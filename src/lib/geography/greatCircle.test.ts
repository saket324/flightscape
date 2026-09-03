import { describe, expect, it } from "vitest";
import type { Coordinates } from "@/types/flight";
import {
  destinationPoint,
  distanceKm,
  greatCirclePath,
  initialBearing,
  interpolateGreatCircle,
  progressAlongRoute,
} from "./greatCircle";
import { angularDifference, normalizeBearing, normalizeLongitude } from "./constants";

const TORONTO: Coordinates = { latitude: 43.6777, longitude: -79.6306 };
const VANCOUVER: Coordinates = { latitude: 49.1939, longitude: -123.184 };
const LONDON: Coordinates = { latitude: 51.4775, longitude: -0.4614 };

describe("distanceKm", () => {
  it("measures a known long-haul route", () => {
    // Published YYZ -> YVR great-circle distance is ~3342 km.
    expect(distanceKm(TORONTO, VANCOUVER)).toBeGreaterThan(3300);
    expect(distanceKm(TORONTO, VANCOUVER)).toBeLessThan(3380);
  });

  it("is zero for a point against itself", () => {
    expect(distanceKm(TORONTO, TORONTO)).toBeCloseTo(0, 6);
  });

  it("is symmetric", () => {
    expect(distanceKm(TORONTO, LONDON)).toBeCloseTo(distanceKm(LONDON, TORONTO), 6);
  });

  it("measures a quarter of the way round the globe across the equator", () => {
    const distance = distanceKm(
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: 90 },
    );
    expect(distance).toBeCloseTo((Math.PI / 2) * 6371.0088, 0);
  });

  it("takes the short way across the antimeridian", () => {
    const distance = distanceKm(
      { latitude: 0, longitude: 179 },
      { latitude: 0, longitude: -179 },
    );
    // Two degrees of longitude at the equator, not 358.
    expect(distance).toBeLessThan(250);
  });
});

describe("initialBearing", () => {
  it("points due east along the equator", () => {
    expect(
      initialBearing({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 10 }),
    ).toBeCloseTo(90, 5);
  });

  it("points due north along a meridian", () => {
    expect(
      initialBearing({ latitude: 0, longitude: 0 }, { latitude: 10, longitude: 0 }),
    ).toBeCloseTo(0, 5);
  });

  it("heads north of due west on a northern great circle", () => {
    // Toronto -> Vancouver arcs over the north, so the initial track is
    // west-north-west rather than the naive due-west of a flat map.
    const bearing = initialBearing(TORONTO, VANCOUVER);
    expect(bearing).toBeGreaterThan(270);
    expect(bearing).toBeLessThan(310);
  });
});

describe("destinationPoint", () => {
  it("round-trips with distance and bearing", () => {
    const bearing = initialBearing(TORONTO, VANCOUVER);
    const distance = distanceKm(TORONTO, VANCOUVER) * 1000;
    const arrived = destinationPoint(TORONTO, bearing, distance);

    expect(arrived.latitude).toBeCloseTo(VANCOUVER.latitude, 4);
    expect(arrived.longitude).toBeCloseTo(VANCOUVER.longitude, 4);
  });

  it("keeps longitude normalised when crossing the antimeridian", () => {
    const point = destinationPoint({ latitude: 0, longitude: 179 }, 90, 400_000);
    expect(point.longitude).toBeLessThanOrEqual(180);
    expect(point.longitude).toBeGreaterThanOrEqual(-180);
    expect(point.longitude).toBeLessThan(0);
  });
});

