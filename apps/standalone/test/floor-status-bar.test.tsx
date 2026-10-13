import { readFileSync } from "node:fs";

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import type { SyncState } from "../src/app/shell.js";
import { readFloorPlace } from "../src/floor/floor-status.js";
import { FloorStatusBar, type FloorStatusBarProps } from "../src/floor/FloorStatusBar.js";
import { keepEnteredShift } from "../src/floor/shifts/shift-copies.js";
import { enteredShiftSchema, type ChangeItem, type HostStatus } from "../src/host/protocol.js";
import type { LocalExecutor } from "../src/local/executor.js";
import { syncReferences } from "../src/local/reference-sync.js";
import { noteRestoreEpoch, reconcileRestore } from "../src/local/restore-reconcile.js";
import { DEVICE_ID, HOST_ID, LINE_ID } from "./support/fixtures.js";
import { seedBlock, unsentScans } from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;
const ENTERED = enteredShiftSchema.parse(
  JSON.parse(
    readFileSync(new URL("../proto/fixtures/device-shift-entered.json", testModuleUrl), "utf8"),
  ),
);
const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };
const OTHER_DEVICE = "1d2e3f4a-5b6c-4d7e-8f90-a1b2c3d4e5f6";
const OTHER_HOST = "7c6b5a49-3827-4165-9403-f2e1d0c9b8a7";
const OTHER_LINE_ID = "00000000-6a3e-4b9f-9d3c-2b1a0e8f7d61";
const SYNCED: SyncState = { kind: "done", synced: 1, failure: null, quarantined: 0 };
const ONLINE_LINK: HostStatus = { state: "online", lastContactAt: null, lastError: null, seq: 1 };
const ORG: ChangeItem = {
  entity: "org_profile",
  id: "1",
  rev: 2,
  deleted: false,
  data: {
    name: "ООО «Атолл»",
    inn: null,
    gln: "4600682000013",
    gs1Prefixes: ["4600682"],
    timeZone: "Europe/Moscow",
  },
};

function line(name: string, archived = false, id = LINE_ID): ChangeItem {
  return { entity: "lines", id, rev: 3, deleted: false, data: { name, archived } };
}

async function synced(items: ChangeItem[], rev = 10): Promise<LocalExecutor> {
  const { executor } = openLocalDb();
  await syncReferences({
    changes: async () => ({ hostId: HOST_ID, rev, hasMore: false, items }),
    local: executor,
    ...PAIRING,
  });
  return executor;
}

function bar(props: Partial<FloorStatusBarProps> & { local: LocalExecutor }) {
  return (
    <ThemeProvider>
      <FloorStatusBar
        pairing={PAIRING}
        lineId={LINE_ID}
        operator={null}
        link={null}
        sync={SYNCED}
        deviceName={null}
        shiftId={null}
        deviceNotSaved={false}
        refusalHeld={false}
        outboxVersion={0}
        factsFailure={null}
        {...props}
      />
    </ThemeProvider>
  );
}

describe("where the floor's status bar says the station works", () => {
  it("names the organization and the line from this pairing's copies, an archived line too", async () => {
    const local = await synced([ORG, line("Линия розлива 2", true)]);
    expect(await readFloorPlace(local, PAIRING, LINE_ID)).toEqual({
      organization: "ООО «Атолл»",
      line: "Линия розлива 2",
    });
    expect(await readFloorPlace(local, PAIRING, null)).toEqual({
      organization: "ООО «Атолл»",
      line: null,
    });
  });

  it("names the line the station is assigned to, not another one of the copies", async () => {
    // The other line sorts and is inserted first, so a read that ignores the id names it.
    const local = await synced([
      ORG,
      line("Линия фасовки 1", false, OTHER_LINE_ID),
      line("Линия розлива 2"),
    ]);
    expect((await readFloorPlace(local, PAIRING, LINE_ID)).line).toBe("Линия розлива 2");
    expect((await readFloorPlace(local, PAIRING, OTHER_LINE_ID)).line).toBe("Линия фасовки 1");
  });

  it("names nothing from copies that are not this pairing's", async () => {
    const local = await synced([ORG, line("Линия розлива 2")]);
    expect(
      await readFloorPlace(local, { hostId: HOST_ID, deviceId: OTHER_DEVICE }, LINE_ID),
    ).toEqual({ organization: null, line: null });
  });
});

