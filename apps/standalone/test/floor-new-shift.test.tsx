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
  await screen.findByText("Молоко 3,2% 0,9 л, GTIN 04600682000013");
}

const CREATED_BODY: DeviceShiftCreate = {
  requestId: REQUEST_ID,
  productId: MILK,
  boxTemplateId: MILK_TEMPLATE,
  productionDate: "2026-10-10",
  boxCapacity: 12,
  plannedQty: null,
  counterpartyId: null,
};

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
    // The product's own template fits its group, so the rule picks it.
    expect(screen.getByText("Шаблон этикетки короба: Молоко 58×40")).toBeTruthy();
    expect(screen.getByText("Дата производства: 10.10.2026")).toBeTruthy();
    expect(screen.getByLabelText("В коробе, шт.")).toHaveProperty("value", "12");
    expect(screen.getByLabelText("План, шт.")).toHaveProperty("value", "");
  });

  it("chooses the product a scan names, by its barcode or its code of marking", async () => {
    const local = await copiesOf(CATALOG);
    for (const raw of ["4600682000013", KM]) {
      const { scanner, view } = renderNew(local);
      // The scanner listens once the screen's effect has run, after the field shows.
      await waitFor(() => expect(scanner.listening()).toBe(true));
      scanner.read(raw);
      expect(await screen.findByText("Молоко 3,2% 0,9 л, GTIN 04600682000013")).toBeTruthy();
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
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
    await waitFor(() => expect(handlers.onEntered).toHaveBeenCalledTimes(1));
    expect(handlers.create.mock.calls).toEqual([[CREATED_BODY]]);
    expect(handlers.enter.mock.calls).toEqual([[PLANNED.id]]);
    expect(handlers.onEntered.mock.calls[0]?.[0]).toMatchObject({
      copy: { id: PLANNED.id, entered: true },
      snapshot: { issuerPrefix: "460068200" },
    });
    expect(await readShiftCopy(local, PAIRING, PLANNED.id)).toMatchObject({ entered: true });
  });

  it("sends the plan, the capacity and another day as the operator set them", async () => {
    const { handlers } = renderNew(await copiesOf(CATALOG));
    await chooseMilk();
    fireEvent.click(screen.getByRole("button", { name: "На день раньше" }));
    fireEvent.click(screen.getByRole("button", { name: "На день раньше" }));
    fireEvent.click(screen.getByRole("button", { name: "На день позже" }));
    expect(screen.getByText("Дата производства: 09.10.2026")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("План, шт."), { target: { value: " 1200 " } });
    fireEvent.change(screen.getByLabelText("В коробе, шт."), { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
    await waitFor(() => expect(handlers.create).toHaveBeenCalledTimes(1));
    expect(handlers.create.mock.calls[0]?.[0]).toEqual({
      ...CREATED_BODY,
      productionDate: "2026-10-09",
      plannedQty: 1200,
      boxCapacity: 6,
    });
  });

  it("checks the plan and the capacity before it asks the host", async () => {
    const { handlers } = renderNew(await copiesOf(CATALOG));
    await chooseMilk();
    fireEvent.change(screen.getByLabelText("План, шт."), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("В коробе, шт."), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
    expect(
      await screen.findByText("Укажите целое число от 1 до 10 000 000 или оставьте пустым"),
    ).toBeTruthy();
    expect(screen.getByText("Укажите целое число от 1 до 100 000")).toBeTruthy();
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
    expect(await screen.findByText("Выберите шаблон этикетки короба.")).toBeTruthy();
    const create = screen.getByRole("button", { name: "Создать и открыть" });
    expect(create).toHaveProperty("disabled", true);
    const group = screen.getByRole("group", { name: "Шаблон этикетки короба" });
    fireEvent.click(within(group).getByRole("button", { name: "Короб 100×150" }));
    expect(within(group).getByRole("button", { name: "Короб 100×150" })).toHaveProperty(
      "ariaPressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
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
    expect(
      screen.getByText(
        "Для этого товара нет подходящего шаблона этикетки короба. Шаблоны настраивают в офисе.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Создать и открыть" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("creates nothing without the host, and says why", async () => {
    renderNew(await copiesOf(CATALOG), { online: false });
    await chooseMilk();
    expect(screen.getByRole("button", { name: "Создать и открыть" })).toHaveProperty(
      "disabled",
      true,
    );
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
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
    await screen.findByText("Нет связи с хостом. Создать смену можно только при связи с ним.");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Создать и открыть" })).toHaveProperty(
        "disabled",
        false,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
    const refusal = await screen.findByText(
      "Нет связи с хостом. Создать смену можно только при связи с ним.",
    );
    const region = refusal.closest('[aria-live="polite"]');
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Создать и открыть" })).toHaveProperty(
        "disabled",
        false,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
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
    const button = screen.getByRole("button", { name: "Создать и открыть" });
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
    await screen.findByText("Молоко 3,2% 0,9 л, GTIN 04600682000013");
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
    const buttons = view.container.querySelectorAll("button");
    expect(buttons.length).toBeGreaterThan(3);
    for (const button of buttons) expect(button.className).toContain("mk-btn--floor");
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
    await screen.findByText("Молоко 3,2% 0,9 л, GTIN 04600682000013");
    expect(screen.queryByText(/Это не код товара/)).toBeNull();
  });
});

describe("the template, the date and the capacity of a new shift", () => {
  it("takes the category's template when the product has none of its own", async () => {
    renderNew(await copiesOf(changed("products", { defaultBoxTemplateId: null }, MILK)));
    await chooseMilk();
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
    expect(await screen.findByText("Шаблон этикетки короба: Коробка 58×40")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Шаблон этикетки короба" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
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
    ["Pacific/Kiritimati", "10.10.2026"],
    ["Pacific/Pago_Pago", "09.10.2026"],
  ])(
    "takes the date where the organization is, not where this computer is (%s)",
    async (timeZone, date) => {
      // 9 October 22:30 UTC is the 10th at +14 and the 9th at -11: whatever zone
      // this computer is in, one of the two is not its own date.
      renderNew(await copiesOf(changed("org_profile", { timeZone })));
      await chooseMilk();
      expect(screen.getByText(`Дата производства: ${date}`)).toBeTruthy();
    },
  );

  it("takes this computer's date, and says so, when the organization's zone is not known", async () => {
    // Noon by this computer's own clock, whatever its zone: 9 October there.
    renderNew(await copiesOf(changed("org_profile", { timeZone: UNKNOWN_ZONE })), {
      now: new Date(2026, 9, 9, 12, 0),
    });
    await chooseMilk();
    expect(screen.getByText("Дата производства: 09.10.2026")).toBeTruthy();
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
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
    expect(await screen.findByText("Укажите целое число от 1 до 100 000")).toBeTruthy();
    expect(handlers.create).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("В коробе, шт."), { target: { value: "8" } });
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
    await waitFor(() => expect(handlers.create).toHaveBeenCalledTimes(1));
    expect(handlers.create.mock.calls[0]?.[0]).toMatchObject({ boxCapacity: 8, plannedQty: null });
  });

  it("marks the field that is wrong, and only that one", async () => {
    renderNew(await copiesOf(CATALOG));
    await chooseMilk();
    const plan = screen.getByLabelText("План, шт.");
    const capacity = screen.getByLabelText("В коробе, шт.");
    fireEvent.change(plan, { target: { value: "много" } });
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
    expect(
      await screen.findByText("Укажите целое число от 1 до 10 000 000 или оставьте пустым"),
    ).toBeTruthy();
    expect(screen.queryByText("Укажите целое число от 1 до 100 000")).toBeNull();
    expect(plan.getAttribute("aria-invalid")).toBe("true");
    expect(capacity.getAttribute("aria-invalid")).toBeNull();
    fireEvent.change(plan, { target: { value: "" } });
    fireEvent.change(capacity, { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
    await screen.findByText("Укажите целое число от 1 до 10 000 000 или оставьте пустым");
    // Another product: a form of its own, with none of the old complaints.
    fireEvent.click(screen.getByRole("button", { name: "Другой товар" }));
    fireEvent.click(await screen.findByRole("button", { name: /Молоко/ }));
    await screen.findByText("Молоко 3,2% 0,9 л, GTIN 04600682000013");
    expect(screen.queryByText(/Укажите целое число/)).toBeNull();
    fireEvent.change(screen.getByLabelText("План, шт."), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
    await screen.findByText("Укажите целое число от 1 до 10 000 000 или оставьте пустым");
    fireEvent.change(screen.getByLabelText("План, шт."), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
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
    fireEvent.click(await screen.findByRole("button", { name: "Короб 100×150" }));
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
    await screen.findByText("Создаём смену…");
    for (const name of [
      "Короб 100×150",
      "Коробка 58×40",
      "На день раньше",
      "На день позже",
      "Другой товар",
    ]) {
      expect(screen.getByRole("button", { name })).toHaveProperty("disabled", true);
    }
    expect(screen.getByLabelText("План, шт.")).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("В коробе, шт.")).toHaveProperty("disabled", true);
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
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
    await screen.findByText("Нет связи с хостом. Создать смену можно только при связи с ним.");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Создать и открыть" })).toHaveProperty(
        "disabled",
        false,
      ),
    );
    // The form stays the operator's after a lost answer, under the same id.
    fireEvent.change(screen.getByLabelText("План, шт."), { target: { value: "500" } });
    fireEvent.click(screen.getByRole("button", { name: "На день позже" }));
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
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
    ["the capacity", { boxCapacity: 6 }],
    ["the plan", { plannedQty: 500 }],
  ] as const)("does not enter a shift that is not the form's in %s", async (_name, patch) => {
    const database = watched(await copiesOf(CATALOG));
    const { handlers } = renderNew(database.local, {
      create: async () => ({ ...MADE, ...patch }),
    });
    await chooseMilk();
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
    expect(
      await screen.findByText(
        "Смена OCT26-005/S уже была создана раньше: дата 09.10.2026, в коробе 6 шт., план 500 шт. Откройте её или выберите другой товар.",
      ),
    ).toBeTruthy();
    // The form is the host's shift now, and stays still.
    expect(screen.getByLabelText("План, шт.")).toHaveProperty("disabled", true);
    fireEvent.click(await screen.findByRole("button", { name: "Открыть смену OCT26-005/S" }));
    await waitFor(() => expect(handlers.onEntered).toHaveBeenCalledTimes(1));
    expect(handlers.enter.mock.calls).toEqual([[PLANNED.id]]);
    expect(handlers.create).toHaveBeenCalledTimes(1);
  });

  it("goes back to the choice of a product from the notice of a shift made before, and enters nothing", async () => {
    const { handlers } = renderNew(await copiesOf(CATALOG), {
      create: async () => ({ ...MADE, boxCapacity: 6 }),
    });
    await chooseMilk();
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
    await screen.findByText(/уже была создана раньше/);
    fireEvent.click(await screen.findByRole("button", { name: "Другой товар" }));
    expect(await screen.findByLabelText("Название товара")).toBeTruthy();
    expect(screen.queryByText(/уже была создана раньше/)).toBeNull();
    expect(handlers.enter).not.toHaveBeenCalled();
    // A form of its own after that, with a request of its own.
    await chooseMilk();
    expect(screen.getByLabelText("В коробе, шт.")).toHaveProperty("disabled", false);
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
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
    fireEvent.click(screen.getByRole("button", { name: "На день раньше" }));
    fireEvent.change(screen.getByLabelText("План, шт."), { target: { value: "1200" } });
    fireEvent.change(screen.getByLabelText("В коробе, шт."), { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
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
    for (const name of ["На день раньше", "На день позже"]) {
      expect(screen.getByRole("button", { name })).toHaveProperty("disabled", true);
    }
    expect(screen.getByLabelText("План, шт.")).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("В коробе, шт.")).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Открыть смену OCT26-005/S" }));
    await waitFor(() => expect(handlers.onEntered).toHaveBeenCalledTimes(1));
    // The second press made nothing: it entered the shift that was kept.
    expect(handlers.create).toHaveBeenCalledTimes(1);
    expect(enter.mock.calls).toEqual([[PLANNED.id], [PLANNED.id]]);
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
    fireEvent.click(await screen.findByRole("button", { name: "Короб 100×150" }));
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
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
    // The rule fixed the template: there is nothing to choose, yet.
    expect(screen.getByText("Шаблон этикетки короба: Молоко 58×40")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Шаблон этикетки короба" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
    expect(
      await screen.findByText(
        "Шаблон этикетки больше не подходит товару. Выберите другой шаблон или обратитесь в офис.",
      ),
    ).toBeTruthy();
    // Now the operator can act: the choice is shown, with none taken.
    const group = screen.getByRole("group", { name: "Шаблон этикетки короба" });
    expect(screen.getByText("Выберите шаблон этикетки короба.")).toBeTruthy();
    expect(within(group).getByRole("button", { name: "Молоко 58×40" })).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Создать и открыть" })).toHaveProperty(
        "disabled",
        true,
      ),
    );
    fireEvent.click(within(group).getByRole("button", { name: "Коробка 58×40" }));
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
    await screen.findByText("Товар выключен или в архиве: смену не создать. Обратитесь в офис.");
    fireEvent.click(screen.getByRole("button", { name: "Другой товар" }));
    // The refusal belongs to the form it was for.
    expect(screen.queryByText(/Товар выключен/)).toBeNull();
    await chooseMilk();
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
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
    expect(createdCopy(PLANNED)).toEqual({ ...PLANNED, localState: null, entered: false });
  });
});
