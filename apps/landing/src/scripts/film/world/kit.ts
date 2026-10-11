import {
  Color,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type BufferGeometry,
  type Material,
  type Object3D,
} from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

import { mixHex } from "../color";

export const ROLES = [
  "base",
  "yard",
  "road",
  "marking",
  "floor",
  "wall",
  "cut",
  "column",
  "steel",
  "graphite",
  "belt",
  "plaster",
  "bottle",
  "card",
  "cardDark",
  "tape",
  "pallet",
  "tree",
  "trunk",
  "coat",
  "trousers",
  "skin",
  "cap",
  "shoe",
  "glass",
  "tank",
  "roof",
  "codeIdle",
] as const;

export type Role = (typeof ROLES)[number];

// Day colours follow packages/ui/src/tokens.css and the prototype scene.
export const DAY_PALETTE: Readonly<Record<Role, string>> = {
  base: "#ebe9e2",
  yard: "#e2dfd6",
  road: "#dcd8ce",
  marking: "#f6f5f1",
  floor: "#f2f0eb",
  wall: "#fbfaf7",
  cut: "#17161a",
  column: "#f6f4ef",
  steel: "#c9c6bd",
  graphite: "#2a292e",
  belt: "#3a393f",
  plaster: "#f7f5f0",
  bottle: "#ffffff",
  card: "#e6e1d6",
  cardDark: "#d8d2c5",
  tape: "#cbc4b6",
  pallet: "#d6d0c4",
  tree: "#f4f2ec",
  trunk: "#bdb9af",
  coat: "#f7f5f0",
  trousers: "#8e8b83",
  skin: "#e4dfd5",
  cap: "#ffffff",
  shoe: "#3a393f",
  glass: "#a9a59c",
  tank: "#eeece6",
  roof: "#e9e6df",
  codeIdle: "#8e8b83",
};

export const NIGHT_PALETTE: Readonly<Record<Role, string>> = {
  base: "#1e1d22",
  yard: "#1a191e",
  road: "#232228",
  marking: "#34333a",
  floor: "#29282e",
  wall: "#302f36",
  cut: "#8e8b83",
  column: "#36353c",
  steel: "#4a4950",
  graphite: "#0f0e12",
  belt: "#17161b",
  plaster: "#3c3b42",
  bottle: "#8e8b83",
  card: "#57534b",
  cardDark: "#4a463f",
  tape: "#645f56",
  pallet: "#46423c",
  tree: "#2b2a31",
  trunk: "#3a3940",
  coat: "#d8d5cd",
  trousers: "#5b5952",
  skin: "#bdb9af",
  cap: "#edebe6",
  shoe: "#1c1b21",
  glass: "#2e2d34",
  tank: "#34333a",
  roof: "#2a2930",
  codeIdle: "#5b5952",
};

export interface PlaceOptions {
  readonly castShadow?: boolean;
  readonly receiveShadow?: boolean;
  readonly rotationY?: number;
}

/** Unlit status colours. Only the meshes named in the plan may use them. */
export class Signals {
  readonly verified = new MeshBasicMaterial({ color: "#3ddc7a" });
  readonly rejected = new MeshBasicMaterial({ color: "#c0392b" });
  readonly offline = new MeshBasicMaterial({ color: "#dd9420" });
  readonly lamp = new MeshBasicMaterial({ color: "#ffe6bf" });
  private readonly base = {
    verified: new Color("#3ddc7a"),
    rejected: new Color("#c0392b"),
    offline: new Color("#dd9420"),
    lamp: new Color("#ffe6bf"),
  };

  /** Pushes the signals above 1 after dusk so the bloom pass picks them up. */
  setGlow(glow: number, lamps: number): void {
    this.verified.color.copy(this.base.verified).multiplyScalar(1 + 0.8 * glow);
    this.rejected.color.copy(this.base.rejected).multiplyScalar(1 + 0.6 * glow);
    this.offline.color.copy(this.base.offline).multiplyScalar(1 + 0.8 * glow);
    this.lamp.color.copy(this.base.lamp).multiplyScalar(1 + 2 * lamps);
  }
}

export class Kit {
  readonly signals = new Signals();
  private readonly materials = new Map<Role, MeshStandardMaterial>();
  private readonly flatMaterials = new Map<Role, MeshStandardMaterial>();
  private readonly boxes = new Map<string, RoundedBoxGeometry>();
  private nightMix = 0;

  /** The shared matte material of a palette role. */
  material(role: Role): MeshStandardMaterial {
    return this.cached(this.materials, role, false);
  }

  /** The same colour with flat shading, for faceted shapes such as tree crowns. */
  flat(role: Role): MeshStandardMaterial {
    return this.cached(this.flatMaterials, role, true);
  }

  private cached(
    cache: Map<Role, MeshStandardMaterial>,
    role: Role,
    flatShading: boolean,
  ): MeshStandardMaterial {
    let material = cache.get(role);
    if (material === undefined) {
      material = new MeshStandardMaterial({
        color: this.colorOf(role),
        roughness: 0.9,
        metalness: 0,
        flatShading,
      });
      material.name = role;
      cache.set(role, material);
    }
    return material;
  }

  colorOf(role: Role): string {
    return mixHex(DAY_PALETTE[role], NIGHT_PALETTE[role], this.nightMix);
  }

  setNightMix(mix: number): void {
    if (mix === this.nightMix) return;
    this.nightMix = mix;
    for (const [role, material] of this.materials) material.color.set(this.colorOf(role));
    for (const [role, material] of this.flatMaterials) material.color.set(this.colorOf(role));
  }

  box(width: number, height: number, depth: number, radius = 0.03): RoundedBoxGeometry {
    const r = Math.max(
      0.0005,
      Math.min(radius, width / 2 - 1e-4, height / 2 - 1e-4, depth / 2 - 1e-4),
    );
    const key = `${width}|${height}|${depth}|${r}`;
    let geometry = this.boxes.get(key);
    if (geometry === undefined) {
      geometry = new RoundedBoxGeometry(width, height, depth, 2, r);
      this.boxes.set(key, geometry);
    }
    return geometry;
  }

  place(
    parent: Object3D,
    geometry: BufferGeometry,
    material: Material,
    x: number,
    y: number,
    z: number,
    options: PlaceOptions = {},
  ): Mesh {
    const mesh = new Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.rotation.y = options.rotationY ?? 0;
    mesh.castShadow = options.castShadow ?? true;
    mesh.receiveShadow = options.receiveShadow ?? true;
    parent.add(mesh);
    return mesh;
  }

  /** A rounded box standing on `y`, centred on `x` and `z`. */
  block(
    parent: Object3D,
    width: number,
    height: number,
    depth: number,
    material: Role | Material,
    x: number,
    y: number,
    z: number,
    radius = 0.03,
    options: PlaceOptions = {},
  ): Mesh {
    const resolved = typeof material === "string" ? this.material(material) : material;
    return this.place(
      parent,
      this.box(width, height, depth, radius),
      resolved,
      x,
      y + height / 2,
      z,
      options,
    );
  }
}
