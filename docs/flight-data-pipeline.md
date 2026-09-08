# Flight data pipeline — audit

Audit of the live-data path, 8 September 2026. Written before any fix, to
record how the system actually behaved rather than how it was meant to.

Two reported symptoms:

1. The 3D visualization is laggy on capable hardware.
2. Searching a real flight number opens a visualization showing the aircraft
   somewhere other than where the flight actually is.

Both were reproduced. Symptom 2 has a single dominant root cause.

---

## 1. The pipeline as built

```
user types "AC103"
      |
      v
GET /api/flights/search?q=AC103
      |
      +-- normalizeFlightIdentifier   reject anything not [A-Z0-9]{2,10}
      +-- callsignCandidates          AC103 -> [ACA103, AC103]  (IATA -> ICAO table)
      |
      +-- adsbdb  /v0/callsign/{c}    route + airline + canonical ICAO callsign
      |                               (cached 1h; schedule data, NOT an observation)
      |
      +-- position feed /v2/callsign/{c}   first feed that returns any aircraft
      |        adsb.lol, then adsb.fi
      |
      v
Flight { id: "adsb:<CALLSIGN>:<ICAO24>", callsign, flightNumber, origin, ... }
      |
      v
GET /api/flights/{id}/position    polled every ~8 s by the browser
      |
      +-- callsignFromId(id) -> re-query the feed BY CALLSIGN
      +-- pick aircraft matching the id's hex, else aircraft[0]
      |
      v
FlightPosition { lat, lon, altitude, heading, speed, verticalSpeed, timestamp }
      |
      v
FlightEngine.ingest()  -> samples[] (max 12) + rolling track
      |
      v
Cesium CallbackProperty -> engine.sample(now) -> interpolate / dead-reckon
      |
      v
Cartesian3.fromDegrees(longitude, latitude, feet * 0.3048)
```

## 2. APIs in use

### adsb.lol — `https://api.adsb.lol/v2`

| Property | Value |
| --- | --- |
| Provides | Live ADS-B state: lat, lon, `alt_baro`, `gs`, `track`, `true_heading`, `baro_rate`, `roll`, `seen_pos` |
| Aircraft identity | `hex` (ICAO 24-bit address) — the airframe |
| Commercial flight numbers | **No.** Only the transmitted callsign (`flight`) |
| Callsigns | Yes, `flight`, space-padded (`"EXS59N  "`) |
| ICAO24 | Yes, `hex` |
| Current lat/lon | Yes |
| Freshness | `seen_pos` = seconds since the fix. Typically < 1 s |
| Observed or derived | **Observed** (receiver-fed) |
| Envelope | `{ ac: [...], now: <ms>, total }` |

### adsb.fi — `https://opendata.adsb.fi/api/v2`

Same readsb schema, same fields, and — this is the point — the same envelope
as adsb.lol. The code assumed the two differed, and was wrong on both counts
(see §3.1):

| Property | adsb.lol (actual) | adsb.fi (actual) | adsb.fi (as coded) |
| --- | --- | --- | --- |
| Aircraft array key | `ac` | `ac` | `aircraft` ✗ |
| `now` units | milliseconds | milliseconds | seconds ✗ |

Both mistakes were invented differences. Had the adapter simply been shared,
neither could have occurred.

### adsbdb — `https://api.adsbdb.com/v0`

| Property | Value |
| --- | --- |
| Provides | Callsign → airline, origin/destination airports with coordinates |
| Aircraft identity | **None.** It knows nothing about airframes |
| Commercial flight numbers | Yes — `callsign_iata` (`LS59N`) and `callsign_icao` (`EXS59N`) |
| Current lat/lon | **No** |
| Observed or derived | **Neither** — it is schedule/reference data |

### Cesium Ion / Esri World Imagery

Imagery and terrain only. No flight data.

## 3. Findings

### 3.1 The adsb.fi fallback has never worked — ROOT CAUSE of the wrong position

`FEEDS[1].unwrap` reads `body.aircraft`, but adsb.fi returns `ac`. The unwrap
therefore always produced an empty list, and the mirror silently contributed
nothing. Measured directly:

```
top-level keys: [ 'ac', 'msg', 'now', 'total', 'ctime', 'ptime' ]
has .ac?       true  len 1
has .aircraft? false len undefined
```

The same adapter also treated `now` as seconds and multiplied by 1000. adsb.fi
reports milliseconds (`1788888548001`), so even with the key fixed every
timestamp would land in the year ~58000, be rejected by `sanitizeTimestamp`
as "in the future", and yield `position: null`.

Two independent bugs, either sufficient to disable the mirror.

### 3.2 adsb.lol rate-limits aggressively, so the dead mirror mattered

