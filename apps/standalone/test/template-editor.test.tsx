import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
  type RenderResult,
} from "@testing-library/react";
import { createMemoryRouter, Link, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildDuplicateLabelTemplate, buildPalletLabelTemplates } from "@markiro/domain";
import { ThemeProvider } from "@markiro/ui";

import { HostError } from "../src/host/client.js";
import type {
  LabelTemplate,
  LabelTemplateSummary,
  OfficeProduct,
  ProductGroup,
} from "../src/host/protocol.js";
import { createOfficeQueryClient } from "../src/office/office-query.js";
import { OfficeSessionProvider } from "../src/office/office-session.js";
import { downloadFile } from "../src/office/templates/download.js";
import {
  BLANK_SPEC,
  MAX_SPEC_BYTES,
  resizedSpec,
  specBytes,
  startingSpec,
} from "../src/office/templates/editor-model.js";
import { analyzeImport } from "../src/office/templates/import-analysis.js";
import { NewTemplatePage } from "../src/office/templates/TemplateEditorPage.js";
import {
  fakeOfficeSession,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";
import { SESSION } from "./support/fixtures.js";
import { chooseValue, chooseValueOn, optionPairsOn, valueOf, valueOn } from "./support/select.js";

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

/** The layout the import makes of `ZPL` (or of `source`) at `dpi`. */
function importedSpec(source = ZPL, dpi: 203 | 300 = 203) {
  const outcome = analyzeImport({ source, format: "zpl", dpi, purpose: "box" });
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

/** Both roles of the office: each reads and writes templates. */
const ROLES = [
  { role: "administrator", user: SESSION.user },
  { role: "technologist", user: TECHNOLOGIST },
];

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

let restoreBlobUrls: (() => void) | null = null;

// Whatever a test did, the stubbed `URL` methods never outlive it.
afterEach(() => {
  restoreBlobUrls?.();
  restoreBlobUrls = null;
});

const NATIVE_BLOB_URLS = {
  create: URL.createObjectURL,
  revoke: URL.revokeObjectURL,
};

/** Blob URLs recorded instead of made; the `afterEach` above puts the ones that were there back. */
function recordBlobUrls() {
  // Whatever stands here is what the environment has: a stub left by an earlier test is a leak.
  expect(URL.createObjectURL).toBe(NATIVE_BLOB_URLS.create);
  expect(URL.revokeObjectURL).toBe(NATIVE_BLOB_URLS.revoke);
  const blobs: Blob[] = [];
  const revoked: string[] = [];
  const own = {
    create: Object.getOwnPropertyDescriptor(URL, "createObjectURL"),
    revoke: Object.getOwnPropertyDescriptor(URL, "revokeObjectURL"),
  };
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
  restoreBlobUrls = () => {
    for (const [name, descriptor] of [
      ["createObjectURL", own.create],
      ["revokeObjectURL", own.revoke],
    ] as const) {
      if (descriptor === undefined) Reflect.deleteProperty(URL, name);
      else Object.defineProperty(URL, name, descriptor);
    }
  };
  return { blobs, revoked };
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
  chooseValueOn(within(dialog).getByRole("combobox", { name: "Формат кода" }), format);
  if (dpi !== undefined) {
    chooseValueOn(within(dialog).getByRole("combobox", { name: "Разрешение кода" }), String(dpi));
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

  it.each(ROLES)(
    "opens from «Создать шаблон» for the $role as an unnamed, enabled box template for every category with an empty 58×40 label",
    async ({ user }) => {
      await openNew(session(user));
      expect(screen.getByLabelText("Название")).toHaveProperty("value", "");
      expect(valueOf("Назначение")).toBe("box");
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
    },
  );

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
    chooseValue("Назначение", "pallet");
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
    chooseValue("Назначение", "pallet");
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
      "✕Хост не принял макет: он больше 256 КБ. Сократите тексты или импортируйте код поменьше.",
    );
    await save();
    expect(screen.getByRole("alert").textContent).toBe(
      "✕Нет связи с хостом. Проверьте, что ПК-хост включён и служба запущена.",
    );
    expect(saveButton()).toHaveProperty("disabled", false);
    expect(fake.api.createTemplate).toHaveBeenCalledTimes(4);
  });

  it("moves the focus to the name or the categories the host refuses", async () => {
    const fake = session();
    const refusal = (field: string) =>
      new HostError({ kind: "api", code: "validation_failed", message: field, details: { field } });
    fake.api.createTemplate
      .mockRejectedValueOnce(refusal("name"))
      .mockRejectedValueOnce(refusal("chzProductGroupCodes"));
    await openNew(fake);
    type("Название", "Молоко");
    expect(document.activeElement).not.toBe(screen.getByLabelText("Название"));
    await save();
    expect(nameError()).toBe("Хост не принял это значение. Проверьте его.");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Название")));
    await save();
    expect(
      screen.getByText("Хост не принял эти категории: справочник групп мог измениться."),
    ).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("group", { name: "Категории" })),
    );
  });

  it("holds a product duplicate to the duplicate rule and offers the domain's duplicate layout back", async () => {
    const fake = session();
    await openNew(fake);
    chooseValue("Назначение", "product_duplicate");
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

  it("sends nothing for a product duplicate that breaks the duplicate rule, even when the form is submitted without its button", async () => {
    const fake = session();
    await openNew(fake);
    chooseValue("Назначение", "product_duplicate");
    type("Название", "Дубликат");
    await importCode(ZPL);
    expect(saveButton()).toHaveProperty("disabled", true);
    const form = screen.getByLabelText("Название").closest("form");
    expect(form).not.toBeNull();
    await act(async () => {
      form?.requestSubmit();
    });
    await settle();
    expect(fake.api.createTemplate).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Дубликату нужен один Data Matrix");
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
    chooseValueOn(purpose(), "product_duplicate");
    expect(elements(buildDuplicateLabelTemplate().elements.length)).toBeTruthy();
    chooseValueOn(purpose(), "pallet");
    expect(elements(buildPalletLabelTemplates()[0]?.spec.elements.length ?? -1)).toBeTruthy();
    chooseValueOn(purpose(), "box");
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
    const card = screen.getByRole("group", { name: "Категории" });
    expect(card.getAttribute("tabindex")).toBe("-1");
    expect(card.id.endsWith("-scope")).toBe(true);
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
    chooseValue("Назначение", "pallet");
    fireEvent.click(screen.getByRole("button", { name: "Скачать JSON" }));
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
    expect(valueOn(within(dialog).getByRole("combobox", { name: "Формат кода" }))).toBe("tspl");
    expect(valueOn(within(dialog).getByRole("combobox", { name: "Разрешение кода" }))).toBe("300");
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
    expect(valueOn(within(dialog).getByRole("combobox", { name: "Размер" }))).toBe("58x40");
    expect(within(dialog).getByLabelText("Ширина, мм")).toHaveProperty("value", "58");
    expect(within(dialog).getByLabelText("Высота, мм")).toHaveProperty("value", "40");
    expect(valueOn(within(dialog).getByRole("combobox", { name: "Разрешение макета" }))).toBe(
      "203",
    );
    chooseValueOn(within(dialog).getByRole("combobox", { name: "Размер" }), "100x150");
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
    expect(valueOn(within(sizeDialog()).getByRole("combobox", { name: "Размер" }))).toBe("custom");
    chooseValueOn(within(sizeDialog()).getByRole("combobox", { name: "Разрешение макета" }), "300");
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
    expect(
      within(within(sizeDialog()).getByRole("alert")).getByText(
        "Элемент макета больше этой этикетки. Увеличьте размер или импортируйте код заново.",
      ),
    ).toBeTruthy();
    chooseValueOn(within(sizeDialog()).getByRole("combobox", { name: "Размер" }), "58x40");
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

  /** 57.9967 × 39.96 mm at 300 dpi: the field shows «58», which is not 58 mm. */
  const ZPL_300_DPI = [
    "^XA",
    "^PW685",
    "^LL472",
    "^FO40,40^A0N,34,34^FDПартия^FS",
    "^FO40,100^A0N,34,34^FD{{qty}}^FS",
    "^XZ",
  ].join("\n");

  it("sends exactly the preset's size when a stored width only shows as the preset's text", async () => {
    const fake = session();
    fake.api.createTemplate.mockResolvedValue(created("Молоко"));
    await openNew(fake);
    await importCode(ZPL_300_DPI, "zpl", 300);
    const imported = importedSpec(ZPL_300_DPI, 300);
    expect(imported.widthMm).not.toBe(58);
    fireEvent.click(screen.getByRole("button", { name: "Изменить размер" }));
    const preset = () => within(sizeDialog()).getByRole("combobox", { name: "Размер" });
    expect(within(sizeDialog()).getByLabelText("Ширина, мм")).toHaveProperty("value", "58");
    expect(valueOn(preset())).toBe("custom");
    chooseValueOn(preset(), "58x40");
    expect(valueOn(preset())).toBe("58x40");
    await applySize();
    expect(screen.getByText("Размер: 58 × 40 мм · 300 dpi")).toBeTruthy();
    expect(await savedSpec(fake)).toStrictEqual({ ...imported, widthMm: 58, heightMm: 40 });
  });

  it("keeps the exact width of an axis the user never touched while the other axis is typed over", async () => {
    const fake = session();
    fake.api.createTemplate.mockResolvedValue(created("Молоко"));
    await openNew(fake);
    await importCode(ZPL_300_DPI, "zpl", 300);
    const imported = importedSpec(ZPL_300_DPI, 300);
    fireEvent.click(screen.getByRole("button", { name: "Изменить размер" }));
    type("Высота, мм", "40");
    expect(valueOn(within(sizeDialog()).getByRole("combobox", { name: "Размер" }))).toBe("custom");
    await applySize();
    expect(await savedSpec(fake)).toStrictEqual({ ...imported, heightMm: 40 });
  });

  it("takes the text of a field the user changed as its value, even when it is typed back to the text shown", async () => {
    const fake = session();
    fake.api.createTemplate.mockResolvedValue(created("Молоко"));
    await openNew(fake);
    await importCode(ZPL_300_DPI, "zpl", 300);
    fireEvent.click(screen.getByRole("button", { name: "Изменить размер" }));
    type("Ширина, мм", "57");
    type("Ширина, мм", "58");
    type("Высота, мм", "40");
    expect(valueOn(within(sizeDialog()).getByRole("combobox", { name: "Размер" }))).toBe("58x40");
    await applySize();
    expect(await savedSpec(fake)).toStrictEqual({
      ...importedSpec(ZPL_300_DPI, 300),
      widthMm: 58,
      heightMm: 40,
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
    expect(valueOn(within(sizeDialog()).getByRole("combobox", { name: "Размер" }))).toBe("custom");
    type("Высота, мм", "40");
    expect(sizeFieldError("Высота, мм")).toBeUndefined();
    type("Ширина, мм", "301");
    type("Высота, мм", "0");
    await applySize();
    expect(within(sizeDialog()).getAllByText("Размер — от 10 до 300 мм")).toHaveLength(2);
    type("Высота, мм", "40");
    expect(sizeFieldError("Высота, мм")).toBeUndefined();
    expect(sizeFieldError("Ширина, мм")).toBe("Размер — от 10 до 300 мм");
    chooseValueOn(within(sizeDialog()).getByRole("combobox", { name: "Размер" }), "60x40");
    expect(sizeFieldError("Ширина, мм")).toBeUndefined();
    type("Ширина, мм", "9");
    type("Высота, мм", "9");
    await applySize();
    expect(within(sizeDialog()).getAllByText("Размер — от 10 до 300 мм")).toHaveLength(2);
    chooseValueOn(within(sizeDialog()).getByRole("combobox", { name: "Размер" }), "100x100");
    expect(within(sizeDialog()).queryByText("Размер — от 10 до 300 мм")).toBeNull();
    expect(within(sizeDialog()).getByLabelText("Ширина, мм")).toHaveProperty("value", "100");
  });

  it("clears the too-large message as either field is typed in, and keeps the layout and the resolution when an element does not fit", async () => {
    const fake = session();
    fake.api.createTemplate.mockResolvedValue(created("Молоко"));
    await openNew(fake);
    await importCode(WIDE_ZPL);
    fireEvent.click(screen.getByRole("button", { name: "Изменить размер" }));
    chooseValueOn(within(sizeDialog()).getByRole("combobox", { name: "Разрешение макета" }), "300");
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
    expect(valueOn(within(sizeDialog()).getByRole("combobox", { name: "Размер" }))).toBe("custom");
    chooseValueOn(within(sizeDialog()).getByRole("combobox", { name: "Разрешение макета" }), "300");
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
    expect(valueOn(within(sizeDialog()).getByRole("combobox", { name: "Разрешение макета" }))).toBe(
      "300",
    );
    chooseValueOn(within(sizeDialog()).getByRole("combobox", { name: "Размер" }), "100x150");
    chooseValueOn(within(sizeDialog()).getByRole("combobox", { name: "Разрешение макета" }), "203");
    await applySize();
    fireEvent.click(screen.getByRole("button", { name: "Изменить размер" }));
    expect(valueOn(within(sizeDialog()).getByRole("combobox", { name: "Размер" }))).toBe("100x150");
    expect(within(sizeDialog()).getByLabelText("Ширина, мм")).toHaveProperty("value", "100");
    expect(within(sizeDialog()).getByLabelText("Высота, мм")).toHaveProperty("value", "150");
    expect(valueOn(within(sizeDialog()).getByRole("combobox", { name: "Разрешение макета" }))).toBe(
      "203",
    );
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
    expect(optionPairsOn(preset())).toStrictEqual([
      ["58x40", "58 × 40 мм"],
      ["60x40", "60 × 40 мм"],
      ["75x120", "75 × 120 мм"],
      ["100x100", "100 × 100 мм"],
      ["100x150", "100 × 150 мм"],
      ["custom", "Свой размер"],
    ]);
    expect(
      optionPairsOn(within(sizeDialog()).getByRole("combobox", { name: "Разрешение макета" })),
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
      chooseValueOn(preset(), key);
      expect(within(sizeDialog()).getByLabelText("Ширина, мм")).toHaveProperty("value", width);
      expect(within(sizeDialog()).getByLabelText("Высота, мм")).toHaveProperty("value", height);
      expect(valueOn(preset())).toBe(key);
    }
    type("Ширина, мм", "70");
    type("Высота, мм", "45,5");
    chooseValueOn(preset(), "custom");
    expect(within(sizeDialog()).getByLabelText("Ширина, мм")).toHaveProperty("value", "70");
    expect(within(sizeDialog()).getByLabelText("Высота, мм")).toHaveProperty("value", "45,5");
    expect(valueOn(preset())).toBe("custom");
    type("Ширина, мм", "58");
    type("Высота, мм", "40");
    expect(valueOn(preset())).toBe("58x40");
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
    chooseValue("Назначение", "product_duplicate");
    const duplicate = buildDuplicateLabelTemplate();
    fireEvent.click(screen.getByRole("button", { name: "Изменить размер" }));
    chooseValueOn(within(sizeDialog()).getByRole("combobox", { name: "Размер" }), "100x100");
    await applySize();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await savedSpec(fake)).toStrictEqual(
      resizedSpec(duplicate, 100, 100, "product_duplicate"),
    );
  });
});

const MILK_ID = "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d";

/** «Молоко 58×40» in the list: a template of the site's own, for milk. */
const MILK_ROW: LabelTemplateSummary = {
  ...BOX_58,
  id: MILK_ID,
  name: "Молоко 58×40",
  stock: false,
  chzProductGroupCodes: [8],
  widthMm: 58.06,
  heightMm: 40.04,
  rev: 61,
};

/** A product the host lists: the one a template's deletion may change. */
const PRODUCT: OfficeProduct = {
  id: "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b",
  gtin14: "04600682000013",
  name: "Молоко 3,2% 0,9 л",
  printName: "Молоко 3,2%",
  chzProductGroupCode: 8,
  boxCapacity: 12,
  palletBoxCapacity: 40,
  shelfLifeDays: 10,
  defaultBoxTemplateId: MILK_ID,
  defaultPalletTemplateId: null,
  archived: false,
  status: "active",
  rev: 65,
};

/** «Молоко 58×40» as `GET /v1/office/templates/{id}` answers. */
function milk(data: Partial<LabelTemplate> = {}): LabelTemplate {
  return {
    id: MILK_ID,
    name: "Молоко 58×40",
    purpose: "box",
    enabled: true,
    chzProductGroupCodes: [8],
    stock: false,
    spec: importedSpec(),
    rev: 61,
    ...data,
  };
}

function editSession(user = TECHNOLOGIST) {
  const fake = session(user);
  fake.api.listTemplates.mockResolvedValue([BOX_58, MILK_ROW]);
  fake.api.getTemplate.mockResolvedValue(milk());
  return fake;
}

async function openEdit(fake: FakeOfficeSession, name = "Молоко 58×40"): Promise<void> {
  await openTemplates(fake);
  fireEvent.click(screen.getByRole("button", { name: `Изменить шаблон «${name}»` }));
  await screen.findByRole("heading", { name: `Шаблон «${name}»` });
  await settle();
}

/**
 * A layout of exactly `bytes` bytes of compact JSON: one text element, its
 * text made of `filler` (a character of two bytes leaves an odd byte to «x»).
 */
function layoutOfBytes(bytes: number, filler = "x") {
  const withText = (text: string) => ({
    ...BLANK_SPEC,
    elements: [{ kind: "text" as const, id: "t", xMm: 1, yMm: 1, fontSizePt: 10, text }],
  });
  const rest = bytes - specBytes(withText(""));
  const width = new TextEncoder().encode(filler).length;
  return withText(filler.repeat(Math.floor(rest / width)) + "x".repeat(rest % width));
}

function hostError(code: string, details: Record<string, unknown> = {}): HostError {
  return new HostError({ kind: "api", code, message: code, details });
}

describe("changing a label template", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  it.each(ROLES)(
    "opens the template as the host has it for the $role, with its purpose fixed and «Сохранить» off until something changes",
    async ({ user }) => {
      const fake = editSession(user);
      await openTemplates(fake);
      expect(screen.queryByRole("button", { name: "Изменить шаблон «Коробка 58×40»" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Изменить шаблон «Молоко 58×40»" }));
      await screen.findByRole("heading", { name: "Шаблон «Молоко 58×40»" });
      expect(fake.api.getTemplate).toHaveBeenCalledWith("office-session-token", MILK_ID);
      expect(screen.getByLabelText("Название")).toHaveProperty("value", "Молоко 58×40");
      const purpose = screen.getByRole("combobox", { name: "Назначение" });
      expect(purpose).toHaveProperty("disabled", true);
      expect(screen.getByText("Назначение не меняется после создания.")).toBeTruthy();
      expect(
        screen.getByRole("radio", { name: "Только выбранные" }).getAttribute("aria-checked"),
      ).toBe("true");
      expect(
        (await screen.findByRole("checkbox", { name: "Молочная продукция" })).getAttribute(
          "aria-checked",
        ),
      ).toBe("true");
      expect(screen.getByText("Размер: 58,06 × 40,04 мм · 203 dpi")).toBeTruthy();
      expect(screen.getByText("Элементов в макете: 2")).toBeTruthy();
      expect(saveButton()).toHaveProperty("disabled", true);
      type("Название", "Молоко 60×40");
      expect(saveButton()).toHaveProperty("disabled", false);
      type("Название", "Молоко 58×40");
      expect(saveButton()).toHaveProperty("disabled", true);
    },
  );

  it("sends what changed and the layout with the opened revision, then lists the templates again with a notice", async () => {
    const fake = editSession();
    fake.api.updateTemplate.mockResolvedValue(
      milk({ name: "Молоко 60×40", enabled: false, rev: 62 }),
    );
    await openEdit(fake);
    type("Название", " Молоко 60×40 ");
    fireEvent.click(screen.getByRole("checkbox", { name: "Включён" }));
    await save();
    expect(fake.api.updateTemplate).toHaveBeenCalledTimes(1);
    expect(fake.api.updateTemplate.mock.calls[0]?.slice(1)).toStrictEqual([
      MILK_ID,
      { expectedRev: 61, name: "Молоко 60×40", enabled: false, spec: importedSpec() },
    ]);
    await screen.findByRole("heading", { name: "Шаблоны этикеток" });
    expect(screen.getByText("Шаблон «Молоко 60×40» сохранён.")).toBeTruthy();
    await waitFor(() => expect(fake.api.listTemplates).toHaveBeenCalledTimes(2));
  });

  it("offers to load the template again after a stale save, which drops the edits and sends the new revision", async () => {
    const fake = editSession();
    fake.api.updateTemplate
      .mockRejectedValueOnce(hostError("stale_revision", { currentRev: 64 }))
      .mockResolvedValueOnce(milk({ name: "Молоко 70×40", rev: 65 }));
    await openEdit(fake);
    type("Название", "Молоко 60×40");
    await save();
    const stale = screen.getByRole("alert");
    expect(stale.textContent).toContain("Данные изменились");
    fake.api.getTemplate.mockResolvedValue(milk({ name: "Молоко (со склада)", rev: 64 }));
    fireEvent.click(within(stale).getByRole("button", { name: "Загрузить заново" }));
    await screen.findByRole("heading", { name: "Шаблон «Молоко (со склада)»" });
    expect(screen.getByLabelText("Название")).toHaveProperty("value", "Молоко (со склада)");
    expect(screen.queryByRole("alert")).toBeNull();
    type("Название", "Молоко 70×40");
    await save();
    expect(fake.api.updateTemplate.mock.calls[1]?.[2]).toMatchObject({ expectedRev: 64 });
  });

  it("says whose default a template is when switching it off is refused", async () => {
    const fake = editSession();
    fake.api.updateTemplate.mockRejectedValue(
      hostError("conflict", {
        constraint: "template_is_default",
        organizationDefault: false,
        categoryDefaults: [8],
      }),
    );
    await openEdit(fake);
    fireEvent.click(screen.getByRole("checkbox", { name: "Включён" }));
    await save();
    expect(screen.getByRole("alert").textContent).toBe(
      "✕Шаблон выбран по умолчанию для категорий: Молочная продукция. Сначала выберите другой шаблон на странице «Умолчания шаблонов».",
    );
  });

  it("says the template is gone when it was deleted elsewhere, and the list is read again", async () => {
    const fake = editSession();
    fake.api.updateTemplate.mockRejectedValue(hostError("not_found"));
    await openEdit(fake);
    type("Название", "Молоко 60×40");
    await save();
    expect(screen.getByRole("alert").textContent).toBe(
      "✕Шаблона больше нет на хосте: его удалили на другом рабочем месте.",
    );
    fireEvent.click(screen.getByRole("button", { name: "К шаблонам" }));
    // The edits are still unsaved, so leaving asks first.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Уйти без сохранения" }));
    });
    await screen.findByRole("heading", { name: "Шаблоны этикеток" });
    await waitFor(() => expect(fake.api.listTemplates).toHaveBeenCalledTimes(2));
  });

  it("reads the template again on every opening and shows the editor only with what this visit read", async () => {
    const fake = editSession();
    await openEdit(fake);
    fireEvent.click(screen.getByRole("button", { name: "К шаблонам" }));
    await screen.findByRole("heading", { name: "Шаблоны этикеток" });
    let answer: (template: LabelTemplate) => void = () => undefined;
    fake.api.getTemplate.mockReturnValue(
      new Promise<LabelTemplate>((resolve) => {
        answer = resolve;
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Изменить шаблон «Молоко 58×40»" }));
    await screen.findByText("Загрузка…");
    expect(screen.queryByLabelText("Название")).toBeNull();
    await act(async () => {
      answer(milk({ name: "Молоко 2", rev: 63 }));
    });
    expect(await screen.findByLabelText("Название")).toHaveProperty("value", "Молоко 2");
    expect(fake.api.getTemplate).toHaveBeenCalledTimes(2);
  });

  it("explains a template it cannot open: deleted, unreachable, stock or with a layout this version cannot read", async () => {
    const opening = async (fake: FakeOfficeSession, text: string) => {
      const view = await openTemplates(fake);
      fireEvent.click(screen.getByRole("button", { name: "Изменить шаблон «Молоко 58×40»" }));
      expect((await screen.findByRole("alert")).textContent).toBe(text);
      return view;
    };
    const gone = editSession();
    gone.api.getTemplate.mockRejectedValue(hostError("not_found"));
    let view = await opening(gone, "⧉Шаблона нет на хосте: его удалили на другом рабочем месте.");
    fireEvent.click(screen.getByRole("button", { name: "К шаблонам" }));
    await screen.findByRole("heading", { name: "Шаблоны этикеток" });
    view.unmount();

    const stock = editSession();
    stock.api.getTemplate.mockResolvedValue(milk({ stock: true }));
    view = await opening(
      stock,
      "⧉Типовой шаблон не переименовывается и не меняет макет. Включить, выключить и сузить его можно на странице «Шаблоны», а изменить — в копии.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Копировать" }));
    await screen.findByRole("heading", { name: "Копия шаблона «Молоко 58×40»" });
    view.unmount();

    const unreadable = editSession();
    unreadable.api.getTemplate.mockResolvedValue(milk({ spec: { widthMm: 58 } }));
    view = await opening(
      unreadable,
      "⧉Макет этого шаблона не читается этой версией приложения. Обновите приложение на этом ПК.",
    );
    view.unmount();

    const down = editSession();
    down.api.getTemplate
      .mockRejectedValueOnce(
        new HostError({ kind: "transport", code: "unreachable", message: "down" }),
      )
      .mockResolvedValueOnce(milk());
    await opening(
      down,
      "✕Нет связи с хостом. Проверьте, что ПК-хост включён и служба запущена.Повторить",
    );
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByLabelText("Название")).toHaveProperty("value", "Молоко 58×40");
  });

  it.each<{
    case: string;
    arrange: (api: FakeOfficeSession["api"]) => void;
    back: boolean;
  }>([
    {
      case: "deleted",
      arrange: (api) => api.getTemplate.mockRejectedValue(hostError("not_found")),
      back: true,
    },
    {
      case: "stock",
      arrange: (api) => api.getTemplate.mockResolvedValue(milk({ stock: true })),
      back: true,
    },
    {
      case: "unreadable",
      arrange: (api) => api.getTemplate.mockResolvedValue(milk({ spec: { widthMm: 58 } })),
      back: true,
    },
    {
      case: "unreachable",
      arrange: (api) =>
        api.getTemplate.mockRejectedValue(
          new HostError({ kind: "transport", code: "unreachable", message: "down" }),
        ),
      back: false,
    },
  ])(
    "keeps the page's heading, and the way back where there is one, on the page of a $case template",
    async ({ arrange, back }) => {
      const fake = editSession();
      arrange(fake.api);
      await openTemplates(fake);
      fireEvent.click(screen.getByRole("button", { name: "Изменить шаблон «Молоко 58×40»" }));
      await screen.findByRole("alert");
      expect(screen.getByRole("heading", { name: "Шаблон" })).toBeTruthy();
      expect(screen.queryByLabelText("Название")).toBeNull();
      expect(screen.queryByRole("button", { name: "К шаблонам" }) !== null).toBe(back);
    },
  );

  it("opens a disabled template for all categories with another purpose as the host has it, and sends only the flag that changed", async () => {
    const fake = editSession();
    fake.api.getTemplate.mockResolvedValue(
      milk({ purpose: "pallet", enabled: false, chzProductGroupCodes: null }),
    );
    fake.api.updateTemplate.mockResolvedValue(milk({ purpose: "pallet", rev: 62 }));
    await openEdit(fake);
    const purpose = screen.getByRole("combobox", { name: "Назначение" });
    expect(valueOn(purpose)).toBe("pallet");
    expect(purpose).toHaveProperty("disabled", true);
    expect(screen.getByRole("checkbox", { name: "Включён" }).getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(screen.getByRole("radio", { name: "Все категории" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(saveButton()).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Включён" }));
    expect(saveButton()).toHaveProperty("disabled", false);
    await save();
    expect(fake.api.updateTemplate.mock.calls[0]?.slice(1)).toStrictEqual([
      MILK_ID,
      { expectedRev: 61, enabled: true, spec: importedSpec() },
    ]);
  });

  it("sends the categories and the resized layout that were changed, not the ones that were read, and the list is not shown from before the save", async () => {
    const fake = editSession();
    fake.api.updateTemplate.mockResolvedValue(milk({ rev: 62 }));
    await openEdit(fake);
    expect(saveButton()).toHaveProperty("disabled", true);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Упакованная вода" }));
    expect(saveButton()).toHaveProperty("disabled", false);
    fireEvent.click(screen.getByRole("button", { name: "Изменить размер" }));
    chooseValueOn(within(sizeDialog()).getByRole("combobox", { name: "Размер" }), "100x150");
    await applySize();
    let answer: (rows: LabelTemplateSummary[]) => void = () => undefined;
    fake.api.listTemplates.mockReturnValueOnce(
      new Promise<LabelTemplateSummary[]>((resolve) => {
        answer = resolve;
      }),
    );
    await save();
    expect(fake.api.updateTemplate.mock.calls[0]?.slice(1)).toStrictEqual([
      MILK_ID,
      {
        expectedRev: 61,
        chzProductGroupCodes: [8, 13],
        spec: resizedSpec(importedSpec(), 100, 150, "box"),
      },
    ]);
    // The list from before the save is dropped, so no row of it is shown while the list is read.
    await screen.findByText("Загрузка…");
    expect(screen.queryByText("Молоко 58×40")).toBeNull();
    await act(async () => {
      answer([BOX_58, { ...MILK_ROW, chzProductGroupCodes: [8, 13], widthMm: 100, heightMm: 150 }]);
    });
    expect(await screen.findByText("100 × 150 мм")).toBeTruthy();
    expect(screen.getByText("Шаблон «Молоко 58×40» сохранён.")).toBeTruthy();
  });

  describe("a layout the host would refuse for its size", () => {
    const TOO_LARGE =
      "Макет больше 256 КБ: хост его не примет. Сократите тексты или импортируйте код поменьше.";

    it.each([
      ["one byte over 256 KB", layoutOfBytes(MAX_SPEC_BYTES + 1)],
      [
        "Cyrillic, under 256 K characters but one byte over 256 KB",
        layoutOfBytes(MAX_SPEC_BYTES + 1, "я"),
      ],
      ["Cyrillic, well over 256 KB", layoutOfBytes(MAX_SPEC_BYTES * 2, "я")],
    ])("is explained with a remedy before a change is sent: %s", async (_name, spec) => {
      const fake = editSession();
      fake.api.getTemplate.mockResolvedValue(milk({ spec }));
      await openEdit(fake);
      type("Название", "Молоко 60×40");
      await save();
      await settle();
      expect(screen.getByRole("alert").textContent).toContain(TOO_LARGE);
      expect(fake.api.updateTemplate).not.toHaveBeenCalled();
      expect(saveButton()).toHaveProperty("disabled", false);
    });

    it.each([
      ["exactly 256 KB", layoutOfBytes(MAX_SPEC_BYTES)],
      ["Cyrillic, exactly 256 KB", layoutOfBytes(MAX_SPEC_BYTES, "я")],
    ])("is sent as it is: %s", async (_name, spec) => {
      const fake = editSession();
      fake.api.getTemplate.mockResolvedValue(milk({ spec }));
      fake.api.updateTemplate.mockResolvedValue(milk({ spec, name: "Молоко 60×40", rev: 62 }));
      await openEdit(fake);
      type("Название", "Молоко 60×40");
      await save();
      expect(fake.api.updateTemplate).toHaveBeenCalledTimes(1);
      expect(specBytes(fake.api.updateTemplate.mock.calls[0]?.[2].spec ?? {})).toBe(MAX_SPEC_BYTES);
      await screen.findByRole("heading", { name: "Шаблоны этикеток" });
    });

    it("is explained when a copy of it is created, and nothing is sent", async () => {
      const fake = editSession();
      fake.api.getTemplate.mockResolvedValue(milk({ spec: layoutOfBytes(MAX_SPEC_BYTES + 1) }));
      await openEdit(fake);
      fireEvent.click(screen.getByRole("button", { name: "Копировать" }));
      await screen.findByRole("heading", { name: "Копия шаблона «Молоко 58×40»" });
      await settle();
      await save();
      await settle();
      expect(screen.getByRole("alert").textContent).toContain(TOO_LARGE);
      expect(fake.api.createTemplate).not.toHaveBeenCalled();
    });
  });

  it("sends the opened revision again, never the current one the host reported, when the same page saves once more after a stale save", async () => {
    const fake = editSession();
    fake.api.updateTemplate
      .mockRejectedValueOnce(hostError("stale_revision", { currentRev: 64 }))
      .mockRejectedValueOnce(hostError("stale_revision", { currentRev: 66 }));
    await openEdit(fake);
    type("Название", "Молоко 60×40");
    await save();
    await save();
    expect(fake.api.updateTemplate.mock.calls.map((call) => call[2])).toMatchObject([
      { expectedRev: 61 },
      { expectedRev: 61 },
    ]);
    expect(fake.api.getTemplate).toHaveBeenCalledTimes(1);
  });

  it("shows why a template cannot be read again after a stale save and starts afresh with the one a retry reads", async () => {
    const fake = editSession();
    fake.api.updateTemplate
      .mockRejectedValueOnce(hostError("stale_revision", { currentRev: 64 }))
      .mockResolvedValueOnce(milk({ rev: 65 }));
    await openEdit(fake);
    type("Название", "Молоко 60×40");
    await save();
    fake.api.getTemplate
      .mockRejectedValueOnce(
        new HostError({ kind: "transport", code: "unreachable", message: "x" }),
      )
      .mockResolvedValueOnce(milk({ name: "Молоко (со склада)", rev: 64 }));
    fireEvent.click(
      within(screen.getByRole("alert")).getByRole("button", { name: "Загрузить заново" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Нет связи с хостом"),
    );
    expect(screen.queryByLabelText("Название")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByLabelText("Название")).toHaveProperty("value", "Молоко (со склада)");
    await settle();
    type("Название", "Молоко 70×40");
    await save();
    expect(fake.api.updateTemplate.mock.calls[1]?.[2]).toMatchObject({ expectedRev: 64 });
  });

  it("shows «Загрузка…», not the earlier failure, while a template is read again on reopening", async () => {
    const fake = editSession();
    fake.api.updateTemplate.mockRejectedValueOnce(hostError("stale_revision", { currentRev: 64 }));
    await openEdit(fake);
    type("Название", "Молоко 60×40");
    await save();
    fake.api.getTemplate.mockRejectedValueOnce(
      new HostError({ kind: "transport", code: "unreachable", message: "down" }),
    );
    fireEvent.click(
      within(screen.getByRole("alert")).getByRole("button", { name: "Загрузить заново" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Нет связи с хостом"),
    );
    // The failed read stays in the cache with the template's old data.
    fireEvent.click(screen.getByRole("link", { name: "Шаблоны" }));
    await screen.findByRole("heading", { name: "Шаблоны этикеток" });
    await waitFor(() => expect(screen.queryByText("Загрузка…")).toBeNull());
    let answer: (template: LabelTemplate) => void = () => undefined;
    fake.api.getTemplate.mockReturnValueOnce(
      new Promise<LabelTemplate>((resolve) => {
        answer = resolve;
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Изменить шаблон «Молоко 58×40»" }));
    await screen.findByText("Загрузка…");
    expect(screen.queryByText(/Нет связи с хостом/)).toBeNull();
    expect(screen.queryByLabelText("Название")).toBeNull();
    await act(async () => {
      answer(milk({ name: "Молоко (со склада)", rev: 64 }));
    });
    expect(await screen.findByLabelText("Название")).toHaveProperty("value", "Молоко (со склада)");
  });

  it("marks «Шаблоны» in the menu on the editor's pages, never «Умолчания шаблонов» or «Обзор»", async () => {
    const fake = editSession();
    await openTemplates(fake);
    const current = () =>
      ["Обзор", "Шаблоны", "Умолчания шаблонов"].filter(
        (name) => screen.getByRole("link", { name }).getAttribute("aria-current") === "page",
      );
    expect(current()).toEqual(["Шаблоны"]);
    fireEvent.click(screen.getByRole("button", { name: "Создать шаблон" }));
    await screen.findByRole("heading", { name: "Новый шаблон" });
    expect(current()).toEqual(["Шаблоны"]);
    fireEvent.click(screen.getByRole("button", { name: "К шаблонам" }));
    await screen.findByRole("heading", { name: "Шаблоны этикеток" });
    await waitFor(() => expect(screen.queryByText("Загрузка…")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Изменить шаблон «Молоко 58×40»" }));
    await screen.findByRole("heading", { name: "Шаблон «Молоко 58×40»" });
    expect(current()).toEqual(["Шаблоны"]);
    fireEvent.click(screen.getByRole("button", { name: "Копировать" }));
    await screen.findByRole("heading", { name: "Копия шаблона «Молоко 58×40»" });
    expect(current()).toEqual(["Шаблоны"]);
    fireEvent.click(screen.getByRole("link", { name: "Умолчания шаблонов" }));
    await screen.findByRole("heading", { name: "Умолчания шаблонов" });
    expect(current()).toEqual(["Умолчания шаблонов"]);
    fireEvent.click(screen.getByRole("link", { name: "Обзор" }));
    await waitFor(() => expect(current()).toEqual(["Обзор"]));
  });

  it("reads each template under its own key, so a read still on its way for one is never taken for another", async () => {
    const WATER_ID = "b4c5d6e7-f8a9-4b0c-9d1e-2f3a4b5c6d7e";
    const fake = editSession();
    fake.api.listTemplates.mockResolvedValue([
      BOX_58,
      MILK_ROW,
      { ...MILK_ROW, id: WATER_ID, name: "Вода 58×40", chzProductGroupCodes: [13] },
    ]);
    fake.api.getTemplate.mockImplementation((_token: string, id: string) =>
      id === MILK_ID
        ? new Promise<LabelTemplate>(() => undefined)
        : Promise.resolve(milk({ id: WATER_ID, name: "Вода 58×40", chzProductGroupCodes: [13] })),
    );
    await openTemplates(fake);
    fireEvent.click(screen.getByRole("button", { name: "Изменить шаблон «Молоко 58×40»" }));
    await screen.findByText("Загрузка…");
    fireEvent.click(screen.getByRole("link", { name: "Шаблоны" }));
    await screen.findByRole("heading", { name: "Шаблоны этикеток" });
    await waitFor(() => expect(screen.queryByText("Загрузка…")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Изменить шаблон «Вода 58×40»" }));
    expect(await screen.findByRole("heading", { name: "Шаблон «Вода 58×40»" })).toBeTruthy();
    expect(fake.api.getTemplate.mock.calls.map((call) => call[1])).toEqual([MILK_ID, WATER_ID]);
  });

  it("shows a name with markup as text on the list, in the edit heading and in the notice", async () => {
    const name = "<i>Молоко</i> &amp; <img src=x onerror=alert(1)>";
    const fake = editSession();
    fake.api.listTemplates.mockResolvedValue([BOX_58, { ...MILK_ROW, name }]);
    fake.api.getTemplate.mockResolvedValue(milk({ name }));
    fake.api.updateTemplate.mockResolvedValue(milk({ name, enabled: false, rev: 62 }));
    await openEdit(fake, name);
    expect(screen.getByLabelText("Название")).toHaveProperty("value", name);
    fireEvent.click(screen.getByRole("checkbox", { name: "Включён" }));
    await save();
    expect(await screen.findByText(`Шаблон «${name}» сохранён.`)).toBeTruthy();
    expect(document.querySelector("img, i, b, script")).toBeNull();
  });
});

/** «Коробка 58×40» as the host has it: the stock box template. */
function stockBox(): LabelTemplate {
  return {
    id: BOX_58.id,
    name: "Коробка 58×40",
    purpose: "box",
    enabled: true,
    chzProductGroupCodes: null,
    stock: true,
    spec: importedSpec(),
    rev: 60,
  };
}

function deleteDialog(): HTMLElement {
  return screen.getByRole("dialog", { name: "Удалить шаблон?" });
}

describe("copying and deleting a label template", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  it("copies a stock template from its row: a new template under «— копия» with the source's purpose, flag, categories and layout", async () => {
    const fake = editSession();
    fake.api.getTemplate.mockResolvedValue({
      ...stockBox(),
      chzProductGroupCodes: [13],
      enabled: false,
    });
    fake.api.createTemplate.mockResolvedValue(created("Коробка 58×40 — копия"));
    await openTemplates(fake);
    fireEvent.click(screen.getByRole("button", { name: "Копировать шаблон «Коробка 58×40»" }));
    await screen.findByRole("heading", { name: "Копия шаблона «Коробка 58×40»" });
    expect(fake.api.getTemplate).toHaveBeenCalledWith("office-session-token", BOX_58.id);
    expect(screen.getByLabelText("Название")).toHaveProperty("value", "Коробка 58×40 — копия");
    expect(screen.getByRole("combobox", { name: "Назначение" })).toHaveProperty("disabled", false);
    expect(screen.queryByRole("button", { name: "Удалить" })).toBeNull();
    await save();
    expect(fake.api.createTemplate.mock.calls[0]?.[1]).toStrictEqual({
      name: "Коробка 58×40 — копия",
      purpose: "box",
      enabled: false,
      chzProductGroupCodes: [13],
      spec: importedSpec(),
    });
    expect(await screen.findByText("Шаблон «Коробка 58×40 — копия» создан.")).toBeTruthy();
  });

  it("copies a template from its editor and keeps the layout when the copy's purpose changes", async () => {
    const fake = editSession();
    // An empty 58×40 box, a new box template's starting layout, which a copy keeps all the same.
    fake.api.getTemplate.mockResolvedValue(milk({ spec: startingSpec("box") }));
    fake.api.createTemplate.mockResolvedValue(created("Молоко 58×40 — копия"));
    await openEdit(fake);
    fireEvent.click(screen.getByRole("button", { name: "Копировать" }));
    await screen.findByRole("heading", { name: "Копия шаблона «Молоко 58×40»" });
    await settle();
    expect(fake.api.getTemplate).toHaveBeenCalledTimes(2);
    chooseValue("Назначение", "pallet");
    expect(screen.getByText("Размер: 58 × 40 мм · 203 dpi")).toBeTruthy();
    await save();
    expect(fake.api.createTemplate.mock.calls[0]?.[1]).toMatchObject({
      purpose: "pallet",
      spec: startingSpec("box"),
    });
  });

  it("deletes a template after a destructive confirmation and lists the templates again with a notice", async () => {
    const fake = editSession();
    fake.api.deleteTemplate.mockResolvedValue(undefined);
    await openEdit(fake);
    fireEvent.click(screen.getByRole("button", { name: "Удалить" }));
    expect(
      within(deleteDialog()).getByText(
        "Шаблон «Молоко 58×40» будет удалён: станции его больше не получат, а товары, у которых он выбран, останутся без этого шаблона. Отменить удаление нельзя.",
      ),
    ).toBeTruthy();
    const submit = within(deleteDialog()).getByRole("button", { name: "Удалить" });
    expect(submit.classList.contains("mk-btn--destructive")).toBe(true);
    await act(async () => {
      fireEvent.click(submit);
    });
    expect(fake.api.deleteTemplate).toHaveBeenCalledWith("office-session-token", MILK_ID);
    await screen.findByRole("heading", { name: "Шаблоны этикеток" });
    expect(screen.getByText("Шаблон «Молоко 58×40» удалён.")).toBeTruthy();
    await waitFor(() => expect(fake.api.listTemplates).toHaveBeenCalledTimes(2));
  });

  it("sends nothing when the deletion is cancelled", async () => {
    const fake = editSession();
    await openEdit(fake);
    fireEvent.click(screen.getByRole("button", { name: "Удалить" }));
    fireEvent.click(within(deleteDialog()).getByRole("button", { name: "Отмена" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fake.api.deleteTemplate).not.toHaveBeenCalled();
  });

  it("says why a deletion is refused: a default, a stock template, a template already gone", async () => {
    const fake = editSession();
    fake.api.deleteTemplate
      .mockRejectedValueOnce(
        hostError("conflict", {
          constraint: "template_is_default",
          organizationDefault: true,
          categoryDefaults: [],
        }),
      )
      .mockRejectedValueOnce(hostError("conflict", { constraint: "stock_template" }))
      .mockRejectedValueOnce(hostError("not_found"));
    await openEdit(fake);
    fireEvent.click(screen.getByRole("button", { name: "Удалить" }));
    const confirm = async () => {
      await act(async () => {
        fireEvent.click(within(deleteDialog()).getByRole("button", { name: "Удалить" }));
      });
      return within(deleteDialog()).getByRole("alert").textContent;
    };
    expect(await confirm()).toBe(
      "✕Шаблон выбран по умолчанию для организации. Сначала выберите другой шаблон на странице «Умолчания шаблонов».",
    );
    expect(await confirm()).toBe("✕Типовой шаблон не удаляется: его можно выключить.");
    expect(await confirm()).toBe(
      "✕Шаблона больше нет на хосте: его удалили на другом рабочем месте.",
    );
    fireEvent.click(within(deleteDialog()).getByRole("button", { name: "Отмена" }));
    fireEvent.click(screen.getByRole("button", { name: "К шаблонам" }));
    await screen.findByRole("heading", { name: "Шаблоны этикеток" });
    await waitFor(() => expect(fake.api.listTemplates).toHaveBeenCalledTimes(2));
  });

  it("copies the source's own purpose, flag, categories and layout, whatever they are, and drops the cached list", async () => {
    const fake = editSession();
    fake.api.getTemplate.mockResolvedValue(
      milk({ purpose: "pallet", chzProductGroupCodes: null, spec: importedSpec(ZPL, 300) }),
    );
    fake.api.createTemplate.mockResolvedValue(created("Молоко 58×40 — копия"));
    await openEdit(fake);
    fireEvent.click(screen.getByRole("button", { name: "Копировать" }));
    await screen.findByRole("heading", { name: "Копия шаблона «Молоко 58×40»" });
    await settle();
    expect(valueOf("Назначение")).toBe("pallet");
    expect(screen.getByRole("radio", { name: "Все категории" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByText(/^Размер: .* · 300 dpi$/)).toBeTruthy();
    let release: (rows: LabelTemplateSummary[]) => void = () => {};
    fake.api.listTemplates.mockReturnValueOnce(
      new Promise<LabelTemplateSummary[]>((resolve) => {
        release = resolve;
      }),
    );
    await save();
    expect(fake.api.createTemplate.mock.calls[0]?.[1]).toStrictEqual({
      name: "Молоко 58×40 — копия",
      purpose: "pallet",
      enabled: true,
      chzProductGroupCodes: null,
      spec: importedSpec(ZPL, 300),
    });
    await screen.findByRole("heading", { name: "Шаблоны этикеток" });
    // The list is read again: no row of the old list stands in for it meanwhile.
    expect(screen.getByText("Загрузка…")).toBeTruthy();
    expect(screen.queryByText("Молоко 58×40")).toBeNull();
    await act(async () => {
      release([BOX_58]);
    });
    expect(await screen.findByText("Коробка 58×40")).toBeTruthy();
  });

  it("drops the cached list after a delete, so the deleted row is never shown again", async () => {
    const fake = editSession();
    fake.api.deleteTemplate.mockResolvedValue(undefined);
    await openEdit(fake);
    let release: (rows: LabelTemplateSummary[]) => void = () => {};
    fake.api.listTemplates.mockReturnValueOnce(
      new Promise<LabelTemplateSummary[]>((resolve) => {
        release = resolve;
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Удалить" }));
    await act(async () => {
      fireEvent.click(within(deleteDialog()).getByRole("button", { name: "Удалить" }));
    });
    await screen.findByRole("heading", { name: "Шаблоны этикеток" });
    expect(screen.getByText("Загрузка…")).toBeTruthy();
    expect(screen.queryByText("Молоко 58×40")).toBeNull();
    await act(async () => {
      release([BOX_58]);
    });
    expect(await screen.findByText("Коробка 58×40")).toBeTruthy();
    expect(screen.queryByText("Молоко 58×40")).toBeNull();
  });

  it("reads the products again after a delete, so none is shown with the preference the host cleared", async () => {
    const fake = editSession();
    fake.api.listProducts.mockResolvedValue([PRODUCT]);
    fake.api.deleteTemplate.mockResolvedValue(undefined);
    await openTemplates(fake);
    fireEvent.click(screen.getByRole("link", { name: "Товары" }));
    expect(await screen.findByText(PRODUCT.name)).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Шаблоны" }));
    await screen.findByRole("heading", { name: "Шаблоны этикеток" });
    await waitFor(() => expect(screen.queryByText("Загрузка…")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Изменить шаблон «Молоко 58×40»" }));
    await screen.findByRole("heading", { name: "Шаблон «Молоко 58×40»" });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Удалить" }));
    await act(async () => {
      fireEvent.click(within(deleteDialog()).getByRole("button", { name: "Удалить" }));
    });
    await screen.findByText("Шаблон «Молоко 58×40» удалён.");
    await waitFor(() => expect(screen.queryByText("Загрузка…")).toBeNull());
    let release: (rows: OfficeProduct[]) => void = () => {};
    fake.api.listProducts.mockReturnValueOnce(
      new Promise<OfficeProduct[]>((resolve) => {
        release = resolve;
      }),
    );
    fireEvent.click(screen.getByRole("link", { name: "Товары" }));
    await screen.findByText("Загрузка…");
    // The list from before the delete is dropped: no row of it stands in for the read.
    expect(screen.queryByText(PRODUCT.name)).toBeNull();
    await act(async () => {
      release([{ ...PRODUCT, rev: PRODUCT.rev + 1 }]);
    });
    expect(await screen.findByText(PRODUCT.name)).toBeTruthy();
    expect(fake.api.listProducts).toHaveBeenCalledTimes(2);
  });

  it.each(ROLES)(
    "offers a copy and a delete to the $role: «Копировать» on a stock row, «Копировать» and «Удалить» in the editor",
    async ({ user }) => {
      const fake = editSession(user);
      fake.api.deleteTemplate.mockResolvedValue(undefined);
      await openTemplates(fake);
      expect(
        screen.getByRole("button", { name: "Копировать шаблон «Коробка 58×40»" }),
      ).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Изменить шаблон «Молоко 58×40»" }));
      await screen.findByRole("heading", { name: "Шаблон «Молоко 58×40»" });
      await settle();
      expect(screen.getByRole("button", { name: "Копировать" })).toBeTruthy();
      const remove = screen.getByRole("button", { name: "Удалить" });
      expect(remove.classList.contains("mk-btn--destructive-outline")).toBe(true);
      fireEvent.click(remove);
      await act(async () => {
        fireEvent.click(within(deleteDialog()).getByRole("button", { name: "Удалить" }));
      });
      expect(await screen.findByText("Шаблон «Молоко 58×40» удалён.")).toBeTruthy();
      expect(fake.api.deleteTemplate).toHaveBeenCalledTimes(1);
    },
  );

  it.each<{
    case: string;
    arrange: (api: FakeOfficeSession["api"]) => void;
    text: string;
  }>([
    {
      case: "deleted",
      arrange: (api) => api.getTemplate.mockRejectedValue(hostError("not_found")),
      text: "⧉Шаблона нет на хосте: его удалили на другом рабочем месте.",
    },
    {
      case: "unreadable",
      arrange: (api) => api.getTemplate.mockResolvedValue({ ...stockBox(), spec: { widthMm: 58 } }),
      text: "⧉Макет этого шаблона не читается этой версией приложения. Обновите приложение на этом ПК.",
    },
  ])(
    "explains a copy page whose source is $case, with no copy of a copy on offer",
    async ({ arrange, text }) => {
      const fake = editSession();
      arrange(fake.api);
      await openTemplates(fake);
      fireEvent.click(screen.getByRole("button", { name: "Копировать шаблон «Коробка 58×40»" }));
      expect((await screen.findByRole("alert")).textContent).toBe(text);
      expect(screen.getByRole("heading", { name: "Копия шаблона" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Копировать" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "К шаблонам" }));
      await screen.findByRole("heading", { name: "Шаблоны этикеток" });
    },
  );

  it("explains a copy page whose source cannot be reached, and reads it again on «Повторить»", async () => {
    const down = editSession();
    down.api.getTemplate
      .mockRejectedValueOnce(
        new HostError({ kind: "transport", code: "unreachable", message: "down" }),
      )
      .mockResolvedValueOnce(stockBox());
    await openTemplates(down);
    fireEvent.click(screen.getByRole("button", { name: "Копировать шаблон «Коробка 58×40»" }));
    await screen.findByRole("button", { name: "Повторить" });
    expect(screen.getByRole("heading", { name: "Копия шаблона" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByLabelText("Название")).toHaveProperty(
      "value",
      "Коробка 58×40 — копия",
    );
  });

  it("clears an earlier refusal while the next delete is on its way, and names the categories of a default", async () => {
    const fake = editSession();
    fake.api.deleteTemplate
      .mockRejectedValueOnce(
        hostError("conflict", {
          constraint: "template_is_default",
          organizationDefault: false,
          categoryDefaults: [13, 8],
        }),
      )
      .mockReturnValueOnce(new Promise<void>(() => {}));
    await openEdit(fake);
    fireEvent.click(screen.getByRole("button", { name: "Удалить" }));
    await act(async () => {
      fireEvent.click(within(deleteDialog()).getByRole("button", { name: "Удалить" }));
    });
    expect(within(deleteDialog()).getByRole("alert").textContent).toBe(
      "✕Шаблон выбран по умолчанию для категорий: Упакованная вода, Молочная продукция. Сначала выберите другой шаблон на странице «Умолчания шаблонов».",
    );
    await act(async () => {
      fireEvent.click(within(deleteDialog()).getByRole("button", { name: "Удалить" }));
    });
    expect(within(deleteDialog()).queryByRole("alert")).toBeNull();
    expect(fake.api.deleteTemplate).toHaveBeenCalledTimes(2);
  });

  it("sends one delete for two clicks in the same moment", async () => {
    const fake = editSession();
    fake.api.deleteTemplate.mockResolvedValue(undefined);
    await openEdit(fake);
    fireEvent.click(screen.getByRole("button", { name: "Удалить" }));
    const submit = within(deleteDialog()).getByRole("button", { name: "Удалить" });
    await act(async () => {
      fireEvent.click(submit);
      fireEvent.click(submit);
    });
    await screen.findByRole("heading", { name: "Шаблоны этикеток" });
    expect(fake.api.deleteTemplate).toHaveBeenCalledTimes(1);
  });

  it("shows a name made of markup as text on the copy page, in the delete dialog and in the notice", async () => {
    const name = "<i>Из файла</i><img src=x onerror=alert(1)>";
    const markup = (fake: ReturnType<typeof editSession>) => {
      fake.api.listTemplates.mockResolvedValue([BOX_58, { ...MILK_ROW, name }]);
      fake.api.getTemplate.mockResolvedValue(milk({ name }));
    };
    const first = editSession();
    markup(first);
    const view = await openTemplates(first);
    fireEvent.click(screen.getByRole("button", { name: `Изменить шаблон «${name}»` }));
    await screen.findByRole("heading", { name: `Шаблон «${name}»` });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Удалить" }));
    expect(within(deleteDialog()).getByText(new RegExp("будет удалён: станции"))).toBeTruthy();
    expect(deleteDialog().textContent).toContain(`Шаблон «${name}» будет удалён`);
    expect(document.querySelector("img, i, b, script")).toBeNull();
    fireEvent.click(within(deleteDialog()).getByRole("button", { name: "Отмена" }));
    fireEvent.click(screen.getByRole("button", { name: "Копировать" }));
    await screen.findByRole("heading", { name: `Копия шаблона «${name}»` });
    expect(screen.getByLabelText("Название")).toHaveProperty("value", `${name} — копия`);
    expect(document.querySelector("img, i, b, script")).toBeNull();
    view.unmount();

    const second = editSession();
    markup(second);
    second.api.deleteTemplate.mockResolvedValue(undefined);
    await openTemplates(second);
    fireEvent.click(screen.getByRole("button", { name: `Изменить шаблон «${name}»` }));
    await screen.findByRole("heading", { name: `Шаблон «${name}»` });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Удалить" }));
    await act(async () => {
      fireEvent.click(within(deleteDialog()).getByRole("button", { name: "Удалить" }));
    });
    expect(await screen.findByText(`Шаблон «${name}» удалён.`)).toBeTruthy();
    expect(document.querySelector("img, i, b, script")).toBeNull();
  });
});

function leaveDialog(): HTMLElement {
  return screen.getByRole("dialog", { name: "Уйти со страницы?" });
}

describe("leaving a label template with unsaved changes", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  it("asks before «К шаблонам» drops the changes, and «Отмена» keeps them", async () => {
    const fake = editSession();
    await openEdit(fake);
    type("Название", "Молоко 60×40");
    fireEvent.click(screen.getByRole("button", { name: "К шаблонам" }));
    expect(
      within(leaveDialog()).getByText("Изменения шаблона не сохранены и пропадут."),
    ).toBeTruthy();
    const leave = within(leaveDialog()).getByRole("button", { name: "Уйти без сохранения" });
    expect(leave.classList.contains("mk-btn--destructive")).toBe(true);
    fireEvent.click(within(leaveDialog()).getByRole("button", { name: "Отмена" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByLabelText("Название")).toHaveProperty("value", "Молоко 60×40");
    fireEvent.click(screen.getByRole("button", { name: "К шаблонам" }));
    await act(async () => {
      fireEvent.click(within(leaveDialog()).getByRole("button", { name: "Уйти без сохранения" }));
    });
    await screen.findByRole("heading", { name: "Шаблоны этикеток" });
    expect(fake.api.updateTemplate).not.toHaveBeenCalled();
  });

  it("asks before the menu and «Копировать» leave a changed template too", async () => {
    const fake = editSession();
    await openEdit(fake);
    fireEvent.click(screen.getByRole("checkbox", { name: "Включён" }));
    fireEvent.click(screen.getByRole("link", { name: "Товары" }));
    expect(leaveDialog()).toBeTruthy();
    fireEvent.click(within(leaveDialog()).getByRole("button", { name: "Отмена" }));
    fireEvent.click(screen.getByRole("button", { name: "Копировать" }));
    expect(leaveDialog()).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(leaveDialog()).getByRole("button", { name: "Уйти без сохранения" }));
    });
    await screen.findByRole("heading", { name: "Копия шаблона «Молоко 58×40»" });
  });

  it("leaves without asking when nothing changed, a new template is untouched, or after a delete", async () => {
    const fake = editSession();
    fake.api.deleteTemplate.mockResolvedValue(undefined);
    await openEdit(fake);
    fireEvent.click(screen.getByRole("button", { name: "К шаблонам" }));
    await screen.findByRole("heading", { name: "Шаблоны этикеток" });
    fireEvent.click(screen.getByRole("button", { name: "Создать шаблон" }));
    await screen.findByRole("heading", { name: "Новый шаблон" });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "К шаблонам" }));
    await screen.findByRole("heading", { name: "Шаблоны этикеток" });
    await waitFor(() => expect(screen.queryByText("Загрузка…")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Изменить шаблон «Молоко 58×40»" }));
    await screen.findByRole("heading", { name: "Шаблон «Молоко 58×40»" });
    await settle();
    type("Название", "Молоко 60×40");
    fireEvent.click(screen.getByRole("button", { name: "Удалить" }));
    await act(async () => {
      fireEvent.click(within(deleteDialog()).getByRole("button", { name: "Удалить" }));
    });
    expect(await screen.findByText("Шаблон «Молоко 58×40» удалён.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not ask once the changes are typed back, and a save after «Отмена» leaves without asking", async () => {
    const fake = editSession();
    fake.api.updateTemplate.mockResolvedValue(milk({ name: "Молоко 60×40", rev: 62 }));
    await openEdit(fake);
    type("Название", "Молоко 60×40");
    type("Название", "Молоко 58×40");
    expect(saveButton()).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("link", { name: "Товары" }));
    await screen.findByRole("heading", { name: "Товары" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(await screen.findByRole("link", { name: "Шаблоны" }));
    await screen.findByRole("heading", { name: "Шаблоны этикеток" });
    await waitFor(() => expect(screen.queryByText("Загрузка…")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Изменить шаблон «Молоко 58×40»" }));
    await screen.findByRole("heading", { name: "Шаблон «Молоко 58×40»" });
    await settle();
    type("Название", "Молоко 60×40");
    fireEvent.click(screen.getByRole("link", { name: "Товары" }));
    fireEvent.click(within(leaveDialog()).getByRole("button", { name: "Отмена" }));
    await save();
    await screen.findByRole("heading", { name: "Шаблоны этикеток" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fake.api.updateTemplate).toHaveBeenCalledTimes(1);
  });

  it("asks before a new template with a typed name and a changed copy are dropped, but not an untouched copy", async () => {
    const fake = editSession();
    await openNew(fake);
    type("Название", "Новый");
    fireEvent.click(screen.getByRole("link", { name: "Товары" }));
    expect(leaveDialog()).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(leaveDialog()).getByRole("button", { name: "Уйти без сохранения" }));
    });
    await screen.findByRole("heading", { name: "Товары" });
    fireEvent.click(await screen.findByRole("link", { name: "Шаблоны" }));
    await screen.findByRole("heading", { name: "Шаблоны этикеток" });
    await waitFor(() => expect(screen.queryByText("Загрузка…")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Копировать шаблон «Коробка 58×40»" }));
    await screen.findByRole("heading", { name: "Копия шаблона «Молоко 58×40»" });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "К шаблонам" }));
    await screen.findByRole("heading", { name: "Шаблоны этикеток" });
    await waitFor(() => expect(screen.queryByText("Загрузка…")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Копировать шаблон «Коробка 58×40»" }));
    await screen.findByRole("heading", { name: "Копия шаблона «Молоко 58×40»" });
    await settle();
    fireEvent.click(screen.getByRole("checkbox", { name: "Включён" }));
    fireEvent.click(screen.getByRole("button", { name: "К шаблонам" }));
    expect(leaveDialog()).toBeTruthy();
  });

  it("does not ask for a navigation that stays on the page, such as a changed search, and asks for another page", async () => {
    const fake = editSession();
    const router = createMemoryRouter(
      [
        {
          path: "/templates/new",
          element: (
            <>
              <NewTemplatePage />
              <Link to="/templates/new?x=1">Та же страница</Link>
              <Link to="/other">Другая страница</Link>
            </>
          ),
        },
        { path: "/other", element: <p>Другая страница открыта</p> },
      ],
      { initialEntries: ["/templates/new"] },
    );
    render(
      <ThemeProvider defaultTheme="dark">
        <QueryClientProvider client={createOfficeQueryClient()}>
          <OfficeSessionProvider value={fake}>
            <RouterProvider router={router} />
          </OfficeSessionProvider>
        </QueryClientProvider>
      </ThemeProvider>,
    );
    await screen.findByRole("heading", { name: "Новый шаблон" });
    // No list page read the categories first, so they arrive during this wait.
    await act(async () => {
      await settle();
    });
    type("Название", "Новый");
    await act(async () => {
      fireEvent.click(screen.getByRole("link", { name: "Та же страница" }));
    });
    expect(router.state.location.search).toBe("?x=1");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByLabelText("Название")).toHaveProperty("value", "Новый");
    await act(async () => {
      fireEvent.click(screen.getByRole("link", { name: "Другая страница" }));
    });
    expect(leaveDialog()).toBeTruthy();
    expect(router.state.location.pathname).toBe("/templates/new");
  });

  it("does not ask after a stale save is loaded again: the new editor starts without edits", async () => {
    const fake = editSession();
    fake.api.updateTemplate.mockRejectedValueOnce(hostError("stale_revision", { currentRev: 64 }));
    await openEdit(fake);
    type("Название", "Молоко 60×40");
    await save();
    fake.api.getTemplate.mockResolvedValue(milk({ name: "Молоко (со склада)", rev: 64 }));
    fireEvent.click(
      within(screen.getByRole("alert")).getByRole("button", { name: "Загрузить заново" }),
    );
    await screen.findByRole("heading", { name: "Шаблон «Молоко (со склада)»" });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "К шаблонам" }));
    await screen.findByRole("heading", { name: "Шаблоны этикеток" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stays where the user went when a save lands after the editor was left through the menu, and still drops the list", async () => {
    const fake = editSession();
    fake.api.listProducts.mockResolvedValue([]);
    let answer: (template: LabelTemplate) => void = () => undefined;
    fake.api.updateTemplate.mockReturnValue(
      new Promise<LabelTemplate>((resolve) => {
        answer = resolve;
      }),
    );
    await openEdit(fake);
    type("Название", "Молоко 60×40");
    await save();
    fireEvent.click(screen.getByRole("link", { name: "Товары" }));
    await act(async () => {
      fireEvent.click(within(leaveDialog()).getByRole("button", { name: "Уйти без сохранения" }));
    });
    await screen.findByRole("heading", { name: "Товары" });
    await act(async () => {
      answer(milk({ name: "Молоко 60×40", rev: 62 }));
    });
    await settle();
    expect(screen.getByRole("heading", { name: "Товары" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Шаблоны этикеток" })).toBeNull();
    expect(screen.queryByText("Шаблон «Молоко 60×40» сохранён.")).toBeNull();
    // The save did land, so the list from before it is gone all the same.
    fake.api.listTemplates.mockReturnValueOnce(new Promise<LabelTemplateSummary[]>(() => {}));
    fireEvent.click(screen.getByRole("link", { name: "Шаблоны" }));
    await screen.findByText("Загрузка…");
    expect(screen.queryByText("Молоко 58×40")).toBeNull();
  });

  it.each([
    ["the «К шаблонам» button", () => screen.getByRole("button", { name: "К шаблонам" })],
    ["the menu's «Шаблоны»", () => screen.getByRole("link", { name: "Шаблоны" })],
  ])(
    "reads the list again when a save lands after the editor was left for the list itself through %s",
    async (_name, target) => {
      const fake = editSession();
      let answer: (template: LabelTemplate) => void = () => undefined;
      fake.api.updateTemplate.mockReturnValue(
        new Promise<LabelTemplate>((resolve) => {
          answer = resolve;
        }),
      );
      await openEdit(fake);
      type("Название", "Молоко 60×40");
      await save();
      fireEvent.click(target());
      await act(async () => {
        fireEvent.click(within(leaveDialog()).getByRole("button", { name: "Уйти без сохранения" }));
      });
      await screen.findByRole("heading", { name: "Шаблоны этикеток" });
      // The page shows the list as it was, read again on arrival.
      expect(await screen.findByText("Молоко 58×40")).toBeTruthy();
      await waitFor(() => expect(fake.api.listTemplates.mock.calls.length).toBeGreaterThan(1));
      await settle();
      const readBeforeSave = fake.api.listTemplates.mock.calls.length;
      fake.api.listTemplates.mockResolvedValue([
        BOX_58,
        { ...MILK_ROW, name: "Молоко 60×40", rev: 62 },
      ]);
      await act(async () => {
        answer(milk({ name: "Молоко 60×40", rev: 62 }));
      });
      // The save did land: the page on screen reads the list again and shows the new row.
      expect(await screen.findByText("Молоко 60×40")).toBeTruthy();
      expect(screen.queryByText("Молоко 58×40")).toBeNull();
      expect(fake.api.listTemplates).toHaveBeenCalledTimes(readBeforeSave + 1);
      expect(screen.queryByText("Шаблон «Молоко 60×40» сохранён.")).toBeNull();
    },
  );

  it("keeps «Копировать» and «Удалить» off while a save is on its way, and «К шаблонам» on", async () => {
    const fake = editSession();
    let refuse: (error: unknown) => void = () => undefined;
    fake.api.updateTemplate.mockReturnValue(
      new Promise<LabelTemplate>((_resolve, reject) => {
        refuse = reject;
      }),
    );
    await openEdit(fake);
    type("Название", "Молоко 60×40");
    await save();
    expect(screen.getByRole("button", { name: "Копировать" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Удалить" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "К шаблонам" })).toHaveProperty("disabled", false);
    await act(async () => {
      refuse(new HostError({ kind: "transport", code: "unreachable", message: "down" }));
    });
    expect(screen.getByRole("button", { name: "Копировать" })).toHaveProperty("disabled", false);
    expect(screen.getByRole("button", { name: "Удалить" })).toHaveProperty("disabled", false);
  });
});

describe("a file saved from the webview", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is clicked while its link is in the page, and its blob URL is revoked after the click", () => {
    recordBlobUrls();
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
    expect(events).toEqual(["click in page: true", "revoke"]);
    expect(document.querySelector("a[download]")).toBeNull();
  });
});
