import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, gt, gte, inArray, lt, lte } from "drizzle-orm";
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
    const now = new Date();
    const [billing, offers, requests, invoices, payments, acts] = await Promise.all([
      this.subscriptionBilling(tenantId, now),
      this.db
        .select()
        .from(schema.commercialOffers)
        .where(eq(schema.commercialOffers.tenantId, tenantId)),
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
            inArray(schema.invoices.status, ["issued", "partially_paid", "paid"]),
          ),
        )
        .orderBy(desc(schema.invoices.updatedAt))
        .limit(20),
      this.db
        .select()
        .from(schema.billingPayments)
        .where(eq(schema.billingPayments.tenantId, tenantId))
        .orderBy(desc(schema.billingPayments.paidAt))
        .limit(20),
      this.db
        .select()
        .from(schema.billingActs)
        .where(eq(schema.billingActs.tenantId, tenantId))
        .orderBy(desc(schema.billingActs.updatedAt))
        .limit(20),
    ]);
    const actionableOffer = this.actionableOffer(offers, now);
    const activeRequest = requests.find(
      (request) => !["completed", "cancelled"].includes(request.status),
    );
    const approachingDeadline = new Date(now);
    approachingDeadline.setUTCDate(approachingDeadline.getUTCDate() + 7);
    const attentionTargets = new Set<string>();
    for (const request of requests) {
      if (request.status === "clarification_required")
        attentionTargets.add(`request:${request.id}`);
    }
    if (actionableOffer) attentionTargets.add(`offer:${actionableOffer.id}`);
    for (const invoice of invoices) {
      if (
        invoice.dueDate &&
        invoice.dueDate <= approachingDeadline &&
        ["issued", "partially_paid"].includes(invoice.status)
      ) {
        attentionTargets.add(`invoice:${invoice.id}`);
      }
    }
    const recentOperations = [
      ...invoices.map((invoice) => ({
        id: invoice.id,
        kind: "invoice" as const,
        status: this.invoiceStatus(invoice, now),
        occurredAt: iso(invoice.updatedAt)!,
        label: invoice.number,
      })),
      ...payments.map((payment) => ({
        id: payment.id,
        kind: "payment" as const,
        status: "confirmed" as const,
        occurredAt: iso(payment.paidAt)!,
        label: "Payment confirmed",
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
      ...billing,
      actionableOffer: actionableOffer
        ? { id: actionableOffer.id, number: actionableOffer.number, total: actionableOffer.total }
        : null,
      recentOperations,
      activeRequest: activeRequest
        ? { id: activeRequest.id, number: activeRequest.number, status: activeRequest.status }
        : null,
      attentionCount: attentionTargets.size,
    };
  }

  subscription(tenantId: string): Promise<TenantSubscriptionBillingDto> {
    return this.subscriptionBilling(tenantId);
  }

  async listInvoices(
    tenantId: string,
    query: ListInvoicesQueryDto,
  ): Promise<{ items: TenantInvoiceDto[] }> {
    const now = new Date();
    const conditions = [eq(schema.invoices.tenantId, tenantId)];
    if (query.status === "overdue") {
      conditions.push(inArray(schema.invoices.status, ["issued", "partially_paid"]));
      conditions.push(lt(schema.invoices.dueDate, now));
    } else if (query.status) {
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
      .offset(query.offset)
      .limit(query.limit);
    const ids = invoices.map((invoice) => invoice.id);
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
      items: invoices.map((invoice) =>
        this.toInvoice(
          invoices.find((row) => row.id === invoice.id)!,
          payments.filter((payment) => payment.invoiceId === invoice.id),
          now,
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
            .orderBy(
              desc(schema.commercialOfferDocuments.createdAt),
              desc(schema.commercialOfferDocuments.id),
            )
            .offset(0)
            .limit(query.offset + query.limit),
      query.type === "offer"
        ? []
        : this.db
            .select()
            .from(schema.billingActDocuments)
            .where(and(...actConditions))
            .orderBy(
              desc(schema.billingActDocuments.createdAt),
              desc(schema.billingActDocuments.id),
            )
            .offset(0)
            .limit(query.offset + query.limit),
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
        .sort((left, right) => {
          const byDate = right.createdAt.localeCompare(left.createdAt);
          return byDate !== 0 ? byDate : right.id.localeCompare(left.id);
        })
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
      status: await this.offerPresentationStatus(tenantId, offer),
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
      `tenants/${tenantId}/invoices/${invoiceId}/`,
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
      `tenants/${tenantId}/offers/${offerId}/`,
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
      `tenants/${tenantId}/acts/${actId}/`,
    );
  }

  private async subscriptionBilling(
    tenantId: string,
    at = new Date(),
  ): Promise<TenantSubscriptionBillingDto> {
    const [subscriptions, resolved, usage, addons, services] = await Promise.all([
      this.db
        .select()
        .from(schema.tenantSubscriptions)
        .where(eq(schema.tenantSubscriptions.tenantId, tenantId))
        .orderBy(
          desc(schema.tenantSubscriptions.startsAt),
          desc(schema.tenantSubscriptions.updatedAt),
        ),
      this.entitlements.resolve(tenantId, this.db, at),
      this.entitlements.usage(tenantId, this.db, at),
      this.db
        .select()
        .from(schema.subscriptionAddons)
        .where(eq(schema.subscriptionAddons.tenantId, tenantId))
        .orderBy(
          desc(schema.subscriptionAddons.startsAt),
          desc(schema.subscriptionAddons.updatedAt),
        ),
      this.db
        .select()
        .from(schema.orderedServices)
        .where(eq(schema.orderedServices.tenantId, tenantId))
        .orderBy(desc(schema.orderedServices.orderedAt), desc(schema.orderedServices.id)),
    ]);
    const currentRow = resolved.subscription
      ? (subscriptions.find((row) => row.id === resolved.subscription!.id) ?? null)
      : this.latestEndedSubscription(subscriptions, at);
    const scheduledRow = subscriptions.find(
      (row) => row.status === "scheduled" && row.startsAt !== null && row.startsAt > at,
    );
    const versionIds = [
      ...subscriptions.map((row) => row.planVersionId),
      ...addons.map((row) => row.addonVersionId),
    ];
    const versions =
      versionIds.length === 0
        ? []
        : await this.db
            .select({
              id: schema.catalogItemVersions.id,
              nameRu: schema.catalogItemVersions.nameRu,
              billingPeriod: schema.catalogItemVersions.billingPeriod,
              unitPrice: schema.catalogItemVersions.unitPrice,
            })
            .from(schema.catalogItemVersions)
            .where(inArray(schema.catalogItemVersions.id, versionIds));
    const versionsById = new Map(versions.map((version) => [version.id, version]));
    const limits = { ...resolved.quotas, ...resolved.features };
    return {
      subscription: currentRow
        ? this.subscriptionDto(
            currentRow,
            versionsById.get(currentRow.planVersionId),
            resolved.subscription ? resolved.subscription.status : "expired",
          )
        : null,
      scheduledSubscription: scheduledRow
        ? this.subscriptionDto(
            scheduledRow,
            versionsById.get(scheduledRow.planVersionId),
            "scheduled",
          )
        : null,
      access: resolved.access,
      limits,
      usage,
      limitPresentation: {
        lines: limitPresentation(usage.lines, resolved.quotas.lines),
        stations: limitPresentation(usage.stations, resolved.quotas.stations),
        kiosks: limitPresentation(usage.kiosks, resolved.quotas.kiosks),
        cabinetUsers: limitPresentation(usage.cabinetUsers, resolved.quotas.cabinetUsers),
      },
      addons: addons.map((addon) => ({
        id: addon.id,
        catalogVersionId: addon.addonVersionId,
        name: versionsById.get(addon.addonVersionId)?.nameRu ?? "",
        quantity: addon.quantity,
        status: addon.status,
        startsAt: iso(addon.startsAt),
        endsAt: iso(addon.endsAt),
      })),
      services: services.map((service) => ({
        id: service.id,
        name: service.nameRu,
        quantity: service.quantity,
        unit: service.unit,
        status: service.status,
        orderedAt: iso(service.orderedAt)!,
      })),
    };
  }

  private latestEndedSubscription(
    subscriptions: Array<typeof schema.tenantSubscriptions.$inferSelect>,
    at: Date,
  ) {
    return (
      subscriptions
        .filter(
          (row) =>
            row.status !== "cancelled" &&
            row.status !== "superseded" &&
            row.endsAt !== null &&
            row.endsAt <= at,
        )
        .sort((left, right) => right.endsAt!.getTime() - left.endsAt!.getTime())[0] ?? null
    );
  }

  private subscriptionDto(
    subscription: typeof schema.tenantSubscriptions.$inferSelect,
    version:
      { nameRu: string; billingPeriod: "month" | "year" | null; unitPrice: string } | undefined,
    status: "pending_activation" | "trial" | "active" | "scheduled" | "expired",
  ) {
    return {
      id: subscription.id,
      planVersionId: subscription.planVersionId,
      status,
      startsAt: iso(subscription.startsAt),
      endsAt: iso(subscription.endsAt),
      planName: version?.nameRu ?? null,
      billingPeriod: version?.billingPeriod ?? null,
      price: version?.unitPrice ?? null,
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

  private actionableOffer(offers: Array<typeof schema.commercialOffers.$inferSelect>, at: Date) {
    const latestByFamily = new Map<string, typeof schema.commercialOffers.$inferSelect>();
    for (const offer of offers) {
      const current = latestByFamily.get(offer.familyId);
      if (!current || offer.revision > current.revision) latestByFamily.set(offer.familyId, offer);
    }
    return [...latestByFamily.values()]
      .filter(
        (offer) =>
          offer.status === "published" && (offer.expiresAt === null || offer.expiresAt > at),
      )
      .sort(
        (left, right) =>
          (right.publishedAt?.getTime() ?? 0) - (left.publishedAt?.getTime() ?? 0) ||
          right.revision - left.revision,
      )[0];
  }

  private async offerPresentationStatus(
    tenantId: string,
    offer: typeof schema.commercialOffers.$inferSelect,
  ) {
    if (offer.status === "published" && offer.expiresAt && offer.expiresAt <= new Date()) {
      return "expired" as const;
    }
    const [newer] = await this.db
      .select({ id: schema.commercialOffers.id })
      .from(schema.commercialOffers)
      .where(
        and(
          eq(schema.commercialOffers.tenantId, tenantId),
          eq(schema.commercialOffers.familyId, offer.familyId),
          gt(schema.commercialOffers.revision, offer.revision),
        ),
      )
      .limit(1);
    return newer ? ("superseded" as const) : offer.status;
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

  private invoiceStatus(invoice: InvoiceRow, now: Date): TenantInvoiceDto["status"] {
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
    expectedPrefix: string,
  ): Promise<PrivateDownloadDto> {
    if (!ready || !objectKey || !objectKey.startsWith(expectedPrefix)) {
      throw new NotFoundException({ code });
    }
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

function limitPresentation(used: number, assigned: number | null) {
  if (assigned === null) return { used, assigned, remaining: null, state: "normal" as const };
  const remaining = assigned - used;
  return {
    used,
    assigned,
    remaining,
    state:
      used > assigned
        ? ("exceeded" as const)
        : used === assigned
          ? ("reached" as const)
          : used / assigned >= 0.8
            ? ("approaching" as const)
            : ("normal" as const),
  };
}
