import type { Coordinates } from "@/types/flight";
import {
  EARTH_RADIUS_M,
  normalizeBearing,
  normalizeLongitude,
  toDegrees,
  toRadians,
} from "./constants";

/**
 * Spherical-earth great-circle maths.
 *
 * A sphere (rather than the WGS84 ellipsoid) is accurate to roughly 0.5% for
 * distance, which is far inside the tolerance of anything we draw. Cesium
 * handles the ellipsoid for actual rendering; this module is for route
 * geometry, progress and bearings.
 */

/** Great-circle distance between two points, in metres. */
export function distanceMeters(a: Coordinates, b: Coordinates): number {
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const deltaLat = toRadians(b.latitude - a.latitude);
  const deltaLon = toRadians(b.longitude - a.longitude);

  // Haversine: numerically stable for the small distances we care most about.
  const h =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const distanceKm = (a: Coordinates, b: Coordinates): number =>
  distanceMeters(a, b) / 1000;

/** Initial bearing (forward azimuth) from `a` to `b`, in degrees true. */
export function initialBearing(a: Coordinates, b: Coordinates): number {
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const deltaLon = toRadians(b.longitude - a.longitude);

  const y = Math.sin(deltaLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);

  return normalizeBearing(toDegrees(Math.atan2(y, x)));
}

/** The point reached by travelling `distance` metres from `origin` on `bearing`. */
export function destinationPoint(
  origin: Coordinates,
  bearingDegrees: number,
  distanceMeters_: number,
): Coordinates {
  const angular = distanceMeters_ / EARTH_RADIUS_M;
  const bearing = toRadians(bearingDegrees);
  const lat1 = toRadians(origin.latitude);
  const lon1 = toRadians(origin.longitude);

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angular) +
      Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
      Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
    );

  return {
    latitude: toDegrees(lat2),
    longitude: normalizeLongitude(toDegrees(lon2)),
  };
}

/**
 * Point at `fraction` along the great circle from `a` to `b`.
 *
 * Uses spherical linear interpolation, which follows the true shortest path
 * across the globe and crosses the antimeridian correctly -- a naive lerp of
 * latitude/longitude would cut a visibly wrong line across high latitudes.
 */
export function interpolateGreatCircle(
  a: Coordinates,
  b: Coordinates,
  fraction: number,
): Coordinates {
  const lat1 = toRadians(a.latitude);
  const lon1 = toRadians(a.longitude);
  const lat2 = toRadians(b.latitude);
  const lon2 = toRadians(b.longitude);

  const deltaLat = lat2 - lat1;
  const deltaLon = lon2 - lon1;
  const h =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  const angular = 2 * Math.asin(Math.min(1, Math.sqrt(h)));

  // Coincident (or near-coincident) points: slerp is undefined, fall back to a
  // straight read of the endpoints.
  if (angular < 1e-12) {
    return { latitude: a.latitude, longitude: a.longitude };
  }

  const sinAngular = Math.sin(angular);
  const scaleA = Math.sin((1 - fraction) * angular) / sinAngular;
  const scaleB = Math.sin(fraction * angular) / sinAngular;

  const x =
    scaleA * Math.cos(lat1) * Math.cos(lon1) +
    scaleB * Math.cos(lat2) * Math.cos(lon2);
  const y =
    scaleA * Math.cos(lat1) * Math.sin(lon1) +
    scaleB * Math.cos(lat2) * Math.sin(lon2);
  const z = scaleA * Math.sin(lat1) + scaleB * Math.sin(lat2);

  return {
    latitude: toDegrees(Math.atan2(z, Math.sqrt(x * x + y * y))),
    longitude: normalizeLongitude(toDegrees(Math.atan2(y, x))),
  };
}

/**
 * Sample a great-circle path as a polyline.
 *
 * `segments` is the number of spans, so the result has `segments + 1` points
 * and always includes both endpoints exactly.
 */
export function greatCirclePath(
  a: Coordinates,
  b: Coordinates,
  segments = 128,
): Coordinates[] {
  const count = Math.max(1, Math.floor(segments));
  const points: Coordinates[] = [];
  for (let i = 0; i <= count; i += 1) {
    points.push(interpolateGreatCircle(a, b, i / count));
  }
  return points;
}

/**
 * How far along the a -> b great circle `point` lies, as a 0-1 fraction.
 *
 * Uses along-track distance rather than a naive "distance flown / total",
 * so a position off to the side of the route still projects sensibly.
 */
export function progressAlongRoute(
  a: Coordinates,
  b: Coordinates,
  point: Coordinates,
): number {
  const total = distanceMeters(a, b);
  if (total < 1) return 0;

  const angularDistanceToPoint = distanceMeters(a, point) / EARTH_RADIUS_M;
  const bearingToPoint = toRadians(initialBearing(a, point));
  const bearingToEnd = toRadians(initialBearing(a, b));

  const crossTrack = Math.asin(
    Math.sin(angularDistanceToPoint) * Math.sin(bearingToPoint - bearingToEnd),
  );
  const alongTrack =
    Math.acos(
      Math.max(
        -1,
        Math.min(1, Math.cos(angularDistanceToPoint) / Math.cos(crossTrack)),
      ),
    ) * Math.sign(Math.cos(bearingToPoint - bearingToEnd));

  const alongTrackMeters = alongTrack * EARTH_RADIUS_M;
  return Math.max(0, Math.min(1, alongTrackMeters / total));
}
