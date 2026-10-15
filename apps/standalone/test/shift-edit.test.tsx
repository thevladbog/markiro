import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HostError } from "../src/host/client.js";
import type { OfficeShift } from "../src/host/protocol.js";
import { TECHNOLOGIST, type FakeOfficeSession } from "./support/office.js";
import {
  ACTIVE,
  AYRAN_ARCHIVED,
  BOX_58,
  CLOSED,
  expectFocusedNotice,
  freezeToday,
  KEFIR_DRAFT,
  LINE_10,
  LINE_2,
  NORTH,
  OLD_BOX,
  OLD_LINE,
  openShifts,
  PALLET,
  pickDate,
  PLANNED,
  shiftRow,
  shiftsSession,
  startEditing,
  SOUTH_ARCHIVED,
  stockSheets,
  WATER,
} from "./support/shifts.js";
import {
  chooseValueOn,
  isSelectTrigger,
  optionTextsOn,
  shownOn,
  valueOn,
  waitForList,
} from "./support/select.js";
import { pressRowAction } from "./support/row-menu.js";
import { findRowAction } from "./support/row-menu.js";

const TOKEN = "office-session-token";

function api(code: string, details: Record<string, unknown> = {}): HostError {
  return new HostError({ kind: "api", code, status: 409, message: code, details });
}

function dialog(name: string): HTMLElement {
  return screen.getByRole("dialog", { name });
}

function field(name: string, label: string): HTMLElement {
  return within(dialog(name)).getByLabelText(label);
}

function options(name: string, label: string): string[] {
  return optionTextsOn(field(name, label));
}

/** Types into an input, or picks the option holding `value` in a select. */
function setField(name: string, label: string, value: string): void {
  const control = field(name, label);
  if (isSelectTrigger(control)) chooseValueOn(control, value);
  else fireEvent.change(control, { target: { value } });
}

function valueOf(name: string, label: string): string {
  const control = field(name, label);
  if (isSelectTrigger(control)) return valueOn(control);
  if (!(control instanceof HTMLInputElement)) throw new Error(`${label} holds no value`);
  return control.value;
}

/** The message under the control labelled `label`, by its `aria-describedby`. */
function messageOf(name: string, label: string): string | null | undefined {
  const id = field(name, label).getAttribute("aria-describedby");
  return id === null ? undefined : document.getElementById(id)?.textContent;
}

function isDisabled(control: HTMLElement): boolean {
  return (control as HTMLInputElement | HTMLSelectElement | HTMLButtonElement).disabled;
}

function save(name: string): HTMLButtonElement {
  const button = within(dialog(name)).getByRole("button", { name: "Сохранить" });
  if (!(button instanceof HTMLButtonElement)) throw new Error("no button");
  return button;
}

async function openEdit(session: FakeOfficeSession, shift: OfficeShift): Promise<string> {
  await openShifts(session);
  const name = await startEditing(shift.number);
  // The template choice waits for the product's record.
  await waitFor(() =>
    expect((field(name, "Шаблон этикетки короба") as HTMLSelectElement).disabled).toBe(false),
  );
  return name;
}

/** The form is gone and the card of the shift (still open) is back, read-only. */
async function leftForCard(name: string): Promise<void> {
  await within(dialog(name)).findByRole("button", { name: /^Изменить смену / });
  expect(within(dialog(name)).queryByLabelText("План, шт")).toBeNull();
}

async function openPlan(session: FakeOfficeSession, shift: OfficeShift): Promise<string> {
  await openShifts(session);
  pressRowAction(screen, `Изменить план смены ${shift.number}`);
  const name = `План смены ${shift.number}`;
  await screen.findByRole("dialog", { name });
  return name;
}

