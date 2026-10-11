import { describe, expect, it } from "vitest";

import { CAMERA_KEYS } from "./camera-keys";
import { orbitKey, poseAt, type CameraKey } from "./camera-path";
import { cameraTime } from "./timeline";

const keys: CameraKey[] = [
  orbitKey(0, [0, 0, 0], 0, 30, 10, 20, [0.2, 0], [0, 0.2]),
  orbitKey(0.5, [1, 0, 0], 20, 20, 6, 30, [0.1, 0], [0, 0.1]),
  orbitKey(1, [2, 0, 1], 40, 10, 4, 40, [0, 0], [0, 0]),
];

const distance = (a: readonly number[], b: readonly number[]) =>
  Math.hypot(...a.map((value, index) => value - (b[index] ?? 0)));

describe("film camera path", () => {
  it("places an orbit key at the requested distance", () => {
    const key = orbitKey(0, [1, 2, 3], -38, 34, 12, 20, [0, 0], [0, 0]);
    expect(distance(key.position, key.target)).toBeCloseTo(12);
  });

  it("passes exactly through every key", () => {
    for (const key of keys) {
      const pose = poseAt(keys, key.at);
      expect(pose.position[0]).toBeCloseTo(key.position[0]);
      expect(pose.target[2]).toBeCloseTo(key.target[2]);
      expect(pose.fov).toBeCloseTo(key.fov);
    }
  });

  it("stays continuous across keys", () => {
    const before = poseAt(keys, 0.5 - 1e-6);
    const after = poseAt(keys, 0.5 + 1e-6);
    expect(distance(before.position, after.position)).toBeLessThan(1e-3);
  });

  it("interpolates field of view and lens shift linearly", () => {
    const middle = poseAt(keys, 0.25);
    expect(middle.fov).toBeCloseTo(25);
    expect(middle.shiftWide[0]).toBeCloseTo(0.15);
  });

  it("clamps outside the path", () => {
    expect(poseAt(keys, -1).fov).toBe(20);
    expect(poseAt(keys, 9).fov).toBe(40);
  });

  it("gives the film two keys per chapter and a final pull-out", () => {
    expect(CAMERA_KEYS).toHaveLength(15);
    CAMERA_KEYS.forEach((key, index) => {
      expect(key.at).toBeCloseTo(index * 0.5);
      expect(key.fov).toBeGreaterThanOrEqual(15);
      expect(key.fov).toBeLessThanOrEqual(45);
      expect(key.position[1]).toBeGreaterThan(key.target[1]);
    });
  });

  it("does not jump at chapter joins", () => {
    for (let chapter = 1; chapter < 7; chapter += 1) {
      const before = poseAt(CAMERA_KEYS, cameraTime(chapter - 1e-7, 7));
      const after = poseAt(CAMERA_KEYS, cameraTime(chapter + 1e-7, 7));
      expect(distance(before.position, after.position), `chapter ${chapter}`).toBeLessThan(1e-3);
      expect(distance(before.target, after.target), `chapter ${chapter}`).toBeLessThan(1e-3);
    }
  });
});
