/**
 * A simulated Toronto -> Vancouver flight.
 *
 * Exists for development, presentations, and for users whose flight is not
 * currently in the air. It flies the real great circle between the real
 * airports with a plausible climb, cruise and descent profile.
 *
 * `isLive` is false and the DataSource says so. That flag travels with the
 * data all the way to the badge in the corner of the screen, which is what
 * guarantees simulated positions can never be presented as LIVE.
 */
import type {
  Airport,
  DataSource,
  Flight,
  FlightPosition,
} from "@/types/flight";
import {
  destinationPoint,
  distanceMeters,
  initialBearing,
  interpolateGreatCircle,
} from "@/lib/geography/greatCircle";
import { KNOTS_TO_MPS } from "@/lib/geography/constants";
import type { FlightDataProvider } from "./types";

const PROVIDER_ID = "demo";

export const DEMO_FLIGHT_ID = "demo:ACA103";

const SOURCE: DataSource = {
  providerId: PROVIDER_ID,
  providerName: "Flightscape demo",
  live: false,
  attribution: "Simulated flight - not a real aircraft",
};

const TORONTO: Airport = {
  iata: "YYZ",
  icao: "CYYZ",
  name: "Toronto Pearson International Airport",
  municipality: "Toronto",
  countryName: "Canada",
  latitude: 43.6772,
  longitude: -79.6306,
  elevationFt: 569,
};

const VANCOUVER: Airport = {
  iata: "YVR",
  icao: "CYVR",
  name: "Vancouver International Airport",
  municipality: "Vancouver",
  countryName: "Canada",
  latitude: 49.1939,
  longitude: -123.184,
  elevationFt: 14,
};

/** A realistic block time for YYZ -> YVR. */
const FLIGHT_DURATION_MS = 5 * 60 * 60 * 1000;
const CRUISE_ALTITUDE_FT = 37_000;
const CRUISE_SPEED_KT = 487;

/** Fractions of the flight spent climbing and descending. */
const CLIMB_FRACTION = 0.12;
const DESCENT_FRACTION = 0.15;

/**
 * The simulated aircraft's progress at a given moment.
 *
 * Anchored to the wall clock modulo the flight duration, so the demo is always
 * mid-flight whenever someone opens it, and any two viewers at the same
 * instant see the same aircraft in the same place.
 */
function progressAt(nowMs: number): number {
  return (nowMs % FLIGHT_DURATION_MS) / FLIGHT_DURATION_MS;
}

/** A smooth climb/cruise/descent profile, in feet. */
function altitudeAt(fraction: number): number {
  const fieldElevation = TORONTO.elevationFt ?? 0;

  if (fraction < CLIMB_FRACTION) {
    const t = fraction / CLIMB_FRACTION;
    // Ease-out: aircraft climb quickly at first, then shallow out.
    const eased = 1 - (1 - t) ** 2;
    return fieldElevation + (CRUISE_ALTITUDE_FT - fieldElevation) * eased;
  }

  if (fraction > 1 - DESCENT_FRACTION) {
    const t = (fraction - (1 - DESCENT_FRACTION)) / DESCENT_FRACTION;
    const eased = t ** 2;
    return (
      CRUISE_ALTITUDE_FT -
      (CRUISE_ALTITUDE_FT - (VANCOUVER.elevationFt ?? 0)) * eased
    );
  }

  return CRUISE_ALTITUDE_FT;
}

function verticalSpeedAt(fraction: number, altitudeFt: number): number {
  const delta = 0.001;
  const ahead = altitudeAt(Math.min(1, fraction + delta));
  const secondsPerDelta = (FLIGHT_DURATION_MS * delta) / 1000;
  return ((ahead - altitudeFt) / secondsPerDelta) * 60;
}

function speedAt(fraction: number): number {
  if (fraction < CLIMB_FRACTION) {
    return 250 + (CRUISE_SPEED_KT - 250) * (fraction / CLIMB_FRACTION);
  }
  if (fraction > 1 - DESCENT_FRACTION) {
    const t = (fraction - (1 - DESCENT_FRACTION)) / DESCENT_FRACTION;
    return CRUISE_SPEED_KT - (CRUISE_SPEED_KT - 180) * t;
  }
  return CRUISE_SPEED_KT;
}

