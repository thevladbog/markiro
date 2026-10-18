import {
  elementBoundsMm,
  type LabelElement,
  type LabelField,
  type LabelTemplateSpec,
} from "@markiro/domain";

import type { LabelRenderOptions } from "./label-samples.js";

/** Slack for floating-point sums of millimetres. */
const EPSILON = 1e-9;

/** An element that cannot sit inside the label: it is larger than the label. */
export interface ElementTooLarge {
  ok: false;
}

export type ElementFit = ElementTooLarge | { ok: true; element: LabelElement; adjusted: boolean };

function finiteSize(spec: Pick<LabelTemplateSpec, "widthMm" | "heightMm">): boolean {
  return (
    Number.isFinite(spec.widthMm) &&
    Number.isFinite(spec.heightMm) &&
    spec.widthMm > 0 &&
    spec.heightMm > 0
  );
}

/**
 * One element moved inside the label, after the cloud editor's
 * `fitElementWithinLabel` (`apps/admin/src/pages/labels/geometry.ts`): its
 * bounds (`elementBoundsMm`, measured with the same sample data the layout
 * is drawn with) are slid back over the edge they hang across; an element
 * larger than the label is refused, never shrunk.
 */
export function fitElementWithinLabel(
  element: LabelElement,
  spec: Pick<LabelTemplateSpec, "widthMm" | "heightMm">,
  data: Record<LabelField, string>,
  options: LabelRenderOptions,
): ElementFit {
  if (!finiteSize(spec)) return { ok: false };
  const bounds = elementBoundsMm(element, data, options);
  if (
    !Number.isFinite(bounds.x) ||
    !Number.isFinite(bounds.y) ||
    !Number.isFinite(bounds.w) ||
    !Number.isFinite(bounds.h) ||
    bounds.w <= 0 ||
    bounds.h <= 0 ||
    bounds.w > spec.widthMm + EPSILON ||
    bounds.h > spec.heightMm + EPSILON
  ) {
    return { ok: false };
  }
  const deltaX = Math.min(Math.max(bounds.x, 0), spec.widthMm - bounds.w) - bounds.x;
  const deltaY = Math.min(Math.max(bounds.y, 0), spec.heightMm - bounds.h) - bounds.y;
  if (Math.abs(deltaX) <= EPSILON && Math.abs(deltaY) <= EPSILON) {
    return { ok: true, element, adjusted: false };
  }
  const moved: LabelElement =
    element.kind === "line"
      ? {
          ...element,
          xMm: element.xMm + deltaX,
          yMm: element.yMm + deltaY,
          x2Mm: element.x2Mm + deltaX,
          y2Mm: element.y2Mm + deltaY,
        }
      : { ...element, xMm: element.xMm + deltaX, yMm: element.yMm + deltaY };
  const after = elementBoundsMm(moved, data, options);
  if (
    after.x < -EPSILON ||
    after.y < -EPSILON ||
    after.x + after.w > spec.widthMm + EPSILON ||
    after.y + after.h > spec.heightMm + EPSILON
  ) {
    return { ok: false };
  }
  return { ok: true, element: moved, adjusted: true };
}

/**
 * Every element of a layout moved inside its label (`fitElementWithinLabel`),
 * all or nothing: one element larger than the label refuses the whole
 * layout, so a resize never cuts content a save would then keep. The ids of
 * the moved elements come back for the import's summary.
 */
export function fitSpecElements(
  spec: LabelTemplateSpec,
  data: Record<LabelField, string>,
  options: LabelRenderOptions,
): ElementTooLarge | { ok: true; spec: LabelTemplateSpec; adjustedIds: string[] } {
  if (!finiteSize(spec)) return { ok: false };
  const adjustedIds: string[] = [];
  const elements: LabelElement[] = [];
  for (const element of spec.elements) {
    const fit = fitElementWithinLabel(element, spec, data, options);
    if (!fit.ok) return fit;
    elements.push(fit.element);
    if (fit.adjusted) adjustedIds.push(element.id);
  }
  return { ok: true, spec: { ...spec, elements }, adjustedIds };
}
