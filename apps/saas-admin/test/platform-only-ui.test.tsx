import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

vi.hoisted(() => vi.stubEnv("VITE_SERVER_PROFILE", "platform-only"));

import { DIAG_OVERVIEW } from "./diagnostics-fixtures.js";

import {
  installCatalogApi,
  installTenantApi,
  jsonResponse,
  PLATFORM_ADMIN_ME,
  renderSaasApp,
  TENANT_DETAIL,
  TENANT_ID,
} from "./render.js";

const offlineDetail = {
  ...structuredClone(TENANT_DETAIL),
  tenant: { ...TENANT_DETAIL.tenant, cabinetAccess: "none" },
  ownerActivation: null,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("creates only a cabinet-free tenant without an owner email", async () => {
  const api = installTenantApi({ detail: offlineDetail });
  renderSaasApp({ initialEntry: "/tenants/new" });
  const user = userEvent.setup();
  await screen.findByRole("heading", { name: "Новый тенант" });
  expect(screen.queryByRole("checkbox", { name: "Доступ в кабинет" })).toBeNull();
  expect(screen.queryByLabelText("Email владельца")).toBeNull();
  expect(screen.queryByText(/Лицензии недоступны, только услуги/)).toBeNull();
  await user.type(screen.getByLabelText("Название"), "Первый завод");
  await user.type(screen.getByLabelText("Slug"), "first-factory");
  await user.click(screen.getByRole("button", { name: "Создать тенант без кабинета" }));
  await screen.findByRole("heading", { name: "Первый завод" });
  expect(api.mutationCalls()).toEqual([
    {
      method: "POST",
      path: "/api/platform/tenants",
      body: { tenantName: "Первый завод", tenantSlug: "first-factory", cabinetAccess: "none" },
    },
  ]);
});

it.each([
  { ...TENANT_DETAIL, ownerActivation: { ...TENANT_DETAIL.ownerActivation, emailVerified: false } },
  offlineDetail,
])("hides cabinet grant and renewal for saved tenants %#", async (detail) => {
  installTenantApi({ detail });
  renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}` });
  await screen.findByRole("heading", { name: "Первый завод" });
  expect(screen.queryByRole("button", { name: "Выдать доступ в кабинет" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Отправить активацию повторно" })).toBeNull();
  expect(screen.getByText(/Облачный кабинет выведен из эксплуатации/)).toBeDefined();
  expect(screen.getByRole("link", { name: "Создать счёт" })).toBeDefined();
});

it("keeps commercial catalog editing without cloud Station grant controls", async () => {
  installCatalogApi({ me: PLATFORM_ADMIN_ME });
  renderSaasApp({ initialEntry: "/catalog" });
  await screen.findByRole("button", { name: "Создать позицию" });
  expect(screen.queryByRole("button", { name: "Офлайн-политики" })).toBeNull();
  expect(screen.getByText(/Облачные разрешения Station выведены из эксплуатации/)).toBeDefined();
  expect(
    vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("lifecycle-policies")),
  ).toBe(false);
});

it("makes the National Catalog direct route unavailable without loading it", async () => {
  const requested: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith("/api/platform/me")) return jsonResponse(200, PLATFORM_ADMIN_ME);
      throw new Error(`Unexpected fetch ${url}`);
    }),
  );
  renderSaasApp({ initialEntry: "/national-catalog" });
  expect(await screen.findByText(/Национальный каталог недоступен в этом профиле/)).toBeDefined();
  expect(screen.queryByRole("link", { name: /Национальный каталог/ })).toBeNull();
  expect(requested.some((url) => url.includes("national-catalog"))).toBe(false);
});

it("reads historical support and retries transcript sync without offering new proposals", async () => {
  const id = "00000000-0000-4000-8000-000000000601";
  const episode = {
    id,
    messages: [
      {
        id: "00000000-0000-4000-8000-000000000602",
        direction: "customer",
        text: "Сохранённое сообщение",
        occurredAt: "2026-10-06T10:00:00.000Z",
        delivery: "sent",
      },
    ],
    nextCursor: null,
    proposal: {
      id: "00000000-0000-4000-8000-000000000604",
      revision: 1,
      title: "Старое предложение",
      summary: "Сохранённое описание",
      noticeVersion: "support-transcript-v1",
      state: "pending",
    },
    request: null,
    sync: { state: "error", lastSyncedAt: null, errorCode: "sync_failed" },
  };
  const posts: Array<{ path: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/platform/me")) return jsonResponse(200, PLATFORM_ADMIN_ME);
      if (url.endsWith(`/api/platform/support-chat/episodes/${id}`))
        return jsonResponse(200, episode);
      if (
        url.endsWith(`/api/platform/support-chat/episodes/${id}/retry-sync`) &&
        init?.method === "POST"
      ) {
        posts.push({ path: url, body: JSON.parse(String(init.body)) });
        return jsonResponse(200, {
          ...episode,
          sync: { state: "pending", lastSyncedAt: null, errorCode: null },
        });
      }
      throw new Error(`Unexpected fetch ${url}`);
    }),
  );
  renderSaasApp({ initialEntry: `/support/${id}` });
  expect(await screen.findByText("Сохранённое сообщение")).toBeDefined();
  expect(screen.getByRole("heading", { name: "Старое предложение" })).toBeDefined();
  expect(screen.queryByRole("textbox", { name: "Заголовок обращения" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Повторить синхронизацию" }));
  expect(await screen.findByText(/синхронизируется/)).toBeDefined();
  expect(posts).toEqual([
    { path: `/api/platform/support-chat/episodes/${id}/retry-sync`, body: {} },
  ]);
  expect(screen.queryByRole("textbox", { name: "Заголовок обращения" })).toBeNull();
});

it("labels saved cloud usage as historical while preserving its figures", async () => {
  installTenantApi();
  renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}` });
  await screen.findByRole("heading", { name: "Первый завод" });
  expect(await screen.findByText(/Облачные показатели являются историческими/)).toBeDefined();
  expect(await screen.findByText("17 / 20")).toBeDefined();
  expect(screen.getByText(/Использование на:/)).toBeDefined();
});

