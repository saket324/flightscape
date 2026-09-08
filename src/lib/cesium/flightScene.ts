/**
 * The scene: entities, camera and environment, driven by the render loop.
 *
 * This class is the only place that touches Cesium entities. It reads the
 * FlightEngine every frame through Cesium's own callback properties, which is
 * what keeps the aircraft moving at display rate without a single React
 * render:
 *
 *     preRender  ->  engine.sample(now)  ->  aircraft position
 *                                        ->  camera framing
 *                                        ->  environment.update()
 *
 * The aircraft's position comes from exactly one place -- `engine.sample()` --
 * and nothing here is permitted to offset, smooth or prettify it. Cameras move
 * around the aircraft; the aircraft goes where the data says.
 */
import type { Flight, RoutePoint } from "@/types/flight";
import type { CameraMode, VisualEnvironmentId } from "@/types/visualization";
import type { FlightEngine } from "@/lib/animation/flightEngine";
import { buildPlannedRoute, splitRouteAtProgress } from "@/lib/flight/route";
import {
  destinationPoint,
  progressAlongRoute,
} from "@/lib/geography/greatCircle";
import {
  createEnvironment,
  type EnvironmentTheme,
  type FlightEnvironment,
} from "@/components/environments";
import type { CesiumModule } from "./bootstrap";
import { dampFraming, framingFor, type CameraFraming } from "./cameras";
import { QualityGovernor, type QualityTier } from "./performance";
import { aircraftOrientation, toCartesian } from "./scene";

type Cesium = CesiumModule;
type Viewer = InstanceType<Cesium["Viewer"]>;
type Entity = InstanceType<Cesium["Entity"]>;
type ImageryLayer = InstanceType<Cesium["ImageryLayer"]>;

/** Metres. Real length of the model, which is authored one unit long. */
const AIRCRAFT_LENGTH_M = 60;

/**
 * Smallest on-screen size for the aircraft, in pixels.
 *
 * From the global view a 60 m aircraft is a fraction of a pixel. Cesium's
 * minimumPixelSize keeps the marker visible without moving it: the model is
 * drawn larger at its true coordinate, the same way a map pin is.
 */
const AIRCRAFT_MIN_PIXELS = 26;

export class FlightScene {
  private readonly cesium: Cesium;
  private readonly viewer: Viewer;
  private readonly engine: FlightEngine;
  private readonly baseLayer: ImageryLayer;

  private flight: Flight;
  private cameraMode: CameraMode = "regional";
  private environment: FlightEnvironment;
  private theme: EnvironmentTheme;

  private aircraftEntity: Entity | null = null;
  private completedEntity: Entity | null = null;
  private remainingEntity: Entity | null = null;
  private trackEntity: Entity | null = null;
  private airportEntities: Entity[] = [];

  /** Imagery layers handed to environments, removed when they are swapped. */
  private environmentLayers: ImageryLayer[] = [];

  private framing: CameraFraming = { headingOffset: 0, pitch: -38, range: 60_000 };
  private lastFrameMs = 0;
  private environmentStartedMs = 0;
  private cinematicStartedMs = 0;
  private removePreRender: (() => void) | null = null;

  /** Watches real frame times and trims quality only on devices that need it. */
  private readonly quality: QualityGovernor;
  /** Baseline resolution scale, so tier multipliers stay relative to it. */
  private baseResolutionScale = 1;

  /** Reused per frame so the render loop allocates nothing. */
  private scratchPosition: InstanceType<Cesium["Cartesian3"]>;

  /**
   * The snapshot for the frame currently being drawn.
   *
   * Cesium pulls position, orientation and both route polylines through
   * separate callback properties, and the camera and environment need the
   * same state again. Each of those used to call `engine.sample()` for
   * itself -- five or six interpolations per frame, all for the same instant,
   * all necessarily identical. `onPreRender` runs before the callbacks, so it
   * computes once and everything else reads this.
   */
  private frameSnapshot: ReturnType<FlightEngine["sample"]> = null;

