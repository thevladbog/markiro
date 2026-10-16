import { readFileSync } from "node:fs";

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildPalletSheetPresets, type MonoRaster } from "@markiro/domain";
import { ThemeProvider } from "@markiro/ui";

import type { ScanSource } from "../src/floor/scan-source.js";
import { NewShift } from "../src/floor/shifts/NewShift.js";
import type {
  ChangeItem,
  ChangesResponse,
  DeviceShift,
  DeviceShiftCreate,
  EnteredShift,
  PalletSheets,
} from "../src/host/protocol.js";
import { deviceShiftsSchema, enteredShiftSchema } from "../src/host/protocol.js";
import { loadBundledMarkiroLogo } from "../src/labels/logo.js";
import { paintMonoRaster, renderSheetRaster } from "../src/labels/sheet-render.js";
import type { LocalExecutor } from "../src/local/executor.js";
import { syncReferences } from "../src/local/reference-sync.js";
import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";
import { HP_A4, HP_LABEL, setUpPrinting } from "./support/printing.js";

import type * as LogoModule from "../src/labels/logo.js";
import type * as SheetRenderModule from "../src/labels/sheet-render.js";

// The domain renderer needs a canvas and a font: the step's own wiring is what is tested.
vi.mock("../src/labels/sheet-render.js", async (importActual) => {
  const actual = await importActual<typeof SheetRenderModule>();
  return { ...actual, renderSheetRaster: vi.fn(), paintMonoRaster: vi.fn() };
});

vi.mock("../src/labels/logo.js", async (importActual) => {
  const actual = await importActual<typeof LogoModule>();
  return { ...actual, loadBundledMarkiroLogo: vi.fn() };
});

const testModuleUrl = import.meta.url;
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"));
}

const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };
const CATALOG = (fixture("changes-catalog.json") as ChangesResponse).items;
const MILK = "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b";
const REQUEST_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const [, PLANNED] = deviceShiftsSchema.parse(fixture("device-shifts.json")).shifts as [
  DeviceShift,
  DeviceShift,
];
const ENTERED: EnteredShift = enteredShiftSchema.parse(fixture("device-shift-entered.json"));
const NOW = new Date("2026-10-09T22:30:00Z");

const [PORTRAIT, LANDSCAPE] = buildPalletSheetPresets();
if (PORTRAIT === undefined || LANDSCAPE === undefined) throw new Error("no stock sheets");
const SHEET_A = "11111111-1111-4111-8111-111111111111";
const SHEET_B = "22222222-2222-4222-8222-222222222222";
const SHEETS: PalletSheets = {
  defaultId: SHEET_A,
  sheets: [
    {
      id: SHEET_A,
      name: "Паллета А4 книжная",
      enabled: true,
      presetKey: null,
      revision: 1,
      spec: PORTRAIT.spec,
    },
    {
      id: SHEET_B,
      name: "Паллета А4 альбомная",
      enabled: true,
      presetKey: null,
      revision: 1,
      spec: LANDSCAPE.spec,
    },
    {
      id: "33333333-3333-4333-8333-333333333333",
      name: "Выключенный лист",
      enabled: false,
      presetKey: null,
      revision: 1,
      spec: PORTRAIT.spec,
    },
  ],
};

function item(entity: string, id: string, rev: number, data: unknown): ChangeItem {
  return { entity, id, rev, deleted: false, data };
}
function palletTemplate(id: string, name: string): ChangeItem {
  return item("label_templates", id, 102, {
    name,
    purpose: "pallet",
    enabled: true,
    chzProductGroupCodes: null,
    stock: true,
    spec: {
      widthMm: 100,
      heightMm: 150,
      dpi: 203,
      language: "zpl",
      elements: [
        { kind: "field", id: "boxes", xMm: 5, yMm: 5, field: "qty.boxes", fontSizePt: 24 },
      ],
    },
  });
}
const COPIES: ChangeItem[] = [
  ...CATALOG,
  palletTemplate("c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f", "Паллета 100×150"),
  palletTemplate("d5e6f7a8-b9c0-4d1e-8f2a-3b4c5d6e7f8a", "Паллета 120×80"),
  palletTemplate("e6f7a8b9-c0d1-4e2f-9a3b-4c5d6e7f8a9b", "Паллета узкая"),
];

function raster(): MonoRaster {
  return {
    format: "mono-raster-v1",
    widthMm: 210,
    heightMm: 297,
    dpi: 300,
    widthDots: 8,
    heightDots: 8,
    stride: 1,
    requiredBounds: { left: 0, top: 0, right: 8, bottom: 8 },
    pixels: new Uint8Array(8).fill(1),
  };
}

async function copiesOf(items: ChangeItem[]): Promise<LocalExecutor> {
  const { executor } = openLocalDb();
  await syncReferences({
    changes: async () => ({ hostId: HOST_ID, rev: 100, hasMore: false, items }),
    local: executor,
    ...PAIRING,
  });
  return executor;
}

const SOURCE: ScanSource = {
  start: () => () => undefined,
  clearPendingInput: () => undefined,
  setManualTextEntryActive: () => undefined,
};

