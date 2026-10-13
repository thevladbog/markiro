import { act, fireEvent, screen, waitFor, within, type RenderResult } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HostError } from "../src/host/client.js";
import type { OfficeShift, TemplateDefaults } from "../src/host/protocol.js";
import { ORG_PROFILE, TECHNOLOGIST, type FakeOfficeSession } from "./support/office.js";
import {
  ACTIVE,
  BOX_58,
  DEFAULTS,
  expectFocusedNotice,
  freezeToday,
  LINE_10,
  LINE_2,
  MILK,
  MILK_BOX,
  NO_TOTALS,
  NORTH,
  openShifts,
  PALLET,
  pickDate,
  shiftsSession,
  stockSheets,
  WATER,
} from "./support/shifts.js";
import {
  chooseValueOn,
  isSelectTrigger,
  optionTextsOn,
  settleSelect,
  shownOn,
  valueOn,
} from "./support/select.js";

const TOKEN = "office-session-token";

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

function api(code: string, details: Record<string, unknown> = {}): HostError {
  return new HostError({ kind: "api", code, status: 409, message: code, details });
}

function dialog(): HTMLElement {
  return screen.getByRole("dialog", { name: "Новая смена" });
}

function field(label: string): HTMLElement {
  return within(dialog()).getByLabelText(label);
}

function set(label: string, value: string): void {
  const control = field(label);
  if (isSelectTrigger(control)) chooseValueOn(control, value);
  else fireEvent.change(control, { target: { value } });
}

/** The texts of the options of the select labelled `label`. */
function options(label: string): string[] {
  return optionTextsOn(field(label));
}

function valueOf(label: string): string {
  const control = field(label);
  if (isSelectTrigger(control)) return valueOn(control);
  if (!(control instanceof HTMLInputElement)) throw new Error(`${label} holds no value`);
  return control.value;
}

/** The message under the field labelled `label`, by its `aria-describedby`. */
function messageOf(label: string): string | null | undefined {
  const id = field(label).getAttribute("aria-describedby");
  return id === null ? undefined : document.getElementById(id)?.textContent;
}

async function openCreate(session: FakeOfficeSession): Promise<RenderResult> {
  const view = await openShifts(session);
  fireEvent.click(screen.getByRole("button", { name: "Запланировать смену" }));
  await screen.findByRole("dialog", { name: "Новая смена" });
  // The product waits for the products, the templates and the defaults.
  await waitFor(() => expect((field("Товар") as HTMLSelectElement).disabled).toBe(false));
  return view;
}

function submit(): void {
  fireEvent.click(within(dialog()).getByRole("button", { name: "Запланировать" }));
}

/** Milk on line 2, a plan of 1200, for the northern counterparty. */
function fillMilk(): void {
  set("Товар", MILK.id);
  set("Линия", LINE_2.id);
  set("План, шт", " 1200 ");
  set("Контрагент", NORTH.id);
}

