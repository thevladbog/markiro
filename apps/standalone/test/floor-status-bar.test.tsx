import { readFileSync } from "node:fs";

import { act, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import type { SyncState } from "../src/app/shell.js";
import { readFloorPlace } from "../src/floor/floor-status.js";
import { FloorStatusBar, type FloorStatusBarProps } from "../src/floor/FloorStatusBar.js";
import { keepEnteredShift } from "../src/floor/shifts/shift-copies.js";
import { enteredShiftSchema, type ChangeItem, type HostStatus } from "../src/host/protocol.js";
import type { LocalExecutor } from "../src/local/executor.js";
import { syncReferences } from "../src/local/reference-sync.js";
import { DEVICE_ID, HOST_ID, LINE_ID } from "./support/fixtures.js";
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
const OTHER_LINE_ID = "00000000-6a3e-4b9f-9d3c-2b1a0e8f7d61";
const SYNCED: SyncState = { kind: "done", synced: 1, failure: null, quarantined: 0 };
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
    // The read of the shift's copy is watched, so that the assertion waits for its
    // answer (and what the bar makes of it), not for a time that may be too short.
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
    await waitFor(() => expect(reads).toHaveLength(1));
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
});
