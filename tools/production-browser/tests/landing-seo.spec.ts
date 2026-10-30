import { expect, test, type Page, type Response } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface LegalArtifactManifestEntry {
  readonly fileName: string;
  readonly bytes: number;
  readonly mediaType: string;
}

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const legalArtifacts = JSON.parse(
  readFileSync(path.join(repositoryRoot, "apps/landing/public/legal/artifacts.json"), "utf8"),
) as LegalArtifactManifestEntry[];
const verificationRoutes = [
  "/d/MKR-PD-01/2026.08/01/15.08.2026",
  "/d/MKR-PD-02/2026.08/01/15.08.2026",
  "/d/MKR-DPA-01/2026.08/01/15.08.2026",
  "/d/MKR-BRD-01/2026.08/01/15.08.2026",
] as const;

const LATEST_RELEASE = {
  v: 1,
  product: "markiro-standalone",
  channel: "stable",
  version: "0.4.0",
  releasedAt: "2026-10-18T09:00:00Z",
  installer: {
    url: "https://releases.markiro.app/standalone/stable/0.4.0/markiro-standalone-0.4.0-windows-x86_64-setup.exe",
    sha256: "3f9c1e7a52d84b06c9e1f3a7d20b5e8c41f6a9d3b7e2c05f18a4d6b9e3c7f201",
    sizeBytes: 64_987_136,
  },
  manifestUrl:
    "https://releases.markiro.app/standalone/stable/0.4.0/markiro-standalone-0.4.0.update.jws",
  notes: [],
};

test.beforeEach(async ({ page }) => {
  await page.route("https://smartcaptcha.cloud.yandex.ru/captcha.js", async (route) => {
    await route.fulfill({
      body: "window.smartCaptcha = { reset() {} };",
      contentType: "application/javascript",
      status: 200,
    });
  });
  // /skachat/ reads the installer pointer from the public release bucket.
  await page.route("https://releases.markiro.app/standalone/stable/latest.json", async (route) => {
    await route.fulfill({
      body: JSON.stringify(LATEST_RELEASE),
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      status: 200,
    });
  });
});

const routes = [
  "/",
  "/skachat/",
  "/stoimost/",
  "/stati/",
  "/instruktsii/",
  "/en/articles/",
  "/en/instructions/",
  "/markirovka-chestny-znak/",
  "/sscc-i-agregatsiya/",
  "/stati/agregatsiya-piva-v-koroba/",
  "/stati/markirovka-piva-2026/",
  "/stati/data-matrix-pivo-ne-schityvaetsya/",
  "/stati/oborudovanie-dlya-markirovki-piva/",
  "/stati/stoimost-markirovki-piva/",
  "/stati/nanesenie-data-matrix-na-pivo/",
  "/stati/markirovka-piva-bez-interneta/",
  "/stati/dubl-koda-markirovki-pivo/",
  "/stati/otchet-o-nanesenii-kodov-pivo/",
  "/rabochee-mesto-upakovki/",
  "/integratsiya-1c/",
  "/oflayn-rabota/",
  "/faq/",
  "/en/",
  "/en/chestny-znak-serialization/",
  "/en/sscc-and-aggregation/",
  "/en/articles/beer-case-aggregation/",
  "/en/articles/beer-marking-2026/",
  "/en/articles/beer-data-matrix-not-scanning/",
  "/en/articles/beer-marking-line-equipment/",
  "/en/articles/beer-marking-cost-russia/",
  "/en/articles/beer-data-matrix-application-methods/",
  "/en/articles/offline-beer-marking-russia/",
  "/en/articles/duplicate-beer-marking-code-russia/",
  "/en/articles/beer-code-application-report-russia/",
  "/en/packing-workstation/",
  "/en/1c-integration/",
  "/en/offline-production/",
  "/en/faq/",
  "/legal/",
  "/privacy/",
  "/personal-data-consent/",
  "/legal/tenant-data-processing/",
  "/legal/brand-letterhead/",
  "/en/legal/",
  "/en/privacy/",
  "/en/personal-data-consent/",
  "/en/legal/tenant-data-processing/",
  "/en/legal/brand-letterhead/",
  ...verificationRoutes,
];
const MARKIRO_MODULE_LAYOUT = [
  { x: "14", y: "14", accent: false },
  { x: "14", y: "26", accent: false },
  { x: "14", y: "38", accent: false },
  { x: "26", y: "22", accent: false },
  { x: "38", y: "14", accent: false },
  { x: "38", y: "26", accent: false },
  { x: "38", y: "38", accent: false },
  { x: "26", y: "42", accent: true },
];

const BRAND_COLORS = {
  dark: { module: "rgb(19, 18, 22)", accent: "rgb(61, 220, 122)", tile: "rgb(250, 250, 248)" },
  light: { module: "rgb(250, 250, 248)", accent: "rgb(15, 175, 86)", tile: "rgb(23, 22, 26)" },
} as const;

test("cookie panel reveals granular controls only after an explicit settings action", async ({
  page,
}) => {
  await page.goto("/");
  const panel = page.locator("[data-consent-panel]");
  const details = panel.locator("[data-consent-details]");

  await expect(panel).toBeVisible();
  await expect(details).toBeHidden();
  await panel.locator("[data-consent-customize]").click();
  await expect(details).toBeVisible();
});

