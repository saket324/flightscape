/**
 * REALISTIC -- the default.
 *
 * Earth as it is: real imagery, real terrain, real sunlight falling where the
 * sun is actually falling right now. The job here is restraint. Everything
 * that makes this look right is already in `resetScene`; this environment adds
 * only the small amount of atmospheric warmth that keeps the limb from
 * reading as a hard edge.
 */
import type {
  EnvironmentContext,
  FlightEnvironment,
} from "./types";
import { configureSky, DEFAULT_THEME, resetScene } from "./types";

export function createRealisticEnvironment(): FlightEnvironment {
  return {
    id: "realistic",
    name: "Realistic",

    theme: {
      ...DEFAULT_THEME,
      routeCompletedCss: "#4dd0e1",
      routeRemainingCss: "#8ea6c8",
      trackCss: "#ffd479",
      airportCss: "#ffffff",
    },

    initialize(context: EnvironmentContext) {
      resetScene(context);

      const { scene } = context.viewer;

      // A touch of extra atmosphere: from cruise altitude the real limb is a
      // thin, bright band, and Cesium's default reads slightly flat.
      configureSky(scene, { brightnessShift: 0.08 });
      scene.fog.density = 1.4e-4;
    },

    dispose() {
      // Nothing allocated; resetScene handles the teardown for the next
      // environment.
    },
  };
}
