import {
  CircleGeometry,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  LatheGeometry,
  PlaneGeometry,
  Vector2,
  type Material,
  type Mesh,
  type Object3D,
} from "three";

import type { ProductKind } from "../animations";
import type { Kit } from "./kit";

export interface Product {
  readonly group: Group;
  readonly code: Mesh;
}

const BOTTLE_PROFILE: readonly (readonly [number, number])[] = [
  [0, 0],
  [0.085, 0],
  [0.1, 0.025],
  [0.1, 0.3],
  [0.088, 0.345],
  [0.05, 0.4],
  [0.042, 0.44],
  [0.042, 0.5],
  [0, 0.5],
];

const shapes = {
  bottle: new LatheGeometry(
    BOTTLE_PROFILE.map(([r, y]) => new Vector2(r, y)),
    28,
  ),
  bottleCap: new CylinderGeometry(0.047, 0.047, 0.05, 18),
  jar: new CylinderGeometry(0.11, 0.11, 0.2, 28),
  jarLid: new CylinderGeometry(0.116, 0.116, 0.05, 28),
  can: new CylinderGeometry(0.075, 0.075, 0.3, 24),
  canRim: new CylinderGeometry(0.068, 0.075, 0.02, 24),
  codeBottle: new PlaneGeometry(0.08, 0.08),
  codeJar: new PlaneGeometry(0.07, 0.07),
  codeCan: new PlaneGeometry(0.06, 0.06),
  caseLabel: new PlaneGeometry(0.24, 0.165),
  palletLabel: new PlaneGeometry(0.34, 0.24),
  wheel: new CylinderGeometry(0.24, 0.24, 0.16, 20),
  headlight: new PlaneGeometry(0.16, 0.1),
  crown: new IcosahedronGeometry(0.46, 1),
  trunk: new CylinderGeometry(0.035, 0.045, 0.62, 8),
  shade: new CylinderGeometry(0.08, 0.26, 0.16, 20),
  disc: new CircleGeometry(0.23, 20),
};

export function createProduct(kit: Kit, kind: ProductKind): Product {
  const group = new Group();
  group.name = `product-${kind}`;
  let code: Mesh;
  if (kind === "bottle") {
    kit.place(group, shapes.bottle, kit.material("bottle"), 0, 0, 0);
    kit.place(group, shapes.bottleCap, kit.material("graphite"), 0, 0.52, 0);
    code = kit.place(group, shapes.codeBottle, kit.material("codeIdle"), 0, 0.19, 0.102, {
      castShadow: false,
    });
  } else if (kind === "jar") {
    kit.place(group, shapes.jar, kit.material("bottle"), 0, 0.1, 0);
    kit.place(group, shapes.jarLid, kit.material("graphite"), 0, 0.225, 0);
    code = kit.place(group, shapes.codeJar, kit.material("codeIdle"), 0, 0.1, 0.112, {
      castShadow: false,
    });
  } else {
    kit.place(group, shapes.can, kit.material("tank"), 0, 0.15, 0);
    kit.place(group, shapes.canRim, kit.material("steel"), 0, 0.305, 0);
    code = kit.place(group, shapes.codeCan, kit.material("codeIdle"), 0, 0.15, 0.077, {
      castShadow: false,
    });
  }
  code.name = "code";
  return { group, code };
}

export function openCase(
  kit: Kit,
  parent: Object3D,
  x: number,
  y: number,
  z: number,
  capacity: number,
): { readonly group: Group; readonly products: readonly Object3D[] } {
  const group = new Group();
  group.name = "open-case";
  group.position.set(x, y, z);
  const width = 0.62;
  const depth = 0.44;
  const height = 0.34;
  const t = 0.018;
  kit.block(group, width, t, depth, "card", 0, 0, 0, 0.004);
  for (const side of [-1, 1]) {
    kit.block(group, width, height, t, "card", 0, 0, side * (depth / 2 - t / 2), 0.004);
    kit.block(group, t, height, depth, "card", side * (width / 2 - t / 2), 0, 0, 0.004);
  }
  const flap = (
    flapWidth: number,
    flapDepth: number,
    px: number,
    pz: number,
    axis: "x" | "z",
    angle: number,
    cx: number,
    cz: number,
  ): void => {
    const pivot = new Group();
    pivot.position.set(px, height, pz);
    pivot.rotation[axis] = angle;
    kit.block(pivot, flapWidth, t, flapDepth, "cardDark", cx, -t / 2, cz, 0.004);
    group.add(pivot);
  };
  flap(width, depth * 0.48, 0, -depth / 2, "x", 0.62, 0, -depth * 0.24);
  flap(width, depth * 0.48, 0, depth / 2, "x", -0.62, 0, depth * 0.24);
  flap(width * 0.48, depth, -width / 2, 0, "z", -0.62, -width * 0.24, 0);
  flap(width * 0.48, depth, width / 2, 0, "z", 0.62, width * 0.24, 0);
  const products: Object3D[] = [];
  for (let slot = 0; slot < capacity; slot += 1) {
    const product = createProduct(kit, "bottle");
    product.group.position.set(((slot % 3) - 1) * 0.2, t, (Math.floor(slot / 3) - 0.5) * 0.2);
    product.code.material = kit.signals.verified;
    group.add(product.group);
    products.push(product.group);
  }
  parent.add(group);
  return { group, products };
}

