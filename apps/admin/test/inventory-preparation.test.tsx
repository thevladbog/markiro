import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";
import { ThemeProvider } from "@markiro/ui";

import type { AccessDocument } from "../src/access/api.js";
import { appRoutes } from "../src/app.js";
import {
  AuthClientProvider,
  type AuthClientLike,
  type OrganizationSummary,
  type SessionData,
} from "../src/auth/client.js";
import i18n from "../src/i18n/index.js";

const ID = {
  inventory: "11111111-1111-4111-8111-111111111111",
  product: "22222222-2222-4222-8222-222222222222",
  line: "33333333-3333-4333-8333-333333333333",
  template: "44444444-4444-4444-8444-444444444444",
  snapshot: "55555555-5555-4555-8555-555555555555",
  emitted: "60000000-0000-4000-8000-000000000001",
  introducedOld: "60000000-0000-4000-8000-000000000002",
  introducedNew: "60000000-0000-4000-8000-000000000003",
  applied: "60000000-0000-4000-8000-000000000004",
  retired: "60000000-0000-4000-8000-000000000005",
  writtenOff: "60000000-0000-4000-8000-000000000006",
  disaggregation: "60000000-0000-4000-8000-000000000007",
} as const;

const SESSION: SessionData = {
  session: { activeOrganizationId: "org_1" },
  user: { id: "user_1", email: "user@example.com", name: "Елена Ким" },
};
const ORGANIZATIONS: OrganizationSummary[] = [{ id: "org_1", name: "Марка Ко", slug: "marka" }];
const ACCESS: AccessDocument = {
  roles: ["manager"],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ, CABINET_CAPABILITY.OPERATIONS_WRITE],
};
const READ_ACCESS: AccessDocument = {
  roles: ["member"],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ],
};

const BASE_INVENTORY = {
  id: ID.inventory,
  number: "IVN-26-0042",
  status: "preparing",
  mode: "repack",
  productId: ID.product,
  gtin14: "04680089900383",
  productName: "Пиво светлое 0,45 л",
  lineId: ID.line,
  lineName: "Упаковка А",
  productionDateFrom: "2025-09-01",
  productionDateTo: "2025-12-31",
  boxLabelTemplateId: ID.template,
  boxLabelTemplate: { id: ID.template, name: "Короб 20 бутылок" },
  activeSnapshotId: null,
  resultRevision: 0,
  createdAt: "2026-08-26T09:00:00.000Z",
  updatedAt: "2026-08-26T09:05:00.000Z",
};
const BLOCKERS = {
  activeParticipantCount: 0,
  pendingEventCount: 0,
  participantOpenBoxCount: 0,
  openRepackBoxCount: 0,
  unresolvedPrintBoxCount: 0,
};
const IMPORTS = [
  attempt(ID.emitted, "EMITTED", "emitted.zip", 166, "2026-08-26T09:01:00.000Z"),
  attempt(ID.introducedNew, "INTRODUCED", "introduced-new.zip", 4323, "2026-08-26T09:08:00.000Z"),
  attempt(ID.introducedOld, "INTRODUCED", "introduced-old.zip", 4310, "2026-08-26T09:02:00.000Z"),
  attempt(ID.applied, "APPLIED", "applied-empty.zip", 0, "2026-08-26T09:03:00.000Z"),
  attempt(ID.retired, "RETIRED", "retired.zip", 1868, "2026-08-26T09:04:00.000Z"),
  attempt(ID.writtenOff, "WRITTEN_OFF", "written-off.zip", 1460, "2026-08-26T09:05:00.000Z"),
  attempt(
    ID.disaggregation,
    "DISAGGREGATION",
    "disaggregation-empty.zip",
    0,
    "2026-08-26T09:06:00.000Z",
  ),
  {
    ...attempt(
      "60000000-0000-4000-8000-000000000009",
      "WRITTEN_OFF",
      "written-off-invalid.zip",
      0,
      "2026-08-26T09:07:00.000Z",
    ),
    parsedStatus: null,
    result: "failed",
    errorCount: 1,
    diagnostics: [{ code: "CHZ_STATUS_MISMATCH", rowNumber: 12 }],
  },
];

