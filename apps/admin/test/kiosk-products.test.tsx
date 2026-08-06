import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { KioskProductsSection } from "../src/pages/kiosks/KioskProductsSection.js";
import type { KioskDto } from "../src/pages/kiosks/api.js";
import { jsonResponse } from "./helpers/http.js";

const ONLINE_KIOSK: KioskDto = {
  id: "k1",
  name: "Касса у входа",
  location: "Зал 1",
  dayLimitPerEmployee: 5,
  showPrices: true,
  status: "active",
  lastSeenAt: "2026-08-06T10:00:00.000Z",
  enrolled: true,
  productIds: ["p1"],
  createdAt: "2026-01-01T00:00:00.000Z",
};

const PRODUCT_A = {
  id: "p1",
  gtin14: "04006381333931",
  name: "Молоко 1л",
  productGroup: "Молочные продукты",
  boxCapacity: 12,
  palletCapacity: 48,
  unitPrice: null,
  egaisCode: null,
  externalRef: null,
  status: "active" as const,
  defaultCounterpartyId: null,
  defaultLabelTemplateId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const PRODUCT_B = {
  ...PRODUCT_A,
  id: "p2",
  gtin14: "04600000000018",
  name: "Сыр Российский",
  createdAt: "2026-01-02T00:00:00.000Z",
};

const PRODUCT_C = {
  ...PRODUCT_A,
  id: "p3",
  gtin14: "04600000000025",
  name: "Йогурт",
  createdAt: "2026-01-03T00:00:00.000Z",
};

function deferred<T>() {
  let resolve: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve: resolve! };
}

