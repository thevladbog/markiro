import { createHash } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";

import { schema, type Db } from "@markiro/db";
import { InventoryDocumentRegistryError, isParticipantInn } from "@markiro/domain";

import { DB } from "../../auth/auth.module";
import { PgBossService } from "../../jobs/jobs.module";
import { ObjectStorageService } from "../storage/object-storage.service";
import type {
  CreateInventoryDocumentRunDto,
  InventoryDocumentDownloadDto,
  InventoryDocumentRunDto,
  InventoryDocumentRunsResponseDto,
} from "./dto";
import { inventoryDocumentRunResponseSchema } from "./dto";
import {
  buildInventoryDocumentZip,
  INVENTORY_DOCUMENT_GENERATOR_REGISTRY,
  InventoryDocumentGeneratorRegistry,
  type InventoryDocumentZipArtifact,
} from "./inventory-document-runner.service";

type InventoryDocumentRunRow = typeof schema.inventoryDocumentRuns.$inferSelect;
type InventoryDocumentTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
const RETRYABLE_ERRORS = [
  "QUEUE_FAILED",
  "STORAGE_FAILED",
  "GENERATION_FAILED",
  "INVALID_ORGANIZATION_INN",
] as const;
const MAX_ZIP_INPUT_BYTES = 50 * 1024 * 1024;

