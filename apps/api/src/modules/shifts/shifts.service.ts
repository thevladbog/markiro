import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { and, eq, gte, lte } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import type {
  CloseShiftDto,
  CreateShiftDto,
  ListShiftsQueryDto,
  ListShiftsResponseDto,
  ShiftDto,
  ShiftMode,
  UpdateShiftDto,
} from "./dto";

type ShiftRow = typeof schema.shifts.$inferSelect;
type ProductRow = typeof schema.products.$inferSelect;

@Injectable()
export class ShiftsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** List a tenant's shifts, joined with product/line/counterparty names. */
  async listShifts(tenantId: string, query: ListShiftsQueryDto): Promise<ListShiftsResponseDto> {
    const conditions = [eq(schema.shifts.tenantId, tenantId)];

    if (query.status) conditions.push(eq(schema.shifts.status, query.status));
    if (query.lineId) conditions.push(eq(schema.shifts.lineId, query.lineId));
    if (query.from) conditions.push(gte(schema.shifts.plannedDate, query.from));
    if (query.to) conditions.push(lte(schema.shifts.plannedDate, query.to));

    const rows = await this.db
      .select(this.joinedSelection())
      .from(schema.shifts)
      .leftJoin(schema.products, eq(schema.shifts.productId, schema.products.id))
      .leftJoin(schema.lines, eq(schema.shifts.lineId, schema.lines.id))
      .leftJoin(schema.counterparties, eq(schema.shifts.counterpartyId, schema.counterparties.id))
      .where(and(...conditions))
      .orderBy(schema.shifts.createdAt);

    return { items: rows };
  }

  /** Get a single shift (joined), must belong to the tenant. */
  async getShift(tenantId: string, id: string): Promise<ShiftDto> {
    const [row] = await this.db
      .select(this.joinedSelection())
      .from(schema.shifts)
      .leftJoin(schema.products, eq(schema.shifts.productId, schema.products.id))
      .leftJoin(schema.lines, eq(schema.shifts.lineId, schema.lines.id))
      .leftJoin(schema.counterparties, eq(schema.shifts.counterpartyId, schema.counterparties.id))
      .where(and(eq(schema.shifts.tenantId, tenantId), eq(schema.shifts.id, id)));

    if (!row) {
      throw new NotFoundException();
    }
    return row;
  }

  /**
   * Create a shift. Server prefill (plan-03 contract): `boxCapacity`/
   * `palletCapacity`/`counterpartyId` default from the product when omitted
   * (`undefined`); an explicit `null` in the body opts out of the prefill.
   * Draft products are rejected outright (422) -- a product must be
   * "complete" (group + both capacities) before any shift can reference it.
   */
  async createShift(tenantId: string, data: CreateShiftDto): Promise<ShiftDto> {
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
      lineId: schema.shifts.lineId,
      lineName: schema.lines.name,
      counterpartyId: schema.shifts.counterpartyId,
      counterpartyName: schema.counterparties.name,
      plannedQty: schema.shifts.plannedQty,
      plannedDate: schema.shifts.plannedDate,
      boxCapacity: schema.shifts.boxCapacity,
      palletCapacity: schema.shifts.palletCapacity,
      palletsEnabled: schema.shifts.palletsEnabled,
      createdFrom: schema.shifts.createdFrom,
      openedAt: schema.shifts.openedAt,
      closedAt: schema.shifts.closedAt,
      closeReason: schema.shifts.closeReason,
      createdAt: schema.shifts.createdAt,
    };
  }

  /**
   * Catch PostgreSQL violations: unique 23505 -> 409; FK 23503 -> 400,
   * naming the referenced entity per FK constraint name (shifts has
   * composite FKs to products/lines/counterparties -- see platform.ts).
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
      throw new BadRequestException(
        "Referenced entity does not belong to this organization or does not exist",
      );
    }
    throw error;
  }
}