function attempt(
  id: string,
  declaredStatus: string,
  fileName: string,
  rowCount: number,
  createdAt: string,
) {
  return {
    id,
    declaredStatus,
    parsedStatus: declaredStatus,
    fileName,
    result: "succeeded",
    rowCount,
    errorCount: 0,
    duplicateCount: 0,
    sha256: id.replaceAll("-", "").padEnd(64, "0").slice(0, 64),
    diagnostics: [],
    createdAt,
  };
}

function detail(overrides: Record<string, unknown> = {}) {
  return {
    ...BASE_INVENTORY,
    blockers: BLOCKERS,
    imports: IMPORTS,
    activeSnapshot: null,
    ...overrides,
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function authClient(): AuthClientLike {
  return {
    useSession: () => ({ data: SESSION, isPending: false, error: null }),
    useListOrganizations: () => ({ data: ORGANIZATIONS, isPending: false, error: null }),
    signIn: { email: async () => ({ data: {}, error: null }) },
    signUp: { email: async () => ({ data: {}, error: null }) },
    resetPassword: async () => ({ data: { status: true }, error: null }),
    signOut: async () => ({ data: {}, error: null }),
    organization: {
      create: async () => ({ data: { id: "org_1" }, error: null }),
      list: async () => ({ data: ORGANIZATIONS, error: null }),
      setActive: async () => ({ data: {}, error: null }),
    },
  };
}

function renderRoute(path: string, fetcher: typeof fetch, access = ACCESS) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/access/me")) return response(access);
      return fetcher(input, init);
    }),
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createMemoryRouter(appRoutes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="light">
        <AuthClientProvider client={authClient()}>
          <RouterProvider router={router} />
        </AuthClientProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  return { router, user: userEvent.setup() };
}

function shellDependency(url: string): Response | null {
  if (url.endsWith("/api/profile")) {
    return response({ firstName: "Елена", lastName: "Ким", middleName: null, hasAvatar: false });
  }
  if (url.includes("/api/pickup-orders")) return response({ items: [] });
  return null;
}

function parameterDependency(url: string): Response | null {
  if (url === "/api/products" || url.startsWith("/api/products?")) {
    return response({
      items: [
        {
          id: ID.product,
          gtin14: "04680089900383",
          name: "Пиво светлое 0,45 л",
          productGroup: "beer",
          chzProductGroupCode: 15,
          boxCapacity: 20,
          palletCapacity: 60,
          unitPrice: null,
          printName: null,
          egaisCode: null,
          shelfLifeDays: 180,
          externalRef: null,
          status: "active",
          defaultCounterpartyId: null,
          createdAt: "2026-08-01T00:00:00.000Z",
        },
      ],
    });
  }
  if (url === "/api/lines") {
    return response({ items: [{ id: ID.line, name: "Упаковка А", createdAt: "2026-08-01" }] });
  }
  if (url === "/api/label-templates") {
    return response({
      items: [
        {
          id: ID.template,
          name: "Короб 20 бутылок",
          widthMm: 58,
          heightMm: 40,
          dpi: 203,
          language: "zpl",
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
      ],
    });
  }
  if (url === "/api/shifts/planning-config") {
    return response({ defaultBoxLabelTemplateId: ID.template });
  }
  return null;
}

async function chooseDate(
  user: ReturnType<typeof userEvent.setup>,
  fieldName: string,
  isoDate: string,
) {
  await user.click(screen.getByRole("button", { name: fieldName }));
  const now = new Date();
  const target = new Date(`${isoDate}T12:00:00`);
  const monthDelta =
    (target.getFullYear() - now.getFullYear()) * 12 + target.getMonth() - now.getMonth();
  const navigationName = monthDelta < 0 ? "Предыдущий месяц" : "Следующий месяц";
  for (let index = 0; index < Math.abs(monthDelta); index += 1) {
    await user.click(screen.getByRole("button", { name: navigationName }));
  }
  const dayName = new Intl.DateTimeFormat("ru", {
    day: "numeric",
    month: "long",
    year: "numeric",
  })
    .format(target)
    .replace(/\sг\.$/u, "");
  await user.click(screen.getByRole("button", { name: dayName }));
}

function fileInput(status: string): HTMLInputElement {
  const slot = document.getElementById(`inventory-slot-${status}`);
  if (!slot) throw new Error(`Missing inventory-slot-${status}`);
  return within(slot).getByTestId("file-drop-input") as HTMLInputElement;
}

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("ru");
});

