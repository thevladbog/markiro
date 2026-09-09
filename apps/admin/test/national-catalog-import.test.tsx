import { StrictMode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider, MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { ThemeProvider } from "@markiro/ui";
import { NationalCatalogIdentityBoundary } from "../src/pages/catalog/national-catalog/ImportPanel.js";
import { AuthQueryBoundary } from "../src/query/AuthQueryBoundary.js";
import { appRoutes } from "../src/app.js";
import { AuthClientProvider, type AuthClientLike } from "../src/auth/client.js";
import "../src/i18n/index.js";
import {
  capabilitiesFixture,
  id,
  itemsFixture,
  sessionFixture,
} from "./national-catalog-fixtures.js";
const defaultSession = {
  data: {
    session: { activeOrganizationId: "tenant" },
    user: { id: "user", email: "user@example.test" },
  },
  isPending: false,
  error: null,
};
let testSession: ReturnType<AuthClientLike["useSession"]> = defaultSession;
const auth: AuthClientLike = {
  useSession: () => testSession,
  useListOrganizations: () => ({
    data: [{ id: "tenant", name: "Tenant", slug: "tenant" }],
    isPending: false,
    error: null,
  }),
  signIn: { email: async () => ({ data: {}, error: null }) },
  signUp: { email: async () => ({ data: {}, error: null }) },
  resetPassword: async () => ({ data: { status: true }, error: null }),
  signOut: async () => ({ data: {}, error: null }),
  organization: {
    create: async () => ({ data: { id: "tenant" }, error: null }),
    list: async () => ({ data: [], error: null }),
    setActive: async () => ({ data: {}, error: null }),
  },
};
function renderImport(route = "/catalog") {
  const router = createMemoryRouter(appRoutes, { initialEntries: [route] });
  const user = userEvent.setup();
  const content = () => (
    <StrictMode>
      <ThemeProvider>
        <QueryClientProvider
          client={
            new QueryClient({
              defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
            })
          }
        >
          <AuthClientProvider client={auth}>
            <NationalCatalogIdentityBoundary
              onIdentityChange={async () => {
                if (router.state.location.pathname.startsWith("/catalog/import"))
                  await router.navigate("/catalog/import", { replace: true });
              }}
            >
              <AuthQueryBoundary>
                <RouterProvider router={router} />
              </AuthQueryBoundary>
            </NationalCatalogIdentityBoundary>
          </AuthClientProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </StrictMode>
  );
  const view = render(content());
  return { router, user, ...view, refresh: () => view.rerender(content()) };
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  testSession = defaultSession;
  vi.restoreAllMocks();
});
it("keeps the complete server selection across pages and returning to an earlier page", async () => {
  let session = { ...sessionFixture };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      let body: unknown = { items: [] };
      if (path.includes("/access/me"))
        body = { roles: ["manager"], capabilities: ["operations.read", "operations.write"] };
      else if (path.includes("/profile"))
        body = { firstName: "Игорь", middleName: null, lastName: "Волков", hasAvatar: false };
      else if (path.includes("/capabilities")) body = capabilitiesFixture;
      else if (path.includes("/selection")) {
        const input = JSON.parse(String(init?.body));
        session = {
          ...session,
          revision: session.revision + 1,
          selectedItemIds: input.itemIds,
          selected: input.itemIds.length,
        };
        body = session;
      } else if (path.includes("/items"))
        body = path.includes("cursor=page2")
          ? {
              items: [{ ...itemsFixture.items[0], id: id(3), gtin14: "04600000000015" }],
              nextCursor: null,
            }
          : itemsFixture;
      else if (path.includes("/import-sessions")) body = session;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  const { user } = renderImport();
  await user.click(
    await screen.findByRole("button", { name: "Добавить из Национального каталога" }),
  );
  await user.click(await screen.findByRole("button", { name: "Загрузить мои товары" }));
  await user.click(await screen.findByRole("checkbox", { name: /4006381333931/ }));
  await user.click(screen.getByRole("button", { name: "Следующая страница" }));
  await screen.findByRole("checkbox", { name: /4600000000015/ });
  await user.click(screen.getByRole("button", { name: "Предыдущая страница" }));
  expect(
    (await screen.findByRole("checkbox", { name: /4006381333931/ })).getAttribute("aria-checked"),
  ).toBe("true");
  expect(screen.getByText("Выбрано: 1 из 100")).toBeDefined();
});

