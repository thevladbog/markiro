import { assertCommercialPlanSequence } from "./commercial-line-terms";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { and, eq, ne, or, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { calculateOfferAmounts } from "../platform-offers/offer-totals";
import { commercialLineTermsSchema, type CreateInvoiceV2 } from "@markiro/platform-contracts";
import {
  acquireBillingWorkflowLocks,
  type BillingWorkflowResource,
} from "../billing-workflow-locks";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Cancellation frees a whole sale only when no payment or applied evidence remains. */
function invoiceOwnsOffer(tenantId: string, offerId: string) {
  return and(
    eq(schema.invoices.tenantId, tenantId),
    eq(schema.invoices.sourceOfferId, offerId),
    or(
      ne(schema.invoices.status, "cancelled"),
      sql`exists (select 1 from invoice_application_events e where e.tenant_id = ${tenantId} and e.invoice_id = ${schema.invoices.id} and e.status = 'applied')`,
      sql`exists (select 1 from billing_payments p where p.tenant_id = ${tenantId} and p.invoice_id = ${schema.invoices.id})`,
    ),
  );
}

/** Caller holds the offer family/offer locks. Cancelled unfulfilled drafts release the reservation. */
export async function assertOfferInvoiceAvailable(
  tx: Tx,
  tenantId: string,
  offerId: string,
): Promise<void> {
  const [reserved] = await tx
    .select({ id: schema.invoices.id })
    .from(schema.invoices)
    .where(invoiceOwnsOffer(tenantId, offerId))
    .limit(1);
  if (reserved) throw new ConflictException({ code: "offer_invoice_exists" });
}

/** Acquire the complete workflow set before locking the invoice row, including automatic payment entry. */
export async function lockInvoiceCommercialOrigin(tx: Tx, invoiceId: string): Promise<void> {
  const [invoice] = await tx
    .select({ tenantId: schema.invoices.tenantId, sourceOfferId: schema.invoices.sourceOfferId })
    .from(schema.invoices)
    .where(eq(schema.invoices.id, invoiceId))
    .limit(1);
  if (!invoice) throw new NotFoundException({ code: "invoice_not_found" });
  if (!invoice.sourceOfferId) return;
  const resources: BillingWorkflowResource[] = [{ kind: "invoice", id: invoiceId }];
  if (invoice.sourceOfferId) {
    const [offer] = await tx
      .select({ familyId: schema.commercialOffers.familyId })
      .from(schema.commercialOffers)
      .where(
        and(
          eq(schema.commercialOffers.tenantId, invoice.tenantId),
          eq(schema.commercialOffers.id, invoice.sourceOfferId),
        ),
      )
      .limit(1);
    if (!offer) throw new ConflictException({ code: "billing_source_link_invalid" });
    resources.push(
      { kind: "offer_family", id: offer.familyId },
      { kind: "offer", id: invoice.sourceOfferId },
    );
  }
  await acquireBillingWorkflowLocks(tx, invoice.tenantId, resources);
}

export function sourceOfferInvoiceLines(
  source: readonly (typeof schema.commercialOfferLines.$inferSelect)[],
  requested: CreateInvoiceV2["lines"],
): CreateInvoiceV2["lines"] {
  assertCommercialPlanSequence(source, true);
  const copied = source.map((line) => ({
    kind: line.kind === "service" && !line.catalogVersionId ? ("custom" as const) : line.kind,
    catalogVersionId: line.catalogVersionId,
    nameRu: line.nameRu,
    nameEn: line.nameEn,
    descriptionRu: line.descriptionRu,
    descriptionEn: line.descriptionEn,
    quantity: line.quantity,
    unit: line.unit,
    catalogUnitPrice: line.catalogUnitPrice,
    agreedUnitPrice: line.agreedUnitPrice,
    vatRateBps: line.vatRate === null ? null : Math.round(Number(line.vatRate) * 100),
    vatIncluded: line.vatIncluded,
    activationPolicy:
      line.kind === "plan"
        ? line.activationPolicy === "after_current"
          ? ("after_current" as const)
          : ("immediate" as const)
        : line.kind === "addon"
          ? commercialLineTermsSchema.safeParse(line.commercialTerms).data?.activationRule ===
            "after_current"
            ? ("after_current" as const)
            : ("immediate" as const)
          : null,
  }));
  if (
    source.length !== requested.length ||
    copied.some((line, index) => {
      const candidate = requested[index];
      if (!candidate) return true;
      return Object.entries(candidate).some(([key, value]) => {
        if (value === undefined) return false;
        if (key === "commercialTerms") {
          const current = commercialLineTermsSchema.safeParse(value);
          const frozen = commercialLineTermsSchema.safeParse(source[index]?.commercialTerms);
          return (
            !current.success ||
            !frozen.success ||
            JSON.stringify(current.data) !== JSON.stringify(frozen.data)
          );
        }
        return value !== line[key as keyof typeof line];
      });
    })
  )
    throw new ConflictException({ code: "offer_invoice_lines_mismatch" });
  return copied;
}

export async function validateInvoiceSaleOrigin(
  tx: Tx,
  invoice: typeof schema.invoices.$inferSelect,
): Promise<void> {
  if (!invoice.sourceOfferId) return;
  const [paidOffer] = await tx
    .select({ id: schema.payments.id })
    .from(schema.payments)
    .where(
      and(
        eq(schema.payments.tenantId, invoice.tenantId),
        eq(schema.payments.offerId, invoice.sourceOfferId),
      ),
    )
    .limit(1);
  if (paidOffer) throw new ConflictException({ code: "commercial_sale_already_fulfilled" });
  const siblings = await tx
    .select({ id: schema.invoices.id })
    .from(schema.invoices)
    .where(invoiceOwnsOffer(invoice.tenantId, invoice.sourceOfferId));
  if (siblings.length !== 1 || siblings[0]?.id !== invoice.id)
    throw new ConflictException({ code: "commercial_source_review_required" });
  const source = await tx
    .select()
    .from(schema.commercialOfferLines)
    .where(
      and(
        eq(schema.commercialOfferLines.tenantId, invoice.tenantId),
        eq(schema.commercialOfferLines.offerId, invoice.sourceOfferId),
      ),
    )
    .orderBy(schema.commercialOfferLines.position);
  const lines = await tx
    .select()
    .from(schema.invoiceLines)
    .where(
      and(
        eq(schema.invoiceLines.tenantId, invoice.tenantId),
        eq(schema.invoiceLines.invoiceId, invoice.id),
      ),
    )
    .orderBy(schema.invoiceLines.position);
  if (
    source.some((line) => !commercialLineTermsSchema.safeParse(line.commercialTerms).success) ||
    lines.some((line) => !commercialLineTermsSchema.safeParse(line.commercialTerms).success)
  )
    throw new ConflictException({ code: "commercial_source_review_required" });
  const amounts = await sourceOfferAmounts(tx, invoice.tenantId, invoice.sourceOfferId, source);
  if (
    invoice.total !== amounts.total ||
    invoice.subtotal !== amounts.subtotal ||
    invoice.vatTotal !== amounts.vatTotal ||
    lines.some((line, index) => {
      const frozen = amounts.lines[index];
      return (
        !frozen ||
        line.lineSubtotal !== frozen.lineSubtotal ||
        line.lineVat !== frozen.lineVat ||
        line.lineTotal !== frozen.lineTotal
      );
    })
  )
    throw new ConflictException({ code: "commercial_source_review_required" });
  sourceOfferInvoiceLines(
    source,
    lines.map((line) => ({
      kind: line.kind,
      catalogVersionId: line.catalogVersionId,
      nameRu: line.nameRu,
      nameEn: line.nameEn,
      descriptionRu: line.descriptionRu,
      descriptionEn: line.descriptionEn,
      quantity: line.quantity,
      unit: line.unit,
      catalogUnitPrice: line.catalogUnitPrice,
      agreedUnitPrice: line.agreedUnitPrice,
      vatRateBps: line.vatRate === null ? null : Math.round(Number(line.vatRate) * 100),
      vatIncluded: line.vatIncluded,
      activationPolicy: line.activationPolicy,
      commercialTerms: commercialLineTermsSchema.parse(line.commercialTerms),
    })),
  );
}

/** Verify every available immutable amount before adapting the accepted source. */
export async function sourceOfferAmounts(
  tx: Tx,
  tenantId: string,
  offerId: string,
  lines: readonly (typeof schema.commercialOfferLines.$inferSelect)[],
) {
  if (lines.some((line) => !commercialLineTermsSchema.safeParse(line.commercialTerms).success))
    throw new ConflictException({ code: "commercial_source_review_required" });
  const amounts = calculateOfferAmounts(
    lines.map((line) => ({
      quantity: line.quantity,
      unitPrice: line.agreedUnitPrice,
      vatRateBps: line.vatRate === null ? null : Math.round(Number(line.vatRate) * 100),
      vatIncluded: line.vatIncluded,
    })),
  );
  const [offer] = await tx
    .select()
    .from(schema.commercialOffers)
    .where(
      and(eq(schema.commercialOffers.tenantId, tenantId), eq(schema.commercialOffers.id, offerId)),
    );
  const [snapshot] = await tx
    .select()
    .from(schema.commercialOfferPrintSnapshots)
    .where(
      and(
        eq(schema.commercialOfferPrintSnapshots.tenantId, tenantId),
        eq(schema.commercialOfferPrintSnapshots.offerId, offerId),
      ),
    );
  const conflict = () => new ConflictException({ code: "commercial_source_review_required" });
  if (
    !offer ||
    offer.total !== amounts.total ||
    lines.some((line, index) => line.lineTotal !== amounts.lines[index]?.lineTotal)
  )
    throw conflict();
  if (!snapshot && lines.some((line) => line.vatRate !== null)) throw conflict();
  if (snapshot) {
    if (
      snapshot.total !== amounts.total ||
      snapshot.subtotal !== amounts.subtotal ||
      snapshot.vatTotal !== amounts.vatTotal ||
      !Array.isArray(snapshot.linesSnapshot) ||
      snapshot.linesSnapshot.length !== lines.length
    )
      throw conflict();
    for (const [index, value] of snapshot.linesSnapshot.entries()) {
      if (!value || typeof value !== "object") throw conflict();
      const frozen = value as Record<string, unknown>,
        line = lines[index],
        amount = amounts.lines[index];
      if (!line || !amount) throw conflict();
      for (const key of [
        "id",
        "position",
        "quantity",
        "agreedUnitPrice",
        "vatRate",
        "vatIncluded",
        "lineTotal",
      ] as const)
        if (frozen[key] !== line[key]) throw conflict();
      for (const key of ["lineSubtotal", "lineVat"] as const)
        if (frozen[key] !== undefined && frozen[key] !== amount[key]) throw conflict();
      // Prefer actual immutable amounts; derive only absent fields after all source checks agree.
      amounts.lines[index] = {
        lineSubtotal:
          typeof frozen.lineSubtotal === "string" ? frozen.lineSubtotal : amount.lineSubtotal,
        lineVat: typeof frozen.lineVat === "string" ? frozen.lineVat : amount.lineVat,
        lineTotal: line.lineTotal,
      };
    }
    return {
      ...amounts,
      subtotal: snapshot.subtotal,
      vatTotal: snapshot.vatTotal,
      total: snapshot.total,
    };
  }
  return amounts;
}
