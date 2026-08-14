import { describe, expect, it } from "vitest";
import { closeShiftOffline } from "../src/lib/shift-close.js";
import type { SqlExecutor } from "../src/lib/mirror.js";

function executor(): { exec: SqlExecutor; statements: string[] } {
  const statements: string[] = [];
  const exec: SqlExecutor = {
    async all<T>(sql: string): Promise<T[]> {
      if (sql.includes("FROM shift_mirror")) {
        return [{ id: "shift-1", product_id: "product-1", product_name: "Widget", planned_qty: 10, status: "active" }] as T[];
      }
      if (sql.includes("FROM codes_mirror")) return [{ actualQty: 9 }] as T[];
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

  it("publishes the local closed state and outbox atomically", async () => {
    const { exec, statements } = executor();
    const summary = await closeShiftOffline(
      exec,
      { shiftId: "shift-1", deviceId: "device-1", operatorId: "operator-1", reasonCode: "equipment_stop" },
      () => new Date("2026-08-14T12:00:00.000Z"),
    );
    expect(summary.actualQty).toBe(9);
    expect(summary.reasonCode).toBe("equipment_stop");
    expect(statements[0]).toBe("BEGIN");
    expect(statements.some((sql) => sql.includes("UPDATE shift_mirror"))).toBe(true);
    expect(statements.some((sql) => sql.includes("INSERT INTO shift_close_outbox"))).toBe(true);
    expect(statements.at(-1)).toBe("COMMIT");
  });
});
