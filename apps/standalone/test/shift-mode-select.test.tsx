import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OfficeShift } from "../src/host/protocol.js";
import { createOfficeQueryClient } from "../src/office/office-query.js";
import { OfficeSessionProvider } from "../src/office/office-session.js";
import { ShiftDialog } from "../src/office/shifts/ShiftDialog.js";
import {
  ACTIVE,
  freezeToday,
  LINE_2,
  MILK,
  MILK_BOX,
  NO_TOTALS,
  NORTH,
  openShifts,
  PALLET,
  PLANNED,
  shiftsSession,
} from "./support/shifts.js";

const TOKEN = "office-session-token";
const NEW = "Новая смена";
const VALIDATION_HINT = "В режиме проверки этикетки коробов не печатаются";

/** The shift the host answers a plan with. */
const CREATED: OfficeShift = {
  ...ACTIVE,
  id: "5a3d9c7f-1b6c-4e8d-9f2a-7c0b3d6e9f1a",
  number: "OCT26-006",
  status: "planned",
  ownerDeviceId: null,
  openedAt: null,
  totals: NO_TOTALS,
};

function dialog(name: string): HTMLElement {
  return screen.getByRole("dialog", { name });
}

function field(name: string, label: string): HTMLElement {
  return within(dialog(name)).getByLabelText(label);
}

function set(name: string, label: string, value: string): void {
  fireEvent.change(field(name, label), { target: { value } });
}

function valueOf(name: string, label: string): string {
  const control = field(name, label);
  if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement)) {
    throw new Error(`${label} holds no value`);
  }
  return control.value;
}

/** The message under the control labelled `label`, by its `aria-describedby`. */
function messageOf(name: string, label: string): string | null | undefined {
  const id = field(name, label).getAttribute("aria-describedby");
  return id === null ? undefined : document.getElementById(id)?.textContent;
}

function modes(name: string): HTMLElement {
  return within(dialog(name)).getByRole("radiogroup", { name: "Режим работы" });
}

function mode(name: string, label: "Проверка" | "Агрегация"): HTMLElement {
  return within(modes(name)).getByRole("radio", { name: label });
}

function isChecked(radio: HTMLElement): boolean {
  return radio.getAttribute("aria-checked") === "true";
}

