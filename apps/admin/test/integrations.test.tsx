import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { IntegrationsPage } from "../src/pages/integrations/index.js";

// Общего рендер-хелпера в этом репозитории НЕТ: каждый админ-тест объявляет
// свой `renderPage` и глушит `fetch` — см. `apps/admin/test/counterparties.test.tsx`
// строки 15-30. Повторить тот же приём здесь, а не заводить `test/support/`.
function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <IntegrationsPage />
    </QueryClientProvider>,
  );
}

/** Глушит `GET /integrations` ответом с переданными каналами. */
function stubChannels(channels: unknown[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ channels }),
    })),
  );
}

describe("IntegrationsPage", () => {
  it("рисует недоступный канал как все остальные, а не прячет его", async () => {
    stubChannels([
      {
        type: "commerceml",
        labelKey: "integrations.channel.commerceml",
        state: "working",
        lastEventAt: new Date().toISOString(),
      },
      {
        type: "chestny_znak",
        labelKey: "integrations.channel.chestnyZnak",
        state: "unavailable",
        lastEventAt: null,
      },
    ]);
    renderPage();
    expect(await screen.findByText("Обмен с 1С")).toBeDefined();
    expect(screen.getByText("Честный ЗНАК")).toBeDefined();
    expect(screen.getByText("Недоступно")).toBeDefined();
  });

  it("показывает, когда канал последний раз дышал", async () => {
    stubChannels([
      {
        type: "commerceml",
        labelKey: "integrations.channel.commerceml",
        state: "working",
        lastEventAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      },
    ]);
    renderPage();
    expect(await screen.findByText(/2 ч назад/)).toBeDefined();
  });

  it("молчащий канал отличается от работающего", async () => {
    stubChannels([
      {
        type: "commerceml",
        labelKey: "integrations.channel.commerceml",
        state: "silent",
        lastEventAt: new Date(Date.now() - 3 * 24 * 3_600_000).toISOString(),
      },
    ]);
    renderPage();
    expect(await screen.findByText(/нет обмена/i)).toBeDefined();
  });

  it("показывает пустое состояние, когда ничего не настроено", async () => {
    stubChannels([
      {
        type: "commerceml",
        labelKey: "integrations.channel.commerceml",
        state: "not_configured",
        lastEventAt: null,
      },
    ]);
    renderPage();
    expect(await screen.findByText(/не настроен/i)).toBeDefined();
  });
});
