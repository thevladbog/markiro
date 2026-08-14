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

beforeAll(() => {
  execFileSync(
    path.join(appRoot, "node_modules/.bin/astro"),
    ["build", "--outDir", outputDirectory],
    {
      cwd: appRoot,
      env: {
        ...process.env,
        ASTRO_TELEMETRY_DISABLED: "1",
        PUBLIC_DEMO_ENDPOINT: "",
        PUBLIC_PHONE: "",
      },
      stdio: "pipe",
    },
  );

  const html = readFileSync(path.join(outputDirectory, "index.html"), "utf8");
  document = new JSDOM(html).window.document;
}, 180_000);

afterAll(() => {
  rmSync(outputDirectory, { force: true, recursive: true });
});

describe("rendered landing page", () => {
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
});
