import { LEGAL_SEARCH_PAGES } from "../content/legal-pages";
import {
  MARKETING_SEARCH_PAGES,
  SEO_PAGES,
  type SearchPageRecord,
  type SeoPageDefinition,
} from "../content/pages";

const SITE_URL = "https://markiro.app";
const INDEXABLE_PAGES: readonly SearchPageRecord[] = [
  ...MARKETING_SEARCH_PAGES,
  ...LEGAL_SEARCH_PAGES,
];

type JsonLdObject = Record<string, unknown>;

export interface PageMetadata {
  path: string;
  alternatePath: string;
  locale: "ru" | "en";
  title: string;
  description: string;
  socialImage: string;
  socialImageAlt: string;
}

export interface PageGraph extends JsonLdObject {
  "@context": "https://schema.org";
  "@graph": JsonLdObject[];
}

function absoluteUrl(path: string): string {
  return new URL(path, SITE_URL).toString();
}

export function buildPageGraph(page: SeoPageDefinition): PageGraph {
  const homePath = page.locale === "ru" ? "/" : "/en/";
  const homePage = SEO_PAGES.find((candidate) => candidate.path === homePath);
  const graph: JsonLdObject[] = [
    {
      "@type": "WebSite",
      "@id": `${SITE_URL}/#website`,
      url: `${SITE_URL}/`,
      name: "Markiro",
      inLanguage: ["ru", "en"],
      publisher: { "@id": `${SITE_URL}/#organization` },
    },
    {
      "@type": "Organization",
      "@id": `${SITE_URL}/#organization`,
      name: "Markiro",
      url: `${SITE_URL}/`,
    },
    {
      "@type": "WebPage",
      "@id": `${absoluteUrl(page.path)}#webpage`,
      url: absoluteUrl(page.path),
      name: page.title,
      description: page.description,
      inLanguage: page.locale,
      isPartOf: { "@id": `${SITE_URL}/#website` },
    },
    {
      "@type": "SoftwareApplication",
      "@id": `${SITE_URL}/#software`,
      name: "Markiro",
      applicationCategory: "BusinessApplication",
      description: homePage?.description,
      inLanguage: page.locale,
      provider: { "@id": `${SITE_URL}/#organization` },
    },
  ];

  if (page.path !== homePath) {
    graph.push({
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Markiro", item: absoluteUrl(homePath) },
        {
          "@type": "ListItem",
          position: 2,
          name: page.navigationLabel,
          item: absoluteUrl(page.path),
        },
      ],
    });
  }

  if (page.faq !== undefined) {
    graph.push({
      "@type": "FAQPage",
      mainEntity: page.faq.map(({ question, answer }) => ({
        "@type": "Question",
        name: question,
        acceptedAnswer: { "@type": "Answer", text: answer },
      })),
    });
  }

  return { "@context": "https://schema.org", "@graph": graph };
}

export function buildLegalPageGraph(
  page: PageMetadata,
  dates?: { readonly published: string; readonly modified: string; readonly basedOn?: string },
): PageGraph {
  const webPage: JsonLdObject = {
    "@type": "WebPage",
    "@id": `${absoluteUrl(page.path)}#webpage`,
    url: absoluteUrl(page.path),
    name: page.title,
    description: page.description,
    inLanguage: page.locale,
    isPartOf: { "@id": `${SITE_URL}/#website` },
  };
  if (dates !== undefined) {
    webPage.datePublished = dates.published;
    webPage.dateModified = dates.modified;
    if (dates.basedOn !== undefined) webPage.isBasedOn = absoluteUrl(dates.basedOn);
  }

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        "@id": `${SITE_URL}/#website`,
        url: `${SITE_URL}/`,
        name: "Markiro",
        inLanguage: ["ru", "en"],
        publisher: { "@id": `${SITE_URL}/#organization` },
      },
      {
        "@type": "Organization",
        "@id": `${SITE_URL}/#organization`,
        name: "Markiro",
        url: `${SITE_URL}/`,
      },
      webPage,
    ],
  };
}

export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export function renderRobotsTxt(): string {
  return `User-agent: *
Allow: /

User-agent: OAI-SearchBot
Allow: /

User-agent: Claude-SearchBot
Allow: /

User-agent: Claude-User
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: GPTBot
Disallow: /

User-agent: ClaudeBot
Disallow: /

Sitemap: ${SITE_URL}/sitemap.xml
`;
}

export function renderSitemapXml(): string {
  const urls = INDEXABLE_PAGES.map(
    (page) => `  <url>
    <loc>${absoluteUrl(page.path)}</loc>
    <xhtml:link rel="alternate" hreflang="${page.locale}" href="${absoluteUrl(page.path)}" />
    <xhtml:link rel="alternate" hreflang="${page.locale === "ru" ? "en" : "ru"}" href="${absoluteUrl(page.alternatePath)}" />
    <xhtml:link rel="alternate" hreflang="x-default" href="${absoluteUrl(page.locale === "ru" ? page.path : page.alternatePath)}" />
    <lastmod>${page.lastModified}</lastmod>
  </url>`,
  ).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls}
</urlset>
`;
}

export function renderLlmsTxt(): string {
  const links = (locale: "ru" | "en", homePath: string) =>
    INDEXABLE_PAGES.filter((page) => page.locale === locale && page.path !== homePath)
      .map((page) => `- [${page.navigationLabel}](${absoluteUrl(page.path)}): ${page.description}`)
      .join("\n");

  return `# Markiro

## Русский

> Производственная система для маркировки, агрегации и прослеживаемости с локальной работой станций.

${links("ru", "/")}

## English

> Production serialization, aggregation, and traceability with offline-capable line stations.

${links("en", "/en/")}
`;
}
