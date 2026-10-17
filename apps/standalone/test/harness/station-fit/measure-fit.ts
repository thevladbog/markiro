/**
 * The measuring guard of the floor's fit, run in a real browser (`window.__inspect()` of a
 * harness page, driven by `measure.mjs` at the terminal's window sizes). It reads the rendered
 * page only, so it works on any floor screen:
 *
 *  - no page-level scroll;
 *  - every control (button, tab, switch, radio, link, input) at least 64 px both ways, and the
 *    floor's primary action at least 72 px (84 px in a tall window);
 *  - no clipping: an element that hides its overflow holds its content, unless it truncates on
 *    purpose (`text-overflow: ellipsis` or a line clamp) and carries the full text as a `title`
 *    or an `aria-label` (on itself or an ancestor within four levels); a scroller the screen
 *    declares with `overflow: auto` is allowed;
 *  - no spill: a text stays inside every surface (an ancestor with a border or a face) it is in;
 *  - no overlap: no two texts, and no text and a control it is not part of, cover each other;
 *  - nothing covered: the point in the middle of every control hits that control (a footer laid
 *    over a keypad hits the footer), and the control lies inside the window.
 *
 * Returns `{ problems, ... }`: the problems as strings, and the figures behind them.
 */
export interface FitResult {
  problems: string[];
  controls: number;
  /** Controls inside a scroller, scrolled out of its view (reachable by scrolling). */
  scrolledAway: number;
  texts: number;
  scrollers: string[];
  keypad: { top: number; bottom: number; keys: number } | null;
  footer: { top: number; bottom: number } | null;
}

const CONTROLS =
  "button, a[href], input, select, textarea, [role=button], [role=tab], [role=switch], [role=radio], [role=checkbox]";
const MIN_TARGET = 64;
const TOLERANCE = 1;

