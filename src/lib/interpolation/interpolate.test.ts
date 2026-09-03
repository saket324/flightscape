import { describe, expect, it } from "vitest";
import type { FlightPosition } from "@/types/flight";
import { distanceKm, distanceMeters } from "@/lib/geography/greatCircle";
import {
  blendPositions,
  deadReckon,
  headingFromMovement,
  interpolateHeading,
  MAX_EXTRAPOLATION_MS,
  samplePositionAt,
} from "./interpolate";

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

describe("interpolateHeading", () => {
  it("interpolates across the 360/0 boundary the short way", () => {
    expect(interpolateHeading(350, 10, 0.5)).toBeCloseTo(0, 6);
  });

  it("returns whichever endpoint is known when the other is null", () => {
    expect(interpolateHeading(null, 90, 0.5)).toBe(90);
    expect(interpolateHeading(90, null, 0.5)).toBe(90);
  });

  it("stays within [0, 360)", () => {
    const heading = interpolateHeading(10, 350, 0.5)!;
    expect(heading).toBeGreaterThanOrEqual(0);
    expect(heading).toBeLessThan(360);
  });
});

describe("headingFromMovement", () => {
  it("declines to guess from noise-scale movement", () => {
    expect(
      headingFromMovement(
        { latitude: 43.5, longitude: -79.2 },
        { latitude: 43.500001, longitude: -79.2 },
      ),
    ).toBeNull();
  });

  it("derives a bearing once the aircraft has actually moved", () => {
    expect(
      headingFromMovement(
        { latitude: 43.5, longitude: -79.2 },
        { latitude: 43.6, longitude: -79.2 },
      ),
    ).toBeCloseTo(0, 3);
  });
});

describe("blendPositions", () => {
  const from = position({ timestamp: at(0), latitude: 43.5, longitude: -79.2 });
  const to = position({
    timestamp: at(15),
    latitude: 43.51,
    longitude: -79.25,
    altitude: 37_400,
    speed: 490,
  });

  it("returns the endpoints at t=0 and t=1", () => {
    expect(blendPositions(from, to, 0).latitude).toBeCloseTo(43.5, 9);
    expect(blendPositions(from, to, 1).latitude).toBeCloseTo(43.51, 9);
  });

  it("lands the midpoint between the two samples", () => {
    const middle = blendPositions(from, to, 0.5);
    expect(middle.latitude).toBeGreaterThan(43.5);
    expect(middle.latitude).toBeLessThan(43.51);
    expect(middle.altitude).toBeCloseTo(37_200, 0);
  });

  it("interpolates the timestamp too", () => {
    expect(Date.parse(blendPositions(from, to, 0.5).timestamp)).toBe(
      BASE_MS + 7_500,
    );
  });

  it("clamps out-of-range fractions", () => {
    expect(blendPositions(from, to, -1).latitude).toBeCloseTo(43.5, 9);
    expect(blendPositions(from, to, 5).latitude).toBeCloseTo(43.51, 9);
  });

  it("falls back to direction of travel when neither sample reports heading", () => {
    const a = position({
      timestamp: at(0),
      heading: null,
      latitude: 43.5,
      longitude: -79.2,
    });
    const b = position({
      timestamp: at(10),
      heading: null,
      latitude: 44.5,
      longitude: -79.2,
    });
    expect(blendPositions(a, b, 0.5).heading).toBeCloseTo(0, 1);
  });

  it("carries a known altitude through when the other sample lacks one", () => {
    const a = position({ timestamp: at(0), altitude: null });
    const b = position({ timestamp: at(10), altitude: 30_000 });
    expect(blendPositions(a, b, 0.5).altitude).toBe(30_000);
  });
});

describe("deadReckon", () => {
  it("advances along the reported track at the reported speed", () => {
    const start = position({ timestamp: at(0), heading: 90, speed: 600 });
    const projected = deadReckon(start, 60_000);

    // 600 kt for one minute is 10 nautical miles = 18.52 km, heading east.
    expect(distanceMeters(start, projected)).toBeCloseTo(18_520, -2);
    expect(projected.longitude).toBeGreaterThan(start.longitude);
    expect(projected.latitude).toBeCloseTo(start.latitude, 2);
  });

  it("applies vertical rate to altitude", () => {
    const start = position({
      timestamp: at(0),
      altitude: 30_000,
      verticalSpeed: 1_800,
    });
    expect(deadReckon(start, 60_000).altitude).toBeCloseTo(31_800, 6);
  });

  it("holds position when speed is unknown", () => {
    const start = position({ timestamp: at(0), speed: null });
    const projected = deadReckon(start, 30_000);
    expect(projected.latitude).toBe(start.latitude);
    expect(projected.longitude).toBe(start.longitude);
  });

  it("holds position when heading is unknown", () => {
    const start = position({ timestamp: at(0), heading: null });
    expect(deadReckon(start, 30_000).latitude).toBe(start.latitude);
  });

  it("does not move a stationary aircraft", () => {
    const start = position({ timestamp: at(0), speed: 0, onGround: true });
    expect(distanceMeters(start, deadReckon(start, 30_000))).toBeCloseTo(0, 6);
  });
});

