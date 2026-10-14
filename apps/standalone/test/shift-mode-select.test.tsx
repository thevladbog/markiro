import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HostError } from "../src/host/client.js";
import type { OfficeShift } from "../src/host/protocol.js";
import { createOfficeQueryClient } from "../src/office/office-query.js";
import { OfficeSessionProvider } from "../src/office/office-session.js";
import { ShiftDialog } from "../src/office/shifts/ShiftDialog.js";
import {
  ACTIVE,
  BOX_58,
  DUPLICATE_58,
  freezeToday,
  LINE_2,
  MILK,
  MILK_BOX,
  MILK_DUPLICATE,
  NO_TOTALS,
  NORTH,
  OLD_DUPLICATE,
  openShifts,
  PALLET,
  PLANNED,
  shiftsSession,
  WATER,
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
      validationPrint: { mode: "none" },
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

  it("drops a refusal of the box capacity once «Проверка» hides it, so «Агрегация» chosen again shows none, and sends none of the refused value", async () => {
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
    // The refusal does not wait behind the hidden field: back on «Агрегация», without a
    // new submit, the capacity shows its value and no message.
    fireEvent.click(mode(NEW, "Проверка"));
    fireEvent.click(mode(NEW, "Агрегация"));
    expect(valueOf(NEW, "Вместимость короба, шт")).toBe("0");
    expect(messageOf(NEW, "Вместимость короба, шт") ?? "").not.toContain("Укажите");
    expect(field(NEW, "Вместимость короба, шт").getAttribute("aria-invalid")).not.toBe("true");
    // And a validation shift is sent without the refused value.
    fireEvent.click(mode(NEW, "Проверка"));
    fireEvent.click(within(dialog(NEW)).getByRole("button", { name: "Запланировать" }));
    await screen.findByText("Смена OCT26-006 запланирована.");
    const [, sent] = session.api.createShift.mock.calls[0] ?? [];
    expect(sent).toMatchObject({ mode: "validation", palletsEnabled: false });
    expect(sent).not.toHaveProperty("boxCapacity");
  });

  it("does not ask for the A4 pallet sheets while «Проверка» is chosen, whatever the pallets switch holds", async () => {
    const validation: OfficeShift = {
      ...PLANNED,
      mode: "validation",
      palletsEnabled: true,
      palletBoxCapacity: 40,
    };
    const session = shiftsSession([validation]);
    const name = await openEdit(session, validation);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(session.api.listPalletSheets).not.toHaveBeenCalled();
    // The control: «Агрегация» with the same pallets switch asks for them.
    fireEvent.click(mode(name, "Агрегация"));
    await waitFor(() => expect(session.api.listPalletSheets).toHaveBeenCalledTimes(1));
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

  it.each([
    ["active", ACTIVE],
    ["closed", { ...ACTIVE, status: "closed" as const }],
  ])(
    "shows the mode of a shift that is %s with both choices off: the mode does not change once planned (Р1)",
    async (_status, base) => {
      const session = shiftsSession();
      for (const shown of ["aggregation", "validation"] as const) {
        const view = render(
          <QueryClientProvider client={createOfficeQueryClient()}>
            <OfficeSessionProvider value={session}>
              <ShiftDialog
                shift={{ ...base, mode: shown }}
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
    },
  );

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

const PRINT = "Печатать дубликат Data Matrix";
const COPY_HINT =
  "На внешнюю упаковку переносится полный код с продукции. Количество продукции не меняется.";
const CHECK = "Обязательная проверка этикетки";
const TEMPLATE = "Шаблон этикетки продукции";
const NONE_HINT = "После отправки на принтер можно сканировать следующую единицу";
const REQUIRED_HINT = "Оператор должен отсканировать новую этикетку перед следующей единицей.";
const FROZEN = "Параметры печати и проверки зафиксированы при открытии смены.";
const NO_TEMPLATES =
  "Для этого продукта нет доступных шаблонов дубликата. Добавьте или включите подходящий шаблон в библиотеке этикеток.";

function printFlag(name: string): HTMLElement | null {
  return within(dialog(name)).queryByRole("checkbox", { name: PRINT });
}

function checkbox(name: string, label: string): HTMLElement {
  return within(dialog(name)).getByRole("checkbox", { name: label });
}

function isOn(box: HTMLElement): boolean {
  return box.getAttribute("aria-checked") === "true";
}

/**
 * Space on a focused button, as a browser presses it. jsdom has no keyboard activation of a
 * button, so the helper plays the browser's part: the click follows only when neither the
 * key-down nor the key-up was swallowed (`preventDefault`) by the control or around it.
 */
function pressSpace(control: HTMLElement): void {
  act(() => control.focus());
  expect(document.activeElement).toBe(control);
  expect(control.tagName).toBe("BUTTON");
  const down = fireEvent.keyDown(control, { key: " ", code: "Space" });
  const up = fireEvent.keyUp(control, { key: " ", code: "Space" });
  expect({ down, up }).toEqual({ down: true, up: true });
  fireEvent.click(control);
}

/** The section «Печать дубликата», or `null` while it is hidden. */
function duplicateSection(name: string): HTMLElement | null {
  return within(dialog(name)).queryByRole("region", { name: "Печать дубликата" });
}

/** The options of the select labelled `label`, by text, the placeholder left out. */
function optionsOf(name: string, label: string): { text: string; disabled: boolean }[] {
  const control = field(name, label);
  if (!(control instanceof HTMLSelectElement)) throw new Error(`${label} is no select`);
  return [...control.options]
    .filter((option) => option.value !== "")
    .map((option) => ({ text: option.textContent, disabled: option.disabled }));
}

/** A planned validation shift of milk that prints with `verification`. */
function printingShift(verification: "none" | "required" = "none"): OfficeShift {
  return {
    ...PLANNED,
    productId: MILK.id,
    boxTemplateId: MILK_BOX.id,
    mode: "validation",
    validationPrint: { mode: "duplicate_dm", templateId: MILK_DUPLICATE.id, verification },
  };
}

function renderDialog(session: ReturnType<typeof shiftsSession>, shift: OfficeShift) {
  return render(
    <QueryClientProvider client={createOfficeQueryClient()}>
      <OfficeSessionProvider value={session}>
        <ShiftDialog
          shift={shift}
          onClose={() => undefined}
          onSaved={() => undefined}
          onReload={() => undefined}
          onOutdated={() => undefined}
        />
      </OfficeSessionProvider>
    </QueryClientProvider>,
  );
}

describe("office shifts: the duplicate print under «Проверка» (plan РЕЖ part B, B7)", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
    freezeToday();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("has no flag under «Агрегация»", async () => {
    await openCreate();
    set(NEW, "Товар", MILK.id);
    expect(printFlag(NEW)).toBeNull();
    expect(duplicateSection(NEW)).toBeNull();
    expect(within(dialog(NEW)).queryByText(COPY_HINT)).toBeNull();
  });

  it("offers the flag under «Проверка», off, with the copy hint under it, before the date", async () => {
    await openCreate();
    set(NEW, "Товар", MILK.id);
    fireEvent.click(mode(NEW, "Проверка"));
    const flag = printFlag(NEW);
    if (flag === null) throw new Error("no flag");
    expect(isOn(flag)).toBe(false);
    expect(messageOf(NEW, PRINT)).toBe(COPY_HINT);
    expect(duplicateSection(NEW)).toBeNull();
    expect(precedes(modes(NEW), flag)).toBe(true);
    expect(
      precedes(flag, within(dialog(NEW)).getByRole("button", { name: "Дата производства" })),
    ).toBe(true);
    // The box template stays (the owner's decision), with its validation hint.
    expect(messageOf(NEW, "Шаблон этикетки короба")).toBe(VALIDATION_HINT);
  });

  it("opens «Печать дубликата» with the fitting duplicate templates and the check off, after the counterparty and before the box template", async () => {
    await openCreate();
    set(NEW, "Товар", MILK.id);
    fireEvent.click(mode(NEW, "Проверка"));
    fireEvent.click(checkbox(NEW, PRINT));
    const section = duplicateSection(NEW);
    if (section === null) throw new Error("no section");
    expect(within(section).getByRole("heading", { name: "Печать дубликата" })).toBeTruthy();
    // Enabled duplicate templates covering milk, by name: not the switched-off one, not a box's.
    expect(optionsOf(NEW, TEMPLATE)).toEqual([
      { text: "Дубликат 58×40 · 58 × 40 мм · 203 dpi", disabled: false },
      { text: "Дубликат молока · 43 × 25 мм · 300 dpi", disabled: false },
    ]);
    expect(valueOf(NEW, TEMPLATE)).toBe("");
    const check = checkbox(NEW, CHECK);
    expect(isOn(check)).toBe(false);
    expect(messageOf(NEW, CHECK)).toBe(NONE_HINT);
    fireEvent.click(check);
    expect(messageOf(NEW, CHECK)).toBe(REQUIRED_HINT);
    // The copy hint moves into the section.
    expect(messageOf(NEW, PRINT)).toBeUndefined();
    expect(within(section).getByText(COPY_HINT)).toBeTruthy();
    expect(within(dialog(NEW)).queryByText(NO_TEMPLATES)).toBeNull();
    // The order (Р16): counterparty, the section, the box template.
    expect(precedes(field(NEW, "Контрагент"), section)).toBe(true);
    expect(precedes(section, field(NEW, "Шаблон этикетки короба"))).toBe(true);
    expect(messageOf(NEW, "Шаблон этикетки короба")).toBe(VALIDATION_HINT);
  });

  it("offers a product of another group only the templates for every category", async () => {
    await openCreate();
    set(NEW, "Товар", WATER.id);
    fireEvent.click(mode(NEW, "Проверка"));
    fireEvent.click(checkbox(NEW, PRINT));
    expect(optionsOf(NEW, TEMPLATE)).toEqual([
      { text: "Дубликат 58×40 · 58 × 40 мм · 203 dpi", disabled: false },
    ]);
  });

  it("refuses a save without the template, says so under it and puts the focus on it", async () => {
    const session = await openCreate();
    set(NEW, "Товар", MILK.id);
    set(NEW, "Линия", LINE_2.id);
    fireEvent.click(mode(NEW, "Проверка"));
    fireEvent.click(checkbox(NEW, PRINT));
    fireEvent.click(within(dialog(NEW)).getByRole("button", { name: "Запланировать" }));
    await waitFor(() =>
      expect(messageOf(NEW, TEMPLATE)).toBe("Выберите шаблон этикетки продукции"),
    );
    await waitFor(() => expect(document.activeElement).toBe(field(NEW, TEMPLATE)));
    expect(session.api.createShift).not.toHaveBeenCalled();
    // Choosing one clears the message.
    set(NEW, TEMPLATE, DUPLICATE_58.id);
    expect(messageOf(NEW, TEMPLATE) ?? "").not.toContain("Выберите шаблон");
  });

  it("says when no duplicate template fits the product, and the flag on cannot be saved", async () => {
    const session = shiftsSession();
    session.api.listTemplates.mockResolvedValue([BOX_58, MILK_BOX, PALLET, OLD_DUPLICATE]);
    await openCreate(session);
    set(NEW, "Товар", MILK.id);
    set(NEW, "Линия", LINE_2.id);
    fireEvent.click(mode(NEW, "Проверка"));
    fireEvent.click(checkbox(NEW, PRINT));
    expect(optionsOf(NEW, TEMPLATE)).toEqual([]);
    expect(within(dialog(NEW)).getByText(NO_TEMPLATES)).toBeTruthy();
    fireEvent.click(within(dialog(NEW)).getByRole("button", { name: "Запланировать" }));
    await waitFor(() =>
      expect(messageOf(NEW, TEMPLATE)).toBe("Выберите шаблон этикетки продукции"),
    );
    expect(session.api.createShift).not.toHaveBeenCalled();
  });

  it("clears the template when the flag is turned off, and shows it empty when turned on again; the check stays", async () => {
    await openCreate();
    set(NEW, "Товар", MILK.id);
    fireEvent.click(mode(NEW, "Проверка"));
    fireEvent.click(checkbox(NEW, PRINT));
    set(NEW, TEMPLATE, MILK_DUPLICATE.id);
    fireEvent.click(checkbox(NEW, CHECK));
    fireEvent.click(checkbox(NEW, PRINT));
    expect(duplicateSection(NEW)).toBeNull();
    expect(messageOf(NEW, PRINT)).toBe(COPY_HINT);
    fireEvent.click(checkbox(NEW, PRINT));
    expect(valueOf(NEW, TEMPLATE)).toBe("");
    // As the cloud's form, the check is kept until the mode changes.
    expect(isOn(checkbox(NEW, CHECK))).toBe(true);
  });

  it("drops the flag, the template, the check and the template's refusal when «Агрегация» is chosen", async () => {
    await openCreate();
    set(NEW, "Товар", MILK.id);
    set(NEW, "Линия", LINE_2.id);
    fireEvent.click(mode(NEW, "Проверка"));
    fireEvent.click(checkbox(NEW, PRINT));
    fireEvent.click(checkbox(NEW, CHECK));
    fireEvent.click(within(dialog(NEW)).getByRole("button", { name: "Запланировать" }));
    await waitFor(() =>
      expect(messageOf(NEW, TEMPLATE)).toBe("Выберите шаблон этикетки продукции"),
    );
    fireEvent.click(mode(NEW, "Агрегация"));
    expect(printFlag(NEW)).toBeNull();
    expect(duplicateSection(NEW)).toBeNull();
    fireEvent.click(mode(NEW, "Проверка"));
    const flag = printFlag(NEW);
    if (flag === null) throw new Error("no flag");
    expect(isOn(flag)).toBe(false);
    fireEvent.click(flag);
    expect(valueOf(NEW, TEMPLATE)).toBe("");
    expect(isOn(checkbox(NEW, CHECK))).toBe(false);
    expect(field(NEW, TEMPLATE).getAttribute("aria-invalid")).not.toBe("true");
    expect(messageOf(NEW, TEMPLATE) ?? "").not.toContain("Выберите шаблон");
  });

  it.each([
    ["the check not required", false, "none"],
    ["the check required", true, "required"],
  ] as const)(
    "plans a validation shift that prints, with %s",
    async (_label, required, verification) => {
      const session = await openCreate();
      session.api.createShift.mockResolvedValue({ ...CREATED, mode: "validation" });
      set(NEW, "Товар", MILK.id);
      set(NEW, "Линия", LINE_2.id);
      fireEvent.click(mode(NEW, "Проверка"));
      fireEvent.click(checkbox(NEW, PRINT));
      set(NEW, TEMPLATE, MILK_DUPLICATE.id);
      if (required) fireEvent.click(checkbox(NEW, CHECK));
      fireEvent.click(within(dialog(NEW)).getByRole("button", { name: "Запланировать" }));
      await screen.findByText("Смена OCT26-006 запланирована.");
      expect(session.api.createShift).toHaveBeenCalledWith(TOKEN, {
        productId: MILK.id,
        lineId: LINE_2.id,
        productionDate: "2026-10-09",
        boxTemplateId: MILK_BOX.id,
        boxCapacity: 12,
        plannedQty: null,
        counterpartyId: null,
        mode: "validation",
        palletsEnabled: false,
        validationPrint: { mode: "duplicate_dm", templateId: MILK_DUPLICATE.id, verification },
      });
    },
  );

  it("forgets the chosen template when «Агрегация» is chosen, so «Проверка» and the flag again start it empty", async () => {
    await openCreate();
    set(NEW, "Товар", MILK.id);
    fireEvent.click(mode(NEW, "Проверка"));
    fireEvent.click(checkbox(NEW, PRINT));
    set(NEW, TEMPLATE, MILK_DUPLICATE.id);
    fireEvent.click(mode(NEW, "Агрегация"));
    fireEvent.click(mode(NEW, "Проверка"));
    fireEvent.click(checkbox(NEW, PRINT));
    expect(valueOf(NEW, TEMPLATE)).toBe("");
  });

  it("drops the template's refusal when the flag is turned off, so turning it on again shows none", async () => {
    await openCreate();
    set(NEW, "Товар", MILK.id);
    set(NEW, "Линия", LINE_2.id);
    fireEvent.click(mode(NEW, "Проверка"));
    fireEvent.click(checkbox(NEW, PRINT));
    fireEvent.click(within(dialog(NEW)).getByRole("button", { name: "Запланировать" }));
    await waitFor(() =>
      expect(messageOf(NEW, TEMPLATE)).toBe("Выберите шаблон этикетки продукции"),
    );
    fireEvent.click(checkbox(NEW, PRINT));
    fireEvent.click(checkbox(NEW, PRINT));
    expect(field(NEW, TEMPLATE).getAttribute("aria-invalid")).not.toBe("true");
    expect(messageOf(NEW, TEMPLATE) ?? "").not.toContain("Выберите шаблон");
  });

  it("drops the host's refusal of a template with the template another product does not take", async () => {
    const session = await openCreate();
    session.api.createShift.mockRejectedValue(
      new HostError({
        kind: "api",
        code: "validation_failed",
        status: 422,
        message: "x",
        details: { field: "validationPrint.templateId" },
      }),
    );
    set(NEW, "Товар", MILK.id);
    set(NEW, "Линия", LINE_2.id);
    fireEvent.click(mode(NEW, "Проверка"));
    fireEvent.click(checkbox(NEW, PRINT));
    set(NEW, TEMPLATE, MILK_DUPLICATE.id);
    fireEvent.click(within(dialog(NEW)).getByRole("button", { name: "Запланировать" }));
    await waitFor(() => expect(field(NEW, TEMPLATE).getAttribute("aria-invalid")).toBe("true"));
    set(NEW, "Товар", WATER.id);
    expect(valueOf(NEW, TEMPLATE)).toBe("");
    expect(field(NEW, TEMPLATE).getAttribute("aria-invalid")).not.toBe("true");
    expect(messageOf(NEW, TEMPLATE) ?? "").not.toContain("Шаблон дубликата");
  });

  it("plans an aggregation and a validation without the flag with no duplicate, whatever was chosen before", async () => {
    const session = await openCreate();
    session.api.createShift.mockResolvedValue(CREATED);
    set(NEW, "Товар", MILK.id);
    set(NEW, "Линия", LINE_2.id);
    fireEvent.click(mode(NEW, "Проверка"));
    fireEvent.click(checkbox(NEW, PRINT));
    set(NEW, TEMPLATE, MILK_DUPLICATE.id);
    fireEvent.click(mode(NEW, "Агрегация"));
    fireEvent.click(within(dialog(NEW)).getByRole("button", { name: "Запланировать" }));
    await screen.findByText("Смена OCT26-006 запланирована.");
    expect(session.api.createShift.mock.calls[0]?.[1]).toMatchObject({
      mode: "aggregation",
      validationPrint: { mode: "none" },
    });
  });

  it("opens a planned shift that prints on its own policy and sends a changed template alone", async () => {
    const shift = printingShift("required");
    const session = shiftsSession([shift]);
    session.api.updateShift.mockResolvedValue({ ...shift, rev: 90 });
    const name = await openEdit(session, shift);
    const flag = printFlag(name);
    if (flag === null) throw new Error("no flag");
    expect(isOn(flag)).toBe(true);
    expect(valueOf(name, TEMPLATE)).toBe(MILK_DUPLICATE.id);
    expect(isOn(checkbox(name, CHECK))).toBe(true);
    set(name, TEMPLATE, DUPLICATE_58.id);
    fireEvent.click(within(dialog(name)).getByRole("button", { name: "Сохранить" }));
    await screen.findByText("Изменения сохранены.");
    expect(session.api.updateShift).toHaveBeenCalledWith(TOKEN, shift.id, {
      validationPrint: {
        mode: "duplicate_dm",
        templateId: DUPLICATE_58.id,
        verification: "required",
      },
      expectedRev: shift.rev,
    });
  });

  it("turns a printing shift into an aggregation with the duplicate dropped in the same request", async () => {
    const shift = printingShift();
    const session = shiftsSession([shift]);
    session.api.updateShift.mockResolvedValue({ ...shift, mode: "aggregation", rev: 90 });
    const name = await openEdit(session, shift);
    fireEvent.click(mode(name, "Агрегация"));
    fireEvent.click(within(dialog(name)).getByRole("button", { name: "Сохранить" }));
    await screen.findByText("Изменения сохранены.");
    expect(session.api.updateShift).toHaveBeenCalledWith(TOKEN, shift.id, {
      mode: "aggregation",
      validationPrint: { mode: "none" },
      expectedRev: shift.rev,
    });
  });

  it("marks a planned shift's template that no longer fits as unavailable, never chosen again", async () => {
    const shift = {
      ...printingShift(),
      validationPrint: {
        mode: "duplicate_dm" as const,
        templateId: OLD_DUPLICATE.id,
        verification: "none" as const,
      },
    };
    const name = await openEdit(shiftsSession([shift]), shift);
    expect(valueOf(name, TEMPLATE)).toBe(OLD_DUPLICATE.id);
    expect(optionsOf(name, TEMPLATE)).toContainEqual({
      text: "Шаблон недоступен — обновите данные",
      disabled: true,
    });
  });

  it("puts the host's refusal of the duplicate template under it, focuses it and reads the templates again", async () => {
    const session = await openCreate();
    session.api.createShift.mockRejectedValue(
      new HostError({
        kind: "api",
        code: "validation_failed",
        status: 422,
        message: "x",
        details: { field: "validationPrint.templateId" },
      }),
    );
    set(NEW, "Товар", MILK.id);
    set(NEW, "Линия", LINE_2.id);
    fireEvent.click(mode(NEW, "Проверка"));
    fireEvent.click(checkbox(NEW, PRINT));
    set(NEW, TEMPLATE, MILK_DUPLICATE.id);
    const reads = session.api.listTemplates.mock.calls.length;
    fireEvent.click(within(dialog(NEW)).getByRole("button", { name: "Запланировать" }));
    await waitFor(() =>
      expect(messageOf(NEW, TEMPLATE)).toBe(
        "Шаблон дубликата выключен или больше не подходит товару. Выберите другой.",
      ),
    );
    await waitFor(() => expect(document.activeElement).toBe(field(NEW, TEMPLATE)));
    await waitFor(() => expect(session.api.listTemplates.mock.calls.length).toBeGreaterThan(reads));
  });

  it("drops a template that does not fit another product chosen, and keeps one that does", async () => {
    await openCreate();
    set(NEW, "Товар", MILK.id);
    fireEvent.click(mode(NEW, "Проверка"));
    fireEvent.click(checkbox(NEW, PRINT));
    set(NEW, TEMPLATE, DUPLICATE_58.id);
    set(NEW, "Товар", WATER.id);
    expect(valueOf(NEW, TEMPLATE)).toBe(DUPLICATE_58.id);
    set(NEW, "Товар", MILK.id);
    set(NEW, TEMPLATE, MILK_DUPLICATE.id);
    set(NEW, "Товар", WATER.id);
    expect(valueOf(NEW, TEMPLATE)).toBe("");
  });

  it("words the counterparty's hint for «Проверка»: no box label, the duplicate's when it prints", async () => {
    await openCreate();
    set(NEW, "Товар", MILK.id);
    expect(messageOf(NEW, "Контрагент")).toBe(
      "Необязательно: его название будет на этикетке короба",
    );
    fireEvent.click(mode(NEW, "Проверка"));
    expect(messageOf(NEW, "Контрагент")).toBe("Необязательно");
    fireEvent.click(checkbox(NEW, PRINT));
    expect(messageOf(NEW, "Контрагент")).toBe(
      "Необязательно: его название будет на этикетке дубликата",
    );
  });

  it("is worked from the keyboard: the flag and the check are buttons in the tab order, the template a native select", async () => {
    await openCreate();
    set(NEW, "Товар", MILK.id);
    fireEvent.click(mode(NEW, "Проверка"));
    const flag = checkbox(NEW, PRINT);
    expect(flag.tagName).toBe("BUTTON");
    expect(flag.tabIndex).toBe(0);
    act(() => flag.focus());
    expect(document.activeElement).toBe(flag);
    fireEvent.click(flag);
    const check = checkbox(NEW, CHECK);
    expect(check.tagName).toBe("BUTTON");
    expect(check.tabIndex).toBe(0);
    expect(field(NEW, TEMPLATE).tagName).toBe("SELECT");
  });

  it("toggles the flag and the check with Space", async () => {
    await openCreate();
    set(NEW, "Товар", MILK.id);
    fireEvent.click(mode(NEW, "Проверка"));
    pressSpace(checkbox(NEW, PRINT));
    expect(isOn(checkbox(NEW, PRINT))).toBe(true);
    pressSpace(checkbox(NEW, CHECK));
    expect(isOn(checkbox(NEW, CHECK))).toBe(true);
    expect(messageOf(NEW, CHECK)).toBe(REQUIRED_HINT);
    pressSpace(checkbox(NEW, CHECK));
    expect(isOn(checkbox(NEW, CHECK))).toBe(false);
    pressSpace(checkbox(NEW, PRINT));
    expect(isOn(checkbox(NEW, PRINT))).toBe(false);
    expect(duplicateSection(NEW)).toBeNull();
  });

  it.each([
    ["is active and its template is known", MILK_DUPLICATE.id, "Дубликат молока"],
    [
      "is active and its template is gone",
      "e0f1a2b3-c4d5-4e6f-8a7b-8c9d0e1f2a3b",
      "Шаблон зафиксирован при открытии смены",
    ],
  ])(
    "shows the frozen policy of a shift that %s, nothing changeable",
    async (_label, templateId, shown) => {
      const session = shiftsSession();
      const shift: OfficeShift = {
        ...ACTIVE,
        mode: "validation",
        validationPrint: { mode: "duplicate_dm", templateId, verification: "required" },
      };
      renderDialog(session, shift);
      const name = `Смена ${ACTIVE.number}`;
      await screen.findByRole("dialog", { name });
      await waitFor(() => expect(optionsOf(name, TEMPLATE).length).toBeGreaterThan(0));
      const flag = checkbox(name, PRINT);
      expect(isOn(flag)).toBe(true);
      expect(flag.hasAttribute("disabled")).toBe(true);
      expect((field(name, TEMPLATE) as HTMLSelectElement).disabled).toBe(true);
      expect(valueOf(name, TEMPLATE)).toBe(templateId);
      const select = field(name, TEMPLATE) as HTMLSelectElement;
      expect(select.selectedOptions[0]?.textContent).toBe(shown);
      expect(checkbox(name, CHECK).hasAttribute("disabled")).toBe(true);
      expect(within(dialog(name)).getByText(FROZEN)).toBeTruthy();
      expect(within(dialog(name)).queryByText(COPY_HINT)).toBeNull();
      expect(within(dialog(name)).queryByText(NO_TEMPLATES)).toBeNull();
    },
  );

  it("says under the switched-off flag of an active validation shift that it was frozen at the opening", async () => {
    const shift: OfficeShift = { ...ACTIVE, mode: "validation", validationPrint: { mode: "none" } };
    renderDialog(shiftsSession(), shift);
    const name = `Смена ${ACTIVE.number}`;
    await screen.findByRole("dialog", { name });
    const flag = checkbox(name, PRINT);
    expect(isOn(flag)).toBe(false);
    expect(flag.hasAttribute("disabled")).toBe(true);
    expect(messageOf(name, PRINT)).toBe(FROZEN);
    expect(within(dialog(name)).queryByText(COPY_HINT)).toBeNull();
    expect(duplicateSection(name)).toBeNull();
  });

  it("marks a planned shift whose duplicate template a station will refuse", async () => {
    const shift = {
      ...printingShift(),
      validationPrint: {
        mode: "duplicate_dm" as const,
        templateId: OLD_DUPLICATE.id,
        verification: "none" as const,
      },
    };
    await openShifts(shiftsSession([shift]));
    expect(
      await screen.findByText("Не откроется: шаблон дубликата выключен или не подходит товару"),
    ).toBeTruthy();
  });
});
