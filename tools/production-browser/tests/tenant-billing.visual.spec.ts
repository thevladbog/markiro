import { expect, test, type Page, type Route } from "@playwright/test";

const access = {
  roles: ["owner"],
  capabilities: ["operations.read", "billing.read", "billing.request"],
  subscription: {
    access: "managed",
    status: "active",
    startsAt: "2026-08-01T00:00:00.000Z",
    endsAt: "2026-09-01T00:00:00.000Z",
    plan: { id: "plan_1", version: 1, nameRu: "Профи", nameEn: "Pro" },
    addons: [],
  },
};
const overview = {
  access: "managed",
  subscription: {
    id: "00000000-0000-4000-8000-000000000101",
    planVersionId: "00000000-0000-4000-8000-000000000102",
    status: "active",
    startsAt: "2026-08-01T00:00:00.000Z",
    endsAt: "2026-09-01T00:00:00.000Z",
    planName: "Профи",
    billingPeriod: "month",
    price: "48000.00",
  },
  scheduledSubscription: null,
  limits: {
    lines: 4,
    stations: 6,
    kiosks: 2,
    cabinetUsers: 10,
    labelEditor: true,
    publicApi: false,
    pallets: false,
  },
  usage: { lines: 3, stations: 4, kiosks: 1, cabinetUsers: 6 },
  limitPresentation: {
    lines: { used: 3, assigned: 4, remaining: 1, state: "approaching" },
    stations: { used: 4, assigned: 6, remaining: 2, state: "normal" },
    kiosks: { used: 1, assigned: 2, remaining: 1, state: "normal" },
    cabinetUsers: { used: 6, assigned: 10, remaining: 4, state: "normal" },
  },
  addons: [],
  services: [],
  actionableOffer: {
    id: "20000000-0000-4000-8000-000000000001",
    number: "КП-0042/2",
    total: "120000.00",
  },
  recentOperations: [
    {
      id: "op_1",
      kind: "invoice",
      status: "paid",
      occurredAt: "2026-08-28T11:30:00.000Z",
      label: "Счёт INV-000042 оплачен",
    },
    {
      id: "op_2",
      kind: "request",
      status: "in_progress",
      occurredAt: "2026-08-28T11:40:00.000Z",
      label: "Заявка BR-000042 выполняется",
    },
  ],
  activeRequest: {
    id: "10000000-0000-4000-8000-000000000001",
    number: "BR-000042",
    status: "in_progress",
  },
  attentionCount: 1,
};
const invoices = {
  items: [
    {
      id: "30000000-0000-4000-8000-000000000001",
      number: "INV-000042",
      issueDate: "2026-08-28T11:00:00.000Z",
      dueDate: "2026-09-04T00:00:00.000Z",
      status: "paid",
      total: "120000.00",
      currency: "RUB",
      paymentSummary: {
        confirmedAmount: "120000.00",
        remainingAmount: "0.00",
        status: "paid",
      },
    },
  ],
};
const offer = {
  id: "20000000-0000-4000-8000-000000000001",
  number: "КП-0042/2",
  status: "published",
  total: "120000.00",
  expiresAt: "2026-09-15T00:00:00.000Z",
  publishedAt: "2026-08-28T10:40:00.000Z",
  paidAt: null,
  termsMarkdown: "Подключение в два этапа",
  isCurrent: true,
  actionable: true,
  latestDecision: null,
  request: {
    id: "10000000-0000-4000-8000-000000000001",
    number: "BR-000042",
    status: "offer_prepared",
  },
  lines: [
    {
      id: "21000000-0000-4000-8000-000000000001",
      position: 1,
      kind: "service",
      nameRu: "Подключение двух линий",
      quantity: 2,
      unit: "линия",
      agreedUnitPrice: "60000.00",
      lineTotal: "120000.00",
    },
  ],
  documents: [],
};

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function installStrictApi(page: Page, scenario = "ready") {
  const unexpected: string[] = [];
  await page.route(/^http:\/\/127\.0\.0\.1:\d+\/api\//, async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/api/profile") {
      return json(route, {
        firstName: "Елена",
        middleName: null,
        lastName: "Ким",
        hasAvatar: false,
      });
    }
    if (path === "/api/access/me") {
      if (scenario === "forbidden") {
        return json(route, { ...access, roles: ["manager"], capabilities: ["operations.read"] });
      }
      return json(route, access);
    }
    if (path === "/api/billing/attention") return json(route, { count: 1 });
    if (path === "/api/pickup-orders") return json(route, { items: [] });
    if (path === "/api/billing/overview") {
      if (scenario === "loading") await new Promise((resolve) => setTimeout(resolve, 400));
      if (scenario === "error") return json(route, { code: "temporarily_unavailable" }, 503);
      if (scenario === "unmanaged") {
        return json(route, { ...overview, access: "unmanaged", subscription: null });
      }
      return json(route, overview);
    }
    if (path === "/api/billing/invoices") {
      return json(route, scenario === "empty" ? { items: [] } : invoices);
    }
    if (path === `/api/billing/offers/${offer.id}`) return json(route, offer);
    unexpected.push(`${route.request().method()} ${path}${url.search}`);
    await route.abort("failed");
  });
  return unexpected;
}

async function assertNoPageOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    viewport: innerWidth,
  }));
  expect(dimensions.width).toBeLessThanOrEqual(dimensions.viewport);
}