test("cookie panel stays anchored to the bottom edge without entering document flow", async ({
  page,
}) => {
  await page.goto("/");
  const panel = page.locator("[data-consent-panel]");
  await expect(panel).toBeVisible();

  expect(
    await panel.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return {
        bottomGap: Math.round(window.innerHeight - box.bottom),
        position: getComputedStyle(element).position,
      };
    }),
  ).toEqual({ bottomGap: 0, position: "fixed" });
});

test("GTM stays offline until analytics consent and loads only once after permission", async ({
  page,
}) => {
  const gtmRequests: string[] = [];
  await page.route("https://www.googletagmanager.com/**", async (route) => {
    gtmRequests.push(route.request().url());
    await route.fulfill({ body: "", contentType: "application/javascript", status: 200 });
  });

  await page.goto("/");
  expect(gtmRequests).toEqual([]);
  await expect(page.locator("iframe[src*='googletagmanager.com']")).toHaveCount(0);

  await page.locator("[data-consent-customize]").click();
  await page.locator("[data-consent-marketing]").check();
  await page.locator("[data-consent-save]").click();
  expect(gtmRequests).toEqual([]);

  await page.locator("[data-consent-settings]").click();
  await page.locator("[data-consent-analytics]").check();
  await page.locator("[data-consent-save]").click();
  await expect.poll(() => gtmRequests).toHaveLength(1);
  expect(gtmRequests[0]).toBe("https://www.googletagmanager.com/gtm.js?id=GTM-KZ6P7NVF");

  await page.evaluate(() => window.dispatchEvent(new Event("markiro:consent-changed")));
  await expect.poll(() => gtmRequests).toHaveLength(1);
});

// The owner's decision (#787): the home pages carry no call form. Leads come through
// /skachat/ and /stoimost/, and «Разобрать линию» leads to the contacts of the home page.
for (const [route, label] of [
  ["/", "hello@markiro.app"],
  ["/en/", "Walk through your line in 30 minutes"],
] as const) {
  test(`${route} has no call form and leads the line review to its contacts`, async ({ page }) => {
    await page.goto(route);
    await expect(page.locator("[data-demo-form]")).toHaveCount(0);
    const call = page.locator("#demo").getByRole("link", { name: label, exact: true });
    await expect(call).toHaveAttribute("href", "mailto:hello@markiro.app");
    await expect(
      page.locator("#demo").getByRole("link", { name: "hello@markiro.app", exact: true }),
    ).toBeVisible();
    for (const href of await page
      .locator('main a[data-analytics="landing_demo_click"]')
      .evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? ""))) {
      expect(href === `${route}#demo` || href.startsWith("mailto:"), href).toBe(true);
    }
  });
}

