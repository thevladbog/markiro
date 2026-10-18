import { menuMove, type MenuMove } from "./menu-model.js";

/**
 * The move a key means in a row of segments: the horizontal arrows (and the vertical ones, so a
 * screen reader's habit works), Home and End.
 */
export function segmentKeyMove(key: string): MenuMove | null {
  if (key === "ArrowRight") return "next";
  if (key === "ArrowLeft") return "previous";
  return menuMove(key);
}

/** Up to this many values a state filter is a segmented control (owner decision 2026-10); more is a select. */
export const MAX_SEGMENTS = 3;

/** Which control a filter of `options` values uses. */
export function filterControlKind(options: number): "segments" | "select" {
  return options <= MAX_SEGMENTS ? "segments" : "select";
}
