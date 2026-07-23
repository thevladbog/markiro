/**
 * Plan 04 Task 9: label editor canvas core -- editor state reducer + hook.
 *
 * `editorReducer` (a plain, dependency-free reducer) and `createEditorState`
 * are exported specifically so the test suite can drive every action
 * directly, without React/`renderHook` machinery -- undo/redo/history-cap
 * semantics are ordinary data transformations, not DOM/React concerns, and
 * are fully covered that way. `useEditorState` is the thin React binding
 * (`useReducer` + stable action callbacks) that `LabelCanvas.tsx` and,
 * later, Task 10's editor page actually consume.
 */
import { useCallback, useReducer } from "react";

import { type LabelElement, type LabelTemplateSpec } from "@markiro/domain";

/**
 * Maximum number of past specs retained for `undo`. Enforced by
 * `pushHistory` below: pushing past this cap drops the OLDEST entry first
 * (a bounded ring, not an error) -- per the plan brief's "history stack
 * (cap 50)" requirement.
 */
export const HISTORY_CAP = 50;

export interface EditorState {
  spec: LabelTemplateSpec;
  selectedId: string | null;
  /** Past specs, oldest first; `undo` pops from the end. Capped at `HISTORY_CAP`. */
  history: LabelTemplateSpec[];
  /** Specs undone-away-from, most-recently-undone first; `redo` pops from the front. */
  future: LabelTemplateSpec[];
}

export type EditorAction =
  | { type: "select"; id: string | null }
  | { type: "moveBy"; id: string; dxMm: number; dyMm: number }
  | { type: "setElement"; id: string; patch: Partial<LabelElement> }
  | { type: "addElement"; element: LabelElement }
  | { type: "removeElement"; id: string }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "replaceSpec"; spec: LabelTemplateSpec };

/** Fresh editor state for `spec`: nothing selected, empty history/future. */
export function createEditorState(spec: LabelTemplateSpec): EditorState {
  return { spec, selectedId: null, history: [], future: [] };
}

function pushHistory(history: LabelTemplateSpec[], spec: LabelTemplateSpec): LabelTemplateSpec[] {
  const next = [...history, spec];
  return next.length > HISTORY_CAP ? next.slice(next.length - HISTORY_CAP) : next;
}

/**
 * A selection only survives a spec change if it still resolves to an
 * element in the NEW spec -- e.g. cleared after `removeElement` removes the
 * selected element (an explicit plan requirement), or after `undo`/`redo`/
 * `replaceSpec` swap in a spec that never had that id to begin with.
 */
function selectedIdAfter(nextSpec: LabelTemplateSpec, selectedId: string | null): string | null {
  return selectedId !== null && nextSpec.elements.some((el) => el.id === selectedId)
    ? selectedId
    : null;
}

function findElement(spec: LabelTemplateSpec, id: string): LabelElement | undefined {
  return spec.elements.find((el) => el.id === id);
}

/**
 * Shared tail for every spec-mutating action: pushes the OLD spec onto the
 * undo history (capped), clears the redo (`future`) stack -- the standard
 * "a new edit invalidates redo" rule -- and reconciles `selectedId` against
 * the new spec.
 */
function withMutatedSpec(state: EditorState, nextSpec: LabelTemplateSpec): EditorState {
  return {
    spec: nextSpec,
    selectedId: selectedIdAfter(nextSpec, state.selectedId),
    history: pushHistory(state.history, state.spec),
    future: [],
  };
}

/**
 * Pure reducer -- see the module doc comment above for why this is
 * exported and tested directly rather than only through `useEditorState`.
 */
