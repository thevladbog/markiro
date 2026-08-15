import { DatabaseSync } from "node:sqlite";
import { STATION_MIGRATIONS } from "@markiro/db/station-sqlite";
import { describe, expect, it, vi } from "vitest";

vi.mock("@markiro/domain", () => ({
  isShiftCloseReasonCode: (value: unknown) =>
    value === "production_defect" || value === "material_shortage" || value === "equipment_stop",
  shiftCloseReasonRequired: (plannedQty: number | null, actualQty: number) =>
    plannedQty !== null && plannedQty !== actualQty,
}));
import { closeShiftOffline } from "../src/lib/shift-close.js";
import type { SqlExecutor } from "../src/lib/mirror.js";

function executor(): { exec: SqlExecutor; statements: string[] } {
  const statements: string[] = [];
  const exec: SqlExecutor = {
    async all<T>(sql: string): Promise<T[]> {
      if (sql.includes("FROM shift_mirror")) {
        return [
          {
            id: "shift-1",
            product_id: "product-1",
            product_name: "Widget",
            planned_qty: 10,
            status: "active",
          },
        ] as T[];
      }
      if (sql.includes("FROM shift_close_outbox")) return [];
      if (sql.includes("FROM codes_mirror")) return [{ actualQty: 9 }] as T[];
      if (sql.includes("openBoxCount")) return [{ openBoxCount: 0 }] as T[];
      return [{ closedBoxCount: 1 }] as T[];
    },
    async run(sql: string): Promise<void> {
      statements.push(sql);
    },
  };
  return { exec, statements };
}

