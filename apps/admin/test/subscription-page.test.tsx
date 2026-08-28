import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { ThemeProvider } from "@markiro/ui";
import { AccessProvider } from "../src/access/context.js";
import { BillingSubscriptionPage } from "../src/pages/billing/BillingSubscriptionPage.js";
import { useBillingSubscription } from "../src/pages/billing/api.js";

vi.mock("../src/pages/billing/api.js", () => ({
  useBillingSubscription: vi.fn(),
}));

const subscription = {
  access: "read_only",
  subscription: {
    status: "expired",
    startsAt: "2026-01-01T00:00:00Z",
    endsAt: "2026-08-10T00:00:00Z",
    id: "00000000-0000-4000-8000-000000000001",
    planVersionId: "00000000-0000-4000-8000-000000000002",
    planName: "Профи",
    billingPeriod: "month",
    price: "48000.00",
  },
  scheduledSubscription: {
    status: "scheduled",
    startsAt: "2026-09-01T00:00:00Z",
    endsAt: "2027-09-01T00:00:00Z",
    id: "00000000-0000-4000-8000-000000000003",
    planVersionId: "00000000-0000-4000-8000-000000000004",
    planName: "Корпоративный",
    billingPeriod: "year",
    price: "480000.00",
  },
  limits: {
    lines: 1,
    stations: 2,
    kiosks: 2,
    cabinetUsers: 5,
    labelEditor: false,
    publicApi: false,
    pallets: false,
  },
  usage: { lines: 2, stations: 0, kiosks: 0, cabinetUsers: 1 },
  limitPresentation: {
    lines: { used: 2, assigned: 1, remaining: 0, state: "exceeded" },
    stations: { used: 0, assigned: 2, remaining: 2, state: "normal" },
    kiosks: { used: 0, assigned: 2, remaining: 2, state: "normal" },
    cabinetUsers: { used: 1, assigned: 5, remaining: 4, state: "normal" },
  },
  addons: [
    {
      id: "00000000-0000-4000-8000-000000000005",
      catalogVersionId: "00000000-0000-4000-8000-000000000006",
      name: "Приоритетная поддержка",
      quantity: 2,
      status: "active",
      startsAt: null,
      endsAt: null,
    },
  ],
  services: [
    {
      id: "00000000-0000-4000-8000-000000000007",
      name: "Внедрение",
      quantity: 3,
      unit: "ч",
      status: "in_progress",
      orderedAt: "2026-08-01T00:00:00Z",
    },
  ],
} as const;

function renderSubscription() {
  return render(
    <ThemeProvider defaultTheme="light">
      <MemoryRouter>
        <AccessProvider
          value={{ roles: ["owner"], capabilities: [CABINET_CAPABILITY.BILLING_REQUEST] }}
        >
          <BillingSubscriptionPage />
        </AccessProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("renders server-provided read-only, exceeded, scheduled, add-on, and service states", () => {
  vi.mocked(useBillingSubscription).mockReturnValue({
    data: subscription,
    isPending: false,
    isError: false,
  } as never);

  renderSubscription();

  expect(screen.getAllByText("Только чтение").length).toBeGreaterThan(0);
  expect(screen.getByText("Лимит превышен")).toBeDefined();
  expect(screen.getByRole("heading", { name: "Следующее изменение", level: 2 })).toBeDefined();
  expect(screen.getByText("Корпоративный")).toBeDefined();
  expect(screen.getByText("Приоритетная поддержка")).toBeDefined();
  expect(screen.getByText("Выполняется")).toBeDefined();
  const lineProgress = screen.getByRole("progressbar", {
    name: "Линии: использовано 2 из 1",
  }) as HTMLProgressElement;
  expect(lineProgress.value).toBe(1);
  expect(lineProgress.max).toBe(1);
  expect(screen.getByRole("link", { name: "Увеличить лимит линий" }).getAttribute("href")).toBe(
    "/billing/requests/new?type=capacity_change&contextType=limit&contextId=lines",
  );
});

it("renders subscription loading, failure, and unmanaged empty states", () => {
  vi.mocked(useBillingSubscription).mockReturnValue({
    data: undefined,
    isPending: true,
    isError: false,
  } as never);
  const rendered = renderSubscription();
  expect(screen.getByRole("status").textContent).toContain("Загрузка");

  rendered.unmount();
  vi.mocked(useBillingSubscription).mockReturnValue({
    data: undefined,
    isPending: false,
    isError: true,
  } as never);
  const failed = renderSubscription();
  expect(screen.getByText("Не удалось загрузить подписку")).toBeDefined();

  failed.unmount();
  vi.mocked(useBillingSubscription).mockReturnValue({
    data: { ...subscription, access: "unmanaged", subscription: null },
    isPending: false,
    isError: false,
  } as never);
  renderSubscription();
  expect(screen.getByText("Подписка не назначена")).toBeDefined();
});