for (const viewport of [
  { width: 1440, height: 1024 },
  { width: 1280, height: 900 },
  { width: 360, height: 800 },
  { width: 320, height: 800 },
]) {
  test(`renders the approved billing hierarchy without clipping at ${viewport.width}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const unexpected = await installStrictApi(page);
    await page.goto("/test/browser/tenant-billing.html?route=/billing");
    await expect(page.getByRole("heading", { level: 1, name: "Биллинг" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Текущая подписка" })).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 2, name: "Текущее предложение" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Лимиты" })).toBeVisible();
    await expect(page.getByText("Приближение к лимиту")).toBeVisible();
    await expect(page.getByText("Использовано: 3 из 4")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Основная навигация" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Разделы биллинга" })).toBeVisible();
    if (viewport.width >= 768) {
      const sidebarBox = await page
        .getByRole("navigation", { name: "Основная навигация" })
        .boundingBox();
      const headingBox = await page
        .getByRole("heading", { level: 1, name: "Биллинг" })
        .boundingBox();
      expect(sidebarBox).not.toBeNull();
      expect(headingBox).not.toBeNull();
      expect(headingBox!.x).toBeGreaterThanOrEqual(sidebarBox!.x + sidebarBox!.width);
    } else {
      await expect(page.getByRole("link", { name: "Открыть профиль Елена Ким" })).toHaveCount(0);
    }
    await assertNoPageOverflow(page);
    expect(unexpected).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`overview-${viewport.width}.png`),
      fullPage: true,
    });
    if (viewport.width <= 360) {
      await page
        .getByRole("navigation", { name: "Основная навигация" })
        .getByRole("link", { name: /Биллинг/ })
        .scrollIntoViewIfNeeded();
      await expect(
        page
          .getByRole("navigation", { name: "Основная навигация" })
          .getByRole("link", { name: /Биллинг/ }),
      ).toBeVisible();
      await page.getByRole("main").evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect(page.getByRole("heading", { level: 2, name: "Активная заявка" })).toBeVisible();
    }
  });
}

test("announces the billing loading state", async ({ page }) => {
  const unexpected = await installStrictApi(page, "loading");
  await page.goto("/test/browser/tenant-billing.html?route=/billing");
  await expect(page.getByText("Загрузка обзора биллинга")).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Текущая подписка" })).toBeVisible();
  expect(unexpected).toEqual([]);
});

test("keeps keyboard focus visible and returns it after the offer dialog", async ({ page }) => {
  const unexpected = await installStrictApi(page);
  await page.goto("/test/browser/tenant-billing.html?route=/billing");
  await expect(page.getByRole("heading", { level: 1, name: "Биллинг" })).toBeVisible();
  await page.keyboard.press("Tab");
  const focused = page.locator(":focus");
  await expect(focused).toBeVisible();
  const focusStyle = await focused.evaluate((element) => {
    const style = getComputedStyle(element);
    return `${style.outlineStyle}:${style.outlineWidth}:${style.boxShadow}`;
  });
  expect(focusStyle).not.toBe("none:0px:none");

  await page.getByRole("link", { name: "Открыть предложение" }).click();
  await expect(page.getByRole("button", { name: "Принять" })).toBeVisible();
  const accept = page.getByRole("button", { name: "Принять" });
  await accept.click();
  await expect(page.getByRole("alertdialog", { name: "Принять предложение?" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(accept).toBeFocused();
  expect(unexpected).toEqual([]);
});

test("uses the table on desktop and invoice cards on narrow screens", async ({ page }) => {
  const unexpected = await installStrictApi(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/test/browser/tenant-billing.html?route=/billing/invoices");
  await expect(page.getByRole("table")).toBeVisible();
  await page.setViewportSize({ width: 360, height: 800 });
  await expect(page.getByRole("table")).toBeHidden();
  await expect(page.getByRole("link", { name: /INV-000042/ })).toBeVisible();
  await assertNoPageOverflow(page);
  expect(unexpected).toEqual([]);
});

test("renders error, empty, unmanaged, and forbidden states through real routes", async ({
  page,
}) => {
  let unexpected = await installStrictApi(page, "error");
  await page.goto("/test/browser/tenant-billing.html?route=/billing");
  await expect(page.getByText("Не удалось загрузить обзор биллинга")).toBeVisible();
  expect(unexpected).toEqual([]);

  await page.unrouteAll({ behavior: "wait" });
  unexpected = await installStrictApi(page, "empty");
  await page.goto("/test/browser/tenant-billing.html?route=/billing/invoices");
  await expect(page.getByText("Счетов по выбранным фильтрам нет")).toBeVisible();
  expect(unexpected).toEqual([]);

  await page.unrouteAll({ behavior: "wait" });
  unexpected = await installStrictApi(page, "unmanaged");
  await page.goto("/test/browser/tenant-billing.html?route=/billing");
  await expect(page.getByText("Подписка не назначена")).toBeVisible();
  expect(unexpected).toEqual([]);

  await page.unrouteAll({ behavior: "wait" });
  unexpected = await installStrictApi(page, "forbidden");
  await page.goto("/test/browser/tenant-billing.html?route=/billing");
  await expect(page.getByTestId("forbidden-page")).toBeVisible();
  expect(unexpected).toEqual([]);
});
