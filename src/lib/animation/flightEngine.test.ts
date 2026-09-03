import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FlightPosition } from "@/types/flight";
import { timing } from "@/config";
import { distanceMeters } from "@/lib/geography/greatCircle";
import { FlightEngine, freshnessFor } from "./flightEngine";

const BASE_MS = Date.parse("2026-09-03T12:00:00.000Z");

function position(
  overrides: Partial<FlightPosition> & { timestamp: string },
): FlightPosition {
  return {
    latitude: 43.5,
    longitude: -79.2,
    altitude: 37_000,
    heading: 270,
    speed: 480,
    verticalSpeed: 0,
    roll: null,
    onGround: false,
    ...overrides,
  };
}

const at = (offsetSeconds: number): string =>
  new Date(BASE_MS + offsetSeconds * 1000).toISOString();

/**
 * The engine reads Date.now() when it syncs its clock offset and again when
 * it samples, so both have to be controlled together for these tests to mean
 * anything. Fake timers give one coherent clock across both paths.
 */
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE_MS);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Move the browser clock to an absolute instant. */
const setClock = (ms: number): void => {
  vi.setSystemTime(ms);
};

describe("freshnessFor", () => {
  it("grades data age against the configured thresholds", () => {
    expect(freshnessFor(0)).toBe("live");
    expect(freshnessFor(timing.delayedAfterSeconds - 1)).toBe("live");
    expect(freshnessFor(timing.delayedAfterSeconds)).toBe("delayed");
    expect(freshnessFor(timing.staleAfterSeconds)).toBe("stale");
    expect(freshnessFor(timing.unavailableAfterSeconds)).toBe("unavailable");
  });
});

describe("FlightEngine.ingest", () => {
  it("returns null before any data has arrived", () => {
    expect(new FlightEngine().sample(BASE_MS)).toBeNull();
  });

  it("accepts a first sample and reports it as live", () => {
    const engine = new FlightEngine();
    engine.ingest(position({ timestamp: at(0) }), at(0));

    const snapshot = engine.sample(BASE_MS)!;
    expect(snapshot.freshness).toBe("live");
    expect(snapshot.dataAgeSeconds).toBeCloseTo(0, 3);
  });

  it("ignores an out-of-order sample so the aircraft cannot move backwards", () => {
    const engine = new FlightEngine();
    engine.ingest(position({ timestamp: at(10), latitude: 44 }), at(10));
    engine.ingest(position({ timestamp: at(5), latitude: 40 }), at(10));

    expect(engine.getLastObserved()!.latitude).toBe(44);
  });

  it("ignores a repeated sample", () => {
    const engine = new FlightEngine();
    const sample = position({ timestamp: at(0) });
    engine.ingest(sample, at(0));
    engine.ingest(sample, at(0));

    expect(engine.getTrack()).toHaveLength(1);
  });

  it("keeps ageing when a poll returns no fix", () => {
    const engine = new FlightEngine();
    engine.ingest(position({ timestamp: at(0) }), at(0));

    // Forty seconds pass on both clocks, and the next poll finds nothing.
    setClock(BASE_MS + 40_000);
    engine.ingest(null, at(40));

    // The last known fix stands, and its age is what the UI must report.
    const snapshot = engine.sample(BASE_MS + 40_000)!;
    expect(snapshot.dataAgeSeconds).toBeCloseTo(40, 0);
    expect(snapshot.freshness).toBe("delayed");
    expect(snapshot.lastObserved.timestamp).toBe(at(0));
  });

  it("rejects a sample with an unparseable timestamp", () => {
    const engine = new FlightEngine();
    engine.ingest(position({ timestamp: "not a date" }), at(0));
    expect(engine.sample(BASE_MS)).toBeNull();
  });
});

describe("FlightEngine clock synchronisation", () => {
  it("judges freshness against the server clock, not the browser's", () => {
    const engine = new FlightEngine();

    // Browser clock is two minutes behind the server.
    const clientNow = BASE_MS - 120_000;
    setClock(clientNow);
    engine.ingest(position({ timestamp: at(0) }), at(0));

    // Sampling with the skewed browser clock must still read as fresh, because
    // the offset learned at ingest corrects for it. Without that correction
    // this fix would look two minutes old and the badge would say DELAYED.
    const snapshot = engine.sample(clientNow)!;
    expect(snapshot.dataAgeSeconds).toBeCloseTo(0, 0);
    expect(snapshot.freshness).toBe("live");
  });

  it("does not let a fast browser clock invent stale data", () => {
    const engine = new FlightEngine();
    const clientNow = BASE_MS + 600_000; // browser ten minutes fast

    setClock(clientNow);
    engine.ingest(position({ timestamp: at(0) }), at(0));

    expect(engine.sample(clientNow)!.freshness).toBe("live");
  });

  it("still ages data correctly once the offset is known", () => {
    const engine = new FlightEngine();
    const clientNow = BASE_MS - 120_000;

    setClock(clientNow);
    engine.ingest(position({ timestamp: at(0) }), at(0));

    // Forty seconds later on the browser's own clock.
    const snapshot = engine.sample(clientNow + 40_000)!;
    expect(snapshot.dataAgeSeconds).toBeCloseTo(40, 0);
    expect(snapshot.freshness).toBe("delayed");
  });
});

