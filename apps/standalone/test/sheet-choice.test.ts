import { describe, expect, it } from "vitest";

import { buildPalletSheetPresets } from "@markiro/domain";

import type { PalletSheet, PalletSheets } from "../src/host/protocol.js";
import i18n from "../src/i18n/index.js";
import { defaultSheetFor, sheetChoices } from "../src/office/sheet-choice.js";

const PRESETS = buildPalletSheetPresets();
const t = i18n.t.bind(i18n);

const PORTRAIT = "6a3f0c5e-1b2d-4e8f-9a7b-0c1d2e3f4a5b";
const LANDSCAPE = "7b4a1d6f-2c3e-4f9a-8b8c-1d2e3f4a5b6c";
const TWO = "8c5b2e7a-3d4f-4a0b-9c9d-2e3f4a5b6c7d";
const GONE = "9d6c3f8b-4e5a-4b1c-8d0e-3f4a5b6c7d8e";

function sheet(id: string, name: string, extra: Partial<PalletSheet> = {}): PalletSheet {
  const preset = PRESETS[0];
  if (preset === undefined) throw new Error("no preset");
  return { id, name, enabled: true, presetKey: null, revision: 1, spec: preset.spec, ...extra };
}

function lists(sheets: PalletSheet[], defaultId: string | null = null): PalletSheets {
  return { sheets, defaultId };
}

const labels = (choices: { label: string }[]) => choices.map((choice) => choice.label);

describe("sheetChoices", () => {
  it("offers none, then the enabled readable sheets by name", () => {
    const choices = sheetChoices(
      lists([
        sheet(LANDSCAPE, "Горизонтальный"),
        sheet(PORTRAIT, "Вертикальный"),
        sheet(TWO, "Две А5", { enabled: false }),
        sheet(GONE, "Сломанный", { spec: { schemaVersion: 9 } }),
      ]),
      [],
      "Не выбран",
      t,
    );
    expect(choices).toEqual([
      { value: "", label: "Не выбран" },
      { value: PORTRAIT, label: "Вертикальный" },
      { value: LANDSCAPE, label: "Горизонтальный" },
    ]);
  });

  it("keeps a held sheet that is off, unreadable or gone as a marked choice", () => {
    const list = lists([
      sheet(TWO, "Две А5", { enabled: false }),
      sheet(LANDSCAPE, "Сломанный", { spec: { schemaVersion: 9 } }),
    ]);
    expect(labels(sheetChoices(list, [TWO, LANDSCAPE, GONE, ""], "—", t))).toEqual([
      "—",
      "Две А5 — выключен",
      "Сломанный — не читается этой версией",
      "Лист 9d6c3f8b… — нет в списке",
    ]);
    // While the list is not loaded, a held sheet shows by the start of its id.
    expect(labels(sheetChoices(undefined, [PORTRAIT], "—", t))).toEqual(["—", "Лист 6a3f0c5e…"]);
  });

  it("tells apart two sheets of one name by the start of their ids", () => {
    const list = lists([sheet(PORTRAIT, "Лист"), sheet(LANDSCAPE, " лист ")]);
    expect(labels(sheetChoices(list, [], "—", t))).toEqual([
      "—",
      "лист · 7b4a1d6f",
      "Лист · 6a3f0c5e",
    ]);
  });
});

describe("defaultSheetFor", () => {
  const all = lists(
    [sheet(PORTRAIT, "В"), sheet(LANDSCAPE, "Г"), sheet(TWO, "Две", { enabled: false })],
    PORTRAIT,
  );
  const defaults = {
    defaultPalletSheetId: PORTRAIT,
    palletSheetCategories: [{ chzProductGroupCode: 8, sheetId: LANDSCAPE }],
  };

  it("takes the product's sheet, then the category's, then the organization's", () => {
    const milk = { chzProductGroupCode: 8, defaultPalletSheetId: null };
    expect(defaultSheetFor({ ...milk, defaultPalletSheetId: LANDSCAPE }, defaults, all)).toBe(
      LANDSCAPE,
    );
    expect(defaultSheetFor(milk, defaults, all)).toBe(LANDSCAPE);
    expect(defaultSheetFor({ ...milk, chzProductGroupCode: 3 }, defaults, all)).toBe(PORTRAIT);
    expect(defaultSheetFor({ ...milk, chzProductGroupCode: null }, defaults, all)).toBe(PORTRAIT);
  });

  it("skips a sheet that is off or gone, and knows nothing without the sheets", () => {
    const milk = { chzProductGroupCode: 8, defaultPalletSheetId: TWO };
    expect(defaultSheetFor(milk, defaults, all)).toBe(LANDSCAPE);
    const gone = {
      ...defaults,
      palletSheetCategories: [{ chzProductGroupCode: 8, sheetId: GONE }],
    };
    expect(defaultSheetFor(milk, gone, all)).toBe(PORTRAIT);
    expect(defaultSheetFor(milk, gone, { ...all, defaultId: null })).toBeNull();
    expect(defaultSheetFor(milk, defaults, undefined)).toBeNull();
    // Without the defaults document, the sheets' own default.
    expect(defaultSheetFor(milk, undefined, all)).toBe(PORTRAIT);
  });
});
