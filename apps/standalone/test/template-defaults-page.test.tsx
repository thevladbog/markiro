import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import type { LabelTemplateSummary, ProductGroup, TemplateDefaults } from "../src/host/protocol.js";
import {
  fakeOfficeSession,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";

const GROUPS: ProductGroup[] = [
  { code: 8, alias: "milk", name: "Молочная продукция" },
  { code: 13, alias: "water", name: "Упакованная вода" },
  { code: 3, alias: "tobacco", name: "Альтернативная табачная продукция" },
];

/** A template summary: an enabled box template for every category unless told otherwise. */
function summary(id: string, name: string, data: Partial<LabelTemplateSummary> = {}) {
  return {
    id,
    name,
    purpose: "box",
    enabled: true,
    chzProductGroupCodes: null,
    stock: true,
    widthMm: 58,
    heightMm: 40,
    dpi: 203,
    language: "zpl",
    rev: 2,
    ...data,
  } satisfies LabelTemplateSummary;
}

const BOX = summary("7c1e4b2a-9d3f-4e5a-8b6c-1d2e3f4a5b6c", "Коробка 58×40");
const BOX_100 = summary("8d2f5c3b-0e4a-4f6b-9c7d-2e3f4a5b6c7d", "Коробка 100×100");
const MILK = summary("a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d", "Молоко 58×40", {
  stock: false,
  chzProductGroupCodes: [8],
});
const OLD = summary("9e3a6d4c-1f5b-4a7c-8d8e-3f4a5b6c7d8e", "Старая коробка", {
  stock: false,
  enabled: false,
});
const PALLET = summary("0f4b7e5d-2a6c-4b8d-9e9f-4a5b6c7d8e9f", "Паллета 100×150", {
  purpose: "pallet",
});
const PALLET_58 = summary("1a5c8f6e-3b7d-4c9e-8f0a-5b6c7d8e9f0a", "Паллета 58×40", {
  purpose: "pallet",
});
const DUPLICATE = summary("2b6d9a7f-4c8e-4d0f-9a1b-6c7d8e9f0a1b", "Дубликат [Полное]", {
  purpose: "product_duplicate",
});
const TEMPLATES = [BOX_100, BOX, DUPLICATE, MILK, OLD, PALLET, PALLET_58];

const DEFAULTS: TemplateDefaults = {
  defaultBoxTemplateId: BOX.id,
  defaultPalletTemplateId: PALLET.id,
  defaultDuplicateTemplateId: null,
  categories: [{ chzProductGroupCode: 8, purpose: "box", templateId: MILK.id }],
  rev: 64,
};

function session(document: TemplateDefaults = DEFAULTS, user = TECHNOLOGIST): FakeOfficeSession {
  const fake = fakeOfficeSession({ user });
  fake.api.getTemplateDefaults.mockResolvedValue(document);
  fake.api.listTemplates.mockResolvedValue(TEMPLATES);
  fake.api.listProductGroups.mockResolvedValue(GROUPS);
  return fake;
}

async function openDefaults(fake: FakeOfficeSession): Promise<void> {
  renderOffice(fake);
  fireEvent.click(await screen.findByRole("link", { name: "Умолчания шаблонов" }));
  await screen.findByRole("heading", { name: "Для организации" });
  await waitFor(() =>
    expect(screen.getByLabelText("Шаблон короба")).toHaveProperty("disabled", false),
  );
}

/** The labels a select offers, top to bottom. */
function choices(label: string): (string | null)[] {
  return within(screen.getByLabelText(label))
    .getAllByRole("option")
    .map((option) => option.textContent);
}

function choose(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function hostError(code: string, status: number, details: Record<string, unknown> = {}): HostError {
  return new HostError({ kind: "api", code, status, message: code, details });
}

/** Two passes of the scheduler: an effect that would read again has run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

const DIRTY = "Есть несохранённые изменения.";
const UNFIT = "Шаблон больше не подходит: его выключили, сузили или удалили. Выберите другой.";

describe("office template defaults: the organization's", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  it("is in the menu under «Каталог» right after «Шаблоны», for both roles", async () => {
    for (const user of [undefined, TECHNOLOGIST]) {
      const view = renderOffice(fakeOfficeSession(user === undefined ? {} : { user }));
      const menu = await screen.findByRole("navigation", { name: "Разделы офиса" });
      const items = within(menu)
        .getAllByRole("listitem")
        .map((item) => item.textContent);
      const catalog = items.indexOf("Каталог");
      expect(items.slice(catalog, catalog + 4)).toEqual([
        "Каталог",
        "Товары",
        "Шаблоны",
        "Умолчания шаблонов",
      ]);
      view.unmount();
    }
  });

  it("offers for each purpose «Не выбран» and the enabled templates of that purpose for every category, by name, and holds the document's choice", async () => {
    await openDefaults(session());
    expect(screen.getByRole("heading", { name: "Умолчания шаблонов" })).toBeTruthy();
    expect(choices("Шаблон короба")).toEqual(["Не выбран", "Коробка 58×40", "Коробка 100×100"]);
    expect(choices("Шаблон паллеты")).toEqual(["Не выбран", "Паллета 58×40", "Паллета 100×150"]);
    expect(choices("Шаблон дубликата товара")).toEqual(["Не выбран", "Дубликат [Полное]"]);
    expect(screen.getByLabelText("Шаблон короба")).toHaveProperty("value", BOX.id);
    expect(screen.getByLabelText("Шаблон паллеты")).toHaveProperty("value", PALLET.id);
    expect(screen.getByLabelText("Шаблон дубликата товара")).toHaveProperty("value", "");
    expect(screen.getAllByText("Только включённые шаблоны для всех категорий")).toHaveLength(3);
  });

  it("keeps a default the list does not offer as a marked choice: one that no longer fits, or one the list lacks", async () => {
    const gone = "6f0b3e1d-8a2c-4b4d-9e5f-0a1b2c3d4e5f";
    await openDefaults(
      session({ ...DEFAULTS, defaultBoxTemplateId: OLD.id, defaultDuplicateTemplateId: gone }),
    );
    expect(choices("Шаблон короба")).toEqual([
      "Не выбран",
      "Коробка 58×40",
      "Коробка 100×100",
      "Старая коробка — не подходит",
    ]);
    expect(screen.getByLabelText("Шаблон короба")).toHaveProperty("value", OLD.id);
    expect(choices("Шаблон дубликата товара")).toEqual([
      "Не выбран",
      "Дубликат [Полное]",
      "Шаблон 6f0b3e1d… — нет в списке",
    ]);
  });

  it("saves the whole document with the loaded revision: a changed default, a cleared one as null and the category defaults as they were; the answer then shows", async () => {
    const fake = session();
    const answer: TemplateDefaults = {
      ...DEFAULTS,
      defaultBoxTemplateId: BOX_100.id,
      defaultPalletTemplateId: null,
      rev: 70,
    };
    fake.api.updateTemplateDefaults.mockResolvedValue(answer);
    await openDefaults(fake);
    choose("Шаблон короба", BOX_100.id);
    const pallets = screen.getByLabelText("Шаблон паллеты");
    const none = within(pallets).getByRole("option", { name: "Не выбран" });
    expect(none).toHaveProperty("value", "");
    fireEvent.change(pallets, { target: { value: none.getAttribute("value") } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Изменения сохранены.")).toBeTruthy();
    expect(fake.api.updateTemplateDefaults.mock.calls).toStrictEqual([
      [
        "office-session-token",
        {
          defaultBoxTemplateId: BOX_100.id,
          defaultPalletTemplateId: null,
          defaultDuplicateTemplateId: null,
          categories: [{ chzProductGroupCode: 8, purpose: "box", templateId: MILK.id }],
          expectedRev: 64,
        },
      ],
    ]);
    expect(screen.getByLabelText("Шаблон короба")).toHaveProperty("value", BOX_100.id);
    expect(screen.getByLabelText("Шаблон паллеты")).toHaveProperty("value", "");
    expect(screen.getByRole("button", { name: "Сохранить" })).toHaveProperty("disabled", true);
    expect(screen.queryByText(DIRTY)).toBeNull();
    await settle();
    expect(fake.api.getTemplateDefaults).toHaveBeenCalledTimes(1);
  });

  it("says when there are unsaved changes, keeps «Сохранить» and «Отменить изменения» off without them, and «Отменить изменения» brings back the loaded document", async () => {
    await openDefaults(session());
    const save = screen.getByRole("button", { name: "Сохранить" });
    const cancel = screen.getByRole("button", { name: "Отменить изменения" });
    expect(save).toHaveProperty("disabled", true);
    expect(cancel).toHaveProperty("disabled", true);
    choose("Шаблон паллеты", PALLET_58.id);
    const note = screen.getByText(DIRTY);
    expect(note.getAttribute("aria-live")).toBe("polite");
    expect(save).toHaveProperty("disabled", false);
    expect(cancel).toHaveProperty("disabled", false);
    // Choosing the loaded template again is no change.
    choose("Шаблон паллеты", PALLET.id);
    expect(screen.queryByText(DIRTY)).toBeNull();
    expect(save).toHaveProperty("disabled", true);
    choose("Шаблон дубликата товара", DUPLICATE.id);
    fireEvent.click(cancel);
    expect(screen.getByLabelText("Шаблон дубликата товара")).toHaveProperty("value", "");
    expect(screen.queryByText(DIRTY)).toBeNull();
  });

  it("puts a refused default under its select as a template that no longer fits, reads the templates again, and takes the message away once that choice changes", async () => {
    const fake = session();
    await openDefaults(fake);
    for (const [field, label] of [
      ["defaultBoxTemplateId", "Шаблон короба"],
      ["defaultPalletTemplateId", "Шаблон паллеты"],
      ["defaultDuplicateTemplateId", "Шаблон дубликата товара"],
    ] as const) {
      fake.api.updateTemplateDefaults.mockRejectedValueOnce(
        hostError("validation_failed", 400, { field }),
      );
      choose("Шаблон дубликата товара", DUPLICATE.id);
      fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
      const message = await screen.findByText(UNFIT);
      expect(screen.getByLabelText(label).getAttribute("aria-describedby")).toBe(message.id);
      expect(screen.getAllByText(UNFIT)).toHaveLength(1);
    }
    await waitFor(() => expect(fake.api.listTemplates).toHaveBeenCalledTimes(4));
    // Another select leaves the message; its own select takes it away.
    choose("Шаблон короба", BOX_100.id);
    expect(screen.getByText(UNFIT)).toBeTruthy();
    choose("Шаблон дубликата товара", "");
    expect(screen.queryByText(UNFIT)).toBeNull();
  });

  it("offers to load the defaults again after a stale save, saying the profile may have moved them; the reload drops the edits", async () => {
    const fake = session();
    fake.api.updateTemplateDefaults.mockRejectedValue(
      hostError("stale_revision", 409, { currentRev: 66 }),
    );
    await openDefaults(fake);
    fake.api.getTemplateDefaults.mockResolvedValue({
      ...DEFAULTS,
      defaultPalletTemplateId: PALLET_58.id,
      rev: 66,
    });
    choose("Шаблон короба", BOX_100.id);
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(
      await screen.findByText(
        "Умолчания или профиль организации изменились, пока вы их правили. Загрузите умолчания заново — ваши правки пропадут.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Загрузить заново" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Шаблон паллеты")).toHaveProperty("value", PALLET_58.id),
    );
    expect(fake.api.getTemplateDefaults).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("Шаблон короба")).toHaveProperty("value", BOX.id);
    expect(screen.queryByText(DIRTY)).toBeNull();
    expect(screen.queryByRole("button", { name: "Загрузить заново" })).toBeNull();
  });

  it("explains any other failure by its code, and a new save takes away both the failure and the notice of the last save", async () => {
    const fake = session();
    let release: (document: TemplateDefaults) => void = () => undefined;
    fake.api.updateTemplateDefaults
      .mockResolvedValueOnce({ ...DEFAULTS, defaultBoxTemplateId: BOX_100.id, rev: 65 })
      .mockRejectedValueOnce(hostError("internal", 500))
      .mockReturnValueOnce(
        new Promise<TemplateDefaults>((resolve) => {
          release = resolve;
        }),
      );
    await openDefaults(fake);
    choose("Шаблон короба", BOX_100.id);
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Изменения сохранены.")).toBeTruthy();
    choose("Шаблон паллеты", PALLET_58.id);
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("На хосте произошла ошибка. Повторите попытку.")).toBeTruthy();
    expect(screen.queryByText("Изменения сохранены.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() =>
      expect(screen.queryByText("На хосте произошла ошибка. Повторите попытку.")).toBeNull(),
    );
    await act(async () => {
      release({
        ...DEFAULTS,
        defaultBoxTemplateId: BOX_100.id,
        defaultPalletTemplateId: PALLET_58.id,
        rev: 66,
      });
    });
    expect(await screen.findByText("Изменения сохранены.")).toBeTruthy();
    expect(fake.api.updateTemplateDefaults.mock.calls.map((call) => call[1].expectedRev)).toEqual([
      64, 65, 65,
    ]);
  });

  it("sends one request for a double click on «Сохранить»", async () => {
    const fake = session();
    let release: (document: TemplateDefaults) => void = () => undefined;
    fake.api.updateTemplateDefaults.mockReturnValue(
      new Promise<TemplateDefaults>((resolve) => {
        release = resolve;
      }),
    );
    await openDefaults(fake);
    choose("Шаблон короба", BOX_100.id);
    const save = screen.getByRole("button", { name: "Сохранить" });
    // Both clicks in one `act`: only the form's own guard drops the second.
    act(() => {
      fireEvent.click(save);
      fireEvent.click(save);
    });
    await waitFor(() => expect(save).toHaveProperty("disabled", true));
    expect(fake.api.updateTemplateDefaults).toHaveBeenCalledTimes(1);
    await act(async () => {
      release({ ...DEFAULTS, defaultBoxTemplateId: BOX_100.id, rev: 65 });
    });
    expect(await screen.findByText("Изменения сохранены.")).toBeTruthy();
    expect(fake.api.updateTemplateDefaults).toHaveBeenCalledTimes(1);
  });

  it("lets both office roles change the defaults", async () => {
    for (const user of [TECHNOLOGIST, { ...TECHNOLOGIST, role: "admin" as const }]) {
      const view = renderOffice(session(DEFAULTS, user));
      fireEvent.click(await screen.findByRole("link", { name: "Умолчания шаблонов" }));
      expect(await screen.findByRole("button", { name: "Сохранить" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Отменить изменения" })).toBeTruthy();
      await waitFor(() =>
        expect(screen.getByLabelText("Шаблон короба")).toHaveProperty("disabled", false),
      );
      view.unmount();
    }
  });

  it("reads the document and the templates again on every visit", async () => {
    const fake = session();
    await openDefaults(fake);
    fireEvent.click(screen.getByRole("link", { name: "Обзор" }));
    fireEvent.click(await screen.findByRole("link", { name: "Умолчания шаблонов" }));
    await waitFor(() => expect(fake.api.getTemplateDefaults).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(fake.api.listTemplates).toHaveBeenCalledTimes(2));
    await screen.findByRole("heading", { name: "Для организации" });
    // Once per visit: the form, which a new revision remounts, reads nothing itself.
    await settle();
    expect(fake.api.getTemplateDefaults).toHaveBeenCalledTimes(2);
    expect(fake.api.listTemplates).toHaveBeenCalledTimes(2);
  });

  it("explains a failed load of the document and loads it again", async () => {
    const fake = session();
    fake.api.getTemplateDefaults.mockRejectedValueOnce(
      new HostError({ kind: "transport", code: "unreachable", message: "down" }),
    );
    renderOffice(fake);
    fireEvent.click(await screen.findByRole("link", { name: "Умолчания шаблонов" }));
    expect(
      await screen.findByText(
        "Нет связи с хостом. Проверьте, что ПК-хост включён и служба запущена.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Для организации" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByRole("heading", { name: "Для организации" })).toBeTruthy();
  });

  it("keeps the choices off while the templates do not load, says so, and reads them again", async () => {
    const fake = session();
    fake.api.listTemplates.mockRejectedValueOnce(
      new HostError({ kind: "transport", code: "unreachable", message: "down" }),
    );
    renderOffice(fake);
    fireEvent.click(await screen.findByRole("link", { name: "Умолчания шаблонов" }));
    expect(
      await screen.findByText("Список шаблонов не загрузился: умолчания сейчас не изменить."),
    ).toBeTruthy();
    expect(screen.getByLabelText("Шаблон короба")).toHaveProperty("disabled", true);
    expect(choices("Шаблон короба")).toEqual(["Не выбран", "Шаблон 7c1e4b2a…"]);
    // The warning says the defaults cannot change now: «Убрать» is no way round it.
    expect(
      await screen.findByRole("button", { name: "Убрать умолчание: Молочная продукция, Короб" }),
    ).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Шаблон короба")).toHaveProperty("disabled", false),
    );
    expect(
      screen.getByRole("button", { name: "Убрать умолчание: Молочная продукция, Короб" }),
    ).toHaveProperty("disabled", false);
    expect(
      screen.queryByText("Список шаблонов не загрузился: умолчания сейчас не изменить."),
    ).toBeNull();
  });
});

describe("office template defaults: the categories'", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  /**
   * Four defaults of two categories, in an order unlike the one the page
   * shows; code 13 has all three purposes, so nothing is left to add for it.
   */
  const FULL_WATER: TemplateDefaults = {
    ...DEFAULTS,
    categories: [
      { chzProductGroupCode: 13, purpose: "product_duplicate", templateId: DUPLICATE.id },
      { chzProductGroupCode: 8, purpose: "box", templateId: MILK.id },
      { chzProductGroupCode: 13, purpose: "pallet", templateId: PALLET.id },
      { chzProductGroupCode: 13, purpose: "box", templateId: BOX.id },
    ],
  };

  function rows(): (string | null)[][] {
    const table = within(screen.getByRole("region", { name: "Для категорий" }));
    return table
      .getAllByRole("row")
      .slice(1)
      .map((row) =>
        within(row)
          .getAllByRole("cell")
          .slice(0, 2)
          .map((cell) => cell.textContent),
      );
  }

  /** Opens «Добавить умолчание категории» and waits for its dialog. */
  function openAdd(): HTMLElement {
    fireEvent.click(screen.getByRole("button", { name: "Добавить умолчание категории" }));
    return screen.getByRole("dialog", { name: "Умолчание категории" });
  }

  it("lists the category defaults by category name and purpose, each a choice of the templates that fit its category and purpose, with «Убрать»", async () => {
    await openDefaults(session(FULL_WATER));
    expect(screen.getByRole("heading", { name: "Для категорий" })).toBeTruthy();
    expect(
      screen.getByText("Станция возьмёт умолчание категории товара раньше умолчания организации."),
    ).toBeTruthy();
    expect(rows()).toEqual([
      ["Молочная продукция", "Короб"],
      ["Упакованная вода", "Короб"],
      ["Упакованная вода", "Паллета"],
      ["Упакованная вода", "Дубликат товара"],
    ]);
    // A category default always has a template: no «Не выбран» in its choice.
    expect(choices("Шаблон: Молочная продукция, Короб")).toEqual([
      "Коробка 58×40",
      "Коробка 100×100",
      "Молоко 58×40",
    ]);
    expect(screen.getByLabelText("Шаблон: Молочная продукция, Короб")).toHaveProperty(
      "value",
      MILK.id,
    );
    expect(choices("Шаблон: Упакованная вода, Короб")).toEqual([
      "Коробка 58×40",
      "Коробка 100×100",
    ]);
    expect(choices("Шаблон: Упакованная вода, Паллета")).toEqual([
      "Паллета 58×40",
      "Паллета 100×150",
    ]);
    expect(
      screen.getByRole("button", { name: "Убрать умолчание: Упакованная вода, Паллета" }),
    ).toBeTruthy();
    const purpose = within(screen.getByRole("region", { name: "Для категорий" })).getByText(
      "Дубликат товара",
    );
    expect(purpose.classList.contains("mk-badge--teal")).toBe(true);
  });

  it("says when there are no category defaults", async () => {
    await openDefaults(session({ ...DEFAULTS, categories: [] }));
    expect(screen.getByText("Умолчаний категорий нет.")).toBeTruthy();
  });

  it("changes a category default's template in its place and removes one; the save sends the categories as the page holds them", async () => {
    const fake = session(FULL_WATER);
    fake.api.updateTemplateDefaults.mockResolvedValue({ ...FULL_WATER, rev: 70 });
    await openDefaults(fake);
    choose("Шаблон: Молочная продукция, Короб", BOX_100.id);
    fireEvent.click(
      screen.getByRole("button", { name: "Убрать умолчание: Упакованная вода, Паллета" }),
    );
    expect(rows()).toHaveLength(3);
    expect(screen.getByText(DIRTY)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await screen.findByText("Изменения сохранены.");
    expect(fake.api.updateTemplateDefaults.mock.calls[0]?.[1].categories).toStrictEqual([
      { chzProductGroupCode: 13, purpose: "product_duplicate", templateId: DUPLICATE.id },
      { chzProductGroupCode: 8, purpose: "box", templateId: BOX_100.id },
      { chzProductGroupCode: 13, purpose: "box", templateId: BOX.id },
    ]);
  });

  it("adds a category default: a category with a purpose left, a purpose it has no default of, then a template that fits both", async () => {
    const fake = session(FULL_WATER);
    const milkPallet = summary("3c7e0b8a-5d9f-4e1a-8b2c-7d8e9f0a1b2c", "Паллета молока", {
      purpose: "pallet",
      stock: false,
      chzProductGroupCodes: [8],
    });
    fake.api.listTemplates.mockResolvedValue([...TEMPLATES, milkPallet]);
    fake.api.updateTemplateDefaults.mockResolvedValue({ ...FULL_WATER, rev: 70 });
    await openDefaults(fake);
    const add = openAdd();
    // «Упакованная вода» has a default of every purpose: it is not offered.
    expect(choices("Категория")).toEqual([
      "Не выбрана",
      "Альтернативная табачная продукция",
      "Молочная продукция",
    ]);
    expect(screen.getByLabelText("Назначение")).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("Шаблон")).toHaveProperty("disabled", true);
    choose("Категория", "8");
    expect(choices("Назначение")).toEqual(["Не выбрано", "Паллета", "Дубликат товара"]);
    choose("Назначение", "pallet");
    // A template scoped to the category fits it too.
    expect(choices("Шаблон")).toEqual([
      "Не выбран",
      "Паллета 58×40",
      "Паллета 100×150",
      "Паллета молока",
    ]);
    choose("Шаблон", PALLET_58.id);
    // A new category starts the purpose and the template afresh.
    choose("Категория", "3");
    expect(screen.getByLabelText("Назначение")).toHaveProperty("value", "");
    expect(screen.getByLabelText("Шаблон")).toHaveProperty("value", "");
    choose("Назначение", "box");
    choose("Шаблон", BOX_100.id);
    fireEvent.click(within(add).getByRole("button", { name: "Добавить" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(rows()[0]).toEqual(["Альтернативная табачная продукция", "Короб"]);
    expect(
      screen.getByLabelText("Шаблон: Альтернативная табачная продукция, Короб"),
    ).toHaveProperty("value", BOX_100.id);
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await screen.findByText("Изменения сохранены.");
    expect(fake.api.updateTemplateDefaults.mock.calls[0]?.[1].categories).toStrictEqual([
      ...FULL_WATER.categories,
      { chzProductGroupCode: 3, purpose: "box", templateId: BOX_100.id },
    ]);
  });

  it("asks for the category, the purpose and the template before adding, says when no template fits, and «Отмена» adds nothing", async () => {
    await openDefaults(session());
    const add = openAdd();
    fireEvent.click(within(add).getByRole("button", { name: "Добавить" }));
    expect(await within(add).findByText("Выберите категорию")).toBeTruthy();
    expect(within(add).getByText("Выберите назначение")).toBeTruthy();
    expect(within(add).getByText("Выберите шаблон")).toBeTruthy();
    expect(screen.getByLabelText("Категория").getAttribute("aria-describedby")).toBe(
      within(add).getByText("Выберите категорию").id,
    );
    choose("Категория", "3");
    expect(within(add).queryByText("Выберите категорию")).toBeNull();
    choose("Назначение", "product_duplicate");
    expect(choices("Шаблон")).toEqual(["Не выбран", "Дубликат [Полное]"]);
    // A category and a purpose without a template is not enough either.
    fireEvent.click(within(add).getByRole("button", { name: "Добавить" }));
    expect(await within(add).findByText("Выберите шаблон")).toBeTruthy();
    expect(within(add).queryByText("Выберите назначение")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Умолчание категории" })).toBeTruthy();
    expect(
      within(add).queryByText("Нет включённых шаблонов этого назначения для этой категории."),
    ).toBeNull();
    fireEvent.click(within(add).getByRole("button", { name: "Отмена" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(rows()).toEqual([["Молочная продукция", "Короб"]]);
    expect(screen.queryByText(DIRTY)).toBeNull();
  });

  it("says when no template fits the category and purpose chosen", async () => {
    const fake = session();
    fake.api.listTemplates.mockResolvedValue(
      TEMPLATES.map((each) => (each.id === DUPLICATE.id ? { ...each, enabled: false } : each)),
    );
    await openDefaults(fake);
    const add = openAdd();
    choose("Категория", "3");
    choose("Назначение", "product_duplicate");
    expect(choices("Шаблон")).toEqual(["Не выбран"]);
    expect(
      within(add).getByText("Нет включённых шаблонов этого назначения для этой категории."),
    ).toBeTruthy();
  });

  it("puts a refused category default under its row, found by the order the page sent and not the order it shows, and takes the message away when that row changes", async () => {
    const fake = session();
    await openDefaults(fake);
    const add = openAdd();
    choose("Категория", "3");
    choose("Назначение", "box");
    choose("Шаблон", BOX_100.id);
    fireEvent.click(within(add).getByRole("button", { name: "Добавить" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Sent: «Молочная продукция» first, then the added one; shown: the added one first.
    expect(rows()).toEqual([
      ["Альтернативная табачная продукция", "Короб"],
      ["Молочная продукция", "Короб"],
    ]);
    const added = "Шаблон: Альтернативная табачная продукция, Короб";
    for (const [field, message] of [
      ["categories.1.templateId", UNFIT],
      ["categories.1.chzProductGroupCode", "Хост не принял эту категорию."],
      ["categories.1", "Это умолчание задано дважды."],
    ] as const) {
      fake.api.updateTemplateDefaults.mockRejectedValueOnce(
        hostError("validation_failed", 400, { field }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
      const shown = await screen.findByText(message);
      expect(screen.getByLabelText(added).getAttribute("aria-describedby")).toBe(shown.id);
      expect(
        screen.getByLabelText("Шаблон: Молочная продукция, Короб").hasAttribute("aria-describedby"),
      ).toBe(false);
    }
    choose(added, BOX.id);
    expect(screen.queryByText("Это умолчание задано дважды.")).toBeNull();
    fake.api.updateTemplateDefaults.mockRejectedValueOnce(
      hostError("validation_failed", 400, { field: "categories.0.templateId" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    const shown = await screen.findByText(UNFIT);
    expect(
      screen.getByLabelText("Шаблон: Молочная продукция, Короб").getAttribute("aria-describedby"),
    ).toBe(shown.id);
    // Another row's change or removal leaves the message; its own row's removal takes it away.
    choose(added, BOX_100.id);
    expect(screen.getByText(UNFIT)).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Убрать умолчание: Альтернативная табачная продукция, Короб",
      }),
    );
    expect(screen.getByText(UNFIT)).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Убрать умолчание: Молочная продукция, Короб" }),
    );
    expect(screen.queryByText(UNFIT)).toBeNull();
  });

  it("names the categories by their codes while the groups do not load, keeps adding off, and reads them again", async () => {
    const fake = session();
    fake.api.listProductGroups.mockRejectedValueOnce(
      new HostError({ kind: "transport", code: "unreachable", message: "down" }),
    );
    await openDefaults(fake);
    expect(
      await screen.findByText(
        "Справочник товарных групп не загрузился: вместо названий категорий видны коды, а умолчание категории сейчас не добавить.",
      ),
    ).toBeTruthy();
    expect(rows()).toEqual([["Код 8", "Короб"]]);
    expect(screen.getByRole("button", { name: "Добавить умолчание категории" })).toHaveProperty(
      "disabled",
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await waitFor(() => expect(rows()).toEqual([["Молочная продукция", "Короб"]]));
    expect(screen.getByRole("button", { name: "Добавить умолчание категории" })).toHaveProperty(
      "disabled",
      false,
    );
  });

  it("keeps «Добавить умолчание категории» off while the templates do not load", async () => {
    const fake = session();
    fake.api.listTemplates.mockRejectedValueOnce(
      new HostError({ kind: "transport", code: "unreachable", message: "down" }),
    );
    renderOffice(fake);
    fireEvent.click(await screen.findByRole("link", { name: "Умолчания шаблонов" }));
    await screen.findByText("Список шаблонов не загрузился: умолчания сейчас не изменить.");
    const add = screen.getByRole("button", { name: "Добавить умолчание категории" });
    expect(add).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await waitFor(() => expect(add).toHaveProperty("disabled", false));
  });
});

// Beyond the plan: each test below kills a one-line mutant the plan's tests let live.
describe("office template defaults: the organization's, beyond the plan", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  it("shows the organization's card as a second-level heading, «Сохранить» as the primary button and «Отменить изменения» as a secondary one", async () => {
    await openDefaults(session());
    expect(screen.getByRole("heading", { name: "Для организации", level: 2 })).toBeTruthy();
    const save = screen.getByRole("button", { name: "Сохранить" });
    expect(save.classList.contains("mk-btn--primary")).toBe(true);
    const cancel = screen.getByRole("button", { name: "Отменить изменения" });
    expect(cancel.classList.contains("mk-btn--secondary")).toBe(true);
  });

  it("shows that the document is loading, with no form, until it arrives", async () => {
    const fake = session();
    let release: (document: TemplateDefaults) => void = () => undefined;
    fake.api.getTemplateDefaults.mockReturnValue(
      new Promise<TemplateDefaults>((resolve) => {
        release = resolve;
      }),
    );
    renderOffice(fake);
    fireEvent.click(await screen.findByRole("link", { name: "Умолчания шаблонов" }));
    expect(await screen.findByText("Загрузка…")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Для организации" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Сохранить" })).toBeNull();
    await act(async () => {
      release(DEFAULTS);
    });
    expect(await screen.findByRole("heading", { name: "Для организации" })).toBeTruthy();
    expect(screen.queryByText("Загрузка…")).toBeNull();
  });

  it("takes away a refusal under a select, and a failure above the form, when «Отменить изменения» brings the document back", async () => {
    const fake = session();
    fake.api.updateTemplateDefaults
      .mockRejectedValueOnce(hostError("validation_failed", 400, { field: "defaultBoxTemplateId" }))
      .mockRejectedValueOnce(hostError("internal", 500));
    await openDefaults(fake);
    choose("Шаблон короба", BOX_100.id);
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await screen.findByText(UNFIT);
    fireEvent.click(screen.getByRole("button", { name: "Отменить изменения" }));
    expect(screen.queryByText(UNFIT)).toBeNull();
    expect(screen.getByLabelText("Шаблон короба")).toHaveProperty("value", BOX.id);
    expect(screen.getByLabelText("Шаблон короба").getAttribute("aria-invalid")).toBeNull();
    choose("Шаблон паллеты", PALLET_58.id);
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await screen.findByText("На хосте произошла ошибка. Повторите попытку.");
    fireEvent.click(screen.getByRole("button", { name: "Отменить изменения" }));
    expect(screen.queryByText("На хосте произошла ошибка. Повторите попытку.")).toBeNull();
    expect(screen.getByLabelText("Шаблон паллеты")).toHaveProperty("value", PALLET.id);
  });

  it("does not read the templates again after a 500 or after a stale save", async () => {
    const fake = session();
    fake.api.updateTemplateDefaults
      .mockRejectedValueOnce(hostError("internal", 500))
      .mockRejectedValueOnce(hostError("stale_revision", 409, { currentRev: 66 }));
    await openDefaults(fake);
    choose("Шаблон короба", BOX_100.id);
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await screen.findByText("На хосте произошла ошибка. Повторите попытку.");
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await screen.findByText(
      "Умолчания или профиль организации изменились, пока вы их правили. Загрузите умолчания заново — ваши правки пропадут.",
    );
    await settle();
    expect(fake.api.updateTemplateDefaults).toHaveBeenCalledTimes(2);
    expect(fake.api.listTemplates).toHaveBeenCalledTimes(1);
  });

  it("keeps the webview from submitting the form itself", async () => {
    const fake = session();
    fake.api.updateTemplateDefaults.mockResolvedValue({
      ...DEFAULTS,
      defaultBoxTemplateId: BOX_100.id,
      rev: 65,
    });
    await openDefaults(fake);
    choose("Шаблон короба", BOX_100.id);
    // The page's handler runs before the event reaches the document: a submit
    // left unprevented would make the webview navigate away from the office.
    const prevented: boolean[] = [];
    const record = (event: Event) => {
      prevented.push(event.defaultPrevented);
    };
    document.addEventListener("submit", record);
    try {
      fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
      expect(await screen.findByText("Изменения сохранены.")).toBeTruthy();
    } finally {
      document.removeEventListener("submit", record);
    }
    expect(prevented).toEqual([true]);
  });

  it("keeps «Отменить изменения» off while the save is on its way", async () => {
    const fake = session();
    let release: (document: TemplateDefaults) => void = () => undefined;
    fake.api.updateTemplateDefaults.mockReturnValue(
      new Promise<TemplateDefaults>((resolve) => {
        release = resolve;
      }),
    );
    await openDefaults(fake);
    choose("Шаблон короба", BOX_100.id);
    const cancel = screen.getByRole("button", { name: "Отменить изменения" });
    expect(cancel).toHaveProperty("disabled", false);
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(cancel).toHaveProperty("disabled", true));
    await act(async () => {
      release({ ...DEFAULTS, defaultBoxTemplateId: BOX_100.id, rev: 65 });
    });
    expect(await screen.findByText("Изменения сохранены.")).toBeTruthy();
  });

  it("keeps one live region for the note about unsaved changes: empty while nothing changed, the same element once something did", async () => {
    await openDefaults(session());
    const note = screen
      .getByRole("button", { name: "Сохранить" })
      .closest(".standalone-form__actions")
      ?.querySelector(".office-note");
    if (note === null || note === undefined) throw new Error("the note about unsaved changes");
    expect(note.getAttribute("aria-live")).toBe("polite");
    expect(note.textContent).toBe("");
    choose("Шаблон паллеты", PALLET_58.id);
    expect(screen.getByText(DIRTY)).toBe(note);
    choose("Шаблон паллеты", PALLET.id);
    expect(note.textContent).toBe("");
    expect(note.isConnected).toBe(true);
  });

  it("keeps the choices off while the templates are loading, shows the loaded default by its id, and turns them on once the list is there", async () => {
    const fake = session();
    let release: (templates: LabelTemplateSummary[]) => void = () => undefined;
    fake.api.listTemplates.mockReturnValue(
      new Promise<LabelTemplateSummary[]>((resolve) => {
        release = resolve;
      }),
    );
    renderOffice(fake);
    fireEvent.click(await screen.findByRole("link", { name: "Умолчания шаблонов" }));
    await screen.findByRole("heading", { name: "Для организации" });
    for (const label of ["Шаблон короба", "Шаблон паллеты", "Шаблон дубликата товара"]) {
      expect(screen.getByLabelText(label), label).toHaveProperty("disabled", true);
    }
    expect(choices("Шаблон короба")).toEqual(["Не выбран", "Шаблон 7c1e4b2a…"]);
    expect(
      screen.queryByText("Список шаблонов не загрузился: умолчания сейчас не изменить."),
    ).toBeNull();
    expect(
      await screen.findByRole("button", { name: "Убрать умолчание: Молочная продукция, Короб" }),
    ).toHaveProperty("disabled", true);
    await act(async () => {
      release(TEMPLATES);
    });
    await waitFor(() =>
      expect(screen.getByLabelText("Шаблон короба")).toHaveProperty("disabled", false),
    );
    expect(choices("Шаблон короба")).toEqual(["Не выбран", "Коробка 58×40", "Коробка 100×100"]);
    expect(
      screen.getByRole("button", { name: "Убрать умолчание: Молочная продукция, Короб" }),
    ).toHaveProperty("disabled", false);
  });

  it("keeps a loaded default the list does not offer as a marked choice when another template is chosen, and lets the user take it back", async () => {
    await openDefaults(session({ ...DEFAULTS, defaultBoxTemplateId: OLD.id }));
    choose("Шаблон короба", BOX_100.id);
    expect(screen.getByLabelText("Шаблон короба")).toHaveProperty("value", BOX_100.id);
    expect(choices("Шаблон короба")).toEqual([
      "Не выбран",
      "Коробка 58×40",
      "Коробка 100×100",
      "Старая коробка — не подходит",
    ]);
    choose("Шаблон короба", OLD.id);
    expect(screen.getByLabelText("Шаблон короба")).toHaveProperty("value", OLD.id);
    expect(screen.queryByText(DIRTY)).toBeNull();
  });

  it("marks the template a refusal names as one that no longer fits once the list is read again, and keeps the choice", async () => {
    const fake = session();
    fake.api.listTemplates
      .mockResolvedValueOnce(TEMPLATES)
      .mockResolvedValue(
        TEMPLATES.map((template) =>
          template.id === BOX_100.id ? { ...template, enabled: false } : template,
        ),
      );
    fake.api.updateTemplateDefaults.mockRejectedValueOnce(
      hostError("validation_failed", 400, { field: "defaultBoxTemplateId" }),
    );
    await openDefaults(fake);
    choose("Шаблон короба", BOX_100.id);
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await screen.findByText(UNFIT);
    await waitFor(() =>
      expect(choices("Шаблон короба")).toEqual([
        "Не выбран",
        "Коробка 58×40",
        "Коробка 100×100 — не подходит",
      ]),
    );
    expect(screen.getByLabelText("Шаблон короба")).toHaveProperty("value", BOX_100.id);
  });

  it("shows template names with markup characters as plain text in the choices and in the mark of a default that no longer fits", async () => {
    // `t()` does not escape what it interpolates (`escapeValue: false`): a name is shown as a React child, never as HTML.
    const name = '<b>Тест</b> & "кавычки"';
    const gone = '<i>Старый</i> & "x"';
    const odd = summary("3c7e0b8a-5d9f-4e1a-8b2c-7d8e9f0a1b2c", name, { stock: false });
    const old = summary("4d8f1c9b-6e0a-4f2b-9c3d-8e9f0a1b2c3d", gone, {
      stock: false,
      enabled: false,
    });
    const fake = session({ ...DEFAULTS, defaultBoxTemplateId: old.id });
    fake.api.listTemplates.mockResolvedValue([BOX, odd, old]);
    await openDefaults(fake);
    expect(choices("Шаблон короба")).toContain(name);
    expect(choices("Шаблон короба")).toContain(`${gone} — не подходит`);
    expect(screen.getByLabelText("Шаблон короба").querySelector("b, i")).toBeNull();
    expect(screen.getByLabelText("Шаблон короба")).toHaveProperty("value", old.id);
  });

  it("shows the warning about the template list as a warning and the notice of a save as a success", async () => {
    const fake = session();
    fake.api.listTemplates.mockRejectedValueOnce(
      new HostError({ kind: "transport", code: "unreachable", message: "down" }),
    );
    fake.api.updateTemplateDefaults.mockResolvedValue({
      ...DEFAULTS,
      defaultBoxTemplateId: BOX_100.id,
      rev: 65,
    });
    renderOffice(fake);
    fireEvent.click(await screen.findByRole("link", { name: "Умолчания шаблонов" }));
    const warning = await screen.findByText(
      "Список шаблонов не загрузился: умолчания сейчас не изменить.",
    );
    expect(warning.closest(".mk-alert")?.classList.contains("mk-alert--warn")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Шаблон короба")).toHaveProperty("disabled", false),
    );
    choose("Шаблон короба", BOX_100.id);
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    const notice = await screen.findByText("Изменения сохранены.");
    expect(notice.closest(".mk-alert")?.classList.contains("mk-alert--ok")).toBe(true);
  });

  it("keeps the notice of a save while the next edits are made, and reads neither the document nor the templates again", async () => {
    const fake = session();
    fake.api.updateTemplateDefaults.mockResolvedValue({
      ...DEFAULTS,
      defaultBoxTemplateId: BOX_100.id,
      rev: 65,
    });
    await openDefaults(fake);
    choose("Шаблон короба", BOX_100.id);
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Изменения сохранены.")).toBeTruthy();
    choose("Шаблон паллеты", PALLET_58.id);
    expect(screen.getByText("Изменения сохранены.")).toBeTruthy();
    expect(screen.getByText(DIRTY)).toBeTruthy();
    await settle();
    expect(fake.api.getTemplateDefaults).toHaveBeenCalledTimes(1);
    expect(fake.api.listTemplates).toHaveBeenCalledTimes(1);
  });
});

// Beyond the plan: each test below kills a one-line mutant the plan's tests let live.
describe("office template defaults: the categories', beyond the plan", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  const ADD = "Добавить умолчание категории";
  const MILK_ROW = "Шаблон: Молочная продукция, Короб";
  const NO_FIT = "Нет включённых шаблонов этого назначения для этой категории.";

  /** The four defaults of the plan's list test, in an order unlike the one the page shows. */
  const FOUR_DEFAULTS: TemplateDefaults = {
    ...DEFAULTS,
    categories: [
      { chzProductGroupCode: 13, purpose: "product_duplicate", templateId: DUPLICATE.id },
      { chzProductGroupCode: 8, purpose: "box", templateId: MILK.id },
      { chzProductGroupCode: 13, purpose: "pallet", templateId: PALLET.id },
      { chzProductGroupCode: 13, purpose: "box", templateId: BOX.id },
    ],
  };

  /** The category and purpose of each row of the table, as it shows them. */
  function shown(): (string | null)[][] {
    return within(screen.getByRole("region", { name: "Для категорий" }))
      .getAllByRole("row")
      .slice(1)
      .map((row) =>
        within(row)
          .getAllByRole("cell")
          .slice(0, 2)
          .map((cell) => cell.textContent),
      );
  }

  /** Opens the dialog of a new category default. */
  function openDialog(): HTMLElement {
    fireEvent.click(screen.getByRole("button", { name: ADD }));
    return screen.getByRole("dialog", { name: "Умолчание категории" });
  }

  /** «Отмена» in the dialog, and the wait until it is gone. */
  async function closeDialog(dialog: HTMLElement): Promise<void> {
    fireEvent.click(within(dialog).getByRole("button", { name: "Отмена" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  }

  it("orders the rows, and the categories on offer for a new default, by name with numbers by value, and not by code or by the lookup's order", async () => {
    const groups: ProductGroup[] = [
      { code: 8, alias: "apples", name: "Яблоки" },
      { code: 13, alias: "melons", name: "Арбузы" },
      { code: 3, alias: "ten", name: "Группа 10" },
      { code: 21, alias: "two", name: "Группа 2" },
      { code: 5, alias: "quinces", name: "Дыни" },
    ];
    const fake = session({
      ...DEFAULTS,
      categories: [8, 13, 3, 21].map((code) => ({
        chzProductGroupCode: code,
        purpose: "box" as const,
        templateId: BOX.id,
      })),
    });
    fake.api.listProductGroups.mockResolvedValue(groups);
    await openDefaults(fake);
    await waitFor(() =>
      expect(shown().map((row) => row[0])).toEqual(["Арбузы", "Группа 2", "Группа 10", "Яблоки"]),
    );
    openDialog();
    expect(choices("Категория")).toEqual([
      "Не выбрана",
      "Арбузы",
      "Группа 2",
      "Группа 10",
      "Дыни",
      "Яблоки",
    ]);
  });

  it("shows the card as a second-level heading over a table of four named columns, «Убрать» in its own words, a tag of its tone for each purpose, a wrapping category column, a secondary «Добавить умолчание категории» button, and no dialog until one is asked for", async () => {
    await openDefaults(session(FOUR_DEFAULTS));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("heading", { name: "Для категорий", level: 2 })).toBeTruthy();
    const table = within(screen.getByRole("region", { name: "Для категорий" }));
    expect(table.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "Категория",
      "Назначение",
      "Шаблон",
      "Действия",
    ]);
    const remove = await table.findByRole("button", {
      name: "Убрать умолчание: Молочная продукция, Короб",
    });
    expect(remove.textContent).toBe("Убрать");
    // A long category name wraps; the purpose cell next to it stays on one line.
    expect(table.getAllByRole("cell")[0]?.style.whiteSpace).toBe("normal");
    expect(table.getAllByRole("cell")[1]?.style.whiteSpace).toBe("nowrap");
    for (const [purpose, tone, count] of [
      ["Короб", "violet", 2],
      ["Паллета", "magenta", 1],
      ["Дубликат товара", "teal", 1],
    ] as const) {
      const tags = table.getAllByText(purpose);
      expect(tags, purpose).toHaveLength(count);
      for (const tag of tags)
        expect(tag.classList.contains(`mk-badge--${tone}`), purpose).toBe(true);
    }
    expect(screen.getByRole("button", { name: ADD }).classList.contains("mk-btn--secondary")).toBe(
      true,
    );
  });

  it("shows both office roles the enabled add button, row choice and «Убрать» of the category defaults", async () => {
    for (const user of [TECHNOLOGIST, { ...TECHNOLOGIST, role: "admin" as const }]) {
      const view = renderOffice(session(DEFAULTS, user));
      fireEvent.click(await screen.findByRole("link", { name: "Умолчания шаблонов" }));
      const add = await screen.findByRole("button", { name: ADD });
      await waitFor(() => expect(add).toHaveProperty("disabled", false));
      expect(
        await screen.findByRole("button", { name: "Убрать умолчание: Молочная продукция, Короб" }),
      ).toHaveProperty("disabled", false);
      expect(screen.getByLabelText(MILK_ROW)).toHaveProperty("disabled", false);
      view.unmount();
    }
  });

  it("keeps adding and the rows' choices off while the groups and the templates are loading, shows a row by its code and template id meanwhile, and turns them on as the lists arrive", async () => {
    const fake = session();
    let releaseTemplates: (templates: LabelTemplateSummary[]) => void = () => undefined;
    let releaseGroups: (groups: ProductGroup[]) => void = () => undefined;
    fake.api.listTemplates.mockReturnValue(
      new Promise<LabelTemplateSummary[]>((resolve) => {
        releaseTemplates = resolve;
      }),
    );
    fake.api.listProductGroups.mockReturnValue(
      new Promise<ProductGroup[]>((resolve) => {
        releaseGroups = resolve;
      }),
    );
    renderOffice(fake);
    fireEvent.click(await screen.findByRole("link", { name: "Умолчания шаблонов" }));
    await screen.findByRole("heading", { name: "Для категорий" });
    const add = screen.getByRole("button", { name: ADD });
    expect(add).toHaveProperty("disabled", true);
    expect(shown()).toEqual([["Код 8", "Короб"]]);
    const stored = "Шаблон: Код 8, Короб";
    expect(screen.getByLabelText(stored)).toHaveProperty("disabled", true);
    expect(choices(stored)).toEqual([`Шаблон ${MILK.id.slice(0, 8)}…`]);
    // Loading is not failing: neither lookup is reported as lost.
    expect(screen.queryByText(/не загрузился/)).toBeNull();
    await act(async () => {
      releaseTemplates(TEMPLATES);
    });
    await waitFor(() => expect(screen.getByLabelText(stored)).toHaveProperty("disabled", false));
    expect(add).toHaveProperty("disabled", true);
    await act(async () => {
      releaseGroups(GROUPS);
    });
    await waitFor(() => expect(add).toHaveProperty("disabled", false));
    expect(shown()).toEqual([["Молочная продукция", "Короб"]]);
  });

  it("turns the purpose on once a category is chosen and the template once a purpose is, off again when the choice is taken back, and speaks of no fitting template only after one was looked for", async () => {
    await openDefaults(session());
    const dialog = openDialog();
    expect(screen.getByLabelText("Назначение")).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("Шаблон")).toHaveProperty("disabled", true);
    expect(within(dialog).queryByText(NO_FIT)).toBeNull();
    choose("Категория", "3");
    expect(screen.getByLabelText("Назначение")).toHaveProperty("disabled", false);
    expect(screen.getByLabelText("Шаблон")).toHaveProperty("disabled", true);
    expect(within(dialog).queryByText(NO_FIT)).toBeNull();
    choose("Назначение", "box");
    expect(screen.getByLabelText("Шаблон")).toHaveProperty("disabled", false);
    expect(within(dialog).queryByText(NO_FIT)).toBeNull();
    // Taking a choice back turns the field after it off again.
    choose("Назначение", "");
    expect(screen.getByLabelText("Шаблон")).toHaveProperty("disabled", true);
    choose("Категория", "");
    expect(screen.getByLabelText("Назначение")).toHaveProperty("disabled", true);
  });

  it("takes an error away as soon as its field, or the field before it, changes, and not before", async () => {
    await openDefaults(session());
    const dialog = openDialog();
    const submit = within(dialog).getByRole("button", { name: "Добавить" });
    const asked = () =>
      ["Выберите категорию", "Выберите назначение", "Выберите шаблон"].map(
        (text) => within(dialog).queryByText(text) !== null,
      );
    fireEvent.click(submit);
    await within(dialog).findByText("Выберите шаблон");
    expect(asked()).toEqual([true, true, true]);
    // A new category starts the purpose and the template afresh: the next «Добавить» asks again.
    choose("Категория", "3");
    expect(asked()).toEqual([false, false, false]);
    fireEvent.click(submit);
    await within(dialog).findByText("Выберите шаблон");
    expect(asked()).toEqual([false, true, true]);
    choose("Назначение", "box");
    expect(asked()).toEqual([false, false, false]);
    fireEvent.click(submit);
    await within(dialog).findByText("Выберите шаблон");
    expect(asked()).toEqual([false, false, true]);
    choose("Шаблон", BOX_100.id);
    expect(asked()).toEqual([false, false, false]);
  });

  it("drops the template when the purpose changes, and the purpose and the template when the category does, so nothing chosen for another slot is added", async () => {
    await openDefaults(session());
    const dialog = openDialog();
    choose("Категория", "8");
    choose("Назначение", "pallet");
    choose("Шаблон", PALLET_58.id);
    choose("Назначение", "product_duplicate");
    fireEvent.click(within(dialog).getByRole("button", { name: "Добавить" }));
    expect(await within(dialog).findByText("Выберите шаблон")).toBeTruthy();
    choose("Шаблон", DUPLICATE.id);
    choose("Категория", "3");
    fireEvent.click(within(dialog).getByRole("button", { name: "Добавить" }));
    expect(await within(dialog).findByText("Выберите назначение")).toBeTruthy();
    expect(within(dialog).getByText("Выберите шаблон")).toBeTruthy();
    await closeDialog(dialog);
    expect(shown()).toEqual([["Молочная продукция", "Короб"]]);
    expect(screen.queryByText(DIRTY)).toBeNull();
  });

  it("offers the slots the page holds now and not the loaded ones, keeps the other rows' elements when one is added, and «Отменить изменения» brings the loaded ones back", async () => {
    await openDefaults(session());
    const milk = await screen.findByLabelText(MILK_ROW);
    let dialog = openDialog();
    choose("Категория", "3");
    choose("Назначение", "pallet");
    choose("Шаблон", PALLET_58.id);
    fireEvent.click(within(dialog).getByRole("button", { name: "Добавить" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(shown()).toEqual([
      ["Альтернативная табачная продукция", "Паллета"],
      ["Молочная продукция", "Короб"],
    ]);
    // The row that was already there keeps its element, so the focus stays where the user left it.
    expect(screen.getByLabelText(MILK_ROW)).toBe(milk);
    // A default added here is no longer offered...
    dialog = openDialog();
    choose("Категория", "3");
    expect(choices("Назначение")).toEqual(["Не выбрано", "Короб", "Дубликат товара"]);
    await closeDialog(dialog);
    // ...and one removed here is offered again.
    fireEvent.click(
      screen.getByRole("button", { name: "Убрать умолчание: Молочная продукция, Короб" }),
    );
    dialog = openDialog();
    choose("Категория", "8");
    expect(choices("Назначение")).toEqual(["Не выбрано", "Короб", "Паллета", "Дубликат товара"]);
    await closeDialog(dialog);
    fireEvent.click(screen.getByRole("button", { name: "Отменить изменения" }));
    expect(shown()).toEqual([["Молочная продукция", "Короб"]]);
    expect(screen.queryByText(DIRTY)).toBeNull();
    openDialog();
    choose("Категория", "8");
    expect(choices("Назначение")).toEqual(["Не выбрано", "Паллета", "Дубликат товара"]);
    choose("Категория", "3");
    expect(choices("Назначение")).toEqual(["Не выбрано", "Короб", "Паллета", "Дубликат товара"]);
  });

  it("sends an empty list when the last category default is removed, which clears it on the host, and says there are none", async () => {
    const fake = session();
    fake.api.updateTemplateDefaults.mockResolvedValue({ ...DEFAULTS, categories: [], rev: 70 });
    await openDefaults(fake);
    fireEvent.click(
      await screen.findByRole("button", { name: "Убрать умолчание: Молочная продукция, Короб" }),
    );
    expect(screen.getByText("Умолчаний категорий нет.")).toBeTruthy();
    expect(screen.getByText(DIRTY)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await screen.findByText("Изменения сохранены.");
    expect(fake.api.updateTemplateDefaults.mock.calls).toStrictEqual([
      [
        "office-session-token",
        {
          defaultBoxTemplateId: BOX.id,
          defaultPalletTemplateId: PALLET.id,
          defaultDuplicateTemplateId: null,
          categories: [],
          expectedRev: 64,
        },
      ],
    ]);
    expect(screen.getByText("Умолчаний категорий нет.")).toBeTruthy();
  });

  it("keeps a loaded category default the list does not offer as a marked choice, also when another template is chosen, and lets the user take it back", async () => {
    await openDefaults(
      session({
        ...DEFAULTS,
        categories: [{ chzProductGroupCode: 8, purpose: "box", templateId: OLD.id }],
      }),
    );
    await screen.findByLabelText(MILK_ROW);
    expect(choices(MILK_ROW)).toEqual([
      "Коробка 58×40",
      "Коробка 100×100",
      "Молоко 58×40",
      "Старая коробка — не подходит",
    ]);
    expect(screen.getByLabelText(MILK_ROW)).toHaveProperty("value", OLD.id);
    choose(MILK_ROW, BOX_100.id);
    expect(choices(MILK_ROW)).toContain("Старая коробка — не подходит");
    expect(screen.getByLabelText(MILK_ROW)).toHaveProperty("value", BOX_100.id);
    choose(MILK_ROW, OLD.id);
    expect(screen.getByLabelText(MILK_ROW)).toHaveProperty("value", OLD.id);
    expect(screen.queryByText(DIRTY)).toBeNull();
  });

  it("marks the template a refused category default names as one that no longer fits once the list is read again, and keeps the choice under the message", async () => {
    const fake = session();
    fake.api.listTemplates
      .mockResolvedValueOnce(TEMPLATES)
      .mockResolvedValue(
        TEMPLATES.map((template) =>
          template.id === BOX_100.id ? { ...template, enabled: false } : template,
        ),
      );
    fake.api.updateTemplateDefaults.mockRejectedValueOnce(
      hostError("validation_failed", 400, { field: "categories.0.templateId" }),
    );
    await openDefaults(fake);
    await screen.findByLabelText(MILK_ROW);
    choose(MILK_ROW, BOX_100.id);
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    const message = await screen.findByText(UNFIT);
    await waitFor(() =>
      expect(choices(MILK_ROW)).toEqual([
        "Коробка 58×40",
        "Молоко 58×40",
        "Коробка 100×100 — не подходит",
      ]),
    );
    expect(screen.getByLabelText(MILK_ROW)).toHaveProperty("value", BOX_100.id);
    expect(screen.getByLabelText(MILK_ROW).getAttribute("aria-describedby")).toBe(message.id);
  });

  it("shows group and template names with markup characters as plain text in the rows and in the dialog", async () => {
    // `t()` does not escape what it interpolates (`escapeValue: false`): a name reaches the page
    // only as a React child or an attribute value, never as HTML.
    const category = '<b>Группа</b> & "x"';
    const other = "<i>Вторая</i> & 'y'";
    const template = '<u>Шаблон</u> & "z"';
    const odd = summary("3c7e0b8a-5d9f-4e1a-8b2c-7d8e9f0a1b2c", template, { stock: false });
    const fake = session({
      ...DEFAULTS,
      categories: [{ chzProductGroupCode: 8, purpose: "box", templateId: odd.id }],
    });
    fake.api.listProductGroups.mockResolvedValue([
      { code: 8, alias: "milk", name: category },
      { code: 13, alias: "water", name: other },
    ]);
    fake.api.listTemplates.mockResolvedValue([BOX, odd]);
    await openDefaults(fake);
    const row = await screen.findByLabelText(`Шаблон: ${category}, Короб`);
    expect(choices(`Шаблон: ${category}, Короб`)).toContain(template);
    expect(row.querySelector("u")).toBeNull();
    const table = within(screen.getByRole("region", { name: "Для категорий" }));
    const cell = table.getAllByRole("cell")[0];
    expect(cell?.textContent).toBe(category);
    expect(cell?.querySelector("b")).toBeNull();
    expect(
      table.getByRole("button", { name: `Убрать умолчание: ${category}, Короб` }),
    ).toBeTruthy();
    const dialog = openDialog();
    expect(choices("Категория")).toContain(category);
    expect(choices("Категория")).toContain(other);
    choose("Категория", "13");
    choose("Назначение", "box");
    expect(choices("Шаблон")).toContain(template);
    expect(dialog.querySelector("b, i, u")).toBeNull();
  });

  it("shows the warning about the group lookup as a warning, and its «Повторить» reads the groups and nothing else", async () => {
    const fake = session();
    fake.api.listProductGroups.mockRejectedValueOnce(
      new HostError({ kind: "transport", code: "unreachable", message: "down" }),
    );
    await openDefaults(fake);
    const warning = await screen.findByText(
      "Справочник товарных групп не загрузился: вместо названий категорий видны коды, а умолчание категории сейчас не добавить.",
    );
    expect(warning.closest(".mk-alert")?.classList.contains("mk-alert--warn")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await waitFor(() => expect(shown()).toEqual([["Молочная продукция", "Короб"]]));
    expect(screen.queryByText(/не загрузился/)).toBeNull();
    await settle();
    expect(fake.api.listProductGroups).toHaveBeenCalledTimes(2);
    expect(fake.api.listTemplates).toHaveBeenCalledTimes(1);
  });

  it("saves one document: an organization default, a changed row, an added one and a removed one go together, the rows in the order the page holds them", async () => {
    const fake = session(FOUR_DEFAULTS);
    fake.api.updateTemplateDefaults.mockResolvedValue({ ...FOUR_DEFAULTS, rev: 70 });
    await openDefaults(fake);
    await screen.findByLabelText(MILK_ROW);
    choose("Шаблон паллеты", PALLET_58.id);
    choose(MILK_ROW, BOX.id);
    fireEvent.click(
      screen.getByRole("button", { name: "Убрать умолчание: Упакованная вода, Дубликат товара" }),
    );
    const dialog = openDialog();
    choose("Категория", "3");
    choose("Назначение", "box");
    choose("Шаблон", BOX_100.id);
    fireEvent.click(within(dialog).getByRole("button", { name: "Добавить" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await screen.findByText("Изменения сохранены.");
    expect(fake.api.updateTemplateDefaults.mock.calls).toStrictEqual([
      [
        "office-session-token",
        {
          defaultBoxTemplateId: BOX.id,
          defaultPalletTemplateId: PALLET_58.id,
          defaultDuplicateTemplateId: null,
          categories: [
            { chzProductGroupCode: 8, purpose: "box", templateId: BOX.id },
            { chzProductGroupCode: 13, purpose: "pallet", templateId: PALLET.id },
            { chzProductGroupCode: 13, purpose: "box", templateId: BOX.id },
            { chzProductGroupCode: 3, purpose: "box", templateId: BOX_100.id },
          ],
          expectedRev: 64,
        },
      ],
    ]);
  });
});

// The final fix wave: the lock while a save is on its way, and where focus goes.
describe("office template defaults: the final fixes", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  const ADD = "Добавить умолчание категории";
  const MILK_ROW = "Шаблон: Молочная продукция, Короб";
  const REMOVE_MILK = "Убрать умолчание: Молочная продукция, Короб";
  const NO_FIT = "Нет включённых шаблонов этого назначения для этой категории.";

  /** Four defaults in three rows' worth of neighbours: shown as milk box, water box, water pallet, water duplicate. */
  const FOUR: TemplateDefaults = {
    ...DEFAULTS,
    categories: [
      { chzProductGroupCode: 13, purpose: "product_duplicate", templateId: DUPLICATE.id },
      { chzProductGroupCode: 8, purpose: "box", templateId: MILK.id },
      { chzProductGroupCode: 13, purpose: "pallet", templateId: PALLET.id },
      { chzProductGroupCode: 13, purpose: "box", templateId: BOX.id },
    ],
  };

  const remove = (name: string) =>
    screen.getByRole("button", { name: `Убрать умолчание: ${name}` });

  /** Every control of the page that changes the document, except «Сохранить». */
  function controls(): [string, HTMLElement][] {
    return [
      ["the box select", screen.getByLabelText("Шаблон короба")],
      ["the pallet select", screen.getByLabelText("Шаблон паллеты")],
      ["the duplicate select", screen.getByLabelText("Шаблон дубликата товара")],
      ["the row's select", screen.getByLabelText(MILK_ROW)],
      ["«Убрать»", screen.getByRole("button", { name: REMOVE_MILK })],
      ["«Добавить умолчание категории»", screen.getByRole("button", { name: ADD })],
      ["«Отменить изменения»", screen.getByRole("button", { name: "Отменить изменения" })],
    ];
  }

  it("turns off every control of the page while a save is on its way, and turns them on again after a refusal and after the answer", async () => {
    const fake = session();
    let rejectSave: (error: Error) => void = () => undefined;
    let release: (document: TemplateDefaults) => void = () => undefined;
    fake.api.updateTemplateDefaults
      .mockReturnValueOnce(
        new Promise<TemplateDefaults>((_resolve, reject) => {
          rejectSave = reject;
        }),
      )
      .mockReturnValueOnce(
        new Promise<TemplateDefaults>((resolve) => {
          release = resolve;
        }),
      );
    await openDefaults(fake);
    choose("Шаблон короба", BOX_100.id);
    for (const [name, control] of controls()) {
      expect(control, name).toHaveProperty("disabled", false);
    }
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => {
      for (const [name, control] of controls())
        expect(control, name).toHaveProperty("disabled", true);
    });
    // A refusal that is no field's: the same form is back, every control on again.
    await act(async () => {
      rejectSave(hostError("internal", 500));
    });
    await screen.findByText("На хосте произошла ошибка. Повторите попытку.");
    await waitFor(() => {
      for (const [name, control] of controls()) {
        expect(control, name).toHaveProperty("disabled", false);
      }
    });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => {
      for (const [name, control] of controls())
        expect(control, name).toHaveProperty("disabled", true);
    });
    await act(async () => {
      release({ ...DEFAULTS, defaultBoxTemplateId: BOX_100.id, rev: 65 });
    });
    expect(await screen.findByText("Изменения сохранены.")).toBeTruthy();
    await waitFor(() => {
      for (const [name, control] of controls()) {
        // Nothing to cancel after a save.
        expect(control, name).toHaveProperty("disabled", name === "«Отменить изменения»");
      }
    });
  });

  it("moves focus to the next row's «Убрать» after a removal, else to the previous row's, else to «Добавить умолчание категории»", async () => {
    await openDefaults(session(FOUR));
    // Shown: milk box, water box, water pallet, water duplicate. The middle row goes: the next row's button.
    fireEvent.click(remove("Упакованная вода, Короб"));
    await waitFor(() => expect(document.activeElement).toBe(remove("Упакованная вода, Паллета")));
    // The last row goes: the previous row's.
    fireEvent.click(remove("Упакованная вода, Дубликат товара"));
    await waitFor(() => expect(document.activeElement).toBe(remove("Упакованная вода, Паллета")));
    fireEvent.click(remove("Упакованная вода, Паллета"));
    await waitFor(() => expect(document.activeElement).toBe(remove("Молочная продукция, Короб")));
    // The only row goes: nothing is left but the card's own button.
    fireEvent.click(remove("Молочная продукция, Короб"));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: ADD })),
    );
  });

  it("moves focus to the first row's neighbour below when the first row is removed", async () => {
    await openDefaults(session(FOUR));
    fireEvent.click(remove("Молочная продукция, Короб"));
    await waitFor(() => expect(document.activeElement).toBe(remove("Упакованная вода, Короб")));
  });

  it("moves focus to the organization select a refusal names, and to the row select it names, and nowhere after another failure", async () => {
    const fake = session();
    fake.api.updateTemplateDefaults
      .mockRejectedValueOnce(hostError("internal", 500))
      .mockRejectedValueOnce(
        hostError("validation_failed", 400, { field: "defaultPalletTemplateId" }),
      )
      .mockRejectedValueOnce(
        hostError("validation_failed", 400, { field: "categories.0.templateId" }),
      );
    await openDefaults(fake);
    // The office shell keeps focus on its main area after the navigation.
    const before = document.activeElement;
    choose("Шаблон короба", BOX_100.id);
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await screen.findByText("На хосте произошла ошибка. Повторите попытку.");
    await settle();
    expect(document.activeElement).toBe(before);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Сохранить" })).toHaveProperty("disabled", false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await screen.findByText(UNFIT);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText("Шаблон паллеты")),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Сохранить" })).toHaveProperty("disabled", false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(MILK_ROW)));
    expect(screen.getByLabelText(MILK_ROW).getAttribute("aria-describedby")).toBe(
      screen.getByText(UNFIT).id,
    );
  });

  it("keeps the no-fit text under «Шаблон» when «Добавить» is pressed with no template to choose, and adds no row", async () => {
    const fake = session();
    fake.api.listTemplates.mockResolvedValue(
      TEMPLATES.map((each) => (each.id === DUPLICATE.id ? { ...each, enabled: false } : each)),
    );
    await openDefaults(fake);
    fireEvent.click(screen.getByRole("button", { name: ADD }));
    const add = screen.getByRole("dialog", { name: "Умолчание категории" });
    choose("Категория", "3");
    choose("Назначение", "product_duplicate");
    expect(within(add).getByText(NO_FIT)).toBeTruthy();
    fireEvent.click(within(add).getByRole("button", { name: "Добавить" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Шаблон").getAttribute("aria-invalid")).toBe("true"),
    );
    expect(within(add).getAllByText(NO_FIT)).toHaveLength(1);
    expect(within(add).queryByText("Выберите шаблон")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Умолчание категории" })).toBeTruthy();
    expect(screen.queryByText(DIRTY)).toBeNull();
    // Without a purpose the template still has to be chosen.
    choose("Назначение", "");
    fireEvent.click(within(add).getByRole("button", { name: "Добавить" }));
    expect(await within(add).findByText("Выберите шаблон")).toBeTruthy();
  });
});
