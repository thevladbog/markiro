import { readFileSync } from "node:fs";
import { join } from "node:path";

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as PhotoEncode from "../src/office/products/photo-encode.js";
import type { OfficeProduct, ProductGroup } from "../src/host/protocol.js";
import { chooseValue, openSelect } from "./support/select.js";
import {
  fakeOfficeSession,
  ORG_PROFILE,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";

const ENCODED = { width: 2, height: 1, dataBase64: "/9j/4AAQSkZJRgABAQ==" };

// jsdom has no canvas to shrink a picture on: the drawer's wiring is under
// test here, `photo-encode.test.ts` covers the encoder itself.
vi.mock("../src/office/products/photo-encode.js", async (importOriginal) => ({
  ...(await importOriginal<typeof PhotoEncode>()),
  encodePhoto: vi.fn(async () => ENCODED),
}));

const LONG_GROUP =
  "Пиво, напитки, изготавливаемые на основе пива, слабоалкогольные напитки, включая сидр, пуаре и медовуху";
const GROUPS: ProductGroup[] = [
  { code: 8, alias: "milk", name: "Молочная продукция" },
  { code: 15, alias: "beer", name: LONG_GROUP },
];

const MILK: OfficeProduct = {
  id: "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b",
  gtin14: "04600682000013",
  name: "Молоко 3,2% 0,9 л",
  printName: null,
  chzProductGroupCode: 8,
  boxCapacity: 12,
  palletBoxCapacity: null,
  shelfLifeDays: 10,
  defaultBoxTemplateId: null,
  defaultPalletTemplateId: null,
  defaultPalletSheetId: null,
  egaisCode: null,
  defaultCounterpartyId: null,
  photoChecksum: null,
  archived: false,
  status: "active",
  rev: 65,
};
const BEER: OfficeProduct = {
  ...MILK,
  id: "6f1c2a7e-3b4d-4c5e-8f90-1a2b3c4d5e6f",
  gtin14: "04607001234562",
  name: "Пиво светлое 0,5 л",
  chzProductGroupCode: 15,
  egaisCode: "0150320000001234567",
};

function session(): FakeOfficeSession {
  const fake = fakeOfficeSession({ user: TECHNOLOGIST });
  fake.api.listProducts.mockResolvedValue([MILK, BEER]);
  fake.api.listProductGroups.mockResolvedValue(GROUPS);
  fake.api.listTemplates.mockResolvedValue([]);
  fake.api.getOrg.mockResolvedValue(ORG_PROFILE);
  fake.api.listCounterparties.mockResolvedValue([]);
  return fake;
}

async function openProducts(fake: FakeOfficeSession): Promise<void> {
  renderOffice(fake);
  fireEvent.click(await screen.findByRole("link", { name: "Товары" }));
  await screen.findByText(MILK.name);
}

async function openCreate(fake: FakeOfficeSession): Promise<HTMLElement> {
  await openProducts(fake);
  fireEvent.click(screen.getByRole("button", { name: "Добавить товар" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Товарная группа")).toHaveProperty("disabled", false),
  );
  return screen.getByRole("dialog", { name: "Новый товар" });
}

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function pick(): void {
  fireEvent.change(screen.getByTestId("file-drop-input"), {
    target: { files: [new File([new Uint8Array([0xff, 0xd8])], "p.jpg", { type: "image/jpeg" })] },
  });
}

describe("the product's drawer (beta 3)", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  it("opens from the right with the photo on top, above every field", async () => {
    const drawer = await openCreate(session());
    expect(drawer.closest(".mk-side-panel")).not.toBeNull();
    const photo = within(drawer).getByRole("region", { name: "Фото товара" });
    expect(within(photo).getByRole("button", { name: /Загрузить фото/u })).toBeTruthy();
    expect(within(photo).getByText("Фото не загружено")).toBeTruthy();
    // The photo comes before the first field in the document.
    expect(
      photo.compareDocumentPosition(screen.getByLabelText("GTIN")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(drawer).getByRole("button", { name: "Отмена" })).toBeTruthy();
    expect(within(drawer).getByRole("button", { name: "Добавить" })).toBeTruthy();
  });

  it.each([MILK, BEER])(
    "offers the photo of a product of any group, group $chzProductGroupCode included",
    async (product) => {
      const fake = session();
      await openProducts(fake);
      fireEvent.click(screen.getByRole("button", { name: `Изменить товар «${product.name}»` }));
      expect(await screen.findByRole("button", { name: /Загрузить фото/u })).toBeTruthy();
      expect(fake.api.getProductPhoto).toHaveBeenCalledWith("office-session-token", product.id);
    },
  );

  it("writes the photo picked for a new product right after the product is saved", async () => {
    const fake = session();
    const created: OfficeProduct = { ...MILK, id: "0f1e2d3c-4b5a-4968-8776-655443322110", rev: 1 };
    fake.api.createProduct.mockResolvedValue(created);
    fake.api.putProductPhoto.mockResolvedValue({ photo: null });
    await openCreate(fake);
    pick();
    expect(await screen.findByRole("img", { name: /^Фото товара/u })).toBeTruthy();
    expect(fake.api.putProductPhoto).not.toHaveBeenCalled();
    type("GTIN", "4600682000013");
    type("Название", MILK.name);
    chooseValue("Товарная группа", "8");
    fireEvent.click(screen.getByRole("button", { name: "Добавить" }));
    expect(await screen.findByText(`Товар «${MILK.name}» добавлен.`)).toBeTruthy();
    expect(fake.api.putProductPhoto.mock.calls).toEqual([
      ["office-session-token", created.id, ENCODED],
    ]);
  });

  it("says so when the product was saved but its photo was not, and keeps the product", async () => {
    const fake = session();
    fake.api.createProduct.mockResolvedValue({
      ...MILK,
      id: "0f1e2d3c-4b5a-4968-8776-655443322110",
    });
    fake.api.putProductPhoto.mockRejectedValue(new Error("network"));
    await openCreate(fake);
    pick();
    await screen.findByRole("img", { name: /^Фото товара/u });
    type("GTIN", "4600682000013");
    type("Название", MILK.name);
    chooseValue("Товарная группа", "8");
    fireEvent.click(screen.getByRole("button", { name: "Добавить" }));
    expect(
      await screen.findByText(
        `Товар «${MILK.name}» добавлен, но фото не загрузилось. Откройте товар и загрузите фото ещё раз.`,
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes a pristine form at once, and asks before it drops what was typed", async () => {
    await openCreate(session());
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Новый товар" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Новый товар" })).toBeNull());

    const again = await (async () => {
      fireEvent.click(screen.getByRole("button", { name: "Добавить товар" }));
      return screen.findByRole("dialog", { name: "Новый товар" });
    })();
    type("Название", "Черновик названия");
    fireEvent.click(within(again).getByRole("button", { name: "Отмена" }));
    const ask = await screen.findByRole("alertdialog", { name: "Закрыть без сохранения?" });
    // «Вернуться к правке» keeps the form as it was.
    fireEvent.click(within(ask).getByRole("button", { name: "Вернуться к правке" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect((screen.getByLabelText("Название") as HTMLInputElement).value).toBe("Черновик названия");
    // Escape asks too; confirming closes the drawer.
    fireEvent.keyDown(document.body, { key: "Escape" });
    const askAgain = await screen.findByRole("alertdialog", { name: "Закрыть без сохранения?" });
    fireEvent.click(within(askAgain).getByRole("button", { name: "Закрыть без сохранения" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Новый товар" })).toBeNull());
  });

  it("keeps the drawer open when a select's own list takes Escape", async () => {
    await openCreate(session());
    const list = openSelect("Товарная группа");
    fireEvent.keyDown(list, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Новый товар" })).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("holds a long group's name inside the drawer: ellipsis in the closed select, the full name as its tooltip", async () => {
    const fake = session();
    await openProducts(fake);
    fireEvent.click(screen.getByRole("button", { name: `Изменить товар «${BEER.name}»` }));
    await screen.findByRole("button", { name: /Загрузить фото/u });
    const trigger = await waitFor(() => {
      const found = screen.getByRole("combobox", { name: "Товарная группа" });
      expect(found.getAttribute("title")).toBe(LONG_GROUP);
      return found;
    });
    expect(trigger.closest(".standalone-form")).not.toBeNull();
    // jsdom lays nothing out: the guard is the sheet. A one-column grid whose
    // track is `auto` grows to its widest value and scrolls the drawer sideways.
    const sheet = readFileSync(join(process.cwd(), "src/app/shell.css"), "utf8");
    expect(sheet).toMatch(/\.standalone-form,[^{]*\{\s*grid-template-columns: minmax\(0, 1fr\);/u);
  });
});
