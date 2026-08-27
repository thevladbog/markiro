import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import { EntitlementsService } from "../../subscriptions/entitlements.service";
import { ObjectStorageService } from "../storage/object-storage.service";
import type {
  ListDocumentsQueryDto,
  ListInvoicesQueryDto,
  PrivateDownloadDto,
  TenantBillingOverviewDto,
  TenantDocumentDto,
  TenantInvoiceDetailDto,
  TenantInvoiceDto,
  TenantOfferDetailDto,
  TenantSubscriptionBillingDto,
} from "./dto";

type InvoiceRow = typeof schema.invoices.$inferSelect;
type DocumentRow = typeof schema.invoiceDocuments.$inferSelect;

@Injectable()
export class TenantBillingReadService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: ObjectStorageService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async overview(tenantId: string): Promise<TenantBillingOverviewDto> {
    const [subscription, scheduledSubscription, limits, offer, requests, invoices, services, acts] =
      await Promise.all([
        this.currentSubscription(tenantId),
        this.scheduledSubscription(tenantId),
        this.subscriptionBilling(tenantId),
        this.db
          .select({
            id: schema.commercialOffers.id,
            number: schema.commercialOffers.number,
            total: schema.commercialOffers.total,
          })
          .from(schema.commercialOffers)
          .where(
            and(
              eq(schema.commercialOffers.tenantId, tenantId),
              eq(schema.commercialOffers.status, "published"),
            ),
          )
          .orderBy(desc(schema.commercialOffers.publishedAt))
          .limit(1),
        this.db
          .select()
          .from(schema.tenantBillingRequests)
          .where(eq(schema.tenantBillingRequests.tenantId, tenantId))
          .orderBy(desc(schema.tenantBillingRequests.updatedAt))
          .limit(100),
        this.db
          .select()
          .from(schema.invoices)
          .where(
            and(
              eq(schema.invoices.tenantId, tenantId),
              inArray(schema.invoices.status, ["issued", "partially_paid"]),
            ),
          )
          .orderBy(desc(schema.invoices.updatedAt))
          .limit(20),
        this.db
          .select()
          .from(schema.orderedServices)
          .where(eq(schema.orderedServices.tenantId, tenantId))
          .orderBy(desc(schema.orderedServices.orderedAt))
          .limit(20),
        this.db
          .select()
          .from(schema.billingActs)
          .where(eq(schema.billingActs.tenantId, tenantId))
          .orderBy(desc(schema.billingActs.updatedAt))
          .limit(20),
      ]);
    const now = new Date();
    const activeRequest = requests.find(
      (request) => !["completed", "cancelled"].includes(request.status),
    );
    const attentionCount =
      requests.filter((request) => request.status === "clarification_required").length +
      invoices.filter((invoice) => this.invoiceStatus(invoice, now) === "overdue").length;
    const recentOperations = [
      ...invoices.map((invoice) => ({
        id: invoice.id,
        kind: "invoice" as const,
        status: this.invoiceStatus(invoice, now),
        occurredAt: iso(invoice.updatedAt)!,
        label: invoice.number,
      })),
      ...services.map((service) => ({
        id: service.id,
        kind: "service" as const,
        status: service.status,
        occurredAt: iso(service.orderedAt)!,
        label: service.nameRu,
      })),
      ...acts.map((act) => ({
        id: act.id,
        kind: "act" as const,
        status: act.status,
        occurredAt: iso(act.updatedAt)!,
        label: act.number,
      })),
    ]
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
      .slice(0, 20);
    return {
      ...limits,
      subscription,
      scheduledSubscription,
      actionableOffer: offer[0] ?? null,
      recentOperations,
      activeRequest: activeRequest
        ? { id: activeRequest.id, number: activeRequest.number, status: activeRequest.status }
        : null,
      attentionCount,
    };
  }

  subscription(tenantId: string): Promise<TenantSubscriptionBillingDto> {
    return this.subscriptionBilling(tenantId);
  }

  async listInvoices(
    tenantId: string,
    query: ListInvoicesQueryDto,
  ): Promise<{ items: TenantInvoiceDto[] }> {
    const conditions = [eq(schema.invoices.tenantId, tenantId)];
    if (query.status && query.status !== "overdue") {
      conditions.push(eq(schema.invoices.status, query.status));
    }
    if (query.from)
      conditions.push(gte(schema.invoices.issueDate, new Date(`${query.from}T00:00:00.000Z`)));
    if (query.to)
      conditions.push(lte(schema.invoices.issueDate, new Date(`${query.to}T23:59:59.999Z`)));
    const invoices = await this.db
      .select()
      .from(schema.invoices)
      .where(and(...conditions))
      .orderBy(desc(schema.invoices.issuedAt), desc(schema.invoices.createdAt))
      .limit(100);
    const invoicesWithStatus = invoices
      .map((invoice) => this.toInvoice(invoice, [], new Date()))
      .filter((invoice) => query.status === undefined || invoice.status === query.status)
      .slice(query.offset, query.offset + query.limit);
    const ids = invoicesWithStatus.map((invoice) => invoice.id);
    if (ids.length === 0) return { items: [] };
    const payments = await this.db
      .select()
      .from(schema.billingPayments)
      .where(
        and(
          eq(schema.billingPayments.tenantId, tenantId),
          inArray(schema.billingPayments.invoiceId, ids),
        ),
      )
      .orderBy(schema.billingPayments.paidAt, schema.billingPayments.id);
    return {
      items: invoicesWithStatus.map((invoice) =>
        this.toInvoice(
          invoices.find((row) => row.id === invoice.id)!,
          payments.filter((payment) => payment.invoiceId === invoice.id),
          new Date(),
        ),
      ),
    };
  }

  async invoiceDetail(tenantId: string, id: string): Promise<TenantInvoiceDetailDto> {
    const [invoice] = await this.db
      .select()
      .from(schema.invoices)
      .where(and(eq(schema.invoices.tenantId, tenantId), eq(schema.invoices.id, id)))
      .limit(1);
    if (!invoice) throw new NotFoundException({ code: "invoice_not_found" });
    const [lines, documents, payments, links] = await Promise.all([
      this.db
        .select()
        .from(schema.invoiceLines)
        .where(
          and(eq(schema.invoiceLines.tenantId, tenantId), eq(schema.invoiceLines.invoiceId, id)),
        )
        .orderBy(schema.invoiceLines.position),
      this.db
        .select()
        .from(schema.invoiceDocuments)
        .where(
          and(
            eq(schema.invoiceDocuments.tenantId, tenantId),
            eq(schema.invoiceDocuments.invoiceId, id),
          ),
        )
        .orderBy(desc(schema.invoiceDocuments.revision)),
      this.db
        .select()
        .from(schema.billingPayments)
        .where(
          and(
            eq(schema.billingPayments.tenantId, tenantId),
            eq(schema.billingPayments.invoiceId, id),
          ),
        )
        .orderBy(schema.billingPayments.paidAt, schema.billingPayments.id),
      this.db
        .select()
        .from(schema.tenantBillingRequestLinks)
        .where(
          and(
            eq(schema.tenantBillingRequestLinks.tenantId, tenantId),
            eq(schema.tenantBillingRequestLinks.invoiceId, id),
          ),
        )
        .limit(1),
    ]);
    const request = await this.requestForLink(tenantId, links[0]?.requestId);
    return {
      ...this.toInvoice(invoice, payments, new Date()),
      subtotal: invoice.subtotal,
      vatTotal: invoice.vatTotal,
      payments: payments.map((payment) => ({
        id: payment.id,
        amount: payment.amount,
        currency: "RUB",
        paidAt: iso(payment.paidAt)!,
      })),
      lines: lines.map((line) => ({
        id: line.id,
        position: line.position,
        nameRu: line.nameRu,
        unit: line.unit,
        quantity: line.quantity,
        agreedUnitPrice: line.agreedUnitPrice,
        lineTotal: line.lineTotal,
      })),
      documents: documents.map((document) => this.invoiceDocument(document)),
      request,
    };
  }

  async listDocuments(
    tenantId: string,
    query: ListDocumentsQueryDto,
  ): Promise<{ items: TenantDocumentDto[] }> {
    const from = query.from ? new Date(`${query.from}T00:00:00.000Z`) : undefined;
    const to = query.to ? new Date(`${query.to}T23:59:59.999Z`) : undefined;
    const offerConditions = [eq(schema.commercialOfferDocuments.tenantId, tenantId)];
    const actConditions = [eq(schema.billingActDocuments.tenantId, tenantId)];
    if (from) {
      offerConditions.push(gte(schema.commercialOfferDocuments.createdAt, from));
      actConditions.push(gte(schema.billingActDocuments.createdAt, from));
    }
    if (to) {
      offerConditions.push(lte(schema.commercialOfferDocuments.createdAt, to));
      actConditions.push(lte(schema.billingActDocuments.createdAt, to));
    }
    const [offerDocuments, actDocuments] = await Promise.all([
      query.type === "act"
        ? []
        : this.db
            .select()
            .from(schema.commercialOfferDocuments)
            .where(and(...offerConditions))
            .orderBy(desc(schema.commercialOfferDocuments.createdAt))
            .limit(100),
      query.type === "offer"
        ? []
        : this.db
            .select()
            .from(schema.billingActDocuments)
            .where(and(...actConditions))
            .orderBy(desc(schema.billingActDocuments.createdAt))
            .limit(100),
    ]);
    return {
      items: [
        ...offerDocuments.map((document) => ({
          id: document.id,
          type: "offer" as const,
          entityId: document.offerId,
          revision: document.revision,
          format: document.format as "pdf" | "html",
          status: document.status as "pending" | "ready" | "failed",
          contentType: document.contentType,
          byteSize: document.byteSize,
          createdAt: iso(document.createdAt)!,
        })),
        ...actDocuments.map((document) => ({
          id: document.id,
          type: "act" as const,
          entityId: document.actId,
          revision: document.revision,
          format: "pdf" as const,
          status: "ready" as const,
          contentType: document.contentType,
          byteSize: document.byteSize,
          createdAt: iso(document.createdAt)!,
        })),
      ]
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(query.offset, query.offset + query.limit),
    };
  }

  async offerDetail(tenantId: string, id: string): Promise<TenantOfferDetailDto> {
    const [offer] = await this.db
      .select()
      .from(schema.commercialOffers)
      .where(
        and(eq(schema.commercialOffers.tenantId, tenantId), eq(schema.commercialOffers.id, id)),
      )
      .limit(1);
    if (!offer) throw new NotFoundException({ code: "offer_not_found" });
    const [lines, documents, links] = await Promise.all([
      this.db
        .select()
        .from(schema.commercialOfferLines)
        .where(
          and(
            eq(schema.commercialOfferLines.tenantId, tenantId),
            eq(schema.commercialOfferLines.offerId, id),
          ),
        )
        .orderBy(schema.commercialOfferLines.position),
      this.db
        .select()
        .from(schema.commercialOfferDocuments)
        .where(
          and(
            eq(schema.commercialOfferDocuments.tenantId, tenantId),
            eq(schema.commercialOfferDocuments.offerId, id),
          ),
        )
        .orderBy(desc(schema.commercialOfferDocuments.revision)),
      this.db
        .select()
        .from(schema.tenantBillingRequestLinks)
        .where(
          and(
            eq(schema.tenantBillingRequestLinks.tenantId, tenantId),
            eq(schema.tenantBillingRequestLinks.offerId, id),
          ),
        )
        .limit(1),
    ]);
    return {
      id: offer.id,
      number: offer.number,
      status: offer.status,
      total: offer.total,
      expiresAt: iso(offer.expiresAt),
      publishedAt: iso(offer.publishedAt),
      paidAt: iso(offer.paidAt),
      termsMarkdown: offer.termsMarkdown,
      lines: lines.map((line) => ({
        id: line.id,
        position: line.position,
        kind: line.kind,
        nameRu: line.nameRu,
        quantity: line.quantity,
        unit: line.unit,
        agreedUnitPrice: line.agreedUnitPrice,
        lineTotal: line.lineTotal,
      })),
      documents: documents.map((document) => ({
        id: document.id,
        revision: document.revision,
        format: document.format as "pdf" | "html",
        status: document.status as "pending" | "ready" | "failed",
        contentType: document.contentType,
        byteSize: document.byteSize,
        createdAt: iso(document.createdAt)!,
      })),
      request: await this.requestForLink(tenantId, links[0]?.requestId),
    };
  }

  async downloadInvoiceDocument(
    tenantId: string,
    invoiceId: string,
    documentId: string,
  ): Promise<PrivateDownloadDto> {
    const [document] = await this.db
      .select({
        objectKey: schema.invoiceDocuments.objectKey,
        status: schema.invoiceDocuments.status,
      })
      .from(schema.invoiceDocuments)
      .where(
        and(
          eq(schema.invoiceDocuments.tenantId, tenantId),
          eq(schema.invoiceDocuments.invoiceId, invoiceId),
          eq(schema.invoiceDocuments.id, documentId),
        ),
      )
      .limit(1);
    return this.presigned(
      document?.objectKey,
      document?.status === "ready",
      "invoice_document_not_ready",
    );
  }

  async downloadOfferDocument(
    tenantId: string,
    offerId: string,
    documentId: string,
  ): Promise<PrivateDownloadDto> {
    const [document] = await this.db
      .select({
        objectKey: schema.commercialOfferDocuments.objectKey,
        status: schema.commercialOfferDocuments.status,
      })
      .from(schema.commercialOfferDocuments)
      .where(
        and(
          eq(schema.commercialOfferDocuments.tenantId, tenantId),
          eq(schema.commercialOfferDocuments.offerId, offerId),
          eq(schema.commercialOfferDocuments.id, documentId),
        ),
      )
      .limit(1);
    return this.presigned(
      document?.objectKey,
      document?.status === "ready",
      "offer_document_not_ready",
    );
  }

  async downloadActDocument(
    tenantId: string,
    actId: string,
    documentId: string,
  ): Promise<PrivateDownloadDto> {
    const [document] = await this.db
      .select({ objectKey: schema.billingActDocuments.objectKey })
      .from(schema.billingActDocuments)
      .where(
        and(
          eq(schema.billingActDocuments.tenantId, tenantId),
          eq(schema.billingActDocuments.actId, actId),
          eq(schema.billingActDocuments.id, documentId),
        ),
      )
      .limit(1);
    return this.presigned(
      document?.objectKey,
      Boolean(document?.objectKey),
      "act_document_not_found",
    );
  }

  private async subscriptionBilling(tenantId: string): Promise<TenantSubscriptionBillingDto> {
    const [subscription, scheduledSubscription, resolved] = await Promise.all([
      this.currentSubscription(tenantId),
      this.scheduledSubscription(tenantId),
      this.entitlements.resolve(tenantId),
    ]);
    return {
      subscription,
      scheduledSubscription,
      access: resolved.access,
      limits: { ...resolved.quotas, ...resolved.features },
    };
  }

  private async currentSubscription(tenantId: string) {
    const [subscription] = await this.db
      .select()
      .from(schema.tenantSubscriptions)
      .where(
        and(
          eq(schema.tenantSubscriptions.tenantId, tenantId),
          inArray(schema.tenantSubscriptions.status, ["pending_activation", "trial", "active"]),
        ),
      )
      .orderBy(desc(schema.tenantSubscriptions.updatedAt))
      .limit(1);
    return subscription ? this.subscriptionDto(subscription) : null;
  }

  private async scheduledSubscription(tenantId: string) {
    const [subscription] = await this.db
      .select()
      .from(schema.tenantSubscriptions)
      .where(
        and(
          eq(schema.tenantSubscriptions.tenantId, tenantId),
          eq(schema.tenantSubscriptions.status, "scheduled"),
        ),
      )
      .orderBy(desc(schema.tenantSubscriptions.updatedAt))
      .limit(1);
    return subscription ? this.subscriptionDto(subscription) : null;
  }

  private async subscriptionDto(subscription: typeof schema.tenantSubscriptions.$inferSelect) {
    const [version] = await this.db
      .select({ nameRu: schema.catalogItemVersions.nameRu })
      .from(schema.catalogItemVersions)
      .where(eq(schema.catalogItemVersions.id, subscription.planVersionId))
      .limit(1);
    return {
      id: subscription.id,
      planVersionId: subscription.planVersionId,
      status: subscription.status,
      startsAt: iso(subscription.startsAt),
      endsAt: iso(subscription.endsAt),
      planName: version?.nameRu ?? null,
    };
  }

  private async requestForLink(tenantId: string, requestId: string | null | undefined) {
    if (!requestId) return null;
    const [request] = await this.db
      .select({
        id: schema.tenantBillingRequests.id,
        number: schema.tenantBillingRequests.number,
        status: schema.tenantBillingRequests.status,
      })
      .from(schema.tenantBillingRequests)
      .where(
        and(
          eq(schema.tenantBillingRequests.tenantId, tenantId),
          eq(schema.tenantBillingRequests.id, requestId),
        ),
      )
      .limit(1);
    return request ?? null;
  }

  private toInvoice(
    invoice: InvoiceRow,
    payments: Array<typeof schema.billingPayments.$inferSelect>,
    now: Date,
  ): TenantInvoiceDto {
    return {
      id: invoice.id,
      number: invoice.number,
      status: this.invoiceStatus(invoice, now),
      issueDate: iso(invoice.issueDate),
      dueDate: iso(invoice.dueDate),
      total: invoice.total,
      currency: "RUB",
      paymentSummary:
        invoice.status === "draft" || invoice.status === "cancelled"
          ? null
          : paymentSummary(invoice.total, payments),
    };
  }

  private invoiceStatus(invoice: InvoiceRow, now: Date) {
    return (invoice.status === "issued" || invoice.status === "partially_paid") &&
      invoice.dueDate &&
      invoice.dueDate < now
      ? "overdue"
      : invoice.status;
  }

  private invoiceDocument(document: DocumentRow) {
    return {
      id: document.id,
      revision: document.revision,
      format: document.format as "pdf" | "html",
      status: document.status as "pending" | "ready" | "failed",
      contentType: document.contentType,
      byteSize: document.byteSize,
      createdAt: iso(document.createdAt)!,
    };
  }

  private async presigned(
    objectKey: string | null | undefined,
    ready: boolean,
    code: string,
  ): Promise<PrivateDownloadDto> {
    if (!ready || !objectKey) throw new NotFoundException({ code });
    return { url: await this.storage.presignRead(objectKey, 300) };
  }
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function money(value: bigint): string {
  return `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;
}
function cents(value: string): bigint {
  const [whole, fraction = "00"] = value.split(".");
  return BigInt(whole ?? "0") * 100n + BigInt(fraction.padEnd(2, "0"));
}
function paymentSummary(
  total: string,
  payments: Array<typeof schema.billingPayments.$inferSelect>,
) {
  const confirmed = payments.reduce((sum, payment) => sum + cents(payment.amount), 0n);
  const remaining = cents(total) - confirmed;
  return {
    confirmedAmount: money(confirmed),
    remainingAmount: money(remaining),
    status:
      remaining === 0n
        ? ("paid" as const)
        : confirmed === 0n
          ? ("issued" as const)
          : ("partially_paid" as const),
  };
}
