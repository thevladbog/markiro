import { createHash } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import type * as MarkiroDb from "@markiro/db";
import { schema, type Db } from "@markiro/db";

// Hoisted so the `vi.mock` factory below (itself hoisted above this file's
// other imports) can close over it -- same discipline `App.test.tsx` uses
// for `hardwareMock`.
const ensurePartitionsMock = vi.hoisted(() => vi.fn());

vi.mock("@markiro/db", async (importOriginal) => {
  const actual = await importOriginal<typeof MarkiroDb>();
  return { ...actual, ensurePartitions: ensurePartitionsMock };
});

import { StationScansService } from "../src/modules/station-scans/station-scans.service";
import type { SsccService } from "../src/modules/sscc/sscc.service";
import { syncBatchSchema, type SyncBatchDto } from "../src/modules/station-scans/dto";
import type { EntitlementsService } from "../src/subscriptions/entitlements.service";

function item(scannedAt: string): SyncBatchDto["items"][number] {
  return {
    shiftId: "11111111-1111-1111-1111-111111111111",
    terminalId: "t1",
    raw: "RAW",
    verdict: "invalid",
    scannedAt,
    code: null,
    boxId: null,
    operatorId: null,
  };
}

// None of this file's cases reach the box-closures loop (every item's code
// is null, so `claimItems` -- and thus the box-membership section nested
// inside it -- never runs, and every batch here carries no `boxes` either),
// so a stub that is never called satisfies StationScansService's second
// constructor argument.
const ssccServiceStub = { recordConsumedSerial: vi.fn() } as unknown as SsccService;
const entitlementsServiceStub = {
  resolveRecovery: async () => ({ access: "managed" }),
} as unknown as EntitlementsService;

