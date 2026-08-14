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
import { and, eq, gte, isNull, lte, or } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import type { LabelTemplateSpec } from "@markiro/domain";
import { DB } from "../../auth/auth.module";
import { OperatorsService } from "../operators/operators.service";
import type { ProductDto } from "../products/dto";
import type { ProductImageDescriptor } from "../products/dto";
import {
  BOX_EXTENSION_DIGIT,
  SsccCapacityExhaustedException,
  SsccService,
} from "../sscc/sscc.service";
import type {
  CloseShiftDto,
  CreateShiftDto,
  ListShiftsQueryDto,
  ListShiftsResponseDto,
  ShiftBundleDto,
  ShiftDto,
  ShiftMode,
  UpdateShiftDto,
} from "./dto";
import { EntitlementsService } from "../../subscriptions/entitlements.service";
import { SubscriptionReadOnlyException } from "../../subscriptions/subscription-errors";

type ShiftRow = typeof schema.shifts.$inferSelect;
type ProductRow = typeof schema.products.$inferSelect;
type JoinedShiftRow = Omit<ShiftDto, "image"> & {
  imageChecksum: string | null;
  imageByteSize: number | null;
  imageWidth: number | null;
  imageHeight: number | null;
};
export type EffectiveListShiftsQuery = ListShiftsQueryDto & { includeUnassigned?: boolean };

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
      .leftJoin(schema.labelTemplates, eq(schema.shifts.labelTemplateId, schema.labelTemplates.id))
      .where(and(...conditions))
      .orderBy(schema.shifts.createdAt);

    return { items: rows.map((row) => this.mapShiftRow(row)) };
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
      .leftJoin(schema.labelTemplates, eq(schema.shifts.labelTemplateId, schema.labelTemplates.id))
      .where(and(eq(schema.shifts.tenantId, tenantId), eq(schema.shifts.id, id)));

    if (!row) {
      throw new NotFoundException();
    }
    return this.mapShiftRow(row);
  }

  /**
   * Create a shift. Server prefill (plan-03 contract, extended in plan-04
   * for label templates): `boxCapacity`/`palletCapacity`/`counterpartyId`/
   * `labelTemplateId` default from the product when omitted (`undefined`);
   * an explicit `null` in the body opts out of the prefill. Draft products
   * are rejected outright (422) -- a product must be "complete" (group +
   * both capacities) before any shift can reference it. A shift may end up
   * with no effective label template (neither the shift nor its product has
   * one) -- allowed by design; the printing station decides the fallback.
   */
  async createShift(tenantId: string, data: CreateShiftDto): Promise<ShiftDto> {
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

    const boxCapacity = data.boxCapacity !== undefined ? data.boxCapacity : product.boxCapacity;
    const palletCapacity =
      data.palletCapacity !== undefined ? data.palletCapacity : product.palletCapacity;
    const counterpartyId =
      data.counterpartyId !== undefined ? data.counterpartyId : product.defaultCounterpartyId;
    const labelTemplateId =
      data.labelTemplateId !== undefined ? data.labelTemplateId : product.defaultLabelTemplateId;
    const palletsEnabled = data.palletsEnabled ?? false;

    this.assertCapacityRules(data.mode, boxCapacity, palletsEnabled, palletCapacity);

    try {
      const [row] = await this.db
        .insert(schema.shifts)
        .values({
          tenantId,
          productId: data.productId,
          lineId: data.lineId ?? null,
          counterpartyId: counterpartyId ?? null,
          labelTemplateId: labelTemplateId ?? null,
          // No product-level default exists for either field (unlike
          // counterpartyId/labelTemplateId above) -- the issuer is always
          // explicit, so an omitted value is simply null ("our organisation").
          ssccIssuerCounterpartyId: data.ssccIssuerCounterpartyId ?? null,
          boxLabelTemplateId: data.boxLabelTemplateId ?? null,
          mode: data.mode,
          plannedQty: data.plannedQty ?? null,
          plannedDate: data.plannedDate ?? null,
          boxCapacity: boxCapacity ?? null,
          palletCapacity: palletCapacity ?? null,
          palletsEnabled,
        })
        .returning();

      if (!row) {
        throw new InternalServerErrorException("Failed to create shift");
      }
      return this.getShift(tenantId, row.id);
    } catch (error) {
      this.handleWriteError(error);
    }
  }

  /**
   * Partial update, allowed only while `status === "planned"` (409
   * otherwise). Capacity/mode rules are re-checked against the merged
   * (post-patch) values, mirroring the create-time validation.
   */
  async updateShift(tenantId: string, id: string, data: UpdateShiftDto): Promise<ShiftDto> {
    if (data.palletsEnabled === true || data.palletCapacity !== undefined) {
      await this.entitlements.assertFeatureAccess(tenantId, "pallets");
    }
    const current = await this.findRow(tenantId, id);
    if (!current) {
      throw new NotFoundException();
    }
    if (current.status !== "planned") {
      throw new ConflictException("Shift can only be edited while planned");
    }

    const mode = data.mode !== undefined ? data.mode : current.mode;
    const lineId = data.lineId !== undefined ? data.lineId : current.lineId;
    const counterpartyId =
      data.counterpartyId !== undefined ? data.counterpartyId : current.counterpartyId;
    const labelTemplateId =
      data.labelTemplateId !== undefined ? data.labelTemplateId : current.labelTemplateId;
    const ssccIssuerCounterpartyId =
      data.ssccIssuerCounterpartyId !== undefined
        ? data.ssccIssuerCounterpartyId
        : current.ssccIssuerCounterpartyId;
    const boxLabelTemplateId =
      data.boxLabelTemplateId !== undefined ? data.boxLabelTemplateId : current.boxLabelTemplateId;
    const plannedQty = data.plannedQty !== undefined ? data.plannedQty : current.plannedQty;
    const plannedDate = data.plannedDate !== undefined ? data.plannedDate : current.plannedDate;
    const boxCapacity = data.boxCapacity !== undefined ? data.boxCapacity : current.boxCapacity;
    const palletCapacity =
      data.palletCapacity !== undefined ? data.palletCapacity : current.palletCapacity;
    const palletsEnabled =
      data.palletsEnabled !== undefined ? data.palletsEnabled : current.palletsEnabled;

    this.assertCapacityRules(mode, boxCapacity, palletsEnabled, palletCapacity);

    try {
      const [row] = await this.db
        .update(schema.shifts)
        .set({
          mode,
          lineId,
          counterpartyId,
          labelTemplateId,
          ssccIssuerCounterpartyId,
          boxLabelTemplateId,
          plannedQty,
          plannedDate,
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
        .returning();

      if (!row) {
        throw new ConflictException("Shift can only be edited while planned");
      }
      return this.getShift(tenantId, row.id);
    } catch (error) {
      this.handleWriteError(error);
    }
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
  async openShift(tenantId: string, id: string): Promise<ShiftDto> {
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
    const shift = await this.getShift(tenantId, id); // 404 if cross-tenant/missing

    const productRow = await this.findProductRow(tenantId, shift.productId);
    if (!productRow) throw new NotFoundException("Shift product missing");
    const image = await this.findProductImage(tenantId, shift.productId);
    const product: ProductDto = {
      id: productRow.id,
      gtin14: productRow.gtin14,
      name: productRow.name,
      productGroup: productRow.productGroup,
      boxCapacity: productRow.boxCapacity,
      palletCapacity: productRow.palletCapacity,
      status: productRow.status,
      defaultCounterpartyId: productRow.defaultCounterpartyId,
      defaultLabelTemplateId: productRow.defaultLabelTemplateId,
      unitPrice: productRow.unitPrice,
      egaisCode: productRow.egaisCode,
      externalRef: productRow.externalRef,
      createdAt: productRow.createdAt,
      image,
    };

    const labelTemplate = await this.findLabelTemplate(tenantId, shift.labelTemplateId);
    // The box label's own template (Finding 3): resolved the exact same way
    // as `labelTemplate` above, from `shift.boxLabelTemplateId` -- a
    // completely separate column, with no fallback to the item template or
    // to any product-level default (products have no equivalent "default box
    // label template" column, unlike `defaultLabelTemplateId` for the item
    // template).
    const boxLabelTemplate = await this.findLabelTemplate(tenantId, shift.boxLabelTemplateId);

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

    // Aggregation shifts, and only for an actual station device. A
    // validation shift closes no boxes, so allocating for it would burn
    // serials nothing will ever print; a session caller has no device row to
    // attribute a block to (sscc_blocks.device_id is NOT NULL).
    const sscc: ShiftBundleDto["sscc"] =
      shift.mode === "aggregation" && deviceId
        ? await this.bundleSscc(tenantId, shift.id, deviceId)
        : null;

    return { shift, product, labelTemplate, boxLabelTemplate, counterpartyGln, operators, sscc };
  }

  /**
   * Resolves a label template id (tenant-scoped) into the `{ id, name, spec }`
   * shape both `ShiftBundleDto.labelTemplate` and `.boxLabelTemplate` share.
   * Null in, or a template this tenant does not own, both resolve to null --
   * never a fallback to any other template.
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
  ): Promise<ShiftBundleDto["sscc"]> {
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
      if (!shift || shift.status !== "active" || shift.mode !== "aggregation") return null;

      const access = await this.entitlements.resolveRecovery(tenantId, tx, new Date());
      if (access.access === "read_only") {
        const endsAt = access.subscription?.endsAt;
        if (!endsAt || !shift.openedAt || shift.openedAt >= endsAt) return null;
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
        return null;
      }
      try {
        return await this.sscc.allocateForBundle(
          tenantId,
          issuerPrefix,
          BOX_EXTENSION_DIGIT,
          deviceId,
          BOX_BLOCK_SIZE,
          tx,
        );
      } catch (error) {
        if (!(error instanceof SsccCapacityExhaustedException)) throw error;
        this.logger.warn(
          `Shift ${shiftId} (tenant ${tenantId}) bundle has no box serial block -- ${error.message}`,
        );
        return null;
      }
    });
  }

  private async findRow(tenantId: string, id: string): Promise<ShiftRow | undefined> {
    const [row] = await this.db
      .select()
      .from(schema.shifts)
      .where(and(eq(schema.shifts.tenantId, tenantId), eq(schema.shifts.id, id)));
    return row;
  }

  private async findProductRow(
    tenantId: string,
    productId: string,
  ): Promise<ProductRow | undefined> {
    const [row] = await this.db
      .select()
      .from(schema.products)
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

  private joinedSelection() {
    return {
      id: schema.shifts.id,
      status: schema.shifts.status,
      mode: schema.shifts.mode,
      productId: schema.shifts.productId,
      productName: schema.products.name,
      imageChecksum: schema.mediaAssets.checksum,
      imageByteSize: schema.mediaAssets.byteSize,
      imageWidth: schema.mediaAssets.width,
      imageHeight: schema.mediaAssets.height,
      lineId: schema.shifts.lineId,
      lineName: schema.lines.name,
      counterpartyId: schema.shifts.counterpartyId,
      counterpartyName: schema.counterparties.name,
      labelTemplateId: schema.shifts.labelTemplateId,
      labelTemplateName: schema.labelTemplates.name,
      ssccIssuerCounterpartyId: schema.shifts.ssccIssuerCounterpartyId,
      boxLabelTemplateId: schema.shifts.boxLabelTemplateId,
      plannedQty: schema.shifts.plannedQty,
      plannedDate: schema.shifts.plannedDate,
      boxCapacity: schema.shifts.boxCapacity,
      palletCapacity: schema.shifts.palletCapacity,
      palletsEnabled: schema.shifts.palletsEnabled,
      createdFrom: schema.shifts.createdFrom,
      openedAt: schema.shifts.openedAt,
      closedAt: schema.shifts.closedAt,
      closeReason: schema.shifts.closeReason,
      lateDataAt: schema.shifts.lateDataAt,
      createdAt: schema.shifts.createdAt,
    };
  }

  private mapShiftRow(row: JoinedShiftRow): ShiftDto {
    const { imageChecksum, imageByteSize, imageWidth, imageHeight, ...shift } = row;
    return {
      ...shift,
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

  /**
   * Catch PostgreSQL violations: unique 23505 -> 409; FK 23503 -> 400,
   * naming the referenced entity per FK constraint name (shifts has
   * composite FKs to products/lines/counterparties/label_templates --
   * see platform.ts).
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
      if (constraint === "shifts_tenant_label_template_fk") {
        throw new BadRequestException("Unknown label template for this organization");
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
