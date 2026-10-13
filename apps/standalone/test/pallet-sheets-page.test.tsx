import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildPalletSheetPresets, type MonoBitmap, type MonoRaster } from "@markiro/domain";

import { HostError } from "../src/host/client.js";
import type { PalletSheet, PalletSheets } from "../src/host/protocol.js";
import { paintMonoRaster, renderSheetRaster } from "../src/labels/sheet-render.js";
import { sheetExport } from "../src/office/sheets/sheet-list.js";
import { downloadFile } from "../src/office/templates/download.js";
import {
  fakeOfficeSession,
  ORG_PROFILE,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";
import { stockSheets } from "./support/shifts.js";

import type * as SheetRenderModule from "../src/labels/sheet-render.js";
import type * as LogoModule from "../src/labels/logo.js";
import type * as DownloadModule from "../src/office/templates/download.js";

// The domain renderer needs a canvas and a font; the page's wiring is what is tested here.
vi.mock("../src/labels/sheet-render.js", async (importActual) => {
  const actual = await importActual<typeof SheetRenderModule>();
  return { ...actual, renderSheetRaster: vi.fn(), paintMonoRaster: vi.fn() };
});
vi.mock("../src/labels/logo.js", async (importActual) => {
  const actual = await importActual<typeof LogoModule>();
  const bitmap: MonoBitmap = { width: 8, height: 8, stride: 1, pixels: new Uint8Array(8) };
  return { ...actual, loadBundledMarkiroLogo: vi.fn(async () => bitmap) };
});
vi.mock("../src/office/templates/download.js", async (importActual) => {
  const actual = await importActual<typeof DownloadModule>();
  return { ...actual, downloadFile: vi.fn() };
});

const TOKEN = "office-session-token";
const PRESETS = buildPalletSheetPresets();
const STOCK = stockSheets();
const [PORTRAIT, LANDSCAPE, TWO_A5] = STOCK.sheets as [PalletSheet, PalletSheet, PalletSheet];
const PRESET_BODIES = PRESETS.map((preset) => ({
  name: preset.name,
  presetKey: preset.key,
  spec: preset.spec,
}));

const RASTER: MonoRaster = {
  format: "mono-raster-v1",
  widthMm: 210,
  heightMm: 297,
  dpi: 300,
  widthDots: 8,
  heightDots: 8,
  stride: 1,
  requiredBounds: { left: 0, top: 0, right: 8, bottom: 8 },
  pixels: new Uint8Array(8),
};

function api(code: string, details: Record<string, unknown> = {}): HostError {
  return new HostError({ kind: "api", code, status: 409, message: code, details });
}
const down = () => new HostError({ kind: "transport", code: "unreachable", message: "down" });

const withSheets = (sheets: PalletSheet[], defaultId: string | null): PalletSheets => ({
  sheets,
  defaultId,
});

function session(list: PalletSheets, user?: FakeOfficeSession["user"]): FakeOfficeSession {
  const fake = fakeOfficeSession(user === undefined ? {} : { user });
  fake.api.getOrg.mockResolvedValue(ORG_PROFILE);
  fake.api.getOrgLogo.mockResolvedValue({ logo: null });
  fake.api.listPalletSheets.mockResolvedValue(list);
  return fake;
}

async function openSheets(fake: FakeOfficeSession): Promise<void> {
  renderOffice(fake);
  fireEvent.click(await screen.findByRole("link", { name: "Шаблоны" }));
  fireEvent.click(await screen.findByRole("link", { name: "Листы А4" }));
  await screen.findByRole("heading", { name: "Листы паллет А4" });
  await waitFor(() => expect(screen.queryByText("Загрузка…")).toBeNull());
}

function rows(): HTMLElement[] {
  return within(screen.getByRole("table")).getAllByRole("row").slice(1);
}

function rowOf(name: string): HTMLElement {
  const found = rows().find((row) => within(row).queryByText(name, { exact: false }) !== null);
  if (found === undefined) throw new Error(`no row for ${name}`);
  return found;
}

/** The first cell of each row without its tags: the names top to bottom. */
function names(): string[] {
  return rows().map((row) =>
    (within(row).getAllByRole("cell")[0]?.textContent ?? "").replace(/\s+/g, " ").trim(),
  );
}

function click(name: string): void {
  fireEvent.click(screen.getByRole("button", { name }));
}

function pickFile(file: File): void {
  fireEvent.change(screen.getByTestId("file-drop-input"), { target: { files: [file] } });
}

const sheetFile = (sheet: PalletSheet, name = "лист.json") =>
  new File([sheetExport(sheet)], name, { type: "application/json" });

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("unreadable"));
    reader.readAsText(blob);
  });
}

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