function renderNew(
  local: LocalExecutor,
  palletSheets?: (productId?: string) => Promise<PalletSheets>,
) {
  const create = vi.fn<(create: DeviceShiftCreate) => Promise<DeviceShift>>(async () => ({
    ...PLANNED,
    productId: MILK,
  }));
  render(
    <ThemeProvider>
      <NewShift
        local={local}
        pairing={PAIRING}
        online
        source={SOURCE}
        create={create}
        enter={async () => ENTERED}
        onEntered={() => undefined}
        onHostError={() => undefined}
        onBack={() => undefined}
        newRequestId={() => REQUEST_ID}
        now={() => NOW}
        {...(palletSheets === undefined ? {} : { palletSheets })}
      />
    </ThemeProvider>,
  );
  return { create };
}

async function toPalletStep(): Promise<void> {
  fireEvent.change(await screen.findByLabelText("Название товара"), { target: { value: "мол" } });
  fireEvent.click(screen.getByRole("button", { name: "Молоко 3,2% 0,9 л — 04600682000013" }));
  await screen.findByRole("heading", { name: "Молоко 3,2% 0,9 л" });
  fireEvent.click(screen.getByRole("button", { name: "Далее" }));
  fireEvent.click(screen.getByRole("button", { name: "Далее" }));
}

beforeEach(() => {
  vi.mocked(renderSheetRaster).mockReset().mockResolvedValue(raster());
  vi.mocked(paintMonoRaster).mockReset();
  vi.mocked(loadBundledMarkiroLogo)
    .mockReset()
    .mockResolvedValue({ width: 8, height: 8, stride: 1, pixels: new Uint8Array(8).fill(1) });
});

describe("the pallet step of a new shift follows the printer assigned to pallets", () => {
  it("on a printer of A4 sheets chooses a sheet and draws it, not a label template", async () => {
    const local = await copiesOf(COPIES);
    await setUpPrinting(local, {
      printers: [HP_A4],
      assignments: { box: null, pallet: "hp-a4", duplicate: null },
    });
    const palletSheets = vi.fn(async () => SHEETS);
    const { create } = renderNew(local, palletSheets);
    await toPalletStep();
    const group = await screen.findByRole("group", { name: "Лист А4 паллеты" });
    expect(palletSheets).toHaveBeenCalledWith(MILK);
    // «По умолчанию товара» and the two enabled sheets; the disabled one is not offered.
    expect(
      within(group)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["По умолчанию товара", "Паллета А4 книжная", "Паллета А4 альбомная"]);
    expect(screen.queryByRole("group", { name: "Шаблон этикетки паллеты" })).toBeNull();
    expect(
      screen.getByText("Лист А4 для паллеты: по умолчанию товара (Паллета А4 книжная)"),
    ).toBeTruthy();
    await waitFor(() => expect(paintMonoRaster).toHaveBeenCalledTimes(1));
    expect(vi.mocked(renderSheetRaster).mock.calls[0]?.[0]).toEqual(PORTRAIT.spec);
    expect(
      screen.getByRole("img", { name: "Предпросмотр листа А4 «Паллета А4 книжная»" }),
    ).toBeTruthy();
    // Another sheet is drawn, and the shift is made with it.
    fireEvent.click(within(group).getByRole("button", { name: "Паллета А4 альбомная" }));
    await waitFor(() => expect(paintMonoRaster).toHaveBeenCalledTimes(2));
    expect(vi.mocked(renderSheetRaster).mock.calls[1]?.[0]).toEqual(LANDSCAPE.spec);
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      palletsEnabled: true,
      palletSheetTemplateId: SHEET_B,
    });
  });

  it("leaves the sheet to the host when «по умолчанию товара» stays chosen", async () => {
    const local = await copiesOf(COPIES);
    await setUpPrinting(local, {
      printers: [HP_A4],
      assignments: { box: null, pallet: "hp-a4", duplicate: null },
    });
    const { create } = renderNew(local, async () => SHEETS);
    await toPalletStep();
    await screen.findByRole("group", { name: "Лист А4 паллеты" });
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const body = create.mock.calls[0]?.[0];
    expect(body).toMatchObject({ palletsEnabled: true });
    expect(body).not.toHaveProperty("palletSheetTemplateId");
  });

  it("says so when the host has no enabled sheet", async () => {
    const local = await copiesOf(COPIES);
    await setUpPrinting(local, {
      printers: [HP_A4],
      assignments: { box: null, pallet: "hp-a4", duplicate: null },
    });
    renderNew(local, async () => ({ defaultId: null, sheets: [] }));
    await toPalletStep();
    expect(
      await screen.findByText("Нет включённых листов А4 — добавьте лист в офисе: «Листы А4»."),
    ).toBeTruthy();
  });

  it("on a label printer keeps the label templates and their preview", async () => {
    const local = await copiesOf(COPIES);
    await setUpPrinting(local, {
      printers: [HP_LABEL],
      assignments: { box: null, pallet: "hp-a4", duplicate: null },
    });
    const palletSheets = vi.fn(async () => SHEETS);
    renderNew(local, palletSheets);
    await toPalletStep();
    const group = await screen.findByRole("group", { name: "Шаблон этикетки паллеты" });
    expect(within(group).getAllByRole("button")).toHaveLength(3);
    expect(screen.queryByRole("group", { name: "Лист А4 паллеты" })).toBeNull();
    expect(palletSheets).not.toHaveBeenCalled();
    expect(renderSheetRaster).not.toHaveBeenCalled();
  });
});
