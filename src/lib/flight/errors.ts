/**
 * Typed failures for the flight pipeline.
 *
 * Providers throw these instead of letting raw fetch/parse errors escape, so
 * the API layer can map every failure onto a message a person can act on. The
 * raw cause is kept for server logs and never sent to the browser.
 */

export type FlightErrorCode =
  | "invalid_identifier"
  | "not_found"
  | "no_live_position"
  | "rate_limited"
  | "provider_unavailable"
  | "network"
  | "invalid_response"
  | "unknown";

/** What the user is told. Deliberately free of provider names and stack traces. */
const USER_MESSAGES: Record<FlightErrorCode, string> = {
  invalid_identifier:
    "That doesn't look like a flight number. Try something like AC103.",
  not_found:
    "We couldn't find a flight with that number.",
  no_live_position:
    "We couldn't find a live position for this flight.",
  rate_limited:
    "The flight data service is busy right now. Give it a moment and try again.",
  provider_unavailable:
    "The flight data service isn't responding at the moment.",
  network:
    "We couldn't reach the flight data service. Check your connection and try again.",
  invalid_response:
    "The flight data service returned something we couldn't read.",
  unknown:
    "Something went wrong loading this flight.",
};

export class FlightError extends Error {
  readonly code: FlightErrorCode;
  /** Safe to render in the browser. */
  readonly userMessage: string;
  readonly status: number;

  constructor(
    code: FlightErrorCode,
    options: { cause?: unknown; detail?: string } = {},
  ) {
    super(options.detail ?? code, { cause: options.cause });
    this.name = "FlightError";
    this.code = code;
    this.userMessage = USER_MESSAGES[code];
    this.status = statusFor(code);
  }
}

function statusFor(code: FlightErrorCode): number {
  switch (code) {
    case "invalid_identifier":
      return 400;
    case "not_found":
    case "no_live_position":
      return 404;
    case "rate_limited":
      return 429;
    case "provider_unavailable":
    case "network":
      return 503;
    default:
      return 500;
  }
}

/** Coerce anything thrown into a FlightError without losing the cause. */
export function toFlightError(error: unknown): FlightError {
  if (error instanceof FlightError) return error;
  return new FlightError("unknown", { cause: error });
}
