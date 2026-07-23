/**
 * Plan 04 Task 9: label editor canvas core.
 *
 * Covers the PURE parts directly (per the task brief: canvas 2D drawing
 * itself cannot be pixel-tested under jsdom -- `HTMLCanvasElement.
 * prototype.getContext("2d")` returns `null` there, same constraint as
 * `labels/rasterizer.ts`, see `labels-raster.test.ts`):
 *  - `elementBoundsMm` (renderer.ts): the documented geometry heuristic, one
 *    vector per element kind.
 *  - `hitTest` (LabelCanvas.tsx): topmost-wins, miss -> null, mm coordinates.
 *  - `editorReducer` (useEditorState.ts): every action, undo/redo, the
 *    history cap, and selection-clears-on-remove.
 *  - `LabelCanvas` itself, rendered together with the REAL `useEditorState`
 *    hook (a small local harness component) so keyboard nudge/Delete are
 *    asserted as actual state changes flowing hook -> component -> back to
 *    the hook, not just "a callback was called".
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { sampleLabelData, type LabelElement, type LabelTemplateSpec } from "@markiro/domain";

import { DEFAULT_SCALE, hitTest, LabelCanvas } from "../src/pages/labels/editor/LabelCanvas.js";
import { elementBoundsMm } from "../src/pages/labels/editor/renderer.js";
import {
  createEditorState,
  editorReducer,
  HISTORY_CAP,
  useEditorState,
  type EditorState,
} from "../src/pages/labels/editor/useEditorState.js";

afterEach(() => {
  cleanup();
});

const PT_TO_MM = 25.4 / 72;
/** Same ratios documented in renderer.ts's `elementBoundsMm` -- recomputed
 * independently here (not imported) so these tests actually pin the
 * documented heuristic's numeric behavior, not just "whatever the code
 * currently does". */
const AVG_CHAR_WIDTH_EM = 0.55;
const LINE_HEIGHT_EM = 1.5;
const BAR_WIDTH_PER_CHAR_FACTOR = 0.7;
const TOTAL_MODULES = 24; // 20 interior + 2*2 quiet zone, per renderer.ts

function textWidthMm(text: string, fontSizePt: number): number {
  return Math.max(text.length, 1) * fontSizePt * PT_TO_MM * AVG_CHAR_WIDTH_EM;
}
function textHeightMm(fontSizePt: number): number {
  return fontSizePt * PT_TO_MM * LINE_HEIGHT_EM;
}

function makeSpec(elements: LabelElement[]): LabelTemplateSpec {
  return { widthMm: 100, heightMm: 100, dpi: 203, language: "zpl", elements };
}

