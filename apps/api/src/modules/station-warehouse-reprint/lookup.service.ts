import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import {
  DomainError,
  formatLabelDate,
  formatShiftNumber,
  parseDuplicateKm,
  productLabelBytesDigest,
  productLabelValueDigest,
  resolveWarehouseReprintScan,
  warehouseSourceSchema,
  type LabelField,
  type WarehouseLookupRequest,
  type WarehouseLookupResult,
  type WarehouseReprintSource,
} from "@markiro/domain";
import { DB } from "../../auth/auth.module";
import { assertWarehouseDevice, assertWarehouseOperator, type WarehouseReader } from "./access";

function fields(
  product: typeof schema.products.$inferSelect,
  shift: typeof schema.shifts.$inferSelect,
  qty: number,
  date: string | null,
  raw: string,
  sscc: string,
): Record<LabelField, string> {
  return {
    "product.name": product.name,
    "product.printName": product.printName ?? product.name,
    "product.gtin": product.gtin14,
    "product.egais": product.egaisCode ?? "",
    "km.code": raw,
    sscc,
    "shift.no": formatShiftNumber({
      monthKey: shift.numberMonthKey,
      seq: shift.numberSeq,
      createdFrom: shift.createdFrom,
    }),
    date: date === null ? "" : formatLabelDate(date),
    expiry: "",
    qty: String(qty),
    "qty.boxes": "",
    operator: "",
    "counterparty.name": "",
  };
}
function source(
  value: Omit<WarehouseReprintSource, "revision" | "payloadDigest">,
): WarehouseReprintSource {
  const payload = value.kind === "unit" ? value.fields["km.code"] : value.fields.sscc;
  const snapshot = {
    ...value,
    payloadDigest: productLabelBytesDigest(new TextEncoder().encode(payload)),
  };
  return warehouseSourceSchema.parse({ ...snapshot, revision: productLabelValueDigest(snapshot) });
}
@Injectable()
export class WarehouseLookupService {
  constructor(@Inject(DB) private readonly db: Db) {}
  async lookup(
    tenantId: string,
    deviceId: string,
    input: WarehouseLookupRequest,
  ): Promise<WarehouseLookupResult> {
    await assertWarehouseDevice(this.db, tenantId, deviceId);
    await assertWarehouseOperator(this.db, tenantId, input.operatorId);
    const scan = resolveWarehouseReprintScan(input.raw);
    if (scan.kind === "invalid") throw new BadRequestException({ code: "WAREHOUSE_SCAN_INVALID" });
    return this.db.transaction(
      async (tx) => {
        if (scan.kind === "box") {
          const found = await this.boxSource(tx, tenantId, scan.sscc);
          return found.status === "found" ? { ...found, repair: scan.repair } : found;
        }
        const [row] = await tx
          .select({ code: schema.codes, shift: schema.shifts, product: schema.products })
          .from(schema.codeRegistry)
          .innerJoin(
            schema.codes,
            and(
              eq(schema.codes.tenantId, schema.codeRegistry.tenantId),
              eq(schema.codes.codeHash, schema.codeRegistry.codeHash),
              eq(schema.codes.shiftId, schema.codeRegistry.shiftId),
              eq(schema.codes.scannedAt, schema.codeRegistry.scannedAt),
            ),
          )
          .innerJoin(
            schema.shifts,
            and(
              eq(schema.shifts.tenantId, schema.codeRegistry.tenantId),
              eq(schema.shifts.id, schema.codeRegistry.shiftId),
            ),
          )
          .innerJoin(
            schema.products,
            and(
              eq(schema.products.tenantId, schema.shifts.tenantId),
              eq(schema.products.id, schema.shifts.productId),
            ),
          )
          .where(
            and(
              eq(schema.codeRegistry.tenantId, tenantId),
              eq(schema.codeRegistry.codeHash, scan.codeHash),
            ),
          );
        if (!row) return { status: "not_found" };
        if (row.shift.status === "planned")
          return { status: "unavailable", code: "source_not_printable" };
        try {
          parseDuplicateKm(row.code.canonicalRaw);
        } catch (error) {
          if (!(error instanceof DomainError)) throw error;
          return { status: "unavailable", code: "incomplete_km" };
        }
        const unavailable: LabelField[] = ["expiry", "operator", "counterparty.name"];
        if (row.shift.productionDate === null) unavailable.push("date");
        const result = source({
          kind: "unit",
          sourceId: scan.codeHash,
          identity: scan.codeHash,
          productName: row.product.name,
          chzProductGroupCode: row.product.chzProductGroupCode,
          fields: fields(
            row.product,
            row.shift,
            1,
            row.shift.productionDate,
            row.code.canonicalRaw,
            "",
          ),
          unavailableFields: unavailable,
          sourceShiftId: row.shift.id,
        });
        return { status: "found", source: result, repair: null };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  private async boxSource(
    db: WarehouseReader,
    tenantId: string,
    sscc: string,
  ): Promise<WarehouseLookupResult> {
    const [row] = await db
      .select({ box: schema.boxes, shift: schema.shifts, product: schema.products })
      .from(schema.boxes)
      .innerJoin(
        schema.shifts,
        and(
          eq(schema.shifts.tenantId, schema.boxes.tenantId),
          eq(schema.shifts.id, schema.boxes.shiftId),
        ),
      )
      .innerJoin(
        schema.products,
        and(
          eq(schema.products.tenantId, schema.shifts.tenantId),
          eq(schema.products.id, schema.shifts.productId),
        ),
      )
      .where(and(eq(schema.boxes.tenantId, tenantId), eq(schema.boxes.sscc, sscc)));
    const repack = await this.repackSource(db, tenantId, sscc);
    if (row && repack !== null) return { status: "unavailable", code: "ownership_conflict" };
    if (!row) {
      if (repack !== null) return repack;
      const [pallet] = await db
        .select({ id: schema.pallets.id })
        .from(schema.pallets)
        .where(and(eq(schema.pallets.tenantId, tenantId), eq(schema.pallets.sscc, sscc)));
      return pallet
        ? { status: "unavailable", code: "unsupported_pallet" }
        : { status: "not_found" };
    }
    if (
      row.box.closedAt === null ||
      row.box.disassembledAt !== null ||
      row.shift.status === "planned"
    )
      return { status: "unavailable", code: "source_not_printable" };
    const [count] = await db
      .select({ qty: sql<number>`count(*)::integer` })
      .from(schema.boxItems)
      .innerJoin(
        schema.codeRegistry,
        and(
          eq(schema.codeRegistry.tenantId, schema.boxItems.tenantId),
          eq(schema.codeRegistry.codeHash, schema.boxItems.codeHash),
          eq(schema.codeRegistry.shiftId, row.shift.id),
        ),
      )
      .where(
        and(
          eq(schema.boxItems.tenantId, tenantId),
          eq(schema.boxItems.boxId, row.box.id),
          isNull(schema.boxItems.displacedAt),
          isNull(schema.boxItems.removedAt),
        ),
      );
    const qty = count?.qty ?? 0;
    if (qty === 0) return { status: "unavailable", code: "source_not_printable" };
    const unavailable: LabelField[] = ["expiry", "operator", "counterparty.name"];
    if (row.shift.productionDate === null) unavailable.push("date");
    return {
      status: "found",
      repair: null,
      source: source({
        kind: "box",
        sourceId: row.box.id,
        identity: sscc,
        productName: row.product.name,
        chzProductGroupCode: row.product.chzProductGroupCode,
        fields: fields(row.product, row.shift, qty, row.shift.productionDate, "", sscc),
        unavailableFields: unavailable,
        sourceShiftId: row.shift.id,
      }),
    };
  }
  private async repackSource(
    db: WarehouseReader,
    tenantId: string,
    sscc: string,
  ): Promise<WarehouseLookupResult | null> {
    const [row] = await db
      .select({
        box: schema.inventoryRepackBoxes,
        inventory: schema.inventories,
        snapshot: schema.inventorySnapshots,
        product: schema.products,
      })
      .from(schema.inventoryRepackBoxes)
      .innerJoin(
        schema.inventories,
        and(
          eq(schema.inventories.tenantId, schema.inventoryRepackBoxes.tenantId),
          eq(schema.inventories.id, schema.inventoryRepackBoxes.inventoryId),
        ),
      )
      .innerJoin(
        schema.inventorySnapshots,
        and(
          eq(schema.inventorySnapshots.tenantId, schema.inventories.tenantId),
          eq(schema.inventorySnapshots.id, schema.inventories.activeSnapshotId),
        ),
      )
      .innerJoin(
        schema.products,
        and(
          eq(schema.products.tenantId, schema.inventories.tenantId),
          eq(schema.products.id, schema.inventories.productId),
        ),
      )
      .where(
        and(
          eq(schema.inventoryRepackBoxes.tenantId, tenantId),
          eq(schema.inventoryRepackBoxes.newSscc, sscc),
        ),
      );
    if (!row) return null;
    if (
      row.box.state !== "closed" ||
      row.box.closedAt === null ||
      !["running", "closed", "completed"].includes(row.inventory.status)
    )
      return { status: "unavailable", code: "source_not_printable" };
    const [count] = await db
      .select({ qty: sql<number>`count(*)::integer` })
      .from(schema.inventoryRepackItems)
      .innerJoin(
        schema.inventoryCodeResults,
        and(
          eq(schema.inventoryCodeResults.tenantId, schema.inventoryRepackItems.tenantId),
          eq(schema.inventoryCodeResults.id, schema.inventoryRepackItems.resultId),
          eq(schema.inventoryCodeResults.classification, "expected"),
        ),
      )
      .where(
        and(
          eq(schema.inventoryRepackItems.tenantId, tenantId),
          eq(schema.inventoryRepackItems.boxId, row.box.id),
          isNull(schema.inventoryRepackItems.removedAt),
        ),
      );
    const qty = count?.qty ?? 0;
    if (qty === 0) return { status: "unavailable", code: "source_not_printable" };
    const data: Record<LabelField, string> = {
      "product.name": row.snapshot.productName,
      "product.printName": row.snapshot.productName,
      "product.gtin": row.inventory.gtin14Snapshot,
      "product.egais": "",
      "km.code": "",
      sscc,
      "shift.no": "",
      date: formatLabelDate(row.box.productionDate),
      expiry: "",
      qty: String(qty),
      "qty.boxes": "",
      operator: "",
      "counterparty.name": "",
    };
    return {
      status: "found",
      repair: null,
      source: source({
        kind: "box",
        sourceId: row.box.id,
        identity: sscc,
        productName: row.snapshot.productName,
        chzProductGroupCode: row.product.chzProductGroupCode,
        fields: data,
        unavailableFields: [
          "product.printName",
          "product.egais",
          "expiry",
          "operator",
          "counterparty.name",
        ],
        sourceShiftId: null,
      }),
    };
  }
}
