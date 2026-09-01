import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";

import type { AccessDocument } from "../src/access/api.js";
import { AccessProvider } from "../src/access/context.js";
import { SignerAgentsPanel } from "../src/pages/integrations/SignerAgentsPanel.js";
import type { SignerAgent, SignerTokenStatus } from "../src/pages/integrations/api.js";
import { jsonResponse } from "./helpers/http.js";

// Общего рендер-хелпера в этом репозитории нет -- каждый админ-тест пишет
// свой render* заново (см. `apps/admin/test/integrations-api-keys.test.tsx`,
// которому этот файл следует почти дословно), но fetch-стаб строит настоящий
// Response через общий helpers/http.js (см. employees-routing.test.tsx,
// kiosks-routing.test.tsx).
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function newQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function agentFixture(overrides: Partial<SignerAgent> = {}): SignerAgent {
  return {
    id: "a1",
    name: "BUH-PC",
    status: "active",
    appVersion: "0.1.0",
    certThumbprint: null,
    certSubject: null,
    certInn: null,
    certNotAfter: null,
    lastSeenAt: null,
    createdAt: "2026-08-28T00:00:00Z",
    ...overrides,
  };
}

const NO_TOKEN: SignerTokenStatus = {
  status: "none",
  obtainedAt: null,
  expiresAt: null,
  certThumbprint: null,
};

let agentsFixture: SignerAgent[] = [];
let tokenFixture: SignerTokenStatus = NO_TOKEN;
let listMode: "ok" | "pending" | "error" = "ok";
let pairingCodeExpiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
let refreshTaskFixture: {
  id: string;
  status: "pending" | "claimed" | "completed" | "failed" | "expired";
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
} | null = null;

const revokeSpy = vi.fn();
const refreshTokenSpy = vi.fn();

beforeEach(() => {
  agentsFixture = [];
  tokenFixture = NO_TOKEN;
  listMode = "ok";
  pairingCodeExpiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  refreshTaskFixture = null;
  revokeSpy.mockClear();
  refreshTokenSpy.mockClear();
});

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

const READ_ONLY_ACCESS: AccessDocument = {
  roles: ["member"],
  capabilities: [CABINET_CAPABILITY.INTEGRATIONS_READ],
};

function renderPanel(access: AccessDocument = ADMIN_ACCESS) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^\/api/, "");
    const method = init?.method ?? "GET";

    if (method === "GET" && path === "/signer-agents") {
      if (listMode === "pending") return new Promise<Response>(() => {});
      if (listMode === "error") return jsonResponse(500, { message: "Internal error" });
      return jsonResponse(200, {
        agents: agentsFixture,
        token: tokenFixture,
        refreshTask: refreshTaskFixture,
      });
    }

    if (method === "POST" && path === "/signer-agents/pairing-code") {
      return jsonResponse(200, { code: "01234567", expiresAt: pairingCodeExpiresAt });
    }

    if (method === "POST" && path === "/signer-agents/token-refresh") {
      refreshTokenSpy();
      refreshTaskFixture = {
        id: "11111111-1111-4111-8111-111111111111",
        status: "pending",
        errorCode: null,
        errorMessage: null,
        createdAt: "2026-09-01T00:00:00Z",
        completedAt: null,
      };
      return jsonResponse(202, { status: "queued", taskId: refreshTaskFixture.id });
    }

    const revokeMatch = /^\/signer-agents\/([^/]+)\/revoke$/.exec(path);
    if (method === "POST" && revokeMatch) {
      revokeSpy(revokeMatch[1]);
      agentsFixture = agentsFixture.map((agent) =>
        agent.id === revokeMatch[1] ? { ...agent, status: "revoked" } : agent,
      );
      return jsonResponse(204, undefined);
    }

    return jsonResponse(404, { message: "not found" });
  });

  vi.stubGlobal("fetch", fetchMock);

  const view = render(
    <QueryClientProvider client={newQueryClient()}>
      <AccessProvider value={access}>
        <SignerAgentsPanel />
      </AccessProvider>
    </QueryClientProvider>,
  );
  return { ...view, fetchMock };
}

