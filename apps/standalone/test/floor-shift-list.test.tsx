import { readFileSync } from "node:fs";

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import type { FloorSession } from "../src/app/shell.js";
import {
  keepEnteredShift,
  readShiftCopy,
  replaceShiftCopies,
  type WorkShift,
} from "../src/floor/shifts/shift-copies.js";
import { enterShift, type EntryContext } from "../src/floor/shifts/shift-entry.js";
import { ShiftList } from "../src/floor/shifts/ShiftList.js";
import { HostError } from "../src/host/client.js";
import {
  deviceShiftsSchema,
  enteredShiftSchema,
  type DeviceShift,
  type EnteredShift,
} from "../src/host/protocol.js";
import type { LocalExecutor } from "../src/local/executor.js";
import { DEVICE_ID, HOST_ID, LINE_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"));
}

const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };
const [ACTIVE, PLANNED] = deviceShiftsSchema.parse(fixture("device-shifts.json")).shifts as [
  DeviceShift,
  DeviceShift,
];
const ENTERED: EnteredShift = enteredShiftSchema.parse(fixture("device-shift-entered.json"));
/** The planned shift as the host answers its opening: active, this station's. */
const OPENED: EnteredShift = {
  ...ENTERED,
  id: PLANNED.id,
  number: PLANNED.number,
  createdFrom: "station",
  productionDate: PLANNED.productionDate,
  plannedQty: null,
  counterpartyName: null,
  snapshot: { ...ENTERED.snapshot, counterpartyName: null },
};
const ANNA: FloorSession = {
  sessionId: 1,
  id: "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
  login: "0042",
  name: "Анна Кузнецова",
  role: null,
};
const OTHER_STATION = "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f";
const READ = { done: 1, failed: false };
const SEEN = 1_790_000_000_000;

interface Options {
  online?: boolean;
  shiftReads?: { done: number; failed: boolean };
  enter?: (id: string) => Promise<EnteredShift>;
  outboxVersion?: number;
  /** The workstation setup's entry (plan 2a7); none — no button. */
  onSetup?: () => void;
}

function listOf(local: LocalExecutor, handlers: ReturnType<typeof handlersOf>, options: Options) {
  return (
    <ThemeProvider>
      <ShiftList
        local={local}
        pairing={PAIRING}
        lineId={LINE_ID}
        operator={ANNA}
        online={options.online ?? true}
        shiftReads={options.shiftReads ?? READ}
        outboxVersion={options.outboxVersion ?? 0}
        enter={options.enter ?? handlers.enter}
        onEntered={handlers.onEntered}
        onHostError={handlers.onHostError}
        onNew={handlers.onNew}
        onSignOut={handlers.onSignOut}
        {...(options.onSetup === undefined ? {} : { onSetup: options.onSetup })}
      />
    </ThemeProvider>
  );
}

function handlersOf() {
  return {
    enter: vi.fn<(id: string) => Promise<EnteredShift>>(async () => OPENED),
    onEntered: vi.fn<(shift: WorkShift) => void>(),
    onHostError: vi.fn<(error: unknown) => void>(),
    onNew: vi.fn(),
    onSignOut: vi.fn(),
  };
}

async function copiesOf(shifts: DeviceShift[], entered: EnteredShift[] = []) {
  const opened = openLocalDb();
  for (const shift of entered) {
    await keepEnteredShift(opened.executor, PAIRING, shift, "2026-10-09T06:00:00.000Z", SEEN);
  }
  await replaceShiftCopies(opened.executor, PAIRING, shifts, SEEN);
  return opened;
}

function renderList(local: LocalExecutor, options: Options = {}) {
  const handlers = handlersOf();
  const view = render(listOf(local, handlers, options));
  return { handlers, view };
}

function card(number: string): HTMLElement {
  const label = screen.getByText(number);
  const element = label.closest(".shift-card");
  if (!(element instanceof HTMLElement)) throw new Error(`no card for ${number}`);
  return element;
}

/** This station's active shift as the list reads it: owned by this device. */
const MINE: DeviceShift = { ...ACTIVE, ownerDeviceId: DEVICE_ID };
const ENTERED_MINE: EnteredShift = { ...ENTERED, ownerDeviceId: DEVICE_ID };

