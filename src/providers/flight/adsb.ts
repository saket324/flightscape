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
  /** Look an airframe up by its ICAO 24-bit address. */
  hexUrl: (icao24: string) => string;
};

const FEEDS: readonly PositionFeed[] = [
  {
    name: "adsb.fi",
    callsignUrl: (callsign) =>
      `https://opendata.adsb.fi/api/v2/callsign/${encodeURIComponent(callsign)}`,
    hexUrl: (icao24) =>
      `https://opendata.adsb.fi/api/v2/hex/${encodeURIComponent(icao24)}`,
  },
  {
    name: "adsb.lol",
    callsignUrl: (callsign) =>
      `https://api.adsb.lol/v2/callsign/${encodeURIComponent(callsign)}`,
    hexUrl: (icao24) =>
      `https://api.adsb.lol/v2/hex/${encodeURIComponent(icao24)}`,
  },
];

/**
 * Pull the aircraft list and the feed's clock out of a readsb envelope.
 *
 * Deliberately one shared function rather than a per-feed adapter. The
 * per-feed version silently disabled the adsb.fi mirror for its entire
 * existence: it read `body.aircraft` where the feed returns `ac`, so it
 * always saw zero aircraft and simply reported "not found". A missing key
 * that yields an empty list is invisible -- there is no error, just an
 * aircraft that quietly stops existing -- so the shape is now probed rather
 * than assumed.
 *
 * `now` is likewise detected rather than assumed. Both feeds currently report
 * milliseconds, but the same class of mistake (multiplying a millisecond
 * clock by 1000) pushes every timestamp into the far future, where
 * sanitizeTimestamp rejects it and every position becomes null.
 */
export function unwrapFeed(payload: unknown): {
  aircraft: AdsbLolAircraft[];
  nowMs: number;
} {
  const body = payload as {
    ac?: unknown;
    aircraft?: unknown;
    now?: unknown;
  } | null;

  const list = [body?.ac, body?.aircraft].find(Array.isArray) as
    | AdsbLolAircraft[]
    | undefined;

  return {
    aircraft: list ?? [],
    nowMs: normalizeFeedClock(body?.now),
  };
}

/**
 * A feed clock in milliseconds.
 *
 * Unix seconds are ~1.8e9 and milliseconds ~1.8e12, so the magnitude
 * distinguishes them unambiguously for any date this software will see.
 */
export function normalizeFeedClock(value: unknown, now = Date.now()): number {
  const parsed = finiteOrNull(value);
  if (parsed === null || parsed <= 0) return now;
  return parsed > 1e11 ? parsed : parsed * 1000;
}

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

/**
 * The callsign an aircraft is actually transmitting.
 *
 * Feeds space-pad the field ("EXS59N  "), so it has to be trimmed before any
 * comparison. Used for identity checks, where a loose match would let one
 * flight's data be shown under another's name.
 */
export function normalizeTransmittedCallsign(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== ""
    ? value.replace(/\s+/g, "").toUpperCase()
    : null;
}

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
async function fetchFromFeeds(
  url: (feed: PositionFeed) => string,
  label: string,
): Promise<{ aircraft: AdsbLolAircraft[]; nowMs: number }> {
  let lastError: unknown = null;
  let sawHealthyFeed = false;

  for (const feed of FEEDS) {
    try {
      const payload = await fetchJson<unknown>(url(feed), {
        allowNotFound: true,
        timeoutMs: 8_000,
      });

      sawHealthyFeed = true;
      if (payload === null) continue;

      const result = unwrapFeed(payload);
      if (result.aircraft.length > 0) return result;
    } catch (error) {
      lastError = error;
      console.warn(
        `[adsb] ${feed.name} unavailable for ${label}; trying next mirror`,
      );
    }
  }

  // At least one mirror answered and none had this aircraft: a real "no".
  if (sawHealthyFeed) return { aircraft: [], nowMs: Date.now() };

  throw lastError ?? new FlightError("provider_unavailable");
}

const fetchAircraftByCallsign = (callsign: string) =>
  fetchFromFeeds((feed) => feed.callsignUrl(callsign), callsign);

