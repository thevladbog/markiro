import { describe, expect, it } from "vitest";

import { findSeoPage } from "../content/pages";
import {
  buildPageGraph,
  renderLlmsTxt,
  renderRobotsTxt,
  renderSitemapXml,
  serializeJsonLd,
} from "./seo";

describe("SEO generators", () => {
  it("separates search retrieval from model training", () => {
    const robots = renderRobotsTxt();

    expect(robots).toContain("User-agent: OAI-SearchBot\nAllow: /");
    expect(robots).toContain("User-agent: Claude-SearchBot\nAllow: /");
    expect(robots).toContain("User-agent: Claude-User\nAllow: /");
    expect(robots).toContain("User-agent: PerplexityBot\nAllow: /");
    expect(robots).toContain("User-agent: GPTBot\nDisallow: /");
    expect(robots).toContain("User-agent: ClaudeBot\nDisallow: /");
    expect(robots).toContain("Sitemap: https://markiro.app/sitemap.xml");
  });

  it("lists every canonical route with a real review date", () => {
    const sitemap = renderSitemapXml();

    expect(sitemap).toContain("<loc>https://markiro.app/</loc>");
    expect(sitemap).toMatch(
      /<loc>https:\/\/markiro\.app\/oflayn-rabota\/<\/loc>[\s\S]*?<lastmod>2026-08-14<\/lastmod>/,
    );
    expect(sitemap).toContain("<loc>https://markiro.app/en/offline-production/</loc>");
    expect(sitemap).toContain('hreflang="ru"');
    expect(sitemap).toContain('hreflang="en"');
    expect(sitemap).toContain('hreflang="x-default"');
    expect(sitemap.match(/<url>/g)).toHaveLength(16);
  });

  it("publishes an experimental content map without ranking claims", () => {
    const llms = renderLlmsTxt();

    expect(llms).toContain("# Markiro");
    expect(llms).toContain(
      "> Производственная система для маркировки, агрегации и прослеживаемости с локальной работой станций.",
    );
    expect(llms).toContain("https://markiro.app/sscc-i-agregatsiya/");
    expect(llms).toContain("## English");
    expect(llms).toContain(
      "> Production serialization, aggregation, and traceability with offline-capable line stations.",
    );
    expect(llms).toContain("https://markiro.app/en/sscc-and-aggregation/");
    expect(llms).not.toMatch(/ranking|ранжир/i);
  });

  it("builds truthful breadcrumb data for an inner route", () => {
    const graph = buildPageGraph(findSeoPage("/oflayn-rabota/"));
    const breadcrumb = graph["@graph"].find((entry) => entry["@type"] === "BreadcrumbList");

    expect(breadcrumb).toEqual({
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Markiro", item: "https://markiro.app/" },
        {
          "@type": "ListItem",
          position: 2,
          name: "Офлайн-работа производства",
          item: "https://markiro.app/oflayn-rabota/",
        },
      ],
    });
  });

  it("localizes structured data for English pages", () => {
    const graph = buildPageGraph(findSeoPage("/en/offline-production/"));
    const website = graph["@graph"].find((entry) => entry["@type"] === "WebSite");
    const webPage = graph["@graph"].find((entry) => entry["@type"] === "WebPage");
    const breadcrumb = graph["@graph"].find((entry) => entry["@type"] === "BreadcrumbList");

    expect(website?.inLanguage).toEqual(["ru", "en"]);
    expect(webPage).toMatchObject({
      "@type": "WebPage",
      url: "https://markiro.app/en/offline-production/",
      inLanguage: "en",
    });
    expect(breadcrumb).toEqual({
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Markiro", item: "https://markiro.app/en/" },
        {
          "@type": "ListItem",
          position: 2,
          name: "Offline production",
          item: "https://markiro.app/en/offline-production/",
        },
      ],
    });
  });

  it("escapes characters that can break an inline JSON script", () => {
    const serialized = serializeJsonLd({ value: "</script>&\u2028\u2029" });

    expect(serialized).toBe('{"value":"\\u003c/script\\u003e\\u0026\\u2028\\u2029"}');
  });
});
