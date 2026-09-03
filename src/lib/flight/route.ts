/**
 * Route geometry and progress.
 *
 * The distinction this module exists to protect: an aircraft's *route* is
 * where it is scheduled to go, and its *track* is where it has actually been.
 * We can usually draw the first and only sometimes the second, and the two are
 * never blended into one line. Every point carries a `kind` so the renderer
 * can style a schedule differently from an observation, and `isActualTrack`
 * says plainly which kind of line the caller is holding.
 */
import type {
  Airport,
  Coordinates,
  Flight,
  FlightPosition,
  FlightProgress,
  FlightRoute,
  RoutePoint,
} from "@/types/flight";
import { KNOTS_TO_MPS } from "@/lib/geography/constants";
import {
  distanceMeters,
  greatCirclePath,
  progressAlongRoute,
} from "@/lib/geography/greatCircle";

/** Segments used to sample a great circle. Enough to look smooth at any zoom. */
const ROUTE_SEGMENTS = 192;

/**
 * The planned great-circle route between the airports, if both are known.
 *
 * Every point is marked "estimated": this is the path the flight is expected
 * to take, not one it has been observed taking.
 */
export function buildPlannedRoute(flight: Flight): FlightRoute | null {
  const { origin, destination } = flight;
  if (!origin || !destination) return null;

  const points: RoutePoint[] = greatCirclePath(
    origin,
    destination,
    ROUTE_SEGMENTS,
  ).map((coordinates) => ({
    ...coordinates,
    altitude: null,
    kind: "estimated" as const,
    timestamp: null,
  }));

  return { isActualTrack: false, points };
}

/**
 * The observed track.
 *
 * Returns null rather than an empty route when there is nothing observed yet,
 * so callers cannot accidentally render an empty "actual path".
 */
export function buildObservedTrack(
  track: readonly RoutePoint[],
): FlightRoute | null {
  if (track.length < 2) return null;
  return { isActualTrack: true, points: [...track] };
}

/**
 * Split the planned route at the aircraft's current progress.
 *
 * Used to draw the completed portion differently from the remaining one. Both
 * halves are still estimated geometry -- the split point is real, the line is
 * not.
 */
export function splitRouteAtProgress(
  route: FlightRoute,
  fraction: number,
): { completed: RoutePoint[]; remaining: RoutePoint[] } {
  const clamped = Math.max(0, Math.min(1, fraction));
  const index = Math.round(clamped * (route.points.length - 1));

  return {
    completed: route.points.slice(0, index + 1),
    // Overlap by one point so the two polylines meet without a visible gap.
    remaining: route.points.slice(Math.max(0, index)),
  };
}

/**
 * How far along the route the aircraft is, and when it should arrive.
 *
 * Progress is geometric -- the aircraft's position projected onto the
 * origin/destination great circle -- rather than time-based, because we do not
 * always have a departure time but we always have coordinates.
 */
export function computeProgress(
  origin: Airport | null,
  destination: Airport | null,
  position: Coordinates | null,
  groundSpeedKt: number | null,
  nowMs: number = Date.now(),
): FlightProgress | null {
  if (!origin || !destination || !position) return null;

  const totalMeters = distanceMeters(origin, destination);
  if (totalMeters < 1) return null;

  const fraction = progressAlongRoute(origin, destination, position);
  const flownMeters = totalMeters * fraction;
  const remainingMeters = totalMeters - flownMeters;

  // An arrival estimate needs the aircraft to actually be moving. A taxiing
  // or stationary aircraft would otherwise produce an absurd ETA.
  const estimatedArrival =
    groundSpeedKt !== null && groundSpeedKt > 40
      ? new Date(nowMs + (remainingMeters / (groundSpeedKt * KNOTS_TO_MPS)) * 1000)
      : null;

  return {
    fraction,
    distanceFlownKm: flownMeters / 1000,
    distanceRemainingKm: remainingMeters / 1000,
    totalDistanceKm: totalMeters / 1000,
    estimatedArrival,
  };
}

/**
 * Whether a position is close enough to an airport to call the flight landed.
 *
 * Deliberately conservative: on the ground and within a few kilometres. A
 * cruising aircraft passing over its destination must not read as arrived.
 */
export function hasArrived(
  position: FlightPosition,
  destination: Airport | null,
  radiusMeters = 5_000,
): boolean {
  if (!destination || !position.onGround) return false;
  return distanceMeters(position, destination) <= radiusMeters;
}
