/**
 * SPACE -- Earth from far enough away to see it curve.
 *
 * The camera pulls back, the stars come up, and the atmosphere becomes the
 * bright thin line it actually is from orbit. The aircraft is still at its
 * true coordinates; it is simply very small, so the model is scaled up to stay
 * visible. That is a rendering decision about the marker, not a change to
 * where the marker sits -- its position is untouched.
 */
import type { EnvironmentContext, FlightEnvironment } from "./types";
import { configureSky, DEFAULT_THEME, resetScene } from "./types";

export function createSpaceEnvironment(): FlightEnvironment {
  return {
    id: "space",
    name: "Space",

    theme: {
      ...DEFAULT_THEME,
      routeCompletedCss: "#5ce6a8",
      routeRemainingCss: "#2e5a7a",
      trackCss: "#4dd0e1",
      airportCss: "#8ea6c8",
      routeGlow: true,
      // Visible from thousands of kilometres up. The model gets bigger; the
      // coordinate it is drawn at does not move.
      aircraftScale: 3.2,
    },

    initialize(context: EnvironmentContext) {
      resetScene(context);

      const { cesium, viewer } = context;
      const { scene } = viewer;

      // Deepen the imagery so the lit limb reads bright against black.
      context.baseLayer.brightness = 0.82;
      context.baseLayer.contrast = 1.25;
      context.baseLayer.saturation = 1.15;

      scene.globe.enableLighting = true;
      scene.globe.showGroundAtmosphere = true;
      scene.globe.baseColor = cesium.Color.fromCssColorString("#050d1a");

      // The orbital view of the atmosphere: a hard, bright, narrow band.
      configureSky(scene, {
        show: true,
        brightnessShift: 0.4,
        saturationShift: 0.3,
      });

      // Fog is a low-altitude phenomenon; from here it would just grey
      // everything out.
      scene.fog.enabled = false;

      if (scene.skyBox) scene.skyBox.show = true;
      if (scene.sun) scene.sun.show = true;
      if (scene.moon) scene.moon.show = true;

      scene.backgroundColor = cesium.Color.BLACK;
      scene.highDynamicRange = true;
    },

    dispose() {
      // resetScene restores the imagery adjustments for the next environment.
    },
  };
}
