/**
 * Turning discrete position reports into continuous motion.
 *
 * Live feeds deliver a position every several seconds. The globe renders sixty
 * times a second. Everything in between is this module's job.
 *
 * Two regimes, and the distinction matters for honesty:
 *
 *   INTERPOLATION  The render time falls between two observed samples. The
 *                  aircraft's path is bounded by real data on both sides.
 *
 *   EXTRAPOLATION  The render time is past the newest sample -- the normal
 *                  case, since feeds always lag reality by a few seconds. We
 *                  dead-reckon forward from the last observed position using
 *                  its own reported speed, track and vertical rate. That is an
 *                  estimate derived from real data, and it is flagged as such
 *                  so the UI never presents it as an observation.
 *
 * Both regimes are pure functions of the samples, so they are directly
 * testable and hold no state.
 */
import type { Coordinates, FlightPosition } from "@/types/flight";
import {
  angularDifference,
  KNOTS_TO_MPS,
  normalizeBearing,
} from "@/lib/geography/constants";
import {
  destinationPoint,
  distanceMeters,
  initialBearing,
  interpolateGreatCircle,
} from "@/lib/geography/greatCircle";

/** How far past the newest sample we are willing to dead-reckon, in ms. */
export const MAX_EXTRAPOLATION_MS = 45_000;

export type SampledPosition = FlightPosition & {
  /** True when this position was dead-reckoned rather than observed. */
  isExtrapolated: boolean;
  /** Age in seconds of the observation this was derived from. */
  sourceAgeSeconds: number;
};

const timeOf = (position: FlightPosition): number =>
  Date.parse(position.timestamp);

/** Linear interpolation that tolerates either endpoint being unknown. */
function lerpNullable(
  a: number | null,
  b: number | null,
  t: number,
): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a + (b - a) * t;
}

/**
 * Interpolate a heading across the shortest arc.
 *
 * Interpolating 350 -> 10 numerically would sweep the aircraft 340 degrees the
 * wrong way round; the shortest angular difference gives the 20 degree turn
 * that actually happened.
 */
export function interpolateHeading(
  a: number | null,
  b: number | null,
  t: number,
): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return normalizeBearing(a + angularDifference(a, b) * t);
}

/**
 * Heading implied by travel from `a` to `b`.
 *
 * Only meaningful once the aircraft has actually moved -- below a few metres
 * the bearing is dominated by position noise, so we decline to guess.
 */
export function headingFromMovement(
  a: Coordinates,
  b: Coordinates,
  minimumMeters = 15,
): number | null {
  return distanceMeters(a, b) < minimumMeters ? null : initialBearing(a, b);
}

/** Blend two observed samples at fraction `t` in [0, 1]. */
export function blendPositions(
  from: FlightPosition,
  to: FlightPosition,
  t: number,
): FlightPosition {
  const clamped = Math.max(0, Math.min(1, t));
  const coordinates = interpolateGreatCircle(from, to, clamped);

  // Prefer reported headings; fall back to the direction of travel between the
  // two samples, which is the only other thing the data actually tells us.
  const heading =
    interpolateHeading(from.heading, to.heading, clamped) ??
    headingFromMovement(from, to);

  return {
    ...coordinates,
    altitude: lerpNullable(from.altitude, to.altitude, clamped),
    heading,
    speed: lerpNullable(from.speed, to.speed, clamped),
    verticalSpeed: lerpNullable(from.verticalSpeed, to.verticalSpeed, clamped),
    roll: lerpNullable(from.roll, to.roll, clamped),
    onGround: clamped < 0.5 ? from.onGround : to.onGround,
    timestamp: new Date(
      timeOf(from) + (timeOf(to) - timeOf(from)) * clamped,
    ).toISOString(),
  };
}

/**
 * Dead-reckon forward from an observed sample.
 *
 * Ground speed along the reported track, plus vertical rate. No turn is
 * assumed: without a rate of turn, straight-ahead is the only defensible
 * projection, and it is what an aircraft in cruise is actually doing.
 */
export function deadReckon(
  from: FlightPosition,
  elapsedMs: number,
): FlightPosition {
  const elapsedSeconds = Math.max(0, elapsedMs) / 1000;

  const canProject =
    from.speed !== null && from.speed > 0 && from.heading !== null;

  const coordinates: Coordinates = canProject
    ? destinationPoint(
        from,
        from.heading!,
        from.speed! * KNOTS_TO_MPS * elapsedSeconds,
      )
    : { latitude: from.latitude, longitude: from.longitude };

  const altitude =
    from.altitude !== null && from.verticalSpeed !== null
      ? from.altitude + (from.verticalSpeed * elapsedSeconds) / 60
      : from.altitude;

  return {
    ...from,
    ...coordinates,
    altitude,
    timestamp: new Date(timeOf(from) + Math.max(0, elapsedMs)).toISOString(),
  };
}

/**
 * The aircraft's position at `atMs`, given every sample we hold.
 *
 * `samples` must be sorted oldest-first. Returns null only when there is
 * nothing to work from at all.
 */
export function samplePositionAt(
  samples: readonly FlightPosition[],
  atMs: number,
  maxExtrapolationMs = MAX_EXTRAPOLATION_MS,
): SampledPosition | null {
  if (samples.length === 0) return null;

  const newest = samples[samples.length - 1];
  const newestMs = timeOf(newest);

  // Past the newest observation: dead-reckon, but only so far. Beyond the cap
  // we hold the last projected position rather than inventing more distance.
  if (atMs >= newestMs) {
    const elapsed = Math.min(atMs - newestMs, maxExtrapolationMs);
    const projected = deadReckon(newest, elapsed);
    return {
      ...projected,
      isExtrapolated: elapsed > 0,
      sourceAgeSeconds: (atMs - newestMs) / 1000,
    };
  }

  const oldest = samples[0];
  const oldestMs = timeOf(oldest);

  // Before anything we know about: hold the oldest sample still.
  if (atMs <= oldestMs) {
    return {
      ...oldest,
      isExtrapolated: false,
      sourceAgeSeconds: (atMs - oldestMs) / 1000,
    };
  }

  for (let i = samples.length - 1; i > 0; i -= 1) {
    const to = samples[i];
    const from = samples[i - 1];
    const fromMs = timeOf(from);
    const toMs = timeOf(to);

    if (atMs >= fromMs && atMs <= toMs) {
      const span = toMs - fromMs;
      // Duplicate timestamps would divide by zero; take the later sample.
      const t = span <= 0 ? 1 : (atMs - fromMs) / span;
      return {
        ...blendPositions(from, to, t),
        isExtrapolated: false,
        sourceAgeSeconds: 0,
      };
    }
  }

  return {
    ...newest,
    isExtrapolated: false,
    sourceAgeSeconds: (atMs - newestMs) / 1000,
  };
}
