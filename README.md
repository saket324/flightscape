# Flightscape

**See your journey differently.**

Enter a flight number. Flightscape finds the aircraft that is flying right now,
places it at its real coordinates on a 3D Earth, and lets you change the world
around it.

```
                              ✈
                            ╱
                    REAL 3D EARTH
        ────────────────────────────────────
        Toronto                    Vancouver
```

The visual world is imaginative. The flight data is not.

---

## The one rule

Everything in this codebase follows from a single constraint:

> **The live feed determines where the aircraft is. Nothing else may.**

Latitude, longitude, altitude, heading, speed and timestamp come from a real
position report. The visual layer can turn the Earth violet, fill the sky with
cloud, or pull the camera into orbit — and in every one of those worlds the
aircraft sits at exactly the same coordinate.

Concretely, that means:

- Simulated data is labelled `DEMO` and can never be labelled `LIVE`. The flag
  travels with the data from the provider to the badge.
- A failed live search never silently falls back to the demo. The user is told,
  and chooses.
- Data age is shown, and shown honestly: `LIVE`, then `DELAYED`, then
  `NO SIGNAL` with the age of the last known fix.
- A planned great-circle route and an observed track are different things and
  are never drawn as one line.

---

## Features

**Live flight tracking.** Search by flight number in either the form people
know (`AC103`) or the form aircraft transmit (`ACA103`). Positions update every
few seconds from community ADS-B networks.

**A real 3D Earth.** CesiumJS with satellite imagery, atmosphere, and real
day/night lighting. Look down and you see the actual place under the aircraft.