it("keeps standalone sites without requesting the retired cloud device pool", async () => {
  installTenantApi();
  const original = vi.mocked(fetch);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/standalone-sites"))
        return jsonResponse(200, {
          tenantId: TENANT_ID,
          issuanceSource: "offline_assignments",
          items: [],
        });
      return original(input, init);
    }),
  );
  renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}?tab=equipment` });
  expect(
    await screen.findByRole("heading", { name: "Автоном: площадки и офлайн-лицензии" }),
  ).toBeDefined();
  expect(
    screen.getByText(/Облачное управление устройствами выведено из эксплуатации/),
  ).toBeDefined();
  expect(
    vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("device-licensing")),
  ).toBe(false);
});

it.each([true, false])(
  "preserves the independent standalone report source, time and unknown state: report=%s",
  async (hasReport) => {
    installTenantApi();
    const original = vi.mocked(fetch);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/standalone-diagnostics/overview"))
          return jsonResponse(200, hasReport ? DIAG_OVERVIEW : { ...DIAG_OVERVIEW, hosts: [] });
        if (url.endsWith("/standalone-diagnostics/statistics"))
          return jsonResponse(200, { hosts: [], multipleHosts: false, months: [] });
        if (url.endsWith("/standalone-diagnostics"))
          return jsonResponse(200, { items: [], nextCursor: null });
        return original(input, init);
      }),
    );
    renderSaasApp({ initialEntry: `/tenants/${TENANT_ID}?tab=diagnostics` });
    if (hasReport) {
      expect(await screen.findByText("Цех розлива")).toBeDefined();
      expect(screen.getByText("3f1c2d4e")).toBeDefined();
      expect(screen.getByText(/15 окт. 2026/)).toBeDefined();
      expect(screen.getByText(/4 из 3/)).toBeDefined();
    } else {
      expect(await screen.findByText(/Отчётов пока нет. Вставьте текст/)).toBeDefined();
      expect(screen.queryByText(/4 из 3/)).toBeNull();
    }
    expect(screen.queryByText(/Облачные показатели являются историческими/)).toBeNull();
  },
);

it("identifies production reports as historical without relabeling commercial reporting", async () => {
  installTenantApi();
  const original = vi.mocked(fetch);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/platform/reports?"))
        return jsonResponse(200, { items: [], nextOffset: null });
      return original(input, init);
    }),
  );
  renderSaasApp({ initialEntry: "/reports" });
  expect(
    await screen.findByText(/Производственные отчёты содержат исторические облачные данные/),
  ).toBeDefined();
  expect(screen.getByRole("button", { name: "Сформировать отчёт" })).toBeDefined();
});
