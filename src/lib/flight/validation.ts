/**
 * Sanitisation for untrusted external data.
 *
 * Every value that reaches the visualization passes through here first. A
 * malformed upstream response should degrade the display, never crash the
 * globe: a NaN latitude handed to Cesium corrupts the whole scene graph, so
 * anything we cannot vouch for becomes `null` at the boundary.
 */
import type { FlightPosition } from "@/types/flight";
import { normalizeBearing, normalizeLongitude } from "@/lib/geography/constants";

/** Physically impossible altitudes, in feet. Beyond this it is bad data. */
const MIN_ALTITUDE_FT = -1_500;
const MAX_ALTITUDE_FT = 150_000;
/** No airliner exceeds this ground speed in knots. */
const MAX_SPEED_KT = 1_500;
const MAX_VERTICAL_SPEED_FPM = 30_000;

/** A finite number, or null. Rejects NaN, Infinity, strings and objects. */
export function finiteOrNull(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function clampOrNull(
  value: unknown,
  min: number,
  max: number,
): number | null {
  const parsed = finiteOrNull(value);
  if (parsed === null) return null;
  return parsed >= min && parsed <= max ? parsed : null;
}

export function isValidLatitude(value: unknown): value is number {
  const parsed = finiteOrNull(value);
  return parsed !== null && parsed >= -90 && parsed <= 90;
}

export function isValidLongitude(value: unknown): value is number {
  const parsed = finiteOrNull(value);
  return parsed !== null && parsed >= -180 && parsed <= 180;
}

/**
 * A coordinate pair we are willing to place an aircraft at.
 *
 * (0, 0) is rejected: it is in the Gulf of Guinea and is overwhelmingly more
 * likely to be an upstream null-as-zero bug than a real aircraft position.
 */
export function sanitizeCoordinates(
  latitude: unknown,
  longitude: unknown,
): { latitude: number; longitude: number } | null {
  if (!isValidLatitude(latitude) || !isValidLongitude(longitude)) return null;

  const lat = finiteOrNull(latitude)!;
  const lon = finiteOrNull(longitude)!;
  if (Math.abs(lat) < 1e-9 && Math.abs(lon) < 1e-9) return null;

  return { latitude: lat, longitude: normalizeLongitude(lon) };
}

export const sanitizeAltitudeFt = (value: unknown): number | null =>
  clampOrNull(value, MIN_ALTITUDE_FT, MAX_ALTITUDE_FT);

export const sanitizeSpeedKt = (value: unknown): number | null =>
  clampOrNull(value, 0, MAX_SPEED_KT);

export const sanitizeVerticalSpeedFpm = (value: unknown): number | null =>
  clampOrNull(value, -MAX_VERTICAL_SPEED_FPM, MAX_VERTICAL_SPEED_FPM);

export function sanitizeHeading(value: unknown): number | null {
  const parsed = finiteOrNull(value);
  return parsed === null ? null : normalizeBearing(parsed);
}

/** Bank angle, clamped to what a transport aircraft can actually do. */
export function sanitizeRoll(value: unknown): number | null {
  return clampOrNull(value, -45, 45);
}

/**
 * Coerce a timestamp to ISO 8601.
 *
 * Rejects timestamps more than a minute in the future or a day in the past --
 * both indicate a clock or parsing problem rather than a real observation.
 */
export function sanitizeTimestamp(value: unknown, now = Date.now()): string | null {
  let ms: number | null = null;

  if (typeof value === "number" && Number.isFinite(value)) {
    // Heuristic: ADS-B feeds use seconds, JS uses milliseconds.
    ms = value > 1e11 ? value : value * 1000;
  } else if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) ms = parsed;
  }

  if (ms === null || !Number.isFinite(ms)) return null;
  if (ms > now + 60_000) return null;
  if (ms < now - 86_400_000) return null;

  return new Date(ms).toISOString();
}

/**
 * Flight identifiers as typed by a user.
 *
 * Restricted to the alphanumerics that real callsigns use, which also keeps
 * user input from reaching an upstream URL as anything but a safe token.
 */
const IDENTIFIER_PATTERN = /^[A-Z0-9]{2,10}$/;

export function normalizeFlightIdentifier(raw: string): string | null {
  const cleaned = raw.trim().toUpperCase().replace(/[\s-]/g, "");
  return IDENTIFIER_PATTERN.test(cleaned) ? cleaned : null;
}

/**
 * Assemble a position from untrusted parts, or return null.
 *
 * Coordinates and a timestamp are mandatory -- without them there is no
 * defensible place to draw the aircraft. Everything else degrades to null.
 */
export function buildPosition(input: {
  latitude: unknown;
  longitude: unknown;
  altitude?: unknown;
  heading?: unknown;
  speed?: unknown;
  verticalSpeed?: unknown;
  roll?: unknown;
  onGround?: unknown;
  timestamp: unknown;
}, now = Date.now()): FlightPosition | null {
  const coordinates = sanitizeCoordinates(input.latitude, input.longitude);
  if (!coordinates) return null;

  const timestamp = sanitizeTimestamp(input.timestamp, now);
  if (!timestamp) return null;

  return {
    ...coordinates,
    altitude: sanitizeAltitudeFt(input.altitude),
    heading: sanitizeHeading(input.heading),
    speed: sanitizeSpeedKt(input.speed),
    verticalSpeed: sanitizeVerticalSpeedFpm(input.verticalSpeed),
    roll: sanitizeRoll(input.roll),
    onGround: input.onGround === true,
    timestamp,
  };
}
