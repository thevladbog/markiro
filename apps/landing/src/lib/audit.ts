import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";

export type AuditFindingCode =
  | "BROKEN_INTERNAL_LINK"
  | "MISSING_IMAGE"
  | "MISSING_TITLE"
  | "MISSING_DESCRIPTION"
  | "DUPLICATE_TITLE"
  | "DUPLICATE_DESCRIPTION"
  | "INVALID_CANONICAL"
  | "DUPLICATE_CANONICAL"
  | "INVALID_H1"
  | "INVALID_JSON_LD"
  | "SITEMAP_ROUTE_MISMATCH"
  | "INVALID_MANIFEST"
  | "INVALID_FAVICON";

export interface AuditFinding {
  code: AuditFindingCode;
  route: string;
  detail: string;
}

interface PageRecord {
  route: string;
  document: Document;
  title: string;
  description: string;
  canonical: string;
}

const SITE_ORIGIN = "https://markiro.app";
const BRAND_MANIFESTS = [
  {
    file: "site.webmanifest",
    label: "Russian",
    expected: { lang: "ru", name: "маркиро", short_name: "маркиро" },
  },
  {
    file: "site.en.webmanifest",
    label: "English",
    expected: { lang: "en", name: "Markiro", short_name: "Markiro" },
  },
] as const;
const FAVICON_FILE = "favicon.svg";
const MARKIRO_MODULE_ATTRIBUTE = "data-markiro-module";
const MARKIRO_MODULE_FILL = "#fafaf8";
const MARKIRO_ACCENT_FILL = "#3ddc7a";

function finding(code: AuditFindingCode, route: string, detail: string): AuditFinding {
  return { code, route, detail };
}

function routeForFile(relativePath: string): string {
  const normalized = relativePath.split(path.sep).join("/");
  if (normalized === "index.html") return "/";
  if (normalized.endsWith("/index.html")) return `/${normalized.slice(0, -"index.html".length)}`;
  return `/${normalized}`;
}

function outputCandidates(url: URL): string[] {
  const pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith("/")) return [`${pathname.slice(1)}index.html`];
  return [pathname.slice(1), `${pathname.slice(1)}/index.html`];
}

async function collectFiles(root: string): Promise<Set<string>> {
  const files = new Set<string>();
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);
      if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.add(relative.split(path.sep).join("/"));
    }
  };
  await visit(root);
  return files;
}

function internalUrl(value: string, pageUrl: URL): URL | null {
  if (!value || value.startsWith("#") || /^(?:mailto|tel|data|blob):/i.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value, pageUrl);
  } catch {
    return null;
  }
  return url.origin === SITE_ORIGIN ? url : null;
}

function duplicateFindings(
  pages: PageRecord[],
  property: "title" | "description" | "canonical",
  code: AuditFindingCode,
): AuditFinding[] {
  const groups = new Map<string, string[]>();
  for (const page of pages) {
    const value = page[property];
    if (!value) continue;
    groups.set(value, [...(groups.get(value) ?? []), page.route]);
  }
  return [...groups.entries()].flatMap(([value, routes]) =>
    routes.length > 1
      ? routes.map((route) => finding(code, route, `duplicate ${property}: ${value}`))
      : [],
  );
}

function sitemapRoutes(xml: string): Set<string> | null {
  const document = new JSDOM(xml, { contentType: "text/xml" }).window.document;
  if (document.querySelector("parsererror")) return null;
  const routes = new Set<string>();
  for (const node of document.querySelectorAll("loc")) {
    try {
      const url = new URL(node.textContent?.trim() ?? "");
      if (url.origin !== SITE_ORIGIN) return null;
      routes.add(url.pathname);
    } catch {
      return null;
    }
  }
  return routes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function auditBrandAssets(root: string, files: Set<string>): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];

  for (const { file, label, expected } of BRAND_MANIFESTS) {
    const route = `/${file}`;
    if (!files.has(file)) {
      findings.push(
        finding("INVALID_MANIFEST", route, `${label} manifest is missing or unreadable`),
      );
      continue;
    }

    let manifest: unknown;
    try {
      manifest = JSON.parse(await readFile(path.join(root, file), "utf8"));
    } catch {
      findings.push(finding("INVALID_MANIFEST", route, `${label} manifest must be a JSON object`));
      continue;
    }

    if (!isRecord(manifest)) {
      findings.push(finding("INVALID_MANIFEST", route, `${label} manifest must be a JSON object`));
      continue;
    }

    if (manifest.lang !== expected.lang) {
      findings.push(
        finding(
          "INVALID_MANIFEST",
          route,
          `${label} manifest must declare the ${expected.lang} locale`,
        ),
      );
      continue;
    }
    if (manifest.name !== expected.name || manifest.short_name !== expected.short_name) {
      findings.push(
        finding("INVALID_MANIFEST", route, `${label} manifest must use the ${expected.name} name`),
      );
    }
  }

  const faviconRoute = `/${FAVICON_FILE}`;
  if (!files.has(FAVICON_FILE)) {
    findings.push(
      finding(
        "INVALID_FAVICON",
        faviconRoute,
        "favicon must contain exactly eight Markiro modules",
      ),
    );
    return findings;
  }

  let favicon: Document;
  try {
    favicon = new JSDOM(await readFile(path.join(root, FAVICON_FILE), "utf8"), {
      contentType: "image/svg+xml",
    }).window.document;
  } catch {
    findings.push(
      finding(
        "INVALID_FAVICON",
        faviconRoute,
        "favicon must contain exactly eight Markiro modules",
      ),
    );
    return findings;
  }

  const modules = [...favicon.querySelectorAll(`[${MARKIRO_MODULE_ATTRIBUTE}]`)];
  if (favicon.querySelector("parsererror") || modules.length !== 8) {
    findings.push(
      finding(
        "INVALID_FAVICON",
        faviconRoute,
        "favicon must contain exactly eight Markiro modules",
      ),
    );
    return findings;
  }

  const ordinaryModules = modules.slice(0, -1);
  const accentModule = modules.at(-1);
  if (
    ordinaryModules.some((module) => module.getAttribute("fill") !== MARKIRO_MODULE_FILL) ||
    accentModule?.getAttribute("fill") !== MARKIRO_ACCENT_FILL
  ) {
    findings.push(
      finding(
        "INVALID_FAVICON",
        faviconRoute,
        "favicon modules must use seven off-white marks and one green accent",
      ),
    );
  }

  return findings;
}

