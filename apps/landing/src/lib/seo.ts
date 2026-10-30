import { findLegalDocument, findLegalRelease, requireLegalContent } from "@markiro/legal-documents";

import { SITE_CONTACTS } from "../content/contacts";
import { LEGAL_SEARCH_PAGES, type LegalDocumentPageDefinition } from "../content/legal-pages";
import type { PublishedLegalArtifact } from "./legal-artifacts";
import { ARTICLE_SEARCH_PAGES, type ArticlePageDefinition } from "../content/articles";
import { HUB_SEARCH_PAGES, findHubPage, hubPath, type HubPageDefinition } from "../content/hubs";
import { articlesForLocale } from "../content/articles";
import { AUTONOM_SEARCH_PAGES, type AutonomPageDefinition } from "../content/autonom-pages";
import { formatRoubles, TARIFFS } from "../content/pricing";
import { TARIFFS_EN } from "../content/autonom-en";
import { mirrorPathFor } from "./mirror-path.ts";

export { mirrorPathFor };
import {
  MARKETING_SEARCH_PAGES,
  SEO_PAGES,
  type SearchPageRecord,
  type SeoPageDefinition,
} from "../content/pages";

const SITE_URL = "https://markiro.app";
const ORGANIZATION_EMAIL = SITE_CONTACTS.email;
const ORGANIZATION_LOGO_PATH = "/brand/markiro-logo.svg";
const INDEXABLE_PAGES: readonly SearchPageRecord[] = [
  ...MARKETING_SEARCH_PAGES,
  ...AUTONOM_SEARCH_PAGES,
  ...HUB_SEARCH_PAGES,
  ...ARTICLE_SEARCH_PAGES,
  ...LEGAL_SEARCH_PAGES,
];
const SOFTWARE_FACTS = {
  ru: {
    helpPath: "/instruktsii/",
    features: [
      "Проверка кодов маркировки Data Matrix на линии",
      "Агрегация в короба и паллеты с SSCC",
      "Печать этикеток ZPL и TSPL",
      "Работа без интернета: программа и база на ПК завода",
      "Сборка паллет на ТСД с Android",
      "Выгрузки смены в TXT, CSV и XML для ГИС МТ и 1С",
    ],
  },
  en: {
    helpPath: "/en/instructions/",
    features: [
      "Data Matrix code verification on the line",
      "Case and pallet aggregation with SSCC",
      "ZPL and TSPL label printing",
      "No internet needed: the software and the database run on the plant's PCs",
      "Pallet building on an Android handheld",
      "Shift exports in TXT, CSV and XML for GIS MT and 1C",
    ],
  },
} as const;

type JsonLdObject = Record<string, unknown>;

export interface OrganizationContact {
  telephone: string | null;
}

export interface BreadcrumbTrailItem {
  name: string;
  path: string;
}

export interface HubItem {
  name: string;
  path: string;
}

export interface LegalGraphOptions {
  breadcrumbs?: readonly BreadcrumbTrailItem[];
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

/** Page translations describe the same application; the application UI is Russian. */
function softwareReference(locale: "ru" | "en"): JsonLdObject {
  return {
    "@type": "SoftwareApplication",
    "@id": `${SITE_URL}/#software`,
    name: locale === "ru" ? "Маркиро Автоном" : "Markiro Autonom",
  };
}

function softwareNode(locale: "ru" | "en"): JsonLdObject {
  const facts = SOFTWARE_FACTS[locale];
  const homePath = locale === "ru" ? "/" : "/en/";
  return {
    ...softwareReference(locale),
    alternateName:
      locale === "ru" ? ["Markiro Autonom", "Markiro"] : ["Маркиро Автоном", "Markiro"],
    url: absoluteUrl(homePath),
    applicationCategory: "BusinessApplication",
    operatingSystem: "Windows 10, Windows 11, Android",
    description: SEO_PAGES.find((page) => page.path === homePath)?.description,
    inLanguage: "ru",
    installUrl: absoluteUrl("/skachat/"),
    featureList: [...facts.features],
    softwareHelp: {
      "@type": "CreativeWork",
      "@id": `${absoluteUrl(facts.helpPath)}#webpage`,
      url: absoluteUrl(facts.helpPath),
    },
    provider: { "@id": `${SITE_URL}/#organization` },
  };
}

function breadcrumbList(locale: "ru" | "en", items: readonly BreadcrumbTrailItem[]): JsonLdObject {
  const homePath = locale === "ru" ? "/" : "/en/";
  return {
    "@type": "BreadcrumbList",
    itemListElement: [{ name: "Markiro", path: homePath }, ...items].map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: absoluteUrl(item.path),
    })),
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
      about: { "@id": `${SITE_URL}/#software` },
    },
    softwareNode(page.locale),
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
  const hub = findHubPage(hubPath(page.locale, "articles"));
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
      breadcrumbList(page.locale, [
        { name: hub.navigationLabel, path: hub.path },
        { name: page.navigationLabel, path: page.path },
      ]),
    ],
  };
}

