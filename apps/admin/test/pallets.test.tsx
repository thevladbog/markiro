/**
 * Cabinet pallet surfaces (06d Task 22): the shift panel's pallet table, the
 * shift form's pallet label-template picker and boxes-per-pallet wording, the
 * per-extension-digit SSCC counters, and the pallet export formats.
 *
 * The SSCC cases here are deliberately written against the LIST response
 * (`{ counters: [...] }`) the API actually returns since 06d Task 11. The
 * previous single-counter mocks kept passing against a shape the server no
 * longer produces, which is exactly what hid the break -- see
 * `.superpowers/sdd/progress.md`'s Task 11 entry.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildPalletLabelTemplates, CABINET_CAPABILITY } from "@markiro/domain";

import type { AccessDocument } from "../src/access/api.js";
import { AccessProvider } from "../src/access/context.js";
import { CounterpartyForm } from "../src/pages/counterparties/CounterpartyForm.js";
import type { ProductDto } from "../src/pages/catalog/api.js";
import type { LabelTemplateSummaryDto } from "../src/pages/labels/api.js";
import { LabelEditorPage } from "../src/pages/labels/editor/index.js";
import { OrgProfilePage } from "../src/pages/settings/OrgProfilePage.js";
import type { ShiftDto } from "../src/pages/shifts/api.js";
import { ShiftDetailsPanel } from "../src/pages/shifts/ShiftDetailsPanel.js";
import { ShiftExportsContent } from "../src/pages/shifts/ShiftExportsDialog.js";
import {
  BOX_TEMPLATE_SELECTION,
  ShiftForm,
  type ShiftFormValues,
} from "../src/pages/shifts/ShiftForm.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Minimal Response stand-in -- only what apps/admin/src/api/client.ts reads. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  } as Response;
}

function newQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

const SHIFT: ShiftDto = {
  validationPrint: {
    mode: "none",
    verification: "none",
    templateId: null,
    snapshot: null,
    policyRevision: null,
  },
  id: "11111111-1111-4111-8111-111111111111",
  number: "SEP26-001",
  status: "closed",
  mode: "aggregation",
  productId: "p1",
  productName: "Молоко 1л",
  lineId: null,
  lineName: "Линия розлива № 1",
  counterpartyId: null,
  counterpartyName: null,
  ssccIssuerCounterpartyId: null,
  boxLabelTemplateId: null,
  palletLabelTemplateId: null,
  plannedQty: 480,
  plannedDate: "2026-09-11",
  productionDate: null,
  boxCapacity: 12,
  palletBoxCapacity: 40,
  palletsEnabled: true,
  createdFrom: "admin",
  openedAt: "2026-09-11T06:00:00.000Z",
  closedAt: "2026-09-11T16:00:00.000Z",
  lateDataAt: null,
  closeReason: "Смена закончена",
  createdAt: "2026-09-11T05:00:00.000Z",
  output: { mode: "aggregation", closedBoxes: 40, containedUnits: 480 },
};

const PALLET = {
  id: "pal-1",
  sscc: "00103460068200000004",
  terminalId: "t1",
  lineName: "Линия розлива № 1",
  operatorId: null,
  boxCount: 12,
  unitCount: 240,
  closedAt: "2026-09-11T15:00:00.000Z",
  contentsChangedAfterClose: false,
  disassembledAt: null,
};

const SUMMARY = {
  generatedAt: "2026-09-11T16:05:00.000Z",
  output: { mode: "aggregation", closedBoxes: 40, containedUnits: 480 },
  participants: [],
  unattributed: { eventCount: 0, acceptedScans: 0, closedBoxes: 0 },
};

const ACCESS: AccessDocument = {
  roles: ["owner"],
  capabilities: [...Object.values(CABINET_CAPABILITY)],
};

/**
 * Answers every request the shift panel makes. `pallets` is the only branch
 * a test normally overrides; `exports`/`formats` keep the exports section
 * quiet so the pallet table is what the assertions see.
 */
