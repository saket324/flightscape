/**
 * The real-time core.
 *
 * Sits between the polling loop and the renderer, and is deliberately plain
 * TypeScript with no React in it at all. The Cesium render loop calls
 * `sample()` sixty times a second; React never re-renders at that rate, and
 * subscribers are notified on a slow, throttled tick suitable for text.
 *
 *      poll (every ~8s) --> ingest() --> [samples]
 *                                           |
 *      render loop (60fps) --> sample() ----+--> aircraft position
 *                                           |
 *      UI tick (~4Hz) --> subscribers ------+--> readouts
 *
 * Three responsibilities:
 *
 *   1. Hold observed samples and interpolate/extrapolate between them.
 *   2. Judge freshness against the *server's* clock, not the browser's.
 *   3. Maintain a bounded rolling track of where the aircraft has been.
 */
import type {
  FlightPosition,
  FreshnessLevel,
  PositionConfidence,
  RoutePoint,
} from "@/types/flight";
import { timing } from "@/config";
import { distanceMeters } from "@/lib/geography/greatCircle";
import {
  samplePositionAt,
  type SampledPosition,
} from "@/lib/interpolation/interpolate";

export type FlightSnapshot = {
  position: SampledPosition;
  /** Age of the newest observation, in seconds, against the server clock. */
  dataAgeSeconds: number;
  freshness: FreshnessLevel;
  /** The last actually-observed position, as distinct from the rendered one. */
  lastObserved: FlightPosition;
  /** Provenance for the rendered position: source, age, observed vs derived. */
  confidence: PositionConfidence;
};

type Listener = (snapshot: FlightSnapshot | null) => void;

/** How many samples to keep for interpolation. A handful is plenty. */
const MAX_SAMPLES = 12;

export function freshnessFor(ageSeconds: number): FreshnessLevel {
  if (ageSeconds >= timing.unavailableAfterSeconds) return "unavailable";
  if (ageSeconds >= timing.staleAfterSeconds) return "stale";
  if (ageSeconds >= timing.derivedAfterSeconds) return "derived";
  if (ageSeconds >= timing.recentAfterSeconds) return "recent";
  return "live";
}

export class FlightEngine {
  private samples: FlightPosition[] = [];
  private track: RoutePoint[] = [];

  /**
   * Bumped whenever the track changes.
   *
   * The renderer converts the whole track to scene coordinates, which it must
   * not redo every frame for data that changes every few seconds. Comparing a
   * counter is how it knows whether its cached geometry is still good.
   */
  private trackVersion = 0;
  private listeners = new Set<Listener>();

  /**
   * serverNow - clientNow, in milliseconds.
   *
   * Browser clocks are routinely wrong by seconds and occasionally by
   * minutes. Judging "how old is this data" against an unsynchronised local
   * clock would show a healthy feed as stale, or worse, a stale one as live.
   */
  private clockOffsetMs = 0;

  /** Name of the provider these samples came from, for provenance. */
  private sourceName = "unknown";

  /** Record which provider is supplying samples. */
  setSource(name: string): void {
    this.sourceName = name;
  }

  /** Wall-clock time as the server sees it. */
  now(clientNowMs: number = Date.now()): number {
    return clientNowMs + this.clockOffsetMs;
  }

  /**
   * Take a freshly polled position.
   *
   * Out-of-order and duplicate samples are discarded: feeds occasionally
   * repeat a fix, and accepting an older one would drag the aircraft
   * backwards.
   */
  ingest(position: FlightPosition | null, serverTimeIso: string): void {
    this.syncClock(serverTimeIso);

    if (!position) {
      // No fix this round. The existing samples stand and simply age, which
      // the freshness level reflects on the next tick.
      this.notify();
      return;
    }

    const incomingMs = Date.parse(position.timestamp);
    if (!Number.isFinite(incomingMs)) return;

    const newest = this.samples[this.samples.length - 1];
    if (newest && incomingMs <= Date.parse(newest.timestamp)) return;

    this.samples.push(position);
    if (this.samples.length > MAX_SAMPLES) {
      this.samples.splice(0, this.samples.length - MAX_SAMPLES);
    }

    this.appendToTrack(position);
    this.notify();
  }

