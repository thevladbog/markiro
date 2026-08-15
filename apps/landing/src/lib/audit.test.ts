import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { auditBuiltSite, type AuditFindingCode } from "./audit";

const roots: string[] = [];
const MARKIRO_MODULE_GRID = [
  { x: "18", y: "8" },
  { x: "38", y: "8" },
  { x: "28", y: "18" },
  { x: "18", y: "28" },
  { x: "38", y: "28" },
  { x: "18", y: "38" },
  { x: "38", y: "38" },
  { x: "28", y: "48" },
] as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "markiro-landing-audit-"));
  roots.push(root);
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  return root;
}

function html({
  route = "/",
  title = "Unique title",
  description = "Unique description",
  body = '<h1>Heading</h1><img src="/image.svg"><a href="/faq/">FAQ</a>',
  jsonLd = '{"@context":"https://schema.org","@type":"WebPage"}',
}: {
  route?: string;
  title?: string;
  description?: string;
  body?: string;
  jsonLd?: string;
} = {}): string {
  return `<!doctype html><html><head><title>${title}</title><meta name="description" content="${description}"><link rel="canonical" href="https://markiro.app${route}"><script type="application/ld+json">${jsonLd}</script></head><body>${body}</body></html>`;
}

function brandAssets({
  faviconModules = 8,
  ordinaryFill = "#fafaf8",
  accentFill = "#3ddc7a",
  ruManifest = { lang: "ru", name: "маркиро", short_name: "маркиро" },
  enManifest = { lang: "en", name: "Markiro", short_name: "Markiro" },
}: {
  faviconModules?: number;
  ordinaryFill?: string;
  accentFill?: string;
  ruManifest?: Record<string, string>;
  enManifest?: Record<string, string>;
} = {}): Record<string, string> {
  const modules = MARKIRO_MODULE_GRID.slice(0, faviconModules).map(
    ({ x, y }, index) =>
      `<rect data-markiro-module="" x="${x}" y="${y}" width="8" height="8" fill="${index === faviconModules - 1 ? accentFill : ordinaryFill}"/>`,
  );
  return {
    "favicon.svg": `<svg>${modules.join("")}</svg>`,
    "site.webmanifest": JSON.stringify(ruManifest),
    "site.en.webmanifest": JSON.stringify(enManifest),
  };
}