test.describe("standalone lead forms", () => {
  test("/skachat/ posts the download lead and shows the installer from latest.json", async ({
    page,
    isMobile,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window.crypto, "randomUUID", {
        value: () => "33333333-3333-4333-8333-333333333333",
      });
    });
    let payload: unknown;
    await page.route("**/api/landing-leads", async (route) => {
      payload = route.request().postDataJSON();
      await route.fulfill({
        body: JSON.stringify({ accepted: true, requestId: "33333333-3333-4333-8333-333333333333" }),
        contentType: "application/json",
        status: 202,
      });
    });

    await page.goto("/?utm_source=yandex&utm_medium=cpc");
    let releaseReads = 0;
    page.on("request", (request) => {
      if (request.url().endsWith("/standalone/stable/latest.json")) releaseReads += 1;
    });
    await page.goto("/skachat/", { waitUntil: "networkidle" });
    // The cookie panel covers the form on phones; a visitor answers it first.
    await page.locator("[data-consent-reject]").click();
    // The release bucket and the captcha are third parties: nothing is asked before the form.
    expect(releaseReads).toBe(0);
    await expect(page.locator("[data-release-fact]").first()).toBeHidden();
    const form = page.locator("form[data-lead-form]");
    await form.locator('input[name="email"]').fill("ivan@zavod");
    await expect(page.locator('[data-release="version"]').first()).toHaveText("0.4.0");
    expect(releaseReads).toBe(1);
    await form.locator('button[type="submit"]').click();
    await expect(form.locator('[data-error-for="email"]')).toHaveText(
      "Проверьте почту: не хватает домена, например zavod.ru",
    );
    await expect(form.locator('[data-error-for="company"]')).toHaveText("Укажите компанию");
    expect(payload).toBeUndefined();

    await form.locator('input[name="email"]').fill(" Ivan@Zavod.ru ");
    await form.locator('input[name="company"]').fill("ООО «Пивоварня»");
    await form.locator('input[name="consent"]').check();
    await form.locator('button[type="submit"]').click();

    await expect(
      page.locator("[data-download-ready] [data-release-only] [data-ready-heading]"),
    ).toBeFocused();
    expect(payload).toEqual({
      company: "ООО «Пивоварня»",
      consentVersion: "MKR-PD-02/2026.08/01",
      email: "ivan@zavod.ru",
      intent: "download",
      locale: "ru",
      requestId: "33333333-3333-4333-8333-333333333333",
      sourcePath: "/skachat/",
      utm: { source: "yandex", medium: "cpc" },
      website: "",
    });
    const link = page.locator("[data-release-link]:visible");
    await expect(link).toHaveAttribute("href", LATEST_RELEASE.installer.url);
    await expect(page.locator('[data-release="sha256"]')).toHaveText(
      LATEST_RELEASE.installer.sha256,
    );
    await expect(page.getByText("Перед первым запуском Windows", { exact: true })).toBeVisible();
    await expect(page.locator("[data-download-ready]")).toContainText(
      isMobile ? "Заявка принята" : "Ссылка готова",
    );
  });

  test("/skachat/ says the version is being prepared when latest.json is missing", async ({
    page,
  }) => {
    await page.route("https://releases.markiro.app/standalone/stable/latest.json", (route) =>
      route.fulfill({ status: 404, body: "", headers: { "access-control-allow-origin": "*" } }),
    );
    await page.route("**/api/landing-leads", (route) =>
      route.fulfill({ body: "{}", contentType: "application/json", status: 202 }),
    );
    await page.goto("/skachat/");
    await page.locator("[data-consent-reject]").click();
    const form = page.locator("form[data-lead-form]");
    await form.locator('input[name="email"]').fill("ivan@zavod.ru");
    await form.locator('input[name="company"]').fill("Завод");
    await form.locator('input[name="consent"]').check();
    await form.locator('button[type="submit"]').click();
    await expect(page.locator("[data-pending-only] [data-ready-heading]")).toHaveText(
      "Заявка принята. Установщик пока недоступен",
    );
    await expect(page.locator("[data-pending-only]")).toContainText("ivan@zavod.ru");
    await expect(page.locator("[data-release-only]")).toBeHidden();
  });

  test("/skachat/ keeps the data and offers a retry after a failed request", async ({ page }) => {
    let attempts = 0;
    await page.route("**/api/landing-leads", async (route) => {
      attempts += 1;
      if (attempts === 1) await route.abort("failed");
      else await route.fulfill({ body: "{}", contentType: "application/json", status: 202 });
    });
    await page.goto("/skachat/");
    await page.locator("[data-consent-reject]").click();
    const form = page.locator("form[data-lead-form]");
    await form.locator('input[name="email"]').fill("ivan@zavod.ru");
    await form.locator('input[name="company"]').fill("Завод");
    await form.locator('input[name="consent"]').check();
    await form.locator('button[type="submit"]').click();
    await expect(form.locator("[data-lead-alert]")).toBeVisible();
    await expect(form.locator('[data-label="retry"]')).toBeVisible();
    await expect(form.locator('input[name="email"]')).toHaveValue("ivan@zavod.ru");
    await form.locator('button[type="submit"]').click();
    await expect(page.locator("[data-download-ready]")).toBeVisible();
    expect(attempts).toBe(2);
  });

  test("/stoimost/ requests an invoice for the tariff chosen on a price card", async ({ page }) => {
    let payload: Record<string, unknown> | undefined;
    await page.route("**/api/landing-leads", async (route) => {
      payload = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({ body: "{}", contentType: "application/json", status: 202 });
    });
    await page.goto("/stoimost/");
    await page.locator("[data-consent-reject]").click();
    await page.locator('[data-tariff="workshop"] a[data-invoice-tariff]').click();
    const form = page.locator("form[data-lead-form]");
    await expect(form.locator('select[name="tariffCode"]')).toHaveValue("workshop");
    await expect(page).toHaveURL(/\/stoimost\/\?tarif=workshop#schet$/u);

    await form.locator('input[name="inn"]').fill("77070838");
    await form.locator('button[type="submit"]').click();
    await expect(form.locator('[data-error-for="inn"]')).toHaveText(
      "ИНН — 10 цифр для организации или 12 для ИП",
    );
    await expect(form.locator('[data-error-for="consent"]')).toHaveText(
      "Нужно согласие на обработку данных",
    );

    await form.locator('input[name="inn"]').fill("7707083893");
    await form.locator('input[name="email"]').fill("buh@zavod.ru");
    await form.locator('input[name="consent"]').check();
    await form.locator('button[type="submit"]').click();
    await expect(page.locator("[data-invoice-success]")).toContainText(
      "Счёт по тарифу «Цех» и ссылку на договор-оферту пришлём на buh@zavod.ru",
    );
    expect(payload).toMatchObject({
      intent: "invoice",
      inn: "7707083893",
      tariffCode: "workshop",
      email: "buh@zavod.ru",
      sourcePath: "/stoimost/",
    });
    expect(payload).not.toHaveProperty("company");
  });

  test("the theme switch follows the system and remembers a choice", async ({ page, isMobile }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.locator("[data-consent-reject]").click();
    if (isMobile) {
      await page.locator("[data-menu-trigger]").click();
      await page.locator('.ax-menu [data-theme-option="light"]').click();
    } else {
      await page.locator("[data-theme-toggle]").click();
      await page.locator('#ax-theme-menu [data-theme-option="light"]').click();
    }
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.goto("/stoimost/");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(page.locator('[data-tariff="line"]')).toHaveClass(/ax-plan--recommended/u);
  });
});

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

test("the download form never loads a third-party captcha runtime", async ({ page }) => {
  let captchaRequests = 0;
  await page.route("https://smartcaptcha.cloud.yandex.ru/captcha.js", async (route) => {
    captchaRequests += 1;
    await route.fulfill({
      body: "window.smartCaptcha = { reset() {} };",
      contentType: "application/javascript",
      status: 200,
    });
  });

  await page.goto("/skachat/", { waitUntil: "networkidle" });
  expect(captchaRequests).toBe(0);
  await expect(
    page.locator('script[src="https://smartcaptcha.cloud.yandex.ru/captcha.js"]'),
  ).toHaveCount(0);

  await page.locator('[data-lead-form] input[name="email"]').focus();
  await expect(page.locator(".smart-captcha")).toHaveCount(0);
  await page.locator('[data-lead-form] input[name="company"]').focus();
  await page.waitForTimeout(200);
  expect(captchaRequests).toBe(0);
});

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

