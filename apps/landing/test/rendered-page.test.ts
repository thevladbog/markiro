import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const outputDirectory = mkdtempSync(path.join(tmpdir(), "markiro-landing-render-"));
const enabledOutputDirectory = mkdtempSync(path.join(tmpdir(), "markiro-landing-enabled-render-"));
let document: Document;
const documents = new Map<string, Document>();
const enabledDocuments = new Map<string, Document>();

const EXPECTED_ROUTES = [
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
] as const;

beforeAll(() => {
  execFileSync(
    path.join(appRoot, "node_modules/.bin/astro"),
    ["build", "--outDir", outputDirectory],
    {
      cwd: appRoot,
      env: {
        ...process.env,
        ASTRO_TELEMETRY_DISABLED: "1",
        PUBLIC_DEMO_CONSENT_VERSION: "stray-consent-version",
        PUBLIC_DEMO_SUBMISSION_ENABLED: "false",
        PUBLIC_PERSONAL_DATA_CONSENT_PATH: "/stray-consent/",
        PUBLIC_PHONE: "",
        PUBLIC_PRIVACY_POLICY_PATH: "/stray-privacy/",
        PUBLIC_SMARTCAPTCHA_CLIENT_KEY: "ysc1_stray-client-key",
      },
      stdio: "pipe",
    },
  );

  execFileSync(
    path.join(appRoot, "node_modules/.bin/astro"),
    ["build", "--outDir", enabledOutputDirectory],
    {
      cwd: appRoot,
      env: {
        ...process.env,
        ASTRO_TELEMETRY_DISABLED: "1",
        PUBLIC_DEMO_CONSENT_VERSION: "stray-enabled-consent",
        PUBLIC_DEMO_SUBMISSION_ENABLED: "true",
        PUBLIC_PERSONAL_DATA_CONSENT_PATH: "/personal-data-consent/",
        PUBLIC_PHONE: "",
        PUBLIC_PRIVACY_POLICY_PATH: "/privacy/",
        PUBLIC_SMARTCAPTCHA_CLIENT_KEY: "ysc1_render-test-key",
      },
      stdio: "pipe",
    },
  );

  for (const route of EXPECTED_ROUTES) {
    const outputPath =
      route === "/"
        ? path.join(outputDirectory, "index.html")
        : path.join(outputDirectory, route.slice(1), "index.html");
    const html = readFileSync(outputPath, "utf8");
    documents.set(route, new JSDOM(html).window.document);

    const enabledOutputPath =
      route === "/"
        ? path.join(enabledOutputDirectory, "index.html")
        : path.join(enabledOutputDirectory, route.slice(1), "index.html");
    const enabledHtml = readFileSync(enabledOutputPath, "utf8");
    enabledDocuments.set(route, new JSDOM(enabledHtml).window.document);
  }
  document = documents.get("/") as Document;
}, 180_000);

afterAll(() => {
  rmSync(outputDirectory, { force: true, recursive: true });
  rmSync(enabledOutputDirectory, { force: true, recursive: true });
});