function renderProductsSection(
  kiosk: KioskDto = ONLINE_KIOSK,
  reporters = {
    onDirtyChange: vi.fn(),
    onBusyChange: vi.fn(),
    onErrorChange: vi.fn(),
  },
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <KioskProductsSection kiosk={kiosk} {...reporters} />
    </QueryClientProvider>,
  );
  return {
    ...reporters,
    ...view,
    rerenderProductsSection: (nextKiosk: KioskDto) =>
      view.rerender(
        <QueryClientProvider client={queryClient}>
          <KioskProductsSection kiosk={nextKiosk} {...reporters} />
        </QueryClientProvider>,
      ),
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("KioskProductsSection", () => {
  it("renders a recoverable loading and catalog error state", async () => {
    const productRequest = deferred<Response>();
    let productRequests = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url === "/api/products?status=active") {
        productRequests += 1;
        return productRequests === 1
          ? productRequest.promise
          : Promise.resolve(jsonResponse(200, { items: [PRODUCT_A] }));
      }
      return Promise.resolve(jsonResponse(200, { items: [] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const reporters = {
      onDirtyChange: vi.fn(),
      onBusyChange: vi.fn(),
      onErrorChange: vi.fn(),
    };
    renderProductsSection(ONLINE_KIOSK, reporters);

    const section = screen.getByRole("region", { name: "Разрешённые товары" });
    expect(within(section).getByRole("status", { name: "Загрузка товаров…" })).toBeDefined();
    expect(within(section).queryByRole("button", { name: "Сохранить список" })).toBeNull();

    productRequest.resolve(jsonResponse(500, { message: "Catalog unavailable" }));
    expect((await within(section).findByRole("alert")).textContent).toContain(
      "Не удалось загрузить товары.",
    );
    expect(reporters.onErrorChange).toHaveBeenLastCalledWith(true);
    await userEvent.setup().click(within(section).getByRole("button", { name: "Повторить" }));
    expect(
      fetchMock.mock.calls.filter(([url]) => url === "/api/products?status=active"),
    ).toHaveLength(2);
    expect(await within(section).findByRole("checkbox", { name: PRODUCT_A.name })).toBeDefined();
    expect(reporters.onErrorChange).toHaveBeenLastCalledWith(false);
  });

  it("explains an empty active catalog without offering a save", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { items: [] })),
    );
    renderProductsSection();

    const section = screen.getByRole("region", { name: "Разрешённые товары" });
    expect(await within(section).findByText("В каталоге нет активных товаров.")).toBeDefined();
    expect(within(section).queryByRole("button", { name: "Сохранить список" })).toBeNull();
  });

  it("keeps selected ids hidden by the local filter and sends the catalog-ordered exact list", async () => {
    const saveResponse = deferred<Response>();
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/products?status=active") {
        return Promise.resolve(jsonResponse(200, { items: [PRODUCT_A, PRODUCT_B] }));
      }
      if (url === "/api/kiosks/k1/products" && init?.method === "PUT") {
        return saveResponse.promise;
      }
      return Promise.resolve(jsonResponse(200, { items: [] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const reporters = {
      onDirtyChange: vi.fn(),
      onBusyChange: vi.fn(),
      onErrorChange: vi.fn(),
    };
    renderProductsSection({ ...ONLINE_KIOSK, productIds: [PRODUCT_B.id] }, reporters);
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText("Поиск по товарам"), "молоко");
    expect(screen.getByRole("checkbox", { name: PRODUCT_A.name })).toBeDefined();
    expect(screen.queryByRole("checkbox", { name: PRODUCT_B.name })).toBeNull();
    await user.clear(screen.getByLabelText("Поиск по товарам"));
    await user.type(await screen.findByLabelText("Поиск по товарам"), PRODUCT_A.gtin14);
    expect(screen.queryByRole("checkbox", { name: PRODUCT_B.name })).toBeNull();
    await user.click(screen.getByRole("checkbox", { name: PRODUCT_A.name }));
    await user.clear(screen.getByLabelText("Поиск по товарам"));
    expect(
      screen.getByRole("checkbox", { name: PRODUCT_B.name }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.getByText("Выбрано: 2")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Сохранить список" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/kiosks/k1/products",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ productIds: ["p1", "p2"] }),
        }),
      );
    });
    await waitFor(() => expect(reporters.onBusyChange).toHaveBeenLastCalledWith(true));

    saveResponse.resolve(jsonResponse(200, { ...ONLINE_KIOSK, productIds: ["p1", "p2"] }));

    await waitFor(() => expect(reporters.onDirtyChange).toHaveBeenLastCalledWith(false));
    expect(screen.getByRole("region", { name: "Разрешённые товары" })).toBeDefined();
    expect(await screen.findByText("Список товаров обновлён")).toBeDefined();
    expect(reporters.onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it("reports a changed selection and retains it with the server error after a failed save", async () => {
    const saveResponse = deferred<Response>();
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/products?status=active") {
        return Promise.resolve(jsonResponse(200, { items: [PRODUCT_A, PRODUCT_B] }));
      }
      if (url === "/api/kiosks/k1/products" && init?.method === "PUT") {
        return saveResponse.promise;
      }
      return Promise.resolve(jsonResponse(200, { items: [] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const reporters = {
      onDirtyChange: vi.fn(),
      onBusyChange: vi.fn(),
      onErrorChange: vi.fn(),
    };
    renderProductsSection(ONLINE_KIOSK, reporters);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("checkbox", { name: PRODUCT_B.name }));
    expect(reporters.onDirtyChange).toHaveBeenLastCalledWith(true);
    await user.click(screen.getByRole("button", { name: "Сохранить список" }));
    await waitFor(() => expect(reporters.onBusyChange).toHaveBeenLastCalledWith(true));

    saveResponse.resolve(jsonResponse(409, { message: "Product is unavailable" }));

    const section = screen.getByRole("region", { name: "Разрешённые товары" });
    expect((await within(section).findByRole("alert")).textContent).toContain(
      "Product is unavailable",
    );
    expect(
      within(section).getByRole("checkbox", { name: PRODUCT_B.name }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(reporters.onErrorChange).toHaveBeenLastCalledWith(true);
    expect(reporters.onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it("adopts an incoming server selection after a dirty local selection is reverted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { items: [PRODUCT_A, PRODUCT_B, PRODUCT_C] })),
    );
    const { rerenderProductsSection } = renderProductsSection();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("checkbox", { name: PRODUCT_B.name }));
    rerenderProductsSection({ ...ONLINE_KIOSK, productIds: [PRODUCT_A.id, PRODUCT_C.id] });
    await user.click(screen.getByRole("checkbox", { name: PRODUCT_B.name }));

    await waitFor(() =>
      expect(
        screen.getByRole("checkbox", { name: PRODUCT_C.name }).getAttribute("aria-checked"),
      ).toBe("true"),
    );
  });
});