export function buildHubPageGraph(hub: HubPageDefinition, items: readonly HubItem[]): PageGraph {
  return {
    "@context": "https://schema.org",
    "@graph": [
      websiteNode(),
      organizationNode(),
      {
        "@type": "CollectionPage",
        "@id": `${absoluteUrl(hub.path)}#webpage`,
        url: absoluteUrl(hub.path),
        name: hub.title,
        description: hub.description,
        inLanguage: hub.locale,
        dateModified: hub.reviewedAt,
        isPartOf: { "@id": `${SITE_URL}/#website` },
        mainEntity: { "@id": `${absoluteUrl(hub.path)}#items` },
        ...(hub.kind === "instructions" ? { about: softwareReference(hub.locale) } : {}),
      },
      breadcrumbList(hub.locale, [{ name: hub.navigationLabel, path: hub.path }]),
      {
        "@type": "ItemList",
        "@id": `${absoluteUrl(hub.path)}#items`,
        numberOfItems: items.length,
        itemListElement: items.map((item, index) => ({
          "@type": "ListItem",
          position: index + 1,
          name: item.name,
          url: absoluteUrl(item.path),
        })),
      },
    ],
  };
}

export interface AutonomGraphOptions {
  readonly faq?: readonly { question: string; answer: string }[];
  /** Adds the Product with one Offer per published yearly price (/stoimost/). */
  readonly offers?: boolean;
}

function productNode(page: AutonomPageDefinition): JsonLdObject {
  const pageUrl = absoluteUrl(page.path);
  const offers = TARIFFS.flatMap((tariff) =>
    tariff.pricePerYear === null
      ? []
      : [
          {
            "@type": "Offer",
            name: `«${tariff.name}»`,
            description: tariff.features.join(", "),
            url: pageUrl,
            price: tariff.pricePerYear,
            priceCurrency: "RUB",
            availability: "https://schema.org/InStock",
            seller: { "@id": `${SITE_URL}/#organization` },
            priceSpecification: {
              "@type": "UnitPriceSpecification",
              price: tariff.pricePerYear,
              priceCurrency: "RUB",
              valueAddedTaxIncluded: false,
              unitText: "год",
              referenceQuantity: { "@type": "QuantitativeValue", value: 1, unitCode: "ANN" },
            },
          },
        ],
  );
  const prices = offers.map((offer) => offer.price);
  return {
    ...softwareNode(page.locale),
    "@type": ["SoftwareApplication", "Product"],
    description:
      "Программа маркировки и агрегации для Windows: станция на линии, ТСД на складе и офис на ПК заказчика. Лицензия на площадку на год.",
    brand: { "@type": "Brand", name: "Маркиро" },
    category: "Программное обеспечение для маркировки и агрегации",
    offers: {
      "@type": "AggregateOffer",
      priceCurrency: "RUB",
      lowPrice: Math.min(...prices),
      highPrice: Math.max(...prices),
      offerCount: offers.length,
      offers,
    },
  };
}

