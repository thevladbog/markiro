import type { DatabaseSync } from "node:sqlite";

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LineSelect, type LineSelectProps } from "../src/app/LineSelect.js";
import type { SyncFailure, SyncState } from "../src/app/shell.js";
import { DeviceError } from "../src/host/device.js";
import { LocalDbError, type LocalExecutor } from "../src/local/executor.js";
import { openLocalDb } from "./support/local-db.js";

const LINE_2 = "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61";
const LINE_10 = "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21";
const OLD_LINE = "9b2e4a6c-0000-4000-8000-000000000000";

/** Copies this computer cannot read. */
const UNREADABLE: LocalExecutor = {
  query: () => Promise.reject(new LocalDbError("statement_failed", "disk I/O error")),
  transaction: () => Promise.reject(new LocalDbError("statement_failed", "disk I/O error")),
};

function insertLine(db: DatabaseSync, id: string, name: string, archived = 0): void {
  db.prepare("INSERT INTO ref_lines (id, name, archived, rev) VALUES (?, ?, ?, 1)").run(
    id,
    name,
    archived,
  );
}

/** A sync state with no failure and nothing quarantined. */
function syncState(kind: SyncState["kind"], synced: number): SyncState {
  return { kind, synced, failure: null, quarantined: 0 };
}

function renderLineSelect(sync: SyncState, overrides: Partial<LineSelectProps> = {}) {
  const { db, executor } = openLocalDb();
  const props: LineSelectProps = {
    local: executor,
    sync,
    link: null,
    onSelect: vi.fn<LineSelectProps["onSelect"]>(async () => undefined),
    onSync: vi.fn<LineSelectProps["onSync"]>(),
    onOffice: vi.fn<LineSelectProps["onOffice"]>(),
    ...overrides,
  };
  return { db, props, view: render(<LineSelect {...props} />) };
}

