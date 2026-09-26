import { clamp01, ramp } from "./math";

export type ProductKind = "bottle" | "jar" | "can";

export const PRODUCT_KINDS: readonly ProductKind[] = ["bottle", "jar", "can"];

export interface BeltItemState {
  readonly x: number;
  readonly visible: boolean;
  readonly kind: ProductKind;
  readonly code: "idle" | "verified" | "rejected";
  /** 0 on the belt, 1 pushed off into the reject bin. */
  readonly aside: number;
}

export interface FilmAnimationState {
  readonly belt: readonly BeltItemState[];
  readonly caseFill: number;
  readonly labelOut: number;
  readonly palletCases: number;
  readonly queueCount: number;
  readonly queueFlush: number;
  readonly networkOnline: boolean;
  readonly kioskStep: number;
  readonly officeLights: number;
}

export const BELT = {
  start: -5.0,
  end: 0.45,
  archX: -2.1,
  spacing: 0.42,
  count: 13,
  rejectEvery: 6,
  travelPerUnit: 2.4,
} as const;

export const CASE_CAPACITY = 6;
export const PALLET_CAPACITY = 8;
export const QUEUE_TILES = 12;

export function beltAt(filmTime: number): BeltItemState[] {
  const span = BELT.count * BELT.spacing;
  const phase = Math.max(0, filmTime) * BELT.travelPerUnit;
  const items: BeltItemState[] = [];
  for (let index = 0; index < BELT.count; index += 1) {
    const travelled = index * BELT.spacing + phase;
    const lap = Math.floor(travelled / span);
    const x = BELT.start + (travelled - lap * span);
    const serial = index + lap;
    const kind = PRODUCT_KINDS[serial % PRODUCT_KINDS.length] ?? "bottle";
    const rejected = serial % BELT.rejectEvery === 0;
    const passed = x > BELT.archX;
    items.push({
      x,
      visible: x < BELT.end,
      kind,
      code: passed ? (rejected ? "rejected" : "verified") : "idle",
      aside: rejected && passed ? clamp01((x - BELT.archX) / 0.9) : 0,
    });
  }
  return items;
}

function steps(value: number, count: number): number {
  return Math.min(count, Math.floor(value * count + 1e-9));
}

export function animationAt(filmTime: number): FilmAnimationState {
  const offline = filmTime >= 4.1 && filmTime < 4.7;
  return {
    belt: beltAt(filmTime),
    caseFill: steps(ramp(filmTime, 2.05, 2.55), CASE_CAPACITY),
    labelOut: ramp(filmTime, 2.55, 2.8),
    // The top layer lands while the camera flies in to the handheld, so the pallet
    // is complete, and labelled, while the camera holds there.
    palletCases: 4 + steps(ramp(filmTime, 3.0, 3.4), PALLET_CAPACITY - 4),
    queueCount: filmTime < 4.1 ? 0 : Math.ceil(ramp(filmTime, 4.1, 4.6) * QUEUE_TILES - 1e-9),
    queueFlush: ramp(filmTime, 4.7, 4.95),
    networkOnline: !offline,
    kioskStep: steps(ramp(filmTime, 5.2, 5.8), 3),
    officeLights: ramp(filmTime, 6.0, 6.4),
  };
}
