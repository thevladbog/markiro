import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@markiro/db";
import { StationShiftProgressService } from "../src/modules/shifts/station-shift-progress.service";

type QueryResult = { rows: Record<string, unknown>[] };

function progressService(results: QueryResult[]) {
  const dialect = new PgDialect();
  const queries: { sql: string; params: unknown[] }[] = [];
  const execute = vi.fn(async (query: SQL) => {
    const compiled = dialect.sqlToQuery(query);
    queries.push({ sql: compiled.sql, params: compiled.params });
    const result = results.shift();
    if (!result) throw new Error("Unexpected progress query");
    return result;
  });
  const transaction = vi.fn(async (run: (tx: { execute: typeof execute }) => Promise<unknown>) =>
    run({ execute }),
  );
  const service = new StationShiftProgressService({ transaction } as unknown as Db);
  return { service, transaction, queries };
}

const SHIFT = "8f14e45f-ceea-467a-9b3c-1c6a1c3f9b10";
const DEVICE = "c9f0f895-fb98-4b91-a9b5-9f1d5f6b2f11";

describe("StationShiftProgressService", () => {
  it("adds reprocessed units to registry owners in one read-only snapshot", async () => {
    const harness = progressService([
      {
        rows: [
          {
            asOf: new Date("2026-09-25T09:00:00.000Z"),
            registryUnits: "1200",
            deviceRegistryUnits: 300,
            reprocessedUnits: 2,
            deviceReprocessedUnits: "2",
          },
        ],
      },
    ]);
    await expect(harness.service.progress("tenant-1", SHIFT, DEVICE)).resolves.toEqual({
      shiftId: SHIFT,
      acceptedUnits: 1202,
      deviceAcceptedUnits: 302,
      asOf: "2026-09-25T09:00:00.000Z",
    });
    expect(harness.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
    const [query] = harness.queries;
    expect(query?.sql).toContain("from code_registry");
    expect(query?.sql).toContain("allow_previously_accepted_codes");
    expect(query?.params).toEqual(expect.arrayContaining(["tenant-1", SHIFT, DEVICE]));
  });

  it("answers 404 for a missing shift and for a malformed id without querying", async () => {
    const missing = progressService([{ rows: [] }]);
    await expect(missing.service.progress("tenant-1", SHIFT, DEVICE)).rejects.toMatchObject({
      status: 404,
    });
    const malformed = progressService([]);
    await expect(
      malformed.service.progress("tenant-1", "not-a-uuid", DEVICE),
    ).rejects.toMatchObject({ status: 404 });
    expect(malformed.transaction).not.toHaveBeenCalled();
  });
});