/** A create that answers with the sheet it was sent, under a fresh id. */
function echoCreate(fake: FakeOfficeSession): void {
  let next = 0;
  fake.api.createPalletSheet.mockImplementation(async (_token, body) => {
    next += 1;
    return {
      id: `9a3f0c5e-1b2d-4e8f-9a7b-0c1d2e3f4a5${String(next)}`,
      name: body.name,
      enabled: body.enabled ?? true,
      presetKey: body.presetKey ?? null,
      revision: 1,
      spec: body.spec,
    };
  });
}

beforeEach(() => {
  localStorage.removeItem("markiro.theme");
  vi.mocked(renderSheetRaster).mockReset().mockResolvedValue(RASTER);
  vi.mocked(paintMonoRaster).mockReset();
  vi.mocked(downloadFile).mockReset();
});

describe("the A4 sheets page: reading", () => {
  it.each([
    ["an administrator", undefined],
    ["a technologist", TECHNOLOGIST],
  ] as const)("is in the menu for %s and opens the page", async (_who, user) => {
    const fake = session(STOCK, user);
    await openSheets(fake);
    expect(screen.getByRole("heading", { name: "Листы паллет А4" })).toBeTruthy();
    expect(fake.api.listPalletSheets).toHaveBeenCalledWith(TOKEN);
  });

  it("lists the sheets by name with their layout, state and the organization's default marked", async () => {
    await openSheets(session(withSheets([TWO_A5, PORTRAIT, LANDSCAPE], PORTRAIT.id)));
    expect(names()).toEqual([
      "Палета А4 · вертикальная По умолчанию Готовый",
      "Палета А4 · горизонтальная Готовый",
      "Палета А4 · две одинаковые А5 Готовый",
    ]);
    const portrait = within(rowOf("вертикальная"))
      .getAllByRole("cell")
      .map((cell) => cell.textContent);
    expect(portrait[1]).toBe("А4 вертикальный");
    expect(portrait[2]).toMatch(/Включён$/);
    expect(within(rowOf("горизонтальная")).getAllByRole("cell")[1]?.textContent).toBe(
      "А4 горизонтальный",
    );
    expect(within(rowOf("две одинаковые")).getAllByRole("cell")[1]?.textContent).toBe(
      "А4 горизонтальный · две А5",
    );
    expect(within(rowOf("вертикальная")).getByText("По умолчанию")).toBeTruthy();
    expect(within(rowOf("горизонтальная")).queryByText("По умолчанию")).toBeNull();
  });

  it("says there are no sheets and offers the stock ones", async () => {
    await openSheets(session(withSheets([], null)));
    expect(
      screen.getByText("Листов пока нет. Добавьте готовые листы или загрузите свой файл JSON."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Добавить готовые листы" })).toBeTruthy();
  });

  it("explains a list that did not load and reads it again", async () => {
    const fake = session(STOCK);
    fake.api.listPalletSheets.mockRejectedValueOnce(down()).mockResolvedValueOnce(STOCK);
    renderOffice(fake);
    fireEvent.click(await screen.findByRole("link", { name: "Шаблоны" }));
    fireEvent.click(await screen.findByRole("link", { name: "Листы А4" }));
    await screen.findByText(
      "Нет связи с хостом. Проверьте, что ПК-хост включён и служба запущена.",
    );
    click("Повторить");
    expect(await screen.findByRole("table")).toBeTruthy();
  });

  it("marks sheets that share a name, in words, and says so above the table", async () => {
    const twin = { ...LANDSCAPE, name: PORTRAIT.name };
    await openSheets(session(withSheets([PORTRAIT, twin, TWO_A5], PORTRAIT.id)));
    expect(screen.getAllByText("Название повторяется")).toHaveLength(2);
    expect(screen.getByText(/Названия повторяются: Палета А4 · вертикальная\./)).toBeTruthy();
    expect(within(rowOf("две одинаковые")).queryByText("Название повторяется")).toBeNull();
  });

  it("marks nothing when every name is its own", async () => {
    await openSheets(session(STOCK));
    expect(screen.queryByText("Название повторяется")).toBeNull();
    expect(screen.queryByText(/Названия повторяются/)).toBeNull();
  });

  it("shows a sheet this build cannot read as unreadable and offers neither its preview nor its file", async () => {
    const odd: PalletSheet = { ...LANDSCAPE, spec: { widthMm: 58 } };
    await openSheets(session(withSheets([PORTRAIT, odd], PORTRAIT.id)));
    expect(within(rowOf("горизонтальная")).getByText("Не читается этой версией")).toBeTruthy();
    expect(screen.getByRole("button", { name: `Просмотр «${odd.name}»` })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: `Скачать JSON «${odd.name}»` })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: `Просмотр «${PORTRAIT.name}»` })).toHaveProperty(
      "disabled",
      false,
    );
  });

  it("gives a technologist every action too: both office roles keep the catalog", async () => {
    await openSheets(session(STOCK, TECHNOLOGIST));
    expect(screen.getByRole("button", { name: `Переименовать «${LANDSCAPE.name}»` })).toBeTruthy();
    expect(screen.getByRole("button", { name: `Удалить «${LANDSCAPE.name}»` })).toBeTruthy();
    expect(screen.getByTestId("file-drop-input")).toBeTruthy();
  });
});