describe("office shifts: changing a shift", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
    freezeToday();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("offers a planned shift's change and delete, an active one's figures, plan, close and export, and a closed one's figures and export alone, to both roles", async () => {
    for (const user of [undefined, TECHNOLOGIST]) {
      const view = await openShifts(shiftsSession(undefined, user));
      expect(
        within(shiftRow("OCT26-005"))
          .getAllByRole("button")
          .map((button) => button.getAttribute("aria-label")),
      ).toEqual(["Открыть смену OCT26-005", "Удалить смену OCT26-005"]);
      expect(
        within(shiftRow("OCT26-004"))
          .getAllByRole("button")
          .map((button) => button.getAttribute("aria-label")),
      ).toEqual(["Итоги смены OCT26-004", "Действия: OCT26-004"]);
      // The rest of an active shift's actions are the «⋯» menu's items, the close set apart.
      const items = findRowAction(within(shiftRow("OCT26-004")), "Изменить план смены OCT26-004");
      expect(items.getAttribute("role")).toBe("menuitem");
      expect(
        within(screen.getByRole("menu"))
          .getAllByRole("menuitem")
          .map((item) => [item.getAttribute("aria-label"), item.getAttribute("data-destructive")]),
      ).toEqual([
        ["Изменить план смены OCT26-004", null],
        ["Выгрузка смены OCT26-004", null],
        ["Закрыть смену OCT26-004", "true"],
      ]);
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      // A closed shift only reads: its figures and its export (plan ЧЗ).
      expect(
        within(shiftRow(CLOSED.number))
          .getAllByRole("button")
          .map((button) => button.getAttribute("aria-label")),
      ).toEqual(["Итоги смены OCT26-001/S", "Выгрузка смены OCT26-001/S"]);
      view.unmount();
    }
  });

  it("opens a planned shift with its own values and its product named, and saves only after a change", async () => {
    const session = shiftsSession();
    const name = await openEdit(session, PLANNED);
    expect(
      within(dialog(name)).getByText("Товар: Вода 0,5 л. Товар смены не меняется."),
    ).toBeTruthy();
    expect(within(dialog(name)).queryByLabelText("Товар")).toBeNull();
    expect(valueOf(name, "Линия")).toBe(PLANNED.lineId);
    expect(valueOf(name, "План, шт")).toBe("");
    expect(valueOf(name, "Вместимость короба, шт")).toBe("24");
    expect(valueOf(name, "Шаблон этикетки короба")).toBe(BOX_58.id);
    expect(valueOf(name, "Контрагент")).toBe("");
    expect(
      within(dialog(name)).getByRole("button", { name: "Дата производства" }).textContent,
    ).toBe("9 октября 2026");
    // The working day is the shift's own and differs from the production date.
    expect(within(dialog(name)).getByRole("button", { name: "Дата смены" }).textContent).toBe(
      "10 октября 2026",
    );
    expect(save(name).disabled).toBe(true);
  });

  it("changes the shift's own date alone, and sends nothing else", async () => {
    const session = shiftsSession();
    session.api.updateShift.mockResolvedValue({ ...PLANNED, plannedDate: "2026-10-12", rev: 90 });
    const name = await openEdit(session, PLANNED);
    pickDate("Дата смены", "12 октября 2026");
    fireEvent.click(save(name));
    await screen.findByText("Изменения сохранены.");
    expect(session.api.updateShift).toHaveBeenCalledWith(TOKEN, PLANNED.id, {
      plannedDate: "2026-10-12",
      expectedRev: 72,
    });
  });

  it("sends only what changed with the loaded revision, then says so and reads the list again", async () => {
    const session = shiftsSession();
    session.api.updateShift.mockResolvedValue({ ...PLANNED, lineId: LINE_2.id, rev: 90 });
    const name = await openEdit(session, PLANNED);
    setField(name, "Линия", LINE_2.id);
    fireEvent.change(field(name, "План, шт"), { target: { value: "900" } });
    pickDate("Дата производства", "10 октября 2026");
    fireEvent.click(save(name));
    await screen.findByText("Изменения сохранены.");
    expect(session.api.updateShift).toHaveBeenCalledWith(TOKEN, PLANNED.id, {
      lineId: LINE_2.id,
      productionDate: "2026-10-10",
      plannedQty: 900,
      expectedRev: 72,
    });
    await waitFor(() => expect(session.api.listShifts).toHaveBeenCalledTimes(2));
  });

  it("keeps an archived line and counterparty and an unfit template as marked choices, and does not send them back", async () => {
    const shift: OfficeShift = {
      ...PLANNED,
      lineId: OLD_LINE.id,
      counterpartyId: SOUTH_ARCHIVED.id,
      boxTemplateId: OLD_BOX.id,
    };
    const session = shiftsSession([shift]);
    session.api.updateShift.mockResolvedValue({ ...shift, boxCapacity: 30, rev: 91 });
    const name = await openEdit(session, shift);
    expect(options(name, "Линия")).toEqual(["Линия 2", "Линия 10", "Линия 1 (в архиве)"]);
    expect(options(name, "Контрагент")).toEqual([
      "Не выбран",
      "ООО «Северный берег»",
      "ООО «Юг» (в архиве)",
    ]);
    expect(options(name, "Шаблон этикетки короба")).toEqual([
      "Коробка 58×40",
      "Старая коробка — не подходит",
    ]);
    fireEvent.change(field(name, "Вместимость короба, шт"), { target: { value: "30" } });
    fireEvent.click(save(name));
    await screen.findByText("Изменения сохранены.");
    expect(session.api.updateShift).toHaveBeenCalledWith(TOKEN, shift.id, {
      boxCapacity: 30,
      expectedRev: 72,
    });
  });

  it("keeps a line and a counterparty the person chose and the host then refused as marked choices the selects show", async () => {
    const session = shiftsSession();
    session.api.updateShift
      .mockRejectedValueOnce(api("validation_failed", { field: "lineId" }))
      .mockRejectedValueOnce(api("validation_failed", { field: "counterpartyId" }));
    const name = await openEdit(session, PLANNED);
    setField(name, "Линия", LINE_2.id);
    session.api.listLines.mockResolvedValue([LINE_10, { ...LINE_2, archived: true }]);
    fireEvent.click(save(name));
    await waitForList(() => expect(options(name, "Линия")).toContain("Линия 2 (в архиве)"));
    expect(shownOn(field(name, "Линия"))).toBe("Линия 2 (в архиве)");
    expect(valueOf(name, "Линия")).toBe(LINE_2.id);
    // Back to the shift's own line, and a counterparty the host then refuses.
    await waitFor(() => expect(isDisabled(field(name, "Линия"))).toBe(false));
    setField(name, "Линия", PLANNED.lineId);
    setField(name, "Контрагент", NORTH.id);
    session.api.listCounterparties.mockResolvedValue([{ ...NORTH, archived: true }]);
    fireEvent.click(save(name));
    await waitForList(() =>
      expect(options(name, "Контрагент")).toContain("ООО «Северный берег» (в архиве)"),
    );
    expect(shownOn(field(name, "Контрагент"))).toBe("ООО «Северный берег» (в архиве)");
    expect(valueOf(name, "Контрагент")).toBe(NORTH.id);
  });

  it("moves the focus to the notice once a shift is changed", async () => {
    const session = shiftsSession();
    session.api.updateShift.mockResolvedValue({ ...PLANNED, plannedQty: 900, rev: 91 });
    const name = await openEdit(session, PLANNED);
    fireEvent.change(field(name, "План, шт"), { target: { value: "900" } });
    fireEvent.click(save(name));
    await expectFocusedNotice("Изменения сохранены.");
  });

  it("clears the plan and the counterparty with null", async () => {
    const session = shiftsSession();
    const shift: OfficeShift = {
      ...PLANNED,
      plannedQty: 800,
      counterpartyId: ACTIVE.counterpartyId,
    };
    session.api.listShifts.mockResolvedValue([shift]);
    session.api.updateShift.mockResolvedValue({ ...shift, plannedQty: null, counterpartyId: null });
    const name = await openEdit(session, shift);
    fireEvent.change(field(name, "План, шт"), { target: { value: " " } });
    setField(name, "Контрагент", "");
    fireEvent.click(save(name));
    await screen.findByText("Изменения сохранены.");
    expect(session.api.updateShift).toHaveBeenCalledWith(TOKEN, shift.id, {
      plannedQty: null,
      counterpartyId: null,
      expectedRev: 72,
    });
  });

  it("offers to load the list again after a stale save, which leaves the form for the card and drops the edits", async () => {
    const session = shiftsSession();
    session.api.updateShift.mockRejectedValue(api("stale_revision", { currentRev: 95 }));
    const name = await openEdit(session, PLANNED);
    fireEvent.change(field(name, "План, шт"), { target: { value: "900" } });
    fireEvent.click(save(name));
    fireEvent.click(await within(dialog(name)).findByRole("button", { name: "Загрузить заново" }));
    await leftForCard(name);
    await waitFor(() => expect(session.api.listShifts).toHaveBeenCalledTimes(2));
    expect(session.api.updateShift).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "opened on a station meanwhile",
      api("conflict", { constraint: "shift_status", status: "active" }),
      "Смену уже открыли на станции: теперь у неё можно изменить только план. Список смен обновлён.",
    ],
    [
      "deleted meanwhile",
      api("not_found"),
      "Этой смены больше нет: её удалили. Список смен обновлён.",
    ],
  ])(
    "says a shift was %s, keeps the dialog and reads the list again",
    async (_what, refusal, text) => {
      const session = shiftsSession();
      session.api.updateShift.mockRejectedValue(refusal);
      const name = await openEdit(session, PLANNED);
      fireEvent.change(field(name, "План, шт"), { target: { value: "900" } });
      fireEvent.click(save(name));
      expect(await within(dialog(name)).findByText(text)).toBeTruthy();
      await waitFor(() => expect(session.api.listShifts).toHaveBeenCalledTimes(2));
    },
  );

  it("changes an active shift's plan alone, and clears it with null", async () => {
    const session = shiftsSession();
    session.api.updateShift.mockResolvedValue({ ...ACTIVE, plannedQty: 1500, rev: 92 });
    const name = await openPlan(session, ACTIVE);
    expect(
      within(dialog(name)).getByText(
        "Смена уже идёт на станции: у неё меняется только план. На этикетку план не попадает.",
      ),
    ).toBeTruthy();
    expect(valueOf(name, "План, шт")).toBe("1200");
    expect(save(name).disabled).toBe(true);
    fireEvent.change(field(name, "План, шт"), { target: { value: "1500" } });
    fireEvent.click(save(name));
    await screen.findByText("Изменения сохранены.");
    expect(session.api.updateShift).toHaveBeenLastCalledWith(TOKEN, ACTIVE.id, {
      plannedQty: 1500,
      expectedRev: 71,
    });
    pressRowAction(screen, "Изменить план смены OCT26-004");
    fireEvent.change(field(name, "План, шт"), { target: { value: "" } });
    fireEvent.click(save(name));
    await waitFor(() =>
      expect(session.api.updateShift).toHaveBeenLastCalledWith(TOKEN, ACTIVE.id, {
        plannedQty: null,
        expectedRev: 71,
      }),
    );
  });

  it("moves the focus to the notice once an active shift's plan is changed", async () => {
    const session = shiftsSession();
    session.api.updateShift.mockResolvedValue({ ...ACTIVE, plannedQty: 1500, rev: 92 });
    const name = await openPlan(session, ACTIVE);
    fireEvent.change(field(name, "План, шт"), { target: { value: "1500" } });
    fireEvent.click(save(name));
    await expectFocusedNotice("Изменения сохранены.");
  });

  it("refuses a plan that is no whole number from 1 to 10 000 000, and says a shift closed meanwhile", async () => {
    const session = shiftsSession();
    session.api.updateShift.mockRejectedValue(
      api("conflict", { constraint: "shift_status", status: "closed" }),
    );
    const name = await openPlan(session, ACTIVE);
    fireEvent.change(field(name, "План, шт"), { target: { value: "1,5" } });
    fireEvent.click(save(name));
    expect(
      await within(dialog(name)).findByText(
        "Укажите целое число от 1 до 10 000 000 или оставьте пустым",
      ),
    ).toBeTruthy();
    expect(session.api.updateShift).not.toHaveBeenCalled();
    // The button is busy until the refused submit has settled.
    await waitFor(() => expect(save(name).disabled).toBe(false));
    fireEvent.change(field(name, "План, шт"), { target: { value: "1300" } });
    fireEvent.click(save(name));
    expect(
      await within(dialog(name)).findByText("Смена уже закрыта. Список смен обновлён."),
    ).toBeTruthy();
    await waitFor(() => expect(session.api.listShifts).toHaveBeenCalledTimes(2));
  });
});