/** Whether `first` comes before `second` in the document. */
function precedes(first: Element, second: Element): boolean {
  return (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

async function openCreate(session = shiftsSession()): Promise<typeof session> {
  await openShifts(session);
  fireEvent.click(screen.getByRole("button", { name: "Запланировать смену" }));
  await screen.findByRole("dialog", { name: NEW });
  await waitFor(() => expect((field(NEW, "Товар") as HTMLSelectElement).disabled).toBe(false));
  return session;
}

async function openEdit(session: ReturnType<typeof shiftsSession>, shift: OfficeShift) {
  await openShifts(session);
  fireEvent.click(screen.getByRole("button", { name: `Изменить смену ${shift.number}` }));
  const name = `Смена ${shift.number}`;
  await screen.findByRole("dialog", { name });
  await waitFor(() =>
    expect((field(name, "Шаблон этикетки короба") as HTMLSelectElement).disabled).toBe(false),
  );
  return name;
}

describe("office shifts: a shift's mode (plan РЕЖ)", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
    freezeToday();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("offers «Проверка» and «Агрегация» in that order right after the product, «Агрегация» chosen", async () => {
    await openCreate();
    const group = modes(NEW);
    expect(
      within(group)
        .getAllByRole("radio")
        .map(
          (radio) =>
            document.getElementById(radio.getAttribute("aria-labelledby") ?? "")?.textContent,
        ),
    ).toEqual(["Проверка", "Агрегация"]);
    expect(isChecked(mode(NEW, "Агрегация"))).toBe(true);
    expect(isChecked(mode(NEW, "Проверка"))).toBe(false);
    expect(precedes(field(NEW, "Товар"), group)).toBe(true);
    expect(precedes(group, field(NEW, "Линия"))).toBe(true);
    // Aggregation shows its own fields and no validation hint.
    expect(field(NEW, "Вместимость короба, шт")).toBeTruthy();
    expect(within(dialog(NEW)).getByRole("checkbox", { name: "С паллетами" })).toBeTruthy();
    expect(within(dialog(NEW)).queryByText(VALIDATION_HINT)).toBeNull();
  });

  it("plans a validation shift: hides the box capacity and the pallets, keeps the box template with its hint, and sends the product's capacity", async () => {
    const session = await openCreate();
    session.api.createShift.mockResolvedValue({ ...CREATED, mode: "validation" });
    set(NEW, "Товар", MILK.id);
    set(NEW, "Линия", LINE_2.id);
    set(NEW, "План, шт", "1200");
    set(NEW, "Контрагент", NORTH.id);
    fireEvent.click(mode(NEW, "Проверка"));
    expect(isChecked(mode(NEW, "Проверка"))).toBe(true);
    expect(within(dialog(NEW)).queryByLabelText("Вместимость короба, шт")).toBeNull();
    expect(within(dialog(NEW)).queryByRole("checkbox", { name: "С паллетами" })).toBeNull();
    expect(within(dialog(NEW)).queryByLabelText("Коробов на паллете")).toBeNull();
    expect(valueOf(NEW, "Шаблон этикетки короба")).toBe(MILK_BOX.id);
    expect(messageOf(NEW, "Шаблон этикетки короба")).toBe(VALIDATION_HINT);
    fireEvent.click(within(dialog(NEW)).getByRole("button", { name: "Запланировать" }));
    await screen.findByText("Смена OCT26-006 запланирована.");
    expect(session.api.createShift).toHaveBeenCalledWith(TOKEN, {
      productId: MILK.id,
      lineId: LINE_2.id,
      productionDate: "2026-10-09",
      boxTemplateId: MILK_BOX.id,
      boxCapacity: 12,
      plannedQty: 1200,
      counterpartyId: NORTH.id,
      mode: "validation",
      palletsEnabled: false,
    });
  });

  it("brings the pallets and the box capacity back with the form's values when «Агрегация» is chosen again", async () => {
    await openCreate();
    set(NEW, "Товар", MILK.id);
    set(NEW, "Вместимость короба, шт", "10");
    fireEvent.click(within(dialog(NEW)).getByRole("checkbox", { name: "С паллетами" }));
    set(NEW, "Коробов на паллете", "32");
    fireEvent.click(mode(NEW, "Проверка"));
    expect(within(dialog(NEW)).queryByLabelText("Коробов на паллете")).toBeNull();
    fireEvent.click(mode(NEW, "Агрегация"));
    expect(valueOf(NEW, "Вместимость короба, шт")).toBe("10");
    expect(
      (
        within(dialog(NEW)).getByRole("checkbox", { name: "С паллетами" }) as HTMLButtonElement
      ).getAttribute("aria-checked"),
    ).toBe("true");
    expect(valueOf(NEW, "Коробов на паллете")).toBe("32");
    expect(valueOf(NEW, "Шаблон этикетки паллеты")).toBe(PALLET.id);
    expect(messageOf(NEW, "Шаблон этикетки короба")).not.toBe(VALIDATION_HINT);
  });

  it("drops a refusal of the box capacity once «Проверка» hides it, and sends none of the refused value", async () => {
    const session = await openCreate();
    session.api.createShift.mockResolvedValue({ ...CREATED, mode: "validation" });
    set(NEW, "Товар", MILK.id);
    set(NEW, "Линия", LINE_2.id);
    set(NEW, "Вместимость короба, шт", "0");
    fireEvent.click(within(dialog(NEW)).getByRole("button", { name: "Запланировать" }));
    await waitFor(() =>
      expect(messageOf(NEW, "Вместимость короба, шт")).toBe("Укажите целое число от 1 до 100 000"),
    );
    expect(session.api.createShift).not.toHaveBeenCalled();
    fireEvent.click(mode(NEW, "Проверка"));
    fireEvent.click(within(dialog(NEW)).getByRole("button", { name: "Запланировать" }));
    await screen.findByText("Смена OCT26-006 запланирована.");
    const [, sent] = session.api.createShift.mock.calls[0] ?? [];
    expect(sent).toMatchObject({ mode: "validation", palletsEnabled: false });
    expect(sent).not.toHaveProperty("boxCapacity");
  });

  it("changes a planned shift's mode, sending the mode alone", async () => {
    const session = shiftsSession();
    session.api.updateShift.mockResolvedValue({ ...PLANNED, mode: "validation", rev: 90 });
    const name = await openEdit(session, PLANNED);
    expect(isChecked(mode(name, "Агрегация"))).toBe(true);
    fireEvent.click(mode(name, "Проверка"));
    fireEvent.click(within(dialog(name)).getByRole("button", { name: "Сохранить" }));
    await screen.findByText("Изменения сохранены.");
    expect(session.api.updateShift).toHaveBeenCalledWith(TOKEN, PLANNED.id, {
      mode: "validation",
      expectedRev: PLANNED.rev,
    });
  });

  it("opens a planned validation shift on «Проверка», without its box capacity or pallets", async () => {
    const validation: OfficeShift = { ...PLANNED, mode: "validation" };
    const name = await openEdit(shiftsSession([validation]), validation);
    expect(isChecked(mode(name, "Проверка"))).toBe(true);
    expect(within(dialog(name)).queryByLabelText("Вместимость короба, шт")).toBeNull();
    expect(within(dialog(name)).queryByRole("checkbox", { name: "С паллетами" })).toBeNull();
    expect(messageOf(name, "Шаблон этикетки короба")).toBe(VALIDATION_HINT);
  });

  it("shows an active shift's mode with both choices off: an open shift's mode does not change (Р1)", async () => {
    const session = shiftsSession();
    for (const shown of ["aggregation", "validation"] as const) {
      const view = render(
        <QueryClientProvider client={createOfficeQueryClient()}>
          <OfficeSessionProvider value={session}>
            <ShiftDialog
              shift={{ ...ACTIVE, mode: shown }}
              onClose={() => undefined}
              onSaved={() => undefined}
              onReload={() => undefined}
              onOutdated={() => undefined}
            />
          </OfficeSessionProvider>
        </QueryClientProvider>,
      );
      const name = `Смена ${ACTIVE.number}`;
      await screen.findByRole("dialog", { name });
      const radios = within(modes(name)).getAllByRole("radio");
      expect(radios.map((radio) => radio.hasAttribute("disabled"))).toEqual([true, true]);
      expect(isChecked(mode(name, shown === "validation" ? "Проверка" : "Агрегация"))).toBe(true);
      view.unmount();
    }
  });

  it("is reached by Tab on the chosen mode and changed by the arrows", async () => {
    await openCreate();
    const group = modes(NEW);
    const aggregation = mode(NEW, "Агрегация");
    // One stop in the tab order: the group, which hands the focus to the chosen mode.
    expect(group.tabIndex).toBe(0);
    expect(aggregation.tabIndex).toBe(-1);
    expect(mode(NEW, "Проверка").tabIndex).toBe(-1);
    act(() => group.focus());
    expect(document.activeElement).toBe(aggregation);
    fireEvent.keyDown(aggregation, { key: "ArrowUp" });
    await waitFor(() => expect(isChecked(mode(NEW, "Проверка"))).toBe(true));
    expect(document.activeElement).toBe(mode(NEW, "Проверка"));
    expect(within(dialog(NEW)).queryByLabelText("Вместимость короба, шт")).toBeNull();
    fireEvent.keyDown(mode(NEW, "Проверка"), { key: "ArrowDown" });
    await waitFor(() => expect(isChecked(mode(NEW, "Агрегация"))).toBe(true));
    expect(field(NEW, "Вместимость короба, шт")).toBeTruthy();
  });
});
