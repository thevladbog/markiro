import { describe, expect, it } from "vitest";

import { sampleLabelData, type LabelElement, type LabelTemplateSpec } from "@markiro/domain";

import { fitElementWithinLabel, fitSpecElements } from "../src/office/templates/label-geometry.js";

const DATA = sampleLabelData();

/** A 20 × 10 mm box: its bounds are its own size. */
function box(
  id: string,
  xMm: number,
  yMm: number,
  size: { widthMm?: number; heightMm?: number } = {},
): LabelElement {
  const { widthMm = 20, heightMm = 10 } = size;
  return { kind: "box", id, xMm, yMm, widthMm, heightMm, thicknessMm: 0.5 };
}

function spec(elements: LabelElement[], widthMm = 58, heightMm = 40): LabelTemplateSpec {
  return { widthMm, heightMm, dpi: 203, language: "zpl", elements };
}

describe("fitting a layout inside its label", () => {
  it("leaves an element that fits where it is", () => {
    const element = box("a", 2, 3);
    expect(fitElementWithinLabel(element, spec([]), DATA, {})).toStrictEqual({
      ok: true,
      element,
      adjusted: false,
    });
  });

  it("slides an element back over the edges it hangs across", () => {
    expect(fitElementWithinLabel(box("a", 50, -4), spec([]), DATA, {})).toStrictEqual({
      ok: true,
      element: box("a", 38, 0),
      adjusted: true,
    });
  });

  it("moves both ends of a line by the same amount", () => {
    const line: LabelElement = {
      kind: "line",
      id: "l",
      xMm: 50,
      yMm: 5,
      x2Mm: 70,
      y2Mm: 5,
      thicknessMm: 0.5,
    };
    const fit = fitElementWithinLabel(line, spec([]), DATA, {});
    expect(fit.ok).toBe(true);
    if (!fit.ok) return;
    expect(fit.element).toMatchObject({ xMm: 38, x2Mm: 58, yMm: 5, y2Mm: 5 });
  });

  it("moves both ends of an upright line over the top edge by the same amount", () => {
    const line: LabelElement = {
      kind: "line",
      id: "l",
      xMm: 5,
      yMm: -3,
      x2Mm: 5,
      y2Mm: 17,
      thicknessMm: 0.5,
    };
    const fit = fitElementWithinLabel(line, spec([]), DATA, {});
    expect(fit.ok).toBe(true);
    if (!fit.ok) return;
    expect(fit.element).toMatchObject({ xMm: 5, x2Mm: 5, yMm: 0, y2Mm: 20 });
  });

  it("forgives the float noise of a sum of millimetres, and no more than that", () => {
    const noisy: LabelElement = box("a", 38 + 1e-10, 3);
    expect(fitElementWithinLabel(noisy, spec([]), DATA, {})).toStrictEqual({
      ok: true,
      element: noisy,
      adjusted: false,
    });
    const slightlyWide: LabelElement = box("a", 0, 0, { widthMm: 20 + 1e-10 });
    expect(fitElementWithinLabel(slightlyWide, spec([], 20, 40), DATA, {}).ok).toBe(true);
    const tooWide: LabelElement = box("a", 0, 0, { widthMm: 20 + 1e-8 });
    expect(fitElementWithinLabel(tooWide, spec([], 20, 40), DATA, {})).toStrictEqual({ ok: false });
    const slightlyTall: LabelElement = box("a", 0, 0, { heightMm: 10 + 1e-8 });
    expect(fitElementWithinLabel(slightlyTall, spec([], 58, 10), DATA, {})).toStrictEqual({
      ok: false,
    });
  });

  it("refuses a label that has no finite positive size, even an empty one", () => {
    for (const [widthMm, heightMm] of [
      [0, 40],
      [58, 0],
      [-58, 40],
      [58, -40],
      [Number.NaN, 40],
      [58, Number.NaN],
      [Number.POSITIVE_INFINITY, 40],
      [58, Number.POSITIVE_INFINITY],
    ] as const) {
      expect(fitSpecElements(spec([], widthMm, heightMm), DATA, {})).toStrictEqual({ ok: false });
      expect(fitElementWithinLabel(box("a", 2, 3), { widthMm, heightMm }, DATA, {})).toStrictEqual({
        ok: false,
      });
    }
  });

  it("refuses an element larger than the label instead of shrinking it", () => {
    expect(fitElementWithinLabel(box("a", 0, 0), spec([], 15, 40), DATA, {})).toStrictEqual({
      ok: false,
    });
  });

  it("fits a whole layout and names the elements it moved", () => {
    expect(fitSpecElements(spec([box("a", 2, 3), box("b", 45, 35)]), DATA, {})).toStrictEqual({
      ok: true,
      spec: spec([box("a", 2, 3), box("b", 38, 30)]),
      adjustedIds: ["b"],
    });
  });

  it("refuses the whole layout when one element does not fit", () => {
    expect(fitSpecElements(spec([box("a", 2, 3), box("b", 0, 0)], 58, 8), DATA, {})).toStrictEqual({
      ok: false,
    });
  });
});
