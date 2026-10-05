import { randomUUID } from "node:crypto";
import { schema, type Db } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import { UsRequestPrepareStore } from "../../src/modules/traceability/requests/us-request-prepare";
import { UsRequestStore } from "../../src/modules/traceability/requests/us-request-store";
import { UsRequestValidationStore } from "../../src/modules/traceability/requests/us-request-validation";
import { verifyUsRequestRunEvidence } from "../../src/modules/traceability/requests/us-request-run-evidence";
import type { seedCompleteReceiving } from "./us-receiving-fixture";
import {
  finalizeUsRequestPayloadReceiving,
  seedUsRequestPayloadPlan,
} from "./us-request-payload-fixture";

export const legacyRequestBuild = {
  apiVersion: "test-us09-versions",
  gitSha: "a".repeat(40),
  dirty: false,
} as const;

/** Fixture-owned real v1 commands; no production provisioning audit is fabricated. */
export async function seedLegacyUsRequestRun(
  db: Db,
  c: Awaited<ReturnType<typeof seedCompleteReceiving>>,
  mode: "export_ready" | "available_records_incomplete",
) {
  const empty = mode === "available_records_incomplete";
  if (!empty) {
    await finalizeUsRequestPayloadReceiving(db, c);
    await seedUsRequestPayloadPlan(db, c);
  }
  const request = await new UsRequestStore(db).create(c.tenant, c.actor, {
    requestNumber: randomUUID(),
    requesterName: "Synthetic version fixture",
    requesterOrganization: null,
    requesterContact: "private@example.test",
    receivedAt: "2026-10-04T00:00:00Z",
    scope: empty ? { tlcs: ["NO-MATCH-VERSION-FIXTURE"] } : { lotId: c.lot },
  });
  await new UsRequestValidationStore(db).validate(
    c.tenant,
    c.actor,
    request.id,
    legacyRequestBuild,
  );
  const prepared = await new UsRequestPrepareStore(db).prepare(
    c.tenant,
    c.actor,
    request.id,
    {
      mode,
      idempotencyKey: randomUUID(),
    },
    legacyRequestBuild,
  );
  const saved = verifyUsRequestRunEvidence(prepared, c.tenant);
  if (saved.schemaVersion === 1) return prepared;
  // Insert a separate fixture row; accepted writer evidence stays untouched.
  const { tenantOrigin, ...priorFacts } = saved.validationSnapshot;
  void tenantOrigin;
  const validationSnapshot = { ...priorFacts, schemaVersion: 1 as const };
  const scopedContentDigest = canonicalExportDigest(validationSnapshot);
  const inputSnapshot = {
    ...saved,
    schemaVersion: 1 as const,
    validationSnapshot,
    warningAcknowledgement:
      saved.warningAcknowledgement === null
        ? null
        : {
            ...saved.warningAcknowledgement,
            digest: scopedContentDigest,
          },
  };
  const [legacy] = await db
    .insert(schema.traceExportRuns)
    .values({
      ...prepared,
      id: randomUUID(),
      idempotencyKey: randomUUID(),
      revision: prepared.revision + 1,
      scopedContentDigest,
      inputSnapshot,
    })
    .returning();
  if (!legacy) throw new Error("Missing owned legacy fixture row");
  verifyUsRequestRunEvidence(legacy, c.tenant);
  return legacy;
}
