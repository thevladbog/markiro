import { expect, test } from "@playwright/test";

const routes = [
  "/",
  "/markirovka-chestny-znak/",
  "/sscc-i-agregatsiya/",
  "/rabochee-mesto-upakovki/",
  "/kiosk-samovydachi/",
  "/integratsiya-1c/",
  "/oflayn-rabota/",
  "/faq/",
  "/en/",
  "/en/chestny-znak-serialization/",
  "/en/sscc-and-aggregation/",
  "/en/packing-workstation/",
  "/en/self-service-pickup-kiosk/",
  "/en/1c-integration/",
  "/en/offline-production/",
  "/en/faq/",
];
const MARKIRO_MODULE_LAYOUT = [
  { position: "0-0", row: "1", column: "1", color: "rgb(250, 250, 248)" },
  { position: "0-2", row: "1", column: "3", color: "rgb(250, 250, 248)" },
  { position: "1-1", row: "2", column: "2", color: "rgb(250, 250, 248)" },
  { position: "2-0", row: "3", column: "1", color: "rgb(250, 250, 248)" },
  { position: "2-2", row: "3", column: "3", color: "rgb(250, 250, 248)" },
  { position: "3-0", row: "4", column: "1", color: "rgb(250, 250, 248)" },
  { position: "3-2", row: "4", column: "3", color: "rgb(250, 250, 248)" },
  { position: "4-1", row: "5", column: "2", color: "rgb(61, 220, 122)" },
];

for (const route of routes) {
  test(`${route} renders without browser or layout errors`, async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));

    const response = await page.goto(route, { waitUntil: "networkidle" });
    expect(response?.status()).toBe(200);
    await expect(page.locator("h1")).toHaveCount(1);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      `https://markiro.app${route}`,
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(errors).toEqual([]);
  });
}

test("keyboard focus is visible on the first interactive control", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  const focused = page.locator(":focus");
  await expect(focused).toHaveCount(1);
  expect(
    await focused.evaluate((element) => {
      const style = getComputedStyle(element);
      return style.outlineStyle !== "none" || style.boxShadow !== "none";
    }),
  ).toBe(true);
});

for (const [route, wordmark] of [
  ["/", "маркиро"],
  ["/en/", "MARKIRO"],
] as const) {
  test(`${route} renders the localized exact brand in its header and footer`, async ({ page }) => {
    await page.goto(route);
    for (const brand of [page.locator("header .brand-mark"), page.locator("footer .brand-mark")]) {
      await expect(brand.locator(".brand-mark__word")).toHaveText(wordmark);
      await expect(brand.locator("[data-brand-module]")).toHaveCount(8);
      expect(
        await brand.locator("[data-brand-module]").evaluateAll((modules) =>
          modules.map((module) => {
            const style = getComputedStyle(module);
            return {
              position: module.getAttribute("data-position"),
              row: style.gridRowStart,
              column: style.gridColumnStart,
              width: style.width,
              height: style.height,
              color: style.backgroundColor,
            };
          }),
        ),
      ).toEqual(
        MARKIRO_MODULE_LAYOUT.map(({ position, row, column, color }) => ({
          position,
          row,
          column,
          width: "4px",
          height: "4px",
          color,
        })),
      );
      await expect(brand.locator("[data-brand-accent]")).toHaveCount(1);
      await expect(brand.locator("[data-brand-accent]")).toHaveAttribute("data-position", "4-1");
    }
  });
}

test("language switch connects exact page counterparts", async ({ page }) => {
  await page.goto("/en/offline-production/");
  const menuTrigger = page.locator("[data-menu-trigger]");
  if (await menuTrigger.isVisible()) await menuTrigger.click();

  await expect(page.locator('a[hreflang="ru"]')).toHaveAttribute("href", "/oflayn-rabota/");
  await expect(page.locator('a[hreflang="en"]')).toHaveAttribute("href", "/en/offline-production/");
  await expect(page.locator('a[hreflang="en"]')).toHaveAttribute("aria-current", "page");
});

test("crawler policy endpoints expose the approved search boundary", async ({ request }) => {
  const robots = await request.get("/robots.txt");
  expect(robots.status()).toBe(200);
  const text = await robots.text();
  expect(text).toContain("User-agent: OAI-SearchBot");
  expect(text).toContain("User-agent: GPTBot\nDisallow: /");
  expect(text).toContain("Sitemap: https://markiro.app/sitemap.xml");
  await expect((await request.get("/sitemap.xml")).text()).resolves.toContain(
    "https://markiro.app/faq/",
  );
  await expect((await request.get("/sitemap.xml")).text()).resolves.toContain(
    "https://markiro.app/en/faq/",
  );
  await expect((await request.get("/llms.txt")).text()).resolves.toContain("https://markiro.app/");
});

test("representative search crawlers receive the same primary content", async ({ browser }) => {
  const userAgents = [
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "OAI-SearchBot/1.0; +https://openai.com/searchbot",
    "Claude-SearchBot/1.0",
    "PerplexityBot/1.0",
  ];
  const texts: string[] = [];
  for (const userAgent of userAgents) {
    const context = await browser.newContext({ userAgent });
    const page = await context.newPage();
    await page.goto("/");
    texts.push((await page.locator("main").innerText()).replaceAll(/\s+/g, " ").trim());
    await context.close();
  }
  expect(new Set(texts).size).toBe(1);
});

test("unknown routes are real 404s", async ({ page }) => {
  const response = await page.goto("/definitely-missing/");
  expect(response?.status()).toBe(404);
});
