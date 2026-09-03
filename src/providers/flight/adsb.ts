/**
 * The default live provider: community ADS-B feeds for positions, adsbdb for
 * routes.
 *
 * None of these services requires an API key, so Flightscape shows real
 * aircraft from a clean checkout. They divide neatly:
 *
 *   adsb.lol,  Where the aircraft is right now. Receiver-fed, sub-second
 *   adsb.fi    freshness, indexed by transmitted callsign. Two mirrors, since
 *              either may rate-limit briefly.
 *   adsbdb     What the callsign means: airline, origin, destination. Static
 *              reference data, so it is cached aggressively.
 *
 * The split is also why route data and position data are never confused for
 * one another: a route from adsbdb is a schedule, not an observation.
 */
import type {
  Airline,
  Airport,
  DataSource,
  Flight,
  FlightPosition,
  FlightStatus,
} from "@/types/flight";
import { TtlCache } from "@/lib/flight/cache";
import { callsignCandidates, displayFlightNumber } from "@/lib/flight/callsign";
import { FlightError } from "@/lib/flight/errors";
import { fetchJson } from "@/lib/flight/http";
import {
  buildPosition,
  finiteOrNull,
  normalizeFlightIdentifier,
  sanitizeCoordinates,
} from "@/lib/flight/validation";
import type { FlightDataProvider } from "./types";

const ADSBDB_BASE = "https://api.adsbdb.com/v0";

const PROVIDER_ID = "adsb";

const SOURCE: DataSource = {
  providerId: PROVIDER_ID,
  providerName: "adsb.lol / adsb.fi / adsbdb",
  live: true,
  attribution:
    "Live positions from the adsb.lol and adsb.fi community networks - route data from adsbdb",
};

/**
 * Position feeds, tried in order.
 *
 * Both run readsb and emit identical per-aircraft records; only the response
 * envelope differs. Community feeds rate-limit on a short sliding window and
 * send no Retry-After, so a second mirror is what keeps a live flight on
 * screen when the first one briefly says no.
 */
type PositionFeed = {
  name: string;
  callsignUrl: (callsign: string) => string;
  /** Pull the aircraft list and the feed's own clock out of the envelope. */
  unwrap: (payload: unknown) => { aircraft: AdsbLolAircraft[]; nowMs: number };
};

const FEEDS: readonly PositionFeed[] = [
  {
    name: "adsb.lol",
    callsignUrl: (callsign) =>
      `https://api.adsb.lol/v2/callsign/${encodeURIComponent(callsign)}`,
    unwrap: (payload) => {
      const body = payload as { ac?: AdsbLolAircraft[] | null; now?: unknown };
      // adsb.lol reports `now` in milliseconds.
      return {
        aircraft: body?.ac ?? [],
        nowMs: finiteOrNull(body?.now) ?? Date.now(),
      };
    },
  },
  {
    name: "adsb.fi",
    callsignUrl: (callsign) =>
      `https://opendata.adsb.fi/api/v2/callsign/${encodeURIComponent(callsign)}`,
    unwrap: (payload) => {
      const body = payload as {
        aircraft?: AdsbLolAircraft[] | null;
        now?: unknown;
      };
      // adsb.fi reports `now` in seconds; normalise to milliseconds.
      const seconds = finiteOrNull(body?.now);
      return {
        aircraft: body?.aircraft ?? [],
        nowMs: seconds === null ? Date.now() : seconds * 1000,
      };
    },
  },
];

/** Route reference data is static; an hour is comfortably conservative. */
const routeCache = new TtlCache<AdsbdbRoute | null>(60 * 60 * 1000, 400);

/**
 * Drop cached route data.
 *
 * The cache is a module singleton, which is right for a server process but
 * would otherwise carry state between tests.
 */
export function clearRouteCache(): void {
  routeCache.clear();
}

// --- Upstream wire shapes ---------------------------------------------------
// Typed loosely on purpose: these come from a third party and every field is
// re-validated before use. `unknown` where the shape genuinely varies.

