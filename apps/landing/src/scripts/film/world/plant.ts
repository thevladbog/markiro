import {
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  SphereGeometry,
  type Object3D,
} from "three";

import { BELT, CASE_CAPACITY, PALLET_CAPACITY, QUEUE_TILES, type ProductKind } from "../animations";
import { person } from "./figures";
import type { Kit } from "./kit";
import { createProduct, lampFixture, openCase, pallet, rack, van } from "./props";
import type { ScreenTextures } from "./textures";

export type Vec3Tuple = readonly [number, number, number];

export const FLOOR = 0.06;
export const HALL = { x0: -6.2, x1: 3.4, z0: -3.6, z1: 2.4 } as const;
export const CONVEYOR = { x0: -5.2, x1: 0.55, z: -1.1, y: 0.78, width: 0.62 } as const;
export const BELT_TOP = CONVEYOR.y + 0.01;

const TABLE = { x: 1.55, z: -1.1, width: 1.7, depth: 1.1, height: 0.76 } as const;
const COLUMN_HEIGHT = 2.9;
const TRUSS_X = [-3.8, -1.3, 1.1] as const;
const PRODUCTS_FACE = (-30 * Math.PI) / 180;
const LAMP_SPOTS: readonly Vec3Tuple[] = [
  [-3.8, FLOOR + 2.45, -1.1],
  [-1.3, FLOOR + 2.45, -1.1],
  [1.1, FLOOR + 2.45, -1.0],
  [2.4, FLOOR + 2.45, 1.3],
];

export interface BeltSlot {
  readonly group: Group;
  readonly products: Readonly<Record<ProductKind, Group>>;
  readonly codes: readonly Mesh[];
}

export interface PlantHandles {
  readonly belt: readonly BeltSlot[];
  readonly caseProducts: readonly Object3D[];
  readonly labelTongue: Mesh;
  readonly palletCases: readonly Object3D[];
  readonly palletLabel: Mesh;
  readonly queueTiles: readonly Mesh[];
  readonly queueBase: Vec3Tuple;
  readonly mastLamp: Mesh;
  readonly monitorScreen: Mesh<PlaneGeometry, MeshBasicMaterial>;
  readonly kioskScreen: Mesh<PlaneGeometry, MeshBasicMaterial>;
  readonly windows: MeshStandardMaterial;
  readonly scanLamp: Vec3Tuple;
  readonly lampSpots: readonly Vec3Tuple[];
}

/** A cut wall: a white slab with a graphite cap, split around its openings. */
function wall(
  kit: Kit,
  parent: Object3D,
  from: readonly [number, number],
  to: readonly [number, number],
  height: number,
  gaps: readonly (readonly [number, number])[] = [],
): void {
  const thickness = 0.2;
  const alongX = Math.abs(to[1] - from[1]) < 1e-6;
  const start = alongX ? Math.min(from[0], to[0]) : Math.min(from[1], to[1]);
  const end = alongX ? Math.max(from[0], to[0]) : Math.max(from[1], to[1]);
  const segments: (readonly [number, number])[] = [];
  let cursor = start;
  for (const [gapStart, gapEnd] of [...gaps].sort((a, b) => a[0] - b[0])) {
    if (gapStart > cursor) segments.push([cursor, gapStart]);
    cursor = Math.max(cursor, gapEnd);
  }
  if (cursor < end) segments.push([cursor, end]);
  for (const [s0, s1] of segments) {
    const length = s1 - s0;
    const middle = (s0 + s1) / 2;
    const width = alongX ? length : thickness;
    const depth = alongX ? thickness : length;
    const x = alongX ? middle : from[0];
    const z = alongX ? from[1] : middle;
    kit.block(parent, width, height, depth, "wall", x, FLOOR, z, 0.02);
    kit.block(parent, width + 0.004, 0.035, depth + 0.004, "cut", x, FLOOR + height, z, 0.006, {
      castShadow: false,
    });
  }
}

