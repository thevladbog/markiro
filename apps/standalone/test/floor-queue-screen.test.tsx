import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import type { FloorSession } from "../src/app/shell.js";
import { QueueScreen } from "../src/floor/queue/QueueScreen.js";
import { keepEnteredShift } from "../src/floor/shifts/shift-copies.js";
import { FACT_RECEIPT_CODES, type HostStatus } from "../src/host/protocol.js";
import type { LocalExecutor } from "../src/local/executor.js";
import ru from "../src/i18n/ru.json";
import {
  ENTERED,
  failingWrites,
  holdingWrites,
  OPERATOR_ID,
  PAIRING,
  rows,
  SHIFT_ID,
  unsentScans,
} from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";

const OPERATOR: FloorSession = {
  id: OPERATOR_ID,
  login: "0042",
  name: "Анна Кузнецова",
  role: null,
  sessionId: 1,
};
const OTHER_PAIRING = { ...PAIRING, deviceId: "9b2d4f61-3a5c-4e7d-8f90-1a2b3c4d5e6f" };
// The scans of `unsentScans` are kept at 06:15 UTC; two hours and five minutes later.
const NOW = new Date("2026-10-08T08:20:00.000Z");
const OFFLINE: HostStatus = { state: "offline", lastContactAt: null, lastError: null, seq: 1 };

async function station() {
  const { db, executor } = openLocalDb();
  await keepEnteredShift(executor, PAIRING, ENTERED, "2026-10-08T06:02:00.000Z", 1);
  return { db, local: executor };
}

function refuse(
  db: ReturnType<typeof openLocalDb>["db"],
  id: string,
  outcome: string,
  code: string | null,
) {
  db.prepare("UPDATE outbox SET outcome = ?, outcome_code = ?, acked_at = ? WHERE id = ?").run(
    outcome,
    code,
    "2026-10-08T06:30:00.000Z",
    id,
  );
}

/** A clock that moves a second at every reading: the guard against a second tap is always over. */
function movingClock() {
  let n = 0;
  return () => {
    n += 1_000;
    return n;
  };
}

interface Options {
  link?: HostStatus | null;
  outboxVersion?: number;
  clock?: () => number;
}

function screenOf(local: LocalExecutor, onChanged: () => void, onBack: () => void, o: Options) {
  let n = 0;
  return (
    <ThemeProvider>
      <QueueScreen
        local={local}
        pairing={PAIRING}
        operator={OPERATOR}
        link={o.link === undefined ? null : o.link}
        outboxVersion={o.outboxVersion ?? 0}
        onChanged={onChanged}
        onBack={onBack}
        newId={() => {
          n += 1;
          return `00000000-0000-4000-8000-f${String(n).padStart(11, "0")}`;
        }}
        now={() => NOW}
        clock={o.clock ?? movingClock()}
      />
    </ThemeProvider>
  );
}

function view(local: LocalExecutor, options: Options = {}) {
  const onChanged = vi.fn();
  const onBack = vi.fn();
  const mounted = render(screenOf(local, onChanged, onBack, options));
  return {
    onChanged,
    onBack,
    ...mounted,
    /** The same screen with other options (`outboxVersion`): the same component, so its state stays. */
    again: (next: Options) => mounted.rerender(screenOf(local, onChanged, onBack, next)),
  };
}

/** The confirmation that asks; it takes the focus when it opens. */
async function confirmation() {
  return screen.findByRole("group", { name: "Подтверждение" });
}

/** An executor whose answers to the reads come late: the query runs now, its answer waits. */
function lateReads(local: LocalExecutor) {
  let gate: Promise<void> | null = null;
  let open: () => void = () => undefined;
  const executor: LocalExecutor = {
    query: async (sql, params, row) => {
      const held = gate;
      const result = await local.query(sql, params, row);
      if (held !== null) await held;
      return result;
    },
    transaction: (statements) => local.transaction(statements),
  };
  return {
    executor,
    /** The answers of the reads that start now wait for `release()`. */
    hold: () => {
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
    },
    /** Reads that start from now on answer at once. */
    stopHolding: () => {
      gate = null;
    },
    release: () => open(),
  };
}

