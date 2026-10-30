import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TECHNOLOGIST } from "./support/office.js";
import {
  ACTIVE,
  CLOSED,
  freezeToday,
  openShifts,
  PALLET,
  PLANNED,
  shiftRow,
  shiftsSession,
  startEditing,
  WATER,
} from "./support/shifts.js";
import { findRowAction } from "./support/row-menu.js";

// Owner feedback after beta 3.2: «Изменить» in the list becomes «Открыть»; the card shows the
// shift's data read-only, «Изменить» in it turns the same drawer into the form; planning a new
// shift is a drawer too.

beforeEach(() => {
  localStorage.removeItem("markiro.theme");
  freezeToday();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("office shifts: the list's «Открыть» and the card's «Изменить»", () => {
  it("offers a planned shift «Открыть» and «Удалить» to both roles, and no «Изменить» in the list", async () => {
    for (const user of [undefined, TECHNOLOGIST]) {
      const view = await openShifts(shiftsSession(undefined, user));
      const row = shiftRow("OCT26-005");
      expect(
        within(row)
          .getAllByRole("button")
          .map((button) => button.getAttribute("aria-label")),
      ).toEqual(["Открыть смену OCT26-005", "Действия: OCT26-005"]);
      expect(findRowAction(within(row), "Удалить смену OCT26-005").textContent).toBe("Удалить");
      expect(screen.queryByRole("button", { name: /^Изменить смену/ })).toBeNull();
      view.unmount();
    }
  });

  it("opens the card on «Открыть» with the shift's data as text: product, line, both dates, plan, mode, counterparty, templates", async () => {
    const shift = { ...PLANNED, counterpartyId: ACTIVE.counterpartyId, plannedQty: 800 };
    await openShifts(shiftsSession([shift, ACTIVE, CLOSED]));
    fireEvent.click(screen.getByRole("button", { name: "Открыть смену OCT26-005" }));
    const dialog = await screen.findByRole("dialog", { name: "Смена OCT26-005" });
    await within(dialog).findByText(WATER.name);
    const facts = Object.fromEntries(
      within(dialog)
        .getAllByRole("term")
        .map((term) => [term.textContent ?? "", term.nextElementSibling?.textContent ?? ""]),
    );
    expect(facts).toMatchObject({
      Товар: WATER.name,
      "Дата смены": "10.10.2026",
      "Дата производства": "09.10.2026",
      Режим: "Агрегация",
      "План, шт": "800",
      "Вместимость короба, шт": "24",
      "Шаблон этикетки короба": "Коробка 58×40",
    });
    expect(facts["Контрагент"]).not.toBe("—");
    // Text, not fields: nothing is editable until «Изменить».
    expect(within(dialog).queryByLabelText("План, шт")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Сохранить" })).toBeNull();
    expect(
      within(dialog).getByRole("button", { name: "Изменить смену OCT26-005" }).textContent,
    ).toBe("Изменить");
  });

  it("shows the pallet template and the A4 sheet of a planned shift with pallets", async () => {
    const shift = {
      ...PLANNED,
      palletsEnabled: true,
      palletBoxCapacity: 40,
      palletTemplateId: PALLET.id,
      palletSheetTemplateId: null,
    };
    await openShifts(shiftsSession([shift, ACTIVE, CLOSED]));
    fireEvent.click(screen.getByRole("button", { name: "Открыть смену OCT26-005" }));
    const dialog = await screen.findByRole("dialog", { name: "Смена OCT26-005" });
    await within(dialog).findByText("Паллета 100×150");
    const facts = Object.fromEntries(
      within(dialog)
        .getAllByRole("term")
        .map((term) => [term.textContent ?? "", term.nextElementSibling?.textContent ?? ""]),
    );
    expect(facts["Шаблон палета"]).toBe("Паллета 100×150");
    expect(facts["Лист палета А4"]).toBe("По умолчанию (стандартный лист)");
  });

  it.each([
    ["active", ACTIVE],
    ["closed", CLOSED],
  ])(
    "offers no «Изменить» in the card of a shift that is %s: its fields are fixed once planned",
    async (_status, shift) => {
      await openShifts(shiftsSession([PLANNED, ACTIVE, CLOSED]));
      fireEvent.click(screen.getByText(shift.number));
      const dialog = await screen.findByRole("dialog", { name: `Смена ${shift.number}` });
      await within(dialog).findByRole("tablist");
      expect(within(dialog).queryByRole("button", { name: /^Изменить смену/ })).toBeNull();
    },
  );

  it("turns the same drawer into the form on «Изменить», with «Сохранить» and «Отмена» in its footer, and back to the card with the notice after saving", async () => {
    const session = shiftsSession();
    session.api.updateShift.mockResolvedValue({ ...PLANNED, plannedQty: 900, rev: 90 });
    await openShifts(session);
    const name = await startEditing("OCT26-005");
    const drawer = screen.getByRole("dialog", { name });
    // One drawer: it is the same dialog, now with the fields and the footer.
    expect(within(drawer).getByLabelText("План, шт")).toBeTruthy();
    expect(within(drawer).getByRole("button", { name: "Отмена" })).toBeTruthy();
    expect(
      (within(drawer).getByRole("button", { name: "Сохранить" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.change(within(drawer).getByLabelText("План, шт"), { target: { value: "900" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "Сохранить" }));
    await within(drawer).findByRole("button", { name: "Изменить смену OCT26-005" });
    expect(session.api.updateShift).toHaveBeenCalledWith("office-session-token", PLANNED.id, {
      plannedQty: 900,
      expectedRev: 72,
    });
    expect(
      await within(screen.getByRole("dialog", { name })).findByText("Изменения сохранены."),
    ).toBeTruthy();
    expect(within(screen.getByRole("dialog", { name })).queryByLabelText("План, шт")).toBeNull();
  });
});

describe("office shifts: planning a new shift in a drawer", () => {
  it("opens «Запланировать смену» as a side drawer with the fields and the footer, not a modal", async () => {
    await openShifts(shiftsSession());
    fireEvent.click(screen.getByRole("button", { name: "Запланировать смену" }));
    await screen.findByRole("dialog", { name: "Новая смена" });
    // The drawer waits for the organization's profile, then shows the form: read the dialog anew.
    const product = () =>
      within(screen.getByRole("dialog", { name: "Новая смена" })).getByLabelText("Товар");
    await waitFor(() => expect((product() as HTMLButtonElement).disabled).toBe(false));
    const drawer = screen.getByRole("dialog", { name: "Новая смена" });
    // The drawer is the side panel of @markiro/ui, as every other record's, with its footer.
    expect(drawer.className).toMatch(/side-panel/);
    expect(within(drawer).getByRole("button", { name: "Запланировать" })).toBeTruthy();
    expect(within(drawer).getByRole("button", { name: "Отмена" })).toBeTruthy();
  });
});
