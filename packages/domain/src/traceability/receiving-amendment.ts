import type { ReceivingReadinessInput } from "./receiving-readiness.js";

export type ReceivingMaterialSource = ReceivingReadinessInput["draft"]["items"][number]["source"];
export interface ReceivingMaterialLine {
  lineNo: number;
  previousLineNo: number | null;
  productId: string | null;
  lotId: string | null;
  lotLinkMode: "create_on_finalize" | "link_existing";
  effectiveTlc: string | null;
  source: ReceivingMaterialSource;
  receiptHandling: "ordinary" | "exempt_existing_tlc" | "exempt_assigned_tlc";
  quantity: string | null;
  unitOfMeasure: string | null;
}
export interface ReceivingMaterialRevision {
  dateReceived: string | null;
  locationId: string | null;
  previousSourceLocationId: string | null;
  lines: readonly ReceivingMaterialLine[];
}
export interface ReceivingAmendmentEffect {
  kind: "documentary" | "material";
  affectedLotIds: string[];
  removedPreviousLineNos: number[];
  identityLockedLineNos: number[];
  invalidBindingLineNos: number[];
}

function sameMaterialSource(a: ReceivingMaterialSource, b: ReceivingMaterialSource): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === "location" && b.kind === "location") return a.locationId === b.locationId;
  return (
    a.kind === "reference" &&
    b.kind === "reference" &&
    a.referenceKind === b.referenceKind &&
    a.referenceValue === b.referenceValue &&
    a.resolvedLocationId === b.resolvedLocationId
  );
}

/** Compare saved revisions, not labels or array positions. Findings must block finalization. */
export function classifyReceivingAmendment(
  predecessor: ReceivingMaterialRevision,
  candidate: ReceivingMaterialRevision,
): ReceivingAmendmentEffect {
  const previous = new Map(predecessor.lines.map((line) => [line.lineNo, line]));
  const bindingCounts = new Map<number, number>();
  for (const line of candidate.lines)
    if (line.previousLineNo !== null)
      bindingCounts.set(line.previousLineNo, (bindingCounts.get(line.previousLineNo) ?? 0) + 1);
  const bound = new Set<number>();
  const invalidBindings = new Set<number>();
  const identityLocked = new Set<number>();
  const removed = new Set<number>();
  const affected = new Set<string>();
  let material =
    predecessor.dateReceived !== candidate.dateReceived ||
    predecessor.locationId !== candidate.locationId ||
    predecessor.previousSourceLocationId !== candidate.previousSourceLocationId;
  const affect = (line: ReceivingMaterialLine) => {
    if (line.lotId !== null) affected.add(line.lotId);
  };
  if (material) [...predecessor.lines, ...candidate.lines].forEach(affect);

  for (const line of candidate.lines) {
    if (line.previousLineNo === null) {
      material = true;
      affect(line);
      continue;
    }
    const original = previous.get(line.previousLineNo);
    if (original) bound.add(original.lineNo);
    if (!original || bindingCounts.get(line.previousLineNo) !== 1) {
      material = true;
      invalidBindings.add(line.lineNo);
      affect(line);
      if (original) affect(original);
      continue;
    }
    const identityChanged =
      original.lotId !== line.lotId ||
      original.productId !== line.productId ||
      original.effectiveTlc !== line.effectiveTlc ||
      original.lotLinkMode !== line.lotLinkMode ||
      original.receiptHandling !== line.receiptHandling ||
      !sameMaterialSource(original.source, line.source);
    if (identityChanged) identityLocked.add(line.lineNo);
    if (
      identityChanged ||
      original.quantity !== line.quantity ||
      original.unitOfMeasure !== line.unitOfMeasure
    ) {
      material = true;
      affect(original);
      affect(line);
    }
  }
  for (const line of predecessor.lines) {
    if (bound.has(line.lineNo)) continue;
    material = true;
    removed.add(line.lineNo);
    affect(line);
  }
  return {
    kind: material ? "material" : "documentary",
    affectedLotIds: [...affected].sort(),
    removedPreviousLineNos: [...removed].sort((a, b) => a - b),
    identityLockedLineNos: [...identityLocked].sort((a, b) => a - b),
    invalidBindingLineNos: [...invalidBindings].sort((a, b) => a - b),
  };
}
