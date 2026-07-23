import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  applyMigrations,
  upsertBundle,
  readShiftMirror,
  readOperatorsMirror,
  type SqlExecutor,
  type StationBundle,
} from "../src/lib/mirror.js";

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
  operators: [
    {
      operatorId: "op1",
      name: "Ivan",
      role: "operator",
      pinHash: "pbkdf2$sha256$1$c2FsdA==$aA==",
      badgeHash: null,
      active: true,
    },
  ],
};

describe("mirror", () => {
  it("applies migrations then upserts a bundle and reads it back offline", async () => {
    const exec = nodeExecutor();
    await applyMigrations(exec);
    await upsertBundle(exec, bundle);

    const shift = await readShiftMirror(exec, "s1");
    expect(shift).toMatchObject({ id: "s1", status: "active", counterpartyGln: "6291041500213" });
    expect(JSON.parse(shift!.labelTemplateSpec!)).toMatchObject({ language: "zpl" });

    const ops = await readOperatorsMirror(exec);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ operatorId: "op1", active: true });
  });

  it("upserting the same shift twice does not duplicate rows", async () => {
    const exec = nodeExecutor();
    await applyMigrations(exec);
    await upsertBundle(exec, bundle);
    await upsertBundle(exec, bundle);
    const rows = await exec.all<{ n: number }>("SELECT COUNT(*) AS n FROM shift_mirror");
    expect(rows[0]!.n).toBe(1);
  });
});
