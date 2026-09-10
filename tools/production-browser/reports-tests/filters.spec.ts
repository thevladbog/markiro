import { test, expect } from "@playwright/test";
import {
  platformCapabilitiesForRole,
  tenantListItemSchema,
} from "../../../packages/platform-contracts/src/index.js";

for (const width of [390, 1440]) {
  test(`searches report products and time zones at ${width}px`, async ({
    page,
    context,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const tenant = tenantListItemSchema.parse({
      id: "report-fixture",
      name: "Тестовый завод",
      slug: "report-fixture",
      createdAt: "2026-09-01T00:00:00Z",
      subscriptionStatus: "trial",
    });
    const firstId = "92111111-1111-4111-8111-111111111111";
    const secondId = "93111111-1111-4111-8111-111111111111";
    const requests: URL[] = [];
    const unexpected: string[] = [];
    // Synthetic responses only: never connect this browser test to production.
    await context.route(
      (url) => url.pathname.startsWith("/api/"),
      async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === "/api/platform-auth/get-session") {
          await route.fulfill({
            json: {
              session: { id: "fixture-session", expiresAt: "2027-01-01T00:00:00Z" },
              user: {
                id: "fixture-admin",
                email: "fixture@example.invalid",
                name: "Fixture",
                twoFactorEnabled: true,
              },
            },
          });
        } else if (url.pathname === "/api/platform/me") {
          await route.fulfill({
            json: {
              userId: "fixture-admin",
              role: "platform_admin",
              capabilities: platformCapabilitiesForRole.platform_admin,
              twoFactorReady: true,
            },
          });
        } else if (url.pathname === "/api/platform/tenants") {
          await route.fulfill({ json: { items: [tenant], page: 1, limit: 50, total: 1 } });
        } else if (url.pathname === "/api/platform/reports") {
          await route.fulfill({ json: { items: [], nextOffset: null } });
        } else if (url.pathname === "/api/platform/reports/options") {
          requests.push(url);
          const matching =
            url.searchParams.get("kind") === "products" &&
            url.searchParams.get("search") === "Кефир";
          const next = url.searchParams.get("offset") === "50";
          await route.fulfill({
            json: {
              items: matching
                ? [
                    {
                      id: next ? secondId : firstId,
                      name: next ? "Кефир 3%" : "Кефир 1%",
                      tenantId: tenant.id,
                    },
                  ]
                : [],
              nextOffset: matching && !next ? 50 : null,
            },
          });
        } else {
          unexpected.push(`Unexpected fixture request: ${url.pathname}`);
          await route.abort();
        }
      },
    );
    await page.goto("/reports");
    await page.getByRole("button", { name: "RU", exact: true }).click();
    await page.getByRole("checkbox", { name: tenant.name }).check();
    const dates = await page
      .locator('input[name="fromDate"], input[name="toDate"]')
      .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));
    const timezone = page.getByRole("combobox", { name: /часовой пояс/i });
    await expect(timezone).toContainText("Москва — Europe/Moscow");
    await timezone.click();
    await page.getByRole("searchbox").fill("Екатеринбург");
    await expect(
      page.getByRole("option", { name: "Екатеринбург — Asia/Yekaterinburg" }),
    ).toBeVisible();
    const timezoneMenu = await page.locator(".mk-combobox__content").boundingBox();
    expect(timezoneMenu).not.toBeNull();
    expect(timezoneMenu!.x).toBeGreaterThanOrEqual(0);
    expect(timezoneMenu!.x + timezoneMenu!.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath("timezone-search.png") });
    await page.getByRole("searchbox").press("ArrowDown");
    await page.getByRole("searchbox").press("Enter");
    await expect(timezone).toContainText("Asia/Yekaterinburg");
    expect(
      await page
        .locator('input[name="fromDate"], input[name="toDate"]')
        .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value)),
    ).toEqual(dates);
    const product = page.getByRole("combobox", { name: "Продукт", exact: true });
    await product.click();
    await page.getByRole("searchbox").fill("Кефир");
    await expect(page.getByRole("option", { name: "Кефир 1%" })).toBeVisible();
    await page.getByRole("button", { name: "Загрузить ещё продукцию" }).click();
    await expect(page.getByRole("option", { name: "Кефир 3%" })).toBeVisible();
    await expect(page.getByRole("option", { name: "Кефир 1%" })).toBeVisible();
    expect(
      requests.some(
        (url) =>
          url.searchParams.get("search") === "Кефир" &&
          url.searchParams.get("offset") === "50" &&
          url.searchParams.getAll("tenantIds").join() === tenant.id,
      ),
    ).toBe(true);
    const menu = await page.getByRole("listbox", { name: "Продукт" }).boundingBox();
    expect(menu).not.toBeNull();
    expect(menu!.x).toBeGreaterThanOrEqual(0);
    expect(menu!.x + menu!.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath("product-search.png") });
    await page.getByRole("option", { name: "Кефир 3%" }).click();
    await expect(product).toContainText("Кефир 3%");
    await page.getByRole("button", { name: "EN", exact: true }).click();
    const englishTimezone = page.getByRole("combobox", { name: /timezone/i });
    await englishTimezone.click();
    await page.getByRole("searchbox", { name: "Search cities or time zones" }).fill("UTC");
    await page.getByRole("option", { name: "UTC", exact: true }).click();
    await expect(englishTimezone).toContainText("UTC");
    await page.getByRole("combobox", { name: "Product", exact: true }).click();
    await page.getByRole("searchbox", { name: "Search products by name" }).fill("missing");
    await expect(page.getByText("No products found", { exact: true })).toBeVisible();
    await page.getByRole("searchbox").press("Escape");
    await expect(page.getByRole("combobox", { name: "Product", exact: true })).toContainText(
      "Кефир 3%",
    );
    await context.unrouteAll({ behavior: "wait" });
    expect(unexpected).toEqual([]);
  });
}