describe("the queue screen", () => {
  it("says what waits by kind and for how long, the refused records by shift with their reason in words, and the conflicts", async () => {
    const { db, local } = await station();
    const [refused = "", conflict = ""] = await unsentScans(local, 3);
    refuse(db, refused, "rejected", "gtin_mismatch");
    refuse(db, conflict, "conflict", null);
    view(local);
    expect(await screen.findByText("Ждут отправки на хост")).toBeTruthy();
    expect(screen.getByText("1, самая старая ждёт 2 ч 5 мин")).toBeTruthy();
    expect(screen.getByText(`Смена ${ENTERED.number}`)).toBeTruthy();
    expect(screen.getByText("Код другого товара, не товара смены")).toBeTruthy();
    expect(screen.getByText("Код уже принят хостом в другом месте: проверьте короб.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Отправить снова" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Разобрано" })).toBeTruthy();
  });

  it("says in words that nothing waits, nothing is refused and nothing conflicts", async () => {
    const { local } = await station();
    view(local);
    expect(await screen.findByText("Все записи отправлены.")).toBeTruthy();
    expect(screen.getByText("Отклонённых записей нет.")).toBeTruthy();
    expect(screen.getByText("Конфликтов нет.")).toBeTruthy();
    expect(screen.queryByText(/остались неотправленные записи/)).toBeNull();
  });

  it("shows the link, also when the host is away, and what is refused all the same", async () => {
    const { db, local } = await station();
    const [refused = ""] = await unsentScans(local, 1);
    refuse(db, refused, "rejected", "not_entered");
    view(local, { link: OFFLINE });
    expect(await screen.findByText("Нет связи с хостом")).toBeTruthy();
    expect(screen.getByText("На хосте станция не входила в эту смену")).toBeTruthy();
  });

  it("names the kind and the SSCC of a refused box's record, never a code of marking", async () => {
    const { db, local } = await station();
    db.prepare(
      "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at, outcome, outcome_code, acked_at) " +
        "VALUES ('c1', ?, ?, 'box_closed', ?, ?, '2026-10-08T06:20:00.000Z', 'rejected', 'box_state', '2026-10-08T06:30:00.000Z')",
    ).run(
      PAIRING.hostId,
      PAIRING.deviceId,
      SHIFT_ID,
      JSON.stringify({ id: "c1", kind: "box_closed", data: { sscc: "046006820000000017" } }),
    );
    view(local);
    expect(await screen.findByText(/^Закрытие короба · SSCC 046006820000000017 · /)).toBeTruthy();
    expect(screen.getByText("Короб в состоянии, которое не допускает эту запись")).toBeTruthy();
  });

  it("gives an unknown kind and an unknown code as they are, and a shift without a copy as a dash", async () => {
    const { db, local } = await station();
    db.prepare(
      "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at, outcome, outcome_code, acked_at) " +
        "VALUES ('w1', ?, ?, 'weird_kind', 'no-such-shift', '{}', '2026-10-08T06:20:00.000Z', 'rejected', 'new_code', '2026-10-08T06:30:00.000Z')",
    ).run(PAIRING.hostId, PAIRING.deviceId);
    db.prepare(
      "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at, outcome, outcome_code, acked_at) " +
        "VALUES ('w2', ?, ?, 'scan', 'no-such-shift', '{}', '2026-10-08T06:21:00.000Z', 'rejected', NULL, '2026-10-08T06:30:00.000Z')",
    ).run(PAIRING.hostId, PAIRING.deviceId);
    view(local);
    expect(await screen.findByText("Код отказа хоста: new_code")).toBeTruthy();
    expect(screen.getByText(/^weird_kind · /)).toBeTruthy();
    expect(screen.getByText("Код отказа хоста: —")).toBeTruthy();
    expect(screen.getByText("Смена —")).toBeTruthy();
  });

  it("reads the queue while it says so, and says so when it cannot be read, with a way to read it again", async () => {
    const { local } = await station();
    let failing = true;
    const unreadable: LocalExecutor = {
      query: async (sql, params, row) => {
        if (failing) throw new Error("disk");
        return local.query(sql, params, row);
      },
      transaction: (statements) => local.transaction(statements),
    };
    view(unreadable);
    expect(screen.getByText("Читаем очередь…")).toBeTruthy();
    expect(
      await screen.findByText("Не удалось прочитать очередь в базе этого компьютера."),
    ).toBeTruthy();
    expect(screen.queryByText("Ждут отправки на хост")).toBeNull();
    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByText("Все записи отправлены.")).toBeTruthy();
    expect(screen.queryByText("Не удалось прочитать очередь в базе этого компьютера.")).toBeNull();
  });

  it("sends a shift's refused records again only once the operator confirms, and says what follows", async () => {
    const { db, local } = await station();
    const [one = "", two = ""] = await unsentScans(local, 2);
    refuse(db, one, "rejected", "not_entered");
    refuse(db, two, "rejected", "not_entered");
    const { onChanged } = view(local);
    fireEvent.click(await screen.findByRole("button", { name: "Отправить снова" }));
    const confirm = await confirmation();
    expect(
      within(confirm).getByText(/Отправить снова отклонённые записи смены \(2\)/),
    ).toBeTruthy();
    expect(within(confirm).getByText(/с новыми номерами, в прежнем порядке/)).toBeTruthy();
    expect(within(confirm).getByText(/когда будет связь/)).toBeTruthy();
    expect(within(confirm).getByText(`Смена ${ENTERED.number}: Скан — 2.`)).toBeTruthy();
    expect(rows(db, "SELECT count(*) AS n FROM outbox")).toEqual([{ n: 2 }]);
    fireEvent.click(within(confirm).getByRole("button", { name: "Отправить снова" }));
    const notice = await screen.findByText("Записи поставлены в очередь заново.");
    await waitFor(() => expect(screen.getByText("Отклонённых записей нет.")).toBeTruthy());
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(rows(db, "SELECT count(*) AS n FROM outbox WHERE resolution = 'resent'")).toEqual([
      { n: 2 },
    ]);
    expect(rows(db, "SELECT resolved_by FROM outbox WHERE resolution = 'resent'")).toEqual([
      { resolved_by: OPERATOR_ID },
      { resolved_by: OPERATOR_ID },
    ]);
    expect(screen.queryByRole("group", { name: "Подтверждение" })).toBeNull();
    // The two new records wait for the host (kept just now), and the screen says so.
    expect(screen.getByText("2, самая старая ждёт меньше минуты")).toBeTruthy();
    // The decision's result takes the focus the closed confirmation left.
    await waitFor(() => expect(document.activeElement).toBe(notice));
  });

  it("takes a refused record off on confirmation, offers it for no close, and settles a conflict", async () => {
    const { db, local } = await station();
    const [refused = "", conflict = ""] = await unsentScans(local, 2);
    refuse(db, refused, "rejected", "not_entered");
    refuse(db, conflict, "conflict", null);
    view(local);
    fireEvent.click(await screen.findByRole("button", { name: "Снять с очереди" }));
    const confirm = await confirmation();
    fireEvent.click(within(confirm).getByRole("button", { name: "Снять" }));
    expect(await screen.findByText("Запись снята с очереди.")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Разобрано" }));
    const settle = await confirmation();
    fireEvent.click(within(settle).getByRole("button", { name: "Разобрано" }));
    await waitFor(() => expect(screen.getByText("Конфликтов нет.")).toBeTruthy());
    expect(screen.getByText("Конфликт отмечен разобранным.")).toBeTruthy();
    expect(rows(db, "SELECT resolution, resolved_by FROM outbox ORDER BY seq")).toEqual([
      { resolution: "dismissed", resolved_by: OPERATOR_ID },
      { resolution: "dismissed", resolved_by: OPERATOR_ID },
    ]);
  });

  it("says before it takes a record off what is dropped, that the host never gets it and that it cannot be undone", async () => {
    const { db, local } = await station();
    const [refused = ""] = await unsentScans(local, 1);
    refuse(db, refused, "rejected", "gtin_mismatch");
    view(local);
    fireEvent.click(await screen.findByRole("button", { name: "Снять с очереди" }));
    const confirm = await confirmation();
    expect(
      within(confirm).getByText(/^Скан · .*\. Код другого товара, не товара смены$/),
    ).toBeTruthy();
    expect(within(confirm).getByText(/Хост её так и не получит/)).toBeTruthy();
    expect(within(confirm).getByText(/Вернуть её в очередь будет нельзя/)).toBeTruthy();
    // What cannot be taken back looks like it; what can be asked again does not.
    expect(within(confirm).getByRole("button", { name: "Снять" }).className).toContain(
      "mk-btn--destructive",
    );
  });

  it("says before it settles a conflict that the record stays on this computer", async () => {
    const { db, local } = await station();
    const [conflict = ""] = await unsentScans(local, 1);
    refuse(db, conflict, "conflict", null);
    view(local);
    fireEvent.click(await screen.findByRole("button", { name: "Разобрано" }));
    const confirm = await confirmation();
    expect(within(confirm).getByText(/Запись останется в базе этого компьютера/)).toBeTruthy();
    expect(within(confirm).getByText(/Код уже принят хостом в другом месте/)).toBeTruthy();
    expect(within(confirm).queryByText(/Хост её так и не получит/)).toBeNull();
    expect(within(confirm).getByRole("button", { name: "Разобрано" }).className).toContain(
      "mk-btn--primary",
    );
  });

  it("offers a refused close only to be sent again, never to be taken off", async () => {
    const { db, local } = await station();
    db.prepare(
      "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at, outcome, outcome_code, acked_at) " +
        "VALUES ('close', ?, ?, 'shift_closed', ?, '{}', '2026-10-08T06:20:00.000Z', 'rejected', 'box_state', '2026-10-08T06:30:00.000Z')",
    ).run(PAIRING.hostId, PAIRING.deviceId, SHIFT_ID);
    view(local);
    expect(await screen.findByText(/^Закрытие смены · /)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Отправить снова" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Снять с очереди" })).toBeNull();
  });

  it("writes nothing when the operator cancels, and gives the focus back to the button that asked", async () => {
    const { db, local } = await station();
    const [refused = ""] = await unsentScans(local, 1);
    refuse(db, refused, "rejected", "not_entered");
    const { onChanged } = view(local);
    const ask = await screen.findByRole("button", { name: "Снять с очереди" });
    fireEvent.click(ask);
    const confirm = await confirmation();
    await waitFor(() => expect(document.activeElement).toBe(confirm));
    fireEvent.click(within(confirm).getByRole("button", { name: "Отмена" }));
    expect(screen.queryByRole("group", { name: "Подтверждение" })).toBeNull();
    expect(document.activeElement).toBe(ask);
    expect(rows(db, "SELECT resolution FROM outbox")).toEqual([{ resolution: null }]);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("cancels on the keyboard with Escape, and not while a decision is being written", async () => {
    const { db, local } = await station();
    const [refused = ""] = await unsentScans(local, 1);
    refuse(db, refused, "rejected", "not_entered");
    const held = holdingWrites(local);
    view(held.executor);
    const ask = await screen.findByRole("button", { name: "Снять с очереди" });
    fireEvent.click(ask);
    let confirm = await confirmation();
    fireEvent.keyDown(confirm, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Подтверждение" })).toBeNull();
    expect(document.activeElement).toBe(ask);
    expect(rows(db, "SELECT resolution FROM outbox")).toEqual([{ resolution: null }]);
    // Escape while the write runs does not hide the question under the answer.
    fireEvent.click(ask);
    confirm = await confirmation();
    held.holdNext();
    fireEvent.click(within(confirm).getByRole("button", { name: "Снять" }));
    await act(async () => held.reached());
    fireEvent.keyDown(confirm, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Подтверждение" })).not.toBeNull();
    await act(async () => held.release());
    expect(await screen.findByText("Запись снята с очереди.")).toBeTruthy();
  });

  it("holds every button while a decision is written, and the confirmation until it is", async () => {
    const { db, local } = await station();
    const [one = "", two = ""] = await unsentScans(local, 2);
    refuse(db, one, "rejected", "not_entered");
    refuse(db, two, "conflict", null);
    const held = holdingWrites(local);
    view(held.executor);
    fireEvent.click(await screen.findByRole("button", { name: "Снять с очереди" }));
    const confirm = await confirmation();
    held.holdNext();
    fireEvent.click(within(confirm).getByRole("button", { name: "Снять" }));
    await act(async () => held.reached());
    for (const name of ["Отправить снова", "Снять с очереди", "Разобрано"]) {
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled, name).toBe(true);
    }
    expect(
      (within(confirm).getByRole("button", { name: "Снять" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (within(confirm).getByRole("button", { name: "Отмена" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await act(async () => held.release());
    expect(await screen.findByText("Запись снята с очереди.")).toBeTruthy();
  });

  it("writes one decision for two presses of «Отправить снова» in one turn", async () => {
    const { db, local } = await station();
    const [one = "", two = ""] = await unsentScans(local, 2);
    refuse(db, one, "rejected", "not_entered");
    refuse(db, two, "rejected", "not_entered");
    view(local);
    fireEvent.click(await screen.findByRole("button", { name: "Отправить снова" }));
    const confirm = await confirmation();
    const send = within(confirm).getByRole("button", { name: "Отправить снова" });
    await act(async () => {
      fireEvent.click(send);
      fireEvent.click(send);
    });
    expect(await screen.findByText("Записи поставлены в очередь заново.")).toBeTruthy();
    expect(screen.queryByText(/Очередь изменилась/)).toBeNull();
    expect(rows(db, "SELECT count(*) AS n FROM outbox")).toEqual([{ n: 4 }]);
  });

  it("ignores a press on a confirmation for 400 ms after it opened: the second tap of a double tap decides nothing", async () => {
    const { db, local } = await station();
    const [one = ""] = await unsentScans(local, 1);
    refuse(db, one, "rejected", "not_entered");
    const clock = { now: 10_000 };
    const { onChanged } = view(local, { clock: () => clock.now });
    fireEvent.click(await screen.findByRole("button", { name: "Снять с очереди" }));
    const confirm = await confirmation();
    const take = within(confirm).getByRole("button", { name: "Снять" });
    for (const at of [10_000, 10_399]) {
      clock.now = at;
      fireEvent.click(take);
    }
    await act(async () => undefined);
    expect(rows(db, "SELECT resolution FROM outbox")).toEqual([{ resolution: null }]);
    expect(screen.queryByRole("group", { name: "Подтверждение" })).not.toBeNull();
    expect(onChanged).not.toHaveBeenCalled();
    clock.now = 10_400;
    fireEvent.click(take);
    expect(await screen.findByText("Запись снята с очереди.")).toBeTruthy();
    expect(rows(db, "SELECT resolution FROM outbox")).toEqual([{ resolution: "dismissed" }]);
  });

  it("guards the confirmation of «Отправить снова» the same way, and again when another question opens", async () => {
    const { db, local } = await station();
    const [one = "", two = ""] = await unsentScans(local, 2);
    refuse(db, one, "rejected", "not_entered");
    refuse(db, two, "conflict", null);
    const clock = { now: 50_000 };
    view(local, { clock: () => clock.now });
    fireEvent.click(await screen.findByRole("button", { name: "Отправить снова" }));
    let confirm = await confirmation();
    clock.now = 50_100;
    fireEvent.click(within(confirm).getByRole("button", { name: "Отправить снова" }));
    await act(async () => undefined);
    expect(rows(db, "SELECT count(*) AS n FROM outbox")).toEqual([{ n: 2 }]);
    // Another question opens at 51 000: its own 400 ms begin there.
    clock.now = 51_000;
    fireEvent.click(screen.getByRole("button", { name: "Разобрано" }));
    confirm = await waitFor(() => {
      const group = screen.getByRole("group", { name: "Подтверждение" });
      expect(within(group).getByRole("button", { name: "Разобрано" })).toBeTruthy();
      return group;
    });
    clock.now = 51_200;
    fireEvent.click(within(confirm).getByRole("button", { name: "Разобрано" }));
    await act(async () => undefined);
    expect(rows(db, "SELECT resolution FROM outbox WHERE id = ?", two)).toEqual([
      { resolution: null },
    ]);
    clock.now = 51_400;
    fireEvent.click(within(confirm).getByRole("button", { name: "Разобрано" }));
    expect(await screen.findByText("Конфликт отмечен разобранным.")).toBeTruthy();
  });

  it("does not hold a press for a clock that went back", async () => {
    const { db, local } = await station();
    const [one = ""] = await unsentScans(local, 1);
    refuse(db, one, "rejected", "not_entered");
    const clock = { now: 90_000 };
    view(local, { clock: () => clock.now });
    fireEvent.click(await screen.findByRole("button", { name: "Снять с очереди" }));
    const confirm = await confirmation();
    clock.now = 10;
    fireEvent.click(within(confirm).getByRole("button", { name: "Снять" }));
    expect(await screen.findByText("Запись снята с очереди.")).toBeTruthy();
  });

  it("says the queue changed when a record was resolved while the operator decided, and reads the list again", async () => {
    const { db, local } = await station();
    const [refused = ""] = await unsentScans(local, 1);
    refuse(db, refused, "rejected", "not_entered");
    const { onChanged } = view(local);
    fireEvent.click(await screen.findByRole("button", { name: "Отправить снова" }));
    const confirm = await confirmation();
    db.prepare(
      "UPDATE outbox SET resolution = 'dismissed', resolved_at = 'x', resolved_by = 'y'",
    ).run();
    fireEvent.click(within(confirm).getByRole("button", { name: "Отправить снова" }));
    expect(
      await screen.findByText(
        "Очередь изменилась, пока вы решали: список обновлён, проверьте его ещё раз.",
      ),
    ).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Отклонённых записей нет.")).toBeTruthy());
    expect(screen.queryByRole("group", { name: "Подтверждение" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Отправить снова" })).toBeNull();
    expect(rows(db, "SELECT count(*) AS n FROM outbox")).toEqual([{ n: 1 }]);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("says a record this build cannot send again cannot, and writes nothing", async () => {
    const { db, local } = await station();
    db.prepare(
      "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at, outcome, outcome_code, acked_at) " +
        "VALUES ('old-build', ?, ?, 'scan', ?, '{\"id\":\"old-build\",\"kind\":\"scan\"}', '2026-10-08T06:20:00.000Z', 'rejected', 'invalid_record', '2026-10-08T06:30:00.000Z')",
    ).run(PAIRING.hostId, PAIRING.deviceId, SHIFT_ID);
    view(local);
    fireEvent.click(await screen.findByRole("button", { name: "Отправить снова" }));
    const confirm = await confirmation();
    fireEvent.click(within(confirm).getByRole("button", { name: "Отправить снова" }));
    expect(await screen.findByText(/не читается этой версией станции/)).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Подтверждение" })).toBeNull();
    expect(rows(db, "SELECT count(*) AS n FROM outbox")).toEqual([{ n: 1 }]);
    // It can be taken off instead.
    expect(screen.getByRole("button", { name: "Снять с очереди" })).toBeTruthy();
  });

  it("says when the computer's database would not take the decision, and still tells the status bar", async () => {
    const { db, local } = await station();
    const [refused = ""] = await unsentScans(local, 1);
    refuse(db, refused, "rejected", "not_entered");
    const failing = failingWrites(local);
    const { onChanged } = view(failing);
    fireEvent.click(await screen.findByRole("button", { name: "Снять с очереди" }));
    const confirm = await confirmation();
    fireEvent.click(within(confirm).getByRole("button", { name: "Снять" }));
    expect(await screen.findByText(/Не удалось записать в базу этого компьютера/)).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Подтверждение" })).toBeNull();
    expect(rows(db, "SELECT resolution FROM outbox")).toEqual([{ resolution: null }]);
    // The record is still there to be decided again.
    expect(screen.getByRole("button", { name: "Снять с очереди" })).toBeTruthy();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("names the records an older pairing left unsent, offers nothing to do with them, and says where they are", async () => {
    const { local } = await station();
    await unsentScans(local, 2, OTHER_PAIRING, 50);
    view(local);
    expect(
      await screen.findByText(/остались неотправленные записи прежнего подключения: 2/),
    ).toBeTruthy();
    expect(screen.getByText(/Отсюда их отправить нельзя/)).toBeTruthy();
    expect(screen.getByText(/сообщите администратору/)).toBeTruthy();
    // Read only: the only button is the way back.
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["Назад"]);
    // They are not this pairing's: nothing waits here.
    expect(screen.getByText("Все записи отправлены.")).toBeTruthy();
  });

  it("goes back to the list", async () => {
    const { local } = await station();
    const { onBack } = view(local);
    fireEvent.click(await screen.findByRole("button", { name: "Назад" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("makes every button of it a button of the floor: 64 px and more", async () => {
    const { db, local } = await station();
    const [refused = "", conflict = ""] = await unsentScans(local, 2);
    refuse(db, refused, "rejected", "not_entered");
    refuse(db, conflict, "conflict", null);
    view(local);
    fireEvent.click(await screen.findByRole("button", { name: "Снять с очереди" }));
    await confirmation();
    const buttons = screen.getAllByRole("button");
    // Back, send again, take off, settle, and the confirmation's two.
    expect(buttons).toHaveLength(6);
    for (const button of buttons)
      expect(button.className, button.textContent ?? "").toContain("mk-btn--floor");
  });

  it("reads the queue again when the outbox changed, and keeps what it showed until then", async () => {
    const { db, local } = await station();
    const [first = "", second = ""] = await unsentScans(local, 2);
    refuse(db, first, "rejected", "not_entered");
    const { again } = view(local);
    await screen.findByText("На хосте станция не входила в эту смену");
    refuse(db, second, "rejected", "gtin_mismatch");
    expect(screen.queryByText("Код другого товара, не товара смены")).toBeNull();
    again({ outboxVersion: 1 });
    expect(await screen.findByText("Код другого товара, не товара смены")).toBeTruthy();
    expect(screen.getByText("На хосте станция не входила в эту смену")).toBeTruthy();
  });

  it("shows the newest read, though an older read answers last", async () => {
    const { db, local } = await station();
    const [first = "", second = ""] = await unsentScans(local, 2);
    refuse(db, first, "rejected", "not_entered");
    const late = lateReads(local);
    late.hold();
    const { again } = view(late.executor);
    // The first read has its answer (one refusal) and waits to hand it over.
    await act(async () => undefined);
    late.stopHolding();
    refuse(db, second, "rejected", "gtin_mismatch");
    again({ outboxVersion: 1 });
    expect(await screen.findByText("Код другого товара, не товара смены")).toBeTruthy();
    await act(async () => {
      late.release();
      await Promise.resolve();
    });
    expect(screen.getByText("Код другого товара, не товара смены")).toBeTruthy();
    expect(screen.getByText("На хосте станция не входила в эту смену")).toBeTruthy();
  });

  it("closes a question whose record is gone, and says the queue changed", async () => {
    const { db, local } = await station();
    const [refused = ""] = await unsentScans(local, 1);
    refuse(db, refused, "rejected", "not_entered");
    const { again } = view(local);
    fireEvent.click(await screen.findByRole("button", { name: "Снять с очереди" }));
    await confirmation();
    db.prepare(
      "UPDATE outbox SET resolution = 'dismissed', resolved_at = 'x', resolved_by = 'y'",
    ).run();
    again({ outboxVersion: 1 });
    expect(
      await screen.findByText(
        "Очередь изменилась, пока вы решали: список обновлён, проверьте его ещё раз.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Подтверждение" })).toBeNull();
    expect(screen.getByText("Отклонённых записей нет.")).toBeTruthy();
  });

  it("names the kinds of a shift's refused records and how many of each", async () => {
    const { db, local } = await station();
    const [one = "", two = ""] = await unsentScans(local, 2);
    refuse(db, one, "rejected", "not_entered");
    refuse(db, two, "rejected", "not_entered");
    db.prepare(
      "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at, outcome, outcome_code, acked_at) " +
        "VALUES ('close', ?, ?, 'shift_closed', ?, '{}', '2026-10-08T06:20:00.000Z', 'rejected', 'box_state', '2026-10-08T06:30:00.000Z')",
    ).run(PAIRING.hostId, PAIRING.deviceId, SHIFT_ID);
    view(local);
    fireEvent.click(await screen.findByRole("button", { name: "Отправить снова" }));
    const confirm = await confirmation();
    expect(within(confirm).getByText(/записи смены \(3\)/)).toBeTruthy();
    expect(
      within(confirm).getByText(`Смена ${ENTERED.number}: Скан — 2, Закрытие смены — 1.`),
    ).toBeTruthy();
  });

  it("drops the question without a word of change when the queue cannot be read again", async () => {
    const { db, local } = await station();
    const [refused = ""] = await unsentScans(local, 1);
    refuse(db, refused, "rejected", "not_entered");
    let failing = false;
    const flaky: LocalExecutor = {
      query: async (sql, params, row) => {
        if (failing) throw new Error("disk");
        return local.query(sql, params, row);
      },
      transaction: (statements) => local.transaction(statements),
    };
    const { again } = view(flaky);
    fireEvent.click(await screen.findByRole("button", { name: "Снять с очереди" }));
    await confirmation();
    failing = true;
    again({ outboxVersion: 1 });
    expect(
      await screen.findByText("Не удалось прочитать очередь в базе этого компьютера."),
    ).toBeTruthy();
    // The effects that drop the question have run before the notice is looked for.
    await act(async () => undefined);
    expect(screen.queryByRole("group", { name: "Подтверждение" })).toBeNull();
    expect(screen.queryByText(/Очередь изменилась/)).toBeNull();
  });

  it("shows no question for a record that vanished under a decision being written, and says the queue changed after it", async () => {
    const { db, local } = await station();
    const [refused = ""] = await unsentScans(local, 1);
    refuse(db, refused, "rejected", "not_entered");
    const held = holdingWrites(local);
    const { again } = view(held.executor);
    fireEvent.click(await screen.findByRole("button", { name: "Снять с очереди" }));
    const confirm = await confirmation();
    held.holdNext();
    fireEvent.click(within(confirm).getByRole("button", { name: "Снять" }));
    await act(async () => held.reached());
    db.prepare(
      "UPDATE outbox SET resolution = 'dismissed', resolved_at = 'x', resolved_by = 'y'",
    ).run();
    again({ outboxVersion: 1 });
    await waitFor(() => expect(screen.getByText("Отклонённых записей нет.")).toBeTruthy());
    expect(screen.queryByRole("group", { name: "Подтверждение" })).toBeNull();
    await act(async () => held.release());
    expect(
      await screen.findByText(
        "Очередь изменилась, пока вы решали: список обновлён, проверьте его ещё раз.",
      ),
    ).toBeTruthy();
  });

  it("counts a shift's refused records in the question as they are now", async () => {
    const { db, local } = await station();
    const [one = "", two = "", three = ""] = await unsentScans(local, 3);
    refuse(db, one, "rejected", "not_entered");
    refuse(db, two, "rejected", "not_entered");
    const { again } = view(local);
    fireEvent.click(await screen.findByRole("button", { name: "Отправить снова" }));
    const confirm = await confirmation();
    expect(within(confirm).getByText(/записи смены \(2\)/)).toBeTruthy();
    refuse(db, three, "rejected", "not_entered");
    again({ outboxVersion: 1 });
    await waitFor(() =>
      expect(
        within(screen.getByRole("group", { name: "Подтверждение" })).getByText(
          /записи смены \(3\)/,
        ),
      ).toBeTruthy(),
    );
  });

  it("still tells the status bar of a decision the operator is no longer there to see", async () => {
    const { db, local } = await station();
    const [refused = ""] = await unsentScans(local, 1);
    refuse(db, refused, "rejected", "not_entered");
    const held = holdingWrites(local);
    const { onChanged, unmount } = view(held.executor);
    fireEvent.click(await screen.findByRole("button", { name: "Снять с очереди" }));
    const confirm = await confirmation();
    held.holdNext();
    fireEvent.click(within(confirm).getByRole("button", { name: "Снять" }));
    await act(async () => held.reached());
    unmount();
    await act(async () => held.release());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(rows(db, "SELECT resolution FROM outbox")).toEqual([{ resolution: "dismissed" }]);
  });

  it("has words for every code of refusal the host gives", () => {
    const codes: Record<string, unknown> = ru.floor.queue.code;
    for (const code of FACT_RECEIPT_CODES) expect(codes[code], code).toEqual(expect.any(String));
  });

  it("has words for every kind of record the station keeps", () => {
    const kinds: Record<string, unknown> = ru.floor.queue.kind;
    expect(Object.keys(kinds).sort()).toEqual([
      "box_closed",
      "box_exception",
      "box_label",
      "pallet_closed",
      "pallet_exception",
      "pallet_label",
      "scan",
      "shift_closed",
    ]);
  });
});
