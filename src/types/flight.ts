/**
 * Core flight domain types.
 *
 * These types are provider-agnostic on purpose: every provider normalises its
 * own wire format into these shapes, so the visualization layer never has to
 * know where a coordinate came from.
 */

/** A WGS84 geographic coordinate. */
export type Coordinates = {
  latitude: number;
  longitude: number;
};

export type Airport = {
  iata: string | null;
  icao: string | null;
  name: string;
  municipality: string | null;
  countryName: string | null;
  latitude: number;
  longitude: number;
  /** Field elevation in feet above mean sea level. */
  elevationFt: number | null;
};

export type Airline = {
  name: string;
  iata: string | null;
  icao: string | null;
};

export type FlightStatus =
  | "scheduled"
  | "active"
  | "landed"
  | "unknown";

/**
 * Where a piece of data came from, and whether it represents reality.
 *
 * `live` is deliberately part of the data rather than a UI flag: it is the one
 * bit the interface must never get wrong. Simulated data carries `live: false`
 * from the provider all the way to the LIVE/DEMO badge.
 */
export type DataSource = {
  providerId: string;
  providerName: string;
  live: boolean;
  attribution: string;
};

export type Flight = {
  /** Stable, provider-scoped identifier used to fetch positions. */
  id: string;
  /** ICAO callsign as transmitted by the aircraft, e.g. "ACA103". */
  callsign: string;
  /** Human-facing flight number, e.g. "AC103". */
  flightNumber: string;
  airline: Airline | null;
  origin: Airport | null;
  destination: Airport | null;
  status: FlightStatus;
  aircraftType: string | null;
  registration: string | null;
  /** ISO 8601 timestamps, when the provider supplies them. */
  departureTime: string | null;
  arrivalTime: string | null;
  estimatedArrival: string | null;
  source: DataSource;
};

/**
 * A single observed aircraft position.
 *
 * Units are fixed here so no downstream code has to guess:
 *   altitude       feet above mean sea level
 *   heading        degrees true, 0-360
 *   speed          knots, ground speed
 *   verticalSpeed  feet per minute, positive = climbing
 *   roll           degrees, negative = left bank
 */
export type FlightPosition = {
  latitude: number;
  longitude: number;
  altitude: number | null;
  heading: number | null;
  speed: number | null;
  verticalSpeed: number | null;
  roll: number | null;
  onGround: boolean;
  /** ISO 8601 timestamp of when the aircraft was actually at this position. */
  timestamp: string;
};

/** How fresh the live feed is, as judged against the newest sample. */
/**
 * How much to trust the position currently on screen.
 *
 * A ladder, not a boolean, because the honest answer degrades gradually. The
 * distinction that matters most is `derived`: feeds always lag reality by a
 * few seconds, so the rendered position is dead-reckoned forward from the last
 * real observation. While that projection is short it is indistinguishable
 * from an observation; once it stretches, the viewer deserves to know they are
 * looking at an estimate rather than a report.
 *
 *   live         observed moments ago
 *   recent       observed, ageing, projection still small
 *   derived      materially dead-reckoned from the last observation
 *   stale        past the projection cap; the aircraft is held in place
 *   unavailable  too old to present as the aircraft's whereabouts
 */
export type FreshnessLevel =
  | "live"
  | "recent"
  | "derived"
  | "stale"
  | "unavailable";

/**
 * Provenance for a rendered position.
 *
 * Carried alongside the position so the interface cannot present an estimate
 * as an observation by accident.
 */
export type PositionConfidence = {
  /** Which provider observed it. */
  source: string;
  /** When the underlying observation was actually made. */
  observedAt: string;
  /** Seconds between that observation and now, on the server clock. */
  ageSeconds: number;
  /** False when the coordinates were dead-reckoned rather than reported. */
  observed: boolean;
  level: FreshnessLevel;
};

export type FlightState = {
  flight: Flight;
  position: FlightPosition | null;
  previousPosition: FlightPosition | null;
  /** Seconds between the newest sample's timestamp and now. */
  dataAgeSeconds: number;
  isLive: boolean;
  freshness: FreshnessLevel;
};

/**
 * A point on the aircraft's route.
 *
 * `kind` keeps the promise made in the product spec: an estimated great-circle
 * path is never rendered as though it were the aircraft's observed track.
 */
export type RoutePointKind = "estimated" | "observed";

export type RoutePoint = Coordinates & {
  altitude: number | null;
  kind: RoutePointKind;
  timestamp: string | null;
};

export type FlightRoute = {
  /** True only when every point came from an observed position report. */
  isActualTrack: boolean;
  points: RoutePoint[];
};

/** Progress along the origin -> destination great circle, derived geometrically. */
export type FlightProgress = {
  /** 0-1 fraction of the great-circle distance covered. */
  fraction: number;
  distanceFlownKm: number;
  distanceRemainingKm: number;
  totalDistanceKm: number;
  /** Null when ground speed is unknown or the aircraft is not moving. */
  estimatedArrival: Date | null;
};
