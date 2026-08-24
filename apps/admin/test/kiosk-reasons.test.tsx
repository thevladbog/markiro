import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, expect, it, vi } from "vitest";

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

const ACTIVE_SESSION: SessionData = {
  session: { activeOrganizationId: "org_1" },
  user: { id: "user_1", email: "user@example.com", name: "Елена Ким" },
};

const ORGANIZATIONS: OrganizationSummary[] = [{ id: "org_1", name: "Марка Ко", slug: "marka-co" }];

const OPERATIONS_WRITE: AccessDocument = {
  roles: ["manager"],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ, CABINET_CAPABILITY.OPERATIONS_WRITE],
};

const OPERATIONS_READ_ONLY: AccessDocument = {
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
  lastSeenAt: new Date().toISOString(),
  enrolled: true,
  productIds: [],
  createdAt: "2026-01-01T00:00:00.000Z",
};

const REASON_A = { id: "r1", name: "Испорчен товар", sortOrder: 1 };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

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

function stubFetch({
  access = OPERATIONS_WRITE,
  kiosks = [],
  reasons = [],
  onRequest,
}: {
  access?: AccessDocument;
  kiosks?: unknown[];
  reasons?: unknown[];
  onRequest?: (path: string, init?: RequestInit) => Response | Promise<Response> | undefined;
}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const override = await onRequest?.(path, init);
    if (override) return override;
    if (path.endsWith("/api/profile")) {
      return jsonResponse(200, {
        firstName: "Елена",
        lastName: "Ким",
        middleName: null,
        hasAvatar: false,
      });
    }
    if (path.endsWith("/api/access/me")) return jsonResponse(200, access);
    if (path.endsWith("/api/kiosks")) return jsonResponse(200, { items: kiosks });
    if (path.endsWith("/api/pickup-reasons")) return jsonResponse(200, { items: reasons });
    if (path.endsWith("/api/products")) return jsonResponse(200, { items: [] });
    return jsonResponse(200, { items: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderKiosksRouter(initialPath: string) {
  const router = createMemoryRouter(appRoutes, { initialEntries: [initialPath] });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
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
  return { ...view, queryClient, router };
}

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("ru");
});

it("moves reasons to a route-backed sibling view", async () => {
  const fetchMock = stubFetch({ kiosks: [ONLINE_KIOSK], reasons: [REASON_A] });
  const { router } = renderKiosksRouter("/kiosks");
  const user = userEvent.setup();

  await screen.findByRole("link", { name: "Причины списания" });
  fetchMock.mockClear();
  await user.click(await screen.findByRole("link", { name: "Причины списания" }));

  expect(router.state.location.pathname).toBe("/pickup/reasons");
  expect(
    (await screen.findByRole("link", { name: "Причины" })).getAttribute("aria-current"),
  ).toBe("page");
  expect(await screen.findByText(REASON_A.name)).toBeDefined();
  expect(screen.queryByText(ONLINE_KIOSK.name)).toBeNull();
  expect(fetchMock).not.toHaveBeenCalledWith("/api/kiosks", expect.anything());
});

it("keeps a failed reason edit in its row with the exact payload", async () => {
  const fetchMock = stubFetch({
    reasons: [REASON_A],
    onRequest: (path, init) =>
      path.endsWith(`/api/pickup-reasons/${REASON_A.id}`) && init?.method === "PATCH"
        ? jsonResponse(409, { message: "Reason is referenced" })
        : undefined,
  });
  renderKiosksRouter("/pickup/reasons");
  const user = userEvent.setup();

  await user.click(await screen.findByRole("button", { name: "Изменить" }));
  await user.clear(screen.getByLabelText("Название"));
  await user.type(screen.getByLabelText("Название"), "Повреждение упаковки");
  await user.clear(screen.getByLabelText("Порядок"));
  await user.type(screen.getByLabelText("Порядок"), "7");
  await user.click(screen.getByRole("button", { name: "Сохранить" }));

  expect(fetchMock).toHaveBeenCalledWith(
    `/api/pickup-reasons/${REASON_A.id}`,
    expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ name: "Повреждение упаковки", sortOrder: 7 }),
    }),
  );
  expect((await screen.findByRole("alert")).textContent).toContain("Reason is referenced");
  expect((screen.getByLabelText("Название") as HTMLInputElement).value).toBe(
    "Повреждение упаковки",
  );
});

it("renders a semantic reasons table for an authorized user", async () => {
  stubFetch({ reasons: [REASON_A] });
  renderKiosksRouter("/pickup/reasons");

  await screen.findByText(REASON_A.name);
  const table = screen.getByRole("table", { name: "Причины списания" });
  expect(
    within(table)
      .getAllByRole("columnheader")
      .map((header) => header.textContent),
  ).toEqual(["Название", "Порядок", "Действия"]);
  const row = within(table).getByRole("row", { name: /Испорчен товар.*1/ });
  expect(within(row).getByRole("button", { name: "Изменить" })).toBeDefined();
  expect(within(row).getByRole("button", { name: "Удалить" })).toBeDefined();
});