**Smooth motion.** The feed updates every several seconds; the aircraft moves
continuously at display rate. See [Real-time architecture](#real-time-architecture).

**Five camera modes.** Global, Regional, Follow, Cinematic and Cockpit — all of
them tracking the real aircraft.

**Six visual environments.** Realistic, Map, Night, Space, Clouds and Dream.

**No API keys required.** Works from a clean checkout against keyless data
sources. Keys upgrade quality; they are not a prerequisite.

---

## Tech stack

| Layer | Choice |
| --- | --- |
| Framework | Next.js 16 (App Router), React 19 |
| Language | TypeScript, strict |
| 3D | CesiumJS 1.145 |
| Styling | Tailwind CSS 4 |
| Tests | Vitest 5 |

---

## Local setup

Requires Node 22 or newer.

```bash
git clone https://github.com/saket324/flightscape.git
cd flightscape
npm install
npm run dev
```

Open <http://localhost:3000>. No configuration needed — search a flight that is
currently airborne, or press **Try a demo flight**.

`npm install` runs `scripts/copy-cesium.mjs`, which copies Cesium's static
Workers, Assets and Widgets into `public/cesium`. Those are served over HTTP
rather than bundled, so they must be present before the globe will start.

### Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` | Production build, including type checking |
| `npm test` | Unit tests — offline and deterministic |
| `npm run test:live` | Integration tests against the real upstream APIs |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build-model` | Regenerate the aircraft model |

---

## Environment variables

Every variable is optional. Copy `.env.example` to `.env.local` to set any.

| Variable | Effect if unset |
| --- | --- |
| `NEXT_PUBLIC_CESIUM_ION_TOKEN` | Falls back to Esri World Imagery and a smooth ellipsoid. Geography stays correct; there is no 3D terrain relief. |
| `FLIGHT_PROVIDER` | Defaults to `adsb`. |
| `OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET` | OpenSky is used anonymously, at a lower rate limit. |
| `FLIGHT_POLL_INTERVAL_SECONDS` | Defaults to 8. |

`.env*` is gitignored apart from `.env.example`. Provider credentials are read
only in server code and never reach the browser; the Cesium Ion token is
`NEXT_PUBLIC_` by design, since the browser is what uses it.

### Cesium Ion setup

A free token from [ion.cesium.com/tokens](https://ion.cesium.com/tokens) adds:

- Cesium World Terrain — real mountains, so crossing the Rockies looks like it
- Sentinel-2 cloudless imagery, which reads better from cruise altitude

Without a token the app still shows real satellite imagery, just over a smooth
globe.

### Flight API setup

None required. The default provider uses:

- **[adsb.lol](https://adsb.lol)** and **[adsb.fi](https://adsb.fi)** —
  community ADS-B receiver networks, for live positions
- **[adsbdb](https://adsbdb.com)** — for airline, origin and destination

These are volunteer-run. Flightscape polls at a modest interval and spaces its
requests; please keep it that way if you fork this.

---

## Real-time architecture

Flight APIs report a position every several seconds. A globe renders sixty
times a second. Everything between those two numbers is the interesting part.

```
   poll (~8s)  ──▶  FlightEngine.ingest()  ──▶  [samples]
                                                    │
   render loop (60fps)  ──▶  sample(now)  ─────────▶├──▶  aircraft position
                                                    │
   UI tick (~4Hz)  ──▶  React state  ──────────────▶└──▶  text readouts
```

`FlightEngine` is plain TypeScript with no React in it. Cesium reads it every
frame through callback properties, so **the aircraft's motion never passes
through React** — no reconciliation at frame rate.

Three details that matter more than they look:

**Interpolation vs extrapolation.** When the render time falls between two
observed samples, the position is bounded by real data on both sides. Past the
newest sample — the normal case, since feeds lag reality — the position is
dead-reckoned forward from the last observation using its own reported speed
and track. That is an estimate derived from real data, it is capped at 45
seconds, and it is flagged so the UI can say so.

**Freshness is judged against the server's clock.** Browser clocks are
routinely wrong by seconds. The engine learns the offset on every poll;
without that correction a healthy feed can read as `DELAYED`, or worse, a stale
one as `LIVE`.

**The track is bounded.** Points closer together than 400 m are skipped and the
buffer is capped, so a long-haul flight cannot grow it without limit.

---

## Architecture

```
src/
  app/                     routes and API handlers
    api/flights/           server-side provider proxy
    flight/[id]/           the visualization
  components/
    globe/                 the React boundary around Cesium
    flight/                panel, live indicator, error states
    ui/                    search, controls
    environments/          the six visual worlds
  lib/
    animation/             FlightEngine — the real-time core
    cesium/                viewer setup, cameras, scene
    flight/                validation, errors, HTTP, cache, formatting
    geography/             great-circle maths
    interpolation/         position interpolation and dead reckoning
  providers/flight/        data sources behind one interface
  hooks/  types/  config/
```

The layers are kept apart deliberately: flight data, geographic maths,
animation, visualization and UI each know as little about the others as
possible. Cesium is imported **only** under `components/globe` and
`lib/cesium` — it is browser-only and multi-megabyte, and the landing page
should not pay for it.

### Adding a flight provider

Implement `FlightDataProvider` (`src/providers/flight/types.ts`):

```ts
interface FlightDataProvider {
  readonly id: string;
  readonly name: string;
  readonly attribution: string;
  readonly isLive: boolean;

  searchFlight(identifier: string): Promise<Flight[]>;
  getLivePosition(flightId: string): Promise<FlightPosition | null>;
  getFlightDetails(flightId: string): Promise<Flight | null>;
}
```

Then add one line to `FACTORIES` in `src/providers/flight/index.ts`. Nothing
above the provider boundary changes.

Two contracts to honour:

- `getLivePosition` returns `null` when the position is unknown. Never a
  remembered or estimated coordinate — null is the correct, honest answer.
- `isLive` is false for anything simulated, and stays false all the way to the
  badge.

Flight ids are provider-prefixed (`demo:ACA103`, `adsb:ACA103:c02f41`), so a
demo id can never be answered by a live provider or the reverse.

### Adding a visual environment

Implement `FlightEnvironment` (`src/components/environments/types.ts`):

```ts
interface FlightEnvironment {
  readonly id: VisualEnvironmentId;
  readonly name: string;
  readonly theme: EnvironmentTheme;

  initialize(context: EnvironmentContext): void;
  update?(state: EnvironmentFlightState): void;
  dispose(): void;
}
```

Register it in `src/components/environments/index.ts`.

An environment receives the aircraft's real state each frame and can only read
it. It may change imagery, atmosphere, lighting, fog and its own primitives; it
has no way to move the aircraft. `resetScene` runs before `initialize`, so an
environment only describes its differences from a plain realistic Earth rather
than undoing whatever ran before it.

The `theme` covers scene elements the environment does not own — route, track,
labels — because a cyan line that works over dark ocean disappears over a pale
map.

---

## Testing

```bash
npm test          # offline, deterministic
npm run test:live # hits the real APIs
```

Unit tests cover the parts where being wrong is silent:

- **Geographic maths** — distance, bearing, great-circle interpolation across
  the antimeridian and the poles, along-track progress
- **Interpolation** — including a sweep asserting the aircraft never jumps
  between consecutive frames, and that extrapolation is capped
- **Validation** — that malformed upstream data becomes `null` rather than a
  `NaN` in the scene graph
- **Providers** — valid responses, missing fields, rate limits, network
  failure, and unknown response shapes
- **Cameras** — continuity of the cinematic sequence, frame-rate-independent
  damping

Live tests assert invariants rather than values — a test expecting a particular
aircraft over a particular city would fail by design. They share a single
lookup, because these feeds run on donated hardware.

---

## Notes from building this

A few things were only discoverable by looking at the result:

**Camera pitch is not what you would guess.** Cesium's `fov` is *horizontal*,
so a 16:9 canvas sees roughly 15° above the aim point, not 25°. From 20 km the
horizon sits only 4.5° below level. An apparently reasonable -38° pitch put the
horizon off the top of the screen, every pixel became ground, and the view read
as a flat map rather than flight.

**Mirror feeds must fail over on empty, not just on error.** These networks are
fed by volunteer receivers with different coverage. An aircraft absent from one
feed is often plainly visible in the other, so stopping at the first empty
answer reported flying aircraft as not found.

**Cesium's `widgets.css` is not optional**, even with every widget disabled.
Without it `.cesium-widget` has no height rule and the canvas silently stays at
the HTML default of 300×150.

**Hue shifts wrap.** Cesium's imagery `hue` is additive, so what matters is
where a shift lands. The Dream environment's first pass overshot violet into
magenta and turned the world hot pink under a yellow sky.

---

## Roadmap

Designed for, not yet built:

- **Real weather** — the cloud environment already reads deck altitude,
  thickness and coverage from constants a weather provider could supply
- Flight replay and historical tracks
- Saved flights, accounts, shareable pages
- Social video export (9:16, 16:9, 1:1)
- Airline-specific aircraft models
- Multiple live aircraft, air traffic mode

---

## Git workflow

Conventional commits, small and meaningful. Before committing, check
`git status` and `git diff` for secrets, `.env` files, credentials and large
files. `.env*` is gitignored except `.env.example`.

---

## Attribution and licensing

- Live positions: the [adsb.lol](https://adsb.lol) and [adsb.fi](https://adsb.fi)
  community networks
- Route data: [adsbdb](https://adsbdb.com)
- Satellite imagery: Esri, Maxar, Earthstar Geographics and the GIS User
  Community — or Cesium Ion when a token is configured
- Basemaps for the Map and Night environments: © OpenStreetMap contributors,
  © CARTO
- 3D engine: [CesiumJS](https://cesium.com/platform/cesiumjs/), Apache 2.0

The aircraft model is generated by `scripts/build-aircraft-model.mjs` and
carries no third-party licence.
