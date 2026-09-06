import { describe, expect, it } from "vitest";

import { ARTICLE_SEARCH_PAGES } from "./articles";
import { HUB_PAGES, HUB_SEARCH_PAGES, findHubPage, hubPath } from "./hubs";

describe("hub page registry", () => {
  it("owns one articles hub and one instructions hub per locale", () => {
    expect(HUB_PAGES.map(({ path }) => path)).toEqual([
      "/stati/",
      "/instruktsii/",
      "/en/articles/",
      "/en/instructions/",
    ]);
    expect(hubPath("ru", "articles")).toBe("/stati/");
    expect(hubPath("ru", "instructions")).toBe("/instruktsii/");
    expect(hubPath("en", "articles")).toBe("/en/articles/");
    expect(hubPath("en", "instructions")).toBe("/en/instructions/");
  });

  it("keeps hub metadata unique, bounded and paired across locales", () => {
    expect(new Set(HUB_PAGES.map(({ title }) => title)).size).toBe(HUB_PAGES.length);
    expect(new Set(HUB_PAGES.map(({ description }) => description)).size).toBe(HUB_PAGES.length);
    const pages = new Map(HUB_PAGES.map((page) => [page.path, page]));

    for (const page of HUB_PAGES) {
      expect(page.title.length).toBeGreaterThanOrEqual(30);
      expect(page.title.length).toBeLessThanOrEqual(70);
      expect(page.description.length).toBeGreaterThanOrEqual(100);
      expect(page.description.length).toBeLessThanOrEqual(180);
      expect(page.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const alternate = pages.get(page.alternatePath);
      expect(alternate?.locale).not.toBe(page.locale);
      expect(alternate?.alternatePath).toBe(page.path);
      expect(alternate?.kind).toBe(page.kind);
    }
  });

  it("publishes search records that the sitemap can consume", () => {
    expect(HUB_SEARCH_PAGES.map(({ path }) => path)).toEqual(HUB_PAGES.map(({ path }) => path));
    for (const record of HUB_SEARCH_PAGES) {
      expect(record.lastModified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(record.navigationLabel.length).toBeGreaterThan(0);
    }
  });

  it("never lists an article path that the article registry does not know", () => {
    const known = new Set(ARTICLE_SEARCH_PAGES.map(({ path }) => path));
    expect(known.has("/stati/markirovka-piva-2026/")).toBe(true);
    expect(() => findHubPage("/unknown/")).toThrow("Unknown hub page: /unknown/");
    expect(findHubPage("/stati/").kind).toBe("articles");
  });
});
