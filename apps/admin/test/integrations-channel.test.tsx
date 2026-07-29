import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChannelPage } from "../src/pages/integrations/ChannelPage.js";
import type { JournalSessionDto } from "../src/pages/integrations/api.js";

// Общего рендер-хелпера в этом репозитории НЕТ: каждый админ-тест объявляет
// свой `renderPage`/`render*` и глушит `fetch` -- см.
// `apps/admin/test/counterparties.test.tsx` строки 15-30 и
// `apps/admin/test/pickup-detail.test.tsx` (MemoryRouter + Routes для
// параметризованного маршрута). Повторяем тот же приём здесь, а не заводим
// `test/support/`.

// `vitest.config.ts` не включает `test.globals`, поэтому Testing Library не
// подчищает DOM между тестами сама -- без `cleanup()` узлы от `render()`
// копятся в `document.body` между тестами этого файла.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  patchSpy.mockClear();
  journalSessions = [];
});

/** Minimal Response stand-in -- only what apps/admin/src/api/client.ts reads. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

/** `iso(-1)` -- "a day ago"; `iso(-2)` -- "two days ago". Relative to render time. */
function iso(daysOffset: number): string {
  return new Date(Date.now() + daysOffset * 86_400_000).toISOString();
}

const ISSUED_LOGIN = "mk-1c-a1b2c3d4";
const ISSUED_SECRET = "R4nd0mExchangeSecretValue==";

/** Captures every `PATCH /integrations/:type` call as `(path, parsedBody)`. */
const patchSpy = vi.fn();

/** Sessions the next `GET /integrations/:type/journal` call answers with. */
let journalSessions: JournalSessionDto[] = [];

/** `stubJournal([...])` -- overrides the journal fixture for one test. */
function stubJournal(sessions: JournalSessionDto[]): void {
  journalSessions = sessions;
}

function defaultDetail(type: string) {
  return {
    type,
    labelKey: `integrations.channel.${type}`,
    state: "working",
    lastEventAt: null,
    settings: {},
    silentAfterHours: 48,
    credentialLogin: null,
  };
}

function createFetchMock(journalMode: "ok" | "pending" | "error") {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace(/^\/api/, "");
    const method = init?.method ?? "GET";

    if (method === "GET" && /\/journal$/.test(path)) {
      if (journalMode === "pending") return new Promise<Response>(() => {});
      if (journalMode === "error") return jsonResponse(500, { message: "Internal error" });
      return jsonResponse(200, { sessions: journalSessions });
    }
    if (method === "POST" && /\/credentials$/.test(path)) {
      return jsonResponse(200, { login: ISSUED_LOGIN, secret: ISSUED_SECRET });
    }
    if (method === "PATCH") {
      const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
      patchSpy(path, body);
      const type = path.split("/").pop()!;
      return jsonResponse(200, { ...defaultDetail(type), settings: body });
    }
    // Plain `GET /integrations/:type` -- the channel-detail fallback.
    const type = path.split("/").pop()!;
    return jsonResponse(200, defaultDetail(type));
  });
}

function renderChannel(type: string, options: { journalMode?: "pending" | "error" } = {}) {
  vi.stubGlobal("fetch", createFetchMock(options.journalMode ?? "ok"));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/integrations/${type}`]}>
        <Routes>
          <Route path="/integrations/:type" element={<ChannelPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ChannelPage", () => {
  it("показывает секрет обмена один раз и больше никогда", async () => {
    renderChannel("commerceml");
    await userEvent.click(await screen.findByRole("button", { name: /выпустить/i }));
    expect(await screen.findByText(/mk-1c-/)).toBeDefined();
    expect(screen.getByText(/больше он показан не будет/i)).toBeDefined();
  });

  it("поднимает неуспешный сеанс наверх журнала", async () => {
    stubJournal([
      { id: "s2", startedAt: iso(-1), finishedAt: iso(-1), outcome: "ok", summary: {}, events: [] },
      {
        id: "s1",
        startedAt: iso(-2),
        finishedAt: iso(-2),
        outcome: "error",
        summary: {},
        events: [],
      },
    ]);
    renderChannel("commerceml");
    const sessions = await screen.findAllByTestId("journal-session");
    // No `@testing-library/jest-dom` in this repo (see
    // `apps/admin/test/pickup.test.tsx`'s plain `toHaveProperty` uses for the
    // same reason) -- assert the raw attribute instead of `toHaveAttribute`.
    expect(sessions[0]?.getAttribute("data-outcome")).toBe("error");
  });

  it("показывает ответ протокола дословно — его читает специалист по 1С", async () => {
    stubJournal([
      {
        id: "s1",
        startedAt: iso(-1),
        finishedAt: iso(-1),
        outcome: "error",
        summary: {},
        events: [
          {
            at: iso(-1),
            direction: "in",
            outcome: "error",
            message: "Файл не разобран",
            details: { raw: "failure\nCommerceML: unexpected token at 12" },
          },
        ],
      },
    ]);
    renderChannel("commerceml");
    await userEvent.click(await screen.findByTestId("journal-session"));
    expect(await screen.findByText(/unexpected token at 12/)).toBeDefined();
  });

  it("сохраняет тип цены", async () => {
    renderChannel("commerceml");
    await userEvent.type(await screen.findByLabelText(/тип цены/i), "Розничная");
    await userEvent.click(screen.getByRole("button", { name: /сохранить/i }));
    expect(patchSpy).toHaveBeenCalledWith(
      "/integrations/commerceml",
      expect.objectContaining({ priceType: "Розничная" }),
    );
  });

  // Брифа 08 требования к спискам (пустое состояние, загрузка, ошибка --
  // каждое своим тестом) относятся и к журналу этой страницы -- он остаётся
  // единственным списком на ней.
  it("показывает пустое состояние журнала, когда обменов ещё не было", async () => {
    renderChannel("commerceml");
    expect(await screen.findByText(/обменов ещё не было/i)).toBeDefined();
  });

  it("показывает спиннер, пока журнал ещё не загрузился", async () => {
    renderChannel("commerceml", { journalMode: "pending" });
    // Настройки уже отрисованы (деталь канала загрузилась), а спиннер журнала
    // всё ещё висит -- это должно быть отдельное состояние, а не блокировать
    // всю страницу.
    expect(await screen.findByLabelText(/тип цены/i)).toBeDefined();

    // `@markiro/ui`'s `toast()` viewport is a module-level singleton that
    // outlives `cleanup()` (see `pickup.test.tsx`'s note on the same thing),
    // so an earlier test's toast can still carry its own `role="status"` --
    // scope the search to the journal card instead of a bare
    // `findByRole("status")`.
    const journalCard = (await screen.findByText(/журнал/i)).closest(".mk-card");
    if (!journalCard) throw new Error("expected to find the journal card");
    expect(within(journalCard as HTMLElement).getByRole("status")).toBeDefined();
    expect(screen.queryByText(/обменов ещё не было/i)).toBeNull();
  });

  it("показывает ошибку, когда запрос журнала не удался", async () => {
    renderChannel("commerceml", { journalMode: "error" });
    expect(await screen.findByText(/не удалось загрузить журнал/i)).toBeDefined();
    expect(screen.queryByText(/обменов ещё не было/i)).toBeNull();
  });
});