it("creates one-product parameters with inclusive dates, mode, template, and line", async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const { user, router } = renderRoute("/inventory/new", async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    const dependency = shellDependency(url);
    if (dependency) return dependency;
    const parameter = parameterDependency(url);
    if (parameter) return parameter;
    if (url === "/api/inventories" && init?.method === "POST") {
      return response({ ...BASE_INVENTORY, status: "draft" }, 201);
    }
    if (url === `/api/inventories/${ID.inventory}`) return response(detail());
    throw new Error(`Unexpected request: ${url}`);
  });

  fireEvent.click(await screen.findByRole("combobox", { name: "Продукт" }));
  fireEvent.click(await screen.findByRole("option", { name: /Пиво светлое/ }));
  await user.click(screen.getByRole("radio", { name: /С переупаковкой/ }));
  fireEvent.click(screen.getByRole("combobox", { name: "Линия" }));
  fireEvent.click(await screen.findByRole("option", { name: "Упаковка А" }));
  fireEvent.click(screen.getByRole("combobox", { name: "Шаблон этикетки короба" }));
  fireEvent.click(await screen.findByRole("option", { name: "Короб 20 бутылок" }));
  await chooseDate(user, "Дата производства с", "2025-09-01");
  await chooseDate(user, "Дата производства по", "2025-12-31");
  await user.click(screen.getByRole("button", { name: "К выпискам ЧЗ" }));

  await waitFor(() =>
    expect(
      requests.some(({ url, init }) => url === "/api/inventories" && init?.method === "POST"),
    ).toBe(true),
  );
  const create = requests.find(
    ({ url, init }) => url === "/api/inventories" && init?.method === "POST",
  );
  expect(JSON.parse(String(create?.init?.body))).toEqual({
    productId: ID.product,
    lineId: ID.line,
    mode: "repack",
    productionDateFrom: "2025-09-01",
    productionDateTo: "2025-12-31",
    boxLabelTemplateId: ID.template,
  });
  await waitFor(() => expect(router.state.location.pathname).toBe(`/inventory/${ID.inventory}`));
  expect(await screen.findByText("Период применяется включительно")).toBeDefined();
});

