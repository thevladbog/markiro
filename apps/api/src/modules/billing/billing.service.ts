import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import type {
  InvoiceCreateServiceResultSource,
  InvoiceServiceDetailSource,
  InvoiceServiceRecordSource,
} from "@markiro/platform-contracts";
import { DB } from "../../auth/auth.module";
import type { PlatformPrincipal } from "../../platform-auth/platform-access-policy";
import { PlatformAuditService } from "../../platform-auth/platform-audit.service";
import {
  bankAccountLast4,
  bankAccountSnapshot,
  billingProfileSnapshot,
  resolveCommercialBillingDetails,
} from "./commercial-snapshots";
import type { CreateInvoiceDto } from "./dto";

const cents = (value: string): bigint => {
  const [whole, fraction = "00"] = value.split(".");
  return BigInt(whole ?? "0") * 100n + BigInt(fraction.padEnd(2, "0"));
};
const money = (value: bigint): string =>
  `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;

@Injectable()
export class BillingService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: PlatformAuditService,
  ) {}

  async create(
    principal: PlatformPrincipal,
    input: CreateInvoiceDto,
  ): Promise<InvoiceCreateServiceResultSource> {
    return this.db.transaction(async (tx) => {
      const [tenant] = await tx
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.id, input.tenantId))
        .limit(1);
      if (!tenant) throw new NotFoundException({ code: "tenant_not_found" });
      const sourceRequestId = input.sourceRequestId
        ? await lockInvoiceSourceRequest(tx, input.tenantId, input.sourceRequestId)
        : null;
      const sourceOfferId = input.sourceOfferId
        ? await lockAcceptedInvoiceSourceOffer(tx, input.tenantId, input.sourceOfferId)
        : null;
      const [last] = await tx
        .select({ number: schema.invoices.number })
        .from(schema.invoices)
        .orderBy(desc(schema.invoices.createdAt))
        .limit(1);
      const next = nextInvoiceNumber(last?.number);
      const [invoice] = await tx
        .insert(schema.invoices)
        .values({
          tenantId: input.tenantId,
          number: next,
          sellerBankAccountId: input.sellerBankAccountId ?? null,
          dueDate: input.dueDate ? new Date(input.dueDate) : null,
          applicationMode: input.applicationMode,
          sourceOfferId,
          createdByPlatformUserId: principal.userId,
          subtotal: "0.00",
          vatTotal: "0.00",
          total: "0.00",
        })
        .returning();
      if (!invoice) throw new BadRequestException({ code: "invoice_create_failed" });
      if (sourceRequestId) {
        await tx.insert(schema.tenantBillingRequestLinks).values({
          tenantId: input.tenantId,
          requestId: sourceRequestId,
          invoiceId: invoice.id,
        });
      }

      let subtotal = 0n;
      let vatTotal = 0n;
      let total = 0n;
      for (const [index, line] of input.lines.entries()) {
        const catalog = line.catalogVersionId
          ? await tx
              .select()
              .from(schema.catalogItemVersions)
              .where(
                and(
                  eq(schema.catalogItemVersions.id, line.catalogVersionId),
                  eq(schema.catalogItemVersions.status, "published"),
                ),
              )
              .limit(1)
          : [];
        const version = catalog[0];
        if (line.kind !== "custom" && (!version || version.kind !== line.kind)) {
          throw new BadRequestException({ code: "invoice_catalog_version_invalid" });
        }
        if (line.kind === "custom" && line.catalogVersionId) {
          throw new BadRequestException({ code: "invoice_custom_catalog_reference" });
        }
        const nameRu = version?.nameRu ?? line.nameRu;
        const nameEn = version?.nameEn ?? line.nameEn;
        const unit = version?.unit ?? line.unit;
        if (!nameRu || !nameEn || !unit)
          throw new BadRequestException({ code: "invoice_line_name_required" });
        const vatRateBps =
          line.vatRateBps !== undefined
            ? line.vatRateBps
            : version?.vatRate
              ? Math.round(Number(version.vatRate) * 100)
              : null;
        const rate = BigInt(vatRateBps ?? 0);
        const lineGross = cents(line.agreedUnitPrice) * BigInt(line.quantity);
        const lineVat = line.vatIncluded
          ? (lineGross * rate) / (10_000n + rate)
          : (lineGross * rate) / 10_000n;
        const lineSubtotal = line.vatIncluded ? lineGross - lineVat : lineGross;
        const lineTotal = line.vatIncluded ? lineGross : lineGross + lineVat;
        subtotal += lineSubtotal;
        vatTotal += lineVat;
        total += lineTotal;
        await tx.insert(schema.invoiceLines).values({
          tenantId: input.tenantId,
          invoiceId: invoice.id,
          position: index + 1,
          kind: line.kind,
          catalogVersionId: version?.id ?? null,
          catalogKind: version?.kind ?? null,
          nameRu,
          nameEn,
          descriptionRu:
            line.descriptionRu !== undefined
              ? line.descriptionRu
              : (version?.descriptionRu ?? null),
          descriptionEn:
            line.descriptionEn !== undefined
              ? line.descriptionEn
              : (version?.descriptionEn ?? null),
          quantity: line.quantity,
          unit,
          catalogUnitPrice: version?.unitPrice ?? line.catalogUnitPrice ?? null,
          agreedUnitPrice: line.agreedUnitPrice,
          vatRate: vatRateBps === null ? null : (vatRateBps / 100).toFixed(2),
          vatIncluded: line.vatIncluded,
          lineSubtotal: money(lineSubtotal),
          lineVat: money(lineVat),
          lineTotal: money(lineTotal),
          activationPolicy:
            line.kind === "plan" || line.kind === "addon"
              ? (line.activationPolicy ?? "manual")
              : null,
        });
      }
      const [updated] = await tx
        .update(schema.invoices)
        .set({ subtotal: money(subtotal), vatTotal: money(vatTotal), total: money(total) })
        .where(eq(schema.invoices.id, invoice.id))
        .returning();
      if (!updated) throw new BadRequestException({ code: "invoice_create_failed" });
      return { ...updated, sourceRequestId, lines: input.lines.length };
    });
  }

  async list(tenantId?: string): Promise<{ items: InvoiceServiceRecordSource[] }> {
    const query = this.db.select().from(schema.invoices).orderBy(desc(schema.invoices.createdAt));
    return {
      items: tenantId ? await query.where(eq(schema.invoices.tenantId, tenantId)) : await query,
    };
  }

  async get(id: string): Promise<InvoiceServiceDetailSource> {
    return this.db.transaction(
      async (tx) => {
        const [invoice] = await tx
          .select()
          .from(schema.invoices)
          .where(eq(schema.invoices.id, id))
          .limit(1);
        if (!invoice) throw new NotFoundException({ code: "invoice_not_found" });
        const lines = await tx
          .select()
          .from(schema.invoiceLines)
          .where(eq(schema.invoiceLines.invoiceId, id))
          .orderBy(schema.invoiceLines.position);
        const documents = await tx
          .select({
            id: schema.invoiceDocuments.id,
            revision: schema.invoiceDocuments.revision,
            format: schema.invoiceDocuments.format,
            status: schema.invoiceDocuments.status,
            contentType: schema.invoiceDocuments.contentType,
            byteSize: schema.invoiceDocuments.byteSize,
            sha256: schema.invoiceDocuments.sha256,
            errorCode: schema.invoiceDocuments.errorCode,
            createdAt: schema.invoiceDocuments.createdAt,
            updatedAt: schema.invoiceDocuments.updatedAt,
          })
          .from(schema.invoiceDocuments)
          .where(eq(schema.invoiceDocuments.invoiceId, id))
          .orderBy(desc(schema.invoiceDocuments.revision));
        const payments = await tx
          .select()
          .from(schema.billingPayments)
          .where(
            and(
              eq(schema.billingPayments.tenantId, invoice.tenantId),
              eq(schema.billingPayments.invoiceId, id),
            ),
          )
          .orderBy(schema.billingPayments.paidAt, schema.billingPayments.id);
        const attempts = await tx
          .select()
          .from(schema.invoiceApplicationEvents)
          .where(
            and(
              eq(schema.invoiceApplicationEvents.tenantId, invoice.tenantId),
              eq(schema.invoiceApplicationEvents.invoiceId, id),
            ),
          )
          .orderBy(
            schema.invoiceApplicationEvents.createdAt,
            schema.invoiceApplicationEvents.attempt,
          );
        const latestAttempts = new Map<string, (typeof attempts)[number]>();
        for (const attempt of attempts) {
          const previous = latestAttempts.get(attempt.invoiceLineId);
          if (!previous || attempt.attempt >= previous.attempt) {
            latestAttempts.set(attempt.invoiceLineId, attempt);
          }
        }
        const latestByLine = lines.flatMap((line) => {
          const event = latestAttempts.get(line.id);
          return event ? [event] : [];
        });
        const applicationStatus =
          invoice.status !== "paid"
            ? "not_paid"
            : latestByLine.some((event) => event.status === "failed")
              ? "partial_failure"
              : latestByLine.length < lines.length ||
                  latestByLine.some((event) => event.status === "pending")
                ? "pending"
                : "applied";
        return {
          ...invoice,
          lines,
          documents,
          payments,
          paymentSummary:
            invoice.status === "draft" || invoice.status === "cancelled"
              ? null
              : invoicePaymentSummary(invoice.total, payments),
          application: {
            status: applicationStatus,
            latestByLine,
            attempts,
          },
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  async issue(principal: PlatformPrincipal, id: string): Promise<InvoiceServiceRecordSource> {
    return this.db.transaction(async (tx) => {
      const [invoice] = await tx
        .select()
        .from(schema.invoices)
        .where(eq(schema.invoices.id, id))
        .for("update")
        .limit(1);
      if (!invoice) throw new NotFoundException({ code: "invoice_not_found" });
      if (invoice.status !== "draft") throw new ConflictException({ code: "invoice_not_draft" });
      const { seller, buyer, sellerAccount, buyerAccount } = await resolveCommercialBillingDetails(
        tx,
        invoice.tenantId,
        invoice.sellerBankAccountId,
      );
      const now = new Date();
      const [updated] = await tx
        .update(schema.invoices)
        .set({
          status: "issued",
          issueDate: now,
          issuedAt: now,
          issuedByPlatformUserId: principal.userId,
          sellerBankAccountId: sellerAccount.id,
          sellerSnapshot: billingProfileSnapshot(seller),
          buyerSnapshot: billingProfileSnapshot(buyer),
          sellerBankAccountSnapshot: bankAccountSnapshot(sellerAccount),
          buyerBankAccountSnapshot: buyerAccount ? bankAccountSnapshot(buyerAccount) : null,
        })
        .where(and(eq(schema.invoices.id, id), eq(schema.invoices.status, "draft")))
        .returning();
      if (!updated) throw new ConflictException({ code: "invoice_not_draft" });
      const [sourceLink] = await tx
        .select()
        .from(schema.tenantBillingRequestLinks)
        .where(
          and(
            eq(schema.tenantBillingRequestLinks.tenantId, invoice.tenantId),
            eq(schema.tenantBillingRequestLinks.invoiceId, invoice.id),
          ),
        )
        .for("update")
        .limit(1);
      let sourceRequestId: string | null = null;
      if (sourceLink) {
        const [request] = await tx
          .select()
          .from(schema.tenantBillingRequests)
          .where(
            and(
              eq(schema.tenantBillingRequests.tenantId, invoice.tenantId),
              eq(schema.tenantBillingRequests.id, sourceLink.requestId),
            ),
          )
          .for("update")
          .limit(1);
        if (!request) throw new ConflictException({ code: "billing_source_link_invalid" });
        sourceRequestId = request.id;
        const linkEventIdempotencyKey = randomUUID();
        const [linkEvent] = await tx
          .insert(schema.tenantBillingRequestEvents)
          .values({
            tenantId: invoice.tenantId,
            requestId: request.id,
            kind: "invoice_linked",
            actorKind: "platform_user",
            actorPlatformUserId: principal.userId,
            metadata: { invoiceId: invoice.id, linkId: sourceLink.id },
            idempotencyKey: linkEventIdempotencyKey,
          })
          .returning({ id: schema.tenantBillingRequestEvents.id });
        if (!linkEvent) throw new Error("invoice request link event insert failed");
        await this.audit.record(tx, {
          actorPlatformUserId: principal.userId,
          actorRole: principal.role,
          action: "billing.request.invoice_linked",
          outcome: "success",
          tenantId: invoice.tenantId,
          targetType: "tenant_billing_request",
          targetId: request.id,
          reason: null,
          before: { status: request.status },
          after: { status: request.status, invoiceId: invoice.id, eventId: linkEvent.id },
          requestId: null,
        });
        if (request.status === "offer_prepared") {
          await tx
            .update(schema.tenantBillingRequests)
            .set({ status: "awaiting_payment", responsibleSide: "tenant", updatedAt: now })
            .where(
              and(
                eq(schema.tenantBillingRequests.tenantId, request.tenantId),
                eq(schema.tenantBillingRequests.id, request.id),
                eq(schema.tenantBillingRequests.status, "offer_prepared"),
              ),
            );
          const [statusEvent] = await tx
            .insert(schema.tenantBillingRequestEvents)
            .values({
              tenantId: invoice.tenantId,
              requestId: request.id,
              kind: "status_changed",
              fromStatus: "offer_prepared",
              toStatus: "awaiting_payment",
              actorKind: "platform_user",
              actorPlatformUserId: principal.userId,
              metadata: { invoiceId: invoice.id },
              idempotencyKey: randomUUID(),
            })
            .returning({ id: schema.tenantBillingRequestEvents.id });
          if (!statusEvent) throw new Error("invoice request status event insert failed");
          await this.audit.record(tx, {
            actorPlatformUserId: principal.userId,
            actorRole: principal.role,
            action: "billing.request.status_changed",
            outcome: "success",
            tenantId: invoice.tenantId,
            targetType: "tenant_billing_request",
            targetId: request.id,
            reason: null,
            before: { status: "offer_prepared", responsibleSide: request.responsibleSide },
            after: {
              status: "awaiting_payment",
              responsibleSide: "tenant",
              eventId: statusEvent.id,
              invoiceId: invoice.id,
            },
            requestId: null,
          });
        }
      }
      await this.audit.record(tx, {
        actorPlatformUserId: principal.userId,
        actorRole: principal.role,
        action: "billing.invoice.issued",
        outcome: "success",
        tenantId: invoice.tenantId,
        targetType: "invoice",
        targetId: id,
        reason: null,
        before: { status: invoice.status },
        after: {
          status: "issued",
          number: invoice.number,
          sellerAccountId: sellerAccount.id,
          sellerAccountLast4: bankAccountLast4(sellerAccount),
          buyerAccountId: buyerAccount?.id ?? null,
          buyerAccountLast4: buyerAccount ? bankAccountLast4(buyerAccount) : null,
        },
        requestId: null,
      });
      return { ...updated, sourceRequestId };
    });
  }

  async cancel(principal: PlatformPrincipal, id: string): Promise<InvoiceServiceRecordSource> {
    return this.db.transaction(async (tx) => {
      const [invoice] = await tx
        .select()
        .from(schema.invoices)
        .where(eq(schema.invoices.id, id))
        .for("update")
        .limit(1);
      if (!invoice) throw new NotFoundException({ code: "invoice_not_found" });
      if (invoice.status === "paid" || invoice.status === "partially_paid") {
        throw new ConflictException({ code: "invoice_paid" });
      }
      const [updated] = await tx
        .update(schema.invoices)
        .set({ status: "cancelled", cancelledAt: new Date() })
        .where(and(eq(schema.invoices.id, id), eq(schema.invoices.status, invoice.status)))
        .returning();
      if (!updated) throw new ConflictException({ code: "invoice_cancel_failed" });
      return updated;
    });
  }
}

type InvoiceSourceExecutor = Pick<Db, "select" | "execute">;

async function lockInvoiceSourceRequest(
  tx: InvoiceSourceExecutor,
  tenantId: string,
  requestId: string,
): Promise<string> {
  const [request] = await tx
    .select({
      id: schema.tenantBillingRequests.id,
      tenantId: schema.tenantBillingRequests.tenantId,
    })
    .from(schema.tenantBillingRequests)
    .where(eq(schema.tenantBillingRequests.id, requestId))
    .for("update")
    .limit(1);
  if (!request) throw new NotFoundException({ code: "billing_request_not_found" });
  if (request.tenantId !== tenantId) {
    throw new ConflictException({ code: "billing_source_tenant_mismatch" });
  }
  return request.id;
}

async function lockAcceptedInvoiceSourceOffer(
  tx: InvoiceSourceExecutor,
  tenantId: string,
  offerId: string,
): Promise<string> {
  const [located] = await tx
    .select({
      tenantId: schema.commercialOffers.tenantId,
      familyId: schema.commercialOffers.familyId,
    })
    .from(schema.commercialOffers)
    .where(eq(schema.commercialOffers.id, offerId))
    .limit(1);
  if (!located) throw new NotFoundException({ code: "offer_not_found" });
  if (located.tenantId !== tenantId) {
    throw new ConflictException({ code: "billing_source_tenant_mismatch" });
  }
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`commercial-offer-family:${tenantId}:${located.familyId}`}, 0))`,
  );
  const family = await tx
    .select()
    .from(schema.commercialOffers)
    .where(
      and(
        eq(schema.commercialOffers.tenantId, tenantId),
        eq(schema.commercialOffers.familyId, located.familyId),
      ),
    )
    .orderBy(desc(schema.commercialOffers.revision), desc(schema.commercialOffers.id))
    .for("update");
  const source = family.find((offer) => offer.id === offerId);
  if (!source) throw new NotFoundException({ code: "offer_not_found" });
  const currentPublished = family.find((offer) => offer.status === "published");
  if (source.status !== "published") {
    throw new ConflictException({ code: "offer_not_accepted" });
  }
  if (!currentPublished || currentPublished.id !== source.id) {
    throw new ConflictException({ code: "offer_version_stale" });
  }
  const [decision] = await tx
    .select()
    .from(schema.commercialOfferDecisions)
    .where(
      and(
        eq(schema.commercialOfferDecisions.tenantId, tenantId),
        eq(schema.commercialOfferDecisions.offerId, source.id),
      ),
    )
    .orderBy(
      desc(schema.commercialOfferDecisions.createdAt),
      desc(schema.commercialOfferDecisions.id),
    )
    .for("update")
    .limit(1);
  if (decision?.decision !== "accepted") {
    throw new ConflictException({ code: "offer_not_accepted" });
  }
  return source.id;
}

function invoicePaymentSummary(
  total: string,
  payments: Array<typeof schema.billingPayments.$inferSelect>,
) {
  const totalCents = cents(total);
  const confirmed = payments.reduce((sum, payment) => sum + cents(payment.amount), 0n);
  return {
    confirmedAmount: money(confirmed),
    remainingAmount: money(totalCents - confirmed),
    status:
      confirmed === 0n
        ? ("issued" as const)
        : confirmed === totalCents
          ? ("paid" as const)
          : ("partially_paid" as const),
  };
}

function nextInvoiceNumber(last: string | undefined): string {
  const numeric = last?.match(/(\d+)$/)?.[1];
  return `INV-${String((numeric ? Number(numeric) : 0) + 1).padStart(6, "0")}`;
}
