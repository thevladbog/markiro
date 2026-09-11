import { createHash, randomUUID } from "node:crypto";

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { buildTenantAgreement, renderLegalDocxDraft } from "@markiro/legal-documents";
import type { AgreementDocument } from "@markiro/platform-contracts";

import { DB } from "../../auth/auth.module";
import type { PlatformPrincipal } from "../../platform-auth/platform-access-policy";
import { PlatformAuditService } from "../../platform-auth/platform-audit.service";
import { ObjectStorageService } from "../storage/object-storage.service";
import {
  agreementAttachmentObjectKey,
  agreementDraftObjectKey,
  agreementSignedObjectKey,
} from "./agreement-object-key";
import { toAgreementFields } from "./agreement-fields";
import { parseRequisites, parseSignatory, parseTerms } from "./agreement-state";

export const AGREEMENT_RENDERER_VERSION = "agreement-docx-v1";
const DOCX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// MKR-AGR-01 is not a registry release, so the Data Matrix points at the
// published registry rather than a /d/ page that would 404.
const AGREEMENT_CODE = "MKR-AGR-01";
const AGREEMENT_REVISION = "2026.09/01";
const AGREEMENT_EFFECTIVE_DATE = "2026-09-10";
const REGISTRY_URL = "https://markiro.app/legal/";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const ATTACHMENT_SIGNATURES = new Map<string, readonly number[]>([
  ["application/pdf", [0x25, 0x50, 0x44, 0x46]],
  [DOCX_MEDIA_TYPE, [0x50, 0x4b, 0x03, 0x04]],
  ["image/png", [0x89, 0x50, 0x4e, 0x47]],
  ["image/jpeg", [0xff, 0xd8, 0xff]],
]);

type AgreementRow = typeof schema.platformAgreements.$inferSelect;
type AgreementDocumentRow = typeof schema.platformAgreementDocuments.$inferSelect;

export interface SignedRender {
  readonly objectKey: string;
  readonly sha256: string;
  readonly byteSize: number;
}

export function assertAllowedAttachment(mediaType: string, body: Buffer): void {
  const signature = ATTACHMENT_SIGNATURES.get(mediaType);
  if (!signature) throw new BadRequestException("Unsupported attachment type");
  if (body.byteLength === 0) throw new BadRequestException("Empty attachment");
  if (body.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new PayloadTooLargeException("Attachment exceeds 20 MB");
  }
  // Declared type is a claim; the leading bytes are the evidence.
  if (!signature.every((byte, index) => body[index] === byte)) {
    throw new BadRequestException("Attachment content does not match its declared type");
  }
}