Twelve sequential requests, 400 ms apart, for a known-airborne aircraft:

```
adsb.lol /callsign  hit= 2/12  empty=10  status=200,429
adsb.lol /hex       hit= 0/12  empty=12  status=429
adsb.fi  /callsign  hit=12/12  empty= 0  status=200
adsb.fi  /hex       hit=12/12  empty= 0  status=200
```

adsb.lol returns 429 on a short sliding window. adsb.fi answered every time.
So the only working feed was the one the adapter had disabled.

### 3.3 The observed failure, end to end

Real flight, traced live (`LS59N` / `EXS59N`, Tenerife → Bristol):

```
GROUND TRUTH (adsb.lol /v2/hex/4070ed)
  lat 49.757767  lon -3.782188  alt 35000  seen_pos 0.112 s

APP  GET /api/flights/search?q=LS59N          -> 200, correct aircraft, id adsb:EXS59N:4070ed
APP  GET /api/flights/adsb:EXS59N:4070ed/position
                                              -> 200  { "position": null }

server log: [adsb] adsb.lol unavailable for EXS59N; trying next mirror
```

Search succeeded (adsb.lol had not yet throttled). The position poll hit the
429, fell through to adsb.fi, and the broken unwrap turned a good response
into "no aircraft".

**How that becomes a wrong position rather than an honest "unknown":** the
FlightEngine keeps the last observed sample when a poll returns null, and
`samplePositionAt` dead-reckons forward for up to 45 s before freezing. So the
aircraft holds at its last fix plus at most 45 s of projection while the real
flight keeps going. After a few minutes of failed polls the rendered aircraft
is tens of kilometres behind the real one. The engine is honest internally —
`freshness` degrades to `delayed`/`stale` — but the aircraft is still drawn,
and drawn in the wrong place.

### 3.4 Identity: flight number ≠ callsign ≠ airframe

The audit brief asked specifically about this. The code does distinguish them,
but incompletely:

- `flightNumber` (`LS59N`) is display-only, from adsbdb.
- `callsign` (`EXS59N`) is what the aircraft transmits.
- `icao24` (`4070ed`) is the airframe.

Two places where the distinction breaks down:

1. **`getLivePosition` substitutes a different airframe.** If the id carries a
   hex and no aircraft in the response matches it, `?? aircraft[0]` falls back
   to whatever else is transmitting that callsign. A callsign can legitimately
   be carried by two airframes near a rotation, so this can return a wholly
   different aircraft's position under the requested flight's identity.

2. **Route data is attached without verifying the callsign matches.** Search
   resolves a route for candidate *A*, then may find an aircraft under
   candidate *B*, and attaches *A*'s origin/destination to it.

3. **Polling is keyed on callsign, not airframe.** The stable identifier is
   known after search but is not what the position endpoint queries.

### 3.5 Performance

Measured in-page against the live scene (`scene.render()` driven directly;
the preview pane suspends `requestAnimationFrame`, so wall-clock FPS was not
measurable here — see Limitations).

Scene is small: **6 entities, 2 primitives, 1 imagery layer.** Entity count is
not the problem.

Per-frame cost of the JavaScript callbacks, 1280×720:

```
track.polyline.positions.getValue      0.0070 ms
route-completed positions.getValue     0.0070 ms
aircraft.position.getValue             0.0045 ms
aircraft.orientation.getValue          0.0120 ms
                              total    0.030  ms   (budget 16.67 ms)
```

So the callback JS is not the bottleneck at present. Structural issues remain
and matter more as a flight progresses:

- **The observed-track polyline rebuilds its entire point array every frame.**
  It allocates a fresh `Cartesian3` per point and returns a new array, so
  Cesium re-uploads the polyline geometry every frame. Cheap at the 7 points a
  new flight has; the retention cap is 900, and the cost scales linearly.
- **`engine.sample()` runs 5–6 times per frame** (position callback,
  orientation callback, two route callbacks, `onPreRender`, and cockpit
  camera), each redoing the same interpolation for the same instant.
- **Render settings are fixed regardless of device.** `highDynamicRange` and
  4× MSAA are always on. Toggling HDR off at 1280×720 moved a render from
  3.45 ms to 1.45 ms, i.e. HDR alone was ~2 ms of a frame at 0.92 MP. That
  cost scales with pixel count, so on a HiDPI or large display it is several
  times larger.
- **Five RSC fetches of `/flight/[id]` per single navigation**, caused by
  `router.replace()` in an effect syncing camera/environment to the URL. Each
  refetch re-runs `getFlightDetails` server-side — extra upstream calls that
  feed the rate limiting in §3.2.

## 4. Causes considered and ruled out

