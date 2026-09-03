import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdsbFlightProvider, clearRouteCache } from "./adsb";
import { FlightError } from "@/lib/flight/errors";
import { resetMinRequestSpacing, setMinRequestSpacing } from "@/lib/flight/http";

/**
 * Upstream is stubbed at the fetch boundary so these tests exercise the real
 * parsing, validation and fallback logic without touching the network.
 */

const ROUTE_BODY = {
  response: {
    flightroute: {
      callsign: "ACA103",
      callsign_icao: "ACA103",
      callsign_iata: "AC103",
      airline: { name: "Air Canada", icao: "ACA", iata: "AC" },
      origin: {
        iata_code: "YYZ",
        icao_code: "CYYZ",
        name: "Lester B. Pearson International Airport",
        municipality: "Toronto",
        country_name: "Canada",
        latitude: 43.6772,
        longitude: -79.6306,
        elevation: 569,
      },
      destination: {
        iata_code: "YVR",
        icao_code: "CYVR",
        name: "Vancouver International Airport",
        municipality: "Vancouver",
        country_name: "Canada",
        latitude: 49.1939,
        longitude: -123.184,
        elevation: 14,
      },
    },
  },
};

const AIRCRAFT = {
  hex: "c02f41",
  flight: "ACA103  ",
  r: "C-FGDT",
  t: "B78X",
  lat: 45.12,
  lon: -95.4,
  alt_baro: 37_000,
  gs: 487,
  track: 274.5,
  true_heading: 276.1,
  baro_rate: 64,
  roll: -1.2,
  seen_pos: 2.5,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Route requests to canned bodies by URL. */
function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  const spy = vi.fn(async (input: RequestInfo | URL) => handler(String(input)));
  vi.stubGlobal("fetch", spy);
  return spy;
}

let provider: AdsbFlightProvider;

beforeEach(() => {
  // Fetch is stubbed throughout this file, so the politeness delay would only
  // slow the suite down.
  setMinRequestSpacing(0);
  clearRouteCache();
  provider = new AdsbFlightProvider();
});

