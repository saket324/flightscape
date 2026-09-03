/**
 * Creating and configuring the Cesium viewer.
 *
 * Flightscape supplies its own controls, so every Cesium widget is switched
 * off and the scene is set up for one job: showing a real place on Earth with
 * an aircraft above it.
 *
 * Imagery and terrain degrade rather than fail. With a Cesium Ion token you
 * get world imagery and real terrain relief; without one you get OpenStreetMap
 * over a smooth ellipsoid. The geography is correct either way -- only the
 * fidelity of what is under the aircraft changes.
 */
import type { CesiumModule } from "./bootstrap";
import { hasIonToken } from "./bootstrap";

type Cesium = CesiumModule;

export type SceneQuality = {
  /** True when Ion assets are in use. */
  hasWorldImagery: boolean;
  hasWorldTerrain: boolean;
};

/**
 * Esri World Imagery: global satellite and aerial photography, no key needed.
 *
 * Note the {z}/{y}/{x} ordering -- Esri's tile scheme puts row before column,
 * unlike the {z}/{x}/{y} of most slippy-map services.
 */
const ESRI_WORLD_IMAGERY =
  "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

/**
 * Base imagery.
 *
 * Satellite photography is not optional for this product: the promise is that
 * you can look down and see the actual place under the aircraft, and a road
 * map cannot deliver that. So the keyless path uses Esri World Imagery rather
 * than OpenStreetMap, and an Ion token simply upgrades the source.
 *
 * Ion asset 3954 is Sentinel-2 cloudless, which reads better from cruise
 * altitude than the default aerial mosaic and carries no baked-in labels.
 */
async function createBaseLayer(
  cesium: Cesium,
): Promise<{ layer: InstanceType<Cesium["ImageryLayer"]>; fromIon: boolean }> {
  if (hasIonToken()) {
    try {
      const provider = await cesium.IonImageryProvider.fromAssetId(3954);
      return { layer: new cesium.ImageryLayer(provider), fromIon: true };
    } catch (error) {
      console.warn(
        "[cesium] Ion imagery unavailable, falling back to Esri World Imagery",
        error,
      );
    }
  }

  return {
    layer: new cesium.ImageryLayer(
      new cesium.UrlTemplateImageryProvider({
        url: ESRI_WORLD_IMAGERY,
        credit:
          "Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community",
        maximumLevel: 19,
      }),
    ),
    fromIon: false,
  };
}

/**
 * Terrain.
 *
 * Real relief matters here: the product promises that crossing the Rockies
 * looks like crossing the Rockies. Without a token we use the smooth
 * ellipsoid, which is geographically correct but flat.
 */
async function createTerrain(cesium: Cesium): Promise<{
  provider: InstanceType<Cesium["EllipsoidTerrainProvider"]> | Awaited<
    ReturnType<Cesium["createWorldTerrainAsync"]>
  >;
  fromIon: boolean;
}> {
  if (hasIonToken()) {
    try {
      const provider = await cesium.createWorldTerrainAsync({
        requestVertexNormals: true,
        requestWaterMask: false,
      });
      return { provider, fromIon: true };
    } catch (error) {
      console.warn(
        "[cesium] Ion terrain unavailable, falling back to ellipsoid",
        error,
      );
    }
  }

  return { provider: new cesium.EllipsoidTerrainProvider(), fromIon: false };
}

