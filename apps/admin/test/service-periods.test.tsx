import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "../src/i18n/index.js";
import { ServicePeriodDetailPage } from "../src/pages/billing/ServicePeriodDetailPage.js";
import { ServicePeriodsPage } from "../src/pages/billing/ServicePeriodsPage.js";

const IDs = {
  active: "11111111-1111-4111-8111-111111111111",
  upcoming: "22222222-2222-4222-8222-222222222222",
  expired: "33333333-3333-4333-8333-333333333333",
  exhausted: "44444444-4444-4444-8444-444444444444",
  approved: "55555555-5555-4555-8555-555555555555",
  ordered: "66666666-6666-4666-8666-666666666666",
  catalog: "77777777-7777-4777-8777-777777777777",
  version: "88888888-8888-4888-8888-888888888888",
  usage: "99999999-9999-4999-8999-999999999999",
  correction: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  defect: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
} as const;

const basePeriod = {
  orderedServiceId: IDs.ordered,
  catalogItemId: IDs.catalog,
  catalogVersionId: IDs.version,
  nameRu: "Сервисное сопровождение",
  nameEn: "Service support",
  startsAt: "2026-09-01T00:00:00.000Z",
  endsAt: "2026-10-01T00:00:00.000Z",
  revision: 3,
};

const periods = [
  {
    ...basePeriod,
    id: IDs.active,
    state: "active",
    balance: { included: 180, externallyApproved: 0, consumed: 45, remaining: 135 },
  },
  {
    ...basePeriod,
    id: IDs.upcoming,
    nameRu: "Предстоящая поддержка",
    nameEn: "Upcoming support",
    state: "upcoming",
    balance: { included: 60, externallyApproved: 0, consumed: 0, remaining: 60 },
  },
  {
    ...basePeriod,
    id: IDs.expired,
    nameRu: "Завершённая поддержка",
    nameEn: "Expired support",
    state: "expired",
    balance: { included: 90, externallyApproved: 0, consumed: 30, remaining: 60 },
  },
  {
    ...basePeriod,
    id: IDs.exhausted,
    nameRu: "Исчерпанный пакет",
    nameEn: "Exhausted package",
    state: "active",
    balance: { included: 30, externallyApproved: 0, consumed: 30, remaining: 0 },
  },
  {
    ...basePeriod,
    id: IDs.approved,
    nameRu: "Расширенная поддержка",
    nameEn: "Extended support",
    state: "active",
    balance: { included: 60, externallyApproved: 30, consumed: 20, remaining: 70 },
  },
] as const;

const detail = {
  ...periods[0],
  entries: [
    {
      id: IDs.usage,
      kind: "usage",
      classification: "customer_service",
      originalEntryId: null,
      workReference: "SUP-42",
      description: "Настройка линии",
      performedAt: "2026-09-10T08:00:00.000Z",
      postedAt: "2026-09-12T09:30:00.000Z",
      actualMinutesDelta: 50,
      allowanceMinutesDelta: 50,
    },
    {
      id: IDs.correction,
      kind: "correction",
      classification: "customer_service",
      originalEntryId: IDs.usage,
      workReference: "SUP-42",
      description: "Уточнение продолжительности",
      performedAt: "2026-09-10T08:00:00.000Z",
      postedAt: "2026-09-13T10:00:00.000Z",
      actualMinutesDelta: -5,
      allowanceMinutesDelta: -5,
    },
    {
      id: IDs.defect,
      kind: "usage",
      classification: "product_defect",
      originalEntryId: null,
      workReference: "BUG-7",
      description: "Исправление дефекта",
      performedAt: "2026-09-14T08:00:00.000Z",
      postedAt: "2026-09-14T08:30:00.000Z",
      actualMinutesDelta: 30,
      allowanceMinutesDelta: 0,
    },
  ],
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderRoute(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      { path: "/billing/services", element: <ServicePeriodsPage /> },
      { path: "/billing/services/:periodId", element: <ServicePeriodDetailPage /> },
    ],
    { initialEntries: [path] },
  );
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("ru");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/billing/service-periods?"))
        return response({ items: periods, nextCursor: null });
      if (url.endsWith(`/api/billing/service-periods/${IDs.active}`)) return response(detail);
      return response({ code: "not_found" }, 404);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("tenant service periods", () => {
  it("renders active, upcoming, expired, exhausted and externally approved periods", async () => {
    renderRoute("/billing/services");

    const active = await screen.findByRole("article", { name: "Сервисное сопровождение" });
    expect(within(active).getByText("180 мин включено")).toBeDefined();
    expect(within(active).getByText("45 мин использовано")).toBeDefined();
    expect(within(active).getByText("135 мин осталось")).toBeDefined();
    expect(screen.getByText("Предстоящая поддержка")).toBeDefined();
    expect(screen.getByText("Завершённая поддержка")).toBeDefined();
    expect(screen.getByText("Исчерпанный пакет")).toBeDefined();
    expect(screen.getByText("30 мин согласовано дополнительно")).toBeDefined();
    expect(screen.getByText("Пакет исчерпан")).toBeDefined();
    expect(screen.queryByRole("link", { name: /купить|увеличить|перейти/i })).toBeNull();
  });

  it("renders customer-safe work history and nests corrections under their original entry", async () => {
    renderRoute(`/billing/services/${IDs.active}`);

    expect(await screen.findByRole("heading", { name: "Сервисное сопровождение" })).toBeDefined();
    const usage = screen.getByRole("listitem", { name: /SUP-42/ });
    expect(within(usage).getByText("Настройка линии")).toBeDefined();
    expect(within(usage).getByText("Уточнение продолжительности")).toBeDefined();
    expect(within(usage).getByText(/Выполнено/)).toBeDefined();
    expect(within(usage).getAllByText(/Проведено/)).toHaveLength(2);
    expect(screen.getByText("Не списывается из пакета")).toBeDefined();
    expect(screen.queryByText("Диагностика завершена")).toBeNull();
  });

  it("localizes service cards and the empty state", async () => {
    await i18n.changeLanguage("en");
    renderRoute("/billing/services");
    expect(await screen.findByText("Service support")).toBeDefined();
    expect(screen.getByText("180 min included")).toBeDefined();
  });

  it("renders recoverable error and empty states", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ items: [], nextCursor: null })));
    const empty = renderRoute("/billing/services");
    expect(await screen.findByText("Сервисных пакетов пока нет")).toBeDefined();
    empty.unmount();

    vi.stubGlobal("fetch", vi.fn(async () => response({ code: "temporarily_unavailable" }, 503)));
    renderRoute("/billing/services");
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Не удалось загрузить сервисные пакеты.",
    );
    expect(screen.getByRole("button", { name: "Повторить" })).toBeDefined();
  });
});
