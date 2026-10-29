import { expect, test } from "@playwright/test";

const routes = [
  { path: "/legal/", copiedLabel: "Скопировано" },
  {
    path: "/d/MKR-PD-01/2026.08/01/15.08.2026",
    copiedLabel: "Скопировано",
  },
] as const;

for (const route of routes) {
  test(`${route.path} keeps legal controls executable under the production CSP`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));

    const response = await page.goto(route.path, { waitUntil: "networkidle" });
    expect(response?.status()).toBe(200);
    expect(response?.headers()["content-security-policy"]).toContain("script-src 'self'");

    const copyButton = page.locator("[data-copy-artifact]").first();
    await expect(copyButton).toBeVisible();
    await copyButton.click();
    await expect(copyButton).toHaveText(route.copiedLabel);
    expect(errors).toEqual([]);
  });
}

const legacyRedirects = new Map([
  ["/d/MKR-PD-01/2026.08.01/2026-08-15", "/d/MKR-PD-01/2026.08/01/15.08.2026"],
  ["/d/MKR-PD-02/2026.08.01/2026-08-15", "/d/MKR-PD-02/2026.08/01/15.08.2026"],
  ["/d/MKR-DPA-01/2026.08.01/2026-08-15", "/d/MKR-DPA-01/2026.08/01/15.08.2026"],
  ["/d/MKR-BRD-01/2026.08.01/2026-08-15", "/d/MKR-BRD-01/2026.08/01/15.08.2026"],
]);

test("production Caddy exposes only the four bounded legacy redirects", async ({ request }) => {
  for (const [legacyPath, target] of legacyRedirects) {
    const response = await request.get(legacyPath, { maxRedirects: 0 });
    expect(response.status(), legacyPath).toBe(308);
    expect(response.headers().location, legacyPath).toBe(target);
  }
});

for (const malformed of [
  "/d/MKR-PD-01/2026.08.01",
  "/d/mkr-pd-01/2026.08.01/2026-08-15",
  "/d/MKR-PD-01/2026.08.01/2026-08-15/extra",
  "/d/MKR-PD-99/2026.08.01/2026-08-15",
  "/d/mkr-pd-01/2026.08/01/15.08.2026",
  "/d/MKR-PD-01/2026.08/01/not-a-date",
]) {
  test(`${malformed} remains a bounded branded 404 through production Caddy`, async ({ page }) => {
    const response = await page.goto(malformed);
    expect(response?.status()).toBe(404);
    await expect(page.locator("h1")).toContainText("Revision not found");
    const body = await page.locator("body").innerText();
    expect(body.length).toBeLessThan(5_000);
    expect(body).not.toContain("MKR-PD-02");
    expect(body).not.toContain("artifacts.json");
  });
}

const canonicalRedirects = new Map([
  ["/faq", "/faq/"],
  ["/faq?utm_source=test&ysclid=1", "/faq/?utm_source=test&ysclid=1"],
  ["/index.html", "/"],
  ["/faq/index.html", "/faq/"],
  ["/stati", "/stati/"],
  ["/d/MKR-PD-01/2026.08/01/15.08.2026/", "/d/MKR-PD-01/2026.08/01/15.08.2026"],
]);

test("production Caddy redirects URL variants to their canonical form and keeps the query", async ({
  request,
}) => {
  for (const [variant, target] of canonicalRedirects) {
    const response = await request.get(variant, { maxRedirects: 0 });
    expect(response.status(), variant).toBe(308);
    expect(response.headers().location, variant).toBe(target);
    expect(response.headers()["content-security-policy"], variant).toContain("script-src 'self'");
  }
  for (const canonical of ["/faq/", "/stati/", "/d/MKR-PD-01/2026.08/01/15.08.2026"]) {
    const response = await request.get(canonical, { maxRedirects: 0 });
    expect(response.status(), canonical).toBe(200);
  }
});

test("production Caddy caches static images and manifests for a day", async ({ request }) => {
  for (const path of [
    "/og-markiro.jpg",
    "/favicon.svg",
    "/site.webmanifest",
    "/brand/markiro-logo.svg",
  ]) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);
    expect(response.headers()["cache-control"], path).toBe("public, max-age=86400");
  }
  const document = await request.get("/faq/");
  expect(document.headers()["cache-control"]).toBe("no-cache");
});

