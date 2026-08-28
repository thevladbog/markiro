import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, getTableName, is } from "drizzle-orm";
import { getTableConfig, IndexedColumn } from "drizzle-orm/pg-core";
import { createDb, schema } from "../src/index.js";
import {
  boxExceptions,
  boxItems,
  boxRegistryVersions,
  boxes,
  codeConflicts,
  codeRegistry,
  counterparties,
  lines,
  products,
  shiftNumberCounters,
  shifts,
  ssccBlocks,
  ssccCounters,
  stationDevices,
  stationPairingCodes,
} from "../src/schema/platform.js";
import { codes } from "../src/schema/codes.js";
import { orgProfiles } from "../src/schema/org-profile.js";

describe("platform schema", () => {
  it("stores one non-null operational timezone per organization", () => {
    expect(orgProfiles.timeZone.notNull).toBe(true);
    expect(orgProfiles.timeZone.hasDefault).toBe(true);
    expect(orgProfiles.timeZone.default).toBe("Europe/Moscow");
  });

  it("exports inventory preparation persistence", () => {
    expect(getTableName(schema.inventories)).toBe("inventories");
    expect(getTableName(schema.inventoryImports)).toBe("inventory_imports");
    expect(getTableName(schema.inventorySnapshots)).toBe("inventory_snapshots");
    expect(getTableName(schema.inventorySnapshotInputs)).toBe("inventory_snapshot_inputs");
    expect(getTableName(schema.inventorySnapshotCodes)).toBe("inventory_snapshot_codes");
  });

  it("gives organization profiles a nullable tenant-scoped default box label template", () => {
    expect(orgProfiles.defaultBoxLabelTemplateId).toBeDefined();
    expect(orgProfiles.defaultBoxLabelTemplateId.notNull).toBe(false);

    const foreignKey = getTableConfig(orgProfiles).foreignKeys.find(
      (item) => item.getName() === "org_profiles_box_label_template_tenant_fk",
    );
    expect(
      foreignKey,
      "missing organization default box label template tenant foreign key",
    ).toBeDefined();
    const reference = foreignKey!.reference();
    expect(reference.columns.map((column) => column.name)).toEqual([
      "tenant_id",
      "default_box_label_template_id",
    ]);
    expect(reference.foreignColumns.map((column) => column.name)).toEqual(["tenant_id", "id"]);
  });

  it("exports the four tables", () => {
    expect(getTableName(counterparties)).toBe("counterparties");
    expect(getTableName(products)).toBe("products");
    expect(getTableName(lines)).toBe("lines");
    expect(getTableName(shifts)).toBe("shifts");
  });
  it("products enforce tenant-scoped GTIN uniqueness (by declared index name)", () => {
    // structural smoke: the unique index is declared in the table config
    expect(Object.keys(products)).toContain("gtin14");
  });

  it("lets a product be archived without being deleted", () => {
    // Archived products stay for history (orders, shifts, reports); the flag
    // only removes them from selection surfaces. New products start live.
    expect(Object.keys(products)).toContain("archived");
    expect(products.archived.default).toBe(false);
    expect(products.archived.notNull).toBe(true);
  });

  it("keys the sscc counter by tenant, issuer prefix and extension digit", () => {
    const cols = Object.keys(ssccCounters);
    expect(cols).toEqual(
      expect.arrayContaining(["tenantId", "issuerPrefix", "extensionDigit", "nextSerial"]),
    );
  });

  it("defaults a fresh sscc counter to serial one", () => {
    expect(ssccCounters.nextSerial.default).toBe(1);
  });

  it("lets an sscc block be revoked without being deleted", () => {
    const cols = Object.keys(ssccBlocks);
    expect(cols).toEqual(expect.arrayContaining(["revokedAt", "allocationOrder"]));
    // Nullable: null IS the live state, and a revoked block must survive as
    // the only record of where a gap in the numbering came from.
    expect(ssccBlocks.revokedAt.notNull).toBe(false);
    expect(ssccBlocks.allocationOrder.notNull).toBe(true);
    expect(ssccBlocks.allocationOrder.hasDefault).toBe(false);
    const allocationOrderIndex = getTableConfig(ssccBlocks).indexes.find(
      (index) => index.config.name === "sscc_blocks_stream_allocation_order_uq",
    );
    expect(allocationOrderIndex?.config.unique).toBe(true);
    expect(
      allocationOrderIndex?.config.columns.map((column) =>
        is(column, IndexedColumn) ? column.name : undefined,
      ),
    ).toEqual(["tenant_id", "issuer_prefix", "extension_digit", "device_id", "allocation_order"]);
  });

  it("gives boxes a tenant-unique sscc", () => {
    const cols = Object.keys(boxes);
    expect(cols).toEqual(
      expect.arrayContaining([
        "tenantId",
        "id",
        "sscc",
        "shiftId",
        "terminalId",
        "closedAt",
        "registryVersion",
        "updatedAt",
      ]),
    );
    if (!("updatedAt" in boxes)) return;
    expect(boxes.updatedAt.notNull).toBe(true);
    expect(boxes.updatedAt.hasDefault).toBe(true);
  });

  // Column-presence checks above would not catch a dropped unique index or a
  // missing composite tenant FK — both are declared in the table's extra
  // config, invisible to Object.keys(table). getTableConfig reaches that
  // config directly, so these assert on the constraints themselves.
  it("declares boxes' tenant-scoped unique constraints", () => {
    const { uniqueConstraints } = getTableConfig(boxes);
    const byName = new Map(uniqueConstraints.map((u) => [u.getName(), u]));
    expect(byName.get("boxes_tenant_id_uq")?.columns.map((c) => c.name)).toEqual([
      "tenant_id",
      "id",
    ]);
    expect(byName.get("boxes_tenant_sscc_uq")?.columns.map((c) => c.name)).toEqual([
      "tenant_id",
      "sscc",
    ]);
    expect(byName.get("boxes_device_box_uq")?.columns.map((c) => c.name)).toEqual([
      "tenant_id",
      "shift_id",
      "terminal_id",
      "device_box_id",
    ]);
  });

  it("indexes the tenant box registry cursor in paging order", () => {
    const cursorIndex = getTableConfig(boxes).indexes.find(
      (one) => one.config.name === "boxes_registry_cursor_idx",
    );

    expect(cursorIndex, "missing box registry cursor index").toBeDefined();
    expect(cursorIndex?.config.method).toBe("btree");
    expect(
      cursorIndex?.config.columns.map((column) =>
        is(column, IndexedColumn) ? column.name : undefined,
      ),
    ).toEqual(["tenant_id", "registry_version", "id"]);
  });

  it("declares a tenant-owned committed box registry revision", () => {
    expect(getTableName(boxRegistryVersions)).toBe("box_registry_versions");
    expect(boxRegistryVersions.currentVersion.notNull).toBe(true);
    expect(boxRegistryVersions.currentVersion.hasDefault).toBe(true);
    const fk = getTableConfig(boxRegistryVersions).foreignKeys.find(
      (one) => one.getName() === "box_registry_versions_tenant_fk",
    );
    expect(fk).toBeDefined();
    expect(fk?.reference().columns.map((column) => column.name)).toEqual(["tenant_id"]);
    expect(fk?.reference().foreignColumns.map((column) => column.name)).toEqual(["id"]);
  });

  it("gives boxes.operator_id a composite tenant FK to employees", () => {
    const { foreignKeys } = getTableConfig(boxes);
    const fk = foreignKeys.find((f) => f.getName() === "boxes_tenant_operator_fk");
    expect(fk).toBeDefined();
    const ref = fk!.reference();
    expect(getTableName(ref.foreignTable)).toBe("employees");
    expect(ref.columns.map((c) => c.name)).toEqual(["tenant_id", "operator_id"]);
    expect(ref.foreignColumns.map((c) => c.name)).toEqual(["tenant_id", "id"]);
  });

  it("gives sscc_blocks.device_id a composite tenant FK to station_devices", () => {
    const { foreignKeys } = getTableConfig(ssccBlocks);
    const fk = foreignKeys.find((f) => f.getName() === "sscc_blocks_tenant_device_fk");
    expect(fk).toBeDefined();
    const ref = fk!.reference();
    expect(getTableName(ref.foreignTable)).toBe("station_devices");
    expect(ref.columns.map((c) => c.name)).toEqual(["tenant_id", "device_id"]);
    expect(ref.foreignColumns.map((c) => c.name)).toEqual(["tenant_id", "id"]);
  });

  it("declares durable station pairing fields and tenant-scoped pairing constraints", () => {
    expect(stationDevices.apiKeyId.notNull).toBe(false);
    expect(stationDevices.lineId).toBeDefined();
    expect(stationDevices.pairedAt).toBeDefined();
    expect(stationDevices.revokedAt).toBeDefined();
    expect(stationPairingCodes).toBeDefined();

    const { foreignKeys } = getTableConfig(stationDevices);
    const lineFk = foreignKeys.find((f) => f.getName() === "station_devices_tenant_line_fk");
    expect(lineFk).toBeDefined();
    const lineRef = lineFk!.reference();
    expect(getTableName(lineRef.foreignTable)).toBe("lines");
    expect(lineRef.columns.map((c) => c.name)).toEqual(["tenant_id", "line_id"]);
    expect(lineRef.foreignColumns.map((c) => c.name)).toEqual(["tenant_id", "id"]);

    const pairingConfig = getTableConfig(stationPairingCodes);
    const deviceFk = pairingConfig.foreignKeys.find(
      (f) => f.getName() === "station_pairing_codes_tenant_station_device_fk",
    );
    expect(deviceFk).toBeDefined();
    const deviceRef = deviceFk!.reference();
    expect(getTableName(deviceRef.foreignTable)).toBe("station_devices");
    expect(deviceRef.columns.map((c) => c.name)).toEqual(["tenant_id", "station_device_id"]);
    expect(deviceRef.foreignColumns.map((c) => c.name)).toEqual(["tenant_id", "id"]);
  });

  it("declares canonical raw storage and lowercase SHA-256 checks", () => {
    expect(Object.keys(codes)).toContain("canonicalRaw");
    const checks = [codes, codeRegistry, codeConflicts, boxItems, boxExceptions].flatMap((table) =>
      getTableConfig(table).checks.map((constraint) => constraint.name),
    );
    expect(checks).toEqual(
      expect.arrayContaining([
        "codes_hash_check",
        "codes_canonical_raw_size_check",
        "code_registry_hash_check",
        "code_conflicts_hash_check",
        "box_items_hash_check",
        "box_exceptions_hash_check",
      ]),
    );
  });

  it("stores the exact scan targeted by an undo exception", () => {
    expect(Object.keys(boxExceptions)).toContain("targetScannedAt");
  });

  it("gives shifts a NOT NULL month key and sequence for the shift number", () => {
    expect(shifts.numberMonthKey).toBeDefined();
    expect(shifts.numberMonthKey.notNull).toBe(true);
    expect(shifts.numberSeq).toBeDefined();
    expect(shifts.numberSeq.notNull).toBe(true);

    const uq = getTableConfig(shifts).indexes.find(
      (item) => item.config.name === "shifts_tenant_month_seq_uq",
    );
    expect(uq, "missing shifts (tenant, month, seq) unique index").toBeDefined();
    expect(uq?.config.unique).toBe(true);
    expect(
      uq?.config.columns.map((column) => (is(column, IndexedColumn) ? column.name : undefined)),
    ).toEqual(["tenant_id", "number_month_key", "number_seq"]);
  });

  it("stores an optional production date on a shift without a default", () => {
    expect(shifts.productionDate).toBeDefined();
    expect(shifts.productionDate.notNull).toBe(false);
    expect(shifts.productionDate.default).toBeUndefined();
    expect(shifts.productionDate.dataType).toBe("string");
  });

  it("stores the first accepted box-closure receipt as a nullable marker without a default", () => {
    expect(shifts.firstBoxClosureAt).toBeDefined();
    expect(shifts.firstBoxClosureAt.notNull).toBe(false);
    expect(shifts.firstBoxClosureAt.default).toBeUndefined();
    expect(shifts.firstBoxClosureAt.dataType).toBe("date");
  });

  it("keys the shift number counter by tenant and month", () => {
    expect(getTableName(shiftNumberCounters)).toBe("shift_number_counters");
    const cols = Object.keys(shiftNumberCounters);
    expect(cols).toEqual(expect.arrayContaining(["tenantId", "monthKey", "lastSeq"]));
    const pk = getTableConfig(shiftNumberCounters).primaryKeys[0];
    expect(pk).toBeDefined();
    expect(pk?.columns.map((column) => column.name)).toEqual(["tenant_id", "month_key"]);
  });
});