describe("interpolateGreatCircle", () => {
  it("returns the endpoints exactly", () => {
    const start = interpolateGreatCircle(TORONTO, VANCOUVER, 0);
    const end = interpolateGreatCircle(TORONTO, VANCOUVER, 1);

    expect(start.latitude).toBeCloseTo(TORONTO.latitude, 6);
    expect(end.latitude).toBeCloseTo(VANCOUVER.latitude, 6);
    expect(end.longitude).toBeCloseTo(VANCOUVER.longitude, 6);
  });

  it("puts the midpoint equidistant from both ends", () => {
    const middle = interpolateGreatCircle(TORONTO, VANCOUVER, 0.5);
    expect(distanceKm(TORONTO, middle)).toBeCloseTo(distanceKm(middle, VANCOUVER), 1);
  });

  it("arcs poleward of the latitude midpoint", () => {
    // The defining property of a great circle on a Mercator-shaped intuition:
    // the true path bulges toward the pole.
    const middle = interpolateGreatCircle(TORONTO, VANCOUVER, 0.5);
    const naiveMiddleLatitude = (TORONTO.latitude + VANCOUVER.latitude) / 2;
    expect(middle.latitude).toBeGreaterThan(naiveMiddleLatitude);
  });

  it("handles coincident points without producing NaN", () => {
    const point = interpolateGreatCircle(TORONTO, TORONTO, 0.5);
    expect(Number.isFinite(point.latitude)).toBe(true);
    expect(Number.isFinite(point.longitude)).toBe(true);
  });

  it("does not sweep the long way across the antimeridian", () => {
    const middle = interpolateGreatCircle(
      { latitude: 0, longitude: 170 },
      { latitude: 0, longitude: -170 },
      0.5,
    );
    expect(Math.abs(middle.longitude)).toBeGreaterThan(179);
  });
});

describe("greatCirclePath", () => {
  it("returns segments + 1 points including both endpoints", () => {
    const path = greatCirclePath(TORONTO, VANCOUVER, 64);
    expect(path).toHaveLength(65);
    expect(path[0].latitude).toBeCloseTo(TORONTO.latitude, 6);
    expect(path[64].latitude).toBeCloseTo(VANCOUVER.latitude, 6);
  });

  it("produces only finite coordinates", () => {
    for (const point of greatCirclePath(TORONTO, LONDON, 32)) {
      expect(Number.isFinite(point.latitude)).toBe(true);
      expect(Number.isFinite(point.longitude)).toBe(true);
      expect(Math.abs(point.latitude)).toBeLessThanOrEqual(90);
    }
  });
});

describe("progressAlongRoute", () => {
  it("is 0 at the origin and 1 at the destination", () => {
    expect(progressAlongRoute(TORONTO, VANCOUVER, TORONTO)).toBeCloseTo(0, 3);
    expect(progressAlongRoute(TORONTO, VANCOUVER, VANCOUVER)).toBeCloseTo(1, 3);
  });

  it("is about a half at the great-circle midpoint", () => {
    const middle = interpolateGreatCircle(TORONTO, VANCOUVER, 0.5);
    expect(progressAlongRoute(TORONTO, VANCOUVER, middle)).toBeCloseTo(0.5, 2);
  });

  it("projects an off-track position onto the route", () => {
    // 60 km north of the 40% point still reads as roughly 40% complete.
    const onTrack = interpolateGreatCircle(TORONTO, VANCOUVER, 0.4);
    const offTrack = destinationPoint(onTrack, 0, 60_000);
    expect(progressAlongRoute(TORONTO, VANCOUVER, offTrack)).toBeCloseTo(0.4, 1);
  });

  it("clamps rather than reporting progress outside the route", () => {
    const beyond = destinationPoint(VANCOUVER, initialBearing(TORONTO, VANCOUVER), 500_000);
    expect(progressAlongRoute(TORONTO, VANCOUVER, beyond)).toBe(1);
  });
});

describe("angle helpers", () => {
  it("normalises bearings into [0, 360)", () => {
    expect(normalizeBearing(-90)).toBe(270);
    expect(normalizeBearing(450)).toBe(90);
    expect(normalizeBearing(360)).toBe(0);
  });

  it("normalises longitude into [-180, 180)", () => {
    expect(normalizeLongitude(190)).toBeCloseTo(-170, 9);
    expect(normalizeLongitude(-190)).toBeCloseTo(170, 9);
  });

  it("takes the short way round for angular differences", () => {
    expect(angularDifference(350, 10)).toBeCloseTo(20, 9);
    expect(angularDifference(10, 350)).toBeCloseTo(-20, 9);
  });
});
