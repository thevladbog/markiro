import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  user: { id: "user_1", email: "owner@example.com", name: "Елена Ким" },
};

const ORGANIZATIONS: OrganizationSummary[] = [{ id: "org_1", name: "Марка Ко", slug: "marka-ko" }];

const TRIAL_SUBSCRIPTION: NonNullable<AccessDocument["subscription"]> = {
  access: "managed",
  status: "trial",
  startsAt: "2026-08-01T00:00:00.000Z",
  endsAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
  plan: { id: "plan_1", version: 1, nameRu: "Демо", nameEn: "Demo" },
  addons: [],
};

const OWNER_ACCESS: AccessDocument = {
  roles: ["owner"],
  capabilities: [
    CABINET_CAPABILITY.OPERATIONS_READ,
    CABINET_CAPABILITY.BILLING_READ,
    CABINET_CAPABILITY.BILLING_REQUEST,
  ],
  subscription: TRIAL_SUBSCRIPTION,
};

const ADMIN_ACCESS: AccessDocument = {
  roles: ["admin"],
  capabilities: [
    CABINET_CAPABILITY.OPERATIONS_READ,
    CABINET_CAPABILITY.BILLING_READ,
    CABINET_CAPABILITY.BILLING_REQUEST,
  ],
  subscription: TRIAL_SUBSCRIPTION,
};

const MANAGER_ACCESS: AccessDocument = {
  roles: ["manager"],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ],
  subscription: TRIAL_SUBSCRIPTION,
};

const MEMBER_ACCESS: AccessDocument = {
  roles: ["member"],
  capabilities: [],
};

const BILLING_READ_ONLY_ACCESS: AccessDocument = {
  roles: ["admin"],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ, CABINET_CAPABILITY.BILLING_READ],
  subscription: TRIAL_SUBSCRIPTION,
};

const INVOICE = {
  id: "invoice_1",
  number: "Счёт №184",
  issueDate: "2026-08-01T00:00:00.000Z",
  dueDate: "2026-08-15T00:00:00.000Z",
  status: "issued",
  total: "48000",
  currency: "RUB",
};

const INVOICE_DETAIL = {
  ...INVOICE,
  subtotal: "40000",
  vatTotal: "8000",
  lines: [
    {
      position: 1,
      nameRu: "Подписка",
      unit: "мес.",
      quantity: 1,
      agreedUnitPrice: "40000",
      lineTotal: "40000",
    },
  ],
  documents: [{ id: "document_1", revision: 1, format: "pdf", status: "ready", byteSize: 123 }],
};

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

function createAuthClient(): AuthClientLike {
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

function renderRoute(path: string, access: AccessDocument) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/profile")) {
        return response({
          firstName: "Елена",
          lastName: "Ким",
          middleName: null,
          hasAvatar: false,
        });
      }
      if (url.endsWith("/api/access/me")) return response(access);
      if (url.includes("/api/pickup-orders")) return response({ items: [] });
      if (url.endsWith("/api/billing/invoices/invoice_1/documents/document_1/download")) {
        return response({ url: "https://example.test/invoice-184.pdf" });
      }
      if (url.endsWith("/api/billing/invoices/invoice_1")) return response(INVOICE_DETAIL);
      if (url.endsWith("/api/billing/invoices")) return response({ items: [INVOICE] });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="light">
        <AuthClientProvider client={createAuthClient()}>
          <RouterProvider router={createMemoryRouter(appRoutes, { initialEntries: [path] })} />
        </AuthClientProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("ru");
});

it.each([
  ["owner", OWNER_ACCESS],
  ["admin", ADMIN_ACCESS],
] as const)("shows billing navigation and request action for an %s", async (_role, access) => {
  renderRoute("/billing", access);

  expect(await screen.findByRole("link", { name: "Биллинг" })).toBeDefined();
  expect(screen.getByRole("heading", { name: "Биллинг" })).toBeDefined();
  expect(screen.getByRole("link", { name: "Создать заявку" }).getAttribute("href")).toBe(
    "/billing/requests/new",
  );
  expect(
    within(screen.getByRole("navigation", { name: "Разделы биллинга" }))
      .getByRole("link", { name: "Обзор" })
      .getAttribute("aria-current"),
  ).toBe("page");
});

