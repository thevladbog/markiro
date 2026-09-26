import {
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  type Object3D,
} from "three";

import { person } from "./figures";
import type { Kit } from "./kit";
import { buildPlant, type PlantHandles } from "./plant";
import { tree } from "./props";
import type { ScreenTextures } from "./textures";

export const DISTRICT = { width: 36, depth: 24 } as const;

export interface DistrictHandles extends PlantHandles {
  readonly contactShadow: MeshBasicMaterial;
}

const TREES: readonly (readonly [number, number, number])[] = [
  [-16.2, -10.2, 0.9],
  [-16.4, -2.2, 0.8],
  [-16.1, 4.2, 1.0],
  [-8.2, -10.6, 0.8],
  [-7.8, 4.0, 0.9],
  [-7.2, 8.6, 0.8],
  [-2.2, 8.8, 0.9],
  [2.6, 8.7, 0.8],
  [7.4, 8.9, 1.0],
  [15.9, 8.5, 0.9],
  [16.2, 1.8, 0.8],
  [16.3, -10.4, 0.9],
  [8.4, -10.6, 0.8],
  [0.4, -8.6, 0.9],
  [-3.4, -8.9, 0.8],
  [3.8, -9.2, 1.0],
];

function road(
  kit: Kit,
  parent: Object3D,
  from: readonly [number, number],
  to: readonly [number, number],
): void {
  const alongX = Math.abs(to[1] - from[1]) < 1e-6;
  const width = 1.8;
  const length = alongX ? Math.abs(to[0] - from[0]) : Math.abs(to[1] - from[1]);
  const x = (from[0] + to[0]) / 2;
  const z = (from[1] + to[1]) / 2;
  kit.block(
    parent,
    alongX ? length : width,
    0.015,
    alongX ? width : length,
    "road",
    x,
    0,
    z,
    0.006,
    {
      castShadow: false,
    },
  );
  if (!alongX) return;
  for (let dx = -length / 2 + 0.6; dx < length / 2 - 0.3; dx += 1.2) {
    kit.block(parent, 0.55, 0.008, 0.06, "marking", x + dx, 0.015, z, 0.003, { castShadow: false });
  }
}

function brewery(kit: Kit, parent: Object3D, x: number, z: number): void {
  const group = new Group();
  group.name = "brewery";
  group.position.set(x, 0, z);
  kit.block(group, 5.2, 0.05, 6.6, "yard", 0, 0, 0.6, 0.02, { castShadow: false });
  kit.block(group, 5, 2.6, 3.4, "wall", 0, 0.02, -1.2, 0.04);
  kit.block(group, 5.04, 0.04, 3.44, "cut", 0, 2.62, -1.2, 0.01, { castShadow: false });
  kit.block(group, 1.4, 1.5, 0.08, "graphite", 1.3, 0.02, 0.52, 0.01);
  const tank = new CylinderGeometry(0.72, 0.72, 2.8, 28);
  const top = new ConeGeometry(0.72, 0.55, 28);
  for (const tx of [-1.8, -0.6, 0.6, 1.8]) {
    kit.block(group, 1.1, 0.5, 1.1, "steel", tx, 0.02, 2.1, 0.05);
    kit.place(group, tank, kit.material("tank"), tx, 1.92, 2.1);
    kit.place(group, top, kit.material("tank"), tx, 3.595, 2.1);
  }
  kit.block(group, 4.2, 0.08, 0.08, "steel", 0, 3.0, 2.1, 0.01);
  parent.add(group);
}

function cosmetics(kit: Kit, parent: Object3D, x: number, z: number): void {
  const group = new Group();
  group.name = "cosmetics";
  group.position.set(x, 0, z);
  kit.block(group, 6.8, 0.05, 5.6, "yard", 0, 0, 0.4, 0.02, { castShadow: false });
  kit.block(group, 6.4, 1.8, 3.4, "wall", 0, 0.02, -0.6, 0.04);
  for (let bay = 0; bay < 4; bay += 1) {
    kit.block(group, 1.6, 0.05, 3.4, "roof", -2.4 + bay * 1.6, 2.1, -0.6, 0.01).rotation.z = 0.42;
    kit.block(group, 0.04, 0.62, 3.3, "glass", -1.65 + bay * 1.6, 1.82, -0.6, 0.005);
  }
  kit.block(group, 1.6, 0.9, 0.9, "card", 2.2, 0.02, 1.7, 0.03);
  kit.block(group, 1.2, 1.2, 0.08, "graphite", -1.6, 0.02, 1.12, 0.01);
  parent.add(group);
}

export function buildDistrict(
  kit: Kit,
  parent: Object3D,
  screens: ScreenTextures,
): DistrictHandles {
  const district = new Group();
  district.name = "district";
  parent.add(district);
  kit.block(district, DISTRICT.width, 0.5, DISTRICT.depth, "base", 0, -0.5, 0, 0.16);
  const contactShadow = new MeshBasicMaterial({
    color: "#000000",
    alphaMap: screens.contactShadow,
    transparent: true,
    opacity: 0.24,
    depthWrite: false,
  });
  const shadow = new Mesh(
    new PlaneGeometry(DISTRICT.width * 1.3, DISTRICT.depth * 1.55),
    contactShadow,
  );
  shadow.name = "contact-shadow";
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(0.7, -0.95, 0.6);
  district.add(shadow);

  kit.block(district, 4.6, 0.02, 9.2, "yard", 5.7, 0, 0, 0.01, { castShadow: false });
  for (const z of [0.35, 2.15]) {
    for (let x = 4.1; x < 7.6; x += 0.6) {
      kit.block(district, 0.34, 0.012, 0.05, "marking", x, 0.02, z, 0.004, { castShadow: false });
    }
  }
  road(kit, district, [-17, 6.4], [17, 6.4]);
  road(kit, district, [5.7, 4.6], [5.7, 6.4]);
  road(kit, district, [-12.5, -3.2], [-12.5, 6.4]);
  road(kit, district, [12.5, -3.4], [12.5, 6.4]);
  brewery(kit, district, -12.5, -6.2);
  cosmetics(kit, district, 12.5, -6.4);
  for (const [x, z, scale] of TREES) tree(kit, district, x, z, scale);
  person(kit, district, -10.4, 1.2, Math.PI / 2, "walk", 0);
  person(kit, district, 10.8, 0.4, -Math.PI / 2 + 0.3, "walk", 0);
  return { ...buildPlant(kit, district, screens), contactShadow };
}
