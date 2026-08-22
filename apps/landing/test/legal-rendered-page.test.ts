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

const VERIFICATION_ROUTES = [
  "/d/MKR-PD-01/2026.08/01/15.08.2026",
  "/d/MKR-PD-02/2026.08/01/15.08.2026",
  "/d/MKR-DPA-01/2026.08/01/15.08.2026",
  "/d/MKR-BRD-01/2026.08/01/15.08.2026",
] as const;

const documents = new Map<string, Document>();

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

  for (const route of [...LEGAL_ROUTES, ...VERIFICATION_ROUTES]) {
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
    expect(document?.querySelector("[data-legal-revision]")?.textContent).toContain("2026.08/01");
    const visibleDate = route.startsWith("/en/") ? "15 August 2026" : "15.08.2026";
    expect(document?.querySelector("[data-legal-effective-date]")?.textContent).toContain(
      visibleDate,
    );
    expect(document?.querySelector("[data-legal-effective-date]")?.getAttribute("datetime")).toBe(
      "2026-08-15",
    );
    if (!route.startsWith("/en/")) expect(document?.body.textContent).not.toContain("2026-08-15");
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
      const expectedCodes =
        route === "/legal/"
          ? [
              "MKR-PD-01",
              "MKR-PD-02",
              "MKR-DPA-01",
              "MKR-BRD-01",
              "MKR-INS-01",
              "MKR-INS-02",
              "MKR-INS-03",
              "MKR-INS-04",
            ]
          : ["MKR-PD-01", "MKR-PD-02", "MKR-DPA-01", "MKR-BRD-01"];
      expect(codes).toEqual(expectedCodes);
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
      const document = documents.get(route)!;
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

  it.each([
    ["/privacy/", ["Персональные данные", "Обработка", "Тенант"]],
    ["/en/privacy/", ["Personal data", "Processing", "Tenant"]],
  ] as const)("renders every definition as term — detail at %s", (route, terms) => {
    const rows = documents.get(route)?.querySelectorAll(".legal-definitions > div") ?? [];
    expect(rows).toHaveLength(terms.length);
    rows.forEach((row, index) => {
      const term = terms[index];
      expect(row.querySelector("dt")?.textContent?.trim()).toBe(`${term} —`);
      expect(row.querySelector("dd")?.textContent?.trim().length).toBeGreaterThan(0);
      expect(row.textContent?.replaceAll(/\s+/g, " ").trim()).toMatch(new RegExp(`^${term} — `));
    });
  });

  it("publishes the verified PDF/A download, digest, and Data Matrix on document results", () => {
    for (const route of [
      ...LEGAL_ROUTES.filter((candidate) => !candidate.endsWith("/legal/")),
      ...VERIFICATION_ROUTES,
    ]) {
      const document = documents.get(route)!;
      expect(document.querySelector('a[download$=".pdf"]')).not.toBeNull();
      expect(document.querySelector("[data-artifact-sha256]")?.textContent?.trim()).toMatch(
        /^[a-f0-9]{64}$/,
      );
      expect(document.querySelector("[data-document-datamatrix] svg")).not.toBeNull();
    }
  });

  it("publishes editable DOCX only for template releases with an explicit warning", () => {
    for (const route of LEGAL_ROUTES.filter((candidate) => !candidate.endsWith("/legal/"))) {
      const document = documents.get(route)!;
      const docx = document.querySelector('a[download$=".docx"]');
      const isTemplate =
        route.includes("tenant-data-processing") || route.includes("brand-letterhead");
      expect(docx === null).toBe(!isTemplate);
      expect(document.querySelector("[data-template-warning]") !== null).toBe(isTemplate);
    }
  });

  it("lists all localized immutable artifacts in each registry", () => {
    for (const route of ["/legal/", "/en/legal/"] as const) {
      const document = documents.get(route);
      const pdfCount = route === "/legal/" ? 8 : 4;
      const shaCount = route === "/legal/" ? 10 : 6;
      expect(document?.querySelectorAll('a[download$=".pdf"]')).toHaveLength(pdfCount);
      expect(document?.querySelectorAll('a[download$=".docx"]')).toHaveLength(2);
      expect(document?.querySelectorAll("[data-artifact-sha256]")).toHaveLength(shaCount);
    }
  });

  it("keeps footer metadata and legal artifact rows in bounded layout groups", () => {
    for (const route of ["/privacy/", "/legal/", VERIFICATION_ROUTES[0]] as const) {
      const document = documents.get(route)!;
      const footerMeta = document.querySelector("[data-footer-meta]");
      expect(footerMeta?.querySelector(".brand-mark")).not.toBeNull();
      expect(footerMeta?.querySelector("[data-footer-year]")?.textContent).toContain("2026");
      for (const card of document.querySelectorAll("[data-legal-artifact-card]")) {
        expect(card.querySelector("[data-artifact-format-row]")).not.toBeNull();
        expect(card.querySelector("[data-artifact-action-row]")).not.toBeNull();
        expect(card.querySelector("[data-artifact-digest-row]")).not.toBeNull();
      }
      for (const digest of document.querySelectorAll("[data-artifact-digest-row]")) {
        expect(digest.querySelector("code[data-artifact-sha256]")).not.toBeNull();
        expect(digest.querySelector("button[data-copy-artifact]")).not.toBeNull();
      }
      for (const address of document.querySelectorAll("[data-verification-address]")) {
        expect(address.querySelector("[data-document-datamatrix]")).not.toBeNull();
        expect(address.querySelector("a[href^='/d/']")).not.toBeNull();
      }
    }
  });

  it.each(VERIFICATION_ROUTES)(
    "renders the bilingual bounded verification result at %s",
    (route) => {
      const document = documents.get(route);
      expect(document?.querySelectorAll("h1")).toHaveLength(1);
      expect(document?.querySelector("[data-document-id]")?.textContent).toContain(
        route.split("/")[2],
      );
      expect(document?.querySelectorAll('a[download$=".pdf"]')).toHaveLength(2);
      const literalUrl = `https://markiro.app${route}`;
      expect(
        document
          ?.querySelector("[data-document-datamatrix]")
          ?.getAttribute("data-document-datamatrix"),
      ).toBe(literalUrl);
      expect(document?.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe(
        literalUrl,
      );
      expect(document?.body.textContent).toMatch(/Проверка документа/);
      expect(document?.body.textContent).toMatch(/Document verification/);
    },
  );
});
