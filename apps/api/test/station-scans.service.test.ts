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
import type { ScanItemDto } from "../src/modules/station-scans/dto";

function item(scannedAt: string): ScanItemDto {
  return {
    shiftId: "11111111-1111-1111-1111-111111111111",
    terminalId: "t1",
    raw: "RAW",
    verdict: "ok",
    scannedAt,
    code: null,
  };
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
      transaction: () => {
        throw new Error("must not open a transaction for a batch rejected by the month cap");
      },
    } as unknown as Db;
    const service = new StationScansService(dbStub);

    // One item per month across more months than the cap allows -- well
    // within `items.max(500)` (dto.ts), exactly the shape Finding 2
    // describes (up to 500 distinct months in a single request).
    const items = Array.from({ length: 8 }, (_, i) =>
      item(`2026-${String(i + 1).padStart(2, "0")}-15T00:00:00.000Z`),
    );

    await expect(
      service.applyBatch("tenant-1", { batchId: "m1:install-1:200", items }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(ensurePartitionsMock).not.toHaveBeenCalled();
  });

  it("does not reject a batch within the cap on month count alone", async () => {
    ensurePartitionsMock.mockClear().mockResolvedValue([]);
    let claimedTransaction = false;
    const dbStub = {
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
    const service = new StationScansService(dbStub);

    const items = Array.from({ length: 3 }, (_, i) => item(`2026-0${i + 1}-15T00:00:00.000Z`));

    const result = await service.applyBatch("tenant-1", {
      batchId: "m1:install-1:200",
      items,
    });

    expect(ensurePartitionsMock).toHaveBeenCalledTimes(1);
    expect(claimedTransaction).toBe(true);
    // The batch is already recorded (`onConflictDoNothing` returned no row
    // in this stub) -- this test only cares that the month cap itself did
    // not block a legitimate, small batch from reaching the transaction.
    expect(result).toEqual({ applied: 0, alreadyApplied: true });
  });
});