it("keeps six independent slots, zero-row success, replacement history, and exact snapshot ids", async () => {
  let currentDetail = detail();
  const posts: Array<{ url: string; body: unknown }> = [];
  const { user } = renderRoute(`/inventory/${ID.inventory}`, async (input, init) => {
    const url = String(input);
    const dependency = shellDependency(url);
    if (dependency) return dependency;
    if (url === `/api/inventories/${ID.inventory}` && !init?.method) return response(currentDetail);
    if (url.endsWith("/imports/INTRODUCED") && init?.method === "POST") {
      const uploaded = attempt(
        "60000000-0000-4000-8000-000000000008",
        "INTRODUCED",
        "introduced-replacement.zip",
        4325,
        "2026-08-26T09:12:00.000Z",
      );
      currentDetail = detail({ imports: [uploaded, ...IMPORTS] });
      posts.push({ url, body: init.body });
      const uploadResponse = { ...uploaded };
      delete (uploadResponse as Partial<typeof uploaded>).fileName;
      delete (uploadResponse as Partial<typeof uploaded>).createdAt;
      return response(uploadResponse, 201);
    }
    if (url.endsWith("/snapshots") && init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      const snapshot = {
        id: ID.snapshot,
        inventoryId: ID.inventory,
        revision: 1,
        combinedDigest: "a".repeat(64),
        fixedAt: "2026-08-26T09:15:00.000Z",
        inputs: (JSON.parse(String(init.body)) as { imports: unknown }).imports,
        counts: {
          emitted: 166,
          introduced: 4323,
          applied: 0,
          retired: 1868,
          writtenOff: 1460,
          disaggregation: 0,
          protected: 207,
          expected: 4116,
          packages: 48,
          loose: 3828,
        },
      };
      currentDetail = detail({
        status: "ready",
        activeSnapshotId: ID.snapshot,
        activeSnapshot: snapshot,
      });
      return response(snapshot, 201);
    }
    if (url === "/api/lines/presence") return response({ items: [] });
    throw new Error(`Unexpected request: ${url}`);
  });

  expect(await screen.findByRole("heading", { name: "Выписки по статусам кодов" })).toBeDefined();
  expect(screen.getAllByTestId("inventory-upload-slot")).toHaveLength(6);
  expect(document.getElementById("inventory-slot-APPLIED")?.textContent).toContain(
    "0 · ошибок: 0 · дублей: 0",
  );
  expect(screen.getByText("introduced-old.zip")).toBeDefined();
  expect(screen.getByText("introduced-new.zip")).toBeDefined();
  expect(screen.getByText(/ошибок: 1/)).toBeDefined();
  expect(screen.getByText(/CHZ_STATUS_MISMATCH/)).toBeDefined();

  const file = new File(["replacement"], "introduced-replacement.zip", {
    type: "application/zip",
  });
  expect(screen.getByRole("button", { name: "Выбрать файл INTRODUCED" })).toBeDefined();
  await user.upload(fileInput("INTRODUCED"), file);
  await waitFor(() =>
    expect(posts.some(({ url }) => url.endsWith("/imports/INTRODUCED"))).toBe(true),
  );
  await user.click(await screen.findByRole("radio", { name: /introduced-old\.zip/ }));
  await user.click(screen.getByRole("button", { name: "Проверить снимок" }));
  expect(await screen.findByRole("heading", { name: "Проверка снимка" })).toBeDefined();
  expect(screen.getByText("Ожидаемый остаток")).toBeDefined();
  expect(screen.getByText("Рассчитается после фиксации")).toBeDefined();
  await user.click(screen.getByRole("button", { name: "Зафиксировать снимок" }));

  expect(posts.find(({ url }) => url.endsWith("/snapshots"))?.body).toEqual({
    imports: {
      EMITTED: ID.emitted,
      INTRODUCED: ID.introducedOld,
      APPLIED: ID.applied,
      RETIRED: ID.retired,
      WRITTEN_OFF: ID.writtenOff,
      DISAGGREGATION: ID.disaggregation,
    },
  });
  expect(await screen.findByRole("heading", { name: "Проверка снимка" })).toBeDefined();
  expect(await screen.findByText("Ожидаемый остаток: 4 116")).toBeDefined();
  await user.click(screen.getByRole("button", { name: "К терминалам" }));
  expect(await screen.findByRole("heading", { name: "Доступ терминалов" })).toBeDefined();
  await user.click(screen.getByRole("button", { name: "Назад" }));
  expect(await screen.findByRole("heading", { name: "Проверка снимка" })).toBeDefined();
  await user.click(screen.getByRole("button", { name: "К терминалам" }));
  expect(await screen.findByRole("heading", { name: "Доступ терминалов" })).toBeDefined();
});

