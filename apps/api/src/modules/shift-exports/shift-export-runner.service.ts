import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  getShiftExportFormat,
  renderShiftExport,
  ShiftExportDomainError,
  type ShiftExportPart,
} from "@markiro/domain";
import { schema, type Db } from "@markiro/db";
import { and, eq, lte, or, sql } from "drizzle-orm";
import { DB } from "../../auth/auth.module";
import { ObjectStorageService } from "../storage/object-storage.service";
import { ShiftExportSourceError, ShiftExportSourceService } from "./shift-export-source.service";

export const SHIFT_EXPORT_SAFE_ERROR_CODES = [
  "SHIFT_NOT_CLOSED",
  "SHIFT_HAS_NO_CODES",
  "SHIFT_DATE_MISSING",
  "BOX_COVERAGE_INCOMPLETE",
  "ORG_INN_MISSING",
  "FORMAT_NOT_FOUND",
  "INVALID_LINE_LIMIT",
  "BOX_EXCEEDS_LINE_LIMIT",
  "GENERATION_FAILED",
  "STORAGE_FAILED",
  "QUEUE_FAILED",
] as const;

type ShiftExportSafeErrorCode = (typeof SHIFT_EXPORT_SAFE_ERROR_CODES)[number];
type ShiftExportRow = typeof schema.shiftExports.$inferSelect;
type ShiftExportTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Task 6 retries this request-driven job after 30 seconds. A 20-second lease lets
 * that first retry reclaim a worker that disappeared or could not reconcile an
 * ambiguous commit, while the attempt-count predicate fences the previous owner.
 */
const PROCESSING_LEASE_MS = 20_000;

interface AttemptContext {
  retryCount: number;
  retryLimit: number;
}

interface UploadedArtifact {
  part: ShiftExportPart;
  objectKey: string;
  byteSize: number;
  sha256: string;
}

