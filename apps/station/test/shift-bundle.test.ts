import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { applyMigrations, type SqlExecutor, type StationBundle } from "../src/lib/mirror.js";
import { mirrorShiftBundle } from "../src/lib/shift-bundle.js";

function nodeExecutor(): SqlExecutor {
  const db = new DatabaseSync(":memory:");
  return {
    async run(sql, params = []) {
      db.prepare(sql).run(...(params as never[]));
    },
    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
  };
}

const bundle: StationBundle = {
  shift: {
    id: "s1",
    status: "active",
    mode: "validation",
    productId: "p1",
    productName: "Cola",
    lineId: null,
    lineName: null,
    counterpartyId: "c1",
    counterpartyName: "Buyer",
    labelTemplateId: "lt1",
    labelTemplateName: "T",
    plannedQty: 100,
    plannedDate: "2026-07-23",
    boxCapacity: 12,
    palletCapacity: 48,
    palletsEnabled: false,
    openedAt: "2026-07-23T08:00:00Z",
  },
  product: {
    id: "p1",
    gtin14: "04600000000017",
    name: "Cola",
    productGroup: "Beverages",
    boxCapacity: 12,
    palletCapacity: 48,
    status: "active",
    defaultCounterpartyId: "c1",
    defaultLabelTemplateId: "lt1",
  },
  labelTemplate: {
    id: "lt1",
    name: "T",
    spec: { widthMm: 58, heightMm: 40, dpi: 203, language: "zpl", elements: [] },
  },
  counterpartyGln: "6291041500213",
  // The server bundle returns `operators: []` in 05a — the server operators
  // table is a parallel 05b workstream (see plan decision #4).
  operators: [],
};

describe("mirrorShiftBundle", () => {
  it("downloads the bundle via the client and mirrors it into shift_mirror/product_mirror", async () => {
    const exec = nodeExecutor();
    await applyMigrations(exec);
    const get = vi.fn().mockResolvedValue(bundle);

    await mirrorShiftBundle({ get }, exec, "s1");

    expect(get).toHaveBeenCalledWith("/shifts/s1/bundle");
    const shiftRows = await exec.all<{ id: string; product_id: string }>(
      "SELECT id, product_id FROM shift_mirror WHERE id = ?",
      ["s1"],
    );
    expect(shiftRows).toEqual([{ id: "s1", product_id: "p1" }]);
    const productRows = await exec.all<{ id: string }>(
      "SELECT id FROM product_mirror WHERE id = ?",
      ["p1"],
    );
    expect(productRows).toHaveLength(1);
  });

  it("is resilient: a download failure is logged, not thrown, and mirrors nothing", async () => {
    const exec = nodeExecutor();
    await applyMigrations(exec);
    const get = vi.fn().mockRejectedValue(new Error("network down"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(mirrorShiftBundle({ get }, exec, "s1")).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalled();
    const rows = await exec.all("SELECT id FROM shift_mirror");
    expect(rows).toHaveLength(0);
    consoleError.mockRestore();
  });
});
