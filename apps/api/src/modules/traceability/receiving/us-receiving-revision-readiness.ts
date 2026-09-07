import { createHash } from "node:crypto";
import { assessReceivingRevisionReadiness, type ReceivingReadinessInput } from "@markiro/domain";
import { receivingRevisionReadinessSchema } from "@markiro/platform-contracts";
import { sql } from "drizzle-orm";
import type { UsMasterDataTransaction } from "../master-data/us-master-data-support";
import { readReceivingWorkingDraft } from "./us-receiving-working-draft";
import { readReceivingReferenceFacts } from "./us-receiving-reference-context";
import { readReceivingBasis } from "./us-receiving-basis";
import { unavailable } from "./us-receiving-persistence";

/** Authorized repeatable-read context, also reusable by the eventual v3 finalizer. */
export async function readReceivingRevisionContext(
  tx: UsMasterDataTransaction,
  tenantId: string,
  eventId: string,
  expectedDraftVersion: number,
  profileCode: ReceivingReadinessInput["profileCode"],
  lockReferences = false,
) {
  const working = await readReceivingWorkingDraft(tx, tenantId, eventId, expectedDraftVersion);
  // No persisted downstream model is registered yet. Receiving-only integrity
  // must be established even for empty drafts; unknown kinds cannot mean no dependencies.
  const kinds = await tx.execute<{ invalid: boolean }>(sql`SELECT EXISTS (
    SELECT 1 FROM traceability_events WHERE tenant_id=${tenantId} AND type<>'receiving'
  ) AS invalid`);
  if (kinds.rows[0]?.invalid !== false) throw unavailable();
  const priorLotIds =
    working.predecessor?.draft.items.flatMap((line) => (line.lotId === null ? [] : [line.lotId])) ??
    [];
  const facts = await readReceivingReferenceFacts(
    tx,
    tenantId,
    working.draft,
    profileCode,
    lockReferences,
    {
      retainedBindings: working.retainedBindings,
      additionalLotIds: priorLotIds,
    },
  );
  const presentLotIds = new Set(facts.lotRows.map((lot) => lot.id));
  if (priorLotIds.some((id) => !presentLotIds.has(id))) throw unavailable();
  // Counts are complete, not the bounded response page. Every support change
  // bumps the lot token, including a replacement that restores the same count.
  // Include removed predecessor lots so their provenance cannot drift unnoticed.
  const basis = [];
  for (const lot of facts.lotRows) {
    const current = await readReceivingBasis(tx, tenantId, lot.id, { limit: 1, offset: 0 });
    basis.push({
      lotId: current.lotId,
      basisVersion: current.basisVersion,
      supportCount: current.supportCount,
    });
  }
  const ruleVersion = "receiving-readiness-v4";
  const inputDigest = createHash("sha256")
    .update(JSON.stringify({ ruleVersion, working, facts, basis }))
    .digest("hex");
  const result = receivingRevisionReadinessSchema.safeParse({
    eventId,
    draftVersion: working.record.draftVersion,
    checkedAt: new Date().toISOString(),
    inputDigest,
    ruleVersion,
    rootId: working.record.lifecycle.rootId,
    expectedLifecycleVersion: working.record.lifecycle.lifecycleVersion,
    previousRevisionId: working.record.lifecycle.previousRevisionId,
    profileCode,
    ...assessReceivingRevisionReadiness(facts.input, {
      retainedBindings: working.retainedBindings,
    }),
  });
  if (!result.success) throw unavailable();
  return { readiness: result.data, working, facts, basis };
}
