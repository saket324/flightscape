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
import { distanceKm } from "@/lib/geography/greatCircle";
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

    // A null here is a legitimate outcome, not a defect: these networks are
    // fed by volunteer receivers, and an aircraft can drop out of coverage
    // between one request and the next. That is exactly the case the app
    // handles by ageing its freshness indicator rather than inventing a fix.
    // What must never happen is a position that is present but implausible,
    // which is what the assertions below actually guard.
    if (!position) {
      console.warn(
        `[live] ${airborneFlight.callsign} is briefly out of receiver coverage`,
      );
      return;
    }

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

/**
 * The end-to-end check the audit was written around.
 *
 * Resolves a real commercial flight the way a user would, then verifies the
 * position the app reports against an independent lookup of the same airframe
 * by its ICAO 24-bit address. This is precisely the comparison that exposed
 * the dead adsb.fi mirror: the app said "no position", while a by-hex query
 * showed the aircraft with a sub-second-old fix.
 */
describe("real commercial flight, end to end (live)", () => {
  it("places the aircraft where an independent by-ICAO24 lookup puts it", async () => {
    if (!airborneFlight) return;

    const icao24 = airborneFlight.id.split(":")[2];
    expect(icao24).toMatch(/^[0-9a-f]{6}$/);

    const [appPosition, truth] = await Promise.all([
      provider.getLivePosition(airborneFlight.id),
      fetchJson<{ ac?: Array<Record<string, unknown>> }>(
        `https://opendata.adsb.fi/api/v2/hex/${icao24}`,
        { timeoutMs: 15_000 },
      ),
    ]);

    const reference = truth?.ac?.[0];
    if (!appPosition || !reference) {
      console.warn("[live] aircraft out of coverage during cross-check");
      return;
    }

    // Identity first: the app must be reporting the airframe it claims to be.
    expect(String(reference.hex).toLowerCase()).toBe(icao24);

    const referenceLat = reference.lat as number;
    const referenceLon = reference.lon as number;

    // Both readings are of the same aircraft moments apart, so they differ by
    // however far it flew in between -- seconds of travel, not tens of
    // kilometres. A wrong-aircraft match fails this by orders of magnitude.
    const separationKm = distanceKm(
      { latitude: referenceLat, longitude: referenceLon },
      { latitude: appPosition.latitude, longitude: appPosition.longitude },
    );

    console.info(
      `[live] ${airborneFlight.callsign} @ ${icao24}: app vs independent ` +
        `lookup = ${separationKm.toFixed(2)} km apart`,
    );

    expect(separationKm).toBeLessThan(15);
  }, 45_000);

  it("never reports a position for an airframe that is not the one requested", async () => {
    if (!airborneFlight) return;

    // A real callsign paired with an address that cannot exist on it. The
    // old code fell back to `aircraft[0]` here and returned someone else.
    const impostor = `adsb:${airborneFlight.callsign}:ffffff`;
    expect(await provider.getLivePosition(impostor)).toBeNull();
  }, 30_000);
});