  /** Scene-space track geometry, rebuilt only when the track itself changes. */
  private trackCache: {
    version: number;
    positions: InstanceType<Cesium["Cartesian3"]>[];
  } | null = null;
  private routeSplitCache: {
    fraction: number;
    completed: InstanceType<Cesium["Cartesian3"]>[];
    remaining: InstanceType<Cesium["Cartesian3"]>[];
  } | null = null;

  constructor(options: {
    cesium: Cesium;
    viewer: Viewer;
    engine: FlightEngine;
    flight: Flight;
    baseLayer: ImageryLayer;
    environment: VisualEnvironmentId;
    cameraMode: CameraMode;
  }) {
    this.cesium = options.cesium;
    this.viewer = options.viewer;
    this.engine = options.engine;
    this.flight = options.flight;
    this.baseLayer = options.baseLayer;
    this.cameraMode = options.cameraMode;

    this.scratchPosition = new this.cesium.Cartesian3();
    this.baseResolutionScale = this.viewer.resolutionScale;
    this.quality = new QualityGovernor({
      onChange: (tier) => this.applyQualityTier(tier),
    });

    this.environment = createEnvironment(options.environment);
    this.theme = this.environment.theme;
    this.environment.initialize(this.environmentContext());
    this.environmentStartedMs = performance.now();

    this.buildEntities();
    this.startRenderLoop();
  }

  // --- public API ----------------------------------------------------------

  setCameraMode(mode: CameraMode): void {
    if (mode === this.cameraMode) return;
    this.cameraMode = mode;
    this.cinematicStartedMs = performance.now();

    // From the flight deck you cannot see your own aircraft. Leaving it
    // visible puts its wings and nose across the middle of the view.
    if (this.aircraftEntity) {
      this.aircraftEntity.show = mode !== "cockpit";
    }

    // Global is a one-shot framing of the whole journey rather than a
    // per-frame follow, so it is flown to once on entry.
    if (mode === "global") {
      this.releaseCamera();
      this.flyToWholeRoute();
    }
  }

  setEnvironment(id: VisualEnvironmentId): void {
    if (id === this.environment.id) return;

    this.environment.dispose();
    this.clearEnvironmentLayers();

    this.environment = createEnvironment(id);
    this.theme = this.environment.theme;
    this.environment.initialize(this.environmentContext());
    this.environmentStartedMs = performance.now();

    // Route and aircraft styling belongs to the flight layer but has to read
    // against the new world, so it is re-applied from the new theme.
    this.applyTheme();
  }

  /** Called when route metadata arrives after the scene was created. */
  setFlight(flight: Flight): void {
    this.flight = flight;
    this.rebuildRoute();
  }

  destroy(): void {
    this.removePreRender?.();
    this.removePreRender = null;

    this.environment.dispose();
    this.clearEnvironmentLayers();

    if (!this.viewer.isDestroyed()) {
      this.releaseCamera();
      this.viewer.entities.removeAll();
    }
  }

  /**
   * The engine state for this frame.
   *
   * Falls back to sampling directly when called outside a render pass, so the
   * entity callbacks remain correct if Cesium evaluates them off-cycle.
   */
  private currentSnapshot(): ReturnType<FlightEngine["sample"]> {
    return this.frameSnapshot ?? this.engine.sample();
  }

  /** Current render quality, for diagnostics. */
  getQualityStats(): {
    medianFrameMs: number;
    level: number;
    windows: number;
    label: string;
  } {
    return { ...this.quality.stats, label: this.quality.currentTier.label };
  }

  /**
   * Apply a quality tier to the live scene.
   *
   * Only the settings that actually cost measurable frame time are touched.
   * Terrain and imagery detail are left alone: they are the geography the
   * product exists to show, and blurring the world to gain frames would
   * defeat the point.
   */
  private applyQualityTier(tier: QualityTier): void {
    if (this.viewer.isDestroyed()) return;

    const { scene } = this.viewer;

    scene.highDynamicRange = tier.hdr && scene.highDynamicRangeSupported;
    scene.msaaSamples = tier.msaaSamples;
    this.viewer.resolutionScale = this.baseResolutionScale * tier.resolutionScale;

    console.info(
      `[flightscape] render quality -> ${tier.label} (median frame ${this.quality.stats.medianFrameMs.toFixed(1)}ms)`,
    );
  }