function hallShell(kit: Kit, plant: Group): void {
  kit.block(
    plant,
    HALL.x1 - HALL.x0,
    FLOOR,
    HALL.z1 - HALL.z0,
    "floor",
    (HALL.x0 + HALL.x1) / 2,
    0,
    (HALL.z0 + HALL.z1) / 2,
    0.02,
  );
  wall(kit, plant, [HALL.x0, HALL.z0], [HALL.x1, HALL.z0], 1.9);
  wall(kit, plant, [HALL.x1, HALL.z0], [HALL.x1, HALL.z1], 1.9, [[0.1, 2.25]]);
  wall(kit, plant, [HALL.x0, HALL.z0], [HALL.x0, HALL.z1], 0.42);
  wall(kit, plant, [HALL.x0, HALL.z1], [HALL.x1, HALL.z1], 0.42, [[-5.3, -4.3]]);
  const roller = kit.place(
    plant,
    new CylinderGeometry(0.16, 0.16, 2.3, 20),
    kit.material("steel"),
    HALL.x1,
    FLOOR + 1.72,
    1.18,
  );
  roller.rotation.x = Math.PI / 2;
  for (const x of [HALL.x0, ...TRUSS_X, HALL.x1]) {
    for (const z of [HALL.z0, HALL.z1]) {
      kit.block(plant, 0.17, COLUMN_HEIGHT, 0.17, "column", x, FLOOR, z, 0.02);
    }
  }
  for (const x of TRUSS_X) {
    kit.block(
      plant,
      0.11,
      0.13,
      HALL.z1 - HALL.z0,
      "column",
      x,
      FLOOR + COLUMN_HEIGHT - 0.13,
      (HALL.z0 + HALL.z1) / 2,
      0.02,
    );
  }
  for (const z of [HALL.z0, HALL.z1]) {
    kit.block(
      plant,
      HALL.x1 - HALL.x0,
      0.13,
      0.11,
      "column",
      (HALL.x0 + HALL.x1) / 2,
      FLOOR + COLUMN_HEIGHT - 0.13,
      z,
      0.02,
    );
  }
  for (const [x, y, z] of LAMP_SPOTS)
    lampFixture(kit, plant, x, y, z, FLOOR + COLUMN_HEIGHT - 0.13);
}

function line(kit: Kit, plant: Group): readonly BeltSlot[] {
  const middle = (CONVEYOR.x0 + CONVEYOR.x1) / 2;
  const length = CONVEYOR.x1 - CONVEYOR.x0;
  for (let x = CONVEYOR.x0 + 0.3; x <= CONVEYOR.x1 - 0.2; x += 1.1) {
    for (const side of [-1, 1]) {
      kit.block(
        plant,
        0.07,
        CONVEYOR.y - FLOOR - 0.06,
        0.07,
        "steel",
        x,
        FLOOR,
        CONVEYOR.z + side * (CONVEYOR.width / 2 - 0.06),
        0.01,
      );
    }
  }
  for (const side of [-1, 1]) {
    kit.block(
      plant,
      length,
      0.12,
      0.06,
      "steel",
      middle,
      CONVEYOR.y - 0.08,
      CONVEYOR.z + side * (CONVEYOR.width / 2),
      0.01,
    );
    kit.block(
      plant,
      length,
      0.03,
      0.03,
      "steel",
      middle,
      CONVEYOR.y + 0.16,
      CONVEYOR.z + side * 0.2,
      0.01,
    );
  }
  kit.block(
    plant,
    length,
    0.05,
    CONVEYOR.width - 0.1,
    "belt",
    middle,
    CONVEYOR.y - 0.04,
    CONVEYOR.z,
    0.02,
  );
  for (const side of [-1, 1]) {
    kit.block(
      plant,
      0.12,
      1.28,
      0.12,
      "graphite",
      BELT.archX,
      FLOOR,
      CONVEYOR.z + side * 0.46,
      0.02,
    );
  }
  kit.block(plant, 0.22, 0.16, 1.04, "graphite", BELT.archX, FLOOR + 1.26, CONVEYOR.z, 0.03);
  kit.place(
    plant,
    new SphereGeometry(0.075, 20, 14),
    kit.signals.verified,
    BELT.archX,
    FLOOR + 1.5,
    CONVEYOR.z,
    { castShadow: false },
  ).name = "scanner-lamp";
  kit.block(
    plant,
    0.03,
    0.012,
    0.82,
    kit.signals.verified,
    BELT.archX,
    FLOOR + 1.245,
    CONVEYOR.z,
    0.004,
    { castShadow: false },
  ).name = "scan-line";
  // Reject bin beside the belt, just past the arch.
  kit.block(plant, 0.62, 0.34, 0.42, "graphite", BELT.archX + 0.75, FLOOR, CONVEYOR.z + 0.62, 0.03);

  const slots: BeltSlot[] = [];
  for (let index = 0; index < BELT.count; index += 1) {
    const group = new Group();
    group.name = "belt-slot";
    group.position.set(BELT.start, BELT_TOP, CONVEYOR.z);
    group.rotation.y = PRODUCTS_FACE;
    const bottle = createProduct(kit, "bottle");
    const jar = createProduct(kit, "jar");
    const can = createProduct(kit, "can");
    group.add(bottle.group, jar.group, can.group);
    plant.add(group);
    slots.push({
      group,
      products: { bottle: bottle.group, jar: jar.group, can: can.group },
      codes: [bottle.code, jar.code, can.code],
    });
  }
  return slots;
}

