import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, sql, type SQL } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { validatePickupKm } from "@markiro/domain";
import { DB } from "../../auth/auth.module";
import { nextOrderNo } from "../../pickup/order-number";
import type { PickupSlipData } from "../../pickup/slip";
import type {
  CreateOrderDto,
  CreateOrderResultDto,
  KioskBootstrapDto,
  ListPickupOrdersQueryDto,
  ListPickupOrdersResponseDto,
  OrderConflict,
  PickupOrderDetailDto,
  PickupOrderRowDto,
  ResolvePickupOrderDto,
} from "./dto";

/** An item that survived KM validation, allowlist resolution and in-request dedup. */
interface ResolvedItem {
  rawKm: string;
  productId: string;
  gtin14: string;
  serial: string;
  kmKey: string;
  unitPrice: string | null;
}

/** One item classified against `validatePickupKm`, still pending allowlist resolution. */
type ParsedItem =
  | { rawKm: string; ok: true; gtin14: string; serial: string; key: string }
  | { rawKm: string; ok: false; conflictReason: "not_km" | "incomplete" };

@Injectable()
export class PickupOrdersService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Authoritative kiosk create/sync path (brief's 7-step algorithm):
   * 1. idempotency on (tenantId, kioskId, deviceSeq)
   * 2. badge -> active employee
   * 3. writeoff reason validation
   * 4. per-item KM validation + allowlist resolution + in-request dedup
   * 5. per-employee day-limit
   * 6. transactional insert, retrying around a kmKey race (23505)
   * 7. return the outcome
   */
  async createFromKiosk(tenantId: string, kioskId: string, dto: CreateOrderDto): Promise<CreateOrderResultDto> {
    // 1. Idempotency: a replayed sync for the same device sequence returns the same order, unchanged.
    const [existing] = await this.db
      .select()
      .from(schema.pickupOrders)
      .where(and(
        eq(schema.pickupOrders.tenantId, tenantId),
        eq(schema.pickupOrders.kioskId, kioskId),
        eq(schema.pickupOrders.deviceSeq, dto.deviceSeq),
      ));
    if (existing) {
      return { orderNo: existing.orderNo, status: "pending", itemCount: existing.itemCount, conflicts: [] };
    }

    // 2. Badge -> active employee (badge's revoked_at is null). Unknown -> 401 ("bad badge" on the kiosk).
    const employeeId = await this.resolveActiveEmployeeId(tenantId, dto.badgeCode);
    if (!employeeId) throw new UnauthorizedException("Unknown badge");

    // 3. Writeoff orders require a non-archived reason belonging to this tenant.
    const writeoffReasonId = await this.resolveWriteoffReasonId(tenantId, dto);

    // 4. Per-item KM validation, allowlist resolution and in-request dedup.
    const { conflicts, candidates } = await this.resolveItems(tenantId, kioskId, dto.items);

    // 5. Day-limit: accept up to dayLimitPerEmployee, flag the rest as over_limit.
    const when = dto.createdAt ? new Date(dto.createdAt) : new Date();
    const { accepted, overflowConflicts } = await this.applyDayLimit(tenantId, kioskId, employeeId, when, candidates);
    conflicts.push(...overflowConflicts);

    // 6. Transactional insert; a kmKey race against another open order converts that item to a duplicate conflict.
    const order = await this.insertOrderWithRetry(
      tenantId, kioskId, employeeId, dto.reason, writeoffReasonId, dto.deviceSeq, when, accepted, conflicts,
    );

    // 7. Outcome. (A device-seq race outcome carries its own `conflicts: []`, mirroring the
    // sequential idempotent path — this request's own conflicts belong to a duplicate submission.)
    return { orderNo: order.orderNo, status: "pending", itemCount: order.itemCount, conflicts: order.conflicts ?? conflicts };
  }

  /** Offline-cache payload: everything a kiosk needs to operate without a round-trip per scan. */
  async bootstrap(tenantId: string, kioskId: string): Promise<KioskBootstrapDto> {
    const [kiosk] = await this.db
      .select({ dayLimitPerEmployee: schema.kiosks.dayLimitPerEmployee, showPrices: schema.kiosks.showPrices })
      .from(schema.kiosks)
      .where(and(eq(schema.kiosks.tenantId, tenantId), eq(schema.kiosks.id, kioskId)));

    const reasons = await this.db
      .select({ id: schema.pickupOrderReasons.id, name: schema.pickupOrderReasons.name })
      .from(schema.pickupOrderReasons)
      .where(and(eq(schema.pickupOrderReasons.tenantId, tenantId), eq(schema.pickupOrderReasons.archived, false)))
      .orderBy(asc(schema.pickupOrderReasons.sortOrder), asc(schema.pickupOrderReasons.name));

    const products = await this.db
      .select({
        id: schema.products.id, gtin14: schema.products.gtin14, name: schema.products.name,
        unitPrice: schema.products.unitPrice, egaisCode: schema.products.egaisCode,
      })
      .from(schema.kioskProducts)
      .innerJoin(schema.products, and(
        eq(schema.products.tenantId, schema.kioskProducts.tenantId),
        eq(schema.products.id, schema.kioskProducts.productId),
      ))
      .where(and(eq(schema.kioskProducts.tenantId, tenantId), eq(schema.kioskProducts.kioskId, kioskId)));

    const employeeRows = await this.db
      .select()
      .from(schema.employees)
      .where(and(eq(schema.employees.tenantId, tenantId), eq(schema.employees.status, "active")))
      .orderBy(asc(schema.employees.fullName));
    const badgeRows = await this.db
      .select({ employeeId: schema.employeeBadges.employeeId, badgeCode: schema.employeeBadges.badgeCode })
      .from(schema.employeeBadges)
      .where(and(eq(schema.employeeBadges.tenantId, tenantId), isNull(schema.employeeBadges.revokedAt)));
    const badgesByEmployee = new Map<string, string[]>();
    for (const b of badgeRows) {
      const list = badgesByEmployee.get(b.employeeId) ?? [];
      list.push(b.badgeCode);
      badgesByEmployee.set(b.employeeId, list);
    }

    return {
      config: {
        dayLimitPerEmployee: kiosk?.dayLimitPerEmployee ?? 0,
        showPrices: kiosk?.showPrices ?? true,
      },
      reasons,
      products,
      employees: employeeRows.map((e) => ({
        id: e.id, fullName: e.fullName, role: e.role, badgeCodes: badgesByEmployee.get(e.id) ?? [],
      })),
    };
  }

  /** Admin list, joined with employee/kiosk/writeoff-reason names, newest first. */
  async list(tenantId: string, query: ListPickupOrdersQueryDto): Promise<ListPickupOrdersResponseDto> {
    const conditions: SQL[] = [eq(schema.pickupOrders.tenantId, tenantId)];
    if (query.status) conditions.push(eq(schema.pickupOrders.status, query.status));
    if (query.reason) conditions.push(eq(schema.pickupOrders.reason, query.reason));
    if (query.from) conditions.push(gte(schema.pickupOrders.createdAt, new Date(`${query.from}T00:00:00.000Z`)));
    if (query.to) conditions.push(lte(schema.pickupOrders.createdAt, new Date(`${query.to}T23:59:59.999Z`)));

    const rows = await this.queryJoinedRows(conditions);
    return { items: rows.map((row) => this.mapRowDto(row)) };
  }

  /** Admin detail: joined row + the employee's active badge code + items (with product names). */
  async detail(tenantId: string, id: string): Promise<PickupOrderDetailDto> {
    const [row] = await this.db
      .select({
        ...this.joinedSelection(),
        employeeId: schema.pickupOrders.employeeId,
        receiptNo: schema.pickupOrders.receiptNo,
        actNo: schema.pickupOrders.actNo,
      })
      .from(schema.pickupOrders)
      .leftJoin(schema.employees, eq(schema.employees.id, schema.pickupOrders.employeeId))
      .leftJoin(schema.kiosks, eq(schema.kiosks.id, schema.pickupOrders.kioskId))
      .leftJoin(schema.pickupOrderReasons, eq(schema.pickupOrderReasons.id, schema.pickupOrders.writeoffReasonId))
      .where(and(eq(schema.pickupOrders.tenantId, tenantId), eq(schema.pickupOrders.id, id)));

    if (!row) throw new NotFoundException();

    const [badge] = await this.db
      .select({ badgeCode: schema.employeeBadges.badgeCode })
      .from(schema.employeeBadges)
      .where(and(
        eq(schema.employeeBadges.tenantId, tenantId),
        eq(schema.employeeBadges.employeeId, row.employeeId),
        isNull(schema.employeeBadges.revokedAt),
      ));

    const itemRows = await this.db
      .select({
        id: schema.pickupOrderItems.id,
        gtin14: schema.pickupOrderItems.gtin14,
        serial: schema.pickupOrderItems.serial,
        rawKm: schema.pickupOrderItems.rawKm,
        productName: schema.products.name,
        unitPrice: schema.pickupOrderItems.unitPrice,
      })
      .from(schema.pickupOrderItems)
      .leftJoin(schema.products, eq(schema.products.id, schema.pickupOrderItems.productId))
      .where(and(eq(schema.pickupOrderItems.tenantId, tenantId), eq(schema.pickupOrderItems.orderId, id)));

    return {
      ...this.mapRowDto(row),
      employeeBadgeCode: badge?.badgeCode ?? null,
      items: itemRows.map((item) => ({
        id: item.id,
        gtin14: item.gtin14,
        serial: item.serial,
        rawKm: item.rawKm,
        productName: item.productName ?? "",
        unitPrice: item.unitPrice,
      })),
      receiptNo: row.receiptNo,
      actNo: row.actNo,
    };
  }

  /**
   * Gathers everything `renderPickupSlipHtml` needs for the printed A4 slip:
   * the order + its (non-voided) items joined with product names, the
   * employee's currently-active badge (may be none), and this tenant's
   * `organization` name + `orgProfiles` INN (the profile row may not exist
   * yet — org comes back null in that case, not a 404).
   */
  async slipData(tenantId: string, id: string): Promise<PickupSlipData> {
    const [row] = await this.db
      .select({
        orderNo: schema.pickupOrders.orderNo,
        createdAt: schema.pickupOrders.createdAt,
        reason: schema.pickupOrders.reason,
        totalPrice: schema.pickupOrders.totalPrice,
        employeeId: schema.pickupOrders.employeeId,
        employeeFullName: schema.employees.fullName,
        employeeRole: schema.employees.role,
        kioskName: schema.kiosks.name,
        writeoffReasonName: schema.pickupOrderReasons.name,
      })
      .from(schema.pickupOrders)
      .leftJoin(schema.employees, eq(schema.employees.id, schema.pickupOrders.employeeId))
      .leftJoin(schema.kiosks, eq(schema.kiosks.id, schema.pickupOrders.kioskId))
      .leftJoin(schema.pickupOrderReasons, eq(schema.pickupOrderReasons.id, schema.pickupOrders.writeoffReasonId))
      .where(and(eq(schema.pickupOrders.tenantId, tenantId), eq(schema.pickupOrders.id, id)));

    if (!row) throw new NotFoundException();

    const [badge] = await this.db
      .select({ badgeCode: schema.employeeBadges.badgeCode })
      .from(schema.employeeBadges)
      .where(and(
        eq(schema.employeeBadges.tenantId, tenantId),
        eq(schema.employeeBadges.employeeId, row.employeeId),
        isNull(schema.employeeBadges.revokedAt),
      ));

    const [org] = await this.db
      .select({ name: schema.organization.name, inn: schema.orgProfiles.inn })
      .from(schema.organization)
      .leftJoin(schema.orgProfiles, eq(schema.orgProfiles.tenantId, schema.organization.id))
      .where(eq(schema.organization.id, tenantId));

    const itemRows = await this.db
      .select({
        gtin14: schema.pickupOrderItems.gtin14,
        serial: schema.pickupOrderItems.serial,
        rawKm: schema.pickupOrderItems.rawKm,
        productName: schema.products.name,
        unitPrice: schema.pickupOrderItems.unitPrice,
      })
      .from(schema.pickupOrderItems)
      .leftJoin(schema.products, eq(schema.products.id, schema.pickupOrderItems.productId))
      .where(and(
        eq(schema.pickupOrderItems.tenantId, tenantId),
        eq(schema.pickupOrderItems.orderId, id),
        eq(schema.pickupOrderItems.voided, false),
      ))
      .orderBy(asc(schema.pickupOrderItems.scannedAt));

    return {
      orderNo: row.orderNo,
      createdAt: row.createdAt,
      org: org ? { name: org.name, inn: org.inn } : null,
      employee: {
        fullName: row.employeeFullName ?? "",
        role: row.employeeRole,
        badgeCode: badge?.badgeCode ?? null,
      },
      kioskName: row.kioskName ?? "",
      reason: row.reason,
      writeoffReasonName: row.writeoffReasonName,
      total: row.totalPrice,
      items: itemRows.map((item, index) => ({
        n: index + 1,
        productName: item.productName ?? "",
        gtin14: item.gtin14,
        serial: item.serial,
        rawKm: item.rawKm,
        unitPrice: item.unitPrice,
      })),
    };
  }

  /**
   * Resolve a pending order: `punch` records the receipt number; `writeoff`
   * requires a writeoff reason (supplied — validated against this tenant,
   * else inherited from the order's own `writeoffReasonId` — else 400) and
   * records the act number. Either way, must currently be `pending` (409
   * otherwise), and records who resolved it (`resolvedByUserId`, threaded
   * from `TenantGuard`).
   */
  async resolve(
    tenantId: string,
    id: string,
    dto: ResolvePickupOrderDto,
    userId: string,
  ): Promise<PickupOrderRowDto> {
    const current = await this.findRow(tenantId, id);
    if (!current) throw new NotFoundException();
    if (current.status !== "pending") {
      throw new ConflictException("Order can only be resolved while pending");
    }

    const resolvedAt = new Date();
    const pendingCondition = and(
      eq(schema.pickupOrders.tenantId, tenantId),
      eq(schema.pickupOrders.id, id),
      eq(schema.pickupOrders.status, "pending"),
    );

    let updatedId: string | undefined;
    if (dto.action === "punch") {
      const [row] = await this.db
        .update(schema.pickupOrders)
        .set({ status: "punched", receiptNo: dto.receiptNo ?? null, resolvedAt, resolvedByUserId: userId })
        .where(pendingCondition)
        .returning({ id: schema.pickupOrders.id });
      updatedId = row?.id;
    } else {
      const writeoffReasonId = dto.writeoffReasonId ?? current.writeoffReasonId;
      if (!writeoffReasonId) {
        throw new BadRequestException("writeoffReasonId is required to write off this order");
      }
      if (dto.writeoffReasonId) {
        await this.assertValidWriteoffReason(tenantId, dto.writeoffReasonId);
      }
      const [row] = await this.db
        .update(schema.pickupOrders)
        .set({ status: "writtenoff", actNo: dto.actNo ?? null, writeoffReasonId, resolvedAt, resolvedByUserId: userId })
        .where(pendingCondition)
        .returning({ id: schema.pickupOrders.id });
      updatedId = row?.id;
    }

    if (!updatedId) throw new ConflictException("Order can only be resolved while pending");
    return this.rowDtoById(tenantId, updatedId);
  }

  /**
   * Export raw KMs from the specified orders. Each item's rawKm is on a separate line.
   * Order IDs that don't belong to this tenant are silently excluded (no error).
   * Returns one rawKm per line, joined by newlines, preserving GS bytes.
   */
  async exportCodes(tenantId: string, orderIds: string[]): Promise<string> {
    if (orderIds.length === 0) return "";

    const rows = await this.db
      .select({ rawKm: schema.pickupOrderItems.rawKm })
      .from(schema.pickupOrderItems)
      .where(and(
        eq(schema.pickupOrderItems.tenantId, tenantId),
        inArray(schema.pickupOrderItems.orderId, orderIds),
      ))
      .orderBy(asc(schema.pickupOrderItems.orderId), asc(schema.pickupOrderItems.scannedAt));

    return rows.map((r) => r.rawKm).join("\n");
  }

  /**
   * Cancel a pending order (409 otherwise) and void its items in the same
   * transaction — voiding frees the partial-unique index on `kmKey`, so a
   * cancelled code can be re-scanned into a new order.
   */
  async cancel(tenantId: string, id: string): Promise<PickupOrderRowDto> {
    const cancelledId = await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select({ status: schema.pickupOrders.status })
        .from(schema.pickupOrders)
        .where(and(eq(schema.pickupOrders.tenantId, tenantId), eq(schema.pickupOrders.id, id)));

      if (!current) throw new NotFoundException();
      if (current.status !== "pending") {
        throw new ConflictException("Order can only be cancelled while pending");
      }

      const [row] = await tx
        .update(schema.pickupOrders)
        .set({ status: "cancelled" })
        .where(and(
          eq(schema.pickupOrders.tenantId, tenantId),
          eq(schema.pickupOrders.id, id),
          eq(schema.pickupOrders.status, "pending"),
        ))
        .returning({ id: schema.pickupOrders.id });

      if (!row) throw new ConflictException("Order can only be cancelled while pending");

      await tx
        .update(schema.pickupOrderItems)
        .set({ voided: true })
        .where(and(eq(schema.pickupOrderItems.tenantId, tenantId), eq(schema.pickupOrderItems.orderId, id)));

      return row.id;
    });

    return this.rowDtoById(tenantId, cancelledId);
  }

  /** A writeoffReasonId explicitly supplied to /resolve must belong to this tenant. */
  private async assertValidWriteoffReason(tenantId: string, writeoffReasonId: string): Promise<void> {
    const [reason] = await this.db
      .select({ id: schema.pickupOrderReasons.id })
      .from(schema.pickupOrderReasons)
      .where(and(eq(schema.pickupOrderReasons.tenantId, tenantId), eq(schema.pickupOrderReasons.id, writeoffReasonId)));
    if (!reason) throw new BadRequestException("Unknown writeoff reason for this organization");
  }

  private async findRow(tenantId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(schema.pickupOrders)
      .where(and(eq(schema.pickupOrders.tenantId, tenantId), eq(schema.pickupOrders.id, id)));
    return row;
  }

  private async rowDtoById(tenantId: string, id: string): Promise<PickupOrderRowDto> {
    const rows = await this.queryJoinedRows([
      eq(schema.pickupOrders.tenantId, tenantId),
      eq(schema.pickupOrders.id, id),
    ]);
    const row = rows[0];
    if (!row) throw new NotFoundException();
    return this.mapRowDto(row);
  }

  private async queryJoinedRows(conditions: SQL[]) {
    return this.db
      .select(this.joinedSelection())
      .from(schema.pickupOrders)
      .leftJoin(schema.employees, eq(schema.employees.id, schema.pickupOrders.employeeId))
      .leftJoin(schema.kiosks, eq(schema.kiosks.id, schema.pickupOrders.kioskId))
      .leftJoin(schema.pickupOrderReasons, eq(schema.pickupOrderReasons.id, schema.pickupOrders.writeoffReasonId))
      .where(and(...conditions))
      .orderBy(desc(schema.pickupOrders.createdAt));
  }

  private joinedSelection() {
    return {
      id: schema.pickupOrders.id,
      orderNo: schema.pickupOrders.orderNo,
      employeeName: schema.employees.fullName,
      kioskName: schema.kiosks.name,
      reason: schema.pickupOrders.reason,
      writeoffReasonName: schema.pickupOrderReasons.name,
      itemCount: schema.pickupOrders.itemCount,
      totalPrice: schema.pickupOrders.totalPrice,
      status: schema.pickupOrders.status,
      createdAt: schema.pickupOrders.createdAt,
    };
  }

  private mapRowDto(row: {
    id: string;
    orderNo: string;
    employeeName: string | null;
    kioskName: string | null;
    reason: "buy" | "writeoff";
    writeoffReasonName: string | null;
    itemCount: number;
    totalPrice: string | null;
    status: "pending" | "punched" | "writtenoff" | "cancelled";
    createdAt: Date;
  }): PickupOrderRowDto {
    return {
      id: row.id,
      orderNo: row.orderNo,
      employeeName: row.employeeName ?? "",
      kioskName: row.kioskName ?? "",
      reason: row.reason,
      writeoffReasonName: row.writeoffReasonName,
      itemCount: row.itemCount,
      totalPrice: row.totalPrice,
      status: row.status,
      createdAt: row.createdAt,
    };
  }

  private async resolveActiveEmployeeId(tenantId: string, badgeCode: string): Promise<string | undefined> {
    const [badge] = await this.db
      .select({ employeeId: schema.employeeBadges.employeeId })
      .from(schema.employeeBadges)
      .innerJoin(schema.employees, and(
        eq(schema.employees.tenantId, schema.employeeBadges.tenantId),
        eq(schema.employees.id, schema.employeeBadges.employeeId),
      ))
      .where(and(
        eq(schema.employeeBadges.tenantId, tenantId),
        eq(schema.employeeBadges.badgeCode, badgeCode),
        isNull(schema.employeeBadges.revokedAt),
        eq(schema.employees.status, "active"),
      ));
    return badge?.employeeId;
  }

  private async resolveWriteoffReasonId(tenantId: string, dto: CreateOrderDto): Promise<string | null> {
    if (dto.reason !== "writeoff") return null;
    if (!dto.writeoffReasonId) {
      throw new BadRequestException("writeoffReasonId is required when reason is writeoff");
    }
    const [reason] = await this.db
      .select({ id: schema.pickupOrderReasons.id })
      .from(schema.pickupOrderReasons)
      .where(and(
        eq(schema.pickupOrderReasons.tenantId, tenantId),
        eq(schema.pickupOrderReasons.id, dto.writeoffReasonId),
        eq(schema.pickupOrderReasons.archived, false),
      ));
    if (!reason) throw new BadRequestException("Unknown or archived writeoff reason");
    return reason.id;
  }

  /** Classifies every scan, resolves it against this kiosk's allowlist, and dedups within the request. */
  private async resolveItems(
    tenantId: string,
    kioskId: string,
    items: CreateOrderDto["items"],
  ): Promise<{ conflicts: OrderConflict[]; candidates: ResolvedItem[] }> {
    const parsed: ParsedItem[] = items.map((item) => {
      const result = validatePickupKm(item.rawKm);
      if (result.status === "not_km" || result.status === "incomplete") {
        return { rawKm: item.rawKm, ok: false, conflictReason: result.status };
      }
      return { rawKm: item.rawKm, ok: true, gtin14: result.km.gtin14, serial: result.km.serial, key: result.key };
    });

    const allowlist = await this.kioskAllowlist(tenantId, kioskId);
    const gtinsToCheck = new Set<string>();
    for (const p of parsed) {
      if (p.ok && !allowlist.has(p.gtin14)) gtinsToCheck.add(p.gtin14);
    }
    const existingGtins = gtinsToCheck.size > 0
      ? await this.existingProductGtins(tenantId, Array.from(gtinsToCheck))
      : new Set<string>();

    const conflicts: OrderConflict[] = [];
    const seenKeys = new Set<string>();
    const candidates: ResolvedItem[] = [];
    for (const p of parsed) {
      if (!p.ok) {
        conflicts.push({ rawKm: p.rawKm, reason: p.conflictReason });
        continue;
      }
      const allowed = allowlist.get(p.gtin14);
      if (!allowed) {
        conflicts.push({ rawKm: p.rawKm, reason: existingGtins.has(p.gtin14) ? "not_allowed" : "unknown_product" });
        continue;
      }
      if (seenKeys.has(p.key)) {
        conflicts.push({ rawKm: p.rawKm, reason: "duplicate" });
        continue;
      }
      seenKeys.add(p.key);
      candidates.push({
        rawKm: p.rawKm, productId: allowed.productId, gtin14: p.gtin14, serial: p.serial,
        kmKey: p.key, unitPrice: allowed.unitPrice,
      });
    }
    return { conflicts, candidates };
  }

  private async kioskAllowlist(
    tenantId: string,
    kioskId: string,
  ): Promise<Map<string, { productId: string; unitPrice: string | null }>> {
    const rows = await this.db
      .select({ productId: schema.products.id, gtin14: schema.products.gtin14, unitPrice: schema.products.unitPrice })
      .from(schema.kioskProducts)
      .innerJoin(schema.products, and(
        eq(schema.products.tenantId, schema.kioskProducts.tenantId),
        eq(schema.products.id, schema.kioskProducts.productId),
      ))
      .where(and(eq(schema.kioskProducts.tenantId, tenantId), eq(schema.kioskProducts.kioskId, kioskId)));
    const map = new Map<string, { productId: string; unitPrice: string | null }>();
    for (const r of rows) map.set(r.gtin14, { productId: r.productId, unitPrice: r.unitPrice });
    return map;
  }

  private async existingProductGtins(tenantId: string, gtins: string[]): Promise<Set<string>> {
    if (gtins.length === 0) return new Set();
    const rows = await this.db
      .select({ gtin14: schema.products.gtin14 })
      .from(schema.products)
      .where(and(eq(schema.products.tenantId, tenantId), inArray(schema.products.gtin14, gtins)));
    return new Set(rows.map((r) => r.gtin14));
  }

  /** Accepts up to `dayLimitPerEmployee` items for today (UTC), flagging the rest `over_limit`. */
  private async applyDayLimit(
    tenantId: string,
    kioskId: string,
    employeeId: string,
    when: Date,
    candidates: ResolvedItem[],
  ): Promise<{ accepted: ResolvedItem[]; overflowConflicts: OrderConflict[] }> {
    const [kiosk] = await this.db
      .select({ dayLimitPerEmployee: schema.kiosks.dayLimitPerEmployee })
      .from(schema.kiosks)
      .where(and(eq(schema.kiosks.tenantId, tenantId), eq(schema.kiosks.id, kioskId)));
    const dayLimit = kiosk?.dayLimitPerEmployee ?? 0;

    const dateStr = when.toISOString().slice(0, 10);
    const existingRows = await this.db
      .select({ id: schema.pickupOrderItems.id })
      .from(schema.pickupOrderItems)
      .innerJoin(schema.pickupOrders, and(
        eq(schema.pickupOrders.tenantId, schema.pickupOrderItems.tenantId),
        eq(schema.pickupOrders.id, schema.pickupOrderItems.orderId),
      ))
      .where(and(
        eq(schema.pickupOrderItems.tenantId, tenantId),
        eq(schema.pickupOrders.employeeId, employeeId),
        ne(schema.pickupOrders.status, "cancelled"),
        eq(schema.pickupOrderItems.voided, false),
        sql`(${schema.pickupOrders.createdAt} at time zone 'utc')::date = ${dateStr}`,
      ));
    let count = existingRows.length;

    const accepted: ResolvedItem[] = [];
    const overflowConflicts: OrderConflict[] = [];
    for (const c of candidates) {
      if (count < dayLimit) {
        accepted.push(c);
        count++;
      } else {
        overflowConflicts.push({ rawKm: c.rawKm, reason: "over_limit" });
      }
    }
    return { accepted, overflowConflicts };
  }

  /**
   * Inserts the order + accepted items in a transaction. If insertion loses a race against
   * another open order for the same kmKey (23505 on pickup_order_items_tenant_kmkey_open_uq),
   * converts every now-conflicting item to a `duplicate` conflict and retries without them.
   *
   * A separate race is possible on (tenantId, kioskId, deviceSeq) itself: two truly-concurrent
   * POSTs with the same idempotency key both pass the pre-SELECT in `createFromKiosk` (TOCTOU),
   * so the loser's INSERT hits `pickup_orders_kiosk_device_seq_uq` (23505). That is NOT a
   * conflict to surface — it means another request already created the order this one wants;
   * re-fetch and return the winner's outcome instead of erroring or creating a duplicate order.
   */
  private async insertOrderWithRetry(
    tenantId: string,
    kioskId: string,
    employeeId: string,
    reason: "buy" | "writeoff",
    writeoffReasonId: string | null,
    deviceSeq: number,
    when: Date,
    items: ResolvedItem[],
    conflicts: OrderConflict[],
  ): Promise<{ orderNo: string; itemCount: number; conflicts?: OrderConflict[] }> {
    let remaining = items;
    for (;;) {
      try {
        return await this.db.transaction(async (tx) => {
          // nextOrderNo's `tx` param is deliberately loosely typed (Task 7) so it
          // doesn't have to import drizzle's transaction type; adapt the real
          // transaction handle's `execute` to that shape at the call site instead
          // of widening `order-number.ts`'s own signature.
          const orderNo = await nextOrderNo(
            { execute: (q) => tx.execute<{ seq: number }>(q as Parameters<typeof tx.execute>[0]) },
            tenantId,
            when,
          );
          const [order] = await tx
            .insert(schema.pickupOrders)
            .values({
              tenantId, orderNo, kioskId, employeeId, reason,
              writeoffReasonId, status: "pending", itemCount: remaining.length,
              totalPrice: this.computeTotalPrice(remaining), deviceSeq, createdAt: when,
            })
            .returning();
          if (!order) throw new Error("Failed to insert pickup order");
          if (remaining.length > 0) {
            await tx.insert(schema.pickupOrderItems).values(remaining.map((item) => ({
              tenantId, orderId: order.id, productId: item.productId, gtin14: item.gtin14,
              serial: item.serial, rawKm: item.rawKm, kmKey: item.kmKey,
              unitPrice: item.unitPrice, scannedAt: when,
            })));
          }
          return { orderNo: order.orderNo, itemCount: order.itemCount };
        });
      } catch (error) {
        if (this.isDeviceSeqRace(error)) {
          const [winner] = await this.db
            .select()
            .from(schema.pickupOrders)
            .where(and(
              eq(schema.pickupOrders.tenantId, tenantId),
              eq(schema.pickupOrders.kioskId, kioskId),
              eq(schema.pickupOrders.deviceSeq, deviceSeq),
            ));
          if (!winner) throw error; // shouldn't happen, but avoid looping forever
          return { orderNo: winner.orderNo, itemCount: winner.itemCount, conflicts: [] };
        }

        if (!this.isKmKeyRace(error) || remaining.length === 0) throw error;

        const keys = remaining.map((i) => i.kmKey);
        const openRows = await this.db
          .select({ kmKey: schema.pickupOrderItems.kmKey })
          .from(schema.pickupOrderItems)
          .where(and(
            eq(schema.pickupOrderItems.tenantId, tenantId),
            eq(schema.pickupOrderItems.voided, false),
            inArray(schema.pickupOrderItems.kmKey, keys),
          ));
        const conflictingKeys = new Set(openRows.map((r) => r.kmKey));
        if (conflictingKeys.size === 0) throw error; // shouldn't happen, but avoid looping forever

        const stillOk: ResolvedItem[] = [];
        for (const item of remaining) {
          if (conflictingKeys.has(item.kmKey)) {
            conflicts.push({ rawKm: item.rawKm, reason: "duplicate" });
          } else {
            stillOk.push(item);
          }
        }
        remaining = stillOk;
      }
    }
  }

  private computeTotalPrice(items: ResolvedItem[]): string | null {
    if (items.length === 0) return null;
    let sum = 0;
    for (const item of items) {
      if (item.unitPrice === null) return null;
      sum += Number(item.unitPrice);
    }
    return sum.toFixed(2);
  }

  /** 23505 on pickup_order_items_tenant_kmkey_open_uq -> the code is already open in another order. */
  private isKmKeyRace(error: unknown): boolean {
    const err = error as Error & { code?: string; constraint?: string; cause?: unknown };
    const cause = err?.cause as { code?: string; constraint?: string } | undefined;
    const code = err?.code || cause?.code;
    const constraint = err?.constraint || cause?.constraint;
    return code === "23505" && constraint === "pickup_order_items_tenant_kmkey_open_uq";
  }

  /** 23505 on pickup_orders_kiosk_device_seq_uq -> lost the idempotency race to a concurrent identical POST. */
  private isDeviceSeqRace(error: unknown): boolean {
    const err = error as Error & { code?: string; constraint?: string; cause?: unknown };
    const cause = err?.cause as { code?: string; constraint?: string } | undefined;
    const code = err?.code || cause?.code;
    const constraint = err?.constraint || cause?.constraint;
    return code === "23505" && constraint === "pickup_orders_kiosk_device_seq_uq";
  }
}
