/**
 * Live integration checks against the real upstream services.
 *
 * Excluded from `npm test` because they need the network and depend on which
 * aircraft happen to be flying. Run with `npm run test:live` to confirm the
 * providers still match reality after an upstream change.
 *
 * These assert on invariants rather than specific values -- a test expecting a
 * particular aircraft over a particular city would fail by design. The whole
 * file shares one aircraft lookup, because these feeds run on donated hardware
 * and a test suite has no business hammering them.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { Flight, FlightPosition } from "@/types/flight";
import { fetchJson } from "@/lib/flight/http";
import { AdsbFlightProvider } from "./adsb";

const provider = new AdsbFlightProvider();

type NearbyAircraft = { flight?: unknown; alt_baro?: unknown };

/** Both feeds, so a rate limit on one does not fail the run. */
const NEARBY_URLS = [
  "https://opendata.adsb.fi/api/v2/lat/51.47/lon/-0.46/dist/150",
  "https://api.adsb.lol/v2/lat/51.47/lon/-0.46/dist/150",
];

/** One airborne callsign, resolved once and reused by every test below. */
let airborneCallsign: string | null = null;
let airborneFlight: Flight | null = null;

async function findAirborneCallsign(): Promise<string | null> {
  for (const url of NEARBY_URLS) {
    let payload: { ac?: NearbyAircraft[]; aircraft?: NearbyAircraft[] } | null;
    try {
      payload = await fetchJson(url, { timeoutMs: 15_000 });
    } catch {
      continue;
    }

    const list = payload?.ac ?? payload?.aircraft ?? [];
    const airborne = list.find(
      (aircraft) =>
        typeof aircraft.flight === "string" &&
        aircraft.flight.trim().length >= 4 &&
        typeof aircraft.alt_baro === "number" &&
        aircraft.alt_baro > 10_000,
    );

    if (typeof airborne?.flight === "string") return airborne.flight.trim();
  }

  return null;
}

beforeAll(async () => {
  airborneCallsign = await findAirborneCallsign();
  if (!airborneCallsign) {
    console.warn("[live] no airborne aircraft found nearby");
    return;
  }

  const flights = await provider.searchFlight(airborneCallsign);
  airborneFlight = flights[0] ?? null;
  console.info(`[live] using ${airborneCallsign} (${airborneFlight?.id})`);
}, 60_000);

describe("adsbdb route lookup (live)", () => {
  it("resolves an IATA flight number to a real route", async () => {
    const flights = await provider.searchFlight("AC103");
    expect(flights.length).toBeGreaterThan(0);

    const [flight] = flights;
    expect(flight.callsign).toBe("ACA103");
    expect(flight.airline?.name).toMatch(/Air Canada/i);
    expect(flight.origin?.iata).toBe("YYZ");
    expect(flight.destination?.iata).toBe("YVR");

    // Airport coordinates must be usable as scene geometry.
    expect(Number.isFinite(flight.origin!.latitude)).toBe(true);
    expect(Math.abs(flight.origin!.latitude)).toBeLessThanOrEqual(90);
  }, 30_000);
});

describe("live positions (live)", () => {
  it("finds an airborne aircraft and reports it as active", () => {
    if (!airborneFlight) return;

    expect(airborneFlight.status).toBe("active");
    expect(airborneFlight.source.live).toBe(true);
    // The id must pin a specific airframe, not just a callsign.
    expect(airborneFlight.id).toMatch(/^adsb:[A-Z0-9]+:[0-9a-f]{6}$/);
  });

  it("returns a fresh, physically plausible position", async () => {
    if (!airborneFlight) return;

    const position = await provider.getLivePosition(airborneFlight.id);
    expect(position).not.toBeNull();

    const { latitude, longitude, altitude, speed, timestamp } =
      position as FlightPosition;

    expect(Number.isFinite(latitude)).toBe(true);
    expect(Math.abs(latitude)).toBeLessThanOrEqual(90);
    expect(Math.abs(longitude)).toBeLessThanOrEqual(180);
    expect(altitude === null || altitude > -1_500).toBe(true);
    expect(speed === null || (speed >= 0 && speed < 1_500)).toBe(true);

    // The whole product rests on this: the fix is from a moment ago, not a
    // remembered value from an earlier session.
    const ageSeconds = (Date.now() - Date.parse(timestamp)) / 1000;
    expect(ageSeconds).toBeGreaterThanOrEqual(-5);
    expect(ageSeconds).toBeLessThan(180);

    console.info(
      `[live] ${airborneFlight.callsign}: ${latitude.toFixed(3)}, ` +
        `${longitude.toFixed(3)} @ ${altitude ?? "unknown"} ft, ` +
        `${ageSeconds.toFixed(1)}s old`,
    );
  }, 30_000);

  it("returns an empty result for a callsign nobody flies", async () => {
    expect(await provider.searchFlight("ZZ9998")).toEqual([]);
  }, 30_000);
});
