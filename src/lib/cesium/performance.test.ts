import { describe, expect, it, vi } from "vitest";
import {
  medianOf,
  QUALITY_TIERS,
  QualityGovernor,
  type QualityTier,
} from "./performance";

/** Push `count` frames of `ms` each through the governor. */
function feed(governor: QualityGovernor, ms: number, count: number): void {
  for (let i = 0; i < count; i += 1) governor.recordFrame(ms);
}

const FAST = 8; // ~125fps
const SLOW = 30; // ~33fps
const OK = 15; // inside budget, outside headroom

describe("medianOf", () => {
  it("returns 0 for no samples", () => {
    expect(medianOf([])).toBe(0);
  });

  it("takes the middle of an odd-length set", () => {
    expect(medianOf([5, 1, 3])).toBe(3);
  });

  it("averages the middle pair of an even-length set", () => {
    expect(medianOf([1, 2, 3, 4])).toBe(2.5);
  });

  it("ignores a single outlier, unlike a mean", () => {
    const values = [10, 10, 10, 10, 10, 10, 10, 10, 10, 1000];
    expect(medianOf(values)).toBe(10);
  });
});

describe("QualityGovernor", () => {
  it("starts at full quality", () => {
    const governor = new QualityGovernor({ onChange: () => {} });
    expect(governor.currentTier.level).toBe(0);
    expect(governor.currentTier.hdr).toBe(true);
  });

  it("leaves a fast machine alone", () => {
    const onChange = vi.fn();
    const governor = new QualityGovernor({ onChange });

    feed(governor, FAST, 60 * 20);

    expect(onChange).not.toHaveBeenCalled();
    expect(governor.currentTier.level).toBe(0);
  });

  it("steps down when frames are consistently over budget", () => {
    const changes: QualityTier[] = [];
    const governor = new QualityGovernor({ onChange: (t) => changes.push(t) });

    // Two slow windows are required before the first drop.
    feed(governor, SLOW, 60);
    expect(changes).toHaveLength(0);

    feed(governor, SLOW, 60);
    expect(changes).toHaveLength(1);
    expect(changes[0].hdr).toBe(false);
  });

  it("drops HDR before touching resolution", () => {
    const changes: QualityTier[] = [];
    const governor = new QualityGovernor({ onChange: (t) => changes.push(t) });

    feed(governor, SLOW, 60 * 4);

    expect(changes[0].hdr).toBe(false);
    expect(changes[0].resolutionScale).toBe(1);
  });

  it("never degrades past the lowest tier", () => {
    const changes: QualityTier[] = [];
    const governor = new QualityGovernor({ onChange: (t) => changes.push(t) });

    feed(governor, SLOW, 60 * 60);

    expect(governor.currentTier.level).toBe(3);
    expect(changes).toHaveLength(QUALITY_TIERS.length - 1);
  });

  it("recovers quality when the machine speeds up again", () => {
    const governor = new QualityGovernor({ onChange: () => {} });

    feed(governor, SLOW, 60 * 4);
    const degraded = governor.currentTier.level;
    expect(degraded).toBeGreaterThan(0);

    feed(governor, FAST, 60 * 8);
    expect(governor.currentTier.level).toBeLessThan(degraded);
  });

  it("does not oscillate on frame times between the thresholds", () => {
    const onChange = vi.fn();
    const governor = new QualityGovernor({ onChange });

    feed(governor, OK, 60 * 30);

    expect(onChange).not.toHaveBeenCalled();
  });

  it("requires sustained slowness, not one bad window", () => {
    const onChange = vi.fn();
    const governor = new QualityGovernor({ onChange });

    // One slow window, then recovery: not enough to change anything.
    feed(governor, SLOW, 60);
    feed(governor, FAST, 60);
    feed(governor, SLOW, 60);
    feed(governor, FAST, 60);

    expect(onChange).not.toHaveBeenCalled();
  });

  it("ignores stalls from a backgrounded tab", () => {
    const onChange = vi.fn();
    const governor = new QualityGovernor({ onChange });

    // A tab restored after a minute produces one enormous delta. Treating
    // that as a performance signal would downgrade a perfectly fast machine.
    for (let i = 0; i < 200; i += 1) {
      governor.recordFrame(60_000);
      governor.recordFrame(FAST);
    }

    expect(onChange).not.toHaveBeenCalled();
    expect(governor.currentTier.level).toBe(0);
  });

  it("ignores nonsense deltas", () => {
    const onChange = vi.fn();
    const governor = new QualityGovernor({ onChange });

    for (let i = 0; i < 200; i += 1) {
      governor.recordFrame(Number.NaN);
      governor.recordFrame(0);
      governor.recordFrame(-5);
    }

    expect(onChange).not.toHaveBeenCalled();
  });

  it("reports the measured median for diagnostics", () => {
    const governor = new QualityGovernor({ onChange: () => {} });
    feed(governor, 12, 60);
    expect(governor.stats.medianFrameMs).toBe(12);
    expect(governor.stats.windows).toBe(1);
  });
});
