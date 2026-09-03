/**
 * The wire contract between our API routes and the browser.
 *
 * Kept in one place so the route handlers and the client hooks cannot drift
 * apart. Every response carries `serverTime`: the browser's clock may be off
 * by seconds or minutes, and data age must be judged against the same clock
 * that produced the timestamps, not the viewer's.
 */
import type { Flight, FlightPosition } from "@/types/flight";

export type ApiError = {
  code: string;
  message: string;
};

export type SearchResponse = {
  flights: Flight[];
  serverTime: string;
};

export type PositionResponse = {
  /** Null when the provider currently has no fix for this aircraft. */
  position: FlightPosition | null;
  serverTime: string;
  /** Seconds the client should wait before polling again. */
  pollAfterSeconds: number;
};

export type FlightDetailsResponse = {
  flight: Flight;
  serverTime: string;
};

export type ApiResponse<T> = T | { error: ApiError };

export function isApiError<T>(
  payload: ApiResponse<T>,
): payload is { error: ApiError } {
  return typeof payload === "object" && payload !== null && "error" in payload;
}