describe("the floor's status bar", () => {
  it("shows the organization, the line and that nobody is signed in, with nothing to press", async () => {
    render(bar({ local: await synced([ORG, line("Линия розлива 2")]) }));
    expect(await screen.findByText("ООО «Атолл»")).toBeTruthy();
    expect(screen.getByText("Линия розлива 2")).toBeTruthy();
    expect(screen.getByText("Никто не вошёл")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Строка состояния цеха" })).toBeTruthy();
    expect(screen.queryAllByRole("button")).toEqual([]);
  });

  it("names the operator signed in", async () => {
    render(
      bar({
        local: await synced([ORG]),
        operator: { id: "op-1", login: "0042", name: "Анна Кузнецова", role: null },
      }),
    );
    expect(await screen.findByText("Анна Кузнецова, табельный номер 0042")).toBeTruthy();
  });

  it("shows the operator's name as text, whatever characters it holds", async () => {
    const name = '<img src="x" alt="boom"> Анна & <b>Кузнецова</b>';
    const view = render(
      bar({
        local: await synced([ORG]),
        operator: { id: "op-1", login: "0042", name, role: null },
      }),
    );
    expect(await screen.findByText(`${name}, табельный номер 0042`)).toBeTruthy();
    expect(view.container.querySelector("img, b")).toBeNull();
  });

  it("offers «Сменить оператора» in its rail once an operator is in, at the floor's 64 px", async () => {
    const onSwitchOperator = vi.fn();
    render(
      bar({
        local: await synced([ORG]),
        operator: { id: "op-1", login: "0042", name: "Анна Кузнецова", role: null },
        onSwitchOperator,
      }),
    );
    const rail = await screen.findByRole("group", { name: "Действия станции" });
    const button = within(rail).getByRole("button", { name: "Сменить оператора" });
    expect(button.className).toContain("mk-btn--floor");
    expect(button).toHaveProperty("disabled", false);
    // Outside a shift there is nothing to keep: it signs out at once.
    fireEvent.click(button);
    expect(onSwitchOperator).toHaveBeenCalledTimes(1);
  });

  it("offers no switch while nobody is signed in", async () => {
    render(bar({ local: await synced([ORG]), onSwitchOperator: vi.fn() }));
    await screen.findByText("Никто не вошёл");
    expect(screen.queryByRole("button", { name: "Сменить оператора" })).toBeNull();
  });

  it("asks first in a shift: «Остаться» keeps the operator, the confirmation signs out", async () => {
    const local = await synced([ORG]);
    await keepEnteredShift(local, PAIRING, ENTERED, "2026-10-09T06:00:00.000Z", 1);
    const onSwitchOperator = vi.fn();
    render(
      bar({
        local,
        operator: { id: "op-1", login: "0042", name: "Анна Кузнецова", role: null },
        shiftId: ENTERED.id,
        onSwitchOperator,
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Сменить оператора" }));
    const dialog = await screen.findByRole("dialog", { name: "Сменить оператора?" });
    expect(
      within(dialog).getByText(
        "Текущая смена останется открытой. Все записанные операции сохранятся на станции.",
      ),
    ).toBeTruthy();
    expect(onSwitchOperator).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Остаться" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onSwitchOperator).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Сменить оператора" }));
    const again = await screen.findByRole("dialog", { name: "Сменить оператора?" });
    fireEvent.click(within(again).getByRole("button", { name: "Сменить оператора" }));
    expect(onSwitchOperator).toHaveBeenCalledTimes(1);
  });

  it("shows the link to the host", async () => {
    const offline: HostStatus = {
      state: "offline",
      lastContactAt: null,
      lastError: "unreachable",
      seq: 1,
    };
    render(bar({ local: await synced([ORG]), link: offline }));
    expect(await screen.findByText("Нет связи с хостом")).toBeTruthy();
    expect(screen.getByText("Хост не отвечает.")).toBeTruthy();
  });

  it("reads the names again after every sync", async () => {
    const { executor } = openLocalDb();
    const { rerender } = render(bar({ local: executor, sync: { ...SYNCED, synced: 0 } }));
    expect(await screen.findByText("Никто не вошёл")).toBeTruthy();
    expect(screen.queryByText("Организация")).toBeNull();
    await syncReferences({
      changes: async () => ({ hostId: HOST_ID, rev: 10, hasMore: false, items: [ORG] }),
      local: executor,
      ...PAIRING,
    });
    rerender(bar({ local: executor, sync: SYNCED }));
    expect(await screen.findByText("ООО «Атолл»")).toBeTruthy();
  });

  it("leaves the names out when the copies cannot be read", async () => {
    const real = await synced([ORG, line("Линия розлива 2")]);
    let reads = 0;
    const local: LocalExecutor = {
      query: () => {
        reads += 1;
        return Promise.reject(new Error("disk"));
      },
      transaction: (statements) => real.transaction(statements),
    };
    render(bar({ local }));
    await waitFor(() => expect(reads).toBeGreaterThan(0));
    expect(screen.getByText("Никто не вошёл")).toBeTruthy();
    expect(screen.queryByText("ООО «Атолл»")).toBeNull();
    expect(screen.queryByText("Организация")).toBeNull();
  });

  it("forgets the names when the next read of the copies fails", async () => {
    const real = await synced([ORG, line("Линия розлива 2")]);
    let failing = false;
    let reads = 0;
    const local: LocalExecutor = {
      query: (sql, params, row) => {
        if (!failing) return real.query(sql, params, row);
        reads += 1;
        return Promise.reject(new Error("disk"));
      },
      transaction: (statements) => real.transaction(statements),
    };
    const { rerender } = render(bar({ local }));
    expect(await screen.findByText("ООО «Атолл»")).toBeTruthy();
    expect(await screen.findByText("Линия розлива 2")).toBeTruthy();

    failing = true;
    rerender(bar({ local, sync: { ...SYNCED, synced: 2 } }));
    await waitFor(() => expect(reads).toBeGreaterThan(0));
    await waitFor(() => expect(screen.queryByText("ООО «Атолл»")).toBeNull());
    expect(screen.queryByText("Линия розлива 2")).toBeNull();
    expect(screen.getByText("Никто не вошёл")).toBeTruthy();
  });

  it("keeps the names of the line it has now when a read for the line before it lands late", async () => {
    const real = await synced([
      ORG,
      line("Линия фасовки 1", false, OTHER_LINE_ID),
      line("Линия розлива 2"),
    ]);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let heldStarted = false;
    const local: LocalExecutor = {
      query: (sql, params, row) => {
        const result = real.query(sql, params, row);
        if (!sql.includes("ref_lines") || params[0] !== OTHER_LINE_ID) return result;
        heldStarted = true;
        return gate.then(() => result);
      },
      transaction: (statements) => real.transaction(statements),
    };
    const { rerender } = render(bar({ local, lineId: OTHER_LINE_ID }));
    await waitFor(() => expect(heldStarted).toBe(true));

    rerender(bar({ local, lineId: LINE_ID }));
    expect(await screen.findByText("Линия розлива 2")).toBeTruthy();

    await act(async () => {
      release();
      await gate;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByText("Линия розлива 2")).toBeTruthy();
    expect(screen.queryByText("Линия фасовки 1")).toBeNull();
  });

  it("names the device, and the shift the operator works in while they work in it", async () => {
    const local = await synced([ORG, line("Линия розлива 2")]);
    await keepEnteredShift(local, PAIRING, ENTERED, "2026-10-09T06:00:00.000Z", 1_790_000_000_000);
    const view = render(bar({ local, deviceName: "Станция у окна", shiftId: ENTERED.id }));
    const region = screen.getByRole("region", { name: "Строка состояния цеха" });
    expect(within(region).getByText("Станция у окна")).toBeTruthy();
    expect(await within(region).findByText("OCT26-004")).toBeTruthy();
    view.rerender(bar({ local, deviceName: "Станция у окна", shiftId: null }));
    expect(within(region).queryByText("OCT26-004")).toBeNull();
    expect(within(region).queryByText("Смена")).toBeNull();
  });

  it("shows the link as stopped while the host's refusal waits, whatever the link's last status says", async () => {
    const local = await synced([ORG]);
    const online: HostStatus = { state: "online", lastContactAt: null, lastError: null, seq: 1 };
    const failing: SyncState = { ...SYNCED, kind: "failed", failure: "host" };
    const view = render(bar({ local, link: online, sync: failing }));
    expect(await screen.findByText("ООО «Атолл»")).toBeTruthy();
    const region = screen.getByRole("region", { name: "Строка состояния цеха" });
    expect(within(region).getByText("На связи с хостом")).toBeTruthy();
    expect(
      within(region).getByText("Справочники не обновились — повторим автоматически"),
    ).toBeTruthy();
    expect(within(region).queryByText("Нет связи с хостом")).toBeNull();

    // The link is torn down already, but a refusal that came from a call left its status online.
    view.rerender(bar({ local, link: online, sync: failing, refusalHeld: true }));
    expect(within(region).queryByText("На связи с хостом")).toBeNull();
    expect(within(region).getByText("Нет связи с хостом")).toBeTruthy();
    // A sync that cannot run is not the news now: the refusal is.
    expect(
      within(region).queryByText("Справочники не обновились — повторим автоматически"),
    ).toBeNull();

    view.rerender(bar({ local, link: online, sync: failing, refusalHeld: false }));
    expect(within(region).getByText("На связи с хостом")).toBeTruthy();
  });

  it("shows no link of its own while the refusal waits before the first status of the link", async () => {
    const local = await synced([ORG]);
    render(bar({ local, link: null, refusalHeld: true }));
    expect(await screen.findByText("ООО «Атолл»")).toBeTruthy();
    const region = screen.getByRole("region", { name: "Строка состояния цеха" });
    expect(within(region).queryByText("Нет связи с хостом")).toBeNull();
    expect(within(region).queryByText("На связи с хостом")).toBeNull();
  });

  it("names no device for a pairing file that has no name", async () => {
    render(bar({ local: await synced([ORG]) }));
    expect(await screen.findByText("ООО «Атолл»")).toBeTruthy();
    expect(screen.queryByText("Устройство")).toBeNull();
  });

  it("keeps the number of the shift read before out of the bar when the next shift cannot be read", async () => {
    const local = await synced([ORG]);
    await keepEnteredShift(local, PAIRING, ENTERED, "2026-10-09T06:00:00.000Z", 1_790_000_000_000);
    const view = render(bar({ local, shiftId: ENTERED.id }));
    expect(await screen.findByText("OCT26-004")).toBeTruthy();
    // A shift this pairing has no copy of, and one it cannot read at all.
    view.rerender(bar({ local, shiftId: "4e7a1c9d-2b5f-4d8e-a3c6-9f0b1e2d3c4a" }));
    await waitFor(() => expect(screen.queryByText("OCT26-004")).toBeNull());
    expect(screen.queryByText("Смена")).toBeNull();
    view.rerender(bar({ local, shiftId: ENTERED.id }));
    expect(await screen.findByText("OCT26-004")).toBeTruthy();
    const broken: LocalExecutor = {
      query: () => Promise.reject(new Error("disk")),
      transaction: (statements) => local.transaction(statements),
    };
    view.rerender(bar({ local: broken, shiftId: ENTERED.id }));
    await waitFor(() => expect(screen.queryByText("OCT26-004")).toBeNull());
  });

  it("names no shift of a pairing other than its own", async () => {
    const real = await synced([ORG]);
    await keepEnteredShift(real, PAIRING, ENTERED, "2026-10-09T06:00:00.000Z", 1_790_000_000_000);
    // The reads of the shift's copy and of its snapshot's prefix (for the serials) are
    // watched, so that the assertion waits for their answers (and what the bar makes
    // of them), not for a time that may be too short.
    const reads: Promise<unknown>[] = [];
    const local: LocalExecutor = {
      query: (sql, params, row) => {
        const read = real.query(sql, params, row);
        if (sql.includes("FROM floor_shifts")) reads.push(read);
        return read;
      },
      transaction: (statements) => real.transaction(statements),
    };
    render(
      bar({ local, pairing: { hostId: HOST_ID, deviceId: OTHER_DEVICE }, shiftId: ENTERED.id }),
    );
    await waitFor(() => expect(reads).toHaveLength(2));
    await act(async () => {
      await Promise.all(reads);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByText("OCT26-004")).toBeNull();
  });

  /** The polite live regions of the bar, before anything is warned of. */
  function politeRegions(region: HTMLElement): Set<Element> {
    return new Set(region.querySelectorAll('[aria-live="polite"]'));
  }

  /** The element sits in one of those regions (it is not, when it brought its own). */
  function isIn(regions: Set<Element>, element: HTMLElement): boolean {
    const region = element.closest('[aria-live="polite"]');
    return region !== null && regions.has(region);
  }

  it("warns while a change the office made to the device was not saved here, in a polite region that was there before", async () => {
    const local = await synced([ORG]);
    const view = render(bar({ local }));
    expect(await screen.findByText("ООО «Атолл»")).toBeTruthy();
    const region = screen.getByRole("region", { name: "Строка состояния цеха" });
    const before = politeRegions(region);
    view.rerender(bar({ local, deviceNotSaved: true }));
    const warning = screen.getByText(
      "Офис изменил это устройство, но изменение не удалось сохранить на этом компьютере: станция работает по-прежнему. Освободите место на диске или обратитесь к администратору.",
    );
    // A region that appears together with its text is not announced.
    expect(isIn(before, warning)).toBe(true);
    // The warning is heard once, by that region: it is not an alert of its own as well.
    expect(within(region).queryAllByRole("alert")).toEqual([]);
    view.rerender(bar({ local, deviceNotSaved: false }));
    expect(screen.queryByText(/не удалось сохранить на этом компьютере/)).toBeNull();
  });

  it("says in the same polite region that the host refused this station while the operator is still in the shift", async () => {
    const local = await synced([ORG]);
    const view = render(bar({ local }));
    expect(await screen.findByText("ООО «Атолл»")).toBeTruthy();
    const region = screen.getByRole("region", { name: "Строка состояния цеха" });
    const before = politeRegions(region);
    const marker =
      "Хост отказал этой станции: записи не отправляются. Выйдите из смены и подключите станцию заново.";
    expect(screen.queryByText(marker)).toBeNull();
    view.rerender(bar({ local, refusalHeld: true }));
    const shown = screen.getByText(marker);
    expect(isIn(before, shown)).toBe(true);
    expect(within(region).queryAllByRole("alert")).toEqual([]);
    // Both warnings stand together.
    view.rerender(bar({ local, refusalHeld: true, deviceNotSaved: true }));
    expect(screen.getByText(marker)).toBeTruthy();
    expect(screen.getByText(/не удалось сохранить на этом компьютере/)).toBeTruthy();
    view.rerender(bar({ local, refusalHeld: false, deviceNotSaved: true }));
    expect(screen.queryByText(marker)).toBeNull();
  });

  it("says, in the same region, that another host answers when that is what waits for the operator", async () => {
    const local = await synced([ORG]);
    const view = render(bar({ local }));
    expect(await screen.findByText("ООО «Атолл»")).toBeTruthy();
    const region = screen.getByRole("region", { name: "Строка состояния цеха" });
    const before = politeRegions(region);
    const refused =
      "Хост отказал этой станции: записи не отправляются. Выйдите из смены и подключите станцию заново.";
    const other =
      "По адресу хоста отвечает другой хост: записи не отправляются. Выйдите из смены и подключите станцию заново.";
    view.rerender(bar({ local, link: ONLINE_LINK, refusalHeld: true, otherHostHeld: true }));
    const shown = screen.getByText(other);
    expect(isIn(before, shown)).toBe(true);
    expect(within(region).queryAllByRole("alert")).toEqual([]);
    // It is not the host's refusal, and the link is not called up either.
    expect(screen.queryByText(refused)).toBeNull();
    expect(within(region).queryByText("На связи с хостом")).toBeNull();
    view.rerender(bar({ local, link: ONLINE_LINK, refusalHeld: true }));
    expect(screen.getByText(refused)).toBeTruthy();
    expect(screen.queryByText(other)).toBeNull();
    // A flag without the hold says nothing.
    view.rerender(bar({ local, refusalHeld: false, otherHostHeld: true }));
    expect(screen.queryByText(other)).toBeNull();
  });
});

describe("the outbox and the serials on the floor's status bar", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The value the bar shows under `label`, or `null` when it shows no such item. */
  function shown(label: string): string | null {
    const term = screen.queryByText(label);
    return term === null ? null : (term.nextElementSibling?.textContent ?? null);
  }

  /** The polite live regions of the bar, before anything is warned of. */
  function politeRegions(): Set<Element> {
    const region = screen.getByRole("region", { name: "Строка состояния цеха" });
    return new Set(region.querySelectorAll('[aria-live="polite"]'));
  }

  /** The element sits in one of those regions, and the bar has no alert of its own. */
  function heardOnce(regions: Set<Element>, element: HTMLElement): boolean {
    const region = element.closest('[aria-live="polite"]');
    const bar = screen.getByRole("region", { name: "Строка состояния цеха" });
    return (
      region !== null && regions.has(region) && within(bar).queryAllByRole("alert").length === 0
    );
  }

  /** An executor whose first read that `matches` waits for `release()`; the answer is the one it had. */
  function holdingFirstRead(real: LocalExecutor, matches: (sql: string) => boolean) {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    const executor: LocalExecutor = {
      query: (sql, params, row) => {
        const result = real.query(sql, params, row);
        if (held || !matches(sql)) return result;
        held = true;
        return gate.then(() => result);
      },
      transaction: (statements) => real.transaction(statements),
    };
    return { executor, started: () => held, release: () => release() };
  }

  const clock = () => new Date();

  /** Lets the effects the last render scheduled run (a timer a bar sets is set by one). */
  async function flushEffects(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
    });
  }

  const isUnsentCount = (sql: string): boolean =>
    sql.includes("count(*)") && sql.includes("IS NULL");
  const isHeadRecord = (sql: string): boolean => sql.includes("sent_at, created_at FROM outbox");
  const isSerialsRead = (sql: string): boolean => sql.includes("next_serial, to_serial FROM");

  it("counts this pairing's records not sent, refused and in conflict, and reads them again on a change", async () => {
    const { db, executor } = openLocalDb();
    const ids = await unsentScans(executor, 5);
    await unsentScans(executor, 2, { hostId: HOST_ID, deviceId: OTHER_DEVICE }, 100);
    await unsentScans(executor, 1, { hostId: OTHER_HOST, deviceId: DEVICE_ID }, 200);
    const answer = db.prepare(
      "UPDATE outbox SET outcome = ?, outcome_code = ?, acked_at = '2026-10-08T06:20:00.000Z' WHERE id = ?",
    );
    answer.run("accepted", null, ids[0] ?? "");
    answer.run("rejected", "invalid_record", ids[1] ?? "");
    const view = render(bar({ local: executor }));
    await waitFor(() => expect(shown("Не отправлено")).toBe("3"));
    expect(shown("Отклонено хостом")).toBe("1");
    expect(shown("Конфликтов")).toBeNull();
    answer.run("conflict", null, ids[2] ?? "");
    view.rerender(bar({ local: executor, outboxVersion: 1 }));
    await waitFor(() => expect(shown("Не отправлено")).toBe("2"));
    expect(shown("Конфликтов")).toBe("1");
  });

  it("shows every count with the thousands separator", async () => {
    const { db, executor } = openLocalDb();
    const fill = db.prepare(
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?) " +
        "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at, outcome, acked_at) " +
        "SELECT ? || i, ?, ?, 'scan', 's', '{}', '2026-10-08T06:20:00.000Z', ?, " +
        "CASE WHEN ? IS NULL THEN NULL ELSE '2026-10-08T06:30:00.000Z' END FROM n",
    );
    fill.run(1234, "u", HOST_ID, DEVICE_ID, null, null);
    fill.run(1111, "r", HOST_ID, DEVICE_ID, "rejected", "rejected");
    fill.run(2222, "c", HOST_ID, DEVICE_ID, "conflict", "conflict");
    render(bar({ local: executor }));
    await waitFor(() => expect(shown("Не отправлено")).toBe("1\u00a0234"));
    expect(shown("Отклонено хостом")).toBe("1\u00a0111");
    expect(shown("Конфликтов")).toBe("2\u00a0222");
  });

  it("shows the serials left for the boxes of the shift the operator works in, and none outside it", async () => {
    const { db, executor } = openLocalDb();
    await keepEnteredShift(executor, PAIRING, ENTERED, "2026-10-08T06:02:00.000Z", 1);
    seedBlock(db, { blockId: "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a", from: 1500, to: 3499 });
    const view = render(bar({ local: executor, shiftId: ENTERED.id }));
    await waitFor(() => expect(shown("Номеров SSCC")).toBe("2\u00a0000"));
    // Nothing written yet: nothing to send, refused or in conflict.
    expect([shown("Не отправлено"), shown("Отклонено хостом"), shown("Конфликтов")]).toEqual([
      "0",
      null,
      null,
    ]);
    db.prepare("UPDATE floor_sscc_blocks SET next_serial = 1501").run();
    view.rerender(bar({ local: executor, shiftId: ENTERED.id, outboxVersion: 1 }));
    await waitFor(() => expect(shown("Номеров SSCC")).toBe("1\u00a0999"));
    view.rerender(bar({ local: executor, shiftId: null, outboxVersion: 1 }));
    expect(shown("Номеров SSCC")).toBeNull();
  });

  it("leaves the counts out when this computer cannot read the outbox", async () => {
    const { executor } = openLocalDb();
    const failing: LocalExecutor = {
      query: (sql, params, row) =>
        sql.includes("FROM outbox")
          ? Promise.reject(new Error("disk"))
          : executor.query(sql, params, row),
      transaction: (statements) => executor.transaction(statements),
    };
    render(bar({ local: failing }));
    expect(await screen.findByText("Никто не вошёл")).toBeTruthy();
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
    });
    expect(shown("Не отправлено")).toBeNull();
  });

  it("forgets the counts the outbox gave when its next read fails", async () => {
    const { executor } = openLocalDb();
    await unsentScans(executor, 2);
    let failing = false;
    const local: LocalExecutor = {
      query: (sql, params, row) =>
        failing && sql.includes("FROM outbox")
          ? Promise.reject(new Error("disk"))
          : executor.query(sql, params, row),
      transaction: (statements) => executor.transaction(statements),
    };
    const view = render(bar({ local }));
    await waitFor(() => expect(shown("Не отправлено")).toBe("2"));
    failing = true;
    view.rerender(bar({ local, outboxVersion: 1 }));
    await waitFor(() => expect(shown("Не отправлено")).toBeNull());
  });

  it("leaves the serials out when this computer cannot read them, and for a shift it has no snapshot of", async () => {
    const { db, executor } = openLocalDb();
    await keepEnteredShift(executor, PAIRING, ENTERED, "2026-10-08T06:02:00.000Z", 1);
    seedBlock(db, { blockId: "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a", from: 1, to: 2000 });
    let failing = false;
    const local: LocalExecutor = {
      query: (sql, params, row) =>
        failing && sql.includes("floor_sscc_blocks")
          ? Promise.reject(new Error("disk"))
          : executor.query(sql, params, row),
      transaction: (statements) => executor.transaction(statements),
    };
    const view = render(bar({ local, shiftId: ENTERED.id }));
    await waitFor(() => expect(shown("Номеров SSCC")).toBe("2\u00a0000"));
    failing = true;
    view.rerender(bar({ local, shiftId: ENTERED.id, outboxVersion: 1 }));
    await waitFor(() => expect(shown("Номеров SSCC")).toBeNull());
    failing = false;
    view.rerender(bar({ local, shiftId: ENTERED.id, outboxVersion: 2 }));
    await waitFor(() => expect(shown("Номеров SSCC")).toBe("2\u00a0000"));
    // A shift this pairing has no copy of names no serials.
    view.rerender(
      bar({ local, shiftId: "4e7a1c9d-2b5f-4d8e-a3c6-9f0b1e2d3c4a", outboxVersion: 2 }),
    );
    await waitFor(() => expect(shown("Номеров SSCC")).toBeNull());
  });

  it("warns, in the polite region that was there before, at a quarter and a tenth of the block, at the last serial, and says so at zero (plan ОЧ)", async () => {
    const { db, executor } = openLocalDb();
    await keepEnteredShift(executor, PAIRING, ENTERED, "2026-10-08T06:02:00.000Z", 1);
    // A block of 2 000 with 501 left: nothing to say yet.
    seedBlock(db, {
      blockId: "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a",
      from: 1,
      to: 2000,
      next: 1500,
    });
    const view = render(bar({ local: executor, shiftId: ENTERED.id }));
    await waitFor(() => expect(shown("Номеров SSCC")).toBe("501"));
    const before = politeRegions();
    expect(screen.queryByText(/Номеров SSCC для коробов осталось/)).toBeNull();

    const step = async (next: number, version: number) => {
      db.prepare("UPDATE floor_sscc_blocks SET next_serial = ?").run(next);
      view.rerender(bar({ local: executor, shiftId: ENTERED.id, outboxVersion: version }));
    };
    await step(1501, 1);
    const quarter = await screen.findByText(
      "Номеров SSCC для коробов осталось 500 — четверть блока или меньше. Новые номера выдаёт хост: станция должна быть с ним на связи.",
    );
    expect(heardOnce(before, quarter)).toBe(true);
    await step(1801, 2);
    expect(
      await screen.findByText(
        "Номеров SSCC для коробов осталось 200 — десятая часть блока или меньше. Без связи с хостом короба скоро не закрыть.",
      ),
    ).toBeTruthy();
    // One warning at a time: the quarter's words are gone.
    expect(screen.queryByText(/четверть блока или меньше/)).toBeNull();
    await step(2000, 3);
    const last = await screen.findByText(
      "Остался последний номер SSCC для коробов: следующий короб без связи с хостом не закрыть.",
    );
    expect(heardOnce(before, last)).toBe(true);
    expect(screen.queryByText(/десятая часть блока или меньше/)).toBeNull();
    await step(2001, 4);
    const gone = await screen.findByText(
      "Номера SSCC для коробов закончились: короб не закрыть, пока хост не выдаст станции новый блок. Нужна связь с хостом.",
    );
    expect(heardOnce(before, gone)).toBe(true);
    expect(screen.queryByText(/Остался последний номер/)).toBeNull();
    expect(shown("Номеров SSCC")).toBe("0");

    // A block arrives: the warnings go.
    seedBlock(db, { blockId: "6e5d4c3b-2a1f-4e0d-9c8b-7a6f5e4d3c2b", from: 2001, to: 4000 });
    view.rerender(bar({ local: executor, shiftId: ENTERED.id, outboxVersion: 5 }));
    await waitFor(() => expect(shown("Номеров SSCC")).toBe("2\u00a0000"));
    expect(screen.queryByText(/Номера SSCC для коробов закончились/)).toBeNull();
    expect(screen.queryByText(/Номеров SSCC для коробов осталось/)).toBeNull();
  });

  it("says «или меньше» at a quarter and a tenth, for boxes and pallets: both thresholds count exactly 25 % and 10 % (final review m-5)", () => {
    const stock = (
      JSON.parse(readFileSync(new URL("../src/i18n/ru.json", testModuleUrl), "utf8")) as {
        floor: { status: { stock: Record<string, Record<string, string>> } };
      }
    ).floor.status.stock;
    for (const what of ["box", "pallet"]) {
      expect(stock[what]?.["quarter"], what).toContain("— четверть блока или меньше.");
      expect(stock[what]?.["tenth"], what).toContain("— десятая часть блока или меньше.");
      expect(JSON.stringify(stock[what]), what).not.toMatch(/меньше (четверти|десятой)/);
    }
  });

  it("calls the warnings by their weight: a warning at a quarter and a tenth, an error at the last serial and at none", async () => {
    const { db, executor } = openLocalDb();
    await keepEnteredShift(executor, PAIRING, ENTERED, "2026-10-08T06:02:00.000Z", 1);
    seedBlock(db, {
      blockId: "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a",
      from: 1,
      to: 2000,
      next: 1501,
    });
    const view = render(bar({ local: executor, shiftId: ENTERED.id }));
    const toneOf = (text: RegExp): string =>
      (screen.getByText(text).closest(".mk-alert")?.className ?? "").replace(
        /^.*(mk-alert--\w+).*$/,
        "$1",
      );
    const step = (next: number, version: number) => {
      db.prepare("UPDATE floor_sscc_blocks SET next_serial = ?").run(next);
      view.rerender(bar({ local: executor, shiftId: ENTERED.id, outboxVersion: version }));
    };
    await screen.findByText(/четверть блока или меньше/);
    expect(toneOf(/четверть блока или меньше/)).toBe("mk-alert--warn");
    step(1801, 1);
    await screen.findByText(/десятая часть блока или меньше/);
    expect(toneOf(/десятая часть блока или меньше/)).toBe("mk-alert--warn");
    step(2000, 2);
    await screen.findByText(/Остался последний номер/);
    expect(toneOf(/Остался последний номер/)).toBe("mk-alert--error");
    step(2001, 3);
    await screen.findByText(/Номера SSCC для коробов закончились/);
    expect(toneOf(/Номера SSCC для коробов закончились/)).toBe("mk-alert--error");
  });

  it("shows and warns of the pallets' serials only in a shift with pallets (plan ОЧ)", async () => {
    const { db, executor } = openLocalDb();
    await keepEnteredShift(executor, PAIRING, ENTERED, "2026-10-08T06:02:00.000Z", 1);
    seedBlock(db, { blockId: "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a", from: 1, to: 2000 });
    seedBlock(db, {
      blockId: "6e5d4c3b-2a1f-4e0d-9c8b-7a6f5e4d3c2b",
      from: 1,
      to: 200,
      next: 181,
      extension: 1,
    });
    const view = render(bar({ local: executor, shiftId: ENTERED.id }));
    await waitFor(() => expect(shown("Номеров SSCC")).toBe("2\u00a0000"));
    expect(shown("Номеров SSCC паллет")).toBeNull();
    expect(screen.queryByText(/Номеров SSCC для паллет/)).toBeNull();
    db.prepare("UPDATE floor_shifts SET pallets_enabled = 1 WHERE id = ?").run(ENTERED.id);
    view.rerender(bar({ local: executor, shiftId: ENTERED.id, outboxVersion: 1 }));
    await waitFor(() => expect(shown("Номеров SSCC паллет")).toBe("20"));
    expect(
      screen.getByText(
        "Номеров SSCC для паллет осталось 20 — десятая часть блока или меньше. Без связи с хостом полную паллету скоро не закрыть.",
      ),
    ).toBeTruthy();
    // The boxes' stock is plentiful: nothing is said of it.
    expect(screen.queryByText(/Номеров SSCC для коробов/)).toBeNull();
    // The pallets' last serial and none have their own words.
    db.prepare("UPDATE floor_sscc_blocks SET next_serial = 200 WHERE extension = 1").run();
    view.rerender(bar({ local: executor, shiftId: ENTERED.id, outboxVersion: 2 }));
    expect(
      await screen.findByText(
        "Остался последний номер SSCC для паллет: следующую полную паллету без связи с хостом не закрыть.",
      ),
    ).toBeTruthy();
    db.prepare("UPDATE floor_sscc_blocks SET next_serial = 201 WHERE extension = 1").run();
    view.rerender(bar({ local: executor, shiftId: ENTERED.id, outboxVersion: 3 }));
    expect(
      await screen.findByText(
        "Номера SSCC для паллет закончились: полную паллету не закрыть, пока хост не выдаст станции новый блок. Нужна связь с хостом.",
      ),
    ).toBeTruthy();
    expect(shown("Номеров SSCC паллет")).toBe("0");
    // Pallets are off again: nothing of them.
    db.prepare("UPDATE floor_shifts SET pallets_enabled = 0 WHERE id = ?").run(ENTERED.id);
    view.rerender(bar({ local: executor, shiftId: ENTERED.id, outboxVersion: 4 }));
    await waitFor(() => expect(shown("Номеров SSCC паллет")).toBeNull());
    expect(screen.queryByText(/Номера SSCC для паллет закончились/)).toBeNull();
  });

  it("says the blocks the host gave and the station did not take, and the records an older pairing left (plan ОЧ)", async () => {
    const { db, executor } = openLocalDb();
    db.prepare(
      "INSERT INTO floor_block_drops (host_id, device_id, block_id, request_id, issuer_prefix, " +
        "extension, from_serial, to_serial, reason, dropped_at) VALUES (?, ?, 'b-1', 'r', " +
        "'460068200', 0, 1, 10, 'overlap', '2026-10-11T08:00:00.000Z')",
    ).run(PAIRING.hostId, PAIRING.deviceId);
    await unsentScans(executor, 3, { hostId: HOST_ID, deviceId: OTHER_DEVICE }, 50);
    const view = render(bar({ local: executor }));
    const before = politeRegions();
    const drops = await screen.findByText(/станции блоков номеров SSCC, которые она не приняла: 1/);
    // Heard once in the region that was there before, and called an error in words, not by colour alone.
    expect(heardOnce(before, drops)).toBe(true);
    expect(drops.closest(".mk-alert")?.classList.contains("mk-alert--error")).toBe(true);
    await waitFor(() => expect(shown("Не отправлено прежним подключением")).toBe("3"));
    // The records of the other pairing are not this pairing's unsent ones.
    expect(shown("Не отправлено")).toBe("0");
    // The drops are read again with the outbox, the stranded records are not (a walk too dear for every scan).
    db.prepare(
      "INSERT INTO floor_block_drops (host_id, device_id, block_id, request_id, issuer_prefix, " +
        "extension, from_serial, to_serial, reason, dropped_at) VALUES (?, ?, 'b-2', 'r', " +
        "'460068200', 0, 11, 20, 'mismatch', '2026-10-11T08:01:00.000Z')",
    ).run(PAIRING.hostId, PAIRING.deviceId);
    await unsentScans(executor, 2, { hostId: HOST_ID, deviceId: OTHER_DEVICE }, 90);
    view.rerender(bar({ local: executor, outboxVersion: 1 }));
    expect(
      await screen.findByText(/станции блоков номеров SSCC, которые она не приняла: 2/),
    ).toBeTruthy();
    expect(shown("Не отправлено прежним подключением")).toBe("3");
  });

  it("says nothing of dropped blocks or older records when there are none", async () => {
    const { executor } = openLocalDb();
    // Records of the pairing itself are not an older pairing's.
    await unsentScans(executor, 2);
    render(bar({ local: executor }));
    await waitFor(() => expect(shown("Не отправлено")).toBe("2"));
    await flushEffects();
    expect(shown("Не отправлено прежним подключением")).toBeNull();
    expect(screen.queryByText(/которые она не приняла/)).toBeNull();
  });

  it("keeps the drops and the older records of the newest read when an older one lands late", async () => {
    const { db, executor } = openLocalDb();
    const drop = db.prepare(
      "INSERT INTO floor_block_drops (host_id, device_id, block_id, request_id, issuer_prefix, " +
        "extension, from_serial, to_serial, reason, dropped_at) VALUES (?, ?, ?, 'r', '460068200', " +
        "0, 1, 10, 'overlap', '2026-10-11T08:00:00.000Z')",
    );
    drop.run(PAIRING.hostId, PAIRING.deviceId, "b-1");
    const heldDrops = holdingFirstRead(executor, (sql) => sql.includes("FROM floor_block_drops"));
    const view = render(bar({ local: heldDrops.executor }));
    await waitFor(() => expect(heldDrops.started()).toBe(true));
    drop.run(PAIRING.hostId, PAIRING.deviceId, "b-2");
    view.rerender(bar({ local: heldDrops.executor, outboxVersion: 1 }));
    expect(await screen.findByText(/которые она не приняла: 2/)).toBeTruthy();
    await act(async () => {
      heldDrops.release();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByText(/которые она не приняла: 1/)).toBeNull();
    expect(screen.queryByText(/которые она не приняла: 2/)).toBeTruthy();
    view.unmount();

    // The older records are read per pairing: an answer for the pairing left must not land on the next.
    await unsentScans(executor, 3, { hostId: HOST_ID, deviceId: OTHER_DEVICE }, 50);
    const heldOld = holdingFirstRead(executor, (sql) => sql.includes("INDEXED BY"));
    const second = render(bar({ local: heldOld.executor }));
    await waitFor(() => expect(heldOld.started()).toBe(true));
    // Another pairing (the one that left the records) sees none of its own as an older one's.
    second.rerender(
      bar({ local: heldOld.executor, pairing: { hostId: HOST_ID, deviceId: OTHER_DEVICE } }),
    );
    await flushEffects();
    expect(shown("Не отправлено прежним подключением")).toBeNull();
    await act(async () => {
      heldOld.release();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(shown("Не отправлено прежним подключением")).toBeNull();
  });

  it("drops the older records it said when the next read of them fails, and what a failed read of the drops said", async () => {
    const { executor } = openLocalDb();
    await unsentScans(executor, 3, { hostId: HOST_ID, deviceId: OTHER_DEVICE }, 50);
    let failing = false;
    const flaky: LocalExecutor = {
      query: (sql, params, row) =>
        failing && sql.includes("INDEXED BY")
          ? Promise.reject(new Error("disk"))
          : executor.query(sql, params, row),
      transaction: (statements) => executor.transaction(statements),
    };
    const view = render(bar({ local: flaky }));
    await waitFor(() => expect(shown("Не отправлено прежним подключением")).toBe("3"));
    failing = true;
    view.rerender(bar({ local: flaky, pairing: { hostId: OTHER_HOST, deviceId: DEVICE_ID } }));
    await waitFor(() => expect(shown("Не отправлено прежним подключением")).toBeNull());
  });

  it("drops what a failed read of the dropped blocks said", async () => {
    const { db, executor } = openLocalDb();
    db.prepare(
      "INSERT INTO floor_block_drops (host_id, device_id, block_id, request_id, issuer_prefix, " +
        "extension, from_serial, to_serial, reason, dropped_at) VALUES (?, ?, 'b-1', 'r', " +
        "'460068200', 0, 1, 10, 'overlap', '2026-10-11T08:00:00.000Z')",
    ).run(PAIRING.hostId, PAIRING.deviceId);
    let failing = false;
    const local: LocalExecutor = {
      query: (sql, params, row) =>
        failing && sql.includes("floor_block_drops")
          ? Promise.reject(new Error("disk"))
          : executor.query(sql, params, row),
      transaction: (statements) => executor.transaction(statements),
    };
    const view = render(bar({ local }));
    expect(await screen.findByText(/которые она не приняла: 1/)).toBeTruthy();
    failing = true;
    view.rerender(bar({ local, outboxVersion: 1 }));
    await waitFor(() => expect(screen.queryByText(/которые она не приняла/)).toBeNull());
    expect(shown("Не отправлено прежним подключением")).toBeNull();
  });

  it("says nothing of serials outside a shift, though the pairing has none", async () => {
    const { executor } = openLocalDb();
    render(bar({ local: executor, shiftId: null }));
    expect(await screen.findByText("Никто не вошёл")).toBeTruthy();
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
    });
    expect(screen.queryByText(/Номера SSCC/)).toBeNull();
    expect(shown("Номеров SSCC")).toBeNull();
  });

  it("says in the polite region when the host or this computer, not the link, fails the outbox's delivery", async () => {
    const { executor } = openLocalDb();
    const view = render(bar({ local: executor, factsFailure: "offline" }));
    expect(await screen.findByText("Никто не вошёл")).toBeTruthy();
    const before = politeRegions();
    expect(screen.queryByText(/Хост не принимает записи смены/)).toBeNull();
    expect(screen.queryByText(/Ответ хоста не удалось записать/)).toBeNull();
    view.rerender(bar({ local: executor, factsFailure: "host" }));
    const host = screen.getByText(
      "Хост не принимает записи смены: на хосте ошибка. Станция повторяет отправку, записи хранятся на этом компьютере.",
    );
    expect(heardOnce(before, host)).toBe(true);
    expect(screen.queryByText(/Ответ хоста не удалось записать/)).toBeNull();
    view.rerender(bar({ local: executor, factsFailure: "local" }));
    const local = screen.getByText(
      "Ответ хоста не удалось записать в базу этого компьютера. Станция повторяет отправку.",
    );
    expect(heardOnce(before, local)).toBe(true);
    expect(screen.queryByText(/Хост не принимает записи смены/)).toBeNull();
    view.rerender(bar({ local: executor, factsFailure: null }));
    expect(screen.queryByText(/Станция повторяет отправку/)).toBeNull();
  });

  it("says in the polite region that a host restored from a copy holds the records", async () => {
    const { executor } = openLocalDb();
    const view = render(bar({ local: executor, factsFailure: null }));
    expect(await screen.findByText("Никто не вошёл")).toBeTruthy();
    const before = politeRegions();
    expect(screen.queryByText(/отправка ждёт администратора/)).toBeNull();
    view.rerender(bar({ local: executor, factsFailure: "held" }));
    const held = screen.getByText(
      "Хост восстановлен из копии — отправка ждёт администратора. Станция работает и хранит записи на этом компьютере.",
    );
    expect(heardOnce(before, held)).toBe(true);
    expect(screen.queryByText(/Хост не принимает записи смены/)).toBeNull();
  });

  it("says while the station owes a restored host its blocks, and then how many the host refused", async () => {
    const { db, executor } = openLocalDb();
    seedBlock(db, { blockId: "6f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", from: 3500, to: 5499 });
    seedBlock(db, { blockId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", from: 5500, to: 7499 });
    await noteRestoreEpoch(executor, PAIRING, "5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e", new Date());
    const view = render(bar({ local: executor }));
    expect(await screen.findByText("Никто не вошёл")).toBeTruthy();
    const before = politeRegions();
    const due = await screen.findByText(
      "Хост восстановлен из копии — станция возвращает ему свои блоки номеров SSCC. Записи смены ждут и хранятся на этом компьютере.",
    );
    expect(heardOnce(before, due)).toBe(true);
    await reconcileRestore({
      local: executor,
      pairing: PAIRING,
      register: async (request) => ({
        results: request.blocks.map((block) => ({
          id: block.id,
          outcome: "refused" as const,
          code: "block_overlap",
        })),
      }),
      now: () => new Date(),
    });
    view.rerender(bar({ local: executor, outboxVersion: 1 }));
    const refused = await screen.findByText(
      "Блоков номеров SSCC, которые хост не принял после восстановления: 2. Станция больше не печатает номера из них — сообщите администратору.",
    );
    expect(heardOnce(before, refused)).toBe(true);
    expect(screen.queryByText(/станция возвращает ему свои блоки/)).toBeNull();
  });

  it("does not call a wait of weeks stuck while the host holds the records or blocks are owed", async () => {
    const { executor } = openLocalDb();
    await unsentScans(executor, 2);
    await noteRestoreEpoch(executor, PAIRING, "5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e", new Date());
    const view = render(bar({ local: executor, factsFailure: "host", now: clock }));
    expect(await screen.findByText(/Хост не принимает записи смены/)).toBeTruthy();
    expect(screen.getByText(/станция возвращает ему свои блоки/)).toBeTruthy();
    await flushEffects();
    expect(screen.queryByText(/Самая старая запись ждёт/)).toBeNull();
    await reconcileRestore({
      local: executor,
      pairing: PAIRING,
      register: async (request) => ({
        results: request.blocks.map((block) => ({ id: block.id, outcome: "known", code: null })),
      }),
      now: () => new Date(),
    });
    view.rerender(bar({ local: executor, factsFailure: "host", now: clock, outboxVersion: 1 }));
    expect(await screen.findByText(/Самая старая запись ждёт/)).toBeTruthy();
    view.rerender(bar({ local: executor, factsFailure: "held", now: clock, outboxVersion: 1 }));
    expect(screen.getByText(/отправка ждёт администратора/)).toBeTruthy();
    expect(screen.queryByText(/Самая старая запись ждёт/)).toBeNull();
    expect(shown("Не отправлено")).toBe("2");
  });

  it("says nothing of a restore for a station that owes nothing, with no block either", async () => {
    const { executor } = openLocalDb();
    await noteRestoreEpoch(executor, PAIRING, "5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e", new Date());
    const view = render(bar({ local: executor }));
    expect(await screen.findByText(/станция возвращает ему свои блоки/)).toBeTruthy();
    // No block: one empty request marks the station on the host (plan ХП), and the obligation is settled at once.
    const asked = vi.fn();
    const result = await reconcileRestore({
      local: executor,
      pairing: PAIRING,
      register: async (request) => {
        asked(request);
        return { results: [] };
      },
      now: () => new Date(),
    });
    expect(result).toMatchObject({ kind: "reconciled", registered: 0, known: 0, refused: 0 });
    expect(asked.mock.calls).toEqual([[{ blocks: [] }]]);
    view.rerender(bar({ local: executor, outboxVersion: 1 }));
    await waitFor(() => expect(screen.queryByText(/станция возвращает ему свои блоки/)).toBeNull());
    expect(screen.queryByText(/Блоков номеров SSCC, которые хост не принял/)).toBeNull();
    expect(screen.queryByText(/Хост не принимает записи смены/)).toBeNull();
  });

  it("keeps the refused blocks in the bar when the host's refusal waits, and hides what is not news", async () => {
    const { db, executor } = openLocalDb();
    seedBlock(db, { blockId: "6f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", from: 3500, to: 5499 });
    await noteRestoreEpoch(executor, PAIRING, "5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e", new Date());
    const view = render(bar({ local: executor, refusalHeld: true }));
    expect(await screen.findByText(/Хост отказал этой станции/)).toBeTruthy();
    await flushEffects();
    expect(screen.queryByText(/станция возвращает ему свои блоки/)).toBeNull();
    await reconcileRestore({
      local: executor,
      pairing: PAIRING,
      register: async (request) => ({
        results: request.blocks.map((block) => ({
          id: block.id,
          outcome: "refused" as const,
          code: "block_mismatch",
        })),
      }),
      now: () => new Date(),
    });
    view.rerender(
      bar({ local: executor, refusalHeld: true, factsFailure: "held", outboxVersion: 1 }),
    );
    expect(
      await screen.findByText(
        /Блоков номеров SSCC, которые хост не принял после восстановления: 1/,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/отправка ждёт администратора/)).toBeNull();
  });

  it("does not say the host fails the delivery, or that the link is up, while the host's refusal waits", async () => {
    const { executor } = openLocalDb();
    await unsentScans(executor, 2);
    const online: HostStatus = { state: "online", lastContactAt: null, lastError: null, seq: 1 };
    const view = render(bar({ local: executor, link: online, factsFailure: "host", now: clock }));
    expect(await screen.findByText(/Хост не принимает записи смены/)).toBeTruthy();
    expect(await screen.findByText(/Самая старая запись ждёт/)).toBeTruthy();
    expect(screen.getByText("На связи с хостом")).toBeTruthy();
    view.rerender(
      bar({
        local: executor,
        link: online,
        factsFailure: "host",
        refusalHeld: true,
        now: clock,
      }),
    );
    expect(screen.getByText(/Хост отказал этой станции/)).toBeTruthy();
    expect(screen.queryByText(/Хост не принимает записи смены/)).toBeNull();
    expect(screen.queryByText(/Самая старая запись ждёт/)).toBeNull();
    expect(screen.queryByText("На связи с хостом")).toBeNull();
    view.rerender(
      bar({
        local: executor,
        link: online,
        factsFailure: "local",
        refusalHeld: true,
        now: clock,
      }),
    );
    expect(screen.queryByText(/Ответ хоста не удалось записать/)).toBeNull();
  });
  /** A moment of 2026-10-08 on this computer's clock: the bar's waits are differences, never clock times. */
  const at = (hour: number, minute: number, second = 0): Date =>
    new Date(2026, 9, 8, hour, minute, second);

  /** Three records: one delivered, then the head the sender retries first, then one behind it. */
  async function waitingRecords() {
    const { db, executor } = openLocalDb();
    const [done, head, behind] = await unsentScans(executor, 3);
    const set = db.prepare(
      "UPDATE outbox SET created_at = ?, attempts = ?, sent_at = ? WHERE id = ?",
    );
    set.run(at(6, 0).toISOString(), 1, at(6, 1).toISOString(), done ?? "");
    db.prepare(
      "UPDATE outbox SET outcome = 'accepted', acked_at = '2026-10-08T06:01:00.000Z' WHERE id = ?",
    ).run(done ?? "");
    // The head is not the newest by time, nor the most sent.
    set.run(at(9, 41).toISOString(), 5, at(9, 50, 30).toISOString(), head ?? "");
    set.run(at(9, 30).toISOString(), 9, at(9, 52, 55).toISOString(), behind ?? "");
    return { db, executor, head: head ?? "" };
  }

  it("says how long the oldest undelivered record has waited and how often it was sent, while a send fails", async () => {
    const { db, executor, head } = await waitingRecords();
    const now = () => at(9, 53);
    const view = render(bar({ local: executor, factsFailure: "host", now }));
    const waiting = await screen.findByText(
      "Самая старая запись ждёт отправки уже 12 мин, попыток отправки: 5, последняя — 2 мин назад.",
    );
    // Said by the polite region that was there before, and not as an alert of its own as well.
    expect(heardOnce(politeRegions(), waiting)).toBe(true);

    // Never sent yet: nothing to say of a last attempt.
    db.prepare("UPDATE outbox SET attempts = 0, sent_at = NULL WHERE id = ?").run(head);
    view.rerender(bar({ local: executor, factsFailure: "host", now, outboxVersion: 1 }));
    expect(
      await screen.findByText("Самая старая запись ждёт отправки уже 12 мин, попыток отправки: 0."),
    ).toBeTruthy();

    // Hours, and a count with a thousands separator.
    db.prepare("UPDATE outbox SET created_at = ?, attempts = 1234, sent_at = ? WHERE id = ?").run(
      at(7, 48).toISOString(),
      at(9, 52, 59).toISOString(),
      head,
    );
    view.rerender(bar({ local: executor, factsFailure: "host", now, outboxVersion: 2 }));
    expect(
      await screen.findByText(
        "Самая старая запись ждёт отправки уже 2 ч 5 мин, попыток отправки: 1 234, последняя — меньше минуты назад.",
      ),
    ).toBeTruthy();

    // A clock set back reads as no wait at all, never a negative one.
    view.rerender(
      bar({ local: executor, factsFailure: "host", now: () => at(6, 0), outboxVersion: 3 }),
    );
    expect(
      await screen.findByText(
        "Самая старая запись ждёт отправки уже меньше минуты, попыток отправки: 1 234, последняя — меньше минуты назад.",
      ),
    ).toBeTruthy();
  });

  it("says it for a failure of the link, of the host and of this computer, and not when nothing fails or nothing waits", async () => {
    const { db, executor } = await waitingRecords();
    const now = () => at(9, 53);
    const stuck = /Самая старая запись ждёт отправки уже 12 мин/;
    const view = render(bar({ local: executor, factsFailure: "offline", now }));
    expect(await screen.findByText(stuck)).toBeTruthy();
    view.rerender(bar({ local: executor, factsFailure: "local", now }));
    expect(await screen.findByText(stuck)).toBeTruthy();
    view.rerender(bar({ local: executor, factsFailure: null, now }));
    await waitFor(() => expect(screen.queryByText(stuck)).toBeNull());
    // The failure comes back: the line is read again, not the one shown before.
    db.prepare("UPDATE outbox SET created_at = ? WHERE acked_at IS NULL AND attempts = 5").run(
      at(9, 33).toISOString(),
    );
    view.rerender(bar({ local: executor, factsFailure: "host", now }));
    expect(await screen.findByText(/ждёт отправки уже 20 мин/)).toBeTruthy();
    // Nothing waits any more: a failure that nothing explains is not dressed up as a wait.
    db.prepare(
      "UPDATE outbox SET outcome = 'accepted', acked_at = '2026-10-08T06:20:00.000Z' WHERE acked_at IS NULL",
    ).run();
    view.rerender(bar({ local: executor, factsFailure: "host", now, outboxVersion: 1 }));
    await waitFor(() => expect(screen.queryByText(/Самая старая запись/)).toBeNull());
    expect(screen.getByText(/Хост не принимает записи смены/)).toBeTruthy();
  });

  it("keeps the stuck line out of the bar when the outbox's head cannot be read, and says the rest", async () => {
    const { executor } = await waitingRecords();
    const failing: LocalExecutor = {
      query: (sql, params, row) =>
        isHeadRecord(sql) ? Promise.reject(new Error("disk")) : executor.query(sql, params, row),
      transaction: (statements) => executor.transaction(statements),
    };
    render(bar({ local: failing, factsFailure: "host", now: () => at(9, 53) }));
    expect(await screen.findByText(/Хост не принимает записи смены/)).toBeTruthy();
    await waitFor(() => expect(shown("Не отправлено")).toBe("2"));
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
    });
    expect(screen.queryByText(/Самая старая запись/)).toBeNull();
  });

  it("forgets the wait it showed when the next read of the oldest record fails", async () => {
    const { executor } = await waitingRecords();
    let broken = false;
    const local: LocalExecutor = {
      query: (sql, params, row) =>
        broken && isHeadRecord(sql)
          ? Promise.reject(new Error("disk"))
          : executor.query(sql, params, row),
      transaction: (statements) => executor.transaction(statements),
    };
    const now = () => at(9, 53);
    const view = render(bar({ local, factsFailure: "host", now }));
    expect(await screen.findByText(/Самая старая запись ждёт/)).toBeTruthy();
    broken = true;
    view.rerender(bar({ local, factsFailure: "host", now, outboxVersion: 1 }));
    await waitFor(() => expect(screen.queryByText(/Самая старая запись/)).toBeNull());
    expect(screen.getByText(/Хост не принимает записи смены/)).toBeTruthy();
  });

  it("reads the oldest record again by itself every ten seconds while a send fails, and stops with the failure", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"], shouldAdvanceTime: true });
    const { db, executor, head } = await waitingRecords();
    const now = () => at(9, 53);
    const view = render(bar({ local: executor, factsFailure: "host", now }));
    expect(await screen.findByText(/попыток отправки: 5,/)).toBeTruthy();
    await flushEffects();
    expect(vi.getTimerCount()).toBe(1);

    db.prepare("UPDATE outbox SET attempts = 6 WHERE id = ?").run(head);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    expect(screen.getByText(/попыток отправки: 5,/)).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(await screen.findByText(/попыток отправки: 6,/)).toBeTruthy();

    // The failure goes: nothing is read on a timer for it any more.
    view.rerender(bar({ local: executor, factsFailure: null, now }));
    await waitFor(() => expect(screen.queryByText(/Самая старая запись/)).toBeNull());
    await flushEffects();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts no timer while nothing is wrong, and none outlives the bar", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"], shouldAdvanceTime: true });
    const { db, executor } = openLocalDb();
    await keepEnteredShift(executor, PAIRING, ENTERED, "2026-10-08T06:02:00.000Z", 1);
    seedBlock(db, { blockId: "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a", from: 1, to: 2000 });
    const quiet = render(bar({ local: executor, shiftId: ENTERED.id }));
    await waitFor(() => expect(shown("Номеров SSCC")).toBe("2\u00a0000"));
    await flushEffects();
    expect(vi.getTimerCount()).toBe(0);
    quiet.unmount();

    const failing = render(bar({ local: executor, factsFailure: "local" }));
    expect(await screen.findByText(/Ответ хоста не удалось записать/)).toBeTruthy();
    await flushEffects();
    expect(vi.getTimerCount()).toBe(1);
    failing.unmount();
    expect(vi.getTimerCount()).toBe(0);

    // And the same for a station running out of serials.
    db.prepare("UPDATE floor_sscc_blocks SET next_serial = 1951").run();
    const low = render(bar({ local: executor, shiftId: ENTERED.id }));
    await waitFor(() => expect(shown("Номеров SSCC")).toBe("50"));
    await flushEffects();
    expect(vi.getTimerCount()).toBe(1);
    // A block arrives with no record written: the bar finds out on its own.
    seedBlock(db, { blockId: "6e5d4c3b-2a1f-4e0d-9c8b-7a6f5e4d3c2b", from: 2001, to: 4000 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    expect(shown("Номеров SSCC")).toBe("50");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    await waitFor(() => expect(shown("Номеров SSCC")).toBe("2\u00a0050"));
    expect(screen.queryByText(/Номеров SSCC для коробов осталось/)).toBeNull();
    await flushEffects();
    expect(vi.getTimerCount()).toBe(0);
    low.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps reading the serials by itself exactly while the warning stands", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"], shouldAdvanceTime: true });
    const { db, executor } = openLocalDb();
    await keepEnteredShift(executor, PAIRING, ENTERED, "2026-10-08T06:02:00.000Z", 1);
    seedBlock(db, { blockId: "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a", from: 1, to: 2000 });
    // 501 left, over a quarter of the block: no warning, no timer.
    db.prepare("UPDATE floor_sscc_blocks SET next_serial = 1500").run();
    const view = render(bar({ local: executor, shiftId: ENTERED.id }));
    await waitFor(() => expect(shown("Номеров SSCC")).toBe("501"));
    await flushEffects();
    expect(vi.getTimerCount()).toBe(0);
    // 500 left: the warning stands, and so does the timer.
    db.prepare("UPDATE floor_sscc_blocks SET next_serial = 1501").run();
    view.rerender(bar({ local: executor, shiftId: ENTERED.id, outboxVersion: 1 }));
    await waitFor(() => expect(shown("Номеров SSCC")).toBe("500"));
    expect(await screen.findByText(/Номеров SSCC для коробов осталось 500 —/)).toBeTruthy();
    // (Not inside `waitFor`: its own polling is a timer too.)
    await flushEffects();
    expect(vi.getTimerCount()).toBe(1);
  });

  it("keeps reading by itself while only the pallets' serials are low, and stops when they are not", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"], shouldAdvanceTime: true });
    const { db, executor } = openLocalDb();
    await keepEnteredShift(executor, PAIRING, ENTERED, "2026-10-08T06:02:00.000Z", 1);
    db.prepare("UPDATE floor_shifts SET pallets_enabled = 1 WHERE id = ?").run(ENTERED.id);
    seedBlock(db, { blockId: "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a", from: 1, to: 2000 });
    seedBlock(db, {
      blockId: "6e5d4c3b-2a1f-4e0d-9c8b-7a6f5e4d3c2b",
      from: 1,
      to: 200,
      next: 181,
      extension: 1,
    });
    const view = render(bar({ local: executor, shiftId: ENTERED.id }));
    await waitFor(() => expect(shown("Номеров SSCC паллет")).toBe("20"));
    await flushEffects();
    expect(vi.getTimerCount()).toBe(1);
    // A block of pallets' serials arrives with no record written: the next tick finds out.
    seedBlock(db, {
      blockId: "7f6e5d4c-3b2a-4f1e-8d9c-8b7a6f5e4d3d",
      from: 201,
      to: 400,
      extension: 1,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_500);
    });
    await waitFor(() => expect(shown("Номеров SSCC паллет")).toBe("220"));
    await flushEffects();
    expect(vi.getTimerCount()).toBe(0);
    view.unmount();
  });

  const isRestoreStatus = (sql: string): boolean => sql.includes("floor_restore_epochs");

  it("keeps what the newest read says of a restore when an older one lands late", async () => {
    const { executor } = openLocalDb();
    await noteRestoreEpoch(executor, PAIRING, "5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e", new Date());
    const held = holdingFirstRead(executor, isRestoreStatus);
    const view = render(bar({ local: held.executor }));
    await waitFor(() => expect(held.started()).toBe(true));
    await reconcileRestore({
      local: executor,
      pairing: PAIRING,
      register: async () => ({ results: [] }),
      now: () => new Date(),
    });
    view.rerender(bar({ local: held.executor, outboxVersion: 1 }));
    await flushEffects();
    expect(screen.queryByText(/станция возвращает ему свои блоки/)).toBeNull();
    // The older read, which saw the obligation, lands now.
    await act(async () => {
      held.release();
      await new Promise((resolve) => setImmediate(resolve));
    });
    expect(screen.queryByText(/станция возвращает ему свои блоки/)).toBeNull();
  });

  it("drops what it said of a restore when the next read of it fails", async () => {
    const { executor } = openLocalDb();
    await noteRestoreEpoch(executor, PAIRING, "5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e", new Date());
    let failing = false;
    const flaky: LocalExecutor = {
      query: (sql, params, row) =>
        failing && isRestoreStatus(sql)
          ? Promise.reject(new Error("unreadable"))
          : executor.query(sql, params, row),
      transaction: (statements) => executor.transaction(statements),
    };
    const view = render(bar({ local: flaky }));
    expect(await screen.findByText(/станция возвращает ему свои блоки/)).toBeTruthy();
    failing = true;
    view.rerender(bar({ local: flaky, outboxVersion: 1 }));
    await waitFor(() => expect(screen.queryByText(/станция возвращает ему свои блоки/)).toBeNull());
  });

  it("keeps the counts of the newest read when an older one lands late", async () => {
    const { db, executor } = openLocalDb();
    await unsentScans(executor, 3);
    const held = holdingFirstRead(executor, isUnsentCount);
    const view = render(bar({ local: held.executor }));
    await waitFor(() => expect(held.started()).toBe(true));
    await unsentScans(executor, 1, PAIRING, 50);
    view.rerender(bar({ local: held.executor, outboxVersion: 1 }));
    await waitFor(() => expect(shown("Не отправлено")).toBe("4"));
    await act(async () => {
      held.release();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(shown("Не отправлено")).toBe("4");
    expect(db.prepare("SELECT count(*) AS n FROM outbox").get()).toEqual({ n: 4 });
  });

  it("keeps the serials of the newest read when an older one lands late", async () => {
    const { db, executor } = openLocalDb();
    await keepEnteredShift(executor, PAIRING, ENTERED, "2026-10-08T06:02:00.000Z", 1);
    seedBlock(db, { blockId: "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a", from: 1, to: 2000 });
    const held = holdingFirstRead(executor, isSerialsRead);
    const view = render(bar({ local: held.executor, shiftId: ENTERED.id }));
    await waitFor(() => expect(held.started()).toBe(true));
    db.prepare("UPDATE floor_sscc_blocks SET next_serial = 501").run();
    view.rerender(bar({ local: held.executor, shiftId: ENTERED.id, outboxVersion: 1 }));
    await waitFor(() => expect(shown("Номеров SSCC")).toBe("1\u00a0500"));
    await act(async () => {
      held.release();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(shown("Номеров SSCC")).toBe("1\u00a0500");
  });

  it("keeps the wait of the newest read when an older one lands late", async () => {
    const { db, executor, head } = await waitingRecords();
    const now = () => at(9, 53);
    const held = holdingFirstRead(executor, isHeadRecord);
    const view = render(bar({ local: held.executor, factsFailure: "host", now }));
    await waitFor(() => expect(held.started()).toBe(true));
    db.prepare("UPDATE outbox SET attempts = 7 WHERE id = ?").run(head);
    view.rerender(bar({ local: held.executor, factsFailure: "host", now, outboxVersion: 1 }));
    expect(await screen.findByText(/попыток отправки: 7,/)).toBeTruthy();
    await act(async () => {
      held.release();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByText(/попыток отправки: 7,/)).toBeTruthy();
  });

  it("does not show a wait read for a failure that has ended when it lands", async () => {
    const { executor } = await waitingRecords();
    const now = () => at(9, 53);
    const held = holdingFirstRead(executor, isHeadRecord);
    const view = render(bar({ local: held.executor, factsFailure: "host", now }));
    await waitFor(() => expect(held.started()).toBe(true));
    view.rerender(bar({ local: held.executor, factsFailure: null, now }));
    await act(async () => {
      held.release();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByText(/Самая старая запись/)).toBeNull();
  });
});

describe("the scanner on the floor's status bar", () => {
  /** The value the bar shows under `label`, or `null` when it shows no such item. */
  function shown(label: string): string | null {
    const term = screen.queryByText(label);
    return term === null ? null : (term.nextElementSibling?.textContent ?? null);
  }

  function watching(...statuses: Array<"connected" | "disconnected">) {
    return (
      onSnapshot: (next: {
        revision: number;
        scanners: Array<{ port: string; baud: number; status: "connected" | "disconnected" }>;
      }) => void,
    ) => {
      onSnapshot({
        revision: 1,
        scanners: statuses.map((status, index) => ({
          port: `COM${index + 3}`,
          baud: 9600,
          status,
        })),
      });
      return Promise.resolve(() => undefined);
    };
  }

  it("says «Клавиатурный» with only the keyboard wedge", async () => {
    render(bar({ local: await synced([ORG]) }));
    expect(await screen.findByText("ООО «Атолл»")).toBeTruthy();
    expect(shown("Сканер")).toBe("Клавиатурный");
  });

  it("follows the COM scanners the shell reports", async () => {
    const local = await synced([ORG]);
    const view = render(bar({ local, watchScanners: watching("connected") }));
    await waitFor(() => expect(shown("Сканер")).toBe("Подключён"));
    view.rerender(bar({ local, watchScanners: watching("connected", "disconnected") }));
    await waitFor(() => expect(shown("Сканер")).toBe("Часть сканеров недоступна"));
    view.rerender(bar({ local, watchScanners: watching("disconnected") }));
    await waitFor(() => expect(shown("Сканер")).toBe("Нет связи"));
  });
});