test("article hero keeps a clear heading hierarchy", async ({ page }) => {
  await page.goto("/stati/agregatsiya-piva-v-koroba/");
  const sizes = await page.evaluate(() => ({
    heading: Number.parseFloat(
      getComputedStyle(document.querySelector(".article-hero h1")!).fontSize,
    ),
    lead: Number.parseFloat(
      getComputedStyle(document.querySelector(".article-hero__lead")!).fontSize,
    ),
  }));

  expect(sizes.heading).toBeGreaterThanOrEqual(42);
  expect(sizes.heading).toBeGreaterThan(sizes.lead * 1.5);
});

for (const [route, wordmark, headerTheme, footerTheme] of [
  ["/", "маркиро", "light", "light"],
  ["/en/", "MARKIRO", "light", "dark"],
  ["/sscc-i-agregatsiya/", "маркиро", "dark", "dark"],
  ["/en/sscc-and-aggregation/", "MARKIRO", "dark", "dark"],
] as const) {
  test(`${route} renders the localized exact brand in its header and footer`, async ({ page }) => {
    await page.goto(route);
    for (const [brand, theme] of [
      [page.locator("header .brand-mark"), headerTheme],
      [page.locator("footer .brand-mark"), footerTheme],
    ] as const) {
      const colors = BRAND_COLORS[theme];
      await expect(brand.locator(".brand-mark__word")).toHaveText(wordmark);
      await expect(brand.locator("[data-brand-module]")).toHaveCount(8);
      expect(
        await brand.locator("[data-brand-module]").evaluateAll((modules) =>
          modules.map((module) => {
            const style = getComputedStyle(module);
            return {
              x: module.getAttribute("x"),
              y: module.getAttribute("y"),
              width: module.getAttribute("width"),
              height: module.getAttribute("height"),
              color: style.fill,
            };
          }),
        ),
      ).toEqual(
        MARKIRO_MODULE_LAYOUT.map(({ x, y, accent }) => ({
          x,
          y,
          width: "8",
          height: "8",
          color: accent ? colors.accent : colors.module,
        })),
      );
      expect(
        await brand.locator(".brand-mark__tile").evaluate((tile) => getComputedStyle(tile).fill),
      ).toBe(colors.tile);
      await expect(brand.locator("[data-brand-accent]")).toHaveCount(1);
      await expect(brand.locator("[data-brand-accent]")).toHaveAttribute("x", "26");
      await expect(brand.locator("[data-brand-accent]")).toHaveAttribute("y", "42");
    }
  });
}

test("/ renders the public contact phone", async ({ page }) => {
  await page.goto("/");
  const expectedHref = "tel:+79604954610";
  expect(
    await page
      .locator(`a[href="${expectedHref}"][data-analytics="landing_phone_click"]`)
      .evaluateAll((links) => links.map((link) => (link as HTMLElement).dataset.placement).sort()),
  ).toEqual(["final", "header", "header_mobile", "menu"]);
  const final = page.locator("#demo").getByRole("link", { name: "+7 960 495-46-10", exact: true });
  await expect(final).toBeVisible();
  await expect(final).toHaveAttribute("href", expectedHref);
});

test("/en/ renders the public contact phone", async ({ page }) => {
  await page.goto("/en/");
  const expectedHref = "tel:+79604954610";
  expect(
    await page
      .locator(`a[href="${expectedHref}"][data-analytics="landing_phone_click"]`)
      .evaluateAll((links) => links.map((link) => (link as HTMLElement).dataset.placement).sort()),
  ).toEqual(["final", "header", "header_mobile", "menu"]);
  const final = page.locator("#demo").getByRole("link", { name: "+7 960 495-46-10", exact: true });
  await expect(final).toBeVisible();
  await expect(final).toHaveAttribute("href", expectedHref);
});

test("language switch connects exact page counterparts", async ({ page }) => {
  await page.goto("/en/offline-production/");
  const menuTrigger = page.locator("[data-menu-trigger]");
  if (await menuTrigger.isVisible()) await menuTrigger.click();

  // English pages also mark their links to the Russian-only download page with hreflang.
  const languages = page.locator(".language-switch");
  await expect(languages.locator('a[hreflang="ru"]')).toHaveAttribute("href", "/oflayn-rabota/");
  await expect(languages.locator('a[hreflang="en"]')).toHaveAttribute(
    "href",
    "/en/offline-production/",
  );
  await expect(languages.locator('a[hreflang="en"]')).toHaveAttribute("aria-current", "page");
});