function label(el: Element): string {
  const named = el.getAttribute("aria-label") ?? el.getAttribute("title");
  const text = (named ?? el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 36);
  const cls = typeof el.className === "string" ? el.className.split(" ")[0] : "";
  return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""} «${text}»`;
}

function visible(el: Element): boolean {
  if (el.closest("[hidden]") !== null) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 1 || rect.height <= 1) return false;
  const style = getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none";
}

function hasTitle(el: Element): boolean {
  let at: Element | null = el;
  for (let up = 0; up < 5 && at !== null; up += 1) {
    if (at.hasAttribute("title") || at.hasAttribute("aria-label")) return true;
    at = at.parentElement;
  }
  return false;
}

/** The boxes of an element's own text (direct text nodes): one per line, and their union. */
function textLines(el: Element): { box: DOMRect; lines: DOMRect[] } | null {
  const lines: DOMRect[] = [];
  for (const node of el.childNodes) {
    if (node.nodeType !== Node.TEXT_NODE || (node.textContent ?? "").trim() === "") continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      if (rect.width < 1 || rect.height < 1) continue;
      lines.push(new DOMRect(rect.x, rect.y, rect.width, rect.height));
    }
  }
  const [first, ...rest] = lines;
  if (first === undefined) return null;
  let box = first;
  for (const rect of rest) {
    box = new DOMRect(
      Math.min(box.left, rect.left),
      Math.min(box.top, rect.top),
      Math.max(box.right, rect.right) - Math.min(box.left, rect.left),
      Math.max(box.bottom, rect.bottom) - Math.min(box.top, rect.top),
    );
  }
  return { box, lines };
}

function overlaps(a: DOMRect, b: DOMRect): boolean {
  return (
    Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 &&
    Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2
  );
}

/** A surface a text sits on: it has a border or a painted face. */
function isSurface(el: Element): boolean {
  const style = getComputedStyle(el);
  const painted =
    style.backgroundImage !== "none" ||
    (style.backgroundColor !== "rgba(0, 0, 0, 0)" && style.backgroundColor !== "transparent");
  const bordered = ["Top", "Right", "Bottom", "Left"].some(
    (side) =>
      parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0 &&
      style.getPropertyValue(`border-${side.toLowerCase()}-style`) !== "none",
  );
  return painted || bordered;
}

/**
 * Whether `el` lies outside a box that scrolls or clips it (an ancestor with `overflow` other than
 * visible): it is scrolled away there, and the box is where a real clipping is reported.
 */
function outsideItsScroller(el: Element, rect: DOMRect): boolean {
  for (let at = el.parentElement; at !== null && at !== document.body; at = at.parentElement) {
    const style = getComputedStyle(at);
    if (style.overflowY === "visible" && style.overflowX === "visible") continue;
    const box = at.getBoundingClientRect();
    // Scrolled away: below or above a box that scrolls (or clips) vertically. Sideways is never
    // a scroll the operator has: a control cut at the side is a defect.
    if (rect.bottom > box.bottom + TOLERANCE || rect.top < box.top - TOLERANCE) return true;
  }
  return false;
}

/** The nearest box that hides or scrolls its overflow and cuts `rect` at a side, if any. */
function cutSideways(el: Element, rect: DOMRect): Element | null {
  for (let at = el.parentElement; at !== null && at !== document.body; at = at.parentElement) {
    const style = getComputedStyle(at);
    if (style.overflowX === "visible") continue;
    const box = at.getBoundingClientRect();
    if (rect.right > box.right + TOLERANCE || rect.left < box.left - TOLERANCE) return at;
  }
  return null;
}

export function measureFit(): FitResult {
  const problems: string[] = [];
  const doc = document.documentElement;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (doc.scrollHeight - doc.clientHeight > 0)
    problems.push(`page scrolls vertically by ${doc.scrollHeight - doc.clientHeight}px`);
  if (doc.scrollWidth - doc.clientWidth > 0)
    problems.push(`page scrolls sideways by ${doc.scrollWidth - doc.clientWidth}px`);

  // Controls: size, position, not covered.
  // With a modal open, what is behind it is inert: only the modal's own controls are judged.
  const modal = [...document.querySelectorAll("[role=dialog], [aria-modal=true]")].find(visible);
  const allControls = [...document.querySelectorAll(CONTROLS)]
    .filter(visible)
    .filter((el) => modal === undefined || modal.contains(el));
  let scrolledAway = 0;
  const controls: Element[] = [];
  for (const el of allControls) {
    if (outsideItsScroller(el, el.getBoundingClientRect())) scrolledAway += 1;
    else controls.push(el);
  }
  for (const el of controls) {
    const rect = el.getBoundingClientRect();
    if (el.matches("input[type=file], input[type=hidden]")) continue;
    // A radio or a switch drawn inside a larger labelled row is measured as that row.
    const target = el.matches("input[type=radio], input[type=checkbox]")
      ? (el.closest("label") ?? el)
      : el;
    const box = target.getBoundingClientRect();
    if (box.height < MIN_TARGET - 0.5 || box.width < MIN_TARGET - 0.5)
      problems.push(
        `target under 64px: ${label(el)} ${Math.round(box.width)}x${Math.round(box.height)}`,
      );
    const cutBy = cutSideways(el, rect);
    if (cutBy !== null) problems.push(`control cut at the side: ${label(el)} by ${label(cutBy)}`);
    if (
      rect.left < -TOLERANCE ||
      rect.top < -TOLERANCE ||
      rect.right > vw + TOLERANCE ||
      rect.bottom > vh + TOLERANCE
    )
      problems.push(
        `control outside the window: ${label(el)} (${Math.round(rect.left)},${Math.round(rect.top)})-(${Math.round(rect.right)},${Math.round(rect.bottom)}) in ${vw}x${vh}`,
      );
    else {
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (hit !== null && hit !== el && !el.contains(hit) && !hit.contains(el))
        problems.push(`control covered: ${label(el)} by ${label(hit)}`);
    }
  }
  for (const el of document.querySelectorAll(".floor-primary")) {
    if (!visible(el)) continue;
    const height = el.getBoundingClientRect().height;
    // The hub card's action is the one documented smaller primary: 64 px on a window of 700 px or less.
    const cardAction = el.classList.contains("shift-card__action") && vh <= 700;
    const want = cardAction ? 63.5 : vh >= 900 ? 83.5 : 71.5;
    if (height < want)
      problems.push(
        `primary under ${cardAction ? 64 : vh >= 900 ? 84 : 72}px: ${label(el)} ${height}`,
      );
  }

  // Clipping: boxes that hide their overflow hold their content.
  const scrollers: string[] = [];
  for (const el of document.body.querySelectorAll("*")) {
    if (el instanceof SVGElement || !visible(el)) continue;
    // The sign-in's word mark is cropped on purpose below 1100 px (the mark alone stays).
    if (el.hasAttribute("data-fit-decorative-crop")) continue;
    const style = getComputedStyle(el);
    const hidesX = style.overflowX === "hidden" || style.overflowX === "clip";
    const hidesY = style.overflowY === "hidden" || style.overflowY === "clip";
    if (style.overflowY === "auto" || style.overflowY === "scroll") {
      if (el.scrollHeight - el.clientHeight > 1) scrollers.push(label(el));
      continue;
    }
    if (!hidesX && !hidesY) continue;
    const overX = hidesX && el.scrollWidth - el.clientWidth > TOLERANCE;
    const oneLine = style.textOverflow === "ellipsis" && style.whiteSpace === "nowrap";
    // A one-line ellipsis box is judged by its width: a glyph box a hair taller than the line is no clip.
    // A line box a hair taller than its row (two px: a font's metrics) is no clip.
    const overY = hidesY && !oneLine && el.scrollHeight - el.clientHeight > 2;
    if (!overX && !overY) continue;
    const clamp = (name: string) => {
      const value = style.getPropertyValue(name);
      return value !== "" && value !== "none";
    };
    const truncating =
      style.textOverflow === "ellipsis" || clamp("-webkit-line-clamp") || clamp("line-clamp");
    if (truncating) {
      if (!hasTitle(el)) problems.push(`truncated without a title: ${label(el)}`);
      continue;
    }
    problems.push(
      `clipped: ${label(el)} content ${el.scrollWidth}x${el.scrollHeight} in ${el.clientWidth}x${el.clientHeight}`,
    );
  }

  // Texts: inside their surfaces, never over each other or over a control that is not theirs.
  const texts: { el: Element; box: DOMRect; lines: DOMRect[] }[] = [];
  for (const el of document.body.querySelectorAll("*")) {
    if (el instanceof SVGElement || !visible(el)) continue;
    if (el.closest("[aria-hidden=true]") !== null) continue;
    if (modal !== undefined && !modal.contains(el)) continue;
    const found = textLines(el);
    if (found === null) continue;
    if (outsideItsScroller(el, found.box)) continue;
    // A glyph box is taller than the line box of a tight `line-height` (a figure at `line-height: 1`):
    // lines are compared by their line boxes, the space the layout gave them.
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight);
    // What a box that hides its overflow cuts off (an ellipsis, a clamped line) is not drawn: not text.
    // Every ancestor that hides its overflow counts, the element's own box included.
    const hiders: DOMRect[] = [];
    for (let at: Element | null = el; at !== null && at !== document.body; at = at.parentElement) {
      const style = getComputedStyle(at);
      if (
        ["hidden", "clip"].includes(style.overflowX) ||
        ["hidden", "clip"].includes(style.overflowY)
      )
        hiders.push(at.getBoundingClientRect());
    }
    const lines: DOMRect[] = [];
    for (const raw of found.lines) {
      let line =
        Number.isFinite(lineHeight) && raw.height > lineHeight && raw.height < lineHeight * 1.6
          ? new DOMRect(raw.x, raw.y + (raw.height - lineHeight) / 2, raw.width, lineHeight)
          : raw;
      for (const box of hiders) {
        const left = Math.max(line.left, box.left);
        const right = Math.min(line.right, box.right);
        const top = Math.max(line.top, box.top);
        const bottom = Math.min(line.bottom, box.bottom);
        line = new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
      }
      if (line.width > 1 && line.height > 1) lines.push(line);
    }
    if (lines.length === 0) continue;
    const box = lines.reduce(
      (all, line) =>
        new DOMRect(
          Math.min(all.left, line.left),
          Math.min(all.top, line.top),
          Math.max(all.right, line.right) - Math.min(all.left, line.left),
          Math.max(all.bottom, line.bottom) - Math.min(all.top, line.top),
        ),
      lines[0] as DOMRect,
    );
    texts.push({ el, box, lines });
  }
  for (const { el, box } of texts) {
    if (box.left < -TOLERANCE || box.right > vw + TOLERANCE || box.bottom > vh + TOLERANCE)
      problems.push(`text outside the window: ${label(el)}`);
    let at = el.parentElement;
    for (
      let up = 0;
      up < 6 && at !== null && at !== document.body;
      up += 1, at = at.parentElement
    ) {
      if (!isSurface(at)) continue;
      const surface = at.getBoundingClientRect();
      if (
        box.left < surface.left - TOLERANCE ||
        box.right > surface.right + TOLERANCE ||
        box.top < surface.top - TOLERANCE ||
        box.bottom > surface.bottom + TOLERANCE
      ) {
        problems.push(`text spills out of its box: ${label(el)} out of ${label(at)}`);
        break;
      }
    }
  }
  for (let i = 0; i < texts.length; i += 1) {
    const a = texts[i];
    if (a === undefined) continue;
    for (let j = i + 1; j < texts.length; j += 1) {
      const b = texts[j];
      if (b === undefined) continue;
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      if (a.lines.some((x) => b.lines.some((y) => overlaps(x, y))))
        problems.push(`texts overlap: ${label(a.el)} and ${label(b.el)}`);
    }
    for (const control of controls) {
      if (control.contains(a.el) || a.el.contains(control)) continue;
      if (control.matches("input")) continue;
      const controlBox = control.getBoundingClientRect();
      if (a.lines.some((line) => overlaps(line, controlBox)))
        problems.push(`text over a control: ${label(a.el)} and ${label(control)}`);
    }
  }

  // The keypad and the footer.
  const keypadEl = document.querySelector(
    "[data-keypad], .floor-numeric-keypad, .floor-ip-keypad, .floor-keypad",
  );
  let keypad: FitResult["keypad"] = null;
  if (keypadEl !== null && visible(keypadEl)) {
    const rect = keypadEl.getBoundingClientRect();
    keypad = {
      top: Math.round(rect.top),
      bottom: Math.round(rect.bottom),
      keys: keypadEl.querySelectorAll("button").length,
    };
    if (rect.bottom > vh + TOLERANCE || rect.top < -TOLERANCE || rect.right > vw + TOLERANCE)
      problems.push(`keypad outside the window: ${keypad.top}-${keypad.bottom} in ${vh}`);
  }
  const footerEl = document.querySelector(".station-floor-footer, .workstation-setup__footer");
  let footer: FitResult["footer"] = null;
  if (footerEl !== null && visible(footerEl)) {
    const rect = footerEl.getBoundingClientRect();
    footer = { top: Math.round(rect.top), bottom: Math.round(rect.bottom) };
    if (rect.bottom > vh + TOLERANCE)
      problems.push(`footer past the window by ${Math.round(rect.bottom - vh)}px`);
    for (const control of controls) {
      if (footerEl.contains(control)) continue;
      const box = control.getBoundingClientRect();
      if (box.bottom > rect.top + TOLERANCE && box.top < rect.bottom && overlaps(box, rect))
        problems.push(`footer overlaps content: ${label(control)}`);
    }
  }

  return {
    problems: [...new Set(problems)],
    controls: controls.length,
    scrolledAway,
    texts: texts.length,
    scrollers,
    keypad,
    footer,
  };
}
