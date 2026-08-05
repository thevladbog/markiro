import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";

import type { AccessDocument } from "../src/access/api.js";
import { AccessProvider } from "../src/access/context.js";
import type * as CatalogApiModule from "../src/pages/catalog/api.js";
import { CatalogPage } from "../src/pages/catalog/index.js";
import { ProductPanelRoute } from "../src/pages/catalog/ProductPanelRoute.js";
import { candidatesQueryKey } from "../src/pages/integrations/api.js";

const { unlinkHookMountSpy, writeHookMountSpy } = vi.hoisted(() => ({
  unlinkHookMountSpy: vi.fn(),
  writeHookMountSpy: vi.fn(),
}));

vi.mock("../src/pages/catalog/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof CatalogApiModule>();
  return {
    ...actual,
    useCreateProduct: () => {
      writeHookMountSpy("create");
      return actual.useCreateProduct();
    },
    useUpdateProduct: () => {
      writeHookMountSpy("update");
      return actual.useUpdateProduct();
    },
    useDeleteProduct: () => {
      writeHookMountSpy("delete");
      return actual.useDeleteProduct();
    },
    useUnlinkProduct: () => {
      unlinkHookMountSpy();
      return actual.useUnlinkProduct();
    },
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  unlinkHookMountSpy.mockClear();
  writeHookMountSpy.mockClear();
});