  /** Seed the engine with known history, oldest first. */
  seed(positions: readonly FlightPosition[], serverTimeIso?: string): void {
    if (serverTimeIso) this.syncClock(serverTimeIso);

    for (const position of positions) {
      const ms = Date.parse(position.timestamp);
      if (!Number.isFinite(ms)) continue;
      this.appendToTrack(position);
    }

    const tail = positions.slice(-MAX_SAMPLES);
    if (tail.length > 0) this.samples = [...tail];
    this.notify();
  }

  /**
   * The aircraft's state at this instant.
   *
   * Called from the render loop, so it allocates little and never touches the
   * network or React.
   */
  sample(clientNowMs: number = Date.now()): FlightSnapshot | null {
    if (this.samples.length === 0) return null;

    const serverNow = this.now(clientNowMs);
    const lastObserved = this.samples[this.samples.length - 1];
    const dataAgeSeconds =
      (serverNow - Date.parse(lastObserved.timestamp)) / 1000;

    const freshness = freshnessFor(dataAgeSeconds);

    // Past the point of honest projection, hold at the last observed position
    // rather than dead-reckoning an aircraft we have lost track of.
    const renderAt =
      freshness === "unavailable"
        ? Date.parse(lastObserved.timestamp)
        : serverNow;

    const position = samplePositionAt(this.samples, renderAt);
    if (!position) return null;

    const confidence: PositionConfidence = {
      source: this.sourceName,
      observedAt: lastObserved.timestamp,
      ageSeconds: dataAgeSeconds,
      // The coordinates count as observed only when nothing was projected.
      observed: !position.isExtrapolated,
      level: freshness,
    };

    return { position, dataAgeSeconds, freshness, lastObserved, confidence };
  }

  /** The rolling track of observed positions, oldest first. */
  getTrack(): readonly RoutePoint[] {
    return this.track;
  }

  /** Changes whenever getTrack() would return something different. */
  getTrackVersion(): number {
    return this.trackVersion;
  }

  /** The newest observed position, or null before the first poll. */
  getLastObserved(): FlightPosition | null {
    return this.samples[this.samples.length - 1] ?? null;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  reset(): void {
    this.samples = [];
    this.track = [];
    this.trackVersion += 1;
    this.clockOffsetMs = 0;
  }

  // --- internals -----------------------------------------------------------

  private syncClock(serverTimeIso: string): void {
    const serverMs = Date.parse(serverTimeIso);
    if (Number.isFinite(serverMs)) {
      this.clockOffsetMs = serverMs - Date.now();
    }
  }

  /**
   * Append to the rolling track.
   *
   * Points closer together than the minimum spacing are skipped: a parked or
   * slow-moving aircraft would otherwise fill the buffer with a cluster of
   * near-identical points and push out the useful history. The buffer is
   * capped so a long-haul flight cannot grow it without bound.
   */
  private appendToTrack(position: FlightPosition): void {
    const previous = this.track[this.track.length - 1];

    if (
      previous &&
      distanceMeters(previous, position) < timing.minTrackPointSpacingMeters
    ) {
      return;
    }

    this.trackVersion += 1;
    this.track.push({
      latitude: position.latitude,
      longitude: position.longitude,
      altitude: position.altitude,
      // Observed, not estimated. The route renderer relies on this to avoid
      // drawing a schedule as though it were a flown path.
      kind: "observed",
      timestamp: position.timestamp,
    });

    if (this.track.length > timing.maxTrackPoints) {
      this.track.splice(0, this.track.length - timing.maxTrackPoints);
    }
  }

  private notify(): void {
    const snapshot = this.sample();
    for (const listener of this.listeners) listener(snapshot);
  }
}
