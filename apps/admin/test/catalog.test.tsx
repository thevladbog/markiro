import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CatalogPage } from "../src/pages/catalog/index.js";

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
  } as Response;
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <CatalogPage />
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
  status: "active",
  defaultCounterpartyId: null,
  createdAt: "2026-01-02T00:00:00.000Z",
};

describe("CatalogPage", () => {
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

    const select = (await screen.findByLabelText(
      "Шаблон этикетки по умолчанию",
    )) as HTMLSelectElement;
    expect(within(select).getByRole("option", { name: LABEL_TEMPLATE.name })).toBeDefined();
  });

  it("sends the chosen defaultLabelTemplateId in the create payload", async () => {
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
    fireEvent.change(screen.getByLabelText("Шаблон этикетки по умолчанию"), {
      target: { value: LABEL_TEMPLATE.id },
    });
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
            defaultCounterpartyId: null,
            defaultLabelTemplateId: LABEL_TEMPLATE.id,
          }),
        }),
      );
    });
  });
});
