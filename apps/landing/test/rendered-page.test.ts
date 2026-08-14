import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const outputDirectory = mkdtempSync(path.join(tmpdir(), "markiro-landing-render-"));
let document: Document;
const documents = new Map<string, Document>();

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
        PUBLIC_DEMO_SUBMISSION_ENABLED: "false",
        PUBLIC_PHONE: "",
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
  }
  document = documents.get("/") as Document;
}, 180_000);

afterAll(() => {
  rmSync(outputDirectory, { force: true, recursive: true });
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

  it("activates the shared dark design tokens", () => {
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("sets a mobile-safe viewport without disabling zoom", () => {
    expect(document.querySelector('meta[name="viewport"]')?.getAttribute("content")).toBe(
      "width=device-width, initial-scale=1",
    );
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

  it("renders a labelled three-field demo form", () => {
    const form = document.querySelector("form[data-demo-form]");
    expect(form).not.toBeNull();

    for (const fieldId of ["name", "company", "phone"]) {
      expect(form?.querySelector(`label[for=${fieldId}]`)).not.toBeNull();
      expect(form?.querySelector(`#${fieldId}[name=${fieldId}]`)).not.toBeNull();
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
