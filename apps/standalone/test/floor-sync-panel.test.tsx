import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import type { SyncState } from "../src/app/shell.js";
import { FloorStatusBar, type FloorBarTools } from "../src/floor/FloorStatusBar.js";
import { createKeyboardWedgeSource } from "../src/floor/scan-source.js";
import { SyncPanel } from "../src/floor/SyncPanel.js";
import type { ChangeItem, HostStatus } from "../src/host/protocol.js";
import { syncReferences } from "../src/local/reference-sync.js";
import { DEVICE_ID, HOST_ID, LINE_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";

afterEach(cleanup);

const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };
const SHIFT = "bbbbbbbb-0000-4000-8000-000000000001";
const SYNCED: SyncState = { kind: "done", synced: 1, failure: null, quarantined: 0 };
const ONLINE: HostStatus = {
  state: "online",
  lastContactAt: Date.parse("2026-10-14T10:20:00Z"),
  lastError: null,
  seq: 1,
};
const OFFLINE: HostStatus = {
  state: "offline",
  lastContactAt: Date.parse("2026-10-14T09:00:00Z"),
  lastError: "unreachable",
  seq: 2,
};
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

async function station() {
  const { db, executor } = openLocalDb();
  await syncReferences({
    changes: async () => ({ hostId: HOST_ID, rev: 10, hasMore: false, items: [ORG] }),
    local: executor,
    ...PAIRING,
  });
  return { db, executor };
}

/** An outbox record: `outcome` null for one still waiting. */
function record(
  db: DatabaseSync,
  id: string,
  kind: string,
  outcome: "rejected" | "conflict" | null,
  code: string | null,
  at: string,
  attempts = 0,
) {
  db.prepare(
    "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at, attempts, " +
      "sent_at, outcome, outcome_code, acked_at) VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    HOST_ID,
    DEVICE_ID,
    kind,
    SHIFT,
    at,
    attempts,
    attempts > 0 ? at : null,
    outcome,
    code,
    outcome === null ? null : at,
  );
}

