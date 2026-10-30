import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const output = mkdtempSync(path.join(tmpdir(), "markiro-license-links-"));
const pages = new Map<string, Document>();

beforeAll(() => {
  execFileSync(path.join(appRoot, "node_modules/.bin/astro"), ["build", "--outDir", output], {
    cwd: appRoot,
    env: {
      ...process.env,
      ASTRO_TELEMETRY_DISABLED: "1",
      PUBLIC_DEMO_SUBMISSION_ENABLED: "true",
      PUBLIC_SMARTCAPTCHA_CLIENT_KEY: "ysc1_local-test",
      PUBLIC_PHONE: "",
    },
    stdio: "pipe",
  });
  for (const name of readdirSync(output, { recursive: true })) {
    if (typeof name === "string" && name.endsWith("index.html")) {
      pages.set(
        `/${name.slice(0, -"index.html".length)}`,
        new JSDOM(readFileSync(path.join(output, name), "utf8")).window.document,
      );
    }
  }
}, 180_000);
afterAll(() => rmSync(output, { recursive: true, force: true }));

function follow(href: string): Document {
  expect(href.startsWith("/")).toBe(true);
  const page = pages.get(href);
  expect(page, `Missing legal page ${href}`).toBeDefined();
  if (!page) throw new Error(`Missing legal page ${href}`);
  return page;
}

function verifyPdf(document: Document, code: string): void {
  const href = document.querySelector('a[download$=".pdf"]')?.getAttribute("href");
  expect(href).toContain(`markiro_${code.toLowerCase()}_2026.10-01_`);
  if (!href) throw new Error(`Missing PDF link for ${code}`);
  const pdf = path.join(output, href.slice(1));
  expect(existsSync(pdf)).toBe(true);
  expect(readFileSync(pdf).subarray(0, 5).toString()).toBe("%PDF-");
}

describe("published form links", () => {
  it("resolves consent and policy from every enabled lead/demo form to the same current revision", () => {
    let checked = 0;
    for (const [route, document] of pages) {
      for (const form of document.querySelectorAll<HTMLFormElement>("form[data-consent-version]")) {
        checked++;
        expect(form.dataset.consentVersion, route).toBe("MKR-PD-02/2026.10/01");
        const checkbox = form.querySelector<HTMLInputElement>('input[name="consent"]');
        expect(checkbox?.required, route).toBe(true);
        expect(checkbox?.checked, route).toBe(false);
        const localePrefix = route.startsWith("/en/") ? "/en" : "";
        for (const [suffix, code] of [
          ["/personal-data-consent/", "MKR-PD-02"],
          ["/privacy/", "MKR-PD-01"],
        ]) {
          const href = `${localePrefix}${suffix}`;
          expect(form.querySelector(`a[href="${href}"]`), `${route} → ${href}`).not.toBeNull();
          const target = follow(href);
          expect(target.querySelector("[data-legal-code]")?.textContent).toBe(code);
          expect(target.querySelector("[data-legal-revision]")?.textContent).toBe("2026.10/01");
          if (!code) throw new Error("Missing expected document code");
          verifyPdf(target, code);
        }
        expect(form.querySelector('input[name*="marketing"],input[name*="newsletter"]')).toBeNull();
      }
    }
    expect(checked).toBeGreaterThanOrEqual(2);
  });

  it.each(["/skachat/", "/stoimost/"])(
    "links the existing trial/offer wording to the license offer on %s",
    (route) => {
      const document = follow(route);
      const link = document.querySelector('a[href="/legal/autonom-license/"]');
      expect(link).not.toBeNull();
      const href = link?.getAttribute("href");
      if (!href) throw new Error(`Missing offer link on ${route}`);
      const target = follow(href);
      expect(target.querySelector("[data-legal-code]")?.textContent).toBe("MKR-LIC-01");
      verifyPdf(target, "MKR-LIC-01");
      expect(target.body.textContent).toContain("не являются акцептом платной лицензии");
    },
  );
});
