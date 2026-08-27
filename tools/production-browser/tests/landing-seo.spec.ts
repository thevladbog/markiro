import { expect, test } from "@playwright/test";
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

test.beforeEach(async ({ page }) => {
  await page.route("https://smartcaptcha.cloud.yandex.ru/captcha.js", async (route) => {
    await route.fulfill({
      body: "window.smartCaptcha = { reset() {} };",
      contentType: "application/javascript",
      status: 200,
    });
  });
});

const routes = [
  "/",
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
  "/kiosk-samovydachi/",
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
  "/en/self-service-pickup-kiosk/",
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
  { x: "14", y: "14", color: "rgb(19, 18, 22)" },
  { x: "14", y: "26", color: "rgb(19, 18, 22)" },
  { x: "14", y: "38", color: "rgb(19, 18, 22)" },
  { x: "26", y: "22", color: "rgb(19, 18, 22)" },
  { x: "38", y: "14", color: "rgb(19, 18, 22)" },
  { x: "38", y: "26", color: "rgb(19, 18, 22)" },
  { x: "38", y: "38", color: "rgb(19, 18, 22)" },
  { x: "26", y: "42", color: "rgb(61, 220, 122)" },
];

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

test("a successful demo request emits one submit attempt and one lead event", async ({ page }) => {
  await page.route("https://www.googletagmanager.com/**", async (route) => {
    await route.fulfill({ body: "", contentType: "application/javascript", status: 200 });
  });
  await page.route("**/api/demo-requests", async (route) => {
    const request = route.request().postDataJSON() as { requestId?: string };
    await route.fulfill({
      body: JSON.stringify({ accepted: true, requestId: request.requestId }),
      contentType: "application/json",
      status: 202,
    });
  });

  await page.goto("/");
  await page.locator("[data-consent-accept]").click();
  const form = page.locator("[data-demo-form]");
  await form.evaluate((element) => {
    const token = document.createElement("input");
    token.name = "smart-token";
    token.type = "hidden";
    element.append(token);
  });
  await form.locator('input[name="name"]').fill("Анна");
  await form.locator('input[name="company"]').fill("Завод Север");
  await form.locator('input[name="email"]').fill("anna@example.test");
  await form.locator('input[name="consent"]').check();
  await form.locator('input[name="smart-token"]').evaluate((input) => {
    (input as HTMLInputElement).value = "captcha-token";
  });
  await form.locator('button[type="submit"]').click();
  await expect(page.locator("[data-demo-success]")).toBeVisible();

  expect(
    await page.evaluate(() => {
      const layer = (window as Window & { dataLayer?: unknown[] }).dataLayer ?? [];
      return layer
        .filter(
          (item): item is Record<string, unknown> =>
            typeof item === "object" && item !== null && "event" in item,
        )
        .map((item) => item.event)
        .filter((event) => event === "landing_form_submit" || event === "landing_form_success");
    }),
  ).toEqual(["landing_form_submit", "landing_form_success"]);
});

const demoCases = [
  {
    company: "Завод Север",
    consent:
      "Даю согласие на обработку персональных данных на условиях согласия и подтверждаю, что ознакомился с политикой обработки персональных данных.",
    emailInput: " ANNA@EXAMPLE.TEST ",
    expectedPayload: {
      captchaToken: "ru-captcha-token",
      company: "Завод Север",
      consentVersion: "MKR-PD-02/2026.08/01",
      email: "anna@example.test",
      locale: "ru",
      name: "Анна",
      phone: "+79991234567",
      requestId: "11111111-1111-4111-8111-111111111111",
      sourcePath: "/",
      website: "",
    },
    name: "Анна",
    path: "/",
    phone: "8 (999) 123-45-67",
    success: "Запрос получили",
    token: "ru-captcha-token",
  },
  {
    company: "Factory",
    consent:
      "I consent to the processing of my personal data under the personal-data consent and confirm that I have read the personal-data processing policy.",
    emailInput: " ADA@EXAMPLE.TEST ",
    expectedPayload: {
      captchaToken: "en-captcha-token",
      company: "Factory",
      consentVersion: "MKR-PD-02/2026.08/01",
      email: "ada@example.test",
      locale: "en",
      name: "Ada",
      requestId: "22222222-2222-4222-8222-222222222222",
      sourcePath: "/en/",
      website: "",
    },
    name: "Ada",
    path: "/en/",
    phone: "",
    success: "Request received",
    token: "en-captcha-token",
  },
] as const;

