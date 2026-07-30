import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IntegrationsPage } from "../src/pages/integrations/index.js";

// Общего рендер-хелпера в этом репозитории НЕТ: каждый админ-тест объявляет
// свой `renderPage` и глушит `fetch` — см. `apps/admin/test/counterparties.test.tsx`
// строки 15-30. Повторить тот же приём здесь, а не заводить `test/support/`.

// `vitest.config.ts` не включает `test.globals`, поэтому Testing Library не
// подчищает DOM между тестами сама -- без этого узлы от `render()` копятся в
// `document.body`, и следующий `render()` дописывает поверх старого дерева, а
// не заменяет его. Все остальные `*.test.tsx` в этой папке вызывают
// `afterEach(cleanup)` по этой же причине (см. `kiosks-pairing-placeholder.test.tsx`).
afterEach(cleanup);

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // `ChannelCard` (Task 13) now links each available card to its channel
  // page via `react-router`'s `Link`, which throws without a Router
  // ancestor -- `MemoryRouter` supplies one; nothing here navigates, so no
  // `Routes`/`Route` is needed.
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <IntegrationsPage />
      </MemoryRouter>
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

  // Тест выше кладёт в список один канал в состоянии `not_configured`, так что
  // `channels.length` никогда не становится нулём -- он проверяет чип
  // карточки, а не настоящую пустую секцию. Эти три теста покрывают три ветви
  // рендера, которые компонент рисует, но которые до сих пор не выполнял ни
  // один тест: пустой список, ещё не пришедший ответ и упавший запрос
  // (см. брифа 08 "empty, loading, error and stale variants for every list").
  it("рисует EmptyState, когда список каналов действительно пуст", async () => {
    stubChannels([]);
    renderPage();
    expect(await screen.findByText("Каналы не настроены")).toBeDefined();
    expect(
      screen.getByText(
        "Здесь появятся каналы обмена данными с внешними системами: 1С, ГИС МТ, Честный ЗНАК.",
      ),
    ).toBeDefined();
  });

  it("рисует спиннер, пока запрос списка каналов ещё не завершился", async () => {
    // Никогда не резолвящийся fetch держит query в состоянии `isPending` вечно.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    renderPage();
    expect(await screen.findByRole("status")).toBeDefined();
    expect(screen.queryByText("Каналы не настроены")).toBeNull();
  });

  it("рисует сообщение об ошибке, когда запрос списка каналов не удался", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({ message: "Internal error" }),
      })),
    );
    renderPage();
    expect(
      await screen.findByText("Не удалось загрузить данные. Обновите страницу или войдите заново."),
    ).toBeDefined();
    expect(screen.queryByText("Каналы не настроены")).toBeNull();
  });
});