describe("elementBoundsMm", () => {
  it("text: width from char-count heuristic, height from line-height heuristic", () => {
    const bounds = elementBoundsMm({
      kind: "text",
      id: "t1",
      xMm: 5,
      yMm: 7,
      text: "Hello",
      fontSizePt: 12,
    });
    expect(bounds.x).toBe(5);
    expect(bounds.y).toBe(7);
    expect(bounds.w).toBeCloseTo(textWidthMm("Hello", 12), 6);
    expect(bounds.h).toBeCloseTo(textHeightMm(12), 6);
  });

  it("text: an explicit maxWidthMm overrides the heuristic width", () => {
    const bounds = elementBoundsMm({
      kind: "text",
      id: "t1",
      xMm: 0,
      yMm: 0,
      text: "A very long line of text",
      fontSizePt: 10,
      maxWidthMm: 30,
    });
    expect(bounds.w).toBe(30);
  });

  it("field: measures the field's sampleLabelData() value (no literal text on the element itself)", () => {
    const sampleText = sampleLabelData()["product.name"];
    const bounds = elementBoundsMm({
      kind: "field",
      id: "f1",
      xMm: 2,
      yMm: 3,
      field: "product.name",
      fontSizePt: 10,
    });
    expect(bounds.w).toBeCloseTo(textWidthMm(sampleText, 10), 6);
    expect(bounds.h).toBeCloseTo(textHeightMm(10), 6);
  });

  it("barcode (code128/ean13, literal data): height = sizeMm, width from char-count heuristic", () => {
    const bounds = elementBoundsMm({
      kind: "barcode",
      id: "b1",
      xMm: 1,
      yMm: 2,
      format: "code128",
      data: { literal: "12345" },
      sizeMm: 10,
    });
    expect(bounds.h).toBe(10);
    expect(bounds.w).toBeCloseTo(Math.max("12345".length, 1) * BAR_WIDTH_PER_CHAR_FACTOR * 10, 6);
  });

  it("barcode (ean13, field-bound data): measures sampleLabelData() for that field", () => {
    const sampleText = sampleLabelData().sscc;
    const bounds = elementBoundsMm({
      kind: "barcode",
      id: "b2",
      xMm: 0,
      yMm: 0,
      format: "ean13",
      data: "sscc",
      sizeMm: 8,
    });
    expect(bounds.w).toBeCloseTo(Math.max(sampleText.length, 1) * BAR_WIDTH_PER_CHAR_FACTOR * 8, 6);
  });

  it("barcode (datamatrix/qr): square bounds = TOTAL_MODULES * sizeMm (module square side)", () => {
    const bounds = elementBoundsMm({
      kind: "barcode",
      id: "b3",
      xMm: 4,
      yMm: 4,
      format: "datamatrix",
      data: "km.code",
      sizeMm: 0.5,
    });
    expect(bounds.w).toBeCloseTo(TOTAL_MODULES * 0.5, 6);
    expect(bounds.h).toBeCloseTo(TOTAL_MODULES * 0.5, 6);

    const qrBounds = elementBoundsMm({
      kind: "barcode",
      id: "b4",
      xMm: 0,
      yMm: 0,
      format: "qr",
      data: { literal: "https://example.com" },
      sizeMm: 0.4,
    });
    expect(qrBounds.w).toBeCloseTo(TOTAL_MODULES * 0.4, 6);
  });

  it("line: bounding box from endpoints, clamped to thicknessMm on a degenerate axis", () => {
    // Perfectly horizontal: y-span is 0, must clamp up to thicknessMm.
    const horizontal = elementBoundsMm({
      kind: "line",
      id: "l1",
      xMm: 10,
      yMm: 20,
      x2Mm: 40,
      y2Mm: 20,
      thicknessMm: 0.6,
    });
    expect(horizontal).toEqual({ x: 10, y: 20, w: 30, h: 0.6 });

    // A genuinely diagonal line still gets its bounding rectangle.
    const diagonal = elementBoundsMm({
      kind: "line",
      id: "l2",
      xMm: 5,
      yMm: 5,
      x2Mm: 0,
      y2Mm: 15,
      thicknessMm: 0.2,
    });
    expect(diagonal).toEqual({ x: 0, y: 5, w: 5, h: 10 });
  });

  it("box: bounds are the element's own literal x/y/width/height", () => {
    const bounds = elementBoundsMm({
      kind: "box",
      id: "bx1",
      xMm: 1,
      yMm: 2,
      widthMm: 20,
      heightMm: 15,
      thicknessMm: 0.5,
    });
    expect(bounds).toEqual({ x: 1, y: 2, w: 20, h: 15 });
  });
});

describe("hitTest", () => {
  it("returns null for a point that misses every element", () => {
    const spec = makeSpec([
      { kind: "box", id: "bx1", xMm: 0, yMm: 0, widthMm: 10, heightMm: 10, thicknessMm: 0.5 },
    ]);
    expect(hitTest(spec, 50, 50)).toBeNull();
  });

  it("resolves in millimetre coordinates (a point inside one element's box, outside the other's)", () => {
    const spec = makeSpec([
      { kind: "box", id: "left", xMm: 0, yMm: 0, widthMm: 10, heightMm: 10, thicknessMm: 0.5 },
      { kind: "box", id: "right", xMm: 50, yMm: 50, widthMm: 10, heightMm: 10, thicknessMm: 0.5 },
    ]);
    expect(hitTest(spec, 5, 5)).toBe("left");
    expect(hitTest(spec, 55, 55)).toBe("right");
    expect(hitTest(spec, 25, 25)).toBeNull();
  });

  it("topmost element (last in the array) wins when boxes overlap", () => {
    const spec = makeSpec([
      { kind: "box", id: "back", xMm: 0, yMm: 0, widthMm: 20, heightMm: 20, thicknessMm: 0.5 },
      { kind: "box", id: "front", xMm: 5, yMm: 5, widthMm: 20, heightMm: 20, thicknessMm: 0.5 },
    ]);
    // (10, 10) is inside BOTH boxes -- "front" (drawn last / on top) must win.
    expect(hitTest(spec, 10, 10)).toBe("front");
    // (2, 2) is inside "back" only.
    expect(hitTest(spec, 2, 2)).toBe("back");
  });
});