describe("StationScansService box registry versioning", () => {
  it("advances a closed box with the monotonic registry cursor expression in the batch transaction", async () => {
    const boxUpdates: Array<Record<string, unknown>> = [];
    const insertedTables: unknown[] = [];
    const lockQueries: Array<{ sql: string; params: unknown[] }> = [];
    const shiftId = "11111111-1111-1111-1111-111111111111";
    const terminalId = "22222222-2222-2222-2222-222222222222";
    const dbStub = {
      transaction: async (run: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          insert: (table: unknown) => {
            insertedTables.push(table);
            return {
              values: () => ({
                onConflictDoNothing: () => ({
                  returning: () => Promise.resolve([{ batchId: "box-close-1" }]),
                }),
                onConflictDoUpdate: () => ({
                  returning: () => Promise.resolve([{ currentVersion: 1n }]),
                }),
              }),
            };
          },
          select: () => ({
            from: () => ({
              where: () => ({
                orderBy: () => ({
                  for: () => Promise.resolve([{ id: shiftId, openedAt: new Date() }]),
                }),
              }),
            }),
          }),
          execute: (query: SQL) => {
            const rendered = new PgDialect().sqlToQuery(query);
            lockQueries.push({ sql: rendered.sql, params: rendered.params });
            return Promise.resolve();
          },
          update: (table: unknown) => ({
            set: (values: Record<string, unknown>) => {
              if (table === schema.boxes) boxUpdates.push(values);
              return {
                where: () => {
                  const result = Promise.resolve({ rowCount: 1 });
                  return Object.assign(result, {
                    returning: () => Promise.resolve([{ id: "box-1" }]),
                  });
                },
              };
            },
          }),
        };
        return run(tx);
      },
    } as unknown as Db;
    const ssccService = {
      recordConsumedSerial: vi.fn().mockResolvedValue(undefined),
    } as unknown as SsccService;
    const service = new StationScansService(dbStub, ssccService, entitlementsServiceStub);

    await service.applyBatch(
      "tenant-1",
      {
        batchId: "box-close-1",
        items: [],
        boxes: [
          {
            boxId: "device-box-1",
            shiftId,
            terminalId,
            sscc: "123456789012345675",
            closedAt: "2026-07-29T11:00:00.000Z",
            operatorId: null,
            printVerifiedAt: null,
            printSkippedAt: null,
            // Explicitly "not on a pallet": the pallet pre-pass reads this
            // field, and these fixtures bypass the zod default that supplies
            // it at the HTTP boundary.
            devicePalletId: null,
          },
        ],
        exceptions: [],
      },
      terminalId,
    );

    expect(insertedTables).toContain(schema.boxRegistryVersions);
    expect(lockQueries[0]?.params).toContain("box-registry:tenant-1");
    expect(
      lockQueries.filter((query) => query.params.includes("box-registry:tenant-1")).length,
    ).toBe(1);
    expect(boxUpdates).toHaveLength(2);
    expect(boxUpdates[0]).not.toHaveProperty("registryVersion");
    expect(boxUpdates[1]?.registryVersion).toBe(1n);
    const updatedAt = boxUpdates[1]?.updatedAt;
    expect(updatedAt).toBeInstanceOf(SQL);
    const query = new PgDialect().sqlToQuery(updatedAt as SQL).sql;
    expect(query).toMatch(
      /^GREATEST\(clock_timestamp\(\), .*updated_at.* \+ interval '1 millisecond'\)$/i,
    );
  });

  it("does not acquire the tenant registry lock for an exact replay", async () => {
    const execute = vi.fn();
    const replayRows = [{ terminalId: null, payloadDigest: null, result: null }];
    const tx = {
      execute,
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({ returning: () => Promise.resolve([]) }),
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            for: () => Promise.resolve(replayRows),
          }),
        }),
      }),
    };
    // Match the actual digest by returning it through a thenable shim after
    // the service has built the query; the mismatch path is irrelevant to
    // the lock assertion, so use the legacy replay row which returns early.
    const service = new StationScansService(
      { transaction: (run: (executor: typeof tx) => unknown) => run(tx) } as never,
      ssccServiceStub,
      entitlementsServiceStub,
    );
    await service.applyBatch(
      "tenant-1",
      { batchId: "replay-1", items: [], boxes: [], exceptions: [] },
      "terminal-1",
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("locks every closure shift in sorted tenant-scoped order before updating a box", async () => {
    const firstShiftId = "11111111-1111-4111-8111-111111111111";
    const secondShiftId = "22222222-2222-4222-8222-222222222222";
    const events: string[] = [];
    const shiftQueries: Array<{ sql: string; params: unknown[] }> = [];
    let boxSequence = 0;
    const tx = {
      insert: (_table: unknown) => ({
        values: () => ({
          onConflictDoNothing: () => ({
            returning: () => Promise.resolve([{ batchId: "sorted-shift-locks" }]),
          }),
          onConflictDoUpdate: () => ({
            returning: () => Promise.resolve([{ currentVersion: 1n }]),
          }),
        }),
      }),
      select: () => ({
        from: (table: unknown) => {
          if (table !== schema.shifts) throw new Error("Unexpected select table");
          return {
            where: (condition: SQL) => {
              const query = new PgDialect().sqlToQuery(condition);
              shiftQueries.push({ sql: query.sql, params: query.params });
              events.push("shift-where");
              return {
                orderBy: (column: unknown) => {
                  expect(column).toBe(schema.shifts.id);
                  events.push("shift-order");
                  return {
                    for: (mode: string) => {
                      events.push(`shift-for-${mode}`);
                      return Promise.resolve([
                        { id: firstShiftId, openedAt: new Date() },
                        { id: secondShiftId, openedAt: new Date() },
                      ]);
                    },
                  };
                },
              };
            },
          };
        },
      }),
      execute: () => Promise.resolve(),
      update: (table: unknown) => ({
        set: () => {
          if (table === schema.boxes) events.push("box-update");
          return {
            where: () => ({
              returning: () => Promise.resolve([{ id: `box-${++boxSequence}` }]),
            }),
          };
        },
      }),
    };
    const dbStub = {
      transaction: (run: (writer: typeof tx) => Promise<unknown>) => run(tx),
    } as unknown as Db;
    const ssccService = {
      recordConsumedSerial: vi.fn().mockResolvedValue(undefined),
    } as unknown as SsccService;
    const service = new StationScansService(dbStub, ssccService, entitlementsServiceStub);

    await service.applyBatch(
      "tenant-1",
      {
        batchId: "sorted-shift-locks",
        items: [],
        boxes: [
          {
            boxId: "box-b",
            shiftId: secondShiftId,
            terminalId: "ignored",
            sscc: "223456789012345674",
            closedAt: "2026-08-21T10:00:00.000Z",
            operatorId: null,
            printVerifiedAt: null,
            printSkippedAt: null,
            // Explicitly "not on a pallet": the pallet pre-pass reads this
            // field, and these fixtures bypass the zod default that supplies
            // it at the HTTP boundary.
            devicePalletId: null,
          },
          {
            boxId: "box-a",
            shiftId: firstShiftId,
            terminalId: "ignored",
            sscc: "123456789012345675",
            closedAt: "2026-08-21T10:00:01.000Z",
            operatorId: null,
            printVerifiedAt: null,
            printSkippedAt: null,
            // Explicitly "not on a pallet": the pallet pre-pass reads this
            // field, and these fixtures bypass the zod default that supplies
            // it at the HTTP boundary.
            devicePalletId: null,
          },
          {
            boxId: "box-c",
            shiftId: firstShiftId,
            terminalId: "ignored",
            sscc: "323456789012345673",
            closedAt: "2026-08-21T10:00:02.000Z",
            operatorId: null,
            printVerifiedAt: null,
            printSkippedAt: null,
            // Explicitly "not on a pallet": the pallet pre-pass reads this
            // field, and these fixtures bypass the zod default that supplies
            // it at the HTTP boundary.
            devicePalletId: null,
          },
        ],
        exceptions: [],
      },
      "terminal-1",
    );

    expect(shiftQueries).toEqual([
      {
        sql: '("shifts"."tenant_id" = $1 and "shifts"."id" in ($2, $3))',
        params: ["tenant-1", firstShiftId, secondShiftId],
      },
    ]);
    expect(events.slice(0, 4)).toEqual([
      "shift-where",
      "shift-order",
      "shift-for-update",
      "box-update",
    ]);
  });
});

