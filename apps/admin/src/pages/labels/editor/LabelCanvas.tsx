/**
 * Plan 04 Task 9: label editor canvas core -- interactive `<canvas>`.
 *
 * Deliberately holds NO editor state itself (no undo/redo, no spec
 * mutation): `spec`/`selectedId` are props, and every user interaction is
 * reported upward via callbacks (`onSelect`/`onMoveBy`/`onDelete`). This
 * lets the component compose with `useEditorState` (via the callbacks
 * matching that hook's `select`/`moveBy`/`removeElement` signatures
 * exactly) or with any other state owner -- e.g. a future read-only
 * preview that never mutates anything -- without a hard dependency on the
 * reducer. Task 10 wires this component and `useEditorState` together in
 * the actual editor page; per this task's brief, no route is wired yet.
 */
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";

import { sampleLabelData, type LabelField, type LabelTemplateSpec } from "@markiro/domain";

import { draw, drawSelectionOutline, elementBoundsMm } from "./renderer.js";

/** Default canvas scale: pixels rendered per physical millimetre. */
export const DEFAULT_SCALE = 4;
const NUDGE_MM = 1;
const NUDGE_MM_SHIFT = 5;

/**
 * Pure hit-test: which element (if any) sits under `(xMm, yMm)`. Elements
 * later in `spec.elements` are drawn ON TOP of earlier ones (see
 * `renderer.ts`'s `draw`, which paints them in array order), so this walks
 * back-to-front and returns the FIRST match -- the topmost element under
 * the point, per the plan brief's "topmost element wins" requirement --
 * rather than the first match walking front-to-back.
 */
export function hitTest(spec: LabelTemplateSpec, xMm: number, yMm: number): string | null {
  for (let i = spec.elements.length - 1; i >= 0; i--) {
    const element = spec.elements[i]!;
    const bounds = elementBoundsMm(element);
    if (
      xMm >= bounds.x &&
      xMm <= bounds.x + bounds.w &&
      yMm >= bounds.y &&
      yMm <= bounds.y + bounds.h
    ) {
      return element.id;
    }
  }
  return null;
}

export interface LabelCanvasProps {
  spec: LabelTemplateSpec;
  selectedId: string | null;
  /** Sample/print data for `field`/`barcode` resolution; defaults to `sampleLabelData()`. */
  data?: Record<LabelField, string>;
  /** Pixels rendered per millimetre; defaults to `DEFAULT_SCALE`. */
  scale?: number;
  onSelect: (id: string | null) => void;
  onMoveBy: (id: string, dxMm: number, dyMm: number) => void;
  onDelete: (id: string) => void;
}

function clientPointToMm(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
  scale: number,
): { xMm: number; yMm: number } {
  const rect = canvas.getBoundingClientRect();
  return { xMm: (clientX - rect.left) / scale, yMm: (clientY - rect.top) / scale };
}

export function LabelCanvas({
  spec,
  selectedId,
  data,
  scale = DEFAULT_SCALE,
  onSelect,
  onMoveBy,
  onDelete,
}: LabelCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragOriginRef = useRef<{ xMm: number; yMm: number } | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const resolvedData = data ?? sampleLabelData();

  const widthPx = spec.widthMm * scale;
  const heightPx = spec.heightMm * scale;

  // Redraws on every render (no dependency array): the canvas is a plain
  // imperative paint surface with no internal state of its own, so simply
  // repainting unconditionally after each commit is both correct and cheap
  // -- and it sidesteps having to list `resolvedData` (a fresh object every
  // render when `data` is omitted) in a dependency array. Under jsdom,
  // `getContext("2d")` returns `null` (no native `canvas` backend
  // installed -- see `labels/rasterizer.ts`'s identical constraint), so
  // drawing is simply skipped there; every OTHER behavior in this
  // component (hit-testing, drag, keyboard) works identically either way.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    draw(spec, ctx, scale, resolvedData);
    if (selectedId !== null) {
      const selected = spec.elements.find((el) => el.id === selectedId);
      if (selected) drawSelectionOutline(ctx, elementBoundsMm(selected), scale);
    }
  });

  // Drag continues even if the cursor leaves the canvas mid-move (a fast
  // real-world drag easily outruns a small label's on-screen bounds), so
  // move/up listeners are attached to `window` for the duration of a drag
  // rather than only to the canvas element's own mouse events.
  useEffect(() => {
    if (draggingId === null) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    function handleWindowMouseMove(event: globalThis.MouseEvent): void {
      const origin = dragOriginRef.current;
      if (!origin || !canvas) return;
      const { xMm, yMm } = clientPointToMm(canvas, event.clientX, event.clientY, scale);
      const dxMm = xMm - origin.xMm;
      const dyMm = yMm - origin.yMm;
      if (dxMm === 0 && dyMm === 0) return;
      onMoveBy(draggingId!, dxMm, dyMm);
      dragOriginRef.current = { xMm, yMm };
    }

    function handleWindowMouseUp(): void {
      setDraggingId(null);
      dragOriginRef.current = null;
    }

    window.addEventListener("mousemove", handleWindowMouseMove);
    window.addEventListener("mouseup", handleWindowMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleWindowMouseMove);
      window.removeEventListener("mouseup", handleWindowMouseUp);
    };
  }, [draggingId, scale, onMoveBy]);

  function handleMouseDown(event: ReactMouseEvent<HTMLCanvasElement>): void {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.focus();
    const { xMm, yMm } = clientPointToMm(canvas, event.clientX, event.clientY, scale);
    const id = hitTest(spec, xMm, yMm);
    onSelect(id);
    if (id !== null) {
      dragOriginRef.current = { xMm, yMm };
      setDraggingId(id);
    }
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLCanvasElement>): void {
    if (selectedId === null) return;
    const step = event.shiftKey ? NUDGE_MM_SHIFT : NUDGE_MM;
    switch (event.key) {
      case "ArrowLeft":
        event.preventDefault();
        onMoveBy(selectedId, -step, 0);
        break;
      case "ArrowRight":
        event.preventDefault();
        onMoveBy(selectedId, step, 0);
        break;
      case "ArrowUp":
        event.preventDefault();
        onMoveBy(selectedId, 0, -step);
        break;
      case "ArrowDown":
        event.preventDefault();
        onMoveBy(selectedId, 0, step);
        break;
      case "Delete":
      case "Backspace":
        event.preventDefault();
        onDelete(selectedId);
        break;
      default:
        break;
    }
  }

  return (
    <canvas
      ref={canvasRef}
      tabIndex={0}
      width={widthPx}
      height={heightPx}
      style={{ width: widthPx, height: heightPx, background: "#ffffff", outline: "none" }}
      onMouseDown={handleMouseDown}
      onKeyDown={handleKeyDown}
    />
  );
}
