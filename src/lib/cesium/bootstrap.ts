/**
 * Loading Cesium in a Next.js app.
 *
 * Two constraints shape this module:
 *
 * 1. Cesium's Workers, Assets and Widgets are served over HTTP rather than
 *    bundled, so `CESIUM_BASE_URL` has to be set on `window` *before* the
 *    library is imported. That forces a dynamic import behind a side effect,
 *    which is what `loadCesium()` is.
 *
 * 2. It is browser-only and multi-megabyte. Importing it from a module that
 *    the server also renders would break the build and slow the landing page,
 *    so nothing outside `components/globe` imports Cesium directly.
 */
import { publicConfig } from "@/config";

export type CesiumModule = typeof import("cesium");

declare global {
  interface Window {
    CESIUM_BASE_URL?: string;
  }
}

let cesiumPromise: Promise<CesiumModule> | null = null;

/**
 * Load Cesium once and reuse it.
 *
 * The promise is cached rather than the module, so concurrent callers during
 * mount share a single download instead of racing.
 */
export function loadCesium(): Promise<CesiumModule> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Cesium can only be loaded in a browser"));
  }

  if (!cesiumPromise) {
    window.CESIUM_BASE_URL = publicConfig.cesiumBaseUrl;

    cesiumPromise = import("cesium").then((module) => {
      // An Ion token unlocks world terrain and imagery. Without one we fall
      // back to open data, so the app still works from a clean checkout --
      // see `createImageryProvider` in scene.ts.
      if (publicConfig.cesiumIonToken) {
        module.Ion.defaultAccessToken = publicConfig.cesiumIonToken;
      }
      return module;
    });
  }

  return cesiumPromise;
}

export const hasIonToken = (): boolean => publicConfig.cesiumIonToken !== null;
