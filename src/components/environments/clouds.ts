/**
 * CLOUDS -- flying through weather.
 *
 * A cumulus deck is built around the aircraft using Cesium's cloud billboards,
 * and travels with it so the aircraft is always inside the field rather than
 * flying out of a fixed patch after a minute.
 *
 * The critical property: clouds are decoration. They are placed *relative to
 * wherever the aircraft actually is*, so the field follows the aircraft rather
 * than the aircraft being moved to meet the field. The real Earth stays
 * visible below and between them.
 *
 * The deck is procedural for now. The layout deliberately reads cloud altitude
 * and coverage from constants that a weather provider could later supply --
 * see the note on REAL WEATHER in the README.
 */
import type {
  EnvironmentContext,
  EnvironmentFlightState,
  FlightEnvironment,
} from "./types";
import { configureSky, DEFAULT_THEME, resetScene } from "./types";
import type { CesiumModule } from "@/lib/cesium/bootstrap";

type Cesium = CesiumModule;

/** Deck geometry. A weather feed would eventually supply these. */
const CLOUD_COUNT = 90;
/** Metres above sea level. A typical mid-level deck. */
const DECK_ALTITUDE_M = 6_500;
const DECK_THICKNESS_M = 2_200;
/** Half-width of the field around the aircraft, in metres. */
const FIELD_RADIUS_M = 55_000;
/** Rebuild the field once the aircraft has travelled this far through it. */
const RECENTRE_DISTANCE_M = 22_000;

/**
 * A deterministic pseudo-random sequence.
 *
 * Math.random would reshuffle the whole deck on every recentre, making the
 * clouds flicker; a seeded sequence keeps each cloud's shape stable.
 */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

export function createCloudsEnvironment(): FlightEnvironment {
  let cesium: Cesium | null = null;
  let viewer: InstanceType<Cesium["Viewer"]> | null = null;
  let clouds: InstanceType<Cesium["CloudCollection"]> | null = null;
  let fieldCentre: { latitude: number; longitude: number } | null = null;

  /** Lay the deck out around a geographic centre. */
  function buildField(latitude: number, longitude: number): void {
    if (!cesium || !clouds) return;

    clouds.removeAll();
    const random = seeded(0xc10d5);

    // Degrees covered by the field, corrected for convergence of meridians.
    const latSpan = FIELD_RADIUS_M / 111_320;
    const lonSpan =
      FIELD_RADIUS_M /
      (111_320 * Math.max(0.15, Math.cos((latitude * Math.PI) / 180)));

    for (let i = 0; i < CLOUD_COUNT; i += 1) {
      const cloudLat = latitude + (random() * 2 - 1) * latSpan;
      const cloudLon = longitude + (random() * 2 - 1) * lonSpan;
      const altitude =
        DECK_ALTITUDE_M + (random() * 2 - 1) * (DECK_THICKNESS_M / 2);

      // Fewer, larger clouds read as a weather system; many small ones read
      // as noise, which is what the first pass looked like.
      const width = 6_000 + random() * 13_000;
      const depth = 5_000 + random() * 11_000;
      const height = 1_400 + random() * 2_600;

      clouds.add({
        position: cesium.Cartesian3.fromDegrees(cloudLon, cloudLat, altitude),
        scale: new cesium.Cartesian2(width, depth),
        maximumSize: new cesium.Cartesian3(width / 2, depth / 2, height),
        // A higher slice takes a fuller cross-section through the cloud
        // volume, giving solid puffs rather than wispy fragments.
        slice: 0.45 + random() * 0.3,
        brightness: 0.85 + random() * 0.15,
      });
    }

    fieldCentre = { latitude, longitude };
  }

  return {
    id: "clouds",
    name: "Clouds",

    theme: {
      ...DEFAULT_THEME,
      routeCompletedCss: "#4dd0e1",
      routeRemainingCss: "#7f93b5",
      trackCss: "#ffffff",
      airportCss: "#e8f1ff",
      routeGlow: true,
      aircraftScale: 1.1,
    },

    initialize(context: EnvironmentContext) {
      resetScene(context);

      cesium = context.cesium;
      viewer = context.viewer;
      const { scene } = context.viewer;

      // Thick air: heavier fog and a warmer, brighter sky sell the sense of
      // being down among the weather.
      scene.fog.enabled = true;
      scene.fog.density = 6e-4;
      configureSky(scene, { show: true, brightnessShift: 0.25 });
      scene.globe.enableLighting = true;

      clouds = scene.primitives.add(
        new context.cesium.CloudCollection({
          // Lower detail than the default gives smoother, more billowy
          // shapes; high detail turns into speckle at the sizes used here.
          noiseDetail: 10,
          show: true,
        }),
      ) as InstanceType<Cesium["CloudCollection"]>;
    },

    /**
     * Keep the deck centred on the aircraft.
     *
     * Only rebuilt when the aircraft has moved a meaningful distance, so this
     * costs nothing on a typical frame.
     */
    update(state: EnvironmentFlightState) {
      if (!clouds) return;

      if (!fieldCentre) {
        buildField(state.latitude, state.longitude);
        return;
      }

      // Cheap planar estimate; exact distance is not needed for a threshold.
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
      if (clouds && viewer && !viewer.isDestroyed()) {
        viewer.scene.primitives.remove(clouds);
      }
      clouds = null;
      viewer = null;
      cesium = null;
      fieldCentre = null;
    },
  };
}
