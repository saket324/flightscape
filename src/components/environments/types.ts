/**
 * The visual environment system.
 *
 * This is where Flightscape's central separation lives. An environment may do
 * anything it likes to how the world *looks* -- imagery, atmosphere, light,
 * clouds, colour -- and has no ability to affect where the aircraft *is*. It
 * is handed the aircraft's real state on every frame and can only read it.
 *
 *      real flight data
 *            |
 *      real geographic position   <-- fixed, owned by FlightEngine
 *            |
 *      Cesium Earth
 *            |
 *      VisualEnvironment          <-- free to reinvent everything above
 *            |
 *      camera / atmosphere / effects
 *
 * Adding an environment means writing one module here and registering it. No
 * part of the flight engine changes.
 */
import type { VisualEnvironmentId } from "@/types/visualization";
import type { CesiumModule } from "@/lib/cesium/bootstrap";

type Cesium = CesiumModule;

/**
 * Colours the scene applies to things an environment does not own directly.
 *
 * The route, track and labels belong to the flight layer, but they have to
 * read against whatever world the environment has built -- a cyan line that
 * works over dark ocean disappears over a pale map. Environments express that
 * as a theme rather than reaching into the flight layer themselves.
 */
export type EnvironmentTheme = {
  routeCompletedCss: string;
  routeRemainingCss: string;
  trackCss: string;
  airportCss: string;
  labelCss: string;
  labelOutlineCss: string;
  /** Whether route lines get an outer glow. */
  routeGlow: boolean;
  /** Multiplier on the aircraft model's size. */
  aircraftScale: number;
};

export const DEFAULT_THEME: EnvironmentTheme = {
  routeCompletedCss: "#4dd0e1",
  routeRemainingCss: "#4dd0e1",
  trackCss: "#ffffff",
  airportCss: "#9aa8c4",
  labelCss: "#f2f6ff",
  labelOutlineCss: "#04070d",
  routeGlow: true,
  aircraftScale: 1,
};

/** What an environment is given to work with. */
export type EnvironmentContext = {
  cesium: Cesium;
  viewer: InstanceType<Cesium["Viewer"]>;
  /** The realistic base imagery, so environments can restore or restyle it. */
  baseLayer: InstanceType<Cesium["ImageryLayer"]>;
  /**
   * Add an imagery layer that will be removed automatically on dispose.
   * Environments should use this rather than touching the layer collection.
   */
  addImageryLayer: (
    provider: InstanceType<Cesium["UrlTemplateImageryProvider"]>,
  ) => InstanceType<Cesium["ImageryLayer"]>;
};

/**
 * The aircraft's real state, passed to environments each frame.
 *
 * Deliberately read-only, and deliberately not the FlightEngine itself:
 * an environment can respond to where the aircraft is, and can do nothing
 * about it.
 */
export type EnvironmentFlightState = {
  readonly latitude: number;
  readonly longitude: number;
  readonly altitudeFeet: number;
  readonly headingDegrees: number;
  readonly position: InstanceType<Cesium["Cartesian3"]>;
  /** Seconds since the environment was activated. */
  readonly elapsedSeconds: number;
};

export interface FlightEnvironment {
  readonly id: VisualEnvironmentId;
  readonly name: string;
  /** Colours for scene elements the environment does not own. */
  readonly theme: EnvironmentTheme;

  /** Build the look. Called once when the environment becomes active. */
  initialize(context: EnvironmentContext): void;

  /** Called every frame with the aircraft's real state. Optional. */
  update?(state: EnvironmentFlightState): void;

  /** Undo everything `initialize` did. Must leave the scene reusable. */
  dispose(): void;
}

export type FlightEnvironmentFactory = () => FlightEnvironment;

/**
 * Apply sky-atmosphere settings, if the scene has one.
 *
 * Cesium allows a viewer to be built with no sky atmosphere at all, so the
 * property is optional. Rather than guard at a dozen call sites, environments
 * describe what they want and this quietly does nothing when there is nothing
 * to configure.
 */
export function configureSky(
  scene: InstanceType<Cesium["Scene"]>,
  settings: {
    show?: boolean;
    hueShift?: number;
    saturationShift?: number;
    brightnessShift?: number;
  },
): void {
  const sky = scene.skyAtmosphere;
  if (!sky) return;

  if (settings.show !== undefined) sky.show = settings.show;
  if (settings.hueShift !== undefined) sky.hueShift = settings.hueShift;
  if (settings.saturationShift !== undefined) {
    sky.saturationShift = settings.saturationShift;
  }
  if (settings.brightnessShift !== undefined) {
    sky.brightnessShift = settings.brightnessShift;
  }
}

/**
 * Scene settings every environment starts from.
 *
 * Applied before `initialize`, so an environment only has to describe its
 * differences from a plain realistic Earth rather than reset state left
 * behind by whichever environment ran before it.
 */
export function resetScene(context: EnvironmentContext): void {
  const { cesium, viewer, baseLayer } = context;
  const { scene } = viewer;

  baseLayer.show = true;
  baseLayer.alpha = 1;
  baseLayer.brightness = 1;
  baseLayer.contrast = 1;
  baseLayer.hue = 0;
  baseLayer.saturation = 1;
  baseLayer.gamma = 1;

  scene.globe.enableLighting = true;
  scene.globe.showGroundAtmosphere = true;
  scene.globe.baseColor = cesium.Color.fromCssColorString("#0b1a2e");
  scene.globe.translucency.enabled = false;

  configureSky(scene, {
    show: true,
    hueShift: 0,
    saturationShift: 0,
    brightnessShift: 0,
  });

  scene.fog.enabled = true;
  scene.fog.density = 2e-4;

  if (scene.skyBox) scene.skyBox.show = true;
  if (scene.sun) scene.sun.show = true;
  if (scene.moon) scene.moon.show = true;

  scene.backgroundColor = cesium.Color.fromCssColorString("#04070d");
  scene.highDynamicRange = true;
}