describe("the A4 sheets page: stock sheets", () => {
  it("adds the three stock sheets with their keys, one after another, without reading the list again", async () => {
    const fake = session(withSheets([], null));
    echoCreate(fake);
    await openSheets(fake);
    click("Добавить готовые листы");
    expect(await screen.findByText("Готовые листы добавлены.")).toBeTruthy();
    expect(fake.api.createPalletSheet.mock.calls.map((call) => call[1])).toEqual(PRESET_BODIES);
    expect(fake.api.createPalletSheet.mock.calls.map((call) => call[0])).toEqual([
      TOKEN,
      TOKEN,
      TOKEN,
    ]);
    expect(rows()).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Добавить готовые листы" })).toBeNull();
    expect(fake.api.listPalletSheets).toHaveBeenCalledTimes(1);
  });

  it("adds only the stock sheets that are missing", async () => {
    const fake = session(withSheets([PORTRAIT], PORTRAIT.id));
    echoCreate(fake);
    await openSheets(fake);
    click("Добавить готовые листы");
    await screen.findByText("Готовые листы добавлены.");
    expect(fake.api.createPalletSheet.mock.calls.map((call) => call[1].presetKey)).toEqual([
      "pallet-a4-landscape",
      "pallet-a4-two-a5",
    ]);
  });

  it("keeps the sheets added before a failure, says it failed and reads the list again", async () => {
    const fake = session(withSheets([], null));
    echoCreate(fake);
    const echo = fake.api.createPalletSheet.getMockImplementation();
    fake.api.createPalletSheet
      .mockImplementationOnce(echo ?? (() => Promise.reject(down())))
      .mockRejectedValueOnce(down());
    fake.api.listPalletSheets
      .mockResolvedValueOnce(withSheets([], null))
      .mockResolvedValue(withSheets([PORTRAIT], null));
    await openSheets(fake);
    click("Добавить готовые листы");
    expect(
      await screen.findByText("Запрос не выполнен. Проверьте связь с хостом и повторите."),
    ).toBeTruthy();
    await waitFor(() => expect(fake.api.listPalletSheets).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Готовые листы добавлены.")).toBeNull();
    // The button is still there to go on with.
    expect(screen.getByRole("button", { name: "Добавить готовые листы" })).toBeTruthy();
  });
});

describe("the A4 sheets page: the main sheet and the state", () => {
  it("offers no «Сделать основным»: the default is chosen on the «По умолчанию» tab beside the pallet labels", async () => {
    const fake = session(withSheets([PORTRAIT, LANDSCAPE], PORTRAIT.id));
    await openSheets(fake);
    expect(screen.queryByRole("button", { name: /основным/ })).toBeNull();
    expect(screen.getByText(/выбирается на вкладке «По умолчанию»/)).toBeTruthy();
    expect(fake.api.setDefaultPalletSheet).not.toHaveBeenCalled();
  });

  it("switches a sheet off with its revision, then on with the revision the answer gave", async () => {
    const fake = session(withSheets([PORTRAIT, LANDSCAPE], PORTRAIT.id));
    fake.api.updatePalletSheet
      .mockResolvedValueOnce({ ...LANDSCAPE, enabled: false, revision: 2 })
      .mockResolvedValueOnce({ ...LANDSCAPE, enabled: true, revision: 3 });
    await openSheets(fake);
    click(`Выключить «${LANDSCAPE.name}»`);
    expect(
      await screen.findByText(
        `Лист «${LANDSCAPE.name}» выключен. Смены, где он уже выбран, его сохранят.`,
      ),
    ).toBeTruthy();
    expect(fake.api.updatePalletSheet).toHaveBeenLastCalledWith(TOKEN, LANDSCAPE.id, {
      enabled: false,
      expectedRevision: 1,
    });
    expect(within(rowOf("горизонтальная")).getByText("Выключен")).toBeTruthy();
    click(`Включить «${LANDSCAPE.name}»`);
    expect(await screen.findByText(`Лист «${LANDSCAPE.name}» включён.`)).toBeTruthy();
    expect(fake.api.updatePalletSheet).toHaveBeenLastCalledWith(TOKEN, LANDSCAPE.id, {
      enabled: true,
      expectedRevision: 2,
    });
    expect(within(rowOf("горизонтальная")).getByText("Включён")).toBeTruthy();
    expect(fake.api.listPalletSheets).toHaveBeenCalledTimes(1);
  });

  it("says the main sheet cannot be switched off, and reads the list again", async () => {
    const fake = session(withSheets([PORTRAIT, LANDSCAPE], PORTRAIT.id));
    fake.api.updatePalletSheet.mockRejectedValue(
      api("conflict", { constraint: "template_is_default" }),
    );
    await openSheets(fake);
    click(`Выключить «${PORTRAIT.name}»`);
    expect(
      await screen.findByText(
        "Лист выбран по умолчанию (для организации или категории): сначала выберите другой на вкладке «По умолчанию».",
      ),
    ).toBeTruthy();
    await waitFor(() => expect(fake.api.listPalletSheets).toHaveBeenCalledTimes(2));
    expect(within(rowOf("вертикальная")).getByText("Включён")).toBeTruthy();
  });

  it("says a sheet changed in another window is out of date, and reads the list again", async () => {
    const fake = session(withSheets([PORTRAIT, LANDSCAPE], PORTRAIT.id));
    fake.api.updatePalletSheet.mockRejectedValue(api("stale_revision"));
    fake.api.listPalletSheets.mockResolvedValueOnce(withSheets([PORTRAIT, LANDSCAPE], PORTRAIT.id));
    await openSheets(fake);
    click(`Выключить «${LANDSCAPE.name}»`);
    expect(
      await screen.findByText("Лист изменили в другом окне: список обновлён, повторите."),
    ).toBeTruthy();
    await waitFor(() => expect(fake.api.listPalletSheets).toHaveBeenCalledTimes(2));
  });

  it("does not make a second write while one is on its way, and turns the buttons off meanwhile", async () => {
    const fake = session(withSheets([PORTRAIT, LANDSCAPE, TWO_A5], PORTRAIT.id));
    const slow = deferred<PalletSheet>();
    fake.api.updatePalletSheet.mockReturnValue(slow.promise);
    await openSheets(fake);
    const first = screen.getByRole("button", { name: `Выключить «${LANDSCAPE.name}»` });
    const second = screen.getByRole("button", { name: `Выключить «${TWO_A5.name}»` });
    await act(async () => {
      fireEvent.click(first);
      fireEvent.click(second);
    });
    expect(fake.api.updatePalletSheet).toHaveBeenCalledTimes(1);
    expect(second).toHaveProperty("disabled", true);
    expect(
      screen.getByRole("button", { name: `Переименовать «${LANDSCAPE.name}»` }),
    ).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: `Удалить «${LANDSCAPE.name}»` })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: `Удалить «${TWO_A5.name}»` })).toHaveProperty(
      "disabled",
      true,
    );
    await act(async () => {
      slow.resolve({ ...LANDSCAPE, enabled: false, revision: 2 });
      await slow.promise;
    });
    await waitFor(() => expect(second).toHaveProperty("disabled", false));
  });
});

