import { Box3, Group, Mesh, Vector3 } from "three";
import { describe, expect, it } from "vitest";

import { CAMERA_KEYS } from "../camera-keys";
import { poseAt } from "../camera-path";
import { cameraTime } from "../timeline";
import { buildDistrict } from "./district";
import { Kit } from "./kit";
import { FILM_CHAPTERS } from "./runtime";
import { blankTextureFactory, createScreenTextures } from "./textures";

/** The camera's near plane: anything closer than this is cut open on screen. */
const NEAR_PLANE = 0.5;

function isMesh(node: unknown): node is Mesh {
  return node instanceof Mesh;
}

describe("film camera clearance", () => {
  it("never flies closer to a model than the camera's near plane", () => {
    const root = new Group();
    buildDistrict(new Kit(), root, createScreenTextures(blankTextureFactory));
    root.updateMatrixWorld(true);
    const boxes: { name: string; box: Box3 }[] = [];
    root.traverse((node) => {
      if (isMesh(node) && node.name !== "contact-shadow") {
        boxes.push({ name: node.name, box: new Box3().setFromObject(node) });
      }
    });
    let closest = { distance: Number.POSITIVE_INFINITY, time: 0 };
    const eye = new Vector3();
    for (let step = 0; step <= FILM_CHAPTERS * 200; step += 1) {
      const time = step / 200;
      const { position } = poseAt(CAMERA_KEYS, cameraTime(time, FILM_CHAPTERS));
      eye.set(position[0], position[1], position[2]);
      for (const { box } of boxes) {
        const distance = box.distanceToPoint(eye);
        if (distance < closest.distance) closest = { distance, time };
      }
    }
    expect(
      closest.distance,
      `closest at film time ${closest.time.toFixed(3)}`,
    ).toBeGreaterThanOrEqual(NEAR_PLANE);
  });
});
