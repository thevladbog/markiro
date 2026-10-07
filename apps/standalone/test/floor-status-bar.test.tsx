import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import type { SyncState } from "../src/app/shell.js";
import { readFloorPlace } from "../src/floor/floor-status.js";
import { FloorStatusBar, type FloorStatusBarProps } from "../src/floor/FloorStatusBar.js";
import type { ChangeItem, HostStatus } from "../src/host/protocol.js";
import type { LocalExecutor } from "../src/local/executor.js";
import { syncReferences } from "../src/local/reference-sync.js";
import { DEVICE_ID, HOST_ID, LINE_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";

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
});