  // --- entities ------------------------------------------------------------

  private buildEntities(): void {
    const { cesium, viewer } = this;

    // Position and orientation are callback properties: Cesium pulls them once
    // per frame straight from the engine, so there is no React state, no
    // setInterval and no copy of the position living anywhere else.
    const position = new cesium.CallbackPositionProperty(() => {
      const snapshot = this.currentSnapshot();
      if (!snapshot) return undefined;

      return toCartesian(
        cesium,
        snapshot.position.latitude,
        snapshot.position.longitude,
        snapshot.position.altitude,
      );
    }, false);

    const orientation = new cesium.CallbackProperty(() => {
      const snapshot = this.currentSnapshot();
      if (!snapshot) return undefined;

      const cartesian = toCartesian(
        cesium,
        snapshot.position.latitude,
        snapshot.position.longitude,
        snapshot.position.altitude,
      );

      // Roll is used only where the aircraft actually reported it. We do not
      // invent bank angles to make turns look more dramatic.
      return aircraftOrientation(
        cesium,
        cartesian,
        snapshot.position.heading,
        0,
        snapshot.position.roll ?? 0,
      );
    }, false);

    this.aircraftEntity = viewer.entities.add({
      id: "aircraft",
      position,
      orientation,
      // Hidden in cockpit view, including when the page opens straight into it
      // from a shared URL.
      show: this.cameraMode !== "cockpit",
      model: {
        uri: "/models/airliner.glb",
        scale: AIRCRAFT_LENGTH_M * this.theme.aircraftScale,
        minimumPixelSize: AIRCRAFT_MIN_PIXELS,
        maximumScale: 200_000,
        // Silhouette keeps the aircraft readable against bright terrain and
        // dark ocean alike.
        silhouetteColor: cesium.Color.fromCssColorString("#04070d"),
        silhouetteSize: 1.5,
      },
    });

    this.rebuildRoute();
    this.buildTrack();
    this.buildAirports();
    this.applyTheme();
  }

  /**
   * The planned great-circle route, split into flown and remaining halves.
   *
   * Both halves are estimated geometry. The renderer styles them differently
   * from the observed track, which is drawn separately in `buildTrack`.
   */
  private rebuildRoute(): void {
    const { cesium, viewer } = this;

    if (this.completedEntity) viewer.entities.remove(this.completedEntity);
    if (this.remainingEntity) viewer.entities.remove(this.remainingEntity);
    this.completedEntity = null;
    this.remainingEntity = null;
    this.routeSplitCache = null;

    const route = buildPlannedRoute(this.flight);
    if (!route) return;

    // Split is recomputed only when progress changes materially, so the
    // polyline arrays are not rebuilt every frame.
    const positionsFor = (which: "completed" | "remaining") =>
      new cesium.CallbackProperty(() => {
        const split = this.currentRouteSplit(route.points);
        return split ? split[which] : undefined;
      }, false);

    this.completedEntity = viewer.entities.add({
      id: "route-completed",
      polyline: {
        positions: positionsFor("completed"),
        width: 3,
        // Clamping to the ellipsoid rather than to terrain: the route is a
        // path over the ground, not a line draped across every hillside.
        arcType: cesium.ArcType.NONE,
        material: new cesium.ColorMaterialProperty(
          cesium.Color.fromCssColorString(this.theme.routeCompletedCss),
        ),
      },
    });

    this.remainingEntity = viewer.entities.add({
      id: "route-remaining",
      polyline: {
        positions: positionsFor("remaining"),
        width: 2,
        arcType: cesium.ArcType.NONE,
        material: new cesium.PolylineDashMaterialProperty({
          color: cesium.Color.fromCssColorString(this.theme.routeRemainingCss),
          dashLength: 18,
        }),
      },
    });
  }

