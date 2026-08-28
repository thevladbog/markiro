import { Inject, Injectable, Optional } from "@nestjs/common";
import { resolveCabinetAccess } from "@markiro/domain";
import { schema, type Db } from "@markiro/db";
import type { TenantBillingEventKind } from "@markiro/email";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { DB } from "../../auth/auth.module";
import { MailDeliveryService } from "../mail/mail-delivery.service";

export const BILLING_DUE_SOON_DAYS = 7;
export const TENANT_BILLING_ADMIN_ORIGIN = "TENANT_BILLING_ADMIN_ORIGIN";
export const TENANT_BILLING_CLOCK = "TENANT_BILLING_CLOCK";
const BUSINESS_TIME_ZONE = "Europe/Moscow";
const recipientSchema = z.email();

type Clock = () => Date;
type NotificationTransaction = Pick<Db, "select" | "insert">;

export interface TenantBillingNotificationInput {
  tenantId: string;
  eventKind: TenantBillingEventKind;
  entityId: string;
  revision: number | string;
  subjectName: string;
}

@Injectable()
export class TenantBillingNotificationsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly mail: MailDeliveryService,
    @Inject(TENANT_BILLING_ADMIN_ORIGIN) private readonly adminOrigin: string,
    @Optional() @Inject(TENANT_BILLING_CLOCK) private readonly clock: Clock = () => new Date(),
  ) {}

  async enqueueInTransaction(
    tx: NotificationTransaction,
    input: TenantBillingNotificationInput,
  ): Promise<string[]> {
    const rows = await tx
      .select({
        organizationName: schema.organization.name,
        userId: schema.user.id,
        recipientName: schema.user.name,
        recipient: schema.user.email,
        role: schema.member.role,
      })
      .from(schema.member)
      .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
      .innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
      .where(eq(schema.member.organizationId, input.tenantId))
      .orderBy(schema.user.id, schema.member.id);
    const recipients = new Map<
      string,
      { organizationName: string; userId: string; recipientName: string; recipient: string }
    >();
    for (const row of rows) {
      const roles = resolveCabinetAccess(row.role).roles;
      if (!roles.includes("owner") && !roles.includes("admin")) continue;
      const recipient = row.recipient.trim().toLocaleLowerCase("en-US");
      if (!recipientSchema.safeParse(recipient).success) continue;
      const existing = recipients.get(recipient);
      if (!existing || row.userId.localeCompare(existing.userId) < 0) {
        recipients.set(recipient, { ...row, recipient });
      }
    }
    const sourceId = `billing:${input.eventKind}:${input.entityId}:${input.revision}`;
    const actionUrl = billingActionUrl(this.adminOrigin, input.eventKind, input.entityId);
    const deliveryIds: string[] = [];
    for (const recipient of [...recipients.values()].sort((a, b) =>
      a.recipient.localeCompare(b.recipient),
    )) {
      const deliveryId = await this.mail.enqueueTenantBillingUnique(tx, {
        scope: { tenantId: input.tenantId },
        recipient: recipient.recipient,
        sourceId,
        template: {
          kind: "tenant-billing-notification",
          locale: "ru",
          recipientName: recipient.recipientName,
          organizationName: recipient.organizationName,
          eventKind: input.eventKind,
          subjectName: input.subjectName,
          actionUrl,
        },
      });
      if (deliveryId) deliveryIds.push(deliveryId);
    }
    return deliveryIds;
  }

  async attention(tenantId: string): Promise<{ count: number }> {
    const now = this.clock();
    const today = businessDate(now);
    const result = await this.db.execute<{ count: number | string }>(sql`
      with latest_offers as (
        select distinct on (family_id) id, status, expires_at
        from commercial_offers
        where tenant_id = ${tenantId}
        order by family_id, revision desc, published_at desc nulls last, id desc
      ), attention_targets as (
        select 'request:' || request.id::text as target
        from tenant_billing_requests as request
        where request.tenant_id = ${tenantId}
          and request.status = 'clarification_required'
        union all
        select 'offer:' || offer.id::text as target
        from latest_offers as offer
        where offer.status = 'published'
          and (offer.expires_at is null or offer.expires_at > ${now})
          and not exists (
            select 1
            from commercial_offer_decisions as decision
            where decision.tenant_id = ${tenantId}
              and decision.offer_id = offer.id
          )
        union all
        select 'invoice:' || invoice.id::text as target
        from invoices as invoice
        where invoice.tenant_id = ${tenantId}
          and invoice.status in ('issued', 'partially_paid')
          and (invoice.due_date at time zone ${BUSINESS_TIME_ZONE})::date >= ${today}::date
          and (invoice.due_date at time zone ${BUSINESS_TIME_ZONE})::date <= (${today}::date + ${BILLING_DUE_SOON_DAYS}::int)
      )
      select count(distinct target)::int as count
      from attention_targets
    `);
    return { count: Number(result.rows[0]?.count ?? 0) };
  }

  isDueSoon(dueDate: Date | null): boolean {
    if (!dueDate) return false;
    const today = businessDate(this.clock());
    const due = businessDate(dueDate);
    const days =
      (Date.parse(`${due}T00:00:00.000Z`) - Date.parse(`${today}T00:00:00.000Z`)) / 86_400_000;
    return days >= 0 && days <= BILLING_DUE_SOON_DAYS;
  }
}

function billingActionUrl(origin: string, kind: TenantBillingEventKind, entityId: string): string {
  const base = new URL(origin);
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new Error("Tenant billing admin origin must use http(s)");
  }
  base.username = "";
  base.password = "";
  base.search = "";
  base.hash = "";
  const path =
    kind === "clarification_required"
      ? `/billing/requests/${encodeURIComponent(entityId)}`
      : kind === "offer_published"
        ? `/billing/offers/${encodeURIComponent(entityId)}`
        : kind === "invoice_due_soon"
          ? `/billing/invoices/${encodeURIComponent(entityId)}`
          : "/billing/documents";
  return new URL(path, base.origin).toString();
}

function businessDate(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}
