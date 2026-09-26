import { clamp01 } from "./math";

export interface SectionBox {
  readonly top: number;
  readonly height: number;
}

export interface ChapterPosition {
  readonly index: number;
  readonly local: number;
}

/**
 * Film time runs from 0 to the number of chapters. Chapter 1 starts at the top
 * of the page and ends when chapter 2 enters at the bottom of the viewport.
 * Every later chapter runs from its section entering at the bottom to its
 * section leaving at the bottom, which is while its sticky card is on screen.
 */
export function filmTimeFromLayout(
  sections: readonly SectionBox[],
  viewportHeight: number,
): number {
  for (let index = sections.length - 1; index >= 0; index -= 1) {
    const box = sections[index];
    if (box === undefined) continue;
    const start = index === 0 ? 0 : viewportHeight;
    if (box.top > start) continue;
    const span = index === 0 ? box.height - viewportHeight : box.height;
    return index + (span <= 0 ? 1 : clamp01((start - box.top) / span));
  }
  return 0;
}

export function chapterAt(filmTime: number, chapterCount: number): ChapterPosition {
  const clamped = Math.min(chapterCount, Math.max(0, filmTime));
  const index = Math.min(chapterCount - 1, Math.floor(clamped));
  return { index, local: clamped - index };
}

/** Slows the camera mid-chapter; f(0)=0, f(1)=1 and equal slopes at both ends. */
export function dwell(local: number, strength = 0.45): number {
  const x = clamp01(local);
  return x + (strength / (2 * Math.PI)) * Math.sin(2 * Math.PI * x);
}

export function cameraTime(filmTime: number, chapterCount: number): number {
  const { index, local } = chapterAt(filmTime, chapterCount);
  return index + dwell(local);
}