afterEach(() => {
  resetMinRequestSpacing();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AdsbFlightProvider.searchFlight", () => {
  it("resolves an IATA flight number to a live aircraft", async () => {
    stubFetch((url) => {
      if (url.includes("adsbdb")) return jsonResponse(ROUTE_BODY);
      if (url.includes("/callsign/ACA103")) {
        return jsonResponse({ ac: [AIRCRAFT], now: Date.now(), total: 1 });
      }
      return jsonResponse({ ac: [], now: Date.now(), total: 0 });
    });

    const [flight] = await provider.searchFlight("AC103");

    expect(flight.callsign).toBe("ACA103");
    expect(flight.flightNumber).toBe("AC103");
    expect(flight.airline?.name).toBe("Air Canada");
    expect(flight.origin?.iata).toBe("YYZ");
    expect(flight.destination?.iata).toBe("YVR");
    expect(flight.status).toBe("active");
    expect(flight.source.live).toBe(true);
    expect(flight.id).toBe("adsb:ACA103:c02f41");
  });

  it("rejects a malformed identifier before making any request", async () => {
    const spy = stubFetch(() => jsonResponse({}));

    await expect(provider.searchFlight("../etc/passwd")).rejects.toBeInstanceOf(
      FlightError,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns the route with status unknown when nothing is airborne", async () => {
    stubFetch((url) =>
      url.includes("adsbdb")
        ? jsonResponse(ROUTE_BODY)
        : jsonResponse({ ac: [], now: Date.now(), total: 0 }),
    );

    const [flight] = await provider.searchFlight("AC103");

    // We can name the flight, but we must not claim it is flying.
    expect(flight.status).toBe("unknown");
    expect(flight.origin?.iata).toBe("YYZ");
  });

  it("returns nothing when neither service knows the flight", async () => {
    stubFetch((url) =>
      url.includes("adsbdb")
        ? jsonResponse({ response: "unknown callsign" })
        : jsonResponse({ ac: [], now: Date.now(), total: 0 }),
    );

    expect(await provider.searchFlight("ZZ9999")).toEqual([]);
  });

  it("still returns the aircraft when route lookup fails entirely", async () => {
    stubFetch((url) => {
      if (url.includes("adsbdb")) return jsonResponse({}, 500);
      return jsonResponse({ ac: [AIRCRAFT], now: Date.now(), total: 1 });
    });

    const [flight] = await provider.searchFlight("ACA103");

    expect(flight.callsign).toBe("ACA103");
    expect(flight.origin).toBeNull();
    expect(flight.airline).toBeNull();
  });

  it("surfaces a rate limit rather than pretending the flight is missing", async () => {
    stubFetch(() => jsonResponse({ error: "slow down" }, 429));

    await expect(provider.searchFlight("ACA999")).rejects.toMatchObject({
      code: "rate_limited",
    });
  });
});

describe("AdsbFlightProvider.getLivePosition", () => {
  it("derives the observation time from seen_pos, not the response time", async () => {
    const now = Date.now();
    stubFetch(() => jsonResponse({ ac: [AIRCRAFT], now, total: 1 }));

    const position = await provider.getLivePosition("adsb:ACA103:c02f41");

    expect(position).not.toBeNull();
    // seen_pos of 2.5s means the fix is 2.5 seconds older than the response.
    expect(Date.parse(position!.timestamp)).toBeCloseTo(now - 2_500, -2);
  });

  it("maps every field with the right units and preference order", async () => {
    stubFetch(() => jsonResponse({ ac: [AIRCRAFT], now: Date.now(), total: 1 }));

    const position = (await provider.getLivePosition("adsb:ACA103:c02f41"))!;

    expect(position.latitude).toBe(45.12);
    expect(position.altitude).toBe(37_000);
    expect(position.speed).toBe(487);
    // true_heading is preferred over track.
    expect(position.heading).toBe(276.1);
    expect(position.verticalSpeed).toBe(64);
    expect(position.roll).toBe(-1.2);
    expect(position.onGround).toBe(false);
  });

  it("picks the airframe named in the id when a callsign is duplicated", async () => {
    const other = { ...AIRCRAFT, hex: "aaaaaa", lat: 10, lon: 10 };
    stubFetch(() =>
      jsonResponse({ ac: [other, AIRCRAFT], now: Date.now(), total: 2 }),
    );

    const position = (await provider.getLivePosition("adsb:ACA103:c02f41"))!;
    expect(position.latitude).toBe(45.12);
  });

  it("returns null when the feed has no fix, rather than a remembered one", async () => {
    stubFetch(() => jsonResponse({ ac: [], now: Date.now(), total: 0 }));

    expect(await provider.getLivePosition("adsb:ACA103:c02f41")).toBeNull();
  });

  it("treats an on-ground aircraft as altitude zero", async () => {
    stubFetch(() =>
      jsonResponse({
        ac: [{ ...AIRCRAFT, alt_baro: "ground", gs: 12 }],
        now: Date.now(),
        total: 1,
      }),
    );

    const position = (await provider.getLivePosition("adsb:ACA103:c02f41"))!;
    expect(position.onGround).toBe(true);
    expect(position.altitude).toBe(0);
  });

  it("returns null for a record with unusable coordinates", async () => {
    stubFetch(() =>
      jsonResponse({
        ac: [{ ...AIRCRAFT, lat: null, lon: null }],
        now: Date.now(),
        total: 1,
      }),
    );

    expect(await provider.getLivePosition("adsb:ACA103:c02f41")).toBeNull();
  });

  it("does not crash on a wholly unexpected response shape", async () => {
    stubFetch(() => jsonResponse({ unexpected: "shape" }));

    expect(await provider.getLivePosition("adsb:ACA103:c02f41")).toBeNull();
  });

  it("maps a network failure onto a typed error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    await expect(
      provider.getLivePosition("adsb:ACA103:c02f41"),
    ).rejects.toMatchObject({ code: "network" });
  });
});