describe("LineSelect", () => {
  it("waits for a sync in this session before it reads the lines", async () => {
    const { db, props, view } = renderLineSelect(syncState("running", 0));
    insertLine(db, LINE_2, "Линия 2");
    view.rerender(<LineSelect {...props} />);
    // Flush the microtask a query would resolve on, so a guard that failed
    // to skip the read would actually show up before the assertions run.
    await act(async () => {});
    expect(screen.getByText("Получаем справочники с хоста…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Линия 2" })).toBeNull();
  });

  it("lists the active lines by name once the copies are up to date", async () => {
    const { db, props, view } = renderLineSelect(syncState("running", 0));
    insertLine(db, LINE_10, "Линия 10");
    insertLine(db, LINE_2, "Линия 2");
    insertLine(db, OLD_LINE, "Старая линия", 1);
    view.rerender(<LineSelect {...props} sync={syncState("done", 1)} />);
    await screen.findByRole("button", { name: "Линия 2" });
    const names = screen
      .getAllByRole("button")
      .map((button) => button.textContent)
      .filter((name) => name?.startsWith("Линия"));
    expect(names).toEqual(["Линия 2", "Линия 10"]);
    expect(screen.queryByRole("button", { name: "Старая линия" })).toBeNull();
  });

  it("explains a failed first sync and syncs again on request", () => {
    const { props } = renderLineSelect(syncState("failed", 0));
    expect(screen.getByText("Не удалось получить справочники с хоста.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(props.onSync).toHaveBeenCalledTimes(1);
  });

  it.each<[SyncFailure, string]>([
    ["local", "Не удалось записать справочники на этом компьютере."],
    ["feed", "Ленту изменений хоста не удалось применить."],
  ])("explains a failed first sync by its class (%s), as the status line does", (failure, text) => {
    renderLineSelect({ ...syncState("failed", 0), failure });
    expect(screen.getByText(text)).toBeTruthy();
    expect(screen.queryByText("Не удалось получить справочники с хоста.")).toBeNull();
  });

  it("says when the host has no active lines", async () => {
    renderLineSelect(syncState("done", 1));
    expect(await screen.findByText("На хосте нет активных линий.")).toBeTruthy();
  });

  it("says no line can be chosen when the copies have quarantined records", async () => {
    renderLineSelect({ kind: "done", synced: 1, failure: null, quarantined: 2 });
    expect(
      await screen.findByText(
        "Нет линий, которые можно выбрать: часть записей справочников не принята.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("На хосте нет активных линий.")).toBeNull();
  });

  it("chooses a line with the host", async () => {
    const { db, props, view } = renderLineSelect(syncState("running", 0));
    insertLine(db, LINE_2, "Линия 2");
    view.rerender(<LineSelect {...props} sync={syncState("done", 1)} />);
    fireEvent.click(await screen.findByRole("button", { name: "Линия 2" }));
    await waitFor(() => expect(props.onSelect).toHaveBeenCalledWith(LINE_2));
  });

  it("explains a line the host refused, syncs and reads the lines again", async () => {
    const onSelect = vi.fn<LineSelectProps["onSelect"]>(async () => {
      throw new DeviceError("line_rejected", "archived meanwhile");
    });
    const { db, props, view } = renderLineSelect(syncState("running", 0), { onSelect });
    insertLine(db, LINE_2, "Линия 2");
    insertLine(db, LINE_10, "Линия 10");
    view.rerender(<LineSelect {...props} sync={syncState("done", 1)} />);
    fireEvent.click(await screen.findByRole("button", { name: "Линия 2" }));
    expect(
      await screen.findByText(
        "Хост не принял эту линию: её убрали в архив или удалили. Выберите линию заново.",
      ),
    ).toBeTruthy();
    expect(props.onSync).toHaveBeenCalledTimes(1);

    // The sync brings the archive flag; the list follows it.
    db.prepare("UPDATE ref_lines SET archived = 1 WHERE id = ?").run(LINE_2);
    view.rerender(<LineSelect {...props} sync={syncState("done", 2)} />);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Линия 2" })).toBeNull());
    expect(screen.getByRole("button", { name: "Линия 10" })).toBeTruthy();
  });

  it("explains an unreachable host in words true for a remote station too", async () => {
    const onSelect = vi.fn<LineSelectProps["onSelect"]>(async () => {
      throw new DeviceError("unreachable", "host down");
    });
    const { db, props, view } = renderLineSelect(syncState("running", 0), { onSelect });
    insertLine(db, LINE_2, "Линия 2");
    view.rerender(<LineSelect {...props} sync={syncState("done", 1)} />);
    fireEvent.click(await screen.findByRole("button", { name: "Линия 2" }));
    // Not "Служба хоста на этом компьютере не отвечает.": this station's
    // paired host can be a different PC on the network.
    expect(await screen.findByText("Хост не отвечает.")).toBeTruthy();
    expect(screen.queryByText("Служба хоста на этом компьютере не отвечает.")).toBeNull();
  });

  it("explains any other refusal without syncing", async () => {
    const onSelect = vi.fn<LineSelectProps["onSelect"]>(async () => {
      throw new DeviceError("request_failed", "host error");
    });
    const { db, props, view } = renderLineSelect(syncState("running", 0), { onSelect });
    insertLine(db, LINE_2, "Линия 2");
    view.rerender(<LineSelect {...props} sync={syncState("done", 1)} />);
    fireEvent.click(await screen.findByRole("button", { name: "Линия 2" }));
    expect(await screen.findByText("Хост не выполнил запрос. Повторите попытку.")).toBeTruthy();
    expect(props.onSync).not.toHaveBeenCalled();
  });

  it("says a copy that cannot be read is this computer's, not the host's", async () => {
    const { props } = renderLineSelect(syncState("done", 1), { local: UNREADABLE });
    expect(
      await screen.findByText("Не удалось прочитать справочники на этом компьютере."),
    ).toBeTruthy();
    expect(screen.queryByText("Не удалось получить справочники с хоста.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(props.onSync).toHaveBeenCalledTimes(1);
  });

  it("shows progress, not the older alert, while the retry syncs", async () => {
    const { props, view } = renderLineSelect(syncState("done", 1), { local: UNREADABLE });
    await screen.findByText("Не удалось прочитать справочники на этом компьютере.");
    view.rerender(<LineSelect {...props} sync={syncState("running", 1)} />);
    expect(screen.getByText("Получаем справочники с хоста…")).toBeTruthy();
    expect(screen.queryByText("Не удалось прочитать справочники на этом компьютере.")).toBeNull();
  });

  it("explains the latest failure: a sync that failed after the copy could not be read", async () => {
    const { props, view } = renderLineSelect(syncState("done", 1), { local: UNREADABLE });
    await screen.findByText("Не удалось прочитать справочники на этом компьютере.");
    view.rerender(<LineSelect {...props} sync={{ ...syncState("failed", 1), failure: "host" }} />);
    expect(screen.getByText("Не удалось получить справочники с хоста.")).toBeTruthy();
    expect(screen.queryByText("Не удалось прочитать справочники на этом компьютере.")).toBeNull();
  });

  it("stops showing a stale read failure once a new sync succeeds, before the new read itself resolves", async () => {
    let calls = 0;
    const local: LocalExecutor = {
      query: <T,>(): Promise<T[]> => {
        calls += 1;
        // The first read (for `synced: 1`) fails; every read after that
        // stays pending, so the assertions below land in the gap before a
        // later read has had any chance to resolve.
        return calls === 1
          ? Promise.reject(new LocalDbError("statement_failed", "disk I/O error"))
          : new Promise<T[]>(() => undefined);
      },
      transaction: () => Promise.reject(new LocalDbError("statement_failed", "disk I/O error")),
    };
    const { props, view } = renderLineSelect(syncState("done", 1), { local });
    await screen.findByText("Не удалось прочитать справочники на этом компьютере.");

    // A new sync succeeds (`synced: 2`); the stale failure — pinned to
    // `synced: 1` — must stop showing at once, not only once this new read
    // (still pending) resolves.
    view.rerender(<LineSelect {...props} sync={syncState("done", 2)} />);
    expect(screen.getByText("Получаем справочники с хоста…")).toBeTruthy();
    expect(screen.queryByText("Не удалось прочитать справочники на этом компьютере.")).toBeNull();
  });

  it("shows a local failure exactly once when no lines are listed, not doubled by the status line", () => {
    renderLineSelect(
      { kind: "failed", synced: 0, failure: "local", quarantined: 0 },
      { link: { state: "online", lastContactAt: 1_790_000_000_000, lastError: null, seq: 1 } },
    );
    // Before the fix, the status line repeated the same text (`errors.sync.local`
    // is also its own reason for this failure class) next to this screen's own
    // alert.
    expect(screen.getAllByText("Не удалось записать справочники на этом компьютере.")).toHaveLength(
      1,
    );
  });

  it("shows the quarantine count while no lines are listed and the sync failed, without the failure line", () => {
    // The restart case for a station without a line yet: the run that just
    // failed still read a count (item A), and it must show here too, even
    // though the failure line itself is left to this screen's own alert.
    renderLineSelect(
      { kind: "failed", synced: 0, failure: "host", quarantined: 2 },
      { link: { state: "online", lastContactAt: 1_790_000_000_000, lastError: null, seq: 1 } },
    );
    expect(screen.getByText("Не приняты записи справочников: 2")).toBeTruthy();
    expect(screen.queryByText("Справочники не обновились — повторим автоматически")).toBeNull();
  });

  it("keeps the failure's own alert, and no second failure line, while a retry runs with no lines listed yet", () => {
    renderLineSelect(
      { kind: "running", synced: 0, failure: "host", quarantined: 0 },
      { link: { state: "online", lastContactAt: 1_790_000_000_000, lastError: null, seq: 1 } },
    );
    expect(screen.getByText("Не удалось получить справочники с хоста.")).toBeTruthy();
    expect(screen.queryByText("Получаем справочники с хоста…")).toBeNull();
    expect(screen.queryByText("Справочники не обновились — повторим автоматически")).toBeNull();
  });

  it("announces a failed sync once: its alert stays mounted through the automatic retries", () => {
    const failed: SyncState = { kind: "failed", synced: 0, failure: "host", quarantined: 0 };
    const { props, view } = renderLineSelect(failed);
    const alert = screen.getByRole("alert");
    // The retry's run shows on the button instead of a spinner in the alert's place.
    view.rerender(<LineSelect {...props} sync={{ ...failed, kind: "running" }} />);
    expect(screen.getByRole("alert")).toBe(alert);
    expect(within(alert).getByRole("button", { name: "Повторить" })).toHaveProperty(
      "disabled",
      true,
    );
    view.rerender(<LineSelect {...props} sync={failed} />);
    expect(screen.getByRole("alert")).toBe(alert);
    expect(within(alert).getByRole("button", { name: "Повторить" })).toHaveProperty(
      "disabled",
      false,
    );
  });

  it("shows the failure line once lines are already listed, since nothing else reports it", async () => {
    const { db, props, view } = renderLineSelect(syncState("running", 0), {
      link: { state: "online", lastContactAt: 1_790_000_000_000, lastError: null, seq: 1 },
    });
    insertLine(db, LINE_2, "Линия 2");
    view.rerender(<LineSelect {...props} sync={syncState("done", 1)} />);
    await screen.findByRole("button", { name: "Линия 2" });

    // A later, background run fails while the previously read lines stay on
    // screen (the read effect does not rerun: `sync.synced` did not change).
    view.rerender(
      <LineSelect
        {...props}
        sync={{ kind: "failed", synced: 1, failure: "host", quarantined: 0 }}
      />,
    );
    expect(screen.getByRole("button", { name: "Линия 2" })).toBeTruthy();
    expect(screen.getByText("Справочники не обновились — повторим автоматически")).toBeTruthy();
    expect(screen.getByText("Запрос к хосту не удался.")).toBeTruthy();
  });

  it("shows the link and opens the office", () => {
    const { props } = renderLineSelect(syncState("failed", 0), {
      link: { state: "offline", lastContactAt: null, lastError: "unreachable", seq: 4 },
    });
    expect(screen.getByText("Нет связи с хостом")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Офис" }));
    expect(props.onOffice).toHaveBeenCalledTimes(1);
  });
});