describe("editorReducer", () => {
  function specWithBox(id = "bx1"): LabelTemplateSpec {
    return makeSpec([
      { kind: "box", id, xMm: 10, yMm: 10, widthMm: 20, heightMm: 20, thicknessMm: 1 },
    ]);
  }

  it("select: sets selectedId, does not touch history (selection is ephemeral)", () => {
    const state = createEditorState(specWithBox());
    const next = editorReducer(state, { type: "select", id: "bx1" });
    expect(next.selectedId).toBe("bx1");
    expect(next.history).toHaveLength(0);

    const cleared = editorReducer(next, { type: "select", id: null });
    expect(cleared.selectedId).toBeNull();
    expect(cleared.history).toHaveLength(0);
  });

  it("moveBy: shifts and grid-snaps to the nearest whole millimetre", () => {
    const state = createEditorState(specWithBox());
    const next = editorReducer(state, { type: "moveBy", id: "bx1", dxMm: 0.6, dyMm: -0.2 });
    const el = next.spec.elements[0]!;
    expect(el.xMm).toBe(Math.round(10 + 0.6));
    expect(el.yMm).toBe(Math.round(10 - 0.2));
    expect(next.history).toEqual([state.spec]);
  });

  it("moveBy: translates a line's second endpoint by the same delta (preserves length/direction)", () => {
    const spec = makeSpec([
      { kind: "line", id: "l1", xMm: 10, yMm: 10, x2Mm: 30, y2Mm: 10, thicknessMm: 0.5 },
    ]);
    const state = createEditorState(spec);
    const next = editorReducer(state, { type: "moveBy", id: "l1", dxMm: 5, dyMm: 5 });
    const el = next.spec.elements[0] as Extract<LabelElement, { kind: "line" }>;
    expect(el.xMm).toBe(15);
    expect(el.yMm).toBe(15);
    expect(el.x2Mm).toBe(35);
    expect(el.y2Mm).toBe(15);
  });

  it("moveBy: no-op (state unchanged, no history push) for an unknown id", () => {
    const state = createEditorState(specWithBox());
    const next = editorReducer(state, { type: "moveBy", id: "missing", dxMm: 1, dyMm: 1 });
    expect(next).toBe(state);
  });

  it("setElement: merges a patch into the matching element", () => {
    const state = createEditorState(specWithBox());
    const next = editorReducer(state, { type: "setElement", id: "bx1", patch: { widthMm: 40 } });
    const el = next.spec.elements[0] as Extract<LabelElement, { kind: "box" }>;
    expect(el.widthMm).toBe(40);
    expect(el.heightMm).toBe(20); // untouched fields survive the merge
    expect(next.history).toEqual([state.spec]);
  });

  it("setElement: no-op for an unknown id", () => {
    const state = createEditorState(specWithBox());
    const next = editorReducer(state, { type: "setElement", id: "missing", patch: { xMm: 99 } });
    expect(next).toBe(state);
  });

  it("addElement: appends (topmost) and selects the new element", () => {
    const state = createEditorState(specWithBox());
    const newEl: LabelElement = {
      kind: "text",
      id: "t2",
      xMm: 0,
      yMm: 0,
      text: "New",
      fontSizePt: 10,
    };
    const next = editorReducer(state, { type: "addElement", element: newEl });
    expect(next.spec.elements).toHaveLength(2);
    expect(next.spec.elements[1]).toEqual(newEl);
    expect(next.selectedId).toBe("t2");
    expect(next.history).toEqual([state.spec]);
  });

  it("removeElement: removes the element and clears selection when it was selected", () => {
    let state = createEditorState(specWithBox());
    state = editorReducer(state, { type: "select", id: "bx1" });
    const next = editorReducer(state, { type: "removeElement", id: "bx1" });
    expect(next.spec.elements).toHaveLength(0);
    expect(next.selectedId).toBeNull();
  });

  it("removeElement: leaves an unrelated selection alone", () => {
    let state = createEditorState(
      makeSpec([
        { kind: "box", id: "a", xMm: 0, yMm: 0, widthMm: 5, heightMm: 5, thicknessMm: 0.5 },
        { kind: "box", id: "b", xMm: 10, yMm: 10, widthMm: 5, heightMm: 5, thicknessMm: 0.5 },
      ]),
    );
    state = editorReducer(state, { type: "select", id: "b" });
    const next = editorReducer(state, { type: "removeElement", id: "a" });
    expect(next.selectedId).toBe("b");
    expect(next.spec.elements.map((e) => e.id)).toEqual(["b"]);
  });

  it("removeElement: no-op for an unknown id", () => {
    const state = createEditorState(specWithBox());
    const next = editorReducer(state, { type: "removeElement", id: "missing" });
    expect(next).toBe(state);
  });

  it("replaceSpec: swaps the whole spec, pushes the old one onto history, clears a now-invalid selection", () => {
    let state = createEditorState(specWithBox());
    state = editorReducer(state, { type: "select", id: "bx1" });
    const freshSpec = makeSpec([]);
    const next = editorReducer(state, { type: "replaceSpec", spec: freshSpec });
    expect(next.spec).toBe(freshSpec);
    expect(next.selectedId).toBeNull();
    expect(next.history).toEqual([state.spec]);
  });

  it("undo/redo: undo restores the previous spec, redo re-applies the undone one", () => {
    const state = createEditorState(specWithBox());
    const afterMove = editorReducer(state, { type: "moveBy", id: "bx1", dxMm: 1, dyMm: 0 });
    const afterUndo = editorReducer(afterMove, { type: "undo" });
    expect(afterUndo.spec).toEqual(state.spec);
    expect(afterUndo.history).toHaveLength(0);
    expect(afterUndo.future).toEqual([afterMove.spec]);

    const afterRedo = editorReducer(afterUndo, { type: "redo" });
    expect(afterRedo.spec).toEqual(afterMove.spec);
    expect(afterRedo.future).toHaveLength(0);
    expect(afterRedo.history).toEqual([state.spec]);
  });

  it("undo: no-op when history is empty", () => {
    const state = createEditorState(specWithBox());
    const next = editorReducer(state, { type: "undo" });
    expect(next).toBe(state);
  });

  it("redo: no-op when future is empty", () => {
    const state = createEditorState(specWithBox());
    const next = editorReducer(state, { type: "redo" });
    expect(next).toBe(state);
  });

  it("undo: clears a selection that only existed on the spec being undone away from", () => {
    let state = createEditorState(specWithBox());
    const newEl: LabelElement = {
      kind: "text",
      id: "t2",
      xMm: 0,
      yMm: 0,
      text: "New",
      fontSizePt: 10,
    };
    state = editorReducer(state, { type: "addElement", element: newEl }); // selects t2
    expect(state.selectedId).toBe("t2");
    const undone = editorReducer(state, { type: "undo" });
    // t2 doesn't exist in the pre-addElement spec any more.
    expect(undone.selectedId).toBeNull();
  });

  it("a new mutating action after undo clears the redo (future) stack", () => {
    const state = createEditorState(specWithBox());
    const afterMove = editorReducer(state, { type: "moveBy", id: "bx1", dxMm: 1, dyMm: 0 });
    const afterUndo = editorReducer(afterMove, { type: "undo" });
    expect(afterUndo.future).toHaveLength(1);
    const afterAnotherMove = editorReducer(afterUndo, {
      type: "moveBy",
      id: "bx1",
      dxMm: 2,
      dyMm: 0,
    });
    expect(afterAnotherMove.future).toHaveLength(0);
  });

  it("history is capped at HISTORY_CAP (50): oldest entries drop off first", () => {
    let state = createEditorState(specWithBox());
    const specsPushed: LabelTemplateSpec[] = [];
    for (let i = 0; i < HISTORY_CAP + 10; i++) {
      specsPushed.push(state.spec);
      state = editorReducer(state, { type: "moveBy", id: "bx1", dxMm: 1, dyMm: 0 });
    }
    expect(state.history).toHaveLength(HISTORY_CAP);
    // The retained history is exactly the LAST HISTORY_CAP pushed specs
    // (the oldest 10 were evicted), oldest-of-the-retained-window first.
    expect(state.history).toEqual(specsPushed.slice(specsPushed.length - HISTORY_CAP));

    // Undoing HISTORY_CAP times empties history; one more undo is a no-op
    // (can't recover the evicted specs).
    let undone: EditorState = state;
    for (let i = 0; i < HISTORY_CAP; i++) {
      undone = editorReducer(undone, { type: "undo" });
    }
    expect(undone.history).toHaveLength(0);
    const oneMoreUndo = editorReducer(undone, { type: "undo" });
    expect(oneMoreUndo).toBe(undone);
  });
});

