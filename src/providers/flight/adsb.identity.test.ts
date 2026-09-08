/**
 * Regression tests for feed normalisation and aircraft identity.
 *
 * Every test here corresponds to a defect found in the September 2026 audit
 * (docs/flight-data-pipeline.md). The originals were all silent: a feed that
 * returned nothing, or a position that belonged to a different aeroplane.
 * Nothing threw, so nothing caught them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AdsbFlightProvider,
  clearRouteCache,
  normalizeFeedClock,
  normalizeTransmittedCallsign,
  unwrapFeed,
} from "./adsb";

/** A real adsb.fi response, captured live during the audit. */
const ADSB_FI_BODY = {
  ac: [
    {
      hex: "4070ed",
      type: "adsb_icao",
      flight: "EXS59N  ",
      r: "G-JZHZ",
      t: "B738",
      alt_baro: 35000,
      gs: 438.5,
      track: 193.72,
      true_heading: 199.27,
      baro_rate: 0,
      lat: 49.581066,
      lon: -3.849001,
      seen_pos: 0,
    },
  ],
  msg: "No error",
  now: 1788888548001,
  total: 1,
  ctime: 1788888548001,
  ptime: 0,
};

/** The equivalent adsb.lol envelope. Same key, same units, as it happens. */
const ADSB_LOL_BODY = {
  ac: ADSB_FI_BODY.ac,
  now: 1788888548001,
  total: 1,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  const spy = vi.fn(async (input: RequestInfo | URL) => handler(String(input)));
  vi.stubGlobal("fetch", spy);
  return spy;
}

let provider: AdsbFlightProvider;

beforeEach(() => {
  clearRouteCache();
  provider = new AdsbFlightProvider();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("unwrapFeed", () => {
  it("reads the real adsb.fi envelope", () => {
    // The audit's root cause: this returned [] because the adapter read
    // `body.aircraft`, a key adsb.fi does not use.
    const { aircraft } = unwrapFeed(ADSB_FI_BODY);
    expect(aircraft).toHaveLength(1);
    expect(aircraft[0].hex).toBe("4070ed");
  });

  it("reads the adsb.lol envelope", () => {
    expect(unwrapFeed(ADSB_LOL_BODY).aircraft).toHaveLength(1);
  });

  it("accepts an `aircraft` key too, should a mirror use one", () => {
    expect(unwrapFeed({ aircraft: [{ hex: "abc123" }] }).aircraft).toHaveLength(1);
  });

  it("returns an empty list for junk rather than throwing", () => {
    for (const payload of [null, undefined, {}, [], 42, "nope", { ac: null }]) {
      expect(unwrapFeed(payload).aircraft).toEqual([]);
    }
  });
});

describe("normalizeFeedClock", () => {
  it("passes milliseconds through", () => {
    expect(normalizeFeedClock(1788888548001)).toBe(1788888548001);
  });

  it("promotes seconds to milliseconds", () => {
    expect(normalizeFeedClock(1788888548)).toBe(1788888548000);
  });

  it("falls back to now for missing or nonsensical values", () => {
    const now = 1788888548001;
    for (const value of [null, undefined, 0, -5, NaN, "soon", {}]) {
      expect(normalizeFeedClock(value, now)).toBe(now);
    }
  });

  it("never produces a far-future timestamp from a millisecond clock", () => {
    // The original adsb.fi adapter multiplied a ms clock by 1000, landing in
    // the year ~58000, where sanitizeTimestamp rejected every position.
    const result = normalizeFeedClock(1788888548001);
    expect(new Date(result).getUTCFullYear()).toBeLessThan(2100);
  });
});

describe("normalizeTransmittedCallsign", () => {
  it("strips the space padding feeds emit", () => {
    expect(normalizeTransmittedCallsign("EXS59N  ")).toBe("EXS59N");
  });

  it("uppercases and removes interior whitespace", () => {
    expect(normalizeTransmittedCallsign(" exs 59n ")).toBe("EXS59N");
  });

  it("returns null for blank or non-string input", () => {
    for (const value of ["", "   ", null, undefined, 42, {}]) {
      expect(normalizeTransmittedCallsign(value)).toBeNull();
    }
  });
});

describe("getLivePosition: airframe identity", () => {
  it("queries by ICAO24 when the id carries one", async () => {
    const spy = stubFetch(() => jsonResponse(ADSB_FI_BODY));

    await provider.getLivePosition("adsb:EXS59N:4070ed");

    const urls = spy.mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.includes("/hex/4070ed"))).toBe(true);
    expect(urls.some((url) => url.includes("/callsign/"))).toBe(false);
  });

  it("returns null rather than a different aircraft when the airframe is absent", async () => {
    // The audit defect: `?? aircraft[0]` handed back whatever else was
    // transmitting that callsign, under this flight's identity.
    const someoneElse = {
      ...ADSB_FI_BODY.ac[0],
      hex: "aaaaaa",
      lat: 10,
      lon: 10,
    };
    stubFetch(() =>
      jsonResponse({ ac: [someoneElse], now: ADSB_FI_BODY.now, total: 1 }),
    );

    expect(await provider.getLivePosition("adsb:EXS59N:4070ed")).toBeNull();
  });

  it("picks the pinned airframe out of a shared-callsign response", async () => {
    const other = { ...ADSB_FI_BODY.ac[0], hex: "aaaaaa", lat: 10, lon: 10 };
    stubFetch(() =>
      jsonResponse({
        ac: [other, ADSB_FI_BODY.ac[0]],
        now: ADSB_FI_BODY.now,
        total: 2,
      }),
    );

    const position = await provider.getLivePosition("adsb:EXS59N:4070ed");
    expect(position?.latitude).toBeCloseTo(49.581066, 6);
  });

  it("requires an exact callsign match when no airframe is pinned", async () => {
    stubFetch(() =>
      jsonResponse({
        ac: [{ ...ADSB_FI_BODY.ac[0], flight: "SOMEONE " }],
        now: ADSB_FI_BODY.now,
        total: 1,
      }),
    );

    expect(await provider.getLivePosition("adsb:EXS59N")).toBeNull();
  });
});

