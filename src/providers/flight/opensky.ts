/**
 * OpenSky Network provider.
 *
 * A second live source with different receiver coverage, useful where adsb.lol
 * is thin. Set FLIGHT_PROVIDER=opensky to make it primary.
 *
 * Two things shape this implementation:
 *
 * 1. Since March 2026 OpenSky accepts only OAuth2 client credentials. It still
 *    serves anonymous requests, at a much lower credit allowance, so the
 *    provider works without configuration and simply does better with it.
 *
 * 2. There is no "search by callsign" endpoint. Finding a flight means pulling
 *    the global state vector table and filtering it, which costs 4 credits.
 *    Polling one aircraft by its ICAO 24-bit address costs 1. So we resolve a
 *    callsign to an address once, remember it, and poll cheaply thereafter --
 *    which matters when anonymous access allows only 400 credits a day.
 */
import type {
  DataSource,
  Flight,
  FlightPosition,
  FlightStatus,
} from "@/types/flight";
import { serverConfig } from "@/config";
import { TtlCache } from "@/lib/flight/cache";
import { callsignCandidates, displayFlightNumber } from "@/lib/flight/callsign";
import { FlightError } from "@/lib/flight/errors";
import { fetchJson } from "@/lib/flight/http";
import { buildPosition, normalizeFlightIdentifier } from "@/lib/flight/validation";
import { metersToFeet } from "@/lib/geography/constants";
import type { FlightDataProvider } from "./types";

const STATES_URL = "https://opensky-network.org/api/states/all";
const TOKEN_URL =
  "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";

const PROVIDER_ID = "opensky";

const SOURCE: DataSource = {
  providerId: PROVIDER_ID,
  providerName: "OpenSky Network",
  live: true,
  attribution: "Live positions from The OpenSky Network",
};

/**
 * OpenSky state vectors arrive as positional arrays, not objects.
 * Indices per the published schema; naming them here stops the rest of the
 * file from being a wall of magic numbers.
 */
const enum StateIndex {
  Icao24 = 0,
  Callsign = 1,
  OriginCountry = 2,
  TimePosition = 3,
  LastContact = 4,
  Longitude = 5,
  Latitude = 6,
  BaroAltitude = 7,
  OnGround = 8,
  Velocity = 9,
  TrueTrack = 10,
  VerticalRate = 11,
  GeoAltitude = 13,
}

type StateVector = unknown[];

type StatesResponse = {
  time?: unknown;
  states?: StateVector[] | null;
};

/** Callsign -> ICAO 24-bit address. Aircraft keep the same address all day. */
const addressCache = new TtlCache<string | null>(30 * 60 * 1000, 200);

let cachedToken: { value: string; expiresAtMs: number } | null = null;

/**
 * A bearer token, or null when running anonymously.
 *
 * Tokens last 30 minutes; we refresh a minute early to avoid racing expiry
 * mid-request.
 */
async function getAccessToken(): Promise<string | null> {
  const { clientId, clientSecret } = serverConfig.openSky;
  if (!clientId || !clientSecret) return null;

  const now = Date.now();
  if (cachedToken && cachedToken.expiresAtMs > now) return cachedToken.value;

  try {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }),
      cache: "no-store",
    });

    if (!response.ok) {
      console.warn(
        `[opensky] token request failed (${response.status}); continuing anonymously`,
      );
      return null;
    }

    const payload = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!payload.access_token) return null;

    const lifetimeMs = (payload.expires_in ?? 1_800) * 1000;
    cachedToken = {
      value: payload.access_token,
      expiresAtMs: now + lifetimeMs - 60_000,
    };
    return cachedToken.value;
  } catch (error) {
    // Authentication is an optimisation here, never a hard requirement.
    console.warn("[opensky] token request errored; continuing anonymously", error);
    return null;
  }
}

async function fetchStates(params: URLSearchParams): Promise<{
  states: StateVector[];
  timeMs: number;
}> {
  const token = await getAccessToken();
  const query = params.toString();

  const payload = await fetchJson<StatesResponse>(
    query ? `${STATES_URL}?${query}` : STATES_URL,
    {
      allowNotFound: true,
      timeoutMs: 12_000,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    },
  );

  const timeSeconds =
    typeof payload?.time === "number" ? payload.time : Date.now() / 1000;

  return { states: payload?.states ?? [], timeMs: timeSeconds * 1000 };
}

const stringAt = (state: StateVector, index: number): string | null => {
  const value = state[index];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
};

/**
 * Convert a state vector into a position.
 *
 * OpenSky reports altitude in metres and speed in metres per second; the rest
 * of Flightscape works in feet and knots, so conversion happens here at the
 * provider boundary rather than leaking units downstream.
 */