type AdsbLolAircraft = {
  hex?: unknown;
  flight?: unknown;
  r?: unknown;
  t?: unknown;
  lat?: unknown;
  lon?: unknown;
  alt_baro?: unknown;
  alt_geom?: unknown;
  gs?: unknown;
  track?: unknown;
  true_heading?: unknown;
  mag_heading?: unknown;
  baro_rate?: unknown;
  geom_rate?: unknown;
  roll?: unknown;
  seen_pos?: unknown;
};

type AdsbdbAirport = {
  iata_code?: unknown;
  icao_code?: unknown;
  name?: unknown;
  municipality?: unknown;
  country_name?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  elevation?: unknown;
};

type AdsbdbRoute = {
  callsign?: unknown;
  callsign_icao?: unknown;
  callsign_iata?: unknown;
  airline?: {
    name?: unknown;
    icao?: unknown;
    iata?: unknown;
  } | null;
  origin?: AdsbdbAirport | null;
  destination?: AdsbdbAirport | null;
};

type AdsbdbResponse = {
  response?: { flightroute?: AdsbdbRoute | null } | string | null;
};

// --- Normalisation ----------------------------------------------------------

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

function toAirport(raw: AdsbdbAirport | null | undefined): Airport | null {
  if (!raw) return null;

  const coordinates = sanitizeCoordinates(raw.latitude, raw.longitude);
  if (!coordinates) return null;

  const name = asString(raw.name);
  if (!name) return null;

  return {
    iata: asString(raw.iata_code),
    icao: asString(raw.icao_code),
    name,
    municipality: asString(raw.municipality),
    countryName: asString(raw.country_name),
    ...coordinates,
    elevationFt: finiteOrNull(raw.elevation),
  };
}

function toAirline(raw: AdsbdbRoute["airline"]): Airline | null {
  const name = asString(raw?.name);
  if (!name) return null;
  return { name, icao: asString(raw?.icao), iata: asString(raw?.iata) };
}

/**
 * Convert an adsb.lol record into a position.
 *
 * `seen_pos` is seconds since the position was actually observed, so the
 * timestamp is derived by subtracting it from now. Using the response time
 * directly would quietly present a stale fix as a fresh one.
 */
function toPosition(
  aircraft: AdsbLolAircraft,
  responseNowMs: number,
): FlightPosition | null {
  const secondsSincePosition = finiteOrNull(aircraft.seen_pos) ?? 0;
  const observedAtMs = responseNowMs - secondsSincePosition * 1000;

  // alt_baro is the string "ground" for aircraft on the surface.
  const onGround = aircraft.alt_baro === "ground";
  const altitude = onGround ? 0 : aircraft.alt_baro;

  return buildPosition(
    {
      latitude: aircraft.lat,
      longitude: aircraft.lon,
      altitude,
      // Prefer true heading (where the nose points) and fall back to track
      // (where the aircraft is going). They differ by the wind's drift angle.
      heading: aircraft.true_heading ?? aircraft.track ?? aircraft.mag_heading,
      speed: aircraft.gs,
      verticalSpeed: aircraft.baro_rate ?? aircraft.geom_rate,
      roll: aircraft.roll,
      onGround,
      timestamp: observedAtMs,
    },
    Date.now(),
  );
}

function statusFor(position: FlightPosition | null): FlightStatus {
  if (!position) return "unknown";
  return position.onGround ? "scheduled" : "active";
}

// --- Upstream calls ---------------------------------------------------------

async function fetchRoute(callsign: string): Promise<AdsbdbRoute | null> {
  return routeCache.fetch(callsign, async () => {
    const payload = await fetchJson<AdsbdbResponse>(
      `${ADSBDB_BASE}/callsign/${encodeURIComponent(callsign)}`,
      { allowNotFound: true, timeoutMs: 6_000 },
    );

    // adsbdb answers unknown callsigns with a string body rather than 404.
    const response = payload?.response;
    if (!response || typeof response === "string") return null;
    return response.flightroute ?? null;
  });
}

