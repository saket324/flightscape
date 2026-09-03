"use client";

/**
 * The status badge.
 *
 * The single most important piece of text in the product: it is the promise
 * that what you are watching is real. It is driven by two independent facts --
 * whether the source is live at all, and how old its newest observation is --
 * and it degrades honestly through both.
 *
 *   LIVE       real source, fresh data
 *   DELAYED    real source, data ageing
 *   NO SIGNAL  real source, nothing recent enough to trust
 *   DEMO       simulated source, whatever its age
 *   LANDED     the flight is over
 */
import type { FreshnessLevel } from "@/types/flight";
import { formatDataAge } from "@/lib/flight/format";

export type IndicatorState =
  | { kind: "live"; freshness: FreshnessLevel; ageSeconds: number }
  | { kind: "demo" }
  | { kind: "landed" }
  | { kind: "connecting" };

const STYLES: Record<
  string,
  { dot: string; text: string; ring: string; pulse: boolean }
> = {
  live: {
    dot: "bg-ok",
    text: "text-ok",
    ring: "bg-ok/15 border-ok/30",
    pulse: true,
  },
  delayed: {
    dot: "bg-warn",
    text: "text-warn",
    ring: "bg-warn/15 border-warn/30",
    pulse: false,
  },
  lost: {
    dot: "bg-alert",
    text: "text-alert",
    ring: "bg-alert/15 border-alert/30",
    pulse: false,
  },
  demo: {
    dot: "bg-signal",
    text: "text-signal",
    ring: "bg-signal/15 border-signal/30",
    pulse: false,
  },
  landed: {
    dot: "bg-ink-muted",
    text: "text-ink-muted",
    ring: "bg-ink-muted/10 border-ink-muted/25",
    pulse: false,
  },
  connecting: {
    dot: "bg-ink-faint",
    text: "text-ink-faint",
    ring: "bg-ink-faint/10 border-ink-faint/25",
    pulse: true,
  },
};

function describe(state: IndicatorState): {
  label: string;
  detail: string | null;
  style: (typeof STYLES)[string];
} {
  switch (state.kind) {
    case "demo":
      return {
        label: "DEMO",
        detail: "Simulated flight",
        style: STYLES.demo,
      };

    case "landed":
      return { label: "LANDED", detail: null, style: STYLES.landed };

    case "connecting":
      return {
        label: "CONNECTING",
        detail: "Looking for this aircraft",
        style: STYLES.connecting,
      };

    case "live": {
      if (state.freshness === "unavailable") {
        return {
          label: "NO SIGNAL",
          // Never present an old fix as current -- say exactly how old it is.
          detail: `Last known position ${formatDataAge(state.ageSeconds)}`,
          style: STYLES.lost,
        };
      }

      if (state.freshness === "delayed" || state.freshness === "stale") {
        return {
          label: "DELAYED",
          detail: `Updated ${formatDataAge(state.ageSeconds)}`,
          style: STYLES.delayed,
        };
      }

      return {
        label: "LIVE",
        detail: `Updated ${formatDataAge(state.ageSeconds)}`,
        style: STYLES.live,
      };
    }
  }
}

export function LiveIndicator({
  state,
  className = "",
}: {
  state: IndicatorState;
  className?: string;
}) {
  const { label, detail, style } = describe(state);

  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <span
        className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 ${style.ring}`}
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${style.dot} ${
            style.pulse ? "animate-live" : ""
          }`}
        />
        <span
          className={`text-[11px] font-semibold tracking-[0.14em] ${style.text}`}
        >
          {label}
        </span>
      </span>

      {detail && (
        <span className="tabular truncate text-xs text-ink-faint">{detail}</span>
      )}
    </div>
  );
}
