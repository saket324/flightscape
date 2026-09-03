/**
 * NIGHT -- dark Earth, lit cities, a glowing route.
 *
 * Selectable whatever the real time of day at the aircraft. That is deliberate
 * and it is not a lie about the data: this environment says nothing about
 * whether it is dark outside the window, only about how the scene is drawn.
 * The aircraft's position, altitude and heading are the same real values as in
 * every other environment.
 *
 * Cities come from a dark basemap whose road and settlement geometry reads as
 * light against the ground, which is a close enough evocation of the view from
 * a night flight without requiring a licensed night-lights imagery asset.
 */
import type { EnvironmentContext, FlightEnvironment } from "./types";
import { configureSky, DEFAULT_THEME, resetScene } from "./types";

const DARK_MATTER_URL =
  "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png";

export function createNightEnvironment(): FlightEnvironment {
  return {
    id: "night",
    name: "Night",

    theme: {
      ...DEFAULT_THEME,
      routeCompletedCss: "#4dd0e1",
      routeRemainingCss: "#3a4f6e",
      trackCss: "#ffb454",
      airportCss: "#ffd479",
      labelCss: "#dce7ff",
      routeGlow: true,
      aircraftScale: 1.1,
    },

    initialize(context: EnvironmentContext) {
      resetScene(context);

      const { cesium, viewer } = context;
      const { scene } = viewer;

      const layer = context.addImageryLayer(
        new cesium.UrlTemplateImageryProvider({
          url: DARK_MATTER_URL,
          credit: "© OpenStreetMap contributors, © CARTO",
          maximumLevel: 18,
        }),
      );

      // Lift the basemap's brightness a little: its city geometry is what
      // stands in for lights here, and at default it sinks into the ground.
      layer.brightness = 1.35;
      layer.contrast = 1.2;
      layer.gamma = 0.85;

      context.baseLayer.show = false;

      // Uniform darkness rather than real sun lighting -- otherwise half the
      // globe would still be in daylight and the effect would only work on
      // one side of the terminator.
      scene.globe.enableLighting = false;
      scene.globe.baseColor = cesium.Color.fromCssColorString("#040910");
      scene.globe.showGroundAtmosphere = true;

      // A cool, deep rim of atmosphere against the black.
      //
      // The sun is still wherever it really is, so the atmosphere shader is
      // lit whatever we do to the globe. It has to be pulled a long way down
      // -- at -0.35 the horizon was still a bright daylight teal band, which
      // undid the whole effect.
      configureSky(scene, {
        show: true,
        hueShift: -0.04,
        saturationShift: 0.15,
        brightnessShift: -0.72,
      });

      scene.fog.enabled = true;
      scene.fog.density = 3e-4;

      if (scene.sun) scene.sun.show = false;
      scene.backgroundColor = cesium.Color.fromCssColorString("#01030a");
      scene.highDynamicRange = true;
    },

    dispose() {
      // Imagery layers are removed by the scene.
    },
  };
}