| Hypothesis | Verdict |
| --- | --- |
| Latitude/longitude swapped | **Ruled out.** `Cartesian3.fromDegrees(longitude, latitude, h)` is correct |
| Coordinate transform wrong | **Ruled out.** Demo flight tracks its great circle correctly |
| Airport coordinates used as aircraft position | **Ruled out.** Position comes only from feed `lat`/`lon` |
| Cached position served as current | **Ruled out.** Only route data is cached; `fetchJson` sends `cache: no-store` |
| Timezone / date mismatch | **Ruled out** for adsb.lol. **Confirmed** for adsb.fi (§3.1) |
| Historical track used instead of current state | **Ruled out.** Track is display-only |
| Incorrect interpolation | **Ruled out** as primary. Dead reckoning is capped at 45 s |
| Stale simulated coordinates leaking into live | **Ruled out.** Provider is chosen by id prefix; demo ids cannot reach a live provider |
| Wrong API endpoint | **Partly.** Endpoint is valid but callsign-keyed polling is the wrong choice (§3.4) |
| Incorrect flight-to-aircraft matching | **Confirmed as a latent risk** (§3.4), not the observed cause |
| Stale data presented as current | **Confirmed as the mechanism** (§3.3) |

## 5. Limitations of this audit

- Wall-clock FPS, CPU% and GPU% were not measurable: the preview pane throttles
  `requestAnimationFrame` while hidden and its compositor made direct
  `scene.render()` timings non-monotonic across resolutions. Numbers above are
  the ones that reproduced consistently. FPS on the user's own display remains
  unmeasured.
- The trace captured one flight in one region at one moment. The feed
  behaviour in §3.2 is a snapshot of that window, though the adapter bugs in
  §3.1 are unconditional and independent of load.

---

## 6. Outcome

### Fixes

| # | Change | Effect |
| --- | --- | --- |
| 1 | One shared feed unwrap that probes for `ac`/`aircraft` and detects the clock unit by magnitude | Revives the adsb.fi mirror, which had never returned an aircraft |
| 2 | Positions polled by `/hex/{icao24}`, accepting only that airframe | Identity pinned to the metal; no substitution possible |
| 3 | `?? aircraft[0]` removed from `getLivePosition` and `getFlightDetails` | A missing airframe now yields null, not another aircraft |
| 4 | Callsign-only lookups require an exact transmitted-callsign match | No loose matching when no airframe is pinned |
| 5 | adsbdb route attached only when its callsign matches the aircraft found | One flight's schedule cannot caption another's position |
| 6 | `history.replaceState` instead of `router.replace` for URL sync | 5 RSC page fetches per visit → 1 |
| 7 | One `engine.sample()` per frame instead of 5–6 | Same interpolation no longer recomputed per consumer |
| 8 | Track polyline cached against an engine track version | Polyline geometry no longer re-uploaded 60×/s |
| 9 | Adaptive quality governor (HDR → MSAA → resolution) | Quality reduced only on devices that miss the frame budget |
| 10 | Frame snapshot cleared in `postRender` | Off-frame property reads get a fresh sample, not a stale one |
| 11 | Freshness ladder gains `recent` and `derived`; `PositionConfidence` on every snapshot | A dead-reckoned position can no longer be labelled LIVE |

### Verification

End-to-end on real commercial flights, comparing the app against an
independent by-ICAO24 lookup of the same airframe:

```
Before   LS59N  / EXS59N / 4070ed   app: position: null      (aircraft visible upstream, fix 0.1s old)
After    BA830D / BAW830D / 4009c5  app vs independent: 0.33 km
After    TS123  / TSC123 / c06e45   app vs independent: 0.00 km   (live integration test)
After    TS123  3D scene vs app API: 0.26 km
```

Each residual is the distance the aircraft covered between the two
measurements, not error.

Request volume for one visit plus three control changes: **1** page fetch
(was 5 for a bare visit), position polling steady at ~8 s.

### Still open

- **Wall-clock FPS on the user's display is still unmeasured.** The preview
  pane suspends `requestAnimationFrame`, so the governor's real behaviour on
  the reporting machine is unverified. It logs its decisions to the console
  (`[flightscape] render quality -> …`) and `FlightScene.getQualityStats()`
  reports the measured median frame time; those are the numbers to read on the
  affected hardware.
- **adsb.lol rate limiting is worked around, not solved.** Two mirrors with
  failover is what keeps positions flowing; sustained throttling on both would
  still produce gaps, now surfaced honestly as ESTIMATED then DELAYED.
- **No schedule times.** adsbdb supplies routes, not timetables, so departure
  and arrival times remain null and arrival is derived geometrically from live
  ground speed.
- **Track history is per-session.** A page reload starts the observed track
  again from empty; nothing persists a flown path.
