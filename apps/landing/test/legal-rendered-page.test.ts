import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const outputDirectory = mkdtempSync(path.join(tmpdir(), "markiro-legal-render-"));

const LEGAL_ROUTES = [
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
] as const;

const documents = new Map<(typeof LEGAL_ROUTES)[number], Document>();

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

  for (const route of LEGAL_ROUTES) {
    const html = readFileSync(path.join(outputDirectory, route.slice(1), "index.html"), "utf8");
    documents.set(route, new JSDOM(html).window.document);
  }
}, 180_000);

afterAll(() => rmSync(outputDirectory, { force: true, recursive: true }));

describe("rendered legal pages", () => {
  it.each(LEGAL_ROUTES)("renders the public legal contract at %s", (route) => {
    const document = documents.get(route);
    expect(document?.querySelectorAll("h1")).toHaveLength(1);
    expect(document?.querySelector("main#main article[data-legal-document]")).not.toBeNull();
    expect(document?.querySelector("[data-legal-code]")?.textContent).toContain("MKR-");
    expect(document?.querySelector("[data-legal-revision]")?.textContent).toContain("2026.08.01");
    expect(document?.querySelector("[data-legal-effective-date]")?.textContent).toContain(
      "2026-08-15",
    );
    expect(document?.querySelector('link[rel="alternate"][hreflang="ru"]')).not.toBeNull();
    expect(document?.querySelector('link[rel="alternate"][hreflang="en"]')).not.toBeNull();
    expect(document?.querySelector('a[hreflang="ru"]')).not.toBeNull();
    expect(document?.querySelector('a[hreflang="en"]')).not.toBeNull();
    expect(document?.querySelector('[data-legal-status="active"]')).not.toBeNull();
    expect(document?.documentElement.outerHTML).not.toContain('data-legal-status="draft"');
  });

  it("lists every released document once in each localized registry", () => {
    for (const route of ["/legal/", "/en/legal/"] as const) {
      const codes = [...(documents.get(route)?.querySelectorAll("[data-registry-code]") ?? [])].map(
        (element) => element.textContent?.trim(),
      );
      expect(codes).toEqual(["MKR-PD-01", "MKR-PD-02", "MKR-DPA-01", "MKR-BRD-01"]);
    }
  });

  it("renders the authoritative-language notice on every English document", () => {
    for (const route of LEGAL_ROUTES.filter((candidate) => candidate.startsWith("/en/"))) {
      expect(
        documents.get(route)?.querySelector("[data-authoritative-language]")?.textContent,
      ).toMatch(/Russian.*authoritative/i);
    }
  });

  it("renders operator contacts as accessible text and links", () => {
    for (const route of ["/privacy/", "/en/privacy/"] as const) {
      const document = documents.get(route);
      expect(document?.body.textContent).toContain(
        "353745, Краснодарский край, Ленинградский район, ст. Ленинградская, ул. Грузская, д. 26",
      );
      expect(document?.querySelector('a[href="mailto:hello@v-b.tech"]')?.textContent).toBe(
        "hello@v-b.tech",
      );
      expect(document?.querySelector('a[href="tel:+79343551490"]')?.textContent).toBe(
        "+7 934 355-14-90",
      );
    }
  });

  it("does not advertise downloads before immutable artifacts exist", () => {
    for (const document of documents.values()) {
      expect(document.querySelector('a[download], a[href$=".pdf"], a[href$=".docx"]')).toBeNull();
    }
  });
});
