import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { and, asc, desc, eq, getTableColumns, inArray } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { SHIFT_EXPORT_FORMATS, type ShiftExportFormatId } from "@markiro/domain";
import { DB } from "../../auth/auth.module";
import { PgBossService } from "../../jobs/jobs.module";
import { ObjectStorageService } from "../storage/object-storage.service";
import type {
  CreateShiftExportDto,
  ShiftExportArtifactDto,
  ShiftExportDownloadDto,
  ShiftExportDto,
  ShiftExportFormatsDto,
} from "./dto";

type ShiftExportRow = typeof schema.shiftExports.$inferSelect;
type ShiftExportTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

interface ListedShiftExportRow extends ShiftExportRow {
  lateDataAt: Date | null;
  userName: string;
  firstName: string | null;
  lastName: string | null;
  middleName: string | null;
}

@Injectable()
export class ShiftExportsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly jobs: PgBossService,
    private readonly storage: ObjectStorageService,
  ) {}

  formats(): ShiftExportFormatsDto {
    return SHIFT_EXPORT_FORMATS;
  }

  async create(
    tenantId: string,
    actorUserId: string,
    shiftId: string,
    input: CreateShiftExportDto,
  ): Promise<ShiftExportDto> {
    let row: ShiftExportRow;
    let shouldEnqueue = true;
    try {
      row = await this.db.transaction(async (tx) => {
        const [shift] = await tx
          .select({ status: schema.shifts.status })
          .from(schema.shifts)
          .where(and(eq(schema.shifts.tenantId, tenantId), eq(schema.shifts.id, shiftId)))
          .limit(1);
        if (!shift) throw new NotFoundException();
        if (shift.status !== "closed") throw new ConflictException("Shift must be closed");

        const [created] = await tx
          .insert(schema.shiftExports)
          .values({
            tenantId,
            shiftId,
            formatId: input.formatId,
            formatVersion: input.formatVersion,
            maxLines: input.maxLines,
            createdByUserId: actorUserId,
            idempotencyKey: input.idempotencyKey,
          })
          .returning();
        if (!created) throw new Error("Failed to create shift export");
        await this.writeAudit(tx, created, actorUserId, "shift_export.created", "success", {
          status: "queued",
        });
        return created;
      });
    } catch (error) {
      if (!isIdempotencyConflict(error)) throw error;
      const [existing] = await this.db
        .select()
        .from(schema.shiftExports)
        .where(
          and(
            eq(schema.shiftExports.tenantId, tenantId),
            eq(schema.shiftExports.createdByUserId, actorUserId),
            eq(schema.shiftExports.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (!existing) throw error;
      if (
        existing.shiftId !== shiftId ||
        existing.formatId !== input.formatId ||
        existing.formatVersion !== input.formatVersion ||
        existing.maxLines !== input.maxLines
      ) {
        throw new ConflictException("Idempotency key already belongs to another export request");
      }
      row = existing;
      shouldEnqueue = existing.status === "queued";
      if (existing.status === "failed" && existing.errorCode === "QUEUE_FAILED") {
        const restored = await this.restoreFailed(existing, actorUserId);
        if (restored) {
          row = restored;
          shouldEnqueue = true;
        }
      }
    }

    if (shouldEnqueue) await this.enqueueOrFail(row, actorUserId);
    return this.getById(tenantId, row.id);
  }

  async list(tenantId: string, shiftId: string): Promise<ShiftExportDto[]> {
    const rows = await this.listedRows(
      and(eq(schema.shiftExports.tenantId, tenantId), eq(schema.shiftExports.shiftId, shiftId)),
    );
    return this.toDtos(rows);
  }

  async retry(tenantId: string, actorUserId: string, exportId: string): Promise<ShiftExportDto> {
    const [existing] = await this.db
      .select()
      .from(schema.shiftExports)
      .where(and(eq(schema.shiftExports.tenantId, tenantId), eq(schema.shiftExports.id, exportId)))
      .limit(1);
    if (!existing) throw new NotFoundException();
    if (existing.status !== "failed") throw new ConflictException("Only failed exports can retry");
    const restored = await this.restoreFailed(existing, actorUserId);
    if (!restored) throw new ConflictException("Export is no longer failed");
    await this.enqueueOrFail(restored, actorUserId);
    return this.getById(tenantId, exportId);
  }

  async download(
    tenantId: string,
    actorUserId: string,
    exportId: string,
    artifactId: string,
  ): Promise<ShiftExportDownloadDto> {
    const [row] = await this.db
      .select({
        export: schema.shiftExports,
        artifact: schema.shiftExportArtifacts,
      })
      .from(schema.shiftExportArtifacts)
      .innerJoin(
        schema.shiftExports,
        and(
          eq(schema.shiftExports.tenantId, schema.shiftExportArtifacts.tenantId),
          eq(schema.shiftExports.id, schema.shiftExportArtifacts.exportId),
        ),
      )
      .where(
        and(
          eq(schema.shiftExports.tenantId, tenantId),
          eq(schema.shiftExports.id, exportId),
          eq(schema.shiftExports.status, "ready"),
          eq(schema.shiftExportArtifacts.id, artifactId),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException();

    const url = await this.storage.presignRead(row.artifact.objectKey, 300, {
      downloadFilename: row.artifact.filename,
    });
    await this.writeAudit(this.db, row.export, actorUserId, "shift_export.downloaded", "success", {
      artifactId: row.artifact.id,
      partNumber: row.artifact.partNumber,
      filename: row.artifact.filename,
    });
    return { url, filename: row.artifact.filename, expiresInSeconds: 300 };
  }

  private async getById(tenantId: string, exportId: string): Promise<ShiftExportDto> {
    const rows = await this.listedRows(
      and(eq(schema.shiftExports.tenantId, tenantId), eq(schema.shiftExports.id, exportId)),
    );
    const [dto] = await this.toDtos(rows);
    if (!dto) throw new NotFoundException();
    return dto;
  }

  private listedRows(where: ReturnType<typeof and>): Promise<ListedShiftExportRow[]> {
    return this.db
      .select({
        ...getTableColumns(schema.shiftExports),
        lateDataAt: schema.shifts.lateDataAt,
        userName: schema.user.name,
        firstName: schema.userProfiles.firstName,
        lastName: schema.userProfiles.lastName,
        middleName: schema.userProfiles.middleName,
      })
      .from(schema.shiftExports)
      .innerJoin(
        schema.shifts,
        and(
          eq(schema.shifts.tenantId, schema.shiftExports.tenantId),
          eq(schema.shifts.id, schema.shiftExports.shiftId),
        ),
      )
      .innerJoin(schema.user, eq(schema.user.id, schema.shiftExports.createdByUserId))
      .leftJoin(schema.userProfiles, eq(schema.userProfiles.userId, schema.user.id))
      .where(where)
      .orderBy(desc(schema.shiftExports.createdAt));
  }

  private async toDtos(rows: ListedShiftExportRow[]): Promise<ShiftExportDto[]> {
    const [firstRow] = rows;
    if (!firstRow) return [];
    const artifacts = await this.db
      .select()
      .from(schema.shiftExportArtifacts)
      .where(
        and(
          eq(schema.shiftExportArtifacts.tenantId, firstRow.tenantId),
          inArray(
            schema.shiftExportArtifacts.exportId,
            rows.map((row) => row.id),
          ),
        ),
      )
      .orderBy(asc(schema.shiftExportArtifacts.partNumber));
    const byExport = new Map<string, ShiftExportArtifactDto[]>();
    for (const artifact of artifacts) {
      const list = byExport.get(artifact.exportId) ?? [];
      list.push({
        id: artifact.id,
        partNumber: artifact.partNumber,
        physicalLineCount: artifact.physicalLineCount,
        codeCount: artifact.codeCount,
        boxCount: artifact.boxCount,
        filename: artifact.filename,
        mimeType: artifact.mimeType,
        byteSize: artifact.byteSize,
        sha256: artifact.sha256,
      });
      byExport.set(artifact.exportId, list);
    }
    return rows.map((row) => ({
      id: row.id,
      shiftId: row.shiftId,
      formatId: row.formatId as ShiftExportFormatId,
      formatVersion: row.formatVersion as 1,
      maxLines: row.maxLines,
      status: row.status,
      errorCode: row.errorCode,
      productNameSnapshot: row.productNameSnapshot,
      shiftDateSnapshot: row.shiftDateSnapshot,
      totalCodeCount: row.totalCodeCount,
      totalBoxCount: row.totalBoxCount,
      createdByUserId: row.createdByUserId,
      createdByName: creatorName(row),
      sourceSnapshotStartedAt: row.sourceSnapshotStartedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      attemptCount: row.attemptCount,
      createdAt: row.createdAt.toISOString(),
      stale:
        row.lateDataAt !== null &&
        row.sourceSnapshotStartedAt !== null &&
        row.lateDataAt > row.sourceSnapshotStartedAt,
      artifacts: byExport.get(row.id) ?? [],
    }));
  }

  private async restoreFailed(
    existing: ShiftExportRow,
    actorUserId: string,
  ): Promise<ShiftExportRow | undefined> {
    return this.db.transaction(async (tx) => {
      const [restored] = await tx
        .update(schema.shiftExports)
        .set({ status: "queued", errorCode: null, completedAt: null, updatedAt: new Date() })
        .where(
          and(
            eq(schema.shiftExports.tenantId, existing.tenantId),
            eq(schema.shiftExports.id, existing.id),
            eq(schema.shiftExports.status, "failed"),
            eq(schema.shiftExports.errorCode, "QUEUE_FAILED"),
          ),
        )
        .returning();
      if (!restored) return undefined;
      await this.writeAudit(tx, restored, actorUserId, "shift_export.retried", "success", {
        status: "queued",
        attemptCount: restored.attemptCount,
      });
      return restored;
    });
  }

  private async enqueueOrFail(row: ShiftExportRow, actorUserId: string): Promise<void> {
    try {
      await this.jobs.enqueueShiftExport(row.id);
    } catch {
      const completedAt = new Date();
      await this.db.transaction(async (tx) => {
        const [failed] = await tx
          .update(schema.shiftExports)
          .set({
            status: "failed",
            errorCode: "QUEUE_FAILED",
            completedAt,
            updatedAt: completedAt,
          })
          .where(
            and(
              eq(schema.shiftExports.tenantId, row.tenantId),
              eq(schema.shiftExports.id, row.id),
              eq(schema.shiftExports.status, "queued"),
            ),
          )
          .returning();
        if (failed) {
          await this.writeAudit(tx, failed, actorUserId, "shift_export.failed", "failure", {
            status: "failed",
            errorCode: "QUEUE_FAILED",
          });
        }
      });
      throw new ServiceUnavailableException("Shift export queue is unavailable");
    }
  }

  private writeAudit(
    tx: Pick<Db, "insert"> | ShiftExportTx,
    row: ShiftExportRow,
    actorUserId: string,
    action: string,
    outcome: "success" | "failure",
    metadata: Record<string, unknown>,
  ): Promise<unknown> {
    return tx.insert(schema.tenantAuditEvents).values({
      organizationId: row.tenantId,
      actorUserId,
      action,
      outcome,
      targetType: "shift_export",
      targetId: row.id,
      after: {
        tenantId: row.tenantId,
        actorUserId,
        shiftId: row.shiftId,
        exportId: row.id,
        formatId: row.formatId,
        formatVersion: row.formatVersion,
        maxLines: row.maxLines,
        outcome,
        ...metadata,
      },
    });
  }
}

function creatorName(row: ListedShiftExportRow): string | null {
  const profileName = [row.lastName, row.firstName, row.middleName]
    .filter(Boolean)
    .join(" ")
    .trim();
  return profileName || row.userName.trim() || null;
}

function isIdempotencyConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as {
    code?: string;
    constraint?: string;
    cause?: { code?: string; constraint?: string };
  };
  const code = value.code ?? value.cause?.code;
  const constraint = value.constraint ?? value.cause?.constraint;
  return code === "23505" && constraint === "shift_exports_tenant_idempotency_uq";
}