import { act, fireEvent, waitFor } from "@testing-library/react";
import {
  importApplySchema,
  importPrepareSchema,
  importSelectionSchema,
  type ImportItem,
} from "@markiro/platform-contracts";
import { previewFixture, resultFixture } from "./national-catalog-fixtures.js";
import { identityKey, loadIntent } from "../src/pages/catalog/national-catalog/pendingIntent.js";
import { ImportReview } from "../src/pages/catalog/national-catalog/ImportReview.js";
import {
  ImportSelection,
  initialItemsQuery,
} from "../src/pages/catalog/national-catalog/ImportSelection.js";
function mockServer() {
  const state = {
    session: { ...sessionFixture, selected: 1, selectedItemIds: [id(2)] },
    preparation: structuredClone(previewFixture),
    result: structuredClone(resultFixture),
    readOnly: false,
    expired: false,
    failApply: 0,
    failPrepare: 0,
    apply403: false,
    apply409: false,
    retry409: false,
    disabled: false,
  };
  const prepares: ReturnType<typeof importPrepareSchema.parse>[] = [];
  const applies: ReturnType<typeof importApplySchema.parse>[] = [];
  const starts: unknown[] = [];
  const calls: string[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    calls.push(path);
    let body: unknown = { items: [] };
    let status = 200;
    if (path.includes("/access/me"))
      body = {
        roles: ["manager"],
        capabilities: state.readOnly
          ? ["operations.read"]
          : ["operations.read", "operations.write"],
      };
    else if (path.includes("/profile"))
      body = { firstName: "Игорь", middleName: null, lastName: "Волков", hasAvatar: false };
    else if (path.includes("/capabilities"))
      body = state.disabled
        ? {
            ownCatalog: false,
            gtinLookup: false,
            photos: false,
            connection: { state: "missing", reason: "integration_missing" },
            unavailableReason: {
              ownCatalog: "connection_unavailable",
              gtinLookup: "connection_unavailable",
              images: "connection_unavailable",
            },
          }
        : capabilitiesFixture;
    else if (path.endsWith("/selection")) {
      const b = importSelectionSchema.parse(JSON.parse(String(init?.body)));
      state.session = {
        ...state.session,
        revision: state.session.revision + 1,
        selectedItemIds: b.itemIds,
        selected: b.itemIds.length,
      };
      body = state.session;
    } else if (path.includes("/items")) body = { ...itemsFixture, nextCursor: null };
    else if (path.endsWith("/previews")) {
      const b = importPrepareSchema.parse(JSON.parse(String(init?.body)));
      prepares.push(b);
      if (state.failPrepare-- > 0) throw new TypeError("Failed to fetch");
      state.preparation = {
        ...state.preparation,
        preparation: { ...state.preparation.preparation, requestId: b.requestId },
      };
      body = state.preparation;
    } else if (path.includes("/preparations/")) body = state.preparation;
    else if (path.endsWith("/applies")) {
      const b = importApplySchema.parse(JSON.parse(String(init?.body)));
      applies.push(b);
      if (state.failApply-- > 0) throw new TypeError("Failed to fetch");
      if (state.apply403) {
        status = 403;
        body = { message: "access_changed" };
      } else if (state.apply409) {
        status = 409;
        body = { message: "preview_expired" };
      } else body = state.result;
    } else if (path.includes("/applies/") && path.endsWith("/retries") && state.retry409) {
      state.result.state = "running";
      status = 409;
      body = { message: "operation_running" };
    } else if (path.includes("/applies/")) body = state.result;
    else if (path.includes("/import-sessions")) {
      if (init?.method === "POST") starts.push(JSON.parse(String(init.body)));
      if (state.expired && init?.method !== "POST") {
        status = 410;
        body = { message: "import_session_expired" };
      } else body = state.session;
    }
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { state, prepares, applies, starts, calls, fetchMock };
}
const selectionRoute = `/catalog/import?sessionId=${id(1)}`;
const reviewRoute = `${selectionRoute}&preparationId=${id(10)}`;
const resultRoute = `${selectionRoute}&operationId=${id(20)}`;
it("starts GTIN lookup with exact text and keeps the selected session route", async () => {
  const server = mockServer();
  const { user, router } = renderImport("/catalog/import");
  await user.type(await screen.findByLabelText("Список GTIN"), "4006381333931, BAD");
  await user.click(screen.getByRole("button", { name: "Найти по GTIN" }));
  await screen.findByRole("checkbox", { name: /4006381333931/ });
  expect(server.starts).toEqual([{ mode: "gtins", text: "4006381333931, BAD" }]);
  expect(router.state.location.search).toContain(`sessionId=${id(1)}`);
});
it("replays lost prepare response after unmount with identical body/requestId", async () => {
  const server = mockServer();
  server.state.failPrepare = 1;
  let view = renderImport(selectionRoute);
  await view.user.click(await screen.findByRole("button", { name: "Сравнить выбранные товары" }));
  await screen.findByText(
    "Ответ на предыдущий запрос не получен. Восстановите его результат перед новым действием.",
  );
  view.unmount();
  view = renderImport(selectionRoute);
  await view.user.click(
    await screen.findByRole("button", { name: "Восстановить результат запроса" }),
  );
  await screen.findByLabelText("Название вручную");
  expect(server.prepares).toHaveLength(2);
  expect(server.prepares[1]).toEqual(server.prepares[0]);
  expect(loadIntent(identityKey("tenant", "user"), id(1))).toBeNull();
});
it("recovers accepted apply after lost response, expired session and temporary403 with the same body", async () => {
  const server = mockServer();
  const originalNow = Date.now();
  server.state.session.expiresAt = new Date(originalNow + 60000).toISOString();
  server.state.failApply = 1;
  let view = renderImport(reviewRoute);
  await view.user.click(
    await screen.findByRole("button", { name: "Добавить выбранные изменения" }),
  );
  await screen.findByRole("button", { name: "Восстановить результат запроса" });
  const intent = loadIntent(identityKey("tenant", "user"), id(1));
  expect(intent?.kind).toBe("apply");
  view.unmount();
  server.state.expired = true;
  vi.spyOn(Date, "now").mockReturnValue(originalNow + 120000);
  server.state.apply403 = true;
  view = renderImport(reviewRoute);
  await view.user.click(
    await screen.findByRole("button", { name: "Восстановить результат запроса" }),
  );
  await screen.findByText(
    "Проверьте вход, права на изменение и подписку. Сохранённый запрос можно повторить после восстановления доступа.",
  );
  expect(loadIntent(identityKey("tenant", "user"), id(1))).toEqual(intent);
  view.unmount();
  server.state.apply403 = false;
  view = renderImport(reviewRoute);
  await view.user.click(
    await screen.findByRole("button", { name: "Восстановить результат запроса" }),
  );
  await screen.findByText("Товар добавлен. Фото не загрузилось.");
  expect(server.applies).toHaveLength(3);
  expect(server.applies.every((b) => JSON.stringify(b) === JSON.stringify(server.applies[0]))).toBe(
    true,
  );
  expect(view.router.state.location.search).toContain(`operationId=${id(20)}`);
  expect(loadIntent(identityKey("tenant", "user"), id(1))).toBeNull();
});
it("preserves pending apply through navigating away and reopening", async () => {
  const server = mockServer();
  server.state.failApply = 1;
  const view = renderImport(reviewRoute);
  await view.user.click(
    await screen.findByRole("button", { name: "Добавить выбранные изменения" }),
  );
  await screen.findByRole("button", { name: "Восстановить результат запроса" });
  await view.user.click(screen.getByRole("button", { name: "Закрыть" }));
  await act(() => view.router.navigate(reviewRoute));
  await view.user.click(
    await screen.findByRole("button", { name: "Восстановить результат запроса" }),
  );
  await screen.findByText("Товар добавлен. Фото не загрузилось.");
  expect(server.applies[1]).toEqual(server.applies[0]);
});
it("never sends a canonical request when browser persistence is unavailable", async () => {
  const server = mockServer();
  const view = renderImport(reviewRoute);
  await screen.findByLabelText("Название вручную");
  const setter = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("QuotaExceededError");
  });
  await view.user.click(screen.getByRole("button", { name: "Добавить выбранные изменения" }));
  await screen.findByText(/Не удалось сохранить запрос/);
  expect(server.applies).toHaveLength(0);
  setter.mockRestore();
});
it("reads a retained receipt with no write, connection or feature availability, without session/provider work", async () => {
  const server = mockServer();
  server.state.readOnly = true;
  server.state.disabled = true;
  server.state.expired = true;
  renderImport(resultRoute);
  await screen.findByText("Товар добавлен. Фото не загрузилось.");
  expect(screen.queryByRole("button", { name: "Повторить загрузку фото" })).toBeNull();
  expect(
    server.calls.some(
      (path) => path.includes("/items") || path.endsWith(`/import-sessions/${id(1)}`),
    ),
  ).toBe(false);
  expect(server.applies).toHaveLength(0);
});
it("does not offer parallel manual retries while the result is running with an image failure", async () => {
  const server = mockServer();
  server.state.result.state = "running";
  renderImport(resultRoute);
  await screen.findByText("Добавление продолжается");
  expect(screen.queryByRole("button", { name: "Повторить загрузку фото" })).toBeNull();
  expect(screen.getByRole("button", { name: "Остановить дальнейшее добавление" })).toBeDefined();
});
it("preserves catalogue filters on keyboard close", async () => {
  mockServer();
  const { user, router } = renderImport();
  await user.type(await screen.findByLabelText("Поиск"), "milk");
  await user.click(screen.getByRole("button", { name: "Добавить из Национального каталога" }));
  await screen.findByRole("dialog", { name: "Национальный каталог" });
  await user.keyboard("{Escape}");
  await waitFor(() => expect(router.state.location.pathname).toBe("/catalog"));
  expect((screen.getByLabelText("Поиск") as HTMLInputElement).value).toBe("milk");
});
it("rejects the101st selection atomically and keeps archived and invalid rows nonselectable", async () => {
  const onSelection = vi.fn();
  const row: ImportItem = { ...itemsFixture.items[0]!, id: id(500) };
  const selected = Array.from({ length: 100 }, (_, i) => id(100 + i));
  render(
    <ImportSelection
      session={{ ...sessionFixture, selected: 100, selectedItemIds: selected }}
      data={{
        items: [
          row,
          { ...row, id: id(501), statusKeys: ["archived"] },
          { ...row, id: id(502), match: "invalid", gtin14: null, input: "BAD", selectable: false },
        ],
        nextCursor: null,
      }}
      query={initialItemsQuery}
      onQuery={vi.fn()}
      onSelection={onSelection}
      onPrepare={vi.fn()}
      canWrite
      busy={false}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getAllByRole("checkbox", { name: /4006381333931/ })[0]!);
  expect(onSelection).not.toHaveBeenCalled();
  expect(screen.getByText(/Можно выбрать не больше 100/)).toBeDefined();
  expect(
    screen.getAllByRole("checkbox", { name: /4006381333931/ })[1]?.hasAttribute("disabled"),
  ).toBe(true);
  expect(screen.getByRole("checkbox", { name: /BAD/ }).hasAttribute("disabled")).toBe(true);
});
it("preserves manual name, field toggles, explicit keep and replacement confirmation when polling returns READY photos", async () => {
  const data = structuredClone(previewFixture);
  const p = data.items[0]!;
  p.productId = id(21);
  p.linkAction = "replace";
  p.photos = [
    {
      candidateId: id(30),
      state: "pending",
      previewPath: null,
      primary: true,
      selectedByDefault: true,
      reason: null,
    },
  ];
  const apply = vi.fn();
  const prepare = vi.fn();
  const props = {
    sessionId: id(1),
    data,
    canWrite: true,
    busy: false,
    onPrepare: prepare,
    onApply: apply,
    onPhoto: vi.fn(),
    onRetry: vi.fn(),
  };
  const view = render(<ImportReview {...props} />, { wrapper: MemoryRouter });
  const user = userEvent.setup();
  await user.click(screen.getByRole("checkbox", { name: "Название товара" }));
  await user.click(screen.getByRole("checkbox", { name: /Подтверждаю замену/ }));
  await user.click(screen.getByRole("button", { name: "Сохранить текущее фото" }));
  const ready = structuredClone(data);
  ready.items[0]!.photos[0]!.state = "ready";
  view.rerender(<ImportReview {...props} data={ready} />);
  expect(
    screen.getByRole("checkbox", { name: "Название товара" }).getAttribute("aria-checked"),
  ).toBe("true");
  expect(
    screen.getByRole("checkbox", { name: /Подтверждаю замену/ }).getAttribute("aria-checked"),
  ).toBe("true");
  await user.click(screen.getByRole("button", { name: "Добавить выбранные изменения" }));
  expect(apply).toHaveBeenCalledWith([
    {
      previewId: id(12),
      acceptedEntryIds: [id(13)],
      linkAction: "replace",
      photo: { kind: "keep" },
    },
  ]);
  await user.type(screen.getByLabelText("Название вручную"), "Моё название");
  view.rerender(<ImportReview {...props} data={structuredClone(ready)} />);
  expect((screen.getByLabelText("Название вручную") as HTMLInputElement).value).toBe(
    "Моё название",
  );
  await user.click(screen.getByRole("button", { name: "Обновить сравнение" }));
  expect(prepare).toHaveBeenCalledWith({
    manualNames: { [id(2)]: "Моё название" },
    categoryChoices: {},
  });
});
it("records keep.reviewedCandidateId only after explicitly viewing a READY candidate and choosing keep", async () => {
  const data = structuredClone(previewFixture);
  data.items[0]!.productId = id(21);
  data.items[0]!.photos = [
    {
      candidateId: id(30),
      state: "ready",
      previewPath: "/untrusted",
      primary: true,
      selectedByDefault: true,
      reason: null,
    },
  ];
  const apply = vi.fn();
  render(
    <ImportReview
      sessionId={id(1)}
      data={data}
      canWrite
      busy={false}
      onPrepare={vi.fn()}
      onApply={apply}
      onPhoto={vi.fn()}
      onRetry={vi.fn()}
    />,
    { wrapper: MemoryRouter },
  );
  const user = userEvent.setup();
  expect(screen.queryByRole("img")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Просмотреть фото" }));
  const image = screen.getByRole("img", { name: "Подготовленное фото товара" });
  expect(image.getAttribute("src")).toBe(
    `/api/national-catalog/import-sessions/${id(1)}/images/${id(30)}`,
  );
  fireEvent.load(image);
  await user.click(screen.getByRole("button", { name: "Сохранить текущее фото" }));
  await user.click(screen.getByRole("button", { name: "Добавить выбранные изменения" }));
  expect(apply.mock.calls[0]?.[0][0].photo).toEqual({ kind: "keep", reviewedCandidateId: id(30) });
});

it("requires category acceptance for dependent fields, while independent fields remain selected", async () => {
  const data = structuredClone(previewFixture);
  data.items[0]!.fields.push(
    { ...data.items[0]!.fields[0]!, id: id(40), label: "Категория", requiresEntryIds: [] },
    { ...data.items[0]!.fields[0]!, id: id(41), label: "Объём", requiresEntryIds: [id(40)] },
  );
  render(
    <ImportReview
      sessionId={id(1)}
      data={data}
      canWrite
      busy={false}
      onPrepare={vi.fn()}
      onApply={vi.fn()}
      onPhoto={vi.fn()}
      onRetry={vi.fn()}
    />,
    { wrapper: MemoryRouter },
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("checkbox", { name: "Категория" }));
  expect(screen.getByRole("checkbox", { name: "Объём" }).getAttribute("aria-checked")).toBe(
    "false",
  );
  expect(screen.getByRole("checkbox", { name: "Объём" }).hasAttribute("disabled")).toBe(true);
  expect(
    screen.getByRole("checkbox", { name: "Название товара" }).getAttribute("aria-checked"),
  ).toBe("true");
  await user.click(screen.getByRole("checkbox", { name: "Категория" }));
  expect(screen.getByRole("checkbox", { name: "Объём" }).hasAttribute("disabled")).toBe(false);
  expect(screen.getByRole("checkbox", { name: "Объём" }).getAttribute("aria-checked")).toBe(
    "false",
  );
});
it("prepares a fresh request for manual names and initial category; restores selected category and manual override after reload", async () => {
  const server = mockServer();
  const p = server.state.preparation.items[0]!;
  p.fields[0]!.source = "manual";
  p.fields[0]!.after = "Моё название";
  p.categoryOptions = [{ optionId: id(40), label: "Молочная продукция", selected: true }];
  const view = renderImport(reviewRoute);
  await waitFor(() =>
    expect((screen.getByLabelText("Название вручную") as HTMLInputElement).value).toBe(
      "Моё название",
    ),
  );
  await view.user.selectOptions(screen.getByLabelText("Начальная категория"), "");
  await waitFor(() => expect(server.prepares).toHaveLength(1));
  expect(server.prepares[0]?.manualNames).toEqual([{ itemId: id(2), name: "Моё название" }]);
  expect(server.prepares[0]?.categoryChoices).toEqual([]);
  expect(server.prepares[0]?.requestId).not.toBe(previewFixture.preparation.requestId);
});
it("allows blank draft name repair, caps manual override at200 and blocks apply until recompare", async () => {
  const data = structuredClone(previewFixture);
  data.items[0]!.fields = [];
  data.items[0]!.canApply = false;
  data.items[0]!.reason = "name_required";
  const prepare = vi.fn();
  render(
    <ImportReview
      sessionId={id(1)}
      data={data}
      canWrite
      busy={false}
      onPrepare={prepare}
      onApply={vi.fn()}
      onPhoto={vi.fn()}
      onRetry={vi.fn()}
    />,
  );
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Название вручную"), "x".repeat(201));
  expect((screen.getByLabelText("Название вручную") as HTMLInputElement).value).toHaveLength(200);
  expect(
    screen.getByRole("button", { name: "Добавить выбранные изменения" }).hasAttribute("disabled"),
  ).toBe(true);
  await user.click(screen.getByRole("button", { name: "Обновить сравнение" }));
  expect(prepare.mock.calls[0]?.[0].manualNames[id(2)]).toHaveLength(200);
});
it("blocks apply until explicit replacement and supports link-only preserving existing fields and photo", async () => {
  const data = structuredClone(previewFixture);
  data.items[0]!.productId = id(21);
  data.items[0]!.linkAction = "replace";
  const apply = vi.fn();
  render(
    <ImportReview
      sessionId={id(1)}
      data={data}
      canWrite
      busy={false}
      onPrepare={vi.fn()}
      onApply={apply}
      onPhoto={vi.fn()}
      onRetry={vi.fn()}
    />,
    { wrapper: MemoryRouter },
  );
  const user = userEvent.setup();
  expect(
    screen.getByRole("button", { name: "Добавить выбранные изменения" }).hasAttribute("disabled"),
  ).toBe(true);
  await user.click(screen.getByRole("checkbox", { name: "Название товара" }));
  await user.click(screen.getByRole("button", { name: "Добавить связь без изменения полей" }));
  await user.click(screen.getByRole("checkbox", { name: /Подтверждаю замену/ }));
  await user.click(screen.getByRole("button", { name: "Добавить выбранные изменения" }));
  expect(apply).toHaveBeenCalledWith([
    { previewId: id(12), acceptedEntryIds: [], linkAction: "replace", photo: { kind: "keep" } },
  ]);
});
it("does not silently reapply a409 stale comparison and refreshes with a new prepare requestId", async () => {
  const server = mockServer();
  server.state.apply409 = true;
  const view = renderImport(reviewRoute);
  await view.user.click(
    await screen.findByRole("button", { name: "Добавить выбранные изменения" }),
  );
  await screen.findByText(
    "Данные изменились. Проверьте позиции и обновите сравнение перед применением.",
  );
  expect(server.applies).toHaveLength(1);
  await view.user.click(screen.getByRole("button", { name: "Обновить сравнение" }));
  await waitFor(() => expect(server.prepares).toHaveLength(1));
  expect(server.prepares[0]?.requestId).not.toBe(id(11));
});

it("shows pinned GTIN/name and existing-link context on saved comparison without enumerating items", async () => {
  const server = mockServer();
  server.state.preparation.items[0]!.productId = id(21);
  server.state.preparation.items[0]!.linkAction = "keep";
  server.state.preparation.items[0]!.fields = [];
  renderImport(reviewRoute);
  await screen.findByText("04006381333931 · Молоко");
  expect(screen.getByText("Связь уже есть")).toBeDefined();
  expect(server.calls.some((path) => path.includes("/items"))).toBe(false);
});
it("preserves choices across a real focused preparation poll", async () => {
  const server = mockServer();
  const p = server.state.preparation.items[0]!;
  p.productId = id(21);
  p.linkAction = "replace";
  p.photos = [
    {
      candidateId: id(30),
      state: "pending",
      previewPath: null,
      primary: true,
      selectedByDefault: true,
      reason: null,
    },
  ];
  const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const { user } = renderImport(reviewRoute);
  await user.click(await screen.findByRole("checkbox", { name: "Название товара" }));
  await user.type(screen.getByLabelText("Название вручную"), "Моё название");
  await user.click(screen.getByRole("checkbox", { name: /Подтверждаю замену/ }));
  await user.click(screen.getByRole("button", { name: "Сохранить текущее фото" }));
  p.photos[0]!.state = "ready";
  await screen.findByRole("button", { name: "Просмотреть фото" }, { timeout: 4000 });
  expect(server.calls.filter((path) => path.includes("/preparations/")).length).toBeGreaterThan(1);
  expect((screen.getByLabelText("Название вручную") as HTMLInputElement).value).toBe(
    "Моё название",
  );
  expect(
    screen.getByRole("checkbox", { name: "Название товара" }).getAttribute("aria-checked"),
  ).toBe("true");
  expect(
    screen.getByRole("checkbox", { name: /Подтверждаю замену/ }).getAttribute("aria-checked"),
  ).toBe("true");
  expect(
    screen.getByRole("button", { name: "Сохранить текущее фото" }).getAttribute("aria-pressed"),
  ).toBe("true");
  focus.mockRestore();
});
it("allows explicit foreign-GTIN READY alternative with a warning and never selects it by default", async () => {
  const data = structuredClone(previewFixture);
  data.items[0]!.photos = [
    {
      candidateId: id(30),
      state: "ready",
      previewPath: "/unsafe",
      primary: true,
      selectedByDefault: true,
      reason: "barcode_mismatch",
    },
  ];
  const apply = vi.fn();
  render(
    <ImportReview
      sessionId={id(1)}
      data={data}
      canWrite
      busy={false}
      onPrepare={vi.fn()}
      onApply={apply}
      onPhoto={vi.fn()}
      onRetry={vi.fn()}
    />,
  );
  const user = userEvent.setup();
  expect(screen.getByText(/GTIN фотографии отличается/)).toBeDefined();
  expect(screen.getByRole("button", { name: "Без фото" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  await user.click(screen.getByRole("button", { name: "Выбрать это фото" }));
  await user.click(screen.getByRole("button", { name: "Добавить выбранные изменения" }));
  expect(apply.mock.calls[0]?.[0][0].photo).toEqual({ kind: "candidate", candidateId: id(30) });
});

it("clears owned intents after a settled tenant switch even with the panel closed and preserves other app storage", async () => {
  const server = mockServer();
  server.state.failApply = 1;
  const view = renderImport(reviewRoute);
  await view.user.click(
    await screen.findByRole("button", { name: "Добавить выбранные изменения" }),
  );
  await screen.findByRole("button", { name: "Восстановить результат запроса" });
  await view.user.click(screen.getByRole("button", { name: "Закрыть" }));
  expect(loadIntent(identityKey("tenant", "user"), id(1))).not.toBeNull();
  sessionStorage.setItem("unrelated", "keep");
  testSession = {
    ...defaultSession,
    data: { ...defaultSession.data, session: { activeOrganizationId: "other" } },
  };
  view.refresh();
  await screen.findByRole("button", { name: "Добавить из Национального каталога" });
  await waitFor(() => expect(loadIntent(identityKey("tenant", "user"), id(1))).toBeNull());
  expect(sessionStorage.getItem("unrelated")).toBe("keep");
  expect(view.router.state.location.pathname).toBe("/catalog");
});
it("preserves a same-owner pending intent through transient session refresh and StrictMode remount", async () => {
  const server = mockServer();
  server.state.failApply = 1;
  const view = renderImport(reviewRoute);
  await view.user.click(
    await screen.findByRole("button", { name: "Добавить выбранные изменения" }),
  );
  await screen.findByRole("button", { name: "Восстановить результат запроса" });
  const intent = loadIntent(identityKey("tenant", "user"), id(1));
  testSession = { ...defaultSession, isPending: true };
  view.refresh();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(loadIntent(identityKey("tenant", "user"), id(1))).toEqual(intent);
  testSession = defaultSession;
  view.refresh();
  await view.user.click(
    await screen.findByRole("button", { name: "Восстановить результат запроса" }),
  );
  await screen.findByText("Товар добавлен. Фото не загрузилось.");
  expect(server.applies[1]).toEqual(server.applies[0]);
});
it("does not strand an initial saved route when all browser storage writes are blocked", async () => {
  mockServer();
  const setter = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  renderImport(reviewRoute);
  await screen.findByText("04006381333931 · Молоко");
  expect(screen.getByRole("dialog", { name: "Национальный каталог" })).toBeDefined();
  setter.mockRestore();
});

it("clears carried route IDs on a known identity switch even when owner storage cannot be written", async () => {
  const server = mockServer();
  const setter = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  const view = renderImport(reviewRoute);
  await screen.findByText("04006381333931 · Молоко");
  const reads = server.calls.filter((path) => path.includes("/preparations/")).length;
  testSession = {
    ...defaultSession,
    data: { ...defaultSession.data, session: { activeOrganizationId: "other" } },
  };
  view.refresh();
  await screen.findByRole("button", { name: "Загрузить мои товары" });
  expect(view.router.state.location.search).toBe("");
  expect(server.calls.filter((path) => path.includes("/preparations/"))).toHaveLength(reads);
  setter.mockRestore();
});

it("refreshes running operation after retry409 and permits retry only after subsequent finished receipt", async () => {
  const server = mockServer();
  server.state.retry409 = true;
  const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const { user } = renderImport(resultRoute);
  await user.click(await screen.findByRole("button", { name: "Повторить загрузку фото" }));
  await screen.findByText("Добавление продолжается");
  expect(screen.queryByRole("button", { name: "Повторить загрузку фото" })).toBeNull();
  server.state.result.state = "finished";
  await screen.findByRole("button", { name: "Повторить загрузку фото" }, { timeout: 4000 });
  focus.mockRestore();
});
it("stops interval and focus refetch after410 for an expired session", async () => {
  const server = mockServer();
  server.state.expired = true;
  server.state.session.state = "loading";
  const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  renderImport(selectionRoute);
  await screen.findByText(
    "Срок сессии истёк. Сохранённый результат принятой операции остаётся доступен.",
  );
  const before = server.calls.filter((path) => path.endsWith(`/import-sessions/${id(1)}`)).length;
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(server.calls.filter((path) => path.endsWith(`/import-sessions/${id(1)}`))).toHaveLength(
    before,
  );
  focus.mockRestore();
});

it("returns from selection to the saved running receipt without losing its operation route or creating another request", async () => {
  const server = mockServer();
  server.state.result.state = "running";
  const { user, router } = renderImport(resultRoute);
  await screen.findByText("Добавление продолжается");
  await user.click(screen.getByRole("button", { name: "Выбор товаров" }));
  await screen.findByRole("checkbox", { name: /4006381333931/ });
  expect(router.state.location.search).toContain(`operationId=${id(20)}`);
  await user.click(screen.getByRole("button", { name: "Результат" }));
  await screen.findByText("Добавление продолжается");
  expect(server.applies).toHaveLength(0);
});