/**
 * Look up one airframe by its ICAO 24-bit address.
 *
 * This is the right key for tracking a flight once identity is established.
 * A callsign says what a flight is *called* -- it is reassigned between
 * rotations, can be shared by two airframes around a turnaround, and is
 * whatever the crew typed into the box. The ICAO24 address is burned into the
 * transponder and identifies the metal.
 */
const fetchAircraftByHex = (icao24: string) =>
  fetchFromFeeds((feed) => feed.hexUrl(icao24), icao24);

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

  /**
   * The aircraft's current position, or null.
   *
   * Identity is pinned to the airframe. When the id carries an ICAO24 we ask
   * the feeds for that address directly and accept nothing else: if that
   * airframe is not being received, the honest answer is null.
   *
   * The previous implementation queried by callsign and, when the pinned hex
   * was absent from the response, fell back to `aircraft[0]` -- returning some
   * other aircraft's coordinates under this flight's identity. That is the one
   * failure this product cannot have, so there is no fallback here at all.
   */
  async getLivePosition(flightId: string): Promise<FlightPosition | null> {
    const hex = this.hexFromId(flightId);

    if (hex) {
      const { aircraft, nowMs } = await fetchAircraftByHex(hex);
      const match = aircraft.find(
        (entry) => asString(entry.hex)?.toLowerCase() === hex,
      );
      return match ? toPosition(match, nowMs) : null;
    }

    // No airframe pinned yet (a route-only flight). Fall back to the callsign,
    // and accept a record only if it really is transmitting that callsign.
    const callsign = this.callsignFromId(flightId);
    if (!callsign) throw new FlightError("invalid_identifier");

    const { aircraft, nowMs } = await fetchAircraftByCallsign(callsign);
    const match = aircraft.find(
      (entry) => normalizeTransmittedCallsign(entry.flight) === callsign,
    );

    return match ? toPosition(match, nowMs) : null;
  }

  async getFlightDetails(flightId: string): Promise<Flight | null> {
    const callsign = this.callsignFromId(flightId);
    if (!callsign) throw new FlightError("invalid_identifier");

    const hex = this.hexFromId(flightId);

    const [route, feed] = await Promise.all([
      fetchRoute(callsign).catch(() => null),
      // Same identity rule as getLivePosition: ask for the airframe by
      // address when we know it, and never settle for a different one.
      (hex ? fetchAircraftByHex(hex) : fetchAircraftByCallsign(callsign)).catch(
        () => ({ aircraft: [] as AdsbLolAircraft[], nowMs: Date.now() }),
      ),
    ]);

    const match = hex
      ? feed.aircraft.find(
          (entry) => asString(entry.hex)?.toLowerCase() === hex,
        )
      : feed.aircraft.find(
          (entry) => normalizeTransmittedCallsign(entry.flight) === callsign,
        );

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
      normalizeTransmittedCallsign(aircraft.flight) ?? fallbackCallsign;
    const hex = asString(aircraft.hex)?.toLowerCase() ?? null;
    const position = toPosition(aircraft, nowMs);

    /**
     * Only attach route data that belongs to this aircraft.
     *
     * Search resolves a route from one callsign candidate but may find the
     * aircraft under a different one. Attaching the route regardless would
     * label a real aircraft with another flight's origin and destination --
     * the map would be right and the caption wrong, which is arguably worse
     * than showing nothing.
     */
    const routeCallsign =
      normalizeTransmittedCallsign(route?.callsign_icao) ??
      normalizeTransmittedCallsign(route?.callsign);
    const routeMatches = routeCallsign !== null && routeCallsign === callsign;
    const verifiedRoute = routeMatches ? route : null;

    return {
      id: this.buildId(callsign, hex),
      callsign,
      flightNumber:
        asString(verifiedRoute?.callsign_iata) ?? displayFlightNumber(callsign),
      airline: toAirline(verifiedRoute?.airline),
      origin: toAirport(verifiedRoute?.origin),
      destination: toAirport(verifiedRoute?.destination),
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
