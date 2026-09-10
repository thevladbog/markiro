import { createHash, randomUUID } from "node:crypto";
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import {
  SIGNED_PRINT_SELLER_TAX_ID,
  type PrintDocumentVariant,
  type PlatformPrincipal,
  type CommercialDocumentDownloadSource,
  type CommercialDocumentListItemServiceSource,
  type CommercialDocumentRenderServiceResultSource,
  type CommercialDocumentServiceSource,
} from "@markiro/platform-contracts";
import { DB } from "../../auth/auth.module";
import { ObjectStorageService } from "../storage/object-storage.service";
import { renderPrintHtml } from "../billing/print-document-html";
import { toOfferPrintModel } from "../billing/print-document-model";
import { renderPrintPdf } from "../billing/print-document-pdf";
import { storedPrintVariant } from "../billing/print-document-layout";
import { acquireBillingWorkflowLocks } from "../billing-workflow-locks";
import { PlatformAuditService } from "../../platform-auth/platform-audit.service";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

@Injectable()
export class OfferDocumentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: ObjectStorageService,
    private readonly audit: PlatformAuditService,
  ) {}

  async render(
    offerId: string,
    printVariant: PrintDocumentVariant = "clean",
    actor?: PlatformPrincipal,
  ): Promise<CommercialDocumentRenderServiceResultSource> {
    if (
      (actor && !actor.capabilities.includes("billing.write")) ||
      (printVariant === "signed" && !actor)
    )
      throw new ForbiddenException();
    return this.db.transaction(async (tx) => {
      // Keep the workflow lock through upload and metadata commit. Retry callers see
      // the committed ready rows; a crashed transaction leaves them untouched.
      const [located] = await tx
        .select()
        .from(schema.commercialOffers)
        .where(eq(schema.commercialOffers.id, offerId))
        .limit(1);
      if (!located) throw new NotFoundException({ code: "offer_not_found" });
      await acquireBillingWorkflowLocks(tx, located.tenantId, [
        { kind: "offer_family", id: located.familyId },
        { kind: "offer", id: offerId },
      ]);
      const family = await tx
        .select()
        .from(schema.commercialOffers)
        .where(
          and(
            eq(schema.commercialOffers.tenantId, located.tenantId),
            eq(schema.commercialOffers.familyId, located.familyId),
          ),
        )
        .orderBy(desc(schema.commercialOffers.revision))
        .for("share");
      const offer = family.find((candidate) => candidate.id === offerId);
      if (!offer) throw new NotFoundException({ code: "offer_not_found" });
      if (
        printVariant === "signed" &&
        ((offer.status !== "published" && offer.status !== "paid") ||
          (offer.status === "published" &&
            offer.expiresAt !== null &&
            offer.expiresAt.getTime() <= Date.now()) ||
          family.find((candidate) => candidate.status !== "draft")?.id !== offerId)
      )
        throw new ConflictException({ code: "offer_signed_variant_not_allowed" });
      const revision = offer.revision;
      const [snapshot] = await tx
        .select()
        .from(schema.commercialOfferPrintSnapshots)
        .where(
          and(
            eq(schema.commercialOfferPrintSnapshots.offerId, offerId),
            eq(schema.commercialOfferPrintSnapshots.tenantId, offer.tenantId),
            eq(schema.commercialOfferPrintSnapshots.revision, revision),
          ),
        )
        .limit(1);
      if (!snapshot) throw new NotFoundException({ code: "offer_print_snapshot_not_found" });
      const model = toOfferPrintModel({ ...snapshot, status: "published" });
      if (printVariant === "signed" && model.seller.taxId !== SIGNED_PRINT_SELLER_TAX_ID)
        throw new ConflictException({ code: "signed_print_seller_not_authorized" });
      await tx
        .insert(schema.commercialOfferDocuments)
        .values(
          (["html", "pdf"] as const).map((format) => ({
            tenantId: snapshot.tenantId,
            offerId,
            revision,
            format,
            printVariant,
            status: "pending",
            rendererVersion: "billing-print-v2",
          })),
        )
        .onConflictDoNothing({
          target: [
            schema.commercialOfferDocuments.offerId,
            schema.commercialOfferDocuments.revision,
            schema.commercialOfferDocuments.format,
            schema.commercialOfferDocuments.printVariant,
          ],
        });
      const documents = await tx
        .select()
        .from(schema.commercialOfferDocuments)
        .where(
          and(
            eq(schema.commercialOfferDocuments.offerId, offerId),
            eq(schema.commercialOfferDocuments.revision, revision),
            eq(schema.commercialOfferDocuments.printVariant, printVariant),
          ),
        )
        .orderBy(schema.commercialOfferDocuments.format);
      const rendered: CommercialDocumentServiceSource[] = [];
      for (const document of documents) rendered.push(await this.renderOne(tx, document, model));
      if (actor)
        await this.audit.record(tx, {
          actorPlatformUserId: actor.userId,
          actorRole: actor.role,
          tenantId: offer.tenantId,
          action: "billing.offer.documents.rendered",
          outcome: rendered.every((document) => document.status === "ready")
            ? "success"
            : "failure",
          targetType: "commercial_offer",
          targetId: offerId,
          reason: null,
          before: null,
          after: {
            revision,
            printVariant,
            documents: rendered.map(({ format, status }) => ({ format, status })),
          },
          requestId: null,
        });
      return {
        revision,
        documents: rendered,
      };
    });
  }

  async list(offerId: string): Promise<CommercialDocumentListItemServiceSource[]> {
    const documents = await this.db
      .select({
        id: schema.commercialOfferDocuments.id,
        revision: schema.commercialOfferDocuments.revision,
        format: schema.commercialOfferDocuments.format,
        printVariant: schema.commercialOfferDocuments.printVariant,
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
    return documents.map((document) => ({
      ...document,
      printVariant: storedPrintVariant(document.printVariant),
    }));
  }

  async url(offerId: string, documentId: string): Promise<CommercialDocumentDownloadSource> {
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
    tx: Transaction,
    document: typeof schema.commercialOfferDocuments.$inferSelect,
    model: Parameters<typeof renderPrintHtml>[0],
  ): Promise<CommercialDocumentServiceSource> {
    if (document.status === "ready") return this.publicDocument(document);
    try {
      const format = document.format as "html" | "pdf";
      const printVariant = storedPrintVariant(document.printVariant);
      const body =
        format === "html"
          ? Buffer.from(renderPrintHtml(model, { printVariant }), "utf8")
          : await renderPrintPdf(model, { printVariant });
      const contentType = format === "html" ? "text/html; charset=utf-8" : "application/pdf";
      // A rollback or ambiguous commit may orphan this attempt, never overwrite a winner.
      const key = `tenants/${document.tenantId}/offers/${document.offerId}/r${document.revision}/${printVariant}/${randomUUID()}.${format}`;
      await this.storage.ensureBucket();
      await this.storage.put(key, body, contentType);
      const [updated] = await tx
        .update(schema.commercialOfferDocuments)
        .set({
          status: "ready",
          objectKey: key,
          contentType,
          sha256: createHash("sha256").update(body).digest("hex"),
          byteSize: body.byteLength,
          rendererVersion: "billing-print-v2",
          updatedAt: new Date(),
          errorCode: null,
        })
        .where(eq(schema.commercialOfferDocuments.id, document.id))
        .returning();
      return this.publicDocument(updated ?? document);
    } catch {
      const [failed] = await tx
        .update(schema.commercialOfferDocuments)
        .set({
          status: "failed",
          errorCode: "render_failed",
          updatedAt: new Date(),
        })
        .where(eq(schema.commercialOfferDocuments.id, document.id))
        .returning();
      return this.publicDocument(failed ?? document);
    }
  }

  private publicDocument(
    document: typeof schema.commercialOfferDocuments.$inferSelect,
  ): CommercialDocumentServiceSource {
    return {
      id: document.id,
      revision: document.revision,
      format: document.format,
      printVariant: storedPrintVariant(document.printVariant),
      status: document.status,
      contentType: document.contentType,
      byteSize: document.byteSize,
      sha256: document.sha256,
      errorCode: document.errorCode,
    };
  }
}
