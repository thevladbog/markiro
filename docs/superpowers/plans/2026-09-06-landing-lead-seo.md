# Landing SEO for Leads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This plan was executed inline by its author in the same session; the merged diff is authoritative where the two differ.

**Goal:** Turn the audited Russian landing into a deeper, better-linked, canonically served and agent-readable site without adding unverifiable product claims.

**Architecture:** Content stays in typed modules (`pages.ts`, `articles.ts`, new `hubs.ts`); one SEO library (`seo.ts`) renders JSON-LD, robots, sitemap, feeds and llms files; Astro pages select typed entries; a post-build step derives markdown mirrors from the HTML; Caddy owns canonical redirects and cache policy; contract tests pin every edge and workflow change.

**Tech Stack:** Astro 7 (static), TypeScript strict, Vitest + jsdom, Node test runner for deploy contracts, Caddy 2.11, Playwright, Lighthouse.

**Spec:** `docs/superpowers/specs/2026-09-06-landing-lead-seo-design.md`

## Global Constraints

- Every visible claim must be traceable to code, specs or MKR-INS instructions; no prices, customers, certificates, guarantees.
- Canonical URLs keep the trailing slash; `/d/…` verification routes keep no trailing slash.
- `GPTBot` and `ClaudeBot` stay disallowed; `OAI-SearchBot`, `Claude-SearchBot`, `Claude-User`, `PerplexityBot` stay allowed.
- English pages contain no Cyrillic in `<body>`.
- Exact dependency pins; no new runtime dependencies for the landing.
- Never print secrets; the IndexNow key is public by protocol but is still never logged.

## File Structure

- `apps/landing/src/content/pages.ts` — topic-page model gains `summary`, `relatedArticlePaths`; five RU and five EN pages gain depth and FAQ.
- `apps/landing/src/content/hubs.ts` — hub definitions and search records.
- `apps/landing/src/content/articles.ts` — `articlesForLocale()` helper.
- `apps/landing/src/content/legal-pages.ts` — computed registry `lastmod`, verification routes out of the sitemap.
- `apps/landing/src/content/ui.ts` — navigation, hub, materials and label copy.
- `apps/landing/src/lib/seo.ts` — robots, sitemap, llms, RSS, graphs.
- `apps/landing/src/lib/social-image.ts` — JPEG dimension reader.
- `apps/landing/src/lib/markdown-mirror.ts` — post-build markdown + `llms-full.txt`.
- `apps/landing/src/lib/audit.ts` — `noindex` exemption.
- `apps/landing/src/layouts/BaseLayout.astro` — meta, hreflang, feed and markdown links.
- `apps/landing/src/components/{SeoArticle,RelatedPages,Breadcrumbs,HubPage,HomeMaterials,LandingHeader,LandingFooter,LineConsole,InstructionDocument,LegalVerification,HomePage}.astro`.
- `apps/landing/src/pages/{stati,instruktsii,en/articles,en/instructions}/index.astro`, `stati/rss.xml.ts`, `en/articles/rss.xml.ts`, `[indexNowKey].txt.ts`.
- `apps/landing/src/pages/stati/*/index.astro`, `en/articles/*/index.astro` — hub breadcrumb, JPEG fallback.
- `deploy/production/Caddyfile`, `smoke.mjs`, `edge.Dockerfile`, tests under `deploy/production/test/`.
- `tools/production-browser/{tests/landing-seo.spec.ts,tests/landing-caddy-csp.spec.ts,scripts/lighthouse-landing.mjs}`.
- `tools/indexnow/submit.mjs` + `tools/indexnow/test/submit.test.mjs`; root `package.json` script.
- `.github/workflows/{release-images,deploy-production}.yml`.
- `docs/runbooks/{landing-publication,landing-google-analytics}.md`.

---

### Task 1: SEO library core

**Files:** `src/lib/seo.ts`, `src/lib/seo.test.ts`, `src/lib/social-image.ts`, `src/lib/social-image.test.ts`, `src/content/legal-pages.ts`, `src/layouts/BaseLayout.astro`, `public/brand/markiro-logo.svg`

- [x] Failing tests: robots contains `User-agent: Yandex` + `Clean-param`, training bots disallowed; `readJpegDimensions` returns real sizes for `public/og-*.jpg`; Organization has `email`, `logo`, `contactPoint`, optional `telephone`; WebPage carries `dateModified`; sitemap omits `/d/` and self-referencing hreflang; `/legal/` lastmod equals the newest active release.
- [x] Implement; run `pnpm --filter @markiro/landing exec vitest run src/lib`.
- [x] Commit `feat(landing): robots Clean-param, richer Organization and truthful OG dimensions`.

### Task 2: Hubs, navigation, breadcrumbs, related articles

**Files:** `src/content/hubs.ts` (+ test), `src/content/articles.ts`, `src/content/ui.ts`, `src/components/{HubPage,HomeMaterials,Breadcrumbs,RelatedPages,LandingHeader,LandingFooter,InstructionDocument,HomePage}.astro`, four hub pages, 18 article pages, `src/lib/seo.ts` (hub graph, 3-level article breadcrumbs), `test/rendered-page.test.ts`

- [x] Failing tests: hub registry, sitemap count and hub URLs, article breadcrumb has three items, rendered hub pages list every article/instruction of the locale, home has `section#materials`, header links to the articles hub.
- [x] Implement; run landing `test`, `typecheck`, `lint`.
- [x] Commit `feat(landing): article and instruction hubs with cluster navigation`.