/** A shift the list shows after a station opened it: the planned one, active and newer. */
const OPENED: OfficeShift = {
  ...PLANNED,
  status: "active",
  ownerDeviceId: ACTIVE.ownerDeviceId,
  openedAt: ACTIVE.openedAt,
  rev: 99,
};

/** A second box template that fits every category. */
const BOX_70: typeof BOX_58 = {
  ...BOX_58,
  id: "b4c5d6e7-f8a9-4bac-9d1e-2f3a4b5c6d7e",
  name: "Коробка 70×50",
  widthMm: 70,
  heightMm: 50,
  rev: 66,
};

describe("office shifts: changing a shift, the edges", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
    freezeToday();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends every field it can change when all of them changed, trimmed, and never the product", async () => {
    const session = shiftsSession();
    session.api.listTemplates.mockResolvedValue([BOX_58, BOX_70]);
    session.api.updateShift.mockResolvedValue({ ...PLANNED, rev: 90 });
    const name = await openEdit(session, PLANNED);
    setField(name, "Линия", LINE_2.id);
    pickDate("Дата производства", "10 октября 2026");
    fireEvent.change(field(name, "План, шт"), { target: { value: " 900 " } });
    fireEvent.change(field(name, "Вместимость короба, шт"), { target: { value: " 20 " } });
    setField(name, "Шаблон этикетки короба", BOX_70.id);
    setField(name, "Контрагент", NORTH.id);
    fireEvent.click(save(name));
    await screen.findByText("Изменения сохранены.");
    expect(session.api.updateShift).toHaveBeenCalledTimes(1);
    expect(session.api.updateShift).toHaveBeenCalledWith(TOKEN, PLANNED.id, {
      lineId: LINE_2.id,
      productionDate: "2026-10-10",
      boxTemplateId: BOX_70.id,
      boxCapacity: 20,
      plannedQty: 900,
      counterpartyId: NORTH.id,
      expectedRev: 72,
    });
  });

  it("turns a planned shift's pallets on with the product's capacity and the rule's template, and off by the switch alone (plan О-Ф)", async () => {
    const session = shiftsSession();
    const withPallets: OfficeShift = {
      ...PLANNED,
      palletsEnabled: true,
      palletBoxCapacity: 40,
      palletTemplateId: PALLET.id,
    };
    session.api.updateShift.mockResolvedValue(withPallets);
    let name = await openEdit(session, PLANNED);
    fireEvent.click(within(dialog(name)).getByRole("checkbox", { name: "С паллетами" }));
    expect(valueOf(name, "Коробов на паллете")).toBe("40");
    expect(valueOf(name, "Шаблон этикетки паллеты")).toBe(PALLET.id);
    // The list read again after the save has the shift with its pallets.
    session.api.listShifts.mockResolvedValue([withPallets, ACTIVE, CLOSED]);
    fireEvent.click(save(name));
    await screen.findByText("Изменения сохранены.");
    expect(session.api.updateShift).toHaveBeenLastCalledWith(TOKEN, PLANNED.id, {
      palletsEnabled: true,
      palletBoxCapacity: 40,
      palletTemplateId: PALLET.id,
      expectedRev: 72,
    });
    await waitFor(() => expect(session.api.listShifts).toHaveBeenCalledTimes(2));
    // The card is back from the form, with the notice; «Изменить» turns it into the form again.
    name = `Смена ${PLANNED.number}`;
    fireEvent.click(
      await within(await screen.findByRole("dialog", { name })).findByRole("button", {
        name: `Изменить смену ${PLANNED.number}`,
      }),
    );
    await waitFor(() => expect(valueOf(name, "Коробов на паллете")).toBe("40"));
    fireEvent.click(within(dialog(name)).getByRole("checkbox", { name: "С паллетами" }));
    expect(within(dialog(name)).queryByLabelText("Коробов на паллете")).toBeNull();
    fireEvent.click(save(name));
    await waitFor(() =>
      expect(session.api.updateShift).toHaveBeenLastCalledWith(TOKEN, PLANNED.id, {
        palletsEnabled: false,
        expectedRev: 72,
      }),
    );
  });

  // Added by the task 8 implementer: the plan's test leaves these edges of a shift with pallets unpinned.
  it("lets a shift with pallets turn them off even when its product no longer has a pallet capacity", async () => {
    const withPallets: OfficeShift = {
      ...PLANNED,
      palletsEnabled: true,
      palletBoxCapacity: 40,
      palletTemplateId: PALLET.id,
    };
    const session = shiftsSession([withPallets, ACTIVE, CLOSED]);
    session.api.listProducts.mockResolvedValue([{ ...WATER, palletBoxCapacity: null }]);
    session.api.updateShift.mockResolvedValue(PLANNED);
    const name = await openEdit(session, withPallets);
    const pallets = within(dialog(name)).getByRole("checkbox", { name: "С паллетами" });
    expect(pallets.getAttribute("aria-checked")).toBe("true");
    expect(isDisabled(pallets)).toBe(false);
    expect(valueOf(name, "Коробов на паллете")).toBe("40");
    expect(valueOf(name, "Шаблон этикетки паллеты")).toBe(PALLET.id);
    // Nothing was changed: nothing is saved.
    expect(save(name).disabled).toBe(true);
    fireEvent.click(pallets);
    // Once off, a product without a pallet capacity cannot have them back.
    expect(isDisabled(within(dialog(name)).getByRole("checkbox", { name: "С паллетами" }))).toBe(
      true,
    );
    fireEvent.click(save(name));
    await waitFor(() =>
      expect(session.api.updateShift).toHaveBeenCalledWith(TOKEN, withPallets.id, {
        palletsEnabled: false,
        expectedRev: 72,
      }),
    );
  });

  it("sends only the pallet capacity of a shift with pallets that changed, and puts a refusal of it under its field", async () => {
    const withPallets: OfficeShift = {
      ...PLANNED,
      palletsEnabled: true,
      palletBoxCapacity: 40,
      palletTemplateId: PALLET.id,
    };
    const session = shiftsSession([withPallets, ACTIVE, CLOSED]);
    session.api.updateShift.mockRejectedValue(
      api("validation_failed", { field: "palletBoxCapacity" }),
    );
    const name = await openEdit(session, withPallets);
    fireEvent.change(field(name, "Коробов на паллете"), { target: { value: " 32 " } });
    fireEvent.click(save(name));
    await waitFor(() =>
      expect(messageOf(name, "Коробов на паллете")).toBe(
        "Хост не принял это значение. Проверьте его.",
      ),
    );
    expect(session.api.updateShift).toHaveBeenCalledWith(TOKEN, withPallets.id, {
      palletBoxCapacity: 32,
      expectedRev: 72,
    });
    // An edit of the plan alone names no pallet field.
    fireEvent.change(field(name, "Коробов на паллете"), { target: { value: "40" } });
    fireEvent.change(field(name, "План, шт"), { target: { value: "900" } });
    session.api.updateShift.mockResolvedValue(withPallets);
    fireEvent.click(save(name));
    await waitFor(() =>
      expect(session.api.updateShift).toHaveBeenLastCalledWith(TOKEN, withPallets.id, {
        plannedQty: 900,
        expectedRev: 72,
      }),
    );
  });

  it("leaves the pallet template off and says so when the templates do not load", async () => {
    const withPallets: OfficeShift = {
      ...PLANNED,
      palletsEnabled: true,
      palletBoxCapacity: 40,
      palletTemplateId: PALLET.id,
    };
    const session = shiftsSession([withPallets, ACTIVE, CLOSED]);
    session.api.listTemplates.mockRejectedValue(api("internal"));
    await openShifts(session);
    const name = await startEditing(withPallets.number);
    await waitFor(() =>
      expect(messageOf(name, "Шаблон этикетки паллеты")).toBe(
        "Список шаблонов не загрузился. Закройте окно и откройте его снова.",
      ),
    );
    expect(isDisabled(field(name, "Шаблон этикетки паллеты"))).toBe(true);
  });

  it("switches «Сохранить» off again when an edit is undone", async () => {
    const session = shiftsSession();
    const name = await openEdit(session, PLANNED);
    fireEvent.change(field(name, "План, шт"), { target: { value: "900" } });
    expect(save(name).disabled).toBe(false);
    fireEvent.change(field(name, "План, шт"), { target: { value: "" } });
    await waitFor(() => expect(save(name).disabled).toBe(true));
  });

  it("opens without the organization's profile, which a new shift's «today» alone needs", async () => {
    const session = shiftsSession();
    session.api.getOrg.mockReturnValue(new Promise(() => undefined));
    const name = await openEdit(session, PLANNED);
    expect(valueOf(name, "План, шт")).toBe("");
    // The card reads the profile for its times, but the form never waits for it: a changed
    // shift has no use for «today».
    expect(session.api.getOrg).toHaveBeenCalled();
  });

  it("lets the person go back to the shift's own marked choices after leaving them", async () => {
    const shift: OfficeShift = {
      ...PLANNED,
      lineId: OLD_LINE.id,
      counterpartyId: SOUTH_ARCHIVED.id,
      boxTemplateId: OLD_BOX.id,
    };
    const session = shiftsSession([shift]);
    session.api.updateShift.mockResolvedValue({ ...shift, rev: 91 });
    const name = await openEdit(session, shift);
    setField(name, "Линия", LINE_2.id);
    setField(name, "Контрагент", NORTH.id);
    setField(name, "Шаблон этикетки короба", BOX_58.id);
    expect(options(name, "Линия")).toContain("Линия 1 (в архиве)");
    expect(options(name, "Контрагент")).toContain("ООО «Юг» (в архиве)");
    expect(options(name, "Шаблон этикетки короба")).toContain("Старая коробка — не подходит");
    setField(name, "Линия", OLD_LINE.id);
    setField(name, "Контрагент", SOUTH_ARCHIVED.id);
    setField(name, "Шаблон этикетки короба", OLD_BOX.id);
    // Back where it began: nothing to save.
    await waitFor(() => expect(save(name).disabled).toBe(true));
  });

  it("names an archived product, and still changes the shift", async () => {
    const shift: OfficeShift = { ...PLANNED, productId: AYRAN_ARCHIVED.id };
    const session = shiftsSession([shift]);
    session.api.updateShift.mockResolvedValue({ ...shift, plannedQty: 700, rev: 90 });
    const name = await openEdit(session, shift);
    expect(
      within(dialog(name)).getByText("Товар: Айран (в архиве). Товар смены не меняется."),
    ).toBeTruthy();
    fireEvent.change(field(name, "План, шт"), { target: { value: "700" } });
    fireEvent.click(save(name));
    await screen.findByText("Изменения сохранены.");
    expect(session.api.updateShift).toHaveBeenCalledWith(TOKEN, shift.id, {
      plannedQty: 700,
      expectedRev: 72,
    });
  });

  it("says a product that is no longer in use refused the change, and reads the products again", async () => {
    const shift: OfficeShift = { ...PLANNED, productId: AYRAN_ARCHIVED.id };
    const session = shiftsSession([shift]);
    session.api.listTemplates.mockResolvedValue([BOX_58, BOX_70]);
    session.api.updateShift.mockRejectedValue(api("conflict", { constraint: "product_inactive" }));
    const name = await openEdit(session, shift);
    const productsRead = session.api.listProducts.mock.calls.length;
    setField(name, "Шаблон этикетки короба", BOX_70.id);
    fireEvent.click(save(name));
    expect(
      await within(dialog(name)).findByText(
        "Товар больше не в работе: он в архиве или стал черновиком",
      ),
    ).toBeTruthy();
    await waitFor(() =>
      expect(session.api.listProducts.mock.calls.length).toBeGreaterThan(productsRead),
    );
    // The change was sent once with the template alone; nothing else moved.
    expect(session.api.updateShift).toHaveBeenCalledTimes(1);
    expect(session.api.updateShift).toHaveBeenCalledWith(TOKEN, shift.id, {
      boxTemplateId: BOX_70.id,
      expectedRev: 72,
    });
  });

  it("says under the product that a shift of an archived or draft product will not open", async () => {
    for (const [product, text] of [
      [AYRAN_ARCHIVED, "Не откроется: товар в архиве"],
      [KEFIR_DRAFT, "Не откроется: товар — черновик"],
    ] as const) {
      const shift: OfficeShift = { ...PLANNED, productId: product.id };
      const view = await openShifts(shiftsSession([shift]));
      const name = await startEditing(shift.number);
      expect(await within(dialog(name)).findByText(text)).toBeTruthy();
      view.unmount();
    }
    const name = await openEdit(shiftsSession(), PLANNED);
    expect(within(dialog(name)).queryByText(/Не откроется/)).toBeNull();
  });

  it("names a line, counterparty and template the lists lack by their ids, as choices", async () => {
    const shift: OfficeShift = {
      ...PLANNED,
      lineId: "11111111-2222-4333-8444-555555555555",
      counterpartyId: "22222222-3333-4444-8555-666666666666",
      boxTemplateId: "33333333-4444-4555-8666-777777777777",
    };
    const session = shiftsSession([shift]);
    const name = await openEdit(session, shift);
    expect(options(name, "Линия")).toEqual(["Линия 2", "Линия 10", "Линия 11111111…"]);
    expect(options(name, "Контрагент")).toEqual([
      "Не выбран",
      "ООО «Северный берег»",
      "Контрагент 22222222…",
    ]);
    expect(options(name, "Шаблон этикетки короба")).toEqual([
      "Коробка 58×40",
      "Шаблон 33333333… — нет в списке",
    ]);
    expect(valueOf(name, "Линия")).toBe(shift.lineId);
    expect(valueOf(name, "Контрагент")).toBe(shift.counterpartyId);
    expect(valueOf(name, "Шаблон этикетки короба")).toBe(shift.boxTemplateId);
  });

  it("keeps the shift's own choices, off, and says so when the lists do not load", async () => {
    const shift: OfficeShift = { ...PLANNED, counterpartyId: NORTH.id };
    const session = shiftsSession([shift]);
    session.api.listProducts.mockRejectedValue(api("internal"));
    session.api.listLines.mockRejectedValue(api("internal"));
    session.api.listCounterparties.mockRejectedValue(api("internal"));
    await openShifts(session);
    const name = await startEditing(shift.number);
    await waitFor(() =>
      expect(messageOf(name, "Контрагент")).toBe(
        "Список контрагентов не загрузился: контрагент смены не меняется.",
      ),
    );
    await waitFor(() =>
      expect(messageOf(name, "Шаблон этикетки короба")).toBe(
        "Список товаров не загрузился. Закройте окно и откройте его снова.",
      ),
    );
    await waitFor(() =>
      expect(messageOf(name, "Линия")).toBe(
        "Список линий не загрузился. Закройте окно и откройте его снова.",
      ),
    );
    expect(
      within(dialog(name)).getByText("Товар: Товар 2b3c4d5e…. Товар смены не меняется."),
    ).toBeTruthy();
    expect(options(name, "Линия")).toEqual(["Линия 0b7e7dcb…"]);
    expect(options(name, "Контрагент")).toEqual(["Не выбран", "Контрагент d2b7c9e1…"]);
    expect(options(name, "Шаблон этикетки короба")).toEqual(["Коробка 58×40"]);
    for (const label of ["Линия", "Шаблон этикетки короба", "Контрагент"]) {
      expect(isDisabled(field(name, label))).toBe(true);
      expect(valueOf(name, label)).not.toBe("");
    }
    expect(valueOf(name, "Контрагент")).toBe(NORTH.id);
  });

  it("asks before «Отмена» drops what was typed, then shows the card, sends nothing and opens the form on the shift's own values", async () => {
    const session = shiftsSession();
    const name = await openEdit(session, PLANNED);
    fireEvent.change(field(name, "План, шт"), { target: { value: "900" } });
    fireEvent.click(within(dialog(name)).getByRole("button", { name: "Отмена" }));
    // Typed and not saved: the question first, and answering «Вернуться» keeps the form as it was.
    const question = await screen.findByRole("alertdialog", { name: "Закрыть без сохранения?" });
    fireEvent.click(within(question).getByRole("button", { name: "Вернуться к правке" }));
    expect(valueOf(name, "План, шт")).toBe("900");
    fireEvent.click(within(dialog(name)).getByRole("button", { name: "Отмена" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog", { name: "Закрыть без сохранения?" })).getByRole(
        "button",
        { name: "Закрыть без сохранения" },
      ),
    );
    // The card is back (read-only), not the list: the shift's fields are text again.
    await within(dialog(name)).findByRole("button", { name: `Изменить смену ${PLANNED.number}` });
    expect(within(dialog(name)).queryByLabelText("План, шт")).toBeNull();
    expect(session.api.updateShift).not.toHaveBeenCalled();
    fireEvent.click(
      within(dialog(name)).getByRole("button", { name: `Изменить смену ${PLANNED.number}` }),
    );
    await within(dialog(name)).findByRole("button", { name: "Сохранить" });
    expect(valueOf(name, "План, шт")).toBe("");
    expect(save(name).disabled).toBe(true);
  });

  it("goes back to the card from an untouched form without asking, and closes the drawer from the × only after asking when something was typed", async () => {
    const session = shiftsSession();
    const name = await openEdit(session, PLANNED);
    fireEvent.click(within(dialog(name)).getByRole("button", { name: "Отмена" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await within(dialog(name)).findByRole("button", { name: `Изменить смену ${PLANNED.number}` });
    fireEvent.click(
      within(dialog(name)).getByRole("button", { name: `Изменить смену ${PLANNED.number}` }),
    );
    await within(dialog(name)).findByRole("button", { name: "Сохранить" });
    fireEvent.change(field(name, "План, шт"), { target: { value: "900" } });
    fireEvent.click(within(dialog(name)).getByRole("button", { name: "Закрыть карточку смены" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog", { name: "Закрыть без сохранения?" })).getByRole(
        "button",
        { name: "Закрыть без сохранения" },
      ),
    );
    expect(screen.queryByRole("dialog", { name })).toBeNull();
    expect(session.api.updateShift).not.toHaveBeenCalled();
  });

  it("puts a line the host refused under the line, with the focus, and reads the lines again", async () => {
    const session = shiftsSession();
    session.api.updateShift.mockRejectedValue(api("validation_failed", { field: "lineId" }));
    const name = await openEdit(session, PLANNED);
    const linesRead = session.api.listLines.mock.calls.length;
    setField(name, "Линия", LINE_2.id);
    fireEvent.click(save(name));
    await waitFor(() => expect(messageOf(name, "Линия")).toBe("Линия в архиве. Выберите другую."));
    await waitFor(() => expect(document.activeElement).toBe(field(name, "Линия")));
    await waitFor(() => expect(session.api.listLines.mock.calls.length).toBeGreaterThan(linesRead));
  });

  it("holds every control while the change is on its way, frees them after a refusal and sends again", async () => {
    const session = shiftsSession();
    let fail: (error: unknown) => void = () => undefined;
    session.api.updateShift.mockReturnValueOnce(
      new Promise<OfficeShift>((_resolve, reject) => {
        fail = reject;
      }),
    );
    const name = await openEdit(session, PLANNED);
    fireEvent.change(field(name, "План, шт"), { target: { value: "900" } });
    fireEvent.click(save(name));
    await waitFor(() => expect(session.api.updateShift).toHaveBeenCalledTimes(1));
    const controls = (): HTMLElement[] => [
      field(name, "Линия"),
      within(dialog(name)).getByRole("button", { name: "Дата производства" }),
      field(name, "План, шт"),
      field(name, "Вместимость короба, шт"),
      field(name, "Шаблон этикетки короба"),
      field(name, "Контрагент"),
    ];
    await waitFor(() => expect(controls().map(isDisabled)).toEqual(Array(6).fill(true)));
    expect(isDisabled(within(dialog(name)).getByRole("button", { name: "Отмена" }))).toBe(true);
    await act(async () => {
      fail(api("internal"));
      await Promise.resolve();
    });
    await waitFor(() => expect(controls().map(isDisabled)).toEqual(Array(6).fill(false)));
    expect(await within(dialog(name)).findByRole("alert")).toBeTruthy();
    // What was typed stays, and a second try goes out with the same revision.
    expect(valueOf(name, "План, шт")).toBe("900");
    session.api.updateShift.mockResolvedValueOnce({ ...PLANNED, plannedQty: 900, rev: 90 });
    fireEvent.click(save(name));
    await screen.findByText("Изменения сохранены.");
    expect(session.api.updateShift).toHaveBeenNthCalledWith(2, TOKEN, PLANNED.id, {
      plannedQty: 900,
      expectedRev: 72,
    });
  });

  it("reads the shifts again behind the dialog after a lost answer", async () => {
    const session = shiftsSession();
    session.api.updateShift.mockRejectedValue(
      new HostError({ kind: "transport", code: "unreachable", message: "x" }),
    );
    const name = await openEdit(session, PLANNED);
    fireEvent.change(field(name, "План, шт"), { target: { value: "900" } });
    fireEvent.click(save(name));
    expect(await within(dialog(name)).findByRole("alert")).toBeTruthy();
    await waitFor(() => expect(session.api.listShifts).toHaveBeenCalledTimes(2));
  });

  it("keeps the revision it was opened with when the list behind it is read again", async () => {
    const session = shiftsSession();
    session.api.updateShift.mockRejectedValue(
      new HostError({ kind: "transport", code: "unreachable", message: "x" }),
    );
    const name = await openEdit(session, PLANNED);
    // The list read after the lost answer shows the shift opened, with a newer revision.
    session.api.listShifts.mockResolvedValue([OPENED, ACTIVE, CLOSED]);
    fireEvent.change(field(name, "План, шт"), { target: { value: "900" } });
    fireEvent.click(save(name));
    expect(await within(dialog(name)).findByRole("alert")).toBeTruthy();
    await waitFor(() =>
      expect(within(shiftRow(PLANNED.number)).getByText("Активна", { exact: false })).toBeTruthy(),
    );
    await waitFor(() => expect(save(name).disabled).toBe(false));
    fireEvent.click(save(name));
    await waitFor(() => expect(session.api.updateShift).toHaveBeenCalledTimes(2));
    expect(session.api.updateShift).toHaveBeenNthCalledWith(2, TOKEN, PLANNED.id, {
      plannedQty: 900,
      expectedRev: 72,
    });
  });

  it("sends nothing and closes without a word when the form differs from the shift in blanks only", async () => {
    const session = shiftsSession();
    const name = await openEdit(session, PLANNED);
    // A space in an empty plan: the form is changed, the shift is not.
    fireEvent.change(field(name, "План, шт"), { target: { value: " " } });
    await waitFor(() => expect(save(name).disabled).toBe(false));
    fireEvent.click(save(name));
    await leftForCard(name);
    expect(session.api.updateShift).not.toHaveBeenCalled();
    expect(screen.queryByText("Изменения сохранены.")).toBeNull();
    expect(session.api.listShifts).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "opened on a station meanwhile",
      api("conflict", { constraint: "shift_status", status: "active" }),
    ],
    ["deleted meanwhile", api("not_found")],
  ])(
    "switches «Сохранить» off and offers to load the list again once a shift was %s",
    async (_what, refusal) => {
      const session = shiftsSession();
      session.api.updateShift.mockRejectedValue(refusal);
      const name = await openEdit(session, PLANNED);
      fireEvent.change(field(name, "План, шт"), { target: { value: "900" } });
      fireEvent.click(save(name));
      const reload = await within(dialog(name)).findByRole("button", {
        name: "Загрузить заново",
      });
      await waitFor(() => expect(session.api.listShifts).toHaveBeenCalledTimes(2));
      expect(save(name).disabled).toBe(true);
      // What was typed stays to be read; the way out is the alert's button.
      expect(valueOf(name, "План, шт")).toBe("900");
      fireEvent.click(reload);
      await leftForCard(name);
      expect(session.api.updateShift).toHaveBeenCalledTimes(1);
    },
  );

  it("does not take the answer of a new shift's missing record for a deleted shift", async () => {
    const session = shiftsSession();
    session.api.createShift.mockRejectedValue(api("not_found"));
    await openShifts(session);
    fireEvent.click(screen.getByRole("button", { name: "Запланировать смену" }));
    const name = "Новая смена";
    await screen.findByRole("dialog", { name });
    await waitFor(() => expect(isDisabled(field(name, "Товар"))).toBe(false));
    setField(name, "Товар", WATER.id);
    setField(name, "Линия", LINE_2.id);
    fireEvent.click(within(dialog(name)).getByRole("button", { name: "Запланировать" }));
    expect(await within(dialog(name)).findByRole("alert")).toBeTruthy();
    expect(within(dialog(name)).queryByText(/Этой смены больше нет/)).toBeNull();
    // The shifts were read once, on opening: a new shift's refusal leaves the list alone.
    expect(session.api.listShifts).toHaveBeenCalledTimes(1);
  });
});

describe("office shifts: changing an active shift's plan, the edges", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
    freezeToday();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts empty for a shift without a plan and sends the first plan alone", async () => {
    const shift: OfficeShift = { ...ACTIVE, plannedQty: null };
    const session = shiftsSession([shift]);
    session.api.updateShift.mockResolvedValue({ ...shift, plannedQty: 700, rev: 92 });
    const name = await openPlan(session, shift);
    expect(valueOf(name, "План, шт")).toBe("");
    expect(messageOf(name, "План, шт")).toBe("Пусто — без плана");
    expect(save(name).disabled).toBe(true);
    fireEvent.change(field(name, "План, шт"), { target: { value: " 700 " } });
    fireEvent.click(save(name));
    await screen.findByText("Изменения сохранены.");
    expect(session.api.updateShift).toHaveBeenCalledWith(TOKEN, shift.id, {
      plannedQty: 700,
      expectedRev: 71,
    });
  });

  it("puts the focus on a plan it refuses, and sends nothing", async () => {
    const session = shiftsSession();
    const name = await openPlan(session, ACTIVE);
    fireEvent.change(field(name, "План, шт"), { target: { value: "0" } });
    fireEvent.click(save(name));
    await within(dialog(name)).findByText(
      "Укажите целое число от 1 до 10 000 000 или оставьте пустым",
    );
    await waitFor(() => expect(document.activeElement).toBe(field(name, "План, шт")));
    expect(session.api.updateShift).not.toHaveBeenCalled();
  });

  it("puts a plan the host refused under the field, with the focus", async () => {
    const session = shiftsSession();
    session.api.updateShift.mockRejectedValue(api("validation_failed", { field: "plannedQty" }));
    const name = await openPlan(session, ACTIVE);
    fireEvent.change(field(name, "План, шт"), { target: { value: "900" } });
    fireEvent.click(save(name));
    await waitFor(() =>
      expect(messageOf(name, "План, шт")).toBe("Хост не принял это значение. Проверьте его."),
    );
    await waitFor(() => expect(document.activeElement).toBe(field(name, "План, шт")));
  });

  it("holds the plan and «Отмена» while the change is on its way, then gives the plan back", async () => {
    const session = shiftsSession();
    let fail: (error: unknown) => void = () => undefined;
    session.api.updateShift.mockReturnValueOnce(
      new Promise<OfficeShift>((_resolve, reject) => {
        fail = reject;
      }),
    );
    const name = await openPlan(session, ACTIVE);
    fireEvent.change(field(name, "План, шт"), { target: { value: "900" } });
    fireEvent.click(save(name));
    await waitFor(() => expect(session.api.updateShift).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((field(name, "План, шт") as HTMLInputElement).readOnly).toBe(true));
    expect(isDisabled(within(dialog(name)).getByRole("button", { name: "Отмена" }))).toBe(true);
    await act(async () => {
      fail(api("internal"));
      await Promise.resolve();
    });
    await waitFor(() => expect((field(name, "План, шт") as HTMLInputElement).readOnly).toBe(false));
    expect(await within(dialog(name)).findByRole("alert")).toBeTruthy();
    expect(valueOf(name, "План, шт")).toBe("900");
  });

  it("offers to load the list again after a stale change, which closes the dialog and drops the edit", async () => {
    const session = shiftsSession();
    session.api.updateShift.mockRejectedValue(api("stale_revision", { currentRev: 95 }));
    const name = await openPlan(session, ACTIVE);
    fireEvent.change(field(name, "План, шт"), { target: { value: "900" } });
    fireEvent.click(save(name));
    fireEvent.click(await within(dialog(name)).findByRole("button", { name: "Загрузить заново" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name })).toBeNull());
    await waitFor(() => expect(session.api.listShifts).toHaveBeenCalledTimes(2));
    expect(session.api.updateShift).toHaveBeenCalledTimes(1);
  });

  it("says a shift was deleted meanwhile, keeps the dialog and reads the list again", async () => {
    const session = shiftsSession();
    session.api.updateShift.mockRejectedValue(api("not_found"));
    const name = await openPlan(session, ACTIVE);
    fireEvent.change(field(name, "План, шт"), { target: { value: "900" } });
    fireEvent.click(save(name));
    expect(
      await within(dialog(name)).findByText(
        "Этой смены больше нет: её удалили. Список смен обновлён.",
      ),
    ).toBeTruthy();
    await waitFor(() => expect(session.api.listShifts).toHaveBeenCalledTimes(2));
  });

  it("reads the list again after a lost answer, since the plan may have been changed", async () => {
    const session = shiftsSession();
    session.api.updateShift.mockRejectedValue(
      new HostError({ kind: "transport", code: "unreachable", message: "x" }),
    );
    const name = await openPlan(session, ACTIVE);
    fireEvent.change(field(name, "План, шт"), { target: { value: "900" } });
    fireEvent.click(save(name));
    expect(await within(dialog(name)).findByRole("alert")).toBeTruthy();
    await waitFor(() => expect(session.api.listShifts).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("dialog", { name })).toBeTruthy();
    expect(valueOf(name, "План, шт")).toBe("900");
  });

  it("leaves the list alone after an answer of the host that changed nothing", async () => {
    const session = shiftsSession();
    session.api.updateShift.mockRejectedValue(api("internal"));
    const name = await openPlan(session, ACTIVE);
    fireEvent.change(field(name, "План, шт"), { target: { value: "900" } });
    fireEvent.click(save(name));
    expect(await within(dialog(name)).findByRole("alert")).toBeTruthy();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(session.api.listShifts).toHaveBeenCalledTimes(1);
  });

  it("sends nothing and closes without a word when the plan differs from the shift in blanks only", async () => {
    const session = shiftsSession();
    const name = await openPlan(session, ACTIVE);
    fireEvent.change(field(name, "План, шт"), { target: { value: " 1200 " } });
    await waitFor(() => expect(save(name).disabled).toBe(false));
    fireEvent.click(save(name));
    await waitFor(() => expect(screen.queryByRole("dialog", { name })).toBeNull());
    expect(session.api.updateShift).not.toHaveBeenCalled();
    expect(screen.queryByText("Изменения сохранены.")).toBeNull();
    expect(session.api.listShifts).toHaveBeenCalledTimes(1);
  });

  it("switches «Сохранить» off and offers to load the list again once the shift was closed", async () => {
    const session = shiftsSession();
    session.api.updateShift.mockRejectedValue(
      api("conflict", { constraint: "shift_status", status: "closed" }),
    );
    const name = await openPlan(session, ACTIVE);
    fireEvent.change(field(name, "План, шт"), { target: { value: "900" } });
    fireEvent.click(save(name));
    const reload = await within(dialog(name)).findByRole("button", { name: "Загрузить заново" });
    await waitFor(() => expect(session.api.listShifts).toHaveBeenCalledTimes(2));
    expect(save(name).disabled).toBe(true);
    fireEvent.click(reload);
    await waitFor(() => expect(screen.queryByRole("dialog", { name })).toBeNull());
    expect(session.api.updateShift).toHaveBeenCalledTimes(1);
  });
});