for (const [route, counterpart, registry] of [
  ["/privacy/", "/en/privacy/", "/legal/"],
  ["/en/privacy/", "/privacy/", "/en/legal/"],
] as const) {
  test(`${route} exposes legal navigation, anchors, and no captcha runtime`, async ({ page }) => {
    await page.goto(route);
    const menuTrigger = page.locator("[data-menu-trigger]");
    if (await menuTrigger.isVisible()) await menuTrigger.click();

    await expect(page.locator(`header .language-switch a[href="${counterpart}"]`)).toBeVisible();
    await expect(page.locator(`a.legal-backlink[href="${registry}"]`)).toBeVisible();
    await page.locator('.legal-toc a[href="#general"]').click();
    await expect(page.locator("#general")).toBeInViewport();
    await expect(
      page.locator('script[src="https://smartcaptcha.cloud.yandex.ru/captcha.js"]'),
    ).toHaveCount(0);

    await page.keyboard.press("Tab");
    await page.locator("a.legal-backlink").focus();
    await expect(page.locator("a.legal-backlink")).toBeFocused();
    expect(
      await page.locator("a.legal-backlink").evaluate((element) => {
        const style = getComputedStyle(element);
        return (
          element.matches(":focus-visible") &&
          (style.outlineStyle !== "none" || style.boxShadow !== "none")
        );
      }),
    ).toBe(true);
  });
}

for (const [route, terms] of [
  ["/privacy/", ["Персональные данные", "Обработка", "Тенант"]],
  ["/en/privacy/", ["Personal data", "Processing", "Tenant"]],
] as const) {
  test(`${route} keeps definition terms and em dashes on one aligned row`, async ({ page }) => {
    await page.goto(route);
    const rows = page.locator(".legal-definitions > div");
    await expect(rows).toHaveCount(terms.length);
    // Each entry is one run-in paragraph: the term and its dash end on the row where the
    // definition's first line starts, so compare line boxes, not the wrapped elements' boxes.
    const lineBox = (selector: string, line: "first" | "last", index: number) =>
      rows
        .nth(index)
        .locator(selector)
        .evaluate((element, which) => {
          const lines = [...element.getClientRects()];
          const rect = which === "first" ? lines[0] : lines.at(-1);
          return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
        }, line);
    for (const [index, term] of terms.entries()) {
      await expect(rows.nth(index).locator("dt")).toHaveText(`${term} —`);
      const definitionLine = await lineBox("dd", "first", index);
      const termLine = await lineBox("dt", "last", index);
      if (!definitionLine || !termLine) throw new Error(`Missing definition geometry for ${term}`);
      expect(definitionLine.x).toBeGreaterThanOrEqual(termLine.x + termLine.width - 1);
      expect(definitionLine.y).toBeLessThan(termLine.y + termLine.height);
      expect(termLine.y).toBeLessThan(definitionLine.y + definitionLine.height);
    }
  });
}

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
  await expect((await request.get("/sitemap.xml")).text()).resolves.toContain(
    "https://markiro.app/privacy/",
  );
  await expect((await request.get("/sitemap.xml")).text()).resolves.toContain(
    "https://markiro.app/stati/agregatsiya-piva-v-koroba/",
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

test("every manifest artifact downloads with its released size and media type", async ({
  page,
  request,
}) => {
  const declaredMediaTypes = new Map<string, string>();
  for (const registry of ["/legal/", "/en/legal/"]) {
    await page.goto(registry);
    for (const link of await page.locator("a[download][type]").evaluateAll((anchors) =>
      anchors.map((anchor) => ({
        fileName: anchor.getAttribute("download") ?? "",
        mediaType: anchor.getAttribute("type") ?? "",
      })),
    )) {
      declaredMediaTypes.set(link.fileName, link.mediaType);
    }
  }

  for (const artifact of legalArtifacts) {
    const response = await request.get(`/legal/files/${artifact.fileName}`);
    expect(response.status(), artifact.fileName).toBe(200);
    expect(declaredMediaTypes.get(artifact.fileName), artifact.fileName).toBe(artifact.mediaType);
    const responseMediaType = response.headers()["content-type"];
    if (responseMediaType) {
      expect(responseMediaType, artifact.fileName).toContain(artifact.mediaType);
    } else {
      expect(artifact.fileName, "Astro preview omits MIME only for DOCX static files").toMatch(
        /\.docx$/,
      );
    }
    const bytes = await response.body();
    expect(bytes.byteLength, artifact.fileName).toBe(artifact.bytes);
    expect(bytes.byteLength, artifact.fileName).toBeGreaterThan(0);
    expect(bytes.byteLength, artifact.fileName).toBeLessThanOrEqual(5 * 1024 * 1024);
  }
});

for (const route of verificationRoutes) {
  test(`${route} exposes bilingual verification and bounded downloads`, async ({
    page,
    baseURL,
  }) => {
    await page.goto(route);
    await expect(page.locator("[data-document-id]")).toContainText(route.split("/")[2]!);
    await expect(page.locator("h1")).toContainText("Проверка документа");
    await expect(page.locator("h1")).toContainText("Document verification");
    await expect(page.locator("[data-document-datamatrix] svg")).toHaveCount(2);
    await expect(page.locator('a[download$=".pdf"]')).toHaveCount(2);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      `https://markiro.app${route}`,
    );
    expect(page.url()).toBe(new URL(route, baseURL).href);
    for (const matrix of await page.locator("[data-document-datamatrix]").evaluateAll((nodes) =>
      nodes.map((node) => {
        const symbol = node.querySelector("svg");
        const wrapper = node.getBoundingClientRect();
        const symbolRect = symbol?.getBoundingClientRect();
        return {
          payload: node.getAttribute("data-document-datamatrix"),
          symbolWidth: symbolRect?.width ?? 0,
          wrapperWidth: wrapper.width,
        };
      }),
    )) {
      expect(matrix.payload).toBe(`https://markiro.app${route}`);
      expect(matrix.symbolWidth).toBeGreaterThan(43);
      expect(matrix.symbolWidth).toBeLessThan(44);
      expect(matrix.wrapperWidth).toBeGreaterThan(matrix.symbolWidth);
    }
  });
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "Pixel 7", width: 412, height: 915 },
] as const) {
  test(`${viewport.name} keeps legal cards and footer aligned`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/legal/");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const footerMeta = page.locator("[data-footer-meta]");
    await expect(footerMeta.locator("[data-footer-year]")).toBeVisible();
    const metaBox = await footerMeta.boundingBox();
    const yearBox = await footerMeta.locator("[data-footer-year]").boundingBox();
    expect(metaBox).not.toBeNull();
    expect(yearBox).not.toBeNull();
    expect(yearBox!.x).toBeGreaterThanOrEqual(metaBox!.x);
    expect(yearBox!.x + yearBox!.width).toBeLessThanOrEqual(metaBox!.x + metaBox!.width + 1);

    const firstCard = page.locator("[data-legal-artifact-card]").first();
    await expect(firstCard.locator("[data-artifact-digest-row] button")).toBeVisible();
    await firstCard.locator("[data-artifact-digest-row] button").focus();
    await expect(firstCard.locator("[data-artifact-digest-row] button")).toBeFocused();
  });
}

