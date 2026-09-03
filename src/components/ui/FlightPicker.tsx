"use client";

/**
 * Disambiguation when one flight number matches several aircraft.
 *
 * Usually the two directions of a rotation, occasionally the same number in
 * use by a second airframe. We show enough to tell them apart -- route,
 * registration, altitude -- rather than making the user guess.
 */
import type { Flight } from "@/types/flight";
import { routeLabel } from "@/lib/flight/format";

export function FlightPicker({
  flights,
  onPick,
}: {
  flights: Flight[];
  onPick: (flight: Flight) => void;
}) {
  return (
    <div className="rounded-xl border border-hairline bg-surface/60 p-4">
      <h2 className="mb-3 text-xs uppercase tracking-widest text-ink-faint">
        Select flight
      </h2>

      <ul className="flex flex-col gap-2">
        {flights.map((flight) => (
          <li key={flight.id}>
            <button
              type="button"
              onClick={() => onPick(flight)}
              className="w-full rounded-lg border border-hairline bg-surface-raised/60 px-4 py-3 text-left transition-colors hover:border-signal/50 hover:bg-surface-raised"
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-mono text-lg text-ink">
                  {flight.flightNumber}
                </span>
                {flight.registration && (
                  <span className="font-mono text-xs text-ink-faint">
                    {flight.registration}
                  </span>
                )}
              </div>

              <div className="mt-1 text-sm text-ink-muted">
                {routeLabel(flight)}
              </div>

              {flight.airline && (
                <div className="mt-0.5 text-xs text-ink-faint">
                  {flight.airline.name}
                  {flight.aircraftType ? ` · ${flight.aircraftType}` : ""}
                </div>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
