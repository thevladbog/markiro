# Markiro Landing SEO Content Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish eight truthful, internally linked static Russian pages with deterministic metadata, structured data, crawler policy, sitemap, and privacy-safe analytics hooks.

**Architecture:** Keep route facts in a typed registry, render the seven specialist pages through one shared content layout, and derive metadata/policy outputs from the same canonical source. Astro emits plain HTML with no framework hydration; existing visual components remain on the home page.

**Tech Stack:** Astro 7.1.6, TypeScript 6, Vitest 4, jsdom 29, `@markiro/ui`.

**Spec:** `docs/superpowers/specs/2026-08-14-landing-seo-ai-discoverability-design.md`

## Global Constraints

- Russian-only, canonical apex `https://markiro.app`, lowercase trailing-slash routes.
- Claims must be supported by current code, tests, or accepted documentation.
- Search/retrieval crawlers are allowed; `GPTBot` and `ClaudeBot` are blocked.
- No ratings, prices, customers, partners, legal identity, contacts, or analytics vendors may be invented.
- The page and demo form UI work with JavaScript and cookies disabled.
- Use test-first RED/GREEN cycles and keep source modules focused.

---

### Task 1: Add the typed page registry and policy generators

**Files:**

- Create: `apps/landing/src/content/pages.ts`
- Create: `apps/landing/src/content/pages.test.ts`
- Create: `apps/landing/src/lib/seo.ts`
- Create: `apps/landing/src/lib/seo.test.ts`
- Create: `apps/landing/src/pages/robots.txt.ts`
- Create: `apps/landing/src/pages/sitemap.xml.ts`
- Create: `apps/landing/src/pages/llms.txt.ts`
- Delete: `apps/landing/public/robots.txt`
- Delete: `apps/landing/public/sitemap.xml`

**Interfaces:**

- Produces: `SEO_PAGES: readonly SeoPageDefinition[]`, `findSeoPage(path)`, `buildPageGraph(page)`, and deterministic text/XML endpoints.
- Consumes: `Astro.site` fixed at `https://markiro.app`.

- [ ] **Step 1: Write registry and SEO RED tests**

  Assert the exact eight paths, unique paths/titles/descriptions, valid related paths, real review dates, safe JSON serialization, sitemap membership, crawler allow/disallow groups, and canonical llms links.

  ```ts
  expect(SEO_PAGES.map(({ path }) => path)).toEqual([
    "/",
    "/markirovka-chestny-znak/",
    "/sscc-i-agregatsiya/",
    "/rabochee-mesto-upakovki/",
    "/kiosk-samovydachi/",
    "/integratsiya-1c/",
    "/oflayn-rabota/",
    "/faq/",
  ]);
  expect(renderRobots()).toContain("User-agent: GPTBot\nDisallow: /");
  expect(renderRobots()).toContain("User-agent: OAI-SearchBot\nAllow: /");
  ```

- [ ] **Step 2: Run RED**

  Run: `pnpm --filter @markiro/landing exec vitest run src/content/pages.test.ts src/lib/seo.test.ts`
  Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement the registry and generators**

  Define the exact interface from the spec, frozen page definitions, and pure generators. Escape `<`, `>`, `&`, U+2028 and U+2029 in JSON embedded in HTML. Generate `lastmod` only from `reviewedAt`.

- [ ] **Step 4: Expose deterministic Astro endpoints**

  Return explicit `Content-Type` headers: `text/plain; charset=utf-8` for robots/llms and `application/xml; charset=utf-8` for sitemap.

- [ ] **Step 5: Run GREEN and commit**

  Run the focused tests and `pnpm --filter @markiro/landing typecheck`.

  ```bash
  git add apps/landing/src/content apps/landing/src/lib/seo.ts apps/landing/src/lib/seo.test.ts apps/landing/src/pages/robots.txt.ts apps/landing/src/pages/sitemap.xml.ts apps/landing/src/pages/llms.txt.ts apps/landing/public/robots.txt apps/landing/public/sitemap.xml
  git commit -m "feat(landing): add canonical SEO content registry"
  ```

### Task 2: Render the topic cluster and truthful structured data

**Files:**

- Create: `apps/landing/src/components/Breadcrumbs.astro`
- Create: `apps/landing/src/components/RelatedPages.astro`
- Create: `apps/landing/src/components/SeoArticle.astro`
- Create: `apps/landing/src/pages/markirovka-chestny-znak/index.astro`
- Create: `apps/landing/src/pages/sscc-i-agregatsiya/index.astro`
- Create: `apps/landing/src/pages/rabochee-mesto-upakovki/index.astro`
- Create: `apps/landing/src/pages/kiosk-samovydachi/index.astro`
- Create: `apps/landing/src/pages/integratsiya-1c/index.astro`
- Create: `apps/landing/src/pages/oflayn-rabota/index.astro`
- Create: `apps/landing/src/pages/faq/index.astro`
- Modify: `apps/landing/src/pages/index.astro`
- Modify: `apps/landing/src/components/LandingHeader.astro`
- Modify: `apps/landing/src/layouts/BaseLayout.astro`
- Modify: `apps/landing/src/styles/landing.css`
- Modify: `apps/landing/test/rendered-page.test.ts`

