import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { buildPalletSheetPresets } from "@markiro/domain";

import { HostError } from "../src/host/client.js";
import type {
  CounterpartyRecord,
  LabelTemplateSummary,
  OfficeProduct,
  ProductGroup,
} from "../src/host/protocol.js";
import { gtinOwner } from "../src/office/products/product-form.js";
import {
  fakeOfficeSession,
  ORG_PROFILE,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";
import { chooseValue, openSelect, optionTextOf, optionTexts, valueOf } from "./support/select.js";

const GROUPS: ProductGroup[] = [
  { code: 13, alias: "water", name: "Упакованная вода" },
  { code: 8, alias: "milk", name: "Молочная продукция" },
];

const NORTH: CounterpartyRecord = {
  id: "d2b7c9e1-4f3a-4b6c-8d5e-9f0a1b2c3d4e",
  name: "ООО «Северный берег»",
  inn: "7812345678",
  gln: "4601234000017",
  gs1Prefixes: ["4601234"],
  archived: false,
  rev: 12,
};
const OLD: CounterpartyRecord = {
  id: "5c9b8a7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d",
  name: "Альфа",
  inn: null,
  gln: "4602222000026",
  gs1Prefixes: ["4602222"],
  archived: true,
  rev: 7,
};

const MILK_58 = "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d";
const MILK: OfficeProduct = {
  id: "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b",
  gtin14: "04600682000013",
  name: "Молоко 3,2% 0,9 л",
  printName: "Молоко 3,2%",
  chzProductGroupCode: 8,
  boxCapacity: 12,
  palletBoxCapacity: 40,
  shelfLifeDays: 10,
  defaultBoxTemplateId: MILK_58,
  defaultPalletTemplateId: null,
  defaultPalletSheetId: null,
  archived: false,
  status: "active",
  rev: 65,
};
/** Archived: its GTIN is free, and another product may hold it now. */
const AYRAN: OfficeProduct = {
  ...MILK,
  id: "4d5e6f70-8192-4a34-9c5d-6e7f80910213",
  gtin14: "04605555000015",
  name: "Айран",
  printName: null,
  defaultBoxTemplateId: null,
  archived: true,
  rev: 72,
};

/** A template summary: a box template for every category unless told otherwise. */
function summary(id: string, name: string, data: Partial<LabelTemplateSummary> = {}) {
  return {
    id,
    name,
    purpose: "box",
    enabled: true,
    chzProductGroupCodes: null,
    stock: false,
    widthMm: 58,
    heightMm: 40,
    dpi: 203,
    language: "zpl",
    rev: 60,
    ...data,
  } satisfies LabelTemplateSummary;
}

const BOX_58 = "7c1e4b2a-9d3f-4e5a-8b6c-1d2e3f4a5b6c";
const WATER_58 = "8d2f5c3b-0e4a-4f6b-9c7d-2e3f4a5b6c7d";
const OLD_BOX = "9e3a6d4c-1f5b-4a7c-8d8e-3f4a5b6c7d8e";
const PALLET = "0f4b7e5d-2a6c-4b8d-9e9f-4a5b6c7d8e9f";
const TEMPLATES: LabelTemplateSummary[] = [
  summary(MILK_58, "Молоко 58×40", { chzProductGroupCodes: [8] }),
  summary(WATER_58, "Вода 58×40", { chzProductGroupCodes: [13] }),
  summary(BOX_58, "Коробка 58×40"),
  summary(OLD_BOX, "Старая коробка", { enabled: false }),
  summary(PALLET, "Паллета 100×150", { purpose: "pallet" }),
  summary("1a5c8f6e-3b7d-4c9e-8f0a-5b6c7d8e9f0a", "Дубликат", { purpose: "product_duplicate" }),
];

function session(user = TECHNOLOGIST): FakeOfficeSession {
  const fake = fakeOfficeSession({ user });
  fake.api.listProducts.mockResolvedValue([MILK, AYRAN]);
  fake.api.listProductGroups.mockResolvedValue(GROUPS);
  fake.api.listTemplates.mockResolvedValue(TEMPLATES);
  fake.api.getOrg.mockResolvedValue(ORG_PROFILE);
  fake.api.listCounterparties.mockResolvedValue([NORTH, OLD]);
  return fake;
}

/** The labels a select offers, top to bottom. */
function choices(label: string): string[] {
  return optionTexts(label);
}

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function dialog(): HTMLElement {
  return screen.getByRole("dialog");
}

async function openProducts(fake: FakeOfficeSession): Promise<void> {
  renderOffice(fake);
  fireEvent.click(await screen.findByRole("link", { name: "Товары" }));
  await screen.findByText("Молоко 3,2% 0,9 л");
}

/** Opens «Добавить товар» and waits for the lists the dialog reads. */
async function openCreate(fake: FakeOfficeSession): Promise<void> {
  await openProducts(fake);
  fireEvent.click(screen.getByRole("button", { name: "Добавить товар" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Товарная группа")).toHaveProperty("disabled", false),
  );
}

function hostError(code: string, status: number, details: Record<string, unknown> = {}): HostError {
  return new HostError({ kind: "api", code, status, message: code, details });
}

const VALIDATION = (field: string) => hostError("validation_failed", 400, { field });

describe("office product dialog", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  it("lets both office roles add and change products", async () => {
    for (const user of [TECHNOLOGIST, { ...TECHNOLOGIST, role: "admin" as const }]) {
      const view = renderOffice(session(user));
      fireEvent.click(await screen.findByRole("link", { name: "Товары" }));
      expect(
        await screen.findByRole("button", { name: "Изменить товар «Молоко 3,2% 0,9 л»" }),
      ).toBeTruthy();
      expect(screen.getByRole("button", { name: "Добавить товар" })).toBeTruthy();
      view.unmount();
    }
  });

  it("lets a long list be searched: the groups and the templates have a filter in the open list, the state filter does not", async () => {
    await openCreate(session());
    await waitFor(() =>
      expect(screen.getByLabelText("Шаблон короба")).toHaveProperty("disabled", false),
    );
    const list = openSelect("Товарная группа");
    const search = within(list).getByRole("searchbox", { name: "Поиск по списку" });
    expect(search.getAttribute("placeholder")).toBe("Начните вводить");
    fireEvent.change(search, { target: { value: "вода" } });
    expect(
      within(list)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Упакованная вода"]);
    fireEvent.change(search, { target: { value: "кефир" } });
    expect(within(list).queryAllByRole("option")).toHaveLength(0);
    expect(within(list).getByRole("status").textContent).toBe("Ничего не найдено");
    fireEvent.keyDown(list, { key: "Escape" });
    // The next opening starts afresh, with every group.
    const again = openSelect("Товарная группа");
    expect(within(again).getByRole("searchbox", { name: "Поиск по списку" })).toHaveProperty(
      "value",
      "",
    );
    expect(within(again).getAllByRole("option").length).toBeGreaterThan(2);
    fireEvent.keyDown(again, { key: "Escape" });
    for (const label of ["Шаблон короба", "Шаблон паллеты"]) {
      const templates = openSelect(label);
      expect(within(templates).getByRole("searchbox", { name: "Поиск по списку" })).toBeTruthy();
      fireEvent.keyDown(templates, { key: "Escape" });
    }
  });

  it("adds a product, sending the GTIN as its 14 digits and every field by name; a new product has no archive box, and its form submits while still pristine", async () => {
    const fake = session();
    const created: OfficeProduct = {
      ...MILK,
      id: "0f1e2d3c-4b5a-4968-8776-655443322110",
      name: "Молоко 2,5% 1 л",
      printName: null,
      defaultBoxTemplateId: null,
      rev: 80,
    };
    fake.api.createProduct.mockResolvedValue(created);
    await openCreate(fake);
    expect(within(dialog()).queryByRole("checkbox")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Новый товар" })).toBeTruthy();
    // A new product has nothing to change yet, and its form still submits.
    expect(within(dialog()).getByRole("button", { name: "Добавить" })).toHaveProperty(
      "disabled",
      false,
    );
    type("GTIN", " 4600682000013 ");
    type("Название", " Молоко 2,5% 1 л ");
    type("Название для печати", "   ");
    chooseValue("Товарная группа", "8");
    type("В коробе, шт.", "12");
    type("Коробов на паллете", "40");
    type("Срок годности, дней", " 10 ");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    expect(await screen.findByText("Товар «Молоко 2,5% 1 л» добавлен.")).toBeTruthy();
    expect(fake.api.createProduct.mock.calls).toStrictEqual([
      [
        "office-session-token",
        {
          gtin14: "04600682000013",
          name: "Молоко 2,5% 1 л",
          printName: null,
          chzProductGroupCode: 8,
          boxCapacity: 12,
          palletBoxCapacity: 40,
          shelfLifeDays: 10,
          defaultBoxTemplateId: null,
          defaultPalletTemplateId: null,
          defaultPalletSheetId: null,
        },
      ],
    ]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Молоко 2,5% 1 л")).toBeTruthy();
  });

  it("checks the fields like the host, and a GTIN's check digit, before sending", async () => {
    const fake = session();
    await openCreate(fake);
    type("GTIN", "4600682000010");
    type("Название", "  ");
    type("Название для печати", "я".repeat(201));
    type("В коробе, шт.", "0");
    type("Коробов на паллете", "1e3");
    type("Срок годности, дней", "3651");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    expect(await screen.findByText("Неверная контрольная цифра GTIN")).toBeTruthy();
    expect(screen.getByText("Укажите название товара, до 200 символов")).toBeTruthy();
    expect(screen.getByText("Название для печати — до 200 символов")).toBeTruthy();
    expect(
      screen.getByText("Укажите целое число от 1 до 100 000 или оставьте пустым"),
    ).toBeTruthy();
    expect(screen.getByText("Укажите целое число от 1 до 10 000 или оставьте пустым")).toBeTruthy();
    expect(
      screen.getByText("Укажите целое число дней от 1 до 3650 или оставьте пустым"),
    ).toBeTruthy();
    // Each message sits under its own field, not just somewhere in the form.
    for (const [label, message] of [
      ["GTIN", "Неверная контрольная цифра GTIN"],
      ["Название", "Укажите название товара, до 200 символов"],
      ["Название для печати", "Название для печати — до 200 символов"],
      ["В коробе, шт.", "Укажите целое число от 1 до 100 000 или оставьте пустым"],
      ["Коробов на паллете", "Укажите целое число от 1 до 10 000 или оставьте пустым"],
      ["Срок годности, дней", "Укажите целое число дней от 1 до 3650 или оставьте пустым"],
    ] as const) {
      expect(screen.getByLabelText(label).getAttribute("aria-describedby")).toBe(
        screen.getByText(message).id,
      );
    }
    expect(fake.api.createProduct).not.toHaveBeenCalled();
  });

  it("says a GTIN of a wrong length in its own words", async () => {
    await openCreate(session());
    type("GTIN", "46006820000");
    type("Название", "Молоко");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    expect(await screen.findByText("GTIN — 8, 12, 13 или 14 цифр")).toBeTruthy();
  });

  it("shows the 14 digits a valid GTIN is saved as when they differ from what was typed", async () => {
    await openCreate(session());
    type("GTIN", "4600682000013");
    expect(await screen.findByText("Сохранится как 04600682000013.")).toBeTruthy();
    // A screen reader hears the note when it appears.
    expect(
      screen
        .getByText("Сохранится как 04600682000013.")
        .closest("[aria-live]")
        ?.getAttribute("aria-live"),
    ).toBe("polite");
    type("GTIN", "04600682000013");
    await waitFor(() => expect(screen.queryByText(/^Сохранится как/)).toBeNull());
    // Spaces around the 14 digits are not a difference either.
    type("GTIN", " 04600682000013 ");
    await waitFor(() => expect(screen.queryByText(/^Сохранится как/)).toBeNull());
    type("GTIN", "4600682000010");
    await waitFor(() => expect(screen.queryByText(/^Префикс GTIN/)).toBeNull());
  });

  it("says whose prefix a valid GTIN has: the organization's, a counterparty's or nobody's", async () => {
    await openCreate(session());
    type("GTIN", "4600682000013");
    expect(await screen.findByText("Префикс GTIN — вашей организации.")).toBeTruthy();
    type("GTIN", "4601234000017");
    expect(
      await screen.findByText("Префикс GTIN — контрагента «ООО «Северный берег»»."),
    ).toBeTruthy();
    type("GTIN", "4602222000026");
    expect(await screen.findByText("Префикс GTIN — контрагента «Альфа (в архиве)».")).toBeTruthy();
    type("GTIN", "4607091000009");
    expect(
      await screen.findByText(
        "Владелец GTIN не определён: префикс не совпал ни с организацией, ни с контрагентами.",
      ),
    ).toBeTruthy();
  });

  it("finds a GTIN's owner like the cloud's `checkGtinOwner`, except that counterparties go active first, by name; one matching prefix of several is enough", () => {
    // The matching prefix comes last: `every`, or only the first prefix, would miss it.
    const second = {
      ...NORTH,
      id: "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d",
      name: "Альфа-2",
      gs1Prefixes: ["4609999", "4601234"],
    };
    expect(gtinOwner("04601234000017", ["4600682"], [NORTH, second])).toEqual({
      kind: "counterparty",
      counterparty: second,
    });
    expect(gtinOwner("04601234000017", ["4601234"], [NORTH])).toEqual({ kind: "own" });
    expect(gtinOwner("04601234000017", ["4609999", "4601234"], [])).toEqual({ kind: "own" });
    expect(gtinOwner("04601234000017", [], [{ ...second, archived: true }, NORTH])).toEqual({
      kind: "counterparty",
      counterparty: NORTH,
    });
    expect(gtinOwner("04607091000009", ["4600682"], [NORTH, OLD])).toEqual({ kind: "unknown" });
  });

  it("leaves the owner out when the organization or the counterparties do not load, and still saves", async () => {
    const fake = session();
    fake.api.getOrg.mockRejectedValue(hostError("internal", 500));
    fake.api.createProduct.mockResolvedValue({
      ...MILK,
      id: "0f1e2d3c-4b5a-4968-8776-655443322110",
    });
    await openCreate(fake);
    type("GTIN", "4600682000013");
    type("Название", "Молоко");
    expect(await screen.findByText("Сохранится как 04600682000013.")).toBeTruthy();
    expect(screen.queryByText(/^Префикс GTIN|^Владелец GTIN/)).toBeNull();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    await waitFor(() => expect(fake.api.createProduct).toHaveBeenCalledTimes(1));
    // The same when the counterparties fail and the organization alone could answer.
    cleanup();
    const other = session();
    other.api.listCounterparties.mockRejectedValue(hostError("internal", 500));
    await openCreate(other);
    type("GTIN", "4600682000013");
    expect(await screen.findByText("Сохранится как 04600682000013.")).toBeTruthy();
    await waitFor(() => expect(other.api.listCounterparties).toHaveBeenCalledTimes(1));
    // Two passes of the scheduler: the failure has been taken in.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(screen.queryByText(/^Префикс GTIN|^Владелец GTIN/)).toBeNull();
  });

  it("shows the draft note while the group or either capacity is missing", async () => {
    await openCreate(session());
    const hint =
      "Товар остаётся черновиком, пока не указаны товарная группа, вместимость короба и число коробов на паллете.";
    expect(screen.getByText(hint)).toBeTruthy();
    chooseValue("Товарная группа", "8");
    type("В коробе, шт.", "12");
    expect(screen.getByText(hint)).toBeTruthy();
    type("Коробов на паллете", "40");
    await waitFor(() => expect(screen.queryByText(hint)).toBeNull());
    // Each of the three brings the line back on its own; spaces are no capacity.
    chooseValue("Товарная группа", "");
    expect(screen.getByText(hint)).toBeTruthy();
    chooseValue("Товарная группа", "8");
    await waitFor(() => expect(screen.queryByText(hint)).toBeNull());
    type("В коробе, шт.", "  ");
    expect(screen.getByText(hint)).toBeTruthy();
    type("В коробе, шт.", "12");
    await waitFor(() => expect(screen.queryByText(hint)).toBeNull());
    type("Коробов на паллете", "  ");
    expect(screen.getByText(hint)).toBeTruthy();
  });

  it("saves a change as the whole record with the loaded revision, archive included, puts the returned record in the old row's place, and drops the notice when the next dialog opens", async () => {
    const fake = session();
    // Both default templates travel with the record: the box one comes with `MILK`,
    // the pallet one is added here.
    fake.api.listProducts.mockResolvedValue([{ ...MILK, defaultPalletTemplateId: PALLET }, AYRAN]);
    fake.api.updateProduct.mockResolvedValue({
      ...MILK,
      name: "Молоко 3,2% 1 л",
      archived: true,
      rev: 81,
    });
    await openProducts(fake);
    fireEvent.click(screen.getByRole("button", { name: "Изменить товар «Молоко 3,2% 0,9 л»" }));
    expect(screen.getByRole("dialog", { name: "Товар «Молоко 3,2% 0,9 л»" })).toBeTruthy();
    const save = within(dialog()).getByRole("button", { name: "Сохранить" });
    expect(save).toHaveProperty("disabled", true);
    type("Название", "Молоко 3,2% 1 л");
    fireEvent.click(within(dialog()).getByRole("checkbox", { name: "В архиве" }));
    fireEvent.click(save);
    expect(await screen.findByText("Изменения сохранены.")).toBeTruthy();
    expect(fake.api.updateProduct.mock.calls).toStrictEqual([
      [
        "office-session-token",
        MILK.id,
        {
          gtin14: "04600682000013",
          name: "Молоко 3,2% 1 л",
          printName: "Молоко 3,2%",
          chzProductGroupCode: 8,
          boxCapacity: 12,
          palletBoxCapacity: 40,
          shelfLifeDays: 10,
          defaultBoxTemplateId: MILK_58,
          defaultPalletTemplateId: PALLET,
          defaultPalletSheetId: null,
          archived: true,
          expectedRev: 65,
        },
      ],
    ]);
    // The record the host returned took the old row's place, and sorts as archived now.
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getAllByRole("cell")[1]?.textContent)).toEqual([
      "Айран",
      "Молоко 3,2% 1 лДля печати: Молоко 3,2%",
    ]);
    // The notice goes when another dialog opens.
    fireEvent.click(screen.getByRole("button", { name: "Добавить товар" }));
    expect(screen.queryByText("Изменения сохранены.")).toBeNull();
  });

  it("puts a taken GTIN under the GTIN when a product comes back from the archive, and saves it under another", async () => {
    const fake = session();
    fake.api.updateProduct
      .mockRejectedValueOnce(hostError("conflict", 409, { constraint: "gtin14" }))
      .mockResolvedValueOnce({ ...AYRAN, gtin14: "04607091000009", archived: false, rev: 82 });
    await openProducts(fake);
    fireEvent.click(screen.getByRole("button", { name: "Изменить товар «Айран»" }));
    fireEvent.click(within(dialog()).getByRole("checkbox", { name: "В архиве" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    const message = await screen.findByText("Этот GTIN уже у товара в работе");
    expect(screen.getByLabelText("GTIN").getAttribute("aria-describedby")).toBe(message.id);
    type("GTIN", "4607091000009");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Изменения сохранены.")).toBeTruthy();
    expect(
      fake.api.updateProduct.mock.calls.map((call) => [call[2].gtin14, call[2].archived]),
    ).toEqual([
      ["04605555000015", false],
      ["04607091000009", false],
    ]);
  });

  it("puts the host's refusal of a field under that field, and takes an earlier alert away", async () => {
    const fake = session();
    // The first save fails as a whole and shows an alert; its retry is refused on a field.
    fake.api.createProduct.mockRejectedValueOnce(hostError("internal", 500));
    fake.api.createProduct.mockRejectedValueOnce(VALIDATION("shelfLifeDays"));
    await openCreate(fake);
    type("GTIN", "4600682000013");
    type("Название", "Молоко");
    type("Срок годности, дней", "10");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    expect(await screen.findByText("На хосте произошла ошибка. Повторите попытку.")).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    const message = await screen.findByText("Хост не принял это значение. Проверьте его.");
    expect(screen.queryByText("На хосте произошла ошибка. Повторите попытку.")).toBeNull();
    expect(screen.getByLabelText("Срок годности, дней").getAttribute("aria-describedby")).toBe(
      message.id,
    );
    // Every other field the host names goes under its own, one refusal after the other.
    for (const [field, label] of [
      ["gtin14", "GTIN"],
      ["name", "Название"],
      ["printName", "Название для печати"],
      ["chzProductGroupCode", "Товарная группа"],
      ["boxCapacity", "В коробе, шт."],
      ["palletBoxCapacity", "Коробов на паллете"],
    ] as const) {
      fake.api.createProduct.mockRejectedValueOnce(VALIDATION(field));
      fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
      await waitFor(() => {
        const described = screen.getByLabelText(label).getAttribute("aria-describedby");
        expect(document.getElementById(described ?? "")?.textContent).toBe(
          "Хост не принял это значение. Проверьте его.",
        );
      });
    }
  });

  it("offers to load the products again after a stale change", async () => {
    const fake = session();
    fake.api.updateProduct.mockRejectedValueOnce(
      hostError("stale_revision", 409, { currentRev: 66 }),
    );
    await openProducts(fake);
    fireEvent.click(screen.getByRole("button", { name: "Изменить товар «Молоко 3,2% 0,9 л»" }));
    type("Название", "Молоко 3,2% 1 л");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    fireEvent.click(await screen.findByRole("button", { name: "Загрузить заново" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(fake.api.listProducts).toHaveBeenCalledTimes(2));
  });

  it("sends one request for a double click, and none while it is on its way; the request is a draft, with a blank group, capacities and shelf life sent as `null`", async () => {
    const fake = session();
    let answer: (product: OfficeProduct) => void = () => undefined;
    fake.api.createProduct.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    await openCreate(fake);
    type("GTIN", "4600682000013");
    type("Название", "Молоко 2,5% 1 л");
    const add = within(dialog()).getByRole("button", { name: "Добавить" });
    // Both clicks in one `act`: nothing renders between them, so the button is
    // not yet disabled for the second, and only the dialog's own guard drops it.
    act(() => {
      fireEvent.click(add);
      fireEvent.click(add);
    });
    await waitFor(() => expect(add).toHaveProperty("disabled", true));
    fireEvent.click(add);
    expect(fake.api.createProduct).toHaveBeenCalledTimes(1);
    await act(async () => {
      answer({ ...MILK, id: "0f1e2d3c-4b5a-4968-8776-655443322110", name: "Молоко 2,5% 1 л" });
    });
    expect(await screen.findByText("Товар «Молоко 2,5% 1 л» добавлен.")).toBeTruthy();
    expect(fake.api.createProduct).toHaveBeenCalledTimes(1);
    // The one request is a draft: every field left blank goes as `null`.
    expect(fake.api.createProduct.mock.calls[0]?.[1]).toStrictEqual({
      gtin14: "04600682000013",
      name: "Молоко 2,5% 1 л",
      printName: null,
      chzProductGroupCode: null,
      boxCapacity: null,
      palletBoxCapacity: null,
      shelfLifeDays: null,
      defaultBoxTemplateId: null,
      defaultPalletTemplateId: null,
      defaultPalletSheetId: null,
    });
  });

  it("offers the groups by name, keeps a product's group the lookup lacks, and does not offer a group the lookup has twice; «Отмена» closes the dialog", async () => {
    const fake = session();
    fake.api.listProducts.mockResolvedValue([{ ...MILK, chzProductGroupCode: 99 }, AYRAN]);
    await openProducts(fake);
    fireEvent.click(screen.getByRole("button", { name: "Изменить товар «Молоко 3,2% 0,9 л»" }));
    const select = screen.getByLabelText("Товарная группа");
    await waitFor(() => expect(select).toHaveProperty("disabled", false));
    expect(choices("Товарная группа")).toEqual([
      "Без группы",
      "Молочная продукция",
      "Упакованная вода",
      "Код 99 — нет в справочнике",
    ]);
    expect(valueOf("Товарная группа")).toBe("99");
    expect(
      screen.queryByText("Справочник групп не загрузился: группу сейчас не изменить."),
    ).toBeNull();
    // A group the lookup has is not offered twice.
    fireEvent.click(within(dialog()).getByRole("button", { name: "Отмена" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Изменить товар «Айран»" }));
    const known = screen.getByLabelText("Товарная группа");
    expect(known).toBeTruthy();
    expect(choices("Товарная группа")).toEqual([
      "Без группы",
      "Молочная продукция",
      "Упакованная вода",
    ]);
    expect(valueOf("Товарная группа")).toBe("8");
  });

  it("keeps the product's group when the lookup does not load, and sends it unchanged", async () => {
    const fake = session();
    fake.api.listProductGroups.mockRejectedValue(hostError("internal", 500));
    fake.api.updateProduct.mockResolvedValue({ ...MILK, name: "Молоко 3,2% 1 л", rev: 81 });
    await openProducts(fake);
    fireEvent.click(screen.getByRole("button", { name: "Изменить товар «Молоко 3,2% 0,9 л»" }));
    expect(
      await screen.findByText("Справочник групп не загрузился: группу сейчас не изменить."),
    ).toBeTruthy();
    const select = screen.getByLabelText("Товарная группа");
    expect(select).toHaveProperty("disabled", true);
    expect(valueOf("Товарная группа")).toBe("8");
    // Only its code: nothing is said about a lookup that did not load.
    expect(choices("Товарная группа")).toEqual(["Без группы", "Код 8"]);
    type("Название", "Молоко 3,2% 1 л");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    await screen.findByText("Изменения сохранены.");
    expect(fake.api.updateProduct.mock.calls[0]?.[2].chzProductGroupCode).toBe(8);
    // While the lookup is still on its way the choice is off too, but no failure is claimed.
    cleanup();
    const slow = session();
    slow.api.listProductGroups.mockReturnValue(new Promise(() => undefined));
    await openProducts(slow);
    fireEvent.click(screen.getByRole("button", { name: "Изменить товар «Молоко 3,2% 0,9 л»" }));
    expect(screen.getByLabelText("Товарная группа")).toHaveProperty("disabled", true);
    expect(
      screen.queryByText("Справочник групп не загрузился: группу сейчас не изменить."),
    ).toBeNull();
  });
});

describe("office product dialog: default templates", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  /** Opens a product's dialog and waits for the templates. */
  async function openEdit(fake: FakeOfficeSession, name: string): Promise<void> {
    await openProducts(fake);
    fireEvent.click(screen.getByRole("button", { name: `Изменить товар «${name}»` }));
    await waitFor(() =>
      expect(screen.getByLabelText("Шаблон короба")).toHaveProperty("disabled", false),
    );
  }

  it("offers in each slot the templates that fit the product's group, by name, and none", async () => {
    const fake = session();
    // By name counts numbers by value: 80 comes before 100.
    fake.api.listTemplates.mockResolvedValue([
      ...TEMPLATES,
      summary("4d8e1c9b-6f0a-4b2c-9d3e-8f9a0b1c2d3e", "Паллета 80×120", { purpose: "pallet" }),
    ]);
    fake.api.createProduct.mockResolvedValue({
      ...MILK,
      id: "0f1e2d3c-4b5a-4968-8776-655443322110",
    });
    await openCreate(fake);
    await waitFor(() =>
      expect(screen.getByLabelText("Шаблон короба")).toHaveProperty("disabled", false),
    );
    // Once the list is in, each select says what its choice is for.
    expect(
      screen.getAllByText(
        "Необязательно: станция возьмёт этот шаблон первым, пока он подходит товару",
      ),
    ).toHaveLength(2);
    // No group yet: only templates for every category fit.
    expect(choices("Шаблон короба")).toEqual(["Не выбран", "Коробка 58×40"]);
    expect(choices("Шаблон паллеты")).toEqual(["Не выбран", "Паллета 80×120", "Паллета 100×150"]);
    chooseValue("Товарная группа", "8");
    expect(choices("Шаблон короба")).toEqual(["Не выбран", "Коробка 58×40", "Молоко 58×40"]);
    chooseValue("Шаблон короба", MILK_58);
    chooseValue("Шаблон паллеты", PALLET);
    // What the form chose stays a marked choice when the group stops admitting it.
    chooseValue("Товарная группа", "13");
    expect(choices("Шаблон короба")).toEqual([
      "Не выбран",
      "Вода 58×40",
      "Коробка 58×40",
      "Молоко 58×40 — не подходит",
    ]);
    expect(valueOf("Шаблон короба")).toBe(MILK_58);
    chooseValue("Товарная группа", "8");
    type("GTIN", "4600682000013");
    type("Название", "Молоко");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    await waitFor(() => expect(fake.api.createProduct).toHaveBeenCalledTimes(1));
    expect(fake.api.createProduct.mock.calls[0]?.[1]).toMatchObject({
      chzProductGroupCode: 8,
      defaultBoxTemplateId: MILK_58,
      defaultPalletTemplateId: PALLET,
    });
  });

  it("keeps a preference that no longer fits as a marked choice, and sends it unless it is changed", async () => {
    const fake = session();
    fake.api.listProducts.mockResolvedValue([{ ...MILK, defaultBoxTemplateId: OLD_BOX }]);
    fake.api.updateProduct.mockResolvedValue({ ...MILK, name: "Молоко 3,2% 1 л", rev: 81 });
    await openEdit(fake, "Молоко 3,2% 0,9 л");
    const offered = ["Не выбран", "Коробка 58×40", "Молоко 58×40", "Старая коробка — не подходит"];
    expect(choices("Шаблон короба")).toEqual(offered);
    expect(valueOf("Шаблон короба")).toBe(OLD_BOX);
    // Choosing another template does not take the old preference away: it can be chosen again.
    chooseValue("Шаблон короба", BOX_58);
    expect(choices("Шаблон короба")).toEqual(offered);
    chooseValue("Шаблон короба", OLD_BOX);
    expect(valueOf("Шаблон короба")).toBe(OLD_BOX);
    type("Название", "Молоко 3,2% 1 л");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    await screen.findByText("Изменения сохранены.");
    expect(fake.api.updateProduct.mock.calls[0]?.[2].defaultBoxTemplateId).toBe(OLD_BOX);
  });

  it("keeps a chosen template as a marked choice when the group changes and it stops fitting", async () => {
    const fake = session();
    fake.api.updateProduct.mockResolvedValue({ ...MILK, chzProductGroupCode: 13, rev: 81 });
    await openEdit(fake, "Молоко 3,2% 0,9 л");
    expect(valueOf("Шаблон короба")).toBe(MILK_58);
    chooseValue("Товарная группа", "13");
    expect(choices("Шаблон короба")).toEqual([
      "Не выбран",
      "Вода 58×40",
      "Коробка 58×40",
      "Молоко 58×40 — не подходит",
    ]);
    expect(valueOf("Шаблон короба")).toBe(MILK_58);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    await screen.findByText("Изменения сохранены.");
    expect(fake.api.updateProduct.mock.calls[0]?.[2]).toMatchObject({
      chzProductGroupCode: 13,
      defaultBoxTemplateId: MILK_58,
    });
  });

  it("names a preference the template list does not have, and clears it with «Не выбран»", async () => {
    const fake = session();
    const gone = "2b6d9a7f-4c8e-4d0f-9a1b-6c7d8e9f0a1b";
    fake.api.listProducts.mockResolvedValue([{ ...MILK, defaultPalletTemplateId: gone }]);
    fake.api.updateProduct.mockResolvedValue({ ...MILK, rev: 81 });
    await openEdit(fake, "Молоко 3,2% 0,9 л");
    expect(choices("Шаблон паллеты")).toEqual([
      "Не выбран",
      "Паллета 100×150",
      "Шаблон 2b6d9a7f… — нет в списке",
    ]);
    // «Не выбран» holds the empty value, and the choice is made through the option itself.
    expect(optionTextOf("Шаблон паллеты", "")).toBe("Не выбран");
    chooseValue("Шаблон паллеты", "");
    expect(valueOf("Шаблон паллеты")).toBe("");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    await screen.findByText("Изменения сохранены.");
    expect(fake.api.updateProduct.mock.calls[0]?.[2]).toMatchObject({
      defaultBoxTemplateId: MILK_58,
      defaultPalletTemplateId: null,
    });
  });

  it("keeps the template choices off while the templates do not load, and sends the preferences unchanged", async () => {
    const fake = session();
    fake.api.listTemplates.mockRejectedValue(hostError("internal", 500));
    fake.api.updateProduct.mockResolvedValue({ ...MILK, name: "Молоко 3,2% 1 л", rev: 81 });
    await openProducts(fake);
    fireEvent.click(screen.getByRole("button", { name: "Изменить товар «Молоко 3,2% 0,9 л»" }));
    expect(
      await screen.findAllByText("Список шаблонов не загрузился: шаблоны останутся как есть."),
    ).toHaveLength(2);
    const box = screen.getByLabelText("Шаблон короба");
    expect(box).toHaveProperty("disabled", true);
    expect(choices("Шаблон короба")).toEqual(["Не выбран", "Шаблон a3b4c5d6…"]);
    expect(valueOf("Шаблон короба")).toBe(MILK_58);
    type("Название", "Молоко 3,2% 1 л");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    await screen.findByText("Изменения сохранены.");
    expect(fake.api.updateProduct.mock.calls[0]?.[2]).toMatchObject({
      defaultBoxTemplateId: MILK_58,
      defaultPalletTemplateId: null,
    });
    // While the list is still on its way the choices are off too, but no failure is claimed.
    cleanup();
    const slow = session();
    slow.api.listTemplates.mockReturnValue(new Promise(() => undefined));
    await openProducts(slow);
    fireEvent.click(screen.getByRole("button", { name: "Изменить товар «Молоко 3,2% 0,9 л»" }));
    expect(screen.getByLabelText("Шаблон короба")).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("Шаблон паллеты")).toHaveProperty("disabled", true);
    expect(screen.getAllByText("Загружаем шаблоны…")).toHaveLength(2);
    expect(
      screen.queryByText("Список шаблонов не загрузился: шаблоны останутся как есть."),
    ).toBeNull();
  });

  it("reads a refused template preference, its template deleted meanwhile, as a stale change: the products again now, the templates when the dialog opens again", async () => {
    const fake = session();
    fake.api.updateProduct.mockRejectedValueOnce(VALIDATION("defaultBoxTemplateId"));
    await openEdit(fake, "Молоко 3,2% 0,9 л");
    type("Название", "Молоко 3,2% 1 л");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    expect(
      await screen.findByText(
        "Данные изменились, пока вы их редактировали. Обновите их и повторите.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Загрузить заново" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(fake.api.listProducts).toHaveBeenCalledTimes(2));
    expect(fake.api.listTemplates).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Изменить товар «Молоко 3,2% 0,9 л»" }));
    await waitFor(() => expect(fake.api.listTemplates).toHaveBeenCalledTimes(2));
    // The pallet preference is refused, and read, the same way.
    fake.api.updateProduct.mockRejectedValueOnce(VALIDATION("defaultPalletTemplateId"));
    type("Название", "Молоко 3,2% 1 л");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    expect(
      await screen.findByText(
        "Данные изменились, пока вы их редактировали. Обновите их и повторите.",
      ),
    ).toBeTruthy();
  });

  it("offers the pallet's A4 sheet beside the pallet template: the enabled sheets, a held one that is off marked, and sends the choice as a sheet", async () => {
    const [preset] = buildPalletSheetPresets();
    if (preset === undefined) throw new Error("no stock sheet");
    const portrait = "6a3f0c5e-1b2d-4e8f-9a7b-0c1d2e3f4a5b";
    const off = "7b4a1d6f-2c3e-4f9a-8b8c-1d2e3f4a5b6c";
    const fake = session();
    fake.api.listProducts.mockResolvedValue([{ ...MILK, defaultPalletSheetId: off }, AYRAN]);
    fake.api.listPalletSheets.mockResolvedValue({
      sheets: [
        {
          id: off,
          name: "Две А5",
          enabled: false,
          presetKey: null,
          revision: 2,
          spec: preset.spec,
        },
        {
          id: portrait,
          name: "Палета А4 · вертикальная",
          enabled: true,
          presetKey: preset.key,
          revision: 1,
          spec: preset.spec,
        },
      ],
      defaultId: portrait,
    });
    fake.api.updateProduct.mockResolvedValue({ ...MILK, defaultPalletSheetId: portrait, rev: 66 });
    await openProducts(fake);
    fireEvent.click(screen.getByRole("button", { name: "Изменить товар «Молоко 3,2% 0,9 л»" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Лист А4 паллеты")).toHaveProperty("disabled", false),
    );
    // Right after the pallet template, its alternative.
    const fields = [...dialog().querySelectorAll("select")].map(
      (select) => select.labels?.[0]?.textContent ?? "",
    );
    expect(fields.indexOf("Лист А4 паллеты")).toBe(fields.indexOf("Шаблон паллеты") + 1);
    expect(choices("Лист А4 паллеты")).toEqual([
      "Не выбран",
      "Палета А4 · вертикальная",
      "Две А5 — выключен",
    ]);
    expect(screen.getByLabelText("Лист А4 паллеты")).toHaveProperty("value", off);
    // Pallet labels are not sheets, and the sheets are no pallet labels.
    expect(choices("Шаблон паллеты")).not.toContain("Палета А4 · вертикальная");
    expect(choices("Лист А4 паллеты")).not.toContain("Паллета 100×150");
    type("Лист А4 паллеты", portrait);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Изменения сохранены.")).toBeTruthy();
    expect(fake.api.updateProduct.mock.calls[0]?.[2]).toMatchObject({
      defaultPalletTemplateId: null,
      defaultPalletSheetId: portrait,
    });
  });

  it("leaves the sheet as it is while the sheets do not load, and says why", async () => {
    const sheet = "6a3f0c5e-1b2d-4e8f-9a7b-0c1d2e3f4a5b";
    const fake = session();
    fake.api.listProducts.mockResolvedValue([{ ...MILK, defaultPalletSheetId: sheet }, AYRAN]);
    fake.api.listPalletSheets.mockRejectedValue(new Error("offline"));
    fake.api.updateProduct.mockResolvedValue({ ...MILK, name: "Молоко", rev: 66 });
    await openProducts(fake);
    fireEvent.click(screen.getByRole("button", { name: "Изменить товар «Молоко 3,2% 0,9 л»" }));
    expect(
      await screen.findByText("Список листов А4 не загрузился: лист останется как есть."),
    ).toBeTruthy();
    expect(screen.getByLabelText("Лист А4 паллеты")).toHaveProperty("disabled", true);
    type("Название", "Молоко");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Изменения сохранены.")).toBeTruthy();
    expect(fake.api.updateProduct.mock.calls[0]?.[2]).toMatchObject({
      defaultPalletSheetId: sheet,
    });
  });
});
