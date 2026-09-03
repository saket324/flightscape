"use client";

/**
 * The React boundary around Cesium.
 *
 * Deliberately thin. React mounts a div, creates the viewer once, and hands
 * everything after that to FlightScene, which runs on Cesium's render loop.
 * Camera and environment changes come in as props and are forwarded through
 * imperative setters rather than causing the scene to be rebuilt.
 *
 * Nothing here re-renders per frame -- the aircraft's motion never passes
 * through React at all.
 */
import { useEffect, useRef, useState } from "react";

// Cesium's own stylesheet. Without it `.cesium-widget` has no height rule and
// the canvas stays at the HTML default of 300x150 regardless of its container.
// Imported here rather than in globals.css so the landing page does not pay
// for it.
import "cesium/Build/Cesium/Widgets/widgets.css";

import type { Flight } from "@/types/flight";
import type { CameraMode, VisualEnvironmentId } from "@/types/visualization";
import type { FlightEngine } from "@/lib/animation/flightEngine";
import { loadCesium } from "@/lib/cesium/bootstrap";
import { FlightScene } from "@/lib/cesium/flightScene";
import { createViewer, type SceneQuality } from "@/lib/cesium/scene";

type Props = {
  flight: Flight;
  engine: FlightEngine;
  cameraMode: CameraMode;
  environment: VisualEnvironmentId;
  onReady?: (quality: SceneQuality) => void;
  onError?: (message: string) => void;
};

export function FlightGlobe({
  flight,
  engine,
  cameraMode,
  environment,
  onReady,
  onError,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<FlightScene | null>(null);
  const [failed, setFailed] = useState(false);

  /**
   * Latest props, mirrored so the setup effect can depend on nothing that
   * changes during a session while still reading current values when it runs.
   *
   * The ref is initialised with the mount-time props and refreshed in an
   * effect rather than during render -- writing a ref while rendering is not
   * safe under concurrent rendering, where a render may be discarded.
   */
  const latestRef = useRef({
    flight,
    cameraMode,
    environment,
    onReady,
    onError,
  });

  // Declared before the setup effect so that on mount it runs first.
  useEffect(() => {
    latestRef.current = { flight, cameraMode, environment, onReady, onError };
  });

  // Create the viewer exactly once. Cesium is expensive to construct and
  // holds a WebGL context, so this effect deliberately depends on nothing
  // that changes during a session.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    let viewer: Awaited<ReturnType<typeof createViewer>>["viewer"] | null = null;

    void (async () => {
      try {
        const cesium = await loadCesium();
        if (cancelled) return;

        const created = await createViewer(cesium, container);
        if (cancelled) {
          created.viewer.destroy();
          return;
        }

        viewer = created.viewer;

        sceneRef.current = new FlightScene({
          cesium,
          viewer: created.viewer,
          engine,
          flight: latestRef.current.flight,
          baseLayer: created.viewer.imageryLayers.get(0),
          environment: latestRef.current.environment,
          cameraMode: latestRef.current.cameraMode,
        });

        // Development aid: reach the live scene from the browser console.
        if (process.env.NODE_ENV !== "production") {
          (window as unknown as Record<string, unknown>).__flightscape = {
            viewer: created.viewer,
            cesium,
          };
        }

        latestRef.current.onReady?.(created.quality);
      } catch (error) {
        console.error("[globe] failed to initialise Cesium", error);
        if (cancelled) return;

        setFailed(true);
        latestRef.current.onError?.(
          "The 3D globe couldn't start. Your browser may not support WebGL.",
        );
      }
    })();

    return () => {
      cancelled = true;
      sceneRef.current?.destroy();
      sceneRef.current = null;
      if (viewer && !viewer.isDestroyed()) viewer.destroy();
    };
  }, [engine]);

  useEffect(() => {
    sceneRef.current?.setCameraMode(cameraMode);
  }, [cameraMode]);

  useEffect(() => {
    sceneRef.current?.setEnvironment(environment);
  }, [environment]);

  useEffect(() => {
    sceneRef.current?.setFlight(flight);
  }, [flight]);

  return (
    <div className="absolute inset-0">
      <div
        ref={containerRef}
        className="h-full w-full"
        // The globe is decorative to a screen reader; the flight panel carries
        // the same information as text.
        aria-hidden
      />
      {failed && (
        <div className="absolute inset-0 flex items-center justify-center bg-void/90 p-6 text-center">
          <p className="max-w-sm text-ink-muted">
            The 3D globe couldn&apos;t start. Your browser may not support
            WebGL, or hardware acceleration may be switched off.
          </p>
        </div>
      )}
    </div>
  );
}
