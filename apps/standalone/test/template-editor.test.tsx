import { act, fireEvent, screen, waitFor, within, type RenderResult } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildDuplicateLabelTemplate, buildPalletLabelTemplates } from "@markiro/domain";

import { HostError } from "../src/host/client.js";
import type { LabelTemplate, LabelTemplateSummary, ProductGroup } from "../src/host/protocol.js";
import { downloadFile } from "../src/office/templates/download.js";
import { resizedSpec } from "../src/office/templates/editor-model.js";
import { analyzeImport } from "../src/office/templates/import-analysis.js";
import {
  fakeOfficeSession,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";
import { SESSION } from "./support/fixtures.js";

const GROUPS: ProductGroup[] = [
  { code: 8, alias: "milk", name: "Молочная продукция" },
  { code: 13, alias: "water", name: "Упакованная вода" },
  { code: 15, alias: "beer", name: "Пиво и пивные напитки" },
];

const BOX_58: LabelTemplateSummary = {
  id: "7c1e4b2a-9d3f-4e5a-8b6c-1d2e3f4a5b6c",
  name: "Коробка 58×40",
  purpose: "box",
  enabled: true,
  chzProductGroupCodes: null,
  stock: true,
  widthMm: 58,
  heightMm: 40,
  dpi: 203,
  language: "zpl",
  rev: 60,
};

/** 58×40 mm at 203 dpi: a text line and a `{{qty}}` field. */
const ZPL = [
  "^XA",
  "^PW464",
  "^LL320",
  "^FO40,40^A0N,34,34^FDПартия^FS",
  "^FO40,100^A0N,34,34^FD{{qty}}^FS",
  "^XZ",
].join("\n");

/** The layout the import makes of `ZPL`. */
function importedSpec(source = ZPL) {
  const outcome = analyzeImport({ source, format: "zpl", dpi: 203, purpose: "box" });
  if (!outcome.ok) throw new Error("the sample does not import");
  return outcome.analysis.result.spec;
}

/** What the host answers for a created template. */
function created(name: string, data: Partial<LabelTemplate> = {}): LabelTemplate {
  return {
    id: "c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f",
    name,
    purpose: "box",
    enabled: true,
    chzProductGroupCodes: null,
    stock: false,
    spec: importedSpec(),
    rev: 70,
    ...data,
  };
}

function session(user = TECHNOLOGIST) {
  const fake = fakeOfficeSession({ user });
  fake.api.listTemplates.mockResolvedValue([BOX_58]);
  fake.api.listProductGroups.mockResolvedValue(GROUPS);
  return fake;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function openTemplates(fake: FakeOfficeSession): Promise<RenderResult> {
  const view = renderOffice(fake);
  fireEvent.click(await screen.findByRole("link", { name: "Шаблоны" }));
  await screen.findByRole("heading", { name: "Шаблоны этикеток" });
  await waitFor(() => expect(screen.queryByText("Загрузка…")).toBeNull());
  return view;
}

async function openNew(fake: FakeOfficeSession): Promise<RenderResult> {
  const view = await openTemplates(fake);
  fireEvent.click(screen.getByRole("button", { name: "Создать шаблон" }));
  await screen.findByRole("heading", { name: "Новый шаблон" });
  await settle();
  return view;
}

/** Blob URLs, which jsdom lacks, recorded instead of made. */
function recordBlobUrls() {
  const blobs: Blob[] = [];
  const revoked: string[] = [];
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: (blob: Blob) => {
      blobs.push(blob);
      return "blob:template";
    },
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: (url: string) => {
      revoked.push(url);
    },
  });
  return {
    blobs,
    revoked,
    restore: () => {
      Reflect.deleteProperty(URL, "createObjectURL");
      Reflect.deleteProperty(URL, "revokeObjectURL");
    },
  };
}

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

const CODE_LABELS = { zpl: "Код ZPL", tspl: "Код TSPL (TSC)", json: "JSON шаблона" } as const;

/** Imports code through the dialog and replaces the layout. */
async function importCode(
  source: string,
  format: "zpl" | "tspl" | "json" = "zpl",
  dpi?: 203 | 300,
): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Импорт кода" }));
  const dialog = await screen.findByRole("dialog", { name: "Импорт кода этикетки" });
  fireEvent.change(within(dialog).getByRole("combobox", { name: "Формат кода" }), {
    target: { value: format },
  });
  if (dpi !== undefined) {
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Разрешение кода" }), {
      target: { value: String(dpi) },
    });
  }
  fireEvent.change(within(dialog).getByLabelText(CODE_LABELS[format]), {
    target: { value: source },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Проверить код" }));
  await act(async () => {
    fireEvent.click(within(dialog).getByRole("button", { name: "Заменить макет" }));
  });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

function chooseCategories(...names: string[]): void {
  fireEvent.click(screen.getByRole("radio", { name: "Только выбранные" }));
  for (const name of names) fireEvent.click(screen.getByRole("checkbox", { name }));
}

async function save(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  });
}

function saveButton(): HTMLElement {
  return screen.getByRole("button", { name: "Сохранить" });
}

function nameError(): string | null | undefined {
  const name = screen.getByLabelText("Название");
  const describedBy = name.getAttribute("aria-describedby");
  return describedBy === null ? null : document.getElementById(describedBy)?.textContent;
}

