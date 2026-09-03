/**
 * The contract every flight-data source implements.
 *
 * The visualization layer talks only to this interface. Swapping adsb.lol for
 * FlightAware, or adding a paid provider alongside the free ones, should mean
 * writing one file in this directory and registering it -- nothing above the
 * provider boundary knows a vendor's name.
 */
import type { Flight, FlightPosition } from "@/types/flight";

export interface FlightDataProvider {
  /** Stable key used in configuration and in `Flight.id`. */
  readonly id: string;
  /** Shown to users when describing where data came from. */
  readonly name: string;
  /** Attribution text the provider's terms expect us to display. */
  readonly attribution: string;
  /**
   * Whether this provider reports real aircraft.
   *
   * The demo provider sets this false, and that single bit is what stops
   * simulated data from ever being labelled LIVE.
   */
  readonly isLive: boolean;

  /**
   * Find flights matching a user-entered identifier.
   *
   * Returns every plausible match so the UI can disambiguate -- the same
   * flight number is often used for both directions of a rotation. An empty
   * array means "nothing found", which is a normal answer, not an error.
   */
  searchFlight(identifier: string): Promise<Flight[]>;

  /**
   * The aircraft's current position, or null if the provider has no fix.
   *
   * Implementations must never return a remembered or estimated coordinate
   * here. Null is the correct answer when the aircraft's position is unknown.
   */
  getLivePosition(flightId: string): Promise<FlightPosition | null>;

  /** Route, airline and schedule metadata for a known flight. */
  getFlightDetails(flightId: string): Promise<Flight | null>;
}

/** Providers are constructed lazily so configuration is read at call time. */
export type FlightProviderFactory = () => FlightDataProvider;
