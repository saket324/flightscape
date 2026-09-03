import { FlightSearch } from "@/components/ui/FlightSearch";

/**
 * The landing page.
 *
 * Static and light: no globe here. Cesium is a multi-megabyte download and
 * loading it before the user has chosen a flight would make the first screen
 * slow for no benefit. The horizon below is CSS.
 */
export default function Home() {
  return (
    <main className="relative flex h-full flex-col items-center justify-center overflow-hidden px-6">
      <Backdrop />

      <div className="animate-rise relative z-10 flex w-full flex-col items-center">
        <h1 className="font-mono text-3xl font-medium tracking-[0.4em] text-ink sm:text-5xl sm:tracking-[0.5em]">
          FLIGHTSCAPE
        </h1>

        <p className="mt-5 text-center text-lg text-ink-muted sm:text-xl">
          See your journey differently.
        </p>
        <p className="mt-2 mb-10 text-center text-sm text-ink-faint">
          Enter a flight number to watch it live, in three dimensions.
        </p>

        <FlightSearch />
      </div>

      <footer className="relative z-10 mt-14 px-4 text-center text-xs text-ink-faint/70">
        Live positions from the adsb.lol and adsb.fi community networks.
        <br className="hidden sm:block" /> Route data from adsbdb.
      </footer>
    </main>
  );
}

/**
 * A suggested horizon: atmospheric glow above a curved limb.
 *
 * Pure CSS so the first paint costs nothing.
 */
function Backdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      {/* Atmospheric halo, sitting where the Earth's limb would be. */}
      <div
        className="absolute left-1/2 h-[120vmax] w-[120vmax] -translate-x-1/2 rounded-full opacity-70"
        style={{
          top: "58vh",
          background:
            "radial-gradient(circle at 50% 0%, color-mix(in srgb, var(--color-signal) 22%, transparent) 0%, color-mix(in srgb, var(--color-signal) 6%, transparent) 28%, transparent 55%)",
        }}
      />

      {/* The limb itself. */}
      <div
        className="absolute left-1/2 h-[120vmax] w-[120vmax] -translate-x-1/2 rounded-full border-t border-signal/25"
        style={{
          top: "60vh",
          background:
            "linear-gradient(to bottom, var(--color-abyss) 0%, var(--color-void) 40%)",
        }}
      />

      <Stars />

      {/* Vignette, so the type always has something quiet to sit on. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at 50% 35%, transparent 30%, color-mix(in srgb, var(--color-void) 75%, transparent) 100%)",
        }}
      />
    </div>
  );
}

/**
 * A fixed star field.
 *
 * Positions are hard-coded rather than random so the server and client render
 * identical markup -- Math.random() here would hydrate mismatched.
 */
function Stars() {
  const stars = [
    [8, 12, 1], [17, 31, 1], [23, 8, 2], [31, 22, 1], [38, 41, 1],
    [44, 15, 1], [52, 28, 2], [58, 9, 1], [63, 35, 1], [71, 19, 1],
    [77, 44, 2], [84, 13, 1], [89, 30, 1], [94, 22, 1], [12, 47, 1],
    [27, 52, 1], [41, 6, 1], [49, 49, 1], [67, 52, 1], [81, 55, 2],
    [3, 27, 1], [35, 34, 1], [55, 41, 1], [73, 7, 1], [96, 45, 1],
  ] as const;

  return (
    <div className="absolute inset-0">
      {stars.map(([left, top, size], index) => (
        <span
          key={index}
          className="absolute rounded-full bg-ink"
          style={{
            left: `${left}%`,
            top: `${top}%`,
            width: size,
            height: size,
            opacity: 0.18 + (index % 5) * 0.09,
          }}
        />
      ))}
    </div>
  );
}
