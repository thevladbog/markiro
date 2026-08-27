import { createHash, randomUUID } from "node:crypto";

import {
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";

import { schema, type Db } from "@markiro/db";
import {
  classifyInventorySnapshotRow,
  INVENTORY_CHZ_STATUSES,
  type InventoryChzStatus,
} from "@markiro/domain";

import { DB } from "../../auth/auth.module";
import { isMissingObjectError, ObjectStorageService } from "../storage/object-storage.service";
import { ChzImportError, parseChzImport } from "./chz-import-parser";
import { CHZ_MAX_COMPRESSED_BYTES, type ChzContainerKind } from "./chz-tabular-reader";
import type {
  FixInventorySnapshotDto,
  InventorySnapshotCountsDto,
  InventorySnapshotDto,
  InventorySnapshotInputSelectionDto,
} from "./dto";

type InventoryTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type InventoryImport = typeof schema.inventoryImports.$inferSelect;
type NewSnapshotCode = typeof schema.inventorySnapshotCodes.$inferInsert;

export interface InventorySnapshotDigestEvidence {
  status: InventoryChzStatus;
  importId: string;
  sha256: string;
  byteSize: number;
  containerKind: ChzContainerKind;
}

const SNAPSHOT_CODE_INSERT_CHUNK = 250;

const STATUS_COUNT_KEY: Record<
  InventoryChzStatus,
  keyof Pick<
    InventorySnapshotCountsDto,
    "emitted" | "introduced" | "applied" | "retired" | "writtenOff" | "disaggregation"
  >
> = {
  EMITTED: "emitted",
  INTRODUCED: "introduced",
  APPLIED: "applied",
  RETIRED: "retired",
  WRITTEN_OFF: "writtenOff",
  DISAGGREGATION: "disaggregation",
};

export function inventorySnapshotCombinedDigest(
  evidence: readonly InventorySnapshotDigestEvidence[],
): string {
  const byStatus = new Map(evidence.map((item) => [item.status, item]));
  if (byStatus.size !== INVENTORY_CHZ_STATUSES.length) {
    throw new Error("Snapshot digest requires one input for every inventory status");
  }
  const canonical = {
    version: 1,
    inputs: INVENTORY_CHZ_STATUSES.map((status) => {
      const item = byStatus.get(status);
      if (item === undefined) {
        throw new Error(`Snapshot digest input is missing for ${status}`);
      }
      return {
        status,
        importId: item.importId,
        sha256: item.sha256,
        byteSize: item.byteSize,
        containerKind: item.containerKind,
      };
    }),
  };
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

@Injectable()
export class InventorySnapshotService {
  private readonly logger = new Logger(InventorySnapshotService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: ObjectStorageService,
  ) {}

  async fix(
    tenantId: string,
    actorUserId: string,
    inventoryId: string,
    input: FixInventorySnapshotDto,
  ): Promise<InventorySnapshotDto> {
    try {
      return await this.db.transaction(async (tx) => {
        const [inventory] = await tx
          .select({
            id: schema.inventories.id,
            status: schema.inventories.status,
            gtin14: schema.inventories.gtin14Snapshot,
            productId: schema.inventories.productId,
            lineId: schema.inventories.lineId,
            productionDateFrom: schema.inventories.productionDateFrom,
            productionDateTo: schema.inventories.productionDateTo,
            activeSnapshotId: schema.inventories.activeSnapshotId,
          })
          .from(schema.inventories)
          .where(
            and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)),
          )
          .for("update");
        if (!inventory) throw new NotFoundException();

        if (inventory.activeSnapshotId !== null) {
          return this.existingSnapshot(
            tx,
            tenantId,
            inventoryId,
            inventory.activeSnapshotId,
            input.imports,
          );
        }
        if (inventory.status !== "draft" && inventory.status !== "preparing") {
          throw new ConflictException({ code: "INVENTORY_SNAPSHOT_ALREADY_FIXED" });
        }

        const [product] = await tx
          .select({
            name: schema.products.name,
            boxCapacity: schema.products.boxCapacity,
          })
          .from(schema.products)
          .where(
            and(
              eq(schema.products.tenantId, tenantId),
              eq(schema.products.id, inventory.productId),
            ),
          )
          .for("share");
        const [line] = await tx
          .select({ name: schema.lines.name })
          .from(schema.lines)
          .where(and(eq(schema.lines.tenantId, tenantId), eq(schema.lines.id, inventory.lineId)))
          .for("share");
        if (!product || !line) {
          throw new ConflictException({ code: "INVENTORY_SNAPSHOT_CATALOG_INVALID" });
        }

        const selectedImports = await this.selectedImports(
          tx,
          tenantId,
          inventoryId,
          input.imports,
        );
        const combinedDigest = inventorySnapshotCombinedDigest(
          selectedImports.map((row) => ({
            status: row.declaredStatus,
            importId: row.id,
            sha256: row.sha256,
            byteSize: row.byteSize,
            containerKind: row.containerKind,
          })),
        );
        const counts = this.emptyCounts();
        const parentSsccs = new Set<string>();
        const seenCodeHashes = new Set<string>();
        const codeRows: NewSnapshotCode[] = [];
        const snapshotId = randomUUID();

        for (const status of INVENTORY_CHZ_STATUSES) {
          const evidence = selectedImports.find((row) => row.declaredStatus === status);
          if (evidence === undefined) {
            throw new UnprocessableEntityException({
              code: "INVENTORY_SNAPSHOT_IMPORT_INVALID",
            });
          }
          const parsed = await this.readAndParseEvidence(
            tenantId,
            inventoryId,
            inventory.gtin14,
            evidence,
          );
          counts[STATUS_COUNT_KEY[status]] = parsed.rows.length;

          for (const row of parsed.rows) {
            if (seenCodeHashes.has(row.codeHash)) {
              throw new UnprocessableEntityException({
                code: "INVENTORY_SNAPSHOT_DUPLICATE_CODE",
              });
            }
            seenCodeHashes.add(row.codeHash);
            const classification = classifyInventorySnapshotRow(
              {
                gtin14: row.gtin14,
                status: row.sourceStatus,
                state: row.sourceState,
                sourceProductionDate: row.sourceProductionDate,
              },
              {
                productionDateFrom: inventory.productionDateFrom,
                productionDateTo: inventory.productionDateTo,
              },
            );
            if (classification.kind === "invalid_missing_production_date") {
              throw new UnprocessableEntityException({
                code: "INVENTORY_SNAPSHOT_PRODUCTION_DATE_REQUIRED",
              });
            }
            if (classification.protected) counts.protected += 1;
            if (classification.expected) counts.expected += 1;
            if (row.parentSscc === null) counts.loose += 1;
            else parentSsccs.add(row.parentSscc);
            codeRows.push({
              tenantId,
              snapshotId,
              canonicalRaw: row.canonicalKm,
              codeHash: row.codeHash,
              gtin14: row.gtin14,
              serial: row.serial,
              sourceStatus: row.sourceStatus,
              sourceState: row.sourceState,
              sourceProductionDate: row.sourceProductionDate,
              parentSscc: row.parentSscc,
              expected: classification.expected,
              protected: classification.protected,
            });
          }
        }
        counts.packages = parentSsccs.size;

        const fixedAt = new Date();
        await tx.insert(schema.inventorySnapshots).values({
          id: snapshotId,
          tenantId,
          inventoryId,
          revision: 1,
          combinedDigest,
          productName: product.name,
          lineName: line.name,
          boxCapacity: product.boxCapacity,
          emittedCount: counts.emitted,
          introducedCount: counts.introduced,
          appliedCount: counts.applied,
          retiredCount: counts.retired,
          writtenOffCount: counts.writtenOff,
          disaggregationCount: counts.disaggregation,
          protectedCount: counts.protected,
          expectedCount: counts.expected,
          packageCount: counts.packages,
          looseCount: counts.loose,
          fixedByUserId: actorUserId,
          fixedAt,
        });
        await tx.insert(schema.inventorySnapshotInputs).values(
          INVENTORY_CHZ_STATUSES.map((status) => ({
            tenantId,
            snapshotId,
            inventoryId,
            status,
            importId: input.imports[status],
            importParseOutcome: "succeeded" as const,
          })),
        );
        for (let offset = 0; offset < codeRows.length; offset += SNAPSHOT_CODE_INSERT_CHUNK) {
          await tx
            .insert(schema.inventorySnapshotCodes)
            .values(codeRows.slice(offset, offset + SNAPSHOT_CODE_INSERT_CHUNK));
        }
        const [published] = await tx
          .update(schema.inventories)
          .set({ status: "ready", activeSnapshotId: snapshotId, updatedAt: fixedAt })
          .where(
            and(
              eq(schema.inventories.tenantId, tenantId),
              eq(schema.inventories.id, inventoryId),
              eq(schema.inventories.status, inventory.status),
              isNull(schema.inventories.activeSnapshotId),
            ),
          )
          .returning({ id: schema.inventories.id });
        if (!published) {
          throw new ConflictException({ code: "INVENTORY_SNAPSHOT_ALREADY_FIXED" });
        }
        await tx.insert(schema.tenantAuditEvents).values({
          organizationId: tenantId,
          actorUserId,
          action: "inventory.snapshot.fixed",
          outcome: "success",
          targetType: "inventory",
          targetId: inventoryId,
          after: {
            tenantId,
            actorUserId,
            inventoryId,
            snapshotId,
            combinedDigest,
            inputs: input.imports,
            counts,
          },
        });

        return {
          id: snapshotId,
          inventoryId,
          revision: 1,
          combinedDigest,
          fixedAt: fixedAt.toISOString(),
          inputs: this.orderedInputs(input.imports),
          counts,
        };
      });
    } catch (cause) {
      const error = this.normalizeError(cause);
      await this.writeFailureAudit(tenantId, actorUserId, inventoryId, input.imports, error);
      throw error;
    }
  }

  private async selectedImports(
    tx: InventoryTx,
    tenantId: string,
    inventoryId: string,
    selection: InventorySnapshotInputSelectionDto,
  ): Promise<InventoryImport[]> {
    const ids = INVENTORY_CHZ_STATUSES.map((status) => selection[status]);
    const rows = await tx
      .select()
      .from(schema.inventoryImports)
      .where(
        and(
          eq(schema.inventoryImports.tenantId, tenantId),
          eq(schema.inventoryImports.inventoryId, inventoryId),
          inArray(schema.inventoryImports.id, ids),
        ),
      );
    if (rows.length !== INVENTORY_CHZ_STATUSES.length) {
      throw new UnprocessableEntityException({ code: "INVENTORY_SNAPSHOT_IMPORT_INVALID" });
    }
    const byId = new Map(rows.map((row) => [row.id, row]));
    return INVENTORY_CHZ_STATUSES.map((status) => {
      const row = byId.get(selection[status]);
      if (
        row === undefined ||
        row.declaredStatus !== status ||
        row.parsedStatus !== status ||
        row.parseOutcome !== "succeeded" ||
        row.includedGtin14 === null ||
        row.errorCount !== 0 ||
        row.errorCode !== null
      ) {
        throw new UnprocessableEntityException({ code: "INVENTORY_SNAPSHOT_IMPORT_INVALID" });
      }
      return row;
    });
  }

  private async readAndParseEvidence(
    tenantId: string,
    inventoryId: string,
    gtin14: string,
    evidence: InventoryImport,
  ) {
    const expectedKey = `tenants/${tenantId}/inventories/${inventoryId}/imports/${evidence.declaredStatus}/${evidence.sha256}.${evidence.containerKind}`;
    if (evidence.objectKey !== expectedKey || evidence.includedGtin14 !== gtin14) {
      throw new UnprocessableEntityException({ code: "INVENTORY_SNAPSHOT_EVIDENCE_MISMATCH" });
    }
    let stored: Awaited<ReturnType<ObjectStorageService["get"]>>;
    try {
      stored = await this.storage.get(evidence.objectKey, {
        maxBytes: CHZ_MAX_COMPRESSED_BYTES,
      });
    } catch (error) {
      if (isMissingObjectError(error)) {
        throw new UnprocessableEntityException({
          code: "INVENTORY_SNAPSHOT_OBJECT_UNAVAILABLE",
        });
      }
      throw new ServiceUnavailableException({ code: "INVENTORY_SNAPSHOT_OBJECT_READ_FAILED" });
    }
    const digest = createHash("sha256").update(stored.body).digest("hex");
    if (stored.body.byteLength !== evidence.byteSize || digest !== evidence.sha256) {
      throw new UnprocessableEntityException({ code: "INVENTORY_SNAPSHOT_EVIDENCE_MISMATCH" });
    }

    let parsed: ReturnType<typeof parseChzImport>;
    try {
      parsed = parseChzImport({
        filename: `evidence.${evidence.containerKind}`,
        mimeType: this.containerMimeType(evidence.containerKind),
        bytes: stored.body,
        expectedStatus: evidence.declaredStatus,
        expectedGtin14: gtin14,
      });
    } catch (error) {
      if (error instanceof ChzImportError) {
        throw new UnprocessableEntityException({ code: "INVENTORY_SNAPSHOT_SOURCE_INVALID" });
      }
      throw error;
    }
    const duplicateCount =
      parsed.rows.length - new Set(parsed.rows.map((row) => row.codeHash)).size;
    if (
      parsed.sha256 !== evidence.sha256 ||
      parsed.filter.status !== evidence.parsedStatus ||
      parsed.filter.includedGtin14 !== evidence.includedGtin14 ||
      parsed.rows.length !== evidence.rowCount ||
      duplicateCount !== evidence.duplicateCount
    ) {
      throw new UnprocessableEntityException({ code: "INVENTORY_SNAPSHOT_EVIDENCE_MISMATCH" });
    }
    if (duplicateCount > 0) {
      throw new UnprocessableEntityException({ code: "INVENTORY_SNAPSHOT_DUPLICATE_CODE" });
    }
    return parsed;
  }

  private async existingSnapshot(
    tx: InventoryTx,
    tenantId: string,
    inventoryId: string,
    snapshotId: string,
    selection: InventorySnapshotInputSelectionDto,
  ): Promise<InventorySnapshotDto> {
    const [snapshot] = await tx
      .select()
      .from(schema.inventorySnapshots)
      .where(
        and(
          eq(schema.inventorySnapshots.tenantId, tenantId),
          eq(schema.inventorySnapshots.inventoryId, inventoryId),
          eq(schema.inventorySnapshots.id, snapshotId),
        ),
      )
      .limit(1);
    const inputs = await tx
      .select({
        status: schema.inventorySnapshotInputs.status,
        importId: schema.inventorySnapshotInputs.importId,
      })
      .from(schema.inventorySnapshotInputs)
      .where(
        and(
          eq(schema.inventorySnapshotInputs.tenantId, tenantId),
          eq(schema.inventorySnapshotInputs.inventoryId, inventoryId),
          eq(schema.inventorySnapshotInputs.snapshotId, snapshotId),
        ),
      );
    if (!snapshot || inputs.length !== INVENTORY_CHZ_STATUSES.length) {
      throw new ConflictException({ code: "INVENTORY_SNAPSHOT_ALREADY_FIXED" });
    }
    const storedInputs = Object.fromEntries(inputs.map((row) => [row.status, row.importId])) as
      Partial<InventorySnapshotInputSelectionDto> | InventorySnapshotInputSelectionDto;
    if (INVENTORY_CHZ_STATUSES.some((status) => storedInputs[status] !== selection[status])) {
      throw new ConflictException({ code: "INVENTORY_SNAPSHOT_ALREADY_FIXED" });
    }
    return {
      id: snapshot.id,
      inventoryId,
      revision: snapshot.revision,
      combinedDigest: snapshot.combinedDigest,
      fixedAt: snapshot.fixedAt.toISOString(),
      inputs: this.orderedInputs(selection),
      counts: {
        emitted: snapshot.emittedCount,
        introduced: snapshot.introducedCount,
        applied: snapshot.appliedCount,
        retired: snapshot.retiredCount,
        writtenOff: snapshot.writtenOffCount,
        disaggregation: snapshot.disaggregationCount,
        protected: snapshot.protectedCount,
        expected: snapshot.expectedCount,
        packages: snapshot.packageCount,
        loose: snapshot.looseCount,
      },
    };
  }

  private orderedInputs(
    selection: InventorySnapshotInputSelectionDto,
  ): InventorySnapshotInputSelectionDto {
    return Object.fromEntries(
      INVENTORY_CHZ_STATUSES.map((status) => [status, selection[status]]),
    ) as InventorySnapshotInputSelectionDto;
  }

  private emptyCounts(): InventorySnapshotCountsDto {
    return {
      emitted: 0,
      introduced: 0,
      applied: 0,
      retired: 0,
      writtenOff: 0,
      disaggregation: 0,
      protected: 0,
      expected: 0,
      packages: 0,
      loose: 0,
    };
  }

  private containerMimeType(containerKind: ChzContainerKind): string {
    if (containerKind === "csv") return "text/csv";
    if (containerKind === "zip") return "application/zip";
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }

  private normalizeError(error: unknown): unknown {
    if (error instanceof HttpException) return error;
    const value = error as { code?: unknown; constraint?: unknown; cause?: unknown };
    const cause = value?.cause as { code?: unknown; constraint?: unknown } | undefined;
    const code = typeof value?.code === "string" ? value.code : cause?.code;
    const constraint = typeof value?.constraint === "string" ? value.constraint : cause?.constraint;
    if (
      code === "23505" &&
      (constraint === "inventory_snapshots_tenant_inventory_uq" ||
        constraint === "inventory_snapshots_tenant_id_inventory_uq")
    ) {
      return new ConflictException({ code: "INVENTORY_SNAPSHOT_ALREADY_FIXED" });
    }
    return new InternalServerErrorException({
      code: "INVENTORY_SNAPSHOT_FIXATION_FAILED",
    });
  }

  private async writeFailureAudit(
    tenantId: string,
    actorUserId: string,
    inventoryId: string,
    inputs: InventorySnapshotInputSelectionDto,
    error: unknown,
  ): Promise<void> {
    const errorCode = this.auditErrorCode(error);
    try {
      await this.db.insert(schema.tenantAuditEvents).values({
        organizationId: tenantId,
        actorUserId,
        action: "inventory.snapshot.fixed",
        outcome: "failure",
        targetType: "inventory",
        targetId: inventoryId,
        after: {
          tenantId,
          actorUserId,
          inventoryId,
          inputs: this.orderedInputs(inputs),
          errorCode,
        },
      });
    } catch {
      this.logger.error(
        `Could not persist inventory snapshot failure audit for tenant ${tenantId}, inventory ${inventoryId}`,
      );
    }
  }

  private auditErrorCode(error: unknown): string {
    if (error instanceof HttpException) {
      const response = error.getResponse();
      if (response !== null && typeof response === "object" && !Array.isArray(response)) {
        const code = (response as Record<string, unknown>).code;
        if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(code)) return code;
      }
      if (error instanceof NotFoundException) return "INVENTORY_NOT_FOUND";
    }
    return "INVENTORY_SNAPSHOT_FIXATION_FAILED";
  }
}
