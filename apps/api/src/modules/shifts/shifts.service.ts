import {
  readProductLabelHistory,
  readProductLabelEventHistory,
  type ProductLabelHistoryQuery,
  type ProductLabelEventsQuery,
} from "./product-label-history";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from "@nestjs/common";
import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import {
  formatShiftNumber,
  PRODUCT_LABEL_PROTOCOL,
  isBoxLabelTemplateEligible,
  isPalletLabelTemplateEligible,
  productLabelTemplateListSchema,
  parseLabelTemplate,
  shiftMonthKey,
  type ProductLabelTemplateList,
} from "@markiro/domain";
import type { LabelTemplateSpec } from "@markiro/domain";
import { DB } from "../../auth/auth.module";
import {
  findLabelTemplateEligibility,
  resolveDefaultBoxLabelTemplate,
  resolveDefaultPalletLabelTemplate,
} from "../label-templates/box-label-template-eligibility";
import { OperatorsService } from "../operators/operators.service";
import type { ProductImageDescriptor } from "../products/dto";
import {
  BOX_EXTENSION_DIGIT,
  PALLET_EXTENSION_DIGIT,
  SsccCapacityExhaustedException,
  SsccService,
} from "../sscc/sscc.service";
import type {
  BoxTemplateResolution,
  CloseShiftDto,
  CreateShiftDto,
  ListShiftsQueryDto,
  ListShiftsResponseDto,
  PalletTemplateResolution,
  ShiftBoxLabelTemplateOptionDto,
  ShiftBoxLabelTemplatesDto,
  ShiftBundleDto,
  ShiftDto,
  ShiftMode,
  ShiftOrigin,
  ShiftOutputDto,
  ShiftPlanningConfigDto,
  ShiftReferenceBundleDto,
  ShiftSummaryDto,
  UpdateShiftDto,
} from "./dto";
import { EntitlementsService } from "../../subscriptions/entitlements.service";
import { SubscriptionReadOnlyException } from "../../subscriptions/subscription-errors";

import {
  assertProductLabelCapability,
  assertValidationPrintCompatible,
  snapshotValidationPrintPolicy,
  validationPrintFromStorage,
  validationPrintToStorage,
  validationPrintInput,
  VALIDATION_DM_DUPLICATE_ENABLED,
  type ValidationPrintStorage,
} from "./validation-print-policy";