/**
 * Ask each mirror in turn for aircraft transmitting `callsign`.
 *
 * A mirror is tried when the previous one errored *or* came back empty. Empty
 * matters as much as failure here: these networks are fed by volunteer
 * receivers with different geographic coverage, so an aircraft over an area
 * one network covers thinly is genuinely absent from its feed while sitting
 * plainly in the other's. Stopping at the first empty answer would report a
 * flying aircraft as not found.
 *
 * An error is surfaced only if no mirror produced anything at all.
 */
async function fetchAircraftByCallsign(
  callsign: string,
): Promise<{ aircraft: AdsbLolAircraft[]; nowMs: number }> {
  let lastError: unknown = null;
  let sawHealthyFeed = false;

  for (const feed of FEEDS) {
    try {
      const payload = await fetchJson<unknown>(feed.callsignUrl(callsign), {
        allowNotFound: true,
        timeoutMs: 8_000,
      });

      sawHealthyFeed = true;
      if (payload === null) continue;

      const result = feed.unwrap(payload);
      if (result.aircraft.length > 0) return result;
    } catch (error) {
      lastError = error;
      console.warn(
        `[adsb] ${feed.name} unavailable for ${callsign}; trying next mirror`,
      );
    }
  }

  // At least one mirror answered and none had this aircraft: a real "no".
  if (sawHealthyFeed) return { aircraft: [], nowMs: Date.now() };

  throw lastError ?? new FlightError("provider_unavailable");
}

// --- Provider ---------------------------------------------------------------

export class AdsbFlightProvider implements FlightDataProvider {
  readonly id = PROVIDER_ID;
  readonly name = SOURCE.providerName;
  readonly attribution = SOURCE.attribution;
  readonly isLive = true;

  async searchFlight(identifier: string): Promise<Flight[]> {
    const normalized = normalizeFlightIdentifier(identifier);
    if (!normalized) throw new FlightError("invalid_identifier");

    const candidates = callsignCandidates(normalized);

    // Resolve the route first: adsbdb accepts either IATA or ICAO form and
    // tells us the canonical transmitted callsign to look for on the feed.
    const routes = await Promise.all(
      candidates.map((candidate) =>
        fetchRoute(candidate).catch(() => null),
      ),
    );
    const route = routes.find((entry) => entry !== null) ?? null;

    const canonical = asString(route?.callsign_icao);
    const searchOrder = canonical
      ? [canonical, ...candidates.filter((c) => c !== canonical)]
      : candidates;

    // Ask the position feed for each plausible callsign until one answers.
    // Sequential rather than parallel: the first hit is almost always the
    // canonical form, and community feeds deserve the lighter load.
    for (const callsign of searchOrder) {
      const { aircraft, nowMs } = await fetchAircraftByCallsign(callsign);
      if (aircraft.length === 0) continue;

      const flights = aircraft
        .map((entry) => this.toFlight(entry, nowMs, route, callsign))
        .filter((flight): flight is Flight => flight !== null);

      if (flights.length > 0) return flights;
    }

    // Nothing is transmitting under this callsign. If we at least know the
    // route, hand it back so the UI can name the flight while explaining that
    // there is no live position -- but with status "unknown", never "active".
    if (route) {
      const flight = this.fromRouteOnly(route, canonical ?? normalized);
      if (flight) return [flight];
    }

    return [];
  }

  async getLivePosition(flightId: string): Promise<FlightPosition | null> {
    const callsign = this.callsignFromId(flightId);
    if (!callsign) throw new FlightError("invalid_identifier");

    const { aircraft, nowMs } = await fetchAircraftByCallsign(callsign);
    if (aircraft.length === 0) return null;

    const hex = this.hexFromId(flightId);

    // Pin to the specific airframe when the id carries one, so a second
    // aircraft appearing under the same callsign cannot hijack the track.
    const match =
      (hex
        ? aircraft.find((entry) => asString(entry.hex)?.toLowerCase() === hex)
        : undefined) ?? aircraft[0];

    return toPosition(match, nowMs);
  }