/**
 * `monthsAgo` months before "now" (real wall clock), on the 15th at
 * midnight UTC. Used to build fixtures that land safely inside
 * WINDOW_PAST_MS (3 years / 36 months, station-scans.service.ts) so the
 * month-cap tests below isolate the cap itself rather than accidentally
 * tripping the newer absolute-window check first. `setUTCFullYear` (not
 * `Date.UTC`) so a negative or >11 month argument normalizes the same way
 * the source's own month-start computation does.
 */
function monthsAgo(monthsAgo: number): string {
  const d = new Date(0);
  const now = new Date();
  d.setUTCFullYear(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 15);
  return d.toISOString();
}

/**
 * Unit-level (no real Postgres) coverage for Finding 2: a batch spanning too
 * many distinct months must be rejected before `ensurePartitions` ever runs,
 * so a corrupt or hostile `scannedAt` cannot turn into an ACCESS
 * EXCLUSIVE-lock storm on the shared `codes`/`scan_events` partitions. The
 * e2e suite (`test/station-scans.e2e.test.ts`) still covers the happy path
 * (and the month-window / two-digit-year edge cases) against a real DB; this
 * file isolates the new cap with a fake `Db` that throws if a transaction is
 * ever opened, proving a rejected batch is never even attempted.
 */
describe("StationScansService.applyBatch month cap (Finding 2)", () => {
  it("rejects a batch spanning more distinct months than the cap, without ever calling ensurePartitions or opening a transaction", async () => {
    ensurePartitionsMock.mockClear();
    const dbStub = {
      // The shift-ownership guard (Finding 2) now runs before the month cap
      // -- answer it as "owned" so this test isolates the cap itself.
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([{ id: "11111111-1111-1111-1111-111111111111" }]),
        }),
      }),
      transaction: () => {
        throw new Error("must not open a transaction for a batch rejected by the month cap");
      },
    } as unknown as Db;
    const service = new StationScansService(dbStub, ssccServiceStub, entitlementsServiceStub);

    // One item per month across more months than the cap (24) allows --
    // well within `items.max(500)` (dto.ts), exactly the shape Finding 2
    // describes (up to 500 distinct months in a single request). 30
    // consecutive months ending 5 months ago, so all 30 stay safely inside
    // the absolute timestamp window (3 years / 36 months) -- this test must
    // isolate the MONTH CAP, not the window check, which would otherwise
    // reject first and make this test pass for the wrong reason.
    const items = Array.from({ length: 30 }, (_, i) => item(monthsAgo(34 - i)));

    await expect(
      service.applyBatch(
        "tenant-1",
        {
          batchId: "m1:install-1:200",
          items,
          boxes: [],
          exceptions: [],
        },
        "station-1",
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(ensurePartitionsMock).not.toHaveBeenCalled();
  });

  it("does not reject a batch within the cap on month count alone", async () => {
    ensurePartitionsMock.mockClear().mockResolvedValue([]);
    let claimedTransaction = false;
    const reachedTransaction = new Error("reached authoritative transaction");
    const dbStub = {
      // Finding 2's early shift-ownership guard now runs before
      // `ensurePartitions`, outside the transaction -- answer it as "owned"
      // (all these items share `item()`'s fixed shiftId) so this test still
      // isolates what it actually cares about: the month cap itself.
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([{ id: "11111111-1111-1111-1111-111111111111" }]),
        }),
      }),
      transaction: async () => {
        claimedTransaction = true;
        throw reachedTransaction;
      },
    } as unknown as Db;
    const service = new StationScansService(dbStub, ssccServiceStub, entitlementsServiceStub);

    const items = Array.from({ length: 3 }, (_, i) => item(`2026-0${i + 1}-15T00:00:00.000Z`));

    await expect(
      service.applyBatch(
        "tenant-1",
        {
          batchId: "m1:install-1:200",
          items,
          boxes: [],
          exceptions: [],
        },
        "station-1",
      ),
    ).rejects.toBe(reachedTransaction);

    expect(ensurePartitionsMock).toHaveBeenCalledTimes(1);
    expect(claimedTransaction).toBe(true);
    // Reaching the transaction proves the month cap itself did not reject a
    // legitimate, small batch. Transaction behavior is covered by e2e tests.
  });
});

