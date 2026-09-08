import { describe, expect, it } from "vitest";

import { ARTICLE_SEARCH_PAGES } from "./articles";
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
  "/en/",
  "/en/chestny-znak-serialization/",
  "/en/sscc-and-aggregation/",
  "/en/packing-workstation/",
  "/en/self-service-pickup-kiosk/",
  "/en/1c-integration/",
  "/en/offline-production/",
  "/en/faq/",
] as const;

describe("SEO page registry", () => {
  it("owns the complete canonical topic cluster", () => {
    expect(SEO_PAGES.map(({ path }) => path)).toEqual(EXPECTED_PATHS);
  });

  it("keeps route metadata unique and useful", () => {
    expect(new Set(SEO_PAGES.map(({ title }) => title)).size).toBe(SEO_PAGES.length);
    expect(new Set(SEO_PAGES.map(({ description }) => description)).size).toBe(SEO_PAGES.length);

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

  it("pairs every Russian page with one English alternate", () => {
    const pages = new Map(SEO_PAGES.map((page) => [page.path, page]));

    for (const page of SEO_PAGES) {
      expect(page.locale === "ru" || page.locale === "en").toBe(true);
      const alternate = pages.get(page.alternatePath);
      expect(alternate).toBeDefined();
      expect(alternate?.locale).not.toBe(page.locale);
      expect(alternate?.alternatePath).toBe(page.path);
    }
  });

  it("gives every topic page answer-shaped depth", () => {
    const knownArticles = new Map(ARTICLE_SEARCH_PAGES.map((article) => [article.path, article]));

    for (const page of SEO_PAGES) {
      if (page.path === "/" || page.path === "/en/") continue;
      const isFaq = page.path.endsWith("/faq/");

      expect(page.summary.length, page.path).toBeGreaterThanOrEqual(3);
      expect(page.faq?.length ?? 0, page.path).toBeGreaterThanOrEqual(isFaq ? 10 : 3);
      if (!isFaq) expect(page.sections.length, page.path).toBeGreaterThanOrEqual(4);
      expect(page.relatedArticlePaths.length, page.path).toBeGreaterThanOrEqual(2);
      for (const articlePath of page.relatedArticlePaths) {
        expect(knownArticles.get(articlePath)?.locale, `${page.path} -> ${articlePath}`).toBe(
          page.locale,
        );
      }

      const questions = (page.faq ?? []).map(({ question }) => question);
      expect(new Set(questions).size, page.path).toBe(questions.length);
      for (const entry of page.faq ?? []) {
        expect(entry.question.endsWith("?"), `${page.path}: ${entry.question}`).toBe(true);
        expect(entry.answer.length, `${page.path}: ${entry.question}`).toBeGreaterThanOrEqual(60);
      }

      const words = [
        page.introduction,
        ...page.summary,
        ...page.sections.flatMap((section) => [...section.paragraphs, ...(section.bullets ?? [])]),
        ...(page.faq ?? []).map(({ answer }) => answer),
      ]
        .join(" ")
        .split(/\s+/)
        .filter(Boolean).length;
      expect(words, page.path).toBeGreaterThanOrEqual(isFaq ? 350 : 400);
    }
  });

  it("finds canonical pages and rejects unknown paths", () => {
    expect(findSeoPage("/sscc-i-agregatsiya/").heading).toContain("SSCC");
    expect(() => findSeoPage("/unknown/")).toThrow("Unknown SEO page: /unknown/");
  });
});