function routeShiftPanelFetch(overrides: {
  pallets?: () => Response;
}): (input: RequestInfo | URL) => Promise<Response> {
  return async (input) => {
    const url = String(input);
    if (url.startsWith("/api/pallets")) {
      return overrides.pallets?.() ?? jsonResponse(200, { items: [] });
    }
    if (url.includes("/summary")) return jsonResponse(200, SUMMARY);
    if (url.includes("/exports")) return jsonResponse(200, []);
    if (url.includes("/shift-exports/formats")) return jsonResponse(200, []);
    return jsonResponse(200, { items: [] });
  };
}

function renderShiftPanel(shift: ShiftDto = SHIFT) {
  return render(
    <QueryClientProvider client={newQueryClient()}>
      <AccessProvider value={ACCESS}>
        <MemoryRouter>
          <ShiftDetailsPanel shift={shift} onClose={() => undefined} />
        </MemoryRouter>
      </AccessProvider>
    </QueryClientProvider>,
  );
}

describe("shift panel pallet table", () => {
  it("lists a shift's pallets with their box and unit counts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(routeShiftPanelFetch({ pallets: () => jsonResponse(200, { items: [PALLET] }) })),
    );
    renderShiftPanel();

    const section = await screen.findByRole("region", { name: "Паллеты" });
    // Rendered in the same GS1 human-readable form as the box table's SSCC.
    expect(await within(section).findByText("(00)103460068200000004")).toBeDefined();
    expect(within(section).getByText("12")).toBeDefined();
    expect(within(section).getByText("240")).toBeDefined();
  });

  it("warns when a closed pallet lost a box after it was labelled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        routeShiftPanelFetch({
          pallets: () =>
            jsonResponse(200, {
              items: [{ ...PALLET, contentsChangedAfterClose: true }],
            }),
        }),
      ),
    );
    renderShiftPanel();

    const section = await screen.findByRole("region", { name: "Паллеты" });
    expect(await within(section).findByText("Состав изменился после закрытия")).toBeDefined();
  });

  it("does not query or show pallets for a shift that never used them", async () => {
    const fetchMock = vi.fn(routeShiftPanelFetch({}));
    vi.stubGlobal("fetch", fetchMock);
    renderShiftPanel({ ...SHIFT, palletsEnabled: false });

    await screen.findByText("Параметры смены");
    expect(screen.queryByRole("region", { name: "Паллеты" })).toBeNull();
    expect(fetchMock.mock.calls.some((call) => String(call[0]).startsWith("/api/pallets"))).toBe(
      false,
    );
  });

  it("reports a failed pallet load instead of rendering an empty stack", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(routeShiftPanelFetch({ pallets: () => jsonResponse(500, { message: "boom" }) })),
    );
    renderShiftPanel();

    const section = await screen.findByRole("region", { name: "Паллеты" });
    expect(await within(section).findByText("Не удалось загрузить паллеты смены.")).toBeDefined();
  });
});

