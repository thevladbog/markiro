export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];

export interface CameraPose {
  readonly position: Vec3;
  readonly target: Vec3;
  readonly fov: number;
  /** Where the target lands on a landscape screen, in normalised device units. */
  readonly shiftWide: Vec2;
  /** Where the target lands on a portrait screen, in normalised device units. */
  readonly shiftTall: Vec2;
}

export interface CameraKey extends CameraPose {
  readonly at: number;
}

export function catmullRom(p0: number, p1: number, p2: number, p3: number, s: number): number {
  const s2 = s * s;
  const s3 = s2 * s;
  return (
    0.5 *
    (2 * p1 +
      (p2 - p0) * s +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * s2 +
      (3 * p1 - p0 - 3 * p2 + p3) * s3)
  );
}

export function orbitKey(
  at: number,
  target: Vec3,
  azimuthDeg: number,
  elevationDeg: number,
  distance: number,
  fov: number,
  shiftWide: Vec2,
  shiftTall: Vec2,
): CameraKey {
  const azimuth = (azimuthDeg * Math.PI) / 180;
  const elevation = (elevationDeg * Math.PI) / 180;
  return {
    at,
    target,
    fov,
    shiftWide,
    shiftTall,
    position: [
      target[0] + distance * Math.cos(elevation) * Math.sin(azimuth),
      target[1] + distance * Math.sin(elevation),
      target[2] + distance * Math.cos(elevation) * Math.cos(azimuth),
    ],
  };
}

export function poseAt(keys: readonly CameraKey[], time: number): CameraPose {
  const first = keys[0];
  const last = keys.at(-1);
  if (first === undefined || last === undefined) throw new Error("camera path needs a key");
  if (time <= first.at) return first;
  if (time >= last.at) return last;
  let segment = 0;
  while (segment < keys.length - 2 && (keys[segment + 1]?.at ?? Number.POSITIVE_INFINITY) < time) {
    segment += 1;
  }
  const k0 = keys[Math.max(0, segment - 1)] ?? first;
  const k1 = keys[segment] ?? first;
  const k2 = keys[segment + 1] ?? last;
  const k3 = keys[Math.min(keys.length - 1, segment + 2)] ?? last;
  const s = (time - k1.at) / (k2.at - k1.at);
  const curve = (a: Vec3, b: Vec3, c: Vec3, d: Vec3): Vec3 => [
    catmullRom(a[0], b[0], c[0], d[0], s),
    catmullRom(a[1], b[1], c[1], d[1], s),
    catmullRom(a[2], b[2], c[2], d[2], s),
  ];
  const lerp = (a: number, b: number): number => a + (b - a) * s;
  const lerp2 = (a: Vec2, b: Vec2): Vec2 => [lerp(a[0], b[0]), lerp(a[1], b[1])];
  return {
    position: curve(k0.position, k1.position, k2.position, k3.position),
    target: curve(k0.target, k1.target, k2.target, k3.target),
    fov: lerp(k1.fov, k2.fov),
    shiftWide: lerp2(k1.shiftWide, k2.shiftWide),
    shiftTall: lerp2(k1.shiftTall, k2.shiftTall),
  };
}
