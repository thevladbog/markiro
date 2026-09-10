import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";

import { mirrorPathFor } from "./mirror-path.ts";

export { mirrorPathFor };

const SITE_URL = "https://markiro.app";
const SKIPPED_TAGS = new Set([
  "NAV",
  "SCRIPT",
  "STYLE",
  "TEMPLATE",
  "SVG",
  "BUTTON",
  "FORM",
  "NOSCRIPT",
]);

interface MirrorDocument {
  route: string;
  lang: string;
  markdown: string;
}

function isSkipped(element: Element): boolean {
  return (
    SKIPPED_TAGS.has(element.tagName) ||
    element.getAttribute("aria-hidden") === "true" ||
    element.hasAttribute("hidden")
  );
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function inline(node: Node, baseUrl: string): string {
  if (node.nodeType === node.TEXT_NODE) return node.textContent ?? "";
  if (node.nodeType !== node.ELEMENT_NODE) return "";
  const element = node as Element;
  if (isSkipped(element)) return "";
  if (element.tagName === "BR") return " ";
  const inner = [...element.childNodes].map((child) => inline(child, baseUrl)).join("");
  if (element.tagName === "A") {
    const href = element.getAttribute("href");
    const text = collapse(inner);
    if (href === null || text.length === 0) return inner;
    try {
      return `[${text}](${new URL(href, baseUrl).toString()})`;
    } catch {
      return inner;
    }
  }
  if (element.tagName === "IMG") {
    const src = element.getAttribute("src");
    if (src === null) return "";
    return `![${collapse(element.getAttribute("alt") ?? "")}](${new URL(src, baseUrl).toString()})`;
  }
  return inner;
}

function listItems(list: Element, baseUrl: string, ordered: boolean): string {
  return [...list.children]
    .filter((item) => item.tagName === "LI" && !isSkipped(item))
    .map((item, index) => {
      const text = collapse(inline(item, baseUrl));
      return ordered ? `${index + 1}. ${text}` : `- ${text}`;
    })
    .join("\n");
}

function walk(element: Element, blocks: string[], baseUrl: string): void {
  for (const child of element.children) {
    if (isSkipped(child)) continue;
    const tag = child.tagName;
    if (/^H[1-6]$/.test(tag)) {
      const level = Number(tag.slice(1));
      const text = collapse(inline(child, baseUrl));
      if (text.length > 0) blocks.push(`${"#".repeat(level)} ${text}`);
      continue;
    }
    if (
      tag === "P" ||
      tag === "FIGCAPTION" ||
      tag === "TIME" ||
      tag === "SMALL" ||
      tag === "SPAN" ||
      tag === "STRONG"
    ) {
      const text = collapse(inline(child, baseUrl));
      // Bare ordinal badges ("01") carry no meaning outside the visual layout.
      if (text.length > 0 && !/^\d{1,3}$/.test(text)) blocks.push(text);
      continue;
    }
    if (tag === "UL" || tag === "OL") {
      const items = listItems(child, baseUrl, tag === "OL");
      if (items.length > 0) blocks.push(items);
      continue;
    }
    if (tag === "IMG") {
      const text = inline(child, baseUrl);
      if (text.length > 0) blocks.push(text);
      continue;
    }
    if (tag === "BLOCKQUOTE") {
      const text = collapse(inline(child, baseUrl));
      if (text.length > 0) blocks.push(`> ${text}`);
      continue;
    }
    if (tag === "PRE") {
      const text = (child.textContent ?? "").replace(/\s+$/, "");
      if (text.length > 0) blocks.push(`\`\`\`\n${text}\n\`\`\``);
      continue;
    }
    if (tag === "DL") {
      const rows: string[] = [];
      let term = "";
      for (const node of child.querySelectorAll("dt, dd")) {
        if (isSkipped(node)) continue;
        if (node.tagName === "DT") term = collapse(inline(node, baseUrl));
        else {
          const detail = collapse(inline(node, baseUrl));
          rows.push(term.length > 0 ? `- ${term}: ${detail}` : `- ${detail}`);
        }
      }
      if (rows.length > 0) blocks.push(rows.join("\n"));
      continue;
    }
    if (tag === "TABLE") {
      const rows = [...child.querySelectorAll("tr")].map((row) =>
        [...row.children].map((cell) => collapse(inline(cell, baseUrl))).join(" | "),
      );
      // The caption sits outside every `tr`, so it needs its own line.
      const caption = child.querySelector("caption");
      const lines = caption ? [collapse(inline(caption, baseUrl)), ...rows] : rows;
      if (rows.length > 0) blocks.push(lines.filter((line) => line.length > 0).join("\n"));
      continue;
    }
    if (tag === "A") {
      const text = collapse(inline(child, baseUrl));
      if (text.length > 0) blocks.push(text);
      continue;
    }
    walk(child, blocks, baseUrl);
  }
}

function frontMatter(entries: ReadonlyArray<readonly [string, string]>): string {
  return ["---", ...entries.map(([key, value]) => `${key}: ${collapse(value)}`), "---"].join("\n");
}

/**
 * Converts one built landing page into a markdown document for agents: front
 * matter with the canonical metadata, then the `<main>` content with headings,
 * paragraphs, lists, images and absolute links. Navigation, forms, scripts and
 * `aria-hidden` decoration are dropped.
 */
export function htmlToMarkdown(html: string, url: string): string {
  const document = new JSDOM(html, { url }).window.document;
  const main = document.querySelector("main") ?? document.body;
  const blocks: string[] = [];
  walk(main, blocks, url);
  const description =
    document.querySelector('meta[name="description"]')?.getAttribute("content") ?? "";
  const meta = frontMatter([
    ["title", document.title],
    ["url", url],
    ["lang", document.documentElement.lang || "ru"],
    ["description", description],
  ]);
  return `${meta}\n\n${blocks.join("\n\n")}\n`;
}

function routeForFile(relative: string): string {
  const normalized = relative.split(path.sep).join("/");
  if (normalized === "index.html") return "/";
  if (normalized.endsWith("/index.html")) return `/${normalized.slice(0, -"index.html".length)}`;
  return `/${normalized}`;
}

async function htmlFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && entry.name.endsWith(".html"))
        files.push(path.relative(root, absolute));
    }
  };
  await visit(root);
  return files.sort();
}

