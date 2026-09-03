/** Shared geodetic and unit constants. */

/** Mean Earth radius in metres (IUGG). */
export const EARTH_RADIUS_M = 6_371_008.8;

export const METERS_PER_FOOT = 0.3048;
export const FEET_PER_METER = 1 / METERS_PER_FOOT;
export const METERS_PER_NAUTICAL_MILE = 1852;
/** Knots -> metres per second. */
export const KNOTS_TO_MPS = METERS_PER_NAUTICAL_MILE / 3600;

export const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;
export const toDegrees = (radians: number): number => (radians * 180) / Math.PI;

/** Normalise any angle into [0, 360). */
export function normalizeBearing(degrees: number): number {
  const wrapped = degrees % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/**
 * Normalise a longitude into [-180, 180].
 *
 * Values already in range are returned untouched. Routing every coordinate
 * through the modulo below would introduce floating-point drift into positions
 * that were exact to begin with (-79.2 comes back as -79.19999999999999),
 * which then shows up as jitter in interpolated paths.
 */
export function normalizeLongitude(degrees: number): number {
  if (degrees >= -180 && degrees <= 180) return degrees;
  const wrapped = (((degrees + 180) % 360) + 360) % 360;
  return wrapped - 180;
}

/** The signed shortest angular difference from `from` to `to`, in [-180, 180). */
export function angularDifference(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

export const feetToMeters = (feet: number): number => feet * METERS_PER_FOOT;
export const metersToFeet = (meters: number): number => meters * FEET_PER_METER;