describe("LabelCanvas (rendered through the real useEditorState hook)", () => {
  /** Test-local harness: wires the real hook to the real component, and
   * surfaces state as text so assertions don't need to reach into React
   * internals -- mirrors the `LocationTracker` pattern used elsewhere in
   * this suite (see shell-layout.test.tsx). */
  function Harness({ initialSpec }: { initialSpec: LabelTemplateSpec }) {
    const { state, select, moveBy, removeElement } = useEditorState(initialSpec);
    return (
      <div>
        <LabelCanvas
          spec={state.spec}
          selectedId={state.selectedId}
          onSelect={select}
          onMoveBy={moveBy}
          onDelete={removeElement}
        />
        <div data-testid="selected-id">{state.selectedId ?? ""}</div>
        <div data-testid="elements-json">{JSON.stringify(state.spec.elements)}</div>
      </div>
    );
  }

  function renderHarness() {
    const spec = makeSpec([
      { kind: "box", id: "box1", xMm: 10, yMm: 10, widthMm: 20, heightMm: 20, thicknessMm: 1 },
    ]);
    const utils = render(<Harness initialSpec={spec} />);
    const canvas = utils.container.querySelector("canvas")!;
    return { ...utils, canvas };
  }

  function readElements(): Array<{ xMm: number; yMm: number }> {
    return JSON.parse(screen.getByTestId("elements-json").textContent!) as Array<{
      xMm: number;
      yMm: number;
    }>;
  }

  it("renders a canvas sized from spec.widthMm/heightMm at the default scale, without throwing under jsdom's ctx-less canvas", () => {
    const { canvas } = renderHarness();
    expect(canvas).toBeTruthy();
    expect(canvas.width).toBe(100 * DEFAULT_SCALE);
    expect(canvas.height).toBe(100 * DEFAULT_SCALE);
  });

  it("mouse-selects the element under the click (hit-test in mm, jsdom's getBoundingClientRect is origin-zero)", () => {
    const { canvas } = renderHarness();
    fireEvent.mouseDown(canvas, { clientX: 15 * DEFAULT_SCALE, clientY: 15 * DEFAULT_SCALE });
    expect(screen.getByTestId("selected-id").textContent).toBe("box1");
  });

  it("clicking empty canvas area deselects", () => {
    const { canvas } = renderHarness();
    fireEvent.mouseDown(canvas, { clientX: 15 * DEFAULT_SCALE, clientY: 15 * DEFAULT_SCALE });
    expect(screen.getByTestId("selected-id").textContent).toBe("box1");

    fireEvent.mouseDown(canvas, { clientX: 90 * DEFAULT_SCALE, clientY: 90 * DEFAULT_SCALE });
    expect(screen.getByTestId("selected-id").textContent).toBe("");
  });

  it("keyboard arrows nudge the selected element by 1mm through the real reducer", () => {
    const { canvas } = renderHarness();
    fireEvent.mouseDown(canvas, { clientX: 15 * DEFAULT_SCALE, clientY: 15 * DEFAULT_SCALE });
    expect(screen.getByTestId("selected-id").textContent).toBe("box1");

    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    expect(readElements()[0]).toMatchObject({ xMm: 11, yMm: 10 });

    fireEvent.keyDown(canvas, { key: "ArrowDown" });
    expect(readElements()[0]).toMatchObject({ xMm: 11, yMm: 11 });
  });

  it("Shift+arrow nudges by 5mm", () => {
    const { canvas } = renderHarness();
    fireEvent.mouseDown(canvas, { clientX: 15 * DEFAULT_SCALE, clientY: 15 * DEFAULT_SCALE });

    fireEvent.keyDown(canvas, { key: "ArrowUp", shiftKey: true });
    expect(readElements()[0]).toMatchObject({ xMm: 10, yMm: 5 });
  });

  it("does nothing on arrow keys when nothing is selected", () => {
    const { canvas } = renderHarness();
    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    expect(readElements()[0]).toMatchObject({ xMm: 10, yMm: 10 });
  });

  it("Delete removes the selected element and clears the selection", () => {
    const { canvas } = renderHarness();
    fireEvent.mouseDown(canvas, { clientX: 15 * DEFAULT_SCALE, clientY: 15 * DEFAULT_SCALE });
    expect(screen.getByTestId("selected-id").textContent).toBe("box1");

    fireEvent.keyDown(canvas, { key: "Delete" });
    expect(screen.getByTestId("selected-id").textContent).toBe("");
    expect(readElements()).toHaveLength(0);
  });
});