describe("the A4 sheets page: renaming", () => {
  async function openRename(fake: FakeOfficeSession, sheet = LANDSCAPE): Promise<HTMLElement> {
    await openSheets(fake);
    click(`Переименовать «${sheet.name}»`);
    return screen.findByRole("dialog", { name: "Название листа" });
  }

  it("keeps «Сохранить» off for the same name, a blank one and the same name with spaces", async () => {
    const box = await openRename(session(STOCK));
    const save = within(box).getByRole("button", { name: "Сохранить" });
    expect(save).toHaveProperty("disabled", true);
    const input = within(box).getByLabelText("Название");
    fireEvent.change(input, { target: { value: `  ${LANDSCAPE.name}  ` } });
    expect(save).toHaveProperty("disabled", true);
    fireEvent.change(input, { target: { value: "   " } });
    expect(save).toHaveProperty("disabled", true);
    fireEvent.change(input, { target: { value: "Лист цеха" } });
    expect(save).toHaveProperty("disabled", false);
  });

  it("warns, in words, that another sheet has the name, and still lets it be saved", async () => {
    const fake = session(STOCK);
    fake.api.updatePalletSheet.mockResolvedValue({
      ...LANDSCAPE,
      name: PORTRAIT.name,
      revision: 2,
    });
    const box = await openRename(fake);
    const input = within(box).getByLabelText("Название");
    const warning = /Лист с таким названием уже есть/;
    expect(within(box).queryByText(warning)).toBeNull();
    fireEvent.change(input, { target: { value: ` ${PORTRAIT.name.toUpperCase()} ` } });
    expect(within(box).getByText(warning)).toBeTruthy();
    expect(within(box).getByRole("button", { name: "Сохранить" })).toHaveProperty(
      "disabled",
      false,
    );
    fireEvent.change(input, { target: { value: "Лист цеха" } });
    expect(within(box).queryByText(warning)).toBeNull();
    fireEvent.change(input, { target: { value: PORTRAIT.name } });
    fireEvent.click(within(box).getByRole("button", { name: "Сохранить" }));
    await screen.findByText(`Лист переименован: «${PORTRAIT.name}».`);
    expect(screen.getByText(/Названия повторяются/)).toBeTruthy();
  });

  it("sends the trimmed name with the revision, closes, and shows the new name without reading again", async () => {
    const fake = session(STOCK);
    fake.api.updatePalletSheet.mockResolvedValue({ ...LANDSCAPE, name: "Лист цеха", revision: 2 });
    const box = await openRename(fake);
    fireEvent.change(within(box).getByLabelText("Название"), {
      target: { value: "  Лист цеха  " },
    });
    fireEvent.click(within(box).getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Лист переименован: «Лист цеха».")).toBeTruthy();
    expect(fake.api.updatePalletSheet).toHaveBeenCalledWith(TOKEN, LANDSCAPE.id, {
      name: "Лист цеха",
      expectedRevision: 1,
    });
    expect(screen.queryByRole("dialog", { name: "Название листа" })).toBeNull();
    expect(names().some((name) => name.startsWith("Лист цеха"))).toBe(true);
    expect(fake.api.listPalletSheets).toHaveBeenCalledTimes(1);
  });

  it("stays open and says why when the host refuses, once, inside the dialog", async () => {
    const fake = session(STOCK);
    fake.api.updatePalletSheet.mockRejectedValue(api("stale_revision"));
    const box = await openRename(fake);
    fireEvent.change(within(box).getByLabelText("Название"), { target: { value: "Лист цеха" } });
    fireEvent.click(within(box).getByRole("button", { name: "Сохранить" }));
    expect(
      await within(box).findByText("Лист изменили в другом окне: список обновлён, повторите."),
    ).toBeTruthy();
    expect(
      screen.getAllByText("Лист изменили в другом окне: список обновлён, повторите."),
    ).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "Название листа" })).toBeTruthy();
  });

  it("closes on «Отмена» and sends nothing", async () => {
    const fake = session(STOCK);
    const box = await openRename(fake);
    fireEvent.click(within(box).getByRole("button", { name: "Отмена" }));
    expect(screen.queryByRole("dialog", { name: "Название листа" })).toBeNull();
    expect(fake.api.updatePalletSheet).not.toHaveBeenCalled();
  });
});