function mast(kit: Kit, plant: Group, x: number, z: number): Mesh {
  kit.block(plant, 0.5, 0.08, 0.5, "steel", x, 0.02, z, 0.02);
  kit.place(plant, new CylinderGeometry(0.035, 0.07, 3.6, 12), kit.material("column"), x, 1.9, z);
  for (const y of [1.2, 2.2, 3.1]) {
    kit.place(plant, new CylinderGeometry(0.16, 0.16, 0.03, 16), kit.material("steel"), x, y, z);
  }
  const dish = kit.place(
    plant,
    new SphereGeometry(0.22, 20, 12),
    kit.material("column"),
    x + 0.12,
    3.35,
    z,
  );
  dish.scale.set(1, 0.35, 1);
  dish.rotation.z = -1.1;
  const lamp = kit.place(
    plant,
    new SphereGeometry(0.075, 16, 12),
    kit.signals.verified,
    x,
    3.78,
    z,
    {
      castShadow: false,
    },
  );
  lamp.name = "mast-lamp";
  return lamp;
}

function checkpoint(
  kit: Kit,
  plant: Group,
  screens: ScreenTextures,
  x: number,
  z: number,
): Mesh<PlaneGeometry, MeshBasicMaterial> {
  const kiosk = new Group();
  kiosk.name = "kiosk";
  kiosk.position.set(x, 0.02, z);
  kiosk.rotation.y = 0.35;
  kit.block(kiosk, 0.62, 0.05, 0.5, "steel", 0, 0, 0, 0.02);
  kit.block(kiosk, 0.5, 1.32, 0.34, "plaster", 0, 0.05, -0.02, 0.05);
  const head = new Group();
  head.position.set(0, 1.28, 0.02);
  head.rotation.x = -0.35;
  kit.block(head, 0.56, 0.72, 0.07, "graphite", 0, 0, 0, 0.02);
  const screen = new Mesh(
    new PlaneGeometry(0.46, 0.64),
    new MeshBasicMaterial({ map: screens.kiosk(false, 0) }),
  );
  screen.name = "kiosk-screen";
  screen.position.set(0, 0.36, 0.036);
  head.add(screen);
  kiosk.add(head);
  kit.block(kiosk, 0.22, 0.1, 0.06, "graphite", 0, 0.92, 0.17, 0.015);
  kit.place(kiosk, new PlaneGeometry(0.14, 0.04), kit.signals.verified, 0, 0.97, 0.2, {
    castShadow: false,
  }).name = "kiosk-ok";
  plant.add(kiosk);
  kit.block(plant, 1.9, 0.06, 1.3, "column", x + 0.1, 2.35, z - 0.1, 0.02);
  for (const [dx, dz] of [
    [-0.85, 0.5],
    [0.95, 0.5],
  ] as const) {
    kit.block(plant, 0.07, 2.33, 0.07, "column", x + dx, 0.02, z + dz, 0.01);
  }
  person(kit, plant, x + 0.25, z + 0.7, Math.atan2(-0.25, -0.7), "badge");
  return screen;
}

