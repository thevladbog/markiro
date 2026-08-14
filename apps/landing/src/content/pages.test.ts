import { describe, expect, it } from "vitest";

import { SEO_PAGES, findSeoPage } from "./pages";

const EXPECTED_PATHS = [
  "/",
  "/markirovka-chestny-znak/",
  "/sscc-i-agregatsiya/",
  "/rabochee-mesto-upakovki/",
  "/kiosk-samovydachi/",
  "/integratsiya-1c/",
  "/oflayn-rabota/",
  "/faq/",
] as const;

describe("SEO page registry", () => {
  it("owns the complete canonical topic cluster", () => {
    expect(SEO_PAGES.map(({ path }) => path)).toEqual(EXPECTED_PATHS);
  });

  it("keeps route metadata unique and useful", () => {
    expect(new Set(SEO_PAGES.map(({ title }) => title)).size).toBe(SEO_PAGES.length);
    expect(new Set(SEO_PAGES.map(({ description }) => description)).size).toBe(
      SEO_PAGES.length,
    );

    for (const page of SEO_PAGES) {
      expect(page.title.length).toBeGreaterThanOrEqual(30);
      expect(page.title.length).toBeLessThanOrEqual(70);
      expect(page.description.length).toBeGreaterThanOrEqual(100);
      expect(page.description.length).toBeLessThanOrEqual(180);
      expect(page.heading.length).toBeGreaterThan(0);
      expect(page.socialImageAlt.length).toBeGreaterThan(0);
      expect(page.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("links only to other canonical pages", () => {
    const paths = new Set(EXPECTED_PATHS);

    for (const page of SEO_PAGES) {
      expect(page.relatedPaths.length).toBeGreaterThanOrEqual(2);
      expect(page.relatedPaths).not.toContain(page.path);
      for (const relatedPath of page.relatedPaths) expect(paths.has(relatedPath)).toBe(true);
    }
  });

  it("finds canonical pages and rejects unknown paths", () => {
    expect(findSeoPage("/sscc-i-agregatsiya/").heading).toContain("SSCC");
    expect(() => findSeoPage("/unknown/")).toThrow("Unknown SEO page: /unknown/");
  });
});
