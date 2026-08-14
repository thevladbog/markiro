import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { auditBuiltSite, type AuditFindingCode } from "./audit";

const roots: string[] = [];

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

describe("auditBuiltSite", () => {
  it("accepts a bounded site whose routes and assets match its sitemap", async () => {
    const root = await fixture({
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
      "index.html": html(),
      "faq/index.html": html({ route: "/", title: "FAQ", description: "FAQ description" }),
      "image.svg": "<svg></svg>",
      "sitemap.xml":
        '<?xml version="1.0"?><urlset><url><loc>https://markiro.app/</loc></url><url><loc>https://markiro.app/faq/</loc></url></urlset>',
    });

    expect((await auditBuiltSite(root)).map(({ code }) => code)).toContain("DUPLICATE_CANONICAL");
  });
});