const PRODUCT: ProductDto = {
  id: "p1",
  gtin14: "04006381333931",
  name: "Молоко 1л",
  printName: null,
  productGroup: "Молочная продукция",
  chzProductGroupCode: 8,
  boxCapacity: 12,
  palletBoxCapacity: 40,
  unitPrice: null,
  egaisCode: null,
  shelfLifeDays: null,
  externalRef: null,
  status: "active",
  archived: false,
  defaultCounterpartyId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const PALLET_TEMPLATE: LabelTemplateSummaryDto = {
  id: "tpl-pallet",
  name: "Паллета 100×150",
  purpose: "pallet",
  widthMm: 100,
  heightMm: 150,
  dpi: 203,
  language: "zpl",
  enabled: true,
  chzProductGroupCodes: null,
  updatedAt: "2026-09-01T00:00:00.000Z",
};

const BOX_TEMPLATE: LabelTemplateSummaryDto = {
  ...PALLET_TEMPLATE,
  id: "tpl-box",
  name: "Короб 58×40",
  purpose: "box",
  widthMm: 58,
  heightMm: 40,
};

const AGGREGATION_FORM_VALUES: ShiftFormValues = {
  productId: PRODUCT.id,
  mode: "aggregation",
  validationPrintMode: "none",
  verificationRequired: true,
  productLabelTemplateId: "",
  plannedQty: "480",
  plannedDate: "2026-09-11",
  productionDate: "",
  lineId: "",
  counterpartyId: "",
  ssccIssuerCounterpartyId: "",
  boxLabelTemplateSelection: BOX_TEMPLATE_SELECTION.none,
  palletLabelTemplateId: "",
  boxCapacity: "12",
  palletBoxCapacity: "40",
  palletsEnabled: false,
};

function renderShiftForm(initialValues: ShiftFormValues) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse(200, { defaultBoxLabelTemplateId: null, defaultSource: null })),
  );
  return render(
    <QueryClientProvider client={newQueryClient()}>
      <MemoryRouter>
        <ShiftForm
          mode="create"
          initialValues={initialValues}
          products={[PRODUCT]}
          lines={[]}
          counterparties={[]}
          formContext={{ labelTemplates: [BOX_TEMPLATE, PALLET_TEMPLATE] }}
          onSubmit={() => undefined}
          onDirtyChange={() => undefined}
          onClose={() => undefined}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("shift form pallet configuration", () => {
  it("offers a pallet template picker only once pallets are switched on", async () => {
    const user = userEvent.setup();
    renderShiftForm(AGGREGATION_FORM_VALUES);

    expect(screen.queryByLabelText("Шаблон этикетки паллеты")).toBeNull();

    await user.click(screen.getByLabelText("Использовать паллеты"));

    expect(await screen.findByLabelText("Шаблон этикетки паллеты")).toBeDefined();
  });

  it("offers only pallet-purpose templates in the pallet picker", async () => {
    const user = userEvent.setup();
    renderShiftForm({ ...AGGREGATION_FORM_VALUES, palletsEnabled: true });

    await user.click(screen.getByLabelText("Шаблон этикетки паллеты"));

    expect(await screen.findByRole("option", { name: "Паллета 100×150" })).toBeDefined();
    expect(screen.queryByRole("option", { name: "Короб 58×40" })).toBeNull();
  });

  it("labels the shift capacity field in boxes, not units", () => {
    renderShiftForm({ ...AGGREGATION_FORM_VALUES, palletsEnabled: true });

    expect(screen.getByLabelText("Коробов на паллете")).toBeDefined();
    expect(screen.queryByLabelText("Вместимость паллеты, шт")).toBeNull();
    // The field changed MEANING, not just its name, so the hint has to say so.
    expect(screen.getByText("Сколько закрытых коробов встаёт на одну паллету.")).toBeDefined();
  });
});

const FORMATS = [
  {
    id: "shift_txt_boxes",
    version: 2,
    label: "[TXT][С коробами] Отчет смены",
    extension: "txt",
    mimeType: "text/plain; charset=utf-8",
    boxMode: "boxes",
  },
  {
    id: "shift_txt_pallets",
    version: 1,
    label: "[TXT][Паллеты] Отчет смены",
    extension: "txt",
    mimeType: "text/plain; charset=utf-8",
    boxMode: "pallets",
  },
  {
    id: "shift_csv_pallets",
    version: 1,
    label: "[CSV][Паллеты] Отчет смены",
    extension: "csv",
    mimeType: "text/csv; charset=utf-8",
    boxMode: "pallets",
  },
  {
    id: "shift_xml_gismt_aggregation_pallets",
    version: 1,
    label: "[XML][ГИСМТ] Паллетная агрегация",
    extension: "xml",
    mimeType: "application/xml; charset=utf-8",
    boxMode: "pallets",
  },
] as const;

function failedExport(errorCode: string) {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    shiftId: SHIFT.id,
    formatId: "shift_txt_pallets",
    formatVersion: 1,
    maxLines: null,
    status: "failed",
    errorCode,
    productNameSnapshot: "Молоко 1л",
    shiftDateSnapshot: "2026-09-11",
    totalCodeCount: null,
    totalBoxCount: null,
    createdByUserId: "u1",
    createdByName: "Иван Иванов",
    sourceSnapshotStartedAt: null,
    completedAt: "2026-09-11T17:00:00.000Z",
    attemptCount: 1,
    createdAt: "2026-09-11T17:00:00.000Z",
    stale: false,
    artifacts: [],
  };
}

