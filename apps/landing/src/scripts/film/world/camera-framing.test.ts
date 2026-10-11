import { Box3, Group, PerspectiveCamera, Vector3 } from "three";
import { describe, expect, it } from "vitest";

import { CAMERA_KEYS } from "../camera-keys";
import { poseAt } from "../camera-path";
import { cameraTime } from "../timeline";
import { buildDistrict } from "./district";
import { Kit } from "./kit";
import { FILM_CHAPTERS } from "./runtime";
import { aimCamera } from "./stage";
import { blankTextureFactory, createScreenTextures } from "./textures";

// Measured in the browser on a 390×844 phone at the warehouse close-up (film time 3.5): the
// packing sheet leaving at the top ends at 33% of the screen height and the warehouse card
// starts at 69%. The scene shows between them.
const PHONE = { width: 390, height: 844 } as const;
const OPEN_FROM = 0.33;
const OPEN_TO = 0.69;

/** Where the corners of a box land on screen, from the top, as a fraction of its height. */
function screenRows(box: Box3, camera: PerspectiveCamera): number[] {
  const rows: number[] = [];
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) {
        rows.push((1 - new Vector3(x, y, z).project(camera).y) / 2);
      }
    }
  }
  return rows;
}

describe("film camera framing on phones", () => {
  it("shows the handheld and the pallet label between the sheets at the warehouse close-up", () => {
    const root = new Group();
    const handles = buildDistrict(new Kit(), root, createScreenTextures(blankTextureFactory));
    root.updateMatrixWorld(true);
    const device = root.getObjectByName("handheld-screen")?.parent ?? null;
    expect(device).not.toBeNull();
    if (device === null) return;
    const camera = new PerspectiveCamera();
    const pose = poseAt(CAMERA_KEYS, cameraTime(3.5, FILM_CHAPTERS));
    aimCamera(camera, pose, PHONE.width, PHONE.height);
    camera.updateMatrixWorld(true);
    const handheld = screenRows(new Box3().setFromObject(device), camera);
    const label = screenRows(new Box3().setFromObject(handles.palletLabel), camera);
    expect(Math.min(...handheld), "top of the handheld").toBeGreaterThan(OPEN_FROM);
    expect(Math.max(...label), "bottom of the pallet label").toBeLessThan(OPEN_TO);
  });
});