it("uses a table-shaped loading state for reasons", async () => {
  const pendingReasons = new Promise<Response>(() => undefined);
  stubFetch({
    onRequest: (path) => (path.endsWith("/api/pickup-reasons") ? pendingReasons : undefined),
  });
  renderKiosksRouter("/pickup/reasons");

  await screen.findByRole("heading", { name: "Выбытие" });
  const loading = screen.getByRole("status");
  expect(loading.querySelector("table")).not.toBeNull();
});

it("does not fetch write-off reasons from the kiosk view", async () => {
  const fetchMock = stubFetch({ kiosks: [ONLINE_KIOSK] });
  renderKiosksRouter("/kiosks");

  expect(await screen.findByText(ONLINE_KIOSK.name)).toBeDefined();
  expect(fetchMock.mock.calls.some(([path]) => String(path).includes("/api/pickup-reasons"))).toBe(
    false,
  );
});

it("keeps direct read-only reasons access readable", async () => {
  stubFetch({ access: OPERATIONS_READ_ONLY, reasons: [REASON_A] });
  renderKiosksRouter("/pickup/reasons");

  expect(await screen.findByText(REASON_A.name)).toBeDefined();
  const table = screen.getByRole("table", { name: "Причины списания" });
  expect(
    within(table)
      .getAllByRole("columnheader")
      .map((header) => header.textContent),
  ).toEqual(["Название", "Порядок", "Действия"]);
  expect(screen.queryByRole("button", { name: "Добавить причину" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Изменить" })).toBeNull();
});

it("uses the full empty state for an authorized empty reasons table", async () => {
  stubFetch({ reasons: [] });
  renderKiosksRouter("/pickup/reasons");

  expect(await screen.findByText("Причины списания не добавлены")).toBeDefined();
  expect(screen.getByText("Причины не добавлены")).toBeDefined();
  expect(screen.getByRole("button", { name: "Добавить причину" })).toBeDefined();
});

it("associates create and edit validation with the exact invalid reason field", async () => {
  const fetchMock = stubFetch({ reasons: [REASON_A] });
  renderKiosksRouter("/pickup/reasons");
  const user = userEvent.setup();

  await user.click(await screen.findByRole("button", { name: "Добавить причину" }));
  const createName = screen.getByLabelText("Название");
  await user.type(createName, "   ");
  await user.click(screen.getByRole("button", { name: "Создать" }));
  expect(createName.getAttribute("aria-invalid")).toBe("true");
  expect(
    document.getElementById(createName.getAttribute("aria-describedby") ?? "")?.textContent,
  ).toBe("Укажите название");

  await user.click(screen.getByRole("button", { name: "Изменить" }));
  const editName = screen.getByLabelText("Название");
  const editOrder = screen.getByLabelText("Порядок");
  await user.clear(editName);
  await user.click(screen.getByRole("button", { name: "Сохранить" }));
  expect(editName.getAttribute("aria-invalid")).toBe("true");
  expect(editOrder.hasAttribute("aria-invalid")).toBe(false);
  expect(
    document.getElementById(editName.getAttribute("aria-describedby") ?? "")?.textContent,
  ).toBe("Укажите название");

  await user.type(editName, "Исправленная причина");
  await user.clear(editOrder);
  await user.click(screen.getByRole("button", { name: "Сохранить" }));
  expect(editName.hasAttribute("aria-invalid")).toBe(false);
  expect(editOrder.getAttribute("aria-invalid")).toBe("true");
  expect(
    document.getElementById(editOrder.getAttribute("aria-describedby") ?? "")?.textContent,
  ).toBe("Введите целое число для порядка");
  expect(
    fetchMock.mock.calls.some(
      ([path, init]) => String(path).includes("/api/pickup-reasons") && init?.method !== undefined,
    ),
  ).toBe(false);

  await user.type(screen.getByLabelText("Порядок"), "1.5");
  await user.click(screen.getByRole("button", { name: "Сохранить" }));
  expect(editOrder.getAttribute("aria-invalid")).toBe("true");
  expect(
    fetchMock.mock.calls.some(
      ([path, init]) => String(path).includes("/api/pickup-reasons") && init?.method !== undefined,
    ),
  ).toBe(false);
});

it("creates a reason with the exact trimmed payload", async () => {
  const fetchMock = stubFetch({
    reasons: [],
    onRequest: (path, init) =>
      path.endsWith("/api/pickup-reasons") && init?.method === "POST"
        ? jsonResponse(201, { id: "r2", name: "Брак упаковки", sortOrder: 2 })
        : undefined,
  });
  renderKiosksRouter("/pickup/reasons");
  const user = userEvent.setup();

  await user.click(await screen.findByRole("button", { name: "Добавить причину" }));
  await user.type(screen.getByLabelText("Название"), "  Брак упаковки  ");
  await user.click(screen.getByRole("button", { name: "Создать" }));

  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/pickup-reasons",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ name: "Брак упаковки" }) }),
    );
  });
});

