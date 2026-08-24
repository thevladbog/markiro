import MarkdownIt from "markdown-it";
import sanitizeHtml from "sanitize-html";

const MAX_TERMS_LENGTH = 20_000;
const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });

const allowedTags = [
  "a",
  "p",
  "br",
  "strong",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
] as const;

const offerTermsSanitizeOptions: sanitizeHtml.IOptions = {
  allowedTags: [...allowedTags],
  allowedAttributes: {
    a: ["href", "title"],
    th: ["colspan", "rowspan"],
    td: ["colspan", "rowspan"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowProtocolRelative: false,
};

export function sanitizeOfferTermsHtml(value: string): string {
  return sanitizeHtml(value, offerTermsSanitizeOptions);
}

function stripUnsupportedMarkdown(source: string): string {
  const withoutHtml = sanitizeHtml(source, {
    allowedTags: [],
    allowedAttributes: {},
    disallowedTagsMode: "discard",
  });
  return withoutHtml
    .replaceAll(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replaceAll(/\[([^\]]*)\]\(\s*(?:javascript|data|vbscript):[^)]*\)/gi, "$1");
}

export function normalizeOfferTerms(source: string | null | undefined): {
  markdown: string | null;
  html: string | null;
} {
  const trimmed = source?.trim() ?? "";
  if (!trimmed) return { markdown: null, html: null };
  if (trimmed.length > MAX_TERMS_LENGTH) throw new Error("offer_terms_too_long");

  const normalizedMarkdown = stripUnsupportedMarkdown(trimmed).trim();
  if (!normalizedMarkdown) return { markdown: null, html: null };
  const html = sanitizeOfferTermsHtml(markdown.render(normalizedMarkdown));
  return { markdown: normalizedMarkdown, html: html || null };
}
