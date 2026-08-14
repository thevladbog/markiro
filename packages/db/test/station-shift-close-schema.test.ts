import { DatabaseSync } from "node:sqlite";
import { getTableConfig, type AnyPgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { schema, STATION_MIGRATIONS } from "../src/index.js";

function applyMigrations(db: DatabaseSync): void {
  for (const statement of STATION_MIGRATIONS) {
    try {
      db.exec(statement);
    } catch (error) {
      if (!/duplicate column name/i.test(error instanceof Error ? error.message : String(error))) {
        throw error;
      }
    }
  }
}

describe("station shift close schema", () => {
  it("declares tenant-scoped participation and idempotent close event tables", () => {
    const participants = (schema as unknown as Record<string, AnyPgTable>).shiftDeviceParticipants;
    const events = (schema as unknown as Record<string, AnyPgTable>).stationShiftCloseEvents;

    expect(participants).toBeDefined();
    expect(events).toBeDefined();
    if (!participants || !events) throw new Error("shift close schema tables are missing");
    expect(getTableConfig(participants).uniqueConstraints.map((item) => item.getName())).toContain(
      "shift_device_participants_tenant_shift_device_uq",
    );
    expect(getTableConfig(events).uniqueConstraints.map((item) => item.getName())).toContain(
      "station_shift_close_events_payload_uq",
    );
    expect(Object.keys(schema.shifts)).toEqual(
      expect.arrayContaining(["stationClosePolicy", "stationCloseOwnerDeviceId"]),
    );
  });

  it("creates the local close outbox and is safe to apply twice", () => {
    const db = new DatabaseSync(":memory:");
    applyMigrations(db);
    expect(() => applyMigrations(db)).not.toThrow();

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(tables.map((table) => table.name)).toContain("shift_close_outbox");

    const columns = db.prepare("PRAGMA table_info(shift_close_outbox)").all() as Array<{
      name: string;
    }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "event_id",
        "shift_id",
        "planned_qty_snapshot",
        "actual_qty",
        "closed_box_count",
        "reason_code",
        "state",
        "last_checked_at",
      ]),
    );
  });
});
