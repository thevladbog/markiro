import { readFileSync } from "node:fs";
import { officeWarehousePalletDetailSchema } from "../src/host/office-pallet-create.js";
import { StrictMode } from "react";
import { ThemeProvider } from "@markiro/ui";
import { Office } from "../src/office/Office.js";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HostError } from "../src/host/client.js";
import type { PalletValidation } from "../src/host/office-pallet-create.js";
import { TECHNOLOGIST } from "./support/office.js";
import { openCodes, packSession } from "./support/pack-cards.js";

const moduleUrl = import.meta.url;
const CREATED_CARD = officeWarehousePalletDetailSchema.parse(
  JSON.parse(
    readFileSync(
      new URL("../proto/fixtures/office-warehouse-pallet-detail.json", moduleUrl),
      "utf8",
    ),
  ),
);
const BOX = "046006820000015000";
function upload(dialog: HTMLElement, name: string, contents: string | Promise<ArrayBuffer>) {
  const file = new File([], name);
  Object.defineProperty(file, "arrayBuffer", {
    value: () =>
      typeof contents === "string"
        ? Promise.resolve(new TextEncoder().encode(contents).buffer)
        : contents,
  });
  fireEvent.change(within(dialog).getByTestId("file-drop-input"), {
    target: { files: [file] },
  });
}
const VALID: PalletValidation = {
  valid: true,
  productId: "b1000000-0000-4000-8000-000000000001",
  productName: "Молоко",
  boxes: 1,
  units: 12,
  errors: [],
};
async function open() {
  const session = packSession();
  session.api.validateWarehousePallet.mockResolvedValue(VALID);
  session.api.listPallets.mockResolvedValue({ items: [], stations: [], nextCursor: null });
  await openCodes(session, "/codes/pallets?product=11111111-1111-4111-8111-111111111111");
  fireEvent.click(screen.getByRole("button", { name: /Новый палет/ }));
  const dialog = screen.getByRole("dialog", { name: "Новый палет" });
  const input = within(dialog).getByRole("textbox", { name: "Коды коробов" });
  fireEvent.change(input, { target: { value: BOX } });
  return { session, dialog, input };
}
describe("office pallet creation", () => {
  it("uses the office side drawer and shared file drop zone", async () => {
    const { dialog } = await open();
    expect(dialog.classList.contains("mk-side-panel")).toBe(true);
    expect(dialog.querySelector(".mk-side-panel__body form")).toBeTruthy();
    expect(dialog.querySelector(".mk-side-panel__footer button[type=submit]")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Загрузить TXT/CSV" })).toBeTruthy();
    const file = within(dialog).getByTestId("file-drop-input");
    expect(file.classList.contains("mk-visually-hidden")).toBe(true);
  });

  it("keeps typed codes when closing the drawer is cancelled", async () => {
    const { dialog, input } = await open();
    fireEvent.click(within(dialog).getByRole("button", { name: "Отмена" }));
    const confirmation = screen.getByRole("alertdialog", { name: "Закрыть без сохранения?" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Вернуться к правке" }));
    expect(input).toHaveProperty("value", BOX);
    expect(screen.getByRole("dialog", { name: "Новый палет" })).toBe(dialog);
  });

  it("requires checking and clears the result on editing", async () => {
    const { session, dialog, input } = await open();
    const create = within(dialog).getByRole("button", { name: "Создать палет" });
    expect(create).toHaveProperty("disabled", true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Проверить короба" }));
    await waitFor(() => expect(create).toHaveProperty("disabled", false));
    expect(session.api.validateWarehousePallet).toHaveBeenCalledWith("office-session-token", {
      codes: [BOX],
    });
    fireEvent.change(input, { target: { value: `${BOX}\ninvalid` } });
    expect(create).toHaveProperty("disabled", true);
  });
  it("ignores a validation response for a list edited while the request runs", async () => {
    const { session, dialog, input } = await open();
    let resolve: (value: PalletValidation) => void = () => undefined;
    session.api.validateWarehousePallet.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Проверить короба" }));
    fireEvent.change(input, { target: { value: `${BOX}\ninvalid` } });
    await act(async () => resolve(VALID));
    expect(within(dialog).getByRole("button", { name: "Создать палет" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(within(dialog).queryByText("Молоко")).toBeNull();
  });
  it("preserves input and request identity after an ambiguous create failure; drops double submits", async () => {
    const { session, dialog, input } = await open();
    session.api.createWarehousePallet.mockRejectedValue(
      new HostError({ kind: "transport", code: "timeout", message: "timeout" }),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Проверить короба" }));
    const create = within(dialog).getByRole("button", { name: "Создать палет" });
    await waitFor(() => expect(create).toHaveProperty("disabled", false));
    const form = dialog.querySelector("form");
    if (!form) throw new Error("missing form");
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(session.api.createWarehousePallet).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(create).toHaveProperty("disabled", false));
    expect(input).toHaveProperty("value", BOX);
    fireEvent.submit(form);
    await waitFor(() => expect(session.api.createWarehousePallet).toHaveBeenCalledTimes(2));
    expect(session.api.createWarehousePallet.mock.calls[1]?.[1]).toEqual(
      session.api.createWarehousePallet.mock.calls[0]?.[1],
    );
  });
  it("loads one-column CSV and preserves manual input after an invalid file", async () => {
    const { dialog, input } = await open();
    upload(dialog, "codes.csv", `"${BOX}"\r\n"00046006820000015000"`);
    await waitFor(() => expect(input).toHaveProperty("value", `${BOX}\n00046006820000015000`));
    upload(dialog, "codes.csv", `${BOX},extra`);
    await within(dialog).findByText(/CSV должен содержать одну колонку/);
    expect(input).toHaveProperty("value", `${BOX}\n00046006820000015000`);
  });
  it("shows an error for a dropped unsupported file and keeps the entered codes", async () => {
    const { dialog, input } = await open();
    const file = new File(["not a code file"], "boxes.xlsx");
    Object.defineProperty(file, "arrayBuffer", {
      value: () => Promise.resolve(new TextEncoder().encode("not a code file").buffer),
    });
    fireEvent.drop(within(dialog).getByRole("button", { name: "Загрузить TXT/CSV" }), {
      dataTransfer: { files: [file] },
    });
    await within(dialog).findByText("Выберите TXT или CSV.");
    expect(input).toHaveProperty("value", BOX);
  });

  it("does not replace a manual edit with a stale file read", async () => {
    const { dialog, input } = await open();
    let finish: (data: ArrayBuffer) => void = () => undefined;
    const pending = new Promise<ArrayBuffer>((resolve) => {
      finish = resolve;
    });
    upload(dialog, "codes.txt", pending);
    fireEvent.change(input, { target: { value: `${BOX}\nmanual` } });
    await act(async () => finish(new TextEncoder().encode(BOX).buffer));
    expect(input).toHaveProperty("value", `${BOX}\nmanual`);
    expect(within(dialog).getByRole("button", { name: "Создать палет" })).toHaveProperty(
      "disabled",
      true,
    );
  });
  it("shows every server conflict line and disables creation until input is checked again", async () => {
    const { session, dialog } = await open();
    session.api.createWarehousePallet.mockRejectedValue(
      new HostError({
        kind: "api",
        code: "conflict",
        message: "conflict",
        details: {
          constraint: "pallet_codes",
          validation: {
            ...VALID,
            valid: false,
            errors: [
              {
                line: 1,
                code: "already_on_pallet",
                sscc: BOX,
                palletId: "a1000000-0000-4000-8000-000000000002",
              },
            ],
          },
        },
      }),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Проверить короба" }));
    const create = within(dialog).getByRole("button", { name: "Создать палет" });
    await waitFor(() => expect(create).toHaveProperty("disabled", false));
    fireEvent.click(create);
    await within(dialog).findByText(/Строка 1: короб уже на действующем палете/);
    expect(create).toHaveProperty("disabled", true);
    expect(
      within(dialog).getByRole("link", { name: "Открыть палет" }).getAttribute("href"),
    ).toContain("warehouse-pallet");
  });
  it("offers creation to a technologist", async () => {
    const session = packSession([], TECHNOLOGIST);
    session.api.listPallets.mockResolvedValue({ items: [], stations: [], nextCursor: null });
    await openCodes(session, "/codes/pallets");
    expect(screen.getByRole("button", { name: /Новый палет/ })).toBeTruthy();
  });

  it("accepts validation after StrictMode replays mount effects", async () => {
    const session = packSession();
    session.api.listPallets.mockResolvedValue({ items: [], stations: [], nextCursor: null });
    session.api.validateWarehousePallet.mockResolvedValue(VALID);
    render(
      <StrictMode>
        <ThemeProvider defaultTheme="dark">
          <Office session={session} initialPath="/codes/pallets" />
        </ThemeProvider>
      </StrictMode>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Новый палет/ }));
    const dialog = screen.getByRole("dialog", { name: "Новый палет" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Коды коробов" }), {
      target: { value: BOX },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Проверить короба" }));
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Создать палет" })).toHaveProperty(
        "disabled",
        false,
      ),
    );
  });

  it("opens the created card and returns to the list with its filters intact", async () => {
    const { session, dialog } = await open();
    session.api.createWarehousePallet.mockResolvedValue({
      id: CREATED_CARD.id,
      sscc: CREATED_CARD.sscc ?? "",
    });
    session.api.getWarehousePallet.mockResolvedValue(CREATED_CARD);
    fireEvent.click(within(dialog).getByRole("button", { name: "Проверить короба" }));
    const create = within(dialog).getByRole("button", { name: "Создать палет" });
    await waitFor(() => expect(create).toHaveProperty("disabled", false));
    fireEvent.click(create);
    await screen.findByRole("heading", { name: `Палет (00)${CREATED_CARD.sscc}` });
    fireEvent.click(screen.getByRole("link", { name: "← Назад" }));
    await screen.findByRole("tab", { name: "Палеты" });
    expect(session.api.listPallets.mock.calls.at(-1)?.[1]).toMatchObject({
      product: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("recovers a committed create after a recheck and canonical-equivalent formatting/reordering", async () => {
    const { session, dialog, input } = await open();
    fireEvent.change(input, { target: { value: `${BOX}\n046006820000015017` } });
    session.api.createWarehousePallet
      .mockRejectedValueOnce(
        new HostError({ kind: "transport", code: "timeout", message: "lost response" }),
      )
      .mockResolvedValue({ id: CREATED_CARD.id, sscc: CREATED_CARD.sscc ?? "" });
    session.api.getWarehousePallet.mockResolvedValue(CREATED_CARD);
    fireEvent.click(within(dialog).getByRole("button", { name: "Проверить короба" }));
    const create = within(dialog).getByRole("button", { name: "Создать палет" });
    await waitFor(() => expect(create).toHaveProperty("disabled", false));
    fireEvent.click(create);
    await within(dialog).findByRole("button", { name: "Повторить создание" });
    session.api.validateWarehousePallet.mockResolvedValue({
      ...VALID,
      valid: false,
      errors: [{ line: 1, code: "already_on_pallet", sscc: BOX, palletId: CREATED_CARD.id }],
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Проверить короба" }));
    await within(dialog).findByText(/короб уже на действующем палете/);
    fireEvent.change(input, { target: { value: ` (00)046006820000015017 \n00${BOX}` } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Повторить создание" }));
    await screen.findByRole("heading", { name: `Палет (00)${CREATED_CARD.sscc}` });
    expect(session.api.createWarehousePallet.mock.calls[1]?.[1].requestId).toBe(
      session.api.createWarehousePallet.mock.calls[0]?.[1].requestId,
    );
  });

  it("uses the saved recovery UUID after a different composition has a definite refusal", async () => {
    const { session, dialog, input } = await open();
    session.api.createWarehousePallet
      .mockRejectedValueOnce(new HostError({ kind: "transport", code: "timeout", message: "lost" }))
      .mockRejectedValueOnce(
        new HostError({
          kind: "api",
          code: "conflict",
          message: "license",
          details: { constraint: "feature_disabled" },
        }),
      )
      .mockResolvedValue({ id: CREATED_CARD.id, sscc: CREATED_CARD.sscc ?? "" });
    session.api.getWarehousePallet.mockResolvedValue(CREATED_CARD);
    fireEvent.click(within(dialog).getByRole("button", { name: "Проверить короба" }));
    const create = within(dialog).getByRole("button", { name: "Создать палет" });
    await waitFor(() => expect(create).toHaveProperty("disabled", false));
    fireEvent.click(create);
    await within(dialog).findByRole("button", { name: "Повторить создание" });
    fireEvent.change(input, { target: { value: "046006820000015017" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Проверить короба" }));
    await waitFor(() => expect(create).toHaveProperty("disabled", false));
    fireEvent.click(create);
    await within(dialog).findByText("Палеты не входят в лицензию площадки. Расширьте лицензию.");
    fireEvent.change(input, { target: { value: BOX } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Повторить создание" }));
    await screen.findByRole("heading", { name: `Палет (00)${CREATED_CARD.sscc}` });
    expect(session.api.createWarehousePallet.mock.calls[2]?.[1].requestId).toBe(
      session.api.createWarehousePallet.mock.calls[0]?.[1].requestId,
    );
  });
});
