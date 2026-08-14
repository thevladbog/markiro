import { SEO_PAGES, type SeoPageDefinition } from "../content/pages";

const SITE_URL = "https://markiro.app";

type JsonLdObject = Record<string, unknown>;

export interface PageGraph extends JsonLdObject {
  "@context": "https://schema.org";
  "@graph": JsonLdObject[];
}

function absoluteUrl(path: string): string {
  return new URL(path, SITE_URL).toString();
}

export function buildPageGraph(page: SeoPageDefinition): PageGraph {
  const graph: JsonLdObject[] = [
    {
      "@type": "WebSite",
      "@id": `${SITE_URL}/#website`,
      url: `${SITE_URL}/`,
      name: "Markiro",
      inLanguage: "ru",
      publisher: { "@id": `${SITE_URL}/#organization` },
    },
    {
      "@type": "Organization",
      "@id": `${SITE_URL}/#organization`,
      name: "Markiro",
      url: `${SITE_URL}/`,
    },
    {
      "@type": "SoftwareApplication",
      "@id": `${SITE_URL}/#software`,
      name: "Markiro",
      applicationCategory: "BusinessApplication",
      description: SEO_PAGES[0]?.description,
      provider: { "@id": `${SITE_URL}/#organization` },
    },
  ];

  if (page.path !== "/") {
    graph.push({
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Markiro", item: `${SITE_URL}/` },
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
  const urls = SEO_PAGES.map(
    (page) => `  <url>
    <loc>${absoluteUrl(page.path)}</loc>
    <lastmod>${page.reviewedAt}</lastmod>
  </url>`,
  ).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

export function renderLlmsTxt(): string {
  const links = SEO_PAGES.filter(({ path }) => path !== "/")
    .map((page) => `- [${page.navigationLabel}](${absoluteUrl(page.path)}): ${page.description}`)
    .join("\n");

  return `# Markiro

> Производственная система для маркировки, агрегации и прослеживаемости с локальной работой станций.

## Основные материалы

${links}
`;
}
