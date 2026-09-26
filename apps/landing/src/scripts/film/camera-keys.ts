import { orbitKey, type CameraKey, type Vec2, type Vec3 } from "./camera-path";

// On landscape screens the subject sits right of the chapter card; on
// portrait screens it sits above the bottom sheet. On the first phone screen
// the plant sits between the header and the headline. In the middle of a
// chapter the previous bottom sheet is still leaving the top of a phone
// screen, so the middle keys hold the subject lower there.
const HERO_TALL: Vec2 = [0, 0.57];
const OVERVIEW_WIDE: Vec2 = [0.28, 0];
const OVERVIEW_TALL: Vec2 = [0, 0.3];
const CLOSE_WIDE: Vec2 = [0.2, 0.04];
const CLOSE_TALL: Vec2 = [0, 0.22];
const PLANT_WIDE: Vec2 = [0.2, 0];
const PLANT_TALL: Vec2 = [0, 0.24];
const PACKING_TALL: Vec2 = [0, -0.06];
const HANDHELD_WIDE: Vec2 = [0.32, 0.06];
const HANDHELD_TALL: Vec2 = [0.06, 0];
const OFFLINE_WIDE: Vec2 = [0.2, 0.17];
const OFFLINE_TALL: Vec2 = [0, 0.14];
const KIOSK_WIDE: Vec2 = [0.2, 0.26];
const KIOSK_TALL: Vec2 = [0, 0.08];
const OFFICE_WIDE: Vec2 = [0.26, 0.06];
const OFFICE_TALL: Vec2 = [0, 0.4];
const FINAL_WIDE: Vec2 = [0.3, 0.1];
const FINAL_TALL: Vec2 = [0, 0.34];
const DISTRICT: Vec3 = [0, 0.5, -1];

/**
 * Two keys per chapter (arrival and the middle), then the final pull-out.
 * Inside the hall the camera flies above the trusses and the pendant lamps.
 * The line is seen along the belt so the scanner reads as an arch, packing
 * from outside the right wall so the worker does not hide the case, and the
 * warehouse worker in profile so the handheld reads against the pallet.
 * Each target is the middle of what the chapter shows: the lens shift places
 * it and the tilt-shift keeps it sharp.
 */
export const CAMERA_KEYS: readonly CameraKey[] = [
  orbitKey(0, DISTRICT, -38, 34, 96, 20, OVERVIEW_WIDE, HERO_TALL),
  orbitKey(0.5, DISTRICT, -35, 32, 76, 20, OVERVIEW_WIDE, OVERVIEW_TALL),
  orbitKey(1, [-1.8, 0.8, -1.0], -45, 42, 14, 30, CLOSE_WIDE, CLOSE_TALL),
  orbitKey(1.5, [-2.0, 0.95, -1.0], -60, 26, 5, 38, CLOSE_WIDE, CLOSE_TALL),
  orbitKey(2, [0.8, 0.9, -1.0], 10, 55, 8, 38, CLOSE_WIDE, CLOSE_TALL),
  orbitKey(2.5, [1.8, 1.0, -1.15], 62, 45, 4.5, 36, CLOSE_WIDE, PACKING_TALL),
  orbitKey(3, [1.2, 1.0, 0.6], -40, 66, 7.5, 38, CLOSE_WIDE, CLOSE_TALL),
  orbitKey(3.5, [2.2, 1.0, 1.55], -85, 38, 4.6, 38, HANDHELD_WIDE, HANDHELD_TALL),
  orbitKey(4, [0.5, 0.8, -0.5], -42, 40, 34, 22, PLANT_WIDE, PLANT_TALL),
  orbitKey(4.5, [1.8, 3.23, -2.2], -32, 30, 30.4, 22, OFFLINE_WIDE, OFFLINE_TALL),
  orbitKey(5, [-2.5, 1.5, 1.0], -25, 30, 12, 30, CLOSE_WIDE, CLOSE_TALL),
  orbitKey(5.5, [-4.65, 1.35, 3.2], -18, 12, 4.13, 36, KIOSK_WIDE, KIOSK_TALL),
  orbitKey(6, [2.5, 1.2, -1.0], -5, 30, 14, 30, CLOSE_WIDE, CLOSE_TALL),
  orbitKey(6.5, [6.2, 1.3, -2.6], 10, 25, 16, 30, OFFICE_WIDE, OFFICE_TALL),
  orbitKey(7, DISTRICT, -40, 36, 92, 20, FINAL_WIDE, FINAL_TALL),
];
