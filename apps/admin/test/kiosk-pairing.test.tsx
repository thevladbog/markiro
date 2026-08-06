import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";
import { ThemeProvider } from "@markiro/ui";

import type { AccessDocument } from "../src/access/api.js";
import { appRoutes } from "../src/app.js";
import {
  AuthClientProvider,
  type AuthClientLike,
  type OrganizationSummary,
  type SessionData,
} from "../src/auth/client.js";
import i18n from "../src/i18n/index.js";
import { jsonResponse } from "./helpers/http.js";

const ACTIVE_SESSION: SessionData = {
  session: { activeOrganizationId: "org_1" },
  user: { id: "user_1", email: "user@example.com", name: "Елена Ким" },
};

const ORGANIZATIONS: OrganizationSummary[] = [{ id: "org_1", name: "Марка Ко", slug: "marka-co" }];

const CREDENTIALS_ACCESS: AccessDocument = {
  roles: ["admin"],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ, CABINET_CAPABILITY.CREDENTIALS_MANAGE],
};

const OPERATIONS_WRITER_ACCESS: AccessDocument = {
  roles: ["manager"],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ, CABINET_CAPABILITY.OPERATIONS_WRITE],
};

const READ_ONLY_ACCESS: AccessDocument = {
  roles: [],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ],
};

const ONLINE_KIOSK = {
  id: "k1",
  name: "Касса у входа",
  location: "Зал 1",
  dayLimitPerEmployee: 5,
  showPrices: true,
  status: "active",
  lastSeenAt: new Date(Date.now() - 5_000).toISOString(),
  enrolled: true,
  productIds: [],
  createdAt: "2026-08-06T00:00:00.000Z",
};

const ARCHIVED_KIOSK = {
  ...ONLINE_KIOSK,
  id: "k9",
  name: "Архивный киоск",
  status: "archived",
};

type InitialEntry = string | { pathname: string; state: { kiosksBackground: true } };

function createFakeAuthClient(): AuthClientLike {
  return {
    useSession: () => ({ data: ACTIVE_SESSION, isPending: false, error: null }),
    useListOrganizations: () => ({ data: ORGANIZATIONS, isPending: false, error: null }),
    signIn: { email: async () => ({ data: {}, error: null }) },
    signUp: { email: async () => ({ data: {}, error: null }) },
    resetPassword: async () => ({ data: { status: true }, error: null }),
    signOut: async () => ({ data: {}, error: null }),
    organization: {
      create: async () => ({ data: { id: "org_1" }, error: null }),
      list: async () => ({ data: ORGANIZATIONS, error: null }),
      setActive: async () => ({ data: {}, error: null }),
    },
  };
}

function deferred<T>() {
  let resolve: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve: resolve! };
}

