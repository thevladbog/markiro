import { expect, test } from "@playwright/test";
const sscc = "123456789012345675";

test.use({ viewport: { width: 393, height: 660 }, isMobile: true, hasTouch: true });

test("box sale controls remain reachable on a short mobile screen", async ({
  page,
  baseURL,
}, testInfo) => {
  if (!baseURL) throw new Error("The admin browser baseURL is required");
  const origin = baseURL;
  const unexpected: string[] = [];
  await page.route(`${origin}/api/**`, async (route) => {
    const url = new URL(route.request().url());
    let body: unknown;
    if (route.request().method() !== "GET") throw new Error("Unexpected mutation");
    if (url.pathname === "/api/support-chat/episodes") {
      await route.fulfill({
        status: 503,
        json: {
          statusCode: 503,
          message: "Support chat unavailable",
          error: "Service Unavailable",
        },
      });
      return;
    }
    if (url.pathname === "/api/profile")
      body = { firstName: "Игорь", lastName: "Волков", middleName: null, hasAvatar: false };
    else if (url.pathname === "/api/access/me")
      body = { roles: ["manager"], capabilities: ["operations.read", "operations.write"] };
    else if (url.pathname === "/api/pickup-orders") body = { items: [] };
    else if (url.pathname === "/api/boxes/sell-codes") {
      expect(url.searchParams.get("sscc")).toBe(sscc);
      body = {
        boxId: "00000000-0000-4000-8000-000000000321",
        sscc,
        productName:
          'Сидр фруктовый ароматизированный нефильтрованный пастеризованный газированный жемчужный полусухой "ТАЙМ КИЛЛА КОНОПЛЯНЫЙ" 0.33 л.',
        itemCount: 2,
        items: ["S-aa", "S-bb"].map((serial, index) => ({
          codeHash: String(index + 1).repeat(64),
          rawKm: `010400638133393121${serial}`,
          gtin14: "04006381333931",
          serial,
        })),
      };
    } else {
      unexpected.push(url.pathname);
      await route.fulfill({ status: 404, body: "Unexpected request" });
      return;
    }
    await route.fulfill({ json: body });
  });
  await page.goto(`${origin}/test/browser/national-catalog-harness.html?route=/boxes/sell`);
  await page.getByLabel("SSCC короба").fill(`!100${sscc}`);
  await page.getByRole("button", { name: "Найти короб", exact: true }).tap();
  await expect(page.getByText("1 / 2", { exact: true })).toBeVisible();
  await expect(page.locator(".mk-sell-code svg")).toBeVisible();

  const main = page.getByRole("main");
  await main.hover();
  await page.mouse.wheel(0, 1000);
  const next = page.getByRole("button", { name: "Далее", exact: true });
  await expect(next).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: testInfo.outputPath("box-sell-mobile.png") });
  await next.tap();
  await expect(page.getByText("2 / 2", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Назад", exact: true }).tap();
  await expect(page.getByText("1 / 2", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 660, height: 393 });
  await main.hover();
  await page.mouse.wheel(0, 1000);
  await expect(next).toBeInViewport({ ratio: 1 });
  await next.tap();
  await next.tap();
  await expect(page.getByText("Все 2 кода показаны", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Следующий короб", exact: true }).tap();
  await expect(page.getByLabel("SSCC короба")).toBeVisible();
  expect(unexpected).toEqual([]);
});