describe("rendered landing page", () => {
  it("renders the exact localized Markiro brand", () => {
    const ruBrand = documents.get("/")?.querySelector("header .brand-mark");
    const enBrand = documents.get("/en/")?.querySelector("header .brand-mark");

    expect(ruBrand?.querySelector(".brand-mark__word")?.textContent).toBe("маркиро");
    expect(ruBrand?.getAttribute("aria-label")).toBe("Маркиро");
    expect(enBrand?.querySelector(".brand-mark__word")?.textContent).toBe("MARKIRO");
    expect(enBrand?.getAttribute("aria-label")).toBe("Markiro");

    for (const brand of [ruBrand, enBrand]) {
      expect(brand?.querySelectorAll("[data-brand-module]")).toHaveLength(8);
      expect(brand?.querySelectorAll("[data-brand-accent]")).toHaveLength(1);
    }
  });

  it("keeps localized brand links accessible and prevents wordmark translation", () => {
    const ruDocument = documents.get("/");
    const enDocument = documents.get("/en/");
    const ruBrandLinks = [
      ruDocument?.querySelector("header .landing-header__brand"),
      ruDocument?.querySelector("footer .landing-footer__meta > a"),
    ];
    const enBrandLinks = [
      enDocument?.querySelector("header .landing-header__brand"),
      enDocument?.querySelector("footer .landing-footer__meta > a"),
    ];

    for (const brandLink of ruBrandLinks) {
      expect(brandLink?.getAttribute("aria-label")).toBe("Маркиро, на главную страницу");
      expect(brandLink?.querySelector(".brand-mark")?.getAttribute("translate")).toBe("no");
    }

    for (const brandLink of enBrandLinks) {
      expect(brandLink?.getAttribute("aria-label")).toBe("Markiro home page");
      expect(brandLink?.querySelector(".brand-mark")?.getAttribute("translate")).toBe("no");
    }
  });

  it("activates the shared dark design tokens", () => {
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("sets a mobile-safe viewport without disabling zoom", () => {
    expect(document.querySelector('meta[name="viewport"]')?.getAttribute("content")).toBe(
      "width=device-width, initial-scale=1",
    );
  });

  it("renders localized cookie choices and a persistent settings control", () => {
    for (const [route, labels] of [
      ["/", ["Отклонить", "Настроить", "Принять все", "Настройки cookies"]],
      ["/en/", ["Reject", "Customize", "Accept all", "Cookie settings"]],
    ] as const) {
      const localizedDocument = documents.get(route);
      const panel = localizedDocument?.querySelector("[data-consent-panel]");
      expect(panel?.hasAttribute("hidden")).toBe(true);
      expect(panel?.querySelector("[data-consent-reject]")?.textContent?.trim()).toBe(labels[0]);
      expect(panel?.querySelector("[data-consent-customize]")?.textContent?.trim()).toBe(labels[1]);
      expect(panel?.querySelector("[data-consent-accept]")?.textContent?.trim()).toBe(labels[2]);
      expect(
        localizedDocument?.querySelector("footer [data-consent-settings]")?.textContent?.trim(),
      ).toBe(labels[3]);
    }
  });

  it("renders the approved semantic section hierarchy", () => {
    expect(document.querySelectorAll("h1")).toHaveLength(1);
    expect(document.querySelector("nav[aria-label]")).not.toBeNull();
    expect(document.querySelector("main#main")).not.toBeNull();

    for (const sectionId of [
      "hero",
      "continuity",
      "cycle",
      "product",
      "traceability",
      "platform",
      "implementation",
      "demo",
    ]) {
      expect(document.querySelector(`section#${sectionId}[aria-labelledby]`)).not.toBeNull();
    }
  });

  it("publishes the current product-category boundary on the home and SSCC pages", () => {
    const ruCategory = "Пиво, напитки, изготавливаемые на основе пива, слабоалкогольные напитки";
    const enCategory = "Beer, beverages made from beer and low-alcohol beverages";

    for (const route of ["/", "/sscc-i-agregatsiya/"] as const) {
      const text = documents.get(route)?.body.textContent?.replace(/\s+/g, " ") ?? "";
      expect(text).toContain(ruCategory);
      expect(text.toLowerCase()).toContain("сидр");
      expect(text).toContain("Новые товарные группы добавляются поэтапно");
      expect(text).not.toContain("внедряется для производителей");
    }

    for (const route of ["/en/", "/en/sscc-and-aggregation/"] as const) {
      const text = documents.get(route)?.body.textContent?.replace(/\s+/g, " ") ?? "";
      expect(text).toContain(enCategory);
      expect(text.toLowerCase()).toContain("cider");
      expect(text).toContain("Additional product categories are being added gradually");
      expect(text).not.toContain("is currently deployed");
    }

    const ruSscc = documents.get("/sscc-i-agregatsiya/")?.body.textContent ?? "";
    expect(ruSscc).toContain("Текущий поддерживаемый уровень — цепочка «единица → короб»");
    expect(ruSscc).toContain("Паллетная агрегация");
    expect(ruSscc).toContain("будет добавлена отдельным следующим этапом");

    const enSscc = documents.get("/en/sscc-and-aggregation/")?.body.textContent ?? "";
    expect(enSscc).toContain("The currently supported level is the item-to-case chain");
    expect(enSscc).toContain("Pallet aggregation");
    expect(enSscc).toContain("will be added as a separate next stage");
  });

  it("renders the four visible fields in the accessible order with optional phone copy", () => {
    const form = document.querySelector<HTMLFormElement>("form[data-demo-form]");
    expect(form).not.toBeNull();

    for (const fieldId of ["name", "company", "email", "phone"]) {
      expect(form?.querySelector(`label[for=${fieldId}]`)).not.toBeNull();
      expect(form?.querySelector(`#${fieldId}[name=${fieldId}]`)).not.toBeNull();
    }
    expect(
      [...(form?.querySelectorAll(".form-field > input") ?? [])].map((input) => input.id),
    ).toEqual(["name", "company", "email", "phone"]);
    expect(form?.querySelector('input[name="email"]')?.getAttribute("autocomplete")).toBe("email");
    expect(form?.querySelector('input[name="phone"]')?.getAttribute("autocomplete")).toBe("tel");
    expect(form?.querySelector('label[for="phone"]')?.textContent).toContain("необязательно");
  });

  it("keeps captcha, consent, and public submission data out of disabled builds", () => {
    const form = document.querySelector<HTMLFormElement>("form[data-demo-form]");
    const fieldset = form?.querySelector<HTMLFieldSetElement>("fieldset[data-demo-fields]");
    expect(form?.hasAttribute("data-endpoint")).toBe(false);
    expect(form?.hasAttribute("data-consent-version")).toBe(false);
    expect(fieldset?.disabled).toBe(true);
    expect(fieldset?.querySelectorAll("[name]")).toHaveLength(4);
    expect(form?.querySelectorAll("[name]")).toHaveLength(4);
    expect(
      [...(form?.querySelectorAll<HTMLElement>("[name]") ?? [])].every((control) =>
        fieldset?.contains(control),
      ),
    ).toBe(true);
    const WindowFormData = form?.ownerDocument.defaultView?.FormData;
    expect(
      WindowFormData && form ? [...new WindowFormData(form).keys()] : ["missing-form"],
    ).toEqual([]);
    expect(fieldset?.querySelector('button[type="submit"]')).not.toBeNull();
    expect(form?.querySelector('input[name="consent"]')).toBeNull();
    expect(form?.querySelector(".smart-captcha")).toBeNull();
    expect(
      document.querySelector('script[src="https://smartcaptcha.cloud.yandex.ru/captcha.js"]'),
    ).toBeNull();
    expect(document.documentElement.outerHTML).not.toContain("stray-consent-version");
    expect(document.documentElement.outerHTML).not.toContain("ysc1_stray-client-key");
    expect(document.documentElement.outerHTML).not.toContain("/stray-consent/");
    expect(document.documentElement.outerHTML).not.toContain("/stray-privacy/");
  });

  it("renders enabled consent, honeypot, captcha, and localized source contracts", () => {
    for (const [route, expectedLocale] of [
      ["/", "ru"],
      ["/en/", "en"],
    ] as const) {
      const enabledDocument = enabledDocuments.get(route) as Document;
      const form = enabledDocument.querySelector<HTMLFormElement>("form[data-demo-form]");
      const fieldset = form?.querySelector<HTMLFieldSetElement>("fieldset[data-demo-fields]");
      expect(form?.dataset.endpoint).toBe("/api/demo-requests");
      expect(form?.dataset.consentVersion).toBe("MKR-PD-02/2026.08/01");
      expect(form?.dataset.locale).toBe(expectedLocale);
      expect(form?.dataset.sourcePath).toBe(route);
      expect(fieldset?.disabled).toBe(false);

      const honeypot = form?.querySelector<HTMLElement>(".demo-form__honeypot");
      expect(honeypot?.getAttribute("aria-hidden")).toBe("true");
      expect(honeypot?.querySelector('input[name="website"]')?.getAttribute("tabindex")).toBe("-1");

      const consent = form?.querySelector<HTMLInputElement>('input[name="consent"]');
      expect(consent?.checked).toBe(false);
      expect(consent?.required).toBe(true);
      expect(form?.querySelector("[data-consent-error]")).not.toBeNull();
      const legalPrefix = expectedLocale === "en" ? "/en" : "";
      expect(form?.querySelector(`a[href="${legalPrefix}/personal-data-consent/"]`)).not.toBeNull();
      expect(form?.querySelector(`a[href="${legalPrefix}/privacy/"]`)).not.toBeNull();
      const consentText = form
        ?.querySelector("label[for=consent]")
        ?.textContent?.replace(/\s+/g, " ")
        .trim();
      expect(consentText).toBe(
        expectedLocale === "ru"
          ? "Даю согласие на обработку персональных данных на условиях согласия и подтверждаю, что ознакомился с политикой обработки персональных данных."
          : "I consent to the processing of my personal data under the personal-data consent and confirm that I have read the personal-data processing policy.",
      );

      expect(form?.querySelector(".smart-captcha")?.getAttribute("data-sitekey")).toBe(
        "ysc1_render-test-key",
      );
      expect(form?.querySelector(".smart-captcha")?.getAttribute("data-hl")).toBe(expectedLocale);
      expect(form?.querySelector("[data-captcha-error]")).not.toBeNull();
      expect(
        enabledDocument.querySelector(
          'script[src="https://smartcaptcha.cloud.yandex.ru/captcha.js"]',
        ),
      ).not.toBeNull();
    }
  });

  it("does not mention CRM or internal rollout dependencies in disabled builds", () => {
    for (const route of ["/", "/en/"] as const) {
      const body = documents.get(route)?.body.textContent ?? "";
      expect(body).not.toMatch(/CRM|подключени[ея] CRM|connection to the CRM/i);
      expect(body).toContain(
        route === "/"
          ? "Онлайн-отправка временно недоступна. Напишите нам на hello@v-b.tech."
          : "Online submission is temporarily unavailable. Email us at hello@v-b.tech.",
      );
    }
  });

  it("does not ship an admin screenshot or invented contact data", () => {
    expect(document.documentElement.outerHTML).not.toContain("screenshot-127.0.0.1");
    expect(document.documentElement.outerHTML).not.toContain("+7 800 555");
    expect(document.querySelector('a[href^="tel:"]')).toBeNull();
  });

  it("does not expose a fake retry control in the illustrative event log", () => {
    expect(
      [...document.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Повторить печать",
      ),
    ).toBeUndefined();
  });

  it("gives the above-the-fold factory image stable dimensions", () => {
    const heroImage = document.querySelector<HTMLImageElement>("[data-hero-image]");
    expect(Number(heroImage?.getAttribute("width"))).toBeGreaterThan(0);
    expect(Number(heroImage?.getAttribute("height"))).toBeGreaterThan(0);
    expect(heroImage?.getAttribute("fetchpriority")).toBe("high");
  });

  it("renders complete unique metadata for every canonical route", () => {
    const titles = new Set<string>();
    const descriptions = new Set<string>();

    for (const [route, routeDocument] of documents) {
      const title = routeDocument.title;
      const description = routeDocument
        .querySelector('meta[name="description"]')
        ?.getAttribute("content");

      expect(routeDocument.querySelectorAll("h1")).toHaveLength(1);
      expect(routeDocument.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe(
        "index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1",
      );
      expect(routeDocument.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe(
        `https://markiro.app${route}`,
      );
      expect(routeDocument.querySelector('meta[property="og:site_name"]')).not.toBeNull();
      const expectedLocale = route.startsWith("/en/") ? "en" : "ru";
      const alternateLocale = expectedLocale === "ru" ? "en" : "ru";
      expect(routeDocument.documentElement.lang).toBe(expectedLocale);
      expect(
        routeDocument.querySelector('meta[property="og:locale"]')?.getAttribute("content"),
      ).toBe(expectedLocale === "ru" ? "ru_RU" : "en_US");
      expect(
        routeDocument.querySelector(`link[rel="alternate"][hreflang="${alternateLocale}"]`),
      ).not.toBeNull();
      expect(
        routeDocument.querySelector('link[rel="alternate"][hreflang="x-default"]'),
      ).not.toBeNull();
      expect(routeDocument.querySelector('meta[property="og:image:alt"]')).not.toBeNull();
      expect(routeDocument.querySelector('meta[name="twitter:title"]')).not.toBeNull();
      expect(routeDocument.querySelector('meta[name="twitter:description"]')).not.toBeNull();
      expect(routeDocument.querySelector('meta[name="twitter:image"]')).not.toBeNull();
      expect(routeDocument.querySelector('meta[name="twitter:image:alt"]')).not.toBeNull();
      expect(routeDocument.querySelector('link[rel="manifest"]')?.getAttribute("href")).toBe(
        expectedLocale === "ru" ? "/site.webmanifest" : "/site.en.webmanifest",
      );
      expect(title).not.toBe("");
      expect(description).toBeTruthy();
      titles.add(title);
      descriptions.add(description as string);
    }

    expect(titles.size).toBe(EXPECTED_ROUTES.length);
    expect(descriptions.size).toBe(EXPECTED_ROUTES.length);
  });

  it("renders English pages without Russian interface copy", () => {
    for (const [route, routeDocument] of documents) {
      if (!route.startsWith("/en/")) continue;
      expect(routeDocument.body.textContent).not.toMatch(/[А-Яа-яЁё]/);
      expect(routeDocument.querySelector('a[hreflang="ru"]')).not.toBeNull();
      expect(routeDocument.querySelector('a[hreflang="en"][aria-current="page"]')).not.toBeNull();
    }
  });

  it("keeps locale-specific time punctuation in the illustrative console", () => {
    expect(documents.get("/")?.body.textContent).toContain("52,40 сек");
    expect(documents.get("/en/")?.body.textContent).toContain("52.40 sec");
  });

  it("renders parseable structured data that matches visible navigation", () => {
    for (const [route, routeDocument] of documents) {
      const script = routeDocument.querySelector('script[type="application/ld+json"]');
      expect(script).not.toBeNull();
      const graph = JSON.parse(script?.textContent ?? "") as {
        "@graph": Array<Record<string, unknown>>;
      };

      expect(graph["@graph"].some((entry) => entry["@type"] === "WebSite")).toBe(true);
      expect(graph["@graph"].some((entry) => entry["@type"] === "WebPage")).toBe(true);
      expect(graph["@graph"].some((entry) => entry["@type"] === "Organization")).toBe(true);
      expect(graph["@graph"].some((entry) => entry["@type"] === "SoftwareApplication")).toBe(true);

      if (route !== "/" && route !== "/en/") {
        const breadcrumbsLabel = route.startsWith("/en/") ? "Breadcrumbs" : "Хлебные крошки";
        expect(routeDocument.querySelector(`nav[aria-label="${breadcrumbsLabel}"]`)).not.toBeNull();
        expect(graph["@graph"].some((entry) => entry["@type"] === "BreadcrumbList")).toBe(true);
      }
    }
  });

  it("keeps FAQ structured answers identical to visible answers", () => {
    const faqDocument = documents.get("/faq/") as Document;
    const graph = JSON.parse(
      faqDocument.querySelector('script[type="application/ld+json"]')?.textContent ?? "",
    ) as {
      "@graph": Array<Record<string, unknown>>;
    };
    const faq = graph["@graph"].find((entry) => entry["@type"] === "FAQPage") as {
      mainEntity: Array<{ name: string; acceptedAnswer: { text: string } }>;
    };

    const visible = [...faqDocument.querySelectorAll("[data-faq-item]")].map((item) => ({
      name: item.querySelector("h2")?.textContent?.trim(),
      text: item.querySelector("p")?.textContent?.trim(),
    }));
    expect(visible).toEqual(
      faq.mainEntity.map((entry) => ({
        name: entry.name,
        text: entry.acceptedAnswer.text,
      })),
    );
  });

  it("links every specialist page to at least two canonical related pages", () => {
    for (const route of EXPECTED_ROUTES.filter((path) => path !== "/" && path !== "/en/")) {
      const routeDocument = documents.get(route) as Document;
      const relatedLinks = [...routeDocument.querySelectorAll('[data-related-pages] a[href^="/"]')];
      expect(relatedLinks.length).toBeGreaterThanOrEqual(2);
    }
  });
});
