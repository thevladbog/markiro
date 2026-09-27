import type { TransformationDraftValue } from "./transformation-readiness.js";

type Output = TransformationDraftValue["outputs"][number];

/** Output position is a permanent lot binding; quantity and UOM may change. */
export function sameTransformationOutputIdentity(
  prior: readonly Output[],
  next: readonly Output[],
): boolean {
  return (
    prior.length === next.length &&
    prior.every(
      (line, index) => line.productId === next[index]?.productId && line.tlc === next[index]?.tlc,
    )
  );
}

/** Only changes to current genealogy or balance are material. */
export function classifyTransformationChange(
  prior: TransformationDraftValue,
  next: TransformationDraftValue,
): "material" | "documentary" {
  if (
    prior.eventDate !== next.eventDate ||
    prior.processorLocationId !== next.processorLocationId ||
    prior.inputs.length !== next.inputs.length ||
    prior.outputs.length !== next.outputs.length
  )
    return "material";
  for (let index = 0; index < prior.inputs.length; index++) {
    const a = prior.inputs[index];
    const b = next.inputs[index];
    if (!a || !b || a.kind !== b.kind) return "material";
    if (a.quantity !== b.quantity || a.unitOfMeasure !== b.unitOfMeasure) return "material";
    if (a.kind === "ftl_lot" && b.kind === "ftl_lot" && a.lotId !== b.lotId) return "material";
    if (
      a.kind === "non_ftl" &&
      b.kind === "non_ftl" &&
      (a.productId !== b.productId ||
        a.sourceLocationId !== b.sourceLocationId ||
        a.reference !== b.reference)
    )
      return "material";
  }
  for (let index = 0; index < prior.outputs.length; index++) {
    const a = prior.outputs[index];
    const b = next.outputs[index];
    if (
      !a ||
      !b ||
      a.productId !== b.productId ||
      a.tlc !== b.tlc ||
      a.quantity !== b.quantity ||
      a.unitOfMeasure !== b.unitOfMeasure
    )
      return "material";
  }
  return "documentary";
}