it("refreshes persisted failed upload attempts and diagnostics after a 422 response", async () => {
  let currentDetail = detail();
  const failedAttempt = {
    ...attempt(
      "60000000-0000-4000-8000-000000000010",
      "WRITTEN_OFF",
      "written-off-persisted-failure.zip",
      0,
      "2026-08-26T09:13:00.000Z",
    ),
    parsedStatus: null,
    result: "failed",
    errorCount: 2,
    diagnostics: [{ code: "MALFORMED_EXPORT", rowNumber: 8 }],
  };
  const { user } = renderRoute(`/inventory/${ID.inventory}`, async (input, init) => {
    const url = String(input);
    const dependency = shellDependency(url);
    if (dependency) return dependency;
    if (url === `/api/inventories/${ID.inventory}` && !init?.method) return response(currentDetail);
    if (url.endsWith("/imports/WRITTEN_OFF") && init?.method === "POST") {
      currentDetail = detail({ imports: [failedAttempt, ...IMPORTS] });
      return response({ code: "INVALID_IMPORT", message: "Выписка содержит ошибки" }, 422);
    }
    throw new Error(`Unexpected request: ${url}`);
  });

  expect(await screen.findByRole("heading", { name: "Выписки по статусам кодов" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Выбрать файл WRITTEN_OFF" })).toBeDefined();
  await user.upload(
    fileInput("WRITTEN_OFF"),
    new File(["invalid"], "written-off-persisted-failure.zip", { type: "application/zip" }),
  );

  expect(await screen.findByText("written-off-persisted-failure.zip")).toBeDefined();
  expect(screen.getByText(/MALFORMED_EXPORT/)).toBeDefined();
  expect(screen.getByText(/ошибок: 2/)).toBeDefined();
});

it("shows a localized upload error inside the status slot that rejected the file", async () => {
  const { user } = renderRoute(`/inventory/${ID.inventory}`, async (input, init) => {
    const url = String(input);
    const dependency = shellDependency(url);
    if (dependency) return dependency;
    if (url === `/api/inventories/${ID.inventory}` && !init?.method) return response(detail());
    if (url.endsWith("/imports/RETIRED") && init?.method === "POST") {
      return response(
        { message: "File too large", error: "Payload Too Large", statusCode: 413 },
        413,
      );
    }
    throw new Error(`Unexpected request: ${url}`);
  });

  expect(await screen.findByRole("heading", { name: "Выписки по статусам кодов" })).toBeDefined();
  await user.upload(
    fileInput("RETIRED"),
    new File(["oversized"], "retired.csv", { type: "text/csv" }),
  );

  const slot = document.getElementById("inventory-slot-RETIRED");
  if (!slot) throw new Error("Missing RETIRED inventory slot");
  const alert = await within(slot).findByRole("alert");
  expect(alert.textContent).toContain("Файл слишком большой. Максимальный размер — 64 МБ.");
  expect(alert.textContent).not.toMatch(/HTTP|File too large/i);
  expect(screen.getAllByRole("alert")).toHaveLength(1);
});

it("updates editable parameters through PATCH and returns to exports", async () => {
  let currentDetail = detail();
  let patchBody: unknown;
  const { user } = renderRoute(`/inventory/${ID.inventory}`, async (input, init) => {
    const url = String(input);
    const dependency = shellDependency(url) ?? parameterDependency(url);
    if (dependency) return dependency;
    if (url === `/api/inventories/${ID.inventory}` && !init?.method) return response(currentDetail);
    if (url === `/api/inventories/${ID.inventory}` && init?.method === "PATCH") {
      patchBody = JSON.parse(String(init.body));
      currentDetail = detail({
        mode: "check",
        boxLabelTemplateId: null,
        boxLabelTemplate: null,
      });
      return response({
        ...BASE_INVENTORY,
        mode: "check",
        boxLabelTemplateId: null,
        boxLabelTemplate: null,
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  });

  expect(await screen.findByRole("heading", { name: "Выписки по статусам кодов" })).toBeDefined();
  await user.click(screen.getByRole("button", { name: "Назад к параметрам" }));
  expect(await screen.findByRole("heading", { name: "Параметры задания" })).toBeDefined();
  await user.click(screen.getByRole("radio", { name: "Без переупаковки" }));
  await user.click(screen.getByRole("button", { name: "Сохранить и продолжить" }));

  await waitFor(() =>
    expect(patchBody).toEqual({
      productId: ID.product,
      lineId: ID.line,
      mode: "check",
      productionDateFrom: "2025-09-01",
      productionDateTo: "2025-12-31",
      boxLabelTemplateId: null,
    }),
  );
  expect(await screen.findByRole("heading", { name: "Выписки по статусам кодов" })).toBeDefined();
});

it("hides parameter editing from inventory readers", async () => {
  renderRoute(
    `/inventory/${ID.inventory}`,
    async (input) => {
      const url = String(input);
      const dependency = shellDependency(url);
      if (dependency) return dependency;
      if (url === `/api/inventories/${ID.inventory}`) return response(detail());
      throw new Error(`Unexpected request: ${url}`);
    },
    READ_ACCESS,
  );

  expect(await screen.findByRole("heading", { name: "Выписки по статусам кодов" })).toBeDefined();
  expect(screen.queryByRole("button", { name: "Назад к параметрам" })).toBeNull();
});

it("recovers the active snapshot after reload and blocks start until warehouse confirmation", async () => {
  const snapshot = {
    id: ID.snapshot,
    inventoryId: ID.inventory,
    revision: 1,
    combinedDigest: "a".repeat(64),
    fixedAt: "2026-08-26T09:15:00.000Z",
    inputs: {
      EMITTED: ID.emitted,
      INTRODUCED: ID.introducedOld,
      APPLIED: ID.applied,
      RETIRED: ID.retired,
      WRITTEN_OFF: ID.writtenOff,
      DISAGGREGATION: ID.disaggregation,
    },
    counts: {
      emitted: 166,
      introduced: 4323,
      applied: 0,
      retired: 1868,
      writtenOff: 1460,
      disaggregation: 0,
      protected: 207,
      expected: 4116,
      packages: 48,
      loose: 3828,
    },
  };
  let starts = 0;
  const { user } = renderRoute(`/inventory/${ID.inventory}`, async (input, init) => {
    const url = String(input);
    const dependency = shellDependency(url);
    if (dependency) return dependency;
    if (url === `/api/inventories/${ID.inventory}` && !init?.method) {
      return response(
        detail({ status: "ready", activeSnapshotId: ID.snapshot, activeSnapshot: snapshot }),
      );
    }
    if (url === "/api/lines/presence") {
      return response({
        items: [
          {
            lineId: ID.line,
            lineName: "Упаковка А",
            assignedStations: 2,
            onlineStations: 1,
            lastSeenAt: "2026-08-26T09:14:00.000Z",
          },
        ],
      });
    }
    if (url.endsWith("/start") && init?.method === "POST") {
      starts += 1;
      return response(
        {
          inventoryId: ID.inventory,
          inventoryNumber: BASE_INVENTORY.number,
          snapshotId: ID.snapshot,
          snapshotRevision: 1,
          snapshotFixedAt: snapshot.fixedAt,
          combinedDigest: snapshot.combinedDigest,
          contentDigest: "b".repeat(64),
          codeCount: 7_817,
          productId: ID.product,
          productName: BASE_INVENTORY.productName,
          productPrintName: null,
          egaisCode: null,
          shelfLifeDays: 180,
          gtin14: BASE_INVENTORY.gtin14,
          boxCapacity: 20,
          mode: "repack",
          lineId: ID.line,
          lineName: BASE_INVENTORY.lineName,
          productionDateFrom: BASE_INVENTORY.productionDateFrom,
          productionDateTo: BASE_INVENTORY.productionDateTo,
          boxLabelTemplate: {
            id: ID.template,
            name: "Короб 20 бутылок",
            spec: { widthMm: 58, heightMm: 40, dpi: 203, language: "zpl", elements: [] },
          },
          limits: { codePageSize: 200, eventBatchSize: 100, progressPageSize: 200 },
        },
        201,
      );
    }
    throw new Error(`Unexpected request: ${url}`);
  });

  expect(await screen.findByRole("heading", { name: "Доступ терминалов" })).toBeDefined();
  expect(await screen.findByText("1 из 2 терминалов в сети")).toBeDefined();
  expect(
    screen.getByText("Печатная A4-форма со штрихкодом для открытия задания на терминале."),
  ).toBeDefined();
  expect(
    screen.getByRole("button", { name: "Открыть форму-задание" }).hasAttribute("disabled"),
  ).toBe(false);
  await user.click(screen.getByRole("button", { name: "К запуску" }));

  const start = screen.getByRole("button", { name: "Запустить инвентаризацию" });
  expect(start.hasAttribute("disabled")).toBe(true);
  expect(screen.getByText("Снимок зафиксирован: 4 116 ожидаемых кодов")).toBeDefined();
  await user.click(screen.getByRole("checkbox", { name: "Движения по складу остановлены" }));
  expect(start.hasAttribute("disabled")).toBe(false);
  await user.click(start);
  await waitFor(() => expect(starts).toBe(1));

  await user.click(screen.getByRole("button", { name: "Назад" }));
  expect(await screen.findByRole("heading", { name: "Доступ терминалов" })).toBeDefined();
  await user.click(screen.getByRole("button", { name: "Назад" }));
  expect(await screen.findByRole("heading", { name: "Проверка снимка" })).toBeDefined();
  await user.click(screen.getByRole("button", { name: "Назад" }));
  expect(
    (await screen.findByRole("radio", { name: /introduced-old\.zip/ })).getAttribute(
      "aria-checked",
    ),
  ).toBe("true");
  expect(
    screen.getByRole("radio", { name: /introduced-new\.zip/ }).getAttribute("aria-checked"),
  ).toBe("false");
  expect(
    screen.queryAllByLabelText(
      /^Выбрать файл (?:EMITTED|INTRODUCED|APPLIED|RETIRED|WRITTEN_OFF|DISAGGREGATION)$/,
    ),
  ).toHaveLength(0);
  expect(screen.getAllByRole("radio").every((control) => control.hasAttribute("disabled"))).toBe(
    true,
  );
  await user.click(screen.getByRole("radio", { name: /introduced-new\.zip/ }));
  expect(
    screen.getByRole("radio", { name: /introduced-old\.zip/ }).getAttribute("aria-checked"),
  ).toBe("true");
  expect(screen.queryByRole("button", { name: "Назад к параметрам" })).toBeNull();
});

it("fails closed when the inventory API returns unknown fields", async () => {
  renderRoute("/inventory", async (input) => {
    const url = String(input);
    const dependency = shellDependency(url);
    if (dependency) return dependency;
    if (url === "/api/inventories") {
      return response({ items: [{ ...BASE_INVENTORY, privateObjectKey: "must-not-be-accepted" }] });
    }
    throw new Error(`Unexpected request: ${url}`);
  });

  expect((await screen.findByRole("alert")).textContent).toContain(
    "Не удалось загрузить инвентаризации",
  );
  expect(screen.queryByText("IVN-26-0042")).toBeNull();
});

it("fails closed when the inventory API returns an impossible civil date", async () => {
  renderRoute("/inventory", async (input) => {
    const url = String(input);
    const dependency = shellDependency(url);
    if (dependency) return dependency;
    if (url === "/api/inventories") {
      return response({ items: [{ ...BASE_INVENTORY, productionDateFrom: "2025-02-30" }] });
    }
    throw new Error(`Unexpected request: ${url}`);
  });

  expect((await screen.findByRole("alert")).textContent).toContain(
    "Не удалось загрузить инвентаризации",
  );
  expect(screen.queryByText("IVN-26-0042")).toBeNull();
});

it.each([
  [
    "has an inverted production range",
    { productionDateFrom: "2025-12-31", productionDateTo: "2025-09-01" },
  ],
  [
    "uses repack mode without a template",
    { mode: "repack", boxLabelTemplateId: null, boxLabelTemplate: null },
  ],
  [
    "uses check mode with a template",
    {
      mode: "check",
      boxLabelTemplateId: ID.template,
      boxLabelTemplate: { id: ID.template, name: "Короб 20 бутылок" },
    },
  ],
  [
    "has a template descriptor for a different id",
    {
      boxLabelTemplateId: ID.template,
      boxLabelTemplate: {
        id: "44444444-4444-4444-8444-444444444445",
        name: "Чужой шаблон",
      },
    },
  ],
])("fails closed when the inventory API response %s", async (_description, overrides) => {
  renderRoute("/inventory", async (input) => {
    const url = String(input);
    const dependency = shellDependency(url);
    if (dependency) return dependency;
    if (url === "/api/inventories") {
      return response({ items: [{ ...BASE_INVENTORY, ...overrides }] });
    }
    throw new Error(`Unexpected request: ${url}`);
  });

  expect((await screen.findByRole("alert")).textContent).toContain(
    "Не удалось загрузить инвентаризации",
  );
  expect(screen.queryByText("IVN-26-0042")).toBeNull();
});