for (const route of ["/d/mkr-pd-01/2026.08/01/15.08.2026", "/d/MKR-PD-01/2026.08/01/not-a-date"]) {
  test(`${route} returns the bounded branded verification 404`, async ({ page }) => {
    const response = await page.goto(route);
    expect(response?.status()).toBe(404);
    await expect(page.locator("h1")).toContainText("Revision not found");
    const body = await page.locator("body").innerText();
    expect(body.length).toBeLessThan(5_000);
    expect(body).not.toContain("MKR-PD-02");
    expect(body).not.toContain(".pdf");
    expect(body).not.toContain("artifacts.json");
  });
}

test.describe("home page", () => {
  test("cookie panel buttons keep readable hover colors on the light home", async ({ page }) => {
    await page.goto("/");
    const panel = page.locator("[data-consent-panel]");
    await expect(panel).toBeVisible();

    const reject = page.locator("[data-consent-reject]");
    await reject.hover();
    // The resting background is already transparent, so polling it alone could pass before the
    // hover style actually applied. Poll the border color (which only changes on hover) first to
    // synchronize on the hover state, then assert the background it implies.
    await expect
      .poll(() => reject.evaluate((element) => getComputedStyle(element).borderTopColor))
      .toBe("rgb(142, 139, 131)");
    await expect
      .poll(() => reject.evaluate((element) => getComputedStyle(element).backgroundColor))
      .toBe("rgba(0, 0, 0, 0)");

    const accept = page.locator("[data-consent-accept]");
    await accept.hover();
    await expect
      .poll(() => accept.evaluate((element) => getComputedStyle(element).backgroundColor))
      .toBe("rgb(107, 229, 153)");
  });

  test("loads no 3D code", async ({ page, baseURL }) => {
    // Three.js could only ship in our own bundles. Third-party scripts such as the
    // captcha the call form loads near the bottom are out of scope. A lazily loaded
    // chunk can also arrive twice (modulepreload, then import), and CDP keeps the body
    // of only one copy, so every script URL the page loaded is fetched again here.
    expect(baseURL).toBeDefined();
    const origin = new URL(baseURL ?? "").origin;
    for (const route of ["/", "/en/"]) {
      const scripts = new Set<string>();
      const collect = (response: Response) => {
        if (response.request().resourceType() !== "script") return;
        if (new URL(response.url()).origin !== origin) return;
        scripts.add(response.url());
      };
      page.on("response", collect);
      await page.goto(route, { waitUntil: "networkidle" });
      await page.evaluate(() =>
        window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" }),
      );
      await page.waitForLoadState("networkidle");
      page.off("response", collect);
      expect(scripts.size, route).toBeGreaterThan(0);
      for (const url of scripts) {
        const response = await page.request.get(url);
        expect(response.ok(), url).toBe(true);
        expect(await response.text(), `${route} ${url}`).not.toContain("WebGLRenderer");
      }
    }
  });

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 412, height: 915 },
    { width: 1440, height: 900 },
  ] as const) {
    test(`fits ${viewport.width} px without horizontal scrolling`, async ({ page }) => {
      await page.setViewportSize(viewport);
      for (const route of ["/", "/skachat/", "/stoimost/", "/en/"]) {
        await page.goto(route, { waitUntil: "networkidle" });
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          route,
        ).toBe(true);
      }
    });
  }
});

test.describe("document pages", () => {
  test("page and section titles render at heading size", async ({ page }) => {
    for (const [route, selector, minimum] of [
      ["/stati/", "h1", 40],
      ["/instruktsii/stantsiya-vkhod-i-start-smeny/", "h1", 40],
      ["/instruktsii/stantsiya-vkhod-i-start-smeny/", ".legal-document h2", 24],
    ] as const) {
      await page.goto(route);
      const size = await page
        .locator(selector)
        .first()
        .evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
      expect(size, `${route} ${selector}`).toBeGreaterThanOrEqual(minimum);
    }
  });

  test("the release card keeps its padding and answers wrap to the left edge", async ({ page }) => {
    await page.goto("/instruktsii/stantsiya-vkhod-i-start-smeny/");
    const padding = await page.locator("section.legal-artifacts").evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft];
    });
    for (const side of padding) expect(parseFloat(side)).toBeGreaterThanOrEqual(16);

    const entries = await page.locator(".legal-definitions > div").evaluateAll((items) =>
      items.map((item) => ({
        left: Math.round(item.getBoundingClientRect().left),
        wrapped: [...(item.querySelector("dd")?.getClientRects() ?? [])]
          .slice(1)
          .map((rect) => Math.round(rect.left)),
      })),
    );
    expect(entries.some((entry) => entry.wrapped.length > 0)).toBe(true);
    for (const entry of entries) for (const left of entry.wrapped) expect(left).toBe(entry.left);
  });
});

