import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import type { PlatformPrincipal } from "../../platform-auth/platform-access-policy";
import { PlatformAuditService } from "../../platform-auth/platform-audit.service";
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

  async create(principal: PlatformPrincipal, input: CreateInvoiceDto) {
    const [tenant] = await this.db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.id, input.tenantId))
      .limit(1);
    if (!tenant) throw new NotFoundException({ code: "tenant_not_found" });
    return this.db.transaction(async (tx) => {
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
          dueDate: input.dueDate ?? null,
          applicationMode: input.applicationMode,
          createdByPlatformUserId: principal.userId,
          subtotal: "0.00",
          vatTotal: "0.00",
          total: "0.00",
        })
        .returning();
      if (!invoice) throw new BadRequestException({ code: "invoice_create_failed" });

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
          descriptionRu: version?.descriptionRu ?? line.descriptionRu ?? null,
          descriptionEn: version?.descriptionEn ?? line.descriptionEn ?? null,
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
      return { ...updated, lines: input.lines.length };
    });
  }

  async list(tenantId?: string) {
    const query = this.db.select().from(schema.invoices).orderBy(desc(schema.invoices.createdAt));
    return {
      items: tenantId ? await query.where(eq(schema.invoices.tenantId, tenantId)) : await query,
    };
  }

  async get(id: string) {
    const [invoice] = await this.db
      .select()
      .from(schema.invoices)
      .where(eq(schema.invoices.id, id))
      .limit(1);
    if (!invoice) throw new NotFoundException({ code: "invoice_not_found" });
    const lines = await this.db
      .select()
      .from(schema.invoiceLines)
      .where(eq(schema.invoiceLines.invoiceId, id));
    const documents = await this.db
      .select()
      .from(schema.invoiceDocuments)
      .where(eq(schema.invoiceDocuments.invoiceId, id));
    return { ...invoice, lines, documents };
  }

  async issue(principal: PlatformPrincipal, id: string) {
    return this.db.transaction(async (tx) => {
      const [invoice] = await tx
        .select()
        .from(schema.invoices)
        .where(eq(schema.invoices.id, id))
        .limit(1);
      if (!invoice) throw new NotFoundException({ code: "invoice_not_found" });
      if (invoice.status !== "draft") throw new ConflictException({ code: "invoice_not_draft" });
      const [seller] = await tx
        .select()
        .from(schema.operatorBillingProfiles)
        .where(eq(schema.operatorBillingProfiles.isCurrent, true))
        .limit(1);
      const [buyer] = await tx
        .select()
        .from(schema.tenantBillingProfiles)
        .where(
          and(
            eq(schema.tenantBillingProfiles.tenantId, invoice.tenantId),
            eq(schema.tenantBillingProfiles.isCurrent, true),
          ),
        )
        .limit(1);
      if (!seller || !buyer) throw new ConflictException({ code: "billing_profile_required" });
      const [updated] = await tx
        .update(schema.invoices)
        .set({
          status: "issued",
          issueDate: new Date(),
          issuedAt: new Date(),
          issuedByPlatformUserId: principal.userId,
          sellerSnapshot: seller,
          buyerSnapshot: buyer,
        })
        .where(eq(schema.invoices.id, id))
        .returning();
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
        after: { status: "issued", number: invoice.number },
        requestId: null,
      });
      return updated;
    });
  }

  async cancel(principal: PlatformPrincipal, id: string) {
    const [invoice] = await this.db
      .select()
      .from(schema.invoices)
      .where(eq(schema.invoices.id, id))
      .limit(1);
    if (!invoice) throw new NotFoundException({ code: "invoice_not_found" });
    if (invoice.status === "paid") throw new ConflictException({ code: "invoice_paid" });
    const [updated] = await this.db
      .update(schema.invoices)
      .set({ status: "cancelled", cancelledAt: new Date() })
      .where(eq(schema.invoices.id, id))
      .returning();
    return updated;
  }
}

function nextInvoiceNumber(last: string | undefined): string {
  const numeric = last?.match(/(\d+)$/)?.[1];
  return `INV-${String((numeric ? Number(numeric) : 0) + 1).padStart(6, "0")}`;
}