/** The simulated position at an arbitrary instant. */
export function demoPositionAt(nowMs: number = Date.now()): FlightPosition {
  const fraction = progressAt(nowMs);
  const coordinates = interpolateGreatCircle(TORONTO, VANCOUVER, fraction);
  const altitude = altitudeAt(fraction);

  // Heading from the direction of travel a moment later, which keeps the
  // aircraft's nose aligned with the great circle as it curves north.
  const ahead = interpolateGreatCircle(
    TORONTO,
    VANCOUVER,
    Math.min(1, fraction + 0.0005),
  );
  const heading =
    distanceMeters(coordinates, ahead) > 1
      ? initialBearing(coordinates, ahead)
      : initialBearing(TORONTO, VANCOUVER);

  return {
    ...coordinates,
    altitude,
    heading,
    speed: speedAt(fraction),
    verticalSpeed: verticalSpeedAt(fraction, altitude),
    roll: null,
    onGround: false,
    timestamp: new Date(nowMs).toISOString(),
  };
}

/** Where the simulated aircraft was, for seeding a plausible track history. */
export function demoTrackHistory(
  nowMs: number = Date.now(),
  spanMinutes = 45,
  points = 60,
): FlightPosition[] {
  const history: FlightPosition[] = [];
  const spanMs = spanMinutes * 60 * 1000;

  for (let i = points; i >= 1; i -= 1) {
    const at = nowMs - (spanMs * i) / points;
    if (at < 0) continue;
    history.push(demoPositionAt(at));
  }

  return history;
}

const DEMO_FLIGHT: Flight = {
  id: DEMO_FLIGHT_ID,
  callsign: "ACA103",
  flightNumber: "AC103",
  airline: { name: "Air Canada", iata: "AC", icao: "ACA" },
  origin: TORONTO,
  destination: VANCOUVER,
  status: "active",
  aircraftType: "B78X",
  registration: "C-FDEMO",
  departureTime: null,
  arrivalTime: null,
  estimatedArrival: null,
  source: SOURCE,
};

export class DemoFlightProvider implements FlightDataProvider {
  readonly id = PROVIDER_ID;
  readonly name = SOURCE.providerName;
  readonly attribution = SOURCE.attribution;
  readonly isLive = false;

  async searchFlight(): Promise<Flight[]> {
    return [this.currentFlight()];
  }

  async getLivePosition(): Promise<FlightPosition | null> {
    return demoPositionAt();
  }

  async getFlightDetails(): Promise<Flight | null> {
    return this.currentFlight();
  }

  /** The demo flight with an arrival time derived from its own progress. */
  private currentFlight(nowMs = Date.now()): Flight {
    const remainingMs = FLIGHT_DURATION_MS * (1 - progressAt(nowMs));
    const departedMs = nowMs - FLIGHT_DURATION_MS * progressAt(nowMs);

    return {
      ...DEMO_FLIGHT,
      departureTime: new Date(departedMs).toISOString(),
      arrivalTime: new Date(nowMs + remainingMs).toISOString(),
      estimatedArrival: new Date(nowMs + remainingMs).toISOString(),
    };
  }
}

/** Exposed for tests and for seeding the demo route. */
export const DEMO_AIRPORTS = { origin: TORONTO, destination: VANCOUVER };
export const DEMO_CRUISE = {
  altitudeFt: CRUISE_ALTITUDE_FT,
  speedKt: CRUISE_SPEED_KT,
  durationMs: FLIGHT_DURATION_MS,
  /** Ground distance covered per second at cruise, in metres. */
  cruiseMetersPerSecond: CRUISE_SPEED_KT * KNOTS_TO_MPS,
  /** Kept for callers that want a point ahead of the aircraft. */
  aheadOf: destinationPoint,
};