it.each([
  ["manager", MANAGER_ACCESS],
  ["member", MEMBER_ACCESS],
] as const)("does not expose billing navigation to a %s", async (_role, access) => {
  renderRoute("/", access);

  if (access.capabilities.length === 0) {
    expect(await screen.findByText("Доступ к кабинету пока не открыт")).toBeDefined();
  } else {
    expect(await screen.findByRole("heading", { name: "Обзор" })).toBeDefined();
  }
  expect(screen.queryByRole("link", { name: "Биллинг" })).toBeNull();
});

it("forbids a manager from opening the billing route directly", async () => {
  renderRoute("/billing/requests", MANAGER_ACCESS);

  expect(await screen.findByTestId("forbidden-page")).toBeDefined();
  expect(screen.queryByRole("heading", { name: "Биллинг" })).toBeNull();
});

it("denies a member direct billing access through the real shell route", async () => {
  renderRoute("/billing", MEMBER_ACCESS);

  expect(await screen.findByText("Доступ к кабинету пока не открыт")).toBeDefined();
});

it("redirects the saved subscription route to the canonical billing tab", async () => {
  renderRoute("/settings/subscription", OWNER_ACCESS);

  expect(await screen.findByRole("heading", { name: "Биллинг" })).toBeDefined();
  expect(screen.getByRole("link", { name: "Подписка и лимиты" }).getAttribute("aria-current")).toBe(
    "page",
  );
});

it("keeps the documents tab current for a commercial offer route", async () => {
  renderRoute("/billing/offers/offer_1", OWNER_ACCESS);

  expect(await screen.findByRole("heading", { name: "Биллинг" })).toBeDefined();
  expect(
    within(screen.getByRole("navigation", { name: "Разделы биллинга" }))
      .getByRole("link", { name: "Документы" })
      .getAttribute("aria-current"),
  ).toBe("page");
});

it("keeps invoice list and detail routes connected to their existing page components", async () => {
  const list = renderRoute("/billing/invoices", OWNER_ACCESS);

  expect(await screen.findByRole("link", { name: "Счёт №184" })).toBeDefined();
  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  expect(screen.getByRole("heading", { name: "Счета", level: 2 })).toBeDefined();
  expect(document.querySelectorAll(".mk-admin-page")).toHaveLength(1);
  expect(document.querySelector(".mk-billing-route-placeholder")).toBeNull();
  list.unmount();

  const open = vi.spyOn(window, "open").mockImplementation(() => null);
  renderRoute("/billing/invoices/invoice_1", OWNER_ACCESS);

  expect(await screen.findByText("Позиции")).toBeDefined();
  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  expect(screen.getByRole("heading", { name: "Счет Счёт №184", level: 2 })).toBeDefined();
  expect(document.querySelectorAll(".mk-admin-page")).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Скачать" })).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Скачать" }));
  await waitFor(() =>
    expect(open).toHaveBeenCalledWith(
      "https://example.test/invoice-184.pdf",
      "_blank",
      "noopener,noreferrer",
    ),
  );
  expect(document.querySelector(".mk-billing-route-placeholder")).toBeNull();
});

it("allows a billing reader to view invoices but not create a request", async () => {
  const reader = renderRoute("/billing/invoices", BILLING_READ_ONLY_ACCESS);

  expect(await screen.findByRole("link", { name: "Счёт №184" })).toBeDefined();
  expect(screen.queryByRole("link", { name: "Создать заявку" })).toBeNull();
  reader.unmount();

  renderRoute("/billing/requests/new", BILLING_READ_ONLY_ACCESS);

  expect(await screen.findByTestId("forbidden-page")).toBeDefined();
});

it.each([
  ["owner", OWNER_ACCESS, true],
  ["manager", MANAGER_ACCESS, false],
] as const)(
  "keeps billing recovery CTA capability-safe for an %s",
  async (_role, access, canRead) => {
    renderRoute("/billing", access);

    expect(await screen.findByRole("alert")).toBeDefined();
    if (canRead) {
      expect(screen.getByRole("link", { name: "Посмотреть лимиты" })).toBeDefined();
    } else {
      expect(screen.queryByRole("link", { name: "Посмотреть лимиты" })).toBeNull();
    }
  },
);

it("keeps the billing tabs in their labelled narrow-screen navigation rail", async () => {
  renderRoute("/billing", OWNER_ACCESS);

  const tabs = await screen.findByRole("navigation", { name: "Разделы биллинга" });
  expect(tabs.classList.contains("mk-billing-tabs")).toBe(true);
  expect(within(tabs).getAllByRole("link")).toHaveLength(5);
});
