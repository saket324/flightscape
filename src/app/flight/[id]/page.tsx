/**
 * /flight/{id} -- the visualization.
 *
 * Flight metadata is fetched on the server so the first paint already names
 * the flight and its route, rather than showing an empty globe while the
 * browser makes its own round trip. Positions are fetched client-side from
 * there on, since they change every few seconds.
 */
import { notFound } from "next/navigation";
import type { Flight } from "@/types/flight";
import { FlightExperience } from "@/components/flight/FlightExperience";
import { FlightUnavailable } from "@/components/flight/FlightUnavailable";
import { FlightError, toFlightError } from "@/lib/flight/errors";
import { getProviderForFlightId } from "@/providers/flight";

// Live data: never prerendered, never cached.
export const dynamic = "force-dynamic";

const FLIGHT_ID_PATTERN = /^[a-z]+:[A-Z0-9]{2,10}(?::[0-9a-fA-F]{6})?$/;

type LoadResult =
  | { ok: true; flight: Flight }
  | { ok: false; code: string; message: string };

/**
 * Fetch the flight, turning any failure into a value.
 *
 * Kept separate from rendering so no JSX is constructed inside a try/catch:
 * React renders components after this function returns, so a render-time
 * error would escape the catch anyway and the structure would be misleading.
 */
async function loadFlight(flightId: string): Promise<LoadResult> {
  try {
    const flight =
      await getProviderForFlightId(flightId).getFlightDetails(flightId);

    if (!flight) {
      const error = new FlightError("not_found");
      return { ok: false, code: error.code, message: error.userMessage };
    }

    return { ok: true, flight };
  } catch (error) {
    const flightError = toFlightError(error);
    console.error("[flight page]", flightError.message, flightError.cause);
    return {
      ok: false,
      code: flightError.code,
      message: flightError.userMessage,
    };
  }
}

export default async function FlightPage({
  params,
}: PageProps<"/flight/[id]">) {
  const { id } = await params;
  const flightId = decodeURIComponent(id);

  if (!FLIGHT_ID_PATTERN.test(flightId)) notFound();

  const result = await loadFlight(flightId);

  if (!result.ok) {
    return (
      <FlightUnavailable
        reason={result.code}
        message={result.message}
        flightId={flightId}
      />
    );
  }

  return <FlightExperience flight={result.flight} />;
}
