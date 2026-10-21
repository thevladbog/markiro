import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

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
  type DeviceLicense,
  type DeviceShift,
  type EnteredShift,
} from "../src/host/protocol.js";
import type { LocalExecutor } from "../src/local/executor.js";
import { DEVICE_ID, HOST_ID, LINE_ID } from "./support/fixtures.js";
import { deviceLicense } from "./support/license.js";
import { openLocalDb } from "./support/local-db.js";
import { readParticipation } from "../src/floor/shifts/shift-participation.js";
import { formatQuantity } from "../src/floor/shifts/shift-text.js";
import {
  enteredOf,
  HANDHELD,
  participant,
  SHARED,
  SHARED_ENTERED,
  sharedShift,
  STATION_ROW,
} from "./support/multi-station.js";

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
  /** The warehouse reprint's entry (plan СКЛ); none — no button. */
  onWarehouse?: () => void;
  /** The queue of what was not sent (plan ОЧ); none — no button. */
  onQueue?: () => void;
  /** The site's license as the station last heard it (plan ЛЦ-3). */
  license?: DeviceLicense | null;
}

function listOf(local: LocalExecutor, handlers: ReturnType<typeof handlersOf>, options: Options) {
  return (
    <ThemeProvider>
      <ShiftList
        local={local}
        pairing={PAIRING}
        lineId={LINE_ID}
        online={options.online ?? true}
        shiftReads={options.shiftReads ?? READ}
        outboxVersion={options.outboxVersion ?? 0}
        enter={options.enter ?? handlers.enter}
        onEntered={handlers.onEntered}
        onHostError={handlers.onHostError}
        onNew={handlers.onNew}
        {...(options.onSetup === undefined ? {} : { onSetup: options.onSetup })}
        {...(options.onWarehouse === undefined ? {} : { onWarehouse: options.onWarehouse })}
        {...(options.onQueue === undefined ? {} : { onQueue: options.onQueue })}
        {...(options.license === undefined ? {} : { license: options.license })}
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

/** The value under the label of a fact of a card (`Дата производства` → `08.10.2026`), or `null`. */
function fact(element: HTMLElement, label: string): string | null {
  const term = within(element).queryByText(label);
  return term === null ? null : (term.nextElementSibling?.textContent ?? null);
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
    expect(fact(active, "Дата производства")).toBe("08.10.2026");
    // The thousands are parted by a no-break space, as `Intl` writes them for Russian.
    expect(fact(active, "План")).toBe("1\u00a0200 шт");
    expect(within(active).getByText("Для: ООО «Северный берег»")).toBeTruthy();
    expect(within(active).getByText("Агрегация")).toBeTruthy();
    const planned = card("OCT26-005/S");
    expect(within(planned).getByText("Не начата")).toBeTruthy();
    expect(fact(planned, "План")).toBe("Не указан");
    expect(within(planned).getByRole("button", { name: "Открыть" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Смены линии" })).toBeTruthy();
  });

  it("names a shift's product by its print name, the full name where there is none", async () => {
    const other = { ...PLANNED, productId: "5d5d5d5d-0000-4000-8000-000000000009" };
    const { executor, db } = await copiesOf([other, MINE]);
    const insert = db.prepare(
      "INSERT INTO ref_products (id, gtin14, name, print_name, archived, status, rev) " +
        "VALUES (?, ?, ?, ?, 0, 'active', 1)",
    );
    insert.run(MINE.productId, "04600682000013", "Молоко 3,2% 0,9 л", "Молоко");
    insert.run(other.productId, "04601234000017", other.productName, "   ");
    renderList(executor);
    await screen.findByText("OCT26-004");
    const named = card("OCT26-004");
    expect(within(named).getByText("Молоко")).toBeTruthy();
    expect(within(named).queryByText("Молоко 3,2% 0,9 л")).toBeNull();
    // A blank print name falls back to the full name the host sent.
    expect(card("OCT26-005/S").textContent).toContain(other.productName);
  });

  it("keeps showing the print name an entered shift's snapshot froze", async () => {
    const { executor, db } = await copiesOf([MINE], [ENTERED_MINE]);
    db.prepare(
      "INSERT INTO ref_products (id, gtin14, name, print_name, archived, status, rev) " +
        "VALUES (?, '04600682000013', 'Молоко 3,2% 0,9 л', 'Переименовано', 0, 'active', 1)",
    ).run(MINE.productId);
    renderList(executor);
    await screen.findByText("OCT26-004");
    expect(within(card("OCT26-004")).getByText("Молоко 3,2%")).toBeTruthy();
    expect(screen.queryByText("Переименовано")).toBeNull();
  });

  it("shows the shift date beside the production date, and nothing extra for a copy without one", async () => {
    const [dated] = deviceShiftsSchema.parse(fixture("device-shifts-planned-date.json")).shifts as [
      DeviceShift,
      DeviceShift,
    ];
    const { executor } = await copiesOf([{ ...dated, plannedDate: "2026-10-12" }, PLANNED]);
    renderList(executor);
    await screen.findByText("OCT26-004");
    const withDate = card("OCT26-004");
    expect(fact(withDate, "Дата производства")).toBe("08.10.2026");
    expect(fact(withDate, "Дата смены")).toBe("12.10.2026");
    // A copy a host before beta 3 sent has no shift date: the production date alone.
    const plain = card("OCT26-005/S");
    expect(fact(plain, "Дата производства")).not.toBeNull();
    expect(within(plain).queryByText("Дата смены")).toBeNull();
  });

  it("opens a planned shift with the host and hands over the shift with its checked snapshot", async () => {
    const { executor } = await copiesOf([PLANNED]);
    const { handlers } = renderList(executor);
    fireEvent.click(await screen.findByRole("button", { name: "Открыть" }));
    await waitFor(() => expect(handlers.onEntered).toHaveBeenCalledTimes(1));
    expect(handlers.enter).toHaveBeenCalledWith(PLANNED.id, {
      supports: ["validation-v1", "validation-dm-duplicate-v1", "multi-station-v1"],
    });
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
    // The footer says it too, beside the disabled button (the card's hint is the first).
    const footer = screen.getByRole("contentinfo", { name: "Действия со сменами" });
    expect(within(footer).getByText("Нужна связь с хостом")).toBeTruthy();
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
    [
      "pallet_template_not_fit",
      "Шаблон этикетки паллеты выключен или не подходит товару: смену не открыть. Обратитесь в офис.",
    ],
    // The template of a validation shift's duplicate (plan РЕЖ, part B).
    [
      "duplicate_template_not_fit",
      "Шаблон дубликата Data Matrix выключен или не подходит товару: смену не открыть. Обратитесь в офис.",
    ],
    // A mode this build does not name in its entry (plan РЕЖ, Р5).
    [
      "station_update",
      "Эту смену приложение этой станции открыть не может. Обновите приложение станции.",
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

  it("neither keeps nor works a shift with pallets whose answer has no pallet layout (plan ПЛ-Ц)", async () => {
    const { executor } = await copiesOf([PLANNED]);
    const pallets = enteredShiftSchema.parse(fixture("device-shift-entered-pallets.json"));
    // The snapshot of a box shift has no pallet layout.
    const answer: EnteredShift = { ...pallets, id: PLANNED.id, snapshot: ENTERED.snapshot };
    const { handlers } = renderList(executor, { enter: vi.fn(async () => answer) });
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

  it("enters one shift at a time, the cards and «Новая смена» waiting while an entry hangs", async () => {
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
    // «Сменить оператора» is the status bar's (floor-app.test pins it while an entry hangs).
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
    // The board's phase vocabulary: a shift closed in the office is «done» (✓), not a warning.
    expect(finished.querySelector(".shift-card__status")?.className).toContain("mk-chip--done");
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
    expect(await screen.findByText("Открытых смен на линии нет")).toBeTruthy();
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
      // The region stands under the screen's title row as a full-width banner (the board's), in
      // the tree from the first render.
      const element = screen
        .getByRole("heading", { name: "Смены линии" })
        .closest("section")
        ?.querySelector(".shift-selection__message");
      if (!(element instanceof HTMLElement)) {
        throw new Error("no polite region under the title row");
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
    // The screen's title takes the focus (the operator is named in the status bar).
    const title = screen.getByRole("heading", { name: "Смены линии" });
    expect(document.activeElement).toBe(title);
    expect(title.tabIndex).toBe(-1);
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
    // Leaving is the status bar's «Сменить оператора», never held by an entry
    // (floor-app.test); the hub keeps no second copy of it.
    expect(screen.queryByRole("button", { name: "Сменить оператора" })).toBeNull();
  });
});

describe("the warehouse reprint's entry (plan СКЛ)", () => {
  it("has no button when the floor gives no warehouse reprint", async () => {
    const { executor } = await copiesOf([PLANNED]);
    renderList(executor, { onSetup: vi.fn() });
    await screen.findByRole("button", { name: "Открыть" });
    expect(screen.queryByRole("button", { name: "Повторная печать этикеток" })).toBeNull();
  });

  it("opens the reprint at the floor's size beside the setup, and waits while a shift is being entered", async () => {
    const { executor } = await copiesOf([PLANNED]);
    const onWarehouse = vi.fn();
    const onSetup = vi.fn();
    renderList(executor, {
      onWarehouse,
      onSetup,
      enter: () => new Promise<EnteredShift>(() => undefined),
    });
    const reprint = await screen.findByRole("button", { name: "Повторная печать этикеток" });
    expect(reprint.className).toContain("mk-btn--floor");
    // Beside the setup, not in its place.
    expect(screen.getByRole("button", { name: "Рабочее место" })).toBeTruthy();
    fireEvent.click(reprint);
    expect(onWarehouse).toHaveBeenCalledTimes(1);
    expect(onSetup).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Открыть" }));
    await screen.findByText("Открываем смену…");
    expect(reprint).toHaveProperty("disabled", true);
    // Leaving is the status bar's «Сменить оператора», never held by an entry
    // (floor-app.test); the hub keeps no second copy of it.
    expect(screen.queryByRole("button", { name: "Сменить оператора" })).toBeNull();
  });
});

describe("the queue's entry (plan ОЧ)", () => {
  it("opens the queue of what was not sent, and offers no button without it", async () => {
    const { executor } = openLocalDb();
    const onQueue = vi.fn();
    const { view } = renderList(executor, { onQueue });
    const queue = await screen.findByRole("button", { name: "Очередь отправки" });
    expect(queue.className).toContain("mk-btn--floor");
    fireEvent.click(queue);
    expect(onQueue).toHaveBeenCalledTimes(1);
    view.unmount();
    renderList(executor);
    await screen.findByRole("button", { name: "Новая смена" });
    expect(screen.queryByRole("button", { name: "Очередь отправки" })).toBeNull();
  });

  it("is open without the host: what was not sent is read on this computer", async () => {
    const { executor } = await copiesOf([PLANNED]);
    const onQueue = vi.fn();
    renderList(executor, {
      online: false,
      onQueue,
      enter: () => new Promise<EnteredShift>(() => undefined),
    });
    const queue = await screen.findByRole("button", { name: "Очередь отправки" });
    expect(queue).toHaveProperty("disabled", false);
    fireEvent.click(queue);
    expect(onQueue).toHaveBeenCalledTimes(1);
  });

  it("is held while a shift is being entered", async () => {
    const { executor } = await copiesOf([PLANNED]);
    renderList(executor, {
      onQueue: vi.fn(),
      enter: () => new Promise<EnteredShift>(() => undefined),
    });
    const queue = await screen.findByRole("button", { name: "Очередь отправки" });
    fireEvent.click(await screen.findByRole("button", { name: "Открыть" }));
    await screen.findByText("Открываем смену…");
    expect(queue).toHaveProperty("disabled", true);
  });
});

describe("the layout ported from the cloud station's shift selection", () => {
  it("keeps the shift actions in one footer row and the warehouse reprint in the title row", async () => {
    const { executor } = await copiesOf([PLANNED]);
    renderList(executor, { onSetup: vi.fn(), onWarehouse: vi.fn(), onQueue: vi.fn() });
    await screen.findByRole("button", { name: "Открыть" });
    const footer = screen.getByRole("contentinfo", { name: "Действия со сменами" });
    for (const name of ["Новая смена", "Рабочее место", "Очередь отправки"]) {
      expect(within(footer).getByRole("button", { name })).toBeTruthy();
    }
    // «Сменить оператора» stands in the status bar, as on the cloud station: one copy only.
    expect(screen.queryByRole("button", { name: "Сменить оператора" })).toBeNull();
    // The cloud station's top-right header action is where its warehouse entry stands.
    const reprint = screen.getByRole("button", { name: "Повторная печать этикеток" });
    expect(within(footer).queryByRole("button", { name: "Повторная печать этикеток" })).toBeNull();
    expect(reprint.closest("header")).toBe(
      screen.getByRole("heading", { name: "Смены линии" }).closest("header"),
    );
  });

  it("shows two cards a page and pages through the rest, as the cloud station does", async () => {
    const third: DeviceShift = {
      ...PLANNED,
      id: "5b0f9f7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b",
      number: "OCT26-006",
    };
    const { executor } = await copiesOf([PLANNED, MINE, third]);
    renderList(executor);
    await screen.findByText("OCT26-004");
    expect(screen.getByText("OCT26-005/S")).toBeTruthy();
    expect(screen.queryByText("OCT26-006")).toBeNull();
    const pager = screen.getByRole("navigation", { name: "Страницы смен" });
    expect(within(pager).getByText("Страница 1 из 2")).toBeTruthy();
    fireEvent.click(within(pager).getByRole("button", { name: "Далее" }));
    expect(await screen.findByText("OCT26-006")).toBeTruthy();
    expect(screen.queryByText("OCT26-004")).toBeNull();
  });

  it("offers no pager while every shift fits on one page", async () => {
    const { executor } = await copiesOf([PLANNED, MINE]);
    renderList(executor);
    await screen.findByText("OCT26-004");
    expect(screen.queryByRole("navigation", { name: "Страницы смен" })).toBeNull();
  });
});

describe("the hub as the owner-approved board draws it", () => {
  const third = (number: string, id: string): DeviceShift => ({ ...PLANNED, id, number });
  const THIRD = third("OCT26-006", "5b0f9f7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b");
  const gridColumns = () =>
    document.querySelector(".shift-selection__grid")?.getAttribute("data-columns");

  function accept(db: DatabaseSync, n: number, device = DEVICE_ID) {
    const insert = db.prepare(
      "INSERT INTO floor_codes (host_id, device_id, code_hash, shift_id, box_id, scan_id, scanned_at) " +
        "VALUES (?, ?, ?, ?, 'box', ?, '2026-10-09T06:12:00.000Z')",
    );
    for (let index = 0; index < n; index += 1) {
      insert.run(HOST_ID, device, `hash-${device}-${index}`, MINE.id, `scan-${device}-${index}`);
    }
  }

  it("lays one shift out as one wide card, two as two columns, more as pages of two", async () => {
    const one = await copiesOf([MINE]);
    const view = renderList(one.executor);
    await screen.findByText("OCT26-004");
    expect(gridColumns()).toBe("1");
    view.view.unmount();

    const two = await copiesOf([PLANNED, MINE]);
    const second = renderList(two.executor);
    await screen.findByText("OCT26-004");
    expect(gridColumns()).toBe("2");
    expect(screen.queryByRole("navigation", { name: "Страницы смен" })).toBeNull();
    second.view.unmount();

    const many = await copiesOf([PLANNED, MINE, THIRD]);
    renderList(many.executor);
    await screen.findByText("OCT26-004");
    expect(gridColumns()).toBe("2");
    // The pager stands in the title row, «‹ Назад  1 / 2  Далее ›».
    const pager = screen.getByRole("navigation", { name: "Страницы смен" });
    expect(pager.closest("header")).toBe(
      screen.getByRole("heading", { name: "Смены линии" }).closest("header"),
    );
    expect(within(pager).getByRole("button", { name: "Назад" })).toHaveProperty("disabled", true);
    expect(within(pager).getByRole("button", { name: "Далее" })).toHaveProperty("disabled", false);
    expect(within(pager).getByText("1 / 2")).toBeTruthy();
    fireEvent.click(within(pager).getByRole("button", { name: "Далее" }));
    expect(await screen.findByText("OCT26-006")).toBeTruthy();
    // The last page holds one card and keeps the two-column grid.
    expect(gridColumns()).toBe("2");
    expect(document.querySelectorAll(".shift-card")).toHaveLength(1);
    expect(within(pager).getByRole("button", { name: "Далее" })).toHaveProperty("disabled", true);
  });

  it("says how many shifts there are under the title, the page, and that the data is old", async () => {
    const one = await copiesOf([MINE]);
    const first = renderList(one.executor);
    expect(await screen.findByText("1 открытая смена")).toBeTruthy();
    first.view.unmount();

    const two = await copiesOf([PLANNED, MINE]);
    const second = renderList(two.executor, { online: false });
    expect(await screen.findByText("2 смены · данные получены раньше")).toBeTruthy();
    second.view.unmount();

    const many = await copiesOf([PLANNED, MINE, THIRD]);
    const third_ = renderList(many.executor);
    expect(await screen.findByText("3 смены · страница 1 из 2")).toBeTruthy();
    third_.view.unmount();

    const none = await copiesOf([]);
    renderList(none.executor);
    expect(await screen.findByText("Открытых смен нет")).toBeTruthy();
    // The empty state, with «Новая смена» still in the footer.
    expect(screen.getByText("Открытых смен на линии нет")).toBeTruthy();
    expect(screen.getByText("Создайте смену или дождитесь плана из офиса.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Новая смена" })).toHaveProperty("disabled", false);
  });

  it("shows «Принято N из M» with a bar from this station's own codes and the shift's plan", async () => {
    const { executor, db } = await copiesOf([MINE], [ENTERED_MINE]);
    accept(db, 5);
    // Codes of another device in the same shift are not this station's count.
    accept(db, 7, OTHER_STATION);
    renderList(executor);
    await screen.findByText("OCT26-004");
    const active = card("OCT26-004");
    expect(within(active).getByText("Принято")).toBeTruthy();
    expect(active.querySelector(".shift-card__progress-count")?.textContent).toBe(
      "5 из 1\u00a0200",
    );
    const bar = within(active).getByRole("progressbar", { name: "Принято" });
    expect(bar.getAttribute("aria-valuenow")).toBe("5");
    expect(bar.getAttribute("aria-valuemax")).toBe("1200");
  });

  it("hides the progress row without a plan, for a shift this station never entered, and for a copy it cannot count", async () => {
    // Not entered here: the plan is the host's, the count is none of this station's.
    const planned = await copiesOf([{ ...PLANNED, plannedQty: 500 }]);
    const first = renderList(planned.executor);
    await screen.findByText("OCT26-005/S");
    expect(screen.queryByText("Принято")).toBeNull();
    first.view.unmount();

    // Entered, but the plan is not set.
    const noPlan = await copiesOf([{ ...MINE, plannedQty: null }], [ENTERED_MINE]);
    noPlan.db.prepare("UPDATE floor_shifts SET planned_qty = NULL WHERE id = ?").run(MINE.id);
    const second = renderList(noPlan.executor);
    await screen.findByText("OCT26-004");
    expect(screen.queryByText("Принято")).toBeNull();
    expect(fact(card("OCT26-004"), "План")).toBe("Не указан");
    second.view.unmount();

    // A count that cannot be read leaves the row out and the list standing.
    const { executor, db } = await copiesOf([MINE], [ENTERED_MINE]);
    accept(db, 3);
    const failing: LocalExecutor = {
      query: (sql, params, row) =>
        sql.includes("FROM floor_codes")
          ? Promise.reject(new Error("disk"))
          : executor.query(sql, params, row),
      transaction: (statements) => executor.transaction(statements),
    };
    renderList(failing);
    await screen.findByText("OCT26-004");
    expect(screen.queryByText("Принято")).toBeNull();
    expect(screen.getByRole("button", { name: "Продолжить" })).toBeTruthy();
  });

  it("draws the tags on the product's panel, and the actions at 84 px: «Продолжить» primary, «Открыть» secondary", async () => {
    const { executor } = await copiesOf([PLANNED, MINE], [ENTERED_MINE]);
    renderList(executor);
    await screen.findByText("OCT26-004");
    const panel = card("OCT26-004").querySelector(".shift-card__photo");
    expect(panel?.getAttribute("data-photo-backing")).toBe("gradient");
    expect(within(panel as HTMLElement).getByText("Агрегация")).toBeTruthy();
    const resume = within(card("OCT26-004")).getByRole("button", { name: "Продолжить" });
    expect(resume.className).toContain("mk-btn--primary");
    expect(resume.className).toContain("floor-primary");
    const open = within(card("OCT26-005/S")).getByRole("button", { name: "Открыть" });
    expect(open.className).toContain("mk-btn--secondary");
    expect(open.className).toContain("floor-primary");
  });

  it("counts the queue on its button: a quiet 0, «N ждут», and the host's refusal first", async () => {
    const { executor, db } = await copiesOf([PLANNED]);
    const view = renderList(executor, { onQueue: vi.fn() });
    const queue = await screen.findByRole("button", { name: "Очередь отправки" });
    await waitFor(() => expect(queue.textContent).toContain("0"));
    expect(queue.querySelector(".shift-hub__queue-badge")?.getAttribute("data-tone")).toBe(
      "neutral",
    );
    // Three records wait for the host.
    const insert = db.prepare(
      "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at) " +
        "VALUES (?, ?, ?, 'scan', 's', '{}', '2026-10-09T06:20:00.000Z')",
    );
    for (const id of ["a", "b", "c"]) insert.run(id, HOST_ID, DEVICE_ID);
    view.view.rerender(listOf(executor, view.handlers, { onQueue: vi.fn(), outboxVersion: 1 }));
    await waitFor(() => expect(queue.textContent).toContain("3 ждут"));
    expect(queue.querySelector(".shift-hub__queue-badge")?.getAttribute("data-tone")).toBe("warn");
    // The queue's name stays the button's name, the count its description.
    expect(queue.getAttribute("aria-label")).toBe("Очередь отправки");
    // The host refused one: that is said first, in the error tone.
    db.prepare(
      "UPDATE outbox SET outcome = 'rejected', outcome_code = 'invalid_record', acked_at = '2026-10-09T06:21:00.000Z' WHERE id = 'a'",
    ).run();
    view.view.rerender(listOf(executor, view.handlers, { onQueue: vi.fn(), outboxVersion: 2 }));
    await waitFor(() => expect(queue.textContent).toContain("Отклонено 1"));
    expect(queue.querySelector(".shift-hub__queue-badge")?.getAttribute("data-tone")).toBe("error");
  });

  it("keeps «Новая смена» off without the host exactly as before: opening a shift freezes the host's snapshot", async () => {
    const { executor } = await copiesOf([PLANNED]);
    renderList(executor, { online: false });
    await screen.findByText("OCT26-005/S");
    expect(screen.getByRole("button", { name: "Новая смена" })).toHaveProperty("disabled", true);
  });
});

describe("the shifts while the site's license opens no new shift (plan ЛЦ-3)", () => {
  const BLOCKED = "Новые смены не открываются: лицензия площадки истекла. Сообщите администратору.";

  it("explains in place of «Открыть» and «Новая смена», and still continues this station's own shift", async () => {
    const { executor } = await copiesOf([PLANNED, MINE], [ENTERED_MINE]);
    // Without the host, so «Продолжить» works from the stored snapshot, as in the tests above.
    const { handlers } = renderList(executor, {
      license: deviceLicense("restricted"),
      online: false,
    });
    await screen.findByText("OCT26-005/S");
    const planned = card("OCT26-005/S");
    expect(within(planned).queryByRole("button")).toBeNull();
    expect(within(planned).getByText(BLOCKED)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Новая смена" })).toBeNull();
    expect(screen.getAllByText(BLOCKED)).toHaveLength(2);
    const mine = card(MINE.number);
    fireEvent.click(within(mine).getByRole("button", { name: "Продолжить" }));
    await waitFor(() => expect(handlers.onEntered).toHaveBeenCalledTimes(1));
  });

  it("opens as before in the grace", async () => {
    const { executor } = await copiesOf([PLANNED]);
    renderList(executor, { license: deviceLicense("grace", "2027-11-14T21:00:00Z") });
    expect(await screen.findByRole("button", { name: "Открыть" })).toHaveProperty(
      "disabled",
      false,
    );
    expect(screen.getByRole("button", { name: "Новая смена" })).toBeTruthy();
  });

  it("says the host's refusal to open by the state it names", async () => {
    const { executor } = await copiesOf([PLANNED]);
    renderList(executor, {
      enter: async () => {
        throw new HostError({
          kind: "api",
          code: "conflict",
          status: 409,
          message: "restricted",
          details: {
            constraint: "license_restricted",
            state: "trial_expired",
            since: "2026-10-24T09:00:00Z",
          },
        });
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Открыть" }));
    expect(
      await screen.findByText(
        "Новые смены не открываются: пробный период закончился. Сообщите администратору.",
      ),
    ).toBeTruthy();
  });
});

describe("the shifts several devices work (plan 2b)", () => {
  const OTHER_ROW = () => participant(OTHER_STATION, "Станция линии 2", "active");
  const joinable = () =>
    sharedShift({
      participants: [{ row: OTHER_ROW(), accepted: 300 }],
      ownerDeviceId: OTHER_STATION,
    });
  const MULTI_ENTRY = {
    supports: ["validation-v1", "validation-dm-duplicate-v1", "multi-station-v1"],
  };

  it("offers to join a shift another station works while a slot is free, and names who works it", async () => {
    const shift = joinable();
    const { executor } = await copiesOf([shift]);
    renderList(executor);
    await screen.findByText(shift.number);
    const joining = card(shift.number);
    expect(within(joining).getByRole("button", { name: "Присоединиться" })).toHaveProperty(
      "disabled",
      false,
    );
    const who = within(joining).getByText("В смене 1 из 2: Станция линии 2 · станция");
    expect(who.getAttribute("title")).toBe("В смене 1 из 2: Станция линии 2 · станция");
    expect(within(joining).queryByRole("button", { name: "Занята другой станцией" })).toBeNull();
  });

  it("joins through the host naming the capability, and keeps the answer's figures", async () => {
    const shift = joinable();
    const { executor } = await copiesOf([shift]);
    const answer = enteredOf(
      sharedShift({
        participants: [
          { row: OTHER_ROW(), accepted: 300 },
          { row: STATION_ROW, accepted: 0 },
        ],
        ownerDeviceId: OTHER_STATION,
        myState: "active",
        asOf: "2026-10-08T09:45:00Z",
      }),
    );
    const enter = vi.fn(async () => answer);
    const { handlers } = renderList(executor, { enter });
    fireEvent.click(await screen.findByRole("button", { name: "Присоединиться" }));
    await waitFor(() => expect(handlers.onEntered).toHaveBeenCalledTimes(1));
    expect(enter).toHaveBeenCalledWith(shift.id, MULTI_ENTRY);
    expect(await readParticipation(executor, PAIRING, shift.id)).toMatchObject({
      myState: "active",
      participants: [{ deviceId: OTHER_STATION }, { deviceId: DEVICE_ID }],
    });
  });

  it("cannot join without the link, and says why", async () => {
    const shift = joinable();
    const { executor } = await copiesOf([shift]);
    renderList(executor, { online: false });
    await screen.findByText(shift.number);
    const joining = card(shift.number);
    expect(within(joining).getByRole("button", { name: "Присоединиться" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(within(joining).getByText("Нужна связь с хостом")).toBeTruthy();
  });

  it("says the line is full, with no action, when every slot is held", async () => {
    const shift = sharedShift({
      participants: [
        { row: OTHER_ROW(), accepted: 300 },
        { row: participant(HANDHELD, "ТСД 1", "active", "handheld"), accepted: 20 },
      ],
      ownerDeviceId: OTHER_STATION,
    });
    const { executor } = await copiesOf([shift]);
    renderList(executor);
    await screen.findByText(shift.number);
    const full = card(shift.number);
    expect(within(full).getByText("Линия занята: 2 из 2")).toBeTruthy();
    expect(
      within(full).getByText("В смене 2 из 2: Станция линии 2 · станция, ТСД 1 · ТСД"),
    ).toBeTruthy();
    expect(within(full).queryAllByRole("button")).toEqual([]);
  });

  it("says this station's part is closed when the host says so, with no action", async () => {
    const shift = sharedShift({
      participants: [
        { row: participant(DEVICE_ID, "Станция линии 1", "closed"), accepted: 40 },
        { row: OTHER_ROW(), accepted: 300 },
      ],
      ownerDeviceId: OTHER_STATION,
      myState: "closed",
    });
    const { executor } = await copiesOf([shift]);
    renderList(executor);
    await screen.findByText(shift.number);
    const closed = card(shift.number);
    expect(
      within(closed).getByText(
        "Ваша часть этой смены закрыта. Смена закроется, когда закроют остальные.",
      ),
    ).toBeTruthy();
    expect(within(closed).queryAllByRole("button")).toEqual([]);
  });

  it("shows a shared shift's progress as the whole shift's, and names this station among who works it", async () => {
    const both = sharedShift({
      participants: [
        { row: STATION_ROW, accepted: 427 },
        { row: OTHER_ROW(), accepted: 120 },
      ],
      myState: "active",
    });
    const { executor } = await copiesOf([both], [enteredOf(both)]);
    renderList(executor);
    await screen.findByText(both.number);
    const mine = card(both.number);
    // The others' part by the host (120) and this station's own codes (none stored here).
    expect(
      within(mine).getByText(`120 из ${formatQuantity(1200)}`.replace(/\s/g, " ")),
    ).toBeTruthy();
    expect(
      within(mine).getByText("В смене 2 из 2: эта станция, Станция линии 2 · станция"),
    ).toBeTruthy();
    expect(within(mine).getByRole("button", { name: "Продолжить" })).toBeTruthy();
  });

  it("keeps a solo station's card as it was on a line of one", async () => {
    const solo = sharedShift({
      participants: [{ row: STATION_ROW, accepted: 5 }],
      maxStations: 1,
      myState: "active",
    });
    const { executor } = await copiesOf([solo], [enteredOf(solo)]);
    renderList(executor);
    await screen.findByText(solo.number);
    expect(within(card(solo.number)).queryByText(/В смене/)).toBeNull();
    expect(within(card(solo.number)).getByRole("button", { name: "Продолжить" })).toBeTruthy();
  });

  it("reads the shared shift of the host's fixture as a card this station continues", async () => {
    const { executor } = await copiesOf([SHARED], [SHARED_ENTERED]);
    renderList(executor);
    await screen.findByText(SHARED.number);
    // The handheld closed its part: only this station works the shift now, so no line names others.
    expect(within(card(SHARED.number)).queryByText(/В смене/)).toBeNull();
  });
});

describe("what an entry into a shared shift comes to (plan 2b)", () => {
  const OTHER_ROW = () => participant(OTHER_STATION, "Станция линии 2", "active");
  const joinable = () =>
    sharedShift({
      participants: [{ row: OTHER_ROW(), accepted: 300 }],
      ownerDeviceId: OTHER_STATION,
    });

  it("says the line is full with the host's numbers, and keeps the list", async () => {
    const shift = joinable();
    const { executor } = await copiesOf([shift]);
    const full = new HostError({
      kind: "api",
      code: "conflict",
      status: 409,
      message: "every slot of this line is taken in this shift",
      details: { constraint: "shift_line_full", maxStations: 2, active: 2 },
    });
    const { handlers } = renderList(executor, { enter: vi.fn(async () => Promise.reject(full)) });
    fireEvent.click(await screen.findByRole("button", { name: "Присоединиться" }));
    expect(
      await screen.findByText(
        "Линия занята: 2 из 2. Присоединиться можно, когда одна из станций выйдет из смены или закроет свою часть.",
      ),
    ).toBeTruthy();
    expect(handlers.onEntered).not.toHaveBeenCalled();
    expect(screen.getByText(shift.number)).toBeTruthy();
  });

  it("says the line is full in words when the refusal names no numbers", async () => {
    const shift = joinable();
    const { executor } = await copiesOf([shift]);
    const full = new HostError({
      kind: "api",
      code: "conflict",
      status: 409,
      message: "full",
      details: { constraint: "shift_line_full" },
    });
    renderList(executor, { enter: vi.fn(async () => Promise.reject(full)) });
    fireEvent.click(await screen.findByRole("button", { name: "Присоединиться" }));
    expect(
      await screen.findByText(
        "Линия занята: все места этой смены заняты. Присоединиться можно, когда одна из станций выйдет из смены или закроет свою часть.",
      ),
    ).toBeTruthy();
  });

  it("works nothing of a part the host says is closed, enters no copy, and keeps the answer's figures for the card", async () => {
    const shift = sharedShift({
      participants: [
        { row: participant(DEVICE_ID, "Станция линии 1", "active"), accepted: 40 },
        { row: OTHER_ROW(), accepted: 300 },
      ],
      myState: "active",
    });
    const { executor } = await copiesOf([shift]);
    const closed = enteredOf(
      sharedShift({
        participants: [
          { row: participant(DEVICE_ID, "Станция линии 1", "closed"), accepted: 40 },
          { row: OTHER_ROW(), accepted: 300 },
        ],
        myState: "closed",
      }),
    );
    const { handlers } = renderList(executor, { enter: vi.fn(async () => closed) });
    fireEvent.click(await screen.findByRole("button", { name: "Продолжить" }));
    expect(
      await screen.findByText("Ваша часть этой смены уже закрыта: войти в неё снова нельзя."),
    ).toBeTruthy();
    expect(handlers.onEntered).not.toHaveBeenCalled();
    expect((await readShiftCopy(executor, PAIRING, shift.id))?.entered).toBe(false);
    // The read-back is a one-shift answer, so it carries the totals even for a closed part (host
    // `35020185a`): the cache takes it, and the card says the closed part without a new list.
    expect(await readParticipation(executor, PAIRING, shift.id)).toMatchObject({
      myState: "closed",
      totals: { accepted: 340 },
    });
  });

  it("enters a known shift without the link and drops the pause the host has not heard", async () => {
    const { db, executor } = await copiesOf([SHARED], [SHARED_ENTERED]);
    db.prepare("UPDATE floor_shift_participation SET leave_requested_at = ?").run(
      "2026-10-08T10:00:00.000Z",
    );
    const context: EntryContext = {
      local: executor,
      pairing: PAIRING,
      online: false,
      enter: vi.fn(async () => SHARED_ENTERED),
      now: () => new Date("2026-10-08T10:05:00.000Z"),
    };
    const copy = await readShiftCopy(executor, PAIRING, SHARED.id);
    if (copy === null) throw new Error("the shared shift is not kept");
    expect(await enterShift(context, copy)).toMatchObject({ kind: "entered", offline: true });
    expect((await readParticipation(executor, PAIRING, SHARED.id))?.leaveRequestedAt).toBeNull();
    expect(context.enter).not.toHaveBeenCalled();
  });

  it("still says stage 2a's «занята» for `shift_busy`", async () => {
    const shift = joinable();
    const { executor } = await copiesOf([shift]);
    const busy = new HostError({
      kind: "api",
      code: "conflict",
      status: 409,
      message: "busy",
      details: { constraint: "shift_busy" },
    });
    renderList(executor, { enter: vi.fn(async () => Promise.reject(busy)) });
    fireEvent.click(await screen.findByRole("button", { name: "Присоединиться" }));
    expect(await screen.findByText("Эту смену уже открыла другая станция.")).toBeTruthy();
  });
});
