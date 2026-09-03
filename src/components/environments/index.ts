/**
 * Environment registry.
 *
 * Adding a world: write a module here and add one line below.
 */
import type { VisualEnvironmentId } from "@/types/visualization";
import type { FlightEnvironment, FlightEnvironmentFactory } from "./types";
import { createCloudsEnvironment } from "./clouds";
import { createDreamEnvironment } from "./dream";
import { createMapEnvironment } from "./map";
import { createNightEnvironment } from "./night";
import { createRealisticEnvironment } from "./realistic";
import { createSpaceEnvironment } from "./space";

export type {
  EnvironmentContext,
  EnvironmentFlightState,
  EnvironmentTheme,
  FlightEnvironment,
} from "./types";
export { DEFAULT_THEME } from "./types";

const FACTORIES: Readonly<
  Record<VisualEnvironmentId, FlightEnvironmentFactory>
> = {
  realistic: createRealisticEnvironment,
  map: createMapEnvironment,
  night: createNightEnvironment,
  space: createSpaceEnvironment,
  clouds: createCloudsEnvironment,
  dream: createDreamEnvironment,
};

/**
 * Build a fresh environment instance.
 *
 * New each time rather than pooled: environments hold Cesium primitives tied
 * to a particular viewer, and reusing one across a viewer teardown would hand
 * back references to destroyed objects.
 */
export function createEnvironment(id: VisualEnvironmentId): FlightEnvironment {
  return (FACTORIES[id] ?? FACTORIES.realistic)();
}
