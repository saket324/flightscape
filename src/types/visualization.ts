/** Camera and visual-environment types for the 3D scene. */

export type CameraMode =
  | "global"
  | "regional"
  | "follow"
  | "cinematic"
  | "cockpit";

export type VisualEnvironmentId =
  | "realistic"
  | "map"
  | "night"
  | "space"
  | "clouds"
  | "dream";

export const CAMERA_MODES: ReadonlyArray<{
  id: CameraMode;
  label: string;
  description: string;
}> = [
  {
    id: "global",
    label: "Global",
    description: "The whole journey, origin to destination.",
  },
  {
    id: "regional",
    label: "Regional",
    description: "The aircraft with the geography around it.",
  },
  {
    id: "follow",
    label: "Follow",
    description: "Behind and above, the Earth moving beneath.",
  },
  {
    id: "cinematic",
    label: "Cinema",
    description: "An automated sequence of cinematic shots.",
  },
  {
    id: "cockpit",
    label: "Cockpit",
    description: "Looking forward from the flight deck.",
  },
];

export const VISUAL_ENVIRONMENTS: ReadonlyArray<{
  id: VisualEnvironmentId;
  label: string;
  description: string;
}> = [
  {
    id: "realistic",
    label: "Realistic",
    description: "Real terrain, real imagery, real sunlight.",
  },
  {
    id: "map",
    label: "Map",
    description: "A clean, stylised cartographic world.",
  },
  {
    id: "night",
    label: "Night",
    description: "Dark Earth, city lights, a glowing route.",
  },
  {
    id: "space",
    label: "Space",
    description: "Earth from far away, against the stars.",
  },
  {
    id: "clouds",
    label: "Clouds",
    description: "Flying through a layered cloudscape.",
  },
  {
    id: "dream",
    label: "Dream",
    description: "A surreal, saturated cinematic world.",
  },
];
