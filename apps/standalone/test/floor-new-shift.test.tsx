import { readFileSync } from "node:fs";

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ThemeProvider } from "@markiro/ui";

import type { ScanListener, ScanSource } from "../src/floor/scan-source.js";
import type { WorkShift } from "../src/floor/shifts/shift-copies.js";
import { readShiftCopy } from "../src/floor/shifts/shift-copies.js";
import { NewShift } from "../src/floor/shifts/NewShift.js";
import { createdCopy, createStationShift } from "../src/floor/shifts/new-shift.js";
import { HostError } from "../src/host/client.js";
import {
  deviceShiftsSchema,
  enteredShiftSchema,
  type ChangeItem,
  type ChangesResponse,
  type DeviceShift,
  type DeviceShiftCreate,
  type EnteredShift,
} from "../src/host/protocol.js";
import type { LocalExecutor } from "../src/local/executor.js";
import { syncReferences } from "../src/local/reference-sync.js";
import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"));
}

const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };
const CATALOG = (fixture("changes-catalog.json") as ChangesResponse).items;
const MILK = "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b";
const MILK_TEMPLATE = "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d";
const REQUEST_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
/** The id a second form (or a second draw for the same form) would get. */
const NEXT_REQUEST_ID = "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f";
const [, PLANNED] = deviceShiftsSchema.parse(fixture("device-shifts.json")).shifts as [
  DeviceShift,
  DeviceShift,
];
/** The body of every entry this station sends (`shift-enter.json`, plan РЕЖ). */
const ENTRY = { supports: ["validation-v1", "validation-dm-duplicate-v1"] };
const ENTERED: EnteredShift = enteredShiftSchema.parse(fixture("device-shift-entered.json"));
/**
 * The shift the host makes of `CREATED_BODY` (the form as it starts on `NOW`):
 * what a create answers when the request is the first one for its id. The
 * fixture's own shift (`PLANNED`) is another day's, so it is what a repeated
 * id brings back after the form was changed.
 */
const MADE: DeviceShift = {
  ...PLANNED,
  productId: MILK,
  boxTemplateId: MILK_TEMPLATE,
  productionDate: "2026-10-10",
  boxCapacity: 12,
  plannedQty: null,
};
const OPENED: EnteredShift = {
  ...ENTERED,
  id: PLANNED.id,
  number: PLANNED.number,
  createdFrom: "station",
  productionDate: "2026-10-10",
  plannedQty: null,
};
/** 9 October 2026, 22:30 UTC: already 10 October in Moscow, the organization's zone. */
const NOW = new Date("2026-10-09T22:30:00Z");
const KM = "0104600682000013215abcde\u001d93AbCd";
const SSCC = "046006820000000013";

function item(entity: string, id: string, rev: number, data: unknown): ChangeItem {
  return { entity, id, rev, deleted: false, data };
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

/** A scanner the test reads into, and what the screen asked of it. */
function fakeSource() {
  let listener: ScanListener | null = null;
  const manual = vi.fn<(active: boolean) => void>();
  const source: ScanSource = {
    start(next) {
      listener = next;
      return () => {
        listener = null;
      };
    },
    clearPendingInput: () => undefined,
    setManualTextEntryActive: manual,
  };
  return {
    source,
    manual,
    listening: () => listener !== null,
    read: (raw: string) =>
      act(() => {
        listener?.(raw);
      }),
  };
}

interface Options {
  online?: boolean;
  create?: (create: DeviceShiftCreate) => Promise<DeviceShift>;
  enter?: (id: string) => Promise<EnteredShift>;
  now?: Date;
}

/** What a later render of the screen is given in place of what it had. */
interface Later {
  online?: boolean;
  onEntered?: (shift: WorkShift) => void;
  onHostError?: (error: unknown) => void;
}

function renderNew(local: LocalExecutor, options: Options = {}) {
  const scanner = fakeSource();
  const ids = [REQUEST_ID, NEXT_REQUEST_ID];
  let drawn = 0;
  const handlers = {
    create: vi.fn(options.create ?? (async () => MADE)),
    enter: vi.fn(options.enter ?? (async () => OPENED)),
    onEntered: vi.fn<(shift: WorkShift) => void>(),
    onHostError: vi.fn<(error: unknown) => void>(),
    onBack: vi.fn(),
  };
  const element = (later: Later = {}) => (
    <ThemeProvider>
      <NewShift
        local={local}
        pairing={PAIRING}
        online={later.online ?? options.online ?? true}
        source={scanner.source}
        create={handlers.create}
        enter={handlers.enter}
        onEntered={later.onEntered ?? handlers.onEntered}
        onHostError={later.onHostError ?? handlers.onHostError}
        onBack={handlers.onBack}
        newRequestId={() => ids[drawn++] ?? "00000000-0000-4000-8000-000000000000"}
        now={() => options.now ?? NOW}
      />
    </ThemeProvider>
  );
  const view = render(element());
  return { scanner, handlers, view, later: (next: Later) => view.rerender(element(next)) };
}

async function chooseMilk(): Promise<void> {
  fireEvent.change(await screen.findByLabelText("Название товара"), {
    target: { value: "мол" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Молоко 3,2% 0,9 л — 04600682000013" }));
  await screen.findByRole("heading", { name: "Молоко 3,2% 0,9 л" });
  // The product card names the product, and its GTIN under the name (the cloud station's card).
  expect(screen.getByText("04600682000013")).toBeTruthy();
}

/**
 * «Далее»: from the details to the box template's step, and from there to the
 * pallet template's for a shift with pallets (the cloud station's order). The
 * plan and the capacity are checked on the first one.
 */
function next(): void {
  fireEvent.click(screen.getByRole("button", { name: "Далее" }));
}

/** Back to the details from a template step, through «Предыдущий шаг». */
function backToDetails(): void {
  for (let step = 0; step < 2; step += 1) {
    const previous = screen.queryByRole("button", { name: "Предыдущий шаг" });
    if (previous === null) return;
    fireEvent.click(previous);
  }
}

/** The last step's «Создать и открыть», reached through «Далее» (at most the two template steps). */
function createButton(): HTMLElement {
  for (let step = 0; step < 2; step += 1) {
    const forward = screen.queryByRole("button", { name: "Далее" });
    if (forward === null || (forward as HTMLButtonElement).disabled) break;
    fireEvent.click(forward);
  }
  return screen.getByRole("button", { name: "Создать и открыть" });
}

/** «Создать и открыть», from wherever the form stands. */
function createShift(): void {
  fireEvent.click(createButton());
}

/** The production date the picker shows, in words («10 октября 2026»). */
function shownDate(): string {
  return screen.getByRole("button", { name: "Дата производства" }).textContent ?? "";
}

/** The shift date («Дата смены») the picker shows, in words. */
function shownShiftDate(): string {
  return screen.getByRole("button", { name: "Дата смены" }).textContent ?? "";
}

/** Picks a shift date in its own DatePicker: opens it and presses the day. */
async function pickShiftDate(day: string): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Дата смены" }));
  fireEvent.click(await screen.findByRole("button", { name: day }));
}

/** Picks a production date in the cloud's DatePicker: opens it and presses the day. */
async function pickDate(day: string): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Дата производства" }));
  fireEvent.click(await screen.findByRole("button", { name: day }));
}

/**
 * The buttons of the screen but the date picker's own (its trigger is held at
 * the floor's 64 px by the screen's stylesheet; its clearing «×» is hidden there).
 */
function screenButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll("button")).filter(
    (button) => button.closest(".mk-date-picker") === null,
  );
}

const CREATED_BODY: DeviceShiftCreate = {
  requestId: REQUEST_ID,
  productId: MILK,
  boxTemplateId: MILK_TEMPLATE,
  productionDate: "2026-10-10",
  // The working day: today in the organization's zone, whatever production date is chosen.
  plannedDate: "2026-10-10",
  boxCapacity: 12,
  plannedQty: null,
  counterpartyId: null,
};

/** Two pallet templates for the milk's group (8) and one for another group (plan ПЛ-Ц). */
const PALLET_TEMPLATE = "c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f";
const OTHER_PALLET_TEMPLATE = "d5e6f7a8-b9c0-4d1e-8f2a-3b4c5d6e7f8a";
function palletTemplate(
  id: string,
  name: string,
  codes: number[] | null,
  extra: Record<string, unknown> = {},
): ChangeItem {
  return item("label_templates", id, 102, {
    name,
    purpose: "pallet",
    enabled: true,
    chzProductGroupCodes: codes,
    stock: false,
    spec: {
      widthMm: 100,
      heightMm: 150,
      dpi: 203,
      language: "zpl",
      elements: [
        { kind: "field", id: "boxes", xMm: 5, yMm: 5, field: "qty.boxes", fontSizePt: 24 },
      ],
    },
    ...extra,
  });
}
const PALLET_COPIES = [
  ...CATALOG,
  palletTemplate(PALLET_TEMPLATE, "Паллета 100×150", [8]),
  palletTemplate("e6f7a8b9-c0d1-4e2f-9a3b-4c5d6e7f8a9b", "Паллета для воды", [13]),
];
/** What the host makes of the milk's form with pallets (the first request of its id). */
const MADE_PALLETS: DeviceShift = {
  ...MADE,
  palletsEnabled: true,
  palletBoxCapacity: 40,
  palletTemplateId: PALLET_TEMPLATE,
};
/** The milk of the catalog with the fields of its copy changed. */
function milkWith(extra: Record<string, unknown>): ChangeItem {
  return item("products", MILK, 103, {
    gtin14: "04600682000013",
    name: "Молоко 3,2% 0,9 л",
    printName: "Молоко 3,2%",
    chzProductGroupCode: 8,
    boxCapacity: 12,
    palletBoxCapacity: 40,
    shelfLifeDays: 10,
    defaultBoxTemplateId: MILK_TEMPLATE,
    defaultPalletTemplateId: null,
    archived: false,
    status: "active",
    ...extra,
  });
}

