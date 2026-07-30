import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiKeysPanel } from "../src/pages/integrations/ApiKeysPanel.js";

// Общего рендер-хелпера в этом репозитории нет -- каждый админ-тест пишет
// свой render*/стаб fetch заново, см. `apps/admin/test/counterparties.test.tsx`
// строки 15-30.
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

function newQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

interface KeyFixture {
  id: string;
  name: string | null;
  createdAt: string;
  lastRequest?: string | null;
}

function toApiKeyDto(fixture: KeyFixture) {
  return {
    id: fixture.id,
    name: fixture.name,
    kind: "public" as const,
    createdAt: fixture.createdAt,
    lastRequest: fixture.lastRequest ?? null,
  };
}

/** `iso(-1)` -- an hour ago; `iso(1)` -- an hour from now. Relative to render time. */
function iso(hoursOffset: number): string {
  return new Date(Date.now() + hoursOffset * 3_600_000).toISOString();
}

/** The keys-list fixture -- reset before every test, overridden by `stubKeys`. */
let keysFixture: KeyFixture[] = [];
/** How `GET /integrations/public_api/keys` should behave for `renderPanel`. */
let listMode: "ok" | "pending" | "error" = "ok";

/** Every `DELETE /integrations/public_api/keys/:id` call, as the key id. */
const revokeSpy = vi.fn();

beforeEach(() => {
  keysFixture = [];
  listMode = "ok";
  revokeSpy.mockClear();
});

/** `stubKeys([...])` -- overrides the keys-list fixture for one test. */
function stubKeys(fixtures: KeyFixture[]): void {
  keysFixture = fixtures;
}

function renderPanel() {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^\/api/, "");
    const method = init?.method ?? "GET";

    if (method === "GET" && path === "/integrations/public_api/keys") {
      if (listMode === "pending") return new Promise<Response>(() => {});
      if (listMode === "error") return jsonResponse(500, { message: "Internal error" });
      return jsonResponse(200, { keys: keysFixture.map(toApiKeyDto) });
    }

    if (method === "POST" && path === "/integrations/public_api/keys") {
      const body = JSON.parse((init?.body as string | undefined) ?? "{}") as { name: string };
      return jsonResponse(200, { id: "new-key", key: `mk_${body.name.toLowerCase()}_secret` });
    }

    const revokeMatch = /^\/integrations\/public_api\/keys\/([^/]+)$/.exec(path);
    if (method === "DELETE" && revokeMatch) {
      revokeSpy(revokeMatch[1]);
      return jsonResponse(200, undefined);
    }

    return jsonResponse(404, { message: "not found" });
  });

  vi.stubGlobal("fetch", fetchMock);

  return render(
    <QueryClientProvider client={newQueryClient()}>
      <ApiKeysPanel />
    </QueryClientProvider>,
  );
}

describe("ApiKeysPanel", () => {
  it("показывает выпущенный ключ один раз и предупреждает об этом", async () => {
    renderPanel();
    await userEvent.type(await screen.findByLabelText(/название/i), "Склад");
    await userEvent.click(screen.getByRole("button", { name: /выпустить/i }));
    expect(await screen.findByText(/mk_/)).toBeDefined();
    expect(screen.getByText(/больше он показан не будет/i)).toBeDefined();
  });

  it("отзыв требует подтверждения — ключ живой и его отзыв необратим", async () => {
    stubKeys([{ id: "k1", name: "Склад", createdAt: iso(-1) }]);
    renderPanel();
    await userEvent.click(await screen.findByRole("button", { name: /отозвать/i }));
    expect(await screen.findByRole("dialog")).toBeDefined();
    expect(revokeSpy).not.toHaveBeenCalled();
  });

  it("пустое состояние объясняет, зачем ключ нужен", async () => {
    stubKeys([]);
    renderPanel();
    expect(await screen.findByText(/ключей пока нет/i)).toBeDefined();
  });

  // Брифа 08 требования к спискам (пустое состояние, загрузка, ошибка --
  // каждое своим тестом) относятся и к списку ключей -- это новый список,
  // ровно тот случай, для которого правило написано (см.
  // `integrations-candidates.test.tsx`, которое добавляет эти же два теста
  // сверх того, что дал бриф).
  it("показывает спиннер, пока список ключей ещё не загрузился", async () => {
    listMode = "pending";
    const { container } = renderPanel();
    expect(await within(container).findByRole("status")).toBeDefined();
    expect(screen.queryByText(/ключей пока нет/i)).toBeNull();
  });

  it("показывает ошибку, когда запрос списка ключей не удался", async () => {
    listMode = "error";
    renderPanel();
    expect(await screen.findByText(/не удалось загрузить ключи/i)).toBeDefined();
    expect(screen.queryByText(/ключей пока нет/i)).toBeNull();
  });

  it("подтверждённый отзыв вызывает DELETE и закрывает диалог подтверждения", async () => {
    stubKeys([{ id: "k1", name: "Склад", createdAt: iso(-1) }]);
    renderPanel();
    await userEvent.click(await screen.findByRole("button", { name: /отозвать/i }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /отозвать/i }));

    await waitFor(() => expect(revokeSpy).toHaveBeenCalledWith("k1"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