describe("the shifts of the station's line", () => {
  it("names each shift, its product, date, plan and counterparty in words", async () => {
    const { executor } = await copiesOf([PLANNED, MINE]);
    renderList(executor);
    await screen.findByText("OCT26-004");
    const active = card("OCT26-004");
    expect(within(active).getByText("В работе")).toBeTruthy();
    expect(within(active).getByText("Молоко 3,2% 0,9 л")).toBeTruthy();
    expect(within(active).getByText("Дата производства: 08.10.2026")).toBeTruthy();
    // The thousands are parted by a no-break space, as `Intl` writes them for Russian.
    expect(active.textContent).toContain("План: 1\u00a0200");
    expect(within(active).getByText("Для: ООО «Северный берег»")).toBeTruthy();
    expect(within(active).getByText("Агрегация")).toBeTruthy();
    const planned = card("OCT26-005/S");
    expect(within(planned).getByText("Не начата")).toBeTruthy();
    expect(within(planned).getByText("План не указан")).toBeTruthy();
    expect(within(planned).getByRole("button", { name: "Открыть" })).toBeTruthy();
    expect(screen.getByText("Вошёл: Анна Кузнецова, табельный номер 0042.")).toBeTruthy();
  });

  it("opens a planned shift with the host and hands over the shift with its checked snapshot", async () => {
    const { executor } = await copiesOf([PLANNED]);
    const { handlers } = renderList(executor);
    fireEvent.click(await screen.findByRole("button", { name: "Открыть" }));
    await waitFor(() => expect(handlers.onEntered).toHaveBeenCalledTimes(1));
    expect(handlers.enter).toHaveBeenCalledWith(PLANNED.id);
    const [shift] = handlers.onEntered.mock.calls[0] ?? [];
    expect(shift).toMatchObject({
      copy: { id: PLANNED.id, status: "active", entered: true },
      snapshot: { issuerPrefix: "460068200", boxTemplate: { spec: { language: "tspl" } } },
    });
    expect(await readShiftCopy(executor, PAIRING, PLANNED.id)).toMatchObject({ entered: true });
  });

  it("keeps a planned shift and a new one closed without the host, and says why", async () => {
    const { executor } = await copiesOf([PLANNED]);
    renderList(executor, { online: false });
    await screen.findByText("OCT26-005/S");
    const planned = card("OCT26-005/S");
    expect(within(planned).getByRole("button", { name: "Открыть" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(within(planned).getByText("Нужна связь с хостом")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Новая смена" })).toHaveProperty("disabled", true);
    expect(screen.getByText("Новую смену можно создать только при связи с хостом.")).toBeTruthy();
    expect(
      screen.getByText(
        "Нет связи с хостом: показаны смены, полученные раньше. Продолжить можно смену, которую эта станция уже открыла.",
      ),
    ).toBeTruthy();
  });

  it("continues the shift this station entered from its stored snapshot without the host", async () => {
    const { executor } = await copiesOf([MINE], [ENTERED_MINE]);
    const { handlers } = renderList(executor, { online: false });
    fireEvent.click(await screen.findByRole("button", { name: "Продолжить" }));
    await waitFor(() => expect(handlers.onEntered).toHaveBeenCalledTimes(1));
    expect(handlers.enter).not.toHaveBeenCalled();
    expect(handlers.onEntered.mock.calls[0]?.[0]).toMatchObject({
      copy: { id: ACTIVE.id, entered: true },
    });
  });

  it("continues from the stored snapshot when the request finds no host though the link said online", async () => {
    const { executor } = await copiesOf([MINE], [ENTERED_MINE]);
    const down = new HostError({ kind: "transport", code: "unreachable", message: "down" });
    const { handlers } = renderList(executor, { enter: vi.fn(async () => Promise.reject(down)) });
    fireEvent.click(await screen.findByRole("button", { name: "Продолжить" }));
    await waitFor(() => expect(handlers.onEntered).toHaveBeenCalledTimes(1));
  });

  it("does not continue a shift of this station whose snapshot it lost, until the host answers", async () => {
    const { executor } = await copiesOf([MINE]);
    renderList(executor, { online: false });
    expect(await screen.findByRole("button", { name: "Продолжить" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it.each([
    ["shift_busy", "Эту смену уже открыла другая станция."],
    ["shift_status", "Смена закрыта."],
    ["shift_line", "Смена не на линии этой станции."],
    ["product_inactive", "Товар смены выключен или в архиве: смену не открыть. Обратитесь в офис."],
    [
      "template_not_fit",
      "Шаблон этикетки смены выключен или не подходит товару: смену не открыть. Обратитесь в офис.",
    ],
  ])("says why the host refused the entry (%s) and keeps the list", async (constraint, text) => {
    const { executor } = await copiesOf([PLANNED]);
    const refused = new HostError({
      kind: "api",
      code: "conflict",
      status: 409,
      message: "no",
      details: { constraint },
    });
    const { handlers } = renderList(executor, {
      enter: vi.fn(async () => Promise.reject(refused)),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Открыть" }));
    expect(await screen.findByText(text)).toBeTruthy();
    expect(handlers.onEntered).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Открыть" })).toHaveProperty("disabled", false),
    );
  });

  it("says a shift the office deleted is gone", async () => {
    const { executor } = await copiesOf([PLANNED]);
    const gone = new HostError({ kind: "api", code: "not_found", status: 404, message: "no" });
    renderList(executor, { enter: vi.fn(async () => Promise.reject(gone)) });
    fireEvent.click(await screen.findByRole("button", { name: "Открыть" }));
    expect(await screen.findByText("Смены больше нет на хосте: её удалили в офисе.")).toBeTruthy();
  });

  it("neither keeps nor works a shift whose layout this build does not read", async () => {
    const { executor } = await copiesOf([PLANNED]);
    const broken = {
      ...OPENED,
      snapshot: { ...OPENED.snapshot, boxTemplate: { ...OPENED.snapshot.boxTemplate, spec: {} } },
    };
    const { handlers } = renderList(executor, { enter: vi.fn(async () => broken) });
    fireEvent.click(await screen.findByRole("button", { name: "Открыть" }));
    expect(
      await screen.findByText(
        "Этикетку этой смены приложение прочитать не может. Обновите приложение или попросите офис закрыть смену.",
      ),
    ).toBeTruthy();
    expect(handlers.onEntered).not.toHaveBeenCalled();
    expect(await readShiftCopy(executor, PAIRING, PLANNED.id)).toMatchObject({ entered: false });
  });

  it("hands a refused device key to the shell", async () => {
    const { executor } = await copiesOf([PLANNED]);
    const rejected = new HostError({
      kind: "api",
      code: "unauthorized",
      status: 401,
      message: "no",
      details: { credential: "device" },
    });
    const { handlers } = renderList(executor, {
      enter: vi.fn(async () => Promise.reject(rejected)),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Открыть" }));
    await waitFor(() => expect(handlers.onHostError).toHaveBeenCalledWith(rejected));
    expect(handlers.onEntered).not.toHaveBeenCalled();
  });

  it("hands another host's certificate to the shell at once, though it holds the shift's snapshot", async () => {
    const { executor } = await copiesOf([MINE], [ENTERED_MINE]);
    const changed = new HostError({
      kind: "transport",
      code: "certificate_mismatch",
      message: "other",
    });
    const { handlers } = renderList(executor, {
      enter: vi.fn(async () => Promise.reject(changed)),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Продолжить" }));
    await waitFor(() => expect(handlers.onHostError).toHaveBeenCalledWith(changed));
    // Not worked from the snapshot behind the shell's back, and not blamed on the shift.
    expect(handlers.onEntered).not.toHaveBeenCalled();
  });

  it("takes the previous refusal off the screen once the next attempt starts", async () => {
    const { executor } = await copiesOf([PLANNED]);
    const closed = new HostError({
      kind: "api",
      code: "conflict",
      status: 409,
      message: "no",
      details: { constraint: "shift_status" },
    });
    const enter = vi
      .fn<(id: string) => Promise<EnteredShift>>()
      .mockRejectedValueOnce(closed)
      .mockImplementationOnce(() => new Promise<EnteredShift>(() => undefined));
    renderList(executor, { enter });
    fireEvent.click(await screen.findByRole("button", { name: "Открыть" }));
    expect(await screen.findByText("Смена закрыта.")).toBeTruthy();
    // The list reads its copies again after a refusal; the entry is offered again when it is back.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Открыть" })).toHaveProperty("disabled", false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Открыть" }));
    expect(await screen.findByText("Открываем смену…")).toBeTruthy();
    expect(enter).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Смена закрыта.")).toBeNull();
  });

  it("enters one shift at a time and keeps «Сменить оператора» while an entry hangs", async () => {
    const { executor } = await copiesOf([PLANNED, MINE], [ENTERED_MINE]);
    let answer: (shift: EnteredShift) => void = () => undefined;
    const enter = vi.fn(
      () =>
        new Promise<EnteredShift>((resolve) => {
          answer = resolve;
        }),
    );
    const { handlers } = renderList(executor, { enter });
    const open = await screen.findByRole("button", { name: "Открыть" });
    act(() => {
      fireEvent.click(open);
      fireEvent.click(open);
    });
    fireEvent.click(screen.getByRole("button", { name: "Продолжить" }));
    expect(enter).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Открываем смену…")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Продолжить" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Новая смена" })).toHaveProperty("disabled", true);
    const signOut = screen.getByRole("button", { name: "Сменить оператора" });
    expect(signOut).toHaveProperty("disabled", false);
    fireEvent.click(signOut);
    expect(handlers.onSignOut).toHaveBeenCalledTimes(1);
    await act(async () => {
      answer(OPENED);
    });
    await waitFor(() => expect(handlers.onEntered).toHaveBeenCalledTimes(1));
  });

  it("drops an entry whose answer lands after the screen is gone", async () => {
    const { executor } = await copiesOf([PLANNED]);
    let answer: (shift: EnteredShift) => void = () => undefined;
    const enter = vi.fn(
      () =>
        new Promise<EnteredShift>((resolve) => {
          answer = resolve;
        }),
    );
    const { handlers, view } = renderList(executor, { enter });
    fireEvent.click(await screen.findByRole("button", { name: "Открыть" }));
    view.unmount();
    await act(async () => {
      answer(OPENED);
    });
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
    });
    expect(handlers.onEntered).not.toHaveBeenCalled();
  });

  it("offers nothing on a shift another station opened or one this station is closing", async () => {
    const { db, executor } = await copiesOf(
      [{ ...ACTIVE, ownerDeviceId: OTHER_STATION }, PLANNED],
      [],
    );
    await keepEnteredShift(executor, PAIRING, { ...OPENED }, "2026-10-09T06:00:00.000Z", SEEN);
    db.prepare("UPDATE floor_shifts SET local_state = 'closing' WHERE id = ?").run(PLANNED.id);
    renderList(executor);
    await screen.findByText("OCT26-004");
    const busy = card("OCT26-004");
    expect(within(busy).getByRole("button", { name: "Занята другой станцией" })).toHaveProperty(
      "disabled",
      true,
    );
    const closing = card("OCT26-005/S");
    expect(within(closing).getByRole("button", { name: "Закрывается" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("says a close the host refused, and lets a close go once the host took it", async () => {
    const { db, executor } = await copiesOf([PLANNED, MINE], [ENTERED_MINE]);
    await keepEnteredShift(executor, PAIRING, { ...OPENED }, "2026-10-09T06:00:00.000Z", SEEN);
    db.prepare("UPDATE floor_shifts SET local_state = 'closing' WHERE id = ?").run(PLANNED.id);
    const record = (id: string, shiftId: string) =>
      `{"id":"${id}","kind":"shift_closed","shiftId":"${shiftId}","operatorId":null,"data":{}}`;
    db.prepare(
      "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at, outcome, " +
        "outcome_code, acked_at) VALUES (?, ?, ?, 'shift_closed', ?, ?, '2026-10-09T08:00:00.000Z', " +
        "'rejected', 'invalid_record', '2026-10-09T08:00:01.000Z')",
    ).run(
      "11111111-1111-4111-8111-111111111111",
      HOST_ID,
      DEVICE_ID,
      PLANNED.id,
      record("11111111-1111-4111-8111-111111111111", PLANNED.id),
    );
    // A refusal of a shift that is not closing here (its close was never written) is not shown.
    db.prepare(
      "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at, outcome, " +
        "outcome_code, acked_at) VALUES (?, ?, ?, 'shift_closed', ?, ?, '2026-10-09T08:00:00.000Z', " +
        "'rejected', 'invalid_record', '2026-10-09T08:00:01.000Z')",
    ).run(
      "22222222-2222-4222-8222-222222222222",
      HOST_ID,
      DEVICE_ID,
      MINE.id,
      record("22222222-2222-4222-8222-222222222222", MINE.id),
    );
    const handlers = handlersOf();
    const view = render(listOf(executor, handlers, {}));
    await screen.findByText("OCT26-005/S");
    expect(
      within(card("OCT26-005/S")).getByText(
        "Хост не принял закрытие смены (код invalid_record). Смену закроют в офисе.",
      ),
    ).toBeTruthy();
    expect(within(card(MINE.number)).queryByText(/Хост не принял/)).toBeNull();
    db.prepare("UPDATE floor_shifts SET local_state = 'closed' WHERE id = ?").run(MINE.id);
    view.rerender(listOf(executor, handlers, { outboxVersion: 1 }));
    await waitFor(() => expect(screen.queryByText(MINE.number)).toBeNull());
    expect(screen.getByText("OCT26-005/S")).toBeTruthy();
  });

  it("says a refusal that came without a code with a dash", async () => {
    const { db, executor } = await copiesOf([PLANNED]);
    await keepEnteredShift(executor, PAIRING, { ...OPENED }, "2026-10-09T06:00:00.000Z", SEEN);
    db.prepare("UPDATE floor_shifts SET local_state = 'closing'").run();
    db.prepare(
      "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at, outcome, " +
        "acked_at) VALUES (?, ?, ?, 'shift_closed', ?, ?, '2026-10-09T08:00:00.000Z', " +
        "'rejected', '2026-10-09T08:00:01.000Z')",
    ).run(
      "33333333-3333-4333-8333-333333333333",
      HOST_ID,
      DEVICE_ID,
      PLANNED.id,
      `{"id":"33333333-3333-4333-8333-333333333333","kind":"shift_closed"}`,
    );
    renderList(executor);
    await screen.findByText("OCT26-005/S");
    expect(
      within(card("OCT26-005/S")).getByText(
        "Хост не принял закрытие смены (код —). Смену закроют в офисе.",
      ),
    ).toBeTruthy();
  });

  it("offers to finish a shift the office closed after this station entered it, without asking the host", async () => {
    const { db, executor } = await copiesOf([], [ENTERED_MINE, OPENED]);
    const closed = { status: "closed" as const, closedAt: "2026-10-09T18:00:00Z" };
    await replaceShiftCopies(
      executor,
      PAIRING,
      [
        { ...MINE, ...closed },
        { ...PLANNED, ...closed },
      ],
      SEEN + 1,
    );
    // A shift this station closed itself stays closing, whatever the office did.
    db.prepare("UPDATE floor_shifts SET local_state = 'closing' WHERE id = ?").run(PLANNED.id);
    const { handlers } = renderList(executor);
    await screen.findByText(MINE.number);
    expect(
      within(card(PLANNED.number)).getByRole("button", { name: "Закрывается" }),
    ).toHaveProperty("disabled", true);
    const finished = card(MINE.number);
    expect(within(finished).getByText("Закрыта в офисе")).toBeTruthy();
    expect(
      within(finished).getByText(
        "Смену закрыли в офисе. Закончите на станции короб и этикетку и закройте смену.",
      ),
    ).toBeTruthy();
    fireEvent.click(within(finished).getByRole("button", { name: "Завершить" }));
    await waitFor(() => expect(handlers.onEntered).toHaveBeenCalledTimes(1));
    expect(handlers.enter).not.toHaveBeenCalled();
    expect(handlers.onEntered.mock.calls[0]?.[0].copy).toMatchObject({
      id: MINE.id,
      status: "closed",
      localState: null,
    });
  });

  it("reads its copies again after every read of the host's list", async () => {
    const { executor } = await copiesOf([]);
    const handlers = handlersOf();
    const view = render(listOf(executor, handlers, {}));
    expect(
      await screen.findByText(
        "Открытых смен на линии нет. Создайте смену или дождитесь плана из офиса.",
      ),
    ).toBeTruthy();
    await replaceShiftCopies(executor, PAIRING, [PLANNED], SEEN + 1);
    view.rerender(listOf(executor, handlers, { shiftReads: { done: 2, failed: false } }));
    expect(await screen.findByText("OCT26-005/S")).toBeTruthy();
  });

  it("says the shifts were never read rather than that there are none", async () => {
    const { executor } = await copiesOf([]);
    renderList(executor, { shiftReads: { done: 0, failed: false } });
    expect(
      await screen.findByText("Смены ещё не получены с хоста. Проверьте связь с хостом."),
    ).toBeTruthy();
  });

  it("says when the host's list did not update", async () => {
    const { executor } = await copiesOf([PLANNED]);
    renderList(executor, { shiftReads: { done: 1, failed: true } });
    expect(
      await screen.findByText("Список смен не обновился с хоста — показаны полученные раньше."),
    ).toBeTruthy();
  });

  describe("what the list says in its one polite region", () => {
    const OFFLINE =
      "Нет связи с хостом: показаны смены, полученные раньше. Продолжить можно смену, которую эта станция уже открыла.";
    const NOT_UPDATED = "Список смен не обновился с хоста — показаны полученные раньше.";

    /** The polite region, there from the first render, and what sits in it. */
    function region(): HTMLElement {
      const element = screen.getByText(
        "Вошёл: Анна Кузнецова, табельный номер 0042.",
      ).nextElementSibling;
      if (!(element instanceof HTMLElement) || element.getAttribute("aria-live") !== "polite") {
        throw new Error("no polite region after the prompt");
      }
      return element;
    }

    it("shows the host's list that did not update in the region, not as an alert of its own", async () => {
      const { executor } = await copiesOf([PLANNED]);
      renderList(executor, { shiftReads: { done: 1, failed: true } });
      await screen.findByText("OCT26-005/S");
      expect(within(region()).getByText(NOT_UPDATED)).toBeTruthy();
      expect(within(region()).queryAllByRole("alert")).toEqual([]);
    });

    it("shows the host's refusal of an entry and the lost link together", async () => {
      const { executor } = await copiesOf([MINE], [ENTERED_MINE]);
      const closed = new HostError({
        kind: "api",
        code: "conflict",
        status: 409,
        message: "no",
        details: { constraint: "shift_status" },
      });
      // Online when the entry starts and offline when it is refused is one list's life.
      const enter = vi.fn(async () => Promise.reject(closed));
      const handlers = handlersOf();
      const view = render(listOf(executor, handlers, { enter }));
      fireEvent.click(await screen.findByRole("button", { name: "Продолжить" }));
      expect(await screen.findByText("Смена закрыта.")).toBeTruthy();
      view.rerender(listOf(executor, handlers, { enter, online: false }));
      expect(within(region()).getByText("Смена закрыта.")).toBeTruthy();
      expect(within(region()).getByText(OFFLINE)).toBeTruthy();
      expect(within(region()).queryAllByRole("alert")).toEqual([]);
    });

    it("keeps the lost link as the one thing said of the link, however the host's list went", async () => {
      const { executor } = await copiesOf([PLANNED]);
      renderList(executor, { online: false, shiftReads: { done: 1, failed: true } });
      await screen.findByText("OCT26-005/S");
      expect(within(region()).getByText(OFFLINE)).toBeTruthy();
      expect(within(region()).queryByText(NOT_UPDATED)).toBeNull();
    });

    it("has the region on screen before any of it is said, and says nothing of the link while it is fine", async () => {
      const { executor } = await copiesOf([PLANNED]);
      const handlers = handlersOf();
      const view = render(listOf(executor, handlers, {}));
      await screen.findByText("OCT26-005/S");
      const before = region();
      expect(before.textContent).toBe("");
      view.rerender(listOf(executor, handlers, { online: false }));
      expect(region()).toBe(before);
      expect(within(before).getByText(OFFLINE)).toBeTruthy();
    });

    it("is heard once: its messages are not alerts of their own inside a polite region", async () => {
      const { executor } = await copiesOf([PLANNED]);
      renderList(executor, { online: false });
      await screen.findByText("OCT26-005/S");
      expect(within(region()).queryAllByRole("alert")).toEqual([]);
    });
  });

  it("gives the focus to the list when it appears, so a keyboard or a screen reader starts there", async () => {
    const { executor } = await copiesOf([PLANNED]);
    renderList(executor);
    await screen.findByText("OCT26-005/S");
    const prompt = screen.getByText("Вошёл: Анна Кузнецова, табельный номер 0042.");
    expect(document.activeElement).toBe(prompt);
    expect(prompt.tabIndex).toBe(-1);
  });

  it("does not take the focus back from a button when it reads its copies again", async () => {
    const { executor: real } = await copiesOf([PLANNED]);
    // The reads of the copies are watched: the assertion is about what the SECOND one
    // sets, so it waits for that read, not for a time that may be too short.
    const reads: Promise<unknown>[] = [];
    const local: LocalExecutor = {
      query: (sql, params, row) => {
        const read = real.query(sql, params, row);
        if (sql.includes("FROM floor_shifts")) reads.push(read);
        return read;
      },
      transaction: (statements) => real.transaction(statements),
    };
    const handlers = handlersOf();
    const view = render(listOf(local, handlers, {}));
    const open = await screen.findByRole("button", { name: "Открыть" });
    open.focus();
    expect(reads).toHaveLength(1);
    view.rerender(listOf(local, handlers, { shiftReads: { done: 2, failed: false } }));
    await waitFor(() => expect(reads).toHaveLength(2));
    await act(async () => {
      await Promise.all(reads);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByRole("button", { name: "Открыть" })).toBe(open);
    expect(document.activeElement).toBe(open);
  });

  it("explains a copy it cannot read and reads again on «Повторить»", async () => {
    const real = (await copiesOf([PLANNED])).executor;
    let broken = true;
    const flaky: LocalExecutor = {
      query: (sql, params, row) =>
        broken ? Promise.reject(new Error("disk")) : real.query(sql, params, row),
      transaction: (statements) => real.transaction(statements),
    };
    renderList(flaky);
    expect(await screen.findByText("Не удалось прочитать смены на этом компьютере.")).toBeTruthy();
    broken = false;
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByText("OCT26-005/S")).toBeTruthy();
  });

  it("reads its copies again after a refusal: the host may have changed the shift", async () => {
    const { executor } = await copiesOf([PLANNED]);
    const closedMeanwhile = new HostError({
      kind: "api",
      code: "conflict",
      status: 409,
      message: "no",
      details: { constraint: "shift_status" },
    });
    const enter = vi.fn(async () => {
      // The host's list lands while the entry is on its way: the shift is gone from it.
      await replaceShiftCopies(executor, PAIRING, [], SEEN + 1);
      throw closedMeanwhile;
    });
    renderList(executor, { enter });
    fireEvent.click(await screen.findByRole("button", { name: "Открыть" }));
    expect(await screen.findByText("Смена закрыта.")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("OCT26-005/S")).toBeNull());
  });

  it("shows the newest read of its copies when an older one lands last", async () => {
    const real = (await copiesOf([])).executor;
    let calls = 0;
    let release: () => void = () => undefined;
    const racy: LocalExecutor = {
      query: async (sql, params, row) => {
        // Only the read of the copies is counted: the list reads the refused closes beside it.
        const ofCopies = sql.includes("FROM floor_shifts");
        if (ofCopies) calls += 1;
        const result = await real.query(sql, params, row);
        if (ofCopies && calls === 1) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return result;
      },
      transaction: (statements) => real.transaction(statements),
    };
    const handlers = handlersOf();
    const view = render(listOf(racy, handlers, {}));
    await waitFor(() => expect(calls).toBe(1));
    await replaceShiftCopies(real, PAIRING, [PLANNED], SEEN + 1);
    view.rerender(listOf(racy, handlers, { shiftReads: { done: 2, failed: false } }));
    expect(await screen.findByText("OCT26-005/S")).toBeTruthy();
    await act(async () => {
      release();
      await new Promise((resolve) => setImmediate(resolve));
    });
    expect(screen.getByText("OCT26-005/S")).toBeTruthy();
  });

  it("hands the answer of an entry to the handlers of the screen as it is when the answer lands", async () => {
    const { executor } = await copiesOf([PLANNED]);
    let answer: (shift: EnteredShift) => void = () => undefined;
    const enter = vi.fn(
      () =>
        new Promise<EnteredShift>((resolve) => {
          answer = resolve;
        }),
    );
    const handlers = handlersOf();
    const view = render(listOf(executor, handlers, { enter }));
    fireEvent.click(await screen.findByRole("button", { name: "Открыть" }));
    const later = handlersOf();
    view.rerender(listOf(executor, later, { enter }));
    await act(async () => {
      answer(OPENED);
    });
    await waitFor(() => expect(later.onEntered).toHaveBeenCalledTimes(1));
    expect(handlers.onEntered).not.toHaveBeenCalled();
  });
});

describe("entering a shift without the host", () => {
  /** The stored copy as the list would hand it over: active, open here, however the store says otherwise. */
  async function staleCopy(local: LocalExecutor) {
    const stored = await readShiftCopy(local, PAIRING, ACTIVE.id);
    if (stored === null) throw new Error("no stored copy");
    return { ...stored, status: "active" as const, localState: null };
  }

  function context(local: LocalExecutor, online: boolean): EntryContext {
    return {
      local,
      pairing: PAIRING,
      online,
      enter: vi.fn(async () => OPENED),
      now: () => new Date(SEEN),
    };
  }

  it.each([true, false])(
    "does not even ask the host to enter a shift this station is closing (link online %s)",
    async (online) => {
      const { executor } = await copiesOf([], [ENTERED_MINE]);
      const copy = { ...(await staleCopy(executor)), localState: "closing" as const };
      const enter = vi.fn(async () => OPENED);
      const result = await enterShift({ ...context(executor, online), enter }, copy);
      expect(result).toEqual({ kind: "refused", reason: "closed" });
      expect(enter).not.toHaveBeenCalled();
    },
  );

  it("enters the active shift this station kept, from its snapshot", async () => {
    const { executor } = await copiesOf([], [ENTERED_MINE]);
    const result = await enterShift(context(executor, false), await staleCopy(executor));
    expect(result).toMatchObject({ kind: "entered", offline: true });
  });

  it.each([false, true])(
    "enters a stored shift the office closed, to finish it, with the link online %s",
    async (online) => {
      const { executor } = await copiesOf([], [{ ...ENTERED_MINE, status: "closed" }]);
      const copy = { ...(await staleCopy(executor)), status: "closed" as const };
      const enter = vi.fn(async () => OPENED);
      const result = await enterShift({ ...context(executor, online), enter }, copy);
      // From the stored snapshot: the host refuses to enter a closed shift, so it is not asked.
      expect(result).toMatchObject({ kind: "entered", offline: true });
      expect(enter).not.toHaveBeenCalled();
    },
  );

  it.each(["closing", "closed"])(
    "refuses a stored shift this station is closing or has closed (%s)",
    async (state) => {
      const { db, executor } = await copiesOf([], [ENTERED_MINE]);
      // The list handed over a copy the store has since moved on from.
      const copy = await staleCopy(executor);
      db.prepare("UPDATE floor_shifts SET local_state = ? WHERE id = ?").run(state, ACTIVE.id);
      const result = await enterShift(context(executor, false), copy);
      expect(result).toEqual({ kind: "refused", reason: "closed" });
    },
  );

  it("hands another host's certificate to the shell, not the stored snapshot, though the station holds one", async () => {
    const { executor } = await copiesOf([], [ENTERED_MINE]);
    const changed = new HostError({
      kind: "transport",
      code: "certificate_mismatch",
      message: "other",
    });
    const enter = vi.fn(async () => Promise.reject(changed));
    const result = await enterShift(
      { ...context(executor, true), enter },
      await staleCopy(executor),
    );
    expect(result).toEqual({ kind: "rejected", error: changed });
    expect(enter).toHaveBeenCalledTimes(1);
  });

  it("calls a failure that is no answer of the host a plain failure, and does not fall back to the snapshot", async () => {
    const { executor } = await copiesOf([], [ENTERED_MINE]);
    const enter = vi.fn(async () => Promise.reject(new Error("boom")));
    const result = await enterShift(
      { ...context(executor, true), enter },
      await staleCopy(executor),
    );
    expect(result).toEqual({ kind: "refused", reason: "failed" });
  });

  describe("when the shift's snapshot cannot be kept or read back", () => {
    it("says the computer could not keep it when the write fails", async () => {
      const { executor } = await copiesOf([PLANNED]);
      const broken: LocalExecutor = {
        query: (sql, params, row) => executor.query(sql, params, row),
        transaction: () => Promise.reject(new Error("disk full")),
      };
      const result = await enterShift(context(broken, true), await plannedCopy(executor));
      expect(result).toEqual({ kind: "refused", reason: "local" });
    });

    it("says the same when the write took and the snapshot is not there to read back", async () => {
      const { executor } = await copiesOf([PLANNED]);
      const lost: LocalExecutor = {
        query: (sql, params, row) => executor.query(sql, params, row),
        // The write is acknowledged and nothing is stored.
        transaction: async (statements) => statements.map(() => 1),
      };
      const result = await enterShift(context(lost, true), await plannedCopy(executor));
      expect(result).toEqual({ kind: "refused", reason: "local" });
    });

    it("says the same when what was kept is a snapshot this build cannot read back", async () => {
      const { db, executor } = await copiesOf([PLANNED]);
      const spoiled: LocalExecutor = {
        query: (sql, params, row) => executor.query(sql, params, row),
        transaction: async (statements) => {
          const changes = await executor.transaction(statements);
          db.prepare("UPDATE floor_shifts SET snapshot = ? WHERE id = ?").run("{}", PLANNED.id);
          return changes;
        },
      };
      const result = await enterShift(context(spoiled, true), await plannedCopy(executor));
      expect(result).toEqual({ kind: "refused", reason: "local" });
    });

    async function plannedCopy(local: LocalExecutor) {
      const stored = await readShiftCopy(local, PAIRING, PLANNED.id);
      if (stored === null) throw new Error("no stored copy");
      return stored;
    }
  });
});

describe("the workstation setup's entry", () => {
  it("has no button when the floor gives no setup", async () => {
    const { executor } = await copiesOf([PLANNED]);
    renderList(executor);
    await screen.findByRole("button", { name: "Открыть" });
    expect(screen.queryByRole("button", { name: "Рабочее место" })).toBeNull();
  });

  it("opens the setup at the floor's size, and waits while a shift is being entered", async () => {
    const { executor } = await copiesOf([PLANNED]);
    const onSetup = vi.fn();
    renderList(executor, { onSetup, enter: () => new Promise<EnteredShift>(() => undefined) });
    const setup = await screen.findByRole("button", { name: "Рабочее место" });
    expect(setup.className).toContain("mk-btn--floor");
    fireEvent.click(setup);
    expect(onSetup).toHaveBeenCalledTimes(1);
    fireEvent.click(await screen.findByRole("button", { name: "Открыть" }));
    await screen.findByText("Открываем смену…");
    expect(setup).toHaveProperty("disabled", true);
    // Leaving is never held by an entry that does not answer.
    expect(screen.getByRole("button", { name: "Сменить оператора" })).toHaveProperty(
      "disabled",
      false,
    );
  });
});
