"use client";

/**
 * Wires a FlightEngine to the network and to React.
 *
 * The split that keeps this smooth:
 *
 *   - The engine is held outside React state. It is mutated by polling and
 *     read by the Cesium render loop sixty times a second, and neither path
 *     causes a re-render.
 *   - React state updates on a slow tick, only for the values a person reads:
 *     altitude, speed, freshness. Those change meaningfully a few times a
 *     second at most.
 *
 * Rendering the interpolated position through React state would mean a full
 * reconciliation per frame; this is the architecture that avoids it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Flight, FlightPosition } from "@/types/flight";
import { timing } from "@/config";
import { FlightEngine, type FlightSnapshot } from "@/lib/animation/flightEngine";
import { isApiError, type PositionResponse } from "@/lib/flight/api";

/** How often the readouts refresh. Fast enough to feel live, far below 60fps. */
const UI_TICK_MS = 250;

export type ConnectionState = "connecting" | "connected" | "error" | "idle";

export type FlightEngineState = {
  engine: FlightEngine;
  /** Throttled snapshot for text readouts. Null until the first fix arrives. */
  snapshot: FlightSnapshot | null;
  connection: ConnectionState;
  /** A user-facing message when polling is failing. */
  errorMessage: string | null;
  /** True once at least one position has ever been received. */
  hasEverConnected: boolean;
};

export function useFlightEngine(
  flight: Flight | null,
  seedPositions?: readonly FlightPosition[],
): FlightEngineState {
  const flightId = flight?.id ?? null;

  /**
   * One engine per flight.
   *
   * Keying the engine to the flight id means switching flights produces a
   * fresh engine rather than needing an effect to reset the old one -- no
   * chance of the previous aircraft's samples surviving into the new track.
   */
  const engine = useMemo(() => {
    const created = new FlightEngine();
    // Provenance travels with every snapshot, so the UI can always say where
    // a position came from without consulting the flight object again.
    if (flight) created.setSource(flight.source.providerName);
    if (seedPositions?.length) created.seed(seedPositions);
    return created;
    // Seed positions are a one-time bootstrap for this flight; re-seeding on
    // array identity would discard live samples already collected.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flightId]);

  const [snapshot, setSnapshot] = useState<FlightSnapshot | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [hasEverConnected, setHasEverConnected] = useState(false);

  // Kept in a ref so the polling effect does not restart when backoff changes.
  const backoffRef = useRef<number>(timing.pollBackoffMinMs);

  /** One poll. Returns the delay to wait before the next one. */
  const poll = useCallback(
    async (signal: AbortSignal): Promise<number> => {
      if (!flightId) return timing.pollIntervalMs;

      const response = await fetch(
        `/api/flights/${encodeURIComponent(flightId)}/position`,
        { signal, cache: "no-store" },
      );

      const payload: unknown = await response.json();

      if (!response.ok || isApiError(payload as never)) {
        const message =
          (payload as { error?: { message?: string } })?.error?.message ??
          "We lost contact with the flight data service.";
        throw new Error(message);
      }

      const { position, serverTime, pollAfterSeconds } =
        payload as PositionResponse;

      engine.ingest(position, serverTime);

      if (position) {
        setHasEverConnected(true);
        setErrorMessage(null);
      }

      setConnection("connected");
      backoffRef.current = timing.pollBackoffMinMs;

      return Math.max(1_000, (pollAfterSeconds ?? 8) * 1000);
    },
    [engine, flightId],
  );

  // The polling loop.
  useEffect(() => {
    if (!flightId) return;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    const run = async () => {
      if (cancelled) return;

      let delay: number;
      try {
        delay = await poll(controller.signal);
      } catch (error) {
        if (cancelled || controller.signal.aborted) return;

        setConnection("error");
        setErrorMessage(
          error instanceof Error
            ? error.message
            : "We lost contact with the flight data service.",
        );

        // Exponential backoff, so a struggling upstream is not hammered.
        delay = backoffRef.current;
        backoffRef.current = Math.min(
          backoffRef.current * 2,
          timing.pollBackoffMaxMs,
        );
      }

      if (!cancelled) timer = setTimeout(run, delay);
    };

    void run();

    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [flightId, poll]);

  // The slow UI tick. Deliberately not requestAnimationFrame: these values are
  // read as text and do not need to change more than a few times a second.
  useEffect(() => {
    if (!flightId) return;

    const interval = setInterval(() => {
      setSnapshot(engine.sample());
    }, UI_TICK_MS);

    return () => clearInterval(interval);
  }, [engine, flightId]);

  return {
    engine,
    snapshot,
    // With no flight there is nothing to connect to; derived rather than
    // stored, so the effect above has no state to write on mount.
    connection: flightId ? connection : "idle",
    errorMessage,
    hasEverConnected,
  };
}
