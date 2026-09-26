import { orbitKey, type CameraKey, type Vec2, type Vec3 } from "./camera-path";

// On landscape screens the subject sits right of the chapter card; on
// portrait screens it sits above the bottom sheet.
const OVERVIEW_WIDE: Vec2 = [0.28, 0];
const OVERVIEW_TALL: Vec2 = [0, 0.3];
const CLOSE_WIDE: Vec2 = [0.12, 0];
const CLOSE_TALL: Vec2 = [0, 0.22];
const PLANT_WIDE: Vec2 = [0.2, 0];
const PLANT_TALL: Vec2 = [0, 0.26];
const DISTRICT: Vec3 = [0, 0.5, -1];

/** Two keys per chapter (arrival and the middle), then the final pull-out. */
export const CAMERA_KEYS: readonly CameraKey[] = [
  orbitKey(0, DISTRICT, -38, 34, 88, 20, OVERVIEW_WIDE, OVERVIEW_TALL),
  orbitKey(0.5, DISTRICT, -35, 32, 76, 20, OVERVIEW_WIDE, OVERVIEW_TALL),
  orbitKey(1, [-1.5, 0.8, -1.1], -32, 38, 16, 30, CLOSE_WIDE, CLOSE_TALL),
  orbitKey(1.5, [-0.6, 0.9, -1.1], -30, 20, 4.6, 40, CLOSE_WIDE, CLOSE_TALL),
  orbitKey(2, [0.6, 0.95, -1.05], -26, 18, 4.2, 40, CLOSE_WIDE, CLOSE_TALL),
  orbitKey(2.5, [1.6, 0.98, -1.0], -18, 17, 3.5, 34, CLOSE_WIDE, CLOSE_TALL),
  orbitKey(3, [2.6, 0.9, 0.8], -45, 30, 7.5, 34, CLOSE_WIDE, CLOSE_TALL),
  orbitKey(3.5, [2.75, 0.95, 1.05], -58, 19, 4.4, 38, CLOSE_WIDE, CLOSE_TALL),
  orbitKey(4, [0.5, 0.8, -0.5], -42, 40, 34, 22, PLANT_WIDE, PLANT_TALL),
  orbitKey(4.5, [0.8, 1.0, -0.8], -36, 30, 26, 22, PLANT_WIDE, PLANT_TALL),
  orbitKey(5, [-4.6, 1.0, 3.2], -20, 28, 9, 34, CLOSE_WIDE, CLOSE_TALL),
  orbitKey(5.5, [-4.65, 1.05, 3.2], -18, 16, 4.2, 36, CLOSE_WIDE, CLOSE_TALL),
  orbitKey(6, [6.0, 1.3, -2.5], -24, 26, 13, 30, CLOSE_WIDE, CLOSE_TALL),
  orbitKey(6.5, [6.0, 1.25, -2.5], -24, 20, 9.5, 30, CLOSE_WIDE, CLOSE_TALL),
  orbitKey(7, DISTRICT, -40, 36, 80, 20, PLANT_WIDE, OVERVIEW_TALL),
];
