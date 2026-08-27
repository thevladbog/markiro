import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import { EntitlementsService } from "../../subscriptions/entitlements.service";
import { generateDeviceToken, hashDeviceToken } from "../../pickup/device-token";
import type {
  CreateKioskDto,
  EnrollKioskResponseDto,
  KioskDto,
  ListKiosksResponseDto,
  SetKioskProductsDto,
  UpdateKioskDto,
} from "./dto";

type KioskRow = typeof schema.kiosks.$inferSelect;

export type KioskUpdateAuditAction = "kiosk.update" | "kiosk.archive" | "kiosk.unbind";

export interface UpdateKioskResult {
  kiosk: KioskDto;
  auditAction: KioskUpdateAuditAction;
}

@Injectable()
export class KiosksService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly entitlements: EntitlementsService,
  ) {}

  async listKiosks(tenantId: string): Promise<ListKiosksResponseDto> {
    const rows = await this.db
      .select()
      .from(schema.kiosks)
      .where(eq(schema.kiosks.tenantId, tenantId))
      .orderBy(schema.kiosks.name);
    const productIds = await this.productIdsFor(
      tenantId,
      rows.map((r) => r.id),
    );
    return { items: rows.map((r) => this.toDto(r, productIds.get(r.id) ?? [])) };
  }

  async createKiosk(tenantId: string, dto: CreateKioskDto): Promise<KioskDto> {
    const row = await this.db.transaction((tx) =>
      this.entitlements.withQuotaSlot(tx, tenantId, "kiosks", async () => {
        const [created] = await tx
          .insert(schema.kiosks)
          .values({
            tenantId,
            name: dto.name,
            location: dto.location ?? null,
            dayLimitPerEmployee: dto.dayLimitPerEmployee,
            showPrices: dto.showPrices,
            printEmployeeQrOnSlip: dto.printEmployeeQrOnSlip,
          })
          .returning();
        return created;
      }),
    );
    return this.toDto(row!, []);
  }

  async updateKiosk(tenantId: string, id: string, dto: UpdateKioskDto): Promise<UpdateKioskResult> {
    const set: Record<string, unknown> = {};
    if (dto.name !== undefined) set.name = dto.name;
    if (dto.location !== undefined) set.location = dto.location;
    if (dto.dayLimitPerEmployee !== undefined) set.dayLimitPerEmployee = dto.dayLimitPerEmployee;
    if (dto.showPrices !== undefined) set.showPrices = dto.showPrices;
    if (dto.printEmployeeQrOnSlip !== undefined)
      set.printEmployeeQrOnSlip = dto.printEmployeeQrOnSlip;
    if (dto.status !== undefined) set.status = dto.status;

    if (Object.keys(set).length === 0) {
      const row = await this.findRow(tenantId, id);
      if (!row) throw new NotFoundException();
      return {
        kiosk: this.toDto(row, await this.productIdsForOne(tenantId, id)),
        auditAction: "kiosk.update",
      };
    }

    let row: KioskRow | undefined;
    let auditAction: KioskUpdateAuditAction = "kiosk.update";
    if (dto.status === undefined) {
      row = await this.updateRow(tenantId, id, set);
    } else {
      const transition = await this.updateKioskStatus(tenantId, id, dto.status, set);
      row = transition.row;
      if (transition.previousStatus !== dto.status) {
        auditAction = dto.status === "archived" ? "kiosk.archive" : "kiosk.unbind";
      }
    }
    if (!row) throw new NotFoundException();
    return {
      kiosk: this.toDto(row, await this.productIdsForOne(tenantId, id)),
      auditAction,
    };
  }

  async archiveKiosk(tenantId: string, id: string): Promise<void> {
    await this.transitionKiosk(tenantId, id, "archived");
  }

  /**
   * Ends the device credential without discarding the durable kiosk or its
   * pickup history. Calling this on an archived kiosk is the explicit
   * reactivate-and-unbind recovery path; no previous hash can be restored.
   */
  async unbindKiosk(tenantId: string, id: string): Promise<void> {
    await this.transitionKiosk(tenantId, id, "active");
  }

  async setProducts(tenantId: string, id: string, dto: SetKioskProductsDto): Promise<KioskDto> {
    const row = await this.findRow(tenantId, id);
    if (!row) throw new NotFoundException();

    // The allowlist is a set of products; duplicate ids in the desired state are redundant, not
    // a client error. Dedupe before insert to avoid tripping kiosk_products_uq (23505).
    const uniqueIds = Array.from(new Set(dto.productIds));

    // Archived ("do not use") products must not be offered on a kiosk. The
    // admin UI already hides them from the section; this keeps a stale or
    // hand-crafted payload from re-listing one. Unknown ids still surface as
    // the FK violation handled in handleWriteError below.
    if (uniqueIds.length > 0) {
      const archivedRows = await this.db
        .select({ id: schema.products.id })
        .from(schema.products)
        .where(
          and(
            eq(schema.products.tenantId, tenantId),
            inArray(schema.products.id, uniqueIds),
            eq(schema.products.archived, true),
          ),
        );
      if (archivedRows.length > 0) {
        throw new BadRequestException("Archived products cannot be assigned to a kiosk");
      }
    }

    try {
      await this.db.transaction(async (tx) => {
        await tx
          .delete(schema.kioskProducts)
          .where(
            and(eq(schema.kioskProducts.tenantId, tenantId), eq(schema.kioskProducts.kioskId, id)),
          );
        if (uniqueIds.length > 0) {
          await tx
            .insert(schema.kioskProducts)
            .values(uniqueIds.map((productId) => ({ tenantId, kioskId: id, productId })));
        }
      });
    } catch (error) {
      this.handleWriteError(error);
    }

    return this.toDto(row, await this.productIdsForOne(tenantId, id));
  }

  async enroll(tenantId: string, id: string): Promise<EnrollKioskResponseDto> {
    const token = generateDeviceToken();
    await this.db.transaction(async (tx) => {
      const [kiosk] = await tx
        .select({ id: schema.kiosks.id, status: schema.kiosks.status })
        .from(schema.kiosks)
        .where(and(eq(schema.kiosks.tenantId, tenantId), eq(schema.kiosks.id, id)))
        .for("update");
      if (!kiosk || kiosk.status !== "active") throw new NotFoundException();

      await tx
        .update(schema.kiosks)
        .set({ deviceTokenHash: hashDeviceToken(token) })
        .where(and(eq(schema.kiosks.tenantId, tenantId), eq(schema.kiosks.id, id)));
    });
    return { token };
  }

  private async findRow(tenantId: string, id: string): Promise<KioskRow | undefined> {
    const [row] = await this.db
      .select()
      .from(schema.kiosks)
      .where(and(eq(schema.kiosks.tenantId, tenantId), eq(schema.kiosks.id, id)));
    return row;
  }

  private async updateRow(
    tenantId: string,
    id: string,
    set: Record<string, unknown>,
  ): Promise<KioskRow | undefined> {
    const [row] = await this.db
      .update(schema.kiosks)
      .set(set)
      .where(and(eq(schema.kiosks.tenantId, tenantId), eq(schema.kiosks.id, id)))
      .returning();
    return row;
  }

  /**
   * PATCH status classification and the lifecycle mutation share the same
   * locked pre-state, so the audit action cannot race a concurrent archive or
   * reactivation. An unchanged status is a metadata update and retains the
   * current credential; a real transition clears it and retires live codes.
   */
  private async updateKioskStatus(
    tenantId: string,
    id: string,
    status: "active" | "archived",
    fields: Record<string, unknown>,
  ): Promise<{ row: KioskRow; previousStatus: "active" | "archived" }> {
    const retiredAt = new Date();
    return this.db.transaction((tx) =>
      this.entitlements.withQuotaLock(tx, tenantId, "kiosks", async () => {
        const [current] = await tx
          .select({ id: schema.kiosks.id, status: schema.kiosks.status })
          .from(schema.kiosks)
          .where(and(eq(schema.kiosks.tenantId, tenantId), eq(schema.kiosks.id, id)))
          .for("update");
        if (!current) throw new NotFoundException();

        const statusChanged = current.status !== status;
        const mutate = async () => {
          const [row] = await tx
            .update(schema.kiosks)
            .set({ ...fields, status, ...(statusChanged ? { deviceTokenHash: null } : {}) })
            .where(and(eq(schema.kiosks.tenantId, tenantId), eq(schema.kiosks.id, id)))
            .returning();
          if (!row) throw new NotFoundException();

          if (statusChanged) {
            await tx
              .update(schema.kioskPairingCodes)
              .set({ usedAt: retiredAt })
              .where(
                and(
                  eq(schema.kioskPairingCodes.tenantId, tenantId),
                  eq(schema.kioskPairingCodes.kioskId, id),
                  isNull(schema.kioskPairingCodes.usedAt),
                ),
              );
          }
          return { row, previousStatus: current.status };
        };
        return current.status === "archived" && status === "active"
          ? this.entitlements.withQuotaSlot(tx, tenantId, "kiosks", mutate)
          : mutate();
      }),
    );
  }

  /**
   * Revocation state, token invalidation, and pairing-code retirement are one
   * tenant-scoped transaction. The same write remains safe to repeat: the row
   * persists, already-retired codes are not touched, and no credential exists
   * to revive when an archive is later made active again.
   */
  private async transitionKiosk(
    tenantId: string,
    id: string,
    status: "active" | "archived",
    fields: Record<string, unknown> = {},
  ): Promise<KioskRow> {
    const retiredAt = new Date();
    return this.db.transaction((tx) =>
      this.entitlements.withQuotaLock(tx, tenantId, "kiosks", async () => {
        const [current] = await tx
          .select({ id: schema.kiosks.id, status: schema.kiosks.status })
          .from(schema.kiosks)
          .where(and(eq(schema.kiosks.tenantId, tenantId), eq(schema.kiosks.id, id)))
          .for("update");
        if (!current) throw new NotFoundException();

        const mutate = async () => {
          const [row] = await tx
            .update(schema.kiosks)
            .set({ ...fields, status, deviceTokenHash: null })
            .where(and(eq(schema.kiosks.tenantId, tenantId), eq(schema.kiosks.id, id)))
            .returning();
          if (!row) throw new NotFoundException();

          await tx
            .update(schema.kioskPairingCodes)
            .set({ usedAt: retiredAt })
            .where(
              and(
                eq(schema.kioskPairingCodes.tenantId, tenantId),
                eq(schema.kioskPairingCodes.kioskId, id),
                isNull(schema.kioskPairingCodes.usedAt),
              ),
            );
          return row;
        };
        return current.status === "archived" && status === "active"
          ? this.entitlements.withQuotaSlot(tx, tenantId, "kiosks", mutate)
          : mutate();
      }),
    );
  }

  private async productIdsForOne(tenantId: string, kioskId: string): Promise<string[]> {
    const map = await this.productIdsFor(tenantId, [kioskId]);
    return map.get(kioskId) ?? [];
  }

  private async productIdsFor(
    tenantId: string,
    kioskIds: string[],
  ): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (kioskIds.length === 0) return map;
    const rows = await this.db
      .select()
      .from(schema.kioskProducts)
      .where(eq(schema.kioskProducts.tenantId, tenantId));
    const idSet = new Set(kioskIds);
    for (const r of rows) {
      if (!idSet.has(r.kioskId)) continue;
      const list = map.get(r.kioskId) ?? [];
      list.push(r.productId);
      map.set(r.kioskId, list);
    }
    return map;
  }

  /** 23503 on kiosk_products_tenant_product_fk -> 400 (unknown/foreign-tenant product). */
  private handleWriteError(error: unknown): never {
    const err = error as Error & { code?: string; constraint?: string; cause?: unknown };
    const cause = err?.cause as { code?: string; constraint?: string } | undefined;
    const errorCode = err?.code || cause?.code;
    const constraint = err?.constraint || cause?.constraint;

    if (errorCode === "23503" && constraint === "kiosk_products_tenant_product_fk") {
      throw new BadRequestException("Unknown product for this organization");
    }
    throw error;
  }

  private toDto(row: KioskRow, productIds: string[]): KioskDto {
    return {
      id: row.id,
      name: row.name,
      location: row.location,
      dayLimitPerEmployee: row.dayLimitPerEmployee,
      showPrices: row.showPrices,
      printEmployeeQrOnSlip: row.printEmployeeQrOnSlip,
      status: row.status,
      lastSeenAt: row.lastSeenAt,
      enrolled: row.deviceTokenHash !== null,
      productIds,
      createdAt: row.createdAt,
    };
  }
}
