import { createHash } from "node:crypto";
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import { ObjectStorageService } from "../storage/object-storage.service";
import { renderPrintHtml } from "../billing/print-document-html";
import { toOfferPrintModel } from "../billing/print-document-model";
import { renderPrintPdf } from "../billing/print-document-pdf";

@Injectable()
export class OfferDocumentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: ObjectStorageService,
  ) {}

  async render(offerId: string, revision = 1) {
    const [snapshot] = await this.db
      .select()
      .from(schema.commercialOfferPrintSnapshots)
      .where(
        and(
          eq(schema.commercialOfferPrintSnapshots.offerId, offerId),
          eq(schema.commercialOfferPrintSnapshots.revision, revision),
        ),
      )
      .limit(1);
    if (!snapshot) throw new NotFoundException({ code: "offer_print_snapshot_not_found" });
    await this.db
      .insert(schema.commercialOfferDocuments)
      .values(
        (["html", "pdf"] as const).map((format) => ({
          tenantId: snapshot.tenantId,
          offerId,
          revision,
          format,
          status: "pending",
          rendererVersion: "billing-print-v1",
        })),
      )
      .onConflictDoNothing({
        target: [
          schema.commercialOfferDocuments.offerId,
          schema.commercialOfferDocuments.revision,
          schema.commercialOfferDocuments.format,
        ],
      });
    const documents = await this.db
      .select()
      .from(schema.commercialOfferDocuments)
      .where(
        and(
          eq(schema.commercialOfferDocuments.offerId, offerId),
          eq(schema.commercialOfferDocuments.revision, revision),
        ),
      );
    const model = toOfferPrintModel({ ...snapshot, status: "published" });
    return {
      revision,
      documents: await Promise.all(documents.map((document) => this.renderOne(document, model))),
    };
  }

  async list(offerId: string) {
    return this.db
      .select({
        id: schema.commercialOfferDocuments.id,
        revision: schema.commercialOfferDocuments.revision,
        format: schema.commercialOfferDocuments.format,
        status: schema.commercialOfferDocuments.status,
        contentType: schema.commercialOfferDocuments.contentType,
        byteSize: schema.commercialOfferDocuments.byteSize,
        sha256: schema.commercialOfferDocuments.sha256,
        errorCode: schema.commercialOfferDocuments.errorCode,
        createdAt: schema.commercialOfferDocuments.createdAt,
        updatedAt: schema.commercialOfferDocuments.updatedAt,
      })
      .from(schema.commercialOfferDocuments)
      .where(eq(schema.commercialOfferDocuments.offerId, offerId))
      .orderBy(
        desc(schema.commercialOfferDocuments.revision),
        schema.commercialOfferDocuments.format,
      );
  }

  async url(offerId: string, documentId: string) {
    const [document] = await this.db
      .select()
      .from(schema.commercialOfferDocuments)
      .where(
        and(
          eq(schema.commercialOfferDocuments.offerId, offerId),
          eq(schema.commercialOfferDocuments.id, documentId),
        ),
      )
      .limit(1);
    if (!document?.objectKey || document.status !== "ready")
      throw new NotFoundException({ code: "offer_document_not_ready" });
    return { url: await this.storage.presignRead(document.objectKey) };
  }

  private async renderOne(
    document: typeof schema.commercialOfferDocuments.$inferSelect,
    model: Parameters<typeof renderPrintHtml>[0],
  ) {
    if (document.status === "ready") return this.publicDocument(document);
    try {
      const format = document.format as "html" | "pdf";
      const body =
        format === "html"
          ? Buffer.from(renderPrintHtml(model), "utf8")
          : await renderPrintPdf(model);
      const contentType = format === "html" ? "text/html; charset=utf-8" : "application/pdf";
      const key = `tenants/${document.tenantId}/offers/${document.offerId}/r${document.revision}.${format}`;
      await this.storage.ensureBucket();
      await this.storage.put(key, body, contentType);
      const [updated] = await this.db
        .update(schema.commercialOfferDocuments)
        .set({
          status: "ready",
          objectKey: key,
          contentType,
          sha256: createHash("sha256").update(body).digest("hex"),
          byteSize: body.byteLength,
          updatedAt: new Date(),
          errorCode: null,
        })
        .where(eq(schema.commercialOfferDocuments.id, document.id))
        .returning();
      return this.publicDocument(updated ?? document);
    } catch (error) {
      const [failed] = await this.db
        .update(schema.commercialOfferDocuments)
        .set({
          status: "failed",
          errorCode: error instanceof Error ? error.message.slice(0, 120) : "render_failed",
          updatedAt: new Date(),
        })
        .where(eq(schema.commercialOfferDocuments.id, document.id))
        .returning();
      return this.publicDocument(failed ?? document);
    }
  }

  private publicDocument(document: typeof schema.commercialOfferDocuments.$inferSelect) {
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
