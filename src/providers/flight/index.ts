/**
 * Provider registry.
 *
 * Adding a source means writing one file in this directory and adding a line
 * to FACTORIES. Nothing above this boundary changes.
 */
import { serverConfig } from "@/config";
import type { FlightDataProvider, FlightProviderFactory } from "./types";
import { AdsbFlightProvider } from "./adsb";
import { DemoFlightProvider } from "./demo";
import { OpenSkyFlightProvider } from "./opensky";

export type { FlightDataProvider } from "./types";

const FACTORIES: Readonly<Record<string, FlightProviderFactory>> = {
  adsb: () => new AdsbFlightProvider(),
  opensky: () => new OpenSkyFlightProvider(),
  demo: () => new DemoFlightProvider(),
};

const instances = new Map<string, FlightDataProvider>();

function instantiate(id: string): FlightDataProvider | null {
  const existing = instances.get(id);
  if (existing) return existing;

  const factory = FACTORIES[id];
  if (!factory) return null;

  const provider = factory();
  instances.set(id, provider);
  return provider;
}

/** The configured live provider, falling back to adsb if misconfigured. */
export function getFlightProvider(): FlightDataProvider {
  const configured = instantiate(serverConfig.providerId);
  if (configured) return configured;

  console.warn(
    `[providers] unknown FLIGHT_PROVIDER "${serverConfig.providerId}"; using adsb`,
  );
  return instantiate("adsb")!;
}

export function getDemoProvider(): FlightDataProvider {
  return instantiate("demo")!;
}

/**
 * Resolve the provider that owns a flight id.
 *
 * Ids are prefixed with their provider (`demo:ACA103`, `adsb:ACA103:c02f41`),
 * so a request always reaches the source that minted it. In particular a demo
 * id can never be answered by a live provider or vice versa.
 */
export function getProviderForFlightId(flightId: string): FlightDataProvider {
  const prefix = flightId.split(":")[0];
  return instantiate(prefix) ?? getFlightProvider();
}

export function isDemoFlightId(flightId: string): boolean {
  return flightId.split(":")[0] === "demo";
}
