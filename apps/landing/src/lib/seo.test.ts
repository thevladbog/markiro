import { LEGAL_RELEASES } from "@markiro/legal-documents";
import { describe, expect, it } from "vitest";

import { BEER_MARKING_2026_ARTICLE, BEER_MARKING_2026_ARTICLE_EN } from "../content/articles";
import { findHubPage } from "../content/hubs";
import { findSeoPage } from "../content/pages";
import { getLegalDocumentPage } from "../content/legal-pages";
import {
  attachOrganizationContact,
  buildArticlePageGraph,
  buildHubPageGraph,
  buildPageGraph,
  buildLegalPageGraph,
  renderArticlesRss,
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

  it("applies the training-crawler policy to every known training agent", () => {
    const robots = renderRobotsTxt();

    for (const agent of [
      "Google-Extended",
      "Applebot-Extended",
      "CCBot",
      "Bytespider",
      "Meta-ExternalAgent",
    ]) {
      expect(robots).toContain(`User-agent: ${agent}\nDisallow: /`);
    }
    expect(robots).not.toContain("User-agent: Googlebot\nDisallow");
    expect(robots).not.toContain("User-agent: YandexBot\nDisallow");
  });

  it("tells Yandex which tracking parameters never change a page", () => {
    const robots = renderRobotsTxt();

    expect(robots).toContain(
      "User-agent: Yandex\nAllow: /\nClean-param: utm_source&utm_medium&utm_campaign&utm_content&utm_term&yclid&ysclid&gclid&fbclid&_openstat /",
    );
  });

  it("lists every canonical route with a real review date", () => {
    const sitemap = renderSitemapXml();

    expect(sitemap).toContain("<loc>https://markiro.app/</loc>");
    expect(sitemap).toMatch(
      /<loc>https:\/\/markiro\.app\/oflayn-rabota\/<\/loc>[\s\S]*?<lastmod>2026-09-06<\/lastmod>/,
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

  it("gives agents verifiable product facts, contacts and full-text pointers", () => {
    const llms = renderLlmsTxt();

    expect(llms).toContain("## Коротко о продукте");
    expect(llms).toContain("единица → короб");
    expect(llms).toContain("hello@v-b.tech");
    expect(llms).toContain("https://markiro.app/#demo");
    expect(llms).toContain("## Полные тексты");
    expect(llms).toContain("https://markiro.app/llms-full.txt");
    expect(llms).toContain("https://markiro.app/faq.md");
    expect(llms).toContain("## About the product");
    expect(llms).not.toMatch(
      /(?<!\p{L})(?:цена|цены|прайс|price|pricing|клиент\p{L}*|customer\p{L}*|гарант\p{L}*)(?!\p{L})/iu,
    );
  });

  it("publishes an RSS feed per locale with every article", () => {
    const ru = renderArticlesRss("ru");
    const en = renderArticlesRss("en");

    expect(ru).toContain('<rss version="2.0"');
    expect(ru).toContain("<link>https://markiro.app/stati/</link>");
    expect(ru).toContain("<language>ru</language>");
    expect(ru.match(/<item>/g)).toHaveLength(9);
    expect(ru).toContain(
      '<guid isPermaLink="true">https://markiro.app/stati/markirovka-piva-2026/</guid>',
    );
    expect(ru).toMatch(/<pubDate>[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} 00:00:00 GMT<\/pubDate>/);
    expect(ru).toContain("<atom:link");
    expect(ru).not.toContain("/d/");
    expect(en).toContain("<link>https://markiro.app/en/articles/</link>");
    expect(en).toContain("<language>en</language>");
    expect(en.match(/<item>/g)).toHaveLength(9);
    expect(en).not.toMatch(/[А-Яа-яЁё]/);
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
    expect(sitemap).not.toContain("<loc>https://markiro.app/d/");
    expect(llms).not.toContain("/d/");
  });

  it("lists the article and instruction hubs with their locale pairs", () => {
    const sitemap = renderSitemapXml();
    const llms = renderLlmsTxt();

    expect(sitemap).toMatch(
      /<loc>https:\/\/markiro\.app\/stati\/<\/loc>[\s\S]*?hreflang="en" href="https:\/\/markiro\.app\/en\/articles\/"/,
    );
    expect(sitemap).toMatch(
      /<loc>https:\/\/markiro\.app\/instruktsii\/<\/loc>[\s\S]*?hreflang="en" href="https:\/\/markiro\.app\/en\/instructions\/"/,
    );
    expect(sitemap).toContain("<loc>https://markiro.app/en/articles/</loc>");
    expect(sitemap).toContain("<loc>https://markiro.app/en/instructions/</loc>");
    expect(llms).toContain("](https://markiro.app/stati/):");
    expect(llms).toContain("](https://markiro.app/en/instructions/):");
  });

  it("routes article breadcrumbs through the localized hub", () => {
    const ru = buildArticlePageGraph(BEER_MARKING_2026_ARTICLE)["@graph"].find(
      (entry) => entry["@type"] === "BreadcrumbList",
    );
    const en = buildArticlePageGraph(BEER_MARKING_2026_ARTICLE_EN)["@graph"].find(
      (entry) => entry["@type"] === "BreadcrumbList",
    );

    expect(ru).toEqual({
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Markiro", item: "https://markiro.app/" },
        { "@type": "ListItem", position: 2, name: "Статьи", item: "https://markiro.app/stati/" },
        {
          "@type": "ListItem",
          position: 3,
          name: "Маркировка пива в 2026 году",
          item: "https://markiro.app/stati/markirovka-piva-2026/",
        },
      ],
    });
    expect(en).toMatchObject({
      itemListElement: [
        { position: 1, item: "https://markiro.app/en/" },
        { position: 2, name: "Articles", item: "https://markiro.app/en/articles/" },
        { position: 3, item: "https://markiro.app/en/articles/beer-marking-2026/" },
      ],
    });
  });

  it("describes a hub as a collection with its visible items", () => {
    const graph = buildHubPageGraph(findHubPage("/stati/"), [
      { name: "Маркировка пива в 2026 году", path: "/stati/markirovka-piva-2026/" },
      { name: "Агрегация пива в короба", path: "/stati/agregatsiya-piva-v-koroba/" },
    ]);
    const types = graph["@graph"].map((entry) => entry["@type"]);

    expect(types).toEqual([
      "WebSite",
      "Organization",
      "CollectionPage",
      "BreadcrumbList",
      "ItemList",
    ]);
    expect(graph["@graph"].find((entry) => entry["@type"] === "CollectionPage")).toMatchObject({
      url: "https://markiro.app/stati/",
      inLanguage: "ru",
      dateModified: findHubPage("/stati/").reviewedAt,
    });
    expect(graph["@graph"].find((entry) => entry["@type"] === "ItemList")).toEqual({
      "@type": "ItemList",
      itemListElement: [
        {
          "@type": "ListItem",
          position: 1,
          name: "Маркировка пива в 2026 году",
          url: "https://markiro.app/stati/markirovka-piva-2026/",
        },
        {
          "@type": "ListItem",
          position: 2,
          name: "Агрегация пива в короба",
          url: "https://markiro.app/stati/agregatsiya-piva-v-koroba/",
        },
      ],
    });
    expect(graph["@graph"].find((entry) => entry["@type"] === "BreadcrumbList")).toEqual({
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Markiro", item: "https://markiro.app/" },
        { "@type": "ListItem", position: 2, name: "Статьи", item: "https://markiro.app/stati/" },
      ],
    });
  });

  it("adds an instruction breadcrumb trail to legal structured data on request", () => {
    const page = getLegalDocumentPage("MKR-INS-01", "ru");
    const graph = buildLegalPageGraph(
      page.metadata,
      { published: "2026-09-02", modified: "2026-09-02" },
      { breadcrumbs: [{ name: "Инструкции", path: "/instruktsii/" }] },
    );

    expect(graph["@graph"].find((entry) => entry["@type"] === "BreadcrumbList")).toEqual({
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Markiro", item: "https://markiro.app/" },
        {
          "@type": "ListItem",
          position: 2,
          name: "Инструкции",
          item: "https://markiro.app/instruktsii/",
        },
        {
          "@type": "ListItem",
          position: 3,
          name: page.metadata.title.replace(/ — Маркиро$/, ""),
          item: "https://markiro.app/instruktsii/stantsiya-vkhod-i-start-smeny/",
        },
      ],
    });
  });

  it("dates the legal registry by its newest active release", () => {
    const sitemap = renderSitemapXml();
    const newest = LEGAL_RELEASES.filter(({ status }) => status === "active")
      .map(({ effectiveDate }) => effectiveDate)
      .sort()
      .at(-1);

    expect(newest).toBe("2026-09-02");
    expect(sitemap).toMatch(
      new RegExp(`<loc>https://markiro\\.app/legal/</loc>[\\s\\S]*?<lastmod>${newest}</lastmod>`),
    );
    expect(sitemap).toMatch(
      new RegExp(
        `<loc>https://markiro\\.app/en/legal/</loc>[\\s\\S]*?<lastmod>${newest}</lastmod>`,
      ),
    );
  });

  it("never points two hreflang alternates of one sitemap entry at the same URL", () => {
    const sitemap = renderSitemapXml();
    const entries = sitemap.match(/<url>[\s\S]*?<\/url>/g) ?? [];

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const ru = entry.match(/hreflang="ru" href="([^"]+)"/)?.[1];
      const en = entry.match(/hreflang="en" href="([^"]+)"/)?.[1];
      if (ru !== undefined && en !== undefined) expect(ru).not.toBe(en);
    }
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

  it("publishes verifiable organization contacts and brand assets", () => {
    const graph = buildPageGraph(findSeoPage("/"));
    const organization = graph["@graph"].find((entry) => entry["@type"] === "Organization");

    expect(organization).toMatchObject({
      "@id": "https://markiro.app/#organization",
      name: "Markiro",
      url: "https://markiro.app/",
      email: "hello@v-b.tech",
      logo: { "@type": "ImageObject", url: "https://markiro.app/brand/markiro-logo.svg" },
      areaServed: "RU",
      contactPoint: [
        {
          "@type": "ContactPoint",
          contactType: "sales",
          email: "hello@v-b.tech",
          availableLanguage: ["Russian", "English"],
        },
      ],
    });
    expect(organization).not.toHaveProperty("telephone");
    expect(organization).not.toHaveProperty("address");
  });

  it("attaches the public phone to the organization only when it is configured", () => {
    const graph = buildPageGraph(findSeoPage("/"));

    const untouched = attachOrganizationContact(graph, { telephone: null });
    expect(
      untouched["@graph"].find((entry) => entry["@type"] === "Organization"),
    ).not.toHaveProperty("telephone");

    const withPhone = attachOrganizationContact(graph, { telephone: "+7 934 355-14-90" });
    const organization = withPhone["@graph"].find((entry) => entry["@type"] === "Organization");
    expect(organization).toMatchObject({
      telephone: "+7 934 355-14-90",
      contactPoint: [expect.objectContaining({ telephone: "+7 934 355-14-90" })],
    });
    expect(graph["@graph"].find((entry) => entry["@type"] === "Organization")).not.toHaveProperty(
      "telephone",
    );
  });

  it("dates topic pages by their real review date", () => {
    const graph = buildPageGraph(findSeoPage("/oflayn-rabota/"));
    const webPage = graph["@graph"].find((entry) => entry["@type"] === "WebPage");

    expect(webPage).toMatchObject({ dateModified: "2026-09-06" });
  });

  it("describes the software with visible facts only", () => {
    const ru = buildPageGraph(findSeoPage("/"))["@graph"].find(
      (entry) => entry["@type"] === "SoftwareApplication",
    );
    const en = buildPageGraph(findSeoPage("/en/"))["@graph"].find(
      (entry) => entry["@type"] === "SoftwareApplication",
    );

    expect(ru).toMatchObject({
      url: "https://markiro.app/",
      operatingSystem: "Windows, Web",
      softwareHelp: { "@type": "CreativeWork", url: "https://markiro.app/instruktsii/" },
    });
    expect(ru?.featureList).toEqual([
      "Проверка кодов маркировки Data Matrix на линии",
      "Агрегация единиц в короба с SSCC",
      "Печать этикеток ZPL и TSPL",
      "Офлайн-работа станции с локальным журналом",
      "Обмен с 1С по CommerceML",
      "Выгрузки отчётов смены для ГИС МТ",
    ]);
    expect(en).toMatchObject({
      softwareHelp: { "@type": "CreativeWork", url: "https://markiro.app/en/instructions/" },
    });
    expect(en?.featureList).toEqual([
      "Data Matrix code verification on the line",
      "Item-to-case aggregation with SSCC",
      "ZPL and TSPL label printing",
      "Offline station with a local journal",
      "1C exchange over CommerceML",
      "Shift report exports for GIS MT",
    ]);
    expect(ru).not.toHaveProperty("offers");
    expect(ru).not.toHaveProperty("aggregateRating");
  });

  it("escapes characters that can break an inline JSON script", () => {
    const serialized = serializeJsonLd({ value: "</script>&\u2028\u2029" });

    expect(serialized).toBe('{"value":"\\u003c/script\\u003e\\u0026\\u2028\\u2029"}');
  });
});