describe("mirror failover", () => {
  it("serves a position from adsb.fi when adsb.lol rate-limits", async () => {
    // The exact end-to-end failure from the audit: adsb.lol 429s, and the
    // fallback must actually produce a position.
    const spy = stubFetch((url) => {
      if (url.includes("adsb.lol")) return jsonResponse({ error: "slow" }, 429);
      return jsonResponse(ADSB_FI_BODY);
    });

    const position = await provider.getLivePosition("adsb:EXS59N:4070ed");

    expect(position).not.toBeNull();
    expect(position!.latitude).toBeCloseTo(49.581066, 6);
    expect(position!.altitude).toBe(35_000);
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("produces a sane timestamp from the adsb.fi clock", async () => {
    stubFetch(() => jsonResponse(ADSB_FI_BODY));

    const position = await provider.getLivePosition("adsb:EXS59N:4070ed");

    const year = new Date(position!.timestamp).getUTCFullYear();
    expect(year).toBeGreaterThan(2020);
    expect(year).toBeLessThan(2100);
  });

  it("reports no position when every mirror is empty", async () => {
    stubFetch(() => jsonResponse({ ac: [], now: Date.now(), total: 0 }));
    expect(await provider.getLivePosition("adsb:EXS59N:4070ed")).toBeNull();
  });
});

describe("route attribution", () => {
  const routeFor = (icao: string, iata: string) => ({
    response: {
      flightroute: {
        callsign: icao,
        callsign_icao: icao,
        callsign_iata: iata,
        airline: { name: "Jet2.com", icao: "EXS", iata: "LS" },
        origin: {
          iata_code: "TFS",
          icao_code: "GCTS",
          name: "Tenerife Sur Airport",
          municipality: "Tenerife",
          country_name: "Spain",
          latitude: 28.0445,
          longitude: -16.5725,
          elevation: 209,
        },
        destination: {
          iata_code: "BRS",
          icao_code: "EGGD",
          name: "Bristol Airport",
          municipality: "Bristol",
          country_name: "United Kingdom",
          latitude: 51.3827,
          longitude: -2.71909,
          elevation: 622,
        },
      },
    },
  });

  it("attaches a route that belongs to the aircraft found", async () => {
    stubFetch((url) =>
      url.includes("adsbdb")
        ? jsonResponse(routeFor("EXS59N", "LS59N"))
        : jsonResponse(ADSB_FI_BODY),
    );

    const [flight] = await provider.searchFlight("LS59N");

    expect(flight.callsign).toBe("EXS59N");
    expect(flight.origin?.iata).toBe("TFS");
    expect(flight.destination?.iata).toBe("BRS");
  });

  it("withholds a route that belongs to a different callsign", async () => {
    // Route resolved for one candidate, aircraft found under another. The
    // position is real; the schedule is not this aircraft's, so it is dropped
    // rather than shown as fact.
    stubFetch((url) =>
      url.includes("adsbdb")
        ? jsonResponse(routeFor("XXX999", "ZZ999"))
        : jsonResponse(ADSB_FI_BODY),
    );

    const [flight] = await provider.searchFlight("LS59N");

    expect(flight.callsign).toBe("EXS59N");
    expect(flight.origin).toBeNull();
    expect(flight.destination).toBeNull();
  });
});
