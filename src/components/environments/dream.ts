/**
 * DREAM -- the world, reimagined.
 *
 * The most licence any environment takes. Imagery is hue-shifted into violets
 * and teals, the atmosphere glows, and a slow-drifting field of luminous
 * motes surrounds the aircraft.
 *
 * Every one of those is a change to how the scene is *drawn*. The aircraft's
 * latitude, longitude, altitude and heading are byte-for-byte the values the
 * live feed reported, exactly as in the realistic environment. The world can
 * be as strange as it likes; the flight cannot.
 */
import type {
  EnvironmentContext,
  EnvironmentFlightState,
  FlightEnvironment,
} from "./types";
import { configureSky, DEFAULT_THEME, resetScene } from "./types";
import type { CesiumModule } from "@/lib/cesium/bootstrap";

type Cesium = CesiumModule;

const MOTE_COUNT = 200;
/** Half-width of the mote field around the aircraft, in metres. */
const FIELD_RADIUS_M = 26_000;
const RECENTRE_DISTANCE_M = 11_000;

const MOTE_COLOURS = ["#a78bfa", "#4dd0e1", "#f0abfc", "#67e8f9", "#fbbf24"];

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

export function createDreamEnvironment(): FlightEnvironment {
  let cesium: Cesium | null = null;
  let viewer: InstanceType<Cesium["Viewer"]> | null = null;
  let motes: InstanceType<Cesium["PointPrimitiveCollection"]> | null = null;
  let fieldCentre: { latitude: number; longitude: number } | null = null;

  function buildField(latitude: number, longitude: number): void {
    if (!cesium || !motes) return;

    motes.removeAll();
    const random = seeded(0xd4ea3);

    const latSpan = FIELD_RADIUS_M / 111_320;
    const lonSpan =
      FIELD_RADIUS_M /
      (111_320 * Math.max(0.15, Math.cos((latitude * Math.PI) / 180)));

    for (let i = 0; i < MOTE_COUNT; i += 1) {
      const colour = MOTE_COLOURS[i % MOTE_COLOURS.length];

      motes.add({
        position: cesium.Cartesian3.fromDegrees(
          longitude + (random() * 2 - 1) * lonSpan,
          latitude + (random() * 2 - 1) * latSpan,
          // Spread through the aircraft's own altitude band, above and below.
          2_000 + random() * 16_000,
        ),
        pixelSize: 2 + random() * 7,
        color: cesium.Color.fromCssColorString(colour).withAlpha(
          0.35 + random() * 0.5,
        ),
        // Motes near the horizon would otherwise pile up into a bright band.
        translucencyByDistance: new cesium.NearFarScalar(
          1_000,
          1,
          260_000,
          0,
        ),
      });
    }

    fieldCentre = { latitude, longitude };
  }

  return {
    id: "dream",
    name: "Dream",

    theme: {
      ...DEFAULT_THEME,
      routeCompletedCss: "#f0abfc",
      routeRemainingCss: "#6d5b9e",
      trackCss: "#67e8f9",
      airportCss: "#fbbf24",
      labelCss: "#f5e8ff",
      labelOutlineCss: "#1a0b2e",
      routeGlow: true,
      aircraftScale: 1.3,
    },

    initialize(context: EnvironmentContext) {
      resetScene(context);

      cesium = context.cesium;
      viewer = context.viewer;
      const { scene } = context.viewer;

      // Push the imagery toward violet and drain the greens.
      context.baseLayer.hue = 0.62;
      context.baseLayer.saturation = 1.9;
      context.baseLayer.brightness = 0.95;
      context.baseLayer.contrast = 1.3;
      context.baseLayer.gamma = 0.8;

      scene.globe.enableLighting = true;
      scene.globe.baseColor = cesium.Color.fromCssColorString("#160c33");

      // An atmosphere in the wrong colour, on purpose.
      configureSky(scene, {
        show: true,
        hueShift: 0.55,
        saturationShift: 0.7,
        brightnessShift: 0.3,
      });

      scene.fog.enabled = true;
      scene.fog.density = 4e-4;

      if (scene.skyBox) scene.skyBox.show = true;
      if (scene.sun) scene.sun.show = false;

      scene.backgroundColor = cesium.Color.fromCssColorString("#0a0418");
      scene.highDynamicRange = true;

      motes = scene.primitives.add(
        new context.cesium.PointPrimitiveCollection(),
      ) as InstanceType<Cesium["PointPrimitiveCollection"]>;
    },

    update(state: EnvironmentFlightState) {
      if (!motes) return;

      if (!fieldCentre) {
        buildField(state.latitude, state.longitude);
        return;
      }

      const dLat = (state.latitude - fieldCentre.latitude) * 111_320;
      const dLon =
        (state.longitude - fieldCentre.longitude) *
        111_320 *
        Math.cos((state.latitude * Math.PI) / 180);

      if (Math.hypot(dLat, dLon) > RECENTRE_DISTANCE_M) {
        buildField(state.latitude, state.longitude);
      }
    },

    dispose() {
      if (motes && viewer && !viewer.isDestroyed()) {
        viewer.scene.primitives.remove(motes);
      }
      motes = null;
      viewer = null;
      cesium = null;
      fieldCentre = null;
    },
  };
}
