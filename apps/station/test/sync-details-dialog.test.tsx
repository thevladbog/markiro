import { DatabaseSync } from "node:sqlite";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    await waitFor(() => expect(screen.getByRole("dialog").textContent).toContain("Current shift"));
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
});