function clipboard() {
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

function panel(local: Awaited<ReturnType<typeof station>>["executor"], patch = {}) {
  const onRetry = vi.fn();
  const view = render(
    <ThemeProvider>
      <SyncPanel
        open
        onClose={() => undefined}
        local={local}
        pairing={PAIRING}
        link={ONLINE}
        sync={SYNCED}
        factsFailure={null}
        refusalHeld={false}
        outboxVersion={0}
        lastSyncedAt={new Date("2026-10-14T10:21:00Z")}
        onRetry={onRetry}
        now={() => new Date("2026-10-14T10:30:00Z")}
        {...patch}
      />
    </ThemeProvider>,
  );
  return { ...view, onRetry };
}

describe("the «Синхронизация» panel", () => {
  it("says that all is well on a connected station with nothing waiting", async () => {
    const { executor } = await station();
    panel(executor);
    expect(await screen.findByText(/Всё в порядке/)).toBeTruthy();
    expect(screen.getByText("На связи с хостом", { selector: "p, span" })).toBeTruthy();
    expect(screen.getByText(/Последнее обновление: 14\.10/, { selector: "p, span" })).toBeTruthy();
    expect(screen.getByText("Не отправлено записей: 0", { selector: "p, span" })).toBeTruthy();
  });

  it("says how many SSCC serials are left for the boxes and, with pallets, the pallets, and warns below the threshold only", async () => {
    const { executor } = await station();
    const view = panel(executor, {
      stock: { boxes: { left: 1998, level: "ok" }, pallets: { left: 197, level: "ok" } },
    });
    const section = (await screen.findByText("Запас номеров SSCC")).closest("section");
    expect(section).not.toBeNull();
    expect(within(section as HTMLElement).getByText("Для коробов осталось: 1 998")).toBeTruthy();
    expect(within(section as HTMLElement).getByText("Для паллет осталось: 197")).toBeTruthy();
    // Plenty left: the counts, no warning words.
    expect(
      screen.queryByText(/четверть блока|десятая часть|последний номер|закончились/),
    ).toBeNull();
    view.unmount();

    // Low: the same row carries the words (the header's chip says it short).
    panel(executor, { stock: { boxes: { left: 200, level: "tenth" }, pallets: null } });
    const low = (await screen.findByText("Запас номеров SSCC")).closest("section") as HTMLElement;
    expect(within(low).getByText("Для коробов осталось: 200")).toBeTruthy();
    expect(within(low).queryByText(/Для паллет осталось/)).toBeNull();
    expect(within(low).getByText(/десятая часть блока или меньше/)).toBeTruthy();
  });

  it("has no serials row outside a shift", async () => {
    const { executor } = await station();
    panel(executor);
    await screen.findByText(/Всё в порядке/);
    expect(screen.queryByText("Запас номеров SSCC")).toBeNull();
  });

  it("says that the references have not been updated since the app started", async () => {
    const { executor } = await station();
    panel(executor, { lastSyncedAt: null });
    expect(await screen.findByText(/ещё не обновлялись/, { selector: "p, span" })).toBeTruthy();
  });

  it("shows the waiting records, the refused ones with the host's reason in words, and the conflicts", async () => {
    const { db, executor } = await station();
    record(db, "u1", "box_closed", null, null, "2026-10-14T10:00:00.000Z", 2);
    record(db, "r1", "box_closed", "rejected", "box_unknown", "2026-10-14T06:10:00.000Z", 1);
    record(db, "r2", "scan", "rejected", "gtin_mismatch", "2026-10-14T06:12:00.000Z", 1);
    record(db, "c1", "scan", "conflict", null, "2026-10-14T06:20:00.000Z", 1);
    panel(executor, { factsFailure: "host" });
    expect(
      await screen.findByText("Не отправлено записей: 1", { selector: "p, span" }),
    ).toBeTruthy();
    expect(screen.getByText("Хост отклонил записей: 2", { selector: "p, span" })).toBeTruthy();
    expect(
      screen.getByText("Записей в конфликте с другой станцией: 1", { selector: "p, span" }),
    ).toBeTruthy();
    expect(screen.getByText("Хост не знает этот короб", { selector: "p, span" })).toBeTruthy();
    expect(
      screen.getByText("Код другого товара, не товара смены", { selector: "p, span" }),
    ).toBeTruthy();
    expect(
      screen.getByText("Код уже принят хостом в другом месте: проверьте короб.", {
        selector: "p, span",
      }),
    ).toBeTruthy();
    expect(
      screen.getByText(/Хост не принимает записи смены/, { selector: "p, span" }),
    ).toBeTruthy();
    expect(screen.queryByText(/Всё в порядке/)).toBeNull();
  });

  it("says why the host is out of reach and since when", async () => {
    const { executor } = await station();
    panel(executor, { link: OFFLINE, factsFailure: "offline" });
    expect(
      await screen.findByText(/Нет связи с хостом с 14\.10/, { selector: "p, span" }),
    ).toBeTruthy();
    expect(
      screen.getByText(/Хост не отвечает\. Станция повторяет отправку/, { selector: "p, span" }),
    ).toBeTruthy();
  });

  it("names a failed reference sync and the records the copies did not accept", async () => {
    const { executor } = await station();
    panel(executor, { sync: { kind: "failed", synced: 0, failure: "host", quarantined: 2 } });
    expect(
      await screen.findByText("Запрос к хосту не удался.", { selector: "p, span" }),
    ).toBeTruthy();
    expect(
      screen.getByText(/Не приняты записи справочников: 2/, { selector: "p, span" }),
    ).toBeTruthy();
  });

  it("only asks the existing retries to run: «Повторить сейчас» calls the one callback", async () => {
    const { executor } = await station();
    const { onRetry } = panel(executor);
    fireEvent.click(await screen.findByRole("button", { name: "Повторить сейчас" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Запрос отправлен/)).toBeTruthy();
  });

  it("copies the details as plain text, with the same lines and no secret", async () => {
    const writeText = clipboard();
    const { db, executor } = await station();
    record(db, "r1", "box_closed", "rejected", "box_unknown", "2026-10-14T06:10:00.000Z", 1);
    panel(executor);
    await screen.findByText("Хост отклонил записей: 1", { selector: "p, span" });
    fireEvent.click(screen.getByRole("button", { name: "Скопировать подробности" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const text = (writeText.mock.calls[0] as unknown as [string])[0];
    expect(text).toContain("Хост отклонил записей: 1");
    expect(text).toContain("Хост не знает этот короб");
    expect(text).toContain("Связь с хостом: На связи с хостом");
    expect(text).not.toMatch(/pbkdf2|PIN/);
    expect(text).not.toContain("\u001d");
    expect(await screen.findByText("Подробности скопированы.")).toBeTruthy();
  });

  it("says when the text could not be copied and leaves it selectable", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async () => {
          throw new Error("denied");
        },
      },
      configurable: true,
    });
    const { executor } = await station();
    panel(executor);
    await screen.findByText(/Всё в порядке/);
    fireEvent.click(screen.getByRole("button", { name: "Скопировать подробности" }));
    expect(await screen.findByText(/Не удалось скопировать/)).toBeTruthy();
  });

  it("says that the queue could not be read, and still offers the retry", async () => {
    const { executor } = await station();
    const broken = { ...executor, query: () => Promise.reject(new Error("db")) };
    panel(broken);
    expect(
      await screen.findByText("Не удалось прочитать очередь в базе этого компьютера."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Повторить сейчас" })).toBeTruthy();
  });
});

describe("the status bar's «Синхронизация» button", () => {
  async function renderBar(patch: Partial<React.ComponentProps<typeof FloorStatusBar>> = {}) {
    const { db, executor } = await station();
    const tools: FloorBarTools = {
      retry: vi.fn(),
      lastSyncedAt: null,
      windowMode: null,
      source: createKeyboardWedgeSource(window),
      onMute: vi.fn(),
    };
    const view = render(
      <ThemeProvider>
        <FloorStatusBar
          local={executor}
          pairing={PAIRING}
          lineId={LINE_ID}
          operator={null}
          link={ONLINE}
          sync={SYNCED}
          deviceName={null}
          shiftId={null}
          deviceNotSaved={false}
          refusalHeld={false}
          outboxVersion={0}
          factsFailure={null}
          tools={tools}
          {...patch}
        />
      </ThemeProvider>,
    );
    return { ...view, db, tools };
  }

  it("is a 64 px-high rail button that opens the panel", async () => {
    await renderBar();
    const button = screen.getByRole("button", { name: "Синхронизация" });
    expect(button.getAttribute("data-problem")).toBe("false");
    fireEvent.click(button);
    expect(await screen.findByRole("region", { name: "Синхронизация" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(screen.queryByRole("region", { name: "Синхронизация" })).toBeNull();
  });

  it("marks a failed delivery in the button's name, not by colour alone", async () => {
    await renderBar({ factsFailure: "host" });
    const button = screen.getByRole("button", { name: "Синхронизация: есть проблемы" });
    expect(button.getAttribute("data-problem")).toBe("true");
  });

  it("is not there without tools: the rail then holds «Сменить оператора» alone", async () => {
    const { executor } = await station();
    render(
      <ThemeProvider>
        <FloorStatusBar
          local={executor}
          pairing={PAIRING}
          lineId={LINE_ID}
          operator={{ id: "op", login: "0042", name: "Анна", role: null }}
          link={ONLINE}
          sync={SYNCED}
          deviceName={null}
          shiftId={null}
          deviceNotSaved={false}
          refusalHeld={false}
          outboxVersion={0}
          factsFailure={null}
          onSwitchOperator={() => undefined}
        />
      </ThemeProvider>,
    );
    const rail = screen.getByRole("group", { name: "Действия станции" });
    expect(
      within(rail)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Сменить оператора"]);
  });
});