type ShiftRow = typeof schema.shifts.$inferSelect;
type CurrentShiftRow = Omit<ShiftRow, "labelTemplateId">;
type ProductRow = Omit<typeof schema.products.$inferSelect, "defaultLabelTemplateId"> & {
  productGroupName: string | null;
};
type JoinedShiftRow = Omit<ShiftDto, "image" | "number" | "validationPrint" | "output"> &
  ValidationPrintStorage & {
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

interface ShiftSummaryOutputRow {
  mode: ShiftMode;
  generatedAt: Date | string;
  validationAcceptedUnits: number;
  aggregationClosedBoxes: number;
  aggregationContainedUnits: number;
}

interface ShiftParticipantRow {
  employeeId: string | null;
  fullName: string | null;
  role: string | null;
  firstActivityAt: Date | string;
  lastActivityAt: Date | string;
  eventCount: number;
  acceptedScans: number;
  closedBoxes: number;
}

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
  validationPrintMode: schema.shifts.validationPrintMode,
  validationPrintVerification: schema.shifts.validationPrintVerification,
  validationPrintTemplateId: schema.shifts.validationPrintTemplateId,
  validationPrintSnapshot: schema.shifts.validationPrintSnapshot,
  validationPrintPolicyRevision: schema.shifts.validationPrintPolicyRevision,
  plannedQty: schema.shifts.plannedQty,
  plannedDate: schema.shifts.plannedDate,
  productionDate: schema.shifts.productionDate,
  firstBoxClosureAt: schema.shifts.firstBoxClosureAt,
  boxCapacity: schema.shifts.boxCapacity,
  palletBoxCapacity: schema.shifts.palletBoxCapacity,
  palletsEnabled: schema.shifts.palletsEnabled,
  palletLabelTemplateId: schema.shifts.palletLabelTemplateId,
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
  palletBoxCapacity: schema.products.palletBoxCapacity,
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
/**
 * A tenth of the box block. A pallet is consumed `palletBoxCapacity` times
 * more slowly than a box, so 200 matches 2000 boxes' offline reach at a
 * pallet of ten boxes and exceeds it above that — and a device that never
 * fills them has not burned 2000 numbers into the sand.
 */
const PALLET_BLOCK_SIZE = 200;

@Injectable()
export class ShiftsService {
  private readonly logger = new Logger(ShiftsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly operatorsService: OperatorsService,
    private readonly sscc: SsccService,
    private readonly entitlements: EntitlementsService,
    @Optional()
    @Inject(VALIDATION_DM_DUPLICATE_ENABLED)
    private readonly duplicateEnabled: boolean = false,
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

    const shifts = rows.map((row) => this.mapShiftRow(row));
    const outputs = await this.fetchShiftOutputs(tenantId, shifts);
    return {
      items: shifts.map((shift) => ({
        ...shift,
        output: outputs.get(shift.id) ?? defaultShiftOutput(shift.mode),
      })),
    };
  }

  /** The one organisation setting needed by operations shift planning, resolved for a product when given. */
  async getPlanningConfig(tenantId: string, productId?: string): Promise<ShiftPlanningConfigDto> {
    const chzProductGroupCode = await this.productGroupCodeForPicker(tenantId, productId);
    const resolved = await resolveDefaultBoxLabelTemplate(this.db, tenantId, chzProductGroupCode);
    return {
      defaultBoxLabelTemplateId: resolved.templateId,
      defaultSource: resolved.source,
      validationPrintProtocol: this.duplicateEnabled ? PRODUCT_LABEL_PROTOCOL : null,
    };
  }

  async listBoxLabelTemplates(
    tenantId: string,
    productId?: string,
  ): Promise<ShiftBoxLabelTemplatesDto> {
    const chzProductGroupCode = await this.productGroupCodeForPicker(tenantId, productId);
    const resolved = await resolveDefaultBoxLabelTemplate(this.db, tenantId, chzProductGroupCode);
    const rows = await this.db
      .select({
        id: schema.labelTemplates.id,
        name: schema.labelTemplates.name,
        spec: schema.labelTemplates.spec,
        purpose: schema.labelTemplates.purpose,
        enabled: schema.labelTemplates.enabled,
        chzProductGroupCodes: schema.labelTemplates.chzProductGroupCodes,
      })
      .from(schema.labelTemplates)
      .where(
        and(
          eq(schema.labelTemplates.tenantId, tenantId),
          eq(schema.labelTemplates.enabled, true),
          eq(schema.labelTemplates.purpose, "box"),
        ),
      )
      .orderBy(schema.labelTemplates.name, schema.labelTemplates.id);
    const items = rows
      // Without a product every enabled template is offered (legacy stations);
      // with one, only templates covering its category.
      .filter(
        (row) =>
          row.purpose === "box" &&
          (productId === undefined || isBoxLabelTemplateEligible(row, chzProductGroupCode)),
      )
      .map((row): ShiftBoxLabelTemplateOptionDto => {
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
      a.id === resolved.templateId ? -1 : b.id === resolved.templateId ? 1 : 0,
    );
    return {
      items,
      defaultBoxLabelTemplateId: resolved.templateId,
      defaultSource: resolved.source,
    };
  }

  async listProductLabelTemplates(
    tenantId: string,
    productId: string,
  ): Promise<ProductLabelTemplateList> {
    const category = await this.productGroupCodeForPicker(tenantId, productId);
    const rows = await this.db
      .select({
        id: schema.labelTemplates.id,
        name: schema.labelTemplates.name,
        spec: schema.labelTemplates.spec,
        chzProductGroupCodes: schema.labelTemplates.chzProductGroupCodes,
      })
      .from(schema.labelTemplates)
      .where(
        and(
          eq(schema.labelTemplates.tenantId, tenantId),
          eq(schema.labelTemplates.purpose, "product_duplicate"),
          eq(schema.labelTemplates.enabled, true),
        ),
      )
      .orderBy(schema.labelTemplates.name, schema.labelTemplates.id);
    return productLabelTemplateListSchema.parse({
      items: rows
        .filter(
          (row) =>
            row.chzProductGroupCodes === null ||
            (category !== null && row.chzProductGroupCodes.includes(category)),
        )
        .map((row) => {
          const spec = parseLabelTemplate(row.spec);
          return {
            id: row.id,
            name: row.name,
            widthMm: spec.widthMm,
            heightMm: spec.heightMm,
            dpi: spec.dpi,
          };
        }),
    });
  }

  /** `null` without a product (organisation-level answer); 404 for a product outside the tenant. */
  private async productGroupCodeForPicker(
    tenantId: string,
    productId: string | undefined,
  ): Promise<number | null> {
    if (productId === undefined) return null;
    const product = await this.findProductRow(tenantId, productId);
    if (!product) throw new NotFoundException("Unknown product for this organization");
    return product.chzProductGroupCode ?? null;
  }

  private async assertBoxTemplateEligible(
    tenantId: string,
    templateId: string,
    chzProductGroupCode: number | null,
  ): Promise<void> {
    const template = await findLabelTemplateEligibility(this.db, tenantId, templateId);
    // Unknown (or another tenant's) template stays a 400, as the FK mapping
    // always answered; a known template that does not fit is a 422.
    if (!template) {
      throw new BadRequestException("Unknown box label template for this organization");
    }
    if (template.purpose !== "box") {
      throw new BadRequestException({
        code: "BOX_LABEL_TEMPLATE_NOT_ELIGIBLE",
        // Names the rule, not one offending purpose: since 06d a tenant can
        // mint pallet templates of its own, so "a product duplicate
        // template" was simply the wrong noun for half the rejections.
        message: "Only a box-purpose template can label a box",
      });
    }
    if (!isBoxLabelTemplateEligible(template, chzProductGroupCode)) {
      throw new UnprocessableEntityException({
        code: "BOX_LABEL_TEMPLATE_NOT_ELIGIBLE",
        message: "Box label template is disabled or does not apply to the product's category",
      });
    }
  }

  /**
   * Same shape as `assertBoxTemplateEligible`, for `palletLabelTemplateId`.
   * Unlike the box check, a wrong purpose here is a 422 rather than a 400: a
   * pallet-purpose assignment is itself an invalid *pallet configuration*
   * (the same family of rule `assertPalletConfiguration` enforces), not a
   * malformed request -- the template id is well-formed and known, it is
   * just the wrong KIND of template for this field.
   */
  private async assertPalletTemplateEligible(
    tenantId: string,
    templateId: string,
    chzProductGroupCode: number | null,
  ): Promise<void> {
    const template = await findLabelTemplateEligibility(this.db, tenantId, templateId);
    if (!template) {
      throw new BadRequestException("Unknown pallet label template for this organization");
    }
    if (template.purpose !== "pallet") {
      throw new UnprocessableEntityException({
        code: "PALLET_LABEL_TEMPLATE_NOT_ELIGIBLE",
        message: "Only a pallet-purpose template can label a pallet",
      });
    }
    if (!isPalletLabelTemplateEligible(template, chzProductGroupCode)) {
      throw new UnprocessableEntityException({
        code: "PALLET_LABEL_TEMPLATE_NOT_ELIGIBLE",
        message: "Pallet label template is disabled or does not apply to the product's category",
      });
    }
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
    const shift = this.mapShiftRow(row);
    const outputs = await this.fetchShiftOutputs(tenantId, [shift]);
    return { ...shift, output: outputs.get(shift.id) ?? defaultShiftOutput(shift.mode) };
  }

  getProductLabelHistory(tenantId: string, id: string, query: ProductLabelHistoryQuery) {
    return readProductLabelHistory(this.db, tenantId, id, query);
  }
  getProductLabelEvents(
    tenantId: string,
    id: string,
    jobId: string,
    query: ProductLabelEventsQuery,
  ) {
    return readProductLabelEventHistory(this.db, tenantId, id, jobId, query);
  }

  async getShiftSummary(
    tenantId: string,
    id: string,
    deviceId: string | null = null,
  ): Promise<ShiftSummaryDto> {
    return this.db.transaction(
      async (tx) => {
        // A device sees only shifts it has entered; the cabinet sees every shift.
        if (deviceId !== null) {
          const [participant] = await tx
            .select({ deviceId: schema.shiftDeviceParticipants.deviceId })
            .from(schema.shiftDeviceParticipants)
            .where(
              and(
                eq(schema.shiftDeviceParticipants.tenantId, tenantId),
                eq(schema.shiftDeviceParticipants.shiftId, id),
                eq(schema.shiftDeviceParticipants.deviceId, deviceId),
              ),
            )
            .limit(1);
          if (!participant) {
            throw new ForbiddenException("Device is not a participant of this shift");
          }
        }
        const outputResult = await tx.execute(sql<ShiftSummaryOutputRow>`
          with target_shift as (
            select shift.tenant_id, shift.id, shift.mode
            from shifts shift
            where shift.tenant_id = ${tenantId}
              and shift.id = ${id}
          )
          select
            target.mode as "mode",
            transaction_timestamp() as "generatedAt",
            (
              select count(*)::int
              from code_registry registry
              where registry.tenant_id = target.tenant_id
                and registry.tenant_id = ${tenantId}
                and registry.shift_id = target.id
                and registry.shift_id = ${id}
                and target.mode = 'validation'
            ) as "validationAcceptedUnits",
            (
              select count(*)::int
              from boxes box
              where box.tenant_id = target.tenant_id
                and box.tenant_id = ${tenantId}
                and box.shift_id = target.id
                and box.shift_id = ${id}
                and target.mode = 'aggregation'
                and box.closed_at is not null
                and box.disassembled_at is null
            ) as "aggregationClosedBoxes",
            (
              select count(*)::int
              from box_items item
              inner join boxes box
                on box.tenant_id = item.tenant_id
                and box.id = item.box_id
              where item.tenant_id = target.tenant_id
                and item.tenant_id = ${tenantId}
                and box.tenant_id = target.tenant_id
                and box.tenant_id = ${tenantId}
                and box.shift_id = target.id
                and box.shift_id = ${id}
                and target.mode = 'aggregation'
                and box.closed_at is not null
                and box.disassembled_at is null
                and item.displaced_at is null
                and item.removed_at is null
            ) as "aggregationContainedUnits"
          from target_shift target
        `);
        const rawOutputRow = outputResult.rows[0];
        if (!rawOutputRow) throw new NotFoundException();
        const outputRow = parseShiftSummaryOutputRow(rawOutputRow);

        const participantsResult = await tx.execute(sql<ShiftParticipantRow>`
          with activity as (
            select
              event.operator_id,
              event.scanned_at as activity_at,
              1::int as event_count,
              case when event.verdict = 'ok' then 1 else 0 end::int as accepted_scans,
              0::int as closed_boxes
            from scan_events event
            where event.tenant_id = ${tenantId}
              and event.shift_id = ${id}

            union all

            select
              box.operator_id,
              coalesce(box.closed_at, box.opened_at) as activity_at,
              1::int as event_count,
              0::int as accepted_scans,
              case when box.closed_at is not null then 1 else 0 end::int as closed_boxes
            from boxes box
            where box.tenant_id = ${tenantId}
              and box.shift_id = ${id}
              and coalesce(box.closed_at, box.opened_at) is not null

            union all

            select
              box_event.operator_id,
              box_event.occurred_at as activity_at,
              1::int as event_count,
              0::int as accepted_scans,
              0::int as closed_boxes
            from box_exceptions box_event
            where box_event.tenant_id = ${tenantId}
              and box_event.shift_id = ${id}
              and box_event.disaggregation_document_id is null

            union all

            select
              closing.operator_id,
              closing.closed_at as activity_at,
              1::int as event_count,
              0::int as accepted_scans,
              0::int as closed_boxes
            from station_shift_close_events closing
            where closing.tenant_id = ${tenantId}
              and closing.shift_id = ${id}
              and closing.outcome = 'accepted'
          )
          select
            employee.id as "employeeId",
            employee.full_name as "fullName",
            employee.role as "role",
            min(activity.activity_at) as "firstActivityAt",
            max(activity.activity_at) as "lastActivityAt",
            sum(activity.event_count)::int as "eventCount",
            sum(activity.accepted_scans)::int as "acceptedScans",
            sum(activity.closed_boxes)::int as "closedBoxes"
          from activity
          left join employees employee
            on employee.tenant_id = ${tenantId}
            and employee.id = activity.operator_id
          group by activity.operator_id, employee.id, employee.full_name, employee.role
          order by min(activity.activity_at), employee.full_name nulls last
        `);

        const participants: ShiftSummaryDto["participants"] = [];
        const unattributed = { eventCount: 0, acceptedScans: 0, closedBoxes: 0 };
        for (const rawRow of participantsResult.rows) {
          const row = parseShiftParticipantRow(rawRow);
          const { eventCount, acceptedScans, closedBoxes } = row;
          if (!row.employeeId || !row.fullName) {
            unattributed.eventCount += eventCount;
            unattributed.acceptedScans += acceptedScans;
            unattributed.closedBoxes += closedBoxes;
            continue;
          }
          participants.push({
            employeeId: row.employeeId,
            fullName: row.fullName,
            role: row.role,
            firstActivityAt: toIsoTimestamp(row.firstActivityAt, "first activity"),
            lastActivityAt: toIsoTimestamp(row.lastActivityAt, "last activity"),
            acceptedScans: row.acceptedScans,
            closedBoxes: row.closedBoxes,
          });
        }

        const mode = outputRow.mode;
        return {
          generatedAt: toIsoTimestamp(outputRow.generatedAt, "summary generated-at"),
          output:
            mode === "validation"
              ? {
                  mode,
                  acceptedUnits: outputRow.validationAcceptedUnits,
                }
              : {
                  mode,
                  closedBoxes: outputRow.aggregationClosedBoxes,
                  containedUnits: outputRow.aggregationContainedUnits,
                },
          participants,
          unattributed,
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  /**
   * Create a shift. `boxCapacity`/`palletBoxCapacity`/`counterpartyId` default
   * from the product when omitted (`undefined`); explicit null opts out.
   * Draft products are rejected outright (422).
   */
  async createShift(
    tenantId: string,
    data: CreateShiftDto,
    createdFrom: ShiftOrigin = "admin",
    capabilities?: string,
  ): Promise<ShiftDto> {
    const printInput = data.validationPrint ?? { mode: "none" };
    assertValidationPrintCompatible(data.mode, printInput);
    if (createdFrom === "station") assertProductLabelCapability(printInput, capabilities);
    if (printInput.mode === "duplicate_dm") this.assertDuplicateEnabled();
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
    const palletBoxCapacity =
      data.palletBoxCapacity !== undefined ? data.palletBoxCapacity : product.palletBoxCapacity;
    const counterpartyId =
      data.counterpartyId !== undefined ? data.counterpartyId : product.defaultCounterpartyId;
    const chzProductGroupCode = product.chzProductGroupCode ?? null;
    let boxLabelTemplateId: string | null;
    if (data.boxLabelTemplateId === undefined) {
      boxLabelTemplateId = (
        await resolveDefaultBoxLabelTemplate(this.db, tenantId, chzProductGroupCode)
      ).templateId;
    } else {
      boxLabelTemplateId = data.boxLabelTemplateId;
      if (boxLabelTemplateId !== null) {
        await this.assertBoxTemplateEligible(tenantId, boxLabelTemplateId, chzProductGroupCode);
      }
    }
    const palletsEnabled = data.palletsEnabled ?? false;
    // Resolved only when pallets are enabled -- a shift without pallets
    // carries no pallet-label snapshot at all (see the field comment on
    // ShiftBundleDto.palletLabelTemplate), so there is nothing useful to
    // default an omitted field to.
    let palletLabelTemplateId: string | null;
    if (data.palletLabelTemplateId === undefined) {
      palletLabelTemplateId = palletsEnabled
        ? (await resolveDefaultPalletLabelTemplate(this.db, tenantId, chzProductGroupCode))
            .templateId
        : null;
    } else {
      palletLabelTemplateId = data.palletLabelTemplateId;
      if (palletLabelTemplateId !== null) {
        await this.assertPalletTemplateEligible(
          tenantId,
          palletLabelTemplateId,
          chzProductGroupCode,
        );
      }
    }

    assertPalletConfiguration({ mode: data.mode, palletsEnabled, boxCapacity, palletBoxCapacity });
    this.assertCapacityRules(data.mode, boxCapacity);
    this.assertBoxTemplateRule(data.mode, boxLabelTemplateId);
    // A fresh shift has no prior state: `palletsEnabled` here IS the moment
    // pallets are enabled, so this always applies -- unlike the update path,
    // there is no "operator already cleared it" history to preserve.
    this.assertPalletTemplateRule(palletsEnabled, palletLabelTemplateId);

    const monthKey = shiftMonthKey(data.plannedDate ?? new Date().toISOString().slice(0, 10));

    try {
      const [row] = await this.db.transaction(async (tx) => {
        const validationPrint = await snapshotValidationPrintPolicy(
          tx,
          tenantId,
          data.productId,
          data.mode,
          printInput,
        );
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
            ...validationPrintToStorage(validationPrint),
            lineId: data.lineId ?? null,
            counterpartyId: counterpartyId ?? null,
            // The issuer is always explicit (unlike the org-defaulted box
            // template resolved above), so an omitted value is null ("our
            // organisation").
            ssccIssuerCounterpartyId: data.ssccIssuerCounterpartyId ?? null,
            boxLabelTemplateId,
            palletLabelTemplateId,
            mode: data.mode,
            plannedQty: data.plannedQty ?? null,
            plannedDate: data.plannedDate ?? null,
            productionDate: data.productionDate ?? null,
            boxCapacity: boxCapacity ?? null,
            palletBoxCapacity: palletBoxCapacity ?? null,
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
      (data.palletsEnabled === true || data.palletBoxCapacity !== undefined)
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
        if (current.status !== "planned" && data.validationPrint !== undefined) {
          throw new ConflictException({
            code: "VALIDATION_PRINT_POLICY_FROZEN",
            message: "Print settings are fixed after the shift starts",
          });
        }

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

        // A shift keeps its snapshot even after the template is disabled or
        // scoped away; eligibility is enforced only when the template changes.
        if (
          data.boxLabelTemplateId !== undefined &&
          data.boxLabelTemplateId !== null &&
          data.boxLabelTemplateId !== current.boxLabelTemplateId
        ) {
          const product = await this.findProductRow(tenantId, current.productId);
          await this.assertBoxTemplateEligible(
            tenantId,
            data.boxLabelTemplateId,
            product?.chzProductGroupCode ?? null,
          );
        }

        // Same rule, mirrored for the pallet-label snapshot.
        if (
          data.palletLabelTemplateId !== undefined &&
          data.palletLabelTemplateId !== null &&
          data.palletLabelTemplateId !== current.palletLabelTemplateId
        ) {
          const product = await this.findProductRow(tenantId, current.productId);
          await this.assertPalletTemplateEligible(
            tenantId,
            data.palletLabelTemplateId,
            product?.chzProductGroupCode ?? null,
          );
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
        const previousPrint = validationPrintFromStorage(current);
        const printInput = data.validationPrint ?? validationPrintInput(previousPrint);
        assertValidationPrintCompatible(mode, printInput);
        if (data.validationPrint?.mode === "duplicate_dm") this.assertDuplicateEnabled();
        const validationPrint =
          data.validationPrint === undefined
            ? previousPrint
            : await snapshotValidationPrintPolicy(
                tx,
                tenantId,
                current.productId,
                mode,
                printInput,
                previousPrint,
              );
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
        let palletLabelTemplateId =
          data.palletLabelTemplateId !== undefined
            ? data.palletLabelTemplateId
            : current.palletLabelTemplateId;
        const plannedQty = data.plannedQty !== undefined ? data.plannedQty : current.plannedQty;
        const plannedDate = data.plannedDate !== undefined ? data.plannedDate : current.plannedDate;
        const productionDate =
          data.productionDate !== undefined ? data.productionDate : current.productionDate;
        const boxCapacity = data.boxCapacity !== undefined ? data.boxCapacity : current.boxCapacity;
        const palletBoxCapacity =
          data.palletBoxCapacity !== undefined ? data.palletBoxCapacity : current.palletBoxCapacity;
        const palletsEnabled =
          data.palletsEnabled !== undefined ? data.palletsEnabled : current.palletsEnabled;

        // `createShift` resolves category default -> organisation default ->
        // none at the moment pallets become enabled. Turning them on by PATCH
        // is the same moment and must resolve the same way: without this, a
        // planned shift edited to enable pallets keeps a null
        // `palletLabelTemplateId` (an omitted field means "keep current"),
        // `assertPalletConfiguration` checks only capacities, and the shift
        // goes on to close pallets and burn pallet serials with no template
        // to print a pallet label from.
        //
        // Deliberately scoped to the off -> ON transition and to a template
        // that is still null: an explicit `palletLabelTemplateId: null`
        // (a cleared template on a shift whose pallets are already on) is an
        // operator's decision, and a later unrelated PATCH must not quietly
        // resurrect the organisation default over it.
        if (
          data.palletLabelTemplateId === undefined &&
          palletsEnabled &&
          !current.palletsEnabled &&
          palletLabelTemplateId === null
        ) {
          const product = await this.findProductRow(tenantId, current.productId);
          palletLabelTemplateId = (
            await resolveDefaultPalletLabelTemplate(
              tx,
              tenantId,
              product?.chzProductGroupCode ?? null,
            )
          ).templateId;
        }

        assertPalletConfiguration({ mode, palletsEnabled, boxCapacity, palletBoxCapacity });
        this.assertCapacityRules(mode, boxCapacity);
        this.assertBoxTemplateRule(mode, boxLabelTemplateId);
        // Scoped to the same off -> ON transition as the default resolution
        // just above, not to every update: an operator who explicitly clears
        // the template on a shift whose pallets are already on keeps that as
        // their own decision (see the comment above), and a later unrelated
        // PATCH must not be rejected for a state that update itself did not
        // create. This is what closes the gap: previously the resolve
        // attempt right above could quietly settle on `null` (now that a
        // tenant can clear its own default) and nothing refused it, so
        // pallets went live with no template to print a label from.
        if (palletsEnabled && !current.palletsEnabled) {
          this.assertPalletTemplateRule(palletsEnabled, palletLabelTemplateId);
        }

        const [updated] = await tx
          .update(schema.shifts)
          .set({
            ...validationPrintToStorage(validationPrint),
            mode,
            lineId,
            counterpartyId,
            ssccIssuerCounterpartyId,
            boxLabelTemplateId,
            palletLabelTemplateId,
            plannedQty,
            plannedDate,
            productionDate,
            boxCapacity,
            palletBoxCapacity,
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
  async openShift(
    tenantId: string,
    id: string,
    deviceId?: string,
    capabilities?: string,
  ): Promise<ShiftDto> {
    if (deviceId) return this.enterShift(tenantId, id, deviceId, capabilities);
    await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select(CURRENT_SHIFT_STORAGE_SELECTION)
        .from(schema.shifts)
        .where(and(eq(schema.shifts.tenantId, tenantId), eq(schema.shifts.id, id)))
        .for("update");
      if (!current) throw new NotFoundException();
      if (current.status !== "planned")
        throw new ConflictException("Shift can only be opened while planned");
      if (current.palletsEnabled) await this.entitlements.assertFeatureAccess(tenantId, "pallets");
      // A shift planned before this slice can hold palletsEnabled with a
      // null capacity; opening it must fail loudly rather than hand a
      // terminal an unfulfillable configuration.
      assertPalletConfiguration({
        mode: current.mode,
        palletsEnabled: current.palletsEnabled,
        boxCapacity: current.boxCapacity,
        palletBoxCapacity: current.palletBoxCapacity,
      });
      const previous = validationPrintFromStorage(current);
      const policy = await snapshotValidationPrintPolicy(
        tx,
        tenantId,
        current.productId,
        current.mode,
        validationPrintInput(previous),
        previous,
      );
      await tx
        .update(schema.shifts)
        .set({ status: "active", openedAt: new Date(), ...validationPrintToStorage(policy) })
        .where(and(eq(schema.shifts.tenantId, tenantId), eq(schema.shifts.id, id)));
    });
    return this.getShift(tenantId, id);
  }

  /** Register a station's participation and atomically derive close authority. */
  async enterShift(
    tenantId: string,
    id: string,
    deviceId: string,
    capabilities?: string,
  ): Promise<ShiftDto> {
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
        .select(CURRENT_SHIFT_STORAGE_SELECTION)
        .from(schema.shifts)
        .where(and(eq(schema.shifts.tenantId, tenantId), eq(schema.shifts.id, id)))
        .for("update");
      if (!shift) throw new NotFoundException();
      const previous = validationPrintFromStorage(shift);
      assertProductLabelCapability(previous, capabilities);
      if (shift.status === "closed") throw new ConflictException("Closed shifts cannot be entered");
      if (shift.status === "planned") {
        if (shift.palletsEnabled) await this.entitlements.assertFeatureAccess(tenantId, "pallets");
        // Same guard as openShift, for the device-entry path into an active shift.
        assertPalletConfiguration({
          mode: shift.mode,
          palletsEnabled: shift.palletsEnabled,
          boxCapacity: shift.boxCapacity,
          palletBoxCapacity: shift.palletBoxCapacity,
        });
        const policy = await snapshotValidationPrintPolicy(
          tx,
          tenantId,
          shift.productId,
          shift.mode,
          validationPrintInput(previous),
          previous,
        );
        await tx
          .update(schema.shifts)
          .set({ status: "active", openedAt: new Date(), ...validationPrintToStorage(policy) })
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
  async getBundle(
    tenantId: string,
    id: string,
    deviceId: string | null,
    capabilities?: string,
  ): Promise<ShiftBundleDto> {
    const referenceBundle = await this.getReferenceBundle(
      tenantId,
      id,
      deviceId !== null,
      capabilities,
    );
    const allocation =
      referenceBundle.shift.mode === "aggregation" && deviceId
        ? await this.bundleSscc(tenantId, referenceBundle.shift.id, deviceId)
        : { sscc: null, ssccRevokedFrom: [], palletSscc: null, palletSsccRevokedFrom: [] };
    return { ...referenceBundle, ...allocation };
  }

  /**
   * Reference-only recovery never enters `bundleSscc`; station callers must
   * still understand the frozen print policy before receiving the bundle.
   */
  async getReferenceBundle(
    tenantId: string,
    id: string,
    stationCaller = false,
    capabilities?: string,
  ): Promise<ShiftReferenceBundleDto> {
    const shift = await this.getShift(tenantId, id); // 404 if cross-tenant/missing
    if (stationCaller) assertProductLabelCapability(shift.validationPrint, capabilities);

    const productRow = await this.findProductRow(tenantId, shift.productId);
    if (!productRow) throw new NotFoundException("Shift product missing");
    const image = await this.findProductImage(tenantId, shift.productId);
    const product: ShiftBundleDto["product"] = {
      id: productRow.id,
      gtin14: productRow.gtin14,
      name: productRow.name,
      productGroup: productRow.productGroupName,
      boxCapacity: productRow.boxCapacity,
      palletBoxCapacity: productRow.palletBoxCapacity,
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
    const palletLabelTemplate = await this.findLabelTemplate(tenantId, shift.palletLabelTemplateId);

    const bundleShift: ShiftBundleDto["shift"] = {
      id: shift.id,
      number: shift.number,
      status: shift.status,
      mode: shift.mode,
      productId: shift.productId,
      productName: shift.productName,
      productPrintName: shift.productPrintName,
      validationPrint: shift.validationPrint,
      image: shift.image ?? null,
      lineId: shift.lineId,
      lineName: shift.lineName,
      counterpartyId: shift.counterpartyId,
      counterpartyName: shift.counterpartyName,
      labelTemplateId: null,
      labelTemplateName: null,
      ssccIssuerCounterpartyId: shift.ssccIssuerCounterpartyId,
      boxLabelTemplateId: shift.boxLabelTemplateId,
      palletLabelTemplateId: shift.palletLabelTemplateId,
      plannedQty: shift.plannedQty,
      plannedDate: shift.plannedDate,
      productionDate: shift.productionDate,
      boxCapacity: shift.boxCapacity,
      // The BUNDLE's capacity, unlike the cabinet shift's, is the device's
      // pallets-on/off signal: both `close-box.ts` and `CloseBox.kt` decide
      // whether a closed box joins a pallet purely from
      // `palletBoxCapacity !== null`, with no separate flag. The server's own
      // signal is `shifts.pallets_enabled`, and the two diverge on an
      // ordinary path: with pallets off the admin omits `palletBoxCapacity`,
      // `createShift` reads an omitted value as "take the product's", and
      // migration 0135 backfilled `products.pallet_box_capacity` broadly --
      // so a pallets-DISABLED shift routinely carries a capacity. Emitting it
      // would make both devices show the pallet strip, join boxes to local
      // pallets and send `devicePalletId`, creating server pallet rows that
      // can never be numbered (`bundleSscc` gates `palletSscc` on
      // `palletsEnabled`). Gating here makes the device's signal BE the
      // server's; `palletsEnabled` still rides along unchanged for a consumer
      // that wants the flag itself.
      palletBoxCapacity: shift.palletsEnabled ? shift.palletBoxCapacity : null,
      palletsEnabled: shift.palletsEnabled,
      createdFrom: shift.createdFrom,
      openedAt: shift.openedAt,
      closedAt: shift.closedAt,
      closeReason: shift.closeReason,
      lateDataAt: shift.lateDataAt,
      createdAt: shift.createdAt,
      output: shift.output,
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
      palletLabelTemplate,
      counterpartyGln,
      operators,
      sscc: null,
      ssccRevokedFrom: [],
      palletSscc: null,
      palletSsccRevokedFrom: [],
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
   *
   * The pallet block (extension digit 1, Task 7) is layered on top of all of
   * the above, only for a shift with `palletsEnabled`: it shares the box
   * block's issuer prefix and transaction, but its own exhaustion degrades
   * only `palletSscc` to null -- never the whole bundle, and never the box
   * block already secured in this same call.
   */
  private async bundleSscc(
    tenantId: string,
    shiftId: string,
    deviceId: string,
  ): Promise<
    Pick<ShiftBundleDto, "sscc" | "ssccRevokedFrom" | "palletSscc" | "palletSsccRevokedFrom">
  > {
    return this.db.transaction(async (tx) => {
      const [shift] = await tx
        .select({
          status: schema.shifts.status,
          mode: schema.shifts.mode,
          openedAt: schema.shifts.openedAt,
          palletsEnabled: schema.shifts.palletsEnabled,
        })
        .from(schema.shifts)
        .where(and(eq(schema.shifts.tenantId, tenantId), eq(schema.shifts.id, shiftId)))
        .for("update");
      if (!shift || shift.status !== "active" || shift.mode !== "aggregation") {
        return { sscc: null, ssccRevokedFrom: [], palletSscc: null, palletSsccRevokedFrom: [] };
      }

      const access = await this.entitlements.resolveRecovery(tenantId, tx, new Date());
      if (access.access === "read_only") {
        const endsAt = access.subscription?.endsAt;
        if (!endsAt || !shift.openedAt || shift.openedAt >= endsAt) {
          return { sscc: null, ssccRevokedFrom: [], palletSscc: null, palletSsccRevokedFrom: [] };
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
        return { sscc: null, ssccRevokedFrom: [], palletSscc: null, palletSsccRevokedFrom: [] };
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

        let palletSscc: ShiftBundleDto["palletSscc"] = null;
        let palletSsccRevokedFrom: number[] = [];
        if (shift.palletsEnabled) {
          try {
            palletSscc = await this.sscc.allocateForBundle(
              tenantId,
              issuerPrefix,
              PALLET_EXTENSION_DIGIT,
              deviceId,
              PALLET_BLOCK_SIZE,
              tx,
            );
            // Read AFTER allocation, in the same transaction, for the same
            // reason the box read is: allocation may have just cut the
            // replacement for a revoked block, and the two must describe one
            // consistent moment.
            palletSsccRevokedFrom = await this.sscc.revokedFromSerials(
              tenantId,
              issuerPrefix,
              PALLET_EXTENSION_DIGIT,
              deviceId,
              tx,
            );
          } catch (error) {
            if (!(error instanceof SsccCapacityExhaustedException)) throw error;
            // Degraded exactly like the box block: the station has a
            // graceful "no serials" state, and landing it there beats
            // costing the operator product, templates and roster.
            this.logger.warn(
              `Shift ${shiftId} (tenant ${tenantId}) bundle has no pallet serial block -- ${error.message}`,
            );
          }
        }

        return { sscc, ssccRevokedFrom, palletSscc, palletSsccRevokedFrom };
      } catch (error) {
        if (!(error instanceof SsccCapacityExhaustedException)) throw error;
        this.logger.warn(
          `Shift ${shiftId} (tenant ${tenantId}) bundle has no box serial block -- ${error.message}`,
        );
        return { sscc: null, ssccRevokedFrom: [], palletSscc: null, palletSsccRevokedFrom: [] };
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
   * aggregation mode needs an effective box capacity. The pallet-specific
   * boxes-per-pallet rule used to live here too (a second `BadRequestException`
   * alongside `assertPalletConfiguration`'s own check); it was folded into
   * that single 422 check instead of keeping two rules that could disagree.
   * Every call site runs `assertPalletConfiguration` before this method, so a
   * pallet-enabled shift with no box capacity already failed with the
   * pallet-specific 422 before reaching this generic 400.
   */
  private assertCapacityRules(mode: ShiftMode, boxCapacity: number | null): void {
    if (mode === "aggregation" && !boxCapacity) {
      throw new BadRequestException("Aggregation mode requires a box capacity");
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

  /**
   * Same shape as `resolveBoxTemplate`, for `palletLabelTemplateId`. Unlike
   * the box rule, this is NOT called unconditionally on every request: an
   * operator can still explicitly clear the template on a shift whose
   * pallets are already on (see the update-path comment above
   * `resolveDefaultPalletLabelTemplate`), and a later unrelated PATCH must
   * not be turned into a 422 by that earlier, deliberate choice. Callers
   * invoke this only at the moment pallets are being newly ENABLED -- create,
   * or the update path's off -> ON transition -- which is exactly where
   * migration 0135 used to guarantee a resolvable default and, since the I6
   * fix let a tenant clear its own, no longer does.
   */
  private resolvePalletTemplate(
    palletsEnabled: boolean,
    palletLabelTemplateId: string | null,
  ): PalletTemplateResolution {
    if (palletsEnabled && palletLabelTemplateId === null) {
      return { ok: false, code: "PALLET_LABEL_TEMPLATE_REQUIRED" };
    }
    return { ok: true, palletLabelTemplateId };
  }

  private assertPalletTemplateRule(
    palletsEnabled: boolean,
    palletLabelTemplateId: string | null,
  ): void {
    const resolution = this.resolvePalletTemplate(palletsEnabled, palletLabelTemplateId);
    if (!resolution.ok) {
      throw new UnprocessableEntityException({
        code: resolution.code,
        message: "Pallets require a pallet label template",
      });
    }
  }

  private assertDuplicateEnabled(): void {
    if (!this.duplicateEnabled)
      throw new ConflictException({
        code: "VALIDATION_PRINT_DISABLED",
        message: "Duplicate printing is not enabled",
      });
  }

  /**
   * Actual production output for a batch of shifts, keyed by shift id — the
   * same factual counts as `getShiftSummary`'s `output`, but grouped by
   * `shift_id` across the whole batch instead of one query per shift, so a
   * shift list page costs three grouped queries total, not N.
   */
  private async fetchShiftOutputs(
    tenantId: string,
    shifts: { id: string; mode: ShiftMode }[],
  ): Promise<Map<string, ShiftOutputDto>> {
    const validationIds = shifts.filter((s) => s.mode === "validation").map((s) => s.id);
    const aggregationIds = shifts.filter((s) => s.mode === "aggregation").map((s) => s.id);
    const outputs = new Map<string, ShiftOutputDto>();

    const tasks: Promise<void>[] = [];

    if (validationIds.length > 0) {
      tasks.push(
        this.db
          .select({
            shiftId: schema.codeRegistry.shiftId,
            acceptedUnits: sql<number>`count(*)::int`,
          })
          .from(schema.codeRegistry)
          .where(
            and(
              eq(schema.codeRegistry.tenantId, tenantId),
              inArray(schema.codeRegistry.shiftId, validationIds),
            ),
          )
          .groupBy(schema.codeRegistry.shiftId)
          .then((rows) => {
            for (const row of rows) {
              outputs.set(row.shiftId, { mode: "validation", acceptedUnits: row.acceptedUnits });
            }
          }),
      );
    }

    if (aggregationIds.length > 0) {
      tasks.push(
        this.db
          .select({ shiftId: schema.boxes.shiftId, closedBoxes: sql<number>`count(*)::int` })
          .from(schema.boxes)
          .where(
            and(
              eq(schema.boxes.tenantId, tenantId),
              inArray(schema.boxes.shiftId, aggregationIds),
              isNotNull(schema.boxes.closedAt),
              isNull(schema.boxes.disassembledAt),
            ),
          )
          .groupBy(schema.boxes.shiftId)
          .then((rows) => {
            for (const row of rows) {
              const previous = outputs.get(row.shiftId);
              outputs.set(row.shiftId, {
                mode: "aggregation",
                closedBoxes: row.closedBoxes,
                containedUnits: previous?.mode === "aggregation" ? previous.containedUnits : 0,
              });
            }
          }),
      );

      tasks.push(
        this.db
          .select({ shiftId: schema.boxes.shiftId, containedUnits: sql<number>`count(*)::int` })
          .from(schema.boxItems)
          .innerJoin(
            schema.boxes,
            and(
              eq(schema.boxes.tenantId, schema.boxItems.tenantId),
              eq(schema.boxes.id, schema.boxItems.boxId),
            ),
          )
          .where(
            and(
              eq(schema.boxItems.tenantId, tenantId),
              eq(schema.boxes.tenantId, tenantId),
              inArray(schema.boxes.shiftId, aggregationIds),
              isNotNull(schema.boxes.closedAt),
              isNull(schema.boxes.disassembledAt),
              isNull(schema.boxItems.displacedAt),
              isNull(schema.boxItems.removedAt),
            ),
          )
          .groupBy(schema.boxes.shiftId)
          .then((rows) => {
            for (const row of rows) {
              const previous = outputs.get(row.shiftId);
              outputs.set(row.shiftId, {
                mode: "aggregation",
                closedBoxes: previous?.mode === "aggregation" ? previous.closedBoxes : 0,
                containedUnits: row.containedUnits,
              });
            }
          }),
      );
    }

    await Promise.all(tasks);
    return outputs;
  }

  private joinedSelection() {
    return {
      id: schema.shifts.id,
      validationPrintMode: schema.shifts.validationPrintMode,
      validationPrintVerification: schema.shifts.validationPrintVerification,
      validationPrintTemplateId: schema.shifts.validationPrintTemplateId,
      validationPrintSnapshot: schema.shifts.validationPrintSnapshot,
      validationPrintPolicyRevision: schema.shifts.validationPrintPolicyRevision,
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
      palletLabelTemplateId: schema.shifts.palletLabelTemplateId,
      plannedQty: schema.shifts.plannedQty,
      plannedDate: schema.shifts.plannedDate,
      productionDate: schema.shifts.productionDate,
      boxCapacity: schema.shifts.boxCapacity,
      palletBoxCapacity: schema.shifts.palletBoxCapacity,
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

  private mapShiftRow(row: JoinedShiftRow): Omit<ShiftDto, "output"> {
    const {
      validationPrintMode,
      validationPrintVerification,
      validationPrintTemplateId,
      validationPrintSnapshot,
      validationPrintPolicyRevision,
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
      validationPrint: validationPrintFromStorage({
        validationPrintMode,
        validationPrintVerification,
        validationPrintTemplateId,
        validationPrintSnapshot,
        validationPrintPolicyRevision,
      }),
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
      if (constraint === "shifts_tenant_pallet_label_template_fk") {
        throw new BadRequestException("Unknown pallet label template for this organization");
      }
      throw new BadRequestException(
        "Referenced entity does not belong to this organization or does not exist",
      );
    }
    throw error;
  }
}

function defaultShiftOutput(mode: ShiftMode): ShiftOutputDto {
  return mode === "validation"
    ? { mode, acceptedUnits: 0 }
    : { mode, closedBoxes: 0, containedUnits: 0 };
}

/**
 * A shift may enable pallets only when both capacities are known. Checked
 * AFTER the product prefill, not in the Zod schema, because an omitted field
 * means "take the product's value" and the schema cannot see it.
 *
 * Without this a shift could enable pallets with no box count, and the
 * terminal would build a pallet that never reaches capacity and never closes.
 *
 * Runs BEFORE `ShiftsService.assertCapacityRules` at every call site: that
 * generic rule already rejects an aggregation shift with no box capacity
 * (400, "Aggregation mode requires a box capacity"), but a pallet-enabled
 * shift in the same state must fail with the pallet-specific 422 below
 * instead, not the generic 400 -- reconciling what used to be two competing
 * checks (this one, and a `BadRequestException` this replaces) into one.
 */
function assertPalletConfiguration(input: {
  mode: ShiftMode;
  palletsEnabled: boolean;
  boxCapacity: number | null;
  palletBoxCapacity: number | null;
}): void {
  if (!input.palletsEnabled) return;
  if (input.mode !== "aggregation") {
    throw new UnprocessableEntityException("Pallets require an aggregation shift");
  }
  if (input.boxCapacity === null || input.boxCapacity < 1) {
    throw new UnprocessableEntityException("Pallets require a box capacity");
  }
  if (input.palletBoxCapacity === null || input.palletBoxCapacity < 1) {
    throw new UnprocessableEntityException("Pallets require a boxes-per-pallet count");
  }
}

function toDatabaseNumber(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${label}`);
  }
  return parsed;
}

function toIsoTimestamp(value: unknown, label: string): string {
  if (!(value instanceof Date) && typeof value !== "string") {
    throw new Error(`Invalid ${label}`);
  }
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid ${label}`);
  return parsed.toISOString();
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`Invalid ${label}`);
  return value;
}

function parseShiftSummaryOutputRow(row: Record<string, unknown>): ShiftSummaryOutputRow {
  if (row.mode !== "validation" && row.mode !== "aggregation") {
    throw new Error("Invalid shift summary mode");
  }
  return {
    mode: row.mode,
    generatedAt: toIsoTimestamp(row.generatedAt, "summary generated-at"),
    validationAcceptedUnits: toDatabaseNumber(
      row.validationAcceptedUnits,
      "validation accepted units",
    ),
    aggregationClosedBoxes: toDatabaseNumber(
      row.aggregationClosedBoxes,
      "aggregation closed boxes",
    ),
    aggregationContainedUnits: toDatabaseNumber(
      row.aggregationContainedUnits,
      "aggregation contained units",
    ),
  };
}

function parseShiftParticipantRow(row: Record<string, unknown>): ShiftParticipantRow {
  return {
    employeeId: nullableString(row.employeeId, "participant employee id"),
    fullName: nullableString(row.fullName, "participant full name"),
    role: nullableString(row.role, "participant role"),
    firstActivityAt: toIsoTimestamp(row.firstActivityAt, "first activity"),
    lastActivityAt: toIsoTimestamp(row.lastActivityAt, "last activity"),
    eventCount: toDatabaseNumber(row.eventCount, "participant event count"),
    acceptedScans: toDatabaseNumber(row.acceptedScans, "participant accepted scans"),
    closedBoxes: toDatabaseNumber(row.closedBoxes, "participant closed boxes"),
  };
}
