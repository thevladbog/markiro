import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { schema, type Db } from "@markiro/db";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  SHIFT_EXPORT_SAFE_ERROR_CODES,
  ShiftExportRunnerService,
} from "../src/modules/shift-exports/shift-export-runner.service";
import {
  ShiftExportSourceError,
  type ShiftExportSnapshot,
  type ShiftExportSourceService,
} from "../src/modules/shift-exports/shift-export-source.service";
import type { ObjectStorageService } from "../src/modules/storage/object-storage.service";

const EXPORT_ID = "11111111-1111-4111-8111-111111111111";
const SNAPSHOT_AT = new Date("2026-08-13T12:34:56.789Z");

interface ExportRow {
  id: string;
  tenantId: string;
  shiftId: string;
  formatId: string;
  formatVersion: number;
  maxLines: number | null;
  status: "queued" | "processing" | "ready" | "failed";
  errorCode: string | null;
  productNameSnapshot: string | null;
  shiftDateSnapshot: string | null;
  totalCodeCount: number | null;
  totalBoxCount: number | null;
  createdByUserId: string;
  sourceSnapshotStartedAt: Date | null;
  completedAt: Date | null;
  attemptCount: number;
}

interface State {
  row: ExportRow;
  artifacts: Record<string, unknown>[];
  audits: Record<string, unknown>[];
}

interface FakeDb {
  db: Db;
  state: State;
  transactions: { insertedArtifacts: number; markedReady: boolean }[];
  updatePredicates: unknown[];
}

function baseRow(overrides: Partial<ExportRow> = {}): ExportRow {
  return {
    id: EXPORT_ID,
    tenantId: "tenant-1",
    shiftId: "22222222-2222-4222-8222-222222222222",
    formatId: "shift_csv_flat",
    formatVersion: 1,
    maxLines: 2,
    status: "queued",
    errorCode: null,
    productNameSnapshot: null,
    shiftDateSnapshot: null,
    totalCodeCount: null,
    totalBoxCount: null,
    createdByUserId: "user-1",
    sourceSnapshotStartedAt: null,
    completedAt: null,
    attemptCount: 0,
    ...overrides,
  };
}

function fakeDb(row = baseRow(), failArtifactPublication = false): FakeDb {
  const state: State = { row: { ...row }, artifacts: [], audits: [] };
  const transactions: FakeDb["transactions"] = [];
  const updatePredicates: unknown[] = [];

  const createBoundary = (target: State, txLog?: FakeDb["transactions"][number]) => {
    const select = () => ({
      from: () => {
        const result = Promise.resolve([target.row]);
        const node = {
          where: () => node,
          limit: () => node,
          then: result.then.bind(result),
        };
        return node;
      },
    });

    const update = (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        const apply = () => {
          if (typeof values.attemptCount !== "undefined") {
            const { attemptCount: _incrementExpression, ...remainingValues } = values;
            Object.assign(target.row, remainingValues);
            target.row.attemptCount += 1;
          } else {
            Object.assign(target.row, values);
          }
          if (values.status === "ready" && txLog) txLog.markedReady = true;
          return [target.row];
        };
        const node = {
          where: (predicate: unknown) => {
            updatePredicates.push(predicate);
            return node;
          },
          returning: async () => {
            if (table === schema.shiftExports && target.row.status !== "queued") return [];
            return apply();
          },
          then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve(apply()).then(resolve, reject),
        };
        return node;
      },
    });

    const insert = (table: unknown) => ({
      values: async (values: Record<string, unknown> | Record<string, unknown>[]) => {
        const rows = Array.isArray(values) ? values : [values];
        if (table === schema.shiftExportArtifacts) {
          if (failArtifactPublication) throw new Error("database publication failed: sensitive");
          target.artifacts.push(...rows);
          if (txLog) txLog.insertedArtifacts += rows.length;
        } else if (table === schema.tenantAuditEvents) {
          target.audits.push(...rows);
        }
      },
    });

    return { select, update, insert };
  };

  const boundary = createBoundary(state);
  const db = {
    ...boundary,
    transaction: async (run: (tx: Db) => Promise<unknown>) => {
      const working: State = {
        row: { ...state.row },
        artifacts: [...state.artifacts],
        audits: [...state.audits],
      };
      const txLog = { insertedArtifacts: 0, markedReady: false };
      transactions.push(txLog);
      const result = await run(createBoundary(working, txLog) as unknown as Db);
      state.row = working.row;
      state.artifacts = working.artifacts;
      state.audits = working.audits;
      return result;
    },
  } as unknown as Db;

  return { db, state, transactions, updatePredicates };
}

