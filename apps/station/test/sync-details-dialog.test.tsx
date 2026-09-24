import { DatabaseSync } from "node:sqlite";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { STATION_MIGRATIONS } from "@markiro/db/station-sqlite";
import { beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n/index.js";
import type { SqlExecutor } from "../src/lib/mirror.js";
import { SyncDetailsDialog } from "../src/ui/SyncDetailsDialog.js";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

function fixture(): SqlExecutor {
  const db = new DatabaseSync(":memory:");
  for (const migration of STATION_MIGRATIONS) {
    try {
      db.exec(migration);
    } catch (error) {
      if (!/duplicate column name/i.test(String(error))) throw error;
    }
  }
  db.prepare(
    `INSERT INTO boxes_mirror(box_id,shift_id,terminal_id,sscc,opened_at,closed_at,acked_at)
    VALUES(?,?,?,?,?,?,?)`,
  ).run(
    "b1",
    "s1",
    "dev-1",
    "123456789012345675",
    "2026-09-23T00:00:00.000Z",
    "2026-09-23T00:03:00.000Z",
    "2026-09-23T00:04:00.000Z",
  );
  db.prepare(
    `INSERT INTO box_reconciliation_issues
    (box_id,shift_id,status,reason_code,local_item_count,server_item_count,checked_at)
    VALUES(?,?,?,?,?,?,?)`,
  ).run(
    "b1",
    "s1",
    "replay_evidence_missing",
    "replay_evidence_missing",
    20,
    null,
    "2026-09-23T00:05:00.000Z",
  );
  return {
    async run(sql, params = []) {
      db.prepare(sql).run(...(params as never[]));
    },
    async all<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
  };
}

async function addSecondShiftIssue(exec: SqlExecutor): Promise<void> {
  await exec.run(
    `INSERT INTO boxes_mirror(box_id,shift_id,terminal_id,sscc,opened_at,closed_at,acked_at)
     VALUES(?,?,?,?,?,?,?)`,
    [
      "b2",
      "s2",
      "dev-1",
      "123456789012345682",
      "2026-09-23T00:00:00.000Z",
      "2026-09-23T00:03:00.000Z",
      "2026-09-23T00:04:00.000Z",
    ],
  );
  await exec.run(
    `INSERT INTO box_reconciliation_issues
     (box_id,shift_id,status,reason_code,local_item_count,server_item_count,checked_at)
     VALUES(?,?,?,?,?,?,?)`,
    ["b2", "s2", "identity_conflict", "sscc_conflict", 20, null, "2026-09-23T00:06:00.000Z"],
  );
}

describe("SyncDetailsDialog", () => {
  it("explains offline retry and the last completed comparison without exposing raw codes", async () => {
    const exec = fixture();
    await exec.run("UPDATE boxes_mirror SET server_reconciled_at=? WHERE box_id='b1'", [
      "2026-09-23T00:05:00.000Z",
    ]);
    render(
      <SyncDetailsDialog
        open
        exec={exec}
        shiftId="s1"
        serverReachability="unreachable"
        onClose={vi.fn()}
        onReconcileNow={vi.fn(async () => {})}
      />,
    );
    await screen.findByText(/No connection/);
    expect(screen.getByRole("dialog").textContent).toContain("Last checked:");
  });
  it("opens a pending shift and its issue list after the work screen is closed", async () => {
    render(
      <SyncDetailsDialog
        open
        exec={fixture()}
        shiftId={null}
        onClose={vi.fn()}
        onReconcileNow={vi.fn(async () => {})}
      />,
    );
    const shift = await screen.findByRole("button", { name: /s1.*Awaiting check/ });
    fireEvent.click(shift);
    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: "Box reconciliation" }).querySelector("p")?.textContent,
      ).toBe("s1"),
    );
    expect(screen.getByRole("dialog").textContent).toContain("123456789012345675");
    fireEvent.click(screen.getByRole("button", { name: "All shifts" }));
    await screen.findByRole("button", { name: /s1.*Awaiting check/ });
  });
  it("shows five counters and a safe, actionable SSCC issue", async () => {
    const onClose = vi.fn();
    const onReconcileNow = vi.fn(async () => {});
    render(
      <>
        <button type="button">sync origin</button>
        <SyncDetailsDialog
          open
          exec={fixture()}
          shiftId="s1"
          onClose={onClose}
          onReconcileNow={onReconcileNow}
        />
      </>,
    );
    const dialog = screen.getByRole("dialog", { name: "Box reconciliation" });
    await waitFor(() => expect(dialog.textContent).toContain("Closed locally"));
    expect(dialog.textContent).toContain("Delivered");
    expect(dialog.textContent).toContain("Server confirmed");
    expect(dialog.textContent).toContain("Awaiting check");
    expect(dialog.textContent).toContain("Discrepancies");
    expect(dialog.textContent).toContain("123456789012345675");
    expect(dialog.textContent).toContain("Local history is insufficient");
    expect(dialog.textContent).not.toContain("0104");
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    await waitFor(() => expect(onReconcileNow).toHaveBeenCalledOnce());
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("lets an operator inspect another shift and all shifts while a shift is active", async () => {
    const exec = fixture();
    await addSecondShiftIssue(exec);
    render(
      <SyncDetailsDialog
        open
        exec={exec}
        shiftId="s1"
        onClose={vi.fn()}
        onReconcileNow={vi.fn(async () => {})}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /s2.*Awaiting check/ }));
    await screen.findByText(/123456789012345682/);
    fireEvent.click(screen.getByRole("button", { name: "All shifts" }));
    await waitFor(() =>
      expect(screen.getByRole("dialog").textContent).toContain("123456789012345675"),
    );
    expect(screen.getByRole("dialog").textContent).toContain("123456789012345682");
  });

  it("ignores an older refresh that finishes after the selected scope changes", async () => {
    const base = fixture();
    await addSecondShiftIssue(base);
    let delayNextS1 = false;
    let releaseOld!: () => void;
    let markOldStarted!: () => void;
    const oldStarted = new Promise<void>((resolve) => {
      markOldStarted = resolve;
    });
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const exec: SqlExecutor = {
      run: base.run,
      all: async <T,>(sql: string, params: unknown[] = []) => {
        if (delayNextS1 && sql.includes("COUNT(*) local_closed") && params[0] === "s1") {
          delayNextS1 = false;
          markOldStarted();
          await oldGate;
        }
        return base.all<T>(sql, params);
      },
    };
    render(
      <SyncDetailsDialog
        open
        exec={exec}
        shiftId="s1"
        onClose={vi.fn()}
        onReconcileNow={vi.fn(async () => {})}
      />,
    );
    const otherShift = await screen.findByRole("button", { name: /s2.*Awaiting check/ });
    delayNextS1 = true;
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    await oldStarted;
    fireEvent.click(otherShift);
    await screen.findByText(/123456789012345682/);
    await act(async () => {
      releaseOld();
      await oldGate;
    });
    expect(screen.getByRole("dialog").textContent).not.toContain("123456789012345675");
  });

  it("keeps a failed manual check visible after refreshing the counters", async () => {
    render(
      <SyncDetailsDialog
        open
        exec={fixture()}
        shiftId="s1"
        onClose={vi.fn()}
        onReconcileNow={vi.fn(async () => {
          throw new Error("check unavailable");
        })}
      />,
    );
    await screen.findByText("Closed locally");
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    await screen.findByRole("alert");
    await waitFor(() => expect(screen.getByRole("button", { name: "Check now" })).toBeDefined());
    expect(screen.getByRole("alert")).toBeDefined();
  });

  it("keeps long shift and issue lists inside a keyboard-scrollable body", async () => {
    render(
      <SyncDetailsDialog
        open
        exec={fixture()}
        shiftId="s1"
        onClose={vi.fn()}
        onReconcileNow={vi.fn(async () => {})}
      />,
    );
    const content = screen.getByRole("region", { name: "Box reconciliation" });
    expect(content.style.overflowY).toBe("auto");
    expect(content.tabIndex).toBe(0);
  });
});
