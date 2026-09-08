/**
 * Adaptive render quality.
 *
 * The audit found the scene's fixed settings -- high dynamic range and 4x MSAA,
 * always on -- cost roughly 2 ms of a frame at 1280x720 (a render went from
 * 3.45 ms to 1.45 ms with HDR alone switched off). That is affordable there,
 * but the cost scales with pixel count, and a 4K or HiDPI display renders
 * several times as many pixels. Fixed settings mean the same scene is
 * comfortable on one machine and stuttering on another.
 *
 * So rather than lowering quality for everyone, this measures frame time and
 * steps down only when a device is actually missing its budget, then steps
 * back up if it recovers. A capable machine keeps the full-quality scene.
 *
 * Deliberately conservative about stepping back up: oscillating between
 * quality levels is more distracting than sitting one level below the best.
 */

export type QualityLevel = 0 | 1 | 2 | 3;

export type QualityTier = {
  level: QualityLevel;
  label: string;
  hdr: boolean;
  msaaSamples: number;
  /** Multiplier on the browser-recommended resolution. */
  resolutionScale: number;
};

/**
 * Ordered best first.
 *
 * Post-processing goes before geometry sharpness, and resolution is given up
 * last: a soft image reads as "broken" far more readily than slightly flatter
 * lighting does.
 */
export const QUALITY_TIERS: readonly QualityTier[] = [
  { level: 0, label: "full", hdr: true, msaaSamples: 4, resolutionScale: 1 },
  { level: 1, label: "no-hdr", hdr: false, msaaSamples: 4, resolutionScale: 1 },
  { level: 2, label: "no-hdr-msaa2", hdr: false, msaaSamples: 2, resolutionScale: 1 },
  { level: 3, label: "reduced", hdr: false, msaaSamples: 1, resolutionScale: 0.8 },
];

/** Frame budget, in milliseconds. Below this we are missing 60fps. */
const TARGET_FRAME_MS = 18;
/** Comfortably inside budget: only then is stepping back up considered. */
const HEADROOM_FRAME_MS = 11;

/** Frames per decision window. ~1 second at 60fps. */
const WINDOW_FRAMES = 60;
/** Consecutive slow windows before dropping a tier. */
const SLOW_WINDOWS_TO_DROP = 2;
/** Consecutive fast windows before regaining one. Deliberately long. */
const FAST_WINDOWS_TO_RAISE = 8;

export type QualityGovernorOptions = {
  onChange: (tier: QualityTier) => void;
  /** Starting tier. Defaults to full quality. */
  initialLevel?: QualityLevel;
};

export class QualityGovernor {
  private level: QualityLevel;
  private readonly onChange: (tier: QualityTier) => void;

  private frameTimes: number[] = [];
  private slowWindows = 0;
  private fastWindows = 0;

  /** Median frame time of the last completed window, for reporting. */
  private lastMedianMs = 0;
  private windowsObserved = 0;

  constructor(options: QualityGovernorOptions) {
    this.level = options.initialLevel ?? 0;
    this.onChange = options.onChange;
  }

  get currentTier(): QualityTier {
    return QUALITY_TIERS[this.level];
  }

  get stats(): { medianFrameMs: number; level: QualityLevel; windows: number } {
    return {
      medianFrameMs: this.lastMedianMs,
      level: this.level,
      windows: this.windowsObserved,
    };
  }

  /**
   * Record one frame.
   *
   * `deltaMs` is wall-clock time between frames, which is what the viewer
   * actually experiences -- it captures GPU cost, compositing and any main
   * thread work, none of which a CPU-side timer around `render()` would see.
   */
  recordFrame(deltaMs: number): void {
    // Ignore absurd deltas: a backgrounded tab or a debugger pause is not a
    // performance signal, and would otherwise trigger an immediate downgrade.
    if (!Number.isFinite(deltaMs) || deltaMs <= 0 || deltaMs > 500) return;

    this.frameTimes.push(deltaMs);
    if (this.frameTimes.length < WINDOW_FRAMES) return;

    this.evaluateWindow();
    this.frameTimes.length = 0;
  }

  private evaluateWindow(): void {
    const median = medianOf(this.frameTimes);
    this.lastMedianMs = median;
    this.windowsObserved += 1;

    if (median > TARGET_FRAME_MS) {
      this.slowWindows += 1;
      this.fastWindows = 0;

      if (this.slowWindows >= SLOW_WINDOWS_TO_DROP && this.level < 3) {
        this.level = (this.level + 1) as QualityLevel;
        this.slowWindows = 0;
        this.onChange(this.currentTier);
      }
      return;
    }

    if (median < HEADROOM_FRAME_MS) {
      this.fastWindows += 1;
      this.slowWindows = 0;

      if (this.fastWindows >= FAST_WINDOWS_TO_RAISE && this.level > 0) {
        this.level = (this.level - 1) as QualityLevel;
        this.fastWindows = 0;
        this.onChange(this.currentTier);
      }
      return;
    }

    // In between: holding steady is the right answer, so decay both counters
    // rather than letting a long mediocre stretch accumulate into a change.
    this.slowWindows = 0;
    this.fastWindows = 0;
  }
}

/** Median rather than mean: one stalled frame should not move the decision. */
export function medianOf(values: readonly number[]): number {
  if (values.length === 0) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}