function renderExports(shift: ShiftDto, exportsBody: unknown = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/shift-exports/formats")) return jsonResponse(200, FORMATS);
      return jsonResponse(200, exportsBody);
    }),
  );
  return render(
    <QueryClientProvider client={newQueryClient()}>
      <MemoryRouter>
        <ShiftExportsContent shift={shift} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("pallet export formats", () => {
  it("offers the pallet formats for a shift that used pallets", async () => {
    renderExports(SHIFT);

    expect(await screen.findByLabelText("[TXT][Паллеты] Отчет смены")).toBeDefined();
    expect(screen.getByLabelText("[CSV][Паллеты] Отчет смены")).toBeDefined();
    expect(screen.getByLabelText("[XML][ГИСМТ] Паллетная агрегация")).toBeDefined();
  });

  it("hides every pallet format for a shift that never used pallets", async () => {
    renderExports({ ...SHIFT, palletsEnabled: false });

    expect(await screen.findByLabelText("[TXT][С коробами] Отчет смены")).toBeDefined();
    expect(screen.queryByText(/паллет/i)).toBeNull();
  });

  it("explains a pallet export that found no closed pallet", async () => {
    renderExports(SHIFT, [failedExport("SHIFT_HAS_NO_PALLETS")]);

    expect(
      await screen.findByText(
        "В смене нет закрытых паллет: коробы не ставились на паллеты либо ни одна паллета ещё не закрыта.",
      ),
    ).toBeDefined();
  });

  it("explains a pallet that does not fit the lines-per-part limit", async () => {
    renderExports(SHIFT, [failedExport("PALLET_EXCEEDS_LINE_LIMIT")]);

    expect(
      await screen.findByText(
        "Паллета вместе со своими коробами не помещается в установленное ограничение строк.",
      ),
    ).toBeDefined();
  });
});

const BOX_COUNTER = { extensionDigit: 0, nextSerial: 41, minSerial: 40, blockedBy: null };
const PALLET_COUNTER = { extensionDigit: 1, nextSerial: 7, minSerial: 0, blockedBy: null };

const ORG_PROFILE = {
  gln: "4606203000012",
  inn: "7712345678",
  timeZone: "Europe/Moscow",
  gs1Prefixes: ["4606203"],
  defaultBoxLabelTemplateId: null,
  categoryBoxLabelTemplateDefaults: [],
  productGroupsInUse: [],
  pickupLimitsEnabled: false,
  logoUrl: null,
};

function renderOrgProfile(counters: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/org/profile/sscc") return jsonResponse(200, { counters });
      if (url === "/api/org/profile") return jsonResponse(200, ORG_PROFILE);
      return jsonResponse(200, { items: [] });
    }),
  );
  return render(
    <QueryClientProvider client={newQueryClient()}>
      <MemoryRouter>
        <OrgProfilePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("SSCC counters per extension digit", () => {
  it("shows a seedable counter for boxes and for pallets", async () => {
    renderOrgProfile([BOX_COUNTER, PALLET_COUNTER]);

    expect(await screen.findByText("Короба")).toBeDefined();
    expect(screen.getByText("Паллеты")).toBeDefined();
    expect(
      (screen.getByLabelText("Начальный серийный номер короба") as HTMLInputElement).value,
    ).toBe("41");
    expect(
      (screen.getByLabelText("Начальный серийный номер паллеты") as HTMLInputElement).value,
    ).toBe("7");
  });

  it("shows the blocker that belongs to each counter, not a silent fallback", async () => {
    renderOrgProfile([
      {
        ...BOX_COUNTER,
        blockedBy: { kind: "active_shift", shiftId: "s1", shiftNumber: "SEP26-001" },
      },
      PALLET_COUNTER,
    ]);

    await screen.findByText("Короба");
    expect(screen.getByText(/Пока открыта смена SEP26-001/)).toBeDefined();
    expect(
      (screen.getByLabelText("Начальный серийный номер короба") as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByLabelText("Начальный серийный номер паллеты") as HTMLInputElement).disabled,
    ).toBe(false);
  });

  it("seeds the counter the operator edited, naming its own extension digit", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/org/profile/sscc" && init?.method === "PUT") {
        return jsonResponse(200, { extensionDigit: 1, nextSerial: 9 });
      }
      if (url === "/api/org/profile/sscc") {
        return jsonResponse(200, { counters: [BOX_COUNTER, PALLET_COUNTER] });
      }
      if (url === "/api/org/profile") return jsonResponse(200, ORG_PROFILE);
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={newQueryClient()}>
        <MemoryRouter>
          <OrgProfilePage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const field = await screen.findByLabelText("Начальный серийный номер паллеты");
    await user.clear(field);
    await user.type(field, "9");
    await user.click(screen.getByRole("button", { name: "Сохранить счётчик паллет" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/org/profile/sscc",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ extensionDigit: 1, nextSerial: 9 }),
        }),
      );
    });
  });

  it("accepts a pallet serial of 0, which the box counter forbids", async () => {
    renderOrgProfile([BOX_COUNTER, { ...PALLET_COUNTER, nextSerial: 0 }]);

    const field = (await screen.findByLabelText(
      "Начальный серийный номер паллеты",
    )) as HTMLInputElement;
    expect(field.value).toBe("0");
  });
});

