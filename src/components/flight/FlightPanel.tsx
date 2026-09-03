"use client";

/**
 * The flight information panel.
 *
 * A bottom sheet on phones, a floating card on wider screens. Values come from
 * the engine's throttled snapshot rather than from the render loop, so this
 * updates a few times a second instead of sixty.
 *
 * Unknown values show an em dash. Never a zero, never a guess.
 */
import type { Flight, FlightProgress } from "@/types/flight";
import type { FlightSnapshot } from "@/lib/animation/flightEngine";
import {
  UNKNOWN,
  airportCode,
  formatAltitude,
  formatClock,
  formatSpeed,
  formatVerticalSpeed,
} from "@/lib/flight/format";
import { LiveIndicator, type IndicatorState } from "./LiveIndicator";

type Props = {
  flight: Flight;
  snapshot: FlightSnapshot | null;
  progress: FlightProgress | null;
  indicator: IndicatorState;
  expanded: boolean;
  onToggle: () => void;
};

export function FlightPanel({
  flight,
  snapshot,
  progress,
  indicator,
  expanded,
  onToggle,
}: Props) {
  const position = snapshot?.position ?? null;
  const percent =
    progress === null ? null : Math.round(progress.fraction * 100);

  return (
    <section
      aria-label="Flight information"
      className="pointer-events-auto w-full rounded-2xl border border-hairline bg-abyss/85 shadow-2xl shadow-black/50 backdrop-blur-xl sm:w-[22rem]"
    >
      <header className="flex items-start gap-3 px-4 pt-4">
        <div className="min-w-0 flex-1">
          <LiveIndicator state={indicator} />

          <h1 className="mt-2.5 font-mono text-2xl leading-none text-ink">
            {flight.flightNumber}
          </h1>

          {flight.airline && (
            <p className="mt-1 truncate text-sm text-ink-muted">
              {flight.airline.name}
            </p>
          )}
        </div>

        {/* Collapse control: the globe is the point, and on a phone this
            panel covers a third of it. */}
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse flight details" : "Expand flight details"}
          className="rounded-lg p-1.5 text-ink-faint transition-colors hover:bg-surface hover:text-ink"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden
            className={`transition-transform duration-300 ${
              expanded ? "" : "rotate-180"
            }`}
          >
            <path
              d="M4 10l4-4 4 4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </header>

      <div className="px-4 pb-4">
        <Journey flight={flight} percent={percent} />

        {/* Collapsed on a phone, this leaves just the route and status.
            Grid rows animate rather than unmounting so the layout does not
            jump. */}
        <div
          className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out ${
            expanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
          }`}
        >
          <div className="overflow-hidden">
            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-hairline pt-4">
              <Readout label="Altitude" value={formatAltitude(position?.altitude ?? null)} />
              <Readout label="Ground speed" value={formatSpeed(position?.speed ?? null)} />
              <Readout
                label="Vertical"
                value={formatVerticalSpeed(position?.verticalSpeed ?? null)}
              />
              <Readout
                label="Arrives"
                value={formatClock(progress?.estimatedArrival ?? null)}
              />
            </dl>

            <Provenance flight={flight} snapshot={snapshot} />
          </div>
        </div>
      </div>
    </section>
  );
}

/** Origin, destination and the progress bar between them. */
function Journey({
  flight,
  percent,
}: {
  flight: Flight;
  percent: number | null;
}) {
  return (
    <div className="mt-3.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-sm text-ink">
          {airportCode(flight.origin)}
        </span>

        <span className="truncate px-2 text-[11px] text-ink-faint">
          {flight.origin?.municipality ?? ""}
          {flight.origin?.municipality && flight.destination?.municipality
            ? " → "
            : ""}
          {flight.destination?.municipality ?? ""}
        </span>

        <span className="font-mono text-sm text-ink">
          {airportCode(flight.destination)}
        </span>
      </div>

      <div className="mt-2">
        <div
          className="relative h-1 overflow-hidden rounded-full bg-hairline"
          role="progressbar"
          aria-valuenow={percent ?? undefined}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Flight progress"
        >
          {percent !== null && (
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-signal transition-[width] duration-1000 ease-linear"
              style={{ width: `${percent}%` }}
            />
          )}
        </div>

        <p className="tabular mt-1.5 text-[11px] text-ink-faint">
          {percent === null ? "Progress unavailable" : `${percent}% complete`}
        </p>
      </div>
    </div>
  );
}

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-[0.12em] text-ink-faint">
        {label}
      </dt>
      <dd
        className={`tabular mt-0.5 text-lg leading-tight ${
          value === UNKNOWN ? "text-ink-faint" : "text-ink"
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

/**
 * Where this data came from.
 *
 * Small, but it is what lets someone check our claim rather than take it on
 * trust -- including whether the position on screen is an observation or a
 * short projection from one.
 */
function Provenance({
  flight,
  snapshot,
}: {
  flight: Flight;
  snapshot: FlightSnapshot | null;
}) {
  const extrapolated = snapshot?.position.isExtrapolated ?? false;

  return (
    <div className="mt-4 border-t border-hairline pt-3">
      {flight.registration && (
        <p className="tabular text-[11px] text-ink-faint">
          {flight.registration}
          {flight.aircraftType ? ` · ${flight.aircraftType}` : ""}
        </p>
      )}

      <p className="mt-1 text-[11px] leading-relaxed text-ink-faint/80">
        {flight.source.attribution}
        {extrapolated && flight.source.live && (
          <>
            {" · "}
            <span title="Projected forward from the last observed position using its own reported speed and track">
              position projected between updates
            </span>
          </>
        )}
      </p>
    </div>
  );
}