describe("auditBuiltSite", () => {
  it("accepts a bounded site whose routes and assets match its sitemap", async () => {
    const root = await fixture({
      ...brandAssets(),
      "index.html": html(),
      "faq/index.html": html({
        route: "/faq/",
        title: "FAQ title",
        description: "FAQ description",
        body: '<h1>FAQ</h1><a href="/">Home</a>',
      }),
      "image.svg": '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      "sitemap.xml":
        '<?xml version="1.0"?><urlset><url><loc>https://markiro.app/</loc></url><url><loc>https://markiro.app/faq/</loc></url></urlset>',
    });

    await expect(auditBuiltSite(root)).resolves.toEqual([]);
  });

  it("reports every deterministic SEO integrity failure code", async () => {
    const root = await fixture({
      ...brandAssets(),
      "index.html": html({
        title: "Duplicate",
        description: "Duplicate description",
        body: '<h1>One</h1><h1>Two</h1><img src="/missing.svg"><a href="/absent/">Absent</a>',
        jsonLd: "{broken",
      }),
      "faq/index.html": html({
        route: "/wrong/",
        title: "Duplicate",
        description: "Duplicate description",
        body: "<main>No heading</main>",
      }),
      "empty/index.html":
        '<!doctype html><html><head><link rel="canonical" href="https://markiro.app/empty/"></head><body><h1>Empty</h1></body></html>',
      "sitemap.xml":
        '<?xml version="1.0"?><urlset><url><loc>https://markiro.app/</loc></url></urlset>',
    });

    const codes = new Set((await auditBuiltSite(root)).map(({ code }) => code));
    const expected: AuditFindingCode[] = [
      "BROKEN_INTERNAL_LINK",
      "MISSING_IMAGE",
      "MISSING_TITLE",
      "MISSING_DESCRIPTION",
      "DUPLICATE_TITLE",
      "DUPLICATE_DESCRIPTION",
      "INVALID_CANONICAL",
      "INVALID_H1",
      "INVALID_JSON_LD",
      "SITEMAP_ROUTE_MISMATCH",
    ];
    for (const code of expected) expect(codes).toContain(code);
  });

  it("reports duplicate canonicals independently of route validation", async () => {
    const root = await fixture({
      ...brandAssets(),
      "index.html": html(),
      "faq/index.html": html({ route: "/", title: "FAQ", description: "FAQ description" }),
      "image.svg": "<svg></svg>",
      "sitemap.xml":
        '<?xml version="1.0"?><urlset><url><loc>https://markiro.app/</loc></url><url><loc>https://markiro.app/faq/</loc></url></urlset>',
    });

    expect((await auditBuiltSite(root)).map(({ code }) => code)).toContain("DUPLICATE_CANONICAL");
  });

  it("rejects manifests and favicons that drift from the localized Markiro brand", async () => {
    const root = await fixture({
      ...brandAssets({
        faviconModules: 4,
        ruManifest: { lang: "ru", name: "Markiro", short_name: "Markiro" },
        enManifest: { lang: "en", name: "Markiro", short_name: "markiro" },
      }),
      "index.html": html({ body: '<h1>Heading</h1><img src="/image.svg">' }),
      "image.svg": '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      "sitemap.xml":
        '<?xml version="1.0"?><urlset><url><loc>https://markiro.app/</loc></url></urlset>',
    });

    const findings = await auditBuiltSite(root);
    expect(findings.map(({ code }) => code)).toEqual([
      "INVALID_FAVICON",
      "INVALID_MANIFEST",
      "INVALID_MANIFEST",
    ]);
    expect(findings.map(({ detail }) => detail)).toEqual([
      "favicon must contain exactly eight Markiro modules",
      "English manifest must use the Markiro name",
      "Russian manifest must use the маркиро name",
    ]);
  });

  it("rejects a favicon without the single green accent module", async () => {
    const root = await fixture({
      ...brandAssets({ accentFill: "#fafaf8" }),
      "index.html": html({ body: '<h1>Heading</h1><img src="/image.svg">' }),
      "image.svg": '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      "sitemap.xml":
        '<?xml version="1.0"?><urlset><url><loc>https://markiro.app/</loc></url></urlset>',
    });

    await expect(auditBuiltSite(root)).resolves.toContainEqual({
      code: "INVALID_FAVICON",
      route: "/favicon.svg",
      detail: "favicon modules must use seven off-white marks and one green accent",
    });
  });

  it("rejects a favicon whose modules drift from the Markiro grid", async () => {
    const modules = Array.from(
      { length: 8 },
      (_, index) =>
        `<rect data-markiro-module="" x="19" y="8" width="8" height="8" fill="${index === 7 ? "#3ddc7a" : "#fafaf8"}"/>`,
    );
    const root = await fixture({
      ...brandAssets(),
      "favicon.svg": `<svg>${modules.join("")}</svg>`,
      "index.html": html({ body: '<h1>Heading</h1><img src="/image.svg">' }),
      "image.svg": '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      "sitemap.xml":
        '<?xml version="1.0"?><urlset><url><loc>https://markiro.app/</loc></url></urlset>',
    });

    await expect(auditBuiltSite(root)).resolves.toContainEqual({
      code: "INVALID_FAVICON",
      route: "/favicon.svg",
      detail: "favicon modules must match the 3 by 5 Markiro grid",
    });
  });

  it("reports a malformed manifest without echoing its contents", async () => {
    const root = await fixture({
      ...brandAssets(),
      "site.webmanifest": `{${"x".repeat(512)}`,
      "index.html": html({ body: '<h1>Heading</h1><img src="/image.svg">' }),
      "image.svg": '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      "sitemap.xml":
        '<?xml version="1.0"?><urlset><url><loc>https://markiro.app/</loc></url></urlset>',
    });

    const findings = await auditBuiltSite(root);
    expect(findings).toContainEqual({
      code: "INVALID_MANIFEST",
      route: "/site.webmanifest",
      detail: "Russian manifest must be a JSON object",
    });
    expect(findings.map(({ detail }) => detail).join(" ")).not.toContain("x".repeat(512));
  });

  it("reports every missing legal-document identity and navigation field", async () => {
    const root = await fixture({
      ...brandAssets(),
      "privacy/index.html": html({
        route: "/privacy/",
        body: '<main><h1>Policy</h1><article data-legal-document data-legal-kind="document"></article></main>',
      }),
      "sitemap.xml":
        '<?xml version="1.0"?><urlset><url><loc>https://markiro.app/privacy/</loc></url></urlset>',
    });

    expect((await auditBuiltSite(root)).map(({ code }) => code)).toEqual([
      "MISSING_LEGAL_CODE",
      "MISSING_LEGAL_EFFECTIVE_DATE",
      "MISSING_LEGAL_REGISTRY_LINK",
      "MISSING_LEGAL_REVISION",
    ]);
  });

  it("requires an authoritative Russian link on an English legal document", async () => {
    const root = await fixture({
      ...brandAssets(),
      "en/privacy/index.html": html({
        route: "/en/privacy/",
        body: '<main><h1>Policy</h1><a href="/en/legal/">Registry</a><article data-legal-document data-legal-kind="document"><span data-legal-code>MKR-PD-01</span><span data-legal-revision>2026.08.01</span><time data-legal-effective-date>2026-08-15</time></article></main>',
      }),
      "en/legal/index.html": html({
        route: "/en/legal/",
        title: "Registry",
        description: "Legal registry",
        body: '<main><h1>Registry</h1><a href="/en/privacy/">Policy</a></main>',
      }),
      "sitemap.xml":
        '<?xml version="1.0"?><urlset><url><loc>https://markiro.app/en/privacy/</loc></url><url><loc>https://markiro.app/en/legal/</loc></url></urlset>',
    });

    await expect(auditBuiltSite(root)).resolves.toContainEqual({
      code: "MISSING_AUTHORITATIVE_LANGUAGE_LINK",
      route: "/en/privacy/",
      detail: "English legal document must link to its authoritative Russian revision",
    });
  });
});
