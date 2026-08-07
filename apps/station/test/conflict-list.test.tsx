import { DatabaseSync } from "node:sqlite";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

async function addConflict(
  exec: SqlExecutor,
  row: {
    codeHash: string;
    terminalId?: string | null;
    detectedAt: string;
    gtin14?: string;
    serial?: string;
  },
): Promise<void> {
  if (row.gtin14 && row.serial) {
    await exec.run(
      `INSERT INTO codes_mirror (code_hash, shift_id, gtin14, serial, scanned_at) VALUES (?,?,?,?,?)`,
      [row.codeHash, "s1", row.gtin14, row.serial, "2026-07-28T10:00:00.000Z"],
    );
  }
  await recordConflicts(
    exec,
    [
      {
        codeHash: row.codeHash,
        winningTerminalId: row.terminalId ?? "t9",
        winningScannedAt: "2026-07-28T10:00:00.000Z",
      },
    ],
    row.detectedAt,
  );
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
      expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("moves through bounded newest-first pages with accessible previous and next controls", async () => {
    const exec = await migratedExec();
    await addConflict(exec, {
      codeHash: "h1",
      detectedAt: "2026-07-28T10:01:00.000Z",
      gtin14: "04600000000017",
      serial: "OLD",
    });
    await addConflict(exec, {
      codeHash: "h2",
      detectedAt: "2026-07-28T10:02:00.000Z",
      gtin14: "04600000000017",
      serial: "MIDDLE",
    });
    await addConflict(exec, {
      codeHash: "h3",
      detectedAt: "2026-07-28T10:03:00.000Z",
      gtin14: "04600000000017",
      serial: "NEWEST",
    });

    render(<ConflictList exec={exec} onBack={() => {}} />);

    expect(await screen.findByText(/NEWEST/)).toBeDefined();
    expect(screen.getByText(/MIDDLE/)).toBeDefined();
    expect(screen.queryByText(/OLD/)).toBeNull();
    expect(screen.getByText("Page 1 of 2")).toBeDefined();
    expect(screen.getByRole("button", { name: "Previous page" }).hasAttribute("disabled")).toBe(
      true,
    );

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(screen.getByText(/OLD/)).toBeDefined());
    expect(screen.getByText("Page 2 of 2")).toBeDefined();
    expect(screen.getByRole("button", { name: "Next page" }).hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    await waitFor(() => expect(screen.getByText(/NEWEST/)).toBeDefined());
    expect(screen.getByText("Page 1 of 2")).toBeDefined();
  });

  it("clamps back to the first page when the local dataset shrinks before a page read", async () => {
    const exec = await migratedExec();
    await addConflict(exec, {
      codeHash: "h1",
      detectedAt: "2026-07-28T10:01:00.000Z",
      gtin14: "04600000000017",
      serial: "OLD",
    });
    await addConflict(exec, {
      codeHash: "h2",
      detectedAt: "2026-07-28T10:02:00.000Z",
      gtin14: "04600000000017",
      serial: "MIDDLE",
    });
    await addConflict(exec, {
      codeHash: "h3",
      detectedAt: "2026-07-28T10:03:00.000Z",
      gtin14: "04600000000017",
      serial: "NEWEST",
    });

    render(<ConflictList exec={exec} onBack={() => {}} />);
    expect(await screen.findByText("Page 1 of 2")).toBeDefined();

    await exec.run("DELETE FROM conflicts_mirror WHERE code_hash <> ?", ["h3"]);
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));

    await waitFor(() => expect(screen.getByText("Page 1 of 1")).toBeDefined());
    expect(screen.getByText(/NEWEST/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Next page" }).hasAttribute("disabled")).toBe(true);
  });

  it("retries a transient local read failure without presenting it as an empty store", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const workingExec = await migratedExec();
      let shouldFail = true;
      const transientExec: SqlExecutor = {
        run: (sql, params) => workingExec.run(sql, params),
        async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
          if (shouldFail) {
            shouldFail = false;
            throw new Error("device DB is locked once");
          }
          return workingExec.all<T>(sql, params);
        },
      };

      render(<ConflictList exec={transientExec} onBack={() => {}} />);
      fireEvent.click(await screen.findByRole("button", { name: "Retry" }));

      expect(await screen.findByText("No conflicts")).toBeDefined();
      expect(screen.queryByText("Could not read the conflict list")).toBeNull();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("shows a long winning terminal in touch-visible text without relying on hover", async () => {
    const exec = await migratedExec();
    const terminalId = "terminal-production-line-04-west-corridor-with-a-very-long-identifier";
    await addConflict(exec, {
      codeHash: "h1",
      terminalId,
      detectedAt: "2026-07-28T10:01:00.000Z",
      gtin14: "04600000000017",
      serial: "AB1",
    });

    render(<ConflictList exec={exec} onBack={() => {}} />);

    expect(await screen.findByText(terminalId)).toBeDefined();
    expect(screen.getByText("Kept by")).toBeDefined();
    expect(screen.queryByTitle(terminalId)).toBeNull();
    expect(
      screen.getByText("Do not rescan. Continue production; a manager will review it."),
    ).toBeDefined();
  });

  it("is a deliberate main screen, never a modal, and Back remains a floor action", async () => {
    const onBack = vi.fn();
    render(<ConflictList exec={await migratedExec()} onBack={onBack} />);

    expect(await screen.findByRole("main", { name: "Codes claimed elsewhere" })).toBeDefined();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalledOnce();
  });
});
