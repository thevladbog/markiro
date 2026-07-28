import { DatabaseSync } from "node:sqlite";
import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import i18n from "../src/i18n/index.js";
import { applyMigrations, type SqlExecutor } from "../src/lib/mirror.js";
import { recordConflicts } from "../src/lib/conflicts.js";
import { ConflictList } from "../src/pages/ConflictList.js";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

async function migratedExec(): Promise<SqlExecutor> {
  const db = new DatabaseSync(":memory:");
  const exec: SqlExecutor = {
    async run(sql, params = []) {
      db.prepare(sql).run(...(params as never[]));
    },
    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
  };
  await applyMigrations(exec);
  return exec;
}

describe("ConflictList", () => {
  it("lists an item by its gtin and serial", async () => {
    const exec = await migratedExec();
    await exec.run(
      `INSERT INTO codes_mirror (code_hash, shift_id, gtin14, serial, scanned_at) VALUES (?,?,?,?,?)`,
      ["h1", "s1", "04600000000017", "AB1", "2026-07-28T10:00:00.000Z"],
    );
    await recordConflicts(
      exec,
      [{ codeHash: "h1", winningTerminalId: "t9", winningScannedAt: "2026-07-28T10:00:00.000Z" }],
      "2026-07-28T10:00:09.000Z",
    );

    render(<ConflictList exec={exec} onBack={() => {}} />);

    expect(await screen.findByText(/04600000000017/)).toBeDefined();
    expect(screen.getByText(/AB1/)).toBeDefined();
  });

  it("falls back to the code when the item is no longer mirrored", async () => {
    const exec = await migratedExec();
    await recordConflicts(
      exec,
      [{ codeHash: "h1", winningTerminalId: "t9", winningScannedAt: "2026-07-28T10:00:00.000Z" }],
      "2026-07-28T10:00:09.000Z",
    );

    render(<ConflictList exec={exec} onBack={() => {}} />);
    expect(await screen.findByText("Item no longer on this device")).toBeDefined();
  });

  it("says so when there is nothing to review", async () => {
    render(<ConflictList exec={await migratedExec()} onBack={() => {}} />);
    expect(await screen.findByText("No conflicts")).toBeDefined();
  });
});
