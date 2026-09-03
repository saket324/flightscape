/**
 * HTTP access to upstream flight APIs.
 *
 * Everything here runs on the server. Centralising it means every provider
 * gets the same timeout, the same identifying User-Agent (community ADS-B
 * aggregators ask for one) and the same mapping from transport failures onto
 * FlightError codes.
 */
import { FlightError } from "./errors";

const DEFAULT_TIMEOUT_MS = 8_000;

const USER_AGENT =
  "Flightscape/0.1 (+https://github.com/saket324/flightscape)";

/**
 * Minimum spacing between requests to any one upstream host.
 *
 * The community ADS-B networks are run on donated hardware and rate-limit on a
 * short sliding window without sending Retry-After. A single viewer polling
 * one flight makes a request every eight seconds and is nowhere near any
 * limit, but concurrent viewers share this server's IP, so requests are
 * serialised per host to keep our footprint polite.
 *
 * Measured rather than guessed: at 250ms a burst of about ten requests was
 * enough to draw a 429 from adsb.fi. A one-second floor is invisible against
 * an eight-second poll and stays comfortably inside what these feeds accept.
 */
const DEFAULT_MIN_REQUEST_SPACING_MS = 1_000;

let minRequestSpacingMs = DEFAULT_MIN_REQUEST_SPACING_MS;

/**
 * Override the spacing floor.
 *
 * Exists for tests with a stubbed fetch, which never touch a real upstream and
 * should not spend a second per request waiting to be polite to nobody. The
 * live integration tests leave it at the default, since they do.
 */
export function setMinRequestSpacing(milliseconds: number): void {
  minRequestSpacingMs = Math.max(0, milliseconds);
}

export function resetMinRequestSpacing(): void {
  minRequestSpacingMs = DEFAULT_MIN_REQUEST_SPACING_MS;
}

const hostQueues = new Map<string, Promise<void>>();

/**
 * Requests currently in flight, keyed by URL.
 *
 * Two viewers watching the same flight would otherwise each poll upstream for
 * the same position. Sharing the in-flight promise collapses them into one
 * request with no staleness whatsoever -- this is deduplication, not caching:
 * nothing is retained after the response resolves.
 */
const inFlight = new Map<string, Promise<unknown>>();

function throttleForHost(host: string): Promise<void> {
  const previous = hostQueues.get(host) ?? Promise.resolve();

  const next = previous.then(
    () => new Promise<void>((resolve) => setTimeout(resolve, minRequestSpacingMs)),
  );

  // Keep the chain from growing without bound across a long-lived process.
  hostQueues.set(host, next);
  next.finally(() => {
    if (hostQueues.get(host) === next) hostQueues.delete(host);
  });

  return previous;
}

export type FetchJsonOptions = {
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Treat a 404 as an empty result rather than an error. */
  allowNotFound?: boolean;
  signal?: AbortSignal;
};

/**
 * Fetch and parse JSON, or throw a FlightError.
 *
 * Returns null only when `allowNotFound` is set and upstream answered 404 --
 * "this flight isn't in the database" is a normal outcome, not a failure.
 */
export async function fetchJson<T>(
  url: string,
  options: FetchJsonOptions = {},
): Promise<T | null> {
  // Join an identical request that is already on its way, rather than making
  // a second one. Caller-specific options (timeout, abort signal) only apply
  // to the request that actually opens the connection, which is why an
  // aborted caller never cancels a shared fetch out from under the others.
  const existing = inFlight.get(url);
  if (existing) return existing as Promise<T | null>;

  const request = performFetch<T>(url, options).finally(() => {
    inFlight.delete(url);
  });

  inFlight.set(url, request);
  return request;
}

async function performFetch<T>(
  url: string,
  options: FetchJsonOptions,
): Promise<T | null> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    headers = {},
    allowNotFound = false,
  } = options;

  await throttleForHost(safeOrigin(url));

  // A hung upstream must not hold a request open indefinitely.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  if (options.signal) {
    options.signal.addEventListener("abort", () => controller.abort(), {
      once: true,
    });
  }

  let response: Response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        ...headers,
      },
      // Live positions must never be served from a cache.
      cache: "no-store",
    });
  } catch (cause) {
    const aborted = cause instanceof Error && cause.name === "AbortError";
    throw new FlightError(aborted ? "provider_unavailable" : "network", {
      cause,
      detail: `Request to ${safeOrigin(url)} failed`,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 404 && allowNotFound) return null;
  if (response.status === 429) {
    throw new FlightError("rate_limited", {
      detail: `${safeOrigin(url)} returned 429`,
    });
  }
  if (response.status >= 500) {
    throw new FlightError("provider_unavailable", {
      detail: `${safeOrigin(url)} returned ${response.status}`,
    });
  }
  if (!response.ok) {
    throw new FlightError("invalid_response", {
      detail: `${safeOrigin(url)} returned ${response.status}`,
    });
  }

  try {
    return (await response.json()) as T;
  } catch (cause) {
    throw new FlightError("invalid_response", {
      cause,
      detail: `${safeOrigin(url)} returned unparseable JSON`,
    });
  }
}

/** Host only -- keeps query strings out of logs and error messages. */
function safeOrigin(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "upstream";
  }
}
