#!/usr/bin/env node
// Quote lens: every «…» (ru) / "…" (en) quote in a compiled legal document
// must exist verbatim (or as a genuine template match) in the admin i18n
// dictionary of that locale. See README.md for the verdict classes and the
// exceptions this document series has accepted.
//
// CLI usage: node lens.mjs <root> <CODE> <ru|en> [dictDir]
//   root    - repository root (absolute or relative to cwd)
//   CODE    - release-key prefix of the document, e.g. MKR-INS-10
//   ru|en   - locale to check
//   dictDir - i18n directory relative to root (default: apps/admin/src/i18n)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const QUOTE_PATTERN = { ru: /«[^»]+»/gu, en: /“[^”]+”/gu };

/**
 * Walks a document's compiled `content[locale]` tree and collects every
 * quoted substring together with the "frame" it is attached to (an image id
 * when the enclosing step carries one, otherwise the section id).
 */
export function extractQuotes(content, locale) {
  const pattern = QUOTE_PATTERN[locale];
  const rows = [];
  function push(text, frame) {
    for (const q of text.match(pattern) ?? []) rows.push({ quote: q.slice(1, -1), frame });
  }
  push(content.summary, "—");
  for (const section of content.sections) {
    push(section.heading, "—");
    for (const block of section.blocks) {
      const frame = block.kind === "step" && block.image ? block.image.id : `§${section.id}`;
      if (block.kind === "paragraph" || block.kind === "callout") push(block.text, frame);
      if (block.kind === "unordered-list" || block.kind === "ordered-list")
        for (const item of block.items) push(item, frame);
      if (block.kind === "definition-list")
        for (const item of block.items) {
          push(item.term, frame);
          push(item.detail, frame);
        }
      if (block.kind === "step") {
        push(block.title, frame);
        push(block.text, frame);
        if (block.expected) push(block.expected, frame);
        push(block.image?.caption ?? "", frame);
      }
    }
  }
  return rows;
}

/** Flattens every string leaf of a parsed i18n JSON tree into a flat array. */
export function flattenDictionaryValues(node, values = []) {
  if (typeof node === "string") values.push(node);
  else if (node && typeof node === "object")
    for (const v of Object.values(node)) flattenDictionaryValues(v, values);
  return values;
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * Classifies one quoted string against the flattened dictionary values for
 * its locale. Verdicts, most to least exact:
 *
 * - "exact": the quote equals a dictionary value byte-for-byte.
 * - "prefix": the quote is the leading substring of a dictionary value
 *   (the document truncated a longer label, e.g. with an ellipsis).
 * - "template": the quote matches a `{{placeholder}}` dictionary value with
 *   its interpolations filled in. Two historical defects live here and both
 *   are guarded explicitly below - see the comments inline.
 * - "fragment": the quote is a >=8 character mid-string excerpt of a
 *   dictionary value (the document quoted a clause, not the whole string).
 * - "MISSING": none of the above - a real finding, unless the quote falls
 *   under one of the accepted exceptions in README.md.
 */
export function classify(quote, values) {
  if (values.includes(quote)) return "exact";
  if (values.some((v) => v.startsWith(quote))) return "prefix";
  if (
    values.some((v) => {
      if (!v.includes("{{")) return false;
      const parts = v.split(/\{\{[^}]+\}\}/gu);
      // A value that is nothing but a placeholder ("{{name}}") would compile
      // to `^.+$` and swallow every quote, turning the whole lens into a
      // no-op. A template only counts when it carries literal text of its
      // own (defect 1: the bare-placeholder no-op).
      const literal = parts.join("");
      if (literal.trim().length < 3) return false;
      // The literal half must carry most of the quote. Without this, a
      // value like "{{count}} смены" compiles to `^.+ смены$` and swallows
      // every unrelated string that happens to end the same way
      // (defect 2: the short-literal false positive).
      if (literal.length * 2 < quote.length) return false;
      const p = parts.map(escapeRegExp).join(".+");
      return new RegExp(`^${p}$`, "u").test(quote);
    })
  )
    return "template";
  // A mid-sentence excerpt of a dictionary value: the words are the
  // product's own, the quote just does not start at the beginning of the
  // string.
  if (quote.length >= 8 && values.some((v) => v.includes(quote))) return "fragment";
  return "MISSING";
}

/**
 * Runs the lens over one locale of one document and prints its findings,
 * mirroring the CLI's historical output exactly. Returns the missing count.
 */
export function lint(rows, values, { code, locale, log = console.log } = {}) {
  const seen = new Set();
  let missing = 0;
  for (const { quote, frame } of rows) {
    const key = `${quote}|${frame}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const verdict = classify(quote, values);
    if (verdict === "MISSING") {
      missing += 1;
      log(`  MISSING ${frame.padEnd(22)} «${quote}»`);
    }
  }
  log(`${code} ${locale}: quotes=${seen.size} missing=${missing}`);
  return missing;
}

async function main() {
  const [root, code, locale, dictDir = "apps/admin/src/i18n"] = process.argv.slice(2);
  const { LEGAL_DOCUMENTS } = await import(
    pathToFileURL(join(root, "packages/legal-documents/dist/registry.js"))
  );
  const source = LEGAL_DOCUMENTS.find((d) => d.releaseKey.startsWith(code));
  const content = source.content[locale];
  if (!content) {
    console.log("no content for", code, locale);
    process.exit(0);
  }
  const rows = extractQuotes(content, locale);
  const values = flattenDictionaryValues(
    JSON.parse(readFileSync(join(root, dictDir, `${locale}.json`), "utf8")),
  );
  lint(rows, values, { code, locale });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await main();
}
