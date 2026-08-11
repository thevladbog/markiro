import { getTableName } from "drizzle-orm";
import { getTableConfig, type AnyPgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { schema } from "../src/index.js";

describe("station sync recovery schema", () => {
  it("binds every new sync batch to one authenticated station and canonical payload", () => {
    expect(Object.keys(schema.syncBatches)).toEqual(
      expect.arrayContaining(["terminalId", "payloadDigest", "result"]),
    );
    expect(schema.syncBatches.terminalId.notNull).toBe(false);
    expect(schema.syncBatches.payloadDigest.notNull).toBe(false);
    expect(schema.syncBatches.result.notNull).toBe(false);

    const config = getTableConfig(schema.syncBatches);
    expect(config.checks.map((item) => item.name)).toEqual(
      expect.arrayContaining([
        "sync_batches_binding_pair_check",
        "sync_batches_payload_digest_check",
      ]),
    );
    expect(config.foreignKeys.map((item) => item.getName())).toContain(
      "sync_batches_tenant_terminal_fk",
    );
  });

  it("keeps denied station records in a tenant/device/batch-scoped durable quarantine", () => {
    const table = (schema as unknown as Record<string, AnyPgTable | undefined>)
      .stationSyncQuarantine;
    expect(table).toBeDefined();
    expect(getTableName(table!)).toBe("station_sync_quarantine");
    expect(Object.keys(table!)).toEqual(
      expect.arrayContaining([
        "tenantId",
        "batchId",
        "terminalId",
        "payloadDigest",
        "recordKind",
        "recordIndex",
        "shiftId",
        "reason",
        "payload",
        "quarantinedAt",
      ]),
    );

    const config = getTableConfig(table!);
    expect(config.foreignKeys.map((item) => item.getName())).toEqual(
      expect.arrayContaining([
        "station_sync_quarantine_tenant_batch_fk",
        "station_sync_quarantine_tenant_terminal_fk",
      ]),
    );
    expect(config.uniqueConstraints.map((item) => item.getName())).toContain(
      "station_sync_quarantine_record_uq",
    );
    expect(config.indexes.map((item) => item.config.name)).toContain(
      "station_sync_quarantine_tenant_time_idx",
    );
  });
});
