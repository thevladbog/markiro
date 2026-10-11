/** Shared serialization only: callers own layout and pass resolved printer dots. */
export function buildZplDocument(
  widthDots: number,
  heightDots: number,
  commands: string[],
): string {
  return ["^XA", `^PW${widthDots}`, `^LL${heightDots}`, ...commands, "^XZ"].join("\n") + "\n";
}

export function buildTsplDocument(widthMm: number, heightMm: number, commands: string[]): string {
  return (
    [
      `SIZE ${widthMm} mm, ${heightMm} mm`,
      "GAP 2 mm, 0 mm",
      "DIRECTION 1",
      "CLS",
      ...commands,
      "PRINT 1",
    ].join("\n") + "\n"
  );
}

export function buildZplBox(
  x: number,
  y: number,
  width: number,
  height: number,
  thickness: number,
): string {
  return `^FO${x},${y}^GB${width},${height},${thickness}^FS`;
}

export function buildTsplBar(x: number, y: number, width: number, height: number): string {
  return `BAR ${x},${y},${width},${height}`;
}

export function buildTsplBox(
  x: number,
  y: number,
  width: number,
  height: number,
  thickness: number,
): string {
  return `BOX ${x},${y},${x + width},${y + height},${thickness}`;
}
