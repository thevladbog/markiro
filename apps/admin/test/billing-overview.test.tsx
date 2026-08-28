import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";
import { ThemeProvider } from "@markiro/ui";

import { AccessProvider } from "../src/access/context.js";
import { BillingOverviewPage } from "../src/pages/billing/BillingOverviewPage.js";
import { useBillingOverview } from "../src/pages/billing/api.js";
import { formatBillingDate, formatMoney } from "../src/pages/billing/format.js";

vi.mock("../src/pages/billing/api.js", () => ({
  useBillingOverview: vi.fn(),
}));

const UUID = "00000000-0000-4000-8000-000000000001";

const overview = {
  access: "managed",
  subscription: {
    id: UUID,
    planVersionId: UUID,
    status: "active",
    startsAt: "2026-08-01T00:00:00.000Z",
    endsAt: "2026-09-01T00:00:00.000Z",
    planName: "Профи",
    billingPeriod: "month",
    price: "48000.00",
  },
  scheduledSubscription: null,
  limits: {
    lines: 2,
    stations: 3,
    kiosks: 2,
    cabinetUsers: 5,
    labelEditor: true,
    publicApi: false,
    pallets: false,
  },
  usage: { lines: 2, stations: 1, kiosks: 0, cabinetUsers: 4 },
  limitPresentation: {
    lines: { used: 2, assigned: 2, remaining: 0, state: "reached" },
    stations: { used: 1, assigned: 3, remaining: 2, state: "normal" },
    kiosks: { used: 0, assigned: 2, remaining: 2, state: "normal" },
    cabinetUsers: { used: 4, assigned: 5, remaining: 1, state: "approaching" },
  },
  addons: [],
  services: [],
  actionableOffer: {
    id: "00000000-0000-4000-8000-000000000002",
    number: "КП-17",
    total: "12000.00",
  },
  recentOperations: [
    {
      id: "00000000-0000-4000-8000-000000000003",
      kind: "invoice",
      status: "issued",
      occurredAt: "2026-08-20T10:00:00.000Z",
      label: "Счёт №17",
    },
  ],
  activeRequest: {
    id: "00000000-0000-4000-8000-000000000004",
    number: "ЗАЯВКА-9",
    status: "under_review",
  },
  attentionCount: 2,
} as const;

function renderOverview() {
  return render(
    <ThemeProvider defaultTheme="light">
      <MemoryRouter>
        <AccessProvider
          value={{
            roles: ["owner"],
            capabilities: [CABINET_CAPABILITY.BILLING_READ, CABINET_CAPABILITY.BILLING_REQUEST],
          }}
        >
          <BillingOverviewPage />
        </AccessProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("shows the current subscription, actionable offer, recent operations, and active request", () => {
  vi.mocked(useBillingOverview).mockReturnValue({
    data: overview,
    isPending: false,
    isError: false,
  } as never);

  renderOverview();

  expect(screen.getByRole("heading", { name: "Текущая подписка", level: 2 })).toBeDefined();
  expect(screen.getByText("Профи")).toBeDefined();
  expect(screen.getByText("Счёт №17")).toBeDefined();
  expect(screen.getByText("ЗАЯВКА-9")).toBeDefined();
  expect(screen.getByRole("link", { name: "Открыть предложение" }).getAttribute("href")).toBe(
    "/billing/offers/00000000-0000-4000-8000-000000000002",
  );
  expect(screen.getByRole("link", { name: "Открыть заявку" }).getAttribute("href")).toBe(
    "/billing/requests/00000000-0000-4000-8000-000000000004",
  );
});

it("labels approaching and reached limits and pre-fills a contextual capacity request", () => {
  vi.mocked(useBillingOverview).mockReturnValue({
    data: overview,
    isPending: false,
    isError: false,
  } as never);

  renderOverview();

  expect(screen.getAllByText("Лимит исчерпан").length).toBeGreaterThan(0);
  expect(screen.getAllByText("Приближение к лимиту").length).toBeGreaterThan(0);
  expect(screen.getByRole("link", { name: "Увеличить лимит линий" }).getAttribute("href")).toBe(
    "/billing/requests/new?type=capacity_change&contextType=limit&contextId=lines",
  );
});

it("handles loading, API failure, and an unmanaged tenant explicitly", () => {
  vi.mocked(useBillingOverview).mockReturnValue({
    data: undefined,
    isPending: true,
    isError: false,
  } as never);
  const rendered = renderOverview();
  expect(screen.getByRole("status").textContent).toContain("Загрузка");

  rendered.unmount();
  vi.mocked(useBillingOverview).mockReturnValue({
    data: undefined,
    isPending: false,
    isError: true,
  } as never);
  renderOverview();
  expect(screen.getByText("Не удалось загрузить обзор биллинга")).toBeDefined();
});

it("explains that an unmanaged tenant has no current subscription", () => {
  vi.mocked(useBillingOverview).mockReturnValue({
    data: {
      ...overview,
      access: "unmanaged",
      subscription: null,
      actionableOffer: null,
      activeRequest: null,
    },
    isPending: false,
    isError: false,
  } as never);

  renderOverview();
  expect(screen.getByText("Подписка не назначена")).toBeDefined();
});

it("keeps invalid money and date input explicit at the billing formatting boundary", () => {
  expect(formatMoney("", "RUB", "ru-RU")).toBe("—");
  expect(formatMoney("48O00.00", "RUB", "ru-RU")).toBe("—");
  expect(formatMoney("48000.00", "INVALID", "ru-RU")).toBe("—");
  expect(formatBillingDate("not-a-date", "ru-RU")).toBe("—");
});
