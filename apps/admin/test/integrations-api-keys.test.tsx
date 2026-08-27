import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";

import type { AccessDocument } from "../src/access/api.js";
import { AccessProvider } from "../src/access/context.js";
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
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
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
/**
 * How `DELETE /integrations/public_api/keys/:id` should behave.
 * "already-gone" mirrors the server's real repeat-revoke contract
 * (`api-keys.service.ts`'s `revoke`: "there is no separate 'already
 * revoked' response", just the same 404 any unknown id gets) -- it also
 * removes the id from `keysFixture` so the *next* `GET` (the refetch a
 * correct `onError` triggers) reflects the row actually being gone, the
 * same way a real server would after another admin/tab revoked it first.
 */
let revokeMode: "ok" | "already-gone" = "ok";

/** Every `DELETE /integrations/public_api/keys/:id` call, as the key id. */
const revokeSpy = vi.fn();

beforeEach(() => {
  keysFixture = [];
  listMode = "ok";
  revokeMode = "ok";
  revokeSpy.mockClear();
});

/** `stubKeys([...])` -- overrides the keys-list fixture for one test. */
function stubKeys(fixtures: KeyFixture[]): void {
  keysFixture = fixtures;
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

const INTEGRATIONS_READ_ACCESS: AccessDocument = {
  roles: ["member"],
  capabilities: [CABINET_CAPABILITY.INTEGRATIONS_READ],
};

function renderPanel(access: AccessDocument = ADMIN_ACCESS) {
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
      if (revokeMode === "already-gone") {
        keysFixture = keysFixture.filter((k) => k.id !== revokeMatch[1]);
        return jsonResponse(404, { message: "Unknown public API key" });
      }
      return jsonResponse(200, undefined);
    }

    return jsonResponse(404, { message: "not found" });
  });

  vi.stubGlobal("fetch", fetchMock);

  const view = render(
    <QueryClientProvider client={newQueryClient()}>
      <AccessProvider value={access}>
        <ApiKeysPanel />
      </AccessProvider>
    </QueryClientProvider>,
  );
  return { ...view, fetchMock };
}

describe("ApiKeysPanel", () => {
  it("renders a translated restriction without mounting key requests for read-only access", async () => {
    const { fetchMock } = renderPanel(INTEGRATIONS_READ_ACCESS);

    expect(await screen.findByText("У вас нет доступа к этому разделу.")).toBeDefined();
    expect(screen.queryByRole("button", { name: /выпустить/i })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

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

  // Fix 2 (review, task 15 follow-up): the brief's contract for a repeat
  // revoke is a 404 -- meaning "this key is already gone", not "the request
  // failed". `useRevokeApiKey` used to invalidate the list only in
  // `onSuccess`, so this 404 left the confirm modal open, the already-gone
  // row still sitting in the table (offering "Отозвать" against it forever,
  // with the same 404 every time), and a raw server string in the toast.
  it("повторный отзыв (404) убирает исчезнувшую строку, закрывает диалог и не показывает сырую ошибку сервера", async () => {
    stubKeys([{ id: "k1", name: "Склад", createdAt: iso(-1) }]);
    revokeMode = "already-gone";
    renderPanel();

    await userEvent.click(await screen.findByRole("button", { name: /отозвать/i }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /отозвать/i }));

    await waitFor(() => expect(revokeSpy).toHaveBeenCalledWith("k1"));
    // The 404 must be treated as "goal achieved", not "failed": the modal
    // closes and the vanished row leaves the table, exactly like a
    // successfully confirmed revoke would.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(screen.queryByText("Склад")).toBeNull());
    expect(screen.queryByText(/unknown public api key/i)).toBeNull();

    // Clicking "Отозвать" again against the now-vanished row must not be
    // possible -- there is no more "Отозвать" button for it, and no second
    // DELETE call happens on its own.
    expect(screen.queryByRole("button", { name: /отозвать/i })).toBeNull();
    expect(revokeSpy).toHaveBeenCalledTimes(1);
  });
});
