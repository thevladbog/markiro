import { DatabaseSync } from "node:sqlite";
import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
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

  // Guards ConflictList's own render, independent of isBatchConflict's
  // filter in lib/sync.ts (Finding 2): a row already in conflicts_mirror
  // with an unparseable winningScannedAt -- from before that filter
  // shipped, or from any other write path -- must degrade one row, not
  // crash the screen. `new Date("garbage")` is an Invalid Date, and
  // `Intl.DateTimeFormat.format()` on one throws a RangeError, which would
  // otherwise take down every row below it, including Back.
  it("renders a row with an unparseable winningScannedAt instead of crashing, and Back still works", async () => {
    const exec = await migratedExec();
    await exec.run(
      `INSERT INTO codes_mirror (code_hash, shift_id, gtin14, serial, scanned_at) VALUES (?,?,?,?,?)`,
      ["h1", "s1", "04600000000017", "AB1", "2026-07-28T10:00:00.000Z"],
    );
    // Bypasses recordConflicts' own parameter typing (which expects a real
    // ISO string) to simulate a row already sitting in the mirror with data
    // that predates or otherwise escaped the sync engine's own guard.
    await exec.run(
      `INSERT INTO conflicts_mirror (code_hash, winning_terminal_id, winning_scanned_at, detected_at)
       VALUES (?,?,?,?)`,
      ["h1", "t9", "garbage", "2026-07-28T10:00:09.000Z"],
    );

    render(<ConflictList exec={exec} onBack={() => {}} />);

    // The row still renders -- item identity survives -- and falls back to
    // the raw stored string rather than throwing or silently blanking it.
    expect(await screen.findByText(/04600000000017/)).toBeDefined();
    expect(screen.getByText(/garbage/)).toBeDefined();
    // Calm, not a crash: Back stays live for this row same as any other.
    expect(screen.getByRole("button", { name: "Back" })).toBeDefined();
  });

  it("says the list could not be read when readConflicts throws, not that there are no conflicts (Finding 3)", async () => {
    // The read failure below is expected and asserted on via the UI copy,
    // not left to print a stack trace into otherwise-pristine test output.
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failingExec: SqlExecutor = {
        async run() {},
        async all() {
          throw new Error("device DB is locked");
        },
      };

      render(<ConflictList exec={failingExec} onBack={() => {}} />);

      expect(await screen.findByText("Could not read the conflict list")).toBeDefined();
      // The failure-safe empty-state copy must never appear alongside it --
      // that would be the exact confusion this finding is about (a genuine
      // read failure indistinguishable from "no conflicts").
      expect(screen.queryByText("No conflicts")).toBeNull();
      // Calm, not an alarm: the Back button stays live.
      expect(screen.getByRole("button", { name: "Back" })).toBeDefined();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});