@Injectable()
export class AgreementDocumentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: ObjectStorageService,
    private readonly audit: PlatformAuditService,
  ) {}

  async renderDraft(actor: PlatformPrincipal, agreement: AgreementRow): Promise<AgreementDocument> {
    const bytes = await this.render(agreement, "ПРОЕКТ ДОГОВОРА");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    // One stable key per agreement: re-rendering a preview overwrites it
    // instead of leaving an object behind for every click.
    const objectKey = agreementDraftObjectKey(agreement.id);
    await this.storage.putVerified(objectKey, bytes, DOCX_MEDIA_TYPE, sha256);

    const filename = `${agreement.number}-проект.docx`;
    const row = await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(schema.platformAgreementDocuments)
        .where(
          and(
            eq(schema.platformAgreementDocuments.agreementId, agreement.id),
            eq(schema.platformAgreementDocuments.kind, "draft"),
          ),
        )
        .limit(1);

      const values = {
        agreementId: agreement.id,
        kind: "draft" as const,
        filename,
        mediaType: DOCX_MEDIA_TYPE,
        objectKey,
        sha256,
        byteSize: bytes.byteLength,
        rendererVersion: AGREEMENT_RENDERER_VERSION,
        uploadedByPlatformUserId: null,
      };
      const [saved] = existing
        ? await tx
            .update(schema.platformAgreementDocuments)
            .set(values)
            .where(eq(schema.platformAgreementDocuments.id, existing.id))
            .returning()
        : await tx.insert(schema.platformAgreementDocuments).values(values).returning();
      if (!saved) throw new Error("Agreement draft document was not stored");

      await this.audit.record(tx, {
        actorPlatformUserId: actor.userId,
        actorRole: actor.role,
        action: "platform.agreement.draft_rendered",
        outcome: "success",
        tenantId: agreement.tenantId,
        targetType: "platform_agreement",
        targetId: agreement.id,
        reason: null,
        before: null,
        after: { sha256, byteSize: bytes.byteLength },
        requestId: null,
      });
      return saved;
    });
    return toDocument(row);
  }

  /**
   * Runs inside the signing transaction. The key is content-addressed and
   * the object-key constraint is unique, so a re-render of identical bytes
   * conflicts rather than silently replacing a signed artifact.
   */
  /**
   * Renders and uploads outside any transaction: object-store round trips
   * must not hold a database transaction open. The key is content-addressed
   * and its column is unique, so a repeated render conflicts rather than
   * silently replacing a signed artifact. A render whose transaction later
   * rolls back leaves a collectable object, never a dangling row.
   */
  async renderSignedObject(agreement: AgreementRow): Promise<SignedRender> {
    const bytes = await this.render(agreement, "ДОГОВОР");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const objectKey = agreementSignedObjectKey(agreement.id, sha256);
    await this.storage.putVerified(objectKey, bytes, DOCX_MEDIA_TYPE, sha256);
    return { objectKey, sha256, byteSize: bytes.byteLength };
  }

  async recordSignedDocument(
    tx: Pick<Db, "insert">,
    agreement: AgreementRow,
    rendered: SignedRender,
  ): Promise<AgreementDocumentRow> {
    const [saved] = await tx
      .insert(schema.platformAgreementDocuments)
      .values({
        agreementId: agreement.id,
        kind: "generated",
        filename: `${agreement.number}.docx`,
        mediaType: DOCX_MEDIA_TYPE,
        objectKey: rendered.objectKey,
        sha256: rendered.sha256,
        byteSize: rendered.byteSize,
        rendererVersion: AGREEMENT_RENDERER_VERSION,
        uploadedByPlatformUserId: null,
      })
      .returning();
    if (!saved) throw new Error("Signed agreement document was not stored");
    return saved;
  }

  async download(agreementId: string, documentId: string): Promise<{ url: string }> {
    const document = await this.requireDocument(agreementId, documentId);
    return {
      url: await this.storage.presignRead(document.objectKey, 300, {
        downloadFilename: document.filename,
      }),
    };
  }

  async uploadAttachment(
    actor: PlatformPrincipal,
    agreement: AgreementRow,
    file: { readonly originalname: string; readonly mimetype: string; readonly buffer: Buffer },
  ): Promise<AgreementDocument> {
    assertAllowedAttachment(file.mimetype, file.buffer);
    const sha256 = createHash("sha256").update(file.buffer).digest("hex");
    // The client filename never reaches the bucket path.
    const objectKey = agreementAttachmentObjectKey(agreement.id, randomUUID());
    await this.storage.putVerified(objectKey, file.buffer, file.mimetype, sha256);

    const row = await this.db.transaction(async (tx) => {
      const [saved] = await tx
        .insert(schema.platformAgreementDocuments)
        .values({
          agreementId: agreement.id,
          kind: "attachment",
          filename: safeFilename(file.originalname),
          mediaType: file.mimetype,
          objectKey,
          sha256,
          byteSize: file.buffer.byteLength,
          rendererVersion: null,
          uploadedByPlatformUserId: actor.userId,
        })
        .returning();
      if (!saved) throw new Error("Attachment was not stored");
      await this.audit.record(tx, {
        actorPlatformUserId: actor.userId,
        actorRole: actor.role,
        action: "platform.agreement.attachment_uploaded",
        outcome: "success",
        tenantId: agreement.tenantId,
        targetType: "platform_agreement",
        targetId: agreement.id,
        reason: null,
        before: null,
        after: { documentId: saved.id, sha256, byteSize: file.buffer.byteLength },
        requestId: null,
      });
      return saved;
    });
    return toDocument(row);
  }

  async deleteAttachment(
    actor: PlatformPrincipal,
    agreementId: string,
    documentId: string,
  ): Promise<{ deleted: true }> {
    const document = await this.requireDocument(agreementId, documentId);
    if (document.kind !== "attachment") {
      throw new BadRequestException("Only an uploaded attachment can be deleted");
    }
    await this.db.transaction(async (tx) => {
      await tx
        .delete(schema.platformAgreementDocuments)
        .where(eq(schema.platformAgreementDocuments.id, document.id));
      await this.audit.record(tx, {
        actorPlatformUserId: actor.userId,
        actorRole: actor.role,
        action: "platform.agreement.attachment_deleted",
        outcome: "success",
        tenantId: null,
        targetType: "platform_agreement",
        targetId: agreementId,
        reason: null,
        before: { documentId: document.id, filename: document.filename },
        after: null,
        requestId: null,
      });
    });
    // Only after the row is gone: a failed object delete leaves collectable
    // storage garbage, whereas the reverse order leaves a row pointing at an
    // object that no longer exists.
    await this.storage.deleteConfirmed(document.objectKey);
    return { deleted: true };
  }

  private async requireDocument(
    agreementId: string,
    documentId: string,
  ): Promise<AgreementDocumentRow> {
    const [row] = await this.db
      .select()
      .from(schema.platformAgreementDocuments)
      .where(
        and(
          eq(schema.platformAgreementDocuments.id, documentId),
          eq(schema.platformAgreementDocuments.agreementId, agreementId),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException("Agreement document not found");
    return row;
  }

  private async render(agreement: AgreementRow, classLabel: string): Promise<Buffer> {
    const content = buildTenantAgreement(
      toAgreementFields({
        number: agreement.number,
        conclusionDate: agreement.conclusionDate,
        city: agreement.city,
        counterparty: parseRequisites(agreement.counterparty, "counterparty"),
        contractor: parseRequisites(agreement.contractor, "contractor"),
        signatory: parseSignatory(agreement.terms),
        terms: parseTerms(agreement.terms),
      }),
      "ru",
    );
    const bytes = await renderLegalDocxDraft({
      code: AGREEMENT_CODE,
      revision: AGREEMENT_REVISION,
      effectiveDate: AGREEMENT_EFFECTIVE_DATE,
      locale: "ru",
      verificationUrl: REGISTRY_URL,
      classLabel,
      operatorProfileId: "operator-2026-08-15",
      content,
    });
    return Buffer.from(bytes);
  }
}

function safeFilename(value: string): string {
  const trimmed = value
    .trim()
    .replace(/[\r\n\t]/g, " ")
    .slice(0, 255);
  if (!trimmed) throw new BadRequestException("Attachment needs a file name");
  return trimmed;
}

function toDocument(row: AgreementDocumentRow): AgreementDocument {
  return {
    id: row.id,
    kind: row.kind,
    filename: row.filename,
    mediaType: row.mediaType,
    sha256: row.sha256,
    byteSize: row.byteSize,
    createdAt: row.createdAt.toISOString(),
  };
}

export { ConflictException };
