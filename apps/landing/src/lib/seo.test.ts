import { describe, expect, it } from "vitest";

import { findSeoPage } from "../content/pages";
import { getLegalDocumentPage } from "../content/legal-pages";
import {
  buildPageGraph,
  buildLegalPageGraph,
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
    expect(sitemap).toMatch(
      /<loc>https:\/\/markiro\.app\/stati\/agregatsiya-piva-v-koroba\/<\/loc>[\s\S]*?<lastmod>2026-08-26<\/lastmod>/,
    );
    expect(sitemap).toMatch(
      /<loc>https:\/\/markiro\.app\/stati\/markirovka-piva-2026\/<\/loc>[\s\S]*?<lastmod>2026-08-26<\/lastmod>/,
    );
    expect(sitemap).toContain("<loc>https://markiro.app/en/articles/beer-case-aggregation/</loc>");
    expect(sitemap).toContain("<loc>https://markiro.app/en/articles/beer-marking-2026/</loc>");
    expect(sitemap).toContain(
      "<loc>https://markiro.app/stati/data-matrix-pivo-ne-schityvaetsya/</loc>",
    );
    expect(sitemap).toContain(
      "<loc>https://markiro.app/en/articles/beer-data-matrix-not-scanning/</loc>",
    );
    expect(sitemap).toContain(
      "<loc>https://markiro.app/stati/oborudovanie-dlya-markirovki-piva/</loc>",
    );
    expect(sitemap).toContain(
      "<loc>https://markiro.app/en/articles/beer-marking-line-equipment/</loc>",
    );
    expect(sitemap).toContain("<loc>https://markiro.app/stati/stoimost-markirovki-piva/</loc>");
    expect(sitemap).toContain(
      "<loc>https://markiro.app/en/articles/beer-marking-cost-russia/</loc>",
    );
    expect(sitemap).toContain(
      "<loc>https://markiro.app/stati/nanesenie-data-matrix-na-pivo/</loc>",
    );
    expect(sitemap).toContain(
      "<loc>https://markiro.app/en/articles/beer-data-matrix-application-methods/</loc>",
    );
    expect(sitemap).toContain(
      "<loc>https://markiro.app/stati/markirovka-piva-bez-interneta/</loc>",
    );
    expect(sitemap).toContain(
      "<loc>https://markiro.app/en/articles/offline-beer-marking-russia/</loc>",
    );
    expect(sitemap).toContain("<loc>https://markiro.app/stati/dubl-koda-markirovki-pivo/</loc>");
    expect(sitemap).toContain(
      "<loc>https://markiro.app/en/articles/duplicate-beer-marking-code-russia/</loc>",
    );
    expect(sitemap).toContain(
      "<loc>https://markiro.app/stati/otchet-o-nanesenii-kodov-pivo/</loc>",
    );
    expect(sitemap).toContain(
      "<loc>https://markiro.app/en/articles/beer-code-application-report-russia/</loc>",
    );
    expect(sitemap).toContain('hreflang="ru"');
    expect(sitemap).toContain('hreflang="en"');
    expect(sitemap).toContain('hreflang="x-default"');
    expect(sitemap.match(/<url>/g)).toHaveLength(62);
  });

  it("publishes an experimental content map without ranking claims", () => {
    const llms = renderLlmsTxt();

    expect(llms).toContain("# Markiro");
    expect(llms).toContain(
      "> Производственная система для маркировки, агрегации и прослеживаемости с локальной работой станций.",
    );
    expect(llms).toContain("https://markiro.app/sscc-i-agregatsiya/");
    expect(llms).toContain("https://markiro.app/stati/agregatsiya-piva-v-koroba/");
    expect(llms).toContain("https://markiro.app/stati/markirovka-piva-2026/");
    expect(llms).toContain("https://markiro.app/en/articles/beer-case-aggregation/");
    expect(llms).toContain("https://markiro.app/en/articles/beer-marking-2026/");
    expect(llms).toContain("https://markiro.app/stati/data-matrix-pivo-ne-schityvaetsya/");
    expect(llms).toContain("https://markiro.app/en/articles/beer-data-matrix-not-scanning/");
    expect(llms).toContain("https://markiro.app/stati/oborudovanie-dlya-markirovki-piva/");
    expect(llms).toContain("https://markiro.app/en/articles/beer-marking-line-equipment/");
    expect(llms).toContain("https://markiro.app/stati/stoimost-markirovki-piva/");
    expect(llms).toContain("https://markiro.app/en/articles/beer-marking-cost-russia/");
    expect(llms).toContain("https://markiro.app/stati/nanesenie-data-matrix-na-pivo/");
    expect(llms).toContain("https://markiro.app/en/articles/beer-data-matrix-application-methods/");
    expect(llms).toContain("https://markiro.app/stati/markirovka-piva-bez-interneta/");
    expect(llms).toContain("https://markiro.app/en/articles/offline-beer-marking-russia/");
    expect(llms).toContain("https://markiro.app/stati/dubl-koda-markirovki-pivo/");
    expect(llms).toContain("https://markiro.app/en/articles/duplicate-beer-marking-code-russia/");
    expect(llms).toContain("https://markiro.app/stati/otchet-o-nanesenii-kodov-pivo/");
    expect(llms).toContain("https://markiro.app/en/articles/beer-code-application-report-russia/");
    expect(llms).toContain("## English");
    expect(llms).toContain(
      "> Production serialization, aggregation, and traceability with offline-capable line stations.",
    );
    expect(llms).toContain("https://markiro.app/en/sscc-and-aggregation/");
    expect(llms).not.toMatch(/ranking|ранжир/i);
  });

  it("discovers every active bilingual legal route exactly once", () => {
    const sitemap = renderSitemapXml();
    const llms = renderLlmsTxt();
    const legalRoutes = [
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
    ];
    for (const route of legalRoutes) {
      expect(
        sitemap.match(new RegExp(`<loc>https://markiro\\.app${route}</loc>`, "g")),
      ).toHaveLength(1);
      expect(
        llms.split("\n").filter((line) => line.includes(`](https://markiro.app${route}):`)),
      ).toHaveLength(1);
    }
    expect(sitemap.match(/<url>/g)).toHaveLength(62);
    expect(sitemap).toMatch(
      /<loc>https:\/\/markiro\.app\/privacy\/<\/loc>[\s\S]*?<lastmod>2026-08-15<\/lastmod>/,
    );
    expect(sitemap).toMatch(
      /<loc>https:\/\/markiro\.app\/en\/privacy\/<\/loc>[\s\S]*?hreflang="ru" href="https:\/\/markiro\.app\/privacy\/"/,
    );
    for (const code of ["MKR-PD-01", "MKR-PD-02", "MKR-DPA-01", "MKR-BRD-01"]) {
      expect(
        sitemap.match(
          new RegExp(`<loc>https://markiro\\.app/d/${code}/2026\\.08/01/15\\.08\\.2026</loc>`, "g"),
        ),
      ).toHaveLength(1);
    }
    expect(llms).not.toContain("/d/");
  });

  it("links English legal structured data to the authoritative Russian revision", () => {
    const page = getLegalDocumentPage("MKR-PD-01", "en");
    const graph = buildLegalPageGraph(page.metadata, {
      basedOn: "/privacy/",
      modified: "2026-08-15",
      published: "2026-08-15",
    });
    expect(graph["@graph"].find((entry) => entry["@type"] === "WebPage")).toMatchObject({
      dateModified: "2026-08-15",
      datePublished: "2026-08-15",
      inLanguage: "en",
      isBasedOn: "https://markiro.app/privacy/",
    });
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