describe("the A4 sheets page: deleting", () => {
  async function openDelete(fake: FakeOfficeSession, sheet = LANDSCAPE): Promise<HTMLElement> {
    await openSheets(fake);
    click(`Удалить «${sheet.name}»`);
    return screen.findByRole("dialog", { name: `Удалить «${sheet.name}»?` });
  }

  it("asks first, says what it means, and deletes nothing on «Отмена»", async () => {
    const fake = session(STOCK);
    const box = await openDelete(fake);
    expect(within(box).getByText(/Лист пропадёт из списка, вернуть его нельзя/)).toBeTruthy();
    expect(
      within(box).getByText(/Лист, выбранный в запланированной смене, удалить нельзя/),
    ).toBeTruthy();
    expect(fake.api.deletePalletSheet).not.toHaveBeenCalled();
    fireEvent.click(within(box).getByRole("button", { name: "Отмена" }));
    expect(fake.api.deletePalletSheet).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(3);
  });

  it("deletes after the confirmation, drops the row without reading again and moves the focus to the notice", async () => {
    const fake = session(STOCK);
    fake.api.deletePalletSheet.mockResolvedValue(undefined);
    const box = await openDelete(fake);
    fireEvent.click(within(box).getByRole("button", { name: "Удалить" }));
    const notice = await screen.findByText(`Лист «${LANDSCAPE.name}» удалён.`);
    expect(fake.api.deletePalletSheet).toHaveBeenCalledWith(TOKEN, LANDSCAPE.id);
    expect(rows()).toHaveLength(2);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fake.api.listPalletSheets).toHaveBeenCalledTimes(1);
    const region = notice.closest('[tabindex="-1"]');
    expect(region).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(region));
  });

  it("deletes once when «Удалить» is pressed twice at once", async () => {
    const fake = session(STOCK);
    const slow = deferred<undefined>();
    fake.api.deletePalletSheet.mockReturnValue(slow.promise);
    const box = await openDelete(fake);
    const confirm = within(box).getByRole("button", { name: "Удалить" });
    await act(async () => {
      fireEvent.click(confirm);
      fireEvent.click(confirm);
    });
    expect(fake.api.deletePalletSheet).toHaveBeenCalledTimes(1);
    await act(async () => {
      slow.resolve(undefined);
      await slow.promise;
    });
    await screen.findByText(`Лист «${LANDSCAPE.name}» удалён.`);
  });

  it("names the planned shifts that hold the sheet when the host refuses, as links to them, and keeps the dialog", async () => {
    const fake = session(STOCK);
    const ids = ["11111111-2222-4333-8444-555555555551", "11111111-2222-4333-8444-555555555552"];
    fake.api.deletePalletSheet.mockRejectedValue(
      api("conflict", { constraint: "template_in_use", shiftIds: ids }),
    );
    const box = await openDelete(fake);
    fireEvent.click(within(box).getByRole("button", { name: "Удалить" }));
    expect(await within(box).findByText(/Лист выбран в запланированных сменах \(2\)/)).toBeTruthy();
    const links = within(box).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual(["Смена 11111111", "Смена 11111111"]);
    expect(links.map((link) => link.getAttribute("href"))).toEqual(
      ids.map((id) => `/shifts/${id}`),
    );
    expect(screen.getByRole("dialog", { name: `Удалить «${LANDSCAPE.name}»?` })).toBeTruthy();
    expect(rows()).toHaveLength(3);
    await waitFor(() => expect(fake.api.listPalletSheets).toHaveBeenCalledTimes(2));
  });

  it("says the sheet is in use without a count or a list when the host names no shift", async () => {
    const fake = session(STOCK);
    fake.api.deletePalletSheet.mockRejectedValue(
      api("conflict", { constraint: "template_in_use" }),
    );
    const box = await openDelete(fake);
    fireEvent.click(within(box).getByRole("button", { name: "Удалить" }));
    expect(
      await within(box).findByText(
        "Лист выбран в запланированной смене: сначала смените лист в смене.",
      ),
    ).toBeTruthy();
    expect(within(box).queryByRole("list")).toBeNull();
    expect(within(box).queryByRole("link")).toBeNull();
  });

  it("lists no more than ten shifts and counts the rest", async () => {
    const fake = session(STOCK);
    const ids = Array.from(
      { length: 12 },
      (_, index) => `${String(index).padStart(2, "0")}111111-2222-4333-8444-555555555551`,
    );
    fake.api.deletePalletSheet.mockRejectedValue(
      api("conflict", { constraint: "template_in_use", shiftIds: ids }),
    );
    const box = await openDelete(fake);
    fireEvent.click(within(box).getByRole("button", { name: "Удалить" }));
    await within(box).findByText(/Лист выбран в запланированных сменах \(12\)/);
    expect(within(box).getAllByRole("link")).toHaveLength(10);
    expect(within(box).getByText("…и ещё 2")).toBeTruthy();
  });

  it("says the main sheet cannot be deleted", async () => {
    const fake = session(STOCK);
    fake.api.deletePalletSheet.mockRejectedValue(
      api("conflict", { constraint: "template_is_default" }),
    );
    const box = await openDelete(fake, PORTRAIT);
    fireEvent.click(within(box).getByRole("button", { name: "Удалить" }));
    expect(
      await within(box).findByText(
        "Лист выбран по умолчанию (для организации или категории): сначала выберите другой на вкладке «По умолчанию».",
      ),
    ).toBeTruthy();
    expect(rows()).toHaveLength(3);
  });

  it("says a sheet that is gone already is gone and reads the list again", async () => {
    const fake = session(STOCK);
    fake.api.deletePalletSheet.mockRejectedValue(api("not_found"));
    const box = await openDelete(fake);
    fireEvent.click(within(box).getByRole("button", { name: "Удалить" }));
    expect(await within(box).findByText("Листа уже нет: список обновлён.")).toBeTruthy();
    await waitFor(() => expect(fake.api.listPalletSheets).toHaveBeenCalledTimes(2));
  });
});

