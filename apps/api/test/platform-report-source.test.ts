import { randomUUID } from "node:crypto";
import { createDb, ensurePartitions, schema } from "@markiro/db";
import type { PlatformReportInput } from "@markiro/platform-contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import {
  PlatformReportSourceService,
  PlatformReportSourceBusyError,
  REPORT_SOURCE_LOCK_KEY,
} from "../src/platform-reports/report-source.service";
import { seedReportInventory } from "./support/platform-report-inventory-fixture";
import { renderPlatformReport } from "../src/platform-reports/report-renderer";
import * as inventorySource from "../src/platform-reports/inventory-report-source";

const url = process.env.DATABASE_URL;
const local = url ? ["localhost", "127.0.0.1"].includes(new URL(url).hostname) : false;
describe.skipIf(!local)("platform report real Postgres projections", () => {
  const { db, pool } = createDb(url ?? "postgres://localhost:55439/unavailable");
  const service = new PlatformReportSourceService(db);
  const tenant = `report-source-${randomUUID()}`;
  const other = `report-source-other-${randomUUID()}`;
  const operator = randomUUID();
  const product = randomUUID();
  const line = randomUUID();
  const shift = randomUUID();
  const box = randomUUID();
  const inventory = randomUUID();
  const user = randomUUID();
  const session = randomUUID();
  const otherLine = randomUUID();
  let completedInventory: string;
  const input: PlatformReportInput = {
    reportType: "shifts",
    tenantIds: [tenant],
    fromDate: "2026-09-01",
    toDate: "2026-09-01",
    timezone: "Europe/Moscow",
    periodBasis: "events",
    privacy: "identified",
  };
  beforeAll(async () => {
    await ensurePartitions(db, [new Date("2026-08-01"), new Date("2026-09-01")]);
    await db.insert(schema.organization).values([
      { id: tenant, name: "Report fixture", slug: tenant, createdAt: new Date() },
      { id: other, name: "Other", slug: other, createdAt: new Date() },
    ]);
    await db.insert(schema.user).values({
      id: user,
      name: "Fixture",
      email: `${user}@example.invalid`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db
      .insert(schema.products)
      .values({ id: product, tenantId: tenant, name: "=unsafe product", gtin14: "00012345678901" });
    await db.insert(schema.lines).values({ id: line, tenantId: tenant, name: "Line" });
    await db
      .insert(schema.employees)
      .values({ id: operator, tenantId: tenant, fullName: "=operator-secret" });
    await db.insert(schema.shifts).values({
      id: shift,
      tenantId: tenant,
      productId: product,
      lineId: line,
      mode: "validation",
      numberMonthKey: "SEP26",
      numberSeq: 1234,
      createdFrom: "station",
      productionDate: "2026-09-01",
      createdAt: new Date("2026-08-01"),
    });
    // Moscow day is [Aug31 21:00Z, Sep1 21:00Z). Two accepted inside, one outside; independent box metrics.
    await db.insert(schema.scanEvents).values([
      {
        tenantId: tenant,
        shiftId: shift,
        operatorId: operator,
        raw: "raw-scan-secret",
        verdict: "ok",
        scannedAt: new Date("2026-08-31T21:00:00Z"),
      },
      {
        tenantId: tenant,
        shiftId: shift,
        operatorId: null,
        raw: "raw-scan-secret",
        verdict: "ok",
        scannedAt: new Date("2026-09-01T12:00:00Z"),
      },
      {
        tenantId: tenant,
        shiftId: shift,
        operatorId: operator,
        raw: "raw-scan-secret",
        verdict: "duplicate",
        scannedAt: new Date("2026-09-01T13:00:00Z"),
      },
      {
        tenantId: tenant,
        shiftId: shift,
        operatorId: operator,
        raw: "raw-scan-secret",
        verdict: "ok",
        scannedAt: new Date("2026-09-01T21:00:00Z"),
      },
    ]);
    await db.insert(schema.boxes).values({
      id: box,
      tenantId: tenant,
      shiftId: shift,
      deviceBoxId: "fixture",
      operatorId: operator,
      openedAt: new Date("2026-08-20"),
      closedAt: new Date("2026-09-01T14:00:00Z"),
      sscc: "000000000000000001",
      printVerifiedAt: new Date("2026-09-02"),
      disassembledAt: new Date("2026-09-01T15:00:00Z"),
    });
    await db.insert(schema.boxes).values({
      tenantId: tenant,
      shiftId: shift,
      deviceBoxId: "next-day-closure",
      operatorId: null,
      openedAt: new Date("2026-09-01T18:00:00Z"),
      closedAt: new Date("2026-09-02T10:00:00Z"),
    });
    const otherProduct = randomUUID();
    const otherShift = randomUUID();
    await db.insert(schema.products).values({
      id: otherProduct,
      tenantId: other,
      gtin14: "00012345678901",
      name: "foreign-product-secret",
    });
    await db.insert(schema.lines).values({ id: otherLine, tenantId: other, name: "Foreign" });
    await db.insert(schema.shifts).values({
      id: otherShift,
      tenantId: other,
      productId: otherProduct,
      lineId: otherLine,
      mode: "validation",
      numberMonthKey: "SEP26",
      numberSeq: 1,
      productionDate: "2026-09-01",
      createdAt: new Date("2026-09-01T10:00:00Z"),
    });
    await db.insert(schema.scanEvents).values({
      tenantId: other,
      shiftId: otherShift,
      raw: "foreign-raw-secret",
      verdict: "ok",
      scannedAt: new Date("2026-09-01T10:00:00Z"),
    });
    await db.insert(schema.boxExceptions).values({
      tenantId: tenant,
      shiftId: shift,
      boxId: box,
      operatorId: operator,
      kind: "reprint",
      reason: "badge-secret",
      occurredAt: new Date("2026-09-01T16:00:00Z"),
    });
    await db.insert(schema.codeConflicts).values({
      tenantId: tenant,
      codeHash: "a".repeat(64),
      losingShiftId: shift,
      winningShiftId: shift,
      losingScannedAt: new Date("2026-08-20"),
      winningScannedAt: new Date("2026-08-19"),
      detectedAt: new Date("2026-09-01T17:00:00Z"),
    });
    await db.insert(schema.inventories).values({
      id: inventory,
      tenantId: tenant,
      number: "INV-1",
      productId: product,
      gtin14Snapshot: "00012345678901",
      lineId: line,
      mode: "check",
      productionDateFrom: "2026-08-01",
      productionDateTo: "2026-09-01",
      createdByUserId: user,
      createdAt: new Date("2026-09-01T10:00:00Z"),
    });
    await db.insert(schema.integrationSessions).values({
      id: session,
      tenantId: tenant,
      channelType: "commerceml",
      cookieHash: randomUUID(),
      startedAt: new Date("2026-09-01T01:00:00Z"),
      expiresAt: new Date("2026-09-02"),
      outcome: "error",
      summary: { secret: "summary-secret" },
    });
    await db.insert(schema.integrationEvents).values([
      {
        tenantId: tenant,
        channelType: "commerceml",
        sessionId: session,
        at: new Date("2026-09-01T02:00:00Z"),
        direction: "in",
        outcome: "error",
        grain: "item",
        message: "import: secret-file-and-badge",
        details: { secret: "details-secret" },
      },
      {
        tenantId: other,
        channelType: "commerceml",
        sessionId: session,
        at: new Date("2026-09-01T03:00:00Z"),
        direction: "out",
        outcome: "ok",
        grain: "item",
        message: "other-tenant-secret",
      },
    ]);
    await db.insert(schema.exchangeUploads).values({
      tenantId: other,
      sessionId: session,
      filename: "other-secret",
      chunk: 0,
      body: Buffer.from("upload-secret"),
    });
    completedInventory = await seedReportInventory(db, { tenant, product, line, operator, user });
  });
  afterAll(async () => {
    // Explicit unique test tenants; clean child tables before their parents.
    await db.execute(
      sql`UPDATE inventories SET status='ready', station_manifest=NULL, completed_at=NULL, completed_by_user_id=NULL, completion_acknowledged_at=NULL, completion_acknowledged_by_user_id=NULL WHERE tenant_id=${tenant} AND active_snapshot_id IS NOT NULL`,
    );
    await db.execute(
      sql`UPDATE inventories SET status='draft', active_snapshot_id=NULL WHERE tenant_id=${tenant}`,
    );
    for (const table of [
      "exchange_uploads",
      "integration_events",
      "integration_sessions",
      "inventory_repack_print_attempts",
      "inventory_repack_boxes",
      "inventory_event_claim_outcomes",
      "inventory_code_results",
      "inventory_scan_events",
      "inventory_scan_batches",
      "inventory_snapshot_codes",
      "inventory_snapshots",
      "inventories",
      "station_devices",
      "code_conflicts",
      "box_exceptions",
      "scan_events",
      "boxes",
      "shifts",
      "employees",
      "products",
      "lines",
    ]) {
      await db.execute(
        sql`DELETE FROM ${sql.identifier(table)} WHERE tenant_id IN (${tenant}, ${other})`,
      );
    }
    await db.execute(sql`DELETE FROM organization WHERE id IN (${tenant}, ${other})`);
    await db.execute(sql`DELETE FROM "user" WHERE id = ${user}`);
    await pool.end();
  });
  it("calculates independently windowed shift facts without scan x box multiplication", async () => {
    const result = await service.load(input);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      shift_number: "SEP26-1234/S",
      accepted_scans: 2,
      duplicate_scans: 1,
      boxes: 1,
      sscc_assigned_boxes: 1,
      print_confirmed_boxes: 0,
      disassembled_boxes: 1,
      reprint_requests: 1,
      conflicts: 1,
      first_event_at: "2026-08-31T21:00:00.000Z",
      last_event_at: "2026-09-01T18:00:00.000Z",
    });
    expect(JSON.stringify(result)).not.toContain("raw-scan-secret");
    expect(JSON.stringify(result)).not.toContain("badge-secret");
  });
  it("production_date includes all facts but never invents a production date", async () => {
    const result = await service.load({ ...input, periodBasis: "production_date" });
    expect(result.rows[0]).toMatchObject({
      accepted_scans: 3,
      print_confirmed_boxes: 1,
      first_event_at: "2026-08-20T00:00:00.000Z",
    });
    expect(
      (
        await service.load({
          ...input,
          periodBasis: "production_date",
          fromDate: "2026-09-02",
          toDate: "2026-09-02",
        })
      ).rows,
    ).toEqual([]);
  });
  it("retains old shifts with only one in-window fact source and excludes unrelated shifts", async () => {
    const ids: string[] = Array.from({ length: 9 }, () => randomUUID());
    const old = new Date("2026-08-01T00:00:00Z");
    const at = new Date("2026-09-01T12:00:00Z");
    try {
      await db.insert(schema.shifts).values(
        ids.map((id, index) => ({
          id,
          tenantId: tenant,
          productId: product,
          lineId: line,
          mode: "validation" as const,
          numberMonthKey: "AUG26",
          numberSeq: index + 1,
          createdAt: index === 7 ? at : old,
          openedAt: old,
          closedAt: old,
        })),
      );
      await db.insert(schema.scanEvents).values({
        tenantId: tenant,
        shiftId: ids[0]!,
        verdict: "ok",
        raw: "fixture",
        scannedAt: at,
      });
      for (const [index, timestamp] of [
        "openedAt",
        "closedAt",
        "printVerifiedAt",
        "disassembledAt",
      ].entries()) {
        await db.insert(schema.boxes).values({
          tenantId: tenant,
          shiftId: ids[index + 1]!,
          deviceBoxId: `fact-${index}`,
          openedAt: old,
          closedAt: old,
          printVerifiedAt: old,
          disassembledAt: old,
          [timestamp]: at,
        });
      }
      await db.insert(schema.boxExceptions).values({
        tenantId: tenant,
        shiftId: ids[5]!,
        boxId: box,
        kind: "reprint",
        reason: "fixture",
        occurredAt: at,
      });
      await db.insert(schema.codeConflicts).values({
        tenantId: tenant,
        codeHash: "b".repeat(64),
        losingShiftId: ids[6]!,
        winningShiftId: shift,
        losingScannedAt: old,
        winningScannedAt: old,
        detectedAt: at,
      });
      const result = await service.load(input);
      const included = result.rows.filter((row) => ids.includes(String(row.shift_id)));
      expect(included.map((row) => row.shift_id).sort()).toEqual(ids.slice(0, 8).sort());
      expect(included.find((row) => row.shift_id === ids[0])).toMatchObject({ accepted_scans: 1 });
      expect(included.find((row) => row.shift_id === ids[2])).toMatchObject({ boxes: 1 });
      expect(included.find((row) => row.shift_id === ids[3])).toMatchObject({
        print_confirmed_boxes: 1,
      });
      expect(included.find((row) => row.shift_id === ids[4])).toMatchObject({
        disassembled_boxes: 1,
      });
      expect(included.find((row) => row.shift_id === ids[5])).toMatchObject({
        reprint_requests: 1,
      });
      expect(included.find((row) => row.shift_id === ids[6])).toMatchObject({ conflicts: 1 });
    } finally {
      // Keep other projection tests isolated from these additional historical shifts.
      await db.execute(
        sql`DELETE FROM code_conflicts WHERE tenant_id=${tenant} AND code_hash=${"b".repeat(64)}`,
      );
      await db.execute(
        sql`DELETE FROM box_exceptions WHERE tenant_id=${tenant} AND shift_id=${ids[5]}::uuid`,
      );
      await db.execute(
        sql`DELETE FROM scan_events WHERE tenant_id=${tenant} AND shift_id=${ids[0]}::uuid`,
      );
      await db
        .delete(schema.boxes)
        .where(and(eq(schema.boxes.tenantId, tenant), inArray(schema.boxes.shiftId, ids)));
      await db
        .delete(schema.shifts)
        .where(and(eq(schema.shifts.tenantId, tenant), inArray(schema.shifts.id, ids)));
    }
  });
  it("retains unknown operators and hides conflicts where attribution is unavailable", async () => {
    const result = await service.load({ ...input, reportType: "shift_operators" });
    expect(result.rows).toHaveLength(2);
    expect(result.rows.find((row) => row.operator_id === null)).toMatchObject({
      accepted_scans: 1,
      boxes: 0,
      conflicts: null,
    });
    expect(result.rows.find((row) => row.operator_id === operator)).toMatchObject({
      accepted_scans: 1,
      boxes: 1,
      conflicts: null,
    });
    expect((await service.load({ ...input, operatorId: operator })).rows[0]).toMatchObject({
      accepted_scans: 1,
      conflicts: null,
    });
  });
  it("aggregate operator template collapses persons and removes their timestamps", async () => {
    const result = await service.load({
      ...input,
      reportType: "shift_operators",
      privacy: "aggregate",
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ accepted_scans: 2, boxes: 1 });
    expect(result.columns).not.toContain("operator_id");
    expect(result.columns).not.toContain("first_event_at");
  });
  it("missing inventory snapshot is unavailable, not zero; summary retains both operational grains", async () => {
    const result = await service.load({ ...input, reportType: "inventories" });
    expect(result.rows.find((row) => row.inventory_id === inventory)).toMatchObject({
      inventory_id: inventory,
      current_expected: null,
      current_protected: null,
      current_missing_expected: null,
      period_item_accepted: 0,
    });
    const summary = await service.load({ ...input, reportType: "summary" });
    expect(summary.rows.map((row) => row.record_type).sort()).toEqual([
      "inventory",
      "inventory",
      "shift",
    ]);
    expect(summary.definitions.inventory_projection).toContain("CURRENT");
  });
  it("separates current inventory classifications, source-event claims and confirmed print attempts", async () => {
    const result = await service.load({ ...input, reportType: "inventories" });
    expect(result.rows.find((row) => row.inventory_id === completedInventory)).toMatchObject({
      current_expected: 3,
      current_protected: 1,
      current_found_expected: 1,
      current_found_protected: 1,
      current_unknown: 1,
      current_voided: 1,
      current_missing_expected: 2,
      period_item_accepted: 1,
      period_duplicate_events: 1,
      period_rejected_events: 1,
      period_claimed_codes: 2,
      period_duplicate_codes: 2,
      period_repack_closed: 1,
      period_repack_invalidated: 0,
      period_initial_printed: 1,
      period_initial_failed: 1,
      period_reprint_printed: 1,
      period_reprint_failed: 1,
    });
    expect(JSON.stringify(result)).not.toContain("inventory-raw-secret");
    expect(JSON.stringify(result)).not.toContain("snapshot-raw-secret");
  });
  it("CommerceML selects safe journal projection and tenant-scopes upload presence", async () => {
    const result = await service.load({ ...input, reportType: "commerceml" });
    expect(result.rows).toHaveLength(2);
    expect(result.rows.find((row) => row.record_type === "session")).toMatchObject({
      current_upload_chunks: 0,
      outcome: "error",
    });
    expect(result.rows.find((row) => row.record_type === "event")).toMatchObject({
      category: "import",
      direction: "in",
      grain: "item",
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(
      (await service.load({ ...input, reportType: "commerceml", outcome: "ok" })).rows,
    ).toEqual([]);
  });
  it("rejects foreign filters and a concurrent source snapshot has an exported busy error", async () => {
    await expect(service.load({ ...input, lineId: otherLine })).rejects.toMatchObject({
      code: "REPORT_INVALID_PARAMETERS",
    });
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${REPORT_SOURCE_LOCK_KEY}::bigint)`);
      await expect(service.load(input)).rejects.toBeInstanceOf(PlatformReportSourceBusyError);
    });
  });
  it("uses one read-only repeatable snapshot across summary sources despite a concurrent commit", async () => {
    const original = inventorySource.loadInventoryRows;
    const spy = vi
      .spyOn(inventorySource, "loadInventoryRows")
      .mockImplementationOnce(async (tx, parameters) => {
        const settings = await tx.execute(
          sql`SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS read_only, current_setting('statement_timeout') AS timeout`,
        );
        expect(settings.rows[0]).toMatchObject({
          isolation: "repeatable read",
          read_only: "on",
          timeout: "1min",
        });
        await db.execute(
          sql`UPDATE products SET name='concurrent-new-name' WHERE id=${product}::uuid AND tenant_id=${tenant}`,
        );
        return original(tx, parameters);
      });
    try {
      const result = await service.load({ ...input, reportType: "summary" });
      expect(result.rows.every((row) => row.product_name === "=unsafe product")).toBe(true);
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
      await db.execute(
        sql`UPDATE products SET name='=unsafe product' WHERE id=${product}::uuid AND tenant_id=${tenant}`,
      );
    }
  });
  it("all five ZIP templates exclude credential/raw bytes and enforce every privacy mode", async () => {
    for (const reportType of [
      "shifts",
      "shift_operators",
      "inventories",
      "summary",
      "commerceml",
    ] as const) {
      for (const privacy of ["identified", "pseudonymous", "aggregate"] as const) {
        const parameters = { ...input, reportType, privacy };
        const result = await service.load(parameters);
        const files = unzipSync(renderPlatformReport(parameters, result).body);
        const text = Object.values(files)
          .map((bytes) => strFromU8(bytes))
          .join("\n");
        for (const secret of [
          "raw-scan-secret",
          "badge-secret",
          "inventory-raw-secret",
          "snapshot-raw-secret",
          "summary-secret",
          "details-secret",
          "secret-file-and-badge",
          "upload-secret",
        ])
          expect(text).not.toContain(secret);
        if (privacy !== "identified") {
          expect(text).not.toContain(operator);
          expect(text).not.toContain("=operator-secret");
        }
        if (privacy === "aggregate") {
          expect(result.columns).not.toContain("operator_id");
          expect(result.columns).not.toContain("first_event_at");
          expect(result.columns).not.toContain("last_event_at");
        }
      }
    }
  });
});