describe("a new label template", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens from «Создать шаблон» for both roles as an unnamed, enabled box template for every category with an empty 58×40 label", async () => {
    for (const user of [SESSION.user, TECHNOLOGIST]) {
      const view = await openNew(session(user));
      expect(screen.getByLabelText("Название")).toHaveProperty("value", "");
      expect(screen.getByRole("combobox", { name: "Назначение" })).toHaveProperty("value", "box");
      expect(screen.getByRole("checkbox", { name: "Включён" }).getAttribute("aria-checked")).toBe(
        "true",
      );
      expect(
        screen.getByRole("radio", { name: "Все категории" }).getAttribute("aria-checked"),
      ).toBe("true");
      expect(screen.getByText("Размер: 58 × 40 мм · 203 dpi")).toBeTruthy();
      expect(
        screen.getByText("Содержимое этикетки не задано — импортируйте код ZPL, TSPL или JSON."),
      ).toBeTruthy();
      expect(saveButton()).toHaveProperty("disabled", false);
      fireEvent.click(screen.getByRole("button", { name: "К шаблонам" }));
      await screen.findByRole("heading", { name: "Шаблоны этикеток" });
      view.unmount();
    }
  });

  it("creates the template from the trimmed name, the imported layout and the categories ascending, then lists the templates again with a notice", async () => {
    const fake = session();
    fake.api.createTemplate.mockResolvedValue(
      created("Молоко 58×40", { chzProductGroupCodes: [8, 13] }),
    );
    await openNew(fake);
    type("Название", "  Молоко 58×40 ");
    await importCode(ZPL);
    expect(screen.getByText("Элементов в макете: 2")).toBeTruthy();
    expect(screen.getByText("Размер: 58,06 × 40,04 мм · 203 dpi")).toBeTruthy();
    chooseCategories("Упакованная вода", "Молочная продукция");
    // The list is read again once the editor is back: that read is held open.
    let listed: (list: LabelTemplateSummary[]) => void = () => undefined;
    fake.api.listTemplates.mockReturnValue(
      new Promise<LabelTemplateSummary[]>((resolve) => {
        listed = resolve;
      }),
    );
    await save();
    expect(fake.api.createTemplate).toHaveBeenCalledTimes(1);
    expect(fake.api.createTemplate.mock.calls[0]?.[1]).toStrictEqual({
      name: "Молоко 58×40",
      purpose: "box",
      enabled: true,
      chzProductGroupCodes: [8, 13],
      spec: importedSpec(),
    });
    await screen.findByRole("heading", { name: "Шаблоны этикеток" });
    expect(screen.getByText("Шаблон «Молоко 58×40» создан.")).toBeTruthy();
    // The cached list was dropped, so no row of the old list shows while it is read.
    expect(screen.getByText("Загрузка…")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    await act(async () => {
      listed([BOX_58]);
    });
    expect(fake.api.listTemplates).toHaveBeenCalledTimes(2);
  });

  it("sends a disabled template, and a purpose with its own starting layout", async () => {
    const fake = session();
    fake.api.createTemplate.mockResolvedValue(created("Паллета", { purpose: "pallet" }));
    await openNew(fake);
    type("Название", "Паллета");
    fireEvent.change(screen.getByRole("combobox", { name: "Назначение" }), {
      target: { value: "pallet" },
    });
    expect(screen.getByText("Размер: 100 × 150 мм · 203 dpi")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Включён" }));
    await save();
    expect(fake.api.createTemplate.mock.calls[0]?.[1]).toStrictEqual({
      name: "Паллета",
      purpose: "pallet",
      enabled: false,
      chzProductGroupCodes: null,
      spec: buildPalletLabelTemplates()[0]?.spec,
    });
  });

  it("keeps an imported layout when the purpose changes", async () => {
    const fake = session();
    await openNew(fake);
    await importCode(ZPL);
    fireEvent.change(screen.getByRole("combobox", { name: "Назначение" }), {
      target: { value: "pallet" },
    });
    expect(screen.getByText("Размер: 58,06 × 40,04 мм · 203 dpi")).toBeTruthy();
    expect(screen.getByText("Элементов в макете: 2")).toBeTruthy();
  });

  it("refuses an empty name and an empty choice of categories before sending, and focuses the refused control", async () => {
    const fake = session();
    await openNew(fake);
    type("Название", "   ");
    await save();
    expect(nameError()).toBe("Укажите название, до 200 символов");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Название")));
    type("Название", "Молоко");
    expect(nameError()).toBeNull();
    chooseCategories();
    await save();
    expect(
      screen.getByText("Выберите хотя бы одну категорию или переключитесь на «Все категории»."),
    ).toBeTruthy();
    expect(fake.api.createTemplate).not.toHaveBeenCalled();
  });

  it("puts the host's refusal under the name or the categories, and explains a refused layout or a lost host above the form", async () => {
    const fake = session();
    fake.api.createTemplate
      .mockRejectedValueOnce(
        new HostError({
          kind: "api",
          code: "validation_failed",
          message: "name",
          details: { field: "name" },
        }),
      )
      .mockRejectedValueOnce(
        new HostError({
          kind: "api",
          code: "validation_failed",
          message: "codes",
          details: { field: "chzProductGroupCodes" },
        }),
      )
      .mockRejectedValueOnce(
        new HostError({
          kind: "api",
          code: "validation_failed",
          message: "spec",
          details: { field: "spec" },
        }),
      )
      .mockRejectedValueOnce(
        new HostError({ kind: "transport", code: "unreachable", message: "down" }),
      );
    await openNew(fake);
    type("Название", "Молоко");
    await save();
    expect(nameError()).toBe("Хост не принял это значение. Проверьте его.");
    await save();
    expect(nameError()).toBeNull();
    expect(
      screen.getByText("Хост не принял эти категории: справочник групп мог измениться."),
    ).toBeTruthy();
    await save();
    expect(screen.getByRole("alert").textContent).toBe(
      "✕Хост не принял макет: он больше 256 КБ или вложен глубже 64 уровней.",
    );
    await save();
    expect(screen.getByRole("alert").textContent).toBe(
      "✕Нет связи с хостом. Проверьте, что ПК-хост включён и служба запущена.",
    );
    expect(saveButton()).toHaveProperty("disabled", false);
    expect(fake.api.createTemplate).toHaveBeenCalledTimes(4);
  });

  it("holds a product duplicate to the duplicate rule and offers the domain's duplicate layout back", async () => {
    const fake = session();
    await openNew(fake);
    fireEvent.change(screen.getByRole("combobox", { name: "Назначение" }), {
      target: { value: "product_duplicate" },
    });
    expect(screen.queryByRole("alert")).toBeNull();
    await importCode(ZPL);
    expect(screen.getByRole("alert").textContent).toContain(
      "Дубликату нужен один Data Matrix с полным кодом маркировки внутри этикетки; поле SSCC недопустимо.",
    );
    expect(saveButton()).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Взять макет дубликата 58 × 40" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(saveButton()).toHaveProperty("disabled", false);
    expect(
      screen.getByText(`Элементов в макете: ${buildDuplicateLabelTemplate().elements.length}`),
    ).toBeTruthy();
  });

  it("takes a JSON import's name for an unnamed template and never over a typed one", async () => {
    const fake = session();
    await openNew(fake);
    const body = JSON.stringify({ name: "Из файла", purpose: "box", spec: importedSpec() });
    await importCode(body, "json");
    expect(screen.getByLabelText("Название")).toHaveProperty("value", "Из файла");
    type("Название", "Своё");
    await importCode(body, "json");
    expect(screen.getByLabelText("Название")).toHaveProperty("value", "Своё");
  });

  it("warns that the EGAIS field prints empty on categories without beer", async () => {
    const fake = session();
    await openNew(fake);
    await importCode(
      ["^XA", "^PW464", "^LL320", "^FO40,40^A0N,34,34^FD{{product.egais}}^FS", "^XZ"].join("\n"),
    );
    const hint =
      "Поле ЕГАИС заполняется только у товаров категории «Пиво»: на выбранных категориях оно напечатается пустым.";
    expect(screen.queryByText(hint)).toBeNull();
    chooseCategories("Молочная продукция");
    expect(screen.getByText(hint)).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Пиво и пивные напитки" }));
    expect(screen.queryByText(hint)).toBeNull();
  });

  it("downloads the layout as `{ name, purpose, spec }` under a file name made of the name", async () => {
    const urls = recordBlobUrls();
    const clicked: { download: string; href: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push({ download: this.download, href: this.getAttribute("href") ?? "" });
    });
    const fake = session();
    await openNew(fake);
    type("Название", " Молоко 58×40 ");
    await importCode(ZPL);
    fireEvent.click(screen.getByRole("button", { name: "Скачать JSON" }));
    urls.restore();
    expect(clicked).toEqual([{ download: "Молоко-58-40.json", href: "blob:template" }]);
    expect(urls.revoked).toEqual(["blob:template"]);
    expect(urls.blobs[0]?.type).toBe("application/json");
    // As the file has it: JSON leaves out the keys the import left undefined.
    expect(JSON.parse(await (urls.blobs[0]?.text() ?? Promise.resolve("")))).toStrictEqual({
      name: "Молоко 58×40",
      purpose: "box",
      spec: JSON.parse(JSON.stringify(importedSpec())),
    });
    expect(document.querySelector("a[download]")).toBeNull();
  });

  it("says there are unsaved changes until they are taken back, and tells the import so", async () => {
    const fake = session();
    await openNew(fake);
    const note = "Есть несохранённые изменения.";
    expect(screen.queryByText(note)).toBeNull();
    type("Название", "Молоко");
    expect(screen.getByText(note).getAttribute("aria-live")).toBe("polite");
    fireEvent.click(screen.getByRole("button", { name: "Импорт кода" }));
    expect(
      screen.getByText("Несохранённый макет будет заменён, когда вы подтвердите импорт."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    type("Название", "");
    expect(screen.queryByText(note)).toBeNull();
  });

  it("sends once for a double click and keeps the form off until the answer", async () => {
    const fake = session();
    let answer: (template: LabelTemplate) => void = () => undefined;
    fake.api.createTemplate.mockReturnValue(
      new Promise<LabelTemplate>((resolve) => {
        answer = resolve;
      }),
    );
    await openNew(fake);
    type("Название", "Молоко");
    await act(async () => {
      fireEvent.click(saveButton());
      fireEvent.click(saveButton());
    });
    expect(fake.api.createTemplate).toHaveBeenCalledTimes(1);
    // The fieldset turns its controls off; their own `disabled` stays false.
    expect(screen.getByLabelText("Название").matches(":disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Импорт кода" }).matches(":disabled")).toBe(true);
    await act(async () => {
      answer(created("Молоко"));
    });
    await screen.findByRole("heading", { name: "Шаблоны этикеток" });
  });

  it("shows a name with markup as text in the notice", async () => {
    const fake = session();
    fake.api.createTemplate.mockResolvedValue(created("<b>Молоко</b>"));
    await openNew(fake);
    type("Название", "<b>Молоко</b>");
    await save();
    const notice = await screen.findByText("Шаблон «<b>Молоко</b>» создан.");
    expect(notice.querySelector("b")).toBeNull();
  });

  // Tests below are the implementer's, beyond the plan: each kills a mutant the plan's tests let live.

  it("lays the form out in three cards with their notes and the page's heading", async () => {
    await openNew(session());
    for (const title of ["Шаблон", "Макет", "Категории"]) {
      expect(screen.getByRole("heading", { level: 2, name: title })).toBeTruthy();
    }
    expect(screen.getByRole("heading", { level: 1, name: "Новый шаблон" })).toBeTruthy();
    expect(
      screen.getByText("Выключенный шаблон не предлагается для товаров и умолчаний."),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Один шаблон печатается и на Zebra, и на TSC: станция выбирает язык по своему принтеру.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Скачать JSON" })).toBeTruthy();
  });

  it("starts each purpose with its own layout until a layout is imported", async () => {
    await openNew(session());
    const purpose = () => screen.getByRole("combobox", { name: "Назначение" });
    const elements = (n: number) => screen.getByText(`Элементов в макете: ${n}`);
    fireEvent.change(purpose(), { target: { value: "product_duplicate" } });
    expect(elements(buildDuplicateLabelTemplate().elements.length)).toBeTruthy();
    fireEvent.change(purpose(), { target: { value: "pallet" } });
    expect(elements(buildPalletLabelTemplates()[0]?.spec.elements.length ?? -1)).toBeTruthy();
    fireEvent.change(purpose(), { target: { value: "box" } });
    expect(
      screen.getByText("Содержимое этикетки не задано — импортируйте код ZPL, TSPL или JSON."),
    ).toBeTruthy();
    expect(screen.getByText("Размер: 58 × 40 мм · 203 dpi")).toBeTruthy();
  });

  it("keeps the old alert and refusal only until the next save", async () => {
    const fake = session();
    fake.api.createTemplate
      .mockRejectedValueOnce(
        new HostError({
          kind: "api",
          code: "validation_failed",
          message: "codes",
          details: { field: "chzProductGroupCodes" },
        }),
      )
      .mockRejectedValueOnce(
        new HostError({
          kind: "api",
          code: "validation_failed",
          message: "spec",
          details: { field: "spec" },
        }),
      );
    await openNew(fake);
    type("Название", "Молоко");
    const scopeRefused = "Хост не принял эти категории: справочник групп мог измениться.";
    await save();
    expect(screen.getByText(scopeRefused)).toBeTruthy();
    // A refusal above the form takes the one under the categories away.
    await save();
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByText(scopeRefused)).toBeNull();
    // A refusal under the name takes the alert above the form away.
    type("Название", "   ");
    await save();
    expect(nameError()).toBe("Укажите название, до 200 символов");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(fake.api.createTemplate).toHaveBeenCalledTimes(2);
  });

  it("clears a refusal under the categories when they change, not when the name does", async () => {
    const fake = session();
    await openNew(fake);
    type("Название", "Молоко");
    chooseCategories();
    await save();
    const refused = "Выберите хотя бы одну категорию или переключитесь на «Все категории».";
    expect(screen.getByText(refused)).toBeTruthy();
    type("Название", "Молоко 2");
    expect(screen.getByText(refused)).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Молочная продукция" }));
    expect(screen.queryByText(refused)).toBeNull();
  });

  it("moves the focus to the categories when they are refused", async () => {
    await openNew(session());
    type("Название", "Молоко");
    chooseCategories();
    await save();
    const card = document.querySelector("[id$='-scope']");
    expect(card?.getAttribute("tabindex")).toBe("-1");
    await waitFor(() => expect(document.activeElement).toBe(card));
  });

  it("downloads a template with the purpose and the starting layout it has, named or not", async () => {
    const urls = recordBlobUrls();
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this.download);
    });
    await openNew(session());
    fireEvent.change(screen.getByRole("combobox", { name: "Назначение" }), {
      target: { value: "pallet" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Скачать JSON" }));
    urls.restore();
    expect(JSON.parse(await (urls.blobs[0]?.text() ?? Promise.resolve("")))).toStrictEqual({
      name: "",
      purpose: "pallet",
      spec: JSON.parse(JSON.stringify(buildPalletLabelTemplates()[0]?.spec)),
    });
    expect(clicked).toEqual(["label.json"]);
  });

  it("refuses a name over 200 characters before sending", async () => {
    const fake = session();
    await openNew(fake);
    type("Название", "я".repeat(201));
    await save();
    expect(nameError()).toBe("Укажите название, до 200 символов");
    expect(fake.api.createTemplate).not.toHaveBeenCalled();
    type("Название", "я".repeat(200));
    fake.api.createTemplate.mockResolvedValue(created("я".repeat(200)));
    await save();
    expect(fake.api.createTemplate).toHaveBeenCalledTimes(1);
  });

  it("keeps «Сохранить» busy while the host answers, and explains a stale answer without a reload", async () => {
    const fake = session();
    let refuse: (error: unknown) => void = () => undefined;
    fake.api.createTemplate.mockReturnValue(
      new Promise<LabelTemplate>((_resolve, reject) => {
        refuse = reject;
      }),
    );
    await openNew(fake);
    type("Название", "Молоко");
    await save();
    expect(saveButton()).toHaveProperty("disabled", true);
    await act(async () => {
      refuse(new HostError({ kind: "api", code: "stale_revision", message: "stale" }));
    });
    expect(saveButton()).toHaveProperty("disabled", false);
    expect(screen.getByRole("alert").textContent).toContain(
      "Данные изменились, пока вы их редактировали. Обновите их и повторите.",
    );
    expect(screen.queryByRole("button", { name: "Загрузить заново" })).toBeNull();
  });

  it("opens the import on the layout's format and resolution, and closes it without a change", async () => {
    await openNew(session());
    const tspl = ["SIZE 58 mm, 40 mm", "CLS", 'TEXT 40,40,"0",0,12,12,"{{qty}}"', "PRINT 1"].join(
      "\n",
    );
    await importCode(tspl, "tspl", 300);
    fireEvent.click(screen.getByRole("button", { name: "Импорт кода" }));
    const dialog = await screen.findByRole("dialog", { name: "Импорт кода этикетки" });
    expect(within(dialog).getByRole("combobox", { name: "Формат кода" })).toHaveProperty(
      "value",
      "tspl",
    );
    expect(within(dialog).getByRole("combobox", { name: "Разрешение кода" })).toHaveProperty(
      "value",
      "300",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Отмена" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("Элементов в макете: 1")).toBeTruthy();
  });

  it("shows names and imported text with markup as text, never as markup", async () => {
    const fake = session();
    fake.api.listProductGroups.mockResolvedValue([
      { code: 8, alias: "milk", name: "<img src=x onerror=alert(1)>Молоко" },
    ]);
    fake.api.createTemplate.mockResolvedValue(created("<i>Из файла</i>"));
    await openNew(fake);
    await importCode(
      JSON.stringify({ name: "<i>Из файла</i>", purpose: "box", spec: importedSpec() }),
      "json",
    );
    expect(screen.getByLabelText("Название")).toHaveProperty("value", "<i>Из файла</i>");
    chooseCategories("<img src=x onerror=alert(1)>Молоко");
    await save();
    expect(await screen.findByText("Шаблон «<i>Из файла</i>» создан.")).toBeTruthy();
    expect(document.querySelector("img, i, b, script")).toBeNull();
  });
});

/** About 100 × 100 mm at 203 dpi, with a text about 32 mm long near the right edge. */
const WIDE_ZPL = ["^XA", "^PW800", "^LL800", "^FO480,40^A0N,34,34^FDACME LOGISTICS^FS", "^XZ"].join(
  "\n",
);

function sizeDialog(): HTMLElement {
  return screen.getByRole("dialog", { name: "Размер этикетки" });
}

async function applySize(): Promise<void> {
  await act(async () => {
    fireEvent.click(within(sizeDialog()).getByRole("button", { name: "Применить" }));
  });
}

/** The layout a save sends. */
async function savedSpec(fake: FakeOfficeSession): Promise<unknown> {
  type("Название", "Молоко");
  await save();
  return fake.api.createTemplate.mock.calls[0]?.[1].spec;
}

describe("the label's size", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  it("opens on the layout's size and resolution, takes a preset and sends the new size", async () => {
    const fake = session();
    fake.api.createTemplate.mockResolvedValue(created("Молоко"));
    await openNew(fake);
    fireEvent.click(screen.getByRole("button", { name: "Изменить размер" }));
    const dialog = sizeDialog();
    expect(within(dialog).getByRole("combobox", { name: "Размер" })).toHaveProperty(
      "value",
      "58x40",
    );
    expect(within(dialog).getByLabelText("Ширина, мм")).toHaveProperty("value", "58");
    expect(within(dialog).getByLabelText("Высота, мм")).toHaveProperty("value", "40");
    expect(within(dialog).getByRole("combobox", { name: "Разрешение макета" })).toHaveProperty(
      "value",
      "203",
    );
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Размер" }), {
      target: { value: "100x150" },
    });
    expect(within(dialog).getByLabelText("Ширина, мм")).toHaveProperty("value", "100");
    expect(within(dialog).getByLabelText("Высота, мм")).toHaveProperty("value", "150");
    await applySize();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Размер: 100 × 150 мм · 203 dpi")).toBeTruthy();
    expect(await savedSpec(fake)).toStrictEqual({
      widthMm: 100,
      heightMm: 150,
      dpi: 203,
      language: "zpl",
      elements: [],
    });
  });

  it("takes a typed size with a comma as «Свой размер», and a resolution", async () => {
    const fake = session();
    await openNew(fake);
    fireEvent.click(screen.getByRole("button", { name: "Изменить размер" }));
    type("Ширина, мм", "58,5");
    expect(within(sizeDialog()).getByRole("combobox", { name: "Размер" })).toHaveProperty(
      "value",
      "custom",
    );
    fireEvent.change(within(sizeDialog()).getByRole("combobox", { name: "Разрешение макета" }), {
      target: { value: "300" },
    });
    await applySize();
    expect(screen.getByText("Размер: 58,5 × 40 мм · 300 dpi")).toBeTruthy();
  });

  it("refuses a size outside 10–300 mm under its field and keeps the layout", async () => {
    const fake = session();
    await openNew(fake);
    fireEvent.click(screen.getByRole("button", { name: "Изменить размер" }));
    type("Ширина, мм", "9");
    type("Высота, мм", "сорок");
    await applySize();
    expect(within(sizeDialog()).getAllByText("Размер — от 10 до 300 мм")).toHaveLength(2);
    type("Ширина, мм", "90");
    expect(within(sizeDialog()).getAllByText("Размер — от 10 до 300 мм")).toHaveLength(1);
    fireEvent.click(within(sizeDialog()).getByRole("button", { name: "Отмена" }));
    expect(screen.getByText("Размер: 58 × 40 мм · 203 dpi")).toBeTruthy();
  });

  it("moves the elements inside a smaller label, and keeps the layout when one is larger than the label", async () => {
    const fake = session();
    fake.api.createTemplate.mockResolvedValue(created("Молоко"));
    await openNew(fake);
    await importCode(WIDE_ZPL);
    fireEvent.click(screen.getByRole("button", { name: "Изменить размер" }));
    type("Ширина, мм", "10");
    type("Высота, мм", "10");
    await applySize();
    expect(within(sizeDialog()).getByRole("alert").textContent).toBe(
      "✕Элемент макета больше этой этикетки. Увеличьте размер или импортируйте код заново.",
    );
    fireEvent.change(within(sizeDialog()).getByRole("combobox", { name: "Размер" }), {
      target: { value: "58x40" },
    });
    expect(within(sizeDialog()).queryByRole("alert")).toBeNull();
    await applySize();
    expect(screen.getByText("Размер: 58 × 40 мм · 203 dpi")).toBeTruthy();
    expect(await savedSpec(fake)).toStrictEqual(resizedSpec(importedSpec(WIDE_ZPL), 58, 40, "box"));
  });

  it("keeps the exact size of an axis left as it was", async () => {
    const fake = session();
    fake.api.createTemplate.mockResolvedValue(created("Молоко"));
    await openNew(fake);
    await importCode(ZPL);
    fireEvent.click(screen.getByRole("button", { name: "Изменить размер" }));
    expect(within(sizeDialog()).getByLabelText("Ширина, мм")).toHaveProperty("value", "58,06");
    type("Высота, мм", "50");
    await applySize();
    expect(screen.getByText("Размер: 58,06 × 50 мм · 203 dpi")).toBeTruthy();
    expect(await savedSpec(fake)).toStrictEqual({
      ...importedSpec(),
      heightMm: 50,
    });
  });

  /** The error text under a field of the size dialog, or `undefined` when it has none. */
  function sizeFieldError(label: string): string | null | undefined {
    const describedBy = within(sizeDialog()).getByLabelText(label).getAttribute("aria-describedby");
    return describedBy === null ? undefined : document.getElementById(describedBy)?.textContent;
  }

  /** 58.06 × 41.29 mm at 203 dpi: neither axis is a whole number of millimetres. */
  const TALL_ZPL = [
    "^XA",
    "^PW464",
    "^LL330",
    "^FO40,40^A0N,34,34^FDПартия^FS",
    "^FO40,100^A0N,34,34^FD{{qty}}^FS",
    "^XZ",
  ].join("\n");

  it("takes a width of digits with a comma or a point within 10–300 mm, and refuses anything else under the field", async () => {
    const fake = session();
    await openNew(fake);
    fireEvent.click(screen.getByRole("button", { name: "Изменить размер" }));
    for (const label of ["Ширина, мм", "Высота, мм"]) {
      const field = within(sizeDialog()).getByLabelText(label);
      expect(field.getAttribute("inputmode"), label).toBe("decimal");
      expect(field.getAttribute("type"), label).not.toBe("number");
    }
    const refused = [
      "",
      "   ",
      "-20",
      "+60",
      "1e2",
      "1e400",
      "Infinity",
      "0x20",
      "9,99",
      "300,01",
      "5,",
      ",5",
      "58,5,5",
      "5 8",
      "58 мм",
    ];
    for (const text of refused) {
      type("Ширина, мм", text);
      await applySize();
      expect(within(sizeDialog()).getAllByText("Размер — от 10 до 300 мм"), text).toHaveLength(1);
      expect(sizeFieldError("Ширина, мм"), text).toBe("Размер — от 10 до 300 мм");
      expect(sizeFieldError("Высота, мм"), text).toBeUndefined();
      // A malformed number is not «the element is too large».
      expect(within(sizeDialog()).queryByRole("alert"), text).toBeNull();
    }
    fireEvent.click(within(sizeDialog()).getByRole("button", { name: "Отмена" }));
    expect(screen.getByText("Размер: 58 × 40 мм · 203 dpi")).toBeTruthy();
    const taken: [string, string][] = [
      ["10", "10"],
      ["300", "300"],
      ["58.5", "58,5"],
      [" 58,5 ", "58,5"],
      ["10,00", "10"],
      ["300.00", "300"],
      ["058", "58"],
    ];
    for (const [text, shown] of taken) {
      fireEvent.click(screen.getByRole("button", { name: "Изменить размер" }));
      type("Ширина, мм", text);
      await applySize();
      expect(screen.getByText(`Размер: ${shown} × 40 мм · 203 dpi`), text).toBeTruthy();
    }
  });

  it("refuses one axis only under its own field, and clears each error as that field is typed in", async () => {
    const fake = session();
    await openNew(fake);
    fireEvent.click(screen.getByRole("button", { name: "Изменить размер" }));
    type("Высота, мм", "9");
    await applySize();
    expect(sizeFieldError("Высота, мм")).toBe("Размер — от 10 до 300 мм");
    expect(sizeFieldError("Ширина, мм")).toBeUndefined();
    expect(within(sizeDialog()).queryByRole("alert")).toBeNull();
    expect(within(sizeDialog()).getByRole("combobox", { name: "Размер" })).toHaveProperty(
      "value",
      "custom",
    );
    type("Высота, мм", "40");
    expect(sizeFieldError("Высота, мм")).toBeUndefined();
    type("Ширина, мм", "301");
    type("Высота, мм", "0");
    await applySize();
    expect(within(sizeDialog()).getAllByText("Размер — от 10 до 300 мм")).toHaveLength(2);
    type("Высота, мм", "40");
    expect(sizeFieldError("Высота, мм")).toBeUndefined();
    expect(sizeFieldError("Ширина, мм")).toBe("Размер — от 10 до 300 мм");
    fireEvent.change(within(sizeDialog()).getByRole("combobox", { name: "Размер" }), {
      target: { value: "60x40" },
    });
    expect(sizeFieldError("Ширина, мм")).toBeUndefined();
    type("Ширина, мм", "9");
    type("Высота, мм", "9");
    await applySize();
    expect(within(sizeDialog()).getAllByText("Размер — от 10 до 300 мм")).toHaveLength(2);
    fireEvent.change(within(sizeDialog()).getByRole("combobox", { name: "Размер" }), {
      target: { value: "100x100" },
    });
    expect(within(sizeDialog()).queryByText("Размер — от 10 до 300 мм")).toBeNull();
    expect(within(sizeDialog()).getByLabelText("Ширина, мм")).toHaveProperty("value", "100");
  });

  it("clears the too-large message as either field is typed in, and keeps the layout and the resolution when an element does not fit", async () => {
    const fake = session();
    fake.api.createTemplate.mockResolvedValue(created("Молоко"));
    await openNew(fake);
    await importCode(WIDE_ZPL);
    fireEvent.click(screen.getByRole("button", { name: "Изменить размер" }));
    fireEvent.change(within(sizeDialog()).getByRole("combobox", { name: "Разрешение макета" }), {
      target: { value: "300" },
    });
    type("Ширина, мм", "10");
    await applySize();
    expect(within(sizeDialog()).getByRole("alert")).toBeTruthy();
    type("Ширина, мм", "11");
    expect(within(sizeDialog()).queryByRole("alert")).toBeNull();
    await applySize();
    expect(within(sizeDialog()).getByRole("alert")).toBeTruthy();
    type("Высота, мм", "11");
    expect(within(sizeDialog()).queryByRole("alert")).toBeNull();
    await applySize();
    expect(within(sizeDialog()).getByRole("alert")).toBeTruthy();
    fireEvent.click(within(sizeDialog()).getByRole("button", { name: "Отмена" }));
    expect(await savedSpec(fake)).toStrictEqual(importedSpec(WIDE_ZPL));
  });

  it("keeps the exact height of an axis left as it was, and a resolution changed alone leaves both axes exact", async () => {
    const fake = session();
    fake.api.createTemplate.mockResolvedValue(created("Молоко"));
    await openNew(fake);
    await importCode(TALL_ZPL);
    const imported = importedSpec(TALL_ZPL);
    fireEvent.click(screen.getByRole("button", { name: "Изменить размер" }));
    expect(within(sizeDialog()).getByLabelText("Ширина, мм")).toHaveProperty("value", "58,06");
    expect(within(sizeDialog()).getByLabelText("Высота, мм")).toHaveProperty("value", "41,29");
    expect(within(sizeDialog()).getByRole("combobox", { name: "Размер" })).toHaveProperty(
      "value",
      "custom",
    );
    fireEvent.change(within(sizeDialog()).getByRole("combobox", { name: "Разрешение макета" }), {
      target: { value: "300" },
    });
    await applySize();
    expect(screen.getByText("Размер: 58,06 × 41,29 мм · 300 dpi")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Изменить размер" }));
    type("Ширина, мм", "70");
    await applySize();
    expect(screen.getByText("Размер: 70 × 41,29 мм · 300 dpi")).toBeTruthy();
    expect(await savedSpec(fake)).toStrictEqual({ ...imported, widthMm: 70, dpi: 300 });
  });

  it("opens on the resolution of the layout, and on the size and resolution just applied", async () => {
    const fake = session();
    await openNew(fake);
    await importCode(ZPL, "zpl", 300);
    fireEvent.click(screen.getByRole("button", { name: "Изменить размер" }));
    expect(
      within(sizeDialog()).getByRole("combobox", { name: "Разрешение макета" }),
    ).toHaveProperty("value", "300");
    fireEvent.change(within(sizeDialog()).getByRole("combobox", { name: "Размер" }), {
      target: { value: "100x150" },
    });
    fireEvent.change(within(sizeDialog()).getByRole("combobox", { name: "Разрешение макета" }), {
      target: { value: "203" },
    });
    await applySize();
    fireEvent.click(screen.getByRole("button", { name: "Изменить размер" }));
    expect(within(sizeDialog()).getByRole("combobox", { name: "Размер" })).toHaveProperty(
      "value",
      "100x150",
    );
    expect(within(sizeDialog()).getByLabelText("Ширина, мм")).toHaveProperty("value", "100");
    expect(within(sizeDialog()).getByLabelText("Высота, мм")).toHaveProperty("value", "150");
    expect(
      within(sizeDialog()).getByRole("combobox", { name: "Разрешение макета" }),
    ).toHaveProperty("value", "203");
  });

  it("offers the presets and «Свой размер», fills both fields from each preset, and leaves typed fields alone on «Свой размер»", async () => {
    const fake = session();
    await openNew(fake);
    fireEvent.click(screen.getByRole("button", { name: "Изменить размер" }));
    const preset = () => within(sizeDialog()).getByRole("combobox", { name: "Размер" });
    expect(
      within(sizeDialog()).getByText(
        "Станция печатает в разрешении своего принтера; это значение — для импорта кода и предпросмотра.",
      ),
    ).toBeTruthy();
    expect(
      within(preset())
        .getAllByRole("option")
        .map((option) => [option.getAttribute("value"), option.textContent]),
    ).toStrictEqual([
      ["58x40", "58 × 40 мм"],
      ["60x40", "60 × 40 мм"],
      ["75x120", "75 × 120 мм"],
      ["100x100", "100 × 100 мм"],
      ["100x150", "100 × 150 мм"],
      ["custom", "Свой размер"],
    ]);
    expect(
      within(within(sizeDialog()).getByRole("combobox", { name: "Разрешение макета" }))
        .getAllByRole("option")
        .map((option) => [option.getAttribute("value"), option.textContent]),
    ).toStrictEqual([
      ["203", "203 dpi"],
      ["300", "300 dpi"],
    ]);
    for (const [key, width, height] of [
      ["75x120", "75", "120"],
      ["60x40", "60", "40"],
      ["100x100", "100", "100"],
      ["58x40", "58", "40"],
    ] as const) {
      fireEvent.change(preset(), { target: { value: key } });
      expect(within(sizeDialog()).getByLabelText("Ширина, мм")).toHaveProperty("value", width);
      expect(within(sizeDialog()).getByLabelText("Высота, мм")).toHaveProperty("value", height);
      expect(preset()).toHaveProperty("value", key);
    }
    type("Ширина, мм", "70");
    type("Высота, мм", "45,5");
    fireEvent.change(preset(), { target: { value: "custom" } });
    expect(within(sizeDialog()).getByLabelText("Ширина, мм")).toHaveProperty("value", "70");
    expect(within(sizeDialog()).getByLabelText("Высота, мм")).toHaveProperty("value", "45,5");
    expect(preset()).toHaveProperty("value", "custom");
    type("Ширина, мм", "58");
    type("Высота, мм", "40");
    expect(preset()).toHaveProperty("value", "58x40");
  });

  it("closes without a change on «Отмена» and forgets what was typed, and marks the draft changed once a size is applied", async () => {
    const fake = session();
    await openNew(fake);
    expect(screen.queryByText("Есть несохранённые изменения.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Изменить размер" }));
    type("Ширина, мм", "70");
    fireEvent.click(within(sizeDialog()).getByRole("button", { name: "Отмена" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("Есть несохранённые изменения.")).toBeNull();
    expect(fake.api.createTemplate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Изменить размер" }));
    expect(within(sizeDialog()).getByLabelText("Ширина, мм")).toHaveProperty("value", "58");
    type("Ширина, мм", "70");
    await applySize();
    expect(screen.getByText("Есть несохранённые изменения.")).toBeTruthy();
    // Applying a size is a change to the draft, not a save.
    expect(fake.api.createTemplate).not.toHaveBeenCalled();
  });

  it("opens beside the page's form without submitting it", async () => {
    const fake = session();
    await openNew(fake);
    type("Название", "Молоко");
    fireEvent.click(screen.getByRole("button", { name: "Изменить размер" }));
    expect(sizeDialog()).toBeTruthy();
    await settle();
    expect(fake.api.createTemplate).not.toHaveBeenCalled();
  });

  it("measures the elements with the sample data of the template's purpose", async () => {
    const fake = session();
    fake.api.createTemplate.mockResolvedValue(
      created("Дубликат", { purpose: "product_duplicate" }),
    );
    await openNew(fake);
    fireEvent.change(screen.getByRole("combobox", { name: "Назначение" }), {
      target: { value: "product_duplicate" },
    });
    const duplicate = buildDuplicateLabelTemplate();
    fireEvent.click(screen.getByRole("button", { name: "Изменить размер" }));
    fireEvent.change(within(sizeDialog()).getByRole("combobox", { name: "Размер" }), {
      target: { value: "100x100" },
    });
    await applySize();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await savedSpec(fake)).toStrictEqual(
      resizedSpec(duplicate, 100, 100, "product_duplicate"),
    );
  });
});

describe("a file saved from the webview", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is clicked while its link is in the page, and its blob URL is revoked after the click", () => {
    const urls = recordBlobUrls();
    const events: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      events.push(`click in page: ${String(this.isConnected)}`);
    });
    const revoke = URL.revokeObjectURL;
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: (url: string) => {
        events.push("revoke");
        revoke(url);
      },
    });
    downloadFile(new Blob(["{}"]), "шаблон.json");
    urls.restore();
    expect(events).toEqual(["click in page: true", "revoke"]);
    expect(document.querySelector("a[download]")).toBeNull();
  });
});
