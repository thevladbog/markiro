import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { and, desc, eq, gte, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { formatShiftNumber, shiftMonthKey } from "@markiro/domain";
import type { LabelTemplateSpec } from "@markiro/domain";
import { DB } from "../../auth/auth.module";
import { OperatorsService } from "../operators/operators.service";
import type { ProductImageDescriptor } from "../products/dto";
import {
  BOX_EXTENSION_DIGIT,
  SsccCapacityExhaustedException,
  SsccService,
} from "../sscc/sscc.service";
import type {
  BoxTemplateResolution,
  CloseShiftDto,
  CreateShiftDto,
  ListShiftsQueryDto,
  ListShiftsResponseDto,
  ShiftBoxLabelTemplateOptionDto,
  ShiftBoxLabelTemplatesDto,
  ShiftBundleDto,
  ShiftDto,
  ShiftMode,
  ShiftOrigin,
  ShiftPlanningConfigDto,
  ShiftReferenceBundleDto,
  UpdateShiftDto,
} from "./dto";
import { EntitlementsService } from "../../subscriptions/entitlements.service";
import { SubscriptionReadOnlyException } from "../../subscriptions/subscription-errors";

type ShiftRow = typeof schema.shifts.$inferSelect;
type CurrentShiftRow = Omit<ShiftRow, "labelTemplateId">;
type ProductRow = Omit<typeof schema.products.$inferSelect, "defaultLabelTemplateId"> & {
  productGroupName: string | null;
};
type JoinedShiftRow = Omit<ShiftDto, "image" | "number"> & {
  numberMonthKey: string;
  numberSeq: number;
  imageChecksum: string | null;
  imageByteSize: number | null;
  imageWidth: number | null;
  imageHeight: number | null;
  stationClosePolicy: "single_device" | "admin_only";
  stationCloseOwnerDeviceId: string | null;
};
export type EffectiveListShiftsQuery = ListShiftsQueryDto & { includeUnassigned?: boolean };

type ProductionDateChange = {
  before: string | null;
  after: string | null;
};

type ProductionDateAuditReason =
  "changed" | "box_already_closed" | "shift_closed" | "status_changed";

type ShiftUpdateTransactionResult =
  | { kind: "updated"; id: string }
  | { kind: "not_found" }
  | {
      kind: "conflict";
      response: string | { code: "PRODUCTION_DATE_LOCKED"; message: string };
    };

const CURRENT_SHIFT_STORAGE_SELECTION = {
  id: schema.shifts.id,
  tenantId: schema.shifts.tenantId,
  status: schema.shifts.status,
  mode: schema.shifts.mode,
  productId: schema.shifts.productId,
  lineId: schema.shifts.lineId,
  counterpartyId: schema.shifts.counterpartyId,
  ssccIssuerCounterpartyId: schema.shifts.ssccIssuerCounterpartyId,
  boxLabelTemplateId: schema.shifts.boxLabelTemplateId,
  plannedQty: schema.shifts.plannedQty,
  plannedDate: schema.shifts.plannedDate,
  productionDate: schema.shifts.productionDate,
  firstBoxClosureAt: schema.shifts.firstBoxClosureAt,
  boxCapacity: schema.shifts.boxCapacity,
  palletCapacity: schema.shifts.palletCapacity,
  palletsEnabled: schema.shifts.palletsEnabled,
  createdFrom: schema.shifts.createdFrom,
  stationClosePolicy: schema.shifts.stationClosePolicy,
  stationCloseOwnerDeviceId: schema.shifts.stationCloseOwnerDeviceId,
  openedAt: schema.shifts.openedAt,
  closedAt: schema.shifts.closedAt,
  closeReason: schema.shifts.closeReason,
  lateDataAt: schema.shifts.lateDataAt,
  createdAt: schema.shifts.createdAt,
  numberMonthKey: schema.shifts.numberMonthKey,
  numberSeq: schema.shifts.numberSeq,
};

const CURRENT_PRODUCT_SELECTION = {
  id: schema.products.id,
  tenantId: schema.products.tenantId,
  gtin14: schema.products.gtin14,
  name: schema.products.name,
  printName: schema.products.printName,
  chzProductGroupCode: schema.products.chzProductGroupCode,
  productGroupName: schema.chzProductGroups.name,
  boxCapacity: schema.products.boxCapacity,
  palletCapacity: schema.products.palletCapacity,
  status: schema.products.status,
  archived: schema.products.archived,
  defaultCounterpartyId: schema.products.defaultCounterpartyId,
  unitPrice: schema.products.unitPrice,
  egaisCode: schema.products.egaisCode,
  shelfLifeDays: schema.products.shelfLifeDays,
  externalRef: schema.products.externalRef,
  createdAt: schema.products.createdAt,
};

/**
 * One block must outlast a shift even if the network drops at the worst
 * moment. Ten million serials per extension digit make generosity free, and
 * a burnt serial costs nothing — SSCCs need not be contiguous.
 */
const BOX_BLOCK_SIZE = 2000;

@Injectable()
export class ShiftsService {
  private readonly logger = new Logger(ShiftsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly operatorsService: OperatorsService,
    private readonly sscc: SsccService,
    private readonly entitlements: EntitlementsService,
  ) {}

  /** List a tenant's shifts, joined with product/line/counterparty names. */
  async listShifts(
    tenantId: string,
    query: EffectiveListShiftsQuery,
  ): Promise<ListShiftsResponseDto> {
    const conditions = [eq(schema.shifts.tenantId, tenantId)];

    if (query.status) conditions.push(eq(schema.shifts.status, query.status));
    if (query.lineId) {
      const lineCondition = query.includeUnassigned
        ? or(eq(schema.shifts.lineId, query.lineId), isNull(schema.shifts.lineId))
        : eq(schema.shifts.lineId, query.lineId);
      if (lineCondition) conditions.push(lineCondition);
    }
    if (query.from) conditions.push(gte(schema.shifts.plannedDate, query.from));
    if (query.to) conditions.push(lte(schema.shifts.plannedDate, query.to));
    // The effective production day -- same fallback the shift exports use
    // (`shift-export-source.service.ts`): explicit productionDate, else
    // plannedDate. A shift with neither simply never matches.
    const effectiveProductionDate = sql`coalesce(${schema.shifts.productionDate}, ${schema.shifts.plannedDate})`;
    if (query.productionFrom)
      conditions.push(sql`${effectiveProductionDate} >= ${query.productionFrom}`);
    if (query.productionTo)
      conditions.push(sql`${effectiveProductionDate} <= ${query.productionTo}`);

    const rows = await this.db
      .select(this.joinedSelection())
      .from(schema.shifts)
      .leftJoin(schema.products, eq(schema.shifts.productId, schema.products.id))
      .leftJoin(
        schema.productImages,
        and(
          eq(schema.productImages.tenantId, schema.shifts.tenantId),
          eq(schema.productImages.productId, schema.shifts.productId),
        ),
      )
      .leftJoin(
        schema.mediaAssets,
        and(
          eq(schema.mediaAssets.id, schema.productImages.assetId),
          eq(schema.mediaAssets.ownerTenantId, tenantId),
          eq(schema.mediaAssets.status, "active"),
        ),
      )
      .leftJoin(schema.lines, eq(schema.shifts.lineId, schema.lines.id))
      .leftJoin(schema.counterparties, eq(schema.shifts.counterpartyId, schema.counterparties.id))
      .where(and(...conditions))
      .orderBy(
        sql`coalesce(${schema.shifts.plannedDate}, ${schema.shifts.createdAt}::date) desc`,
        desc(schema.shifts.createdAt),
      );

    return { items: rows.map((row) => this.mapShiftRow(row)) };
  }

  /** The one organisation setting needed by operations shift planning. */
  async getPlanningConfig(tenantId: string): Promise<ShiftPlanningConfigDto> {
    return { defaultBoxLabelTemplateId: await this.findDefaultBoxLabelTemplateId(tenantId) };
  }

  async listBoxLabelTemplates(tenantId: string): Promise<ShiftBoxLabelTemplatesDto> {
    const defaultBoxLabelTemplateId = await this.findDefaultBoxLabelTemplateId(tenantId);
    const rows = await this.db
      .select({
        id: schema.labelTemplates.id,
        name: schema.labelTemplates.name,
        spec: schema.labelTemplates.spec,
      })
      .from(schema.labelTemplates)
      .where(eq(schema.labelTemplates.tenantId, tenantId))
      .orderBy(schema.labelTemplates.name, schema.labelTemplates.id);
    const items = rows.map((row): ShiftBoxLabelTemplateOptionDto => {
      const spec = row.spec as LabelTemplateSpec;
      return {
        id: row.id,
        name: row.name,
        widthMm: spec.widthMm,
        heightMm: spec.heightMm,
        dpi: spec.dpi,
        language: spec.language,
      };
    });
    // Default first so the preselected option is on the station's first page.
    items.sort((a, b) =>
      a.id === defaultBoxLabelTemplateId ? -1 : b.id === defaultBoxLabelTemplateId ? 1 : 0,
    );
    return { items, defaultBoxLabelTemplateId };
  }

  /** Get a single shift (joined), must belong to the tenant. */
  async getShift(tenantId: string, id: string): Promise<ShiftDto> {
    const [row] = await this.db
      .select(this.joinedSelection())
      .from(schema.shifts)
      .leftJoin(schema.products, eq(schema.shifts.productId, schema.products.id))
      .leftJoin(
        schema.productImages,
        and(
          eq(schema.productImages.tenantId, schema.shifts.tenantId),
          eq(schema.productImages.productId, schema.shifts.productId),
        ),
      )
      .leftJoin(
        schema.mediaAssets,
        and(
          eq(schema.mediaAssets.id, schema.productImages.assetId),
          eq(schema.mediaAssets.ownerTenantId, tenantId),
          eq(schema.mediaAssets.status, "active"),
        ),
      )
      .leftJoin(schema.lines, eq(schema.shifts.lineId, schema.lines.id))
      .leftJoin(schema.counterparties, eq(schema.shifts.counterpartyId, schema.counterparties.id))
      .where(and(eq(schema.shifts.tenantId, tenantId), eq(schema.shifts.id, id)));

    if (!row) {
      throw new NotFoundException();
    }
    return this.mapShiftRow(row);
  }

  /**
   * Create a shift. `boxCapacity`/`palletCapacity`/`counterpartyId` default
   * from the product when omitted (`undefined`); explicit null opts out.
   * Draft products are rejected outright (422).
   */
  async createShift(
    tenantId: string,
    data: CreateShiftDto,
    createdFrom: ShiftOrigin = "admin",
  ): Promise<ShiftDto> {
    if (data.palletsEnabled === true) {
      await this.entitlements.assertFeatureAccess(tenantId, "pallets");
    }
    const product = await this.findProductRow(tenantId, data.productId);
    if (!product) {
      throw new BadRequestException("Unknown product for this organization");
    }
    if (product.status === "draft") {
      throw new UnprocessableEntityException("Product card is incomplete");
    }
    if (product.archived) {
      throw new UnprocessableEntityException("Product is marked as not in use");
    }

    const boxCapacity = data.boxCapacity !== undefined ? data.boxCapacity : product.boxCapacity;
    const palletCapacity =
      data.palletCapacity !== undefined ? data.palletCapacity : product.palletCapacity;
    const counterpartyId =
      data.counterpartyId !== undefined ? data.counterpartyId : product.defaultCounterpartyId;
    const boxLabelTemplateId =
      data.boxLabelTemplateId !== undefined
        ? data.boxLabelTemplateId
        : await this.findDefaultBoxLabelTemplateId(tenantId);
    const palletsEnabled = data.palletsEnabled ?? false;

    this.assertCapacityRules(data.mode, boxCapacity, palletsEnabled, palletCapacity);
    this.assertBoxTemplateRule(data.mode, boxLabelTemplateId);

    const monthKey = shiftMonthKey(data.plannedDate ?? new Date().toISOString().slice(0, 10));

    try {
      const [row] = await this.db.transaction(async (tx) => {
        const [counter] = await tx
          .insert(schema.shiftNumberCounters)
          .values({ tenantId, monthKey, lastSeq: 1 })
          .onConflictDoUpdate({
            target: [schema.shiftNumberCounters.tenantId, schema.shiftNumberCounters.monthKey],
            set: { lastSeq: sql`${schema.shiftNumberCounters.lastSeq} + 1` },
          })
          .returning({ lastSeq: schema.shiftNumberCounters.lastSeq });
        if (!counter) {
          throw new InternalServerErrorException("Failed to allocate a shift number");
        }
        return tx
          .insert(schema.shifts)
          .values({
            tenantId,
            productId: data.productId,
            lineId: data.lineId ?? null,
            counterpartyId: counterpartyId ?? null,
            // The issuer is always explicit (unlike the org-defaulted box
            // template resolved above), so an omitted value is null ("our
            // organisation").
            ssccIssuerCounterpartyId: data.ssccIssuerCounterpartyId ?? null,
            boxLabelTemplateId,
            mode: data.mode,
            plannedQty: data.plannedQty ?? null,
            plannedDate: data.plannedDate ?? null,
            productionDate: data.productionDate ?? null,
            boxCapacity: boxCapacity ?? null,
            palletCapacity: palletCapacity ?? null,
            palletsEnabled,
            createdFrom,
            numberMonthKey: monthKey,
            numberSeq: counter.lastSeq,
          })
          .returning({ id: schema.shifts.id });
      });

      if (!row) {
        throw new InternalServerErrorException("Failed to create shift");
      }
      return this.getShift(tenantId, row.id);
    } catch (error) {
      this.handleWriteError(error);
    }
  }

  /**
   * Planned shifts accept the full planning patch. Active shifts accept only
   * administrative metadata plus the box-label template; changing mode,
   * product-derived rules, or other print semantics after stations have
   * mirrored a bundle would split the line across incompatible local state.
   */
  async updateShift(
    tenantId: string,
    actorUserId: string,
    id: string,
    data: UpdateShiftDto,
  ): Promise<ShiftDto> {
    const preflightCurrent = await this.findRow(tenantId, id);
    if (!preflightCurrent) {
      throw new NotFoundException();
    }
    const preflightProductionDateChange: ProductionDateChange | null =
      data.productionDate !== undefined && data.productionDate !== preflightCurrent.productionDate
        ? { before: preflightCurrent.productionDate, after: data.productionDate }
        : null;
    if (
      preflightCurrent.status !== "closed" &&
      data.productionDate !== undefined &&
      preflightProductionDateChange === null &&
      Object.keys(data).length === 1
    ) {
      return this.getShift(tenantId, id);
    }
    if (
      preflightCurrent.status === "planned" &&
      (data.palletsEnabled === true || data.palletCapacity !== undefined)
    ) {
      await this.entitlements.assertFeatureAccess(tenantId, "pallets");
    }

    let result: ShiftUpdateTransactionResult;
    try {
      result = await this.db.transaction(async (tx): Promise<ShiftUpdateTransactionResult> => {
        // Station closure ingest acquires these same tenant-scoped shift-row
        // locks (sorted by shift id for multi-shift batches) before updating
        // boxes. Holding this row through the historical-box read and shift
        // update makes "first closure wins" linearizable in both directions.
        const [current] = await tx
          .select(CURRENT_SHIFT_STORAGE_SELECTION)
          .from(schema.shifts)
          .where(and(eq(schema.shifts.tenantId, tenantId), eq(schema.shifts.id, id)))
          .for("update");
        if (!current) return { kind: "not_found" };

        const productionDateChange: ProductionDateChange | null =
          data.productionDate !== undefined && data.productionDate !== current.productionDate
            ? { before: current.productionDate, after: data.productionDate }
            : null;

        if (current.status === "closed") {
          if (productionDateChange) {
            await this.writeProductionDateAudit(tx, {
              tenantId,
              actorUserId,
              shiftId: id,
              ...productionDateChange,
              outcome: "failure",
              reason: "shift_closed",
            });
          }
          return { kind: "conflict", response: "Closed shifts cannot be edited" };
        }

        if (
          data.productionDate !== undefined &&
          productionDateChange === null &&
          Object.keys(data).length === 1
        ) {
          return { kind: "updated", id };
        }

        if (productionDateChange) {
          // New ingests set `firstBoxClosureAt` even when an accepted
          // physical closure has no matching box row. The historical box
          // lookup remains for closures accepted before that marker existed.
          let closedBox: { id: string } | undefined;
          if (current.firstBoxClosureAt === null) {
            [closedBox] = await tx
              .select({ id: schema.boxes.id })
              .from(schema.boxes)
              .where(
                and(
                  eq(schema.boxes.tenantId, tenantId),
                  eq(schema.boxes.shiftId, id),
                  isNotNull(schema.boxes.closedAt),
                ),
              )
              .limit(1);
          }
          if (current.firstBoxClosureAt !== null || closedBox) {
            await this.writeProductionDateAudit(tx, {
              tenantId,
              actorUserId,
              shiftId: id,
              ...productionDateChange,
              outcome: "failure",
              reason: "box_already_closed",
            });
            return {
              kind: "conflict",
              response: {
                code: "PRODUCTION_DATE_LOCKED",
                message: "Production date cannot change after the first box closure",
              },
            };
          }
        }

        if (current.status === "active") {
          const allowedFields = new Set<keyof UpdateShiftDto>([
            "lineId",
            "plannedQty",
            "plannedDate",
            "productionDate",
            "boxLabelTemplateId",
          ]);
          const forbiddenField = (Object.keys(data) as (keyof UpdateShiftDto)[]).find(
            (field) => !allowedFields.has(field),
          );
          if (forbiddenField) {
            throw new ConflictException(
              `Active shift field cannot be edited: ${String(forbiddenField)}`,
            );
          }

          const changes: Partial<
            Pick<
              ShiftRow,
              "lineId" | "plannedQty" | "plannedDate" | "productionDate" | "boxLabelTemplateId"
            >
          > = {};
          if (data.lineId !== undefined) changes.lineId = data.lineId;
          if (data.plannedQty !== undefined) changes.plannedQty = data.plannedQty;
          if (data.plannedDate !== undefined) changes.plannedDate = data.plannedDate;
          if (productionDateChange) changes.productionDate = productionDateChange.after;
          if (data.boxLabelTemplateId !== undefined) {
            changes.boxLabelTemplateId = data.boxLabelTemplateId;
          }
          if (Object.keys(changes).length === 0) return { kind: "updated", id };

          const [updated] = await tx
            .update(schema.shifts)
            .set(changes)
            .where(
              and(
                eq(schema.shifts.tenantId, tenantId),
                eq(schema.shifts.id, id),
                eq(schema.shifts.status, "active"),
              ),
            )
            .returning({ id: schema.shifts.id });
          if (!updated) {
            if (productionDateChange) {
              await this.writeProductionDateAudit(tx, {
                tenantId,
                actorUserId,
                shiftId: id,
                ...productionDateChange,
                outcome: "failure",
                reason: "status_changed",
              });
              return { kind: "conflict", response: "Shift is no longer active" };
            }
            throw new ConflictException("Shift is no longer active");
          }
          if (productionDateChange) {
            await this.writeProductionDateAudit(tx, {
              tenantId,
              actorUserId,
              shiftId: id,
              ...productionDateChange,
              outcome: "success",
              reason: "changed",
            });
          }
          return { kind: "updated", id: updated.id };
        }

        const mode = data.mode !== undefined ? data.mode : current.mode;
        const lineId = data.lineId !== undefined ? data.lineId : current.lineId;
        const counterpartyId =
          data.counterpartyId !== undefined ? data.counterpartyId : current.counterpartyId;
        const ssccIssuerCounterpartyId =
          data.ssccIssuerCounterpartyId !== undefined
            ? data.ssccIssuerCounterpartyId
            : current.ssccIssuerCounterpartyId;
        const boxLabelTemplateId =
          data.boxLabelTemplateId !== undefined
            ? data.boxLabelTemplateId
            : current.boxLabelTemplateId;
        const plannedQty = data.plannedQty !== undefined ? data.plannedQty : current.plannedQty;
        const plannedDate = data.plannedDate !== undefined ? data.plannedDate : current.plannedDate;
        const productionDate =
          data.productionDate !== undefined ? data.productionDate : current.productionDate;
        const boxCapacity = data.boxCapacity !== undefined ? data.boxCapacity : current.boxCapacity;
        const palletCapacity =
          data.palletCapacity !== undefined ? data.palletCapacity : current.palletCapacity;
        const palletsEnabled =
          data.palletsEnabled !== undefined ? data.palletsEnabled : current.palletsEnabled;

        this.assertCapacityRules(mode, boxCapacity, palletsEnabled, palletCapacity);
        this.assertBoxTemplateRule(mode, boxLabelTemplateId);

        const [updated] = await tx
          .update(schema.shifts)
          .set({
            mode,
            lineId,
            counterpartyId,
            ssccIssuerCounterpartyId,
            boxLabelTemplateId,
            plannedQty,
            plannedDate,
            productionDate,
            boxCapacity,
            palletCapacity,
            palletsEnabled,
          })
          .where(
            and(
              eq(schema.shifts.tenantId, tenantId),
              eq(schema.shifts.id, id),
              eq(schema.shifts.status, "planned"),
            ),
          )
          .returning({ id: schema.shifts.id });

        if (!updated) {
          if (productionDateChange) {
            await this.writeProductionDateAudit(tx, {
              tenantId,
              actorUserId,
              shiftId: id,
              ...productionDateChange,
              outcome: "failure",
              reason: "status_changed",
            });
            return { kind: "conflict", response: "Shift can only be edited while planned" };
          }
          throw new ConflictException("Shift can only be edited while planned");
        }
        if (productionDateChange) {
          await this.writeProductionDateAudit(tx, {
            tenantId,
            actorUserId,
            shiftId: id,
            ...productionDateChange,
            outcome: "success",
            reason: "changed",
          });
        }
        return { kind: "updated", id: updated.id };
      });
    } catch (error) {
      this.handleWriteError(error);
    }

    if (result.kind === "not_found") throw new NotFoundException();
    if (result.kind === "conflict") throw new ConflictException(result.response);
    return this.getShift(tenantId, result.id);
  }

  /** Delete a shift, allowed only while `status === "planned"` (409 otherwise). */
  async deleteShift(tenantId: string, id: string): Promise<void> {
    const current = await this.findRow(tenantId, id);
    if (!current) {
      throw new NotFoundException();
    }
    if (current.status !== "planned") {
      throw new ConflictException("Shift can only be deleted while planned");
    }

    const result = await this.db
      .delete(schema.shifts)
      .where(
        and(
          eq(schema.shifts.tenantId, tenantId),
          eq(schema.shifts.id, id),
          eq(schema.shifts.status, "planned"),
        ),
      )
      .returning({ id: schema.shifts.id });

    if (result.length === 0) {
      throw new ConflictException("Shift can only be deleted while planned");
    }
  }

  /**
   * Close a shift, allowed only from `status === "active"` (409 otherwise).
   * `reason` is validated (min 3 chars) and persisted to `close_reason`.
   */
  async closeShift(tenantId: string, id: string, data: CloseShiftDto): Promise<ShiftDto> {
    const current = await this.findRow(tenantId, id);
    if (!current) {
      throw new NotFoundException();
    }
    if (current.status !== "active") {
      throw new ConflictException("Shift can only be closed while active");
    }
    const access = await this.entitlements.resolveRecovery(tenantId);
    if (access.access === "read_only") {
      const endsAt = access.subscription?.endsAt;
      if (!endsAt || current.openedAt === null || current.openedAt >= endsAt) {
        throw new SubscriptionReadOnlyException();
      }
    }

    const [row] = await this.db
      .update(schema.shifts)
      .set({ status: "closed", closedAt: new Date(), closeReason: data.reason })
      .where(
        and(
          eq(schema.shifts.tenantId, tenantId),
          eq(schema.shifts.id, id),
          eq(schema.shifts.status, "active"),
        ),
      )
      .returning();

    if (!row) {
      throw new ConflictException("Shift can only be closed while active");
    }
    return this.getShift(tenantId, row.id);
  }

  /** Open a planned shift: planned -> active, stamps openedAt. 409 otherwise. */
  async openShift(tenantId: string, id: string, deviceId?: string): Promise<ShiftDto> {
    if (deviceId) return this.enterShift(tenantId, id, deviceId);
    const current = await this.findRow(tenantId, id);
    if (!current) throw new NotFoundException();
    if (current.status !== "planned") {
      throw new ConflictException("Shift can only be opened while planned");
    }
    if (current.palletsEnabled) {
      await this.entitlements.assertFeatureAccess(tenantId, "pallets");
    }
    const [row] = await this.db
      .update(schema.shifts)
      .set({ status: "active", openedAt: new Date() })
      .where(
        and(
          eq(schema.shifts.tenantId, tenantId),
          eq(schema.shifts.id, id),
          eq(schema.shifts.status, "planned"),
        ),
      )
      .returning();
    if (!row) throw new ConflictException("Shift can only be opened while planned");
    return this.getShift(tenantId, row.id);
  }

  /** Register a station's participation and atomically derive close authority. */
  async enterShift(tenantId: string, id: string, deviceId: string): Promise<ShiftDto> {
    await this.db.transaction(async (tx) => {
      const [device] = await tx
        .select({ id: schema.stationDevices.id })
        .from(schema.stationDevices)
        .where(
          and(
            eq(schema.stationDevices.tenantId, tenantId),
            eq(schema.stationDevices.id, deviceId),
            isNull(schema.stationDevices.revokedAt),
          ),
        )
        .for("update");
      if (!device) throw new NotFoundException("Station device not found");

      const [shift] = await tx
        .select({
          id: schema.shifts.id,
          status: schema.shifts.status,
          palletsEnabled: schema.shifts.palletsEnabled,
          stationClosePolicy: schema.shifts.stationClosePolicy,
          stationCloseOwnerDeviceId: schema.shifts.stationCloseOwnerDeviceId,
        })
        .from(schema.shifts)
        .where(and(eq(schema.shifts.tenantId, tenantId), eq(schema.shifts.id, id)))
        .for("update");
      if (!shift) throw new NotFoundException();
      if (shift.status === "closed") throw new ConflictException("Closed shifts cannot be entered");
      if (shift.status === "planned") {
        if (shift.palletsEnabled) await this.entitlements.assertFeatureAccess(tenantId, "pallets");
        await tx
          .update(schema.shifts)
          .set({ status: "active", openedAt: new Date() })
          .where(and(eq(schema.shifts.tenantId, tenantId), eq(schema.shifts.id, id)));
      }

      const now = new Date();
      await tx
        .insert(schema.shiftDeviceParticipants)
        .values({ tenantId, shiftId: id, deviceId, firstEnteredAt: now, lastEnteredAt: now })
        .onConflictDoUpdate({
          target: [
            schema.shiftDeviceParticipants.tenantId,
            schema.shiftDeviceParticipants.shiftId,
            schema.shiftDeviceParticipants.deviceId,
          ],
          set: { lastEnteredAt: now },
        });

      if (shift.stationClosePolicy === "admin_only") return;
      if (shift.stationCloseOwnerDeviceId === null) {
        await tx
          .update(schema.shifts)
          .set({ stationCloseOwnerDeviceId: deviceId, stationClosePolicy: "single_device" })
          .where(and(eq(schema.shifts.tenantId, tenantId), eq(schema.shifts.id, id)));
      } else if (shift.stationCloseOwnerDeviceId !== deviceId) {
        await tx
          .update(schema.shifts)
          .set({ stationCloseOwnerDeviceId: null, stationClosePolicy: "admin_only" })
          .where(and(eq(schema.shifts.tenantId, tenantId), eq(schema.shifts.id, id)));
      }
    });
    return this.getShift(tenantId, id);
  }

  /**
   * Everything the station downloads for a shift. `operators` is the
   * tenant's active roster, from the same `OperatorsService.buildRoster`
   * query `GET /station/operators` uses -- one method, two consumers, so the
   * initialization sync and the per-shift refresh can never drift.
   *
   * `deviceId` is the calling station device's own id (from `TenantGuard`,
   * resolved off its api-key -- see tenant.guard.ts), or `null` for a
   * session-authenticated caller (admin/manager UI browsing a shift, not a
   * device). It gates the box serial block below: `sscc_blocks.device_id`
   * carries a NOT NULL FK, so a block can only ever be cut for a real device.
   */
  async getBundle(tenantId: string, id: string, deviceId: string | null): Promise<ShiftBundleDto> {
    const referenceBundle = await this.getReferenceBundle(tenantId, id);
    const allocation =
      referenceBundle.shift.mode === "aggregation" && deviceId
        ? await this.bundleSscc(tenantId, referenceBundle.shift.id, deviceId)
        : { sscc: null, ssccRevokedFrom: [] };
    return { ...referenceBundle, ...allocation };
  }

  /**
   * Reference-only bundle for recovery. This method intentionally accepts no
   * device id and never enters `bundleSscc`, so it cannot allocate, replace,
   * or reconcile server-side SSCC state.
   */
  async getReferenceBundle(tenantId: string, id: string): Promise<ShiftReferenceBundleDto> {
    const shift = await this.getShift(tenantId, id); // 404 if cross-tenant/missing

    const productRow = await this.findProductRow(tenantId, shift.productId);
    if (!productRow) throw new NotFoundException("Shift product missing");
    const image = await this.findProductImage(tenantId, shift.productId);
    const product: ShiftBundleDto["product"] = {
      id: productRow.id,
      gtin14: productRow.gtin14,
      name: productRow.name,
      productGroup: productRow.productGroupName,
      boxCapacity: productRow.boxCapacity,
      palletCapacity: productRow.palletCapacity,
      status: productRow.status,
      archived: productRow.archived,
      defaultCounterpartyId: productRow.defaultCounterpartyId,
      defaultLabelTemplateId: null,
      unitPrice: productRow.unitPrice,
      printName: productRow.printName,
      egaisCode: productRow.egaisCode,
      shelfLifeDays: productRow.shelfLifeDays,
      externalRef: productRow.externalRef,
      createdAt: productRow.createdAt,
      image,
    };

    const boxLabelTemplate = await this.findLabelTemplate(tenantId, shift.boxLabelTemplateId);

    const bundleShift: ShiftBundleDto["shift"] = {
      id: shift.id,
      number: shift.number,
      status: shift.status,
      mode: shift.mode,
      productId: shift.productId,
      productName: shift.productName,
      productPrintName: shift.productPrintName,
      image: shift.image ?? null,
      lineId: shift.lineId,
      lineName: shift.lineName,
      counterpartyId: shift.counterpartyId,
      counterpartyName: shift.counterpartyName,
      labelTemplateId: null,
      labelTemplateName: null,
      ssccIssuerCounterpartyId: shift.ssccIssuerCounterpartyId,
      boxLabelTemplateId: shift.boxLabelTemplateId,
      plannedQty: shift.plannedQty,
      plannedDate: shift.plannedDate,
      productionDate: shift.productionDate,
      boxCapacity: shift.boxCapacity,
      palletCapacity: shift.palletCapacity,
      palletsEnabled: shift.palletsEnabled,
      createdFrom: shift.createdFrom,
      openedAt: shift.openedAt,
      closedAt: shift.closedAt,
      closeReason: shift.closeReason,
      lateDataAt: shift.lateDataAt,
      createdAt: shift.createdAt,
    };

    let counterpartyGln: string | null = null;
    if (shift.counterpartyId) {
      const [cp] = await this.db
        .select()
        .from(schema.counterparties)
        .where(
          and(
            eq(schema.counterparties.tenantId, tenantId),
            eq(schema.counterparties.id, shift.counterpartyId),
          ),
        );
      counterpartyGln = cp ? cp.gln : null;
    }

    // The tenant's active operators, hydrated into the station's
    // `operators_mirror`. Same query as GET /station/operators (one service
    // method, two consumers) so the initialization sync and the per-shift
    // refresh can never drift.
    const operators = await this.operatorsService.buildRoster(tenantId);

    return {
      shift: bundleShift,
      product,
      labelTemplate: null,
      boxLabelTemplate,
      counterpartyGln,
      operators,
      sscc: null,
      ssccRevokedFrom: [],
    };
  }

  /**
   * Resolves the box-label snapshot into the station bundle shape. Null in,
   * or a template this tenant does not own, both resolve to null.
   */
  private async findLabelTemplate(
    tenantId: string,
    templateId: string | null,
  ): Promise<{ id: string; name: string; spec: LabelTemplateSpec } | null> {
    if (!templateId) return null;
    const [lt] = await this.db
      .select()
      .from(schema.labelTemplates)
      .where(
        and(eq(schema.labelTemplates.tenantId, tenantId), eq(schema.labelTemplates.id, templateId)),
      );
    return lt ? { id: lt.id, name: lt.name, spec: lt.spec as LabelTemplateSpec } : null;
  }

  /**
   * Resolves the shift's issuer prefix and hands the device its block for
   * the bundle (a fresh one the first time it's seen for this issuer, the
   * SAME block's original bounds plus its consumed-through cursor on every
   * later fetch, or another fresh one if that one is fully consumed -- see
   * `SsccService.allocateForBundle` for why).
   *
   * `apps/station/src/lib/shift-bundle.ts` swallows a bundle download error
   * BY DESIGN, so a thrown 400 here would not just skip the serial block --
   * it would silently cost the operator the product, label template AND
   * operator roster too, with nothing anywhere explaining why. A tenant that
   * never filled in its organisation profile's GLN (that field is nullable,
   * and a tenant may have no profile row at all) must not lose its whole
   * offline mirror over it, so this degrades to `sscc: null` instead of
   * letting `resolveIssuerPrefix`'s `BadRequestException` propagate.
   * `resolveIssuerPrefix` itself must keep throwing for its OTHER callers
   * (the org-profile/counterparty settings routes need that 400 to tell an
   * admin what's wrong), so the degrade lives here, at this one call site,
   * not in the shared method.
   *
   * CodeRabbit PR33 review, Finding 4: the same reasoning extends to
   * `SsccCapacityExhaustedException` -- an entire 9-digit issuer prefix's
   * serial space being spent is exceedingly rare, but if it ever happens the
   * station must still get its product, label template and operator roster;
   * it already has a graceful "no-serials" state for a device with an empty
   * local pool (`sscc-pool.ts`'s `burnSerial` returning null), so degrading
   * to `sscc: null` here lands the device in that SAME, already-handled
   * state rather than losing the whole bundle over it.
   */
  private async bundleSscc(
    tenantId: string,
    shiftId: string,
    deviceId: string,
  ): Promise<Pick<ShiftBundleDto, "sscc" | "ssccRevokedFrom">> {
    return this.db.transaction(async (tx) => {
      const [shift] = await tx
        .select({
          status: schema.shifts.status,
          mode: schema.shifts.mode,
          openedAt: schema.shifts.openedAt,
        })
        .from(schema.shifts)
        .where(and(eq(schema.shifts.tenantId, tenantId), eq(schema.shifts.id, shiftId)))
        .for("update");
      if (!shift || shift.status !== "active" || shift.mode !== "aggregation") {
        return { sscc: null, ssccRevokedFrom: [] };
      }

      const access = await this.entitlements.resolveRecovery(tenantId, tx, new Date());
      if (access.access === "read_only") {
        const endsAt = access.subscription?.endsAt;
        if (!endsAt || !shift.openedAt || shift.openedAt >= endsAt) {
          return { sscc: null, ssccRevokedFrom: [] };
        }
      }

      let issuerPrefix: string;
      try {
        issuerPrefix = await this.sscc.resolveIssuerPrefix(tenantId, shiftId, tx);
      } catch (error) {
        if (!(error instanceof BadRequestException)) throw error;
        // The station never sees this (the bundle just comes back with
        // sscc: null, silently, by the design note above), so the server log
        // is the ONLY place this is ever visible -- it must carry enough to
        // act on: which tenant, which shift, and resolveIssuerPrefix's own
        // reason (no org GLN, or no GLN on the shift's named sscc issuer
        // counterparty).
        this.logger.warn(
          `Shift ${shiftId} (tenant ${tenantId}) bundle has no box serial block -- ${error.message}`,
        );
        return { sscc: null, ssccRevokedFrom: [] };
      }
      try {
        const sscc = await this.sscc.allocateForBundle(
          tenantId,
          issuerPrefix,
          BOX_EXTENSION_DIGIT,
          deviceId,
          BOX_BLOCK_SIZE,
          tx,
        );
        // Read AFTER allocation, in the same transaction: allocation is what
        // may have just cut the replacement for a revoked block, and the two
        // must describe one consistent moment.
        const ssccRevokedFrom = await this.sscc.revokedFromSerials(
          tenantId,
          issuerPrefix,
          BOX_EXTENSION_DIGIT,
          deviceId,
          tx,
        );
        return { sscc, ssccRevokedFrom };
      } catch (error) {
        if (!(error instanceof SsccCapacityExhaustedException)) throw error;
        this.logger.warn(
          `Shift ${shiftId} (tenant ${tenantId}) bundle has no box serial block -- ${error.message}`,
        );
        return { sscc: null, ssccRevokedFrom: [] };
      }
    });
  }

  private async findRow(tenantId: string, id: string): Promise<CurrentShiftRow | undefined> {
    const [row] = await this.db
      .select(CURRENT_SHIFT_STORAGE_SELECTION)
      .from(schema.shifts)
      .where(and(eq(schema.shifts.tenantId, tenantId), eq(schema.shifts.id, id)));
    return row;
  }

  private async findProductRow(
    tenantId: string,
    productId: string,
  ): Promise<ProductRow | undefined> {
    const [row] = await this.db
      .select(CURRENT_PRODUCT_SELECTION)
      .from(schema.products)
      .leftJoin(
        schema.chzProductGroups,
        eq(schema.chzProductGroups.code, schema.products.chzProductGroupCode),
      )
      .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.id, productId)));
    return row;
  }

  private async findDefaultBoxLabelTemplateId(tenantId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ defaultBoxLabelTemplateId: schema.orgProfiles.defaultBoxLabelTemplateId })
      .from(schema.orgProfiles)
      .where(eq(schema.orgProfiles.tenantId, tenantId));
    return row?.defaultBoxLabelTemplateId ?? null;
  }

  private async findProductImage(
    tenantId: string,
    productId: string,
  ): Promise<ProductImageDescriptor | null> {
    const [row] = await this.db
      .select({
        checksum: schema.mediaAssets.checksum,
        byteSize: schema.mediaAssets.byteSize,
        width: schema.mediaAssets.width,
        height: schema.mediaAssets.height,
      })
      .from(schema.productImages)
      .innerJoin(
        schema.mediaAssets,
        and(
          eq(schema.mediaAssets.id, schema.productImages.assetId),
          eq(schema.mediaAssets.ownerTenantId, tenantId),
          eq(schema.mediaAssets.status, "active"),
        ),
      )
      .where(
        and(
          eq(schema.productImages.tenantId, tenantId),
          eq(schema.productImages.productId, productId),
        ),
      )
      .limit(1);
    return row
      ? {
          checksum: row.checksum,
          contentType: "image/webp",
          byteSize: row.byteSize ?? 0,
          width: row.width ?? 0,
          height: row.height ?? 0,
        }
      : null;
  }

  /**
   * aggregation mode needs an effective box capacity; a pallets-enabled
   * aggregation shift additionally needs an effective pallet capacity.
   */
  private assertCapacityRules(
    mode: ShiftMode,
    boxCapacity: number | null,
    palletsEnabled: boolean,
    palletCapacity: number | null,
  ): void {
    if (mode === "aggregation" && !boxCapacity) {
      throw new BadRequestException("Aggregation mode requires a box capacity");
    }
    if (palletsEnabled && mode === "aggregation" && !palletCapacity) {
      throw new BadRequestException("Pallet-enabled aggregation shifts require a pallet capacity");
    }
  }

  private resolveBoxTemplate(
    mode: ShiftMode,
    boxLabelTemplateId: string | null,
  ): BoxTemplateResolution {
    if (mode === "aggregation" && boxLabelTemplateId === null) {
      return { ok: false, code: "BOX_LABEL_TEMPLATE_REQUIRED" };
    }
    return { ok: true, boxLabelTemplateId };
  }

  private assertBoxTemplateRule(mode: ShiftMode, boxLabelTemplateId: string | null): void {
    const resolution = this.resolveBoxTemplate(mode, boxLabelTemplateId);
    if (!resolution.ok) {
      throw new UnprocessableEntityException({
        code: resolution.code,
        message: "Aggregation shifts require a box label template",
      });
    }
  }

  private joinedSelection() {
    return {
      id: schema.shifts.id,
      status: schema.shifts.status,
      mode: schema.shifts.mode,
      productId: schema.shifts.productId,
      productName: schema.products.name,
      productPrintName: schema.products.printName,
      imageChecksum: schema.mediaAssets.checksum,
      imageByteSize: schema.mediaAssets.byteSize,
      imageWidth: schema.mediaAssets.width,
      imageHeight: schema.mediaAssets.height,
      lineId: schema.shifts.lineId,
      lineName: schema.lines.name,
      counterpartyId: schema.shifts.counterpartyId,
      counterpartyName: schema.counterparties.name,
      ssccIssuerCounterpartyId: schema.shifts.ssccIssuerCounterpartyId,
      boxLabelTemplateId: schema.shifts.boxLabelTemplateId,
      plannedQty: schema.shifts.plannedQty,
      plannedDate: schema.shifts.plannedDate,
      productionDate: schema.shifts.productionDate,
      boxCapacity: schema.shifts.boxCapacity,
      palletCapacity: schema.shifts.palletCapacity,
      palletsEnabled: schema.shifts.palletsEnabled,
      createdFrom: schema.shifts.createdFrom,
      openedAt: schema.shifts.openedAt,
      closedAt: schema.shifts.closedAt,
      closeReason: schema.shifts.closeReason,
      lateDataAt: schema.shifts.lateDataAt,
      createdAt: schema.shifts.createdAt,
      stationClosePolicy: schema.shifts.stationClosePolicy,
      stationCloseOwnerDeviceId: schema.shifts.stationCloseOwnerDeviceId,
      numberMonthKey: schema.shifts.numberMonthKey,
      numberSeq: schema.shifts.numberSeq,
    };
  }

  private mapShiftRow(row: JoinedShiftRow): ShiftDto {
    const {
      numberMonthKey,
      numberSeq,
      imageChecksum,
      imageByteSize,
      imageWidth,
      imageHeight,
      stationClosePolicy,
      stationCloseOwnerDeviceId,
      ...shift
    } = row;
    const access =
      stationClosePolicy === "admin_only"
        ? ({ kind: "admin_only" } as const)
        : stationCloseOwnerDeviceId
          ? ({ kind: "single_device", ownerDeviceId: stationCloseOwnerDeviceId } as const)
          : undefined;
    return {
      ...shift,
      number: formatShiftNumber({
        monthKey: numberMonthKey,
        seq: numberSeq,
        createdFrom: shift.createdFrom,
      }),
      ...(access ? { stationCloseAccess: access } : {}),
      image: imageChecksum
        ? {
            checksum: imageChecksum,
            contentType: "image/webp",
            byteSize: imageByteSize ?? 0,
            width: imageWidth ?? 0,
            height: imageHeight ?? 0,
          }
        : null,
    };
  }

  private async writeProductionDateAudit(
    writer: Pick<Db, "insert">,
    input: {
      tenantId: string;
      actorUserId: string;
      shiftId: string;
      before: string | null;
      after: string | null;
      outcome: "success" | "failure";
      reason: ProductionDateAuditReason;
    },
  ): Promise<void> {
    await writer.insert(schema.tenantAuditEvents).values({
      organizationId: input.tenantId,
      actorUserId: input.actorUserId,
      action: "shift.production_date.changed",
      outcome: input.outcome,
      targetType: "shift",
      targetId: input.shiftId,
      before: { productionDate: input.before },
      after: { productionDate: input.after, reason: input.reason },
    });
  }

  /**
   * Catch PostgreSQL violations: unique 23505 -> 409; FK 23503 -> 400,
   * naming the referenced entity per FK constraint name.
   */
  private handleWriteError(error: unknown): never {
    const err = error as Error & { code?: string; constraint?: string; cause?: unknown };
    const cause = err?.cause as { code?: string; constraint?: string } | undefined;
    const errorCode = err?.code || cause?.code;
    const constraint = err?.constraint || cause?.constraint;

    if (errorCode === "23505") {
      throw new ConflictException("A conflicting shift already exists");
    }
    if (errorCode === "23503") {
      if (constraint === "shifts_tenant_product_fk") {
        throw new BadRequestException("Unknown product for this organization");
      }
      if (constraint === "shifts_tenant_line_fk") {
        throw new BadRequestException("Unknown line for this organization");
      }
      if (constraint === "shifts_tenant_counterparty_fk") {
        throw new BadRequestException("Unknown counterparty for this organization");
      }
      if (constraint === "shifts_tenant_sscc_issuer_fk") {
        throw new BadRequestException("Unknown sscc issuer counterparty for this organization");
      }
      if (constraint === "shifts_tenant_box_label_template_fk") {
        throw new BadRequestException("Unknown box label template for this organization");
      }
      throw new BadRequestException(
        "Referenced entity does not belong to this organization or does not exist",
      );
    }
    throw error;
  }
}