function office(kit: Kit, plant: Group, x: number, z: number, windows: MeshStandardMaterial): void {
  const group = new Group();
  group.name = "office";
  const width = 3.0;
  const depth = 2.2;
  const floorHeight = 1.15;
  for (let floor = 0; floor < 2; floor += 1) {
    const y = 0.02 + floor * floorHeight;
    kit.block(group, width, 0.14, depth, "wall", x, y, z, 0.02);
    for (const [dx, dz] of [
      [-width / 2 + 0.08, -depth / 2 + 0.08],
      [width / 2 - 0.08, -depth / 2 + 0.08],
      [-width / 2 + 0.08, depth / 2 - 0.08],
      [width / 2 - 0.08, depth / 2 - 0.08],
    ] as const) {
      kit.block(group, 0.14, floorHeight - 0.14, 0.14, "wall", x + dx, y + 0.14, z + dz, 0.02);
    }
    kit.block(
      group,
      width - 0.24,
      floorHeight - 0.44,
      0.03,
      windows,
      x,
      y + 0.3,
      z + depth / 2 - 0.05,
      0.005,
      { castShadow: false },
    );
    kit.block(
      group,
      0.03,
      floorHeight - 0.44,
      depth - 0.24,
      windows,
      x - width / 2 + 0.05,
      y + 0.3,
      z,
      0.005,
      { castShadow: false },
    );
    kit.block(
      group,
      width - 0.12,
      0.16,
      0.05,
      "wall",
      x,
      y + floorHeight - 0.16,
      z + depth / 2 - 0.02,
      0.01,
    );
    for (let k = 1; k < 6; k += 1) {
      kit.block(
        group,
        0.05,
        floorHeight - 0.44,
        0.05,
        "wall",
        x - width / 2 + k * (width / 6),
        y + 0.3,
        z + depth / 2 - 0.03,
        0.01,
      );
    }
    for (let k = 1; k < 4; k += 1) {
      kit.block(
        group,
        0.05,
        floorHeight - 0.44,
        0.05,
        "wall",
        x - width / 2 + 0.03,
        y + 0.3,
        z - depth / 2 + k * (depth / 4),
        0.01,
      );
    }
  }
  kit.block(group, width + 0.1, 0.16, depth + 0.1, "wall", x, 0.02 + 2 * floorHeight, z, 0.03);
  kit.block(group, width + 0.1, 0.035, depth + 0.1, "cut", x, 0.18 + 2 * floorHeight, z, 0.006, {
    castShadow: false,
  });
  plant.add(group);
}