export function closedCase(
  kit: Kit,
  parent: Object3D,
  x: number,
  y: number,
  z: number,
  rotationY: number,
  label: Material,
): Group {
  const group = new Group();
  group.name = "closed-case";
  group.position.set(x, y, z);
  group.rotation.y = rotationY;
  kit.block(group, 0.62, 0.5, 0.44, "card", 0, 0, 0, 0.014);
  kit.block(group, 0.63, 0.012, 0.09, "tape", 0, 0.495, 0, 0.004, { castShadow: false });
  // SSCC transport labels on two adjacent sides, as on shipped cases: the front
  // (+z) and the left (-x), so one of them faces whoever scans the case.
  kit.place(group, shapes.caseLabel, label, 0.12, 0.32, 0.2215, { castShadow: false }).name =
    "label";
  kit.place(group, shapes.caseLabel, label, -0.3115, 0.32, 0.06, {
    castShadow: false,
    rotationY: -Math.PI / 2,
  }).name = "label";
  parent.add(group);
  return group;
}

export function pallet(
  kit: Kit,
  parent: Object3D,
  x: number,
  y: number,
  z: number,
  capacity: number,
  label: Material,
): { readonly group: Group; readonly cases: readonly Group[] } {
  const group = new Group();
  group.name = "pallet";
  group.position.set(x, y, z);
  for (const side of [-1, 0, 1]) {
    kit.block(group, 1.28, 0.1, 0.12, "pallet", 0, 0, side * 0.4, 0.01);
  }
  for (let board = 0; board < 7; board += 1) {
    kit.block(group, 0.13, 0.035, 0.94, "pallet", -0.57 + board * 0.19, 0.1, 0, 0.008);
  }
  const cases: Group[] = [];
  for (let slot = 0; slot < capacity; slot += 1) {
    const layer = Math.floor(slot / 4);
    const place = slot % 4;
    cases.push(
      closedCase(
        kit,
        group,
        place % 2 === 0 ? -0.32 : 0.32,
        0.135 + layer * 0.505,
        place < 2 ? 0.225 : -0.225,
        0,
        label,
      ),
    );
  }
  // On the wrap across the seam, in the gap between the two bottom case labels.
  kit.place(group, shapes.palletLabel, label, 0.12, 0.3, 0.472, { castShadow: false }).name =
    "pallet-label";
  parent.add(group);
  return { group, cases };
}

export function rack(kit: Kit, parent: Object3D, x0: number, z0: number): void {
  const length = 1.6;
  const depth = 0.5;
  const height = 1.55;
  for (const dx of [0, length]) {
    for (const dz of [0, depth]) {
      kit.block(parent, 0.05, height, 0.05, "graphite", x0 + dx, 0.06, z0 + 0.25 + dz, 0.01);
    }
  }
  for (const shelf of [0.25, 0.8, 1.35]) {
    kit.block(
      parent,
      length + 0.05,
      0.04,
      depth + 0.05,
      "steel",
      x0 + length / 2,
      0.06 + shelf,
      z0 + 0.25 + depth / 2,
      0.01,
    );
    kit.block(
      parent,
      length - 0.3,
      0.22,
      depth - 0.12,
      "card",
      x0 + length / 2,
      0.1 + shelf,
      z0 + 0.25 + depth / 2,
      0.01,
    );
  }
}

export function van(kit: Kit, parent: Object3D, x: number, z: number, label: Material): void {
  const group = new Group();
  group.name = "van";
  group.position.set(x, 0.02, z);
  kit.block(group, 2.3, 1.3, 1.3, "plaster", 0.1, 0.28, 0, 0.08);
  kit.block(group, 0.95, 0.95, 1.26, "plaster", 1.72, 0.28, 0, 0.12);
  kit.block(group, 0.05, 0.42, 1.08, "graphite", 2.18, 0.72, 0, 0.02);
  for (const [wx, wz] of [
    [-0.6, -0.6],
    [-0.6, 0.6],
    [1.6, -0.6],
    [1.6, 0.6],
  ] as const) {
    kit.place(group, shapes.wheel, kit.material("graphite"), wx, 0.26, wz).rotation.x = Math.PI / 2;
  }
  for (const side of [-1, 1]) {
    const door = kit.block(group, 0.04, 1.2, 0.62, "plaster", -1.33, 0.33, side * 0.62, 0.01);
    door.rotation.y = side * 1.25;
    const light = kit.place(group, shapes.headlight, kit.signals.lamp, 2.206, 0.55, side * 0.45, {
      castShadow: false,
    });
    light.rotation.y = Math.PI / 2;
    light.name = "headlight";
  }
  closedCase(kit, group, -0.5, 0.33, -0.25, 0.1, label);
  closedCase(kit, group, -0.5, 0.33, 0.24, -0.05, label);
  parent.add(group);
}

export function tree(kit: Kit, parent: Object3D, x: number, z: number, scale: number): void {
  kit.place(parent, shapes.trunk, kit.material("trunk"), x, 0.31, z);
  kit
    .place(parent, shapes.crown, kit.flat("tree"), x, 0.62 + 0.4 * scale, z)
    .scale.setScalar(scale);
}

export function lampFixture(
  kit: Kit,
  parent: Object3D,
  x: number,
  y: number,
  z: number,
  ceiling: number,
): void {
  kit.block(
    parent,
    0.03,
    Math.max(0.05, ceiling - y - 0.1),
    0.03,
    "graphite",
    x,
    y + 0.1,
    z,
    0.005,
    {
      castShadow: false,
    },
  );
  kit.place(parent, shapes.shade, kit.material("graphite"), x, y + 0.02, z, { castShadow: false });
  const disc = kit.place(parent, shapes.disc, kit.signals.lamp, x, y - 0.065, z, {
    castShadow: false,
  });
  disc.rotation.x = Math.PI / 2;
  disc.name = "lamp-disc";
}
