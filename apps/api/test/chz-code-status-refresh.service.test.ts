import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createDb, ensurePartitions, schema, type Db } from "@markiro/db";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, eq } from "drizzle-orm";
import { Logger } from "@nestjs/common";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ChzCodeStatusRefreshService,
  CHZ_STATUS_MAX_BATCHES_PER_PASS,
  CHZ_STATUS_UNKNOWN_RETRY_LIMIT,
} from "../src/modules/chz-code-statuses/chz-code-status-refresh.service";
import type { ChzTokenService } from "../src/modules/chz-exports/chz-token.service";
import type { TrueApiClient } from "../src/modules/chz-exports/true-api.client";
import type { CisInfo, TrueApiResult } from "../src/modules/chz-exports/true-api.types";
import type { JournalService } from "../src/modules/integrations/journal.service";

const ready = Boolean(process.env.DATABASE_URL);
const PRODUCT_GTIN = "04600000000015";
const TEST_TOKEN = "eyJhbGciOiJub25lIn0.super-secret-true-api-token";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

/** What the Station scanned. */
function scannedRaw(codeHash: string): string {
  return `01${PRODUCT_GTIN}21${codeHash.slice(0, 20)}`;
}

/**
 * What an ordered export delivered. Deliberately distinct from `scannedRaw`
 * so a test can tell which of the two sources a raw came from -- in
 * production both sources carry the same string for one hash.
 */
function exportedRaw(codeHash: string): string {
  return `01${PRODUCT_GTIN}21${codeHash.slice(0, 20)}EXPORTED`;
}

const RAW_A = scannedRaw(HASH_A);
const RAW_B = scannedRaw(HASH_B);

// All scanned test data lives on this one day, well inside a single monthly
// partition, so one `ensurePartitions` call up front covers every test here.
const BASE_SCANNED_AT = new Date("2026-01-15T00:00:00.000Z");

function past(hours: number): Date {
  return new Date(Date.now() - hours * 3_600_000);
}

function future(hours: number): Date {
  return new Date(Date.now() + hours * 3_600_000);
}

function hoursUntil(at: Date): number {
  return (at.getTime() - Date.now()) / 3_600_000;
}

function daysUntil(at: Date): number {
  return (at.getTime() - Date.now()) / 86_400_000;
}

function hash(index: number): string {
  return index.toString(16).padStart(64, "0");
}

interface CisesInfoCall {
  productGroupCode: number;
  cises: string[];
}

interface FakeClient {
  api: TrueApiClient;
  calls: CisesInfoCall[];
  answer: (rows: CisInfo[]) => void;
  fail: (result: Exclude<TrueApiResult<CisInfo[]>, { status: "ok" }>) => void;
}

/**
 * The real client has its own suite; what needs testing here is which codes
 * are asked about and what is written down afterwards, so the transport is a
 * fake that records every call. It answers with nothing by default -- ЧЗ
 * having no opinion about a code is a real outcome, not a setup mistake.
 */
function fakeClient(): FakeClient {
  const calls: CisesInfoCall[] = [];
  let answer: CisInfo[] = [];
  let failure: Exclude<TrueApiResult<CisInfo[]>, { status: "ok" }> | null = null;
  const api = {
    cisesInfo: vi.fn(async (_auth: unknown, productGroupCode: number, cises: string[]) => {
      calls.push({ productGroupCode, cises: [...cises] });
      return failure ?? { status: "ok" as const, value: answer };
    }),
  };
  return {
    api: api as unknown as TrueApiClient,
    calls,
    answer: (rows) => {
      answer = rows;
    },
    fail: (result) => {
      failure = result;
    },
  };
}