export function buildAutonomPageGraph(
  page: AutonomPageDefinition,
  options: AutonomGraphOptions = {},
): PageGraph {
  const pageUrl = absoluteUrl(page.path);
  const graph: JsonLdObject[] = [
    websiteNode(),
    organizationNode(),
    {
      "@type": "WebPage",
      "@id": `${pageUrl}#webpage`,
      url: pageUrl,
      name: page.title,
      description: page.description,
      inLanguage: page.locale,
      dateModified: page.reviewedAt,
      isPartOf: { "@id": `${SITE_URL}/#website` },
      about: { "@id": `${SITE_URL}/#software` },
    },
  ];
  graph.push(options.offers === true ? productNode(page) : softwareNode(page.locale));
  if (options.faq !== undefined) {
    graph.push({
      "@type": "FAQPage",
      mainEntity: options.faq.map(({ question, answer }) => ({
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
  options: LegalGraphOptions = {},
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
      websiteNode(),
      organizationNode(),
      webPage,
      ...(options.breadcrumbs === undefined
        ? []
        : [
            breadcrumbList(page.locale, [
              ...options.breadcrumbs,
              {
                name: page.title.replace(/ — (?:Маркиро(?: Автоном)?|Markiro(?: Autonom)?)$/, ""),
                path: page.path,
              },
            ]),
          ]),
    ],
  };
}

/** Content, edition dates and PDF links come from the same sources as the visible instruction. */
export function buildInstructionPageGraph(
  page: LegalDocumentPageDefinition,
  artifacts: readonly PublishedLegalArtifact[],
): PageGraph {
  const release = findLegalRelease(page.code);
  const content = requireLegalContent(findLegalDocument(page.code), page.locale);
  const hub = findHubPage(hubPath(page.locale, "instructions"));
  const pageUrl = absoluteUrl(page.metadata.path);
  const instructionId = `${pageUrl}#instruction`;
  const graph = buildLegalPageGraph(
    page.metadata,
    { published: release.effectiveDate, modified: release.effectiveDate },
    { breadcrumbs: [{ name: hub.navigationLabel, path: hub.path }] },
  );
  const instruction: JsonLdObject = {
    "@type": "TechArticle",
    "@id": instructionId,
    url: pageUrl,
    headline: content.title,
    description: content.summary,
    identifier: release.code,
    version: release.revision,
    datePublished: release.effectiveDate,
    dateModified: release.effectiveDate,
    inLanguage: page.locale,
    about: softwareReference(page.locale),
    isPartOf: { "@id": `${absoluteUrl(hub.path)}#webpage` },
    mainEntityOfPage: { "@id": `${pageUrl}#webpage` },
    author: { "@id": `${SITE_URL}/#organization` },
    publisher: { "@id": `${SITE_URL}/#organization` },
    hasPart: content.sections.map((section) => ({
      "@type": "WebPageElement",
      "@id": `${pageUrl}#${section.id}`,
      name: section.heading,
    })),
    encoding: artifacts
      .filter((artifact) => artifact.kind === "pdfa-2b")
      .map((artifact) => ({
        "@type": "MediaObject",
        contentUrl: absoluteUrl(artifact.href),
        encodingFormat: artifact.mediaType,
        inLanguage: artifact.locale,
      })),
  };
  if (page.locale === "en") {
    instruction.translationOfWork = { "@id": `${absoluteUrl(release.routes.ru)}#instruction` };
  }
  return {
    ...graph,
    "@graph": [
      ...graph["@graph"].map((node) =>
        node["@type"] === "WebPage" ? { ...node, mainEntity: { "@id": instructionId } } : node,
      ),
      instruction,
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

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function rfc822(date: string): string {
  return new Date(`${date}T00:00:00Z`).toUTCString();
}

export function renderArticlesRss(locale: "ru" | "en"): string {
  const hub = findHubPage(hubPath(locale, "articles"));
  const articles = articlesForLocale(locale);
  const newest =
    articles
      .map(({ publishedAt }) => publishedAt)
      .sort()
      .at(-1) ?? hub.reviewedAt;
  const items = articles
    .map((article) => {
      const url = absoluteUrl(article.path);
      return `    <item>
      <title>${escapeXml(article.heading)}</title>
      <link>${url}</link>
      <guid isPermaLink="true">${url}</guid>
      <pubDate>${rfc822(article.publishedAt)}</pubDate>
      <description>${escapeXml(article.description)}</description>
    </item>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(hub.title)}</title>
    <link>${absoluteUrl(hub.path)}</link>
    <description>${escapeXml(hub.description)}</description>
    <language>${locale}</language>
    <lastBuildDate>${rfc822(newest)}</lastBuildDate>
    <atom:link href="${absoluteUrl(`${hub.path}rss.xml`)}" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>
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

> «Маркиро Автоном»: программа маркировки и агрегации для Windows. Программа, база и копии работают на ПК заказчика, интернет для смены не нужен.

## Коротко о продукте

- Что это: производственная программа маркировки «Честный знак». Главный ПК в офисе держит базу, станции на линиях и ТСД на складе подключаются к нему по локальной сети завода.
- Станция: проверяет каждый код Data Matrix при сканировании (структура GS1, GTIN товара смены, дубли, неполное чтение), собирает короба и паллеты с SSCC, печатает этикетки ZPL или TSPL.
- Товарные группы: любая маркируемая продукция, например соки и вода, молочная продукция, пиво, косметика. Правила конкретной товарной группы сверяются до запуска.
- Уровни агрегации: единица → короб → паллета. Паллеты собирают на станции и на ТСД.
- ТСД: терминал на Android собирает и разбирает паллеты и печатает их этикетки в той же смене.
- Офис: смены, товары, шаблоны этикеток, конфликты, резервные копии и выгрузки смены в TXT, CSV и XML для ГИС МТ на том же ПК.
- 1С: данные смены передаются в 1С файлами выгрузки. Прямой обмен с 1С и загрузка каталога из файла в планах.
- Без облака: во время смены программа не обращается к серверам Маркиро, обновления ставятся из файла, лицензия загружается файлом.
- Пробный период: 14 дней со всеми функциями, без оплаты. Установщик для Windows 10 и 11: ${absoluteUrl("/skachat/")}
- Цены за площадку в год, без НДС: ${TARIFFS.map((tariff) => `«${tariff.name}» ${tariff.pricePerYear === null ? "по запросу" : `${formatRoubles(tariff.pricePerYear)} ₽`}`).join(", ")}. Подробно: ${absoluteUrl("/stoimost/")}
- Контакт: ${ORGANIZATION_EMAIL}, Telegram @${SITE_CONTACTS.telegram.handle}. Разбор линии по видеосвязи: ${absoluteUrl("/#demo")}

${links("ru", "/")}

## English

> Markiro Autonom: serialization and aggregation software for Windows. The software, the database and the backups run on the plant's own PCs; a shift needs no internet.

## About the product

- What it is: Chestny ZNAK production serialization software. The main PC in the office holds the database; stations on the lines and handhelds in the warehouse connect to it over the plant's local network.
- Station: validates every Data Matrix code at scan time (GS1 structure, the shift's GTIN, duplicates, partial reads), builds cases and pallets with SSCC and prints labels in ZPL or TSPL.
- Product groups: any marked goods, for example juice and water, dairy, beer and cosmetics. The rules of a specific product group are checked before launch.
- Aggregation levels: item → case → pallet. Pallets are built on the station and on the handheld.
- Handheld: an Android terminal builds pallets, adds and removes cases and prints pallet labels in the same shift.
- Office: shifts, products, label templates, conflicts, backups and shift exports in TXT, CSV and XML for GIS MT on the same PC.
- 1C: shift data reaches 1C as export files. A direct 1C exchange and a catalogue import from a file are planned.
- No cloud: during a shift the software contacts no Markiro servers; updates and the licence are loaded from a file.
- Interface language: Russian.
- Trial: 14 days with every feature, no payment. The download page is in Russian: ${absoluteUrl("/skachat/")}
- Prices per site per year in roubles, VAT not applicable: ${TARIFFS.map((tariff) => `${TARIFFS_EN[tariff.code].name} ${tariff.pricePerYear === null ? "on request" : `${formatRoubles(tariff.pricePerYear)} RUB`}`).join(", ")}. The pricing page is in Russian: ${absoluteUrl("/stoimost/")}
- Contact: ${ORGANIZATION_EMAIL}. A 30-minute video call about your line: ${absoluteUrl("/en/#demo")}

${links("en", "/en/")}

## Полные тексты

- Все страницы одним файлом в Markdown: ${absoluteUrl("/llms-full.txt")}
- Markdown-версия любой страницы: адрес без завершающего слэша плюс .md, например ${absoluteUrl("/faq.md")}

## Full texts

- Every page in one Markdown file: ${absoluteUrl("/llms-full.txt")}
- A Markdown version of any page: its address without the trailing slash plus .md, for example ${absoluteUrl("/en/faq.md")}
`;
}
