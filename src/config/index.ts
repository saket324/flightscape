/**
 * Application configuration.
 *
 * Server-only values are read from `process.env` directly and must never be
 * imported into a client component. Values that are safe in the browser are
 * prefixed `NEXT_PUBLIC_` and re-exported through `publicConfig`.
 */

function readInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Safe to reference from the browser. */
export const publicConfig = {
  cesiumIonToken: process.env.NEXT_PUBLIC_CESIUM_ION_TOKEN?.trim() || null,
  cesiumBaseUrl: "/cesium",
} as const;

/** Server-only. Importing this from a client component is a bug. */
export const serverConfig = {
  providerId: (process.env.FLIGHT_PROVIDER?.trim() || "adsb").toLowerCase(),
  pollIntervalSeconds: readInt(process.env.FLIGHT_POLL_INTERVAL_SECONDS, 8),
  openSky: {
    clientId: process.env.OPENSKY_CLIENT_ID?.trim() || null,
    clientSecret: process.env.OPENSKY_CLIENT_SECRET?.trim() || null,
  },
} as const;

/** Tunables for the real-time pipeline, shared by client and server. */
export const timing = {
  /** How often the browser asks our API for a new position. */
  pollIntervalMs: 8_000,
  /** Backoff applied after a failed poll, doubling up to the cap. */
  pollBackoffMinMs: 8_000,
  pollBackoffMaxMs: 60_000,
  /** Data older than this is shown as DELAYED rather than LIVE. */
  delayedAfterSeconds: 30,
  /** Data older than this is shown as STALE. */
  staleAfterSeconds: 90,
  /** Beyond this we stop claiming to know where the aircraft is. */
  unavailableAfterSeconds: 300,
  /** Rolling track retention. Bounded so a long flight cannot grow forever. */
  maxTrackPoints: 900,
  minTrackPointSpacingMeters: 400,
} as const;
