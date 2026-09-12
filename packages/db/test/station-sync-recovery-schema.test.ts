import { getTableName } from "drizzle-orm";
import { getTableConfig, PgDialect, type AnyPgTable } from "drizzle-orm/pg-core";
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

  it("accepts every record kind the station ingest can deny, including both pallet kinds", () => {
    // A kind the ingest denies but this CHECK omits is not a missing row: the
    // insert raises 23514 and 500s the whole batch, and the device's drain
    // retries a 5xx forever. The alternative the API took before 06d --
    // dropping the unlistable kind with a log line -- silently lost the
    // closure of a pallet that had already been physically labelled, because
    // `sync_batches` keeps a digest and never the body.
    const table = (schema as unknown as Record<string, AnyPgTable | undefined>)
      .stationSyncQuarantine;
    const check = getTableConfig(table!).checks.find(
      (item) => item.name === "station_sync_quarantine_record_kind_check",
    );
    expect(check).toBeDefined();
    const rendered = new PgDialect().sqlToQuery(check!.value).sql;
    for (const kind of [
      "item",
      "box",
      "exception",
      "product_label_event",
      "pallet",
      "pallet_exception",
    ]) {
      expect(rendered).toContain(`'${kind}'`);
    }
  });
});
