import { act, fireEvent, screen, waitFor, within, type RenderResult } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildDuplicateLabelTemplate, buildPalletLabelTemplates } from "@markiro/domain";

import { HostError } from "../src/host/client.js";
import type { LabelTemplate, LabelTemplateSummary, ProductGroup } from "../src/host/protocol.js";
import { downloadFile } from "../src/office/templates/download.js";
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