describe("closeShiftOffline", () => {
  it("rejects a mismatched plan without a fixed reason", async () => {
    const { exec } = executor();
    await expect(
      closeShiftOffline(exec, { shiftId: "shift-1", deviceId: "device-1", operatorId: null }),
    ).rejects.toThrow("reason");
  });

  it("publishes the local closed state and durable close event", async () => {
    const { exec, statements } = executor();
    const summary = await closeShiftOffline(
      exec,
      {
        shiftId: "shift-1",
        deviceId: "device-1",
        operatorId: "operator-1",
        reasonCode: "equipment_stop",
      },
      () => new Date("2026-08-14T12:00:00.000Z"),
    );
    expect(summary.actualQty).toBe(9);
    expect(summary.reasonCode).toBe("equipment_stop");
    expect(statements.some((sql) => sql.includes("UPDATE shift_mirror"))).toBe(true);
    expect(statements.some((sql) => sql.includes("INSERT INTO shift_close_outbox"))).toBe(true);
  });

  it("closes through an executor that cannot keep a transaction across pooled calls", async () => {
    const db = new DatabaseSync(":memory:");
    for (const migration of STATION_MIGRATIONS) {
      try {
        db.exec(migration);
      } catch (error) {
        if (!/duplicate column name/i.test(String(error))) throw error;
      }
    }
    db.exec(`CREATE TABLE IF NOT EXISTS shift_close_outbox (
      event_id TEXT PRIMARY KEY,
      shift_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      operator_id TEXT,
      product_id TEXT NOT NULL,
      product_name TEXT NOT NULL,
      planned_qty_snapshot INTEGER,
      actual_qty INTEGER NOT NULL,
      closed_box_count INTEGER NOT NULL,
      reason_code TEXT,
      closed_at TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      conflict_code TEXT,
      last_checked_at TEXT
    );`);
    db.prepare(
      `INSERT INTO shift_mirror
         (id, status, mode, product_id, product_name, planned_qty, pallets_enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("shift-pooled", "active", "aggregation", "product-1", "Widget", null, 0);
    const exec: SqlExecutor = {
      run: async (sql, params = []) => {
        if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) {
          throw new Error("multi-call transactions are unavailable");
        }
        db.prepare(sql).run(...(params as never[]));
      },
      all: async <T>(sql: string, params: unknown[] = []) =>
        db.prepare(sql).all(...(params as never[])) as T[],
    };

    await expect(
      closeShiftOffline(exec, {
        shiftId: "shift-pooled",
        deviceId: "device-1",
        operatorId: "operator-1",
      }),
    ).resolves.toMatchObject({ shiftId: "shift-pooled", actualQty: 0 });
    expect(await exec.all("SELECT event_id FROM shift_close_outbox")).toHaveLength(1);
  });

  it("returns the queued close summary when the operator retries a closed shift", async () => {
    const db = new DatabaseSync(":memory:");
    for (const migration of STATION_MIGRATIONS) {
      try {
        db.exec(migration);
      } catch (error) {
        if (!/duplicate column name/i.test(String(error))) throw error;
      }
    }
    db.exec(`CREATE TABLE IF NOT EXISTS shift_close_outbox (
      event_id TEXT PRIMARY KEY,
      shift_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      operator_id TEXT,
      product_id TEXT NOT NULL,
      product_name TEXT NOT NULL,
      planned_qty_snapshot INTEGER,
      actual_qty INTEGER NOT NULL,
      closed_box_count INTEGER NOT NULL,
      reason_code TEXT,
      closed_at TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      conflict_code TEXT,
      last_checked_at TEXT
    );`);
    db.prepare(
      `INSERT INTO shift_mirror
         (id, status, mode, product_id, product_name, planned_qty, pallets_enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("shift-retry", "active", "aggregation", "product-1", "Widget", null, 0);
    const exec: SqlExecutor = {
      run: async (sql, params = []) => {
        db.prepare(sql).run(...(params as never[]));
      },
      all: async <T>(sql: string, params: unknown[] = []) =>
        db.prepare(sql).all(...(params as never[])) as T[],
    };

    const first = await closeShiftOffline(exec, {
      shiftId: "shift-retry",
      deviceId: "device-1",
      operatorId: "operator-1",
    });
    const retried = await closeShiftOffline(exec, {
      shiftId: "shift-retry",
      deviceId: "device-1",
      operatorId: "operator-1",
    });

    expect(retried).toEqual(first);
    expect(await exec.all("SELECT event_id FROM shift_close_outbox")).toHaveLength(1);
  });

  it("removes an empty auto-opened box before closing the shift", async () => {
    const db = new DatabaseSync(":memory:");
    for (const migration of STATION_MIGRATIONS) {
      try {
        db.exec(migration);
      } catch (error) {
        if (!/duplicate column name/i.test(String(error))) throw error;
      }
    }
    db.exec(`CREATE TABLE IF NOT EXISTS shift_close_outbox (
      event_id TEXT PRIMARY KEY,
      shift_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      operator_id TEXT,
      product_id TEXT NOT NULL,
      product_name TEXT NOT NULL,
      planned_qty_snapshot INTEGER,
      actual_qty INTEGER NOT NULL,
      closed_box_count INTEGER NOT NULL,
      reason_code TEXT,
      closed_at TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending'
    );`);
    const exec: SqlExecutor = {
      run: async (sql, params = []) => {
        db.prepare(sql).run(...(params as never[]));
      },
      all: async <T>(sql: string, params: unknown[] = []) =>
        db.prepare(sql).all(...(params as never[])) as T[],
    };
    await exec.run(
      `INSERT INTO shift_mirror
         (id, status, mode, product_id, product_name, planned_qty, pallets_enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["shift-empty-box", "active", "aggregation", "product-1", "Widget", null, 0],
    );
    await exec.run(
      `INSERT INTO boxes_mirror (box_id, shift_id, opened_at)
       VALUES (?, ?, ?)`,
      ["box-empty", "shift-empty-box", "2026-08-15T12:00:00.000Z"],
    );

    await expect(
      closeShiftOffline(exec, {
        shiftId: "shift-empty-box",
        deviceId: "device-1",
        operatorId: "operator-1",
      }),
    ).resolves.toMatchObject({ shiftId: "shift-empty-box", actualQty: 0 });
    expect(
      await exec.all("SELECT box_id FROM boxes_mirror WHERE shift_id = ?", ["shift-empty-box"]),
    ).toEqual([]);
  });
});
