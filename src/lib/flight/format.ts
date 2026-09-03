/**
 * Display formatting.
 *
 * One rule throughout: unknown is shown as an em dash, never as zero. A
 * missing altitude rendered as "0 ft" would be a lie about a cruising
 * aircraft, and these helpers are the only place that decision gets made.
 */
import type { Flight, FreshnessLevel } from "@/types/flight";

export const UNKNOWN = "—";

export function formatAltitude(feet: number | null): string {
  if (feet === null) return UNKNOWN;
  return `${Math.round(feet).toLocaleString("en-US")} ft`;
}

export function formatSpeed(knots: number | null): string {
  return knots === null ? UNKNOWN : `${Math.round(knots)} kt`;
}

export function formatVerticalSpeed(feetPerMinute: number | null): string {
  if (feetPerMinute === null) return UNKNOWN;

  const rounded = Math.round(feetPerMinute / 50) * 50;
  if (Math.abs(rounded) < 100) return "Level";

  const arrow = rounded > 0 ? "↑" : "↓";
  return `${arrow} ${Math.abs(rounded).toLocaleString("en-US")} ft/min`;
}

export function formatHeading(degrees: number | null): string {
  return degrees === null ? UNKNOWN : `${Math.round(degrees) % 360}°`;
}

export function formatDistance(kilometres: number | null): string {
  if (kilometres === null) return UNKNOWN;
  return `${Math.round(kilometres).toLocaleString("en-US")} km`;
}

/** Local wall-clock time, e.g. "18:42". */
export function formatClock(value: Date | string | null): string {
  if (!value) return UNKNOWN;

  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return UNKNOWN;

  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * Data age in words.
 *
 * Sub-second ages read as "just now" rather than "0s ago", which looks broken
 * even though it is accurate.
 */
export function formatDataAge(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return UNKNOWN;
  if (seconds < 2) return "just now";
  if (seconds < 60) return `${Math.round(seconds)}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;

  return `${Math.floor(minutes / 60)} h ago`;
}

export function formatDuration(milliseconds: number | null): string {
  if (milliseconds === null || milliseconds < 0) return UNKNOWN;

  const totalMinutes = Math.round(milliseconds / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/** "Toronto → Vancouver", falling back through the identifiers we have. */
export function routeLabel(flight: Flight): string {
  const from =
    flight.origin?.municipality ?? flight.origin?.iata ?? "Unknown origin";
  const to =
    flight.destination?.municipality ??
    flight.destination?.iata ??
    "Unknown destination";

  if (!flight.origin && !flight.destination) return "Route unavailable";
  return `${from} → ${to}`;
}

export function airportCode(
  airport: Flight["origin"],
  fallback = UNKNOWN,
): string {
  return airport?.iata ?? airport?.icao ?? fallback;
}

/** The words shown beside the status dot. */
export function freshnessLabel(
  freshness: FreshnessLevel,
  isLiveSource: boolean,
): string {
  if (!isLiveSource) return "DEMO";

  switch (freshness) {
    case "live":
      return "LIVE";
    case "delayed":
      return "DELAYED";
    case "stale":
      return "DELAYED";
    case "unavailable":
      return "NO SIGNAL";
  }
}