### Task 3: Commercial page depth

**Files:** `src/content/pages.ts`, `src/content/pages.test.ts`, `src/components/SeoArticle.astro`, `test/rendered-page.test.ts`

- [x] Failing tests: each non-home topic page has ≥ 4 sections, a summary, ≥ 3 FAQ entries and ≥ 2 related articles; FAQPage strings equal visible strings on every page with FAQ; visible `<time>` review date; RU body text ≥ 400 words.
- [x] Write the content (RU, then EN parity), implement components; run landing gates.
- [x] Commit `feat(landing): deepen commercial pages with summaries, FAQ and related articles`.

### Task 4: Feeds, llms and markdown mirrors

**Files:** `src/lib/seo.ts`, `src/lib/markdown-mirror.ts` (+ test), `src/pages/stati/rss.xml.ts`, `src/pages/en/articles/rss.xml.ts`, `src/layouts/BaseLayout.astro`, `package.json` build script

- [x] Failing tests: RSS has every article of the locale with `pubDate`; llms.txt has the product facts block, hub links and `llms-full.txt`; markdown mirror of a fixture HTML keeps headings, lists, links and skips `aria-hidden`; generator writes `dist/faq.md` and `dist/llms-full.txt`.
- [x] Implement; run landing gates and `pnpm --filter @markiro/landing build`.
- [x] Commit `feat(landing): RSS feeds, llms-full and markdown mirrors for agents`.

### Task 5: Edge canonicalisation and cache policy

**Files:** `deploy/production/Caddyfile`, `deploy/production/smoke.mjs`, `deploy/production/test/{edge-contract,smoke-route-table}.test.mjs`, `tools/production-browser/tests/landing-caddy-csp.spec.ts`

- [x] Failing contract tests: redirect matchers exist for `index.html`, slash-less directories and `/d/…/`; static images/manifests/legal files get `public, max-age=86400`; `*.md` and `llms-full.txt` get `text/markdown`/`noindex`; smoke checks `/faq` → 308 `/faq/`.
- [x] Implement; run `pnpm test:production-bundle:contract`; probe with Docker Caddy.
- [x] Commit `feat(edge): canonical landing redirects and static cache policy`.

### Task 6: Images, Lighthouse scope, console note, verification noindex

**Files:** 18 article pages, `tools/production-browser/scripts/lighthouse-landing.mjs` (+ test), `src/components/LineConsole.astro`, `src/components/LegalVerification.astro`, `src/lib/audit.ts` (+ test), `src/content/ui.ts`

- [x] Failing tests: article `<img>` fallback ends with `.jpg`; Lighthouse URL list has three routes; console has the illustrative note; `/d/…` page has `noindex` and audit accepts a `noindex` page missing from the sitemap.
- [x] Implement; run landing gates and the lighthouse parser test.
- [x] Commit `feat(landing): lighter article fallbacks, wider Lighthouse gate, noindex verification pages`.

### Task 7: IndexNow automation and runbooks

**Files:** `tools/indexnow/submit.mjs`, `tools/indexnow/test/submit.test.mjs`, `package.json`, `src/pages/[indexNowKey].txt.ts`, `src/lib/site-config.ts` (+ test), `deploy/production/edge.Dockerfile`, `.github/workflows/{release-images,deploy-production}.yml`, `deploy/production/test/{edge-contract,workflow-contract,runbook-contract}.test.mjs`, `docs/runbooks/{landing-publication,landing-google-analytics}.md`

- [x] Failing tests: `readIndexNowKey` validates the key format; the key route renders only when configured; `submit.mjs` selects URLs by lastmod window, verifies the key file and posts one request; workflow contract sees the build arg and the post-deploy step; runbook mentions DNS verification for Яндекс Вебмастер.
- [x] Implement; run `pnpm test:production-bundle:contract`, `pnpm test:ci-policy`, `node --test tools/indexnow/test/*.test.mjs`.
- [x] Commit `feat(release): IndexNow submission after production deploy`.

### Task 8: Final gates

- [x] `pnpm --filter @markiro/landing test typecheck lint build`, `pnpm test:production-bundle:contract`, `pnpm test:landing:browser`, `pnpm test:landing:lighthouse`, `pnpm test:ci-policy`, `pnpm test:indexnow`, `pnpm format:check`, `git diff --check`.
- [x] Report automated checks separately from external gates (DNS, webmaster ownership, IndexNow acceptance, indexing).

## Execution notes (2026-09-06)

- Executed inline in the authoring session, one commit per task on `claude/russian-landing-seo-c1b119`.
- Extra task discovered by the wider Lighthouse gate: the article template scored 0.88 on mobile because `font-display: swap` shifted the hero when IBM Plex arrived; fixed by preloading the locale's above-the-fold font subsets (`src/lib/font-preloads.ts`). Mobile scores after the fix: home 0.94, topic 0.96, article 0.95.
- The kiosk page was rewritten to the real «Выбытие» flow after the sources showed the previous copy described a customer pickup that the product does not ship.
- Verified locally: landing unit and rendered tests, built-site audit, Playwright landing suite (desktop and mobile), Lighthouse on three routes, production bundle contracts, CI policy tests, IndexNow tests, production Caddy landing routes probed in Docker. Not verified: live DNS/TLS, webmaster ownership, IndexNow acceptance by engines, real indexing, the Caddy Playwright spec against the compose stack (not wired into CI).
