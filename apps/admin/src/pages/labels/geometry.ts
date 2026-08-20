import {
  sampleLabelData,
  type LabelElement,
  type LabelField,
  type LabelTemplateSpec,
} from "@markiro/domain";

import { elementBoundsMm } from "./renderer.js";

export type ElementFitFailure = { ok: false; reason: "ELEMENT_TOO_LARGE" };
export type ElementFitSuccess = { ok: true; element: LabelElement; adjusted: boolean };
export type ElementFitResult = ElementFitFailure | ElementFitSuccess;

const EPSILON = 1e-9;

export function fitElementWithinLabel(
  element: LabelElement,
  spec: Pick<LabelTemplateSpec, "widthMm" | "heightMm">,
  data: Record<LabelField, string> = sampleLabelData(),
): ElementFitResult {
  if (
    !Number.isFinite(spec.widthMm) ||
    !Number.isFinite(spec.heightMm) ||
    spec.widthMm <= 0 ||
    spec.heightMm <= 0
  ) {
    return { ok: false, reason: "ELEMENT_TOO_LARGE" };
  }
  const bounds = elementBoundsMm(element, data);
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
    return { ok: false, reason: "ELEMENT_TOO_LARGE" };
  }

  const nextX = Math.min(Math.max(bounds.x, 0), spec.widthMm - bounds.w);
  const nextY = Math.min(Math.max(bounds.y, 0), spec.heightMm - bounds.h);
  const deltaX = nextX - bounds.x;
  const deltaY = nextY - bounds.y;
  if (Math.abs(deltaX) <= EPSILON && Math.abs(deltaY) <= EPSILON) {
    return { ok: true, element, adjusted: false };
  }

  const fitted: LabelElement =
    element.kind === "line"
      ? {
          ...element,
          xMm: element.xMm + deltaX,
          yMm: element.yMm + deltaY,
          x2Mm: element.x2Mm + deltaX,
          y2Mm: element.y2Mm + deltaY,
        }
      : { ...element, xMm: element.xMm + deltaX, yMm: element.yMm + deltaY };

  const finalBounds = elementBoundsMm(fitted, data);
  if (
    finalBounds.x < -EPSILON ||
    finalBounds.y < -EPSILON ||
    finalBounds.x + finalBounds.w > spec.widthMm + EPSILON ||
    finalBounds.y + finalBounds.h > spec.heightMm + EPSILON
  ) {
    return { ok: false, reason: "ELEMENT_TOO_LARGE" };
  }
  return { ok: true, element: fitted, adjusted: true };
}

export function fitSpecElements(
  spec: LabelTemplateSpec,
  data: Record<LabelField, string> = sampleLabelData(),
): { ok: true; spec: LabelTemplateSpec; adjustedIds: string[] } | ElementFitFailure {
  if (
    !Number.isFinite(spec.widthMm) ||
    !Number.isFinite(spec.heightMm) ||
    spec.widthMm <= 0 ||
    spec.heightMm <= 0
  ) {
    return { ok: false, reason: "ELEMENT_TOO_LARGE" };
  }
  const adjustedIds: string[] = [];
  const elements: LabelElement[] = [];
  for (const element of spec.elements) {
    const result = fitElementWithinLabel(element, spec, data);
    if (!result.ok) return result;
    elements.push(result.element);
    if (result.adjusted) adjustedIds.push(element.id);
  }
  return { ok: true, spec: { ...spec, elements }, adjustedIds };
}
