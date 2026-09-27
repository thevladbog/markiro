import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createTauriLocalExecutor,
  LOCAL_DB_ERROR_CODES,
  LocalDbError,
} from "../src/local/executor.js";
import { openLocalDb } from "./support/local-db.js";

const LINE = "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61";
const INSERT_LINE = "INSERT INTO ref_lines (id, name, archived, rev) VALUES (?, ?, ?, ?)";
const lineRow = z
  .object({ id: z.string(), name: z.string(), archived: z.number(), rev: z.number() })
  .strict();
/** The reference sync's page upsert (plan 1c3), as the shell test runs it too. */
const UPSERT_LINES =
  "INSERT INTO ref_lines (id, name, archived, rev) " +
  "SELECT value ->> 'id', value ->> 'name', value ->> 'archived', value ->> 'rev' " +
  "FROM json_each(?) WHERE true " +
  "ON CONFLICT (id) DO UPDATE SET name = excluded.name, archived = excluded.archived, rev = excluded.rev " +
  "WHERE excluded.rev > ref_lines.rev";

async function failure(promise: Promise<unknown>): Promise<LocalDbError> {
  const error: unknown = await promise.then(
    () => {
      throw new Error("expected the call to fail");
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(LocalDbError);
  return error as LocalDbError;
}

describe("Tauri local executor", () => {
  it("sends a query with its parameters and checks every row", async () => {
    const row = { id: LINE, name: "Линия 1", archived: 0, rev: 1 };
    const call = vi.fn().mockResolvedValue([row]);
    const sql = "SELECT id, name, archived, rev FROM ref_lines WHERE archived = ?";
    await expect(createTauriLocalExecutor(call).query(sql, [0], lineRow)).resolves.toEqual([row]);
    expect(call).toHaveBeenCalledWith("local_query", { sql, params: [0] });
  });

  it("sends a batch with its values and only the expectations it has", async () => {
    const call = vi.fn().mockResolvedValue([1, 1, 0]);
    const update = "UPDATE sync_state SET value = ? WHERE key = 'last_rev'";
    const cleanup = "DELETE FROM ref_lines WHERE rev < 0";
    await expect(
      createTauriLocalExecutor(call).transaction([
        { sql: INSERT_LINE, values: [LINE, "Линия 1", 0, 1] },
        { sql: update, values: ["1"], expectedChanges: 1 },
        { sql: cleanup },
      ]),
    ).resolves.toEqual([1, 1, 0]);
    expect(call).toHaveBeenCalledWith("local_transaction", {
      statements: [
        { sql: INSERT_LINE, values: [LINE, "Линия 1", 0, 1] },
        { sql: update, values: ["1"], expectedChanges: 1 },
        { sql: cleanup, values: [] },
      ],
    });
  });

  it.each(LOCAL_DB_ERROR_CODES)("keeps the shell's %s code", async (code) => {
    const call = vi.fn().mockRejectedValue(code);
    const error = await failure(createTauriLocalExecutor(call).transaction([{ sql: "SELECT 1" }]));
    expect(error.code).toBe(code);
  });

  it("treats an unexpected shell error as a failed statement", async () => {
    const call = vi.fn().mockRejectedValue(new Error("boom"));
    const error = await failure(createTauriLocalExecutor(call).query("SELECT 1", [], z.unknown()));
    expect(error.code).toBe("statement_failed");
  });

  it("rejects answers it cannot read", async () => {
    const rows = vi.fn().mockResolvedValue([{ id: LINE }]);
    const error = await failure(
      createTauriLocalExecutor(rows).query("SELECT id FROM ref_lines", [], lineRow),
    );
    expect(error.code).toBe("invalid_response");
    const changes = vi.fn().mockResolvedValue(["one"]);
    const batch = await failure(
      createTauriLocalExecutor(changes).transaction([{ sql: "SELECT 1" }]),
    );
    expect(batch.code).toBe("invalid_response");
  });
});

describe("local database on node:sqlite", () => {
  it("has exactly the shell's reference tables", async () => {
    const { executor } = openLocalDb();
    const tables = await executor.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      [],
      z.object({ name: z.string() }),
    );
    expect(tables.map((table) => table.name)).toEqual([
      "ref_lines",
      "ref_org",
      "ref_site",
      "sync_state",
    ]);
  });

  it("commits a batch together and rolls it back whole", async () => {
    const { executor } = openLocalDb();
    await expect(
      executor.transaction([{ sql: INSERT_LINE, values: [LINE, "Линия 1", false, 1] }]),
    ).resolves.toEqual([1]);
    const duplicate = await failure(
      executor.transaction([
        { sql: "UPDATE ref_lines SET name = ? WHERE id = ?", values: ["Первая", LINE] },
        { sql: INSERT_LINE, values: [LINE, "Та же линия", 0, 1] },
      ]),
    );
    expect(duplicate.code).toBe("statement_failed");
    const mismatch = await failure(
      executor.transaction([
        { sql: "UPDATE ref_lines SET name = ? WHERE id = ?", values: ["Первая", LINE] },
        {
          sql: "UPDATE ref_lines SET name = ? WHERE id = ?",
          values: ["Вторая", "no-such-line"],
          expectedChanges: 1,
        },
      ]),
    );
    expect(mismatch.code).toBe("changes_mismatch");
    await expect(
      executor.query("SELECT id, name, archived, rev FROM ref_lines", [], lineRow),
    ).resolves.toEqual([{ id: LINE, name: "Линия 1", archived: 0, rev: 1 }]);
  });

  it("upserts a whole page through json_each as the shell does", async () => {
    const { executor } = openLocalDb();
    const page = JSON.stringify(
      Array.from({ length: 1000 }, (_, n) => ({
        id: `line-${String(n).padStart(4, "0")}`,
        name: `Линия ${n}`,
        archived: 0,
        rev: 7,
      })),
    );
    await expect(executor.transaction([{ sql: UPSERT_LINES, values: [page] }])).resolves.toEqual([
      1000,
    ]);
    await expect(executor.transaction([{ sql: UPSERT_LINES, values: [page] }])).resolves.toEqual([
      0,
    ]);
  });

  it("refuses values the shell cannot bind", async () => {
    const { executor } = openLocalDb();
    const error = await failure(
      executor.transaction([{ sql: INSERT_LINE, values: [LINE, ["nested"], 0, 1] }]),
    );
    expect(error.code).toBe("unsupported_value");
  });
});