export async function auditBuiltSite(root: string): Promise<AuditFinding[]> {
  const resolvedRoot = await realpath(root);
  if (!(await lstat(resolvedRoot)).isDirectory()) throw new Error("audit root must be a directory");
  const files = await collectFiles(resolvedRoot);
  const findings: AuditFinding[] = [];
  const pages: PageRecord[] = [];

  for (const relative of [...files].filter((file) => file.endsWith(".html")).sort()) {
    const route = routeForFile(relative);
    const html = await readFile(path.join(resolvedRoot, relative), "utf8");
    const pageUrl = new URL(route, SITE_ORIGIN);
    const document = new JSDOM(html, { url: pageUrl.href }).window.document;
    const title = document.title.trim();
    const description =
      document.querySelector('meta[name="description"]')?.getAttribute("content")?.trim() ?? "";
    const canonical =
      document.querySelector('link[rel~="canonical"]')?.getAttribute("href")?.trim() ?? "";
    pages.push({ route, document, title, description, canonical });

    if (!title) findings.push(finding("MISSING_TITLE", route, "title is absent"));
    if (!description)
      findings.push(finding("MISSING_DESCRIPTION", route, "meta description is absent"));
    if (document.querySelectorAll("h1").length !== 1)
      findings.push(finding("INVALID_H1", route, "page must contain exactly one H1"));
    if (canonical !== pageUrl.href)
      findings.push(finding("INVALID_CANONICAL", route, "canonical does not match the route"));

    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const parsed: unknown = JSON.parse(script.textContent ?? "");
        if (parsed === null || typeof parsed !== "object") throw new Error("not an object");
      } catch {
        findings.push(finding("INVALID_JSON_LD", route, "JSON-LD is not a valid object"));
      }
    }

    for (const anchor of document.querySelectorAll("a[href]")) {
      const url = internalUrl(anchor.getAttribute("href") ?? "", pageUrl);
      if (!url) continue;
      if (!outputCandidates(url).some((candidate) => files.has(candidate)))
        findings.push(finding("BROKEN_INTERNAL_LINK", route, `missing target ${url.pathname}`));
    }
    for (const image of document.querySelectorAll("img[src]")) {
      const url = internalUrl(image.getAttribute("src") ?? "", pageUrl);
      if (!url) continue;
      if (!outputCandidates(url).some((candidate) => files.has(candidate)))
        findings.push(finding("MISSING_IMAGE", route, `missing image ${url.pathname}`));
    }
  }

  findings.push(...duplicateFindings(pages, "title", "DUPLICATE_TITLE"));
  findings.push(...duplicateFindings(pages, "description", "DUPLICATE_DESCRIPTION"));
  findings.push(...duplicateFindings(pages, "canonical", "DUPLICATE_CANONICAL"));

  const sitemapFile = "sitemap.xml";
  const sitemap = files.has(sitemapFile)
    ? sitemapRoutes(await readFile(path.join(resolvedRoot, sitemapFile), "utf8"))
    : null;
  const pageRoutes = new Set(pages.map(({ route }) => route));
  if (
    sitemap === null ||
    sitemap.size !== pageRoutes.size ||
    [...pageRoutes].some((route) => !sitemap.has(route))
  )
    findings.push(
      finding("SITEMAP_ROUTE_MISMATCH", "/sitemap.xml", "sitemap and HTML routes differ"),
    );

  findings.push(...(await auditBrandAssets(resolvedRoot, files)));

  return findings.sort((left, right) =>
    `${left.route}:${left.code}:${left.detail}`.localeCompare(
      `${right.route}:${right.code}:${right.detail}`,
    ),
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const root = process.argv[2];
  if (!root) throw new Error("usage: audit.ts <built-site-root>");
  const findings = await auditBuiltSite(root);
  if (findings.length > 0) {
    console.error(JSON.stringify(findings, null, 2));
    process.exitCode = 1;
  } else {
    console.log("landing built-site audit passed");
  }
}