/**
 * Writes `<route>.md` next to every indexable HTML page of a built site and a
 * combined `llms-full.txt` (Russian pages first, then English). Returns the
 * site-relative paths that were written, in order.
 */
export async function generateMarkdownMirrors(root: string): Promise<string[]> {
  const documents: MirrorDocument[] = [];
  for (const relative of await htmlFiles(root)) {
    if (relative === "404.html") continue;
    const html = await readFile(path.join(root, relative), "utf8");
    const route = routeForFile(relative);
    const page = new JSDOM(html).window.document;
    const robots = page.querySelector('meta[name="robots"]')?.getAttribute("content") ?? "";
    if (robots.toLowerCase().includes("noindex")) continue;
    const canonical = page.querySelector('link[rel~="canonical"]')?.getAttribute("href");
    const url = canonical ?? new URL(route, SITE_URL).toString();
    documents.push({
      route,
      lang: page.documentElement.lang || "ru",
      markdown: htmlToMarkdown(html, url),
    });
  }
  documents.sort(
    (left, right) =>
      Number(left.lang !== "ru") - Number(right.lang !== "ru") ||
      left.route.localeCompare(right.route),
  );

  const written: string[] = [];
  for (const document of documents) {
    const mirror = mirrorPathFor(document.route);
    await writeFile(path.join(root, mirror.slice(1)), document.markdown);
    written.push(mirror);
  }
  const full = `# Markiro\n\n${documents.map(({ markdown }) => markdown.trimEnd()).join("\n\n---\n\n")}\n`;
  await writeFile(path.join(root, "llms-full.txt"), full);
  written.push("/llms-full.txt");
  return written;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const root = process.argv[2];
  if (!root) throw new Error("usage: markdown-mirror.ts <built-site-root>");
  const written = await generateMarkdownMirrors(root);
  console.log(`landing markdown mirrors: ${written.length} files`);
}
