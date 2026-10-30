import { randomUUID } from "node:crypto";
import type { Db } from "@markiro/db";
import { sql } from "drizzle-orm";
import type { PlatformPrincipal } from "../../platform-auth/platform-access-policy";
import type { PlatformAuditService } from "../../platform-auth/platform-audit.service";
import { insertLeadEvent } from "./landing-lead-writer";
import { leadRetentionDue } from "./lead-retention";

export type LeadAnonymizationReason = "lost" | "inactive" | "manual";

type AnonymizeTransaction = Pick<Db, "insert" | "execute">;

/**
 * Erases contact/free-text data, linked request payloads and mail copies. The row
 * retains event counts and bounded consent evidence. Returns false if already erased
 * or no longer due after locking.
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
    retentionMonths?: number;
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
  // A submission may have arrived after candidate selection. A separate statement after
  // the row lock sees its committed event; every incoming writer takes this same lock.
  if (input.retentionMonths !== undefined) {
    const due = await tx.execute<{ id: string }>(sql`
      SELECT l.id::text AS id FROM landing_leads AS l
      WHERE l.id = ${input.leadId}::uuid AND ${leadRetentionDue(input.now, input.retentionMonths)}
    `);
    if (due.rows.length === 0) return false;
  }
  // Mail workers hold this same delivery advisory lock through the send. Wait for an
  // in-flight send, then erase its copy and outbox atomically; a stale retry finds no row.
  const mail = await tx.execute<{ id: string }>(sql`
    SELECT d.id::text AS id FROM email_deliveries AS d WHERE d.public_request_id IN (
      SELECT public_request_id FROM landing_lead_events WHERE lead_id = ${input.leadId}::uuid
    ) OR (d.kind = 'landing-lead-digest' AND EXISTS (
      SELECT 1 FROM lead_notifications AS n WHERE n.kind = 'daily_digest'
        AND d.source_id = 'lead-digest:' || n.digest_date::text
        AND jsonb_path_exists(n.payload, '$.sections.*[*] ? (@ == $id)',
          jsonb_build_object('id', ${input.leadId}::text))
    )) ORDER BY d.id
  `);
  for (const delivery of mail.rows) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${delivery.id}, 0))`);
    await tx.execute(sql`DELETE FROM email_deliveries WHERE id = ${delivery.id}::uuid`);
  }

  await tx.execute(sql`
    UPDATE landing_leads SET
      email = NULL, name = NULL, phone = NULL, owner_note = NULL,
      company = NULL, product_group = NULL, inn = NULL, tenant_id = NULL,
      first_utm = NULL, first_referrer = NULL, next_touch_at = NULL,
      anonymized_at = ${input.now}, updated_at = ${input.now}
    WHERE id = ${input.leadId}::uuid
  `);
  // Retain only bounded consent evidence, event kind/time and replay protection. Free
  // text, company identifiers and activation links do not belong in an erased inquiry.
  await tx.execute(sql`
    UPDATE landing_lead_events SET payload = jsonb_strip_nulls(jsonb_build_object(
      'consentVersion', CASE WHEN payload ->> 'consentVersion' ~ '^MKR-PD-02/[0-9]{4}\\.[0-9]{2}/[0-9]{2}$'
        THEN payload ->> 'consentVersion' END,
      'locale', CASE WHEN payload ->> 'locale' IN ('ru', 'en') THEN payload ->> 'locale' END
    )) WHERE lead_id = ${input.leadId}::uuid
  `);
  await tx.execute(sql`
    UPDATE lead_notifications SET payload = '{}', status = CASE WHEN status = 'pending' THEN 'skipped' ELSE status END,
      last_error_code = CASE WHEN status = 'pending' THEN 'lead_anonymized' ELSE last_error_code END,
      updated_at = ${input.now} WHERE lead_id = ${input.leadId}::uuid
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
