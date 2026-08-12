import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import { ObjectStorageService } from "../storage/object-storage.service";

@Injectable()
export class TenantBillingService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: ObjectStorageService,
  ) {}

  async list(tenantId: string) {
    const rows = await this.db
      .select()
      .from(schema.invoices)
      .where(and(eq(schema.invoices.tenantId, tenantId), eq(schema.invoices.status, "issued")))
      .orderBy(desc(schema.invoices.issuedAt));
    return {
      items: rows.map((invoice) => ({
        id: invoice.id,
        number: invoice.number,
        issueDate: invoice.issueDate,
        dueDate: invoice.dueDate,
        status: invoice.status,
        total: invoice.total,
        currency: invoice.currency,
      })),
    };
  }

  async detail(tenantId: string, id: string) {
    const [invoice] = await this.db
      .select()
      .from(schema.invoices)
      .where(
        and(
          eq(schema.invoices.tenantId, tenantId),
          eq(schema.invoices.id, id),
          eq(schema.invoices.status, "issued"),
        ),
      )
      .limit(1);
    if (!invoice) throw new NotFoundException({ code: "invoice_not_found" });
    const lines = await this.db
      .select({
        position: schema.invoiceLines.position,
        nameRu: schema.invoiceLines.nameRu,
        unit: schema.invoiceLines.unit,
        quantity: schema.invoiceLines.quantity,
        agreedUnitPrice: schema.invoiceLines.agreedUnitPrice,
        lineTotal: schema.invoiceLines.lineTotal,
      })
      .from(schema.invoiceLines)
      .where(and(eq(schema.invoiceLines.tenantId, tenantId), eq(schema.invoiceLines.invoiceId, id)))
      .orderBy(schema.invoiceLines.position);
    const documents = await this.db
      .select({
        id: schema.invoiceDocuments.id,
        revision: schema.invoiceDocuments.revision,
        format: schema.invoiceDocuments.format,
        status: schema.invoiceDocuments.status,
        byteSize: schema.invoiceDocuments.byteSize,
      })
      .from(schema.invoiceDocuments)
      .where(
        and(
          eq(schema.invoiceDocuments.tenantId, tenantId),
          eq(schema.invoiceDocuments.invoiceId, id),
        ),
      )
      .orderBy(desc(schema.invoiceDocuments.revision));
    return {
      id: invoice.id,
      number: invoice.number,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      status: invoice.status,
      subtotal: invoice.subtotal,
      vatTotal: invoice.vatTotal,
      total: invoice.total,
      currency: invoice.currency,
      lines,
      documents,
    };
  }

  async download(tenantId: string, invoiceId: string, documentId: string) {
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
    if (!document?.objectKey || document.status !== "ready")
      throw new NotFoundException({ code: "invoice_document_not_ready" });
    return { url: await this.storage.presignRead(document.objectKey) };
  }
}
