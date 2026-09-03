/**
 * GET /api/flights/{id}
 *
 * Route, airline and aircraft metadata for a flight already identified by a
 * search. Used when a visualization is opened directly from a URL rather than
 * navigated to from the landing page.
 */
import { errorResponse, jsonResponse } from "@/lib/flight/apiResponse";
import { FlightError } from "@/lib/flight/errors";
import { getProviderForFlightId } from "@/providers/flight";

export const dynamic = "force-dynamic";

const FLIGHT_ID_PATTERN = /^[a-z]+:[A-Z0-9]{2,10}(?::[0-9a-fA-F]{6})?$/;

export async function GET(
  _request: Request,
  context: RouteContext<"/api/flights/[id]">,
) {
  try {
    const { id } = await context.params;
    const flightId = decodeURIComponent(id);

    if (!FLIGHT_ID_PATTERN.test(flightId)) {
      throw new FlightError("invalid_identifier");
    }

    const flight = await getProviderForFlightId(flightId).getFlightDetails(
      flightId,
    );
    if (!flight) throw new FlightError("not_found");

    return jsonResponse({ flight, serverTime: new Date().toISOString() });
  } catch (error) {
    return errorResponse("api/flights/details", error);
  }
}
