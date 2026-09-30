import { createDb, schema } from "@markiro/db";
import type { PlatformReportInput } from "@markiro/platform-contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  mergeInventoryCompletions,
  QUALITY_COLUMNS,
} from "../src/platform-reports/quality-report-source";
import { PlatformReportSourceService } from "../src/platform-reports/report-source.service";
import {
  cleanupEvidence,
  seedEvidenceBase,
  type EvidenceBase,
} from "./support/platform-report-evidence-base";
import { seedReportInventory } from "./support/platform-report-inventory-fixture";

describe("mergeInventoryCompletions", () => {
  const empty = {
    tenant_id: "t",
    tenant_name: "T",
    day: "2026-09-01",
    accepted_scans: 4,
  };
  it("adds completed inventories to an existing tenant-day and creates a missing one", () => {
    const rows = mergeInventoryCompletions(
      [empty],
      [
        {
          tenant_id: "t",
          tenant_name: "T",
          inventory_id: "i-1",
          day: "2026-09-01",
          has_snapshot: 1,
        },
        {
          tenant_id: "t",
          tenant_name: "T",
          inventory_id: "i-2",
          day: "2026-09-03",
          has_snapshot: 0,
        },
      ],
      [{ tenant_id: "t", inventory_id: "i-1", current_expected: 3, current_missing_expected: 2 }],
    );
    expect(rows).toEqual([
      expect.objectContaining({
        day: "2026-09-01",
        accepted_scans: 4,
        inventories_completed_with_snapshot: 1,
        inventory_expected_current: 3,
        inventory_missing_expected_current: 2,
      }),
      expect.objectContaining({
        tenant_name: "T",
        day: "2026-09-03",
        accepted_scans: 0,
        inventories_completed_with_snapshot: 0,
        inventory_expected_current: 0,
        inventory_missing_expected_current: 0,
      }),
    ]);
  });
  it("skips null projection values instead of inferring zero-valued facts", () => {
    const [row] = mergeInventoryCompletions(
      [],
      [
        {
          tenant_id: "t",
          tenant_name: "T",
          inventory_id: "i-1",
          day: "2026-09-01",
          has_snapshot: 1,
        },
      ],
      [
        {
          tenant_id: "t",
          inventory_id: "i-1",
          current_expected: null,
          current_missing_expected: null,
        },
      ],
    );
    expect(row).toMatchObject({
      inventory_expected_current: 0,
      inventory_missing_expected_current: 0,
    });
  });
});

const url = process.env.DATABASE_URL;
const local = url ? ["localhost", "127.0.0.1"].includes(new URL(url).hostname) : false;

