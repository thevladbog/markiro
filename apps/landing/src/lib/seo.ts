import { OPERATOR_PROFILES } from "@markiro/legal-documents";

import { LEGAL_SEARCH_PAGES } from "../content/legal-pages";
import { ARTICLE_SEARCH_PAGES, type ArticlePageDefinition } from "../content/articles";
import {
  MARKETING_SEARCH_PAGES,
  SEO_PAGES,
  type SearchPageRecord,
  type SeoPageDefinition,
} from "../content/pages";

const SITE_URL = "https://markiro.app";
const ORGANIZATION_EMAIL = OPERATOR_PROFILES["operator-2026-08-15"].email;
const ORGANIZATION_LOGO_PATH = "/brand/markiro-logo.svg";
const INDEXABLE_PAGES: readonly SearchPageRecord[] = [
  ...MARKETING_SEARCH_PAGES,
  ...ARTICLE_SEARCH_PAGES,
  ...LEGAL_SEARCH_PAGES,
];
const SOFTWARE_FACTS = {
  ru: {
    helpPath: "/instruktsii/",
    features: [
      "Проверка кодов маркировки Data Matrix на линии",
      "Агрегация единиц в короба с SSCC",
      "Печать этикеток ZPL и TSPL",
      "Офлайн-работа станции с локальным журналом",
      "Обмен с 1С по CommerceML",
      "Выгрузки отчётов смены для ГИС МТ",
    ],
  },
  en: {
    helpPath: "/en/instructions/",
    features: [
      "Data Matrix code verification on the line",
      "Item-to-case aggregation with SSCC",
      "ZPL and TSPL label printing",
      "Offline station with a local journal",
      "1C exchange over CommerceML",
      "Shift report exports for GIS MT",
    ],
  },
} as const;

type JsonLdObject = Record<string, unknown>;

export interface OrganizationContact {
  telephone: string | null;
}

export interface PageMetadata {
  path: string;
  alternatePath?: string;
  locale: "ru" | "en";
  title: string;
  description: string;
  socialImage: string;
  socialImageAlt: string;
  ogType?: "article" | "website";
  publishedAt?: string;
  modifiedAt?: string;
}

export interface PageGraph extends JsonLdObject {
  "@context": "https://schema.org";
  "@graph": JsonLdObject[];
}

function absoluteUrl(path: string): string {
  return new URL(path, SITE_URL).toString();
}

function websiteNode(): JsonLdObject {
  return {
    "@type": "WebSite",
    "@id": `${SITE_URL}/#website`,
    url: `${SITE_URL}/`,
    name: "Markiro",
    inLanguage: ["ru", "en"],
    publisher: { "@id": `${SITE_URL}/#organization` },
  };
}

/**
 * The organization publishes only contacts that are already public elsewhere on
 * the site: the operator e-mail from the legal profile and the brand logo. The
 * phone is attached separately because it exists only in configured builds.
 */
function organizationNode(): JsonLdObject {
  return {
    "@type": "Organization",
    "@id": `${SITE_URL}/#organization`,
    name: "Markiro",
    url: `${SITE_URL}/`,
    logo: { "@type": "ImageObject", url: absoluteUrl(ORGANIZATION_LOGO_PATH) },
    email: ORGANIZATION_EMAIL,
    areaServed: "RU",
    contactPoint: [
      {
        "@type": "ContactPoint",
        contactType: "sales",
        email: ORGANIZATION_EMAIL,
        availableLanguage: ["Russian", "English"],
      },
    ],
  };
}

export function attachOrganizationContact(
  graph: PageGraph,
  contact: OrganizationContact,
): PageGraph {
  if (contact.telephone === null) return graph;
  return {
    ...graph,
    "@graph": graph["@graph"].map((entry) => {
      if (entry["@type"] !== "Organization") return entry;
      const contactPoints: readonly unknown[] = Array.isArray(entry.contactPoint)
        ? (entry.contactPoint as readonly unknown[])
        : [];
      return {
        ...entry,
        telephone: contact.telephone,
        contactPoint: contactPoints.map((point) =>
          point !== null && typeof point === "object"
            ? { ...(point as JsonLdObject), telephone: contact.telephone }
            : point,
        ),
      };
    }),
  };
}

