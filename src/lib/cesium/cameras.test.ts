import { describe, expect, it } from "vitest";
import {
  cinematicFramingAt,
  dampFraming,
  framingFor,
  isTrackingMode,
  type AircraftState,
  type CameraFraming,
} from "./cameras";

const cruising: AircraftState = {
  latitude: 43.5,
  longitude: -79.2,
  altitudeFeet: 37_000,
  headingDegrees: 274,
  speedKnots: 487,
};

const onApproach: AircraftState = { ...cruising, altitudeFeet: 2_000 };

describe("framingFor", () => {
  it("puts the follow camera close behind the aircraft", () => {
    const framing = framingFor("follow", cruising, 0)!;
    expect(framing.headingOffset).toBe(0);
    expect(framing.pitch).toBeLessThan(0);
    expect(framing.range).toBeLessThan(3_000);
  });

  it("pulls the regional camera back far enough to show geography", () => {
    const framing = framingFor("regional", cruising, 0)!;
    expect(framing.range).toBeGreaterThan(10_000);
  });

  it("tightens the chase as the aircraft descends", () => {
    const cruise = framingFor("follow", cruising, 0)!;
    const approach = framingFor("follow", onApproach, 0)!;

    // A fixed distance would put the camera underground on final approach.
    expect(approach.range).toBeLessThan(cruise.range);
    expect(approach.range).toBeGreaterThan(0);
  });

  it("has no orbit framing for global or cockpit", () => {
    expect(framingFor("global", cruising, 0)).toBeNull();
    expect(framingFor("cockpit", cruising, 0)).toBeNull();
  });

  it("never returns a range that would put the camera inside the Earth", () => {
    for (const altitude of [0, 500, 5_000, 20_000, 45_000]) {
      const framing = framingFor("follow", { ...cruising, altitudeFeet: altitude }, 0)!;
      expect(framing.range).toBeGreaterThan(100);
      expect(Number.isFinite(framing.range)).toBe(true);
    }
  });
});

describe("cinematicFramingAt", () => {
  it("produces finite framings across the whole sequence", () => {
    for (let t = 0; t < 120; t += 0.25) {
      const framing = cinematicFramingAt(t);
      expect(Number.isFinite(framing.headingOffset)).toBe(true);
      expect(Number.isFinite(framing.pitch)).toBe(true);
      expect(framing.range).toBeGreaterThan(0);
      expect(framing.range).toBeLessThan(1_000_000);
    }
  });

  it("moves continuously, with no cuts between shots", () => {
    let previous = cinematicFramingAt(0);

    for (let t = 0.1; t <= 60; t += 0.1) {
      const current = cinematicFramingAt(t);
      // A tenth of a second must never change the range by more than a third,
      // which would read as a jump cut rather than a camera move.
      const ratio = current.range / previous.range;
      expect(ratio).toBeGreaterThan(0.7);
      expect(ratio).toBeLessThan(1.4);
      previous = current;
    }
  });

  it("loops seamlessly", () => {
    const start = cinematicFramingAt(0);
    const end = cinematicFramingAt(59.99);

    expect(end.range / start.range).toBeCloseTo(1, 0);
    expect(Math.abs(end.pitch - start.pitch)).toBeLessThan(3);
  });

  it("reaches both a close shot and a wide one", () => {
    const ranges: number[] = [];
    for (let t = 0; t < 60; t += 0.5) ranges.push(cinematicFramingAt(t).range);

    expect(Math.min(...ranges)).toBeLessThan(1_500);
    expect(Math.max(...ranges)).toBeGreaterThan(20_000);
  });
});

describe("dampFraming", () => {
  const from: CameraFraming = { headingOffset: 0, pitch: -10, range: 1_000 };
  const to: CameraFraming = { headingOffset: 90, pitch: -40, range: 20_000 };

  it("moves toward the target without overshooting", () => {
    const stepped = dampFraming(from, to, 0.1);

    expect(stepped.range).toBeGreaterThan(from.range);
    expect(stepped.range).toBeLessThan(to.range);
    expect(stepped.pitch).toBeLessThan(from.pitch);
    expect(stepped.pitch).toBeGreaterThan(to.pitch);
  });

  it("converges on the target when given time", () => {
    let framing = from;
    for (let i = 0; i < 200; i += 1) framing = dampFraming(framing, to, 1 / 60);

    expect(framing.range).toBeCloseTo(to.range, -2);
    expect(framing.pitch).toBeCloseTo(to.pitch, 1);
  });

  it("is frame-rate independent", () => {
    // The same elapsed time at 30fps and 120fps must land in the same place,
    // or the camera would move faster on faster machines.
    let slow = from;
    for (let i = 0; i < 30; i += 1) slow = dampFraming(slow, to, 1 / 30);

    let fast = from;
    for (let i = 0; i < 120; i += 1) fast = dampFraming(fast, to, 1 / 120);

    expect(slow.range / fast.range).toBeCloseTo(1, 1);
    expect(Math.abs(slow.pitch - fast.pitch)).toBeLessThan(1);
  });

  it("takes the short way round the compass", () => {
    const stepped = dampFraming(
      { headingOffset: 350, pitch: -10, range: 1_000 },
      { headingOffset: 10, pitch: -10, range: 1_000 },
      0.5,
    );

    // Must pass through 0, not sweep backwards through 180.
    const wrapped = stepped.headingOffset > 180
      ? stepped.headingOffset - 360
      : stepped.headingOffset;
    expect(wrapped).toBeGreaterThan(-11);
    expect(wrapped).toBeLessThan(11);
  });

  it("does nothing when no time has passed", () => {
    const stepped = dampFraming(from, to, 0);
    expect(stepped.range).toBeCloseTo(from.range, 6);
    expect(stepped.pitch).toBeCloseTo(from.pitch, 6);
  });
});

describe("isTrackingMode", () => {
  it("tracks the aircraft in every mode but global", () => {
    expect(isTrackingMode("follow")).toBe(true);
    expect(isTrackingMode("regional")).toBe(true);
    expect(isTrackingMode("cinematic")).toBe(true);
    expect(isTrackingMode("cockpit")).toBe(true);
    expect(isTrackingMode("global")).toBe(false);
  });
});