/** Minimal Response stand-in -- only what apps/admin/src/api/client.ts reads. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const ADMIN_ACCESS: AccessDocument = {
  roles: ["admin"],
  capabilities: [
    CABINET_CAPABILITY.OPERATIONS_READ,
    CABINET_CAPABILITY.OPERATIONS_WRITE,
    CABINET_CAPABILITY.INTEGRATIONS_READ,
    CABINET_CAPABILITY.INTEGRATIONS_WRITE,
    CABINET_CAPABILITY.TENANT_SETTINGS_MANAGE,
    CABINET_CAPABILITY.CREDENTIALS_MANAGE,
  ],
};

const MANAGER_ACCESS: AccessDocument = {
  roles: ["manager"],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ, CABINET_CAPABILITY.OPERATIONS_WRITE],
};

const OPERATIONS_READ_ONLY: AccessDocument = {
  roles: [],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ],
};

function newQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

async function chooseOption(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  option: string,
) {
  await user.click(screen.getByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
}

function renderPage(
  access: AccessDocument = ADMIN_ACCESS,
  queryClient: QueryClient = newQueryClient(),
) {
  return render(
    <QueryClientProvider client={queryClient}>
      <AccessProvider value={access}>
        <MemoryRouter initialEntries={["/catalog"]}>
          <Routes>
            <Route path="/catalog" element={<CatalogPage />}>
              <Route path="new" element={<ProductPanelRoute mode="create" />} />
              <Route path=":productId/edit" element={<ProductPanelRoute mode="edit" />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </AccessProvider>
    </QueryClientProvider>,
  );
}

const DRAFT_PRODUCT = {
  id: "p1",
  gtin14: "04006381333931",
  name: "Молоко 1л",
  productGroup: null,
  boxCapacity: null,
  palletCapacity: null,
  unitPrice: null,
  egaisCode: null,
  status: "draft",
  defaultCounterpartyId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const ACTIVE_PRODUCT = {
  id: "p2",
  gtin14: "04600000000018",
  name: "Сыр Российский",
  productGroup: "Молочные продукты",
  boxCapacity: 12,
  palletCapacity: 48,
  unitPrice: null,
  egaisCode: null,
  status: "active",
  defaultCounterpartyId: null,
  createdAt: "2026-01-02T00:00:00.000Z",
};

describe("CatalogPage", () => {
  it("does not request integration candidates for a manager without integrations.read", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const path = String(url);
      if (path === "/api/products") return jsonResponse(200, { items: [DRAFT_PRODUCT] });
      if (path.includes("/candidates")) {
        throw new Error("manager must not request integration candidates");
      }
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage(MANAGER_ACCESS);

    expect(await screen.findByText(DRAFT_PRODUCT.name)).toBeDefined();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/candidates"))).toBe(false);
  });

  it("does not reveal cached integration candidates to a manager without integrations.read", async () => {
    const queryClient = newQueryClient();
    queryClient.setQueryData(candidatesQueryKey("commerceml", false), [
      {
        id: "candidate-1",
        externalRef: "1c-guid-1",
        name: "Не сопоставленный товар",
        article: null,
        unit: null,
        price: null,
        priceType: null,
        firstSeenAt: "2026-08-01T00:00:00.000Z",
        lastSeenAt: "2026-08-01T00:00:00.000Z",
        hidden: false,
        suggestedProductId: null,
      },
    ]);
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url) === "/api/products") return jsonResponse(200, { items: [DRAFT_PRODUCT] });
      throw new Error(`unexpected fetch: ${String(url)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage(MANAGER_ACCESS, queryClient);

    expect(await screen.findByText(DRAFT_PRODUCT.name)).toBeDefined();
    expect(screen.queryByText(/В обмене появились новые товары/)).toBeNull();
    expect(screen.queryByRole("link", { name: "Открыть очередь" })).toBeNull();
  });

  it("keeps product rows readable while hiding mutations without operations.write", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = String(url);
        if (path === "/api/products") return jsonResponse(200, { items: [DRAFT_PRODUCT] });
        if (path.includes("/candidates")) return jsonResponse(200, { candidates: [] });
        return jsonResponse(200, { items: [] });
      }),
    );

    renderPage(OPERATIONS_READ_ONLY);

    expect(await screen.findByText(DRAFT_PRODUCT.name)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Добавить продукт" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Изменить" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Удалить" })).toBeNull();
    expect(writeHookMountSpy).not.toHaveBeenCalled();
  });

  it("renders products from the mocked GET response with a StatusChip per status", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { items: [DRAFT_PRODUCT, ACTIVE_PRODUCT] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderPage();

    expect(await screen.findByText("Молоко 1л")).toBeDefined();
    expect(screen.getByText("Сыр Российский")).toBeDefined();
    expect(screen.getByText(DRAFT_PRODUCT.gtin14)).toBeDefined();
    expect(screen.getByText(ACTIVE_PRODUCT.gtin14)).toBeDefined();
    // "Черновик"/"Активен" also appear as <option> text in the status filter,
    // so scope the StatusChip assertion to the table itself.
    const table = within(screen.getByRole("table"));
    expect(table.getByText("Черновик")).toBeDefined();
    expect(table.getByText("Активен")).toBeDefined();
    expect(fetchMock).toHaveBeenCalledWith("/api/products", expect.any(Object));
    expect(screen.getByTestId("catalog-page").classList.contains("mk-catalog-page")).toBe(true);
    expect(screen.getByRole("group", { name: "Фильтры каталога" })).toBeDefined();
    expect(screen.getByText("2 продукта")).toBeDefined();
  });

  it("shows a spinner (not EmptyState) while the list request is still pending", async () => {
    // A fetch that never resolves keeps the query in isPending forever.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );

    renderPage();

    expect(await screen.findByRole("status")).toBeDefined();
    expect(screen.queryByText("Каталог пуст")).toBeNull();
  });

  it("shows an error alert (not EmptyState) when the list request fails, e.g. an expired session (401)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(401, { message: "Unauthorized" })),
    );

    renderPage();

    expect(
      await screen.findByText("Не удалось загрузить данные. Обновите страницу или войдите заново."),
    ).toBeDefined();
    expect(screen.queryByText("Каталог пуст")).toBeNull();
  });

  it("never triggers the gtin-check request for a checksum-invalid GTIN", async () => {
    const fetchMock = vi.fn(async (_url: string) => jsonResponse(200, { items: [] }));
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Каталог пуст");

    fireEvent.click(screen.getAllByRole("button", { name: "Добавить продукт" })[0]!);
    await screen.findByText("Новый продукт");

    // 7 digits, and not a valid GS1 checksum either way.
    fireEvent.change(screen.getByLabelText("ГТИН"), { target: { value: "1234567" } });

    // Give any (incorrectly) scheduled effect a chance to fire before asserting it didn't.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const gtinCheckCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("gtin-check"),
    );
    expect(gtinCheckCalls.length).toBe(0);
  });

  it("triggers the gtin-check POST for the checksum-valid GTIN vector 4006381333931", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("gtin-check")) {
        return jsonResponse(200, { gtin14: "04006381333931", owner: "own" });
      }
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Каталог пуст");

    fireEvent.click(screen.getAllByRole("button", { name: "Добавить продукт" })[0]!);
    await screen.findByText("Новый продукт");

    fireEvent.change(screen.getByLabelText("ГТИН"), { target: { value: "4006381333931" } });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/products/gtin-check",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ gtin: "4006381333931" }),
        }),
      );
    });
  });

  it("shows the GTIN owner hint for a counterparty match and applies it via the one-tap button", async () => {
    const created = { ...DRAFT_PRODUCT, id: "p3" };
    let didCreate = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path.includes("gtin-check")) {
        return jsonResponse(200, {
          gtin14: "04006381333931",
          owner: "counterparty",
          counterpartyId: "cp1",
          counterpartyName: "Acme Ltd",
        });
      }
      if (path === "/api/counterparties") {
        return jsonResponse(200, {
          items: [
            {
              id: "cp1",
              name: "Acme Ltd",
              gln: "6291041500213",
              inn: null,
              gs1Prefixes: [],
              notes: null,
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        });
      }
      if (path === "/api/products" && init?.method === "POST") {
        didCreate = true;
        return jsonResponse(201, created);
      }
      return jsonResponse(200, { items: didCreate ? [created] : [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Каталог пуст");

    fireEvent.click(screen.getAllByRole("button", { name: "Добавить продукт" })[0]!);
    await screen.findByText("Новый продукт");

    fireEvent.change(screen.getByLabelText("Название"), { target: { value: "Молоко 1л" } });
    fireEvent.change(screen.getByLabelText("ГТИН"), { target: { value: "4006381333931" } });

    expect(await screen.findByText("Владелец ГТИН — Acme Ltd")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Подставить контрагента" }));
    fireEvent.click(screen.getByRole("button", { name: "Создать" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/products",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            gtin: "4006381333931",
            name: "Молоко 1л",
            productGroup: null,
            boxCapacity: null,
            palletCapacity: null,
            unitPrice: null,
            egaisCode: null,
            defaultCounterpartyId: "cp1",
            defaultLabelTemplateId: null,
          }),
        }),
      );
    });
  });

  it("ignores a gtin-check response for a GTIN the field no longer holds (stale-response guard)", async () => {
    let resolveStaleCheck: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path.includes("gtin-check")) {
        const body = JSON.parse((init?.body as string | undefined) ?? "{}") as { gtin: string };
        if (body.gtin === "4006381333931") {
          // GTIN A's check never resolves on its own -- the test resolves it
          // manually, after the field has already moved on to GTIN B.
          return new Promise<Response>((resolve) => {
            resolveStaleCheck = resolve;
          });
        }
        return jsonResponse(200, {
          gtin14: "04600682000013",
          owner: "counterparty",
          counterpartyId: "cp-fresh",
          counterpartyName: "Fresh Co",
        });
      }
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Каталог пуст");

    fireEvent.click(screen.getAllByRole("button", { name: "Добавить продукт" })[0]!);
    await screen.findByText("Новый продукт");

    // GTIN A -- checksum-valid, kicks off a gtin-check that hangs.
    fireEvent.change(screen.getByLabelText("ГТИН"), { target: { value: "4006381333931" } });
    await waitFor(() => expect(resolveStaleCheck).toBeDefined());

    // The user changes their mind before A's check resolves -- GTIN B (also
    // checksum-valid) fires its own check, which resolves immediately.
    fireEvent.change(screen.getByLabelText("ГТИН"), { target: { value: "4600682000013" } });
    expect(await screen.findByText("Владелец ГТИН — Fresh Co")).toBeDefined();

    // Now the stale A response arrives. Since the field no longer holds "A",
    // it must not clobber the hint that B's (later, matching) response set.
    resolveStaleCheck?.(
      jsonResponse(200, {
        gtin14: "04006381333931",
        owner: "counterparty",
        counterpartyId: "cp-stale",
        counterpartyName: "Stale Co",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(screen.queryByText("Владелец ГТИН — Stale Co")).toBeNull();
    expect(screen.getByText("Владелец ГТИН — Fresh Co")).toBeDefined();
  });

  it("shows a non-blocking warn hint when the GTIN owner is unknown", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const path = String(url);
      if (path.includes("gtin-check")) {
        return jsonResponse(200, { gtin14: "04006381333931", owner: "unknown" });
      }
      if (path === "/api/counterparties") return jsonResponse(200, { items: [] });
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Каталог пуст");

    fireEvent.click(screen.getAllByRole("button", { name: "Добавить продукт" })[0]!);
    await screen.findByText("Новый продукт");

    fireEvent.change(screen.getByLabelText("ГТИН"), { target: { value: "4006381333931" } });

    expect(
      await screen.findByText("Владелец ГТИН не определён — проверьте код перед сохранением."),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: "Подставить контрагента" })).toBeNull();
  });

  it("shows the draft banner only when editing a product with status draft", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const path = String(url);
      if (path === "/api/counterparties") return jsonResponse(200, { items: [] });
      return jsonResponse(200, { items: [DRAFT_PRODUCT, ACTIVE_PRODUCT] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Молоко 1л");

    const draftBanner = "Черновик — заполните группу и вместимости, чтобы запускать смены";

    fireEvent.click(screen.getAllByRole("button", { name: "Изменить" })[0]!);
    await screen.findByText("Изменить продукт");
    expect(screen.getByText(draftBanner)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    await waitFor(() => expect(screen.queryByText("Изменить продукт")).toBeNull());

    fireEvent.click(screen.getAllByRole("button", { name: "Изменить" })[1]!);
    await screen.findByText("Изменить продукт");
    expect(screen.queryByText(draftBanner)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    await waitFor(() => expect(screen.queryByText("Изменить продукт")).toBeNull());

    fireEvent.click(screen.getAllByRole("button", { name: "Добавить продукт" })[0]!);
    await screen.findByText("Новый продукт");
    expect(screen.queryByText(draftBanner)).toBeNull();
  });

  it("debounces the search input to a single fetch carrying the search param", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { items: [] }));
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Каталог пуст");

    const callsAfterMount = fetchMock.mock.calls.length;

    const searchInput = screen.getByLabelText("Поиск");
    fireEvent.change(searchInput, { target: { value: "c" } });
    fireEvent.change(searchInput, { target: { value: "ch" } });
    fireEvent.change(searchInput, { target: { value: "cheese" } });

    // Debounce means no extra fetch immediately after typing.
    expect(fetchMock.mock.calls.length).toBe(callsAfterMount);

    await waitFor(
      () => {
        expect(fetchMock).toHaveBeenCalledWith("/api/products?search=cheese", expect.any(Object));
      },
      { timeout: 1000 },
    );

    // Exactly one additional fetch after the debounce settles -- not one per keystroke.
    expect(fetchMock.mock.calls.length).toBe(callsAfterMount + 1);
  });

  const LABEL_TEMPLATE = {
    id: "lt1",
    name: "Короб 58×40",
    widthMm: 58,
    heightMm: 40,
    dpi: 203,
    language: "zpl",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("renders label templates as options in the default label template select", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (url: string) => {
      const path = String(url);
      if (path === "/api/label-templates") return jsonResponse(200, { items: [LABEL_TEMPLATE] });
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Каталог пуст");

    fireEvent.click(screen.getAllByRole("button", { name: "Добавить продукт" })[0]!);
    await screen.findByText("Новый продукт");

    await user.click(await screen.findByRole("combobox", { name: "Шаблон этикетки по умолчанию" }));
    expect(screen.getByRole("option", { name: LABEL_TEMPLATE.name })).toBeDefined();
  });

  it("sends the chosen defaultLabelTemplateId in the create payload", async () => {
    const user = userEvent.setup();
    const created = { ...DRAFT_PRODUCT, id: "p4", defaultLabelTemplateId: LABEL_TEMPLATE.id };
    let didCreate = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/label-templates") return jsonResponse(200, { items: [LABEL_TEMPLATE] });
      if (path === "/api/counterparties") return jsonResponse(200, { items: [] });
      if (path === "/api/products" && init?.method === "POST") {
        didCreate = true;
        return jsonResponse(201, created);
      }
      return jsonResponse(200, { items: didCreate ? [created] : [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Каталог пуст");

    fireEvent.click(screen.getAllByRole("button", { name: "Добавить продукт" })[0]!);
    await screen.findByText("Новый продукт");

    fireEvent.change(screen.getByLabelText("Название"), { target: { value: "Йогурт" } });
    fireEvent.change(screen.getByLabelText("ГТИН"), { target: { value: "4006381333931" } });
    await chooseOption(user, "Шаблон этикетки по умолчанию", LABEL_TEMPLATE.name);
    fireEvent.click(screen.getByRole("button", { name: "Создать" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/products",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            gtin: "4006381333931",
            name: "Йогурт",
            productGroup: null,
            boxCapacity: null,
            palletCapacity: null,
            unitPrice: null,
            egaisCode: null,
            defaultCounterpartyId: null,
            defaultLabelTemplateId: LABEL_TEMPLATE.id,
          }),
        }),
      );
    });
  });

  it("renders unitPrice and egaisCode inputs and sends them normalized in the create payload", async () => {
    const created = { ...DRAFT_PRODUCT, id: "p5", unitPrice: "52.00", egaisCode: "ЕГАИС123" };
    let didCreate = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/counterparties") return jsonResponse(200, { items: [] });
      if (path === "/api/products" && init?.method === "POST") {
        didCreate = true;
        return jsonResponse(201, created);
      }
      return jsonResponse(200, { items: didCreate ? [created] : [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText("Каталог пуст");

    fireEvent.click(screen.getAllByRole("button", { name: "Добавить продукт" })[0]!);
    await screen.findByText("Новый продукт");

    // Assert the new inputs are rendered
    expect(screen.getByLabelText("Цена за шт., ₽")).toBeDefined();
    expect(screen.getByLabelText("Код ЕГАИС")).toBeDefined();

    // Fill required and new optional fields
    fireEvent.change(screen.getByLabelText("Название"), { target: { value: "Напиток" } });
    fireEvent.change(screen.getByLabelText("ГТИН"), { target: { value: "4006381333931" } });
    fireEvent.change(screen.getByLabelText("Цена за шт., ₽"), { target: { value: "52,00" } });
    fireEvent.change(screen.getByLabelText("Код ЕГАИС"), { target: { value: "ЕГАИС123" } });
    fireEvent.click(screen.getByRole("button", { name: "Создать" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/products",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            gtin: "4006381333931",
            name: "Напиток",
            productGroup: null,
            boxCapacity: null,
            palletCapacity: null,
            unitPrice: "52.00",
            egaisCode: "ЕГАИС123",
            defaultCounterpartyId: null,
            defaultLabelTemplateId: null,
          }),
        }),
      );
    });
  });

  it("pre-fills unitPrice/egaisCode when editing a product that has them, and preserves them on an untouched save", async () => {
    // Based on DRAFT_PRODUCT (not ACTIVE_PRODUCT) -- its gtin14 is a
    // checksum-valid vector, so the zod-validated edit form can actually
    // submit; ACTIVE_PRODUCT's gtin14 fails the check digit and would block
    // the PATCH before it ever fires.
    const priced = {
      ...DRAFT_PRODUCT,
      id: "p6",
      unitPrice: "52.00",
      egaisCode: "EG-123",
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/counterparties") return jsonResponse(200, { items: [] });
      if (path === `/api/products/${priced.id}` && init?.method === "PATCH") {
        return jsonResponse(200, priced);
      }
      return jsonResponse(200, { items: [priced] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText(priced.name);

    fireEvent.click(screen.getByRole("button", { name: "Изменить" }));
    await screen.findByText("Изменить продукт");

    // The edit form must seed from the product being edited, not render blank.
    expect((screen.getByLabelText("Цена за шт., ₽") as HTMLInputElement).value).toBe("52.00");
    expect((screen.getByLabelText("Код ЕГАИС") as HTMLInputElement).value).toBe("EG-123");

    // Save without touching either field -- the PATCH must round-trip the
    // original values, not overwrite them with null (data loss).
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/products/${priced.id}`,
        expect.objectContaining({
          method: "PATCH",
          body: expect.stringContaining('"unitPrice":"52.00"'),
        }),
      );
    });
    const patchCall = fetchMock.mock.calls.find(
      ([url, init]) => url === `/api/products/${priced.id}` && init?.method === "PATCH",
    );
    const patchBody = JSON.parse((patchCall?.[1]?.body as string | undefined) ?? "{}") as Record<
      string,
      unknown
    >;
    expect(patchBody.unitPrice).toBe("52.00");
    expect(patchBody.egaisCode).toBe("EG-123");
  });

  // Fix 2 (review, Task 14 follow-up): `CatalogPage` used to rebuild
  // `initialValues` as a fresh object literal on every render. `ProductForm`'s
  // resync effect depends on that object referentially, so *any* unrelated
  // parent re-render -- including the one `useUnlinkProduct`'s own
  // `invalidateQueries` triggers once the products list refetch settles --
  // re-fired the effect with the still-stale `externalRef` prop (`formState`
  // holds a snapshot captured when "Изменить" was clicked, not the freshly
  // refetched row) and silently restored the just-cleared plaque.
  it("не восстанавливает плашку связи с 1С после успешного разрыва", async () => {
    const LINKED_PRODUCT = {
      ...DRAFT_PRODUCT,
      id: "p7",
      externalRef: "1C-GUID-1",
    };
    let unlinked = false;
    let productsGetCount = 0;
    // Mirrors what the real server does: the DELETE actually clears the ref,
    // so the products list refetch that `invalidateQueries` triggers comes
    // back with a *different* `externalRef` than the modal was opened with.
    // That's what makes TanStack Query's structural sharing treat `data` as
    // genuinely changed and re-render `CatalogPage` -- returning the
    // unchanged ref every time (as an earlier version of this test did)
    // never exercised the bug at all.
    let serverExternalRef: string | null = LINKED_PRODUCT.externalRef;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/counterparties") return jsonResponse(200, { items: [] });
      if (
        path === `/api/products/${LINKED_PRODUCT.id}/external-link` &&
        init?.method === "DELETE"
      ) {
        unlinked = true;
        serverExternalRef = null;
        return jsonResponse(200, undefined);
      }
      productsGetCount += 1;
      return jsonResponse(200, { items: [{ ...LINKED_PRODUCT, externalRef: serverExternalRef }] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await screen.findByText(LINKED_PRODUCT.name);

    fireEvent.click(screen.getByRole("button", { name: "Изменить" }));
    await screen.findByText("Изменить продукт");
    expect(screen.getByText(/Связано с 1С: 1C-GUID-1/)).toBeDefined();

    const productsGetCountBeforeUnlink = productsGetCount;
    fireEvent.click(screen.getByRole("button", { name: "Разорвать связь" }));
    await waitFor(() => expect(unlinked).toBe(true));
    await waitFor(() => expect(screen.queryByText(/Связано с 1С:/)).toBeNull());

    // Wait for `useUnlinkProduct`'s `invalidateQueries` to actually drive a
    // real products refetch to completion (not just fire it) -- that refetch
    // is what triggers the parent (`CatalogPage`) re-render this test targets.
    await waitFor(() => expect(productsGetCount).toBeGreaterThan(productsGetCountBeforeUnlink));
    // Flush the re-render(s) that refetch's resolution schedules.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(screen.queryByText(/Связано с 1С:/)).toBeNull();
  });

  it("shows a linked product to managers without exposing the integration unlink mutation", async () => {
    const linkedProduct = { ...DRAFT_PRODUCT, id: "p8", externalRef: "1C-GUID-READONLY" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = String(url);
        if (path === "/api/counterparties") return jsonResponse(200, { items: [] });
        return jsonResponse(200, { items: [linkedProduct] });
      }),
    );

    renderPage(MANAGER_ACCESS);
    await screen.findByText(linkedProduct.name);
    fireEvent.click(screen.getByRole("button", { name: "Изменить" }));

    expect(await screen.findByText(/Связано с 1С: 1C-GUID-READONLY/)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Разорвать связь" })).toBeNull();
    expect(screen.getByRole("button", { name: "Сохранить" })).toBeDefined();
    expect(unlinkHookMountSpy).not.toHaveBeenCalled();
  });
});