describe("the A4 sheets page: a sheet from a file", () => {
  const OUR_SHEET: PalletSheet = { ...LANDSCAPE, name: " Лист из файла " };

  it("creates a new sheet from the file: name trimmed, layout as read, no preset key", async () => {
    const fake = session(STOCK);
    echoCreate(fake);
    await openSheets(fake);
    pickFile(sheetFile(OUR_SHEET));
    expect(await screen.findByText("Лист «Лист из файла» загружен.")).toBeTruthy();
    expect(fake.api.createPalletSheet).toHaveBeenCalledTimes(1);
    const body = fake.api.createPalletSheet.mock.calls[0]?.[1];
    expect(body).toEqual({ name: "Лист из файла", spec: LANDSCAPE.spec });
    expect(body).not.toHaveProperty("presetKey");
    expect(rows()).toHaveLength(4);
  });

  it("refuses a file that is a label template, broken, or not JSON, and sends nothing", async () => {
    const fake = session(STOCK);
    await openSheets(fake);
    const refused = "Файл — не лист паллеты А4 или повреждён.";
    pickFile(
      new File(
        [JSON.stringify({ name: "x", purpose: "box", spec: { widthMm: 58 } })],
        "label.json",
        { type: "application/json" },
      ),
    );
    expect(await screen.findByText(refused)).toBeTruthy();
    pickFile(new File(["{"], "broken.json", { type: "application/json" }));
    await screen.findByText(refused);
    pickFile(new File(["x"], "notes.txt", { type: "text/plain" }));
    await screen.findByText(refused);
    expect(fake.api.createPalletSheet).not.toHaveBeenCalled();
  });

  it("refuses a file over 256 KiB without reading it", async () => {
    const fake = session(STOCK);
    await openSheets(fake);
    const big = new File([new Uint8Array(256 * 1024 + 1)], "big.json", {
      type: "application/json",
    });
    const text = vi.spyOn(big, "text");
    pickFile(big);
    expect(await screen.findByText("Файл больше 256 КБ: это не лист паллеты А4.")).toBeTruthy();
    expect(text).not.toHaveBeenCalled();
    expect(fake.api.createPalletSheet).not.toHaveBeenCalled();
  });

  it("reads a file of exactly 256 KiB", async () => {
    const fake = session(STOCK);
    await openSheets(fake);
    const edge = new File([new Uint8Array(256 * 1024)], "edge.json", { type: "application/json" });
    const text = vi.spyOn(edge, "text");
    pickFile(edge);
    await screen.findByText("Файл — не лист паллеты А4 или повреждён.");
    expect(text).toHaveBeenCalledTimes(1);
  });

  it("says the host did not take the sheet", async () => {
    const fake = session(STOCK);
    fake.api.createPalletSheet.mockRejectedValue(api("validation_failed", { field: "spec" }));
    await openSheets(fake);
    pickFile(sheetFile(OUR_SHEET));
    expect(await screen.findByText("Хост не принял лист.")).toBeTruthy();
    await waitFor(() => expect(fake.api.listPalletSheets).toHaveBeenCalledTimes(2));
  });

  it("warns when the loaded sheet has a name another sheet has", async () => {
    const fake = session(STOCK);
    echoCreate(fake);
    await openSheets(fake);
    pickFile(sheetFile({ ...LANDSCAPE, name: PORTRAIT.name }));
    await screen.findByText(`Лист «${PORTRAIT.name}» загружен.`);
    expect(screen.getByText(/Названия повторяются/)).toBeTruthy();
    expect(screen.getAllByText("Название повторяется")).toHaveLength(2);
  });
});