export function buildPageGraph(page: SeoPageDefinition): PageGraph {
  const homePath = page.locale === "ru" ? "/" : "/en/";
  const homePage = SEO_PAGES.find((candidate) => candidate.path === homePath);
  const facts = SOFTWARE_FACTS[page.locale];
  const graph: JsonLdObject[] = [
    websiteNode(),
    organizationNode(),
    {
      "@type": "WebPage",
      "@id": `${absoluteUrl(page.path)}#webpage`,
      url: absoluteUrl(page.path),
      name: page.title,
      description: page.description,
      inLanguage: page.locale,
      dateModified: page.reviewedAt,
      isPartOf: { "@id": `${SITE_URL}/#website` },
    },
    {
      "@type": "SoftwareApplication",
      "@id": `${SITE_URL}/#software`,
      name: "Markiro",
      url: `${SITE_URL}/`,
      applicationCategory: "BusinessApplication",
      operatingSystem: "Windows, Web",
      description: homePage?.description,
      inLanguage: page.locale,
      featureList: [...facts.features],
      softwareHelp: { "@type": "CreativeWork", url: absoluteUrl(facts.helpPath) },
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

export function buildArticlePageGraph(page: ArticlePageDefinition): PageGraph {
  const pageUrl = absoluteUrl(page.path);
  const homeUrl = page.locale === "ru" ? `${SITE_URL}/` : `${SITE_URL}/en/`;
  return {
    "@context": "https://schema.org",
    "@graph": [
      websiteNode(),
      organizationNode(),
      {
        "@type": "WebPage",
        "@id": `${pageUrl}#webpage`,
        url: pageUrl,
        name: page.title,
        description: page.description,
        inLanguage: page.locale,
        isPartOf: { "@id": `${SITE_URL}/#website` },
      },
      {
        "@type": "Article",
        "@id": `${pageUrl}#article`,
        headline: page.heading,
        description: page.description,
        image: absoluteUrl(page.socialImage),
        datePublished: page.publishedAt,
        dateModified: page.modifiedAt,
        inLanguage: page.locale,
        mainEntityOfPage: { "@id": `${pageUrl}#webpage` },
        author: { "@id": `${SITE_URL}/#organization` },
        publisher: { "@id": `${SITE_URL}/#organization` },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Markiro", item: homeUrl },
          { "@type": "ListItem", position: 2, name: page.navigationLabel, item: pageUrl },
        ],
      },
    ],
  };
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
    "@graph": [websiteNode(), organizationNode(), webPage],
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

User-agent: Yandex
Allow: /
Clean-param: utm_source&utm_medium&utm_campaign&utm_content&utm_term&yclid&ysclid&gclid&fbclid&_openstat /

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

User-agent: Google-Extended
Disallow: /

User-agent: Applebot-Extended
Disallow: /

User-agent: CCBot
Disallow: /

User-agent: Bytespider
Disallow: /

User-agent: Meta-ExternalAgent
Disallow: /

Sitemap: ${SITE_URL}/sitemap.xml
`;
}

export function renderSitemapXml(): string {
  const urls = INDEXABLE_PAGES.map((page) => {
    const alternateLinks =
      page.alternatePath === undefined || page.alternatePath === page.path
        ? `    <xhtml:link rel="alternate" hreflang="${page.locale}" href="${absoluteUrl(page.path)}" />`
        : `    <xhtml:link rel="alternate" hreflang="${page.locale}" href="${absoluteUrl(page.path)}" />
    <xhtml:link rel="alternate" hreflang="${page.locale === "ru" ? "en" : "ru"}" href="${absoluteUrl(page.alternatePath)}" />
    <xhtml:link rel="alternate" hreflang="x-default" href="${absoluteUrl(page.locale === "ru" ? page.path : page.alternatePath)}" />`;

    return `  <url>
    <loc>${absoluteUrl(page.path)}</loc>
${alternateLinks}
    <lastmod>${page.lastModified}</lastmod>
  </url>`;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls}
</urlset>
`;
}

export function renderLlmsTxt(): string {
  const links = (locale: "ru" | "en", homePath: string) =>
    INDEXABLE_PAGES.filter(
      (page) => page.locale === locale && page.path !== homePath && !page.path.startsWith("/d/"),
    )
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
