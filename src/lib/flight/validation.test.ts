import { describe, expect, it } from "vitest";
import {
  buildPosition,
  normalizeFlightIdentifier,
  sanitizeAltitudeFt,
  sanitizeCoordinates,
  sanitizeHeading,
  sanitizeRoll,
  sanitizeSpeedKt,
  sanitizeTimestamp,
  sanitizeVerticalSpeedFpm,
} from "./validation";

const NOW = Date.parse("2026-09-03T12:00:00.000Z");

describe("sanitizeCoordinates", () => {
  it("accepts a normal position", () => {
    expect(sanitizeCoordinates(43.5, -79.2)).toEqual({
      latitude: 43.5,
      longitude: -79.2,
    });
  });

  it("accepts the poles and the antimeridian edges", () => {
    expect(sanitizeCoordinates(90, 180)).not.toBeNull();
    expect(sanitizeCoordinates(-90, -180)).not.toBeNull();
  });

  it("rejects out-of-range values", () => {
    expect(sanitizeCoordinates(91, 0)).toBeNull();
    expect(sanitizeCoordinates(0, 181)).toBeNull();
    expect(sanitizeCoordinates(-91, 0)).toBeNull();
  });

  it("rejects the null island, which is almost always a null-as-zero bug", () => {
    expect(sanitizeCoordinates(0, 0)).toBeNull();
  });

  it("rejects NaN, Infinity, null and non-numeric junk", () => {
    expect(sanitizeCoordinates(NaN, 0)).toBeNull();
    expect(sanitizeCoordinates(Infinity, 0)).toBeNull();
    expect(sanitizeCoordinates(null, null)).toBeNull();
    expect(sanitizeCoordinates(undefined, undefined)).toBeNull();
    expect(sanitizeCoordinates("north", "west")).toBeNull();
    expect(sanitizeCoordinates({}, [])).toBeNull();
  });

  it("parses numeric strings, as some feeds send them", () => {
    expect(sanitizeCoordinates("43.5", "-79.2")).toEqual({
      latitude: 43.5,
      longitude: -79.2,
    });
  });
});

describe("scalar sanitisers", () => {
  it("keeps plausible altitudes and drops impossible ones", () => {
    expect(sanitizeAltitudeFt(37_000)).toBe(37_000);
    expect(sanitizeAltitudeFt(-200)).toBe(-200); // below sea level airports exist
    expect(sanitizeAltitudeFt(900_000)).toBeNull();
    expect(sanitizeAltitudeFt("ground")).toBeNull();
    expect(sanitizeAltitudeFt(null)).toBeNull();
  });

  it("rejects impossible speeds", () => {
    expect(sanitizeSpeedKt(487)).toBe(487);
    expect(sanitizeSpeedKt(0)).toBe(0);
    expect(sanitizeSpeedKt(-10)).toBeNull();
    expect(sanitizeSpeedKt(9_999)).toBeNull();
  });

  it("normalises headings rather than discarding them", () => {
    expect(sanitizeHeading(274)).toBe(274);
    expect(sanitizeHeading(-90)).toBe(270);
    expect(sanitizeHeading(400)).toBe(40);
    expect(sanitizeHeading(null)).toBeNull();
  });

  it("clamps roll to what a transport aircraft can do", () => {
    expect(sanitizeRoll(-12)).toBe(-12);
    expect(sanitizeRoll(88)).toBeNull();
  });

  it("bounds vertical speed", () => {
    expect(sanitizeVerticalSpeedFpm(-1_800)).toBe(-1_800);
    expect(sanitizeVerticalSpeedFpm(99_999)).toBeNull();
  });
});

describe("sanitizeTimestamp", () => {
  it("accepts ISO strings", () => {
    expect(sanitizeTimestamp("2026-09-03T11:59:50.000Z", NOW)).toBe(
      "2026-09-03T11:59:50.000Z",
    );
  });

  it("treats bare numbers as unix seconds", () => {
    expect(sanitizeTimestamp(NOW / 1000, NOW)).toBe("2026-09-03T12:00:00.000Z");
  });

  it("treats large numbers as unix milliseconds", () => {
    expect(sanitizeTimestamp(NOW, NOW)).toBe("2026-09-03T12:00:00.000Z");
  });

  it("rejects timestamps from the future", () => {
    expect(sanitizeTimestamp(NOW + 600_000, NOW)).toBeNull();
  });

  it("rejects timestamps from more than a day ago", () => {
    expect(sanitizeTimestamp(NOW - 172_800_000, NOW)).toBeNull();
  });

  it("rejects unparseable input", () => {
    expect(sanitizeTimestamp("yesterday", NOW)).toBeNull();
    expect(sanitizeTimestamp(null, NOW)).toBeNull();
    expect(sanitizeTimestamp(NaN, NOW)).toBeNull();
  });
});

describe("normalizeFlightIdentifier", () => {
  it("uppercases and strips separators", () => {
    expect(normalizeFlightIdentifier(" ac103 ")).toBe("AC103");
    expect(normalizeFlightIdentifier("ac-103")).toBe("AC103");
  });

  it("accepts the documented example flights", () => {
    for (const code of ["AC103", "UA84", "DL405", "WS15", "ACA103"]) {
      expect(normalizeFlightIdentifier(code)).toBe(code);
    }
  });

  it("rejects anything that is not a plausible callsign", () => {
    expect(normalizeFlightIdentifier("")).toBeNull();
    expect(normalizeFlightIdentifier("A")).toBeNull();
    expect(normalizeFlightIdentifier("WAY-TOO-LONG-FOR-A-CALLSIGN")).toBeNull();
    expect(normalizeFlightIdentifier("../../etc/passwd")).toBeNull();
    expect(normalizeFlightIdentifier("AC103;DROP")).toBeNull();
    expect(normalizeFlightIdentifier("<script>")).toBeNull();
  });
});

describe("buildPosition", () => {
  const valid = {
    latitude: 43.5,
    longitude: -79.2,
    altitude: 37_000,
    heading: 274,
    speed: 487,
    verticalSpeed: 0,
    timestamp: "2026-09-03T11:59:55.000Z",
  };

  it("assembles a complete position", () => {
    const result = buildPosition(valid, NOW)!;
    expect(result.latitude).toBe(43.5);
    expect(result.altitude).toBe(37_000);
    expect(result.heading).toBe(274);
    expect(result.onGround).toBe(false);
  });

  it("refuses to build without usable coordinates", () => {
    expect(buildPosition({ ...valid, latitude: 999 }, NOW)).toBeNull();
    expect(buildPosition({ ...valid, longitude: null }, NOW)).toBeNull();
  });

  it("refuses to build without a usable timestamp", () => {
    expect(buildPosition({ ...valid, timestamp: "nonsense" }, NOW)).toBeNull();
  });

  it("degrades missing optional fields to null instead of failing", () => {
    const result = buildPosition(
      {
        latitude: 43.5,
        longitude: -79.2,
        altitude: "ground",
        heading: undefined,
        speed: null,
        timestamp: valid.timestamp,
      },
      NOW,
    )!;

    expect(result).not.toBeNull();
    expect(result.altitude).toBeNull();
    expect(result.heading).toBeNull();
    expect(result.speed).toBeNull();
  });

  it("never emits NaN into the scene", () => {
    const result = buildPosition({ ...valid, altitude: NaN, speed: NaN }, NOW)!;
    expect(result.altitude).toBeNull();
    expect(result.speed).toBeNull();
  });
});