describe.skipIf(!local)("quality report projection on real Postgres", () => {
  const { db, pool } = createDb(url ?? "postgres://localhost:55439/unavailable");
  const service = new PlatformReportSourceService(db);
  let base: EvidenceBase;
  let input: PlatformReportInput;

  beforeAll(async () => {
    base = await seedEvidenceBase(db);
    input = {
      reportType: "quality",
      tenantIds: [base.tenant],
      fromDate: "2026-09-01",
      toDate: "2026-09-02",
      timezone: "Europe/Moscow",
      periodBasis: "events",
      privacy: "identified",
    };
    const scan = (verdict: string, at: string) => ({
      tenantId: base.tenant,
      shiftId: base.shiftOne,
      terminalId: "t-1",
      operatorId: base.operatorOne,
      raw: "raw-scan-secret",
      verdict,
      scannedAt: new Date(at),
    });
    await db.insert(schema.scanEvents).values([
      scan("ok", "2026-09-01T09:00:00Z"),
      scan("ok", "2026-09-01T09:05:00Z"),
      scan("duplicate", "2026-09-01T10:00:00Z"),
      scan("wrong_gtin", "2026-09-01T10:05:00Z"),
      scan("invalid", "2026-09-01T10:10:00Z"),
      // 2026-09-01T22:00Z is local 2026-09-02 01:00 in Moscow.
      scan("duplicate", "2026-09-01T22:00:00Z"),
      scan("duplicate", "2026-09-01T22:05:00Z"),
      scan("ok", "2026-09-02T05:00:00Z"),
    ]);
    await db.insert(schema.codeConflicts).values([
      {
        tenantId: base.tenant,
        codeHash: "a".repeat(64),
        losingShiftId: base.shiftOne,
        winningShiftId: base.shiftOne,
        losingScannedAt: new Date("2026-08-20T00:00:00Z"),
        winningScannedAt: new Date("2026-08-19T00:00:00Z"),
        detectedAt: new Date("2026-09-01T17:00:00Z"),
        reviewedAt: new Date("2026-09-02T09:00:00Z"),
      },
      {
        tenantId: base.tenant,
        codeHash: "b".repeat(64),
        losingShiftId: base.shiftOne,
        winningShiftId: base.shiftOne,
        losingScannedAt: new Date("2026-08-20T00:00:00Z"),
        winningScannedAt: new Date("2026-08-19T00:00:00Z"),
        detectedAt: new Date("2026-09-01T18:00:00Z"),
      },
    ]);
    let boxNumber = 0;
    const box = (
      values: Partial<typeof schema.boxes.$inferInsert>,
    ): typeof schema.boxes.$inferInsert => ({
      tenantId: base.tenant,
      shiftId: base.shiftOne,
      terminalId: "t-1",
      operatorId: base.operatorOne,
      deviceBoxId: `q-box-${++boxNumber}`,
      openedAt: new Date("2026-08-20T00:00:00Z"),
      ...values,
    });
    // Closure lag = closure_received_at - closed_at. Bucket edges are half-open.
    await db.insert(schema.boxes).values([
      // lag 0 -> lt_1h
      box({
        closedAt: new Date("2026-09-01T08:00:00Z"),
        closureReceivedAt: new Date("2026-09-01T08:00:00Z"),
      }),
      // lag exactly 1 h -> lt_24h
      box({
        closedAt: new Date("2026-09-01T07:00:00Z"),
        closureReceivedAt: new Date("2026-09-01T08:00:00Z"),
      }),
      // lag exactly 24 h -> lt_7d
      box({
        closedAt: new Date("2026-08-31T08:00:00Z"),
        closureReceivedAt: new Date("2026-09-01T08:00:00Z"),
      }),
      // lag exactly 7 d -> ge_7d
      box({
        closedAt: new Date("2026-08-25T08:00:00Z"),
        closureReceivedAt: new Date("2026-09-01T08:00:00Z"),
      }),
      // device clock ahead of the server -> clock_ahead
      box({
        closedAt: new Date("2026-09-01T09:00:00Z"),
        closureReceivedAt: new Date("2026-09-01T08:00:00Z"),
      }),
      // no device closure time -> unknown
      box({ closedAt: null, closureReceivedAt: new Date("2026-09-01T08:00:00Z") }),
      // lag 15 min -> lt_1h, and disassembled on day one (server clock)
      box({
        closedAt: new Date("2026-09-01T07:45:00Z"),
        closureReceivedAt: new Date("2026-09-01T08:00:00Z"),
        disassembledAt: new Date("2026-09-01T14:00:00Z"),
        disassemblyReceivedAt: new Date("2026-09-01T15:00:00Z"),
      }),
      // lag 2 h, received on local day two -> lt_24h on 2026-09-02
      box({
        closedAt: new Date("2026-09-01T23:00:00Z"),
        closureReceivedAt: new Date("2026-09-02T01:00:00Z"),
      }),
    ]);
    const [pallet] = await db
      .insert(schema.pallets)
      .values({
        tenantId: base.tenant,
        shiftId: base.shiftOne,
        kind: "production",
        devicePalletId: "q-pp-1",
        terminalId: "t-1",
      })
      .returning({ id: schema.pallets.id });
    await db.insert(schema.palletExceptions).values([
      {
        tenantId: base.tenant,
        kind: "disassemble",
        palletId: pallet!.id,
        shiftId: base.shiftOne,
        terminalId: "t-1",
        operatorId: base.operatorOne,
        reason: "operator request",
        occurredAt: new Date("2026-09-02T09:50:00Z"),
        recordedAt: new Date("2026-09-02T10:00:00Z"),
      },
      {
        tenantId: base.tenant,
        kind: "reprint",
        palletId: pallet!.id,
        shiftId: base.shiftOne,
        terminalId: "t-1",
        operatorId: base.operatorOne,
        reason: "damaged",
        occurredAt: new Date("2026-09-01T10:50:00Z"),
        recordedAt: new Date("2026-09-01T11:00:00Z"),
      },
    ]);
    await db.insert(schema.syncBatches).values({
      tenantId: base.tenant,
      batchId: "q-batch",
      terminalId: base.stationDevice,
      payloadDigest: "a".repeat(64),
      result: {},
    });
    await db.insert(schema.stationSyncQuarantine).values(
      [
        [0, "2026-09-01T12:00:00Z"],
        [1, "2026-09-02T12:00:00Z"],
      ].map(([index, at]) => ({
        tenantId: base.tenant,
        batchId: "q-batch",
        terminalId: base.stationDevice,
        payloadDigest: "a".repeat(64),
        recordKind: "box",
        recordIndex: index as number,
        reason: "subscription_read_only",
        payload: { secret: "quarantine-secret" },
        quarantinedAt: new Date(at as string),
      })),
    );
    // Completed 2026-09-01T10:00Z with expected_count 3 and 2 missing expected codes.
    await seedReportInventory(db, {
      tenant: base.tenant,
      product: base.product,
      line: base.lineOne,
      operator: base.operatorOne,
      user: base.user,
    });
  });

  afterAll(async () => {
    await cleanupEvidence(db, [base.tenant, base.other], { users: [base.user] });
    await pool.end();
  });

  it("counts verdicts, conflicts, disassemblies, lag buckets, quarantine and inventories per tenant-day", async () => {
    const result = await service.load(input);
    expect(result.columns).toEqual([...QUALITY_COLUMNS]);
    expect(result.rows).toEqual([
      {
        tenant_id: base.tenant,
        tenant_name: "Evidence fixture A",
        day: "2026-09-01",
        accepted_scans: 2,
        duplicate_scans: 1,
        wrong_gtin_scans: 1,
        invalid_scans: 1,
        code_conflicts_detected: 2,
        code_conflicts_reviewed: 0,
        box_disassemblies: 1,
        pallet_disassemblies: 0,
        box_closure_lag_clock_ahead: 1,
        box_closure_lag_lt_1h: 2,
        box_closure_lag_lt_24h: 1,
        box_closure_lag_lt_7d: 1,
        box_closure_lag_ge_7d: 1,
        box_closure_lag_unknown: 1,
        sync_quarantined_records: 1,
        inventories_completed_with_snapshot: 1,
        inventory_expected_current: 3,
        inventory_missing_expected_current: 2,
      },
      {
        tenant_id: base.tenant,
        tenant_name: "Evidence fixture A",
        day: "2026-09-02",
        accepted_scans: 1,
        duplicate_scans: 2,
        wrong_gtin_scans: 0,
        invalid_scans: 0,
        code_conflicts_detected: 0,
        code_conflicts_reviewed: 1,
        box_disassemblies: 0,
        pallet_disassemblies: 1,
        box_closure_lag_clock_ahead: 0,
        box_closure_lag_lt_1h: 0,
        box_closure_lag_lt_24h: 1,
        box_closure_lag_lt_7d: 0,
        box_closure_lag_ge_7d: 0,
        box_closure_lag_unknown: 0,
        sync_quarantined_records: 1,
        inventories_completed_with_snapshot: 0,
        inventory_expected_current: 0,
        inventory_missing_expected_current: 0,
      },
    ]);
    const text = JSON.stringify(result);
    expect(text).not.toContain("raw-scan-secret");
    expect(text).not.toContain("quarantine-secret");
  });

  it("keeps a foreign tenant out of the selection", async () => {
    const result = await service.load(input);
    expect(result.rows.every((row) => row.tenant_id === base.tenant)).toBe(true);
  });
});