/**
 * Unit-level coverage for the rest of Finding 2. The pure timestamp window is
 * rejected before database work; unknown shifts are filtered out of the
 * partition preflight and then rejected only after the authoritative
 * tenant-scoped shift load is locked inside the write transaction.
 */
describe("StationScansService.applyBatch shift-ownership guard ordering (Finding 2)", () => {
  it("rejects a batch with a scannedAt outside the acceptable window before ever querying shifts, calling ensurePartitions, or opening a transaction", async () => {
    ensurePartitionsMock.mockClear();
    const dbStub = {
      select: () => {
        throw new Error("must not query shifts for a batch outside the timestamp window");
      },
      transaction: () => {
        throw new Error("must not open a transaction for a batch outside the timestamp window");
      },
    } as unknown as Db;
    const service = new StationScansService(dbStub, ssccServiceStub, entitlementsServiceStub);

    // 20 years in the past -- absurdly outside any reasonable window, and
    // nowhere near WINDOW_PAST_MS (3 years, station-scans.service.ts).
    const ancientScannedAt = new Date(Date.now() - 20 * 365 * 24 * 60 * 60 * 1000).toISOString();

    await expect(
      service.applyBatch(
        "tenant-1",
        {
          batchId: "m1:install-1:1",
          items: [item(ancientScannedAt)],
          boxes: [],
          exceptions: [],
        },
        "station-1",
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(ensurePartitionsMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown shift at the authoritative tenant-scoped transaction boundary", async () => {
    ensurePartitionsMock.mockClear();
    let openedTransaction = false;
    const dbStub = {
      select: () => ({
        from: () => ({
          // No shifts owned by this tenant -- the guard query's honest answer
          // for an unknown (or foreign-tenant) shift id.
          where: () => Promise.resolve([]),
        }),
      }),
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        openedTransaction = true;
        const tx = {
          execute: () => Promise.resolve(),
          insert: () => ({
            values: () => ({
              onConflictDoNothing: () => ({
                returning: () => Promise.resolve([{ batchId: "m1:install-1:1" }]),
              }),
            }),
          }),
          select: () => ({
            from: () => ({
              where: () => ({
                orderBy: () => ({ for: () => Promise.resolve([]) }),
              }),
            }),
          }),
        };
        return fn(tx);
      },
    } as unknown as Db;
    const service = new StationScansService(dbStub, ssccServiceStub, entitlementsServiceStub);

    // Well within the timestamp window, so this isolates the shift-ownership
    // rejection rather than the window one.
    const items = [item(new Date().toISOString())];

    await expect(
      service.applyBatch(
        "tenant-1",
        {
          batchId: "m1:install-1:1",
          items,
          boxes: [],
          exceptions: [],
        },
        "station-1",
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(openedTransaction).toBe(true);
    expect(ensurePartitionsMock).toHaveBeenCalledWith(dbStub, []);
  });
});

describe("StationScansService sync batch payload digest", () => {
  // The exact serializer the service pins its digests with: sorted keys, no
  // whitespace. Duplicated deliberately -- this suite exists to pin the
  // BYTES a digest is taken over, so importing the production helper would
  // make the assertion move with the code it is supposed to hold still.
  const stableJson = (value: unknown): string => {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  };
  const sha256 = (value: unknown): string =>
    createHash("sha256").update(stableJson(value)).digest("hex");

  const legacyDigestTx = (
    captured: Record<string, unknown>[],
    batchId: string,
    shiftRows: Record<string, unknown>[] = [],
  ) => ({
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        if (table === schema.syncBatches) captured.push(values);
        return {
          onConflictDoNothing: () => ({
            returning: () => Promise.resolve([{ batchId }]),
          }),
          onConflictDoUpdate: () => ({
            returning: () => Promise.resolve([{ currentVersion: 1n }]),
          }),
        };
      },
    }),
    select: () => ({
      from: () => ({
        // `where(...)` is awaited directly on some paths and refined with
        // `.for("update")` / `.orderBy(...)` on others, so the stub answers
        // both: an empty row set everywhere except the locked shift lookup.
        where: () => ({
          for: () => Promise.resolve([]),
          orderBy: () => ({ for: () => Promise.resolve(shiftRows) }),
          then: (resolve: (rows: Record<string, unknown>[]) => unknown) =>
            Promise.resolve([]).then(resolve),
        }),
      }),
    }),
    execute: () => Promise.resolve(),
    update: () => ({
      set: () => ({ where: () => Promise.resolve({ rowCount: 0 }) }),
    }),
  });

  it("hashes a legacy wire payload exactly as it did before warehouse pallet memberships existed", async () => {
    const captured: Record<string, unknown>[] = [];
    const tx = legacyDigestTx(captured, "legacy-digest-1");
    const service = new StationScansService(
      { transaction: (run: (executor: typeof tx) => unknown) => run(tx) } as never,
      ssccServiceStub,
      entitlementsServiceStub,
    );

    // The wire payload a pre-warehouse-pallet device sends, parsed through
    // the real schema so every zod default that a newer release added --
    // `palletMemberships: []` among them -- is present exactly as it is at
    // the HTTP boundary.
    const wire = { batchId: "legacy-digest-1", items: [], boxes: [], exceptions: [] };
    const body = syncBatchSchema.parse(wire);
    expect(body.palletMemberships).toEqual([]);

    await service.applyBatch("tenant-1", body, "station-1");

    // The pinned digest: the canonical object as the pre-feature release
    // built it. An empty `palletMemberships` that leaked into the hash would
    // move this, and the device would get `station_batch_mismatch` (409) for
    // the batch it is retrying, forever.
    expect(captured).toHaveLength(1);
    expect(captured[0]?.payloadDigest).toBe(
      sha256({ batchId: "legacy-digest-1", items: [], boxes: [], exceptions: [] }),
    );
  });

  it("hashes a legacy production pallet closure and exception without the warehouse keys", async () => {
    const captured: Record<string, unknown>[] = [];
    const shiftId = "11111111-1111-4111-8111-111111111111";
    const tx = legacyDigestTx(captured, "legacy-digest-2", [
      {
        id: shiftId,
        openedAt: new Date("2026-09-01T06:00:00.000Z"),
        allowPreviouslyAcceptedCodes: false,
      },
    ]);
    const service = new StationScansService(
      { transaction: (run: (executor: typeof tx) => unknown) => run(tx) } as never,
      ssccServiceStub,
      entitlementsServiceStub,
    );

    // A pre-warehouse-pallet device's production closure and disassembly: it
    // names neither `kind` nor `productId`, which zod now defaults onto the
    // parsed object.
    const operatorId = "22222222-2222-4222-8222-222222222222";
    const closure = {
      palletId: "device-pallet-1",
      shiftId,
      terminalId: "wire-terminal",
      // Extension digit 1: the pallet SSCC space, so the closure path logs no
      // warning about a serial recorded against another block.
      sscc: "100468200000000018",
      closedAt: "2026-09-01T10:00:00.000Z",
      operatorId,
      printVerifiedAt: "2026-09-01T10:00:05.000Z",
      printSkippedAt: null,
    };
    const exception = {
      kind: "disassemble" as const,
      palletId: "device-pallet-0",
      shiftId,
      terminalId: "wire-terminal",
      operatorId,
      reason: "перепечатка",
      occurredAt: "2026-09-01T10:01:00.000Z",
    };
    const body = syncBatchSchema.parse({
      batchId: "legacy-digest-2",
      items: [],
      boxes: [],
      exceptions: [],
      pallets: [closure],
      palletExceptions: [exception],
    });
    expect(body.pallets[0]).toMatchObject({ kind: "production", productId: null });

    await service.applyBatch("tenant-1", body, "station-1");

    // The canonical object the pre-warehouse release built: the closure
    // without `kind`/`productId`, no `palletMemberships` key at all, and the
    // authenticated terminal substituted into both pallet channels.
    expect(captured).toHaveLength(1);
    expect(captured[0]?.payloadDigest).toBe(
      sha256({
        batchId: "legacy-digest-2",
        items: [],
        boxes: [],
        exceptions: [],
        pallets: [{ ...closure, terminalId: "station-1" }],
        palletExceptions: [{ ...exception, terminalId: "station-1" }],
      }),
    );
  });
});