describe("a new shift with pallets on the station (plan ПЛ-Ц)", () => {
  it("offers pallets for a product with boxes per pallet and a pallet template that fits, on, and sends them", async () => {
    const { handlers, view } = renderNew(await copiesOf(PALLET_COPIES), {
      create: async () => MADE_PALLETS,
    });
    await chooseMilk();
    expect(screen.getByRole("button", { name: "С паллетами" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "Без паллет" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(screen.getByText("Коробов на паллете: 40")).toBeTruthy();
    for (const button of screenButtons(view.container)) {
      expect(button.className).toContain("mk-btn--floor");
    }
    // The box template, then the pallet template, each a step of its own (the cloud's order).
    next();
    next();
    // One pallet template fits the milk's group: the rule leaves nothing to choose.
    expect(screen.getByText("Шаблон этикетки паллеты: Паллета 100×150")).toBeTruthy();
    for (const button of screenButtons(view.container)) {
      expect(button.className).toContain("mk-btn--floor");
    }
    createShift();
    await waitFor(() => expect(handlers.onEntered).toHaveBeenCalledTimes(1));
    expect(handlers.create.mock.calls).toEqual([
      [
        {
          ...CREATED_BODY,
          palletsEnabled: true,
          palletBoxCapacity: 40,
          palletTemplateId: PALLET_TEMPLATE,
        },
      ],
    ]);
  });

  it("creates a shift without pallets once the operator turns them off, and back on again", async () => {
    const { handlers } = renderNew(await copiesOf(PALLET_COPIES));
    await chooseMilk();
    fireEvent.click(screen.getByRole("button", { name: "Без паллет" }));
    expect(screen.queryByText("Коробов на паллете: 40")).toBeNull();
    expect(screen.queryByText(/Шаблон этикетки паллеты/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "С паллетами" }));
    expect(screen.getByText("Коробов на паллете: 40")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Без паллет" }));
    createShift();
    await waitFor(() => expect(handlers.create).toHaveBeenCalledTimes(1));
    expect(handlers.create.mock.calls[0]?.[0]).toEqual(CREATED_BODY);
  });

  it("asks for the pallet template when several fit, and creates nothing until one is chosen", async () => {
    const { handlers } = renderNew(
      await copiesOf([
        ...PALLET_COPIES,
        palletTemplate(OTHER_PALLET_TEMPLATE, "Паллета 120×80", [8]),
      ]),
    );
    await chooseMilk();
    next();
    next();
    expect(screen.getByText("Выберите шаблон этикетки паллеты.")).toBeTruthy();
    expect(createButton()).toHaveProperty("disabled", true);
    // The box template is fixed; the pallet's undecided choice does not hold a shift without pallets.
    fireEvent.click(screen.getByRole("button", { name: "Паллета 120×80" }));
    expect(
      screen.getByRole("button", { name: "Паллета 120×80" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: "Паллета 100×150" }).getAttribute("aria-pressed"),
    ).toBe("false");
    createShift();
    await waitFor(() => expect(handlers.create).toHaveBeenCalledTimes(1));
    expect(handlers.create.mock.calls[0]?.[0]).toMatchObject({
      palletTemplateId: OTHER_PALLET_TEMPLATE,
    });
  });

  it("lets a shift without pallets be created while the pallet template is still to choose", async () => {
    const { handlers } = renderNew(
      await copiesOf([
        ...PALLET_COPIES,
        palletTemplate(OTHER_PALLET_TEMPLATE, "Паллета 120×80", [8]),
      ]),
    );
    await chooseMilk();
    fireEvent.click(screen.getByRole("button", { name: "Без паллет" }));
    createShift();
    await waitFor(() => expect(handlers.create).toHaveBeenCalledTimes(1));
    expect(handlers.create.mock.calls[0]?.[0]).toEqual(CREATED_BODY);
  });

  it("takes the pallet template of the product's preference, then the organization's, from the rule", async () => {
    const both = [
      palletTemplate(PALLET_TEMPLATE, "Паллета 100×150", [8]),
      palletTemplate(OTHER_PALLET_TEMPLATE, "Паллета 120×80", null),
    ];
    const preferred = renderNew(
      await copiesOf([
        ...CATALOG.filter((each) => each.id !== MILK),
        milkWith({ defaultPalletTemplateId: OTHER_PALLET_TEMPLATE }),
        ...both,
      ]),
    );
    await chooseMilk();
    next();
    next();
    expect(screen.getByText("Шаблон этикетки паллеты: Паллета 120×80")).toBeTruthy();
    expect(screen.queryByText("Выберите шаблон этикетки паллеты.")).toBeNull();
    preferred.view.unmount();
    // No preference: the two fit, the rule finds none, and the operator chooses.
    renderNew(await copiesOf([...CATALOG, ...both]));
    await chooseMilk();
    next();
    next();
    expect(screen.getByText("Выберите шаблон этикетки паллеты.")).toBeTruthy();
  });

  it("takes the category's pallet default, then the organization's, when the product has no preference", async () => {
    const both = [
      palletTemplate(PALLET_TEMPLATE, "Паллета 100×150", [8]),
      palletTemplate(OTHER_PALLET_TEMPLATE, "Паллета 120×80", null),
    ];
    const organization = CATALOG.find((each) => each.entity === "org_profile");
    if (organization === undefined) throw new Error("the catalog has no organization");
    const withOrganization = (id: string): ChangeItem[] =>
      CATALOG.map((each) =>
        each === organization
          ? { ...each, data: { ...(each.data as object), defaultPalletTemplateId: id } }
          : each,
      );
    // The organization's default alone.
    const first = renderNew(await copiesOf([...withOrganization(OTHER_PALLET_TEMPLATE), ...both]));
    await chooseMilk();
    next();
    next();
    expect(screen.getByText("Шаблон этикетки паллеты: Паллета 120×80")).toBeTruthy();
    first.view.unmount();
    // The category's pallet default wins over it, and a category default for boxes is no pallet default.
    const categoryDefault = (purpose: string, templateId: string): ChangeItem =>
      item("category_template_defaults", `8:${purpose}`, 104, {
        chzProductGroupCode: 8,
        purpose,
        templateId,
      });
    const second = renderNew(
      await copiesOf([
        ...withOrganization(OTHER_PALLET_TEMPLATE),
        ...both,
        categoryDefault("pallet", PALLET_TEMPLATE),
      ]),
    );
    await chooseMilk();
    next();
    next();
    expect(screen.getByText("Шаблон этикетки паллеты: Паллета 100×150")).toBeTruthy();
    second.view.unmount();
    renderNew(
      await copiesOf([...CATALOG, ...both, categoryDefault("pallet", OTHER_PALLET_TEMPLATE)]),
    );
    await chooseMilk();
    next();
    next();
    expect(screen.getByText("Шаблон этикетки паллеты: Паллета 120×80")).toBeTruthy();
  });

  it("keeps the pallet template buttons from changing once the host has made the shift", async () => {
    renderNew(
      await copiesOf([
        ...PALLET_COPIES,
        palletTemplate(OTHER_PALLET_TEMPLATE, "Паллета 120×80", [8]),
      ]),
      {
        create: async () => ({ ...MADE_PALLETS, palletTemplateId: OTHER_PALLET_TEMPLATE }),
        enter: () =>
          Promise.reject(new HostError({ kind: "transport", code: "timeout", message: "x" })),
      },
    );
    await chooseMilk();
    next();
    next();
    fireEvent.click(screen.getByRole("button", { name: "Паллета 120×80" }));
    createShift();
    await screen.findByRole("button", { name: /Открыть смену/ });
    expect(screen.getByRole("button", { name: "Паллета 120×80" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Паллета 100×150" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("offers no pallets for a product without boxes per pallet, or without a pallet template that fits", async () => {
    // Without a pallet template at all, the catalog's milk has its boxes per pallet.
    const first = renderNew(await copiesOf(CATALOG));
    await chooseMilk();
    expect(screen.queryByRole("button", { name: "С паллетами" })).toBeNull();
    first.view.unmount();
    const noCapacity = milkWith({ palletBoxCapacity: null });
    const second = renderNew(
      await copiesOf([
        ...CATALOG.filter((each) => each.id !== MILK),
        noCapacity,
        ...PALLET_COPIES.slice(CATALOG.length),
      ]),
    );
    await chooseMilk();
    expect(screen.queryByRole("button", { name: "С паллетами" })).toBeNull();
    expect(screen.queryByText(/Коробов на паллете/)).toBeNull();
    createShift();
    await waitFor(() => expect(second.handlers.create).toHaveBeenCalledTimes(1));
    expect(second.handlers.create.mock.calls[0]?.[0]).toEqual(CREATED_BODY);
  });

  it("offers pallets only for boxes per pallet the host takes: 1 to 10 000", async () => {
    const templates = PALLET_COPIES.slice(CATALOG.length);
    const others = CATALOG.filter((each) => each.id !== MILK);
    for (const [capacity, offered] of [
      [0, false],
      [1, true],
      [10_000, true],
      [10_001, false],
    ] as const) {
      const { view } = renderNew(
        await copiesOf([...others, milkWith({ palletBoxCapacity: capacity }), ...templates]),
      );
      await chooseMilk();
      expect(screen.queryByRole("button", { name: "С паллетами" }) !== null, String(capacity)).toBe(
        offered,
      );
      view.unmount();
    }
  });

  it("offers no pallets when the pallet template is off, narrowed away from the group, or no pallet one", async () => {
    for (const templates of [
      [palletTemplate(PALLET_TEMPLATE, "Выключенная", [8], { enabled: false })],
      [palletTemplate(PALLET_TEMPLATE, "Для воды", [13])],
      [palletTemplate(PALLET_TEMPLATE, "Короб", [8], { purpose: "box" })],
    ]) {
      const { view } = renderNew(await copiesOf([...CATALOG, ...templates]));
      await chooseMilk();
      expect(screen.queryByRole("button", { name: "С паллетами" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Без паллет" })).toBeNull();
      view.unmount();
    }
  });

  it("says the host refused the pallet template, and gives the choice back to the operator", async () => {
    const refused = new HostError({
      kind: "api",
      code: "validation_failed",
      status: 400,
      message: "no",
      details: { field: "palletTemplateId" },
    });
    renderNew(await copiesOf(PALLET_COPIES), { create: async () => Promise.reject(refused) });
    await chooseMilk();
    createShift();
    expect(
      await screen.findByText(
        "Шаблон этикетки паллеты больше не подходит товару. Выберите другой шаблон или обратитесь в офис.",
      ),
    ).toBeTruthy();
    // The rule's choice is withdrawn: the operator chooses among those that fit.
    expect(screen.getByText("Выберите шаблон этикетки паллеты.")).toBeTruthy();
    expect(createButton()).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Паллета 100×150" })).toBeTruthy();
  });

  it("names the box template when the host refuses that, not the pallet template", async () => {
    const refused = new HostError({
      kind: "api",
      code: "validation_failed",
      status: 400,
      message: "no",
      details: { field: "boxTemplateId" },
    });
    renderNew(await copiesOf(PALLET_COPIES), { create: async () => Promise.reject(refused) });
    await chooseMilk();
    createShift();
    expect(
      await screen.findByText(
        "Шаблон этикетки больше не подходит товару. Выберите другой шаблон или обратитесь в офис.",
      ),
    ).toBeTruthy();
    // Back on the box template's step, its choice given back; the pallet template stays the rule's.
    expect(screen.getByText("Выберите шаблон этикетки короба.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Коробка 58×40" }));
    next();
    expect(screen.getByText("Шаблон этикетки паллеты: Паллета 100×150")).toBeTruthy();
  });

  it("freezes the pallets once the host has made the shift", async () => {
    const { handlers } = renderNew(await copiesOf(PALLET_COPIES), {
      create: async () => MADE_PALLETS,
      enter: () =>
        Promise.reject(new HostError({ kind: "transport", code: "timeout", message: "x" })),
    });
    await chooseMilk();
    createShift();
    await screen.findByRole("button", { name: /Открыть смену/ });
    expect(handlers.create).toHaveBeenCalledTimes(1);
    backToDetails();
    expect(screen.getByRole("button", { name: "С паллетами" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Без паллет" })).toHaveProperty("disabled", true);
  });

  it("does not enter in silence a shift that a repeated request brings back with other pallets", async () => {
    // The first request of this id made a shift WITHOUT pallets; the form now asks for pallets.
    const { handlers } = renderNew(await copiesOf(PALLET_COPIES), { create: async () => MADE });
    await chooseMilk();
    createShift();
    await waitFor(() => expect(handlers.create).toHaveBeenCalledTimes(1));
    expect(handlers.create.mock.calls[0]?.[0]).toMatchObject({ palletsEnabled: true });
    expect(
      await screen.findByText(
        "Смена OCT26-005/S уже была создана раньше: дата 10.10.2026, в коробе 12 шт., план не задан, без паллет. Откройте её или выберите другой товар.",
      ),
    ).toBeTruthy();
    expect(handlers.enter).not.toHaveBeenCalled();
    expect(handlers.onEntered).not.toHaveBeenCalled();
  });

  it("does not enter a shift with pallets that the form without pallets did not ask for either", async () => {
    // The switch alone makes the shift another, whatever the two fields beside it say.
    const switchOnly = renderNew(await copiesOf(PALLET_COPIES), {
      create: async () => ({ ...MADE, palletsEnabled: true }),
    });
    await chooseMilk();
    fireEvent.click(screen.getByRole("button", { name: "Без паллет" }));
    createShift();
    await screen.findByText(/уже была создана раньше/);
    expect(switchOnly.handlers.enter).not.toHaveBeenCalled();
    switchOnly.view.unmount();
    const { handlers } = renderNew(await copiesOf(PALLET_COPIES), {
      create: async () => MADE_PALLETS,
    });
    await chooseMilk();
    fireEvent.click(screen.getByRole("button", { name: "Без паллет" }));
    createShift();
    await waitFor(() => expect(handlers.create).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByText(
        "Смена OCT26-005/S уже была создана раньше: дата 10.10.2026, в коробе 12 шт., план не задан, паллеты по 40 коробов. Откройте её или выберите другой товар.",
      ),
    ).toBeTruthy();
    expect(handlers.enter).not.toHaveBeenCalled();
  });

  it("does not enter a shift of other pallet capacity or pallet template than the form's", async () => {
    for (const other of [
      { ...MADE_PALLETS, palletBoxCapacity: 41 },
      { ...MADE_PALLETS, palletTemplateId: OTHER_PALLET_TEMPLATE },
      // The switch itself, whatever the two fields beside it say.
      { ...MADE_PALLETS, palletsEnabled: false },
    ]) {
      const { handlers, view } = renderNew(await copiesOf(PALLET_COPIES), {
        create: async () => other,
      });
      await chooseMilk();
      createShift();
      expect(await screen.findByText(/уже была создана раньше/)).toBeTruthy();
      expect(handlers.enter).not.toHaveBeenCalled();
      view.unmount();
    }
  });
});

/** Two duplicate templates for the milk's group (8) and one for another group (beta 3.2). */
const DUPLICATE_TEMPLATE = "b7c8d9e0-f1a2-4b3c-8d4e-5f6a7b8c9d0e";
function duplicateTemplate(id: string, name: string, codes: number[] | null): ChangeItem {
  return item("label_templates", id, 104, {
    name,
    purpose: "product_duplicate",
    enabled: true,
    chzProductGroupCodes: codes,
    stock: false,
    spec: { widthMm: 40, heightMm: 30, dpi: 203, language: "zpl", elements: [] },
  });
}
const DUPLICATE_COPIES = [
  ...CATALOG,
  duplicateTemplate(DUPLICATE_TEMPLATE, "Дубликат 40×30", [8]),
  duplicateTemplate("c8d9e0f1-a2b3-4c4d-9e5f-6a7b8c9d0e1f", "Дубликат 58×40", null),
  duplicateTemplate("d9e0f1a2-b3c4-4d5e-8f6a-7b8c9d0e1f2a", "Дубликат для воды", [13]),
];

describe("the mode of a new shift on the station (beta 3.2, plan РЕЖ Р16)", () => {
  it("offers «Проверка» and «Агрегация», starts on «Агрегация» and names no mode for it", async () => {
    const { handlers } = renderNew(await copiesOf(CATALOG));
    await chooseMilk();
    const group = screen.getByRole("group", { name: "Режим работы" });
    const [validation, aggregation] = within(group).getAllByRole("button");
    expect([validation?.textContent, aggregation?.textContent]).toEqual(["Проверка", "Агрегация"]);
    expect(aggregation?.getAttribute("aria-pressed")).toBe("true");
    expect(validation?.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByRole("group", { name: "Печатать дубликат Data Matrix" })).toBeNull();
    createShift();
    await waitFor(() => expect(handlers.create).toHaveBeenCalledTimes(1));
    // An older host refuses a field it does not know: an aggregation shift sends none.
    expect(handlers.create.mock.calls).toEqual([[CREATED_BODY]]);
  });

  it("creates a validation shift without the box and pallet choices, from the details", async () => {
    const { handlers } = renderNew(await copiesOf(PALLET_COPIES), {
      create: async () => ({ ...MADE, mode: "validation" }),
    });
    await chooseMilk();
    expect(screen.getByRole("group", { name: "Паллеты" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Проверка" }));
    // No pallets and no box capacity: a validation shift puts codes in no box.
    expect(screen.queryByRole("group", { name: "Паллеты" })).toBeNull();
    expect(screen.queryByLabelText("В коробе, шт.")).toBeNull();
    expect(screen.getByText("В режиме проверки этикетки коробов не печатаются.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Далее" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
    await waitFor(() => expect(handlers.create).toHaveBeenCalledTimes(1));
    expect(handlers.create.mock.calls[0]?.[0]).toEqual({
      ...CREATED_BODY,
      mode: "validation",
    });
  });

  it("chooses the duplicate template and the check when the shift prints a duplicate", async () => {
    const { handlers } = renderNew(await copiesOf(DUPLICATE_COPIES), {
      create: async () => ({
        ...MADE,
        mode: "validation",
        validationPrint: {
          mode: "duplicate_dm",
          verification: "required",
          templateId: DUPLICATE_TEMPLATE,
        },
      }),
    });
    await chooseMilk();
    fireEvent.click(screen.getByRole("button", { name: "Проверка" }));
    const flag = screen.getByRole("group", { name: "Печатать дубликат Data Matrix" });
    fireEvent.click(within(flag).getByRole("button", { name: "Да" }));
    // The template is chosen on a step of its own; the creation waits for it.
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    expect(screen.getByRole("heading", { name: "Шаблон этикетки продукции" })).toBeTruthy();
    // Only the templates that fit the product's group: not «Дубликат для воды».
    expect(screen.getByRole("button", { name: "Дубликат 40×30" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Дубликат 58×40" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Дубликат для воды" })).toBeNull();
    const create = screen.getByRole("button", { name: "Создать и открыть" });
    expect((create as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Дубликат 40×30" }));
    const check = screen.getByRole("group", { name: "Обязательная проверка этикетки" });
    fireEvent.click(within(check).getByRole("button", { name: "Да" }));
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
    await waitFor(() => expect(handlers.create).toHaveBeenCalledTimes(1));
    expect(handlers.create.mock.calls[0]?.[0]).toEqual({
      ...CREATED_BODY,
      mode: "validation",
      validationPrint: {
        mode: "duplicate_dm",
        verification: "required",
        templateId: DUPLICATE_TEMPLATE,
      },
    });
  });

  it("gives the choice of the duplicate template back when the host refuses it", async () => {
    const { handlers } = renderNew(await copiesOf(DUPLICATE_COPIES), {
      create: async () => {
        throw new HostError({
          kind: "api",
          status: 400,
          code: "validation_failed",
          message: "no",
          details: { field: "validationPrint.templateId" },
        });
      },
    });
    await chooseMilk();
    fireEvent.click(screen.getByRole("button", { name: "Проверка" }));
    fireEvent.click(
      within(screen.getByRole("group", { name: "Печатать дубликат Data Matrix" })).getByRole(
        "button",
        { name: "Да" },
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    fireEvent.click(screen.getByRole("button", { name: "Дубликат 40×30" }));
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
    await waitFor(() => expect(handlers.create).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByText(/Шаблон этикетки продукции больше не подходит товару/),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Шаблон этикетки продукции" })).toBeTruthy();
  });
});

describe("a new shift on the station", () => {
  it("finds a product in use by its name and starts from its template, today and its capacity", async () => {
    renderNew(await copiesOf(CATALOG));
    fireEvent.change(await screen.findByLabelText("Название товара"), { target: { value: "к" } });
    // One letter finds nothing yet, and the archived draft never shows.
    expect(screen.queryByRole("button", { name: /Кефир/ })).toBeNull();
    fireEvent.change(screen.getByLabelText("Название товара"), { target: { value: "кеф" } });
    expect(
      await screen.findByText("Ничего не нашли. Проверьте название или отсканируйте товар."),
    ).toBeTruthy();
    await chooseMilk();
    expect(shownDate()).toContain("10 октября 2026");
    expect(screen.getByLabelText("В коробе, шт.")).toHaveProperty("value", "12");
    expect(screen.getByLabelText("План, шт.")).toHaveProperty("value", "");
    // The product's own template fits its group, so the rule picks it.
    next();
    expect(screen.getByText("Шаблон этикетки короба: Молоко 58×40")).toBeTruthy();
  });

  it("shows the product's photo on the product card when the station holds it, and the monogram when it does not (beta 3)", async () => {
    const local = await copiesOf(CATALOG);
    const [milk] = await local.query(
      "SELECT id FROM ref_products WHERE gtin14 = ?",
      ["04600682000013"],
      z.object({ id: z.string() }),
    );
    // Without a photo: the monogram on the colour panel.
    const first = renderNew(local);
    await chooseMilk();
    expect(document.querySelector(".new-shift__product-monogram")?.textContent).toBe("М");
    expect(document.querySelector(".new-shift__product-photo img")).toBeNull();
    first.view.unmount();

    await local.transaction([
      {
        sql: "INSERT INTO ref_product_photos (product_id, checksum, width, height, data_base64) VALUES (?, ?, 2, 1, ?)",
        values: [milk?.id, "a".repeat(64), "/9j/4AAQSkZJRgABAQ=="],
      },
    ]);
    renderNew(local);
    await chooseMilk();
    await waitFor(() =>
      expect(document.querySelector(".new-shift__product-photo img")?.getAttribute("src")).toBe(
        "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==",
      ),
    );
    expect(document.querySelector(".new-shift__product-monogram")).toBeNull();
  });

  it("chooses the product a scan names, by its barcode or its code of marking", async () => {
    const local = await copiesOf(CATALOG);
    for (const raw of ["4600682000013", KM]) {
      const { scanner, view } = renderNew(local);
      // The scanner listens once the screen's effect has run, after the field shows.
      await waitFor(() => expect(scanner.listening()).toBe(true));
      scanner.read(raw);
      expect(await screen.findByRole("heading", { name: "Молоко 3,2% 0,9 л" })).toBeTruthy();
      // The scanner listens on the first step only.
      expect(scanner.listening()).toBe(false);
      view.unmount();
    }
  });

  it("says what a scan that names no product in use was", async () => {
    const { scanner } = renderNew(await copiesOf(CATALOG));
    await waitFor(() => expect(scanner.listening()).toBe(true));
    scanner.read(SSCC);
    expect(
      await screen.findByText(
        "Это не код товара. Отсканируйте штрихкод товара или код маркировки.",
      ),
    ).toBeTruthy();
    scanner.read("04600682000020");
    expect(
      await screen.findByText(
        "Товара с GTIN 04600682000020 нет среди товаров в работе. Проверьте товар в офисе.",
      ),
    ).toBeTruthy();
  });

  it("does not guess between two products in use with one GTIN", async () => {
    const twin = item("products", "6b5a4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c2d", 101, {
      gtin14: "04600682000013",
      name: "Молоко 3,2% 0,9 л (акция)",
      printName: null,
      chzProductGroupCode: 8,
      boxCapacity: 12,
      palletBoxCapacity: null,
      shelfLifeDays: 10,
      defaultBoxTemplateId: null,
      defaultPalletTemplateId: null,
      archived: false,
      status: "active",
    });
    const { scanner } = renderNew(await copiesOf([...CATALOG, twin]));
    await waitFor(() => expect(scanner.listening()).toBe(true));
    scanner.read("04600682000013");
    expect(
      await screen.findByText(
        "GTIN 04600682000013 есть у нескольких товаров в работе. Выберите товар по названию.",
      ),
    ).toBeTruthy();
  });

  it("creates the shift with the host and enters it at once", async () => {
    const local = await copiesOf(CATALOG);
    const { handlers } = renderNew(local);
    await chooseMilk();
    createShift();
    await waitFor(() => expect(handlers.onEntered).toHaveBeenCalledTimes(1));
    expect(handlers.create.mock.calls).toEqual([[CREATED_BODY]]);
    expect(handlers.enter.mock.calls).toEqual([[PLANNED.id, ENTRY]]);
    expect(handlers.onEntered.mock.calls[0]?.[0]).toMatchObject({
      copy: { id: PLANNED.id, entered: true },
      snapshot: { issuerPrefix: "460068200" },
    });
    expect(await readShiftCopy(local, PAIRING, PLANNED.id)).toMatchObject({ entered: true });
  });

  it("sends the plan, the capacity and another day as the operator set them", async () => {
    const { handlers } = renderNew(await copiesOf(CATALOG));
    await chooseMilk();
    await pickDate("8 октября 2026");
    await pickDate("9 октября 2026");
    expect(shownDate()).toContain("9 октября 2026");
    fireEvent.change(screen.getByLabelText("План, шт."), { target: { value: " 1200 " } });
    fireEvent.change(screen.getByLabelText("В коробе, шт."), { target: { value: "6" } });
    createShift();
    await waitFor(() => expect(handlers.create).toHaveBeenCalledTimes(1));
    expect(handlers.create.mock.calls[0]?.[0]).toEqual({
      ...CREATED_BODY,
      productionDate: "2026-10-09",
      plannedQty: 1200,
      boxCapacity: 6,
    });
  });

  it("offers the shift date beside the production date: today to begin with, editable on its own", async () => {
    const { handlers } = renderNew(await copiesOf(CATALOG));
    await chooseMilk();
    expect(shownShiftDate()).toContain("10 октября 2026");
    expect(
      screen.getByRole("button", { name: "Дата смены" }).closest(".new-shift__date"),
    ).not.toBeNull();
    // The production date moves apart from it: the shift date stays the working day.
    await pickDate("8 октября 2026");
    await pickDate("9 октября 2026");
    expect(shownShiftDate()).toContain("10 октября 2026");
    await pickShiftDate("12 октября 2026");
    expect(shownShiftDate()).toContain("12 октября 2026");
    expect(shownDate()).toContain("9 октября 2026");
    createShift();
    await waitFor(() => expect(handlers.create).toHaveBeenCalledTimes(1));
    expect(handlers.create.mock.calls[0]?.[0]).toEqual({
      ...CREATED_BODY,
      productionDate: "2026-10-09",
      plannedDate: "2026-10-12",
    });
  });

  it("checks the plan and the capacity before it asks the host", async () => {
    const { handlers } = renderNew(await copiesOf(CATALOG));
    await chooseMilk();
    fireEvent.change(screen.getByLabelText("План, шт."), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("В коробе, шт."), { target: { value: "" } });
    // «Далее» checks them: the form stays on its details with the fields marked.
    next();
    expect(
      await screen.findByText("Укажите целое число от 1 до 10 000 000 или оставьте пустым"),
    ).toBeTruthy();
    expect(screen.getByText("Укажите целое число от 1 до 100 000")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Создать и открыть" })).toBeNull();
    expect(handlers.create).not.toHaveBeenCalled();
  });

  it("asks the operator to choose when the rule leaves several templates, and creates none without one", async () => {
    const org = CATALOG.find((each) => each.entity === "org_profile");
    const items = [
      ...CATALOG.filter((each) => each.entity !== "org_profile"),
      item("org_profile", "1", 102, {
        ...(org?.data as Record<string, unknown>),
        defaultBoxTemplateId: null,
      }),
      item("products", "6b5a4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c2d", 103, {
        gtin14: "04600682000037",
        name: "Сметана 20%",
        printName: null,
        chzProductGroupCode: 15,
        boxCapacity: 20,
        palletBoxCapacity: null,
        shelfLifeDays: 14,
        defaultBoxTemplateId: null,
        defaultPalletTemplateId: null,
        archived: false,
        status: "active",
      }),
      item("label_templates", "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1b", 104, {
        name: "Короб 100×150",
        purpose: "box",
        enabled: true,
        chzProductGroupCodes: null,
        stock: false,
        spec: { widthMm: 100, heightMm: 150, dpi: 203, language: "zpl", elements: [] },
      }),
    ];
    const { handlers } = renderNew(await copiesOf(items));
    fireEvent.change(await screen.findByLabelText("Название товара"), {
      target: { value: "смет" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Сметана 20% — 04600682000037" }));
    await screen.findByRole("heading", { name: "Сметана 20%" });
    next();
    expect(await screen.findByText("Выберите шаблон этикетки короба.")).toBeTruthy();
    const create = createButton();
    expect(create).toHaveProperty("disabled", true);
    const group = screen.getByRole("group", { name: "Шаблон этикетки короба" });
    fireEvent.click(within(group).getByRole("button", { name: "Короб 100×150" }));
    expect(within(group).getByRole("button", { name: "Короб 100×150" })).toHaveProperty(
      "ariaPressed",
      "true",
    );
    createShift();
    await waitFor(() => expect(handlers.create).toHaveBeenCalledTimes(1));
    expect(handlers.create.mock.calls[0]?.[0]).toMatchObject({
      boxTemplateId: "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1b",
      boxCapacity: 20,
    });
  });

  it("says so when no box template fits the product", async () => {
    const items = CATALOG.filter(
      (each) => each.entity !== "label_templates" || each.id === MILK_TEMPLATE,
    ).map((each) =>
      each.entity === "label_templates"
        ? { ...each, data: { ...(each.data as Record<string, unknown>), enabled: false } }
        : each,
    );
    renderNew(await copiesOf(items));
    await chooseMilk();
    next();
    expect(
      screen.getByText(
        "Для этого товара нет подходящего шаблона этикетки короба. Шаблоны настраивают в офисе.",
      ),
    ).toBeTruthy();
    expect(createButton()).toHaveProperty("disabled", true);
  });

  it("creates nothing without the host, and says why", async () => {
    renderNew(await copiesOf(CATALOG), { online: false });
    await chooseMilk();
    expect(createButton()).toHaveProperty("disabled", true);
    expect(screen.getByText("Создать смену можно только при связи с хостом.")).toBeTruthy();
  });

  it.each([
    [
      new HostError({ kind: "transport", code: "unreachable", message: "down" }),
      "Нет связи с хостом. Создать смену можно только при связи с ним.",
    ],
    [
      new HostError({
        kind: "api",
        code: "conflict",
        status: 409,
        message: "no",
        details: { constraint: "product_inactive" },
      }),
      "Товар выключен или в архиве: смену не создать. Обратитесь в офис.",
    ],
    [
      new HostError({
        kind: "api",
        code: "validation_failed",
        status: 400,
        message: "no",
        details: { field: "boxTemplateId" },
      }),
      "Шаблон этикетки больше не подходит товару. Выберите другой шаблон или обратитесь в офис.",
    ],
  ])("says why the host did not create the shift: %s", async (error, text) => {
    const { handlers } = renderNew(await copiesOf(CATALOG), {
      create: async () => Promise.reject(error),
    });
    await chooseMilk();
    createShift();
    expect(await screen.findByText(text)).toBeTruthy();
    expect(handlers.enter).not.toHaveBeenCalled();
  });

  it("repeats the same request after a failure, so a lost answer makes no second shift", async () => {
    const down = new HostError({ kind: "transport", code: "timeout", message: "slow" });
    const create = vi
      .fn<(create: DeviceShiftCreate) => Promise<DeviceShift>>()
      .mockRejectedValueOnce(down)
      .mockResolvedValue(MADE);
    const { handlers } = renderNew(await copiesOf(CATALOG), { create });
    await chooseMilk();
    createShift();
    await screen.findByText("Нет связи с хостом. Создать смену можно только при связи с ним.");
    await waitFor(() => expect(createButton()).toHaveProperty("disabled", false));
    createShift();
    await waitFor(() => expect(handlers.onEntered).toHaveBeenCalledTimes(1));
    expect(create.mock.calls.map(([body]) => body.requestId)).toEqual([REQUEST_ID, REQUEST_ID]);
  });

  it("says the shift was created but not opened when the entry is refused", async () => {
    const busy = new HostError({
      kind: "api",
      code: "conflict",
      status: 409,
      message: "no",
      details: { constraint: "shift_busy" },
    });
    renderNew(await copiesOf(CATALOG), { enter: async () => Promise.reject(busy) });
    await chooseMilk();
    createShift();
    expect(
      await screen.findByText(
        "Смена OCT26-005/S создана, но не открыта. Эту смену уже открыла другая станция.",
      ),
    ).toBeTruthy();
  });

  it("says a refusal once: in a polite region that was there before it, not as an alert inside one", async () => {
    const down = new HostError({ kind: "transport", code: "unreachable", message: "down" });
    renderNew(await copiesOf(CATALOG), { create: async () => Promise.reject(down) });
    await chooseMilk();
    const before = new Set(document.querySelectorAll('[aria-live="polite"]'));
    createShift();
    const text = await screen.findByText(
      "Нет связи с хостом. Создать смену можно только при связи с ним.",
    );
    const region = text.closest('[aria-live="polite"]');
    expect(region !== null && before.has(region)).toBe(true);
    // An element with the role of an alert inside the region is read twice.
    expect(region?.querySelector('[role="alert"]')).toBeNull();
    expect(screen.queryAllByRole("alert")).toEqual([]);
  });

  it("says the progress of a request in the region that holds the refusal that stands", async () => {
    const down = new HostError({ kind: "transport", code: "unreachable", message: "down" });
    let answer: (shift: DeviceShift) => void = () => undefined;
    const create = vi
      .fn<(create: DeviceShiftCreate) => Promise<DeviceShift>>()
      .mockRejectedValueOnce(down)
      .mockImplementation(
        () =>
          new Promise<DeviceShift>((resolve) => {
            answer = resolve;
          }),
      );
    renderNew(await copiesOf(CATALOG), { create });
    await chooseMilk();
    createShift();
    const refusal = await screen.findByText(
      "Нет связи с хостом. Создать смену можно только при связи с ним.",
    );
    const region = refusal.closest('[aria-live="polite"]');
    await waitFor(() => expect(createButton()).toHaveProperty("disabled", false));
    createShift();
    const progress = await screen.findByText("Создаём смену…");
    expect(progress.closest('[aria-live="polite"]')).toBe(region);
    await act(async () => {
      answer(MADE);
    });
  });

  it("hands a refused device key to the shell", async () => {
    const rejected = new HostError({
      kind: "api",
      code: "unauthorized",
      status: 401,
      message: "no",
      details: { credential: "device" },
    });
    const { handlers } = renderNew(await copiesOf(CATALOG), {
      create: async () => Promise.reject(rejected),
    });
    await chooseMilk();
    createShift();
    await waitFor(() => expect(handlers.onHostError).toHaveBeenCalledWith(rejected));
  });

  it("sends one request at a time, and «Назад» is never held by one", async () => {
    let answer: (shift: DeviceShift) => void = () => undefined;
    const create = vi.fn(
      () =>
        new Promise<DeviceShift>((resolve) => {
          answer = resolve;
        }),
    );
    const { handlers } = renderNew(await copiesOf(CATALOG), { create });
    await chooseMilk();
    const button = createButton();
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Создаём смену…")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(handlers.onBack).toHaveBeenCalledTimes(1);
    await act(async () => {
      answer(MADE);
    });
    await waitFor(() => expect(handlers.onEntered).toHaveBeenCalledTimes(1));
  });

  it("takes no scan while the name is typed, and gives the scanner back when the step goes", async () => {
    const { scanner } = renderNew(await copiesOf(CATALOG));
    const field = await screen.findByLabelText("Название товара");
    fireEvent.focus(field);
    expect(scanner.manual.mock.calls).toEqual([[true]]);
    fireEvent.change(field, { target: { value: "мол" } });
    // Choosing a result takes the field away without a blur.
    fireEvent.click(screen.getByRole("button", { name: "Молоко 3,2% 0,9 л — 04600682000013" }));
    await screen.findByRole("heading", { name: "Молоко 3,2% 0,9 л" });
    expect(scanner.manual.mock.calls.at(-1)).toEqual([false]);
  });

  it("explains copies that are not ready and a read that failed", async () => {
    const { executor } = openLocalDb();
    const first = renderNew(executor);
    expect(
      await screen.findByText(
        "Справочники ещё не загружены с хоста. Создать смену можно после синхронизации.",
      ),
    ).toBeTruthy();
    first.view.unmount();
    const failing: LocalExecutor = {
      query: () => Promise.reject(new Error("disk")),
      transaction: () => Promise.reject(new Error("disk")),
    };
    renderNew(failing);
    expect(
      await screen.findByText("Не удалось прочитать справочники на этом компьютере."),
    ).toBeTruthy();
  });

  it("keeps every button at the floor's 64 px", async () => {
    const { view } = renderNew(await copiesOf(CATALOG));
    await chooseMilk();
    // «Далее», «Другой товар», «Назад».
    const buttons = screenButtons(view.container);
    expect(buttons.length).toBeGreaterThanOrEqual(3);
    for (const button of buttons) expect(button.className).toContain("mk-btn--floor");
    // The cloud's DatePicker: its trigger stands inside the screen's date row (held at 64 px there).
    expect(
      screen.getByRole("button", { name: "Дата производства" }).closest(".new-shift__date"),
    ).not.toBeNull();
    // And on the template step too.
    next();
    const templateButtons = screenButtons(view.container);
    expect(templateButtons.length).toBeGreaterThan(3);
    for (const button of templateButtons) expect(button.className).toContain("mk-btn--floor");
  });
});

// Everything below pins what the plan's tests above leave to a one-line
// change: the filters of the search, the rule's wiring, the id of a request,
// what a form freezes, what a stale screen is told.

const UNKNOWN_ZONE = "Mars/Olympus";
const GTINS = [
  "04600682000419",
  "04600682000426",
  "04600682000433",
  "04600682000440",
  "04600682000457",
  "04600682000464",
  "04600682000471",
] as const;

function uuid(number: number): string {
  return `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
}

function productItem(
  number: number,
  name: string,
  gtin14: string,
  extra: Record<string, unknown> = {},
): ChangeItem {
  return item("products", uuid(number), 200 + number, {
    gtin14,
    name,
    printName: null,
    chzProductGroupCode: 8,
    boxCapacity: 12,
    palletBoxCapacity: null,
    shelfLifeDays: 10,
    defaultBoxTemplateId: null,
    defaultPalletTemplateId: null,
    archived: false,
    status: "active",
    ...extra,
  });
}

function boxTemplateItem(id: string, name: string): ChangeItem {
  return item("label_templates", id, 300, {
    name,
    purpose: "box",
    enabled: true,
    chzProductGroupCodes: null,
    stock: false,
    spec: { widthMm: 100, heightMm: 150, dpi: 203, language: "zpl", elements: [] },
  });
}

/** The catalog with the fields of one of its items changed. */
function changed(entity: string, patch: Record<string, unknown>, id?: string): ChangeItem[] {
  return CATALOG.map((each) =>
    each.entity === entity && (id === undefined || each.id === id)
      ? { ...each, data: { ...(each.data as Record<string, unknown>), ...patch } }
      : each,
  );
}

/** The buttons that name a product, in the order shown. */
function productButtons(): string[] {
  return screen.queryAllByRole("button", { name: /—/ }).map((button) => button.textContent ?? "");
}

/**
 * The executor with every call it served remembered. «Nothing more happens» is
 * asserted after `quiet`: the screen asks it for nothing more and every answer
 * it got has landed, whatever the machine's load, not after a fixed time that
 * the work could outlast (and the assertion then pass for nothing).
 */
function watched(real: LocalExecutor) {
  const calls: Promise<unknown>[] = [];
  const local: LocalExecutor = {
    query: (sql, params, row) => {
      const answer = real.query(sql, params, row);
      calls.push(answer.catch(() => undefined));
      return answer;
    },
    transaction: (statements) => {
      const answer = real.transaction(statements);
      calls.push(answer.catch(() => undefined));
      return answer;
    },
  };
  /** Every call so far has answered and what it started has run, and nothing new was asked. */
  async function quiet(): Promise<void> {
    let seen = -1;
    while (seen !== calls.length) {
      seen = calls.length;
      await act(async () => {
        await Promise.all(calls);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
    }
  }
  return { local, calls, quiet };
}

function hanging() {
  let answer: (shift: DeviceShift) => void = () => undefined;
  let fail: (error: unknown) => void = () => undefined;
  const create = vi.fn(
    () =>
      new Promise<DeviceShift>((resolve, reject) => {
        answer = resolve;
        fail = reject;
      }),
  );
  return { create, answer: (shift: DeviceShift) => answer(shift), fail: (e: unknown) => fail(e) };
}

describe("the search of a product", () => {
  it("shows the products in use only: not an archived one, not a draft", async () => {
    renderNew(
      await copiesOf([
        ...CATALOG,
        productItem(1, "Йогурт", GTINS[0]),
        productItem(2, "Йогурт архивный", GTINS[1], { archived: true }),
        productItem(3, "Йогурт черновик", GTINS[2], { status: "draft" }),
      ]),
    );
    fireEvent.change(await screen.findByLabelText("Название товара"), {
      target: { value: "йог" },
    });
    expect(productButtons()).toEqual([`Йогурт — ${GTINS[0]}`]);
  });

  it("answers a scan with a product in use only", async () => {
    const { scanner } = renderNew(
      await copiesOf([
        ...CATALOG,
        productItem(2, "Йогурт архивный", GTINS[1], { archived: true }),
        productItem(3, "Йогурт черновик", GTINS[2], { status: "draft" }),
      ]),
    );
    await waitFor(() => expect(scanner.listening()).toBe(true));
    scanner.read(GTINS[1]);
    expect(
      await screen.findByText(
        `Товара с GTIN ${GTINS[1]} нет среди товаров в работе. Проверьте товар в офисе.`,
      ),
    ).toBeTruthy();
    scanner.read(GTINS[2]);
    expect(
      await screen.findByText(
        `Товара с GTIN ${GTINS[2]} нет среди товаров в работе. Проверьте товар в офисе.`,
      ),
    ).toBeTruthy();
  });

  it("shows five results at most, by name", async () => {
    // Added out of order, with ids against the order of the names.
    const order = [5, 3, 7, 1, 2, 6, 4];
    renderNew(
      await copiesOf([
        ...CATALOG,
        ...order.map((number) =>
          productItem(9 - number, `Сыр ${number}`, GTINS[number - 1] ?? GTINS[0]),
        ),
      ]),
    );
    fireEvent.change(await screen.findByLabelText("Название товара"), {
      target: { value: "сыр" },
    });
    expect(productButtons()).toEqual([1, 2, 3, 4, 5].map((n) => `Сыр ${n} — ${GTINS[n - 1]}`));
  });

  it("cuts a long product name with an ellipsis instead of widening the row: the name is its own element, the full text the button's title (beta 3)", async () => {
    const long =
      "Молоко питьевое ультрапастеризованное 3,2% 0,9 л в упаковке Tetra Pak с крышкой Premium Edition";
    renderNew(await copiesOf([...CATALOG, productItem(9, long, GTINS[1] ?? GTINS[0])]));
    fireEvent.change(await screen.findByLabelText("Название товара"), {
      target: { value: "молоко питьевое" },
    });
    const [button] = screen.getAllByRole("button", { name: /—/ });
    expect(button?.getAttribute("title")).toBe(`${long} — ${GTINS[1] ?? GTINS[0]}`);
    expect(button?.querySelector(".new-shift__result-name")?.textContent).toBe(long);
    expect(button?.querySelector(".new-shift__result-gtin")?.textContent).toBe(
      ` — ${GTINS[1] ?? GTINS[0]}`,
    );
  });

  it("starts at two letters, whatever the case or the spaces, and does not count digits as letters", async () => {
    renderNew(await copiesOf(CATALOG));
    const field = await screen.findByLabelText("Название товара");
    fireEvent.change(field, { target: { value: "к" } });
    expect(productButtons()).toEqual([]);
    expect(screen.queryByText(/Ничего не нашли/)).toBeNull();
    // Two characters, both found in the name, but no letters.
    fireEvent.change(field, { target: { value: "3," } });
    expect(productButtons()).toEqual([]);
    expect(screen.queryByText(/Ничего не нашли/)).toBeNull();
    fireEvent.change(field, { target: { value: "  МОЛ " } });
    expect(productButtons()).toEqual(["Молоко 3,2% 0,9 л — 04600682000013"]);
  });

  it("says there is no product to choose when none is in use", async () => {
    renderNew(await copiesOf(CATALOG.filter((each) => each.entity !== "products")));
    expect(
      await screen.findByText(
        "Нет товаров в работе. Товары добавляют в офисе, в разделе «Товары».",
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Название товара")).toBeNull();
  });

  it("reads the copies again on «Повторить»", async () => {
    const real = await copiesOf(CATALOG);
    let broken = true;
    const flaky: LocalExecutor = {
      query: (sql, params, row) =>
        broken ? Promise.reject(new Error("disk")) : real.query(sql, params, row),
      transaction: (statements) => real.transaction(statements),
    };
    renderNew(flaky);
    await screen.findByText("Не удалось прочитать справочники на этом компьютере.");
    broken = false;
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByLabelText("Название товара")).toBeTruthy();
  });

  it("takes the scanner back to the product step, and gives the typed name back its keyboard when the field goes blur", async () => {
    const { scanner } = renderNew(await copiesOf(CATALOG));
    const field = await screen.findByLabelText("Название товара");
    fireEvent.focus(field);
    fireEvent.blur(field);
    expect(scanner.manual.mock.calls).toEqual([[true], [false]]);
    await chooseMilk();
    expect(scanner.listening()).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Другой товар" }));
    await waitFor(() => expect(scanner.listening()).toBe(true));
  });

  it("forgets a scan that was no product once a product is chosen", async () => {
    const { scanner } = renderNew(await copiesOf(CATALOG));
    await waitFor(() => expect(scanner.listening()).toBe(true));
    scanner.read(SSCC);
    await screen.findByText("Это не код товара. Отсканируйте штрихкод товара или код маркировки.");
    scanner.read("4600682000013");
    await screen.findByRole("heading", { name: "Молоко 3,2% 0,9 л" });
    expect(screen.queryByText(/Это не код товара/)).toBeNull();
  });
});

describe("the template, the date and the capacity of a new shift", () => {
  it("takes the category's template when the product has none of its own", async () => {
    renderNew(await copiesOf(changed("products", { defaultBoxTemplateId: null }, MILK)));
    await chooseMilk();
    next();
    // The organization's default, «Коробка 58×40», fits too, and comes after.
    expect(screen.getByText("Шаблон этикетки короба: Молоко 58×40")).toBeTruthy();
  });

  it("takes the organization's template when nothing nearer decides, with two that fit", async () => {
    renderNew(
      await copiesOf([
        ...CATALOG,
        productItem(4, "Сметана 20%", GTINS[3], { chzProductGroupCode: 15 }),
        boxTemplateItem("5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1b", "Короб 100×150"),
      ]),
    );
    fireEvent.change(await screen.findByLabelText("Название товара"), {
      target: { value: "смет" },
    });
    fireEvent.click(screen.getByRole("button", { name: `Сметана 20% — ${GTINS[3]}` }));
    await screen.findByRole("heading", { name: "Сметана 20%" });
    next();
    expect(await screen.findByText("Шаблон этикетки короба: Коробка 58×40")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Шаблон этикетки короба" })).toBeNull();
  });

  it("takes the one template that fits without asking", async () => {
    const { handlers } = renderNew(
      await copiesOf([
        ...changed("org_profile", { defaultBoxTemplateId: null }),
        productItem(5, "Соль", GTINS[4], { chzProductGroupCode: null }),
      ]),
    );
    fireEvent.change(await screen.findByLabelText("Название товара"), {
      target: { value: "соль" },
    });
    fireEvent.click(screen.getByRole("button", { name: `Соль — ${GTINS[4]}` }));
    await screen.findByRole("heading", { name: "Соль" });
    next();
    expect(await screen.findByText("Шаблон этикетки короба: Коробка 58×40")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Шаблон этикетки короба" })).toBeNull();
    createShift();
    await waitFor(() => expect(handlers.create).toHaveBeenCalledTimes(1));
    expect(handlers.create.mock.calls[0]?.[0]).toMatchObject({
      boxTemplateId: "7c1e4b2a-9d3f-4e5a-8b6c-1d2e3f4a5b6c",
    });
  });

  it("offers the templates that fit by name", async () => {
    renderNew(
      await copiesOf([
        ...changed("org_profile", { defaultBoxTemplateId: null }),
        productItem(4, "Сметана 20%", GTINS[3], { chzProductGroupCode: 15 }),
        boxTemplateItem("5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1b", "Короб 100×150"),
        boxTemplateItem("0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d", "Я короб"),
      ]),
    );
    fireEvent.change(await screen.findByLabelText("Название товара"), {
      target: { value: "смет" },
    });
    fireEvent.click(screen.getByRole("button", { name: `Сметана 20% — ${GTINS[3]}` }));
    await screen.findByRole("heading", { name: "Сметана 20%" });
    next();
    const group = await screen.findByRole("group", { name: "Шаблон этикетки короба" });
    expect(
      within(group)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Короб 100×150", "Коробка 58×40", "Я короб"]);
  });

  it("takes the date of the organization's zone, and says nothing of it", async () => {
    renderNew(await copiesOf(CATALOG));
    await chooseMilk();
    expect(screen.queryByText(/Часовой пояс организации неизвестен/)).toBeNull();
  });

  it.each([
    ["Pacific/Kiritimati", "10 октября 2026"],
    ["Pacific/Pago_Pago", "9 октября 2026"],
  ])(
    "takes the date where the organization is, not where this computer is (%s)",
    async (timeZone, date) => {
      // 9 October 22:30 UTC is the 10th at +14 and the 9th at -11: whatever zone
      // this computer is in, one of the two is not its own date.
      renderNew(await copiesOf(changed("org_profile", { timeZone })));
      await chooseMilk();
      expect(shownDate()).toContain(date);
    },
  );

  it("takes this computer's date, and says so, when the organization's zone is not known", async () => {
    // Noon by this computer's own clock, whatever its zone: 9 October there.
    renderNew(await copiesOf(changed("org_profile", { timeZone: UNKNOWN_ZONE })), {
      now: new Date(2026, 9, 9, 12, 0),
    });
    await chooseMilk();
    expect(shownDate()).toContain("9 октября 2026");
    expect(
      screen.getByText("Часовой пояс организации неизвестен: взята дата этого компьютера."),
    ).toBeTruthy();
  });

  it("leaves the capacity empty for a product without one, and needs it", async () => {
    const { handlers } = renderNew(
      await copiesOf(changed("products", { boxCapacity: null }, MILK)),
    );
    await chooseMilk();
    expect(screen.getByLabelText("В коробе, шт.")).toHaveProperty("value", "");
    next();
    expect(await screen.findByText("Укажите целое число от 1 до 100 000")).toBeTruthy();
    expect(handlers.create).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("В коробе, шт."), { target: { value: "8" } });
    createShift();
    await waitFor(() => expect(handlers.create).toHaveBeenCalledTimes(1));
    expect(handlers.create.mock.calls[0]?.[0]).toMatchObject({ boxCapacity: 8, plannedQty: null });
  });

  it("marks the field that is wrong, and only that one", async () => {
    renderNew(await copiesOf(CATALOG));
    await chooseMilk();
    const plan = screen.getByLabelText("План, шт.");
    const capacity = screen.getByLabelText("В коробе, шт.");
    fireEvent.change(plan, { target: { value: "много" } });
    next();
    expect(
      await screen.findByText("Укажите целое число от 1 до 10 000 000 или оставьте пустым"),
    ).toBeTruthy();
    expect(screen.queryByText("Укажите целое число от 1 до 100 000")).toBeNull();
    expect(plan.getAttribute("aria-invalid")).toBe("true");
    expect(capacity.getAttribute("aria-invalid")).toBeNull();
    fireEvent.change(plan, { target: { value: "" } });
    fireEvent.change(capacity, { target: { value: "0" } });
    next();
    expect(await screen.findByText("Укажите целое число от 1 до 100 000")).toBeTruthy();
    expect(
      screen.queryByText("Укажите целое число от 1 до 10 000 000 или оставьте пустым"),
    ).toBeNull();
    expect(capacity.getAttribute("aria-invalid")).toBe("true");
    expect(plan.getAttribute("aria-invalid")).toBeNull();
  });

  it("drops what was wrong once the form is sent right, and with the product", async () => {
    const { handlers } = renderNew(await copiesOf(CATALOG));
    await chooseMilk();
    fireEvent.change(screen.getByLabelText("План, шт."), { target: { value: "0" } });
    next();
    await screen.findByText("Укажите целое число от 1 до 10 000 000 или оставьте пустым");
    // Another product: a form of its own, with none of the old complaints.
    fireEvent.click(screen.getByRole("button", { name: "Другой товар" }));
    fireEvent.click(await screen.findByRole("button", { name: /Молоко/ }));
    await screen.findByRole("heading", { name: "Молоко 3,2% 0,9 л" });
    expect(screen.queryByText(/Укажите целое число/)).toBeNull();
    fireEvent.change(screen.getByLabelText("План, шт."), { target: { value: "0" } });
    next();
    await screen.findByText("Укажите целое число от 1 до 10 000 000 или оставьте пустым");
    fireEvent.change(screen.getByLabelText("План, шт."), { target: { value: "5" } });
    createShift();
    await waitFor(() => expect(handlers.create).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/Укажите целое число/)).toBeNull();
  });
});

describe("a request to create a shift", () => {
  it.each([
    [
      new HostError({
        kind: "api",
        code: "validation_failed",
        status: 400,
        message: "no",
        details: { field: "plannedQty" },
      }),
      "Хост не принял поля смены. Проверьте план и вместимость короба.",
    ],
    [
      new HostError({
        kind: "api",
        code: "validation_failed",
        status: 400,
        message: "no",
        details: { field: "productId" },
      }),
      "Товар выключен или в архиве: смену не создать. Обратитесь в офис.",
    ],
    [
      new HostError({
        kind: "api",
        code: "validation_failed",
        status: 400,
        message: "no",
        details: { field: "lineId" },
      }),
      "У станции нет линии: смену не создать.",
    ],
    [
      new HostError({
        kind: "api",
        code: "conflict",
        status: 409,
        message: "no",
        details: { constraint: "shift_line" },
      }),
      "У станции нет линии: смену не создать.",
    ],
    [
      new HostError({
        kind: "api",
        code: "conflict",
        status: 409,
        message: "no",
        details: { constraint: "something_new" },
      }),
      "Не удалось создать смену. Попробуйте ещё раз.",
    ],
    [new Error("boom"), "Не удалось создать смену. Попробуйте ещё раз."],
  ])("says why the host did not create the shift, in words (%#)", async (error, text) => {
    const { handlers } = renderNew(await copiesOf(CATALOG), {
      create: async () => Promise.reject(error),
    });
    await chooseMilk();
    createShift();
    expect(await screen.findByText(text)).toBeTruthy();
    expect(handlers.enter).not.toHaveBeenCalled();
    expect(handlers.onHostError).not.toHaveBeenCalled();
  });

  it("keeps the form still while it runs, and lets the operator go back", async () => {
    const { create, answer } = hanging();
    const { handlers } = renderNew(
      await copiesOf([
        ...changed("org_profile", { defaultBoxTemplateId: null }),
        productItem(4, "Сметана 20%", GTINS[3], { chzProductGroupCode: 15 }),
        boxTemplateItem("5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1b", "Короб 100×150"),
      ]),
      { create },
    );
    fireEvent.change(await screen.findByLabelText("Название товара"), {
      target: { value: "смет" },
    });
    fireEvent.click(screen.getByRole("button", { name: `Сметана 20% — ${GTINS[3]}` }));
    await screen.findByRole("heading", { name: "Сметана 20%" });
    next();
    fireEvent.click(await screen.findByRole("button", { name: "Короб 100×150" }));
    createShift();
    await screen.findByText("Создаём смену…");
    // The step it runs on stands still, and no step back to the details is open meanwhile.
    for (const name of ["Короб 100×150", "Коробка 58×40", "Предыдущий шаг", "Другой товар"]) {
      expect(screen.getByRole("button", { name })).toHaveProperty("disabled", true);
    }
    expect(screen.getByRole("button", { name: "Назад" })).toHaveProperty("disabled", false);
    await act(async () => {
      answer({
        ...MADE,
        productId: uuid(4),
        boxTemplateId: "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1b",
      });
    });
    await waitFor(() => expect(handlers.onEntered).toHaveBeenCalledTimes(1));
  });

  it("says the entry is on its way once the shift is created", async () => {
    let open: (shift: EnteredShift) => void = () => undefined;
    const enter = vi.fn(
      () =>
        new Promise<EnteredShift>((resolve) => {
          open = resolve;
        }),
    );
    const { handlers } = renderNew(await copiesOf(CATALOG), { enter });
    await chooseMilk();
    createShift();
    expect(await screen.findByText("Открываем смену…")).toBeTruthy();
    expect(screen.queryByText("Создаём смену…")).toBeNull();
    await act(async () => {
      open(OPENED);
    });
    await waitFor(() => expect(handlers.onEntered).toHaveBeenCalledTimes(1));
  });

  it("is dropped, answer and all, when the screen is gone before the host answers", async () => {
    const { create, answer } = hanging();
    const database = watched(await copiesOf(CATALOG));
    const { handlers, view } = renderNew(database.local, { create });
    await chooseMilk();
    createShift();
    await screen.findByText("Создаём смену…");
    view.unmount();
    const asked = database.calls.length;
    await act(async () => {
      answer(MADE);
    });
    await database.quiet();
    // The host's shift was kept on this computer, and that is as far as it went.
    expect(database.calls.length).toBeGreaterThan(asked);
    expect(handlers.enter).not.toHaveBeenCalled();
    expect(handlers.onEntered).not.toHaveBeenCalled();
  });

  it("starts no work when the screen is gone before the entry answers", async () => {
    let open: (shift: EnteredShift) => void = () => undefined;
    const enter = vi.fn(
      () =>
        new Promise<EnteredShift>((resolve) => {
          open = resolve;
        }),
    );
    const database = watched(await copiesOf(CATALOG));
    const { handlers, view } = renderNew(database.local, { enter });
    await chooseMilk();
    createShift();
    await screen.findByText("Открываем смену…");
    view.unmount();
    const asked = database.calls.length;
    await act(async () => {
      open(OPENED);
    });
    await database.quiet();
    // The host's answer was kept on this computer, and that is as far as it went.
    expect(database.calls.length).toBeGreaterThan(asked);
    expect(handlers.onEntered).not.toHaveBeenCalled();
    expect(handlers.onHostError).not.toHaveBeenCalled();
  });

  it("enters from what the link is when the answer lands, not when «Создать» was pressed", async () => {
    const { create, answer } = hanging();
    const { handlers, later } = renderNew(await copiesOf(CATALOG), { create });
    await chooseMilk();
    createShift();
    await screen.findByText("Создаём смену…");
    later({ online: false });
    await act(async () => {
      answer(MADE);
    });
    expect(
      await screen.findByText(
        "Смена OCT26-005/S создана, но не открыта. Нет связи с хостом. Открыть эту смену можно только при связи с ним.",
      ),
    ).toBeTruthy();
    expect(handlers.enter).not.toHaveBeenCalled();
  });

  it("tells the handler the screen has now, not the one it had at the click", async () => {
    const { create, answer } = hanging();
    const { handlers, later } = renderNew(await copiesOf(CATALOG), { create });
    await chooseMilk();
    createShift();
    await screen.findByText("Создаём смену…");
    const newer = vi.fn<(shift: WorkShift) => void>();
    later({ onEntered: newer });
    await act(async () => {
      answer(MADE);
    });
    await waitFor(() => expect(newer).toHaveBeenCalledTimes(1));
    expect(handlers.onEntered).not.toHaveBeenCalled();
  });

  it("hands a refusal of the key to the handler the screen has now", async () => {
    const { create, fail } = hanging();
    const { handlers, later } = renderNew(await copiesOf(CATALOG), { create });
    await chooseMilk();
    createShift();
    await screen.findByText("Создаём смену…");
    const newer = vi.fn<(error: unknown) => void>();
    later({ onHostError: newer });
    const rejected = new HostError({
      kind: "api",
      code: "unauthorized",
      status: 401,
      message: "no",
      details: { credential: "device" },
    });
    await act(async () => {
      fail(rejected);
    });
    await waitFor(() => expect(newer).toHaveBeenCalledWith(rejected));
    expect(handlers.onHostError).not.toHaveBeenCalled();
    expect(screen.queryByText(/Не удалось создать смену/)).toBeNull();
  });

  it("hands a refusal of the key at the entry to the handler the screen has now", async () => {
    let fail: (error: unknown) => void = () => undefined;
    const enter = vi.fn(
      () =>
        new Promise<EnteredShift>((_, reject) => {
          fail = reject;
        }),
    );
    const { handlers, later } = renderNew(await copiesOf(CATALOG), { enter });
    await chooseMilk();
    createShift();
    await screen.findByText("Открываем смену…");
    const newer = vi.fn<(error: unknown) => void>();
    later({ onHostError: newer });
    const rejected = new HostError({
      kind: "api",
      code: "unauthorized",
      status: 401,
      message: "no",
      details: { credential: "device" },
    });
    await act(async () => {
      fail(rejected);
    });
    await waitFor(() => expect(newer).toHaveBeenCalledWith(rejected));
    expect(handlers.onHostError).not.toHaveBeenCalled();
    expect(handlers.onEntered).not.toHaveBeenCalled();
  });

  it("does not hold a refusal of the key as a failure of its own", async () => {
    const changedCertificate = new HostError({
      kind: "transport",
      code: "certificate_mismatch",
      message: "other certificate",
    });
    const { handlers } = renderNew(await copiesOf(CATALOG), {
      create: async () => Promise.reject(changedCertificate),
    });
    await chooseMilk();
    createShift();
    await waitFor(() => expect(handlers.onHostError).toHaveBeenCalledWith(changedCertificate));
    expect(screen.queryByText(/Нет связи с хостом/)).toBeNull();
  });

  it("does not enter another shift when the answer was lost and the form was changed meanwhile", async () => {
    const create = vi
      .fn<(create: DeviceShiftCreate) => Promise<DeviceShift>>()
      .mockRejectedValueOnce(new HostError({ kind: "transport", code: "timeout", message: "slow" }))
      .mockResolvedValue(MADE);
    const { handlers } = renderNew(await copiesOf(CATALOG), { create });
    await chooseMilk();
    createShift();
    await screen.findByText("Нет связи с хостом. Создать смену можно только при связи с ним.");
    await waitFor(() => expect(createButton()).toHaveProperty("disabled", false));
    // The form stays the operator's after a lost answer, under the same id.
    backToDetails();
    fireEvent.change(screen.getByLabelText("План, шт."), { target: { value: "500" } });
    await pickDate("11 октября 2026");
    createShift();
    // The host answers the first shift for this id whatever the body says now;
    // that shift is not the form on the screen, so it is not entered in silence.
    expect(
      await screen.findByText(
        "Смена OCT26-005/S уже была создана раньше: дата 10.10.2026, в коробе 12 шт., план не задан. Откройте её или выберите другой товар.",
      ),
    ).toBeTruthy();
    expect(create.mock.calls.map(([body]) => body.requestId)).toEqual([REQUEST_ID, REQUEST_ID]);
    expect(create.mock.calls[1]?.[0]).toMatchObject({
      plannedQty: 500,
      productionDate: "2026-10-11",
    });
    expect(handlers.enter).not.toHaveBeenCalled();
    expect(handlers.onEntered).not.toHaveBeenCalled();
    expect(screen.queryByText(/Нет связи с хостом/)).toBeNull();
  });

  it.each([
    ["the product", { productId: uuid(77) }],
    ["the template", { boxTemplateId: uuid(78) }],
    ["the day", { productionDate: "2026-10-09" }],
    ["the shift date", { plannedDate: "2026-10-09" }],
    ["the capacity", { boxCapacity: 6 }],
    ["the plan", { plannedQty: 500 }],
  ] as const)("does not enter a shift that is not the form's in %s", async (_name, patch) => {
    const database = watched(await copiesOf(CATALOG));
    const { handlers } = renderNew(database.local, {
      create: async () => ({ ...MADE, ...patch }),
    });
    await chooseMilk();
    createShift();
    expect(await screen.findByText(/Смена OCT26-005\/S уже была создана раньше/)).toBeTruthy();
    await database.quiet();
    expect(handlers.enter).not.toHaveBeenCalled();
    expect(handlers.onEntered).not.toHaveBeenCalled();
    // Nothing offers to make the shift again.
    expect(screen.queryByRole("button", { name: "Создать и открыть" })).toBeNull();
  });

  it("says what the shift that was made before is, and opens it as it is on request", async () => {
    const { handlers } = renderNew(await copiesOf(CATALOG), {
      create: async () => ({
        ...MADE,
        productionDate: "2026-10-09",
        boxCapacity: 6,
        plannedQty: 500,
      }),
    });
    await chooseMilk();
    createShift();
    expect(
      await screen.findByText(
        "Смена OCT26-005/S уже была создана раньше: дата 09.10.2026, в коробе 6 шт., план 500 шт. Откройте её или выберите другой товар.",
      ),
    ).toBeTruthy();
    // The form is the host's shift now, and stays still.
    backToDetails();
    expect(screen.getByLabelText("План, шт.")).toHaveProperty("disabled", true);
    // Forward again to the step that opens it.
    next();
    fireEvent.click(await screen.findByRole("button", { name: "Открыть смену OCT26-005/S" }));
    await waitFor(() => expect(handlers.onEntered).toHaveBeenCalledTimes(1));
    expect(handlers.enter.mock.calls).toEqual([[PLANNED.id, ENTRY]]);
    expect(handlers.create).toHaveBeenCalledTimes(1);
  });

  it("goes back to the choice of a product from the notice of a shift made before, and enters nothing", async () => {
    const { handlers } = renderNew(await copiesOf(CATALOG), {
      create: async () => ({ ...MADE, boxCapacity: 6 }),
    });
    await chooseMilk();
    createShift();
    await screen.findByText(/уже была создана раньше/);
    fireEvent.click(await screen.findByRole("button", { name: "Другой товар" }));
    expect(await screen.findByLabelText("Название товара")).toBeTruthy();
    expect(screen.queryByText(/уже была создана раньше/)).toBeNull();
    expect(handlers.enter).not.toHaveBeenCalled();
    // A form of its own after that, with a request of its own.
    await chooseMilk();
    expect(screen.getByLabelText("В коробе, шт.")).toHaveProperty("disabled", false);
    createShift();
    await waitFor(() => expect(handlers.create).toHaveBeenCalledTimes(2));
    expect(handlers.create.mock.calls.map(([body]) => body.requestId)).toEqual([
      REQUEST_ID,
      NEXT_REQUEST_ID,
    ]);
  });

  it("enters in silence a shift that is the form's, whatever the form was changed to", async () => {
    const { handlers } = renderNew(await copiesOf(CATALOG), {
      create: async (body) => ({
        ...MADE,
        productionDate: body.productionDate,
        boxCapacity: body.boxCapacity ?? MADE.boxCapacity,
        plannedQty: body.plannedQty ?? null,
      }),
    });
    await chooseMilk();
    await pickDate("9 октября 2026");
    fireEvent.change(screen.getByLabelText("План, шт."), { target: { value: "1200" } });
    fireEvent.change(screen.getByLabelText("В коробе, шт."), { target: { value: "6" } });
    createShift();
    await waitFor(() => expect(handlers.onEntered).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/уже была создана раньше/)).toBeNull();
    expect(screen.queryByText(/создана, но не открыта/)).toBeNull();
  });

  it("keeps the shift it made when it could not open it: the form is frozen, and the button only opens", async () => {
    const busy = new HostError({
      kind: "api",
      code: "conflict",
      status: 409,
      message: "no",
      details: { constraint: "shift_busy" },
    });
    const enter = vi
      .fn<(id: string) => Promise<EnteredShift>>()
      .mockRejectedValueOnce(busy)
      .mockResolvedValue(OPENED);
    const { handlers } = renderNew(await copiesOf(CATALOG), { enter });
    await chooseMilk();
    createShift();
    await screen.findByText(
      "Смена OCT26-005/S создана, но не открыта. Эту смену уже открыла другая станция.",
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Открыть смену OCT26-005/S" })).toHaveProperty(
        "disabled",
        false,
      ),
    );
    // The shift is made; the date, the capacity and the plan are its own now.
    expect(screen.queryByRole("button", { name: "Создать и открыть" })).toBeNull();
    backToDetails();
    expect(screen.getByRole("button", { name: "Дата производства" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: "Дата смены" })).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("План, шт.")).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("В коробе, шт.")).toHaveProperty("disabled", true);
    next();
    fireEvent.click(screen.getByRole("button", { name: "Открыть смену OCT26-005/S" }));
    await waitFor(() => expect(handlers.onEntered).toHaveBeenCalledTimes(1));
    // The second press made nothing: it entered the shift that was kept.
    expect(handlers.create).toHaveBeenCalledTimes(1);
    expect(enter.mock.calls).toEqual([
      [PLANNED.id, ENTRY],
      [PLANNED.id, ENTRY],
    ]);
    expect(screen.queryByText(/создана, но не открыта/)).toBeNull();
  });
  it("freezes the choice of a template too once the shift is made", async () => {
    const busy = new HostError({
      kind: "api",
      code: "conflict",
      status: 409,
      message: "no",
      details: { constraint: "shift_busy" },
    });
    const { handlers } = renderNew(
      await copiesOf([
        ...changed("org_profile", { defaultBoxTemplateId: null }),
        productItem(4, "Сметана 20%", GTINS[3], { chzProductGroupCode: 15 }),
        boxTemplateItem("5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1b", "Короб 100×150"),
      ]),
      {
        create: async (body) => ({
          ...MADE,
          productId: body.productId,
          boxTemplateId: body.boxTemplateId,
        }),
        enter: async () => Promise.reject(busy),
      },
    );
    fireEvent.change(await screen.findByLabelText("Название товара"), {
      target: { value: "смет" },
    });
    fireEvent.click(screen.getByRole("button", { name: `Сметана 20% — ${GTINS[3]}` }));
    await screen.findByRole("heading", { name: "Сметана 20%" });
    next();
    fireEvent.click(await screen.findByRole("button", { name: "Короб 100×150" }));
    createShift();
    await screen.findByText(/создана, но не открыта/);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Открыть смену OCT26-005/S" })).toHaveProperty(
        "disabled",
        false,
      ),
    );
    expect(screen.getByRole("button", { name: "Короб 100×150" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Коробка 58×40" })).toHaveProperty("disabled", true);
    expect(handlers.create).toHaveBeenCalledTimes(1);
  });

  it("offers the templates that fit when the host no longer takes the one the rule chose", async () => {
    const stale = new HostError({
      kind: "api",
      code: "validation_failed",
      status: 400,
      message: "no",
      details: { field: "boxTemplateId" },
    });
    const create = vi
      .fn<(create: DeviceShiftCreate) => Promise<DeviceShift>>()
      .mockRejectedValueOnce(stale)
      .mockImplementation(async (body) => ({ ...MADE, boxTemplateId: body.boxTemplateId }));
    const { handlers } = renderNew(await copiesOf(CATALOG), { create });
    await chooseMilk();
    next();
    // The rule fixed the template: there is nothing to choose, yet.
    expect(screen.getByText("Шаблон этикетки короба: Молоко 58×40")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Шаблон этикетки короба" })).toBeNull();
    createShift();
    expect(
      await screen.findByText(
        "Шаблон этикетки больше не подходит товару. Выберите другой шаблон или обратитесь в офис.",
      ),
    ).toBeTruthy();
    // Now the operator can act: the choice is shown, with none taken.
    const group = screen.getByRole("group", { name: "Шаблон этикетки короба" });
    expect(screen.getByText("Выберите шаблон этикетки короба.")).toBeTruthy();
    expect(within(group).getByRole("button", { name: "Молоко 58×40" })).toBeTruthy();
    await waitFor(() => expect(createButton()).toHaveProperty("disabled", true));
    fireEvent.click(within(group).getByRole("button", { name: "Коробка 58×40" }));
    createShift();
    await waitFor(() => expect(handlers.onEntered).toHaveBeenCalledTimes(1));
    // Nothing was made by the refusal, so the id is the same.
    expect(create.mock.calls.map(([body]) => body.requestId)).toEqual([REQUEST_ID, REQUEST_ID]);
    expect(create.mock.calls[1]?.[0].boxTemplateId).not.toBe(MILK_TEMPLATE);
  });

  it("starts a form of its own, with a request of its own, for every product chosen", async () => {
    const { handlers } = renderNew(await copiesOf(CATALOG), {
      create: async () =>
        Promise.reject(
          new HostError({
            kind: "api",
            code: "conflict",
            status: 409,
            message: "no",
            details: { constraint: "product_inactive" },
          }),
        ),
    });
    await chooseMilk();
    createShift();
    await screen.findByText("Товар выключен или в архиве: смену не создать. Обратитесь в офис.");
    fireEvent.click(screen.getByRole("button", { name: "Другой товар" }));
    // The refusal belongs to the form it was for.
    expect(screen.queryByText(/Товар выключен/)).toBeNull();
    await chooseMilk();
    createShift();
    await waitFor(() => expect(handlers.create).toHaveBeenCalledTimes(2));
    expect(handlers.create.mock.calls.map(([body]) => body.requestId)).toEqual([
      REQUEST_ID,
      NEXT_REQUEST_ID,
    ]);
  });

  it("enters the shift even when this computer could not keep the copy of it at once", async () => {
    const real = await copiesOf(CATALOG);
    let transactions = 0;
    const flaky: LocalExecutor = {
      query: (sql, params, row) => real.query(sql, params, row),
      transaction: (statements) =>
        transactions++ === 0 ? Promise.reject(new Error("disk")) : real.transaction(statements),
    };
    // Only the keep of the copy is the one that fails; the sync above ran on `real`.
    const { handlers } = renderNew(flaky);
    await chooseMilk();
    createShift();
    await waitFor(() => expect(handlers.onEntered).toHaveBeenCalledTimes(1));
    expect(transactions).toBe(2);
  });
});

describe("the creation of a shift, apart from its screen", () => {
  const input = {
    requestId: REQUEST_ID,
    productId: MILK,
    boxTemplateId: MILK_TEMPLATE,
    productionDate: "2026-10-10",
    plannedDate: "2026-10-10",
    boxCapacity: 12,
    plannedQty: null,
  };

  async function createWith(error: unknown) {
    const local = await copiesOf(CATALOG);
    return createStationShift(
      { local, pairing: PAIRING, create: () => Promise.reject(error), now: () => 1 },
      input,
    );
  }

  const conflict = (constraint: unknown) =>
    new HostError({
      kind: "api",
      code: "conflict",
      status: 409,
      message: "no",
      details: constraint === undefined ? {} : { constraint },
    });

  it.each([
    [
      "no answer",
      new HostError({ kind: "transport", code: "unreachable", message: "x" }),
      "no_link",
    ],
    [
      "a late answer",
      new HostError({ kind: "transport", code: "timeout", message: "x" }),
      "no_link",
    ],
    ["a turned-off product", conflict("product_inactive"), "product_inactive"],
    ["no line", conflict("shift_line"), "no_line"],
    ["another conflict", conflict("shift_status"), "failed"],
    ["a conflict without a constraint", conflict(undefined), "failed"],
    ["a constraint that is no text", conflict(7), "failed"],
    [
      "the template",
      new HostError({
        kind: "api",
        code: "validation_failed",
        status: 400,
        message: "x",
        details: { field: "boxTemplateId" },
      }),
      "template",
    ],
    [
      "a product that is gone",
      new HostError({
        kind: "api",
        code: "validation_failed",
        status: 400,
        message: "x",
        details: { field: "productId" },
      }),
      "product_inactive",
    ],
    [
      "a line that is off",
      new HostError({
        kind: "api",
        code: "validation_failed",
        status: 400,
        message: "x",
        details: { field: "lineId" },
      }),
      "no_line",
    ],
    [
      "another field",
      new HostError({
        kind: "api",
        code: "validation_failed",
        status: 400,
        message: "x",
        details: { field: "boxCapacity" },
      }),
      "invalid",
    ],
    [
      "a field that is not named",
      new HostError({ kind: "api", code: "validation_failed", status: 400, message: "x" }),
      "invalid",
    ],
    [
      "a server fault",
      new HostError({ kind: "api", code: "internal", status: 500, message: "x" }),
      "failed",
    ],
    [
      "a session key, which is no device's",
      new HostError({
        kind: "api",
        code: "unauthorized",
        status: 401,
        message: "x",
        details: { credential: "session" },
      }),
      "failed",
    ],
    ["something that is no host answer", new Error("boom"), "failed"],
  ] as const)("refuses on %s as %s", async (_name, error, reason) => {
    expect(await createWith(error)).toEqual({ kind: "refused", reason });
  });

  it.each([
    [
      "a refused device key",
      new HostError({
        kind: "api",
        code: "unauthorized",
        status: 401,
        message: "x",
        details: { credential: "device" },
      }),
    ],
    [
      "another certificate",
      new HostError({ kind: "transport", code: "certificate_mismatch", message: "x" }),
    ],
  ])("hands %s back unjudged", async (_name, error) => {
    expect(await createWith(error)).toEqual({ kind: "rejected", error });
  });

  it("keeps the copy of the shift at the time given, and the host's body is the form's", async () => {
    const local = await copiesOf(CATALOG);
    const create = vi.fn(async (_body: DeviceShiftCreate) => PLANNED);
    const result = await createStationShift(
      { local, pairing: PAIRING, create, now: () => 123456789 },
      input,
    );
    expect(result).toEqual({ kind: "created", shift: PLANNED });
    expect(create.mock.calls).toEqual([[CREATED_BODY]]);
    expect(await readShiftCopy(local, PAIRING, PLANNED.id)).toEqual(createdCopy(PLANNED));
    expect(
      await local.query(
        "SELECT seen_at FROM floor_shifts WHERE id = ?",
        [PLANNED.id],
        z.object({ seen_at: z.number() }),
      ),
    ).toEqual([{ seen_at: 123456789 }]);
  });

  it("makes the copy of a created shift one nobody has entered and nobody is closing", () => {
    expect(createdCopy(PLANNED)).toEqual({
      ...PLANNED,
      // A host before beta 3 names no shift date: the copy keeps none.
      plannedDate: null,
      palletBoxCapacity: null,
      palletTemplateId: null,
      localState: null,
      entered: false,
    });
    expect(createdCopy({ ...PLANNED, plannedDate: "2026-10-12" }).plannedDate).toBe("2026-10-12");
  });

  it("makes the copy of a created shift with pallets keep its boxes per pallet and pallet template", () => {
    const palletsShift = {
      ...PLANNED,
      palletsEnabled: true,
      palletBoxCapacity: 40,
      palletTemplateId: "c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f",
    };
    expect(createdCopy(palletsShift)).toEqual({
      ...palletsShift,
      plannedDate: null,
      localState: null,
      entered: false,
    });
  });
});
