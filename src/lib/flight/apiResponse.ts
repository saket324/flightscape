/**
 * Shared response helpers for the flight API routes.
 *
 * Server-only: keeps the "never leak an internal error to the browser" rule in
 * one place instead of repeating it in every handler.
 */
import { NextResponse } from "next/server";
import { toFlightError } from "./errors";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** A successful payload, explicitly uncacheable. */
export function jsonResponse<T>(payload: T): NextResponse {
  return NextResponse.json(payload, { headers: NO_STORE });
}

/**
 * Map any thrown value onto a safe error payload.
 *
 * The cause is logged server-side; the browser sees only a stable code and a
 * sentence written for a person to read.
 */
export function errorResponse(context: string, error: unknown): NextResponse {
  const flightError = toFlightError(error);

  if (flightError.status >= 500) {
    console.error(`[${context}]`, flightError.message, flightError.cause);
  }

  return NextResponse.json(
    { error: { code: flightError.code, message: flightError.userMessage } },
    { status: flightError.status, headers: NO_STORE },
  );
}