@Injectable()
export class ShiftExportRunnerService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly source: ShiftExportSourceService,
    private readonly storage: ObjectStorageService,
  ) {}

  async run(exportId: string, attempt: AttemptContext): Promise<void> {
    const claimed = await this.claim(exportId);
    if (!claimed) return;

    const uploaded: UploadedArtifact[] = [];
    const attemptedObjectKeys: string[] = [];
    let infrastructureErrorCode: ShiftExportSafeErrorCode = "GENERATION_FAILED";
    let publicationAttempted = false;

    try {
      const format = getShiftExportFormat(claimed.formatId, claimed.formatVersion);
      const snapshot = await this.source.load(claimed.tenantId, claimed.shiftId, format);

      const snapshotUpdates = await this.db
        .update(schema.shiftExports)
        .set({
          productNameSnapshot: snapshot.productName,
          shiftDateSnapshot: snapshot.shiftDate,
          sourceSnapshotStartedAt: snapshot.sourceSnapshotStartedAt,
          updatedAt: new Date(),
        })
        .where(and(this.ownedProcessingAttempt(claimed)))
        .returning({ id: schema.shiftExports.id });
      if (snapshotUpdates.length === 0) throw new ShiftExportClaimLostError();

      const parts = renderShiftExport({
        formatId: format.id,
        formatVersion: format.version,
        productName: snapshot.productName,
        shiftDate: snapshot.shiftDate,
        maxLines: claimed.maxLines,
        source: snapshot.source,
        organizationInn: snapshot.organizationInn,
      });

      infrastructureErrorCode = "STORAGE_FAILED";
      for (const part of parts) {
        await this.refreshLease(claimed);
        const body = Buffer.from(part.bytes);
        const sha256 = createHash("sha256").update(body).digest("hex");
        const objectKey = this.objectKey(claimed, part, format.extension);
        attemptedObjectKeys.push(objectKey);
        const stored = await this.storage.putVerified(objectKey, body, part.mimeType, sha256);
        uploaded.push({ part, objectKey, byteSize: stored.byteSize, sha256 });
      }

      infrastructureErrorCode = "GENERATION_FAILED";
      publicationAttempted = true;
      await this.publishReady(claimed, uploaded);
    } catch (error) {
      if (publicationAttempted) {
        try {
          if (await this.hasCommittedPublication(claimed)) return;
        } catch {
          // The commit outcome is still ambiguous. Preserve objects and let the lease expire.
          throw error;
        }
      }

      await Promise.allSettled(attemptedObjectKeys.map((key) => this.storage.delete(key)));

      if (error instanceof ShiftExportClaimLostError) return;

      const safeErrorCode = safeDomainErrorCode(error);
      if (safeErrorCode !== null) {
        await this.publishFailed(claimed, safeErrorCode);
        return;
      }

      if (attempt.retryCount < attempt.retryLimit) {
        await this.requeue(claimed);
      } else {
        await this.publishFailed(claimed, infrastructureErrorCode);
      }
      throw error;
    }
  }

  private async claim(exportId: string): Promise<ShiftExportRow | undefined> {
    const [candidate] = await this.db
      .select()
      .from(schema.shiftExports)
      .where(eq(schema.shiftExports.id, exportId))
      .limit(1);
    if (!candidate) return undefined;

    const leaseCutoff = new Date(Date.now() - PROCESSING_LEASE_MS);
    const [claimed] = await this.db
      .update(schema.shiftExports)
      .set({
        status: "processing",
        attemptCount: sql`${schema.shiftExports.attemptCount} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.shiftExports.tenantId, candidate.tenantId),
          eq(schema.shiftExports.id, exportId),
          eq(schema.shiftExports.attemptCount, candidate.attemptCount),
          or(
            eq(schema.shiftExports.status, "queued"),
            and(
              eq(schema.shiftExports.status, "processing"),
              lte(schema.shiftExports.updatedAt, leaseCutoff),
            ),
          ),
        ),
      )
      .returning();

    return claimed;
  }

  private async refreshLease(claimed: ShiftExportRow): Promise<void> {
    const refreshed = await this.db
      .update(schema.shiftExports)
      .set({ updatedAt: new Date() })
      .where(this.ownedProcessingAttempt(claimed))
      .returning({ id: schema.shiftExports.id });
    if (refreshed.length === 0) throw new ShiftExportClaimLostError();
  }

  private objectKey(claimed: ShiftExportRow, part: ShiftExportPart, extension: string): string {
    return `tenants/${claimed.tenantId}/shift-exports/${claimed.id}/attempt-${claimed.attemptCount}/part-${part.partNumber}.${extension}`;
  }

  private async publishReady(
    claimed: ShiftExportRow,
    uploaded: readonly UploadedArtifact[],
  ): Promise<void> {
    const completedAt = new Date();
    const totalCodeCount = uploaded.reduce((total, artifact) => total + artifact.part.codeCount, 0);
    const totalBoxCount = uploaded.reduce((total, artifact) => total + artifact.part.boxCount, 0);

    await this.db.transaction(async (tx) => {
      await tx.insert(schema.shiftExportArtifacts).values(
        uploaded.map(({ part, objectKey, byteSize, sha256 }) => ({
          tenantId: claimed.tenantId,
          exportId: claimed.id,
          partNumber: part.partNumber,
          physicalLineCount: part.physicalLineCount,
          codeCount: part.codeCount,
          boxCount: part.boxCount,
          filename: part.filename,
          mimeType: part.mimeType,
          byteSize,
          sha256,
          objectKey,
        })),
      );
      const ready = await tx
        .update(schema.shiftExports)
        .set({
          status: "ready",
          errorCode: null,
          totalCodeCount,
          totalBoxCount,
          completedAt,
          updatedAt: completedAt,
        })
        .where(and(this.ownedProcessingAttempt(claimed)))
        .returning({ id: schema.shiftExports.id });
      if (ready.length === 0) throw new ShiftExportClaimLostError();
      await this.writeAudit(tx, claimed, "shift_export.completed", "success", {
        status: "ready",
        attemptCount: claimed.attemptCount,
        partCount: uploaded.length,
        totalCodeCount,
        totalBoxCount,
      });
    });
  }

  private async requeue(claimed: ShiftExportRow): Promise<void> {
    await this.db
      .update(schema.shiftExports)
      .set({ status: "queued", errorCode: null, completedAt: null, updatedAt: new Date() })
      .where(this.ownedProcessingAttempt(claimed));
  }

  private async publishFailed(
    claimed: ShiftExportRow,
    errorCode: ShiftExportSafeErrorCode,
  ): Promise<void> {
    const completedAt = new Date();
    await this.db.transaction(async (tx) => {
      const failed = await tx
        .update(schema.shiftExports)
        .set({ status: "failed", errorCode, completedAt, updatedAt: completedAt })
        .where(and(this.ownedProcessingAttempt(claimed)))
        .returning({ id: schema.shiftExports.id });
      if (failed.length === 0) throw new ShiftExportClaimLostError();
      await this.writeAudit(tx, claimed, "shift_export.failed", "failure", {
        status: "failed",
        attemptCount: claimed.attemptCount,
        errorCode,
      });
    });
  }

  private async writeAudit(
    tx: ShiftExportTx,
    claimed: ShiftExportRow,
    action: string,
    outcome: "success" | "failure",
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await tx.insert(schema.tenantAuditEvents).values({
      organizationId: claimed.tenantId,
      actorUserId: claimed.createdByUserId,
      action,
      outcome,
      targetType: "shift_export",
      targetId: claimed.id,
      after: {
        tenantId: claimed.tenantId,
        actorUserId: claimed.createdByUserId,
        shiftId: claimed.shiftId,
        exportId: claimed.id,
        formatId: claimed.formatId,
        formatVersion: claimed.formatVersion,
        maxLines: claimed.maxLines,
        outcome,
        ...metadata,
      },
    });
  }

  private ownedProcessingAttempt(claimed: ShiftExportRow) {
    return and(
      eq(schema.shiftExports.tenantId, claimed.tenantId),
      eq(schema.shiftExports.id, claimed.id),
      eq(schema.shiftExports.status, "processing"),
      eq(schema.shiftExports.attemptCount, claimed.attemptCount),
    );
  }

  private async hasCommittedPublication(claimed: ShiftExportRow): Promise<boolean> {
    const [current] = await this.db
      .select({ status: schema.shiftExports.status })
      .from(schema.shiftExports)
      .where(
        and(
          eq(schema.shiftExports.tenantId, claimed.tenantId),
          eq(schema.shiftExports.id, claimed.id),
        ),
      )
      .limit(1);
    const artifacts = await this.db
      .select({ id: schema.shiftExportArtifacts.id })
      .from(schema.shiftExportArtifacts)
      .where(
        and(
          eq(schema.shiftExportArtifacts.tenantId, claimed.tenantId),
          eq(schema.shiftExportArtifacts.exportId, claimed.id),
        ),
      );

    return current?.status === "ready" || artifacts.length > 0;
  }
}

class ShiftExportClaimLostError extends Error {
  constructor() {
    super("Shift export processing claim was lost");
    this.name = "ShiftExportClaimLostError";
  }
}

function safeDomainErrorCode(error: unknown): ShiftExportSafeErrorCode | null {
  if (error instanceof ShiftExportSourceError) return error.code;
  if (!(error instanceof ShiftExportDomainError)) return null;

  switch (error.code) {
    case "FORMAT_NOT_FOUND":
    case "INVALID_LINE_LIMIT":
    case "BOX_EXCEEDS_LINE_LIMIT":
    case "ORG_INN_MISSING":
      return error.code;
    case "FORMAT_SOURCE_MISMATCH":
    case "EMPTY_SOURCE":
      return "GENERATION_FAILED";
    default:
      return "GENERATION_FAILED";
  }
}