describe("FlightEngine.sample", () => {
  it("moves the aircraft continuously between polls", () => {
    const engine = new FlightEngine();
    engine.ingest(position({ timestamp: at(0), latitude: 43.5 }), at(0));
    engine.ingest(position({ timestamp: at(8), latitude: 43.52 }), at(8));

    let previous = engine.sample(BASE_MS)!.position;
    for (let t = 50; t <= 8_000; t += 50) {
      const current = engine.sample(BASE_MS + t)!.position;
      expect(distanceMeters(previous, current)).toBeLessThan(100);
      previous = current;
    }
  });

  it("flags dead-reckoned positions as extrapolated", () => {
    const engine = new FlightEngine();
    engine.ingest(position({ timestamp: at(0) }), at(0));

    const snapshot = engine.sample(BASE_MS + 5_000)!;
    expect(snapshot.position.isExtrapolated).toBe(true);
  });

  it("holds at the last observation once data is unavailable", () => {
    const engine = new FlightEngine();
    engine.ingest(position({ timestamp: at(0), heading: 90, speed: 600 }), at(0));

    const wayLater = BASE_MS + timing.unavailableAfterSeconds * 1000 + 60_000;
    const snapshot = engine.sample(wayLater)!;

    expect(snapshot.freshness).toBe("unavailable");
    // Held exactly at the observed fix -- no further projection.
    expect(snapshot.position.latitude).toBeCloseTo(43.5, 9);
    expect(snapshot.position.longitude).toBeCloseTo(-79.2, 9);
  });
});

describe("FlightEngine track history", () => {
  it("records observed points, marked as observed", () => {
    const engine = new FlightEngine();
    engine.ingest(position({ timestamp: at(0), latitude: 43.5 }), at(0));
    engine.ingest(position({ timestamp: at(15), latitude: 43.6 }), at(15));

    const track = engine.getTrack();
    expect(track).toHaveLength(2);
    expect(track.every((point) => point.kind === "observed")).toBe(true);
  });

  it("skips points too close together to be worth keeping", () => {
    const engine = new FlightEngine();
    engine.ingest(position({ timestamp: at(0), latitude: 43.5 }), at(0));
    // ~11 m away, well under the minimum spacing.
    engine.ingest(position({ timestamp: at(1), latitude: 43.5001 }), at(1));

    expect(engine.getTrack()).toHaveLength(1);
  });

  it("caps the track so a long flight cannot grow it without bound", () => {
    const engine = new FlightEngine();

    for (let i = 0; i < timing.maxTrackPoints + 250; i += 1) {
      engine.ingest(
        position({ timestamp: at(i * 10), latitude: 43.5 + i * 0.01 }),
        at(i * 10),
      );
    }

    expect(engine.getTrack().length).toBeLessThanOrEqual(timing.maxTrackPoints);
    // The oldest points are the ones dropped, so the tail is recent.
    const track = engine.getTrack();
    expect(track[track.length - 1].timestamp).toBe(
      at((timing.maxTrackPoints + 249) * 10),
    );
  });
});

describe("FlightEngine.seed and subscribers", () => {
  it("seeds history without losing the newest sample", () => {
    const engine = new FlightEngine();
    engine.seed(
      [
        position({ timestamp: at(0), latitude: 43.5 }),
        position({ timestamp: at(30), latitude: 43.6 }),
        position({ timestamp: at(60), latitude: 43.7 }),
      ],
      at(60),
    );

    expect(engine.getTrack().length).toBe(3);
    expect(engine.getLastObserved()!.latitude).toBe(43.7);
  });

  it("notifies subscribers on ingest and stops after unsubscribe", () => {
    const engine = new FlightEngine();
    const listener = vi.fn();

    const unsubscribe = engine.subscribe(listener);
    engine.ingest(position({ timestamp: at(0) }), at(0));
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    engine.ingest(position({ timestamp: at(10) }), at(10));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("clears everything on reset", () => {
    const engine = new FlightEngine();
    engine.ingest(position({ timestamp: at(0) }), at(0));
    engine.reset();

    expect(engine.sample(BASE_MS)).toBeNull();
    expect(engine.getTrack()).toHaveLength(0);
  });
});
