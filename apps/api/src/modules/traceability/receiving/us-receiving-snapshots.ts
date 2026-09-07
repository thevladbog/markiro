import { randomUUID } from "node:crypto";
import {
  assessReceivingExemptionLine,
  buildLocationDescriptionSnapshot,
  buildProductSnapshot,
  type ReceivingRetainedBinding,
} from "@markiro/domain";
import {
  receivingFinalizationSnapshotV2Schema,
  receivingFinalizationSnapshotV3Schema,
  type ReceivingDraft,
  type ReceivingDraftRecord,
  type ReceivingFinalizationSnapshotV2,
} from "@markiro/platform-contracts";
import { locationResponse } from "../master-data/us-master-data-support";
import { profileDefaults, storedProfileResponse } from "../products/us-product-profile-support";
import type {
  readReceivingReferenceContext,
  readReceivingReferenceFacts,
} from "./us-receiving-reference-context";
import type { readReceivingRevisionContext } from "./us-receiving-revision-readiness";
import { unavailable } from "./us-receiving-persistence";

type Context = Awaited<ReturnType<typeof readReceivingReferenceContext>>;
type Review = { actorUserId: string; finalizedAt: string; reviewedExemptLines: number[] };
/** All builders consume the same locked context used for readiness and its digest. */
export function planReceivingSnapshot(
  saved: ReceivingDraftRecord,
  context: Context,
  review: Review,
): ReceivingFinalizationSnapshotV2 {
  const result = receivingFinalizationSnapshotV2Schema.safeParse({
    ...planSnapshotContent(saved.draft, context, review),
    snapshotVersion: 2,
    confirmation: {
      ruleVersion: context.readiness.ruleVersion,
      reviewedExemptLines: review.reviewedExemptLines,
      inputDigest: context.readiness.inputDigest,
      warnings: context.readiness.issues.filter((issue) => issue.severity === "warning"),
    },
  });
  if (!result.success) throw unavailable();
  return result.data;
}

export function planReceivingRevisionSnapshot(
  context: Awaited<ReturnType<typeof readReceivingRevisionContext>>,
  review: Review,
) {
  const { working, facts, readiness } = context;
  const content = planSnapshotContent(working.draft, facts, review, working.retainedBindings);
  const bindings = new Map(working.retainedBindings.map((binding) => [binding.lineNo, binding]));
  const result = receivingFinalizationSnapshotV3Schema.safeParse({
    ...content,
    snapshotVersion: 3,
    items: content.items.map((line) => {
      const binding = bindings.get(line.lineNo);
      return {
        ...line,
        lotBinding: binding
          ? {
              kind: "retained",
              previousEventId: working.record.lifecycle.previousRevisionId,
              previousLineNo: binding.previousLineNo,
            }
          : { kind: line.lotLinkMode === "create_on_finalize" ? "created" : "linked" },
      };
    }),
    confirmation: {
      ruleVersion: readiness.ruleVersion,
      reviewedExemptLines: review.reviewedExemptLines,
      inputDigest: readiness.inputDigest,
      warnings: readiness.issues.filter((issue) => issue.severity === "warning"),
    },
  });
  if (!result.success) throw unavailable();
  return result.data;
}

function planSnapshotContent(
  draft: ReceivingDraft,
  context: Pick<
    Awaited<ReturnType<typeof readReceivingReferenceFacts>>,
    "profile" | "locationRows" | "productRows" | "documentRows" | "partyRows"
  >,
  review: Review,
  retainedBindings: readonly ReceivingRetainedBinding[] = [],
) {
  const bindings = new Map(retainedBindings.map((binding) => [binding.lineNo, binding]));
  function location(id: string | null) {
    const row = context.locationRows.find((value) => value.id === id);
    if (!row) throw unavailable();
    const built = buildLocationDescriptionSnapshot(locationResponse(row));
    if (!built.ok) throw unavailable();
    return built.snapshot;
  }
  const planned = draft.items.map((line, index) => {
    const binding = bindings.get(index + 1);
    const assessment = assessReceivingExemptionLine(
      line,
      draft.locationId,
      binding ? { retainedLotId: binding.lotId } : undefined,
    );
    if (!assessment.path || assessment.issues.length) throw unavailable();
    const receiptBasis =
      assessment.path === "ordinary"
        ? { kind: "ordinary" }
        : {
            kind: assessment.path,
            reason: line.exemptReason,
            evidenceUrl: line.exemptReceipt?.evidenceUrl,
            reviewedBy: review.actorUserId,
            reviewedAt: review.finalizedAt,
            ...(assessment.path === "exempt_assigned_tlc" ? { receivedTlc: null } : {}),
          };
    const product = context.productRows.find((row) => row.product.id === line.productId);
    if (!product || !line.source) throw unavailable();
    const current = product.profile
      ? storedProfileResponse(product.profile, context.profile.code)
      : profileDefaults(product.product);
    const built = buildProductSnapshot(product.product, current);
    if (!built.ok) throw unavailable();
    const {
      coverageStatus,
      coverageRationale,
      ftlCategory,
      ftlSourceUrl,
      ftlSourceVersion,
      reviewedBy,
      reviewedAt,
    } = current;
    return {
      lineNo: index + 1,
      productId: line.productId,
      lotId:
        binding?.lotId ?? (line.lotLinkMode === "create_on_finalize" ? randomUUID() : line.lotId),
      lotLinkMode: line.lotLinkMode,
      tlc: assessment.effectiveTlc,
      receiptBasis,
      source: line.source,
      quantity: line.quantity,
      unitOfMeasure: line.unitOfMeasure,
      supplierLotReference: line.supplierLotReference,
      notes: line.notes,
      productDescription: built.snapshot,
      coverage: {
        coverageStatus,
        coverageRationale,
        ftlCategory,
        ftlSourceUrl,
        ftlSourceVersion,
        reviewedBy,
        reviewedAt,
      },
      sourceDescription: location(
        line.source.kind === "location" ? line.source.locationId : line.source.resolvedLocationId,
      ),
    };
  });
  return {
    dateReceived: draft.dateReceived,
    locationId: draft.locationId,
    previousSourceLocationId: draft.previousSourceLocationId,
    receivedAtNote: draft.receivedAtNote,
    notes: draft.notes,
    profileCode: context.profile.code,
    baselineVersion: context.profile.baselineVersion,
    locationDescription: location(draft.locationId),
    previousSourceDescription: location(draft.previousSourceLocationId),
    items: planned,
    documents: draft.documentIds.map((id) => {
      const row = context.documentRows.find((value) => value.id === id);
      if (!row) throw unavailable();
      const issuer = context.partyRows.find((value) => value.id === row.partyId);
      return {
        document: {
          snapshotVersion: 1,
          documentId: row.id,
          type: row.type,
          typeOtherLabel: row.typeOtherLabel,
          number: row.number,
          partyId: row.partyId,
          issuedOn: row.issuedOn,
          notes: row.notes,
        },
        issuer: issuer ? { id: issuer.id, name: issuer.name, legalName: issuer.legalName } : null,
      };
    }),
  };
}
