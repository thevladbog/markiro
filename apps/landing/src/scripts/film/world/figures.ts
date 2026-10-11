import {
  CapsuleGeometry,
  CatmullRomCurve3,
  CylinderGeometry,
  Euler,
  Group,
  LatheGeometry,
  PlaneGeometry,
  SphereGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
  type Object3D,
} from "three";

import type { Kit } from "./kit";

export type Pose = "stand" | "work" | "walk" | "device" | "badge";

type Arm = readonly [pitch: number, abduction: number, bend: number];

interface PoseSpec {
  readonly legs: readonly [number, number];
  readonly arms: readonly [Arm, Arm];
}

const POSES: Readonly<Record<Pose, PoseSpec>> = {
  stand: {
    legs: [0, 0],
    arms: [
      [0.04, 0.09, -0.14],
      [0.04, 0.09, -0.14],
    ],
  },
  work: {
    legs: [0.04, -0.04],
    arms: [
      [-0.4, 0.12, -0.8],
      [-0.4, 0.12, -0.8],
    ],
  },
  walk: {
    legs: [0.3, -0.27],
    arms: [
      [-0.3, 0.08, -0.3],
      [0.28, 0.08, -0.2],
    ],
  },
  device: {
    legs: [0, 0],
    arms: [
      [0.05, 0.09, -0.16],
      [-0.26, 0.06, -1.3],
    ],
  },
  badge: {
    legs: [0, 0],
    arms: [
      [0.05, 0.09, -0.16],
      [-0.62, 0.05, -0.9],
    ],
  },
};

// The white coat is one lathe silhouette, so the figure has no seam at the waist.
const COAT_PROFILE: readonly (readonly [number, number])[] = [
  [0, 0.47],
  [0.156, 0.47],
  [0.151, 0.62],
  [0.141, 0.86],
  [0.131, 1.0],
  [0.149, 1.22],
  [0.161, 1.34],
  [0.139, 1.43],
  [0.074, 1.49],
  [0, 1.5],
];

const shapes = {
  coat: new LatheGeometry(
    COAT_PROFILE.map(([r, y]) => new Vector2(r, y)),
    32,
  ),
  leg: new CapsuleGeometry(0.054, 0.4, 4, 14),
  shoe: new SphereGeometry(0.066, 16, 10),
  neck: new CylinderGeometry(0.042, 0.048, 0.08, 14),
  head: new SphereGeometry(0.098, 28, 20),
  cap: new SphereGeometry(0.107, 28, 12, 0, Math.PI * 2, 0, Math.PI / 2),
  hand: new SphereGeometry(0.04, 16, 12),
  shoulder: new SphereGeometry(0.043, 14, 10),
  screen: new PlaneGeometry(0.066, 0.1),
};

const DOWN = new Vector3(0, -1, 0);

export function person(
  kit: Kit,
  parent: Object3D,
  x: number,
  z: number,
  rotationY: number,
  pose: Pose = "stand",
  y = 0.06,
): Group {
  const spec = POSES[pose];
  const figure = new Group();
  figure.name = "person";
  figure.position.set(x, y, z);
  figure.rotation.y = rotationY;
  spec.legs.forEach((swing, index) => {
    const hip = new Group();
    hip.position.set((index === 0 ? -1 : 1) * 0.068, 0.56, 0);
    hip.rotation.x = swing;
    kit.place(hip, shapes.leg, kit.material("trousers"), 0, -0.25, 0);
    kit.place(hip, shapes.shoe, kit.material("shoe"), 0, -0.5, 0.034).scale.set(0.95, 0.55, 1.55);
    figure.add(hip);
  });
  kit.place(figure, shapes.coat, kit.material("coat"), 0, 0, 0).scale.z = 0.72;
  kit.place(figure, shapes.neck, kit.material("skin"), 0, 1.53, 0);
  kit.place(figure, shapes.head, kit.material("skin"), 0, 1.645, 0.004).scale.set(0.9, 1.1, 0.98);
  kit.place(figure, shapes.cap, kit.material("cap"), 0, 1.675, -0.004).scale.set(1, 0.8, 1.04);
  spec.arms.forEach(([pitch, abduction, bend], index) => {
    const side = index === 0 ? -1 : 1;
    const shoulder = new Vector3(side * 0.158, 1.39, 0);
    const upper = DOWN.clone().applyEuler(new Euler(pitch, 0, side * abduction));
    const elbow = shoulder.clone().addScaledVector(upper, 0.3);
    const forearm = DOWN.clone().applyEuler(new Euler(pitch + bend, 0, side * abduction * 0.6));
    const hand = elbow.clone().addScaledVector(forearm, 0.27);
    const sleeve = new TubeGeometry(
      new CatmullRomCurve3([shoulder, elbow, hand], false, "centripetal"),
      20,
      0.041,
      12,
      false,
    );
    kit.place(figure, sleeve, kit.material("coat"), 0, 0, 0);
    kit.place(figure, shapes.shoulder, kit.material("coat"), shoulder.x, shoulder.y, shoulder.z);
    kit.place(figure, shapes.hand, kit.material("skin"), hand.x, hand.y, hand.z);
    if (side === 1 && (pose === "device" || pose === "badge")) {
      holdItem(kit, figure, hand, forearm, pose);
    }
  });
  parent.add(figure);
  return figure;
}

function holdItem(
  kit: Kit,
  figure: Group,
  hand: Vector3,
  forearm: Vector3,
  pose: "device" | "badge",
): void {
  const item = new Group();
  item.position.copy(hand).addScaledVector(forearm, 0.05);
  item.lookAt(item.position.clone().add(forearm));
  item.rotateX(-Math.PI / 2 + 0.35);
  if (pose === "device") {
    kit.block(item, 0.09, 0.02, 0.16, "graphite", 0, -0.01, 0, 0.008);
    const screen = kit.place(item, shapes.screen, kit.signals.verified, 0, 0.0115, 0.01, {
      castShadow: false,
    });
    screen.rotation.x = -Math.PI / 2;
    screen.name = "handheld-screen";
  } else {
    kit.block(item, 0.085, 0.006, 0.055, "plaster", 0, 0, 0, 0.002, { castShadow: false }).name =
      "badge";
  }
  figure.add(item);
}