**Interfaces:**

- Consumes: `SEO_PAGES`, `findSeoPage`, `buildPageGraph`.
- Produces: eight built HTML routes with one H1, visible body copy, related links, canonical metadata and matching JSON-LD.

- [ ] **Step 1: Extend the rendered-build test and run RED**

  Parse all eight generated HTML files. Assert one H1, unique title/description, absolute canonical, complete OG/Twitter fields, robots meta, JSON-LD parseability, non-root breadcrumbs, internal links, and visible FAQ strings matching `FAQPage`.

  Run: `pnpm --filter @markiro/landing exec vitest run test/rendered-page.test.ts`
  Expected: FAIL because specialist routes and metadata are absent.

- [ ] **Step 2: Expand `BaseLayout` metadata contract**

  Accept a `SeoPageDefinition`, emit the exact robots directive, full social tags, canonical URL and one safe `application/ld+json` graph. Preserve the skip link and static rendering.

- [ ] **Step 3: Build the shared article layout and routes**

  Each page contains a direct introductory answer, a workflow section, supported limitations/recovery, related links and demo CTA. Copy must be checked against source before insertion; omit any uncertain claim.

- [ ] **Step 4: Add cluster navigation and responsive article styling**

  Keep the current industrial visual language, 44px interactive targets, visible focus, readable 65-75 character measure, and reduced-motion behavior.

- [ ] **Step 5: Run GREEN and commit**

  Run focused rendered tests, full landing tests, typecheck, lint and build.

  ```bash
  git add apps/landing/src apps/landing/test
  git commit -m "feat(landing): publish SEO topic cluster"
  ```

### Task 3: Add consent-safe analytics and attribution boundaries

**Files:**

- Create: `apps/landing/src/lib/consent.ts`
- Create: `apps/landing/src/lib/consent.test.ts`
- Create: `apps/landing/src/scripts/consent.ts`
- Create: `apps/landing/src/scripts/consent.test.ts`
- Create: `apps/landing/src/components/ConsentPanel.astro`
- Modify: `apps/landing/src/layouts/BaseLayout.astro`
- Modify: `apps/landing/src/scripts/site.ts`
- Modify: `apps/landing/src/scripts/site.test.ts`
- Modify: `apps/landing/src/styles/landing.css`

**Interfaces:**

- Produces: `ConsentState`, `readConsent`, `writeConsent`, `canUseCategory`, and `initConsentPanel`.
- Consumes: no analytics vendor and creates no visitor identifier.

- [ ] **Step 1: Write RED tests**

  Cover absent/invalid stored state, versioned analytics/marketing booleans, reject-all, accept selected, change-choice, keyboard focus, and proof that no analytics event is dispatched without analytics consent.

- [ ] **Step 2: Run RED**

  Run: `pnpm --filter @markiro/landing exec vitest run src/lib/consent.test.ts src/scripts/consent.test.ts src/scripts/site.test.ts`
  Expected: FAIL because consent modules do not exist and analytics is not gated.

- [ ] **Step 3: Implement the minimal versioned preference and panel**

  Persist only `{ version: 1, analytics: boolean, marketing: boolean }`. Do not load scripts, set tracking cookies, or show the panel when no optional vendor is enabled. Expose the settings control for the future policy-approved configuration.

- [ ] **Step 4: Gate existing analytics dispatch**

  Drop optional events until `canUseCategory(state, "analytics")` is true. Never attach form field values.

- [ ] **Step 5: Run GREEN and commit**

  Run landing test/typecheck/lint/build.

  ```bash
  git add apps/landing/src
  git commit -m "feat(landing): add privacy-safe consent boundary"
  ```

### Task 4: Complete package and visual gates

**Files:**

- Modify: `docs/superpowers/plans/2026-08-14-landing-seo-content.md`

**Interfaces:**

- Consumes: built topic cluster.
- Produces: verified package evidence and recorded external blockers.

- [ ] **Step 1: Run package gates**

  Run `pnpm --filter @markiro/landing test`, `typecheck`, `lint`, and `build`, followed by focused Prettier and `git diff --check`.

- [ ] **Step 2: Run responsive browser review**

  Check 390x844, 834x1112, and 1440x1000; keyboard navigation; JavaScript disabled; reduced motion; 200% zoom; all internal links; and console errors.

- [ ] **Step 3: Record blockers without weakening behavior**

  Record CRM contract, legal/privacy copy, analytics vendor, public organization facts, DNS/TLS, webmaster verification and live indexing as unverified external gates.