function futureExpiry(ms = 15 * 60_000): string {
  return new Date(Date.now() + ms).toISOString();
}

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Required element not found: ${selector}`);
  return element;
}

function storageSnapshot(storage: Storage): Record<string, string> {
  return Object.fromEntries(
    Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((key): key is string => key !== null)
      .map((key) => [key, storage.getItem(key) ?? ""]),
  );
}

function stubFetch({
  access = CREDENTIALS_ACCESS,
  kiosks = [ONLINE_KIOSK],
  onRequest,
}: {
  access?: AccessDocument;
  kiosks?: unknown[];
  onRequest?: (path: string, init?: RequestInit) => Response | Promise<Response> | undefined;
} = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/api/profile")) {
      return jsonResponse(200, {
        firstName: "Елена",
        lastName: "Ким",
        middleName: null,
        hasAvatar: false,
      });
    }
    if (path.endsWith("/api/access/me")) return jsonResponse(200, access);

    const override = await onRequest?.(path, init);
    if (override) return override;
    if (path === "/api/kiosks") return jsonResponse(200, { items: kiosks });
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stubPairingSequence(responses: Array<Response | Promise<Response>>) {
  return stubFetch({
    onRequest: (path, init) => {
      if (path !== `/api/kiosks/${ONLINE_KIOSK.id}/pairing-code` || init?.method !== "POST") {
        return undefined;
      }
      const response = responses.shift();
      if (!response) throw new Error("Unexpected extra pairing-code request");
      return response;
    },
  });
}

function renderKiosksRouter(
  initialEntries: InitialEntry | InitialEntry[],
  access: AccessDocument = CREDENTIALS_ACCESS,
) {
  const entries = Array.isArray(initialEntries) ? initialEntries : [initialEntries];
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createMemoryRouter(appRoutes, {
    initialEntries: entries,
    initialIndex: entries.length - 1,
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="light">
        <AuthClientProvider client={createFakeAuthClient()}>
          <RouterProvider router={router} />
        </AuthClientProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  return { ...view, queryClient, router, access };
}

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
  sessionStorage.clear();
  await i18n.changeLanguage("ru");
});

describe("safe kiosk pairing route", () => {
  it("opens the pairing panel without issuing a code", async () => {
    const fetchMock = stubFetch();
    const { router } = renderKiosksRouter(`/kiosks/${ONLINE_KIOSK.id}/pair`);

    const panel = await screen.findByRole("dialog", { name: "Привязка киоска" });
    expect(await within(panel).findByRole("button", { name: "Сформировать код" })).toBeDefined();
    expect(await within(panel).findByText(/отменит любой ранее сформированный/i)).toBeDefined();
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url) === `/api/kiosks/${ONLINE_KIOSK.id}/pairing-code` &&
          (init as RequestInit | undefined)?.method === "POST",
      ),
    ).toBe(false);
    expect(router.state.location.pathname).toBe(`/kiosks/${ONLINE_KIOSK.id}/pair`);
  });

  it("navigates from the list into safe entry without issuing a code", async () => {
    const fetchMock = stubFetch();
    const { router } = renderKiosksRouter("/kiosks");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Код привязки" }));

    expect(await screen.findByRole("dialog", { name: "Привязка киоска" })).toBeDefined();
    expect(router.state.location.pathname).toBe(`/kiosks/${ONLINE_KIOSK.id}/pair`);
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url) === `/api/kiosks/${ONLINE_KIOSK.id}/pairing-code` &&
          (init as RequestInit | undefined)?.method === "POST",
      ),
    ).toBe(false);
  });

  it.each([
    ["read-only", READ_ONLY_ACCESS],
    ["operations writer", OPERATIONS_WRITER_ACCESS],
  ])("denies direct pairing to a %s", async (_label, access) => {
    const fetchMock = stubFetch({ access });
    renderKiosksRouter(`/kiosks/${ONLINE_KIOSK.id}/pair`, access);

    expect(await screen.findByTestId("forbidden-page")).toBeDefined();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/pairing-code"))).toBe(false);
  });

  it("allows direct pairing to a credential manager", async () => {
    stubFetch();
    renderKiosksRouter(`/kiosks/${ONLINE_KIOSK.id}/pair`);

    expect(await screen.findByRole("dialog", { name: "Привязка киоска" })).toBeDefined();
    expect(screen.queryByTestId("forbidden-page")).toBeNull();
  });

  it("shows archived pairing as unavailable without issuing a code", async () => {
    const fetchMock = stubFetch({ kiosks: [ARCHIVED_KIOSK] });
    renderKiosksRouter(`/kiosks/${ARCHIVED_KIOSK.id}/pair`);

    const panel = await screen.findByRole("dialog", { name: "Привязка киоска" });
    expect((await within(panel).findByRole("alert")).textContent).toContain(
      "Привязка недоступна для киоска в архиве",
    );
    expect(within(panel).queryByRole("button", { name: "Сформировать код" })).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/pairing-code"))).toBe(false);
  });

  it("shows a successful-list not-found state without issuing a code", async () => {
    const fetchMock = stubFetch({ kiosks: [] });
    renderKiosksRouter("/kiosks/missing/pair");

    const panel = await screen.findByRole("dialog", { name: "Привязка киоска" });
    expect((await within(panel).findByRole("alert")).textContent).toContain("Киоск не найден");
    expect(within(panel).queryByRole("button", { name: "Сформировать код" })).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/pairing-code"))).toBe(false);
  });

  it("uses Back for a list-origin panel and destroys the route", async () => {
    stubFetch();
    const { router } = renderKiosksRouter([
      "/kiosks",
      {
        pathname: `/kiosks/${ONLINE_KIOSK.id}/pair`,
        state: { kiosksBackground: true },
      },
    ]);
    const user = userEvent.setup();

    const panel = await screen.findByRole("dialog", { name: "Привязка киоска" });
    await user.click(within(panel).getByRole("button", { name: "Назад" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/kiosks"));
  });

  it("uses Close as the direct-entry fallback", async () => {
    stubFetch();
    const { router } = renderKiosksRouter(`/kiosks/${ONLINE_KIOSK.id}/pair`);
    const user = userEvent.setup();

    const panel = await screen.findByRole("dialog", { name: "Привязка киоска" });
    await user.click(within(panel).getAllByRole("button", { name: "Закрыть" }).at(-1)!);

    await waitFor(() => expect(router.state.location.pathname).toBe("/kiosks"));
  });
});

describe("one-time pairing reveal", () => {
  it("issues only after confirmation and keeps plaintext out of caches, route state, and storage", async () => {
    const copy = vi.fn().mockResolvedValue(undefined);
    localStorage.setItem("keep-local", "unchanged");
    sessionStorage.setItem("keep-session", "unchanged");
    const fetchMock = stubPairingSequence([
      jsonResponse(201, { code: "12345678", expiresAt: futureExpiry() }),
    ]);
    const { queryClient, router } = renderKiosksRouter(`/kiosks/${ONLINE_KIOSK.id}/pair`);
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: copy },
    });
    const panel = await screen.findByRole("dialog", { name: "Привязка киоска" });
    const localBefore = storageSnapshot(localStorage);
    const sessionBefore = storageSnapshot(sessionStorage);

    await user.click(await within(panel).findByRole("button", { name: "Сформировать код" }));

    expect(await within(panel).findByText("1234 5678")).toBeDefined();
    expect(within(panel).getByRole("group", { name: "12345678" })).toBeDefined();
    expect(
      await within(panel).findByRole(
        "img",
        { name: "Штрихкод кода привязки 12345678" },
        { timeout: 3000 },
      ),
    ).toBeDefined();
    await user.click(within(panel).getByRole("button", { name: "Скопировать" }));
    expect(copy).toHaveBeenCalledWith("12345678");
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          String(url) === `/api/kiosks/${ONLINE_KIOSK.id}/pairing-code` &&
          (init as RequestInit | undefined)?.method === "POST",
      ),
    ).toHaveLength(1);

    expect(JSON.stringify(queryClient.getMutationCache().getAll())).not.toContain("12345678");
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ),
    ).not.toContain("12345678");
    expect(JSON.stringify(router.state.location.state)).not.toContain("12345678");
    expect(storageSnapshot(localStorage)).toEqual(localBefore);
    expect(storageSnapshot(sessionStorage)).toEqual(sessionBefore);
  });

  it("keeps an issue failure persistent in a no-code state", async () => {
    stubPairingSequence([jsonResponse(503, { message: "Gateway timeout" })]);
    renderKiosksRouter(`/kiosks/${ONLINE_KIOSK.id}/pair`);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Сформировать код" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Gateway timeout");
    expect(screen.queryByText("1234 5678")).toBeNull();
    expect(screen.getByRole("button", { name: "Сформировать код" })).toBeDefined();
  });

  it("discards the previous plaintext before a failed regeneration settles", async () => {
    stubPairingSequence([
      jsonResponse(201, { code: "12345678", expiresAt: futureExpiry() }),
      jsonResponse(503, { message: "Gateway timeout" }),
    ]);
    renderKiosksRouter(`/kiosks/${ONLINE_KIOSK.id}/pair`);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Сформировать код" }));
    expect(await screen.findByText("1234 5678")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Сформировать новый" }));

    expect(screen.queryByText("1234 5678")).toBeNull();
    expect((await screen.findByRole("alert")).textContent).toContain("Gateway timeout");
  });

  it("replaces a reveal with the successfully regenerated code", async () => {
    const fetchMock = stubPairingSequence([
      jsonResponse(201, { code: "12345678", expiresAt: futureExpiry() }),
      jsonResponse(201, { code: "87654321", expiresAt: futureExpiry() }),
    ]);
    renderKiosksRouter(`/kiosks/${ONLINE_KIOSK.id}/pair`);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Сформировать код" }));
    expect(await screen.findByText("1234 5678")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Сформировать новый" }));

    expect(await screen.findByText("8765 4321")).toBeDefined();
    expect(screen.queryByText("1234 5678")).toBeNull();
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes("/pairing-code")),
    ).toHaveLength(2);
  });

  it("removes the reveal at expiry without announcing every countdown tick", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubPairingSequence([jsonResponse(201, { code: "12345678", expiresAt: futureExpiry(2_000) })]);
    renderKiosksRouter(`/kiosks/${ONLINE_KIOSK.id}/pair`);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    await user.click(await screen.findByRole("button", { name: "Сформировать код" }));
    const countdown = await screen.findByText("Действителен ещё 00:02");
    expect(countdown.closest("[aria-live]")).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(
      await screen.findByText("Срок действия кода истёк. Сформируйте новый код."),
    ).toBeDefined();
    expect(screen.queryByText("1234 5678")).toBeNull();
    expect(screen.queryByRole("img", { name: /12345678/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Скопировать" })).toBeNull();
    expect(screen.getByRole("button", { name: "Сформировать новый" })).toBeDefined();
  });

  it("destroys plaintext on Done and reopens in safe entry", async () => {
    const fetchMock = stubPairingSequence([
      jsonResponse(201, { code: "12345678", expiresAt: futureExpiry() }),
    ]);
    const { router } = renderKiosksRouter(`/kiosks/${ONLINE_KIOSK.id}/pair`);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Сформировать код" }));
    expect(await screen.findByText("1234 5678")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Готово" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/kiosks"));
    expect(screen.queryByText("1234 5678")).toBeNull();

    await router.navigate(`/kiosks/${ONLINE_KIOSK.id}/pair`);
    expect(await screen.findByRole("button", { name: "Сформировать код" })).toBeDefined();
    expect(screen.queryByText("1234 5678")).toBeNull();
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes("/pairing-code")),
    ).toHaveLength(1);
  });

  it("destroys plaintext on Close and browser Back", async () => {
    const fetchMock = stubPairingSequence([
      jsonResponse(201, { code: "12345678", expiresAt: futureExpiry() }),
      jsonResponse(201, { code: "87654321", expiresAt: futureExpiry() }),
    ]);
    const { router } = renderKiosksRouter([
      "/kiosks",
      {
        pathname: `/kiosks/${ONLINE_KIOSK.id}/pair`,
        state: { kiosksBackground: true },
      },
    ]);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Сформировать код" }));
    expect(await screen.findByText("1234 5678")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Закрыть" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/kiosks"));
    expect(screen.queryByText("1234 5678")).toBeNull();

    await router.navigate(`/kiosks/${ONLINE_KIOSK.id}/pair`, {
      state: { kiosksBackground: true },
    });
    await user.click(await screen.findByRole("button", { name: "Сформировать код" }));
    expect(await screen.findByText("8765 4321")).toBeDefined();
    await router.navigate(-1);
    await waitFor(() => expect(router.state.location.pathname).toBe("/kiosks"));
    expect(screen.queryByText("8765 4321")).toBeNull();
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes("/pairing-code")),
    ).toHaveLength(2);
  });

  it("returns to safe entry after an unmount and reload", async () => {
    const fetchMock = stubPairingSequence([
      jsonResponse(201, { code: "12345678", expiresAt: futureExpiry() }),
    ]);
    const first = renderKiosksRouter(`/kiosks/${ONLINE_KIOSK.id}/pair`);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Сформировать код" }));
    expect(await screen.findByText("1234 5678")).toBeDefined();
    first.unmount();

    renderKiosksRouter(`/kiosks/${ONLINE_KIOSK.id}/pair`);
    expect(await screen.findByRole("button", { name: "Сформировать код" })).toBeDefined();
    expect(screen.queryByText("1234 5678")).toBeNull();
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes("/pairing-code")),
    ).toHaveLength(1);
  });

  it("blocks dismissal and duplicate issuance while the request is pending", async () => {
    const response = deferred<Response>();
    const fetchMock = stubPairingSequence([response.promise]);
    const { router } = renderKiosksRouter([
      "/kiosks",
      {
        pathname: `/kiosks/${ONLINE_KIOSK.id}/pair`,
        state: { kiosksBackground: true },
      },
    ]);
    const user = userEvent.setup();
    const panel = await screen.findByRole("dialog", { name: "Привязка киоска" });
    const issue = await within(panel).findByRole("button", { name: "Сформировать код" });

    await user.click(issue);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url).includes("/pairing-code")),
      ).toHaveLength(1),
    );
    expect(
      (within(panel).getByRole("button", { name: "Закрыть" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((issue as HTMLButtonElement).disabled).toBe(true);
    await user.click(issue);
    await user.keyboard("{Escape}");
    fireEvent.mouseDown(requiredElement<HTMLElement>(".mk-side-panel__scrim"));
    await router.navigate(-1);

    expect(router.state.location.pathname).toBe(`/kiosks/${ONLINE_KIOSK.id}/pair`);
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes("/pairing-code")),
    ).toHaveLength(1);

    response.resolve(jsonResponse(201, { code: "12345678", expiresAt: futureExpiry() }));
    expect(await screen.findByText("1234 5678")).toBeDefined();
  });

  it("shows copy failure inside the reveal without destroying the code", async () => {
    stubPairingSequence([jsonResponse(201, { code: "12345678", expiresAt: futureExpiry() })]);
    renderKiosksRouter(`/kiosks/${ONLINE_KIOSK.id}/pair`);
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("Clipboard denied")) },
    });

    await user.click(await screen.findByRole("button", { name: "Сформировать код" }));
    await user.click(await screen.findByRole("button", { name: "Скопировать" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Не удалось скопировать код");
    expect(screen.getByText("1234 5678")).toBeDefined();
  });
});
