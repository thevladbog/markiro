import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import type { TransformationDraftRecord } from "@markiro/platform-contracts";
import {
  seedFinalizableTransformation,
  type TransformationFixtureDatabase,
} from "./us-transformation-finalization-fixture";

/** Finalize both revisions through real store commands in the disposable fixture DB. */
export async function seedTwoByTwoGenealogy(f: TransformationFixtureDatabase) {
  const c = await seedFinalizableTransformation(f);
  const saved = await c.store.saveDraft(
    c.tenant,
    c.actor,
    c.saved.id,
    {
      operationKey: randomUUID(),
      expectedDraftVersion: 1,
      draft: {
        ...c.saved.draft,
        outputs: [
          c.saved.draft.outputs[0]!,
          { productId: c.product, tlc: "NEW-OUTPUT-2", quantity: "75", unitOfMeasure: "case" },
        ],
      },
    },
    "genealogy-two-by-two-save",
  );
  const original = await finalize(c, saved, "genealogy-two-by-two-original");
  const receipt = await c.store.amend(
    c.tenant,
    c.actor,
    original.id,
    {
      operationKey: randomUUID(),
      expectedLifecycleVersion: 2,
      reason: "Correct output quantities",
    },
    "genealogy-two-by-two-amend",
  );
  if (receipt.record.status !== "draft") throw new Error("Expected pending amendment");
  const revised = await c.store.saveDraft(
    c.tenant,
    c.actor,
    receipt.record.id,
    {
      operationKey: randomUUID(),
      expectedDraftVersion: receipt.record.draftVersion,
      draft: {
        ...receipt.record.draft,
        outputs: receipt.record.draft.outputs.map((line, index) => ({
          ...line,
          quantity: index === 0 ? "110" : "70",
        })),
      },
    },
    "genealogy-two-by-two-revise",
  );
  const revision = await finalize(c, revised, "genealogy-two-by-two-revision");
  return { ...c, original, revision };
}

/** Finalize, amend and void a zero-FTL-input Transformation in the fixture DB. */
export async function seedZeroFtlGenealogy(f: TransformationFixtureDatabase) {
  const c = await seedFinalizableTransformation(f);
  const nonFtlProductId = randomUUID();
  await f.db.insert(schema.products).values({
    id: nonFtlProductId,
    tenantId: c.tenant,
    name: "Synthetic non-FTL ingredient",
  });
  await f.db.insert(schema.productTraceabilityProfiles).values({
    tenantId: c.tenant,
    productId: nonFtlProductId,
    productName: "Synthetic non-FTL ingredient",
    coverageStatus: "not_covered",
    coverageRationale: "Ingredient reviewed outside the FTL",
    reviewedBy: c.actor,
    reviewedAt: new Date("2026-09-25T13:14:15.123Z"),
  });
  const saved = await c.store.saveDraft(
    c.tenant,
    c.actor,
    c.saved.id,
    {
      operationKey: randomUUID(),
      expectedDraftVersion: 1,
      draft: {
        ...c.saved.draft,
        inputs: [
          {
            kind: "non_ftl",
            productId: nonFtlProductId,
            sourceLocationId: c.location,
            reference: "Invoice non-FTL 42",
            quantity: "0.250",
            unitOfMeasure: "lb",
          },
        ],
      },
    },
    "genealogy-zero-ftl-save",
  );
  const original = await finalize(c, saved, "genealogy-zero-ftl-original");
  const receipt = await c.store.amend(
    c.tenant,
    c.actor,
    original.id,
    { operationKey: randomUUID(), expectedLifecycleVersion: 2, reason: "Correct notes" },
    "genealogy-zero-ftl-amend",
  );
  if (receipt.record.status !== "draft") throw new Error("Expected pending amendment");
  const revised = await c.store.saveDraft(
    c.tenant,
    c.actor,
    receipt.record.id,
    {
      operationKey: randomUUID(),
      expectedDraftVersion: receipt.record.draftVersion,
      draft: { ...receipt.record.draft, notes: "Documentary correction" },
    },
    "genealogy-zero-ftl-revise",
  );
  const revision = await finalize(c, revised, "genealogy-zero-ftl-revision");
  const voidReceipt = await c.store.void(
    c.tenant,
    c.actor,
    revision.id,
    { operationKey: randomUUID(), expectedLifecycleVersion: 4, reason: "No current origin" },
    "genealogy-zero-ftl-void",
  );
  if (voidReceipt.record.status !== "void" || !("snapshot" in voidReceipt.record))
    throw new Error("Expected voided finalized revision");
  return { ...c, nonFtlProductId, original, revision, voided: voidReceipt.record };
}

export async function seedVoidedAmendmentDraftGenealogy(f: TransformationFixtureDatabase) {
  const c = await seedFinalizableTransformation(f);
  const original = await c.store.finalize(
    c.tenant,
    c.actor,
    c.saved.id,
    c.command,
    "genealogy-void-draft-original",
  );
  const amendment = await c.store.amend(
    c.tenant,
    c.actor,
    original.id,
    { operationKey: randomUUID(), expectedLifecycleVersion: 2, reason: "Proposed correction" },
    "genealogy-void-draft-amend",
  );
  if (amendment.record.status !== "draft") throw new Error("Expected pending amendment");
  const voided = await c.store.void(
    c.tenant,
    c.actor,
    amendment.record.id,
    {
      operationKey: randomUUID(),
      expectedLifecycleVersion: 3,
      expectedDraftVersion: amendment.record.draftVersion,
      reason: "Cancel proposed correction",
    },
    "genealogy-void-draft-cancel",
  );
  if (voided.record.status !== "void" || "snapshot" in voided.record)
    throw new Error("Expected voided draft without snapshot");
  return { ...c, original, voidedDraft: voided.record };
}

async function finalize(
  c: Awaited<ReturnType<typeof seedFinalizableTransformation>>,
  draft: TransformationDraftRecord,
  requestId: string,
) {
  const ready = await c.store.checkReadiness(c.tenant, c.actor, draft.id, {
    expectedDraftVersion: draft.draftVersion,
  });
  if (ready.state !== "complete")
    throw new Error(`Fixture not ready: ${JSON.stringify(ready.issues)}`);
  return c.store.finalize(
    c.tenant,
    c.actor,
    draft.id,
    {
      operationKey: randomUUID(),
      expectedDraftVersion: draft.draftVersion,
      expectedInputDigest: ready.inputDigest,
    },
    requestId,
  );
}
