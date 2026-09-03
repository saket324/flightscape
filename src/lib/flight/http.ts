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
 * short sliding window without sending Retry-After. A single user polling one
 * flight is nowhere near any limit, but several concurrent viewers share this
 * server's IP, so their requests are serialised per host to keep our footprint
 * polite. This is a floor on spacing, not a queue with a deadline: requests
 * still resolve in order, just never in a burst.
 */
const MIN_REQUEST_SPACING_MS = 250;

const hostQueues = new Map<string, Promise<void>>();

function throttleForHost(host: string): Promise<void> {
  const previous = hostQueues.get(host) ?? Promise.resolve();

  const next = previous.then(
    () => new Promise<void>((resolve) => setTimeout(resolve, MIN_REQUEST_SPACING_MS)),
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
