import { createHash, randomUUID } from "node:crypto";

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
} from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";

import { schema, type Db } from "@markiro/db";
import type { InventoryChzStatus } from "@markiro/domain";

import { DB } from "../../auth/auth.module";
import { ObjectStorageService } from "../storage/object-storage.service";
import { ChzImportError, parseChzImport } from "./chz-import-parser";
import type { ChzContainerKind } from "./chz-tabular-reader";
import type {
  CreateInventoryDto,
  FixInventorySnapshotDto,
  InventoryDto,
  InventoryDetailDto,
  InventoryImportDto,
  InventoryLifecycleStatus,
  InventoryMode,
  ListInventoriesResponseDto,
  InventorySnapshotDto,
  UpdateInventoryDto,
} from "./dto";
import { InventorySnapshotService } from "./inventory-snapshot.service";

type InventoryTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type InventoryImport = typeof schema.inventoryImports.$inferSelect;

interface InventoryJoinedRow {
  id: string;
  number: string;
  status: InventoryLifecycleStatus;
  mode: InventoryMode;
  productId: string;
  gtin14: string;
  productName: string;
  lineId: string;
  lineName: string;
  productionDateFrom: string;
  productionDateTo: string;
  boxLabelTemplateId: string | null;
  boxLabelTemplateName: string | null;
  activeSnapshotId: string | null;
  resultRevision: number;
  createdAt: Date;
  updatedAt: Date;
}

interface InventoryImportFile {
  originalName: string;
  mimeType: string;
  bytes: Buffer;
}

interface PublishedAttempt {
  tenantId: string;
  inventoryId: string;
  importId: string;
  objectKey: string;
}

const INVENTORY_SELECTION = {
  id: schema.inventories.id,
  number: schema.inventories.number,
  status: schema.inventories.status,
  mode: schema.inventories.mode,
  productId: schema.inventories.productId,
  gtin14: schema.inventories.gtin14Snapshot,
  productName: schema.products.name,
  lineId: schema.inventories.lineId,
  lineName: schema.lines.name,
  productionDateFrom: schema.inventories.productionDateFrom,
  productionDateTo: schema.inventories.productionDateTo,
  boxLabelTemplateId: schema.inventories.boxLabelTemplateId,
  boxLabelTemplateName: schema.labelTemplates.name,
  activeSnapshotId: schema.inventories.activeSnapshotId,
  resultRevision: schema.inventories.resultRevision,
  createdAt: schema.inventories.createdAt,
  updatedAt: schema.inventories.updatedAt,
};

const MUTABLE_INVENTORY_STATUSES = new Set<InventoryLifecycleStatus>(["draft", "preparing"]);

@Injectable()
export class InventoriesService {
  private readonly logger = new Logger(InventoriesService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: ObjectStorageService,
    private readonly snapshots: InventorySnapshotService,
  ) {}

  async list(tenantId: string): Promise<ListInventoriesResponseDto> {
    const rows = await this.db
      .select(INVENTORY_SELECTION)
      .from(schema.inventories)
      .innerJoin(
        schema.products,
        and(
          eq(schema.products.tenantId, schema.inventories.tenantId),
          eq(schema.products.id, schema.inventories.productId),
        ),
      )
      .innerJoin(
        schema.lines,
        and(
          eq(schema.lines.tenantId, schema.inventories.tenantId),
          eq(schema.lines.id, schema.inventories.lineId),
        ),
      )
      .leftJoin(
        schema.labelTemplates,
        and(
          eq(schema.labelTemplates.tenantId, schema.inventories.tenantId),
          eq(schema.labelTemplates.id, schema.inventories.boxLabelTemplateId),
        ),
      )
      .where(eq(schema.inventories.tenantId, tenantId))
      .orderBy(desc(schema.inventories.createdAt), desc(schema.inventories.id));
    return { items: rows.map((row) => this.toInventoryDto(row)) };
  }