  async getFlightDetails(flightId: string): Promise<Flight | null> {
    const callsign = this.callsignFromId(flightId);
    if (!callsign) throw new FlightError("invalid_identifier");

    const [route, feed] = await Promise.all([
      fetchRoute(callsign).catch(() => null),
      fetchAircraftByCallsign(callsign).catch(() => ({
        aircraft: [] as AdsbLolAircraft[],
        nowMs: Date.now(),
      })),
    ]);

    const hex = this.hexFromId(flightId);
    const match = hex
      ? feed.aircraft.find(
          (entry) => asString(entry.hex)?.toLowerCase() === hex,
        )
      : feed.aircraft[0];

    if (match) {
      const flight = this.toFlight(match, feed.nowMs, route, callsign);
      if (flight) return flight;
    }

    return route ? this.fromRouteOnly(route, callsign) : null;
  }

  // --- id encoding ---------------------------------------------------------
  // A flight id is `adsb:CALLSIGN:HEX`. The hex is the ICAO 24-bit airframe
  // address, which is what makes the id refer to one specific aircraft rather
  // than to whoever is using that callsign at the moment.

  private buildId(callsign: string, hex: string | null): string {
    return `${PROVIDER_ID}:${callsign}${hex ? `:${hex}` : ""}`;
  }

  private callsignFromId(flightId: string): string | null {
    const parts = flightId.split(":");
    const raw = parts[0] === PROVIDER_ID ? parts[1] : parts[0];
    return raw ? normalizeFlightIdentifier(raw) : null;
  }

  private hexFromId(flightId: string): string | null {
    const parts = flightId.split(":");
    const hex = parts[0] === PROVIDER_ID ? parts[2] : parts[1];
    return hex && /^[0-9a-f]{6}$/i.test(hex) ? hex.toLowerCase() : null;
  }

  // --- assembly ------------------------------------------------------------

  private toFlight(
    aircraft: AdsbLolAircraft,
    nowMs: number,
    route: AdsbdbRoute | null,
    fallbackCallsign: string,
  ): Flight | null {
    const callsign =
      asString(aircraft.flight)?.replace(/\s+/g, "") ?? fallbackCallsign;
    const hex = asString(aircraft.hex)?.toLowerCase() ?? null;
    const position = toPosition(aircraft, nowMs);

    return {
      id: this.buildId(callsign, hex),
      callsign,
      flightNumber:
        asString(route?.callsign_iata) ?? displayFlightNumber(callsign),
      airline: toAirline(route?.airline),
      origin: toAirport(route?.origin),
      destination: toAirport(route?.destination),
      status: statusFor(position),
      aircraftType: asString(aircraft.t),
      registration: asString(aircraft.r),
      // This pairing supplies no schedule times. Null is the honest answer;
      // estimated arrival is derived geometrically from live speed instead.
      departureTime: null,
      arrivalTime: null,
      estimatedArrival: null,
      source: SOURCE,
    };
  }

  /** A flight we can name and route, but cannot currently locate. */
  private fromRouteOnly(route: AdsbdbRoute, callsign: string): Flight | null {
    const resolved = asString(route.callsign_icao) ?? callsign;

    return {
      id: this.buildId(resolved, null),
      callsign: resolved,
      flightNumber:
        asString(route.callsign_iata) ?? displayFlightNumber(resolved),
      airline: toAirline(route.airline),
      origin: toAirport(route.origin),
      destination: toAirport(route.destination),
      status: "unknown",
      aircraftType: null,
      registration: null,
      departureTime: null,
      arrivalTime: null,
      estimatedArrival: null,
      source: SOURCE,
    };
  }
}
