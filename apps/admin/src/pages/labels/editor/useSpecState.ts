/**
 * Minimal spec state for the import-based editor: the spec itself plus the
 * geometry error surfaced when a label resize can no longer fit the imported
 * elements. Replaces the removed canvas editor's undo/redo reducer -- with
 * no per-element editing left there is nothing to undo, so the only two
 * transitions are "the import dialog handed us a whole new spec" and "the
 * settings form changed the label's own dimensions".
 *
 * `resizeLabel` keeps the LAST GOOD spec when the new dimensions cannot hold
 * the imported elements (`fitSpecElements` -> `ELEMENT_TOO_LARGE`): the page
 * shows the error instead, so a bad size can never silently truncate content
 * that a subsequent Save would then persist.
 *
 * `resizeLabel` is only ever handed dimensions the page has already checked
 * against the model's 10-300mm bounds, so `ELEMENT_TOO_LARGE` here always
 * means what it says -- "the elements do not fit" -- and never doubles as the
 * report for an empty or out-of-range entry in the size inputs.
 */
import { useCallback, useReducer } from "react";

import { type LabelTemplateSpec } from "@markiro/domain";

import { fitSpecElements } from "../geometry.js";

interface SpecState {
  spec: LabelTemplateSpec;
  geometryError: "ELEMENT_TOO_LARGE" | null;
}

type SpecAction =
  | { type: "replaceSpec"; spec: LabelTemplateSpec }
  | { type: "resizeLabel"; widthMm: number; heightMm: number };

function specReducer(state: SpecState, action: SpecAction): SpecState {
  switch (action.type) {
    case "replaceSpec":
      return { spec: action.spec, geometryError: null };
    case "resizeLabel": {
      const resized: LabelTemplateSpec = {
        ...state.spec,
        widthMm: action.widthMm,
        heightMm: action.heightMm,
      };
      const fitted = fitSpecElements(resized);
      if (!fitted.ok) return { ...state, geometryError: "ELEMENT_TOO_LARGE" };
      return { spec: fitted.spec, geometryError: null };
    }
  }
}

export function useSpecState(initialSpec: LabelTemplateSpec) {
  const [state, dispatch] = useReducer(specReducer, initialSpec, (spec) => ({
    spec,
    geometryError: null,
  }));
  const replaceSpec = useCallback(
    (spec: LabelTemplateSpec) => dispatch({ type: "replaceSpec", spec }),
    [],
  );
  const resizeLabel = useCallback(
    (widthMm: number, heightMm: number) => dispatch({ type: "resizeLabel", widthMm, heightMm }),
    [],
  );
  return { state, replaceSpec, resizeLabel };
}