  async get(tenantId: string, id: string): Promise<InventoryDto> {
    const [row] = await this.db
      .select(INVENTORY_SELECTION)
      .from(schema.inventories)
      .innerJoin(
        schema.products,
        and(
          eq(schema.products.tenantId, schema.inventories.tenantId),
          eq(schema.products.id, schema.inventories.productId),
        ),
      )
      .innerJoin(
        schema.lines,
        and(
          eq(schema.lines.tenantId, schema.inventories.tenantId),
          eq(schema.lines.id, schema.inventories.lineId),
        ),
      )
      .leftJoin(
        schema.labelTemplates,
        and(
          eq(schema.labelTemplates.tenantId, schema.inventories.tenantId),
          eq(schema.labelTemplates.id, schema.inventories.boxLabelTemplateId),
        ),
      )
      .where(and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, id)))
      .limit(1);
    if (!row) throw new NotFoundException();
    return this.toInventoryDto(row);
  }

  async getDetail(tenantId: string, id: string): Promise<InventoryDetailDto> {
    const inventory = await this.get(tenantId, id);
    const [[participantBlockers], [boxBlockers]] = await Promise.all([
      this.db
        .select({
          activeParticipantCount: sql<number>`count(*) filter (where ${schema.inventoryDeviceParticipants.leftAt} is null)::int`,
          pendingEventCount: sql<number>`coalesce(sum(${schema.inventoryDeviceParticipants.pendingEventCount}), 0)::int`,
          participantOpenBoxCount: sql<number>`coalesce(sum(${schema.inventoryDeviceParticipants.openBoxCount}), 0)::int`,
        })
        .from(schema.inventoryDeviceParticipants)
        .where(
          and(
            eq(schema.inventoryDeviceParticipants.tenantId, tenantId),
            eq(schema.inventoryDeviceParticipants.inventoryId, id),
          ),
        ),
      this.db
        .select({
          openRepackBoxCount: sql<number>`count(*) filter (where ${schema.inventoryRepackBoxes.state} = 'open')::int`,
          unresolvedPrintBoxCount: sql<number>`count(*) filter (where ${schema.inventoryRepackBoxes.state} = 'closed' and ${schema.inventoryRepackBoxes.printState} in ('pending', 'printing', 'failed'))::int`,
        })
        .from(schema.inventoryRepackBoxes)
        .where(
          and(
            eq(schema.inventoryRepackBoxes.tenantId, tenantId),
            eq(schema.inventoryRepackBoxes.inventoryId, id),
          ),
        ),
    ]);
    return {
      ...inventory,
      blockers: {
        activeParticipantCount: participantBlockers?.activeParticipantCount ?? 0,
        pendingEventCount: participantBlockers?.pendingEventCount ?? 0,
        participantOpenBoxCount: participantBlockers?.participantOpenBoxCount ?? 0,
        openRepackBoxCount: boxBlockers?.openRepackBoxCount ?? 0,
        unresolvedPrintBoxCount: boxBlockers?.unresolvedPrintBoxCount ?? 0,
      },
    };
  }

  async create(
    tenantId: string,
    actorUserId: string,
    input: CreateInventoryDto,
  ): Promise<InventoryDto> {
    this.assertDateRange(input.productionDateFrom, input.productionDateTo);
    const inventoryId = randomUUID();

    await this.db.transaction(async (tx) => {
      const [tenant] = await tx
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.id, tenantId))
        .for("update");
      if (!tenant) throw new NotFoundException();

      const resolved = await this.resolveParameters(tx, tenantId, {
        ...input,
        boxLabelTemplateId: input.boxLabelTemplateId ?? null,
      });
      const [sequence] = await tx
        .select({
          last: sql<number>`coalesce(max(case
            when ${schema.inventories.number} ~ '^ИНВ-[0-9]+$'
            then substring(${schema.inventories.number} from 5)::integer
            else null
          end), 0)::integer`,
        })
        .from(schema.inventories)
        .where(eq(schema.inventories.tenantId, tenantId));
      const next = Number(sequence?.last ?? 0) + 1;
      const number = `ИНВ-${String(next).padStart(5, "0")}`;

      await tx.insert(schema.inventories).values({
        id: inventoryId,
        tenantId,
        number,
        productId: resolved.productId,
        gtin14Snapshot: resolved.gtin14,
        lineId: resolved.lineId,
        mode: resolved.mode,
        productionDateFrom: resolved.productionDateFrom,
        productionDateTo: resolved.productionDateTo,
        boxLabelTemplateId: resolved.boxLabelTemplateId,
        createdByUserId: actorUserId,
      });
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: tenantId,
        actorUserId,
        action: "inventory.created",
        outcome: "success",
        targetType: "inventory",
        targetId: inventoryId,
        after: {
          tenantId,
          actorUserId,
          inventoryId,
          number,
          productId: resolved.productId,
          gtin14: resolved.gtin14,
          lineId: resolved.lineId,
          mode: resolved.mode,
          productionDateFrom: resolved.productionDateFrom,
          productionDateTo: resolved.productionDateTo,
          boxLabelTemplateId: resolved.boxLabelTemplateId,
        },
      });
    });

    return this.get(tenantId, inventoryId);
  }

  async update(
    tenantId: string,
    actorUserId: string,
    id: string,
    patch: UpdateInventoryDto,
  ): Promise<InventoryDto> {
    await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select({
          id: schema.inventories.id,
          productId: schema.inventories.productId,
          lineId: schema.inventories.lineId,
          mode: schema.inventories.mode,
          productionDateFrom: schema.inventories.productionDateFrom,
          productionDateTo: schema.inventories.productionDateTo,
          gtin14Snapshot: schema.inventories.gtin14Snapshot,
          boxLabelTemplateId: schema.inventories.boxLabelTemplateId,
          status: schema.inventories.status,
        })
        .from(schema.inventories)
        .where(and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, id)))
        .for("update");
      if (!current) throw new NotFoundException();
      this.assertMutable(current.status);

      const desiredMode = patch.mode ?? current.mode;
      const desired = {
        productId: patch.productId ?? current.productId,
        lineId: patch.lineId ?? current.lineId,
        mode: desiredMode,
        productionDateFrom: patch.productionDateFrom ?? current.productionDateFrom,
        productionDateTo: patch.productionDateTo ?? current.productionDateTo,
        boxLabelTemplateId:
          patch.boxLabelTemplateId !== undefined
            ? patch.boxLabelTemplateId
            : desiredMode === "check"
              ? null
              : current.boxLabelTemplateId,
      };
      this.assertDateRange(desired.productionDateFrom, desired.productionDateTo);
      const resolved = await this.resolveParameters(tx, tenantId, desired);
      const updatedAt = new Date();
      await tx
        .update(schema.inventories)
        .set({
          productId: resolved.productId,
          gtin14Snapshot: resolved.gtin14,
          lineId: resolved.lineId,
          mode: resolved.mode,
          productionDateFrom: resolved.productionDateFrom,
          productionDateTo: resolved.productionDateTo,
          boxLabelTemplateId: resolved.boxLabelTemplateId,
          updatedAt,
        })
        .where(and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, id)));
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: tenantId,
        actorUserId,
        action: "inventory.updated",
        outcome: "success",
        targetType: "inventory",
        targetId: id,
        before: {
          productId: current.productId,
          gtin14: current.gtin14Snapshot,
          lineId: current.lineId,
          mode: current.mode,
          productionDateFrom: current.productionDateFrom,
          productionDateTo: current.productionDateTo,
          boxLabelTemplateId: current.boxLabelTemplateId,
        },
        after: {
          tenantId,
          actorUserId,
          inventoryId: id,
          productId: resolved.productId,
          gtin14: resolved.gtin14,
          lineId: resolved.lineId,
          mode: resolved.mode,
          productionDateFrom: resolved.productionDateFrom,
          productionDateTo: resolved.productionDateTo,
          boxLabelTemplateId: resolved.boxLabelTemplateId,
        },
      });
    });
    return this.get(tenantId, id);
  }

  async importEvidence(
    tenantId: string,
    actorUserId: string,
    inventoryId: string,
    declaredStatus: InventoryChzStatus,
    file: InventoryImportFile,
  ): Promise<InventoryImportDto> {
    const sha256 = createHash("sha256").update(file.bytes).digest("hex");
    const importId = randomUUID();
    const publication: { current: PublishedAttempt | null } = { current: null };

    try {
      const [preflightInventory] = await this.db
        .select({
          id: schema.inventories.id,
          productId: schema.inventories.productId,
          status: schema.inventories.status,
        })
        .from(schema.inventories)
        .where(
          and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)),
        );
      if (!preflightInventory) throw new NotFoundException();
      this.assertMutable(preflightInventory.status);

      const preflightExisting = await this.findImportRow(
        this.db,
        tenantId,
        inventoryId,
        declaredStatus,
        sha256,
      );
      if (preflightExisting) {
        return this.importDtoWithStoredDiagnostic(this.db, preflightExisting);
      }
      const containerKind = this.containerKind(file.originalName);

      const [preflightProduct] = await this.db
        .select({ gtin14: schema.products.gtin14, status: schema.products.status })
        .from(schema.products)
        .where(
          and(
            eq(schema.products.tenantId, tenantId),
            eq(schema.products.id, preflightInventory.productId),
          ),
        );
      if (!preflightProduct || preflightProduct.status !== "active") {
        throw new UnprocessableEntityException({ code: "INVENTORY_PRODUCT_INACTIVE" });
      }

      const objectKey = this.importObjectKey(
        tenantId,
        inventoryId,
        declaredStatus,
        sha256,
        containerKind,
      );
      publication.current = { tenantId, inventoryId, importId, objectKey };
      const verified = await this.storage.putVerified(objectKey, file.bytes, file.mimeType, sha256);

      let parsedStatus: InventoryChzStatus | null;
      let includedGtin14: string | null;
      let result: "succeeded" | "failed" = "succeeded";
      let rowCount = 0;
      let duplicateCount = 0;
      let errorCode: string | null = null;
      let errorRowNumber: number | undefined;
      try {
        const parsed = parseChzImport({
          filename: file.originalName,
          mimeType: file.mimeType,
          bytes: file.bytes,
          expectedStatus: declaredStatus,
          expectedGtin14: preflightProduct.gtin14,
        });
        parsedStatus = parsed.filter.status;
        includedGtin14 = parsed.filter.includedGtin14;
        rowCount = parsed.rows.length;
        duplicateCount = rowCount - new Set(parsed.rows.map((row) => row.codeHash)).size;
      } catch (error) {
        if (!(error instanceof ChzImportError)) throw error;
        result = "failed";
        errorCode = error.code;
        errorRowNumber = error.rowNumber;
        parsedStatus = error.parsedStatus ?? null;
        includedGtin14 = error.includedGtin14 ?? null;
      }

      return await this.db.transaction(async (tx) => {
        const [inventory] = await tx
          .select({
            id: schema.inventories.id,
            productId: schema.inventories.productId,
            status: schema.inventories.status,
          })
          .from(schema.inventories)
          .where(
            and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)),
          )
          .for("update");
        if (!inventory) throw new NotFoundException();
        this.assertMutable(inventory.status);

        const existing = await this.findImportRow(
          tx,
          tenantId,
          inventoryId,
          declaredStatus,
          sha256,
        );
        if (existing) return this.importDtoWithStoredDiagnostic(tx, existing);

        const [product] = await tx
          .select({ gtin14: schema.products.gtin14, status: schema.products.status })
          .from(schema.products)
          .where(
            and(
              eq(schema.products.tenantId, tenantId),
              eq(schema.products.id, inventory.productId),
            ),
          )
          .for("share");
        if (!product || product.status !== "active") {
          throw new UnprocessableEntityException({ code: "INVENTORY_PRODUCT_INACTIVE" });
        }
        if (product.gtin14 !== preflightProduct.gtin14) {
          throw new ConflictException({ code: "INVENTORY_PRODUCT_GTIN_CHANGED" });
        }

        await tx.insert(schema.inventoryImports).values({
          id: importId,
          tenantId,
          inventoryId,
          declaredStatus,
          fileName: this.boundedFileName(file.originalName),
          containerKind,
          byteSize: verified.byteSize,
          sha256: verified.sha256,
          objectKey,
          parsedStatus,
          includedGtin14,
          parseOutcome: result,
          rowCount,
          errorCount: result === "failed" ? 1 : 0,
          duplicateCount,
          errorCode,
          createdByUserId: actorUserId,
        });
        if (inventory.status === "draft") {
          await tx
            .update(schema.inventories)
            .set({ status: "preparing", updatedAt: new Date() })
            .where(
              and(
                eq(schema.inventories.tenantId, tenantId),
                eq(schema.inventories.id, inventoryId),
                eq(schema.inventories.status, "draft"),
              ),
            );
        }
        await tx.insert(schema.tenantAuditEvents).values({
          organizationId: tenantId,
          actorUserId,
          action: "inventory.import.processed",
          outcome: result === "succeeded" ? "success" : "failure",
          targetType: "inventory_import",
          targetId: importId,
          after: {
            tenantId,
            actorUserId,
            inventoryId,
            importId,
            result,
            declaredStatus,
            parsedStatus,
            includedGtin14,
            rowCount,
            errorCount: result === "failed" ? 1 : 0,
            duplicateCount,
            sha256,
            ...(errorCode === null ? {} : { errorCode }),
            ...(errorRowNumber === undefined ? {} : { errorRowNumber }),
          },
        });

        return this.toImportDto(
          {
            id: importId,
            tenantId,
            inventoryId,
            declaredStatus,
            fileName: this.boundedFileName(file.originalName),
            containerKind,
            byteSize: verified.byteSize,
            sha256,
            objectKey,
            parsedStatus,
            includedGtin14,
            parseOutcome: result,
            rowCount,
            errorCount: result === "failed" ? 1 : 0,
            duplicateCount,
            errorCode,
            createdByUserId: actorUserId,
            createdAt: new Date(),
            parsedAt: new Date(),
          },
          errorRowNumber,
        );
      });
    } catch (error) {
      const published = publication.current;
      if (published === null) throw error;
      let committed: InventoryImportDto | null;
      try {
        committed = await this.findCommittedPublishedAttempt(published);
      } catch {
        this.logger.error(
          `Could not reconcile inventory import publication for tenant ${tenantId}, inventory ${inventoryId}`,
        );
        throw error;
      }
      if (committed !== null) return committed;
      try {
        await this.storage.delete(published.objectKey);
      } catch {
        this.logger.error(
          `Could not clean unpublished inventory evidence for tenant ${tenantId}, inventory ${inventoryId}`,
        );
      }
      throw error;
    }
  }

  fixSnapshot(
    tenantId: string,
    actorUserId: string,
    inventoryId: string,
    input: FixInventorySnapshotDto,
  ): Promise<InventorySnapshotDto> {
    return this.snapshots.fix(tenantId, actorUserId, inventoryId, input);
  }

  private async resolveParameters(
    tx: InventoryTx,
    tenantId: string,
    input: {
      productId: string;
      lineId: string;
      mode: InventoryMode;
      productionDateFrom: string;
      productionDateTo: string;
      boxLabelTemplateId: string | null;
    },
  ) {
    const [product] = await tx
      .select({ gtin14: schema.products.gtin14, status: schema.products.status })
      .from(schema.products)
      .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.id, input.productId)))
      .for("share");
    if (!product) throw new BadRequestException({ code: "INVENTORY_PRODUCT_INVALID" });
    if (product.status !== "active") {
      throw new UnprocessableEntityException({ code: "INVENTORY_PRODUCT_INACTIVE" });
    }

    const [line] = await tx
      .select({ id: schema.lines.id })
      .from(schema.lines)
      .where(and(eq(schema.lines.tenantId, tenantId), eq(schema.lines.id, input.lineId)))
      .for("share");
    if (!line) throw new BadRequestException({ code: "INVENTORY_LINE_INVALID" });

    if (input.mode === "check" && input.boxLabelTemplateId !== null) {
      throw new UnprocessableEntityException({
        code: "INVENTORY_BOX_LABEL_TEMPLATE_FORBIDDEN",
      });
    }

    if (input.mode === "repack" && input.boxLabelTemplateId === null) {
      throw new UnprocessableEntityException({
        code: "INVENTORY_BOX_LABEL_TEMPLATE_REQUIRED",
      });
    }

    if (input.boxLabelTemplateId !== null) {
      const [template] = await tx
        .select({ id: schema.labelTemplates.id })
        .from(schema.labelTemplates)
        .where(
          and(
            eq(schema.labelTemplates.tenantId, tenantId),
            eq(schema.labelTemplates.id, input.boxLabelTemplateId),
          ),
        )
        .for("share");
      if (!template) {
        throw new UnprocessableEntityException({
          code: "INVENTORY_BOX_LABEL_TEMPLATE_INVALID",
        });
      }
    }

    return {
      ...input,
      gtin14: product.gtin14,
    };
  }

  private assertDateRange(from: string, to: string): void {
    if (from > to) throw new BadRequestException({ code: "INVENTORY_DATE_RANGE_INVALID" });
  }

  private assertMutable(status: InventoryLifecycleStatus): void {
    if (!MUTABLE_INVENTORY_STATUSES.has(status)) {
      throw new ConflictException({ code: "INVENTORY_NOT_EDITABLE" });
    }
  }

  private containerKind(filename: string): ChzContainerKind {
    const lower = filename.toLowerCase();
    if (lower.endsWith(".csv")) return "csv";
    if (lower.endsWith(".zip")) return "zip";
    if (lower.endsWith(".xlsx")) return "xlsx";
    throw new UnsupportedMediaTypeException({ code: "CHZ_UNSUPPORTED_CONTAINER" });
  }

  private boundedFileName(filename: string): string {
    const bounded = filename.slice(0, 512);
    return bounded.length > 0 ? bounded : "inventory-upload";
  }

  private importObjectKey(
    tenantId: string,
    inventoryId: string,
    status: InventoryChzStatus,
    sha256: string,
    containerKind: ChzContainerKind,
  ): string {
    return `tenants/${tenantId}/inventories/${inventoryId}/imports/${status}/${sha256}.${containerKind}`;
  }

  private findImportRow(
    db: Pick<InventoryTx, "select">,
    tenantId: string,
    inventoryId: string,
    status: InventoryChzStatus,
    sha256: string,
  ): Promise<InventoryImport | undefined> {
    return db
      .select()
      .from(schema.inventoryImports)
      .where(
        and(
          eq(schema.inventoryImports.tenantId, tenantId),
          eq(schema.inventoryImports.inventoryId, inventoryId),
          eq(schema.inventoryImports.declaredStatus, status),
          eq(schema.inventoryImports.sha256, sha256),
        ),
      )
      .orderBy(desc(schema.inventoryImports.createdAt), desc(schema.inventoryImports.id))
      .limit(1)
      .then(([row]) => row);
  }

  private async importDtoWithStoredDiagnostic(
    db: Pick<InventoryTx, "select">,
    row: InventoryImport,
  ): Promise<InventoryImportDto> {
    if (row.errorCode === null) return this.toImportDto(row);
    const [audit] = await db
      .select({ after: schema.tenantAuditEvents.after })
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, row.tenantId),
          eq(schema.tenantAuditEvents.targetType, "inventory_import"),
          eq(schema.tenantAuditEvents.targetId, row.id),
          eq(schema.tenantAuditEvents.action, "inventory.import.processed"),
        ),
      )
      .orderBy(desc(schema.tenantAuditEvents.createdAt))
      .limit(1);
    return this.toImportDto(row, this.errorRowNumber(audit?.after));
  }

  private async findCommittedPublishedAttempt(
    attempt: PublishedAttempt,
  ): Promise<InventoryImportDto | null> {
    const [row] = await this.db
      .select()
      .from(schema.inventoryImports)
      .where(
        and(
          eq(schema.inventoryImports.tenantId, attempt.tenantId),
          eq(schema.inventoryImports.inventoryId, attempt.inventoryId),
          eq(schema.inventoryImports.id, attempt.importId),
          eq(schema.inventoryImports.objectKey, attempt.objectKey),
        ),
      )
      .limit(1);
    return row ? this.importDtoWithStoredDiagnostic(this.db, row) : null;
  }

  private errorRowNumber(metadata: unknown): number | undefined {
    if (!this.isUnknownRecord(metadata)) return undefined;
    const value = metadata.errorRowNumber;
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
  }

  private isUnknownRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  private toImportDto(row: InventoryImport, errorRowNumber?: number): InventoryImportDto {
    return {
      id: row.id,
      declaredStatus: row.declaredStatus,
      parsedStatus: row.parsedStatus,
      result: row.parseOutcome,
      rowCount: row.rowCount,
      errorCount: row.errorCount,
      duplicateCount: row.duplicateCount,
      sha256: row.sha256,
      diagnostics:
        row.errorCode === null
          ? []
          : [
              {
                code: row.errorCode,
                ...(errorRowNumber === undefined ? {} : { rowNumber: errorRowNumber }),
              },
            ],
    };
  }

  private toInventoryDto(row: InventoryJoinedRow): InventoryDto {
    return {
      id: row.id,
      number: row.number,
      status: row.status,
      mode: row.mode,
      productId: row.productId,
      gtin14: row.gtin14,
      productName: row.productName,
      lineId: row.lineId,
      lineName: row.lineName,
      productionDateFrom: row.productionDateFrom,
      productionDateTo: row.productionDateTo,
      boxLabelTemplateId: row.boxLabelTemplateId,
      boxLabelTemplate:
        row.boxLabelTemplateId === null || row.boxLabelTemplateName === null
          ? null
          : { id: row.boxLabelTemplateId, name: row.boxLabelTemplateName },
      activeSnapshotId: row.activeSnapshotId,
      resultRevision: row.resultRevision,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

export type { InventoryImportFile };
