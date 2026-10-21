import { randomUUID } from "node:crypto";
import type { PlatformRole } from "@markiro/db";
import {
  STANDALONE_SITE_LEAD_IDS_MAX,
  type LandingLeadStatus,
  type StandaloneSiteLeadLink,
} from "@markiro/platform-contracts";
import { sql } from "drizzle-orm";
import type { PlatformAuditService } from "../../platform-auth/platform-audit.service";
import { insertLeadEvent, type LeadWriteTransaction } from "./landing-lead-writer";

/** What the registration of a site did with the landing leads of its request INN. */
export type ActivationLeadOutcome =
  | { outcome: "linked"; leadId: string }
  | { outcome: "unresolved"; leadIds: string[] }
  | { outcome: "none" };

/** Statuses an activation request moves on to `trial` (spec 2026-10-20 §15.6). */
const BEFORE_TRIAL: readonly LandingLeadStatus[] = ["new", "contacted"];

/**
 * Spec 2026-10-20 §15.6: a site registered from an activation request links the
 * landing lead with the same INN to the tenant, records `activation_request` and
 * moves a `new` or `contacted` lead to `trial`. The request carries no e-mail, so
 * the INN is the only key; an anonymized lead is no longer a candidate. Exactly one
 * candidate, unlinked or already this tenant's, is linked; several, or one linked to
 * another tenant, are left for the operator (`unresolved`), never chosen silently.
 * Runs in the registration's transaction, which holds the leads FOR UPDATE.
 */
export async function linkLeadOnActivation(
  tx: LeadWriteTransaction,
  audit: PlatformAuditService,
  input: {
    inn: string | null;
    tenantId: string;
    siteId: string;
    hostId: string;
    intent: "create" | "rebind";
    requestId: string;
    actor: { id: string; role: PlatformRole };
    now: Date;
    createId?: () => string;
  },
): Promise<ActivationLeadOutcome | null> {
  if (input.inn === null) return null;
  const createId = input.createId ?? randomUUID;
  const candidates = await tx.execute<{
    id: string;
    status: LandingLeadStatus;
    tenantId: string | null;
  }>(sql`
    SELECT id::text AS id, status, tenant_id AS "tenantId" FROM landing_leads
    WHERE inn = ${input.inn} AND anonymized_at IS NULL
    ORDER BY created_at, id
    LIMIT ${STANDALONE_SITE_LEAD_IDS_MAX}
    FOR UPDATE
  `);
  const [lead, ...others] = candidates.rows;
  if (!lead) return { outcome: "none" };
  if (others.length > 0 || (lead.tenantId !== null && lead.tenantId !== input.tenantId))
    return { outcome: "unresolved", leadIds: candidates.rows.map((row) => row.id) };
  const status: LandingLeadStatus = BEFORE_TRIAL.includes(lead.status) ? "trial" : lead.status;
  const statusChanged = status !== lead.status;
  const tenantLinked = lead.tenantId === null;
  await tx.execute(sql`
    UPDATE landing_leads SET
      tenant_id = ${input.tenantId},
      status = ${status},
      status_changed_at = CASE WHEN ${statusChanged} THEN ${input.now} ELSE status_changed_at END,
      updated_at = ${input.now}
    WHERE id = ${lead.id}::uuid
  `);
  const event = (kind: "linked_tenant" | "activation_request" | "status_change", payload: object) =>
    insertLeadEvent(
      tx,
      { leadId: lead.id, kind, payload: { ...payload }, actorPlatformUserId: input.actor.id },
      input.now,
      createId,
    );
  if (tenantLinked) {
    await event("linked_tenant", {
      tenantId: input.tenantId,
      created: false,
      previousTenantId: null,
      via: "activation_request",
    });
    await audit.record(tx, {
      actorPlatformUserId: input.actor.id,
      actorRole: input.actor.role,
      action: "landing_lead.tenant_linked",
      outcome: "success",
      tenantId: input.tenantId,
      targetType: "landing_lead",
      targetId: lead.id,
      reason: "activation_request",
      before: { tenantId: null },
      after: { tenantId: input.tenantId, siteId: input.siteId },
      requestId: input.requestId,
    });
  }
  await event("activation_request", {
    tenantId: input.tenantId,
    siteId: input.siteId,
    hostId: input.hostId,
    intent: input.intent,
  });
  if (statusChanged) {
    await event("status_change", { from: lead.status, to: status, via: "activation_request" });
    await audit.record(tx, {
      actorPlatformUserId: input.actor.id,
      actorRole: input.actor.role,
      action: "landing_lead.status_changed",
      outcome: "success",
      tenantId: input.tenantId,
      targetType: "landing_lead",
      targetId: lead.id,
      reason: "activation_request",
      before: { status: lead.status },
      after: { status },
      requestId: input.requestId,
    });
  }
  return { outcome: "linked", leadId: lead.id };
}

/**
 * The site card's view of the leads with each request INN (spec 2026-10-20 §15.6),
 * by id only: leads linked to this tenant first, otherwise the unresolved candidates.
 */
export async function readSiteLeadLinks(
  tx: Pick<LeadWriteTransaction, "execute">,
  tenantId: string,
  inns: readonly string[],
): Promise<Map<string, StandaloneSiteLeadLink>> {
  const unique = [...new Set(inns)];
  const links = new Map<string, StandaloneSiteLeadLink>();
  if (unique.length === 0) return links;
  const rows = await tx.execute<{ id: string; inn: string; tenantId: string | null }>(sql`
    SELECT id::text AS id, inn, tenant_id AS "tenantId" FROM landing_leads
    WHERE inn IN (${sql.join(
      unique.map((inn) => sql`${inn}`),
      sql`, `,
    )}) AND anonymized_at IS NULL
    ORDER BY created_at, id
  `);
  for (const inn of unique) {
    const leads = rows.rows.filter((row) => row.inn === inn);
    const linked = leads.filter((row) => row.tenantId === tenantId);
    const ids = (list: typeof leads) =>
      list.slice(0, STANDALONE_SITE_LEAD_IDS_MAX).map((row) => row.id);
    links.set(
      inn,
      linked.length > 0
        ? { state: "linked", leadIds: ids(linked) }
        : leads.length > 0
          ? { state: "unresolved", leadIds: ids(leads) }
          : { state: "none", leadIds: [] },
    );
  }
  return links;
}