  /**
   * Split the route at the aircraft's current progress.
   *
   * Cached: recomputed only when progress moves by more than a quarter of a
   * percent, which at cruise is a few seconds apart.
   */
  private currentRouteSplit(points: RoutePoint[]) {
    const snapshot = this.currentSnapshot();
    const { origin, destination } = this.flight;
    if (!snapshot || !origin || !destination) return this.routeSplitCache;

    const fraction = progressAlongRoute(origin, destination, snapshot.position);

    if (
      this.routeSplitCache &&
      Math.abs(this.routeSplitCache.fraction - fraction) < 0.0025
    ) {
      return this.routeSplitCache;
    }

    const { cesium } = this;
    const split = splitRouteAtProgress({ isActualTrack: false, points }, fraction);
    const toPositions = (list: RoutePoint[]) =>
      list.map((point) =>
        cesium.Cartesian3.fromDegrees(point.longitude, point.latitude, 0),
      );

    this.routeSplitCache = {
      fraction,
      completed: toPositions(split.completed),
      remaining: toPositions(split.remaining),
    };

    return this.routeSplitCache;
  }

  /**
   * The observed track: where the aircraft has actually been.
   *
   * Drawn at real altitude and styled distinctly from the planned route,
   * because these are two different kinds of claim.
   */
  private buildTrack(): void {
    const { cesium, viewer } = this;

    this.trackEntity = viewer.entities.add({
      id: "observed-track",
      polyline: {
        /**
         * Cached against the engine's track version.
         *
         * This callback runs every frame. Rebuilding the array meant a fresh
         * Cartesian3 per point and a new array identity each time, so Cesium
         * re-uploaded the whole polyline geometry to the GPU sixty times a
         * second for data that changes once every few seconds. The retention
         * cap is 900 points, so the waste grows with the length of the flight.
         *
         * Returning the same array instance while the version is unchanged
         * lets Cesium skip the rebuild entirely.
         */
        positions: new cesium.CallbackProperty(() => {
          const version = this.engine.getTrackVersion();
          if (this.trackCache?.version === version) {
            return this.trackCache.positions.length >= 2
              ? this.trackCache.positions
              : undefined;
          }

          const track = this.engine.getTrack();
          const positions = track.map((point) =>
            toCartesian(
              cesium,
              point.latitude,
              point.longitude,
              point.altitude,
              0,
            ),
          );

          this.trackCache = { version, positions };
          return positions.length >= 2 ? positions : undefined;
        }, false),
        width: 2.5,
        arcType: cesium.ArcType.NONE,
        material: new cesium.ColorMaterialProperty(
          cesium.Color.fromCssColorString(this.theme.trackCss),
        ),
      },
    });
  }