describe("office shifts: changing the A4 sheet of a planned shift (plan А4)", () => {
  const SHEETS = stockSheets();
  const [PORTRAIT, LANDSCAPE, TWO_A5] = SHEETS.sheets as [
    (typeof SHEETS.sheets)[number],
    (typeof SHEETS.sheets)[number],
    (typeof SHEETS.sheets)[number],
  ];
  const WITH_PALLETS: OfficeShift = {
    ...PLANNED,
    palletsEnabled: true,
    palletBoxCapacity: 40,
    palletTemplateId: PALLET.id,
  };
  const WITH_SHEET: OfficeShift = { ...WITH_PALLETS, palletSheetTemplateId: LANDSCAPE.id };

  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
    freezeToday();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function sessionWith(shift: OfficeShift, sheets = SHEETS): FakeOfficeSession {
    const session = shiftsSession([shift, ACTIVE, CLOSED]);
    session.api.listPalletSheets.mockResolvedValue(sheets);
    session.api.updateShift.mockResolvedValue(shift);
    return session;
  }

  it("shows the sheet the shift holds, offers «main» to it too, and sends nothing for it unchanged", async () => {
    const session = sessionWith(WITH_SHEET);
    const name = await openEdit(session, WITH_SHEET);
    await waitForList(() =>
      expect(options(name, "Лист А4")).toEqual([
        "По умолчанию для товара (Палета А4 · вертикальная)",
        "Палета А4 · вертикальная",
        "Палета А4 · горизонтальная",
        "Палета А4 · две одинаковые А5",
      ]),
    );
    expect(valueOf(name, "Лист А4")).toBe(LANDSCAPE.id);
    expect(save(name).disabled).toBe(true);
    // A change of the plan names no sheet.
    fireEvent.change(field(name, "План, шт"), { target: { value: "900" } });
    fireEvent.click(save(name));
    await waitFor(() =>
      expect(session.api.updateShift).toHaveBeenCalledWith(TOKEN, WITH_SHEET.id, {
        plannedQty: 900,
        expectedRev: 72,
      }),
    );
  });

  it("sends the other sheet that was chosen, with nothing else", async () => {
    const session = sessionWith(WITH_SHEET);
    const name = await openEdit(session, WITH_SHEET);
    await waitForList(() => expect(options(name, "Лист А4")).toHaveLength(4));
    setField(name, "Лист А4", TWO_A5.id);
    fireEvent.click(save(name));
    await waitFor(() =>
      expect(session.api.updateShift).toHaveBeenCalledWith(TOKEN, WITH_SHEET.id, {
        palletSheetTemplateId: TWO_A5.id,
        expectedRev: 72,
      }),
    );
  });

  it("keeps a sheet that was switched off after the shift was planned, marked, and does not ask to change it", async () => {
    const off = { ...SHEETS, sheets: [PORTRAIT, { ...LANDSCAPE, enabled: false }, TWO_A5] };
    const session = sessionWith(WITH_SHEET, off);
    const name = await openEdit(session, WITH_SHEET);
    await waitForList(() =>
      expect(options(name, "Лист А4")).toContain("Палета А4 · горизонтальная (выключен)"),
    );
    expect(valueOf(name, "Лист А4")).toBe(LANDSCAPE.id);
    expect(options(name, "Лист А4")).toHaveLength(4);
    expect(save(name).disabled).toBe(true);
  });

  it("names a sheet that is not in the list by the start of its id, so the select never shows another", async () => {
    const gone = { ...SHEETS, sheets: [PORTRAIT, TWO_A5] };
    const session = sessionWith(WITH_SHEET, gone);
    const name = await openEdit(session, WITH_SHEET);
    await waitForList(() =>
      expect(options(name, "Лист А4")).toContain(`Лист ${LANDSCAPE.id.slice(0, 8)}`),
    );
    expect(valueOf(name, "Лист А4")).toBe(LANDSCAPE.id);
  });

  it("offers «main» to a shift with pallets that has no sheet, and a chosen sheet goes alone", async () => {
    const session = sessionWith(WITH_PALLETS);
    const name = await openEdit(session, WITH_PALLETS);
    await waitForList(() =>
      expect(options(name, "Лист А4")[0]).toBe(
        "По умолчанию для товара (Палета А4 · вертикальная)",
      ),
    );
    expect(valueOf(name, "Лист А4")).toBe("");
    expect(save(name).disabled).toBe(true);
    setField(name, "Лист А4", PORTRAIT.id);
    fireEvent.click(save(name));
    await waitFor(() =>
      expect(session.api.updateShift).toHaveBeenCalledWith(TOKEN, WITH_PALLETS.id, {
        palletSheetTemplateId: PORTRAIT.id,
        expectedRev: 72,
      }),
    );
  });

  it("sends the sheet with the pallets a planned shift turns on", async () => {
    const session = sessionWith(PLANNED);
    const name = await openEdit(session, PLANNED);
    fireEvent.click(within(dialog(name)).getByRole("checkbox", { name: "С паллетами" }));
    await waitForList(() => expect(options(name, "Лист А4")).toHaveLength(4));
    setField(name, "Лист А4", TWO_A5.id);
    fireEvent.click(save(name));
    await waitFor(() =>
      expect(session.api.updateShift).toHaveBeenLastCalledWith(TOKEN, PLANNED.id, {
        palletsEnabled: true,
        palletBoxCapacity: 40,
        palletTemplateId: PALLET.id,
        palletSheetTemplateId: TWO_A5.id,
        expectedRev: 72,
      }),
    );
  });

  it("sends no sheet with the pallets a planned shift turns on when «main» stays", async () => {
    const session = sessionWith(PLANNED);
    const name = await openEdit(session, PLANNED);
    fireEvent.click(within(dialog(name)).getByRole("checkbox", { name: "С паллетами" }));
    await waitForList(() => expect(options(name, "Лист А4")).toHaveLength(4));
    expect(valueOf(name, "Лист А4")).toBe("");
    fireEvent.click(save(name));
    await waitFor(() =>
      expect(session.api.updateShift).toHaveBeenLastCalledWith(TOKEN, PLANNED.id, {
        palletsEnabled: true,
        palletBoxCapacity: 40,
        palletTemplateId: PALLET.id,
        expectedRev: 72,
      }),
    );
  });

  it("sends a shift that holds a sheet back to «main» as `null`, with nothing else", async () => {
    const session = sessionWith(WITH_SHEET);
    const name = await openEdit(session, WITH_SHEET);
    await waitForList(() => expect(options(name, "Лист А4")).toHaveLength(4));
    setField(name, "Лист А4", "");
    expect(valueOf(name, "Лист А4")).toBe("");
    fireEvent.click(save(name));
    await waitFor(() =>
      expect(session.api.updateShift).toHaveBeenCalledWith(TOKEN, WITH_SHEET.id, {
        palletSheetTemplateId: null,
        expectedRev: 72,
      }),
    );
  });

  it("sends no sheet when the pallets are turned off", async () => {
    const session = sessionWith(WITH_SHEET);
    const name = await openEdit(session, WITH_SHEET);
    await waitForList(() => expect(options(name, "Лист А4")).toHaveLength(4));
    fireEvent.click(within(dialog(name)).getByRole("checkbox", { name: "С паллетами" }));
    expect(within(dialog(name)).queryByLabelText("Лист А4")).toBeNull();
    fireEvent.click(save(name));
    await waitFor(() =>
      expect(session.api.updateShift).toHaveBeenCalledWith(TOKEN, WITH_SHEET.id, {
        palletsEnabled: false,
        expectedRev: 72,
      }),
    );
  });

  it("puts a refused sheet under its select and reads the sheets again", async () => {
    const session = sessionWith(WITH_SHEET);
    session.api.updateShift.mockRejectedValue(
      api("validation_failed", { field: "palletSheetTemplateId" }),
    );
    const name = await openEdit(session, WITH_SHEET);
    await waitForList(() => expect(options(name, "Лист А4")).toHaveLength(4));
    setField(name, "Лист А4", TWO_A5.id);
    // The card and the form share the list; only the refusal reads it once more.
    const readBefore = session.api.listPalletSheets.mock.calls.length;
    fireEvent.click(save(name));
    await waitFor(() =>
      expect(messageOf(name, "Лист А4")).toBe(
        "Лист выключен, удалён или не подходит смене. Выберите другой.",
      ),
    );
    await waitFor(() =>
      expect(session.api.listPalletSheets.mock.calls.length).toBeGreaterThan(readBefore),
    );
  });
});
