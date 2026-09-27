import type { DatabaseSync } from "node:sqlite";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LineSelect, type LineSelectProps } from "../src/app/LineSelect.js";
import type { SyncState } from "../src/app/shell.js";
import { DeviceError } from "../src/host/device.js";
import { openLocalDb } from "./support/local-db.js";

const LINE_2 = "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61";
const LINE_10 = "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21";
const OLD_LINE = "9b2e4a6c-0000-4000-8000-000000000000";

function insertLine(db: DatabaseSync, id: string, name: string, archived = 0): void {
  db.prepare("INSERT INTO ref_lines (id, name, archived, rev) VALUES (?, ?, ?, 1)").run(
    id,
    name,
    archived,
  );
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
  it("waits for a sync in this session before it reads the lines", () => {
    const { db, props, view } = renderLineSelect({ kind: "running", synced: 0 });
    insertLine(db, LINE_2, "Линия 2");
    view.rerender(<LineSelect {...props} />);
    expect(screen.getByText("Получаем справочники с хоста…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Линия 2" })).toBeNull();
  });

  it("lists the active lines by name once the copies are up to date", async () => {
    const { db, props, view } = renderLineSelect({ kind: "running", synced: 0 });
    insertLine(db, LINE_10, "Линия 10");
    insertLine(db, LINE_2, "Линия 2");
    insertLine(db, OLD_LINE, "Старая линия", 1);
    view.rerender(<LineSelect {...props} sync={{ kind: "done", synced: 1 }} />);
    await screen.findByRole("button", { name: "Линия 2" });
    const names = screen
      .getAllByRole("button")
      .map((button) => button.textContent)
      .filter((name) => name?.startsWith("Линия"));
    expect(names).toEqual(["Линия 2", "Линия 10"]);
    expect(screen.queryByRole("button", { name: "Старая линия" })).toBeNull();
  });

  it("explains a failed first sync and syncs again on request", () => {
    const { props } = renderLineSelect({ kind: "failed", synced: 0 });
    expect(screen.getByText("Не удалось получить справочники с хоста.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(props.onSync).toHaveBeenCalledTimes(1);
  });

  it("says when the host has no active lines", async () => {
    renderLineSelect({ kind: "done", synced: 1 });
    expect(await screen.findByText("На хосте нет активных линий.")).toBeTruthy();
  });

  it("chooses a line with the host", async () => {
    const { db, props, view } = renderLineSelect({ kind: "running", synced: 0 });
    insertLine(db, LINE_2, "Линия 2");
    view.rerender(<LineSelect {...props} sync={{ kind: "done", synced: 1 }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Линия 2" }));
    await waitFor(() => expect(props.onSelect).toHaveBeenCalledWith(LINE_2));
  });

  it("explains a line the host refused, syncs and reads the lines again", async () => {
    const onSelect = vi.fn<LineSelectProps["onSelect"]>(async () => {
      throw new DeviceError("line_rejected", "archived meanwhile");
    });
    const { db, props, view } = renderLineSelect({ kind: "running", synced: 0 }, { onSelect });
    insertLine(db, LINE_2, "Линия 2");
    insertLine(db, LINE_10, "Линия 10");
    view.rerender(<LineSelect {...props} sync={{ kind: "done", synced: 1 }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Линия 2" }));
    expect(
      await screen.findByText(
        "Хост не принял эту линию: её убрали в архив или удалили. Выберите линию заново.",
      ),
    ).toBeTruthy();
    expect(props.onSync).toHaveBeenCalledTimes(1);

    // The sync brings the archive flag; the list follows it.
    db.prepare("UPDATE ref_lines SET archived = 1 WHERE id = ?").run(LINE_2);
    view.rerender(<LineSelect {...props} sync={{ kind: "done", synced: 2 }} />);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Линия 2" })).toBeNull());
    expect(screen.getByRole("button", { name: "Линия 10" })).toBeTruthy();
  });

  it("explains any other refusal without syncing", async () => {
    const onSelect = vi.fn<LineSelectProps["onSelect"]>(async () => {
      throw new DeviceError("request_failed", "host error");
    });
    const { db, props, view } = renderLineSelect({ kind: "running", synced: 0 }, { onSelect });
    insertLine(db, LINE_2, "Линия 2");
    view.rerender(<LineSelect {...props} sync={{ kind: "done", synced: 1 }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Линия 2" }));
    expect(await screen.findByText("Хост не выполнил запрос. Повторите попытку.")).toBeTruthy();
    expect(props.onSync).not.toHaveBeenCalled();
  });

  it("shows the link and opens the office", () => {
    const { props } = renderLineSelect(
      { kind: "failed", synced: 0 },
      { link: { state: "offline", lastContactAt: null, lastError: "unreachable", seq: 4 } },
    );
    expect(screen.getByText("Нет связи с хостом")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Офис" }));
    expect(props.onOffice).toHaveBeenCalledTimes(1);
  });
});