export async function createViewer(
  cesium: Cesium,
  container: HTMLElement,
): Promise<{ viewer: InstanceType<Cesium["Viewer"]>; quality: SceneQuality }> {
  const [base, terrain] = await Promise.all([
    createBaseLayer(cesium),
    createTerrain(cesium),
  ]);

  const viewer = new cesium.Viewer(container, {
    baseLayer: base.layer,
    terrainProvider: terrain.provider,

    // Every widget off: the product supplies its own chrome.
    animation: false,
    timeline: false,
    baseLayerPicker: false,
    fullscreenButton: false,
    vrButton: false,
    geocoder: false,
    homeButton: false,
    infoBox: false,
    sceneModePicker: false,
    selectionIndicator: false,
    navigationHelpButton: false,
    projectionPicker: false,

    scene3DOnly: true,
    // The clock drives sun position for day/night lighting, so it must run
    // even though nothing else is time-animated.
    shouldAnimate: true,
    // Continuous rendering: the aircraft moves every frame, so render-on-
    // demand would just add bookkeeping for no saving.
    requestRenderMode: false,
  });

  configureScene(cesium, viewer);

  return {
    viewer,
    quality: {
      hasWorldImagery: base.fromIon,
      hasWorldTerrain: terrain.fromIon,
    },
  };
}

/** Scene defaults shared by every visual environment. */
function configureScene(
  cesium: Cesium,
  viewer: InstanceType<Cesium["Viewer"]>,
): void {
  const { scene, camera } = viewer;

  scene.globe.enableLighting = true;
  scene.globe.showGroundAtmosphere = true;
  // The default depth-test-against-terrain would bury the aircraft's route
  // line inside hillsides; we want the whole path visible from above.
  scene.globe.depthTestAgainstTerrain = false;

  if (scene.skyAtmosphere) scene.skyAtmosphere.show = true;
  scene.fog.enabled = true;

  // High dynamic range makes the atmosphere bloom in a way that reads as
  // haze rather than glare.
  scene.highDynamicRange = true;

  // Nothing in this product is picked or hovered, and both cost a render pass.
  scene.useDepthPicking = false;

  // Camera limits: close enough to see an airport, far enough for the globe.
  const controller = scene.screenSpaceCameraController;
  controller.minimumZoomDistance = 300;
  controller.maximumZoomDistance = 45_000_000;
  controller.enableCollisionDetection = true;

  // A slightly narrow field of view flattens perspective distortion at the
  // long focal lengths the cinematic camera uses.
  if (camera.frustum instanceof cesium.PerspectiveFrustum) {
    camera.frustum.fov = cesium.Math.toRadians(50);
  }

  // Keep the sun where it really is, so day/night matches the real world.
  viewer.clock.currentTime = cesium.JulianDate.now();
  viewer.clock.multiplier = 1;
}

/** Convert a geographic position plus altitude in feet into scene coordinates. */
export function toCartesian(
  cesium: Cesium,
  latitude: number,
  longitude: number,
  altitudeFeet: number | null,
  fallbackAltitudeFeet = 30_000,
): InstanceType<Cesium["Cartesian3"]> {
  // Cesium works in metres above the ellipsoid; the feeds report feet above
  // mean sea level. The two differ by the geoid separation, at most ~100 m,
  // which is invisible against a cruise altitude of eleven kilometres.
  const feet = altitudeFeet ?? fallbackAltitudeFeet;
  return cesium.Cartesian3.fromDegrees(longitude, latitude, feet * 0.3048);
}

/**
 * Orientation for an aircraft at a position.
 *
 * Heading is the aircraft's own reported value where available. Pitch and roll
 * stay conservative: we show what the data says, and do not invent dramatic
 * banking to make a turn look better than it was.
 */
export function aircraftOrientation(
  cesium: Cesium,
  position: InstanceType<Cesium["Cartesian3"]>,
  headingDegrees: number | null,
  pitchDegrees = 0,
  rollDegrees = 0,
): InstanceType<Cesium["Quaternion"]> {
  // The glTF convention has the model nosing along +X, so a heading of zero
  // (north) needs a quarter turn to line up.
  const heading = cesium.Math.toRadians((headingDegrees ?? 0) - 90);
  const hpr = new cesium.HeadingPitchRoll(
    heading,
    cesium.Math.toRadians(pitchDegrees),
    cesium.Math.toRadians(rollDegrees),
  );

  return cesium.Transforms.headingPitchRollQuaternion(position, hpr);
}