it("announces successful reason create, update, and delete operations", async () => {
  const createdReason = { id: "r2", name: "Брак упаковки", sortOrder: 2 };
  stubFetch({
    reasons: [REASON_A],
    onRequest: (path, init) => {
      if (path.endsWith("/api/pickup-reasons") && init?.method === "POST") {
        return jsonResponse(201, createdReason);
      }
      if (path.endsWith(`/api/pickup-reasons/${REASON_A.id}`) && init?.method === "PATCH") {
        return jsonResponse(200, REASON_A);
      }
      if (path.endsWith(`/api/pickup-reasons/${REASON_A.id}`) && init?.method === "DELETE") {
        return jsonResponse(204, undefined);
      }
      return undefined;
    },
  });
  renderKiosksRouter("/pickup/reasons");
  const user = userEvent.setup();

  await user.click(await screen.findByRole("button", { name: "Добавить причину" }));
  await user.type(screen.getByLabelText("Название"), createdReason.name);
  await user.click(screen.getByRole("button", { name: "Создать" }));
  expect((await screen.findAllByText("Причина добавлена")).length).toBeGreaterThan(0);

  await user.click(screen.getByRole("button", { name: "Изменить" }));
  await user.click(screen.getByRole("button", { name: "Сохранить" }));
  expect((await screen.findAllByText("Причина обновлена")).length).toBeGreaterThan(0);

  await user.click(screen.getByRole("button", { name: "Удалить" }));
  const dialog = screen.getByRole("alertdialog", { name: "Удалить причину?" });
  await user.click(within(dialog).getByRole("button", { name: "Удалить" }));
  expect((await screen.findAllByText("Причина удалена")).length).toBeGreaterThan(0);
});

it("keeps a failed delete in its confirmation dialog", async () => {
  stubFetch({
    reasons: [REASON_A],
    onRequest: (path, init) =>
      path.endsWith(`/api/pickup-reasons/${REASON_A.id}`) && init?.method === "DELETE"
        ? jsonResponse(409, { message: "Reason is referenced" })
        : undefined,
  });
  renderKiosksRouter("/pickup/reasons");
  const user = userEvent.setup();

  await user.click(await screen.findByRole("button", { name: "Удалить" }));
  const dialog = screen.getByRole("alertdialog", { name: "Удалить причину?" });
  await user.click(within(dialog).getByRole("button", { name: "Удалить" }));

  expect((await within(dialog).findByRole("alert")).textContent).toContain("Reason is referenced");
});

