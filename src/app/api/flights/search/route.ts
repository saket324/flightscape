/**
 * GET /api/flights/search?q=AC103
 *
 * Runs on the server so provider credentials never reach the browser, and so
 * upstream rate limiting is coordinated in one place rather than per tab.
 *
 * `?demo=1` returns the simulated flight instead. It is a separate parameter
 * rather than a fallback: a failed live search never silently becomes demo
 * data, the user has to ask for it.
 */
import type { NextRequest } from "next/server";
import { errorResponse, jsonResponse } from "@/lib/flight/apiResponse";
import { FlightError } from "@/lib/flight/errors";
import { normalizeFlightIdentifier } from "@/lib/flight/validation";
import { getDemoProvider, getFlightProvider } from "@/providers/flight";

// Live positions must never be served from a cached render.
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get("q") ?? "";
  const wantsDemo = request.nextUrl.searchParams.get("demo") === "1";

  try {
    const provider = wantsDemo ? getDemoProvider() : getFlightProvider();

    if (!wantsDemo && !normalizeFlightIdentifier(query)) {
      throw new FlightError("invalid_identifier");
    }

    const flights = await provider.searchFlight(query);
    return jsonResponse({ flights, serverTime: new Date().toISOString() });
  } catch (error) {
    return errorResponse("api/flights/search", error);
  }
}
