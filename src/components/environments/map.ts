/**
 * MAP -- the world as cartography.
 *
 * Satellite imagery is busy: at cruise altitude it is mostly cloud and haze,
 * and the route gets lost in it. This environment replaces it with a pale
 * vector-styled basemap, switches off sun lighting so the whole globe is
 * evenly lit, and drops the atmosphere. The result reads like a beautifully
 * drawn map that happens to be a sphere.
 *
 * The aircraft is at exactly the same latitude, longitude and altitude as in
 * every other environment. Only the paper changed.
 */
import type {
  EnvironmentContext,
  FlightEnvironment,
} from "./types";
import { configureSky, DEFAULT_THEME, resetScene } from "./types";

/** CartoDB Positron: a clean, label-light basemap, free for this scale of use. */
const POSITRON_URL =
  "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png";

export function createMapEnvironment(): FlightEnvironment {
  return {
    id: "map",
    name: "Map",

    theme: {
      ...DEFAULT_THEME,
      // Dark ink on pale paper: the inverse of every other environment.
      routeCompletedCss: "#0f6d8a",
      routeRemainingCss: "#8a97ad",
      trackCss: "#c2410c",
      airportCss: "#1f2937",
      labelCss: "#0f172a",
      labelOutlineCss: "#ffffff",
      routeGlow: false,
      aircraftScale: 1.15,
    },

    initialize(context: EnvironmentContext) {
      resetScene(context);

      const { cesium, viewer } = context;
      const { scene } = viewer;

      context.addImageryLayer(
        new cesium.UrlTemplateImageryProvider({
          url: POSITRON_URL,
          credit: "© OpenStreetMap contributors, © CARTO",
          maximumLevel: 18,
        }),
      );

      // The basemap replaces the imagery rather than tinting it.
      context.baseLayer.show = false;

      // Flat, even illumination: a map has no time of day.
      scene.globe.enableLighting = false;
      scene.globe.showGroundAtmosphere = false;
      scene.globe.baseColor = cesium.Color.fromCssColorString("#e8eef5");

      // No haze, no bloom -- both would soften the linework.
      scene.fog.enabled = false;
      configureSky(scene, { show: false });
      scene.highDynamicRange = false;
      if (scene.sun) scene.sun.show = false;
      if (scene.moon) scene.moon.show = false;

      // A pale sky, so the globe's edge stays legible against it.
      scene.backgroundColor = cesium.Color.fromCssColorString("#0a1424");
      if (scene.skyBox) scene.skyBox.show = false;
    },

    dispose() {
      // The imagery layer is removed by the scene, which tracks everything
      // handed out by addImageryLayer.
    },
  };
}
