import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type * as MarkiroDb from "@markiro/db";
import type { Db } from "@markiro/db";

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
import type { SyncBatchDto } from "../src/modules/station-scans/dto";

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
    const service = new StationScansService(dbStub, ssccServiceStub);

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
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        claimedTransaction = true;
        const tx = {
          insert: () => ({
            values: () => ({
              onConflictDoNothing: () => ({ returning: () => Promise.resolve([]) }),
            }),
          }),
        };
        return fn(tx);
      },
    } as unknown as Db;
    const service = new StationScansService(dbStub, ssccServiceStub);

    const items = Array.from({ length: 3 }, (_, i) => item(`2026-0${i + 1}-15T00:00:00.000Z`));

    const result = await service.applyBatch(
      "tenant-1",
      {
        batchId: "m1:install-1:200",
        items,
        boxes: [],
        exceptions: [],
      },
      "station-1",
    );

    expect(ensurePartitionsMock).toHaveBeenCalledTimes(1);
    expect(claimedTransaction).toBe(true);
    // The batch is already recorded (`onConflictDoNothing` returned no row
    // in this stub) -- this test only cares that the month cap itself did
    // not block a legitimate, small batch from reaching the transaction.
    expect(result).toEqual({ applied: 0, alreadyApplied: true, conflicts: [] });
  });
});

/**
 * Unit-level coverage for the rest of Finding 2: `ensurePartitions` used to
 * run before the shift-ownership check, so a batch full of nonexistent shift
 * ids still triggered the DDL. The e2e suite covers the same behaviour
 * end-to-end; this file isolates it with a fake `Db` that throws if a
 * `select` (the ownership guard) or a `transaction` is ever opened, so a
 * rejected batch provably never reaches either.
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
    const service = new StationScansService(dbStub, ssccServiceStub);

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

  it("rejects a batch referencing an unknown shift before ever calling ensurePartitions or opening a transaction", async () => {
    ensurePartitionsMock.mockClear();
    const dbStub = {
      select: () => ({
        from: () => ({
          // No shifts owned by this tenant -- the guard query's honest answer
          // for an unknown (or foreign-tenant) shift id.
          where: () => Promise.resolve([]),
        }),
      }),
      transaction: () => {
        throw new Error("must not open a transaction for a batch with an unknown shift");
      },
    } as unknown as Db;
    const service = new StationScansService(dbStub, ssccServiceStub);

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
    expect(ensurePartitionsMock).not.toHaveBeenCalled();
  });
});