describe("office shifts: planning a shift", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
    freezeToday();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("offers «Запланировать смену» to both roles", async () => {
    for (const user of [undefined, TECHNOLOGIST]) {
      const view = await openShifts(shiftsSession(undefined, user));
      expect(screen.getByRole("button", { name: "Запланировать смену" })).toBeTruthy();
      view.unmount();
    }
  });

  it("starts on today in the organization's time zone", async () => {
    // 13:00 UTC on 9 October is already 10 October in Kamchatka (UTC+12).
    vi.setSystemTime(new Date("2026-10-09T13:00:00Z"));
    const session = shiftsSession();
    session.api.getOrg.mockResolvedValue({ ...ORG_PROFILE, timeZone: "Asia/Kamchatka" });
    await openCreate(session);
    expect(within(dialog()).getByRole("button", { name: "Дата производства" }).textContent).toBe(
      "10 октября 2026",
    );
    expect(within(dialog()).queryByText(/Часовой пояс организации не загрузился/)).toBeNull();
  });

  it("starts on this PC's date and says so when the organization does not load", async () => {
    const session = shiftsSession();
    session.api.getOrg.mockRejectedValue(api("internal"));
    await openCreate(session);
    expect(within(dialog()).getByRole("button", { name: "Дата производства" }).textContent).toBe(
      "9 октября 2026",
    );
    expect(
      within(dialog()).getByText(
        "Часовой пояс организации не загрузился: «сегодня» — по часам этого ПК.",
      ),
    ).toBeTruthy();
  });

  it("offers the products in use by name with their GTINs, the active lines and the counterparties in use", async () => {
    await openCreate(shiftsSession());
    expect(options("Товар")).toEqual([
      "Вода 0,5 л — 04601234000017",
      "Молоко 3,2% 0,9 л — 04600682000013",
    ]);
    expect(options("Линия")).toEqual(["Линия 2", "Линия 10"]);
    expect(options("Контрагент")).toEqual(["Не выбран", "ООО «Северный берег»"]);
    expect(options("Шаблон этикетки короба")).toEqual([]);
    expect(shownOn(field("Шаблон этикетки короба"))).toBe("Сначала выберите товар");
    expect((field("Шаблон этикетки короба") as HTMLSelectElement).disabled).toBe(true);
  });

  it("takes the box capacity and the template from the product: its preference, else the organization's default", async () => {
    await openCreate(shiftsSession());
    set("Товар", MILK.id);
    expect(valueOf("Вместимость короба, шт")).toBe("12");
    expect(valueOf("Шаблон этикетки короба")).toBe(MILK_BOX.id);
    expect(options("Шаблон этикетки короба")).toEqual(["Коробка 58×40", "Молоко 100×72"]);
    // Water has no preference and its group no default; milk's template is not of its group.
    set("Вместимость короба, шт", "6");
    set("Товар", WATER.id);
    expect(valueOf("Вместимость короба, шт")).toBe("24");
    expect(valueOf("Шаблон этикетки короба")).toBe(BOX_58.id);
    expect(options("Шаблон этикетки короба")).toEqual(["Коробка 58×40"]);
  });

  it("lets the product be chosen only once the templates and the defaults are read, so the template follows it", async () => {
    const session = shiftsSession();
    let answer: (defaults: TemplateDefaults) => void = () => undefined;
    session.api.getTemplateDefaults.mockReturnValue(
      new Promise<TemplateDefaults>((resolve) => {
        answer = resolve;
      }),
    );
    await openShifts(session);
    fireEvent.click(screen.getByRole("button", { name: "Запланировать смену" }));
    await screen.findByRole("dialog", { name: "Новая смена" });
    await waitFor(() => expect(options("Товар")).toHaveLength(2));
    expect((field("Товар") as HTMLSelectElement).disabled).toBe(true);
    act(() => answer(DEFAULTS));
    await waitFor(() => expect((field("Товар") as HTMLSelectElement).disabled).toBe(false));
    set("Товар", WATER.id);
    expect(valueOf("Шаблон этикетки короба")).toBe(BOX_58.id);
  });

  it("asks the person to choose when no template fits by the rule", async () => {
    const session = shiftsSession();
    session.api.getTemplateDefaults.mockResolvedValue({
      defaultBoxTemplateId: null,
      defaultPalletTemplateId: null,
      defaultDuplicateTemplateId: null,
      categories: [],
      defaultPalletSheetId: null,
      palletSheetCategories: [],
      rev: 80,
    });
    await openCreate(session);
    set("Товар", WATER.id);
    expect(valueOf("Шаблон этикетки короба")).toBe("");
    expect(options("Шаблон этикетки короба")).toEqual(["Коробка 58×40"]);
  });

  it("plans the shift with the body built field by field, then closes, says so and reads the list again", async () => {
    const session = shiftsSession();
    session.api.createShift.mockResolvedValue(CREATED);
    await openCreate(session);
    fillMilk();
    pickDate("Дата производства", "12 октября 2026");
    submit();
    await screen.findByText("Смена OCT26-006 запланирована.");
    expect(session.api.createShift).toHaveBeenCalledWith(TOKEN, {
      productId: MILK.id,
      lineId: LINE_2.id,
      productionDate: "2026-10-12",
      boxTemplateId: MILK_BOX.id,
      boxCapacity: 12,
      plannedQty: 1200,
      counterpartyId: NORTH.id,
      mode: "aggregation",
      palletsEnabled: false,
    });
    expect(screen.queryByRole("dialog", { name: "Новая смена" })).toBeNull();
    await waitFor(() => expect(session.api.listShifts).toHaveBeenCalledTimes(2));
  });

  it("moves the focus to the notice once the shift is planned", async () => {
    const session = shiftsSession();
    session.api.createShift.mockResolvedValue(CREATED);
    await openCreate(session);
    fillMilk();
    submit();
    await expectFocusedNotice("Смена OCT26-006 запланирована.");
  });

  it("sends no plan and no counterparty as null, and a capacity typed over the product's", async () => {
    const session = shiftsSession();
    session.api.createShift.mockResolvedValue(CREATED);
    await openCreate(session);
    set("Товар", WATER.id);
    set("Линия", LINE_10.id);
    set("Вместимость короба, шт", " 20 ");
    submit();
    await screen.findByText("Смена OCT26-006 запланирована.");
    expect(session.api.createShift).toHaveBeenCalledWith(TOKEN, {
      productId: WATER.id,
      lineId: LINE_10.id,
      productionDate: "2026-10-09",
      boxTemplateId: BOX_58.id,
      boxCapacity: 20,
      plannedQty: null,
      counterpartyId: null,
      mode: "aggregation",
      palletsEnabled: false,
    });
  });

  it("plans a shift with pallets: their capacity from the product and their template by the rule, both changeable (plan О-Ф)", async () => {
    const session = shiftsSession();
    session.api.createShift.mockResolvedValue(CREATED);
    await openCreate(session);
    expect(within(dialog()).queryByLabelText("Коробов на паллете")).toBeNull();
    fillMilk();
    fireEvent.click(within(dialog()).getByRole("checkbox", { name: "С паллетами" }));
    expect(valueOf("Коробов на паллете")).toBe("40");
    // Milk has no pallet preference and its group no pallet default: the organization's.
    expect(valueOf("Шаблон этикетки паллеты")).toBe(PALLET.id);
    expect(options("Шаблон этикетки паллеты")).toEqual(["Паллета 100×150"]);
    set("Коробов на паллете", " 32 ");
    submit();
    await screen.findByText("Смена OCT26-006 запланирована.");
    expect(session.api.createShift).toHaveBeenCalledWith(TOKEN, {
      productId: MILK.id,
      lineId: LINE_2.id,
      productionDate: "2026-10-09",
      boxTemplateId: MILK_BOX.id,
      boxCapacity: 12,
      plannedQty: 1200,
      counterpartyId: NORTH.id,
      mode: "aggregation",
      palletsEnabled: true,
      palletBoxCapacity: 32,
      palletTemplateId: PALLET.id,
    });
  });

  it("refuses pallets without a capacity or a template before sending, and sends none once they are off", async () => {
    const session = shiftsSession();
    session.api.getTemplateDefaults.mockResolvedValue({
      ...DEFAULTS,
      defaultPalletTemplateId: null,
    });
    session.api.createShift.mockResolvedValue(CREATED);
    await openCreate(session);
    fillMilk();
    fireEvent.click(within(dialog()).getByRole("checkbox", { name: "С паллетами" }));
    expect(valueOf("Шаблон этикетки паллеты")).toBe("");
    set("Коробов на паллете", "");
    await settleSelect();
    submit();
    await waitFor(() =>
      expect(messageOf("Шаблон этикетки паллеты")).toBe("Выберите шаблон этикетки паллеты"),
    );
    expect(messageOf("Коробов на паллете")).toBe("Укажите целое число от 1 до 10 000");
    await waitFor(() => expect(document.activeElement).toBe(field("Коробов на паллете")));
    expect(session.api.createShift).not.toHaveBeenCalled();
    fireEvent.click(within(dialog()).getByRole("checkbox", { name: "С паллетами" }));
    submit();
    await screen.findByText("Смена OCT26-006 запланирована.");
    expect(session.api.createShift).toHaveBeenCalledWith(
      TOKEN,
      expect.objectContaining({ palletsEnabled: false }),
    );
    expect(session.api.createShift.mock.calls[0]?.[1]).not.toHaveProperty("palletTemplateId");
  });

  it("offers no pallets for a product without a pallet capacity, and turns them off when such a product is chosen", async () => {
    const session = shiftsSession();
    session.api.listProducts.mockResolvedValue([MILK, { ...WATER, palletBoxCapacity: null }]);
    await openCreate(session);
    set("Товар", MILK.id);
    fireEvent.click(within(dialog()).getByRole("checkbox", { name: "С паллетами" }));
    expect(valueOf("Коробов на паллете")).toBe("40");
    set("Товар", WATER.id);
    const pallets = within(dialog()).getByRole("checkbox", { name: "С паллетами" });
    expect(pallets.getAttribute("aria-checked")).toBe("false");
    expect(pallets).toHaveProperty("disabled", true);
    expect(
      within(dialog()).getByText("У товара не задана вместимость паллеты: смена без паллет"),
    ).toBeTruthy();
    expect(within(dialog()).queryByLabelText("Коробов на паллете")).toBeNull();
  });

  it("puts a pallet template the host refused under its select and reads the templates again", async () => {
    const session = shiftsSession();
    session.api.createShift.mockRejectedValue(
      api("validation_failed", { field: "palletTemplateId" }),
    );
    await openCreate(session);
    fillMilk();
    fireEvent.click(within(dialog()).getByRole("checkbox", { name: "С паллетами" }));
    session.api.listTemplates.mockResolvedValue([BOX_58, MILK_BOX, { ...PALLET, enabled: false }]);
    submit();
    await waitFor(() =>
      expect(messageOf("Шаблон этикетки паллеты")).toBe(
        "Шаблон паллеты выключен или больше не подходит товару. Выберите другой.",
      ),
    );
    await waitFor(() =>
      expect(options("Шаблон этикетки паллеты")).toEqual(["Паллета 100×150 — не подходит"]),
    );
  });

  // Added by the task 8 implementer: the plan's pallet tests leave these behaviours unpinned.
  it("takes the new product's pallet capacity and template when pallets are on, and none of them when they are off", async () => {
    const session = shiftsSession();
    const bigPallet = { ...WATER, palletBoxCapacity: 60, defaultPalletTemplateId: PALLET.id };
    session.api.listProducts.mockResolvedValue([MILK, bigPallet]);
    await openCreate(session);
    set("Товар", MILK.id);
    // Off: the capacity of a product chosen later is not copied anywhere.
    set("Товар", WATER.id);
    fireEvent.click(within(dialog()).getByRole("checkbox", { name: "С паллетами" }));
    expect(valueOf("Коробов на паллете")).toBe("60");
    set("Коробов на паллете", "7");
    set("Товар", MILK.id);
    expect(valueOf("Коробов на паллете")).toBe("40");
    expect(valueOf("Шаблон этикетки паллеты")).toBe(PALLET.id);
  });

  it("does not keep a refusal of the pallets' earlier values once the pallets are chosen again", async () => {
    const session = shiftsSession();
    session.api.getTemplateDefaults.mockResolvedValue({
      ...DEFAULTS,
      defaultPalletTemplateId: null,
    });
    await openCreate(session);
    fillMilk();
    const pallets = () => within(dialog()).getByRole("checkbox", { name: "С паллетами" });
    const refuse = async () => {
      set("Коробов на паллете", "");
      submit();
      await waitFor(() =>
        expect(messageOf("Шаблон этикетки паллеты")).toBe("Выберите шаблон этикетки паллеты"),
      );
      expect(messageOf("Коробов на паллете")).toBe("Укажите целое число от 1 до 10 000");
    };
    fireEvent.click(pallets());
    await refuse();
    // Off and on again: the fields start afresh, without the old refusal.
    fireEvent.click(pallets());
    fireEvent.click(pallets());
    expect(messageOf("Шаблон этикетки паллеты")).toBeUndefined();
    expect(messageOf("Коробов на паллете")).not.toBe("Укажите целое число от 1 до 10 000");
    expect(valueOf("Коробов на паллете")).toBe("40");
    // A refusal is cleared by a new product too.
    await refuse();
    set("Товар", WATER.id);
    expect(messageOf("Шаблон этикетки паллеты")).toBeUndefined();
    expect(messageOf("Коробов на паллете")).not.toBe("Укажите целое число от 1 до 10 000");
  });

  it("offers only the pallet templates that fit the product's group, and marks the one it kept that no longer fits", async () => {
    const session = shiftsSession();
    const milkOnly = {
      ...PALLET,
      id: "8f7e6d5c-4b3a-4291-8a0b-9c8d7e6f5a4b",
      name: "Паллета молочная",
      chzProductGroupCodes: [8],
    };
    session.api.listTemplates.mockResolvedValue([BOX_58, MILK_BOX, PALLET, milkOnly]);
    await openCreate(session);
    set("Товар", MILK.id);
    fireEvent.click(within(dialog()).getByRole("checkbox", { name: "С паллетами" }));
    expect(options("Шаблон этикетки паллеты")).toEqual(["Паллета 100×150", "Паллета молочная"]);
    set("Товар", WATER.id);
    // Water is not of group 8; the template of the organization still fits.
    expect(options("Шаблон этикетки паллеты")).toEqual(["Паллета 100×150"]);
  });

  it("holds the pallet controls too while the write is on its way", async () => {
    const session = shiftsSession();
    session.api.createShift.mockReturnValueOnce(new Promise<OfficeShift>(() => undefined));
    await openCreate(session);
    fillMilk();
    fireEvent.click(within(dialog()).getByRole("checkbox", { name: "С паллетами" }));
    submit();
    await waitFor(() => expect(session.api.createShift).toHaveBeenCalledTimes(1));
    const disabled = (control: HTMLElement) =>
      (control as HTMLInputElement | HTMLSelectElement).disabled;
    await waitFor(() =>
      expect(
        [
          within(dialog()).getByRole("checkbox", { name: "С паллетами" }),
          field("Коробов на паллете"),
          field("Шаблон этикетки паллеты"),
        ].map(disabled),
      ).toEqual([true, true, true]),
    );
  });

  it("refuses an empty product, line, template, capacity and date before sending, and a bad plan", async () => {
    const session = shiftsSession();
    await openCreate(session);
    fireEvent.click(
      within(dialog()).getByRole("button", { name: "Очистить дату: Дата производства" }),
    );
    set("План, шт", "0");
    submit();
    await waitFor(() => expect(messageOf("Товар")).toBe("Выберите товар"));
    expect(messageOf("Линия")).toBe("Выберите линию");
    expect(messageOf("Шаблон этикетки короба")).toBe("Выберите шаблон этикетки короба");
    expect(messageOf("Вместимость короба, шт")).toBe("Укажите целое число от 1 до 100 000");
    expect(within(dialog()).getByText("Укажите дату производства")).toBeTruthy();
    expect(messageOf("План, шт")).toBe(
      "Укажите целое число от 1 до 10 000 000 или оставьте пустым",
    );
    expect(session.api.createShift).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a product no longer in use",
      api("conflict", { constraint: "product_inactive" }),
      "Товар",
      "Товар больше не в работе: он в архиве или стал черновиком",
    ],
    [
      "an archived line",
      api("validation_failed", { field: "lineId" }),
      "Линия",
      "Линия в архиве. Выберите другую.",
    ],
    [
      "a counterparty archived meanwhile",
      api("validation_failed", { field: "counterpartyId" }),
      "Контрагент",
      "Контрагент в архиве. Выберите другого.",
    ],
    [
      "a plan the host does not take",
      api("validation_failed", { field: "plannedQty" }),
      "План, шт",
      "Хост не принял это значение. Проверьте его.",
    ],
  ])("puts %s under its field and keeps the dialog", async (_what, refusal, label, message) => {
    const session = shiftsSession();
    session.api.createShift.mockRejectedValue(refusal);
    await openCreate(session);
    fillMilk();
    submit();
    await waitFor(() => expect(messageOf(label)).toBe(message));
    expect(dialog()).toBeTruthy();
  });

  it("puts a template switched off meanwhile under the template and reads the templates again", async () => {
    const session = shiftsSession();
    session.api.createShift.mockRejectedValue(api("validation_failed", { field: "boxTemplateId" }));
    await openCreate(session);
    fillMilk();
    session.api.listTemplates.mockResolvedValue([BOX_58, { ...MILK_BOX, enabled: false }]);
    submit();
    await waitFor(() =>
      expect(messageOf("Шаблон этикетки короба")).toBe(
        "Шаблон выключен или больше не подходит товару. Выберите другой.",
      ),
    );
    await waitFor(() =>
      expect(options("Шаблон этикетки короба")).toEqual([
        "Коробка 58×40",
        "Молоко 100×72 — не подходит",
      ]),
    );
  });

  it("explains any other failure above the fields and sends one request for a double click", async () => {
    const session = shiftsSession();
    let fail: (error: unknown) => void = () => undefined;
    session.api.createShift.mockReturnValue(
      new Promise<OfficeShift>((_resolve, reject) => {
        fail = reject;
      }),
    );
    await openCreate(session);
    fillMilk();
    act(() => {
      submit();
      submit();
    });
    await act(async () => {
      fail(new HostError({ kind: "transport", code: "unreachable", message: "x" }));
      await Promise.resolve();
    });
    expect(await within(dialog()).findByRole("alert")).toBeTruthy();
    expect(session.api.createShift).toHaveBeenCalledTimes(1);
  });

  it("keeps the template off and says why while the templates do not load", async () => {
    const session = shiftsSession();
    session.api.listTemplates.mockRejectedValue(api("internal"));
    await openCreate(session);
    set("Товар", MILK.id);
    expect((field("Шаблон этикетки короба") as HTMLSelectElement).disabled).toBe(true);
    expect(
      within(dialog()).getByText(
        "Список шаблонов не загрузился. Закройте окно и откройте его снова.",
      ),
    ).toBeTruthy();
  });

  it("says under the template that the defaults did not load and that it comes from the product alone", async () => {
    const session = shiftsSession();
    session.api.getTemplateDefaults.mockRejectedValue(api("internal"));
    await openCreate(session);
    const words =
      "Шаблоны по умолчанию не загрузились: шаблон берётся только из товара — проверьте выбор.";
    // Water has no preference of its own and its group's default is out of reach: no template.
    set("Товар", WATER.id);
    expect(valueOf("Шаблон этикетки короба")).toBe("");
    expect(messageOf("Шаблон этикетки короба")).toBe(words);
    // Milk has: the template is chosen, and the note still says where it came from.
    set("Товар", MILK.id);
    expect(valueOf("Шаблон этикетки короба")).toBe(MILK_BOX.id);
    expect(messageOf("Шаблон этикетки короба")).toBe(words);
  });

  it("says nothing of the defaults when they loaded", async () => {
    await openCreate(shiftsSession());
    set("Товар", WATER.id);
    expect(messageOf("Шаблон этикетки короба")).toBeUndefined();
  });

  it("waits for the organization's profile behind a loading dialog whose button is off", async () => {
    const session = shiftsSession();
    let answer: (org: typeof ORG_PROFILE) => void = () => undefined;
    session.api.getOrg.mockReturnValue(
      new Promise<typeof ORG_PROFILE>((resolve) => {
        answer = resolve;
      }),
    );
    await openShifts(session);
    fireEvent.click(screen.getByRole("button", { name: "Запланировать смену" }));
    await screen.findByRole("dialog", { name: "Новая смена" });
    expect(within(dialog()).getByText("Загрузка…")).toBeTruthy();
    expect(
      (within(dialog()).getByRole("button", { name: "Запланировать" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(within(dialog()).queryByLabelText("Товар")).toBeNull();
    act(() => answer(ORG_PROFILE));
    await waitFor(() => expect((field("Товар") as HTMLSelectElement).disabled).toBe(false));
    expect(within(dialog()).queryByText("Загрузка…")).toBeNull();
  });

  it("changes the default date at the organization's midnight, to the second", async () => {
    // Moscow is UTC+3: 20:59:59Z on the 9th is still the 9th there, 21:00:00Z is the 10th.
    for (const [instant, day] of [
      ["2026-10-09T20:59:59Z", "9 октября 2026"],
      ["2026-10-09T21:00:00Z", "10 октября 2026"],
    ] as const) {
      vi.setSystemTime(new Date(instant));
      const view = await openCreate(shiftsSession());
      expect(within(dialog()).getByRole("button", { name: "Дата производства" }).textContent).toBe(
        day,
      );
      view.unmount();
    }
  });

  it("starts on this PC's date and says so when this PC does not know the organization's zone", async () => {
    const session = shiftsSession();
    session.api.getOrg.mockResolvedValue({ ...ORG_PROFILE, timeZone: "Mars/Olympus_Mons" });
    await openCreate(session);
    expect(within(dialog()).getByRole("button", { name: "Дата производства" }).textContent).toBe(
      "9 октября 2026",
    );
    expect(
      within(dialog()).getByText(
        "Этот ПК не знает часовой пояс организации: «сегодня» — по часам этого ПК.",
      ),
    ).toBeTruthy();
    expect(within(dialog()).queryByText(/не загрузился: «сегодня»/)).toBeNull();
  });

  it("takes a refused capacity and template error away once a product fills them", async () => {
    await openCreate(shiftsSession());
    submit();
    await waitFor(() =>
      expect(messageOf("Вместимость короба, шт")).toBe("Укажите целое число от 1 до 100 000"),
    );
    expect(messageOf("Шаблон этикетки короба")).toBe("Выберите шаблон этикетки короба");
    set("Товар", MILK.id);
    // Choosing the product checks the product's own field again, which ends after the click.
    await waitFor(() => expect(messageOf("Товар")).toBeUndefined());
    expect(messageOf("Вместимость короба, шт")).toBe("Берётся из товара; можно изменить");
    expect(messageOf("Шаблон этикетки короба")).toBeUndefined();
    expect(valueOf("Вместимость короба, шт")).toBe("12");
  });

  it.each([
    [
      "a product the host does not find",
      api("validation_failed", { field: "productId" }),
      "Товар",
      "Хост не нашёл этот товар. Выберите другой.",
    ],
    [
      "a date the host does not take",
      api("validation_failed", { field: "productionDate" }),
      "Дата производства",
      "Хост не принял это значение. Проверьте его.",
    ],
    [
      "a capacity the host does not take",
      api("validation_failed", { field: "boxCapacity" }),
      "Вместимость короба, шт",
      "Хост не принял это значение. Проверьте его.",
    ],
  ])("puts %s under its field", async (_what, refusal, label, message) => {
    const session = shiftsSession();
    session.api.createShift.mockRejectedValue(refusal);
    await openCreate(session);
    fillMilk();
    submit();
    await waitFor(() => {
      const control =
        label === "Дата производства"
          ? within(dialog()).getByRole("button", { name: label })
          : field(label);
      const id = control.getAttribute("aria-describedby");
      expect(id === null ? undefined : document.getElementById(id)?.textContent).toBe(message);
    });
  });

  it("explains a refusal for lack of rights above the fields, not under one", async () => {
    const session = shiftsSession();
    session.api.createShift.mockRejectedValue(api("forbidden"));
    await openCreate(session);
    fillMilk();
    submit();
    expect(await within(dialog()).findByRole("alert")).toBeTruthy();
    expect(within(dialog()).getByText("Недостаточно прав для этого действия.")).toBeTruthy();
    expect(messageOf("Товар")).toBeUndefined();
  });

  it("puts the focus on the first refused field in the form's order", async () => {
    const session = shiftsSession();
    await openCreate(session);
    // The plan and the line are refused, and the product is not chosen: the product comes first.
    set("План, шт", "0");
    // The form's own focus would visit the plan first; the product alone is to take it.
    const planFocused = vi.fn();
    field("План, шт").addEventListener("focus", planFocused);
    submit();
    await waitFor(() => expect(document.activeElement).toBe(field("Товар")));
    expect(planFocused).not.toHaveBeenCalled();
    set("Товар", MILK.id);
    submit();
    await waitFor(() => expect(document.activeElement).toBe(field("Линия")));
    set("Линия", LINE_2.id);
    submit();
    await waitFor(() => expect(document.activeElement).toBe(field("План, шт")));
    set("План, шт", "");
    fireEvent.click(
      within(dialog()).getByRole("button", { name: "Очистить дату: Дата производства" }),
    );
    submit();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(dialog()).getByRole("button", { name: "Дата производства" }),
      ),
    );
    expect(session.api.createShift).not.toHaveBeenCalled();
  });

  it("puts the focus on the field the host refused", async () => {
    const session = shiftsSession();
    session.api.createShift.mockRejectedValue(api("validation_failed", { field: "lineId" }));
    await openCreate(session);
    fillMilk();
    await settleSelect();
    submit();
    await waitFor(() => expect(messageOf("Линия")).toBe("Линия в архиве. Выберите другую."));
    await waitFor(() => expect(document.activeElement).toBe(field("Линия")));
  });

  it("holds every control while the write is on its way and frees them after a refusal", async () => {
    const session = shiftsSession();
    let fail: (error: unknown) => void = () => undefined;
    session.api.createShift.mockReturnValueOnce(
      new Promise<OfficeShift>((_resolve, reject) => {
        fail = reject;
      }),
    );
    await openCreate(session);
    fillMilk();
    submit();
    await waitFor(() => expect(session.api.createShift).toHaveBeenCalledTimes(1));
    const controls = (): HTMLElement[] => [
      field("Товар"),
      field("Линия"),
      within(dialog()).getByRole("button", { name: "Дата производства" }),
      field("План, шт"),
      field("Вместимость короба, шт"),
      field("Шаблон этикетки короба"),
      field("Контрагент"),
    ];
    const disabled = (control: HTMLElement) =>
      (control as HTMLInputElement | HTMLSelectElement | HTMLButtonElement).disabled;
    await waitFor(() => expect(controls().map(disabled)).toEqual(Array(7).fill(true)));
    expect(
      (within(dialog()).getByRole("button", { name: "Отмена" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await act(async () => {
      fail(api("internal"));
      await Promise.resolve();
    });
    await waitFor(() => expect(controls().map(disabled)).toEqual(Array(7).fill(false)));
    expect(await within(dialog()).findByRole("alert")).toBeTruthy();
    // The form kept what was typed, and a second try goes out.
    expect(valueOf("План, шт")).toBe(" 1200 ");
    session.api.createShift.mockResolvedValueOnce(CREATED);
    submit();
    await screen.findByText("Смена OCT26-006 запланирована.");
    expect(session.api.createShift).toHaveBeenCalledTimes(2);
  });

  it("says when a list does not load and leaves its control off", async () => {
    const session = shiftsSession();
    session.api.listProducts.mockRejectedValue(api("internal"));
    session.api.listLines.mockRejectedValue(api("internal"));
    session.api.listCounterparties.mockRejectedValue(api("internal"));
    await openShifts(session);
    fireEvent.click(screen.getByRole("button", { name: "Запланировать смену" }));
    await screen.findByRole("dialog", { name: "Новая смена" });
    for (const [label, hint] of [
      ["Товар", "Список товаров не загрузился. Закройте окно и откройте его снова."],
      ["Линия", "Список линий не загрузился. Закройте окно и откройте его снова."],
      ["Контрагент", "Список контрагентов не загрузился: смена будет без контрагента."],
    ] as const) {
      await waitFor(() => expect(messageOf(label)).toBe(hint));
      expect((field(label) as HTMLSelectElement).disabled).toBe(true);
    }
  });

  it("drops what was typed when the dialog is closed, sends nothing and opens clean", async () => {
    const session = shiftsSession();
    await openCreate(session);
    fillMilk();
    pickDate("Дата производства", "12 октября 2026");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Отмена" }));
    expect(screen.queryByRole("dialog", { name: "Новая смена" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Запланировать смену" }));
    await screen.findByRole("dialog", { name: "Новая смена" });
    await waitFor(() => expect((field("Товар") as HTMLSelectElement).disabled).toBe(false));
    expect(valueOf("Товар")).toBe("");
    expect(valueOf("План, шт")).toBe("");
    expect(valueOf("Вместимость короба, шт")).toBe("");
    expect(valueOf("Контрагент")).toBe("");
    expect(within(dialog()).getByRole("button", { name: "Дата производства" }).textContent).toBe(
      "9 октября 2026",
    );
    expect(session.api.createShift).not.toHaveBeenCalled();
  });

  it("takes the notice away when the next dialog opens", async () => {
    const session = shiftsSession();
    session.api.createShift.mockResolvedValue(CREATED);
    await openCreate(session);
    fillMilk();
    submit();
    await screen.findByText("Смена OCT26-006 запланирована.");
    fireEvent.click(screen.getByRole("button", { name: "Запланировать смену" }));
    await screen.findByRole("dialog", { name: "Новая смена" });
    expect(screen.queryByText("Смена OCT26-006 запланирована.")).toBeNull();
  });

  it("takes the alert away when the next submit starts", async () => {
    const session = shiftsSession();
    session.api.createShift
      .mockRejectedValueOnce(api("internal"))
      .mockRejectedValueOnce(api("validation_failed", { field: "lineId" }));
    await openCreate(session);
    fillMilk();
    submit();
    await within(dialog()).findByRole("alert");
    await waitFor(() => expect((field("Товар") as HTMLSelectElement).disabled).toBe(false));
    submit();
    await waitFor(() => expect(messageOf("Линия")).toBe("Линия в архиве. Выберите другую."));
    expect(within(dialog()).queryByRole("alert")).toBeNull();
  });

  it("shows a product's name with markup as text, never as markup", async () => {
    const session = shiftsSession();
    const hostile = { ...MILK, name: '<img src="x" onerror="window.pwned = 1"> Сок' };
    session.api.listProducts.mockResolvedValue([hostile]);
    await openCreate(session);
    expect(options("Товар")).toEqual([
      `<img src="x" onerror="window.pwned = 1"> Сок — 04600682000013`,
    ]);
    expect(dialog().querySelector("img")).toBeNull();
  });

  it("closes only the calendar on Escape and keeps the dialog with what was typed", async () => {
    const session = shiftsSession();
    await openCreate(session);
    fillMilk();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Дата производства" }));
    const calendar = screen.getByRole("dialog", { name: "Календарь" });
    fireEvent.keyDown(within(calendar).getByRole("button", { name: "9 октября 2026" }), {
      key: "Escape",
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Календарь" })).toBeNull());
    expect(dialog()).toBeTruthy();
    expect(valueOf("Товар")).toBe(MILK.id);
    expect(valueOf("План, шт")).toBe(" 1200 ");
    // With the calendar shut, the same key on the date still closes the dialog.
    fireEvent.keyDown(within(dialog()).getByRole("button", { name: "Дата производства" }), {
      key: "Escape",
    });
    expect(screen.queryByRole("dialog", { name: "Новая смена" })).toBeNull();
  });

  it("reads the shifts again behind the dialog after a lost answer, since the shift may have been made", async () => {
    const session = shiftsSession();
    session.api.createShift.mockRejectedValue(
      new HostError({ kind: "transport", code: "unreachable", message: "x" }),
    );
    await openCreate(session);
    fillMilk();
    submit();
    expect(await within(dialog()).findByRole("alert")).toBeTruthy();
    await waitFor(() => expect(session.api.listShifts).toHaveBeenCalledTimes(2));
  });

  it("does not read the shifts again after an answer of the host that planned nothing", async () => {
    const session = shiftsSession();
    session.api.createShift.mockRejectedValue(api("internal"));
    await openCreate(session);
    fillMilk();
    submit();
    expect(await within(dialog()).findByRole("alert")).toBeTruthy();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(session.api.listShifts).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "a product no longer in use",
      api("conflict", { constraint: "product_inactive" }),
      "Товар",
      "listProducts",
      "Молоко 3,2% 0,9 л",
      MILK.id,
      "Молоко 3,2% 0,9 л (в архиве)",
    ],
    [
      "a product the host does not find",
      api("validation_failed", { field: "productId" }),
      "Товар",
      "listProducts",
      "Молоко 3,2% 0,9 л",
      MILK.id,
      "Молоко 3,2% 0,9 л (в архиве)",
    ],
    [
      "a product that became a draft",
      api("conflict", { constraint: "product_inactive" }),
      "Товар",
      "listProducts",
      "Молоко 3,2% 0,9 л",
      MILK.id,
      "Молоко 3,2% 0,9 л (черновик)",
    ],
    [
      "an archived line",
      api("validation_failed", { field: "lineId" }),
      "Линия",
      "listLines",
      "Линия 2",
      LINE_2.id,
      "Линия 2 (в архиве)",
    ],
    [
      "a counterparty archived meanwhile",
      api("validation_failed", { field: "counterpartyId" }),
      "Контрагент",
      "listCounterparties",
      "ООО «Северный берег»",
      NORTH.id,
      "ООО «Северный берег» (в архиве)",
    ],
  ] as const)(
    "reads the list again after the host refused %s, and keeps the record as a marked choice the select shows",
    async (_what, refusal, label, list, name, id, marked) => {
      const session = shiftsSession();
      session.api.createShift.mockRejectedValue(refusal);
      await openCreate(session);
      fillMilk();
      expect(options(label).some((text) => text.startsWith(name))).toBe(true);
      session.api.listProducts.mockResolvedValue([
        marked.endsWith("(черновик)") ? { ...MILK, status: "draft" } : { ...MILK, archived: true },
        WATER,
      ]);
      session.api.listLines.mockResolvedValue([LINE_10, { ...LINE_2, archived: true }]);
      session.api.listCounterparties.mockResolvedValue([{ ...NORTH, archived: true }]);
      const before = session.api[list].mock.calls.length;
      submit();
      await waitFor(() => expect(session.api[list]).toHaveBeenCalledTimes(before + 1));
      // The refused record is no longer offered as a normal choice, but the form still holds it,
      // so the select shows it - marked - rather than another record or «Не выбран».
      await waitFor(() => expect(options(label)).toContain(marked));
      expect(options(label).filter((text) => text.startsWith(name))).toEqual([marked]);
      const control = field(label);
      expect(valueOn(control)).toBe(id);
      expect(shownOn(control)).toBe(marked);
      // The refusal stays under the field, and the person picks another record.
      expect(messageOf(label)).not.toBeUndefined();
    },
  );

  it("never clears a refused counterparty: a resend after the re-read still names it and is refused again", async () => {
    const session = shiftsSession();
    session.api.createShift.mockRejectedValue(
      api("validation_failed", { field: "counterpartyId" }),
    );
    await openCreate(session);
    fillMilk();
    session.api.listCounterparties.mockResolvedValue([{ ...NORTH, archived: true }]);
    submit();
    await waitFor(() =>
      expect(messageOf("Контрагент")).toBe("Контрагент в архиве. Выберите другого."),
    );
    await waitFor(() => expect(options("Контрагент")).toContain("ООО «Северный берег» (в архиве)"));
    await waitFor(() => expect((field("Товар") as HTMLSelectElement).disabled).toBe(false));
    submit();
    await waitFor(() => expect(session.api.createShift).toHaveBeenCalledTimes(2));
    expect(session.api.createShift).toHaveBeenLastCalledWith(
      TOKEN,
      expect.objectContaining({ counterpartyId: NORTH.id }),
    );
    // The person picks «Не выбран» on purpose: that, and only that, sends no counterparty.
    await waitFor(() => expect((field("Товар") as HTMLSelectElement).disabled).toBe(false));
    session.api.createShift.mockResolvedValueOnce(CREATED);
    set("Контрагент", "");
    submit();
    await screen.findByText("Смена OCT26-006 запланирована.");
    expect(session.api.createShift).toHaveBeenLastCalledWith(
      TOKEN,
      expect.objectContaining({ counterpartyId: null }),
    );
  });

  it.each([
    ["a date", "productionDate"],
    ["a plan", "plannedQty"],
    ["a capacity", "boxCapacity"],
  ])("reads no list again after the host refused %s", async (_what, name) => {
    const session = shiftsSession();
    session.api.createShift.mockRejectedValue(api("validation_failed", { field: name }));
    await openCreate(session);
    fillMilk();
    const lists = [
      session.api.listProducts,
      session.api.listLines,
      session.api.listCounterparties,
      session.api.listTemplates,
    ];
    const before = lists.map((list) => list.mock.calls.length);
    submit();
    await waitFor(() => expect(session.api.createShift).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((field("Товар") as HTMLSelectElement).disabled).toBe(false));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(lists.map((list) => list.mock.calls.length)).toEqual(before);
  });
});

describe("office shifts: the A4 sheet of a new shift (plan А4)", () => {
  const SHEETS = stockSheets();
  const [PORTRAIT, LANDSCAPE, TWO_A5] = SHEETS.sheets as [
    (typeof SHEETS.sheets)[number],
    (typeof SHEETS.sheets)[number],
    (typeof SHEETS.sheets)[number],
  ];
  const MAIN = "По умолчанию для товара (Палета А4 · вертикальная)";

  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
    freezeToday();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function openWithPallets(session: FakeOfficeSession): Promise<void> {
    session.api.listPalletSheets.mockResolvedValue(SHEETS);
    await openCreate(session);
    fillMilk();
    fireEvent.click(within(dialog()).getByRole("checkbox", { name: "С паллетами" }));
    await waitFor(() => expect(options("Лист А4")[0]).toBe(MAIN));
  }

  it("has no sheet field without pallets, reads the sheets only when they are on, and offers the main sheet first", async () => {
    const session = shiftsSession();
    session.api.listPalletSheets.mockResolvedValue(SHEETS);
    await openCreate(session);
    expect(within(dialog()).queryByLabelText("Лист А4")).toBeNull();
    fillMilk();
    expect(session.api.listPalletSheets).not.toHaveBeenCalled();
    fireEvent.click(within(dialog()).getByRole("checkbox", { name: "С паллетами" }));
    await waitFor(() => expect(options("Лист А4")[0]).toBe(MAIN));
    expect(options("Лист А4")).toEqual([
      MAIN,
      "Палета А4 · вертикальная",
      "Палета А4 · горизонтальная",
      "Палета А4 · две одинаковые А5",
    ]);
    expect(valueOf("Лист А4")).toBe("");
    expect(session.api.listPalletSheets).toHaveBeenCalledTimes(1);
    expect(
      within(dialog()).getByText(
        "Печатается вместо термоэтикетки паллеты на станции с принтером А4. Лист по умолчанию (товара, категории или организации) берётся на момент сохранения смены: его последующая замена смену не меняет.",
      ),
    ).toBeTruthy();
    // Off again: the field goes.
    fireEvent.click(within(dialog()).getByRole("checkbox", { name: "С паллетами" }));
    expect(within(dialog()).queryByLabelText("Лист А4")).toBeNull();
  });

  it("sends no sheet for «main»", async () => {
    const session = shiftsSession();
    session.api.createShift.mockResolvedValue(CREATED);
    await openWithPallets(session);
    submit();
    await screen.findByText("Смена OCT26-006 запланирована.");
    const main = session.api.createShift.mock.calls[0]?.[1];
    expect(main).toMatchObject({ palletsEnabled: true, palletTemplateId: PALLET.id });
    expect(main).not.toHaveProperty("palletSheetTemplateId");
  });

  it("sends the sheet that was chosen", async () => {
    const session = shiftsSession();
    session.api.createShift.mockResolvedValue(CREATED);
    await openWithPallets(session);
    set("Лист А4", LANDSCAPE.id);
    submit();
    await screen.findByText("Смена OCT26-006 запланирована.");
    expect(session.api.createShift).toHaveBeenCalledWith(
      TOKEN,
      expect.objectContaining({
        palletsEnabled: true,
        palletTemplateId: PALLET.id,
        palletSheetTemplateId: LANDSCAPE.id,
      }),
    );
  });

  it("sends no sheet once the pallets are off again, whatever was chosen", async () => {
    const session = shiftsSession();
    session.api.createShift.mockResolvedValue(CREATED);
    await openWithPallets(session);
    set("Лист А4", TWO_A5.id);
    fireEvent.click(within(dialog()).getByRole("checkbox", { name: "С паллетами" }));
    submit();
    await screen.findByText("Смена OCT26-006 запланирована.");
    const sent = session.api.createShift.mock.calls[0]?.[1];
    expect(sent).toMatchObject({ palletsEnabled: false });
    expect(sent).not.toHaveProperty("palletSheetTemplateId");
  });

  it("offers no switched-off sheet, and says which sheet is the main one in the first choice", async () => {
    const session = shiftsSession();
    session.api.listPalletSheets.mockResolvedValue({
      sheets: [PORTRAIT, { ...LANDSCAPE, enabled: false }, TWO_A5],
      defaultId: TWO_A5.id,
    });
    await openCreate(session);
    fillMilk();
    fireEvent.click(within(dialog()).getByRole("checkbox", { name: "С паллетами" }));
    await waitFor(() =>
      expect(options("Лист А4")).toEqual([
        "По умолчанию для товара (Палета А4 · две одинаковые А5)",
        "Палета А4 · вертикальная",
        "Палета А4 · две одинаковые А5",
      ]),
    );
  });

  it("says the list of sheets did not load, and still plans the shift on the main sheet", async () => {
    const session = shiftsSession();
    session.api.listPalletSheets.mockRejectedValue(
      new HostError({ kind: "transport", code: "unreachable", message: "down" }),
    );
    session.api.createShift.mockResolvedValue(CREATED);
    await openCreate(session);
    fillMilk();
    fireEvent.click(within(dialog()).getByRole("checkbox", { name: "С паллетами" }));
    await waitFor(() =>
      expect(
        within(dialog()).getByText(
          "Список листов не загрузился: лист смены не меняется, новая смена получит лист по умолчанию для товара.",
        ),
      ).toBeTruthy(),
    );
    expect(options("Лист А4")).toEqual(["По умолчанию для товара (не выбран)"]);
    submit();
    await screen.findByText("Смена OCT26-006 запланирована.");
    expect(session.api.createShift.mock.calls[0]?.[1]).not.toHaveProperty("palletSheetTemplateId");
  });

  it("puts a sheet the host refused under its select, reads the sheets again and drops the refusal with the pallets", async () => {
    const session = shiftsSession();
    session.api.createShift.mockRejectedValue(
      api("validation_failed", { field: "palletSheetTemplateId" }),
    );
    await openWithPallets(session);
    set("Лист А4", LANDSCAPE.id);
    // The sheet was switched off meanwhile: once read again it is no longer offered.
    session.api.listPalletSheets.mockResolvedValue({
      sheets: [PORTRAIT, { ...LANDSCAPE, enabled: false }, TWO_A5],
      defaultId: PORTRAIT.id,
    });
    submit();
    await waitFor(() =>
      expect(messageOf("Лист А4")).toBe(
        "Лист выключен, удалён или не подходит смене. Выберите другой.",
      ),
    );
    await waitFor(() => expect(session.api.listPalletSheets).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(document.activeElement).toBe(field("Лист А4")));
    // The sheet the person chose stays visible, marked, so the select does not show another.
    await waitFor(() =>
      expect(options("Лист А4")).toContain("Палета А4 · горизонтальная (выключен)"),
    );
    // The sheet does not depend on the product: a new product leaves the refusal where it is.
    set("Товар", WATER.id);
    expect(messageOf("Лист А4")).toBe(
      "Лист выключен, удалён или не подходит смене. Выберите другой.",
    );
    fireEvent.click(within(dialog()).getByRole("checkbox", { name: "С паллетами" }));
    fireEvent.click(within(dialog()).getByRole("checkbox", { name: "С паллетами" }));
    // The select shows its hint again, not the refusal.
    expect(messageOf("Лист А4")).toBe(
      "Печатается вместо термоэтикетки паллеты на станции с принтером А4. Лист по умолчанию (товара, категории или организации) берётся на момент сохранения смены: его последующая замена смену не меняет.",
    );
  });

  it("holds the sheet select while the write is on its way", async () => {
    const session = shiftsSession();
    session.api.createShift.mockReturnValueOnce(new Promise<OfficeShift>(() => undefined));
    await openWithPallets(session);
    submit();
    await waitFor(() => expect(session.api.createShift).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((field("Лист А4") as HTMLSelectElement).disabled).toBe(true));
  });

  it("tells sheets of one name apart by the start of their id", async () => {
    const session = shiftsSession();
    session.api.listPalletSheets.mockResolvedValue({
      sheets: [PORTRAIT, { ...LANDSCAPE, name: PORTRAIT.name }],
      defaultId: PORTRAIT.id,
    });
    await openCreate(session);
    fillMilk();
    fireEvent.click(within(dialog()).getByRole("checkbox", { name: "С паллетами" }));
    await waitFor(() => expect(options("Лист А4")).toHaveLength(3));
    expect(options("Лист А4").slice(1)).toEqual([
      `${PORTRAIT.name} · ${PORTRAIT.id.slice(0, 8)}`,
      `${PORTRAIT.name} · ${LANDSCAPE.id.slice(0, 8)}`,
    ]);
  });
});