export function buildPlant(kit: Kit, parent: Object3D, screens: ScreenTextures): PlantHandles {
  const plant = new Group();
  plant.name = "plant";
  parent.add(plant);
  const label = new MeshStandardMaterial({ map: screens.label, roughness: 0.8 });
  label.name = "label";

  hallShell(kit, plant);
  const belt = line(kit, plant);

  kit.block(
    plant,
    TABLE.width,
    0.05,
    TABLE.depth,
    "plaster",
    TABLE.x,
    TABLE.height - 0.05,
    TABLE.z,
    0.02,
  );
  for (const [dx, dz] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ] as const) {
    kit.block(
      plant,
      0.06,
      TABLE.height - 0.05 - FLOOR,
      0.06,
      "steel",
      TABLE.x + dx * (TABLE.width / 2 - 0.08),
      FLOOR,
      TABLE.z + dz * (TABLE.depth / 2 - 0.08),
      0.01,
    );
  }
  const packing = openCase(kit, plant, TABLE.x + 0.02, TABLE.height, TABLE.z + 0.08, CASE_CAPACITY);
  kit.block(plant, 0.36, 0.26, 0.32, "graphite", TABLE.x + 0.6, TABLE.height, TABLE.z - 0.28, 0.04);
  const labelTongue = kit.place(
    plant,
    new PlaneGeometry(0.17, 0.13),
    label,
    TABLE.x + 0.6,
    TABLE.height + 0.2,
    TABLE.z - 0.08,
    { castShadow: false },
  );
  labelTongue.rotation.x = -0.9;
  labelTongue.name = "label-tongue";
  kit.place(
    plant,
    new SphereGeometry(0.02, 10, 8),
    kit.signals.verified,
    TABLE.x + 0.72,
    TABLE.height + 0.265,
    TABLE.z - 0.14,
    {
      castShadow: false,
    },
  ).name = "printer-led";

  const monitor = new Group();
  monitor.position.set(TABLE.x - 0.55, TABLE.height, TABLE.z - 0.34);
  monitor.rotation.y = 0.35;
  kit.block(monitor, 0.07, 0.34, 0.07, "graphite", 0, 0, 0, 0.01);
  kit.block(monitor, 0.66, 0.44, 0.045, "graphite", 0, 0.3, 0, 0.02);
  const monitorScreen = new Mesh(
    new PlaneGeometry(0.6, 0.375),
    new MeshBasicMaterial({ map: screens.station(false) }),
  );
  monitorScreen.name = "monitor-screen";
  monitorScreen.position.set(0, 0.52, 0.024);
  monitor.add(monitorScreen);
  plant.add(monitor);

  // Offline operations stack up above the hall and fly away once synced.
  const queueBase: Vec3Tuple = [0.3, 1.95, -1.6];
  const queueTiles: Mesh[] = [];
  for (let index = 0; index < QUEUE_TILES; index += 1) {
    const tile = kit.block(
      plant,
      0.9,
      0.08,
      0.6,
      "graphite",
      queueBase[0],
      queueBase[1] + index * 0.14,
      queueBase[2],
      0.02,
      { castShadow: false },
    );
    tile.name = "queue-tile";
    tile.visible = false;
    queueTiles.push(tile);
  }

  const loaded = pallet(kit, plant, 2.45, FLOOR, 1.2, PALLET_CAPACITY, label);
  rack(kit, plant, -5.9, HALL.z0);
  rack(kit, plant, -4.05, HALL.z0);

  person(kit, plant, TABLE.x + 0.02, TABLE.z + 0.86, Math.PI, "work");
  person(kit, plant, CONVEYOR.x0 + 0.45, CONVEYOR.z + 0.72, Math.PI - 0.15, "work");
  // The warehouse worker faces the pallet's front row and holds the handheld about
  // 12 cm in front of the transport label on the front-right top case, the last case
  // the pallet receives.
  person(kit, plant, 3.08, 2.25, Math.PI, "device");
  person(kit, plant, -4.35, 0.75, Math.PI / 2 - 0.35, "walk");

  const mastLamp = mast(kit, plant, 4.3, -3.9);
  const kioskScreen = checkpoint(kit, plant, screens, -4.75, 3.05);
  const windows = new MeshStandardMaterial({
    color: kit.colorOf("glass"),
    emissive: "#f2d2a6",
    emissiveIntensity: 0,
    roughness: 0.25,
  });
  windows.name = "window";
  office(kit, plant, 6.2, -2.75, windows);
  van(kit, plant, 5.3, 1.25, label);

  return {
    belt,
    caseProducts: packing.products,
    labelTongue,
    palletCases: loaded.cases,
    palletLabel: loaded.label,
    queueTiles,
    queueBase,
    mastLamp,
    monitorScreen,
    kioskScreen,
    windows,
    scanLamp: [BELT.archX, FLOOR + 1.1, CONVEYOR.z],
    lampSpots: LAMP_SPOTS,
  };
}
