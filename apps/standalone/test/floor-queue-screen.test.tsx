import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import type { FloorSession } from "../src/app/shell.js";
import { QueueScreen } from "../src/floor/queue/QueueScreen.js";
import { keepEnteredShift } from "../src/floor/shifts/shift-copies.js";
import { FACT_KINDS, FACT_RECEIPT_CODES, type HostStatus } from "../src/host/protocol.js";
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
    expect(await screen.findByText(/^Закрытие смены станцией · /)).toBeTruthy();
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
    // Back, send again, take off, take off the shift's, settle, and the confirmation's two.
    expect(buttons).toHaveLength(7);
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
      within(confirm).getByText(`Смена ${ENTERED.number}: Скан — 2, Закрытие смены станцией — 1.`),
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
    expect(Object.keys(kinds).sort()).toEqual([...FACT_KINDS].sort());
    expect(FACT_KINDS).toContain("unit_label");
    for (const kind of FACT_KINDS) expect(kinds[kind], kind).toEqual(expect.any(String));
  });
});

// The final review's I-1: after a restore of the host a shift the copy does not know is refused
// on every record. The screen lists a bounded part of each shift and counts the rest, and one
// decision takes off all of a shift's refusals but its close.
describe("the queue screen after a restore: a shift refused whole", () => {
  const BULK = "Снять с очереди все отказы смены";

  function refuseClose(db: ReturnType<typeof openLocalDb>["db"]) {
    db.prepare(
      "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at, outcome, outcome_code, acked_at) " +
        "VALUES ('close', ?, ?, 'shift_closed', ?, '{}', '2026-10-08T06:20:00.000Z', 'rejected', 'unknown_shift', '2026-10-08T06:30:00.000Z')",
    ).run(PAIRING.hostId, PAIRING.deviceId, SHIFT_ID);
  }

  async function refusedWhole(n: number, withClose = true) {
    const { db, local } = await station();
    const ids = await unsentScans(local, n);
    for (const id of ids) refuse(db, id, "rejected", "unknown_shift");
    if (withClose) refuseClose(db);
    return { db, local, ids };
  }

  it("lists the first 20 refused records of a shift and says how many more there are", async () => {
    const { local } = await refusedWhole(25);
    view(local);
    expect(await screen.findByText("…и ещё 6")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Снять с очереди" })).toHaveLength(20);
    expect(screen.getAllByText("Хост не знает эту смену")).toHaveLength(20);
  });

  it("says no more when the shift's records are all listed", async () => {
    const { local } = await refusedWhole(19);
    view(local);
    await screen.findByRole("button", { name: BULK });
    expect(screen.queryByText(/и ещё/)).toBeNull();
    // Twenty listed, the close the twentieth: the button is never offered for it.
    expect(screen.getAllByText("Хост не знает эту смену")).toHaveLength(20);
    expect(screen.getAllByRole("button", { name: "Снять с очереди" })).toHaveLength(19);
  });

  it("counts every refused record of the shift in the question of «Отправить снова», also the ones not listed", async () => {
    const { local } = await refusedWhole(25);
    view(local);
    fireEvent.click(await screen.findByRole("button", { name: "Отправить снова" }));
    const confirm = await confirmation();
    expect(within(confirm).getByText(/записи смены \(26\)/)).toBeTruthy();
    expect(
      within(confirm).getByText(`Смена ${ENTERED.number}: Скан — 25, Закрытие смены станцией — 1.`),
    ).toBeTruthy();
  });

  it("takes off every refusal of the shift but its close on one confirmation that names how many, the shift and that it cannot be undone", async () => {
    const { db, local } = await refusedWhole(25);
    const { onChanged } = view(local);
    fireEvent.click(await screen.findByRole("button", { name: BULK }));
    const confirm = await confirmation();
    expect(
      within(confirm).getByText(
        `Снять с очереди все отказы смены ${ENTERED.number} (25), не отправляя? Хост их так и не получит. Вернуть их в очередь будет нельзя; станция запомнит, кто и когда их снял.`,
      ),
    ).toBeTruthy();
    expect(within(confirm).getByText(`Смена ${ENTERED.number}: Скан — 25.`)).toBeTruthy();
    expect(within(confirm).getByText(/закрытие смены этим не снимается/i)).toBeTruthy();
    expect(within(confirm).getByText(/его можно только отправить снова/)).toBeTruthy();
    const take = within(confirm).getByRole("button", { name: "Снять все (25)" });
    expect(take.className).toContain("mk-btn--destructive");
    expect(rows(db, "SELECT count(*) AS n FROM outbox WHERE resolution IS NOT NULL")).toEqual([
      { n: 0 },
    ]);
    fireEvent.click(take);
    const notice = await screen.findByText("Отказы смены сняты с очереди.");
    await waitFor(() => expect(screen.queryByRole("button", { name: BULK })).toBeNull());
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(
      rows(
        db,
        "SELECT kind, resolution, resolved_by, resolved_at, count(*) AS n FROM outbox GROUP BY kind, resolution",
      ),
    ).toEqual([
      {
        kind: "scan",
        resolution: "dismissed",
        resolved_by: OPERATOR_ID,
        resolved_at: NOW.toISOString(),
        n: 25,
      },
      { kind: "shift_closed", resolution: null, resolved_by: null, resolved_at: null, n: 1 },
    ]);
    // The close is what stays, to be sent again.
    expect(screen.getByText(/^Закрытие смены станцией · /)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Отправить снова" })).toBeTruthy();
    expect(screen.queryByText(/и ещё/)).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(notice));
  });

  it("says nothing of a close when the shift's close is not refused", async () => {
    const { local } = await refusedWhole(2, false);
    view(local);
    fireEvent.click(await screen.findByRole("button", { name: BULK }));
    const confirm = await confirmation();
    expect(within(confirm).getByText(/все отказы смены .* \(2\)/)).toBeTruthy();
    expect(within(confirm).queryByText(/закрытие смены/i)).toBeNull();
  });

  it("offers no taking off at once for a shift whose only refusal is its close", async () => {
    const { local } = await refusedWhole(0);
    view(local);
    expect(await screen.findByText(/^Закрытие смены станцией · /)).toBeTruthy();
    expect(screen.queryByRole("button", { name: BULK })).toBeNull();
  });

  it("writes nothing when a refusal arrived after the question opened, says the queue changed and reads it again", async () => {
    const { db, local } = await refusedWhole(2, false);
    const [late = ""] = await unsentScans(local, 1, PAIRING, 500);
    const { onChanged } = view(local);
    fireEvent.click(await screen.findByRole("button", { name: BULK }));
    const confirm = await confirmation();
    expect(within(confirm).getByRole("button", { name: "Снять все (2)" })).toBeTruthy();
    refuse(db, late, "rejected", "unknown_shift");
    fireEvent.click(within(confirm).getByRole("button", { name: "Снять все (2)" }));
    expect(
      await screen.findByText(
        "Очередь изменилась, пока вы решали: список обновлён, проверьте его ещё раз.",
      ),
    ).toBeTruthy();
    expect(rows(db, "SELECT count(*) AS n FROM outbox WHERE resolution IS NOT NULL")).toEqual([
      { n: 0 },
    ]);
    expect(onChanged).toHaveBeenCalledTimes(1);
    // Read again: three now, and a new question names them.
    fireEvent.click(await screen.findByRole("button", { name: BULK }));
    expect(
      within(await confirmation()).getByRole("button", { name: "Снять все (3)" }),
    ).toBeTruthy();
  });

  it("ignores a press on its confirmation for 400 ms after it opened", async () => {
    const { db, local } = await refusedWhole(2, false);
    const clock = { now: 20_000 };
    view(local, { clock: () => clock.now });
    fireEvent.click(await screen.findByRole("button", { name: BULK }));
    const take = within(await confirmation()).getByRole("button", { name: "Снять все (2)" });
    clock.now = 20_399;
    fireEvent.click(take);
    await act(async () => undefined);
    expect(rows(db, "SELECT count(*) AS n FROM outbox WHERE resolution IS NOT NULL")).toEqual([
      { n: 0 },
    ]);
    clock.now = 20_400;
    fireEvent.click(take);
    expect(await screen.findByText("Отказы смены сняты с очереди.")).toBeTruthy();
    expect(rows(db, "SELECT count(*) AS n FROM outbox WHERE resolution = 'dismissed'")).toEqual([
      { n: 2 },
    ]);
  });

  it("closes its question when the shift's refusals were taken off meanwhile, and says the queue changed", async () => {
    const { db, local } = await refusedWhole(2);
    const { again } = view(local);
    fireEvent.click(await screen.findByRole("button", { name: BULK }));
    await confirmation();
    db.prepare(
      "UPDATE outbox SET resolution = 'dismissed', resolved_at = 'x', resolved_by = 'y' WHERE kind = 'scan'",
    ).run();
    again({ outboxVersion: 1 });
    expect(
      await screen.findByText(
        "Очередь изменилась, пока вы решали: список обновлён, проверьте его ещё раз.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Подтверждение" })).toBeNull();
    // The close stays.
    expect(screen.getByText(/^Закрытие смены станцией · /)).toBeTruthy();
  });

  it("never counts a shift below what it lists, though its count was read before a refusal landed", async () => {
    const { db, local } = await refusedWhole(3, false);
    // The counts answer as if none of the shift's refusals were there yet.
    const early: LocalExecutor = {
      query: async (sql, params, row) =>
        sql.includes("GROUP BY shift_id, outcome, kind") ? [] : local.query(sql, params, row),
      transaction: (statements) => local.transaction(statements),
    };
    view(early);
    fireEvent.click(await screen.findByRole("button", { name: "Отправить снова" }));
    expect(within(await confirmation()).getByText(/записи смены \(3\)/)).toBeTruthy();
    // Nothing counted, nothing to take off at once.
    expect(screen.queryByRole("button", { name: BULK })).toBeNull();
    expect(rows(db, "SELECT count(*) AS n FROM outbox WHERE resolution IS NOT NULL")).toEqual([
      { n: 0 },
    ]);
  });

  it("names a shift's kinds in the order of their first record listed, the kinds not listed last", async () => {
    const { db, local } = await refusedWhole(2, false);
    db.prepare(
      "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at, outcome, outcome_code, acked_at) " +
        "VALUES ('box', ?, ?, 'box_closed', ?, '{}', '2026-10-08T06:20:00.000Z', 'rejected', 'unknown_shift', '2026-10-08T06:30:00.000Z')",
    ).run(PAIRING.hostId, PAIRING.deviceId, SHIFT_ID);
    view(local);
    fireEvent.click(await screen.findByRole("button", { name: BULK }));
    expect(
      within(await confirmation()).getByText(
        `Смена ${ENTERED.number}: Скан — 2, Закрытие короба — 1.`,
      ),
    ).toBeTruthy();
  });

  it("lists the first 20 conflicts of a shift and says how many more there are", async () => {
    const { db, local } = await station();
    const ids = await unsentScans(local, 22);
    for (const id of ids) refuse(db, id, "conflict", null);
    view(local);
    expect(await screen.findByText("…и ещё 2")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Разобрано" })).toHaveLength(20);
    // A conflict is never taken off with a shift's refusals.
    expect(screen.queryByRole("button", { name: BULK })).toBeNull();
  });
});

describe("the displaced codes on the queue screen (plan КНФ)", () => {
  const HASH = "0".repeat(63) + "7";

  function displaced(
    db: ReturnType<typeof openLocalDb>["db"],
    conflictId: string,
    fields: { boxId?: string | null; sameDevice?: boolean } = {},
  ): void {
    db.prepare(
      "INSERT INTO floor_displacements (host_id, device_id, conflict_id, record_id, shift_id, " +
        "code_hash, box_id, detected_at, winner_shift_number, winner_same_device, " +
        "winner_scanned_at, learned_at) VALUES (?, ?, ?, ?, ?, ?, ?, '2026-10-08T07:12:03Z', " +
        "'OCT26-005/S', ?, '2026-10-08T06:00:50.000Z', '2026-10-08T07:13:00.000Z')",
    ).run(
      PAIRING.hostId,
      PAIRING.deviceId,
      conflictId,
      `r-${conflictId}`,
      SHIFT_ID,
      HASH,
      fields.boxId ?? null,
      fields.sameDevice === true ? 1 : 0,
    );
  }

  function closedBox(db: ReturnType<typeof openLocalDb>["db"]): void {
    db.prepare(
      "INSERT INTO floor_boxes (id, host_id, device_id, shift_id, opened_at, closed_at, sscc, " +
        "block_id, serial, item_count) VALUES ('box-1', ?, ?, ?, '2026-10-08T06:10:00.000Z', " +
        "'2026-10-08T06:20:00.000Z', '046006820000015001', 'block-1', 1500, 1)",
    ).run(PAIRING.hostId, PAIRING.deviceId, SHIFT_ID);
  }

  it("lists each displaced code by its box and when the host saw it, with what to check", async () => {
    const { db, local } = await station();
    closedBox(db);
    displaced(db, "c-1", { boxId: "box-1" });
    // A box the host still had open: its id is known, its SSCC is not.
    displaced(db, "c-2", { boxId: "box-open", sameDevice: true });
    view(local);
    const section = await screen.findByRole("region", { name: "Вытесненные коды" });
    // 07:12 UTC on this computer's clock as the screen writes every record's time.
    const time = new Intl.DateTimeFormat("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date("2026-10-08T07:12:03Z"));
    expect(
      within(section).getByText(`Смена ${ENTERED.number} · Короб (00)046006820000015001 · ${time}`),
    ).toBeTruthy();
    expect(
      within(section).getByText(
        "Этот код раньше отсканировали в смене OCT26-005/S. Хост учёл его в той смене и исключил из этого короба. Проверьте содержимое короба.",
      ),
    ).toBeTruthy();
    expect(
      within(section).getByText(`Смена ${ENTERED.number} · Короб без SSCC · ${time}`),
    ).toBeTruthy();
    expect(
      within(section).getByText(/раньше отсканировали этой станцией в смене OCT26-005\/S/),
    ).toBeTruthy();
    expect(within(section).getAllByRole("button", { name: "Разобрано" })).toHaveLength(2);
  });

  // A validation shift's scan names no box (plan РЕЖ): the words speak of the product, never of a
  // box the person has nowhere to look for.
  it("words the displaced code of a validation shift without a box", async () => {
    const { db, local } = await station();
    displaced(db, "c-1");
    displaced(db, "c-2", { sameDevice: true });
    view(local);
    const section = await screen.findByRole("region", { name: "Вытесненные коды" });
    expect(within(section).getAllByText(/^Смена .+ · Без короба · /)).toHaveLength(2);
    expect(
      within(section).getByText(
        "Этот код раньше отсканировали в смене OCT26-005/S. Хост учёл его в той смене. Проверьте изделие.",
      ),
    ).toBeTruthy();
    expect(
      within(section).getByText(
        "Этот код раньше отсканировали этой станцией в смене OCT26-005/S. Хост учёл его в той смене. Проверьте изделие.",
      ),
    ).toBeTruthy();
    expect(within(section).queryByText(/проверьте короб/)).toBeNull();
  });

  it("settles a displaced code on confirmation, guarded the same 400 ms, and tells the status bar", async () => {
    const { db, local } = await station();
    displaced(db, "c-1");
    const clock = { now: 10_000 };
    const { onChanged } = view(local, { clock: () => clock.now });
    const section = await screen.findByRole("region", { name: "Вытесненные коды" });
    fireEvent.click(within(section).getByRole("button", { name: "Разобрано" }));
    const confirm = await confirmation();
    expect(within(confirm).getByText(/Отметить вытеснение разобранным\?/)).toBeTruthy();
    const settle = within(confirm).getByRole("button", { name: "Разобрано" });
    clock.now = 10_399;
    fireEvent.click(settle);
    await act(async () => undefined);
    expect(rows(db, "SELECT resolved_at FROM floor_displacements")).toEqual([
      { resolved_at: null },
    ]);
    clock.now = 10_400;
    fireEvent.click(settle);
    expect(await screen.findByText("Вытеснение отмечено разобранным.")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Вытесненных кодов нет.")).toBeTruthy());
    expect(onChanged).toHaveBeenCalled();
    expect(rows(db, "SELECT resolved_at, resolved_by FROM floor_displacements")).toEqual([
      { resolved_at: NOW.toISOString(), resolved_by: OPERATOR_ID },
    ]);
  });

  it("says there are none, and shows no conflict the office reviewed", async () => {
    const { db, local } = await station();
    const [conflict = ""] = await unsentScans(local, 1);
    refuse(db, conflict, "conflict", null);
    db.prepare(
      "UPDATE outbox SET resolution = 'dismissed', resolved_at = ?, resolved_by = NULL, " +
        "office_reviewed_at = ? WHERE id = ?",
    ).run(NOW.toISOString(), "2026-10-08T08:00:00Z", conflict);
    view(local);
    expect(await screen.findByText("Вытесненных кодов нет.")).toBeTruthy();
    expect(screen.getByText("Конфликтов нет.")).toBeTruthy();
  });
});