@Injectable()
export class InventoryDocumentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly jobs: PgBossService,
    private readonly storage: ObjectStorageService,
    @Inject(INVENTORY_DOCUMENT_GENERATOR_REGISTRY)
    private readonly generators: InventoryDocumentGeneratorRegistry,
  ) {}

  async create(
    tenantId: string,
    actorUserId: string,
    inventoryId: string,
    input: CreateInventoryDocumentRunDto,
  ): Promise<InventoryDocumentRunDto> {
    const selectedFormats = [...input.selectedFormats].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );
    const requestDigest = digestRequest({ inventoryId, selectedFormats });
    const persisted = await this.findIdempotentRun(tenantId, actorUserId, input.idempotencyKey);
    if (persisted) {
      const replay = await this.prepareIdempotentReplay(persisted, actorUserId, requestDigest);
      if (replay.shouldEnqueue) await this.enqueueOrFail(replay.row, actorUserId);
      return this.getById(tenantId, replay.row.id);
    }
    const resolvedGenerators = this.resolveGeneratorsForFormats(selectedFormats);

    let row: InventoryDocumentRunRow;
    let shouldEnqueue = true;
    try {
      row = await this.db.transaction(async (tx) => {
        const [inventory] = await tx
          .select({
            status: schema.inventories.status,
            resultRevision: schema.inventories.resultRevision,
            number: schema.inventories.number,
            closedAt: schema.inventories.closedAt,
          })
          .from(schema.inventories)
          .where(
            and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)),
          )
          .for("update");
        if (!inventory) throw new NotFoundException();
        if (inventory.status !== "closed" || inventory.closedAt === null) {
          throw new ConflictException({ code: "INVENTORY_DOCUMENT_RUN_REQUIRES_CLOSED" });
        }
        const [organization] = await tx
          .select({
            name: schema.organization.name,
            inn: schema.orgProfiles.inn,
          })
          .from(schema.organization)
          .leftJoin(schema.orgProfiles, eq(schema.orgProfiles.tenantId, schema.organization.id))
          .where(eq(schema.organization.id, tenantId))
          .limit(1);
        if (!organization) throw new NotFoundException();
        this.ensureOrganizationInnAvailable(resolvedGenerators, organization.inn);
        const [created] = await tx
          .insert(schema.inventoryDocumentRuns)
          .values({
            tenantId,
            inventoryId,
            resultRevision: inventory.resultRevision,
            selectedFormats,
            requestDigest,
            organizationNameSnapshot: organization.name,
            organizationInnSnapshot: organization.inn,
            inventoryNumberSnapshot: inventory.number,
            inventoryClosedAtSnapshot: inventory.closedAt,
            createdByUserId: actorUserId,
            idempotencyKey: input.idempotencyKey,
          })
          .returning();
        if (!created) throw new Error("Inventory document run insert returned no row");
        await this.writeAudit(
          tx,
          created,
          actorUserId,
          "inventory.document_run.created",
          "success",
          {
            status: "queued",
          },
        );
        return created;
      });
    } catch (error) {
      if (!isIdempotencyConflict(error)) throw error;
      const existing = await this.findIdempotentRun(tenantId, actorUserId, input.idempotencyKey);
      if (!existing) throw error;
      const replay = await this.prepareIdempotentReplay(existing, actorUserId, requestDigest);
      row = replay.row;
      shouldEnqueue = replay.shouldEnqueue;
    }
    if (shouldEnqueue) await this.enqueueOrFail(row, actorUserId);
    return this.getById(tenantId, row.id);
  }

  async list(tenantId: string, inventoryId: string): Promise<InventoryDocumentRunsResponseDto> {
    const [inventory] = await this.db
      .select({ id: schema.inventories.id })
      .from(schema.inventories)
      .where(and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)))
      .limit(1);
    if (!inventory) throw new NotFoundException();
    const rows = await this.db
      .select()
      .from(schema.inventoryDocumentRuns)
      .where(
        and(
          eq(schema.inventoryDocumentRuns.tenantId, tenantId),
          eq(schema.inventoryDocumentRuns.inventoryId, inventoryId),
        ),
      )
      .orderBy(desc(schema.inventoryDocumentRuns.createdAt), desc(schema.inventoryDocumentRuns.id));
    return { items: await this.toDtos(rows) };
  }

  async retry(
    tenantId: string,
    actorUserId: string,
    runId: string,
  ): Promise<InventoryDocumentRunDto> {
    const [existing] = await this.db
      .select()
      .from(schema.inventoryDocumentRuns)
      .where(
        and(
          eq(schema.inventoryDocumentRuns.tenantId, tenantId),
          eq(schema.inventoryDocumentRuns.id, runId),
        ),
      )
      .limit(1);
    if (!existing) throw new NotFoundException();
    if (existing.status !== "failed") {
      throw new ConflictException({ code: "INVENTORY_DOCUMENT_RUN_NOT_RETRYABLE" });
    }
    const restored = await this.restoreFailed(existing, actorUserId, RETRYABLE_ERRORS, {
      refreshOrganizationSnapshot: true,
    });
    if (!restored) throw new ConflictException({ code: "INVENTORY_DOCUMENT_RUN_NOT_RETRYABLE" });
    await this.enqueueOrFail(restored, actorUserId);
    return this.getById(tenantId, runId);
  }

  async downloadArtifact(
    tenantId: string,
    actorUserId: string,
    runId: string,
    artifactId: string,
  ): Promise<InventoryDocumentDownloadDto> {
    const [row] = await this.db
      .select({ run: schema.inventoryDocumentRuns, artifact: schema.inventoryDocumentArtifacts })
      .from(schema.inventoryDocumentArtifacts)
      .innerJoin(
        schema.inventoryDocumentRuns,
        and(
          eq(schema.inventoryDocumentRuns.tenantId, schema.inventoryDocumentArtifacts.tenantId),
          eq(schema.inventoryDocumentRuns.id, schema.inventoryDocumentArtifacts.runId),
        ),
      )
      .where(
        and(
          eq(schema.inventoryDocumentRuns.tenantId, tenantId),
          eq(schema.inventoryDocumentRuns.id, runId),
          eq(schema.inventoryDocumentRuns.status, "ready"),
          eq(schema.inventoryDocumentArtifacts.id, artifactId),
          isNull(schema.inventoryDocumentArtifacts.invalidatedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException();
    const url = await this.storage.presignRead(row.artifact.objectKey, 300, {
      downloadFilename: row.artifact.filename,
    });
    const downloadedAt = new Date();
    await this.db.transaction(async (tx) => {
      const updated = await tx
        .update(schema.inventoryDocumentArtifacts)
        .set({ downloadedAt, downloadedByUserId: actorUserId })
        .where(
          and(
            eq(schema.inventoryDocumentArtifacts.tenantId, tenantId),
            eq(schema.inventoryDocumentArtifacts.runId, runId),
            eq(schema.inventoryDocumentArtifacts.id, artifactId),
            isNull(schema.inventoryDocumentArtifacts.invalidatedAt),
          ),
        )
        .returning({ id: schema.inventoryDocumentArtifacts.id });
      if (updated.length === 0)
        throw new ConflictException({ code: "INVENTORY_DOCUMENT_ARTIFACT_INVALIDATED" });
      await this.writeAudit(
        tx,
        row.run,
        actorUserId,
        "inventory.document_artifact.downloaded",
        "success",
        {
          artifactId,
          filename: row.artifact.filename,
        },
      );
    });
    return { url, filename: row.artifact.filename, expiresInSeconds: 300 };
  }

  async downloadZip(
    tenantId: string,
    actorUserId: string,
    runId: string,
  ): Promise<InventoryDocumentDownloadDto> {
    const [run] = await this.db
      .select()
      .from(schema.inventoryDocumentRuns)
      .where(
        and(
          eq(schema.inventoryDocumentRuns.tenantId, tenantId),
          eq(schema.inventoryDocumentRuns.id, runId),
          eq(schema.inventoryDocumentRuns.status, "ready"),
        ),
      )
      .limit(1);
    if (!run) throw new NotFoundException();
    const rows = await this.db
      .select()
      .from(schema.inventoryDocumentArtifacts)
      .where(
        and(
          eq(schema.inventoryDocumentArtifacts.tenantId, tenantId),
          eq(schema.inventoryDocumentArtifacts.runId, runId),
          isNull(schema.inventoryDocumentArtifacts.invalidatedAt),
        ),
      )
      .orderBy(
        asc(schema.inventoryDocumentArtifacts.filename),
        asc(schema.inventoryDocumentArtifacts.id),
      );
    if (rows.length === 0) {
      throw new ConflictException({ code: "INVENTORY_DOCUMENT_RUN_HAS_NO_ARTIFACTS" });
    }
    const totalBytes = rows.reduce((total, artifact) => total + artifact.byteSize, 0);
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_ZIP_INPUT_BYTES) {
      throw new ConflictException({ code: "INVENTORY_DOCUMENT_ZIP_TOO_LARGE" });
    }
    const artifacts: InventoryDocumentZipArtifact[] = [];
    for (const row of rows) {
      const stored = await this.storage.get(row.objectKey, {
        maxBytes: Math.max(1, row.byteSize),
      });
      artifacts.push({
        filename: row.filename,
        mimeType: row.mimeType,
        bytes: stored.body,
        sha256: row.sha256,
        byteSize: row.byteSize,
        rowCount: row.rowCount,
        codeCount: row.codeCount,
        boxCount: row.boxCount,
        formatId: row.formatId,
        formatVersion: row.formatVersion,
        partNumber: row.partNumber,
      });
    }
    const body = Buffer.from(buildInventoryDocumentZip(run.id, run.resultRevision, artifacts));
    const sha256 = createHash("sha256").update(body).digest("hex");
    const objectKey = `tenants/${tenantId}/inventory-documents/${run.id}/revision-${run.resultRevision}/package.zip`;
    const filename = `inventory-${run.inventoryId}-revision-${run.resultRevision}.zip`;
    await this.storage.putVerified(objectKey, body, "application/zip", sha256);
    try {
      const url = await this.storage.presignRead(objectKey, 300, { downloadFilename: filename });
      await this.db.transaction(async (tx) => {
        const updated = await tx
          .update(schema.inventoryDocumentArtifacts)
          .set({ downloadedAt: new Date(), downloadedByUserId: actorUserId })
          .where(
            and(
              eq(schema.inventoryDocumentArtifacts.tenantId, tenantId),
              eq(schema.inventoryDocumentArtifacts.runId, runId),
              inArray(
                schema.inventoryDocumentArtifacts.id,
                rows.map((row) => row.id),
              ),
              isNull(schema.inventoryDocumentArtifacts.invalidatedAt),
            ),
          )
          .returning({ id: schema.inventoryDocumentArtifacts.id });
        if (updated.length !== rows.length) {
          throw new ConflictException({ code: "INVENTORY_DOCUMENT_ARTIFACT_INVALIDATED" });
        }
        await this.writeAudit(
          tx,
          run,
          actorUserId,
          "inventory.document_run.zip_downloaded",
          "success",
          {
            artifactCount: rows.length,
            filename,
            sha256,
          },
        );
      });
      return { url, filename, expiresInSeconds: 300 };
    } catch (error) {
      await this.storage.delete(objectKey).catch(() => undefined);
      throw error;
    }
  }

  private async findIdempotentRun(
    tenantId: string,
    actorUserId: string,
    idempotencyKey: string,
  ): Promise<InventoryDocumentRunRow | undefined> {
    const [existing] = await this.db
      .select()
      .from(schema.inventoryDocumentRuns)
      .where(
        and(
          eq(schema.inventoryDocumentRuns.tenantId, tenantId),
          eq(schema.inventoryDocumentRuns.createdByUserId, actorUserId),
          eq(schema.inventoryDocumentRuns.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    return existing;
  }

  private async prepareIdempotentReplay(
    existing: InventoryDocumentRunRow,
    actorUserId: string,
    requestDigest: string,
  ): Promise<{ row: InventoryDocumentRunRow; shouldEnqueue: boolean }> {
    if (existing.requestDigest !== requestDigest) {
      throw new ConflictException({ code: "INVENTORY_DOCUMENT_IDEMPOTENCY_CONFLICT" });
    }
    const [inventory] = await this.db
      .select({
        status: schema.inventories.status,
        resultRevision: schema.inventories.resultRevision,
      })
      .from(schema.inventories)
      .where(
        and(
          eq(schema.inventories.tenantId, existing.tenantId),
          eq(schema.inventories.id, existing.inventoryId),
        ),
      )
      .limit(1);
    if (
      !inventory ||
      inventory.status !== "closed" ||
      inventory.resultRevision !== existing.resultRevision
    ) {
      throw new ConflictException({ code: "INVENTORY_DOCUMENT_RUN_STALE_REVISION" });
    }
    if (existing.status === "failed" && existing.errorCode === "QUEUE_FAILED") {
      const restored = await this.restoreFailed(existing, actorUserId, ["QUEUE_FAILED"]);
      if (restored) return { row: restored, shouldEnqueue: true };
    }
    return { row: existing, shouldEnqueue: false };
  }

  private async getById(tenantId: string, runId: string): Promise<InventoryDocumentRunDto> {
    const [row] = await this.db
      .select()
      .from(schema.inventoryDocumentRuns)
      .where(
        and(
          eq(schema.inventoryDocumentRuns.tenantId, tenantId),
          eq(schema.inventoryDocumentRuns.id, runId),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException();
    const [dto] = await this.toDtos([row]);
    if (!dto) throw new NotFoundException();
    return dto;
  }

  private async toDtos(
    rows: readonly InventoryDocumentRunRow[],
  ): Promise<InventoryDocumentRunDto[]> {
    if (rows.length === 0) return [];
    const artifacts = await this.db
      .select()
      .from(schema.inventoryDocumentArtifacts)
      .where(
        and(
          eq(schema.inventoryDocumentArtifacts.tenantId, rows[0]!.tenantId),
          inArray(
            schema.inventoryDocumentArtifacts.runId,
            rows.map((row) => row.id),
          ),
        ),
      )
      .orderBy(
        asc(schema.inventoryDocumentArtifacts.formatId),
        asc(schema.inventoryDocumentArtifacts.partNumber),
      );
    const byRun = new Map<string, typeof artifacts>();
    for (const artifact of artifacts) {
      const current = byRun.get(artifact.runId) ?? [];
      current.push(artifact);
      byRun.set(artifact.runId, current);
    }
    return rows.map((row) =>
      inventoryDocumentRunResponseSchema.parse({
        id: row.id,
        inventoryId: row.inventoryId,
        resultRevision: row.resultRevision,
        selectedFormats: row.selectedFormats,
        status: row.status,
        errorCode: row.errorCode,
        sourceSnapshotStartedAt: row.sourceSnapshotStartedAt?.toISOString() ?? null,
        sourceSnapshotCompletedAt: row.sourceSnapshotCompletedAt?.toISOString() ?? null,
        completedAt: row.completedAt?.toISOString() ?? null,
        attemptCount: row.attemptCount,
        createdAt: row.createdAt.toISOString(),
        artifacts: (byRun.get(row.id) ?? []).map((artifact) => ({
          id: artifact.id,
          formatId: artifact.formatId,
          formatVersion: artifact.formatVersion,
          partNumber: artifact.partNumber,
          filename: artifact.filename,
          mimeType: artifact.mimeType,
          rowCount: artifact.rowCount,
          codeCount: artifact.codeCount,
          boxCount: artifact.boxCount,
          byteSize: artifact.byteSize,
          sha256: artifact.sha256,
          downloadedAt: artifact.downloadedAt?.toISOString() ?? null,
          invalidatedAt: artifact.invalidatedAt?.toISOString() ?? null,
        })),
      }),
    );
  }

  private async restoreFailed(
    existing: InventoryDocumentRunRow,
    actorUserId: string,
    errorCodes: readonly string[],
    options?: { refreshOrganizationSnapshot?: boolean },
  ): Promise<InventoryDocumentRunRow | undefined> {
    return this.db.transaction(async (tx) => {
      const [inventory] = await tx
        .select({
          status: schema.inventories.status,
          resultRevision: schema.inventories.resultRevision,
        })
        .from(schema.inventories)
        .where(
          and(
            eq(schema.inventories.tenantId, existing.tenantId),
            eq(schema.inventories.id, existing.inventoryId),
          ),
        )
        .for("update");
      if (inventory?.status !== "closed" || inventory.resultRevision !== existing.resultRevision) {
        throw new ConflictException({ code: "INVENTORY_DOCUMENT_RUN_STALE_REVISION" });
      }
      const organizationSnapshot = options?.refreshOrganizationSnapshot
        ? await this.reloadOrganizationSnapshot(tx, existing)
        : undefined;
      const [restored] = await tx
        .update(schema.inventoryDocumentRuns)
        .set({
          status: "queued",
          errorCode: null,
          completedAt: null,
          updatedAt: new Date(),
          ...organizationSnapshot,
        })
        .where(
          and(
            eq(schema.inventoryDocumentRuns.tenantId, existing.tenantId),
            eq(schema.inventoryDocumentRuns.id, existing.id),
            eq(schema.inventoryDocumentRuns.status, "failed"),
            inArray(schema.inventoryDocumentRuns.errorCode, [...errorCodes]),
          ),
        )
        .returning();
      if (!restored) return undefined;
      await this.writeAudit(
        tx,
        restored,
        actorUserId,
        "inventory.document_run.retried",
        "success",
        {
          status: "queued",
        },
      );
      return restored;
    });
  }

  /**
   * Re-reads the tenant's current organization name/INN and re-validates the
   * INN requirement for the run's already-selected formats, the same way
   * `create` does. Retries must reflect the issuer's current details rather
   * than the (possibly stale or invalid) values captured when the run was
   * first created.
   *
   * Formats are resolved with execution semantics here (not selection
   * semantics): the run's `selectedFormats` were already fixed when it was
   * first created, so a retry must be able to resolve a format that has since
   * been superseded in the catalog (e.g. a frozen historical aggregation
   * version) rather than reject it as if it were a brand-new selection.
   */
  private async reloadOrganizationSnapshot(
    tx: InventoryDocumentTransaction,
    existing: InventoryDocumentRunRow,
  ): Promise<{ organizationNameSnapshot: string; organizationInnSnapshot: string | null }> {
    const [organization] = await tx
      .select({
        name: schema.organization.name,
        inn: schema.orgProfiles.inn,
      })
      .from(schema.organization)
      .leftJoin(schema.orgProfiles, eq(schema.orgProfiles.tenantId, schema.organization.id))
      .where(eq(schema.organization.id, existing.tenantId))
      .limit(1);
    if (!organization) throw new NotFoundException();
    const resolvedGenerators = this.resolveGeneratorsForFormats(existing.selectedFormats, {
      mode: "execution",
    });
    this.ensureOrganizationInnAvailable(resolvedGenerators, organization.inn);
    return {
      organizationNameSnapshot: organization.name,
      organizationInnSnapshot: organization.inn,
    };
  }

  private resolveGeneratorsForFormats(
    selectedFormats: readonly { id: string; version: number }[],
    options?: { mode?: "selection" | "execution" },
  ): ReturnType<InventoryDocumentGeneratorRegistry["resolveForSelection"]>[] {
    const mode = options?.mode ?? "selection";
    return selectedFormats.map((selected) => {
      try {
        return mode === "execution"
          ? this.generators.resolveForExecution(selected.id, selected.version)
          : this.generators.resolveForSelection(selected.id, selected.version);
      } catch (error) {
        throw formatSelectionError(error);
      }
    });
  }

  private ensureOrganizationInnAvailable(
    resolvedGenerators: readonly ReturnType<
      InventoryDocumentGeneratorRegistry["resolveForSelection"]
    >[],
    inn: string | null,
  ): void {
    const needsInn = resolvedGenerators.some(
      (generator) => generator.descriptor.requiresOrganizationInn === true,
    );
    if (!needsInn) return;
    const trimmed = inn?.trim() ?? "";
    // Minimum shared validation: non-empty AND shaped like a usable
    // organization/participant INN (isParticipantInn's 9/10/12-digit forms).
    // This deliberately does not enforce aggregation's stricter 10-digit-only
    // requirement, so a 12-digit individual-entrepreneur INN can still pass
    // this gate and only fail later at generation for aggregation formats —
    // a pre-existing discrepancy between the aggregation and disaggregation
    // domain validators, not introduced by this gate.
    if (trimmed.length === 0 || !isParticipantInn(trimmed)) {
      throw new ConflictException({ code: "ORGANIZATION_INN_REQUIRED" });
    }
  }

  private async enqueueOrFail(row: InventoryDocumentRunRow, actorUserId: string): Promise<void> {
    try {
      await this.jobs.enqueueInventoryDocumentRun(row.id);
    } catch {
      const completedAt = new Date();
      await this.db.transaction(async (tx) => {
        const [failed] = await tx
          .update(schema.inventoryDocumentRuns)
          .set({ status: "failed", errorCode: "QUEUE_FAILED", completedAt, updatedAt: completedAt })
          .where(
            and(
              eq(schema.inventoryDocumentRuns.tenantId, row.tenantId),
              eq(schema.inventoryDocumentRuns.id, row.id),
              eq(schema.inventoryDocumentRuns.status, "queued"),
            ),
          )
          .returning();
        if (failed) {
          await this.writeAudit(
            tx,
            failed,
            actorUserId,
            "inventory.document_run.failed",
            "failure",
            {
              errorCode: "QUEUE_FAILED",
            },
          );
        }
      });
      throw new ServiceUnavailableException({ code: "INVENTORY_DOCUMENT_QUEUE_UNAVAILABLE" });
    }
  }

  private writeAudit(
    tx: Pick<Db, "insert"> | InventoryDocumentTransaction,
    row: InventoryDocumentRunRow,
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
      targetType: "inventory_document_run",
      targetId: row.id,
      after: {
        inventoryId: row.inventoryId,
        resultRevision: row.resultRevision,
        selectedFormats: row.selectedFormats,
        ...metadata,
      },
    });
  }
}

function digestRequest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function formatSelectionError(error: unknown): BadRequestException {
  if (error instanceof InventoryDocumentRegistryError) {
    return new BadRequestException({ code: `INVENTORY_DOCUMENT_${error.code}` });
  }
  return new BadRequestException({ code: "INVENTORY_DOCUMENT_FORMAT_INVALID" });
}

function isIdempotencyConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as {
    code?: string;
    constraint?: string;
    cause?: { code?: string; constraint?: string };
  };
  return (
    (value.code ?? value.cause?.code) === "23505" &&
    (value.constraint ?? value.cause?.constraint) ===
      "inventory_document_runs_tenant_actor_idempotency_uq"
  );
}