describe.skipIf(!ready)("ChzCodeStatusRefreshService", () => {
  const databaseName = `markiro_chz_code_status_refresh_${randomUUID().replaceAll("-", "_")}`;
  const maintenanceUrl = process.env.DATABASE_URL ?? "postgres://invalid";
  const scratchUrl = new URL(maintenanceUrl);
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenance = createDb(maintenanceUrl);
  let connection: ReturnType<typeof createDb>;
  let db: Db;
  let service: ChzCodeStatusRefreshService;

  let tenantId: string;
  let userId: string;
  let productId: string;
  let lineId: string;
  let shiftId: string;
  let inventoryId: string;
  let snapshotId: string;

  let client: FakeClient;
  let tokens: { getActiveToken: ReturnType<typeof vi.fn> };
  let journal: { append: ReturnType<typeof vi.fn> };

  beforeAll(async () => {
    await maintenance.pool.query(`CREATE DATABASE "${databaseName}"`);
    connection = createDb(scratchUrl.toString(), { max: 8 });
    await migrate(connection.db, {
      migrationsFolder: join(__dirname, "../../../packages/db/migrations"),
    });
    db = connection.db;
    await ensurePartitions(db, [BASE_SCANNED_AT]);
  }, 120_000);

  afterAll(async () => {
    await connection?.pool.end();
    await maintenance.pool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await maintenance.pool.end();
  });

  beforeEach(async () => {
    tenantId = randomUUID();
    userId = randomUUID();
    productId = randomUUID();
    lineId = randomUUID();
    shiftId = randomUUID();
    inventoryId = randomUUID();
    snapshotId = randomUUID();

    await db.insert(schema.organization).values({
      id: tenantId,
      name: "Refresh fixture tenant",
      slug: `refresh-${tenantId}`,
      createdAt: new Date(),
    });
    await db.insert(schema.user).values({
      id: userId,
      name: "Refresh fixture user",
      email: `${randomUUID()}@example.invalid`,
      emailVerified: false,
    });
    await db.insert(schema.products).values({
      id: productId,
      tenantId,
      gtin14: PRODUCT_GTIN,
      name: "Refresh fixture product",
      chzProductGroupCode: 8, // milk
    });
    await db.insert(schema.lines).values({ id: lineId, tenantId, name: "Refresh fixture line" });
    await db.insert(schema.shifts).values({
      id: shiftId,
      tenantId,
      productId,
      lineId,
      mode: "aggregation",
      numberMonthKey: "JAN26",
      numberSeq: 1,
    });
    await db.insert(schema.inventories).values({
      id: inventoryId,
      tenantId,
      number: `INV-${randomUUID()}`,
      productId,
      gtin14Snapshot: PRODUCT_GTIN,
      lineId,
      mode: "check",
      productionDateFrom: "2026-01-01",
      productionDateTo: "2026-01-31",
      createdByUserId: userId,
    });
    await db.insert(schema.inventorySnapshots).values({
      id: snapshotId,
      tenantId,
      inventoryId,
      combinedDigest: "0".repeat(64),
      productName: "Refresh fixture product",
      lineName: "Refresh fixture line",
      emittedCount: 0,
      introducedCount: 0,
      appliedCount: 0,
      retiredCount: 0,
      writtenOffCount: 0,
      disaggregationCount: 0,
      protectedCount: 0,
      expectedCount: 0,
      packageCount: 0,
      looseCount: 0,
      fixedByUserId: userId,
    });

    client = fakeClient();
    tokens = {
      getActiveToken: vi.fn().mockResolvedValue({
        status: "ok",
        auth: { baseUrl: "https://true-api.invalid", token: TEST_TOKEN },
      }),
    };
    journal = { append: vi.fn().mockResolvedValue(undefined) };
    service = new ChzCodeStatusRefreshService(
      db,
      tokens as unknown as ChzTokenService,
      client.api,
      journal as unknown as JournalService,
    );
  });

  async function seedScannedCode(codeHash: string): Promise<void> {
    await db.insert(schema.codes).values({
      tenantId,
      codeHash,
      shiftId,
      gtin14: PRODUCT_GTIN,
      serial: `S-${codeHash.slice(0, 12)}`,
      canonicalRaw: scannedRaw(codeHash),
      scannedAt: BASE_SCANNED_AT,
    });
  }

  async function seedExportedCode(codeHash: string): Promise<void> {
    await db.insert(schema.inventorySnapshotCodes).values({
      tenantId,
      snapshotId,
      canonicalRaw: exportedRaw(codeHash),
      codeHash,
      gtin14: PRODUCT_GTIN,
      serial: codeHash.slice(0, 12),
      sourceStatus: "INTRODUCED",
      sourceProductionDate: "2026-01-15",
      expected: false,
      protected: false,
    });
  }

  async function seedStatus(input: {
    codeHash: string;
    group: number | null;
    status?: string;
    withdrawReason?: string;
    unknownAttempts?: number;
    nextRefreshAt: Date;
    /** Which source (if any) holds the raw code. Defaults to a Station scan. */
    source?: "scanned" | "exported" | "both" | "none";
  }): Promise<void> {
    const source = input.source ?? "scanned";
    if (source === "scanned" || source === "both") await seedScannedCode(input.codeHash);
    if (source === "exported" || source === "both") await seedExportedCode(input.codeHash);
    await db.insert(schema.chzCodeStatuses).values({
      tenantId,
      codeHash: input.codeHash,
      chzProductGroupCode: input.group,
      status: input.status ?? null,
      withdrawReason: input.withdrawReason ?? null,
      unknownAttempts: input.unknownAttempts ?? 0,
      nextRefreshAt: input.nextRefreshAt,
    });
  }

  async function makeDue(codeHash: string): Promise<void> {
    await db
      .update(schema.chzCodeStatuses)
      .set({ nextRefreshAt: past(1) })
      .where(
        and(
          eq(schema.chzCodeStatuses.tenantId, tenantId),
          eq(schema.chzCodeStatuses.codeHash, codeHash),
        ),
      );
  }

  async function rowsFor(id: string) {
    return db
      .select()
      .from(schema.chzCodeStatuses)
      .where(eq(schema.chzCodeStatuses.tenantId, id))
      .orderBy(schema.chzCodeStatuses.codeHash);
  }

  it("asks only about due rows that have a product group, oldest first", async () => {
    await seedStatus({ codeHash: HASH_A, group: 8, nextRefreshAt: past(2) });
    await seedStatus({ codeHash: HASH_B, group: 8, nextRefreshAt: past(1) });
    await seedStatus({ codeHash: HASH_C, group: null, nextRefreshAt: past(3) });
    await seedStatus({ codeHash: HASH_D, group: 8, nextRefreshAt: future(1) });

    await service.run(tenantId);

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.cises).toEqual([RAW_A, RAW_B]);
  });

  it("splits a batch per product group, because pg is a query parameter", async () => {
    await seedStatus({ codeHash: HASH_A, group: 8, nextRefreshAt: past(1) });
    await seedStatus({ codeHash: HASH_B, group: 15, nextRefreshAt: past(1) });

    await service.run(tenantId);

    expect(client.calls.map((call) => call.productGroupCode).sort((a, b) => a - b)).toEqual([
      8, 15,
    ]);
    for (const call of client.calls) expect(call.cises).toHaveLength(1);
  });

  it("writes back the facts and sets the daily interval for a code in circulation", async () => {
    await seedStatus({ codeHash: HASH_A, group: 8, nextRefreshAt: past(1) });
    client.answer([
      {
        cis: RAW_A,
        status: "INTRODUCED",
        statusEx: "MOVING_BY_UD",
        ownerInn: "7700000000",
        withdrawReason: null,
      },
    ]);

    const result = await service.run(tenantId);

    const [row] = await rowsFor(tenantId);
    expect(row).toMatchObject({
      status: "INTRODUCED",
      statusEx: "MOVING_BY_UD",
      ownerInn: "7700000000",
      unknownAttempts: 0,
    });
    expect(row!.checkedAt).not.toBeNull();
    expect(hoursUntil(row!.nextRefreshAt)).toBeCloseTo(24, 0);
    expect(result).toMatchObject({ batches: 1, updated: 1, caughtUp: true });
  });

  it("gives a withdrawn code the monthly interval without retiring it", async () => {
    await seedStatus({ codeHash: HASH_A, group: 8, nextRefreshAt: past(1) });
    client.answer([
      { cis: RAW_A, status: "RETIRED", statusEx: null, ownerInn: null, withdrawReason: "SOLD" },
    ]);

    await service.run(tenantId);

    const [row] = await rowsFor(tenantId);
    expect(row!.status).toBe("RETIRED");
    expect(row!.withdrawReason).toBe("SOLD");
    // Not null: ЧЗ permits returning a code to circulation, so a withdrawn
    // code must stay in the queue, just far out.
    expect(row!.nextRefreshAt).not.toBeNull();
    expect(daysUntil(row!.nextRefreshAt)).toBeCloseTo(30, 0);
  });

  it("returns a revived code to the daily interval", async () => {
    await seedStatus({
      codeHash: HASH_A,
      group: 8,
      status: "RETIRED",
      withdrawReason: "SOLD",
      nextRefreshAt: past(1),
    });
    client.answer([
      { cis: RAW_A, status: "INTRODUCED", statusEx: null, ownerInn: null, withdrawReason: null },
    ]);

    await service.run(tenantId);

    const [row] = await rowsFor(tenantId);
    expect(hoursUntil(row!.nextRefreshAt)).toBeCloseTo(24, 0);
    // The stale reason is cleared, not kept: every fact column is ЧЗ's
    // current answer, including the ones it answered null for.
    expect(row!.withdrawReason).toBeNull();
  });

  it("treats an unrecognised status as in circulation", async () => {
    await seedStatus({ codeHash: HASH_A, group: 8, nextRefreshAt: past(1) });
    client.answer([
      { cis: RAW_A, status: "SOMETHING_NEW", statusEx: null, ownerInn: null, withdrawReason: null },
    ]);

    await service.run(tenantId);

    const [row] = await rowsFor(tenantId);
    expect(row!.status).toBe("SOMETHING_NEW");
    expect(hoursUntil(row!.nextRefreshAt)).toBeCloseTo(24, 0);
  });

  it("counts a code ЧЗ did not answer for, and backs it off after the retry limit", async () => {
    await seedStatus({ codeHash: HASH_A, group: 8, nextRefreshAt: past(1) });
    client.answer([]);

    for (let attempt = 1; attempt <= CHZ_STATUS_UNKNOWN_RETRY_LIMIT; attempt += 1) {
      await makeDue(HASH_A);
      await service.run(tenantId);
      expect((await rowsFor(tenantId))[0]!.unknownAttempts).toBe(attempt);
    }

    // Never dropped: an unknown code means it belongs to someone else or is
    // malformed, and that is a fact the operator needs.
    const [row] = await rowsFor(tenantId);
    expect(row!.status).toBeNull();
    // No answer, so nothing was checked: `checkedAt` marks the moment ЧЗ last
    // stated the facts, never the moment we last asked.
    expect(row!.checkedAt).toBeNull();
    expect(daysUntil(row!.nextRefreshAt)).toBeCloseTo(30, 0);
  });

  it("retries an unknown code on the short interval while it is under the limit", async () => {
    await seedStatus({ codeHash: HASH_A, group: 8, nextRefreshAt: past(1) });
    client.answer([]);

    await service.run(tenantId);

    const [row] = await rowsFor(tenantId);
    expect(row!.unknownAttempts).toBe(1);
    expect(hoursUntil(row!.nextRefreshAt)).toBeCloseTo(24, 0);
  });

  it("leaves rows due and untouched when the call fails transiently", async () => {
    await seedStatus({ codeHash: HASH_A, group: 8, status: "INTRODUCED", nextRefreshAt: past(1) });
    client.fail({ status: "unavailable" });

    const result = await service.run(tenantId);

    const [row] = await rowsFor(tenantId);
    // A failed batch must never advance checkedAt: staleness has to stay
    // visible rather than be papered over by a timestamp that records an
    // attempt instead of an answer.
    expect(row).toMatchObject({ status: "INTRODUCED", checkedAt: null, unknownAttempts: 0 });
    expect(row!.nextRefreshAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(result.caughtUp).toBe(false);
    // The batch touched nothing, so this pass is not journalled as a
    // success: `ok` here is exactly the lie an operator's channel card would
    // repeat while ЧЗ stays unreachable for a day.
    expect(result.batches).toBe(0);
    expect(journal.append).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "warn",
        details: expect.objectContaining({ batches: 0, updated: 0, stopReason: "unavailable" }),
      }),
    );
  });

  it("stops the pass on a transient failure instead of working through the other groups", async () => {
    await seedStatus({ codeHash: HASH_A, group: 8, nextRefreshAt: past(2) });
    await seedStatus({ codeHash: HASH_B, group: 15, nextRefreshAt: past(1) });
    client.fail({ status: "unavailable" });

    await service.run(tenantId);

    // ЧЗ being unreachable is not a fact about one product group.
    expect(client.calls).toHaveLength(1);
  });

  it("backs a rejected product group off instead of retrying the refusal forever", async () => {
    await seedStatus({ codeHash: HASH_A, group: 8, nextRefreshAt: past(1) });
    client.fail({ status: "rejected", code: "400", message: "no active contract" });

    await service.run(tenantId);

    const [row] = await rowsFor(tenantId);
    expect(daysUntil(row!.nextRefreshAt)).toBeCloseTo(30, 0);
    // The refusal is the operator's to act on, so ЧЗ's own words reach the journal.
    expect(JSON.stringify(journal.append.mock.calls)).toContain("no active contract");
  });

  it("carries on with the next product group after one is rejected", async () => {
    await seedStatus({ codeHash: HASH_A, group: 8, nextRefreshAt: past(2) });
    await seedStatus({ codeHash: HASH_B, group: 15, nextRefreshAt: past(1) });
    client.fail({ status: "rejected", code: "403", message: "no active contract" });

    const result = await service.run(tenantId);

    expect(client.calls).toHaveLength(2);
    // A refusal is terminal for that group, not for the pass: nothing is left due.
    expect(result.caughtUp).toBe(true);
  });

  it("does nothing and reports not caught up when no token is available", async () => {
    await seedStatus({ codeHash: HASH_A, group: 8, nextRefreshAt: past(1) });
    tokens.getActiveToken.mockResolvedValue({ status: "expired" });

    const result = await service.run(tenantId);

    expect(client.calls).toHaveLength(0);
    expect(result).toMatchObject({ batches: 0, caughtUp: false });
    expect((await rowsFor(tenantId))[0]!.checkedAt).toBeNull();
  });

  it("stops the pass when ЧЗ rejects the bearer, leaving the batch untouched", async () => {
    await seedStatus({ codeHash: HASH_A, group: 8, status: "INTRODUCED", nextRefreshAt: past(1) });
    await seedStatus({ codeHash: HASH_B, group: 15, nextRefreshAt: past(1) });
    client.fail({ status: "unauthorized" });

    const result = await service.run(tenantId);

    expect(client.calls).toHaveLength(1);
    expect(result.caughtUp).toBe(false);
    const [row] = await rowsFor(tenantId);
    expect(row).toMatchObject({ status: "INTRODUCED", checkedAt: null, unknownAttempts: 0 });
    expect(row!.nextRefreshAt.getTime()).toBeLessThanOrEqual(Date.now());
    // Its own warn, distinct from the pass summary: the tenant's agent has to
    // sign in again, and that is the operator's to act on.
    expect(journal.append).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "warn",
        message: "Статусы кодов Честного Знака не обновлены: нет токена",
        details: expect.objectContaining({ tokenStatus: "unauthorized" }),
      }),
    );
    // And the pass summary itself must not paper over the stoppage with `ok`.
    expect(journal.append).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "warn",
        details: expect.objectContaining({ stopReason: "unauthorized" }),
      }),
    );
  });

  it("never writes the token into the journal", async () => {
    await seedStatus({ codeHash: HASH_A, group: 8, nextRefreshAt: past(1) });
    await service.run(tenantId);
    expect(journal.append).toHaveBeenCalled();
    expect(JSON.stringify(journal.append.mock.calls)).not.toContain(TEST_TOKEN);
  });

  it("asks about a code that only an ordered export delivered", async () => {
    // A tenant bootstrapped from an export has a status row but no scan: its
    // raw lives in `inventory_snapshot_codes` and nowhere else.
    await seedStatus({ codeHash: HASH_A, group: 8, nextRefreshAt: past(1), source: "exported" });

    await service.run(tenantId);

    expect(client.calls[0]!.cises).toEqual([exportedRaw(HASH_A)]);
  });

  it("prefers the scanned raw when both sources hold the code", async () => {
    await seedStatus({ codeHash: HASH_A, group: 8, nextRefreshAt: past(1), source: "both" });

    await service.run(tenantId);

    expect(client.calls[0]!.cises).toEqual([RAW_A]);
  });

  it("skips a code no source can resolve and pushes it out instead of failing it", async () => {
    // Its `codes` partition was detached and it never came from an export.
    // Unrefreshable by construction -- this is how archived codes leave the
    // queue.
    await seedStatus({ codeHash: HASH_A, group: 8, nextRefreshAt: past(1), source: "none" });

    const result = await service.run(tenantId);

    expect(client.calls).toHaveLength(0);
    const [row] = await rowsFor(tenantId);
    expect(row).toMatchObject({ status: null, unknownAttempts: 0, checkedAt: null });
    expect(daysUntil(row!.nextRefreshAt)).toBeCloseTo(30, 0);
    expect(result.caughtUp).toBe(true);
  });

  it("still asks about the resolvable codes of a batch that also holds an unresolvable one", async () => {
    await seedStatus({ codeHash: HASH_A, group: 8, nextRefreshAt: past(2), source: "none" });
    await seedStatus({ codeHash: HASH_B, group: 8, nextRefreshAt: past(1) });

    await service.run(tenantId);

    expect(client.calls[0]!.cises).toEqual([RAW_B]);
  });

  it("ignores an answer about a code it did not ask about", async () => {
    await seedStatus({ codeHash: HASH_A, group: 8, nextRefreshAt: past(1) });
    await seedStatus({ codeHash: HASH_B, group: 8, nextRefreshAt: future(1) });
    client.answer([
      { cis: RAW_A, status: "INTRODUCED", statusEx: null, ownerInn: null, withdrawReason: null },
      { cis: RAW_B, status: "RETIRED", statusEx: null, ownerInn: null, withdrawReason: "SOLD" },
    ]);

    await service.run(tenantId);

    const rows = await rowsFor(tenantId);
    expect(rows[0]).toMatchObject({ codeHash: HASH_A, status: "INTRODUCED" });
    // B was not in the batch, so ЧЗ's row about it is not ours to write down.
    expect(rows[1]).toMatchObject({ codeHash: HASH_B, status: null, checkedAt: null });
    // The mismatch is journalled, not silently dropped: the request and the
    // answer disagreeing about what was asked is the operator's to notice.
    expect(journal.append).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "warn",
        message: "Честный Знак ответил о кодах, о которых не спрашивали",
        details: expect.objectContaining({ productGroupCode: 8, unexpected: 1 }),
      }),
    );
  });

  it("splits a mixed answer within one batch: the answered row and the silent one each get their own outcome", async () => {
    // Both rows share a group, so both land in the same `cises/info` call --
    // unlike the "ignores an answer" case above, where the second row sits
    // outside the batch entirely. This exercises the disjoint partition of
    // one batch's own hashes into found and unknown, not the unexpected-cis
    // path.
    await seedStatus({
      codeHash: HASH_A,
      group: 8,
      status: "SOMETHING_OLD",
      nextRefreshAt: past(2),
    });
    await seedStatus({
      codeHash: HASH_B,
      group: 8,
      status: "SOMETHING_OLD",
      nextRefreshAt: past(1),
    });
    client.answer([
      {
        cis: RAW_A,
        status: "INTRODUCED",
        statusEx: "MOVING_BY_UD",
        ownerInn: null,
        withdrawReason: null,
      },
    ]);

    await service.run(tenantId);

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.cises).toEqual([RAW_A, RAW_B]);

    const rows = await rowsFor(tenantId);
    const rowA = rows.find((row) => row.codeHash === HASH_A);
    const rowB = rows.find((row) => row.codeHash === HASH_B);

    // Answered: ЧЗ's facts are written down and the daily interval applies.
    expect(rowA).toMatchObject({ status: "INTRODUCED", statusEx: "MOVING_BY_UD" });
    expect(rowA!.checkedAt).not.toBeNull();
    expect(hoursUntil(rowA!.nextRefreshAt)).toBeCloseTo(24, 0);

    // Unanswered: silence is counted, facts and status are left alone.
    expect(rowB).toMatchObject({ status: "SOMETHING_OLD", unknownAttempts: 1 });
    expect(rowB!.checkedAt).toBeNull();
    expect(hoursUntil(rowB!.nextRefreshAt)).toBeCloseTo(24, 0);
  });

  it("stops after the per-pass batch cap and reports itself not caught up", async () => {
    // One product group per row, so every row needs its own call: the cheapest
    // way to build more batches than a pass may spend.
    const groups = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 19, 20, 21, 22];
    expect(groups).toHaveLength(CHZ_STATUS_MAX_BATCHES_PER_PASS + 1);
    for (const [index, group] of groups.entries()) {
      await seedStatus({ codeHash: hash(index + 1), group, nextRefreshAt: past(1) });
    }

    const result = await service.run(tenantId);

    expect(client.calls).toHaveLength(CHZ_STATUS_MAX_BATCHES_PER_PASS);
    expect(result).toMatchObject({ batches: CHZ_STATUS_MAX_BATCHES_PER_PASS, caughtUp: false });
    const stillDue = (await rowsFor(tenantId)).filter(
      (row) => row.nextRefreshAt.getTime() <= Date.now(),
    );
    expect(stillDue).toHaveLength(1);
  });

  it("does nothing at all when no row is due", async () => {
    await seedStatus({ codeHash: HASH_A, group: 8, nextRefreshAt: future(1) });

    const result = await service.run(tenantId);

    expect(client.calls).toHaveLength(0);
    expect(result).toMatchObject({ batches: 0, updated: 0, caughtUp: true });
    // A pass with nothing to do writes no audit entry: the journal is for
    // events, and a cron tick over an idle tenant is not one.
    expect(journal.append).not.toHaveBeenCalled();
  });

  it("leaves another tenant's due rows alone", async () => {
    const otherTenantId = randomUUID();
    await db.insert(schema.organization).values({
      id: otherTenantId,
      name: "Other tenant",
      slug: `other-${otherTenantId}`,
      createdAt: new Date(),
    });
    await db.insert(schema.chzCodeStatuses).values({
      tenantId: otherTenantId,
      codeHash: HASH_A,
      chzProductGroupCode: 8,
      nextRefreshAt: past(1),
    });
    await seedStatus({ codeHash: HASH_B, group: 8, nextRefreshAt: past(1) });

    await service.run(tenantId);

    expect(client.calls[0]!.cises).toEqual([RAW_B]);
    const [row] = await rowsFor(otherTenantId);
    expect(row).toMatchObject({ unknownAttempts: 0, checkedAt: null });
    expect(row!.nextRefreshAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("finishes the pass when the journal write fails", async () => {
    await seedStatus({ codeHash: HASH_A, group: 8, nextRefreshAt: past(1) });
    client.answer([
      { cis: RAW_A, status: "INTRODUCED", statusEx: null, ownerInn: null, withdrawReason: null },
    ]);
    journal.append.mockRejectedValue(new Error("journal is down"));
    const logged = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

    try {
      const result = await service.run(tenantId);

      // A failed audit write is not a reason to abandon a pass.
      expect(result).toMatchObject({ updated: 1, caughtUp: true });
      expect((await rowsFor(tenantId))[0]!.status).toBe("INTRODUCED");
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });
});