describe("counterparty SSCC counters", () => {
  it("shows both counters for a counterparty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/counterparties/cp1/sscc") {
          return jsonResponse(200, { counters: [BOX_COUNTER, PALLET_COUNTER] });
        }
        return jsonResponse(200, { items: [] });
      }),
    );
    render(
      <QueryClientProvider client={newQueryClient()}>
        <MemoryRouter>
          <CounterpartyForm
            mode="edit"
            counterpartyId="cp1"
            initialValues={{
              name: "Acme Ltd",
              gln: "4606203000012",
              inn: "",
              gs1Prefixes: "",
              notes: "",
            }}
            onSubmit={() => undefined}
            onDirtyChange={() => undefined}
            onBusyChange={() => undefined}
            onClose={() => undefined}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Короба")).toBeDefined();
    expect(screen.getByText("Паллеты")).toBeDefined();
    expect(
      (screen.getByLabelText("Начальный серийный номер паллеты") as HTMLInputElement).value,
    ).toBe("7");
  });
});

describe("pallet label templates in the editor", () => {
  /**
   * `POST /label-templates` only accepts `purpose` "box" or
   * "product_duplicate" (`purposeSchema`, apps/api's label-templates/dto.ts),
   * so "Копировать" on a pallet template would send a purpose the server
   * rejects with an opaque 400. The button has to be absent and the reason
   * stated, not discovered by an operator after laying out a label.
   */
  function renderEditor(template: unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, template)),
    );
    return render(
      <QueryClientProvider client={newQueryClient()}>
        <MemoryRouter initialEntries={["/labels/tpl-pallet"]}>
          <Routes>
            <Route
              path="/labels/:id"
              element={
                <LabelEditorPage
                  rasterizeText={async () => ({
                    hex: "00",
                    totalBytes: 1,
                    bytesPerRow: 1,
                    width: 8,
                    height: 1,
                  })}
                  checkFamilyCoverage={async () => true}
                />
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  const STOCK_PALLET_TEMPLATE = {
    id: "tpl-pallet",
    name: "Паллета 100×150",
    purpose: "pallet",
    spec: buildPalletLabelTemplates()[0]!.spec,
    enabled: true,
    chzProductGroupCodes: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };

  it("refuses to copy a pallet template and says why", async () => {
    renderEditor(STOCK_PALLET_TEMPLATE);

    expect(
      await screen.findByText(
        "Свои шаблоны этикеток паллет пока нельзя создавать: используйте стоковый шаблон.",
      ),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: "Создать копию" })).toBeNull();
  });

  it("still offers the copy action for a box template", async () => {
    renderEditor({ ...STOCK_PALLET_TEMPLATE, purpose: "box", name: "Короб 58×40" });

    expect(await screen.findByRole("button", { name: "Создать копию" })).toBeDefined();
  });
});