function source(snapshot?: Partial<ShiftExportSnapshot>): ShiftExportSourceService {
  return {
    load: vi.fn().mockResolvedValue({
      sourceSnapshotStartedAt: SNAPSHOT_AT,
      productName: "Вода",
      shiftDate: "2026-08-13",
      source: { mode: "flat", codes: ["code-a", "code-b"] },
      ...snapshot,
    }),
  } as unknown as ShiftExportSourceService;
}

function storage(options: { rejectPut?: number } = {}): ObjectStorageService & {
  putVerified: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
} {
  let calls = 0;
  return {
    putVerified: vi.fn(async (_key: string, body: Buffer, _mime: string, sha256: string) => {
      calls += 1;
      if (calls === options.rejectPut) throw new Error("storage secret detail");
      return { byteSize: body.byteLength, sha256 };
    }),
    delete: vi.fn().mockResolvedValue(undefined),
  } as never;
}

function sqlText(fragment: unknown): string {
  const wrapper = fragment as { getSQL(): SQL };
  return new PgDialect().sqlToQuery(wrapper.getSQL()).sql;
}

describe("ShiftExportRunnerService", () => {
  it("claims a queued tenant row and atomically publishes verified rendered parts", async () => {
    const fake = fakeDb();
    const loader = source();
    const objects = storage();

    await new ShiftExportRunnerService(fake.db, loader, objects).run(EXPORT_ID, {
      retryCount: 0,
      retryLimit: 5,
    });

    expect(fake.state.row).toMatchObject({
      status: "ready",
      attemptCount: 1,
      productNameSnapshot: "Вода",
      shiftDateSnapshot: "2026-08-13",
      sourceSnapshotStartedAt: SNAPSHOT_AT,
      totalCodeCount: 2,
      totalBoxCount: 0,
      errorCode: null,
    });
    expect(loader.load).toHaveBeenCalledWith("tenant-1", fake.state.row.shiftId, "flat");
    expect(fake.updatePredicates.map(sqlText).join("\n")).toContain(
      '"shift_exports"."tenant_id" = $1',
    );
    expect(objects.putVerified).toHaveBeenCalledTimes(2);
    for (const [index, call] of objects.putVerified.mock.calls.entries()) {
      const [key, body, _mime, hash] = call as [string, Buffer, string, string];
      expect(key).toBe(
        `tenants/tenant-1/shift-exports/${EXPORT_ID}/attempt-1/part-${index + 1}.csv`,
      );
      expect(hash).toBe(createHash("sha256").update(body).digest("hex"));
    }
    expect(fake.state.artifacts).toHaveLength(2);
    expect(fake.state.artifacts).toEqual([
      expect.objectContaining({
        tenantId: "tenant-1",
        exportId: EXPORT_ID,
        partNumber: 1,
        physicalLineCount: 2,
        codeCount: 1,
        boxCount: 0,
        filename: "Вода_1_2026-08-13_часть_1.csv",
        mimeType: "text/csv; charset=utf-8",
      }),
      expect.objectContaining({
        tenantId: "tenant-1",
        exportId: EXPORT_ID,
        partNumber: 2,
        physicalLineCount: 2,
        codeCount: 1,
        boxCount: 0,
        filename: "Вода_1_2026-08-13_часть_2.csv",
        mimeType: "text/csv; charset=utf-8",
      }),
    ]);
    expect(fake.transactions).toContainEqual({ insertedArtifacts: 2, markedReady: true });
    expect(JSON.stringify(fake.state.audits)).not.toMatch(/code-a|code-b|https?:\/\//);
    expect(fake.state.audits.at(-1)).toMatchObject({
      organizationId: "tenant-1",
      actorUserId: "user-1",
      action: "shift_export.completed",
      outcome: "success",
      targetType: "shift_export",
      targetId: EXPORT_ID,
    });
  });

  it.each(["ready", "processing"] as const)("ignores an export already %s", async (status) => {
    const fake = fakeDb(baseRow({ status }));
    const loader = source();
    const objects = storage();

    await new ShiftExportRunnerService(fake.db, loader, objects).run(EXPORT_ID, {
      retryCount: 0,
      retryLimit: 5,
    });

    expect(loader.load).not.toHaveBeenCalled();
    expect(objects.putVerified).not.toHaveBeenCalled();
    expect(fake.state.row).toMatchObject({ status, attemptCount: 0 });
  });

  it("cleans uploaded objects and leaves a transient storage failure queued for pg-boss", async () => {
    const fake = fakeDb();
    const objects = storage({ rejectPut: 2 });
    const runner = new ShiftExportRunnerService(fake.db, source(), objects);

    await expect(runner.run(EXPORT_ID, { retryCount: 1, retryLimit: 5 })).rejects.toThrow(
      "storage secret detail",
    );

    expect(fake.state.artifacts).toEqual([]);
    expect(objects.delete).toHaveBeenCalledWith(
      `tenants/tenant-1/shift-exports/${EXPORT_ID}/attempt-1/part-1.csv`,
    );
    expect(fake.state.row).toMatchObject({ status: "queued", errorCode: null, completedAt: null });
    expect(fake.state.audits).toEqual([]);
  });

  it("publishes only a bounded storage failure on the final pg-boss attempt", async () => {
    const fake = fakeDb();
    const runner = new ShiftExportRunnerService(fake.db, source(), storage({ rejectPut: 2 }));

    await expect(runner.run(EXPORT_ID, { retryCount: 5, retryLimit: 5 })).rejects.toThrow(
      "storage secret detail",
    );

    expect(fake.state.artifacts).toEqual([]);
    expect(fake.state.row).toMatchObject({ status: "failed", errorCode: "STORAGE_FAILED" });
    expect(fake.state.row.completedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(fake.state.audits)).not.toContain("storage secret detail");
  });

  it.each([
    [1, 5, "queued", null],
    [5, 5, "failed", "GENERATION_FAILED"],
  ] as const)(
    "rolls back database publication and applies retry metadata (%s/%s)",
    async (retryCount, retryLimit, status, errorCode) => {
      const fake = fakeDb(baseRow(), true);
      const objects = storage();
      const runner = new ShiftExportRunnerService(fake.db, source(), objects);

      await expect(runner.run(EXPORT_ID, { retryCount, retryLimit })).rejects.toThrow(
        "database publication failed",
      );

      expect(fake.state.artifacts).toEqual([]);
      expect(objects.delete).toHaveBeenCalledTimes(2);
      expect(fake.state.row).toMatchObject({ status, errorCode });
      expect(fake.state.row.completedAt === null).toBe(status === "queued");
      expect(fake.state.audits).toHaveLength(status === "queued" ? 0 : 1);
    },
  );

  it("finishes safe source errors immediately without leaking their message", async () => {
    const fake = fakeDb();
    const loader = source();
    vi.mocked(loader.load).mockRejectedValue(
      Object.assign(new ShiftExportSourceError("BOX_COVERAGE_INCOMPLETE"), {
        message: "raw KM secret",
      }),
    );

    await expect(
      new ShiftExportRunnerService(fake.db, loader, storage()).run(EXPORT_ID, {
        retryCount: 0,
        retryLimit: 5,
      }),
    ).resolves.toBeUndefined();

    expect(fake.state.row).toMatchObject({
      status: "failed",
      errorCode: "BOX_COVERAGE_INCOMPLETE",
    });
    expect(JSON.stringify(fake.state.audits)).not.toContain("raw KM secret");
  });

  it("finishes safe domain errors immediately without loading or retrying", async () => {
    const fake = fakeDb(baseRow({ formatId: "removed_format", formatVersion: 99 }));
    const loader = source();

    await expect(
      new ShiftExportRunnerService(fake.db, loader, storage()).run(EXPORT_ID, {
        retryCount: 0,
        retryLimit: 5,
      }),
    ).resolves.toBeUndefined();

    expect(loader.load).not.toHaveBeenCalled();
    expect(fake.state.row).toMatchObject({ status: "failed", errorCode: "FORMAT_NOT_FOUND" });
    expect(fake.state.audits).toHaveLength(1);
  });

  it("exports only bounded public error codes", () => {
    expect(SHIFT_EXPORT_SAFE_ERROR_CODES).toEqual([
      "SHIFT_NOT_CLOSED",
      "SHIFT_HAS_NO_CODES",
      "SHIFT_DATE_MISSING",
      "BOX_COVERAGE_INCOMPLETE",
      "FORMAT_NOT_FOUND",
      "INVALID_LINE_LIMIT",
      "BOX_EXCEEDS_LINE_LIMIT",
      "GENERATION_FAILED",
      "STORAGE_FAILED",
      "QUEUE_FAILED",
    ]);
  });
});
