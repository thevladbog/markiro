import { randomUUID } from "node:crypto";
import type { Db } from "@markiro/db";
import { sql } from "drizzle-orm";
import type { PlatformPrincipal } from "../../platform-auth/platform-access-policy";
import type { PlatformAuditService } from "../../platform-auth/platform-audit.service";
import { insertLeadEvent } from "./landing-lead-writer";

export type LeadAnonymizationReason = "lost" | "inactive" | "manual";

type AnonymizeTransaction = Pick<Db, "insert" | "execute">;

/**
 * Clears the personal data of one lead (spec §15.2): e-mail, name and phone, plus the
 * free-text owner note and a 12-digit (individual entrepreneur's) INN — on the lead and
 * in its invoice events — which identify a person too. The row stays for statistics. Returns `false` when it was already done.
 * The audit row records which fields were present, never their values.
 */
export async function anonymizeLead(
  tx: AnonymizeTransaction,
  audit: Pick<PlatformAuditService, "record">,
  input: {
    leadId: string;
    reason: LeadAnonymizationReason;
    actor: PlatformPrincipal | null;
    now: Date;
    createId?: () => string;
  },
): Promise<boolean> {
  const current = await tx.execute<{
    status: string;
    hasEmail: boolean;
    hasName: boolean;
    hasPhone: boolean;
    hasNote: boolean;
    personalInn: boolean;
  }>(sql`
    SELECT status, email IS NOT NULL AS "hasEmail", name IS NOT NULL AS "hasName",
      phone IS NOT NULL AS "hasPhone", owner_note IS NOT NULL AS "hasNote",
      coalesce(char_length(inn) = 12, false) AS "personalInn"
    FROM landing_leads
    WHERE id = ${input.leadId}::uuid AND anonymized_at IS NULL
    FOR UPDATE
  `);
  const before = current.rows[0];
  if (!before) return false;
  await tx.execute(sql`
    UPDATE landing_leads SET
      email = NULL, name = NULL, phone = NULL, owner_note = NULL,
      inn = CASE WHEN char_length(inn) = 12 THEN NULL ELSE inn END,
      anonymized_at = ${input.now}, updated_at = ${input.now}
    WHERE id = ${input.leadId}::uuid
  `);
  // Invoice events carry the INN too; a 12-digit one names a person, so it leaves
  // the journal with the lead's own copy. A company's 10-digit INN stays.
  await tx.execute(sql`
    UPDATE landing_lead_events SET payload = payload - 'inn'
    WHERE lead_id = ${input.leadId}::uuid AND char_length(payload ->> 'inn') = 12
  `);
  await insertLeadEvent(
    tx,
    {
      leadId: input.leadId,
      kind: "anonymized",
      payload: { reason: input.reason },
      actorPlatformUserId: input.actor?.userId ?? null,
    },
    input.now,
    input.createId ?? randomUUID,
  );
  await audit.record(tx, {
    actorPlatformUserId: input.actor?.userId ?? null,
    actorRole: input.actor?.role ?? null,
    action: "landing_lead.anonymized",
    outcome: "success",
    tenantId: null,
    targetType: "landing_lead",
    targetId: input.leadId,
    reason: input.reason,
    before: {
      status: before.status,
      email: before.hasEmail,
      name: before.hasName,
      phone: before.hasPhone,
      ownerNote: before.hasNote,
      personalInn: before.personalInn,
    },
    after: { anonymized: true },
    requestId: null,
  });
  return true;
}