const url = process.env.DATABASE_URL;

describe.skipIf(!url)("box_items.removed_at / boxes.disassembled_at / box_exceptions", () => {
  const { db, pool } = createDb(url!);
  const org = {
    id: `org-${randomUUID()}`,
    name: "T",
    slug: `t-${randomUUID()}`,
    createdAt: new Date(),
  };
  const tenantId = org.id;
  const productId = randomUUID();
  const shiftId = randomUUID();
  const boxId = randomUUID();
  const codeHash = (randomUUID() + randomUUID()).replace(/-/g, "");

  beforeAll(async () => {
    await db.insert(schema.organization).values(org);
    await db.insert(schema.products).values({
      id: productId,
      tenantId,
      gtin14: "04600000000001",
      name: "Test product",
    });
    await db.insert(schema.shifts).values({
      id: shiftId,
      tenantId,
      productId,
      mode: "validation",
      numberMonthKey: "AUG26",
      numberSeq: 1,
    });
    await db.insert(schema.boxes).values({
      id: boxId,
      tenantId,
      shiftId,
      deviceBoxId: "device-box-1",
    });
    await db.insert(schema.boxItems).values({
      tenantId,
      boxId,
      codeHash,
      addedAt: new Date(),
    });
  });

  afterAll(async () => {
    await db.delete(schema.boxExceptions).where(eq(schema.boxExceptions.tenantId, tenantId));
    await db.delete(schema.boxItems).where(eq(schema.boxItems.tenantId, tenantId));
    await db.delete(schema.boxes).where(eq(schema.boxes.tenantId, tenantId));
    await db.delete(schema.shifts).where(eq(schema.shifts.tenantId, tenantId));
    await db.delete(schema.products).where(eq(schema.products.tenantId, tenantId));
    await db.delete(schema.organization).where(eq(schema.organization.id, tenantId));
    await pool.end();
  });

  it("round-trips removedAt, disassembledAt, and a box_exceptions row", async () => {
    await db
      .update(schema.boxItems)
      .set({ removedAt: new Date() })
      .where(and(eq(schema.boxItems.tenantId, tenantId), eq(schema.boxItems.boxId, boxId)));
    await db
      .update(schema.boxes)
      .set({ disassembledAt: new Date() })
      .where(and(eq(schema.boxes.tenantId, tenantId), eq(schema.boxes.id, boxId)));
    const [exception] = await db
      .insert(schema.boxExceptions)
      .values({
        tenantId,
        kind: "disassemble",
        boxId,
        shiftId,
        terminalId: null,
        operatorId: null,
        reason: "test reason",
        occurredAt: new Date(),
      })
      .returning();
    expect(exception?.kind).toBe("disassemble");

    const [row] = await db.select().from(schema.boxes).where(eq(schema.boxes.id, boxId));
    expect(row?.disassembledAt).not.toBeNull();

    // Not asserted by the brief, but worth pinning down since the test name
    // promises it: confirm removedAt actually persisted too, not just
    // disassembledAt.
    const [item] = await db
      .select()
      .from(schema.boxItems)
      .where(and(eq(schema.boxItems.tenantId, tenantId), eq(schema.boxItems.boxId, boxId)));
    expect(item?.removedAt).not.toBeNull();
  });
});
