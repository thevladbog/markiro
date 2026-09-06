# Landing SEO for leads — design spec

**Date:** 2026-09-06
**Status:** approved by owner in session («исправляй и оптимизируй всё, что можно; основная цель — лиды»); implemented inline by the same session
**Scope:** `apps/landing`, `deploy/production` (Caddy, smoke, contracts), `tools/production-browser`, `tools/indexnow`, release/deploy workflows, publication runbooks
**Supersedes in part:** `2026-08-14-landing-seo-ai-discoverability-design.md` (see «Deviations»)

## Goal

Increase qualified demo requests from Russian producers by making the landing rank
better in Яндекс and Google for the commercial intents it already targets, by making
it easy for AI answer engines and agents to read and cite it, and by removing edge and
markup defects found in the 2026-09-06 audit. No new product claims: every sentence
is derived from current code, specs and instructions.

## Audit findings addressed

1. Thin commercial pages (116–160 words) → deep, answer-shaped content, page FAQs,
   «Коротко» summaries, visible review date, related articles.
2. No hubs, weak article discovery → `/stati/`, `/instruktsii/`, `/en/articles/`,
   `/en/instructions/`, header/footer links, home «Материалы» section, 3-level
   breadcrumbs, related articles on topic pages.
3. Duplicate URL variants → 308 redirects to the canonical form at the edge.
4. Yandex parameters → `Clean-param` in `robots.txt`.
5. Webmaster verification via consent-gated GTM cannot work → documented; DNS/static
   verification recommended in the runbook.
6. IndexNow manual → automated post-deploy submission of recently changed URLs.
7. Agent surface → richer `llms.txt`, `llms-full.txt`, markdown mirror per page,
   consistent training-crawler policy.
8. Structured data and meta gaps → Organization contacts/logo, WebPage dates,
   SoftwareApplication facts, FAQPage per page, real OG image dimensions, no
   self-referencing hreflang, computed legal registry lastmod.
9. Cache policy for static files outside `/assets/` → 1 day public caching.
10. 3 MB PNG fallbacks → JPEG fallback for article heroes.
11. Lighthouse gate only on `/` → also a topic page and an article.
12. Verification pages `/d/…` in the index → `noindex`, out of the sitemap.
13. No RSS → Atom-compatible RSS 2.0 feed per locale.
14. Illustrative console numbers → explicit «условные значения» note in the DOM.

## Decisions

- **Truthfulness first.** Copy is limited to behaviour visible in code, specs and the
  MKR-INS instructions. No prices, customers, certificates, guarantees or timelines.
- **RU is primary, EN gets structural parity.** English topic pages receive the same
  sections, summaries, FAQs and related links, translated, so hreflang pairs stay
  comparable. Hubs exist in both locales.
- **Hubs are a separate content type** (`src/content/hubs.ts`) rather than entries in
  `SEO_PAGES`, so the topic-cluster registry test stays exact.
- **FAQPage on every page that has visible FAQ items**, using the same strings as the
  visible markup (extends the 2026-08-14 rule «FAQPage only on /faq/»).
- **Organization gains public contacts** that are already public: `hello@v-b.tech`
  (operator profile), the configured `PUBLIC_PHONE`, the logo. The operator's postal
  address stays only in legal documents.
- **Training-crawler policy stays «blocked» and becomes consistent**: GPTBot and
  ClaudeBot remain blocked; Google-Extended, Applebot-Extended, CCBot, Bytespider and
  Meta-ExternalAgent are added to the same policy. Search and user-directed
  retrieval agents remain allowed.
- **Canonical URL form is the trailing-slash directory URL** (unchanged). The edge
  redirects `/index.html`, `/x/index.html`, `/x` (when `/x/index.html` exists) and
  `/d/…/` (trailing slash) to their canonical form with 308 and preserves the query.
- **Markdown mirrors and `llms-full.txt` are generated post-build from the HTML**
  (`src/lib/markdown-mirror.ts`), served with `text/markdown` and
  `X-Robots-Tag: noindex` so they never compete with the HTML in search indexes.
- **IndexNow key is a public repository variable** (`PUBLIC_INDEXNOW_KEY`), baked into
  the static build as `/{key}.txt` and used by a post-deploy step that submits URLs
  whose sitemap `lastmod` falls inside a 30-day window. HTTP acceptance is not proof
  of indexing (runbook rule unchanged).
- **`/d/…` verification pages are `noindex`** and leave the sitemap; they remain
  reachable for printed Data Matrix codes. The built-site audit exempts `noindex`
  pages from the sitemap parity check.

## Non-goals

- No new analytics vendors, no change to consent gating.
- No automatic content generation, no doorway pages.
- No change to the demo-form contract, CRM boundary or admin/kiosk authorities.
- No migration of hand-written articles to content collections (recorded as a
  direction for a later slice).

## Verification

Landing: focused vitest files, package `test`, `typecheck`, `lint`, `build`, built-site
audit. Production bundle: `pnpm test:production-bundle:contract` (Caddy adapt via
Docker, smoke route table, workflow and runbook contracts). Browser: landing Playwright
suite and Lighthouse where the local environment allows; the Caddy CSP/redirect suite
runs in CI against the edge image. Live DNS, webmaster ownership, IndexNow acceptance
and indexing remain external gates.