for (const demoCase of demoCases) {
  test(`${demoCase.path} submits the exact localized demo request`, async ({ page }) => {
    await page.addInitScript((requestId) => {
      Object.defineProperty(window.crypto, "randomUUID", { value: () => requestId });
    }, demoCase.expectedPayload.requestId);

    let requestPayload: unknown;
    await page.route("**/api/demo-requests", async (route) => {
      requestPayload = route.request().postDataJSON();
      await route.fulfill({
        body: JSON.stringify({ accepted: true, requestId: demoCase.expectedPayload.requestId }),
        contentType: "application/json",
        status: 202,
      });
    });

    await page.goto(demoCase.path);
    const form = page.locator("form[data-demo-form]");
    await expect(form.locator('label[for="consent"]')).toHaveText(demoCase.consent);
    await form.locator('input[name="name"]').fill(demoCase.name);
    await form.locator('input[name="company"]').fill(demoCase.company);
    await form.locator('input[name="email"]').fill(demoCase.emailInput);
    if (demoCase.phone.length > 0) {
      await form.locator('input[name="phone"]').fill(demoCase.phone);
    }
    await form.locator('input[name="consent"]').check();
    await form.evaluate((element, token) => {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = "smart-token";
      input.value = token;
      element.append(input);
    }, demoCase.token);
    await form.locator('button[type="submit"]').click();

    await expect(page.locator("[data-demo-success]")).toContainText(demoCase.success);
    expect(requestPayload).toEqual(demoCase.expectedPayload);
  });
}

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
              x: module.getAttribute("x"),
              y: module.getAttribute("y"),
              width: module.getAttribute("width"),
              height: module.getAttribute("height"),
              color: style.fill,
            };
          }),
        ),
      ).toEqual(
        MARKIRO_MODULE_LAYOUT.map(({ x, y, color }) => ({
          x,
          y,
          width: "8",
          height: "8",
          color,
        })),
      );
      expect(
        await brand.locator(".brand-mark__tile").evaluate((tile) => getComputedStyle(tile).fill),
      ).toBe("rgb(250, 250, 248)");
      await expect(brand.locator("[data-brand-accent]")).toHaveCount(1);
      await expect(brand.locator("[data-brand-accent]")).toHaveAttribute("x", "26");
      await expect(brand.locator("[data-brand-accent]")).toHaveAttribute("y", "42");
    }
  });
}

for (const route of ["/", "/en/"] as const) {
  test(`${route} renders the public contact phone`, async ({ page }) => {
    await page.goto(route);
    const expectedPhone = "+7 934 355-14-90";
    const expectedHref = "tel:+79343551490";

    await expect(page.locator(`a[href="${expectedHref}"]`)).toHaveCount(3);
    expect(
      await page
        .locator(`a[href="${expectedHref}"][data-analytics="landing_phone_click"]`)
        .evaluateAll((links) =>
          links.map((link) => (link as HTMLElement).dataset.placement).sort(),
        ),
    ).toEqual(["demo", "header", "hero"]);
    for (const phone of [
      page.locator("#hero").getByRole("link", { name: expectedPhone, exact: true }),
      page.locator("#demo").getByRole("link", { name: expectedPhone, exact: true }),
    ]) {
      await expect(phone).toBeVisible();
      await expect(phone).toHaveAttribute("href", expectedHref);
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
    for (const [index, term] of terms.entries()) {
      await expect(rows.nth(index).locator("dt")).toHaveText(`${term} —`);
      const definitionBox = await rows.nth(index).locator("dd").boundingBox();
      const termBox = await rows.nth(index).locator("dt").boundingBox();
      expect(definitionBox).not.toBeNull();
      expect(termBox).not.toBeNull();
      if (!definitionBox || !termBox) throw new Error(`Missing definition geometry for ${term}`);
      expect(definitionBox.x).toBeGreaterThanOrEqual(termBox.x + termBox.width - 1);
      expect(definitionBox.y).toBeLessThan(termBox.y + termBox.height);
      expect(termBox.y).toBeLessThan(definitionBox.y + definitionBox.height);
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
  test(`${route} exposes bilingual verification and bounded downloads`, async ({ page }) => {
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
    expect(page.url()).toBe(`http://127.0.0.1:5473${route}`);
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
