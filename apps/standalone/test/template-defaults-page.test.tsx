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
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Шаблон короба")).toHaveProperty("disabled", false),
    );
    expect(
      screen.queryByText("Список шаблонов не загрузился: умолчания сейчас не изменить."),
    ).toBeNull();
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

  it("reads the templates again after a refused default only, not after a stale write or another failure", async () => {
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
      .closest("form")
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
    await act(async () => {
      release(TEMPLATES);
    });
    await waitFor(() =>
      expect(screen.getByLabelText("Шаблон короба")).toHaveProperty("disabled", false),
    );
    expect(choices("Шаблон короба")).toEqual(["Не выбран", "Коробка 58×40", "Коробка 100×100"]);
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