test.describe("header", () => {
  // The suite builds with PUBLIC_PHONE set, so the header carries the phone link. At every width
  // either the whole navigation fits on one line or the header folds it into the menu: nothing is
  // cut off and no link or button breaks onto a second line.
  const problems = (page: Page) =>
    page.locator("[data-header]").evaluate((header) => {
      const edge = header.getBoundingClientRect();
      const shown = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return (
          rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden"
        );
      };
      const label = (element: Element) => element.textContent?.trim() || element.className;
      const cutOff = [...header.querySelectorAll("a, button, .language-switch")]
        .filter(shown)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const past = Math.max(
            edge.left - rect.left,
            rect.right - edge.right,
            rect.right - innerWidth,
          );
          return { label: label(element), past: Math.round(past) };
        })
        .filter((item) => item.past > 0);
      const wrapped = [
        ...header.querySelectorAll(
          ".landing-nav a, .landing-header__cta, .ax-nav a, .ax-header__cta > span:first-child",
        ),
      ]
        .filter(shown)
        .filter((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          const tops = [...range.getClientRects()].map((rect) => rect.top);
          return tops.length > 0 && Math.max(...tops) - Math.min(...tops) > 4;
        })
        .map(label);
      return { cutOff, wrapped };
    });

  // 768-880 px fold into the menu; 1024 px is the narrowest width that shows the whole row and
  // 1200 px the first one with the full spacing.
  for (const width of [768, 800, 840, 880, 1024, 1200] as const) {
    test(`fits ${width} px with the phone number on light and dark pages`, async ({
      page,
      isMobile,
    }) => {
      test.skip(isMobile, "the width is set explicitly, one project covers it");
      await page.setViewportSize({ width, height: 900 });
      for (const route of [
        "/",
        "/stoimost/",
        "/en/",
        "/markirovka-chestny-znak/",
        "/en/chestny-znak-serialization/",
      ]) {
        await page.goto(route);
        const phone = page.locator('[data-header] a[href^="tel:"][data-placement="header"]');
        await expect(phone, route).toHaveCount(1);
        expect(await problems(page), `${route} at ${width} px`).toEqual({
          cutOff: [],
          wrapped: [],
        });
        const trigger = page.locator("[data-menu-trigger]");
        if (await trigger.isVisible()) {
          await trigger.click();
          // The standalone header shows the number as a call button and in the menu.
          await expect(
            page.locator('[data-header] a[href^="tel:"]:visible').first(),
            `${route} at ${width} px, menu open`,
          ).toBeVisible();
          expect(await problems(page), `${route} at ${width} px, menu open`).toEqual({
            cutOff: [],
            wrapped: [],
          });
        }
      }
    });
  }
});

for (const code of ["start", "line", "workshop"]) {
  test(`V4 ${code}: tariff trial and invoice preserve context through validation and retry`, async ({
    page,
  }) => {
    const requests: Record<string, unknown>[] = [];
    let rateLimit = true;
    await page.route("**/api/landing-leads", async (route) => {
      requests.push(route.request().postDataJSON() as Record<string, unknown>);
      if (rateLimit) {
        rateLimit = false;
        await route.fulfill({
          status: 429,
          contentType: "application/json",
          body: JSON.stringify({ code: "rate_limited" }),
        });
      } else
        await route.fulfill({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify({ accepted: true }),
        });
    });
    await page.goto("/stoimost/");
    await page.locator("[data-consent-reject]").click();
    await page
      .locator(`[data-tariff="${code}"] a[data-analytics="landing_download_click"]`)
      .click();
    await expect(page).toHaveURL(new RegExp(`/skachat/\\?tariff=${code}$`));
    const form = page.locator("[data-lead-form]");
    await expect(form.locator('[name="tariffCode"]')).toHaveValue(code);
    await form.locator('[name="email"]').fill("buyer@example.test");
    await form.locator('[name="company"]').fill("Производство");
    await form.locator('[type="submit"]').click();
    expect(requests).toHaveLength(0);
    await expect(form.locator('[data-error-for="consent"]')).not.toBeEmpty();
    await form.locator('[name="consent"]').check();
    await form.locator('[type="submit"]').click();
    await expect(form.locator("[data-form-status]")).toContainText("Слишком много");
    await form.locator('[type="submit"]').click();
    await expect(page.locator("[data-release-only]")).toBeVisible();
    expect(requests).toHaveLength(2);
    expect(requests[0]?.requestId).toBe(requests[1]?.requestId);
    for (const payload of requests)
      expect(payload).toMatchObject({ intent: "download", tariffCode: code });
    await page.goto(`/stoimost/?tarif=${code}#schet`);
    const invoice = page.locator("[data-lead-form]");
    await expect(invoice.locator('[name="tariffCode"]')).toHaveValue(code);
    await invoice.locator('[name="inn"]').fill("7707083893");
    await invoice.locator('[name="email"]').fill("billing@example.test");
    await invoice.locator('[name="consent"]').check();
    await invoice.locator('[type="submit"]').click();
    await expect(page.locator("[data-invoice-success]")).toBeVisible();
    expect(requests.at(-1)).toMatchObject({
      intent: "invoice",
      tariffCode: code,
      inn: "7707083893",
    });
  });
}

