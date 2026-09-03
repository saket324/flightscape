/**
 * What the user sees when a flight cannot be shown.
 *
 * Says plainly what happened and offers two ways forward. It does not fall
 * back to the demo on its own: substituting simulated data for a flight
 * someone asked to see would undermine the one thing this product promises.
 */
import Link from "next/link";
import { DEMO_FLIGHT_ID } from "@/providers/flight/demo";

const REASONS: Record<string, { title: string; detail: string }> = {
  not_found: {
    title: "We couldn't find a live position for this flight.",
    detail:
      "It may not be airborne right now, or no receiver in the network can currently hear it.",
  },
  no_live_position: {
    title: "We couldn't find a live position for this flight.",
    detail:
      "The flight exists, but nothing is reporting where it is at the moment.",
  },
  rate_limited: {
    title: "The flight data service is busy.",
    detail: "Give it a moment and try again.",
  },
  provider_unavailable: {
    title: "The flight data service isn't responding.",
    detail: "This usually clears up on its own within a few minutes.",
  },
  network: {
    title: "We couldn't reach the flight data service.",
    detail: "Check your connection and try again.",
  },
};

export function FlightUnavailable({
  reason,
  message,
  flightId,
}: {
  reason: string;
  message?: string;
  flightId?: string;
}) {
  const copy = REASONS[reason] ?? {
    title: message ?? "We couldn't load this flight.",
    detail: "Something went wrong on our side.",
  };

  return (
    <main className="flex h-full flex-col items-center justify-center px-6 text-center">
      <p className="font-mono text-xs tracking-[0.3em] text-ink-faint">
        FLIGHTSCAPE
      </p>

      <h1 className="mt-6 max-w-md text-xl text-ink sm:text-2xl">
        {copy.title}
      </h1>
      <p className="mt-3 max-w-sm text-sm text-ink-muted">{copy.detail}</p>

      {flightId && (
        <p className="mt-4 font-mono text-xs text-ink-faint/70">
          {flightId.split(":")[1] ?? flightId}
        </p>
      )}

      <div className="mt-8 flex flex-col gap-2 sm:flex-row">
        <Link
          href="/"
          className="rounded-lg border border-hairline px-5 py-2.5 text-sm text-ink-muted transition-colors hover:border-signal/40 hover:text-ink"
        >
          Try another flight
        </Link>
        <Link
          href={`/flight/${encodeURIComponent(DEMO_FLIGHT_ID)}`}
          className="rounded-lg bg-signal/15 px-5 py-2.5 text-sm text-signal transition-colors hover:bg-signal/25"
        >
          Try a demo flight
        </Link>
      </div>
    </main>
  );
}
