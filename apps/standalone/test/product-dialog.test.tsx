import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import type { CounterpartyRecord, OfficeProduct, ProductGroup } from "../src/host/protocol.js";
import { gtinOwner } from "../src/office/products/product-form.js";
import {
  fakeOfficeSession,
  ORG_PROFILE,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";

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

function session(user = TECHNOLOGIST): FakeOfficeSession {
  const fake = fakeOfficeSession({ user });
  fake.api.listProducts.mockResolvedValue([MILK, AYRAN]);
  fake.api.listProductGroups.mockResolvedValue(GROUPS);
  fake.api.getOrg.mockResolvedValue(ORG_PROFILE);
  fake.api.listCounterparties.mockResolvedValue([NORTH, OLD]);
  return fake;
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

  it("adds a product, sending the GTIN as its 14 digits and every field by name", async () => {
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
    type("Товарная группа", "8");
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

  it("finds a GTIN's owner the cloud's way: the organization first, then active counterparties by name", () => {
    const second = { ...NORTH, id: "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d", name: "Альфа-2" };
    expect(gtinOwner("04601234000017", ["4600682"], [NORTH, second])).toEqual({
      kind: "counterparty",
      counterparty: second,
    });
    expect(gtinOwner("04601234000017", ["4601234"], [NORTH])).toEqual({ kind: "own" });
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

  it("says a product without a group or both capacities stays a draft", async () => {
    await openCreate(session());
    const hint = "Без группы и вместимостей товар остаётся черновиком.";
    expect(screen.getByText(hint)).toBeTruthy();
    type("Товарная группа", "8");
    type("В коробе, шт.", "12");
    expect(screen.getByText(hint)).toBeTruthy();
    type("Коробов на паллете", "40");
    await waitFor(() => expect(screen.queryByText(hint)).toBeNull());
    // Each of the three brings the line back on its own; spaces are no capacity.
    type("Товарная группа", "");
    expect(screen.getByText(hint)).toBeTruthy();
    type("Товарная группа", "8");
    await waitFor(() => expect(screen.queryByText(hint)).toBeNull());
    type("В коробе, шт.", "  ");
    expect(screen.getByText(hint)).toBeTruthy();
    type("В коробе, шт.", "12");
    await waitFor(() => expect(screen.queryByText(hint)).toBeNull());
    type("Коробов на паллете", "  ");
    expect(screen.getByText(hint)).toBeTruthy();
  });

  it("saves a change as the whole record with the loaded revision, archive included", async () => {
    const fake = session();
    // Both default templates travel with the record: the box one comes with `MILK`,
    // the pallet one is added here.
    const palletTemplate = "0f4b7e5d-2a6c-4b8d-9e9f-4a5b6c7d8e9f";
    fake.api.listProducts.mockResolvedValue([
      { ...MILK, defaultPalletTemplateId: palletTemplate },
      AYRAN,
    ]);
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
          defaultPalletTemplateId: palletTemplate,
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

  it("puts the host's refusal of a field under that field", async () => {
    const fake = session();
    fake.api.createProduct.mockRejectedValueOnce(VALIDATION("shelfLifeDays"));
    await openCreate(fake);
    type("GTIN", "4600682000013");
    type("Название", "Молоко");
    type("Срок годности, дней", "10");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    const message = await screen.findByText("Хост не принял это значение. Проверьте его.");
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

  it("sends one request for a double click, and none while it is on its way", async () => {
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
    });
  });

  it("offers the groups by name and keeps a product's group the lookup lacks", async () => {
    const fake = session();
    fake.api.listProducts.mockResolvedValue([{ ...MILK, chzProductGroupCode: 99 }, AYRAN]);
    await openProducts(fake);
    fireEvent.click(screen.getByRole("button", { name: "Изменить товар «Молоко 3,2% 0,9 л»" }));
    const select = screen.getByLabelText("Товарная группа");
    await waitFor(() => expect(select).toHaveProperty("disabled", false));
    const options = within(select)
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(options).toEqual([
      "Без группы",
      "Молочная продукция",
      "Упакованная вода",
      "Код 99 — нет в справочнике",
    ]);
    expect(select).toHaveProperty("value", "99");
    expect(
      screen.queryByText("Справочник групп не загрузился: группу сейчас не изменить."),
    ).toBeNull();
    // A group the lookup has is not offered twice.
    fireEvent.click(within(dialog()).getByRole("button", { name: "Отмена" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Изменить товар «Айран»" }));
    const known = screen.getByLabelText("Товарная группа");
    expect(
      within(known)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Без группы", "Молочная продукция", "Упакованная вода"]);
    expect(known).toHaveProperty("value", "8");
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
    expect(select).toHaveProperty("value", "8");
    // Only its code: nothing is said about a lookup that did not load.
    expect(
      within(select)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Без группы", "Код 8"]);
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