test("production Caddy serves markdown mirrors and the full text as noindex agent surfaces", async ({
  request,
}) => {
  const markdown = await request.get("/faq.md");
  expect(markdown.status()).toBe(200);
  expect(markdown.headers()["content-type"]).toBe("text/markdown; charset=utf-8");
  expect(markdown.headers()["x-robots-tag"]).toBe("noindex");
  expect(await markdown.text()).toContain("url: https://markiro.app/faq/");

  const full = await request.get("/llms-full.txt");
  expect(full.status()).toBe(200);
  expect(full.headers()["x-robots-tag"]).toBe("noindex");
  expect((await full.text()).startsWith("# Markiro\n")).toBe(true);

  const feed = await request.get("/stati/rss.xml");
  expect(feed.status()).toBe(200);
  expect(await feed.text()).toContain('<rss version="2.0"');
});

// Retired pages: the film and the disposal kiosk (2026-10-23) move permanently to the
// home page of their language and keep the query string.
const retiredRedirects = new Map([
  ["/kak-rabotaet/", "/"],
  ["/kak-rabotaet", "/"],
  ["/kak-rabotaet/index.html", "/"],
  ["/kak-rabotaet.md", "/"],
  ["/kak-rabotaet/?utm_source=test", "/?utm_source=test"],
  ["/en/how-it-works/", "/en/"],
  ["/en/how-it-works", "/en/"],
  ["/en/how-it-works.md", "/en/"],
  ["/kiosk-samovydachi/", "/"],
  ["/kiosk-samovydachi", "/"],
  ["/kiosk-samovydachi.md", "/"],
  ["/en/self-service-pickup-kiosk/", "/en/"],
  ["/en/self-service-pickup-kiosk/?utm_source=test", "/en/?utm_source=test"],
]);

// Withdrawn instructions (2026-10-29): Markiro Autonom has no inventory and no National
// Catalog import, so MKR-INS-05, 06, 07 and 11 move permanently to the instructions hub
// of their language, their verification pages included, and keep the query string.
const withdrawnInstructionRedirects = new Map([
  ["/instruktsii/inventarizatsiya-na-terminale/", "/instruktsii/"],
  ["/instruktsii/inventarizatsiya-podgotovka", "/instruktsii/"],
  ["/instruktsii/inventarizatsiya-zakrytie.md", "/instruktsii/"],
  ["/instruktsii/katalog-zagruzka-iz-nk/?utm_source=test", "/instruktsii/?utm_source=test"],
  ["/d/MKR-INS-05/2026.09/02/26.09.2026/", "/instruktsii/"],
  ["/d/MKR-INS-11/2026.09/01/11.09.2026/", "/instruktsii/"],
  ["/en/instructions/terminal-inventory-count/", "/en/instructions/"],
  ["/en/instructions/inventory-preparation", "/en/instructions/"],
  ["/en/instructions/inventory-closing.md", "/en/instructions/"],
  [
    "/en/instructions/national-catalog-import/?utm_source=test",
    "/en/instructions/?utm_source=test",
  ],
]);

test("production Caddy moves retired pages permanently to their home page", async ({ request }) => {
  for (const [retired, target] of retiredRedirects) {
    const response = await request.get(retired, { maxRedirects: 0 });
    expect(response.status(), retired).toBe(301);
    expect(response.headers().location, retired).toBe(target);
  }
  for (const live of ["/", "/en/", "/skachat/"]) {
    const response = await request.get(live, { maxRedirects: 0 });
    expect(response.status(), live).toBe(200);
  }
});

test("production Caddy moves withdrawn instructions permanently to the instructions hub", async ({
  request,
}) => {
  for (const [retired, target] of withdrawnInstructionRedirects) {
    const response = await request.get(retired, { maxRedirects: 0 });
    expect(response.status(), retired).toBe(301);
    expect(response.headers().location, retired).toBe(target);
  }
  for (const live of ["/instruktsii/", "/instruktsii/smena-planirovanie/", "/en/instructions/"]) {
    const response = await request.get(live, { maxRedirects: 0 });
    expect(response.status(), live).toBe(200);
  }
});
