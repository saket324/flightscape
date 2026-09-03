/**
 * Camera modes.
 *
 * Every mode is a pure function of the aircraft's real state: given where the
 * aircraft actually is and which way it is actually pointing, each returns a
 * desired camera framing. The camera moves; the aircraft never does. Cinematic
 * shots change the framing over time and nothing else.
 *
 * Framings are expressed as heading/pitch/range about the aircraft, which is
 * Cesium's `lookAt` model, and are damped toward rather than snapped to, so
 * switching modes glides instead of cutting.
 */
import type { CameraMode } from "@/types/visualization";
import { angularDifference, normalizeBearing } from "@/lib/geography/constants";

export type CameraFraming = {
  /** Degrees, relative to the aircraft's own heading. 0 is directly behind. */
  headingOffset: number;
  /** Degrees below horizontal. Negative looks down. */
  pitch: number;
  /** Metres from the aircraft. */
  range: number;
};

/**
 * HORIZON
 *
 * Pitch values here are shallower than they first look like they should be,
 * because Cesium's `fov` is the *horizontal* field of view. On a 16:9 canvas a
 * 50 degree horizontal FOV is only about 29 degrees vertical, so the camera
 * sees roughly 15 degrees above its aim point, not 25.
 *
 * From 20 km up the horizon sits only ~4.5 degrees below level. Aiming at -26
 * therefore puts the horizon a full 7 degrees off the top of the screen and
 * every pixel is ground -- which reads as a flat map, not as flight. Keeping
 * pitch above about -19 at these ranges keeps sky in the frame, and with it
 * the sense of altitude the whole product depends on.
 */

export type AircraftState = {
  latitude: number;
  longitude: number;
  altitudeFeet: number;
  headingDegrees: number;
  speedKnots: number;
};

/**
 * A cinematic shot.
 *
 * `at` is seconds into the sequence. The controller interpolates between
 * consecutive shots, so the list reads as a storyboard.
 */
type CinematicShot = CameraFraming & { at: number };

/**
 * The cinematic sequence, roughly a minute long, then looping.
 *
 * Ordered to breathe: a close chase, a slow orbit revealing the terrain
 * either side, a high wide shot showing where the flight sits on the Earth,
 * then back in. All while the aircraft continues along its real track.
 */
const CINEMATIC_SEQUENCE: readonly CinematicShot[] = [
  { at: 0, headingOffset: 0, pitch: -10, range: 900 },
  { at: 9, headingOffset: 35, pitch: -14, range: 1_800 },
  { at: 19, headingOffset: 120, pitch: -20, range: 4_500 },
  // The one deliberately steep shot: looking down on the aircraft against the
  // country it is crossing. Everything either side of it keeps sky in frame.
  { at: 29, headingOffset: 210, pitch: -42, range: 12_000 },
  { at: 39, headingOffset: 300, pitch: -14, range: 30_000 },
  { at: 50, headingOffset: 350, pitch: -12, range: 6_000 },
  { at: 60, headingOffset: 0, pitch: -10, range: 900 },
];

const CINEMATIC_PERIOD =
  CINEMATIC_SEQUENCE[CINEMATIC_SEQUENCE.length - 1].at;

/** Smoothstep, so shots ease in and out rather than moving linearly. */
function smoothstep(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return clamped * clamped * (3 - 2 * clamped);
}

/** The cinematic framing at a given point in the sequence. */
export function cinematicFramingAt(elapsedSeconds: number): CameraFraming {
  const t = ((elapsedSeconds % CINEMATIC_PERIOD) + CINEMATIC_PERIOD) %
    CINEMATIC_PERIOD;

  for (let i = 0; i < CINEMATIC_SEQUENCE.length - 1; i += 1) {
    const from = CINEMATIC_SEQUENCE[i];
    const to = CINEMATIC_SEQUENCE[i + 1];
    if (t < from.at || t > to.at) continue;

    const span = to.at - from.at;
    const progress = smoothstep(span <= 0 ? 1 : (t - from.at) / span);

    return {
      headingOffset:
        from.headingOffset +
        angularDifference(from.headingOffset, to.headingOffset) * progress,
      pitch: from.pitch + (to.pitch - from.pitch) * progress,
      // Range is interpolated geometrically: going from 900 m to 30 km looks
      // like a steady pull-back only if each step is a constant ratio.
      range: from.range * (to.range / from.range) ** progress,
    };
  }

  return CINEMATIC_SEQUENCE[0];
}

/**
 * The framing a mode wants, given the aircraft's current state.
 *
 * Returns null for modes the controller handles specially: `global` frames the
 * whole route rather than the aircraft, and `cockpit` places the camera at the
 * aircraft instead of orbiting it.
 */
export function framingFor(
  mode: CameraMode,
  aircraft: AircraftState,
  elapsedSeconds: number,
): CameraFraming | null {
  switch (mode) {
    case "follow":
      // Close behind and slightly above: the Earth moves beneath you.
      return { headingOffset: 0, pitch: -11, range: followRange(aircraft) };

    case "regional":
      // Far enough back that the geography around the aircraft is legible,
      // shallow enough that the horizon stays in frame -- see HORIZON note.
      return { headingOffset: 0, pitch: -15, range: regionalRange(aircraft) };

    case "cinematic":
      return cinematicFramingAt(elapsedSeconds);

    case "global":
    case "cockpit":
      return null;
  }
}

/**
 * Chase distance, scaled to altitude.
 *
 * A fixed distance that frames a cruising airliner nicely would put the camera
 * underground on approach, so it tightens as the aircraft descends.
 */
function followRange(aircraft: AircraftState): number {
  const altitudeMeters = aircraft.altitudeFeet * 0.3048;
  return Math.max(320, Math.min(2_600, 320 + altitudeMeters * 0.06));
}

/**
 * Regional distance.
 *
 * Tuned against the horizon rather than by eye. At cruise this lands near
 * 20 km: far enough that a few hundred kilometres of country is in frame,
 * close enough that the aircraft is still a recognisable object and the
 * curvature of the Earth sits across the top of the screen. Earlier values
 * around 80 km put the horizon off-screen entirely and the result read as a
 * flat map rather than a view from altitude.
 */
function regionalRange(aircraft: AircraftState): number {
  const altitudeMeters = aircraft.altitudeFeet * 0.3048;
  return Math.max(9_000, Math.min(60_000, 9_000 + altitudeMeters * 1.1));
}

/**
 * Damping toward a target framing.
 *
 * Frame-rate independent: the same visual smoothing whether the browser is
 * running at 30fps or 144. `responsiveness` is roughly "fraction of the gap
 * closed per second".
 */
export function dampFraming(
  current: CameraFraming,
  target: CameraFraming,
  deltaSeconds: number,
  responsiveness = 2.4,
): CameraFraming {
  const t = 1 - Math.exp(-responsiveness * Math.max(0, deltaSeconds));

  return {
    headingOffset: normalizeBearing(
      current.headingOffset +
        angularDifference(current.headingOffset, target.headingOffset) * t,
    ),
    pitch: current.pitch + (target.pitch - current.pitch) * t,
    // Geometric again, so a large range change feels like a steady zoom.
    range: current.range * (target.range / current.range) ** t,
  };
}

/** Whether a mode keeps the camera locked to the aircraft. */
export function isTrackingMode(mode: CameraMode): boolean {
  return mode !== "global";
}
