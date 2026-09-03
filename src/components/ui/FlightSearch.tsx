"use client";

/**
 * The landing search.
 *
 * Three outcomes, and the difference between them is the product's core
 * promise:
 *
 *   one live match     -> straight to the visualization
 *   several matches    -> let the user pick, because the same number flies
 *                         both directions of a rotation
 *   nothing airborne   -> say so plainly, and offer the demo as a choice the
 *                         user makes, never as a silent substitution
 */
import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import type { Flight } from "@/types/flight";
import { isApiError, type SearchResponse } from "@/lib/flight/api";
import { normalizeFlightIdentifier } from "@/lib/flight/validation";
import { DEMO_FLIGHT_ID } from "@/providers/flight/demo";
import { FlightPicker } from "./FlightPicker";

const EXAMPLES = ["AC103", "UA84", "DL405", "WS15"];

type Status =
  | { kind: "idle" }
  | { kind: "searching" }
  | { kind: "choosing"; flights: Flight[] }
  | { kind: "empty"; query: string }
  | { kind: "error"; message: string };

export function FlightSearch() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const open = useCallback(
    (flight: Flight) => {
      router.push(`/flight/${encodeURIComponent(flight.id)}`);
    },
    [router],
  );

  const search = useCallback(
    async (raw: string) => {
      const identifier = normalizeFlightIdentifier(raw);
      if (!identifier) {
        setStatus({
          kind: "error",
          message: "That doesn't look like a flight number. Try AC103.",
        });
        inputRef.current?.focus();
        return;
      }

      setStatus({ kind: "searching" });

      try {
        const response = await fetch(
          `/api/flights/search?q=${encodeURIComponent(identifier)}`,
          { cache: "no-store" },
        );
        const payload: unknown = await response.json();

        if (!response.ok || isApiError(payload as never)) {
          setStatus({
            kind: "error",
            message:
              (payload as { error?: { message?: string } })?.error?.message ??
              "Something went wrong searching for that flight.",
          });
          return;
        }

        const { flights } = payload as SearchResponse;

        // A flight we can name but cannot locate is not a live match. Saying
        // "found it" and then showing an empty sky would be worse than saying
        // nothing was found.
        const locatable = flights.filter((flight) => flight.status === "active");

        if (locatable.length === 1) {
          open(locatable[0]);
          return;
        }
        if (locatable.length > 1) {
          setStatus({ kind: "choosing", flights: locatable });
          return;
        }

        setStatus({ kind: "empty", query: identifier });
      } catch {
        setStatus({
          kind: "error",
          message:
            "We couldn't reach the flight data service. Check your connection and try again.",
        });
      }
    },
    [open],
  );

  const busy = status.kind === "searching";

  return (
    <div className="w-full max-w-lg">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void search(query);
        }}
        className="flex flex-col gap-3"
      >
        <label htmlFor="flight-number" className="sr-only">
          Flight number
        </label>

        <div className="relative">
          <input
            ref={inputRef}
            id="flight-number"
            name="flight"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              if (status.kind !== "idle") setStatus({ kind: "idle" });
            }}
            placeholder="AC103"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={10}
            disabled={busy}
            aria-describedby="flight-help"
            className="w-full rounded-xl border border-hairline bg-surface/80 px-5 py-4 text-center font-mono text-2xl tracking-[0.2em] text-ink uppercase placeholder:text-ink-faint/60 transition-colors focus:border-signal/60 focus:bg-surface disabled:opacity-60"
          />
          {busy && (
            <div className="animate-sweep pointer-events-none absolute inset-0 overflow-hidden rounded-xl" />
          )}
        </div>

        <button
          type="submit"
          disabled={busy || query.trim().length === 0}
          className="rounded-xl bg-signal px-5 py-3.5 font-medium text-void transition-all hover:bg-signal/90 active:scale-[0.99] disabled:cursor-not-allowed disabled:bg-signal/25 disabled:text-ink-faint"
        >
          {busy ? "Looking for this flight…" : "Visualize flight"}
        </button>
      </form>

      <div className="mt-5 flex items-center gap-3">
        <span className="h-px flex-1 bg-hairline" />
        <span className="text-xs uppercase tracking-widest text-ink-faint">
          or
        </span>
        <span className="h-px flex-1 bg-hairline" />
      </div>

      <button
        type="button"
        onClick={() => router.push(`/flight/${encodeURIComponent(DEMO_FLIGHT_ID)}`)}
        className="mt-5 w-full rounded-xl border border-hairline bg-surface/50 px-5 py-3.5 text-ink-muted transition-colors hover:border-signal/40 hover:text-ink"
      >
        Try a demo flight
      </button>

      <p id="flight-help" className="mt-6 text-center text-sm text-ink-faint">
        Try{" "}
        {EXAMPLES.map((example, index) => (
          <span key={example}>
            {index > 0 && <span className="text-ink-faint/50">, </span>}
            <button
              type="button"
              onClick={() => {
                setQuery(example);
                void search(example);
              }}
              className="font-mono text-ink-muted underline decoration-hairline underline-offset-4 transition-colors hover:text-signal hover:decoration-signal"
            >
              {example}
            </button>
          </span>
        ))}
      </p>

      <SearchStatus
        status={status}
        onPick={open}
        onDemo={() =>
          router.push(`/flight/${encodeURIComponent(DEMO_FLIGHT_ID)}`)
        }
        onRetry={() => {
          setStatus({ kind: "idle" });
          inputRef.current?.focus();
        }}
      />
    </div>
  );
}

function SearchStatus({
  status,
  onPick,
  onDemo,
  onRetry,
}: {
  status: Status;
  onPick: (flight: Flight) => void;
  onDemo: () => void;
  onRetry: () => void;
}) {
  if (status.kind === "idle" || status.kind === "searching") return null;

  if (status.kind === "choosing") {
    return (
      <div className="animate-rise mt-8" role="region" aria-label="Matching flights">
        <FlightPicker flights={status.flights} onPick={onPick} />
      </div>
    );
  }

  const isEmpty = status.kind === "empty";

  return (
    <div
      role="status"
      className="animate-rise mt-8 rounded-xl border border-hairline bg-surface/60 p-5 text-center"
    >
      <p className="text-ink">
        {isEmpty
          ? "We couldn't find a live position for this flight."
          : status.message}
      </p>

      {isEmpty && (
        <p className="mt-2 text-sm text-ink-faint">
          It may not be airborne right now, or no receiver can currently hear
          it.
        </p>
      )}

      <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-center">
        <button
          type="button"
          onClick={onRetry}
          className="rounded-lg border border-hairline px-4 py-2 text-sm text-ink-muted transition-colors hover:border-signal/40 hover:text-ink"
        >
          Try another flight
        </button>
        <button
          type="button"
          onClick={onDemo}
          className="rounded-lg bg-signal/15 px-4 py-2 text-sm text-signal transition-colors hover:bg-signal/25"
        >
          Try a demo flight
        </button>
      </div>
    </div>
  );
}
