"use client";

/**
 * Wires a FlightEngine to the network and to React.
 *
 * The split that keeps this smooth:
 *
 *   - The engine is held in a ref. It is mutated by polling and read by the
 *     Cesium render loop sixty times a second, and neither path touches React
 *     state, so nothing here causes a re-render at frame rate.
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
  const engine = useMemo(() => new FlightEngine(), []);

  const [snapshot, setSnapshot] = useState<FlightSnapshot | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [hasEverConnected, setHasEverConnected] = useState(false);

  const flightId = flight?.id ?? null;

  // Kept in a ref so the polling effect does not restart when backoff changes.
  const backoffRef = useRef<number>(timing.pollBackoffMinMs);

  const seedKey = useMemo(
    () => (seedPositions?.length ? seedPositions[0].timestamp : null),
    [seedPositions],
  );

  useEffect(() => {
    engine.reset();
    setSnapshot(null);
    setHasEverConnected(false);

    if (seedPositions?.length) {
      engine.seed(seedPositions);
      setSnapshot(engine.sample());
      setHasEverConnected(true);
    }
    // seedKey stands in for the seed array's identity; the array itself is
    // rebuilt on every render by callers and would restart this endlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, flightId, seedKey]);

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
    if (!flightId) {
      setConnection("idle");
      return;
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    setConnection("connecting");

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

  return { engine, snapshot, connection, errorMessage, hasEverConnected };
}
