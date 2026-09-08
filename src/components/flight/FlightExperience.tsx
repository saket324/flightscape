"use client";

/**
 * The visualization screen.
 *
 * Owns the UI state -- which camera, which environment, whether the panel is
 * open -- and nothing about the flight itself. Position data lives in the
 * FlightEngine and reaches the globe without passing through here.
 *
 * Camera and environment are reflected in the URL, so a view can be linked to
 * and restored: /flight/adsb:ACA103:c02f41?camera=cinematic&environment=night
 */
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { Flight, FlightProgress } from "@/types/flight";
import {
  CAMERA_MODES,
  VISUAL_ENVIRONMENTS,
  type CameraMode,
  type VisualEnvironmentId,
} from "@/types/visualization";
import { useFlightEngine } from "@/hooks/useFlightEngine";
import { useIsNarrowViewport } from "@/hooks/useMediaQuery";
import { computeProgress, hasArrived } from "@/lib/flight/route";
import { FlightGlobe } from "@/components/globe/FlightGlobe";
import { ControlBar } from "@/components/ui/ControlBar";
import { FlightPanel } from "./FlightPanel";
import type { IndicatorState } from "./LiveIndicator";

const CAMERA_IDS = new Set(CAMERA_MODES.map((mode) => mode.id));
const ENVIRONMENT_IDS = new Set(VISUAL_ENVIRONMENTS.map((env) => env.id));

export function FlightExperience({ flight }: { flight: Flight }) {
  const searchParams = useSearchParams();

  const [cameraMode, setCameraMode] = useState<CameraMode>(() => {
    const requested = searchParams.get("camera");
    return requested && CAMERA_IDS.has(requested as CameraMode)
      ? (requested as CameraMode)
      : "regional";
  });

  const [environment, setEnvironment] = useState<VisualEnvironmentId>(() => {
    const requested = searchParams.get("environment");
    return requested && ENVIRONMENT_IDS.has(requested as VisualEnvironmentId)
      ? (requested as VisualEnvironmentId)
      : "realistic";
  });

  /**
   * Panel state.
   *
   * Null means "not chosen yet", which resolves to collapsed on a phone and
   * expanded on a wider screen. On a 375px-tall-ish viewport the open panel
   * covers most of the globe, and the globe is the product.
   */
  const isNarrow = useIsNarrowViewport();
  const [panelChoice, setPanelChoice] = useState<boolean | null>(null);
  const panelExpanded = panelChoice ?? !isNarrow;

  const { engine, snapshot, connection, hasEverConnected } =
    useFlightEngine(flight);

  /**
   * Progress along the route.
   *
   * Derived from the snapshot rather than stored: it is a pure function of
   * data we already have, so an effect writing it into state would just add a
   * render pass and a frame of lag.
   */
  const progress = useMemo<FlightProgress | null>(() => {
    if (!snapshot) return null;

    return computeProgress(
      flight.origin,
      flight.destination,
      snapshot.position,
      snapshot.position.speed,
    );
  }, [snapshot, flight.origin, flight.destination]);

  /**
   * Keep the URL in step with the controls.
   *
   * Deliberately `history.replaceState` rather than `router.replace`. The
   * router treats a query change as a navigation and refetches the route's
   * RSC payload, which re-runs `getFlightDetails` on the server: the audit
   * measured five `/flight/[id]` fetches for a single visit, each one an
   * extra round of upstream API calls feeding the rate limiting that broke
   * live positions.
   *
   * Nothing here reads the query string after mount -- camera and environment
   * live in React state -- so the URL only needs to be correct for copying
   * and sharing. Rewriting it in place does that without a navigation, and
   * without adding a history entry per control press.
   */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);

    if (cameraMode === "regional") params.delete("camera");
    else params.set("camera", cameraMode);

    if (environment === "realistic") params.delete("environment");
    else params.set("environment", environment);

    const query = params.toString();
    const next = `${window.location.pathname}${query ? `?${query}` : ""}`;

    if (next !== `${window.location.pathname}${window.location.search}`) {
      window.history.replaceState(null, "", next);
    }
  }, [cameraMode, environment]);

  const indicator = useMemo<IndicatorState>(() => {
    if (!flight.source.live) return { kind: "demo" };

    if (snapshot && hasArrived(snapshot.lastObserved, flight.destination)) {
      return { kind: "landed" };
    }

    if (!snapshot || (!hasEverConnected && connection !== "connected")) {
      return { kind: "connecting" };
    }

    return {
      kind: "live",
      freshness: snapshot.freshness,
      ageSeconds: snapshot.dataAgeSeconds,
    };
  }, [flight.source.live, flight.destination, snapshot, connection, hasEverConnected]);


  return (
    <main className="relative h-full w-full overflow-hidden">
      <FlightGlobe
        flight={flight}
        engine={engine}
        cameraMode={cameraMode}
        environment={environment}
      />

      {/* Top bar */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-3 p-3 sm:p-5">
        <Link
          href="/"
          className="pointer-events-auto rounded-lg border border-hairline bg-abyss/80 px-3 py-2 font-mono text-xs tracking-[0.22em] text-ink-muted backdrop-blur-xl transition-colors hover:text-ink"
        >
          FLIGHTSCAPE
        </Link>
      </div>

      {/* Controls and panel.
          Stacked bottom-up on a phone; panel left, controls right on desktop. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col gap-3 p-3 sm:flex-row sm:items-end sm:justify-between sm:gap-5 sm:p-5">
        <FlightPanel
          flight={flight}
          snapshot={snapshot}
          progress={progress}
          indicator={indicator}
          expanded={panelExpanded}
          onToggle={() => setPanelChoice(!panelExpanded)}
        />

        <div className="flex min-w-0 flex-col gap-2 sm:items-end">
          <ControlBar
            legend="Camera"
            options={CAMERA_MODES}
            value={cameraMode}
            onChange={setCameraMode}
          />
          <ControlBar
            legend="Visual environment"
            options={VISUAL_ENVIRONMENTS}
            value={environment}
            onChange={setEnvironment}
          />
        </div>
      </div>
    </main>
  );
}