describe("samplePositionAt", () => {
  const samples = [
    position({ timestamp: at(0), latitude: 43.5, longitude: -79.2 }),
    position({ timestamp: at(15), latitude: 43.51, longitude: -79.25 }),
    position({ timestamp: at(30), latitude: 43.52, longitude: -79.3 }),
  ];

  it("returns null with no samples", () => {
    expect(samplePositionAt([], BASE_MS)).toBeNull();
  });

  it("interpolates between bracketing samples without extrapolating", () => {
    const result = samplePositionAt(samples, BASE_MS + 7_500)!;
    expect(result.isExtrapolated).toBe(false);
    expect(result.latitude).toBeGreaterThan(43.5);
    expect(result.latitude).toBeLessThan(43.51);
  });

  it("selects the correct pair from the middle of the buffer", () => {
    const result = samplePositionAt(samples, BASE_MS + 22_500)!;
    expect(result.latitude).toBeGreaterThan(43.51);
    expect(result.latitude).toBeLessThan(43.52);
  });

  it("never teleports: motion is continuous across the whole window", () => {
    let previous = samplePositionAt(samples, BASE_MS)!;
    for (let t = 100; t <= 30_000; t += 100) {
      const current = samplePositionAt(samples, BASE_MS + t)!;
      // At ~480 kt, 100 ms of travel is ~25 m. Anything near a kilometre
      // between consecutive frames would read as a visible jump.
      expect(distanceMeters(previous, current)).toBeLessThan(200);
      previous = current;
    }
  });

  it("dead-reckons past the newest sample and flags it", () => {
    const result = samplePositionAt(samples, BASE_MS + 35_000)!;
    expect(result.isExtrapolated).toBe(true);
    expect(result.sourceAgeSeconds).toBeCloseTo(5, 6);
  });

  it("caps extrapolation instead of inventing unbounded distance", () => {
    const capped = samplePositionAt(
      samples,
      BASE_MS + 30_000 + MAX_EXTRAPOLATION_MS,
    )!;
    const wayBeyond = samplePositionAt(
      samples,
      BASE_MS + 30_000 + MAX_EXTRAPOLATION_MS * 10,
    )!;

    expect(distanceMeters(capped, wayBeyond)).toBeCloseTo(0, 3);
    // The reported age keeps growing, so the UI can still tell the truth.
    expect(wayBeyond.sourceAgeSeconds).toBeGreaterThan(capped.sourceAgeSeconds);
  });

  it("holds the oldest sample when asked for a time before the buffer", () => {
    const result = samplePositionAt(samples, BASE_MS - 60_000)!;
    expect(result.latitude).toBe(43.5);
    expect(result.isExtrapolated).toBe(false);
  });

  it("handles a single sample by dead-reckoning from it", () => {
    const single = [position({ timestamp: at(0), heading: 90, speed: 600 })];
    const result = samplePositionAt(single, BASE_MS + 60_000)!;
    expect(result.isExtrapolated).toBe(true);
    expect(distanceKm(single[0], result)).toBeGreaterThan(10);
  });

  it("survives duplicate timestamps without dividing by zero", () => {
    const duplicated = [
      position({ timestamp: at(0), latitude: 43.5 }),
      position({ timestamp: at(0), latitude: 43.6 }),
      position({ timestamp: at(10), latitude: 43.7 }),
    ];
    const result = samplePositionAt(duplicated, BASE_MS + 5_000)!;
    expect(Number.isFinite(result.latitude)).toBe(true);
  });

  it("produces only finite coordinates across a long sweep", () => {
    for (let t = -60_000; t < 120_000; t += 250) {
      const result = samplePositionAt(samples, BASE_MS + t)!;
      expect(Number.isFinite(result.latitude)).toBe(true);
      expect(Number.isFinite(result.longitude)).toBe(true);
      expect(Math.abs(result.latitude)).toBeLessThanOrEqual(90);
      expect(Math.abs(result.longitude)).toBeLessThanOrEqual(180);
    }
  });
});
