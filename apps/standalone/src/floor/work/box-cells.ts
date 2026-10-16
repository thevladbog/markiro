/**
 * The open box's cells show the serial of the code in a place under its number only where the
 * cell is big enough for it to be READ: a pure decision from the cell's computed box, so no
 * tiny or half-clipped text ever stands in a cell (owner feedback 2026-10-16).
 */

/** The smallest type a serial may be shown in on the terminal, in px. */
export const SERIAL_MIN_FONT = 12;
/** The type tried first, in px. */
export const SERIAL_FONT = 14;
/** The last characters of a serial a cell must keep when it cuts the serial's head. */
export const SERIAL_MIN_CHARS = 6;
/** A monospace glyph's width as a share of its font size (IBM Plex Mono is 0.6; a margin on top). */
export const MONO_WIDTH = 0.62;
/** Inner padding of a cell on each side and its 2 px border, in px. */
const CELL_PAD = 6;
const CELL_BORDER = 2;
/** The cell's number is at most 30 px; a gap of 4 px separates it from the serial. */
const NUMBER_BLOCK = 30 + 4;

export interface CellSerialInput {
  /** The grid's content box, in px. */
  width: number;
  height: number;
  columns: number;
  rows: number;
  /** The gap between cells, in px. */
  gap: number;
  /** The longest serial among the cells that have one; 0 when none. */
  serialLength: number;
  /** Whether the cells carry their number (up to ten places); smaller cells carry none. */
  numbered: boolean;
}

export type CellSerialPlan =
  | { show: false }
  | { show: true; fontPx: number; chars: number; cellWidth: number; cellHeight: number };

/** The box of one cell: the grid minus its gaps, shared out. */
export function cellBox(
  input: Pick<CellSerialInput, "width" | "height" | "columns" | "rows" | "gap">,
) {
  return {
    width: (input.width - input.gap * (input.columns - 1)) / input.columns,
    height: (input.height - input.gap * (input.rows - 1)) / input.rows,
  };
}

/**
 * Whether a cell shows its serial, in what size, and how many characters (the serial's head is
 * cut to a `…` when it is longer). The serial is shown only when the cell holds the number, a
 * line of serial in at least `SERIAL_MIN_FONT` px, and at least `SERIAL_MIN_CHARS` of its last
 * characters (the whole serial when it is shorter); otherwise it is hidden whole.
 */
export function cellSerialPlan(input: CellSerialInput): CellSerialPlan {
  if (!input.numbered || input.serialLength <= 0) return { show: false };
  const { width: cellWidth, height: cellHeight } = cellBox(input);
  if (!(cellWidth > 0) || !(cellHeight > 0)) return { show: false };
  const need = Math.min(input.serialLength, SERIAL_MIN_CHARS);
  for (const fontPx of [SERIAL_FONT, SERIAL_MIN_FONT]) {
    const line = Math.ceil(fontPx * 1.25);
    if (cellHeight < NUMBER_BLOCK + line + 2 * CELL_PAD + 2 * CELL_BORDER) continue;
    const fit = Math.floor((cellWidth - 2 * CELL_PAD - 2 * CELL_BORDER) / (fontPx * MONO_WIDTH));
    const chars = Math.min(fit, input.serialLength);
    // A cut serial spends one character on «…»: its readable part must still be `need` long.
    const readable = chars < input.serialLength ? chars - 1 : chars;
    if (readable >= need) return { show: true, fontPx, chars, cellWidth, cellHeight };
  }
  return { show: false };
}

/** A serial cut from its head to `chars` characters: `…` and the last ones; whole when it fits. */
export function serialForCell(serial: string, chars: number): string {
  return serial.length <= chars ? serial : `…${serial.slice(-(chars - 1))}`;
}