function toPosition(state: StateVector): FlightPosition | null {
  const baroAltitude = state[StateIndex.BaroAltitude];
  const geoAltitude = state[StateIndex.GeoAltitude];
  const altitudeMeters =
    typeof baroAltitude === "number"
      ? baroAltitude
      : typeof geoAltitude === "number"
        ? geoAltitude
        : null;

  const velocity = state[StateIndex.Velocity];
  const verticalRate = state[StateIndex.VerticalRate];
  const onGround = state[StateIndex.OnGround] === true;

  // Prefer the time the position was actually determined over last contact.
  const timePosition = state[StateIndex.TimePosition];
  const lastContact = state[StateIndex.LastContact];
  const timestampSeconds =
    typeof timePosition === "number"
      ? timePosition
      : typeof lastContact === "number"
        ? lastContact
        : null;

  if (timestampSeconds === null) return null;

  return buildPosition({
    latitude: state[StateIndex.Latitude],
    longitude: state[StateIndex.Longitude],
    altitude: altitudeMeters === null ? null : metersToFeet(altitudeMeters),
    heading: state[StateIndex.TrueTrack],
    // m/s -> knots
    speed: typeof velocity === "number" ? velocity * 1.943_844 : null,
    // m/s -> ft/min
    verticalSpeed:
      typeof verticalRate === "number" ? verticalRate * 196.850_4 : null,
    roll: null,
    onGround,
    timestamp: timestampSeconds,
  });
}

export class OpenSkyFlightProvider implements FlightDataProvider {
  readonly id = PROVIDER_ID;
  readonly name = SOURCE.providerName;
  readonly attribution = SOURCE.attribution;
  readonly isLive = true;

  async searchFlight(identifier: string): Promise<Flight[]> {
    const normalized = normalizeFlightIdentifier(identifier);
    if (!normalized) throw new FlightError("invalid_identifier");

    const wanted = new Set(callsignCandidates(normalized));

    // The global table: the only way to look up a callsign on this API.
    const { states } = await fetchStates(new URLSearchParams());

    const matches = states.filter((state) => {
      const callsign = stringAt(state, StateIndex.Callsign)?.replace(/\s+/g, "");
      return callsign !== null && callsign !== undefined && wanted.has(callsign);
    });

    return matches
      .map((state) => this.toFlight(state))
      .filter((flight): flight is Flight => flight !== null);
  }

  async getLivePosition(flightId: string): Promise<FlightPosition | null> {
    const address = await this.resolveAddress(flightId);
    if (!address) return null;

    const { states } = await fetchStates(new URLSearchParams({ icao24: address }));
    if (states.length === 0) return null;

    return toPosition(states[0]);
  }

  async getFlightDetails(flightId: string): Promise<Flight | null> {
    const address = await this.resolveAddress(flightId);
    if (!address) return null;

    const { states } = await fetchStates(new URLSearchParams({ icao24: address }));
    return states.length > 0 ? this.toFlight(states[0]) : null;
  }

  /**
   * The ICAO 24-bit address for a flight id.
   *
   * Taken straight from the id when present. Otherwise resolved once via a
   * global scan and remembered, so subsequent polls cost a single credit.
   */
  private async resolveAddress(flightId: string): Promise<string | null> {
    const parts = flightId.split(":");
    const embedded = parts[0] === PROVIDER_ID ? parts[2] : parts[1];
    if (embedded && /^[0-9a-f]{6}$/i.test(embedded)) {
      return embedded.toLowerCase();
    }

    const rawCallsign = parts[0] === PROVIDER_ID ? parts[1] : parts[0];
    const callsign = rawCallsign ? normalizeFlightIdentifier(rawCallsign) : null;
    if (!callsign) throw new FlightError("invalid_identifier");

    return addressCache.fetch(callsign, async () => {
      const flights = await this.searchFlight(callsign);
      if (flights.length === 0) return null;
      const found = flights[0].id.split(":")[2];
      return found ?? null;
    });
  }

  private toFlight(state: StateVector): Flight | null {
    const address = stringAt(state, StateIndex.Icao24)?.toLowerCase();
    const callsign = stringAt(state, StateIndex.Callsign)?.replace(/\s+/g, "");
    if (!address || !callsign) return null;

    const onGround = state[StateIndex.OnGround] === true;
    const status: FlightStatus = onGround ? "scheduled" : "active";

    return {
      id: `${PROVIDER_ID}:${callsign}:${address}`,
      callsign,
      flightNumber: displayFlightNumber(callsign),
      // OpenSky's state vectors carry no airline or route information; the
      // fields stay null rather than being guessed at.
      airline: null,
      origin: null,
      destination: null,
      status,
      aircraftType: null,
      registration: null,
      departureTime: null,
      arrivalTime: null,
      estimatedArrival: null,
      source: SOURCE,
    };
  }
}
