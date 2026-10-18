/** A move of the focus inside a menu or a row of options. */
export type MenuMove = "next" | "previous" | "first" | "last";

/** The move a key means in a vertical menu (arrows, Home, End), or `null` for any other key. */
export function menuMove(key: string): MenuMove | null {
  switch (key) {
    case "ArrowDown":
      return "next";
    case "ArrowUp":
      return "previous";
    case "Home":
      return "first";
    case "End":
      return "last";
    default:
      return null;
  }
}

/**
 * The index the focus moves to: the next enabled entry after `current`, wrapping at the ends; Home
 * and End are the first and last enabled ones. `current` is `-1` when no entry has the focus
 * (the next is then the first, the previous the last). `null` when no entry is enabled.
 */
export function nextEnabled(
  move: MenuMove,
  current: number,
  disabled: readonly boolean[],
): number | null {
  const count = disabled.length;
  const enabled = (index: number) => disabled[index] === false;
  if (!disabled.some((each) => !each)) return null;
  if (move === "first") {
    for (let index = 0; index < count; index += 1) if (enabled(index)) return index;
  }
  if (move === "last") {
    for (let index = count - 1; index >= 0; index -= 1) if (enabled(index)) return index;
  }
  const step = move === "previous" ? -1 : 1;
  let index = current < 0 ? (move === "previous" ? count : -1) : current;
  for (let tried = 0; tried < count; tried += 1) {
    index = (index + step + count) % count;
    if (enabled(index)) return index;
  }
  return null;
}