test("V4 direct and invalid tariff entry keep download available without inventing a selection", async ({
  page,
}) => {
  for (const search of ["", "?tariff=not-a-tariff"]) {
    await page.goto("/skachat/" + search);
    await expect(page.locator("[data-download-tariff]")).toHaveValue("");
    await expect(page.locator("[data-selected-tariff]")).toBeHidden();
    await expect(page.locator("[data-lead-fields]")).toBeEnabled();
  }
});

test("V4 missing release can be rechecked without creating another lead", async ({ page }) => {
  let available = false,
    leads = 0;
  await page.route("https://releases.markiro.app/standalone/stable/latest.json", (route) =>
    route.fulfill(
      available
        ? {
            status: 200,
            contentType: "application/json",
            headers: { "access-control-allow-origin": "*" },
            body: JSON.stringify(LATEST_RELEASE),
          }
        : { status: 404, headers: { "access-control-allow-origin": "*" }, body: "" },
    ),
  );
  await page.route("**/api/landing-leads", (route) => {
    leads++;
    return route.fulfill({
      status: 202,
      contentType: "application/json",
      body: '{"accepted":true}',
    });
  });
  await page.goto("/skachat/?tariff=line");
  await page.locator("[data-consent-reject]").click();
  await page.locator('[name="email"]').fill("buyer@example.test");
  await page.locator('[name="company"]').fill("Производство");
  await page.locator('[name="consent"]').check();
  await page.locator('[type="submit"]').click();
  await expect(page.locator("[data-pending-only]")).toBeVisible();
  available = true;
  await page.locator("[data-release-retry]").click();
  await expect(page.locator("[data-release-only]")).toBeVisible();
  expect(leads).toBe(1);
});

test("V4 email link opens the public installer without another form or accepted-lead claim", async ({
  page,
}) => {
  let leads = 0;
  await page.route("**/api/landing-leads", (route) => {
    leads++;
    return route.abort();
  });
  await page.goto("/skachat/?installer=1&tariff=line");
  await expect(page.locator("[data-release-only]")).toBeVisible();
  await expect(page.locator("[data-download-start]")).toBeHidden();
  expect(await page.locator("[data-download-ready]").innerText()).not.toContain(
    "поставлено в очередь",
  );
  await expect(page.locator("[data-release-link]")).toHaveAttribute(
    "href",
    LATEST_RELEASE.installer.url,
  );
  expect(leads).toBe(0);
});

test("V4 changed email after a lost response is a new request", async ({ page }) => {
  const requests: Record<string, unknown>[] = [];
  await page.route("**/api/landing-leads", async (route) => {
    requests.push(route.request().postDataJSON() as Record<string, unknown>);
    if (requests.length === 1) await route.abort("failed");
    else
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: '{"accepted":true}',
      });
  });
  await page.goto("/skachat/?tariff=line");
  await page.locator("[data-consent-reject]").click();
  await page.locator('[name="email"]').fill("old@example.test");
  await page.locator('[name="company"]').fill("Производство");
  await page.locator('[name="consent"]').check();
  await page.locator('[type="submit"]').click();
  await expect(page.locator("[data-lead-alert]")).toBeVisible();
  await page.locator('[name="email"]').fill("corrected@example.test");
  await page.locator('[type="submit"]').click();
  await expect(page.locator("[data-release-only]")).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[0]?.requestId).not.toBe(requests[1]?.requestId);
  expect(requests[1]?.email).toBe("corrected@example.test");
});

test("V4 editing email during a slow manifest keeps the form open", async ({ page }) => {
  let release: () => void = () => {};
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("https://releases.markiro.app/standalone/stable/latest.json", async (route) => {
    await wait;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(LATEST_RELEASE),
    });
  });
  await page.route("**/api/landing-leads", (route) =>
    route.fulfill({ status: 202, contentType: "application/json", body: '{"accepted":true}' }),
  );
  await page.goto("/skachat/");
  await page.locator("[data-consent-reject]").click();
  await page.locator('[name="email"]').fill("old@example.test");
  await page.locator('[name="company"]').fill("Производство");
  await page.locator('[name="consent"]').check();
  await page.locator('[type="submit"]').click();
  await expect(page.locator("[data-loading-only]")).toBeVisible();
  await page.locator("[data-change-email]").click();
  release();
  await expect(page.locator("[data-download-start]")).toBeVisible();
  await expect(page.locator('[name="email"]')).toBeFocused();
  await expect(page.locator('[name="consent"]')).not.toBeChecked();
  await page.locator('[name="email"]').fill("corrected@example.test");
  await page.locator('[name="consent"]').check();
  await page.locator('[type="submit"]').click();
  await expect(page.locator("[data-release-only]")).toBeVisible();
  await expect(page.locator("[data-release-only] [data-ready-email]")).toHaveText(
    "corrected@example.test",
  );
});
