import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import type { OfficeProduct, ProductGroup } from "../src/host/protocol.js";
import {
  fakeOfficeSession,
  ORG_PROFILE,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";
import { pressRowAction } from "./support/row-menu.js";

const GROUPS: ProductGroup[] = [{ code: 8, alias: "milk", name: "Молочная продукция" }];

/** The owner's case: an old card whose GTIN is wrong (check digit), still in use. */
const OLD: OfficeProduct = {
  id: "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b",
  gtin14: "04600682000011",
  name: "Старый кефир",
  printName: null,
  chzProductGroupCode: 8,
  boxCapacity: 12,
  palletBoxCapacity: 40,
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
/** The same card after it went to the archive. */
const OLD_ARCHIVED: OfficeProduct = { ...OLD, archived: true, rev: 66 };

function session(products: OfficeProduct[]): FakeOfficeSession {
  const fake = fakeOfficeSession({ user: TECHNOLOGIST });
  fake.api.listProducts.mockResolvedValue(products);
  fake.api.listProductGroups.mockResolvedValue(GROUPS);
  fake.api.listTemplates.mockResolvedValue([]);
  fake.api.getOrg.mockResolvedValue(ORG_PROFILE);
  fake.api.listCounterparties.mockResolvedValue([]);
  return fake;
}

async function openProducts(fake: FakeOfficeSession): Promise<void> {
  renderOffice(fake, { initialPath: "/products" });
  await screen.findByRole("heading", { name: "Товары" });
  await screen.findByText("Старый кефир");
}

function rowOf(name: string): HTMLElement {
  const row = screen.getByText(name).closest("tr");
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

describe("products: an archived product is not checked for GTIN", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  it("archives a card with a wrong GTIN and says what the archive means", async () => {
    const fake = session([OLD]);
    fake.api.updateProduct.mockResolvedValue(OLD_ARCHIVED);
    await openProducts(fake);
    pressRowAction(within(rowOf("Старый кефир")), "Убрать товар «Старый кефир» в архив");
    const dialog = await screen.findByRole("dialog", { name: "Убрать товар в архив?" });
    expect(within(dialog).getByText(/GTIN архивного товара не проверяется/u)).toBeTruthy();
    expect(within(dialog).getByText(/удалить нельзя/iu)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Убрать в архив" }));
    await screen.findByText("Товар «Старый кефир» убран в архив.");
    expect(fake.api.updateProduct.mock.calls[0]?.[2]).toMatchObject({
      gtin14: "04600682000011",
      archived: true,
      expectedRev: 65,
    });
  });

  it("does not bring a card back while its GTIN fails the check, and points to the card", async () => {
    const fake = session([OLD_ARCHIVED]);
    await openProducts(fake);
    pressRowAction(within(rowOf("Старый кефир")), "Вернуть товар «Старый кефир» из архива");
    const dialog = await screen.findByRole("dialog", { name: "Вернуть товар из архива?" });
    expect(within(dialog).getByText(/не проходит проверку/u)).toBeTruthy();
    const submit = within(dialog).getByRole("button", { name: "Вернуть" });
    expect(submit).toHaveProperty("disabled", true);
    fireEvent.click(submit);
    expect(fake.api.updateProduct).not.toHaveBeenCalled();
  });

  it("brings a card with a good GTIN back, and names the clash when another product holds the GTIN", async () => {
    const good = { ...OLD_ARCHIVED, gtin14: "04600682000013" };
    const fake = session([good]);
    fake.api.updateProduct.mockRejectedValueOnce(
      new HostError({
        kind: "api",
        code: "conflict",
        status: 409,
        message: "conflict",
        details: { constraint: "gtin14" },
      }),
    );
    await openProducts(fake);
    pressRowAction(within(rowOf("Старый кефир")), "Вернуть товар «Старый кефир» из архива");
    const dialog = await screen.findByRole("dialog", { name: "Вернуть товар из архива?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Вернуть" }));
    expect(await within(dialog).findByText(/уже у товара в работе/u)).toBeTruthy();
  });

  it("saves an archived card's other fields without a word about its GTIN, and checks it again once the card is back in use", async () => {
    const fake = session([OLD_ARCHIVED]);
    fake.api.updateProduct.mockResolvedValue({ ...OLD_ARCHIVED, name: "Старый кефир 2", rev: 67 });
    await openProducts(fake);
    fireEvent.click(screen.getByRole("button", { name: "Изменить товар «Старый кефир»" }));
    const drawer = await screen.findByRole("dialog", { name: "Товар «Старый кефир»" });
    await waitFor(() =>
      expect(within(drawer).getByLabelText("Товарная группа")).toHaveProperty("disabled", false),
    );
    expect(within(drawer).getByText(/GTIN архивного товара не проверяется/u)).toBeTruthy();
    fireEvent.change(within(drawer).getByLabelText("Название"), {
      target: { value: "Старый кефир 2" },
    });
    fireEvent.click(within(drawer).getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(fake.api.updateProduct).toHaveBeenCalledTimes(1));
    expect(fake.api.updateProduct.mock.calls[0]?.[2]).toMatchObject({
      gtin14: "04600682000011",
      archived: true,
    });
  });

  it("refuses the wrong GTIN under the field when the archive mark is taken off in the drawer", async () => {
    const fake = session([OLD_ARCHIVED]);
    await openProducts(fake);
    fireEvent.click(screen.getByRole("button", { name: "Изменить товар «Старый кефир»" }));
    const drawer = await screen.findByRole("dialog", { name: "Товар «Старый кефир»" });
    fireEvent.click(within(drawer).getByRole("checkbox", { name: "В архиве" }));
    fireEvent.click(within(drawer).getByRole("button", { name: "Сохранить" }));
    expect(await within(drawer).findByText("Неверная контрольная цифра GTIN")).toBeTruthy();
    expect(fake.api.updateProduct).not.toHaveBeenCalled();
    // Back to the archive: the refusal goes away with the check.
    fireEvent.click(within(drawer).getByRole("checkbox", { name: "В архиве" }));
    await waitFor(() =>
      expect(within(drawer).queryByText("Неверная контрольная цифра GTIN")).toBeNull(),
    );
  });

  it("offers no delete anywhere: a product is only archived", async () => {
    await openProducts(session([OLD]));
    const trigger = within(rowOf("Старый кефир")).getByRole("button", {
      name: "Действия: Старый кефир",
    });
    fireEvent.click(trigger);
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Изменить",
      "Убрать в архив",
    ]);
  });
});
