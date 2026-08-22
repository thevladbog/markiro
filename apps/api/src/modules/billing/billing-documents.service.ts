import { createHash } from "node:crypto";
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, max } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import type {
  CommercialDocumentDownloadSource,
  CommercialDocumentListItemServiceSource,
  CommercialDocumentRenderServiceResultSource,
  CommercialDocumentServiceSource,
} from "@markiro/platform-contracts";
import { DB } from "../../auth/auth.module";
import { ObjectStorageService } from "../storage/object-storage.service";
import { BillingService } from "./billing.service";
import { renderPrintHtml } from "./print-document-html";
import { toInvoicePrintModel } from "./print-document-model";
import { renderPrintPdf } from "./print-document-pdf";

type Format = "html" | "pdf";

@Injectable()
export class BillingDocumentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly billing: BillingService,
    private readonly storage: ObjectStorageService,
  ) {}

  async renderInvoice(
    invoiceId: string,
    requestedRevision?: number,
  ): Promise<CommercialDocumentRenderServiceResultSource> {
    const invoice = await this.billing.get(invoiceId);
    if (invoice.status === "draft") {
      throw new NotFoundException({ code: "invoice_not_issued" });
    }
    const revision = requestedRevision ?? (await this.nextRevision(invoiceId));
    const pending = await this.ensurePending(invoice.tenantId, invoiceId, revision);
    const model = toInvoicePrintModel(invoice);
    const results = await Promise.all(pending.map((document) => this.renderOne(document, model)));
    return { revision, documents: results };
  }

  async renderAndStore(invoiceId: string): Promise<CommercialDocumentRenderServiceResultSource> {
    return this.renderInvoice(invoiceId);
  }

  async list(invoiceId: string): Promise<CommercialDocumentListItemServiceSource[]> {
    return this.db
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
      .where(eq(schema.invoiceDocuments.invoiceId, invoiceId))
      .orderBy(desc(schema.invoiceDocuments.revision), schema.invoiceDocuments.format);
  }

  async url(invoiceId: string, documentId?: string): Promise<CommercialDocumentDownloadSource> {
    const [document] = await this.db
      .select()
      .from(schema.invoiceDocuments)
      .where(
        documentId
          ? and(
              eq(schema.invoiceDocuments.invoiceId, invoiceId),
              eq(schema.invoiceDocuments.id, documentId),
            )
          : eq(schema.invoiceDocuments.invoiceId, invoiceId),
      )
      .orderBy(desc(schema.invoiceDocuments.revision))
      .limit(1);
    if (!document?.objectKey || document.status !== "ready") {
      throw new NotFoundException({ code: "invoice_document_not_ready" });
    }
    return { url: await this.storage.presignRead(document.objectKey) };
  }

  private async nextRevision(invoiceId: string): Promise<number> {
    const [row] = await this.db
      .select({ revision: max(schema.invoiceDocuments.revision) })
      .from(schema.invoiceDocuments)
      .where(eq(schema.invoiceDocuments.invoiceId, invoiceId));
    return Number(row?.revision ?? 0) + 1;
  }

  private async ensurePending(tenantId: string, invoiceId: string, revision: number) {
    await this.db
      .insert(schema.invoiceDocuments)
      .values(
        (["html", "pdf"] as const).map((format) => ({
          tenantId,
          invoiceId,
          revision,
          format,
          status: "pending" as const,
          rendererVersion: "billing-print-v1",
        })),
      )
      .onConflictDoNothing({
        target: [
          schema.invoiceDocuments.invoiceId,
          schema.invoiceDocuments.revision,
          schema.invoiceDocuments.format,
        ],
      });
    return this.db
      .select()
      .from(schema.invoiceDocuments)
      .where(
        and(
          eq(schema.invoiceDocuments.invoiceId, invoiceId),
          eq(schema.invoiceDocuments.revision, revision),
        ),
      );
  }

  private async renderOne(
    document: typeof schema.invoiceDocuments.$inferSelect,
    model: Parameters<typeof renderPrintHtml>[0],
  ): Promise<CommercialDocumentServiceSource> {
    if (document.status === "ready") return this.publicDocument(document);
    try {
      const format = document.format as Format;
      const body =
        format === "html"
          ? Buffer.from(renderPrintHtml(model), "utf8")
          : await renderPrintPdf(model);
      const contentType = format === "html" ? "text/html; charset=utf-8" : "application/pdf";
      const key = `tenants/${document.tenantId}/invoices/${document.invoiceId}/r${document.revision}.${format}`;
      await this.storage.ensureBucket();
      await this.storage.put(key, body, contentType);
      const [updated] = await this.db
        .update(schema.invoiceDocuments)
        .set({
          status: "ready",
          objectKey: key,
          contentType,
          sha256: createHash("sha256").update(body).digest("hex"),
          byteSize: body.byteLength,
          rendererVersion: "billing-print-v1",
          updatedAt: new Date(),
          errorCode: null,
        })
        .where(eq(schema.invoiceDocuments.id, document.id))
        .returning();
      return this.publicDocument(updated ?? document);
    } catch (error) {
      const [failed] = await this.db
        .update(schema.invoiceDocuments)
        .set({
          status: "failed",
          errorCode: error instanceof Error ? error.message.slice(0, 120) : "render_failed",
          updatedAt: new Date(),
        })
        .where(eq(schema.invoiceDocuments.id, document.id))
        .returning();
      return this.publicDocument(failed ?? document);
    }
  }

  private publicDocument(
    document: typeof schema.invoiceDocuments.$inferSelect,
  ): CommercialDocumentServiceSource {
    return {
      id: document.id,
      revision: document.revision,
      format: document.format,
      status: document.status,
      contentType: document.contentType,
      byteSize: document.byteSize,
      sha256: document.sha256,
      errorCode: document.errorCode,
    };
  }
}