it("protects a non-empty create draft before local navigation", async () => {
  stubFetch({ reasons: [REASON_A] });
  const { router } = renderKiosksRouter("/pickup/reasons");
  const user = userEvent.setup();

  await user.click(await screen.findByRole("button", { name: "Добавить причину" }));
  await user.type(screen.getByLabelText("Название"), "Брак упаковки");
  await user.click(
    within(screen.getByRole("navigation", { name: "Разделы выбытия" })).getByRole("link", {
      name: "Заявки",
    }),
  );
  expect(await screen.findByRole("alertdialog", { name: "Отменить изменения?" })).toBeDefined();
  expect(router.state.location.pathname).toBe("/pickup/reasons");

  await user.click(screen.getByRole("button", { name: "Не сохранять" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/pickup"));
});

it("leaves modified local-navigation clicks to the browser", async () => {
  stubFetch({ reasons: [REASON_A] });
  const { router } = renderKiosksRouter("/pickup/reasons");
  const user = userEvent.setup();

  await user.click(await screen.findByRole("button", { name: "Добавить причину" }));
  await user.type(screen.getByLabelText("Название"), "Брак упаковки");
  const kiosksLink = within(screen.getByRole("navigation", { name: "Разделы выбытия" })).getByRole(
    "link",
    { name: "Заявки" },
  );

  expect(fireEvent.click(kiosksLink, { button: 0, ctrlKey: true })).toBe(true);
  expect(screen.queryByRole("alertdialog", { name: "Отменить изменения?" })).toBeNull();
  expect(router.state.location.pathname).toBe("/pickup/reasons");
});

it("confirms before replacing a dirty row edit with another row", async () => {
  const reasonB = { id: "r2", name: "Истёк срок годности", sortOrder: 2 };
  stubFetch({ reasons: [REASON_A, reasonB] });
  renderKiosksRouter("/pickup/reasons");
  const user = userEvent.setup();

  await user.click((await screen.findAllByRole("button", { name: "Изменить" }))[0]!);
  await user.clear(screen.getByLabelText("Название"));
  await user.type(screen.getByLabelText("Название"), "Локальная правка");
  await user.click((await screen.findAllByRole("button", { name: "Изменить" }))[0]!);

  expect(await screen.findByRole("alertdialog", { name: "Отменить изменения?" })).toBeDefined();
  await user.click(screen.getByRole("button", { name: "Не сохранять" }));
  expect(((await screen.findByLabelText("Название")) as HTMLInputElement).value).toBe(reasonB.name);
});

it("confirms before replacing a dirty row edit with the create row", async () => {
  stubFetch({ reasons: [REASON_A] });
  renderKiosksRouter("/pickup/reasons");
  const user = userEvent.setup();

  await user.click(await screen.findByRole("button", { name: "Изменить" }));
  await user.clear(screen.getByLabelText("Название"));
  await user.type(screen.getByLabelText("Название"), "Локальная правка");
  await user.click(screen.getByRole("button", { name: "Добавить причину" }));

  const confirmation = await screen.findByRole("alertdialog", { name: "Отменить изменения?" });
  expect(screen.getAllByLabelText("Название")).toHaveLength(1);
  await user.click(within(confirmation).getByRole("button", { name: "Не сохранять" }));

  expect(screen.getAllByLabelText("Название")).toHaveLength(1);
  expect((screen.getByLabelText("Название") as HTMLInputElement).value).toBe("");
});

it("marks local navigation unavailable while a reason mutation is pending", async () => {
  const createResponse = new Promise<Response>(() => undefined);
  stubFetch({
    reasons: [],
    onRequest: (path, init) =>
      path.endsWith("/api/pickup-reasons") && init?.method === "POST" ? createResponse : undefined,
  });
  const { router } = renderKiosksRouter("/pickup/reasons");
  const user = userEvent.setup();

  await user.click(await screen.findByRole("button", { name: "Добавить причину" }));
  await user.type(screen.getByLabelText("Название"), "Брак упаковки");
  await user.click(screen.getByRole("button", { name: "Создать" }));

  const kiosksLink = within(screen.getByRole("navigation", { name: "Разделы выбытия" })).getByRole(
    "link",
    { name: "Заявки" },
  );
  await waitFor(() => expect(kiosksLink.getAttribute("aria-disabled")).toBe("true"));
  await user.click(kiosksLink);
  expect(router.state.location.pathname).toBe("/pickup/reasons");
});

it("does not replace a dirty edit when a query refetches", async () => {
  let currentReason = REASON_A;
  stubFetch({
    onRequest: (path) =>
      path.endsWith("/api/pickup-reasons")
        ? jsonResponse(200, { items: [currentReason] })
        : undefined,
  });
  const { queryClient } = renderKiosksRouter("/pickup/reasons");
  const user = userEvent.setup();

  await user.click(await screen.findByRole("button", { name: "Изменить" }));
  await user.clear(screen.getByLabelText("Название"));
  await user.type(screen.getByLabelText("Название"), "Локальная правка");
  currentReason = { ...REASON_A, name: "Серверная правка" };
  await queryClient.invalidateQueries({ queryKey: ["pickup-reasons"] });

  expect((screen.getByLabelText("Название") as HTMLInputElement).value).toBe("Локальная правка");
});

it("preserves a dirty reason draft when a background refetch fails", async () => {
  let attempts = 0;
  stubFetch({
    onRequest: (path) => {
      if (!path.endsWith("/api/pickup-reasons")) return undefined;
      attempts += 1;
      if (attempts === 2) return jsonResponse(503, { message: "Refetch failed" });
      return jsonResponse(200, { items: [REASON_A] });
    },
  });
  const { queryClient } = renderKiosksRouter("/pickup/reasons");
  const user = userEvent.setup();

  await user.click(await screen.findByRole("button", { name: "Изменить" }));
  const name = screen.getByLabelText("Название");
  await user.clear(name);
  await user.type(name, "Локальная правка");
  await queryClient.invalidateQueries({ queryKey: ["pickup-reasons"] });

  expect(
    await screen.findByText("Не удалось обновить причины. Показаны последние загруженные данные."),
  ).toBeDefined();
  expect((screen.getByLabelText("Название") as HTMLInputElement).value).toBe("Локальная правка");

  await user.click(screen.getByRole("button", { name: "Повторить" }));
  await waitFor(() => expect(attempts).toBe(3));
  expect(
    screen.queryByText("Не удалось обновить причины. Показаны последние загруженные данные."),
  ).toBeNull();
  expect((screen.getByLabelText("Название") as HTMLInputElement).value).toBe("Локальная правка");
});