export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "select":
      return { ...state, selectedId: action.id };

    case "moveBy": {
      const element = findElement(state.spec, action.id);
      if (!element) return state;

      // Grid-snap the RESULTING position to the nearest whole millimetre
      // (not the delta) -- applies uniformly whether `dxMm`/`dyMm` came
      // from a continuous mouse drag or an already-integer keyboard nudge,
      // per the plan brief's single "moveBy(id, dxMm, dyMm, snap 1mm)"
      // action covering both.
      const xMm = Math.round(element.xMm + action.dxMm);
      const yMm = Math.round(element.yMm + action.dyMm);
      // `line` elements carry a SECOND point (`x2Mm`/`y2Mm`); shifting only
      // the anchor would stretch/skew the line, so the second point is
      // translated by the SAME (post-snap) delta to preserve its length and
      // direction exactly.
      const deltaXMm = xMm - element.xMm;
      const deltaYMm = yMm - element.yMm;
      const moved: LabelElement =
        element.kind === "line"
          ? { ...element, xMm, yMm, x2Mm: element.x2Mm + deltaXMm, y2Mm: element.y2Mm + deltaYMm }
          : { ...element, xMm, yMm };

      const nextSpec: LabelTemplateSpec = {
        ...state.spec,
        elements: state.spec.elements.map((el) => (el.id === action.id ? moved : el)),
      };
      return withMutatedSpec(state, nextSpec);
    }

    case "setElement": {
      const element = findElement(state.spec, action.id);
      if (!element) return state;
      // `patch` is intentionally untyped-by-kind (a `Partial<LabelElement>`
      // covering fields from any element kind): callers (Task 10's
      // properties panel) only ever patch fields belonging to the
      // element's OWN kind, so this merge-then-assert is safe in practice;
      // it does not itself guard against a caller patching in a foreign
      // kind's field.
      const patched = { ...element, ...action.patch } as LabelElement;
      const nextSpec: LabelTemplateSpec = {
        ...state.spec,
        elements: state.spec.elements.map((el) => (el.id === action.id ? patched : el)),
      };
      return withMutatedSpec(state, nextSpec);
    }

    case "addElement": {
      const nextSpec: LabelTemplateSpec = {
        ...state.spec,
        elements: [...state.spec.elements, action.element],
      };
      // Newly added elements become selected -- the common editor
      // convention (Figma, etc.): a just-placed element is what the user
      // most likely wants to immediately position/configure.
      return { ...withMutatedSpec(state, nextSpec), selectedId: action.element.id };
    }

    case "removeElement": {
      if (!findElement(state.spec, action.id)) return state;
      const nextSpec: LabelTemplateSpec = {
        ...state.spec,
        elements: state.spec.elements.filter((el) => el.id !== action.id),
      };
      return withMutatedSpec(state, nextSpec);
    }

    case "replaceSpec":
      return withMutatedSpec(state, action.spec);

    case "undo": {
      if (state.history.length === 0) return state;
      const previous = state.history[state.history.length - 1]!;
      return {
        spec: previous,
        selectedId: selectedIdAfter(previous, state.selectedId),
        history: state.history.slice(0, -1),
        future: [state.spec, ...state.future],
      };
    }

    case "redo": {
      if (state.future.length === 0) return state;
      const next = state.future[0]!;
      return {
        spec: next,
        selectedId: selectedIdAfter(next, state.selectedId),
        history: pushHistory(state.history, state.spec),
        future: state.future.slice(1),
      };
    }
  }
}

/**
 * React binding for `editorReducer`: `useReducer` with `createEditorState`
 * as the lazy initializer (so `initialSpec` seeds state exactly once, on
 * mount -- later re-renders with a different `initialSpec` value do NOT
 * reset the editor, matching the usual "uncontrolled with an initial
 * value" convention) plus one stable callback per action, for
 * `LabelCanvas.tsx` and Task 10's editor chrome to dispatch through.
 */
export function useEditorState(initialSpec: LabelTemplateSpec) {
  const [state, dispatch] = useReducer(editorReducer, initialSpec, createEditorState);

  const select = useCallback((id: string | null) => dispatch({ type: "select", id }), []);
  const moveBy = useCallback(
    (id: string, dxMm: number, dyMm: number) => dispatch({ type: "moveBy", id, dxMm, dyMm }),
    [],
  );
  const setElement = useCallback(
    (id: string, patch: Partial<LabelElement>) => dispatch({ type: "setElement", id, patch }),
    [],
  );
  const addElement = useCallback(
    (element: LabelElement) => dispatch({ type: "addElement", element }),
    [],
  );
  const removeElement = useCallback((id: string) => dispatch({ type: "removeElement", id }), []);
  const undo = useCallback(() => dispatch({ type: "undo" }), []);
  const redo = useCallback(() => dispatch({ type: "redo" }), []);
  const replaceSpec = useCallback(
    (spec: LabelTemplateSpec) => dispatch({ type: "replaceSpec", spec }),
    [],
  );

  return {
    state,
    select,
    moveBy,
    setElement,
    addElement,
    removeElement,
    undo,
    redo,
    replaceSpec,
    canUndo: state.history.length > 0,
    canRedo: state.future.length > 0,
  };
}