  private buildAirports(): void {
    const { cesium, viewer } = this;

    for (const entity of this.airportEntities) viewer.entities.remove(entity);
    this.airportEntities = [];

    for (const airport of [this.flight.origin, this.flight.destination]) {
      if (!airport) continue;

      this.airportEntities.push(
        viewer.entities.add({
          position: cesium.Cartesian3.fromDegrees(
            airport.longitude,
            airport.latitude,
            0,
          ),
          point: {
            pixelSize: 8,
            color: cesium.Color.fromCssColorString(this.theme.airportCss),
            outlineColor: cesium.Color.fromCssColorString(
              this.theme.labelOutlineCss,
            ),
            outlineWidth: 2,
            // Hidden when the far side of the globe is between us and it.
            heightReference: cesium.HeightReference.CLAMP_TO_GROUND,
          },
          label: {
            text: airport.iata ?? airport.icao ?? airport.name,
            font: "500 13px system-ui, sans-serif",
            fillColor: cesium.Color.fromCssColorString(this.theme.labelCss),
            outlineColor: cesium.Color.fromCssColorString(
              this.theme.labelOutlineCss,
            ),
            outlineWidth: 3,
            style: cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new cesium.Cartesian2(0, -18),
            // Fades out when very far away, so the global view stays clean.
            translucencyByDistance: new cesium.NearFarScalar(
              1.0e5,
              1.0,
              1.4e7,
              0.25,
            ),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        }),
      );
    }
  }

  /** Push the active environment's theme onto entities the flight layer owns. */
  private applyTheme(): void {
    const { cesium } = this;
    const theme = this.theme;

    if (this.aircraftEntity?.model) {
      this.aircraftEntity.model.scale = new cesium.ConstantProperty(
        AIRCRAFT_LENGTH_M * theme.aircraftScale,
      );
    }

    if (this.completedEntity?.polyline) {
      this.completedEntity.polyline.material = new cesium.ColorMaterialProperty(
        cesium.Color.fromCssColorString(theme.routeCompletedCss),
      );
    }

    if (this.remainingEntity?.polyline) {
      this.remainingEntity.polyline.material =
        new cesium.PolylineDashMaterialProperty({
          color: cesium.Color.fromCssColorString(theme.routeRemainingCss),
          dashLength: 18,
        });
    }

    if (this.trackEntity?.polyline) {
      this.trackEntity.polyline.material = theme.routeGlow
        ? new cesium.PolylineGlowMaterialProperty({
            color: cesium.Color.fromCssColorString(theme.trackCss),
            glowPower: 0.18,
            taperPower: 0.6,
          })
        : new cesium.ColorMaterialProperty(
            cesium.Color.fromCssColorString(theme.trackCss),
          );
    }

    this.buildAirports();
  }

  // --- render loop ---------------------------------------------------------

  private startRenderLoop(): void {
    const listener = () => this.onPreRender();
    this.viewer.scene.preRender.addEventListener(listener);

    /**
     * The frame snapshot is valid only for the frame that computed it.
     *
     * Without this the value set in preRender would persist indefinitely, and
     * any property read outside a render pass -- Cesium does this for
     * flyTo/zoomTo and entity availability, and it happens whenever the
     * browser suspends the render loop for a hidden tab -- would silently
     * return a stale position. Clearing it here makes `currentSnapshot()`
     * fall through to a fresh `engine.sample()` off-frame, which is the whole
     * point of that fallback.
     */
    const clear = () => {
      this.frameSnapshot = null;
    };
    this.viewer.scene.postRender.addEventListener(clear);

    this.removePreRender = () => {
      this.viewer.scene.preRender.removeEventListener(listener);
      this.viewer.scene.postRender.removeEventListener(clear);
    };

    this.lastFrameMs = performance.now();
    this.cinematicStartedMs = this.lastFrameMs;
  }

  /**
   * One frame.
   *
   * Reads the engine, positions the camera, and hands the environment the
   * aircraft's real state.
   */
  private onPreRender(): void {
    const now = performance.now();
    const deltaMs = now - this.lastFrameMs;
    const deltaSeconds = Math.min(0.25, deltaMs / 1000);
    this.lastFrameMs = now;

    this.quality.recordFrame(deltaMs);

    // One sample for the whole frame; every callback below reads it.
    this.frameSnapshot = this.engine.sample();
    const snapshot = this.frameSnapshot;
    if (!snapshot) return;

    const { cesium } = this;
    const { position } = snapshot;

    const cartesian = toCartesian(
      cesium,
      position.latitude,
      position.longitude,
      position.altitude,
      0,
    );
    this.scratchPosition = cartesian;

    this.updateCamera(cartesian, position.heading ?? 0, deltaSeconds, now);

    this.environment.update?.({
      latitude: position.latitude,
      longitude: position.longitude,
      altitudeFeet: position.altitude ?? 0,
      headingDegrees: position.heading ?? 0,
      position: cartesian,
      elapsedSeconds: (now - this.environmentStartedMs) / 1000,
    });
  }

  private updateCamera(
    aircraft: InstanceType<Cesium["Cartesian3"]>,
    headingDegrees: number,
    deltaSeconds: number,
    nowMs: number,
  ): void {
    const { cesium, viewer } = this;
    const { camera } = viewer;

    if (this.cameraMode === "global") {
      // Free look: the user drives, and the whole route stays in view.
      return;
    }

    if (this.cameraMode === "cockpit") {
      this.releaseCamera();

      const snapshot = this.currentSnapshot();
      if (!snapshot) return;

      // Sit the camera at the nose rather than the aircraft's centre. Placed
      // at the centre it is inside the 60 m model, and the view is the inside
      // of the fuselage.
      const nose = destinationPoint(
        snapshot.position,
        headingDegrees,
        AIRCRAFT_LENGTH_M * 0.6,
      );

      camera.setView({
        destination: toCartesian(
          cesium,
          nose.latitude,
          nose.longitude,
          snapshot.position.altitude,
          0,
        ),
        orientation: {
          heading: cesium.Math.toRadians(headingDegrees),
          // A shade below the horizon, the way a flight deck actually sits.
          pitch: cesium.Math.toRadians(-6),
          roll: 0,
        },
      });
      return;
    }

    const snapshot = this.engine.sample();
    const target = framingFor(
      this.cameraMode,
      {
        latitude: 0,
        longitude: 0,
        altitudeFeet: snapshot?.position.altitude ?? 35_000,
        headingDegrees,
        speedKnots: snapshot?.position.speed ?? 450,
      },
      (nowMs - this.cinematicStartedMs) / 1000,
    );
    if (!target) return;

    this.framing = dampFraming(this.framing, target, deltaSeconds);

    // lookAt locks the camera to a frame centred on the aircraft. The offset
    // is expressed relative to the aircraft's own heading, so "behind" stays
    // behind as the aircraft turns.
    camera.lookAt(
      aircraft,
      new cesium.HeadingPitchRange(
        cesium.Math.toRadians(headingDegrees + this.framing.headingOffset - 90),
        cesium.Math.toRadians(this.framing.pitch),
        this.framing.range,
      ),
    );
  }

  /** Hand control of the camera back to the user. */
  private releaseCamera(): void {
    this.viewer.camera.lookAtTransform(this.cesium.Matrix4.IDENTITY);
  }

  /** Frame origin, destination and the aircraft together. */
  private flyToWholeRoute(): void {
    const { cesium, viewer } = this;
    const points: InstanceType<Cesium["Cartesian3"]>[] = [];

    for (const airport of [this.flight.origin, this.flight.destination]) {
      if (airport) {
        points.push(
          cesium.Cartesian3.fromDegrees(airport.longitude, airport.latitude, 0),
        );
      }
    }

    const snapshot = this.engine.sample();
    if (snapshot) {
      points.push(
        toCartesian(
          cesium,
          snapshot.position.latitude,
          snapshot.position.longitude,
          snapshot.position.altitude,
        ),
      );
    }

    if (points.length === 0) return;

    const sphere = cesium.BoundingSphere.fromPoints(points);
    // A little margin so the endpoints are not against the screen edge.
    sphere.radius = Math.max(sphere.radius * 1.6, 400_000);

    viewer.camera.flyToBoundingSphere(sphere, {
      duration: 1.8,
      offset: new cesium.HeadingPitchRange(0, cesium.Math.toRadians(-55), 0),
    });
  }

  // --- environment plumbing ------------------------------------------------

  private environmentContext() {
    return {
      cesium: this.cesium,
      viewer: this.viewer,
      baseLayer: this.baseLayer,
      addImageryLayer: (
        provider: InstanceType<Cesium["UrlTemplateImageryProvider"]>,
      ) => {
        const layer = this.viewer.imageryLayers.addImageryProvider(provider);
        this.environmentLayers.push(layer);
        return layer;
      },
    };
  }

  private clearEnvironmentLayers(): void {
    if (!this.viewer.isDestroyed()) {
      for (const layer of this.environmentLayers) {
        this.viewer.imageryLayers.remove(layer, true);
      }
    }
    this.environmentLayers = [];
  }
}