describe("the A4 sheets page: a sheet to a file", () => {
  it("saves the sheet's JSON under its name, as the domain writes it", async () => {
    await openSheets(session(STOCK));
    click(`Скачать JSON «${LANDSCAPE.name}»`);
    expect(downloadFile).toHaveBeenCalledTimes(1);
    const [blob, fileName] = vi.mocked(downloadFile).mock.calls[0] ?? [];
    expect(fileName).toBe(`${LANDSCAPE.name}.json`);
    expect(blob?.type).toBe("application/json");
    expect(blob && (await readBlob(blob))).toBe(sheetExport(LANDSCAPE));
  });

  it("keeps what a file name cannot hold out of the name", async () => {
    const odd = { ...LANDSCAPE, name: 'Цех 1/2: "А4"' };
    await openSheets(session(withSheets([PORTRAIT, odd], PORTRAIT.id)));
    click(`Скачать JSON «${odd.name}»`);
    expect(vi.mocked(downloadFile).mock.calls[0]?.[1]).toBe("Цех 1_2_ _А4_.json");
  });
});

describe("the A4 sheets page: the preview", () => {
  it("opens the sheet in a dialog under its name, draws it once, and closes", async () => {
    await openSheets(session(STOCK));
    click(`Просмотр «${LANDSCAPE.name}»`);
    const box = await screen.findByRole("dialog", { name: LANDSCAPE.name });
    expect(within(box).getByRole("img", { name: LANDSCAPE.name })).toBeTruthy();
    await waitFor(() => expect(paintMonoRaster).toHaveBeenCalledTimes(1));
    expect(renderSheetRaster).toHaveBeenCalledTimes(1);
    expect(vi.mocked(renderSheetRaster).mock.calls[0]?.[0]).toEqual(LANDSCAPE.spec);
    expect(vi.mocked(renderSheetRaster).mock.calls[0]?.[1]).toMatchObject({
      organizationName: "ООО «Атолл»",
      organizationInn: "7701234567",
    });
    fireEvent.click(within(box).getByRole("button", { name: "Закрыть" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not draw the sheet again when the page behind it changes", async () => {
    const fake = session(STOCK);
    await openSheets(fake);
    click(`Просмотр «${LANDSCAPE.name}»`);
    await waitFor(() => expect(paintMonoRaster).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(renderSheetRaster).toHaveBeenCalledTimes(1);
  });
});
