import { PerspectiveCamera, Vector3 } from "three";

import settings from "../../../content/home-map.json";
import { CAMERA_KEYS } from "../camera-keys";
import { poseAt } from "../camera-path";
import { cameraTime } from "../timeline";
import { PLANT_SPOTS, type PlantSpotId } from "./plant";
import { FILM_CHAPTERS } from "./runtime";
import { aimCamera } from "./stage";

/** The still is rendered at this size (twice the pixels); the hero keeps its aspect ratio. */
export const HOME_MAP_FRAME = { width: 1440, height: 900 } as const;

export interface HomeMapPoint {
  readonly id: PlantSpotId;
  /** 0 at the left edge of the still, 1 at the right. */
  readonly x: number;
  /** 0 at the top edge of the still, 1 at the bottom. */
  readonly y: number;
}

/** Projects the plant's hotspot anchors with the camera that rendered the home map still. */
export function projectHomeMap(): HomeMapPoint[] {
  const camera = new PerspectiveCamera();
  const pose = poseAt(CAMERA_KEYS, cameraTime(settings.filmTime, FILM_CHAPTERS));
  aimCamera(camera, pose, HOME_MAP_FRAME.width, HOME_MAP_FRAME.height);
  camera.updateMatrixWorld(true);
  return PLANT_SPOTS.map(({ id, position }) => {
    const point = new Vector3(position[0], position[1], position[2]).project(camera);
    return { id, x: (point.x + 1) / 2, y: (1 - point.y) / 2 };
  });
}
