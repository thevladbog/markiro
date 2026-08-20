/**
 * Width-bounded line breaking for label text.
 *
 * WHY THIS EXISTS: `maxWidthMm` used to be a pure ALIGNMENT hint. The
 * rasterized branch of both emitters (`zpl.ts`/`tspl.ts` -- the branch every
 * Cyrillic product name takes) sized its bitmap from the text's own measured
 * width and only used `maxWidthMm` to compute an x-offset, so a long Russian
 * product name on a 58 mm label produced a ~76 mm wide bitmap that printed
 * straight off the right edge, silently. This module makes `maxWidthMm` a
 * real CONSTRAINT: text is broken into at most `maxLines` lines that each fit
 * the width, and anything that still does not fit is truncated with an
 * ellipsis so the operator can SEE that the name was cut rather than reading
 * a plausible-looking but wrong short name.
 *
 * MEASUREMENT IS INJECTED, deliberately: this package stays DOM-free (plan
 * Global Constraints), so it cannot call `ctx.measureText`. The real
 * rasterizers (`apps/admin/src/labels/rasterizer.ts` and the station's copy)
 * pass a canvas-backed `measure`; the native-TSPL path in `tspl.ts` passes a
 * character-count ESTIMATE (see `estimatedTextWidthMm`). One algorithm, two
 * measurement sources, so a wrapped line always breaks at the same word
 * boundary whichever caller asked.
 */

/** Appended to a line whose remaining content did not fit. */
export const WRAP_ELLIPSIS = "…";

/**
 * Average glyph advance as a fraction of the em size, for callers that have
 * no real font metrics (native TSPL text, and the admin's pure
 * `elementBoundsMm` heuristic -- which imports this constant rather than
 * redeclaring it, so the preview's bounds and the emitters' wrapping can
 * never disagree about how wide a string "is"). Real proportional glyphs
 * range from ~0.2em ("i") to ~1em ("W"); 0.55em is the usual rule of thumb
 * for Latin/Cyrillic sans-serif text.
 */
export const AVG_CHAR_WIDTH_EM = 0.55;

/** Line box height as a fraction of the em size -- the SAME 1.5 ratio the
 * real canvas rasterizers use for their own bitmap height, so an estimated
 * line count and a rasterized one describe the same vertical footprint. */
export const LINE_HEIGHT_EM = 1.5;

const MM_PER_INCH = 25.4;
const POINTS_PER_INCH = 72;

/** Points -> millimetres. DPI-independent typographic conversion. */
export function ptToMm(pt: number): number {
  return (pt / POINTS_PER_INCH) * MM_PER_INCH;
}

/** Character-count width estimate in millimetres — the DOM-free stand-in for
 * a real `measureText`, used by native TSPL text and by bounds heuristics. */
export function estimatedTextWidthMm(text: string, fontSizePt: number): number {
  return Math.max(text.length, 1) * ptToMm(fontSizePt) * AVG_CHAR_WIDTH_EM;
}

/**
 * Largest prefix of `text` that still fits `maxWidth` once `WRAP_ELLIPSIS` is
 * appended. Always returns an ellipsized string (or `""` when not even the
 * ellipsis fits) -- callers use it precisely at the point where content is
 * being dropped, so the marker must never be silently omitted.
 *
 * Binary search rather than a character-at-a-time loop: `measure` is a real
 * canvas call in the rasterizers, and text width is monotonic in prefix
 * length, so O(log n) measurements are both correct and noticeably cheaper.
 */
export function clipWithEllipsis(
  text: string,
  measure: (s: string) => number,
  maxWidth: number,
): string {
  if (measure(WRAP_ELLIPSIS) > maxWidth) return "";
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(text.slice(0, mid) + WRAP_ELLIPSIS) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + WRAP_ELLIPSIS;
}

/** Splits a single unbreakable word into the widest chunks that each fit. */
function breakLongWord(word: string, measure: (s: string) => number, maxWidth: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const ch of word) {
    const next = current + ch;
    if (current !== "" && measure(next) > maxWidth) {
      chunks.push(current);
      current = ch;
    } else {
      current = next;
    }
  }
  if (current !== "") chunks.push(current);
  return chunks.length > 0 ? chunks : [word];
}

/**
 * Greedy word wrap of `text` into at most `maxLines` lines no wider than
 * `maxWidth` (in whatever unit `measure` returns — dots for the rasterizers,
 * millimetres for native TSPL).
 *
 * `maxLines` defaults to 1, which is NOT "no wrapping": it means "one line,
 * clipped to the width" — the safe behaviour for every template authored
 * before this module existed, whose elements carry `maxWidthMm` but no
 * `maxLines`. Passing `maxLines: 2` (what the stock box labels do for the
 * product name) allows a real second line.
 *
 * Runs of whitespace collapse to a single space: a label line is a single
 * visual run, and preserving interior double spaces across a break would
 * leave a stray leading space on the next line.
 */
export function wrapTextToWidth(
  text: string,
  measure: (s: string) => number,
  maxWidth: number,
  maxLines = 1,
): string[] {
  if (!Number.isFinite(maxWidth) || maxWidth <= 0) return [text];
  const limit = Math.max(1, Math.floor(maxLines));
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [text];

  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (measure(candidate) <= maxWidth) {
      current = candidate;
      continue;
    }
    // The word does not fit on the line in progress: flush it. Every branch
    // below reassigns `current`, so it is never left holding the flushed
    // line.
    if (current !== "") lines.push(current);
    if (measure(word) <= maxWidth) {
      current = word;
      continue;
    }
    const chunks = breakLongWord(word, measure, maxWidth);
    lines.push(...chunks.slice(0, -1));
    current = chunks[chunks.length - 1] ?? "";
  }
  if (current !== "") lines.push(current);
  if (lines.length === 0) return [""];
  if (lines.length <= limit) return lines;

  // Content was dropped: mark the last surviving line so the truncation is
  // visible on the printed label instead of reading as a complete value.
  const kept = lines.slice(0, limit);
  kept[limit - 1] = clipWithEllipsis(kept[limit - 1] ?? "", measure, maxWidth);
  return kept;
}

/**
 * How many lines `text` occupies under the same rules `wrapTextToWidth`
 * applies, using the DOM-free character-count estimate. Used by the bounds
 * heuristic (`bounds.ts`) so an element's reported HEIGHT grows with the
 * lines it will actually print.
 */
export function estimatedLineCount(
  text: string,
  fontSizePt: number,
  maxWidthMm: number | undefined,
  maxLines: number | undefined,
): number {
  const limit = Math.max(1, Math.floor(maxLines ?? 1));
  if (maxWidthMm === undefined || !(maxWidthMm > 0)) return 1;
  const natural = estimatedTextWidthMm(text, fontSizePt);
  return Math.min(limit, Math.max(1, Math.ceil(natural / maxWidthMm)));
}
