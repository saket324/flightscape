/**
 * GET /api/flights/{id}/position
 *
 * The hot path: called every few seconds for the duration of a session.
 *
 * A null position is a 200, not an error. "The network cannot see this
 * aircraft right now" is a normal, temporary condition -- the client keeps
 * dead-reckoning from its last known fix and ages the freshness indicator,
 * which is exactly right. Turning it into an error would tear down a working
 * visualization over a single missed poll.
 */
import { serverConfig } from "@/config";
import { errorResponse, jsonResponse } from "@/lib/flight/apiResponse";
import { FlightError } from "@/lib/flight/errors";
import { getProviderForFlightId } from "@/providers/flight";

export const dynamic = "force-dynamic";

/** Ids are provider-prefixed and made of safe tokens only. */
const FLIGHT_ID_PATTERN = /^[a-z]+:[A-Z0-9]{2,10}(?::[0-9a-fA-F]{6})?$/;

export async function GET(
  _request: Request,
  context: RouteContext<"/api/flights/[id]/position">,
) {
  try {
    const { id } = await context.params;
    const flightId = decodeURIComponent(id);

    if (!FLIGHT_ID_PATTERN.test(flightId)) {
      throw new FlightError("invalid_identifier");
    }

    const provider = getProviderForFlightId(flightId);
    const position = await provider.getLivePosition(flightId);

    return jsonResponse({
      position,
      serverTime: new Date().toISOString(),
      pollAfterSeconds: serverConfig.pollIntervalSeconds,
    });
  } catch (error) {
    return errorResponse("api/flights/position", error);
  }
}
