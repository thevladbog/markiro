import { DirectionalLight, Group, HemisphereLight, PointLight } from "three";

import type { LightingState } from "../lighting";
import type { PlantHandles } from "./plant";

export interface LightRig {
  readonly root: Group;
  apply(state: LightingState): void;
}

export function createLightRig(handles: PlantHandles, shadowMapSize: number): LightRig {
  const root = new Group();
  root.name = "lights";
  const sky = new HemisphereLight("#ffffff", "#cfcac0", 1.1);
  const sun = new DirectionalLight("#ffffff", 2.7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.025;
  sun.shadow.radius = 4;
  const shadowCamera = sun.shadow.camera;
  shadowCamera.left = -22;
  shadowCamera.right = 22;
  shadowCamera.top = 22;
  shadowCamera.bottom = -22;
  shadowCamera.near = 1;
  shadowCamera.far = 80;
  shadowCamera.updateProjectionMatrix();
  const fill = new DirectionalLight("#ffffff", 0.3);
  fill.position.set(11, 7, 12);
  root.add(sky, sun, sun.target, fill);
  // Point lights never cast shadows: one shadow map per lamp would cost more than the film.
  const lamps = handles.lampSpots.map(([x, y, z]) => {
    const lamp = new PointLight("#ffd7a3", 0, 7.5, 1.7);
    lamp.position.set(x, y - 0.15, z);
    root.add(lamp);
    return lamp;
  });
  const [sx, sy, sz] = handles.scanLamp;
  const scanGlow = new PointLight("#3ddc7a", 0, 2.6, 1.6);
  scanGlow.position.set(sx, sy, sz);
  const office = new PointLight("#ffd9a8", 0, 5, 1.6);
  office.position.set(6.2, 1.6, -1.2);
  root.add(scanGlow, office);
  return {
    root,
    apply(state) {
      sky.color.set(state.skyColor);
      sky.groundColor.set(state.groundColor);
      sky.intensity = state.skyIntensity;
      sun.color.set(state.sunColor);
      sun.intensity = state.sunIntensity;
      const [px, py, pz] = state.sunPosition;
      sun.position.set(px * 1.4, py * 1.4, pz * 1.4);
      fill.intensity = state.fillIntensity;
      for (const lamp of lamps) lamp.intensity = 7.5 * state.lamps;
      scanGlow.intensity = 1.6 * state.glow;
      office.intensity = 2.5 * state.lamps;
    },
  };
}
