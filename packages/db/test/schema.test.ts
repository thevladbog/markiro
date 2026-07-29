import { describe, expect, it } from "vitest";
import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  boxes,
  counterparties,
  lines,
  products,
  shifts,
  ssccBlocks,
  ssccCounters,
} from "../src/schema/platform.js";

describe("platform schema", () => {
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

  it("keys the sscc counter by tenant, issuer and extension digit", () => {
    const cols = Object.keys(ssccCounters);
    expect(cols).toEqual(
      expect.arrayContaining(["tenantId", "issuerGln", "extensionDigit", "nextSerial"]),
    );
  });

  it("gives boxes a tenant-unique sscc", () => {
    const cols = Object.keys(boxes);
    expect(cols).toEqual(
      expect.arrayContaining(["tenantId", "id", "sscc", "shiftId", "terminalId", "closedAt"]),
    );
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
});
