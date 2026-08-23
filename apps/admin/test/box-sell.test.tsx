import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, createRoutesFromElements, Route, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";

import type { AccessDocument } from "../src/access/api.js";
import { AccessProvider } from "../src/access/context.js";
import { SellBoxPage } from "../src/pages/boxes/SellBoxPage.js";

const ACCESS: AccessDocument = {
  roles: ["manager"],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ, CABINET_CAPABILITY.OPERATIONS_WRITE],
};

const SELL_CODES = {
  boxId: "b1",
  sscc: "00123456789012345675",
  productName: "Вода Кристальная 0,5",
  itemCount: 2,
  items: [
    { codeHash: "a".repeat(64), rawKm: "0104006381333931" + "21S-aa", gtin14: "04006381333931", serial: "S-aa" },
    { codeHash: "b".repeat(64), rawKm: "0104006381333931" + "21S-bb", gtin14: "04006381333931", serial: "S-bb" },
  ],
};

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function stubFetch(status = 200, body: unknown = SELL_CODES) {
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).startsWith("/api/boxes/sell-codes?")) return jsonResponse(status, body);
    return jsonResponse(404, { message: "not found" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderPage() {
  const router = createMemoryRouter(
    createRoutesFromElements(<Route path="/boxes/sell" element={<SellBoxPage />} />),
    { initialEntries: ["/boxes/sell"] },
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <AccessProvider value={ACCESS}>
        <RouterProvider router={router} />
      </AccessProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SellBoxPage", () => {
  it("walks entry → per-code display → finish", async () => {
    stubFetch();
    renderPage();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("SSCC короба"), "123456789012345675");
    await user.click(screen.getByRole("button", { name: "Найти короб" }));

    // Первый код: счётчик, продукт, серийник-подпись; DataMatrix из lazy-чанка.
    expect(await screen.findByText("1 / 2")).toBeTruthy();
    expect(screen.getByText("Вода Кристальная 0,5")).toBeTruthy();
    expect(await screen.findByText("S-aa")).toBeTruthy();

    // Назад недоступна на первом коде.
    expect(screen.getByRole("button", { name: "Назад" }).hasAttribute("disabled")).toBe(true);

    await user.click(screen.getByRole("button", { name: "Далее" }));
    expect(await screen.findByText("2 / 2")).toBeTruthy();
    expect(await screen.findByText("S-bb")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Далее" }));
    expect(await screen.findByText("Все 2 кода показаны")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Следующий короб" }));
    expect(await screen.findByLabelText("SSCC короба")).toBeTruthy();
  });

  it("rejects a malformed SSCC locally without a network call", async () => {
    const fetchMock = stubFetch();
    renderPage();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("SSCC короба"), "12345");
    await user.click(screen.getByRole("button", { name: "Найти короб" }));

    expect(await screen.findByText("Неверный SSCC — проверьте 18 цифр кода")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows a per-code error message for a disassembled box", async () => {
    stubFetch(409, { code: "box_disassembled", message: "conflict" });
    renderPage();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("SSCC короба"), "123456789012345675");
    await user.click(screen.getByRole("button", { name: "Найти короб" }));

    expect(await screen.findByText("Короб уже разобран — коды показать нельзя")).toBeTruthy();
  });

  it("shows 'not found' for an unknown box", async () => {
    stubFetch(404, { code: "box_not_found", message: "not found" });
    renderPage();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("SSCC короба"), "123456789012345675");
    await user.click(screen.getByRole("button", { name: "Найти короб" }));

    expect(await screen.findByText("Короб не найден")).toBeTruthy();
  });

  it("retries a transient failure when the cashier resubmits the same SSCC", async () => {
    // First call fails with a transient 500 (no `code`, so it surfaces as
    // "loadFailed"); the second call -- same SSCC -- succeeds. React Query
    // must actually refetch instead of serving the cached error back.
    let call = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).startsWith("/api/boxes/sell-codes?")) {
        call += 1;
        return call === 1
          ? jsonResponse(500, { message: "boom" })
          : jsonResponse(200, SELL_CODES);
      }
      return jsonResponse(404, { message: "not found" });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("SSCC короба"), "123456789012345675");
    await user.click(screen.getByRole("button", { name: "Найти короб" }));

    expect(
      await screen.findByText("Не удалось загрузить короб — проверьте связь и повторите"),
    ).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Same SSCC still in the field -- resubmitting must trigger a real
    // second fetch, not a no-op stuck on the cached error.
    await user.click(screen.getByRole("button", { name: "Найти короб" }));

    expect(await screen.findByText("1 / 2")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
