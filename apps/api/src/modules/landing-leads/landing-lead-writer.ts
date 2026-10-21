import { randomUUID } from "node:crypto";
import { schema, type Db } from "@markiro/db";
import type { LandingLeadEventKind } from "@markiro/platform-contracts";
import { sql } from "drizzle-orm";

/** A Drizzle transaction of the API database; lead, mail and audit writes share it. */
export type LeadWriteTransaction = Pick<Db, "insert" | "execute">;

export interface LeadContactFields {
  /** Already normalized: trimmed and lower-cased. */
  email: string;
  /** Absent on the invoice form, which asks for the INN only. */
  company?: string;
  locale: "ru" | "en";
  sourcePath: string;
  name?: string;
  phone?: string;
  inn?: string;
  productGroup?: string;
  linesBucket?: "1" | "2-3" | "4+";
  utm?: Record<string, string>;
  referrer?: string;
}

/**
 * One lead per normalized e-mail (spec §15.3): a new e-mail creates the lead with its
 * first attribution; a known one only fills empty fields — a filled field, the status
 * and the first attribution are never overwritten. The single statement takes the row
 * lock, so concurrent forms with the same e-mail serialize on it.
 */
export async function upsertLead(
  tx: LeadWriteTransaction,
  fields: LeadContactFields,
  now: Date,
  createId: () => string = randomUUID,
): Promise<{ leadId: string; created: boolean }> {
  const utm = fields.utm && Object.keys(fields.utm).length > 0 ? JSON.stringify(fields.utm) : null;
  const result = await tx.execute<{ id: string; created: boolean }>(sql`
    INSERT INTO landing_leads (
      id, email, company, name, phone, inn, product_group, lines_bucket, locale,
      first_source_path, first_utm, first_referrer, status_changed_at, created_at, updated_at
    ) VALUES (
      ${createId()}::uuid, ${fields.email}, ${fields.company ?? null}, ${fields.name ?? null},
      ${fields.phone ?? null}, ${fields.inn ?? null}, ${fields.productGroup ?? null},
      ${fields.linesBucket ?? null}, ${fields.locale}, ${fields.sourcePath}, ${utm}::jsonb,
      ${fields.referrer ?? null}, ${now}, ${now}, ${now}
    )
    ON CONFLICT (lower(btrim(email))) WHERE email IS NOT NULL DO UPDATE SET
      company = coalesce(landing_leads.company, excluded.company),
      name = coalesce(landing_leads.name, excluded.name),
      phone = coalesce(landing_leads.phone, excluded.phone),
      inn = coalesce(landing_leads.inn, excluded.inn),
      product_group = coalesce(landing_leads.product_group, excluded.product_group),
      lines_bucket = coalesce(landing_leads.lines_bucket, excluded.lines_bucket),
      updated_at = excluded.updated_at
    RETURNING id::text AS id, (xmax = 0) AS created
  `);
  const row = result.rows[0];
  if (!row) throw new Error("Landing lead upsert returned no row");
  return { leadId: row.id, created: row.created };
}

export async function insertLeadEvent(
  tx: LeadWriteTransaction,
  event: {
    leadId: string;
    kind: LandingLeadEventKind;
    payload: Record<string, unknown>;
    publicRequestId?: string;
    actorPlatformUserId?: string | null;
  },
  now: Date,
  createId: () => string = randomUUID,
): Promise<string> {
  const id = createId();
  await tx.insert(schema.landingLeadEvents).values({
    id,
    leadId: event.leadId,
    kind: event.kind,
    payload: event.payload,
    publicRequestId: event.publicRequestId ?? null,
    actorPlatformUserId: event.actorPlatformUserId ?? null,
    createdAt: now,
  });
  return id;
}

/** Telegram outbox row in the caller's transaction (spec §15.4). */
export async function insertLeadNotification(
  tx: LeadWriteTransaction,
  notification: {
    leadId: string;
    eventId: string;
    kind: "new_lead" | "invoice_request";
    /** Whether this form created the lead; decided in the write, not guessed later. */
    firstContact: boolean;
  },
  now: Date,
  createId: () => string = randomUUID,
): Promise<void> {
  await tx.insert(schema.leadNotifications).values({
    id: createId(),
    leadId: notification.leadId,
    eventId: notification.eventId,
    kind: notification.kind,
    payload: { firstContact: notification.firstContact },
    nextAttemptAt: now,
    createdAt: now,
    updatedAt: now,
  });
}

/** Whether a public form request was already accepted (its event is the idempotency key). */
export async function leadRequestSeen(
  tx: LeadWriteTransaction,
  publicRequestId: string,
): Promise<boolean> {
  const result = await tx.execute<{ seen: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM landing_lead_events WHERE public_request_id = ${publicRequestId}::uuid
    ) AS seen
  `);
  return result.rows[0]?.seen === true;
}

export function leadUrl(adminOrigin: string, leadId: string): string {
  return `${adminOrigin.replace(/\/$/, "")}/leads/${leadId}`;
}