describe("SignerAgentsPanel", () => {
  it("renders agents and token status", async () => {
    agentsFixture = [agentFixture()];
    tokenFixture = NO_TOKEN;
    renderPanel();

    expect(await screen.findByText("BUH-PC")).toBeDefined();
    expect(screen.getByText(/нет токена|no token/i)).toBeDefined();
  });

  it("shows and copies the exact eight pairing digits", async () => {
    const copySpy = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: copySpy } });
    renderPanel();
    await userEvent.click(
      await screen.findByRole("button", { name: /код привязки|pairing code/i }),
    );
    const code = await screen.findByTestId("signer-pairing-code");
    expect(code.textContent).toBe("01234567");

    await userEvent.click(screen.getByRole("button", { name: /скопировать|copy/i }));
    expect(copySpy).toHaveBeenCalledWith("01234567");
  });

  it("clears a previous copy error when a new pairing code is issued", async () => {
    const copySpy = vi.fn().mockRejectedValue(new Error("Clipboard unavailable"));
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: copySpy } });
    renderPanel();

    const issueButton = await screen.findByRole("button", {
      name: /код привязки|pairing code/i,
    });
    await userEvent.click(issueButton);
    await userEvent.click(screen.getByRole("button", { name: /скопировать|copy/i }));
    expect(
      await screen.findByText(/не удалось скопировать код|could not copy the code/i),
    ).toBeDefined();

    await userEvent.click(issueButton);
    await waitFor(() =>
      expect(screen.queryByText(/не удалось скопировать код|could not copy the code/i)).toBeNull(),
    );
  });

  it("lets an administrator request a True API token refresh", async () => {
    agentsFixture = [agentFixture()];
    renderPanel();

    await userEvent.click(
      await screen.findByRole("button", { name: /обновить токен|refresh token/i }),
    );

    await waitFor(() => expect(refreshTokenSpy).toHaveBeenCalledOnce());
    expect(await screen.findByText(/задача.*отправлена|task.*sent/i)).toBeDefined();
    expect(
      (
        screen.getByRole("button", {
          name: /обновить токен|refresh token/i,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: /обновить токен|refresh token/i }));
    expect(refreshTokenSpy).toHaveBeenCalledOnce();
  });

  it("stops waiting and shows the signer task failure", async () => {
    agentsFixture = [agentFixture()];
    const polls: Array<() => void> = [];
    vi.spyOn(window, "setInterval").mockImplementation((handler: TimerHandler) => {
      if (typeof handler === "function") polls.push(() => handler());
      return setTimeout(() => undefined, 60_000);
    });
    const { fetchMock } = renderPanel();

    await userEvent.click(
      await screen.findByRole("button", { name: /обновить токен|refresh token/i }),
    );
    await waitFor(() => expect(refreshTokenSpy).toHaveBeenCalledOnce());
    await waitFor(() => expect(polls.length).toBeGreaterThan(0));

    refreshTaskFixture = {
      id: "11111111-1111-4111-8111-111111111111",
      status: "failed",
      errorCode: "TRUE_API",
      errorMessage: "Авторизация по МЧД отклонена",
      createdAt: "2026-09-01T00:00:00Z",
      completedAt: "2026-09-01T00:00:05Z",
    };
    const overviewCallsBeforePoll = fetchMock.mock.calls.filter(
      ([url, init]) => (init?.method ?? "GET") === "GET" && String(url).endsWith("/signer-agents"),
    ).length;
    await act(async () => polls.forEach((poll) => poll()));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          ([url, init]) =>
            (init?.method ?? "GET") === "GET" && String(url).endsWith("/signer-agents"),
        ).length,
      ).toBeGreaterThan(overviewCallsBeforePoll),
    );

    expect(await screen.findByText("Авторизация по МЧД отклонена")).toBeDefined();
    expect(
      (
        screen.getByRole("button", {
          name: /обновить токен|refresh token/i,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("stops waiting when the matching signer task completes", async () => {
    agentsFixture = [agentFixture()];
    const polls: Array<() => void> = [];
    vi.spyOn(window, "setInterval").mockImplementation((handler: TimerHandler) => {
      if (typeof handler === "function") polls.push(() => handler());
      return setTimeout(() => undefined, 60_000);
    });
    renderPanel();

    await userEvent.click(
      await screen.findByRole("button", { name: /обновить токен|refresh token/i }),
    );
    await waitFor(() => expect(refreshTokenSpy).toHaveBeenCalledOnce());
    await waitFor(() => expect(polls.length).toBeGreaterThan(0));

    refreshTaskFixture = {
      id: "11111111-1111-4111-8111-111111111111",
      status: "completed",
      errorCode: null,
      errorMessage: null,
      createdAt: "2026-09-01T00:00:00Z",
      completedAt: "2026-09-01T00:00:05Z",
    };
    await act(async () => polls.forEach((poll) => poll()));

    expect(
      await screen.findByText(/токен true api обновлён|true api token refreshed/i),
    ).toBeDefined();
    expect(
      (
        screen.getByRole("button", {
          name: /обновить токен|refresh token/i,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("polls a refresh task that was already open when the panel loaded", async () => {
    agentsFixture = [agentFixture()];
    refreshTaskFixture = {
      id: "11111111-1111-4111-8111-111111111111",
      status: "pending",
      errorCode: null,
      errorMessage: null,
      createdAt: "2026-09-01T00:00:00Z",
      completedAt: null,
    };
    const polls: Array<() => void> = [];
    vi.spyOn(window, "setInterval").mockImplementation((handler: TimerHandler) => {
      if (typeof handler === "function") polls.push(() => handler());
      return setTimeout(() => undefined, 60_000);
    });
    renderPanel();

    const refreshButton = await screen.findByRole("button", {
      name: /обновить токен|refresh token/i,
    });
    expect((refreshButton as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(polls.length).toBeGreaterThan(0));

    refreshTaskFixture = {
      ...refreshTaskFixture,
      status: "failed",
      errorCode: "NETWORK",
      errorMessage: "Подписант не смог связаться с True API",
      completedAt: "2026-09-01T00:00:05Z",
    };
    await act(async () => polls.forEach((poll) => poll()));

    expect(await screen.findByText("Подписант не смог связаться с True API")).toBeDefined();
    expect((refreshButton as HTMLButtonElement).disabled).toBe(false);
  });

  it("пустое состояние объясняет, как подключить агента", async () => {
    renderPanel();
    expect(await screen.findByText(/агенты ещё не подключены/i)).toBeDefined();
  });

  it("показывает спиннер, пока список ещё не загрузился", async () => {
    listMode = "pending";
    const { container } = renderPanel();
    expect(await within(container).findByRole("status")).toBeDefined();
  });

  it("показывает ошибку, когда запрос списка не удался", async () => {
    listMode = "error";
    renderPanel();
    expect(await screen.findByText(/не удалось загрузить список агентов/i)).toBeDefined();
  });

  it("read-only доступ видит список, но не может выпустить код или отозвать агента", async () => {
    agentsFixture = [agentFixture()];
    const { fetchMock } = renderPanel(READ_ONLY_ACCESS);

    expect(await screen.findByText("BUH-PC")).toBeDefined();
    expect(screen.queryByRole("button", { name: /код привязки/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /обновить токен/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /отозвать/i })).toBeNull();
    const download = screen.getByRole("link", { name: /скачать.*подписант.*windows/i });
    expect(download.getAttribute("href")).toBe("https://releases.markiro.app/signer/download");
    expect(download.getAttribute("data-analytics")).toBe("signer_download_click");
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("pairing-code"),
      expect.anything(),
    );
  });

  it("отзыв агента требует подтверждения и вызывает POST /signer-agents/:id/revoke", async () => {
    agentsFixture = [agentFixture()];
    renderPanel();

    await userEvent.click(await screen.findByRole("button", { name: /отозвать/i }));
    const dialog = await screen.findByRole("alertdialog");
    expect(revokeSpy).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: /отозвать/i }));

    await waitFor(() => expect(revokeSpy).toHaveBeenCalledWith("a1"));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });
});
