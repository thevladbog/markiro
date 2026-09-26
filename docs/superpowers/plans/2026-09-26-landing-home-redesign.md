# Home page redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the markiro.app home page (`/`, `/en/`) as a light page in the film's scale-model world: a full-screen plant map with hotspots, real product screens, an honest "any marked goods" positioning, and a shared header, footer and demo form that work in both themes.

**Architecture:** Astro static page composed of focused section components under `apps/landing/src/components/home/`. The hero image is a still rendered from the film's Three.js scene; hotspot positions are projected from 3D anchors with the same camera at build time, so the page ships no three.js. Product screens are captured once from the real apps (station gallery with a landing profile, admin panel and kiosk on a seeded stand, handheld on the emulator) and committed as optimised assets.

**Tech Stack:** Astro 7.2.8, TypeScript (strict), three 0.186.0 (build-time only on this page), `astro:assets`, Vitest 4.1.11 + JSDOM 29.1.1, Playwright (tools/production-browser), `@markiro/ui` tokens.

**Spec:** `docs/superpowers/specs/2026-09-26-landing-home-redesign-design.md`. Mock: pen.dev `pencil-new.pen`, frames `HP · Главная · направление A · полная страница · 1440`, `HP-H5 · Hero «Карта» · 1440×900`, `HM · Главная · телефон · hero с лентой · 390×844`.

## Global Constraints

- Positioning: `/` and `/en/` say Markiro works for any marked goods and that the rules of the customer's product group are checked before launch; neither page contains «Сейчас — пиво, сидр» or "Currently focused on beer".
- Copy rules: a caption says what the frame shows and never «настоящий экран» / "real screen"; no «не X, а Y» constructions; dashes only where Russian grammar needs them; reuse the film chapter wording in `apps/landing/src/content/film.ts` where it exists.
- Theme: the home page renders `<html data-theme="light">`; its two dark sections (offline, demo) and the film panel set `data-theme="dark"` on themselves; every other page stays `data-theme="dark"`.
- Type: IBM Plex Sans for text, IBM Plex Mono for kickers and captions; home kickers read «NN / НАЗВАНИЕ» in page order, grey (`--fg-3`), the hero kicker unnumbered.
- Green (`--accent`) only on buttons, hotspot dots and small list markers.
- No three.js and no film chunk requested by `/` or `/en/`; Lighthouse gate for `/`: performance ≥ 0.9 (mobile), accessibility 1, SEO 1, best practices ≥ 0.95.
- Images go through `astro:assets` (AVIF and WebP); the hero image is eager with `fetchpriority="high"`; everything below the first screen is lazy.
- No «Тестовый товар А» / "Sample product A" and no real customer data on any home image.
- Hotspot positions come from `projectHomeMap()`; never hand-placed.
- RU and EN keep the same structure (the copy objects are typed by their union, so a missing key fails `astro check`).
- Existing contracts that stay: three `tel:` links on `/` with `data-placement` `demo`, `header`, `hero`; footer link «Station для Windows» → `/rabochee-mesto-upakovki/`; `footer [data-consent-settings]`, `[data-footer-meta]`, `[data-footer-year]`; the demo form fields, captcha and analytics.
- Repository rules: TypeScript strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`, no `any`, `import type` for types, no new dependencies. Build workspace dependencies before landing tests: `pnpm turbo run build --filter='@markiro/landing^...'`. In the agent sandbox prefix pnpm with `pnpm_config_verify_deps_before_run=false`; run Playwright, local servers, docker, the Android emulator and `git push` outside the sandbox.
- Every commit ends with the trailer line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` after one blank line.

## Corrections to the spec made in this plan

- The hero keeps the phone link between the demo button and the film link (the `/` phone test needs placement `hero`).
- The footer lists the packing workstation once, as «Station для Windows» → `/rabochee-mesto-upakovki/` (English "Station for Windows"), in the «Продукт» column. The spec listed it twice; its footer paragraph is corrected in the same commit as this plan.
- The structured data's `featureList` and `operatingSystem` gain pallets and the Android handheld, and the two home entries get a new `reviewedAt`, so the sitemap and JSON-LD match the new page.
- English header labels follow the existing site: Product, How it works, Instructions, Articles, Questions.
- Kiosk and handheld screens are Russian on both locales (their apps ship Russian UI); station and admin screens are captured in both locales.
- The phone hero uses a crop of the same frame in the stage's 16:10 shape (1504 × 940 source, served 780-1500 px wide) instead of 1170 × 720, so one `<picture>` switches the stills by media query without changing the stage's aspect ratio.
- Instruction covers exist per language: `/en/` shows the first pages of the English PDFs.
- Hotspots are links, because each one goes to an anchor on the page: Enter activates them and Space scrolls, as for any link. The spec called them buttons.

## File structure

Create:

- `apps/landing/src/content/home-map.json`: `{ "filmTime": 0.8 }`, the single source for the map still's film time (read by the TypeScript projection and the render script).
- `apps/landing/src/scripts/film/world/home-map.ts` + `home-map.test.ts`: projects the five plant anchors with the film camera; returns normalised points.
- `tools/production-browser/scripts/film-render.mjs`: shared helpers for scene renders (server start, wait, scroll to film time, scene-only style).
- `tools/production-browser/scripts/render-home-images.mjs`: renders `map-wide.jpg`, `map-phone.jpg` and `film-page.jpg`.
- `tools/production-browser/scripts/render-instruction-covers.mjs`: renders instruction cover PNGs from published PDFs with macOS `sips`, per language.
- `tools/production-browser/scripts/capture-station-screens.mjs`: shoots station gallery states with the landing profile.
- `apps/station/src/dev/gallery-profile.ts` + `apps/station/test/gallery-profile.test.tsx`: the gallery's demo-data profiles.
- `apps/landing/src/assets/home/`: `map-wide.jpg`, `map-phone.jpg`, `film-page.jpg`, `screens/<locale>/*.png`, `labels/*.png`, `docs/<code>_<release>_<locale>.png`, `CAPTURES.md`.
- `apps/landing/src/content/home-images.ts`: one registry of every home image.
- `apps/landing/src/components/home/`: `HomeMapHero.astro`, `HomeProduct.astro`, `ScreenFrame.astro`, `HandheldFrame.astro`, `HomeOffline.astro`, `HomeTraceability.astro`, `HomeFilmBlock.astro`, `HomeRollout.astro`, `HomeDocuments.astro`.
- `apps/landing/src/scripts/home/map.ts` + `map.test.ts`: hotspot tooltip dismissal (Escape) and hover persistence.
- `apps/landing/src/styles/home.css`: home sections only.
- `apps/landing/src/content/home-copy.test.ts`: copy parity and positioning rules.
- `apps/landing/test/home-assets.test.ts`: label copies and cover freshness.

Modify:

- `apps/landing/src/layouts/BaseLayout.astro` (theme prop), `LandingHeader.astro` (navigation), `LandingFooter.astro` (three columns), `DemoSection.astro` (dark theme on the section), `HomeMaterials.astro` (new heading), `HomePage.astro` (composition).
- `apps/landing/src/content/ui.ts` (home copy, navigation keys), `pages.ts` (home SEO), `apps/landing/src/lib/seo.ts` + `seo.test.ts` (llms.txt facts).
- `apps/landing/src/styles/landing.css` (shared chrome in both themes; old home rules removed at the end).
- `apps/landing/src/scripts/film/world/plant.ts` (exported anchors).
- `apps/landing/test/rendered-page.test.ts`, `tools/production-browser/tests/landing-seo.spec.ts`.
- `tools/production-browser/scripts/render-film-posters.mjs` (uses the shared helpers).
- `apps/station/src/dev/gallery-fixtures.ts`, `apps/station/src/dev/StationScreenGallery.tsx` (profile).

Delete (Task 12): `LineConsole.astro`, `ProductionCycle.astro`, `ProductModes.astro`, `TraceLog.astro`, `PlatformModules.astro`, `ImplementationSteps.astro`, `apps/landing/src/assets/factory-line.jpg`, the old home copy keys and their CSS.

## Commands used throughout

```bash
# workspace packages the landing imports (run once per fresh checkout and after pulling)
pnpm_config_verify_deps_before_run=false pnpm turbo run build --filter='@markiro/landing^...'
# one landing test file
pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/landing exec vitest run <path>
# the rendered-site suite (builds the site once, ~2 min)
pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/landing exec vitest run test/rendered-page.test.ts
# landing gates
pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/landing test
pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/landing typecheck
pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/landing lint
```

---

### Task 1: Shared chrome for both themes

The header navigation, the footer columns and the light-theme fixes that the film page keeps in `film.css` move into the shared components and `landing.css`. `BaseLayout` learns a theme. The home page is still dark after this task.

**Files:**

- Modify: `apps/landing/src/layouts/BaseLayout.astro:19-25,46,55`
- Modify: `apps/landing/src/content/ui.ts` (`common.nav` in RU lines 11-17 and EN lines 185-191)
- Modify: `apps/landing/src/components/LandingHeader.astro`
- Modify: `apps/landing/src/components/LandingFooter.astro`
- Modify: `apps/landing/src/styles/landing.css` (header 133-146, menu trigger 242-251, mobile nav 1537-1560, footer 1234-1290)
- Test: `apps/landing/test/rendered-page.test.ts`

**Interfaces:**

- Produces: `BaseLayout` prop `theme?: "dark" | "light"` (default `"dark"`); `copy.common.nav` keys `product`, `howItWorks`, `instructions`, `articles`, `faq`; footer markup `[data-footer-column]` with `[data-footer-heading]`.

- [ ] **Step 1: Write the failing tests**

Add to the `describe` block of `apps/landing/test/rendered-page.test.ts`, after the test "links the localized footer to the Station product page instead of the binary":

```ts
  it("links the shared header navigation on every page", () => {
    const ru = [
      ["/#product", "Продукт"],
      ["/kak-rabotaet/", "Как работает"],
      ["/instruktsii/", "Инструкции"],
      ["/stati/", "Статьи"],
      ["/faq/", "Вопросы"],
    ];
    const en = [
      ["/en/#product", "Product"],
      ["/en/how-it-works/", "How it works"],
      ["/en/instructions/", "Instructions"],
      ["/en/articles/", "Articles"],
      ["/en/faq/", "Questions"],
    ];
    for (const [route, expected] of [
      ["/", ru],
      ["/sscc-i-agregatsiya/", ru],
      ["/en/", en],
      ["/en/sscc-and-aggregation/", en],
    ] as const) {
      const links = [
        ...(documents.get(route)?.querySelectorAll("header .landing-nav > a:not(.landing-nav__phone)") ??
          []),
      ].map((link) => [link.getAttribute("href"), link.textContent?.trim()]);
      expect(links, route).toEqual(expected);
    }
  });

  it("groups the footer into product, materials and company columns", () => {
    const columns = (route: string) =>
      [...(documents.get(route)?.querySelectorAll("footer [data-footer-column]") ?? [])].map(
        (column) => ({
          heading: column.querySelector("[data-footer-heading]")?.textContent?.trim(),
          links: [...column.querySelectorAll("a")].map((link) => link.getAttribute("href")),
        }),
      );

    expect(columns("/")).toEqual([
      {
        heading: "Продукт",
        links: [
          "/markirovka-chestny-znak/",
          "/sscc-i-agregatsiya/",
          "/rabochee-mesto-upakovki/",
          "/oflayn-rabota/",
          "/kiosk-samovydachi/",
          "/integratsiya-1c/",
        ],
      },
      { heading: "Материалы", links: ["/kak-rabotaet/", "/stati/", "/instruktsii/", "/faq/"] },
      { heading: "Компания", links: ["/legal/", "/privacy/", "/personal-data-consent/"] },
    ]);
    expect(columns("/en/")).toEqual([
      {
        heading: "Product",
        links: [
          "/en/chestny-znak-serialization/",
          "/en/sscc-and-aggregation/",
          "/en/packing-workstation/",
          "/en/offline-production/",
          "/en/self-service-pickup-kiosk/",
          "/en/1c-integration/",
        ],
      },
      {
        heading: "Materials",
        links: ["/en/how-it-works/", "/en/articles/", "/en/instructions/", "/en/faq/"],
      },
      { heading: "Company", links: ["/en/legal/", "/en/privacy/", "/en/personal-data-consent/"] },
    ]);
    expect(
      documents.get("/")?.querySelector("footer [data-footer-column] [data-consent-settings]"),
    ).not.toBeNull();
  });

  it("keeps topic pages on the dark theme", () => {
    const html = documents.get("/sscc-i-agregatsiya/")?.documentElement;
    expect(html?.getAttribute("data-theme")).toBe("dark");
    expect(
      documents
        .get("/sscc-i-agregatsiya/")
        ?.querySelector('meta[name="theme-color"]')
        ?.getAttribute("content"),
    ).toBe("#131216");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/landing exec vitest run test/rendered-page.test.ts -t "header navigation|footer into|dark theme"`
Expected: the navigation and footer tests FAIL (old labels and no `[data-footer-column]`); the dark-theme test passes already.

- [ ] **Step 3: Give BaseLayout a theme**

In `apps/landing/src/layouts/BaseLayout.astro` replace the `Props` interface and its destructuring:

```astro
interface Props {
  metadata: PageMetadata;
  graph: PageGraph;
  noindex?: boolean;
  /** The home page is light; every other page keeps the dark theme until its own redesign. */
  theme?: "dark" | "light";
}

const { metadata: page, graph, noindex = false, theme = "dark" } = Astro.props;
```

Replace `<html lang={page.locale} data-theme="dark">` with:

```astro
<html lang={page.locale} data-theme={theme}>
```

and `<meta name="theme-color" content="#131216" />` with:

```astro
    <meta name="theme-color" content={theme === "light" ? "#fafaf8" : "#131216"} />
```

- [ ] **Step 4: New navigation labels**

In `apps/landing/src/content/ui.ts` replace the RU `nav` object (inside `common`) with:

```ts
    nav: {
      articles: "Статьи",
      faq: "Вопросы",
      howItWorks: "Как работает",
      instructions: "Инструкции",
      product: "Продукт",
    },
```

and the EN `nav` object with:

```ts
    nav: {
      articles: "Articles",
      faq: "Questions",
      howItWorks: "How it works",
      instructions: "Instructions",
      product: "Product",
    },
```

Then check nothing else reads the removed keys:

Run: `grep -rn "nav\.\(serialization\|aggregation\|offline\)" apps/landing/src`
Expected: matches only in `LandingHeader.astro` (rewritten in the next step).

- [ ] **Step 5: Rewrite the header navigation**

In `apps/landing/src/components/LandingHeader.astro` replace the `paths` constant with:

```astro
const paths = page.locale === "ru"
  ? { faq: "/faq/", film: "/kak-rabotaet/" }
  : { faq: "/en/faq/", film: "/en/how-it-works/" };
```

and the five navigation links (`<a href={paths.serialization}>` … `<a href={paths.faq}>`) with:

```astro
    <a href={`${homePath}#product`}>{copy.nav.product}</a>
    <a href={paths.film}>{copy.nav.howItWorks}</a>
    <a href={hubPath(page.locale, "instructions")}>{copy.nav.instructions}</a>
    <a href={hubPath(page.locale, "articles")}>{copy.nav.articles}</a>
    <a href={paths.faq}>{copy.nav.faq}</a>
```

- [ ] **Step 6: Rewrite the footer as three columns**

Replace the whole frontmatter body after the imports and the markup of `apps/landing/src/components/LandingFooter.astro` with:

```astro
interface Props { page: Pick<PageMetadata, "locale"> }
const { page } = Astro.props;
const copy = getUiCopy(page.locale).common;
const homePath = page.locale === "ru" ? "/" : "/en/";
const columns = page.locale === "ru"
  ? [
      {
        id: "product",
        heading: "Продукт",
        links: [
          ["/markirovka-chestny-znak/", "Маркировка"],
          ["/sscc-i-agregatsiya/", "SSCC и агрегация"],
          ["/rabochee-mesto-upakovki/", "Station для Windows"],
          ["/oflayn-rabota/", "Работа без сети"],
          ["/kiosk-samovydachi/", "Киоск самовыдачи"],
          ["/integratsiya-1c/", "Интеграция с 1С"],
        ],
      },
      {
        id: "materials",
        heading: "Материалы",
        links: [
          ["/kak-rabotaet/", "Как работает"],
          ["/stati/", "Статьи"],
          ["/instruktsii/", "Инструкции"],
          ["/faq/", "Вопросы"],
        ],
      },
      {
        id: "company",
        heading: "Компания",
        links: [
          ["/legal/", "Документы"],
          ["/privacy/", "Политика обработки данных"],
          ["/personal-data-consent/", "Согласие"],
        ],
      },
    ]
  : [
      {
        id: "product",
        heading: "Product",
        links: [
          ["/en/chestny-znak-serialization/", "Serialization"],
          ["/en/sscc-and-aggregation/", "SSCC and aggregation"],
          ["/en/packing-workstation/", "Station for Windows"],
          ["/en/offline-production/", "Work without a network"],
          ["/en/self-service-pickup-kiosk/", "Self-service kiosk"],
          ["/en/1c-integration/", "1C integration"],
        ],
      },
      {
        id: "materials",
        heading: "Materials",
        links: [
          ["/en/how-it-works/", "How it works"],
          ["/en/articles/", "Articles"],
          ["/en/instructions/", "Instructions"],
          ["/en/faq/", "Questions"],
        ],
      },
      {
        id: "company",
        heading: "Company",
        links: [
          ["/en/legal/", "Legal documents"],
          ["/en/privacy/", "Processing policy"],
          ["/en/personal-data-consent/", "Consent"],
        ],
      },
    ];
const consentSettingsLabel = page.locale === "ru" ? "Настройки cookies" : "Cookie settings";
---

<footer class="landing-footer">
  <div class="container landing-footer__inner">
    <div class="landing-footer__meta" data-footer-meta>
      <a href={homePath} aria-label={copy.homeLabel}><BrandMark locale={page.locale} /></a>
      <span data-footer-year>© 2026</span>
    </div>
    {columns.map((column) => (
      <nav class="landing-footer__column" aria-labelledby={`footer-${column.id}`} data-footer-column>
        <p class="landing-footer__heading" id={`footer-${column.id}`} data-footer-heading>{column.heading}</p>
        {column.links.map(([path, label]) => <a href={path}>{label}</a>)}
        {column.id === "company" && (
          <button type="button" data-consent-settings>{consentSettingsLabel}</button>
        )}
      </nav>
    ))}
  </div>
</footer>
```

(Keep the three existing import lines at the top unchanged.)

- [ ] **Step 7: Shared chrome styles for both themes**

In `apps/landing/src/styles/landing.css`:

1. In `.landing-header` replace `border-bottom: 1px solid rgb(250 250 248 / 12%);` with `border-bottom: 1px solid var(--line);`.
2. In `.menu-trigger` replace `background: rgb(19 18 22 / 78%);` with `background: color-mix(in srgb, var(--surface-page) 86%, transparent);`.
3. In the phone rule `.landing-nav { position: absolute; … }` (around line 1537) replace `background: #151419;` with `background: var(--surface-card);` and `box-shadow: 0 1.5rem 3rem rgb(0 0 0 / 40%);` with `box-shadow: 0 1.5rem 3rem rgb(0 0 0 / 24%);`.
4. After the `.button--compact` rule add:

```css
/* Light pages: the current language and the button hover need more contrast on paper. */
[data-theme="light"] .language-switch a[aria-current="page"] {
  color: var(--fg-1);
}

[data-theme="light"] .button:hover {
  border-color: var(--accent-module);
  background: var(--accent-module);
}
```

5. Replace every footer rule from `.landing-footer {` through the `.landing-footer nav button { … }` rule with:

```css
.landing-footer {
  border-top: 1px solid var(--line);
  background: var(--surface-page);
}

[data-theme="dark"] .landing-footer {
  background: #0d0c0f;
}

.landing-footer__inner {
  display: grid;
  grid-template-columns: minmax(12rem, 1.2fr) repeat(3, minmax(0, 1fr));
  align-items: start;
  gap: var(--sp-7) var(--sp-8);
  padding-block: var(--sp-8);
}

.landing-footer__meta {
  display: grid;
  gap: var(--sp-5);
  justify-items: start;
}

.landing-footer__meta > a {
  width: fit-content;
  text-decoration: none;
}

.landing-footer__meta > span {
  color: var(--fg-3);
  font: 500 0.6875rem / 1 var(--font-mono);
}

.landing-footer__column {
  display: grid;
  gap: var(--sp-3);
  align-content: start;
  justify-items: start;
}

.landing-footer__heading {
  margin: 0 0 var(--sp-2);
  color: var(--fg-3);
  font: 600 0.6875rem / 1 var(--font-mono);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.landing-footer__column a,
.landing-footer__column button {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--fg-2);
  font: 400 0.875rem / 1.4 var(--font-ui);
  text-decoration: none;
  cursor: pointer;
}

.landing-footer__column a:hover,
.landing-footer__column button:hover {
  color: var(--fg-1);
}

.landing-footer__column button {
  text-decoration: underline;
  text-underline-offset: 0.2em;
}
```

6. Find the footer rules inside media queries and replace them:

Run: `grep -n "landing-footer" apps/landing/src/styles/landing.css`
Every match outside the block from item 5 is inside a `@media` rule. Delete those rules and add to the existing `@media (max-width: 767px)` block that contains them:

```css
  .landing-footer__inner {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .landing-footer__meta {
    grid-column: 1 / -1;
  }
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/landing exec vitest run test/rendered-page.test.ts`
Expected: PASS, including the existing brand-link, cookie-settings and Station-footer tests.

- [ ] **Step 9: Run the film page browser tests against a production build**

Stop any server on port 5473 first (`lsof -nP -iTCP:5473 -sTCP:LISTEN`), then run outside the sandbox:

Run: `cd tools/production-browser && CI=1 pnpm --ignore-workspace exec playwright test --config landing.playwright.config.ts -g "film page|footer aligned|brand in its header"`
Expected: all selected tests pass.

- [ ] **Step 10: Commit**

```bash
git add apps/landing/src/layouts/BaseLayout.astro apps/landing/src/content/ui.ts apps/landing/src/components/LandingHeader.astro apps/landing/src/components/LandingFooter.astro apps/landing/src/styles/landing.css apps/landing/test/rendered-page.test.ts
git commit -m "feat(landing): shared header, footer and layout theme for light pages" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Home copy, SEO and product facts

Adds the new home copy next to the old keys (the old sections keep compiling until they are replaced), rewrites the home SEO entries and the llms.txt product facts.

**Files:**

- Modify: `apps/landing/src/content/ui.ts` (RU `home` object, EN `home` object)
- Modify: `apps/landing/src/content/pages.ts:79-97,899-922`
- Modify: `apps/landing/src/lib/seo.ts` (the "Коротко о продукте" and "About the product" lists in `renderLlmsTxt`; `SOFTWARE_FACTS` and `operatingSystem` of the structured data)
- Create: `apps/landing/src/content/home-copy.test.ts`
- Modify: `apps/landing/src/lib/seo.test.ts` (tests "publishes an experimental content map without ranking claims" and "describes the software with visible facts only")

**Interfaces:**

- Produces (read by Tasks 8-11), inside `getUiCopy(locale).home`:
  - `mapHero`: `{ kicker, heading: [string, string], lead, filmLink, hint, imageAlt, stripLabel, spots: readonly { id: "line" | "packing" | "warehouse" | "kiosk" | "office"; label: string; line: string; target: string; screenAlt: string }[] }`
  - `productSection`: `{ kicker, heading, rows: readonly { id: "line" | "handheld" | "office"; kicker; title; text; bullets: readonly string[]; link: string; caption: string; screenAlt: string }[], cards: readonly { id: "kiosk" | "integrations"; kicker; title; text; link: string; caption: string; screenAlt: string }[] }`
  - `offline`: `{ kicker, heading: [string, string], lead, points: readonly (readonly [string, string])[], imageAlt, screenAlt, caption }`
  - `traceability`: `{ kicker, heading, lead, screenAlt, caption }`
  - `filmBlock`: `{ kicker, heading, lead, button, imageAlt }`
  - `rollout`: `{ kicker, heading, lead, steps: readonly (readonly [string, string])[], labels: readonly { id: "juices" | "cosmetics"; caption: string; alt: string }[] }`
  - `documents`: `{ kicker, heading, lead, allInstructions, legal, covers: readonly { code: "mkr-ins-01" | "mkr-ins-02" | "mkr-ins-09"; caption: string; alt: string }[] }`

- [ ] **Step 1: Write the failing copy test**

Create `apps/landing/src/content/home-copy.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { getUiCopy } from "./ui";

const ru = getUiCopy("ru").home;
const en = getUiCopy("en").home;
const NEW_KEYS = [
  "mapHero",
  "productSection",
  "offline",
  "traceability",
  "filmBlock",
  "rollout",
  "documents",
] as const;

function text(value: unknown): string {
  return JSON.stringify(value);
}

describe("home copy", () => {
  it("keeps Russian and English in the same shape", () => {
    expect(ru.mapHero.spots.map((spot) => [spot.id, spot.target])).toEqual(
      en.mapHero.spots.map((spot) => [spot.id, spot.target]),
    );
    expect(ru.productSection.rows.map((row) => [row.id, row.bullets.length])).toEqual(
      en.productSection.rows.map((row) => [row.id, row.bullets.length]),
    );
    expect(ru.productSection.cards.map((card) => card.id)).toEqual(
      en.productSection.cards.map((card) => card.id),
    );
    expect(ru.offline.points).toHaveLength(en.offline.points.length);
    expect(ru.rollout.steps).toHaveLength(en.rollout.steps.length);
    expect(ru.documents.covers.map((cover) => cover.code)).toEqual(
      en.documents.covers.map((cover) => cover.code),
    );
  });

  it("sends every hotspot to a product anchor", () => {
    expect(ru.mapHero.spots.map((spot) => [spot.id, spot.target])).toEqual([
      ["line", "#product-line"],
      ["packing", "#product-line"],
      ["warehouse", "#product-handheld"],
      ["kiosk", "#product-kiosk"],
      ["office", "#product-office"],
    ]);
  });

  it("numbers the section kickers in page order", () => {
    const kickers = (copy: typeof ru | typeof en) =>
      [
        copy.productSection.kicker,
        copy.offline.kicker,
        copy.traceability.kicker,
        copy.filmBlock.kicker,
        copy.rollout.kicker,
        copy.documents.kicker,
      ].map((kicker) => kicker.slice(0, 2));
    expect(kickers(ru)).toEqual(["01", "02", "03", "04", "05", "06"]);
    expect(kickers(en)).toEqual(["01", "02", "03", "04", "05", "06"]);
  });

  it("states the product-group boundary honestly", () => {
    const ruText = text(NEW_KEYS.map((key) => ru[key]));
    const enText = text(NEW_KEYS.map((key) => en[key]));
    expect(ruText).toContain("любой маркируемой продукции");
    expect(ruText).toContain("Особенности вашей товарной группы сверяем до запуска");
    expect(enText).toContain("any marked goods");
    expect(enText).toContain("We check the rules of your product group before launch");
    expect(ruText).not.toMatch(/Сейчас — пиво/u);
    expect(enText).not.toMatch(/Currently focused on beer/u);
  });

  it("captions say what the frame shows", () => {
    const captions = (copy: typeof ru | typeof en) =>
      text([
        copy.productSection.rows.map((row) => row.caption),
        copy.productSection.cards.map((card) => card.caption),
        copy.offline.caption,
        copy.traceability.caption,
      ]);
    expect(captions(ru)).not.toMatch(/НАСТОЯЩИЙ ЭКРАН|настоящий экран/u);
    expect(captions(en)).not.toMatch(/REAL SCREEN|real screen/iu);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/landing exec vitest run src/content/home-copy.test.ts`
Expected: FAIL (`ru.mapHero` is undefined).

- [ ] **Step 3: Add the Russian copy**

In `apps/landing/src/content/ui.ts`, inside the RU `home` object, add these keys after `demo` (keep every existing key):

```ts
    mapHero: {
      filmLink: "Посмотреть, как это работает",
      heading: ["Маркировка и агрегация.", "Линия идёт."],
      hint: "Наведите на точку, чтобы увидеть экран на этом участке",
      imageAlt:
        "Макет завода: цех с линией, упаковкой и складом, киоск у входа, офис и склад готовой продукции",
      kicker: "МАРКИРОВКА · АГРЕГАЦИЯ · ПРОСЛЕЖИВАЕМОСТЬ",
      lead: "Проверяем коды, собираем короба и паллеты, печатаем этикетки для соков, косметики, пива и молочной продукции. Когда пропадает сеть, станция продолжает работать.",
      spots: [
        {
          id: "line",
          label: "Линия",
          line: "Станция проверяет каждый код до короба.",
          screenAlt: "Экран станции: сборка короба, принятые коды в журнале смены",
          target: "#product-line",
        },
        {
          id: "packing",
          label: "Упаковка",
          line: "Когда короб заполнен, станция печатает этикетку с SSCC.",
          screenAlt: "Экран станции: короб и паллета в работе",
          target: "#product-line",
        },
        {
          id: "warehouse",
          label: "Склад",
          line: "ТСД собирает паллеты и ведёт инвентаризацию.",
          screenAlt: "Экран ТСД: сборка короба на терминале",
          target: "#product-handheld",
        },
        {
          id: "kiosk",
          label: "Киоск",
          line: "Покупки сотрудников, образцы и бой оформляют на киоске.",
          screenAlt: "Экран киоска выбытия",
          target: "#product-kiosk",
        },
        {
          id: "office",
          label: "Офис",
          line: "В кабинете все смены, обмен с 1С и выгрузки в Честный знак.",
          screenAlt: "Кабинет: сводка производства за день",
          target: "#product-office",
        },
      ],
      stripLabel: "Участки производства",
    },
    productSection: {
      cards: [
        {
          caption: "КИОСК",
          id: "kiosk",
          kicker: "ВЫБЫТИЕ · КИОСК",
          link: "Киоск самовыдачи",
          screenAlt: "Экран киоска выбытия",
          text: "Когда продукция уходит не через отгрузку (покупка сотрудником, образцы, бой), сотрудник сканирует на киоске бейдж и коды, а заявка приходит в кабинет.",
          title: "Выбытие оформляют на киоске.",
        },
        {
          caption: "КАБИНЕТ · СВЯЗЬ С ЧЕСТНЫМ ЗНАКОМ",
          id: "integrations",
          kicker: "ИНТЕГРАЦИИ",
          link: "Интеграция с 1С",
          screenAlt: "Кабинет: товар из Национального каталога и связь с Честным знаком",
          text: "Кабинет связан с Честным знаком, а с 1С обменивается заданиями и статусами. Данные не переносят вручную.",
          title: "Честный знак, 1С и API.",
        },
      ],
      heading: "Экраны, с которыми работают на смене.",
      kicker: "01 / ПРОДУКТ",
      rows: [
        {
          bullets: ["Повторные коды и чужой GTIN", "Несколько терминалов на одной линии", "Печать в ZPL и TSPL"],
          caption: "СТАНЦИЯ · КОРОБ И ПАЛЛЕТА",
          id: "line",
          kicker: "ЛИНИЯ · СТАНЦИЯ",
          link: "Маркировка и агрегация",
          screenAlt: "Экран станции: короб, паллета и журнал смены",
          text: "Станция не пустит в короб повторный код, код чужого товара или код с ошибкой. Оператор видит причину на экране, а заполненный короб сразу получает этикетку с SSCC.",
          title: "Каждый код проверяем до короба.",
        },
        {
          bullets: ["Сборка и разборка паллет", "Инвентаризация у стеллажа", "Печать этикеток с терминала"],
          caption: "ТСД НА ANDROID",
          id: "handheld",
          kicker: "СКЛАД · ТСД НА ANDROID",
          link: "Как это выглядит на складе",
          screenAlt: "Экран ТСД: сборка короба на терминале",
          text: "Кладовщик с терминалом на Android собирает паллеты, снимает с них коробы и проводит инвентаризацию у стеллажа. Операции уходят в тот же журнал, что и со станции.",
          title: "Паллеты собираем на ТСД.",
        },
        {
          bullets: ["Сводка смен и сигналы", "Выгрузки в Честный знак", "Товары из Национального каталога"],
          caption: "КАБИНЕТ · СВОДКА СМЕН",
          id: "office",
          kicker: "ОФИС · КАБИНЕТ",
          link: "Инструкции для кабинета",
          screenAlt: "Кабинет: сводка производства за день",
          text: "Сюда приходят операции со станций, ТСД и киосков. Отсюда идёт обмен с 1С и выгрузка документов для Честного знака.",
          title: "В кабинете видно каждую смену.",
        },
      ],
    },
    offline: {
      caption: "СТАНЦИЯ БЕЗ СЕТИ",
      heading: ["Сеть может исчезнуть.", "Производство не должно."],
      imageAlt: "Макет завода на закате",
      kicker: "02 / БЕЗ СЕТИ",
      lead: "Станция пишет операции в свой журнал и отправляет их на сервер, когда связь вернётся. Если записи с разных станций не сошлись, это видно в разделе «Конфликты».",
      points: [
        ["Проверка на месте", "Коды проверяются на станции без ожидания сервера."],
        ["Операции сохраняются", "Каждое действие лежит в локальном журнале до отправки."],
        ["Линия продолжает работу", "Оператор видит, что происходит, и продолжает смену после сбоя."],
      ],
      screenAlt: "Экран станции без связи с сервером",
    },
    traceability: {
      caption: "СТАНЦИЯ · КОНФЛИКТЫ",
      heading: "У каждой ошибки есть история и следующий шаг.",
      kicker: "03 / ПРОСЛЕЖИВАЕМОСТЬ",
      lead: "Каждое действие остаётся в истории. Проблемную операцию можно понять, повторить или передать ответственному.",
      screenAlt: "Экран станции: список конфликтов",
    },
    filmBlock: {
      button: "Посмотреть, как это работает",
      heading: "Посмотрите, как код проходит через производство.",
      imageAlt: "Страница «Как работает»: глава про склад на макете завода",
      kicker: "04 / КАК ЭТО РАБОТАЕТ",
      lead: "Прокрутите страницу, и камера пройдёт по макету завода: линия, упаковка, склад, киоск и офис.",
    },
    rollout: {
      heading: "Для любой маркируемой продукции.",
      kicker: "05 / ВНЕДРЕНИЕ",
      labels: [
        { alt: "Этикетка короба для сока: товар, даты, GTIN и штрихкод SSCC", caption: "ЭТИКЕТКА КОРОБА · СОКИ", id: "juices" },
        { alt: "Этикетка короба для косметики: товар, даты, GTIN и штрихкод SSCC", caption: "ЭТИКЕТКА КОРОБА · КОСМЕТИКА", id: "cosmetics" },
      ],
      lead: "Коды, короба и паллеты устроены одинаково для соков и воды, молочной продукции, пива и косметики. Особенности вашей товарной группы сверяем до запуска.",
      steps: [
        ["Сверяем правила вашей товарной группы", "Фиксируем товарную группу, форм-фактор упаковки и правила учёта."],
        ["Разбираем линию", "Сопоставляем оборудование, роли и текущий маршрут кодов."],
        ["Запускаем один сценарий", "Настраиваем станцию под конкретный продукт и короб."],
        ["Проверяем на смене", "Работаем с оператором и проверяем восстановление после ошибок."],
      ],
    },
    documents: {
      allInstructions: "Все инструкции",
      covers: [
        { alt: "Первая страница инструкции MKR-INS-01", caption: "MKR-INS-01 · СТАНЦИЯ: ВХОД И СМЕНА", code: "mkr-ins-01" },
        { alt: "Первая страница инструкции MKR-INS-02", caption: "MKR-INS-02 · СТАНЦИЯ: РАБОТА НА ЛИНИИ", code: "mkr-ins-02" },
        { alt: "Первая страница инструкции MKR-INS-09", caption: "MKR-INS-09 · КАБИНЕТ: СВОДКА И ВЫГРУЗКИ", code: "mkr-ins-09" },
      ],
      heading: "Всё описано до покупки.",
      kicker: "06 / ОТКРЫТЫЕ ДОКУМЕНТЫ",
      lead: "Инструкции для станции и кабинета, договор и регламенты опубликованы на сайте. Их можно прочитать до разговора с нами.",
      legal: "Договор и регламенты",
    },
```

- [ ] **Step 4: Add the English copy**

Inside the EN `home` object add the same keys after `demo`:

```ts
    mapHero: {
      filmLink: "See how it works",
      heading: ["Serialization and aggregation.", "Keep the line moving."],
      hint: "Hover a dot to see the screen used in that area",
      imageAlt:
        "Scale model of a plant: the hall with the line, packing and warehouse, the kiosk at the entrance, the office and the finished-goods store",
      kicker: "SERIALIZATION · AGGREGATION · TRACEABILITY",
      lead: "We verify codes, assemble cases and pallets, and print labels for juice, cosmetics, beer and dairy. When the network drops, the station keeps working.",
      spots: [
        {
          id: "line",
          label: "Line",
          line: "The station checks every code before it goes into a case.",
          screenAlt: "Station screen: case assembly and accepted codes in the shift log",
          target: "#product-line",
        },
        {
          id: "packing",
          label: "Packing",
          line: "When a case is full, the station prints an SSCC label.",
          screenAlt: "Station screen: a case and a pallet in progress",
          target: "#product-line",
        },
        {
          id: "warehouse",
          label: "Warehouse",
          line: "The handheld builds pallets and runs inventory.",
          screenAlt: "Handheld screen: case assembly on the terminal",
          target: "#product-handheld",
        },
        {
          id: "kiosk",
          label: "Kiosk",
          line: "Employee purchases, samples and breakage go through the kiosk.",
          screenAlt: "Disposal kiosk screen",
          target: "#product-kiosk",
        },
        {
          id: "office",
          label: "Office",
          line: "The admin panel holds every shift, the 1C exchange and Chestny ZNAK exports.",
          screenAlt: "Admin panel: today's production summary",
          target: "#product-office",
        },
      ],
      stripLabel: "Production areas",
    },
    productSection: {
      cards: [
        {
          caption: "KIOSK",
          id: "kiosk",
          kicker: "DISPOSAL · KIOSK",
          link: "Self-service kiosk",
          screenAlt: "Disposal kiosk screen",
          text: "When products leave other than by shipment (employee purchases, samples, breakage), the employee scans a badge and the codes at the kiosk, and the request arrives in the admin panel.",
          title: "Disposal goes through the kiosk.",
        },
        {
          caption: "ADMIN PANEL · CHESTNY ZNAK LINK",
          id: "integrations",
          kicker: "INTEGRATIONS",
          link: "1C integration",
          screenAlt: "Admin panel: a product from the National Catalogue and the Chestny ZNAK link",
          text: "The admin panel is linked to Chestny ZNAK and exchanges tasks and statuses with 1C, so nobody retypes data.",
          title: "Chestny ZNAK, 1C and an API.",
        },
      ],
      heading: "The screens people work with on shift.",
      kicker: "01 / PRODUCT",
      rows: [
        {
          bullets: ["Repeated codes and foreign GTINs", "Several terminals on one line", "Printing in ZPL and TSPL"],
          caption: "STATION · CASE AND PALLET",
          id: "line",
          kicker: "LINE · STATION",
          link: "Serialization and aggregation",
          screenAlt: "Station screen: a case, a pallet and the shift log",
          text: "The station keeps repeated codes, codes of another product and malformed codes out of the case. The operator sees the reason on screen, and a full case gets its SSCC label at once.",
          title: "We check every code before it goes into a case.",
        },
        {
          bullets: ["Building and breaking pallets", "Inventory at the rack", "Label printing from the terminal"],
          caption: "ANDROID HANDHELD",
          id: "handheld",
          kicker: "WAREHOUSE · ANDROID HANDHELD",
          link: "See it in the warehouse",
          screenAlt: "Handheld screen: case assembly on the terminal",
          text: "A warehouse worker with an Android handheld builds pallets, removes cases from them and runs inventory at the rack. Operations go into the same log as the station's.",
          title: "Pallets are built on the handheld.",
        },
        {
          bullets: ["Shift summary and alerts", "Exports to Chestny ZNAK", "Products from the National Catalogue"],
          caption: "ADMIN PANEL · SHIFT SUMMARY",
          id: "office",
          kicker: "OFFICE · ADMIN PANEL",
          link: "Admin panel instructions",
          screenAlt: "Admin panel: today's production summary",
          text: "Operations from stations, handhelds and kiosks arrive here. From here you exchange data with 1C and export documents for Chestny ZNAK.",
          title: "Every shift is visible in the admin panel.",
        },
      ],
    },
    offline: {
      caption: "STATION WITHOUT A NETWORK",
      heading: ["The network may disappear.", "Production must not."],
      imageAlt: "Scale model of a plant at sunset",
      kicker: "02 / WITHOUT A NETWORK",
      lead: "The station writes operations to its own journal and sends them to the server when the connection returns. If records from different stations disagree, they show up under Conflicts.",
      points: [
        ["Checks on the spot", "Codes are verified on the station without waiting for the server."],
        ["Operations are kept", "Every action stays in the local journal until it is sent."],
        ["The line keeps running", "The operator sees what is happening and carries on after a failure."],
      ],
      screenAlt: "Station screen without a server connection",
    },
    traceability: {
      caption: "STATION · CONFLICTS",
      heading: "Every error has a history and a next step.",
      kicker: "03 / TRACEABILITY",
      lead: "Every action stays in the history. A failed operation can be understood, retried or handed to the right person.",
      screenAlt: "Station screen: the list of conflicts",
    },
    filmBlock: {
      button: "See how it works",
      heading: "See how a code travels through production.",
      imageAlt: "The How it works page: the warehouse chapter over the scale model",
      kicker: "04 / HOW IT WORKS",
      lead: "Scroll the page and the camera moves through a scale model of the plant: the line, packing, the warehouse, the kiosk and the office.",
    },
    rollout: {
      heading: "For any marked goods.",
      kicker: "05 / ROLLOUT",
      labels: [
        { alt: "Juice case label: product, dates, GTIN and SSCC barcode", caption: "CASE LABEL · JUICE", id: "juices" },
        { alt: "Cosmetics case label: product, dates, GTIN and SSCC barcode", caption: "CASE LABEL · COSMETICS", id: "cosmetics" },
      ],
      lead: "Codes, cases and pallets work the same way for juice and water, dairy, beer and cosmetics. We check the rules of your product group before launch.",
      steps: [
        ["We check the rules of your product group", "We record the product group, the packaging format and the accounting rules."],
        ["We walk the line", "We map the equipment, the roles and the current route of codes."],
        ["We launch one scenario", "We set up the station for a specific product and case."],
        ["We test it on shift", "We work with the operator and test recovery after errors."],
      ],
    },
    documents: {
      allInstructions: "All instructions",
      covers: [
        { alt: "First page of instruction MKR-INS-01", caption: "MKR-INS-01 · STATION: SIGN-IN AND SHIFT", code: "mkr-ins-01" },
        { alt: "First page of instruction MKR-INS-02", caption: "MKR-INS-02 · STATION: WORK ON THE LINE", code: "mkr-ins-02" },
        { alt: "First page of instruction MKR-INS-09", caption: "MKR-INS-09 · ADMIN PANEL: SUMMARY AND EXPORTS", code: "mkr-ins-09" },
      ],
      heading: "Everything is documented before you buy.",
      kicker: "06 / OPEN DOCUMENTS",
      lead: "Station and admin panel instructions, the agreement and the regulations are published on the site. You can read them before you talk to us.",
      legal: "Agreement and regulations",
    },
```

- [ ] **Step 5: Run the copy test**

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/landing exec vitest run src/content/home-copy.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Rewrite the home SEO entries**

In `apps/landing/src/content/pages.ts`, in the `path: "/"` entry replace `title`, `description` and `introduction`:

```ts
    title: "ПО для маркировки и агрегации по Честному знаку — Markiro",
    description:
      "Проверка кодов на линии, сборка коробов и паллет, печать этикеток и работа без сети. Для соков, молочной продукции, пива, косметики и другой маркируемой продукции.",
```

```ts
    introduction:
      "Производственная система для любой маркируемой продукции: проверка кодов, сборка коробов и паллет, печать этикеток и работа станции без сети.",
```

In the `path: "/en/"` entry:

```ts
    title: "Serialization and aggregation software for Chestny ZNAK — Markiro",
    description:
      "Code verification on the line, case and pallet aggregation, label printing and offline work. For juice, dairy, beer, cosmetics and other marked goods.",
```

```ts
    introduction:
      "A production system for any marked goods: code verification, case and pallet aggregation, label printing, and station work without a network.",
```

In both entries replace `reviewedAt: REVIEWED,` with a literal date, the day you make this change (the plan was written on `"2026-09-26"`): the sitemap's `lastmod` and the structured data's `dateModified` come from it, and the home page content changes with this plan. The `eyebrow` fields already read «Маркировка / агрегация / прослеживаемость» and need no change.

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/landing exec vitest run src/content/pages.test.ts`
Expected: PASS (titles 57 and 65 characters, descriptions 163 and 150).

- [ ] **Step 7: Write the failing llms.txt assertions**

In `apps/landing/src/lib/seo.test.ts`, inside the test "publishes an experimental content map without ranking claims", after `expect(llms).toContain("# Markiro");` add:

```ts
    expect(llms).toContain(
      "- Товарные группы: любая маркируемая продукция, например соки и вода, молочная продукция, пиво, косметика. Правила конкретной товарной группы сверяются до запуска.",
    );
    expect(llms).toContain(
      "- Product groups: any marked goods, for example juice and water, dairy, beer and cosmetics. The rules of a specific product group are checked before launch.",
    );
    expect(llms).toContain("- Уровни агрегации: единица → короб → паллета.");
    expect(llms).toContain("- Aggregation levels: item → case → pallet.");
    expect(llms).not.toContain("Паллетная агрегация запланирована");
    expect(llms).not.toContain("для линий розлива");
```

The structured data describes the software "with visible facts only", and the new home page shows pallets and the Android handheld. In the test "describes the software with visible facts only" change `operatingSystem: "Windows, Web"` to `operatingSystem: "Windows, Android, Web"` and replace the two `featureList` expectations with:

```ts
    expect(ru?.featureList).toEqual([
      "Проверка кодов маркировки Data Matrix на линии",
      "Агрегация в короба и паллеты с SSCC",
      "Печать этикеток ZPL и TSPL",
      "Офлайн-работа станции с локальным журналом",
      "Сборка паллет и инвентаризация на ТСД с Android",
      "Обмен с 1С по CommerceML",
      "Выгрузки отчётов смены для ГИС МТ",
    ]);
```

```ts
    expect(en?.featureList).toEqual([
      "Data Matrix code verification on the line",
      "Case and pallet aggregation with SSCC",
      "ZPL and TSPL label printing",
      "Offline station with a local journal",
      "Pallet building and inventory on an Android handheld",
      "1C exchange over CommerceML",
      "Shift report exports for GIS MT",
    ]);
```

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/landing exec vitest run src/lib/seo.test.ts -t "content map|visible facts"`
Expected: FAIL (2 tests).

- [ ] **Step 8: Update the product facts**

In `apps/landing/src/lib/seo.ts`, in `renderLlmsTxt`, replace the RU lines «Что это…», «Товарная группа сейчас…» and «Уровень агрегации…» with:

```text
- Что это: производственная система маркировки «Честный знак». Коды Data Matrix проверяются на станции при сканировании, единицы собираются в короба и паллеты с SSCC, этикетки печатаются в ZPL или TSPL, каждое действие остаётся в журнале.
- Товарные группы: любая маркируемая продукция, например соки и вода, молочная продукция, пиво, косметика. Правила конкретной товарной группы сверяются до запуска.
- Уровни агрегации: единица → короб → паллета. Паллеты собирают на станции и на ТСД.
- ТСД: терминал на Android собирает паллеты, снимает с них коробы и проводит инвентаризацию у стеллажа.
```

and the EN lines "What it is…", "Current product group…" and "Aggregation level…" with:

```text
- What it is: a Chestny ZNAK production serialization system. Data Matrix codes are validated on the station at scan time, items are aggregated into cases and pallets with SSCC, labels print in ZPL or TSPL, and every action stays in the log.
- Product groups: any marked goods, for example juice and water, dairy, beer and cosmetics. The rules of a specific product group are checked before launch.
- Aggregation levels: item → case → pallet. Pallets are built on the station and on the handheld.
- Handheld: an Android terminal builds pallets, removes cases from them and runs inventory at the rack.
```

In the same file set `operatingSystem: "Windows, Android, Web",` in the `SoftwareApplication` node of `buildPageGraph`, and make `SOFTWARE_FACTS.ru.features` and `SOFTWARE_FACTS.en.features` the two lists from Step 7, in that order.

- [ ] **Step 9: Run the SEO tests**

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/landing exec vitest run src/lib/seo.test.ts src/content/pages.test.ts src/content/home-copy.test.ts`
Expected: PASS.

- [ ] **Step 10: Typecheck and commit**

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/landing typecheck`
Expected: 0 errors.

```bash
git add apps/landing/src/content/ui.ts apps/landing/src/content/pages.ts apps/landing/src/content/home-copy.test.ts apps/landing/src/lib/seo.ts apps/landing/src/lib/seo.test.ts
git commit -m "feat(landing): home copy, SEO and product facts for any marked goods" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Hotspot projection from the film scene

The five hotspots are positions in the 3D plant projected with the camera that renders the hero still.

**Files:**

- Modify: `apps/landing/src/scripts/film/world/plant.ts` (constants near line 20-30; `buildPlant` calls at lines 519, 533, 541)
- Create: `apps/landing/src/content/home-map.json`
- Create: `apps/landing/src/scripts/film/world/home-map.ts`
- Test: `apps/landing/src/scripts/film/world/home-map.test.ts`

**Interfaces:**

- Consumes: `aimCamera(camera, pose, width, height)` from `./stage`; `poseAt` from `../camera-path`; `CAMERA_KEYS` from `../camera-keys`; `cameraTime` from `../timeline`; `FILM_CHAPTERS` from `./runtime`.
- Produces: `PLANT_SPOTS: readonly PlantSpot[]` and `type PlantSpotId = "line" | "packing" | "warehouse" | "kiosk" | "office"` in `plant.ts`; `HOME_MAP_FRAME = { width: 1440, height: 900 }`, `interface HomeMapPoint { id: PlantSpotId; x: number; y: number }` and `projectHomeMap(): HomeMapPoint[]` in `home-map.ts` (x and y are 0..1 from the left and top of the still).

- [ ] **Step 1: Write the failing test**

Create `apps/landing/src/scripts/film/world/home-map.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import settings from "../../../content/home-map.json";
import { HOME_MAP_FRAME, projectHomeMap } from "./home-map";

describe("home map projection", () => {
  const points = projectHomeMap();
  const at = (id: string) => {
    const point = points.find((candidate) => candidate.id === id);
    if (point === undefined) throw new Error(`missing ${id}`);
    return point;
  };

  it("renders the still at the recorded film moment and frame", () => {
    expect(settings.filmTime).toBe(0.8);
    expect(HOME_MAP_FRAME).toEqual({ width: 1440, height: 900 });
  });

  it("keeps every hotspot on the image and right of the text column", () => {
    expect(points.map((point) => point.id)).toEqual([
      "line",
      "packing",
      "warehouse",
      "kiosk",
      "office",
    ]);
    for (const point of points) {
      expect(point.x, point.id).toBeGreaterThan(0.42);
      expect(point.x, point.id).toBeLessThan(0.97);
      expect(point.y, point.id).toBeGreaterThan(0.08);
      expect(point.y, point.id).toBeLessThan(0.92);
    }
  });

  it("keeps the plant's layout: office behind, kiosk in front, line to warehouse left to right", () => {
    expect(at("office").y).toBeLessThan(at("packing").y);
    expect(at("packing").y).toBeLessThan(at("kiosk").y);
    expect(at("line").y).toBeLessThan(at("kiosk").y);
    expect(at("line").x).toBeLessThan(at("packing").x);
    expect(at("packing").x).toBeLessThan(at("warehouse").x);
  });

  it("leaves room between the dots for their labels", () => {
    for (const a of points) {
      for (const b of points) {
        if (a.id >= b.id) continue;
        const gap = Math.hypot((a.x - b.x) * HOME_MAP_FRAME.width, (a.y - b.y) * HOME_MAP_FRAME.height);
        expect(gap, `${a.id}–${b.id}`).toBeGreaterThan(64);
      }
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/landing exec vitest run src/scripts/film/world/home-map.test.ts`
Expected: FAIL (cannot resolve `./home-map`).

- [ ] **Step 3: Export the plant anchors**

In `apps/landing/src/scripts/film/world/plant.ts`, below the `TABLE` constant add:

```ts
const PALLET_AT = { x: 2.45, z: 1.2 } as const;
const KIOSK_AT = { x: -4.75, z: 3.05 } as const;
const OFFICE_AT = { x: 6.2, z: -2.75 } as const;

export type PlantSpotId = "line" | "packing" | "warehouse" | "kiosk" | "office";

export interface PlantSpot {
  readonly id: PlantSpotId;
  readonly position: Vec3Tuple;
}

/** The home page's map hotspots: the places the film's chapters are about. */
export const PLANT_SPOTS: readonly PlantSpot[] = [
  { id: "line", position: [BELT.archX, FLOOR + 1.1, CONVEYOR.z] },
  { id: "packing", position: [TABLE.x, FLOOR + TABLE.height + 0.3, TABLE.z] },
  { id: "warehouse", position: [PALLET_AT.x, FLOOR + 1.1, PALLET_AT.z] },
  { id: "kiosk", position: [KIOSK_AT.x, FLOOR + 1.3, KIOSK_AT.z] },
  { id: "office", position: [OFFICE_AT.x, FLOOR + 1.6, OFFICE_AT.z] },
];
```

In `buildPlant` use the constants instead of the literals:

```ts
  const loaded = pallet(kit, plant, PALLET_AT.x, FLOOR, PALLET_AT.z, PALLET_CAPACITY, label);
```

```ts
  const kioskScreen = checkpoint(kit, plant, screens, KIOSK_AT.x, KIOSK_AT.z);
```

```ts
  office(kit, plant, OFFICE_AT.x, OFFICE_AT.z, windows);
```

If `BELT` is not imported in `plant.ts` yet, add it to the existing import from `"../animations"`. `Vec3Tuple` is already used by `PlantHandles`.

- [ ] **Step 4: Record the film moment**

Create `apps/landing/src/content/home-map.json`:

```json
{ "filmTime": 0.8 }
```

- [ ] **Step 5: Write the projection**

Create `apps/landing/src/scripts/film/world/home-map.ts`:

```ts
import { PerspectiveCamera, Vector3 } from "three";

import settings from "../../../content/home-map.json";
import { CAMERA_KEYS } from "../camera-keys";
import { poseAt } from "../camera-path";
import { cameraTime } from "../timeline";
import { PLANT_SPOTS, type PlantSpotId } from "./plant";
import { FILM_CHAPTERS } from "./runtime";
import { aimCamera } from "./stage";

/** The still is rendered at this size (twice the pixels); the hero keeps its aspect ratio. */
export const HOME_MAP_FRAME = { width: 1440, height: 900 } as const;

export interface HomeMapPoint {
  readonly id: PlantSpotId;
  /** 0 at the left edge of the still, 1 at the right. */
  readonly x: number;
  /** 0 at the top edge of the still, 1 at the bottom. */
  readonly y: number;
}

/** Projects the plant's hotspot anchors with the camera that rendered the home map still. */
export function projectHomeMap(): HomeMapPoint[] {
  const camera = new PerspectiveCamera();
  const pose = poseAt(CAMERA_KEYS, cameraTime(settings.filmTime, FILM_CHAPTERS));
  aimCamera(camera, pose, HOME_MAP_FRAME.width, HOME_MAP_FRAME.height);
  camera.updateMatrixWorld(true);
  return PLANT_SPOTS.map(({ id, position }) => {
    const point = new Vector3(position[0], position[1], position[2]).project(camera);
    return { id, x: (point.x + 1) / 2, y: (1 - point.y) / 2 };
  });
}
```

- [ ] **Step 6: Run the tests**

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/landing exec vitest run src/scripts/film/world/`
Expected: PASS, including the existing district, kit, apply, clearance and framing tests (the plant geometry did not move).

- [ ] **Step 7: Commit**

```bash
git add apps/landing/src/scripts/film/world/plant.ts apps/landing/src/scripts/film/world/home-map.ts apps/landing/src/scripts/film/world/home-map.test.ts apps/landing/src/content/home-map.json
git commit -m "feat(landing): project the home map hotspots from the film scene" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Render the map still and the film page image

**Files:**

- Create: `tools/production-browser/scripts/film-render.mjs`
- Modify: `tools/production-browser/scripts/render-film-posters.mjs`
- Create: `tools/production-browser/scripts/render-home-images.mjs`
- Modify: `tools/production-browser/package.json` (script entry)
- Create: `apps/landing/src/assets/home/map-wide.jpg`, `apps/landing/src/assets/home/map-phone.jpg`, `apps/landing/src/assets/home/film-page.jpg` (generated)

**Interfaces:**

- Consumes: `apps/landing/src/content/home-map.json` (`filmTime`).
- Produces: `apps/landing/src/assets/home/map-wide.jpg` (2880 × 1800), `apps/landing/src/assets/home/map-phone.jpg` (1504 × 940, a 16:10 crop of the same frame around the hall) and `apps/landing/src/assets/home/film-page.jpg` (2880 × 1800); `landingRoot` exported from `film-render.mjs` (Task 7 uses it).

- [ ] **Step 1: Move the render helpers into a module**

Create `tools/production-browser/scripts/film-render.mjs`:

```js
import { spawn } from "node:child_process";
import path from "node:path";

export const toolRoot = path.resolve(import.meta.dirname, "..");
export const landingRoot = path.resolve(toolRoot, "../../apps/landing");
export const baseUrl = "http://127.0.0.1:5473";
export const filmUrl = `${baseUrl}/kak-rabotaet/?film-tier=high&film-budget=off`;

// Scene renders carry the scene only: the pages draw their own text over them.
export const SCENE_ONLY = `
  .film-top, .film-hero, .film-card, .film__rail, [data-consent-panel],
  .film-chapter__poster, .film-chapter--hero::before { visibility: hidden !important; }
`;

export const HIDE_CONSENT = "[data-consent-panel] { display: none !important; }";

async function waitForServer(url, child) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (child.exitCode !== null) throw new Error("landing server exited early");
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("landing server did not start");
}

/** Builds and serves the landing on port 5473; returns the child process. */
export async function startLandingServer() {
  const server = spawn(process.execPath, [path.join(toolRoot, "scripts/serve-landing.mjs")], {
    stdio: "inherit",
  });
  await waitForServer(`${baseUrl}/kak-rabotaet/`, server);
  return server;
}

/** Opens the film, waits for the live scene. */
export async function openLiveFilm(page, { sceneOnly }) {
  page.on("console", (message) => {
    if (message.type() === "error") console.error(`[page] ${message.text()}`);
  });
  await page.goto(filmUrl, { waitUntil: "networkidle" });
  await page.addStyleTag({ content: sceneOnly ? SCENE_ONLY : HIDE_CONSENT });
  await page.evaluate(() => window.scrollBy({ top: 1, behavior: "instant" }));
  await page.waitForFunction(
    () => document.querySelector("[data-film]")?.classList.contains("film--live"),
    null,
    { timeout: 120_000 },
  );
}

export async function scrollToFilmTime(page, filmTime) {
  await page.evaluate((target) => {
    const sections = [...document.querySelectorAll("[data-film-chapter]")];
    const index = Math.min(sections.length - 1, Math.floor(target));
    const local = target - index;
    const section = sections[index];
    const top = section.getBoundingClientRect().top + window.scrollY;
    const viewport = window.innerHeight;
    const y =
      index === 0
        ? top + local * (section.offsetHeight - viewport)
        : top - viewport + local * section.offsetHeight;
    window.scrollTo({ top: Math.round(y), behavior: "instant" });
  }, filmTime);
  await page.waitForFunction(
    (target) =>
      Math.abs(Number(document.querySelector("[data-film]")?.dataset.filmTime ?? -1) - target) <
      0.01,
    filmTime,
    { timeout: 60_000 },
  );
  await page.waitForTimeout(500);
}
```

- [ ] **Step 2: Use the module in the poster script**

Replace `tools/production-browser/scripts/render-film-posters.mjs` with:

```js
import path from "node:path";

import { chromium } from "@playwright/test";

import { landingRoot, openLiveFilm, scrollToFilmTime, startLandingServer } from "./film-render.mjs";

const outputRoot = path.join(landingRoot, "src/assets/film");
const CHAPTERS = ["district", "line", "packing", "warehouse", "offline", "kiosk", "office"];
const LAYOUTS = [
  {
    name: "wide",
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  },
  {
    name: "tall",
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  },
];

const server = await startLandingServer();
try {
  const browser = await chromium.launch({
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  for (const layout of LAYOUTS) {
    const context = await browser.newContext({ ...layout, reducedMotion: "no-preference" });
    const page = await context.newPage();
    await openLiveFilm(page, { sceneOnly: true });
    for (const [index, id] of CHAPTERS.entries()) {
      await scrollToFilmTime(page, index === 0 ? 0 : index + 0.5);
      await page.screenshot({
        path: path.join(outputRoot, `${id}-${layout.name}.jpg`),
        type: "jpeg",
        quality: 88,
      });
      console.log(`rendered ${id}-${layout.name}.jpg`);
    }
    await context.close();
  }
  await browser.close();
} finally {
  server.kill("SIGTERM");
}
```

- [ ] **Step 3: Write the home render script**

Create `tools/production-browser/scripts/render-home-images.mjs`:

```js
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { chromium } from "@playwright/test";

import { landingRoot, openLiveFilm, scrollToFilmTime, startLandingServer } from "./film-render.mjs";

const outputRoot = path.join(landingRoot, "src/assets/home");
const { filmTime } = JSON.parse(
  readFileSync(path.join(landingRoot, "src/content/home-map.json"), "utf8"),
);
// The film page image shows the warehouse chapter with its card over the scene.
const FILM_PAGE_TIME = 3.5;
// Phones show a crop around the hall in the stage's 16:10 shape (CSS pixels of the 1440 × 900 frame).
const PHONE_CROP = { x: 576, y: 180, width: 752, height: 470 };
const FRAME = {
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  isMobile: false,
  hasTouch: false,
  reducedMotion: "no-preference",
};

mkdirSync(outputRoot, { recursive: true });
const server = await startLandingServer();
try {
  const browser = await chromium.launch({
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  for (const shot of [
    { file: "map-wide.jpg", sceneOnly: true, time: filmTime, crop: "map-phone.jpg" },
    { file: "film-page.jpg", sceneOnly: false, time: FILM_PAGE_TIME, crop: null },
  ]) {
    const context = await browser.newContext(FRAME);
    const page = await context.newPage();
    await openLiveFilm(page, { sceneOnly: shot.sceneOnly });
    await scrollToFilmTime(page, shot.time);
    await page.screenshot({ path: path.join(outputRoot, shot.file), type: "jpeg", quality: 86 });
    console.log(`rendered ${shot.file} at film time ${shot.time}`);
    if (shot.crop !== null) {
      await page.screenshot({
        path: path.join(outputRoot, shot.crop),
        type: "jpeg",
        quality: 86,
        clip: PHONE_CROP,
      });
      console.log(`rendered ${shot.crop}`);
    }
    await context.close();
  }
  await browser.close();
} finally {
  server.kill("SIGTERM");
}
```

In `tools/production-browser/package.json` add next to `"render:film-posters"`:

```json
    "render:home-images": "node scripts/render-home-images.mjs",
```

- [ ] **Step 4: Render and look at the images**

Stop anything listening on port 5473, then run outside the sandbox:

Run: `pnpm --dir tools/production-browser --ignore-workspace render:home-images`
Expected: `rendered map-wide.jpg at film time 0.8`, `rendered map-phone.jpg` and `rendered film-page.jpg at film time 3.5`; `sips -g pixelWidth -g pixelHeight apps/landing/src/assets/home/*.jpg` reports 2880 × 1800 for `map-wide.jpg` and `film-page.jpg`, 1504 × 940 for `map-phone.jpg`.

Open `map-wide.jpg`: the hall with the line, the packing table and the pallet sits right of centre, the office and the finished-goods store behind it, the brewery on the left under calm space. If the hall is small or cut off, try `filmTime` 0.78–0.86 in `home-map.json`, change the expected value in Task 3's test "renders the still at the recorded film moment and frame" to match, rerun that test and this render, and keep the value that frames the hall best. Open `map-phone.jpg`: the whole hall fills the crop. If it sits off-centre, move `PHONE_CROP` (keep width : height at 16 : 10) and rerun.

- [ ] **Step 5: Owner review of the map still**

Show `map-wide.jpg` and `map-phone.jpg` to the owner (the spec's first open item) and record the accepted `filmTime`. Do not continue to Task 8 before the stills are accepted.

- [ ] **Step 6: Re-render the film posters with the refactored script**

Run: `pnpm --dir tools/production-browser --ignore-workspace render:film-posters`
Expected: 14 `rendered …` lines. Then `git status --short apps/landing/src/assets/film` and restore unchanged-content posters: `git checkout -- apps/landing/src/assets/film` (the posters render slightly differently every run; this step only proves the refactor works).

- [ ] **Step 7: Commit**

```bash
git add tools/production-browser/scripts/film-render.mjs tools/production-browser/scripts/render-film-posters.mjs tools/production-browser/scripts/render-home-images.mjs tools/production-browser/package.json apps/landing/src/assets/home/map-wide.jpg apps/landing/src/assets/home/map-phone.jpg apps/landing/src/assets/home/film-page.jpg apps/landing/src/content/home-map.json apps/landing/src/scripts/film/world/home-map.test.ts
git commit -m "feat(landing): render the home map still and the film page image" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 5: Station gallery landing profile and station screens

The station's dev screen gallery gets a demo-data profile. `profile=landing` swaps the test data for a neutral product; without the parameter the gallery is byte-for-byte what the instruction reshoots use today.

**Files:**

- Create: `apps/station/src/dev/gallery-profile.ts`
- Modify: `apps/station/src/dev/gallery-fixtures.ts:63-66` (`GalleryRequest`), `:427-442` (`resolveGalleryRequest`)
- Modify: `apps/station/src/dev/StationScreenGallery.tsx` (station/line/operator/shift passed to `FloorShell` near line 271; `WorkFixture` product name line 1785 and counterparty line 1813; recent-operation serials near line 1931; `GALLERY_CONFLICT_ROWS` near lines 2397-2425)
- Test: `apps/station/test/gallery-profile.test.tsx`
- Modify: `tools/production-browser/scripts/film-render.mjs` (export `waitForServer`)
- Create: `tools/production-browser/scripts/capture-station-screens.mjs`
- Create: `apps/landing/src/assets/home/screens/{ru,en}/station-{aggregation,box,offline,conflicts}.png` (generated)

**Interfaces:**

- Produces: `type GalleryProfileId = "instructions" | "landing"`, `galleryProfile(id, locale): GalleryProfile`, `useGalleryProfile()`, `GalleryProfileContext` in `gallery-profile.ts`; `GalleryRequest.profile?: GalleryProfileId`; `waitForServer(url, child)` exported from `film-render.mjs`; eight station PNGs (1600 × 1000).

- [ ] **Step 1: Write the failing test**

Create `apps/station/test/gallery-profile.test.tsx`:

```tsx
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { resolveGalleryRequest } from "../src/dev/gallery-fixtures.js";
import { galleryProfile } from "../src/dev/gallery-profile.js";
import { StationScreenGallery } from "../src/dev/StationScreenGallery.js";

afterEach(() => {
  cleanup();
});

describe("gallery profiles", () => {
  it("reads the landing profile from the address and leaves other requests unchanged", () => {
    expect(
      resolveGalleryRequest(true, "?gallery=1&state=work-aggregation&locale=ru&profile=landing"),
    ).toEqual({ state: "work-aggregation", locale: "ru", profile: "landing" });
    expect(resolveGalleryRequest(true, "?gallery=1&state=work-aggregation&locale=ru")).toEqual({
      state: "work-aggregation",
      locale: "ru",
    });
    expect(
      resolveGalleryRequest(true, "?gallery=1&state=work-aggregation&profile=unknown"),
    ).toEqual({ state: "work-aggregation", locale: "ru" });
  });

  it("keeps the instructions profile identical to the original demo data", () => {
    const ru = galleryProfile("instructions", "ru");
    const en = galleryProfile("instructions", "en");
    expect([ru.productName, ru.counterpartyName, ru.station, ru.line, ru.operator, ru.shift]).toEqual([
      "Тестовый товар А",
      "ООО «Тестовый производитель»",
      "Демо-станция 01",
      "Тестовая линия А",
      "Оператор Тестов",
      "Смена ДЕМО-01",
    ]);
    expect([en.productName, en.line, en.shift]).toEqual(["Sample product A", "Test line A", "Shift DEMO-01"]);
    expect([ru.serial(128), ru.serial(123), ru.terminal(11)]).toEqual([
      "DEMO-SERIAL-000128",
      "DEMO-SERIAL-000123",
      "DEMO-TERM-11",
    ]);
  });

  it.each(["work-aggregation", "work-pallet-20", "offline", "conflicts-page-1"] as const)(
    "shows no test data on %s with the landing profile",
    async (state) => {
      for (const locale of ["ru", "en"] as const) {
        const view = render(<StationScreenGallery request={{ state, locale, profile: "landing" }} />);
        await view.findByTestId("station-screen-gallery");
        const text = document.body.textContent ?? "";
        expect(text, `${state} ${locale}`).not.toMatch(
          /Тестов|Демо-станция|DEMO-|Sample product|Sample Manufacturer|Test line|Demo station/u,
        );
        cleanup();
      }
    },
  );

  it("names the landing product on the work screen", async () => {
    const view = render(
      <StationScreenGallery request={{ state: "work-aggregation", locale: "ru", profile: "landing" }} />,
    );
    expect((await view.findAllByText("Сок яблочный, 1 л")).length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/station exec vitest run test/gallery-profile.test.tsx`
Expected: FAIL (cannot resolve `gallery-profile.js`).

- [ ] **Step 3: Write the profiles**

Create `apps/station/src/dev/gallery-profile.ts`:

```ts
import { createContext, useContext } from "react";

import type { GalleryLocale } from "./gallery-fixtures.js";

/** `instructions` is the gallery's original test data; the printed instructions are shot from it. */
export type GalleryProfileId = "instructions" | "landing";

/** The demo data a visitor sees on gallery screens. */
export interface GalleryProfile {
  readonly productName: string;
  readonly counterpartyName: string | null;
  readonly station: string;
  readonly line: string;
  readonly operator: string;
  readonly shift: string;
  /** The serial of the n-th demo marking code. */
  readonly serial: (n: number) => string;
  /** The label of the n-th demo terminal. */
  readonly terminal: (n: number) => string;
}

const LANDING_SERIALS = [
  "5aB7Kq1Zx9nT4",
  "Q2m8Rd6hT3wP0",
  "9Lk2Vb7Rf4Nq8",
  "cX5tY1uI8oP3a",
  "M4nB6vC2xZ7lK",
  "7jH3gF9dS1aQ5",
  "W2eR8tY4uI6oP",
  "zX1cV5bN9mL3k",
] as const;

function landingSerial(n: number): string {
  return LANDING_SERIALS[Math.abs(n) % LANDING_SERIALS.length] ?? LANDING_SERIALS[0];
}

function instructionSerial(n: number): string {
  return `DEMO-SERIAL-${String(n).padStart(6, "0")}`;
}

const PROFILES: Readonly<Record<GalleryProfileId, Readonly<Record<GalleryLocale, GalleryProfile>>>> = {
  instructions: {
    ru: {
      productName: "Тестовый товар А",
      counterpartyName: "ООО «Тестовый производитель»",
      station: "Демо-станция 01",
      line: "Тестовая линия А",
      operator: "Оператор Тестов",
      shift: "Смена ДЕМО-01",
      serial: instructionSerial,
      terminal: (n) => `DEMO-TERM-${n}`,
    },
    en: {
      productName: "Sample product A",
      counterpartyName: "Sample Manufacturer Ltd",
      station: "Demo station 01",
      line: "Test line A",
      operator: "Sample Operator",
      shift: "Shift DEMO-01",
      serial: instructionSerial,
      terminal: (n) => `DEMO-TERM-${n}`,
    },
  },
  landing: {
    ru: {
      productName: "Сок яблочный, 1 л",
      counterpartyName: null,
      station: "Станция упаковки 1",
      line: "Линия 1",
      operator: "Мария Соколова",
      shift: "Смена 12",
      serial: landingSerial,
      terminal: (n) => `Терминал ${n}`,
    },
    en: {
      productName: "Apple juice, 1 L",
      counterpartyName: null,
      station: "Packing station 1",
      line: "Line 1",
      operator: "Maria Sokolova",
      shift: "Shift 12",
      serial: landingSerial,
      terminal: (n) => `Terminal ${n}`,
    },
  },
};

export function galleryProfile(id: GalleryProfileId, locale: GalleryLocale): GalleryProfile {
  return PROFILES[id][locale];
}

export const GalleryProfileContext = createContext<GalleryProfile>(PROFILES.instructions.ru);

export function useGalleryProfile(): GalleryProfile {
  return useContext(GalleryProfileContext);
}
```

- [ ] **Step 4: Read the profile from the address**

In `apps/station/src/dev/gallery-fixtures.ts` add the type import at the top:

```ts
import type { GalleryProfileId } from "./gallery-profile.js";
```

extend the request type:

```ts
export interface GalleryRequest {
  state: GalleryStateId;
  locale: GalleryLocale;
  /** Omitted for the original demo data. */
  profile?: GalleryProfileId;
}
```

and at the end of `resolveGalleryRequest` replace `return { state, locale };` with:

```ts
  const profile: GalleryProfileId | null = params.get("profile") === "landing" ? "landing" : null;
  return profile === null ? { state, locale } : { state, locale, profile };
```

- [ ] **Step 5: Provide and use the profile in the gallery**

In `apps/station/src/dev/StationScreenGallery.tsx`:

1. Import: `import { GalleryProfileContext, galleryProfile, useGalleryProfile, type GalleryProfile } from "./gallery-profile.js";`
2. In `StationScreenGallery` after `const copy = COPY[request.locale];` add `const profile = galleryProfile(request.profile ?? "instructions", request.locale);`, wrap the component's returned JSX in `<GalleryProfileContext.Provider value={profile}>…</GalleryProfileContext.Provider>`, and in the props it passes to `FloorShell` replace `copy.station`, `copy.line`, `copy.operator` and `copy.shift` with `profile.station`, `profile.line`, `profile.operator` and `profile.shift`. Leave the `long*` copy and every other `COPY` field as it is.
3. In `WorkFixture` add `const profile = useGalleryProfile();` at the top of the function body, replace `const productName = ru ? "Тестовый товар А" : "Sample product A";` with `const productName = profile.productName;` and `counterpartyName={ru ? "ООО «Тестовый производитель»" : "Sample Manufacturer Ltd"}` with `counterpartyName={profile.counterpartyName}`.
4. The helper that returns the six recent operations (it builds `identityForSerial(\`DEMO-SERIAL-00012${8 - index}\`)`): add a parameter `serial: GalleryProfile["serial"]` as its last parameter, replace the expression with `identityForSerial(serial(128 - index))`, and pass `profile.serial` at its call site in `WorkFixture`.
5. Turn the `GALLERY_CONFLICT_ROWS` constant into `function galleryConflictRows(profile: GalleryProfile)` that returns the same rows with each `DEMO-SERIAL-0001NN` literal replaced by `profile.serial(NNN)` (128, 129, 130, 131) and each `"DEMO-TERM-NN"` by `profile.terminal(NN)` (11, 12, 21, 22); in the conflicts fixture call `galleryConflictRows(useGalleryProfile())` where the constant was used.

Then search for demo strings the landing states still show:

Run: `grep -n "DEMO-\|Тестов\|Sample \|Test line" apps/station/src/dev/StationScreenGallery.tsx`
Every remaining match belongs to a state that Step 1's test does not render (new-shift, shift list, inventory, exceptions, pairing) or to `COPY`'s `long*` strings; leave those.

- [ ] **Step 6: Run the station tests**

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/station exec vitest run test/gallery-profile.test.tsx test/screen-gallery.test.tsx test/screen-gallery-bootstrap.test.tsx`
Expected: PASS. `screen-gallery.test.tsx` still finds «Тестовый товар А», `DEMO-SERIAL-000128`, «15 / 66» and the shift label: the default profile did not change.

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/station typecheck && pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/station lint`
Expected: no errors.

- [ ] **Step 7: Write the capture script**

In `tools/production-browser/scripts/film-render.mjs` change `async function waitForServer` to `export async function waitForServer`.

Create `tools/production-browser/scripts/capture-station-screens.mjs`:

```js
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { chromium } from "@playwright/test";

import { landingRoot, toolRoot, waitForServer } from "./film-render.mjs";

const stationRoot = path.resolve(toolRoot, "../../apps/station");
const baseUrl = "http://127.0.0.1:5273";
// gallery state → file under apps/landing/src/assets/home/screens/<locale>/
const SHOTS = [
  ["work-aggregation", "station-aggregation"],
  ["work-pallet-20", "station-box"],
  ["offline", "station-offline"],
  ["conflicts-page-1", "station-conflicts"],
];

const server = spawn(
  process.execPath,
  [
    path.join(stationRoot, "node_modules/vite/bin/vite.js"),
    "--host",
    "127.0.0.1",
    "--port",
    "5273",
    "--strictPort",
  ],
  { cwd: stationRoot, stdio: "inherit" },
);
try {
  await waitForServer(`${baseUrl}/`, server);
  const browser = await chromium.launch();
  for (const locale of ["ru", "en"]) {
    const outputRoot = path.join(landingRoot, "src/assets/home/screens", locale);
    mkdirSync(outputRoot, { recursive: true });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1.25,
      colorScheme: "dark",
    });
    await context.addInitScript(() => localStorage.setItem("markiro.theme", "dark"));
    const page = await context.newPage();
    for (const [state, file] of SHOTS) {
      await page.goto(`${baseUrl}/?gallery=1&state=${state}&locale=${locale}&profile=landing`, {
        waitUntil: "networkidle",
      });
      await page.locator('[data-testid="station-screen-gallery"]').waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(outputRoot, `${file}.png`) });
      console.log(`captured ${locale}/${file}.png`);
    }
    await context.close();
  }
  await browser.close();
} finally {
  server.kill("SIGTERM");
}
```

In `tools/production-browser/package.json` add `"capture:station-screens": "node scripts/capture-station-screens.mjs",`.

- [ ] **Step 8: Capture and look at the station screens**

Run outside the sandbox: `pnpm --dir tools/production-browser --ignore-workspace capture:station-screens`
Expected: eight `captured …` lines. Open each PNG (1600 × 1000): «Сок яблочный, 1 л» / "Apple juice, 1 L", «Линия 1», «Смена 12», no «Тестов», no `DEMO-`, no red error banner on `work-aggregation` and `work-pallet-20`.

- [ ] **Step 9: Commit**

```bash
git add apps/station/src/dev/gallery-profile.ts apps/station/src/dev/gallery-fixtures.ts apps/station/src/dev/StationScreenGallery.tsx apps/station/test/gallery-profile.test.tsx tools/production-browser/scripts/film-render.mjs tools/production-browser/scripts/capture-station-screens.mjs tools/production-browser/package.json apps/landing/src/assets/home/screens
git commit -m "feat(station): gallery landing profile and station screens for the home page" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Admin panel, kiosk and handheld screens (controller task)

Needs Docker, the Android emulator and a seeded stand, so the controller runs it, not a subagent. The deliverables are six PNGs and a capture manifest; nothing else from the stand is committed.

**Files:**

- Create: `apps/landing/src/assets/home/screens/ru/cabinet-shifts.png`, `apps/landing/src/assets/home/screens/en/cabinet-shifts.png`, `apps/landing/src/assets/home/screens/ru/cabinet-chz.png`, `apps/landing/src/assets/home/screens/en/cabinet-chz.png`, `apps/landing/src/assets/home/screens/ru/kiosk.png`, `apps/landing/src/assets/home/screens/ru/handheld.png`
- Create: `apps/landing/src/assets/home/CAPTURES.md`

**Interfaces:**

- Produces: the six PNGs above (admin and kiosk 1600 × 1000 at device scale 1; handheld 1080 × 2400 from the emulator).

- [ ] **Step 1: Stand database**

Run outside the sandbox:

```bash
docker run -d --rm --name markiro-home-shots -e POSTGRES_PASSWORD=shots -e POSTGRES_DB=markiro -p 55441:5432 postgres:17-alpine
```

If the worktree has no `.env`, create it from `.env.example` and set `DATABASE_URL=postgres://postgres:shots@127.0.0.1:55441/markiro`, `NODE_ENV=test` and fresh random values for every secret the example leaves empty (write it outside the sandbox). If a `.env` exists, do not touch it; pass the same variables on the command line instead. Then:

```bash
set -a; source .env; set +a
pnpm --filter @markiro/db db:migrate
```

- [ ] **Step 2: API, admin panel and seed**

Start `pnpm --filter @markiro/api dev` (port 3000) and `pnpm --filter @markiro/admin dev` outside the sandbox. Copy `/Users/thevladbog/PRSOME/q/output/pdf/atoll/source/stand/seed.mjs`, `codes.txt` and `fake_printer.py` (the customer-proposal stand, untracked in the main checkout; read-only) into `$TMPDIR/home-stand/` and change the seed's products to «Сок яблочный, 1 л» (product group 23), «Нектар вишнёвый, 1 л» (23) and «Крем для рук, 75 мл» (35), each with a GTIN whose check digit is valid. The seed goes through the real API in this order: sign-up → organization create → set-active → `PATCH /profile` → `PUT /org/profile` with a GLN (otherwise the shift bundle has no SSCC issuer) → lines → products (`chzProductGroupCode`, `boxCapacity` and `palletCapacity` all set, or the shift fails with 422) → `buildDefaultLabelTemplates()` and `buildPalletLabelTemplates()` → shifts → open → employee and `PUT /operators/:id` → station device of kind `handheld` → pairing code.

- [ ] **Step 3: Handheld on the emulator**

Build and install outside the sandbox (`ANDROID_HOME` and the Android Studio JBR set): `cd apps/handheld && ./gradlew assembleDebug`, start the emulator `Medium_Phone_API_36` headless (`-no-window`), install the APK, point it at `http://10.0.2.2:3000`, pair with the code, start the shift, run `python3 $TMPDIR/home-stand/fake_printer.py` and set the printer to Wi-Fi `10.0.2.2:9100`, TSPL 203 dpi. Scan a few codes for «Сок яблочный, 1 л» with

```bash
adb shell "am broadcast -a android.intent.ACTION_DECODE_DATA --es barcode_string '01<gtin14>21<serial><GS>93<crypto>'" </dev/null
```

until a case is being assembled. Capture: `adb exec-out screencap -p > apps/landing/src/assets/home/screens/ru/handheld.png`.

- [ ] **Step 4: Admin panel**

With the scans from Step 3 in the database, open the admin panel at 1600 × 1000 (device scale 1): the production overview for today («Производство сегодня») → `screens/ru/cabinet-shifts.png`; the card of «Сок яблочный, 1 л» with its product group and the Chestny ZNAK link block → `screens/ru/cabinet-chz.png`. Switch the admin language to English and capture the same two pages into `screens/en/`.

- [ ] **Step 5: Kiosk**

Copy `apps/kiosk/test/touch-flow.html` and `touch-flow-browser.tsx` to twins (`readme-shot.html`, `readme-shot-browser.tsx`) in the same folder, give the twin a realistic cart (three to five items such as «Сок яблочный, 1 л», «Молоко 3,2 %, 1 л», «Крем для рук, 75 мл»), serve it as the existing harness is served, capture the cart screen at 1600 × 1000 into `screens/ru/kiosk.png`, and delete both twin files. They must not be committed.

- [ ] **Step 6: Tear down**

Stop the dev servers, the emulator and `fake_printer.py`; `docker stop markiro-home-shots`; delete the `.env` only if Step 1 created it.

- [ ] **Step 7: Check the frames**

Every frame shows the demo products, «Линия 1»-style names, no «Тест», no e-mail addresses or personal names beyond the seeded demo ones, and no error banners.

- [ ] **Step 8: Write the capture manifest**

Create `apps/landing/src/assets/home/CAPTURES.md`:

```markdown
# Home page captures

Frames shown on the home page. Retake them when the screens change.

| File | Source | How |
| --- | --- | --- |
| `map-wide.jpg`, `map-phone.jpg`, `film-page.jpg` | Film scene | `pnpm --dir tools/production-browser --ignore-workspace render:home-images` |
| `screens/*/station-*.png` | Station screen gallery, `profile=landing` | `pnpm --dir tools/production-browser --ignore-workspace capture:station-screens` |
| `screens/*/cabinet-*.png` | Admin panel on a seeded stand | Plan task 6, steps 1, 2 and 4 |
| `screens/ru/kiosk.png` | Kiosk harness twin with a realistic cart | Plan task 6, step 5 |
| `screens/ru/handheld.png` | Handheld on the Android emulator | Plan task 6, step 3 |
| `labels/*.png` | Copies of `examples/labels/*/box-100x150.png` | `apps/landing/test/home-assets.test.ts` checks them |
| `docs/*.png` | First pages of the published instructions, Russian and English | `pnpm --dir tools/production-browser --ignore-workspace render:instruction-covers` |

Plan: `docs/superpowers/plans/2026-09-26-landing-home-redesign.md`.
```

- [ ] **Step 9: Commit**

```bash
git add apps/landing/src/assets/home/screens apps/landing/src/assets/home/CAPTURES.md
git commit -m "feat(landing): admin panel, kiosk and handheld screens for the home page" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Case labels and instruction covers

**Files:**

- Create: `apps/landing/src/assets/home/labels/juices-box.png`, `apps/landing/src/assets/home/labels/cosmetics-box.png` (copies)
- Create: `tools/production-browser/scripts/render-instruction-covers.mjs`
- Modify: `tools/production-browser/package.json`
- Create: `apps/landing/src/assets/home/docs/<code>_<release>_<locale>.png` for `mkr-ins-01`, `mkr-ins-02`, `mkr-ins-09` in `ru` and `en` (six generated files)
- Test: `apps/landing/test/home-assets.test.ts`

**Interfaces:**

- Consumes: `landingRoot` from `tools/production-browser/scripts/film-render.mjs` (Task 4).
- Produces: covers named `<code>_<release>_<locale>.png`, where `<release>` is the newest release of `apps/landing/public/legal/files/markiro_<code>_<release>_<locale>.pdf` (today `2026.09-04`, `2026.09-03` and `2026.09-04`); label copies `labels/juices-box.png` and `labels/cosmetics-box.png` (799 × 1199).

- [ ] **Step 1: Write the failing test**

Create `apps/landing/test/home-assets.test.ts`:

```ts
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.resolve(appRoot, "../..");
const COVER_CODES = ["mkr-ins-01", "mkr-ins-02", "mkr-ins-09"] as const;
const LOCALES = ["en", "ru"] as const;

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function publishedReleases(code: string, locale: string): string[] {
  const prefix = `markiro_${code}_`;
  const suffix = `_${locale}.pdf`;
  return readdirSync(path.join(appRoot, "public/legal/files"))
    .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
    .map((name) => name.slice(prefix.length, -suffix.length))
    .sort();
}

describe("home page assets", () => {
  it("keeps the case labels identical to the published examples", () => {
    for (const group of ["juices", "cosmetics"]) {
      expect(sha256(path.join(appRoot, `src/assets/home/labels/${group}-box.png`)), group).toBe(
        sha256(path.join(repoRoot, `examples/labels/${group}/box-100x150.png`)),
      );
    }
  });

  it("shows the current release of every instruction cover in both languages", () => {
    const covers = readdirSync(path.join(appRoot, "src/assets/home/docs")).filter((name) =>
      name.endsWith(".png"),
    );
    expect(covers.map((name) => name.replace(/_[^_]+_(ru|en)\.png$/u, "_$1")).sort()).toEqual(
      COVER_CODES.flatMap((code) => LOCALES.map((locale) => `${code}_${locale}`)).sort(),
    );
    for (const cover of covers) {
      const [code, release, locale] = cover.replace(/\.png$/u, "").split("_");
      if (code === undefined || release === undefined || locale === undefined) {
        throw new Error(`bad cover name ${cover}`);
      }
      expect(release, cover).toBe(publishedReleases(code, locale).at(-1));
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/landing exec vitest run test/home-assets.test.ts`
Expected: FAIL (ENOENT on `src/assets/home/labels/juices-box.png`).

- [ ] **Step 3: Copy the labels**

```bash
mkdir -p apps/landing/src/assets/home/labels
cp examples/labels/juices/box-100x150.png apps/landing/src/assets/home/labels/juices-box.png
cp examples/labels/cosmetics/box-100x150.png apps/landing/src/assets/home/labels/cosmetics-box.png
```

- [ ] **Step 4: Write the cover script**

Create `tools/production-browser/scripts/render-instruction-covers.mjs`:

```js
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

import { landingRoot } from "./film-render.mjs";

// Renders the first page of the newest published PDF of each instruction the home page shows,
// in both languages. Uses macOS `sips`; the PNGs are committed, so CI never renders PDFs.
const pdfRoot = path.join(landingRoot, "public/legal/files");
const outputRoot = path.join(landingRoot, "src/assets/home/docs");
const CODES = ["mkr-ins-01", "mkr-ins-02", "mkr-ins-09"];
const LOCALES = ["ru", "en"];

mkdirSync(outputRoot, { recursive: true });
for (const code of CODES) {
  for (const locale of LOCALES) {
    const prefix = `markiro_${code}_`;
    const suffix = `_${locale}.pdf`;
    const latest = readdirSync(pdfRoot)
      .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
      .sort()
      .at(-1);
    if (latest === undefined) throw new Error(`no published ${locale} PDF for ${code}`);
    const release = latest.slice(prefix.length, -suffix.length);
    for (const old of readdirSync(outputRoot).filter(
      (name) => name.startsWith(`${code}_`) && name.endsWith(`_${locale}.png`),
    )) {
      rmSync(path.join(outputRoot, old));
    }
    const target = path.join(outputRoot, `${code}_${release}_${locale}.png`);
    execFileSync(
      "sips",
      ["-s", "format", "png", "--resampleHeight", "1100", path.join(pdfRoot, latest), "--out", target],
      { stdio: "pipe" },
    );
    console.log(`rendered ${path.basename(target)}`);
  }
}
```

In `tools/production-browser/package.json` add next to `"render:home-images"`:

```json
    "render:instruction-covers": "node scripts/render-instruction-covers.mjs",
```

- [ ] **Step 5: Render the covers**

Run outside the sandbox (`sips` writes temporary files under `/var/folders`): `pnpm --dir tools/production-browser --ignore-workspace render:instruction-covers`
Expected: six `rendered mkr-ins-0N_<release>_<locale>.png` lines; `sips -g pixelWidth -g pixelHeight apps/landing/src/assets/home/docs/*.png` reports 777 × 1100 for each. Open one Russian and one English cover: a sharp title page in its language.

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/landing exec vitest run test/home-assets.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add apps/landing/src/assets/home/labels apps/landing/src/assets/home/docs apps/landing/test/home-assets.test.ts tools/production-browser/scripts/render-instruction-covers.mjs tools/production-browser/package.json
git commit -m "feat(landing): case labels and instruction covers for the home page" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The map hero

Replaces the photo hero with the plant map and switches the home page to the light theme. The old sections below the hero keep rendering (in their dark styles) until Tasks 9-11 replace them.

**Files:**

- Create: `apps/landing/src/content/home-images.ts`
- Create: `apps/landing/src/components/home/HomeMapHero.astro`
- Create: `apps/landing/src/scripts/home/map.ts`
- Test: `apps/landing/src/scripts/home/map.test.ts`
- Create: `apps/landing/src/styles/home.css`
- Modify: `apps/landing/src/components/HomePage.astro`
- Test: `apps/landing/test/rendered-page.test.ts`

**Interfaces:**

- Consumes: `projectHomeMap()` (Task 3); `copy.home.mapHero` (Task 2); `BaseLayout` prop `theme` (Task 1); `posterFor()` from `src/content/film-posters.ts`; `findFilmPage(locale).path` from `src/content/film.ts`; the images of Tasks 4-7.
- Produces, in `src/content/home-images.ts`: `type HomeScreenId`, `homeScreen(locale, id): ImageMetadata`, `SPOT_SCREENS: Record<PlantSpotId, HomeScreenId>`, `HOME_MAP_IMAGE`, `HOME_MAP_PHONE_IMAGE`, `HOME_FILM_PAGE_IMAGE`, `HOME_LABELS: { juices, cosmetics }`, `type HomeCoverCode`, `homeCover(locale, code): ImageMetadata`. In `src/scripts/home/map.ts`: `initHomeMap(root: Document): () => void`. In `home.css`: the shared home classes `.home-kicker`, `.home-caption`, `.home-list`, `.screen-frame` and the rule `.home .section-index`, used by Tasks 9-11.

- [ ] **Step 1: Write the failing page tests**

In `apps/landing/test/rendered-page.test.ts` delete four tests that describe the old hero and its consoles:

- "activates the shared dark design tokens" (the home page turns light; Task 1's test covers the dark topic pages),
- "describes the hero photograph for image search" (the photograph is gone),
- "keeps locale-specific time punctuation in the illustrative console" and "labels the illustrative station console so extracted text is not read as a fact" (the hero console goes now; the compact one in the production-cycle section goes with Task 9).

Keep "gives the above-the-fold factory image stable dimensions": the map still keeps `width`, `height` and `fetchpriority`. Add:

```ts
  it("renders the home page on the light theme", () => {
    for (const route of ["/", "/en/"] as const) {
      const home = documents.get(route);
      expect(home?.documentElement.getAttribute("data-theme"), route).toBe("light");
      expect(home?.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe(
        "#fafaf8",
      );
    }
  });

  it("renders the map hero with five hotspots and a card strip for phones", () => {
    const targets = [
      "#product-line",
      "#product-line",
      "#product-handheld",
      "#product-kiosk",
      "#product-office",
    ];
    for (const [route, heading, alt, labels] of [
      ["/", "Линия идёт.", "Макет завода", ["Линия", "Упаковка", "Склад", "Киоск", "Офис"]],
      [
        "/en/",
        "Keep the line moving.",
        "Scale model of a plant",
        ["Line", "Packing", "Warehouse", "Kiosk", "Office"],
      ],
    ] as const) {
      const hero = documents.get(route)?.querySelector("section#hero");
      expect(hero?.querySelector("h1")?.textContent, route).toContain(heading);
      const spots = [...(hero?.querySelectorAll("[data-map-spot]") ?? [])];
      expect(spots.map((spot) => spot.querySelector(".map-spot__label")?.textContent)).toEqual(
        labels,
      );
      expect(spots.map((spot) => spot.querySelector("a")?.getAttribute("href"))).toEqual(targets);
      for (const spot of spots) {
        const [, left, top] =
          /left: ([\d.]+)%; top: ([\d.]+)%/u.exec(spot.getAttribute("style") ?? "") ?? [];
        expect(Number(left)).toBeGreaterThan(42);
        expect(Number(top)).toBeGreaterThan(8);
        const tipId = spot.querySelector("a")?.getAttribute("aria-describedby") ?? "";
        expect(hero?.querySelector(`#${tipId}[role="tooltip"] img[alt]`), tipId).not.toBeNull();
      }
      expect(
        [...(hero?.querySelectorAll(".home-hero__strip a") ?? [])].map((link) =>
          link.getAttribute("href"),
        ),
      ).toEqual(targets);
      const image = hero?.querySelector("img[data-hero-image]");
      expect(image?.getAttribute("loading")).toBe("eager");
      expect(image?.getAttribute("fetchpriority")).toBe("high");
      expect(image?.getAttribute("alt")).toContain(alt);
      expect(hero?.querySelectorAll('picture source[media="(max-width: 1023px)"]')).toHaveLength(2);
      for (const other of hero?.querySelectorAll("img:not([data-hero-image])") ?? []) {
        expect(other.getAttribute("loading")).toBe("lazy");
      }
    }
  });
```

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/landing exec vitest run test/rendered-page.test.ts -t "light theme|map hero"`
Expected: FAIL.

- [ ] **Step 2: Write the failing script test**

Create `apps/landing/src/scripts/home/map.test.ts`:

```ts
// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import { initHomeMap } from "./map";

function renderMap(): HTMLElement[] {
  document.body.innerHTML = `
    <ul>
      <li data-map-spot><a href="#product-line" aria-describedby="tip-line">Линия</a><div role="tooltip" id="tip-line">Станция</div></li>
      <li data-map-spot><a href="#product-kiosk" aria-describedby="tip-kiosk">Киоск</a><div role="tooltip" id="tip-kiosk">Киоск</div></li>
    </ul>`;
  return [...document.querySelectorAll<HTMLElement>("[data-map-spot]")];
}

function pressEscape(): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("initHomeMap", () => {
  it("hides the focused hotspot's tooltip on Escape and brings it back when focus leaves", () => {
    const [line, kiosk] = renderMap();
    const cleanup = initHomeMap(document);
    line?.querySelector("a")?.focus();
    pressEscape();
    expect(line?.hasAttribute("data-dismissed")).toBe(true);
    expect(kiosk?.hasAttribute("data-dismissed")).toBe(false);
    line?.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    expect(line?.hasAttribute("data-dismissed")).toBe(false);
    cleanup();
  });

  it("brings a dismissed tooltip back when the pointer leaves", () => {
    const [line] = renderMap();
    const cleanup = initHomeMap(document);
    line?.querySelector("a")?.focus();
    pressEscape();
    line?.dispatchEvent(new Event("pointerleave"));
    expect(line?.hasAttribute("data-dismissed")).toBe(false);
    cleanup();
  });

  it("ignores other keys and stops listening after cleanup", () => {
    const [line] = renderMap();
    const cleanup = initHomeMap(document);
    line?.querySelector("a")?.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(line?.hasAttribute("data-dismissed")).toBe(false);
    cleanup();
    pressEscape();
    expect(line?.hasAttribute("data-dismissed")).toBe(false);
  });
});
```

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/landing exec vitest run src/scripts/home/map.test.ts`
Expected: FAIL (cannot resolve `./map`).

- [ ] **Step 3: Write the tooltip script**

Create `apps/landing/src/scripts/home/map.ts`:

```ts
/**
 * Map hotspots show their tooltip on hover and focus through CSS. Escape hides the tooltip the
 * visitor is on (WCAG 1.4.13); leaving the hotspot with the pointer or focus brings it back.
 */
export function initHomeMap(root: Document): () => void {
  const spots = [...root.querySelectorAll<HTMLElement>("[data-map-spot]")];
  const cleanups: (() => void)[] = [];

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    for (const spot of spots) {
      if (spot.matches(":hover") || spot.contains(root.activeElement)) {
        spot.setAttribute("data-dismissed", "");
      }
    }
  };
  root.addEventListener("keydown", onKeyDown);
  cleanups.push(() => root.removeEventListener("keydown", onKeyDown));

  for (const spot of spots) {
    const reset = (): void => spot.removeAttribute("data-dismissed");
    spot.addEventListener("pointerleave", reset);
    spot.addEventListener("focusout", reset);
    cleanups.push(() => {
      spot.removeEventListener("pointerleave", reset);
      spot.removeEventListener("focusout", reset);
    });
  }

  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
```

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/landing exec vitest run src/scripts/home/map.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 4: Write the image registry**

Create `apps/landing/src/content/home-images.ts`:

```ts
import type { ImageMetadata } from "astro";

import filmPage from "../assets/home/film-page.jpg";
import cosmeticsLabel from "../assets/home/labels/cosmetics-box.png";
import juicesLabel from "../assets/home/labels/juices-box.png";
import mapPhone from "../assets/home/map-phone.jpg";
import mapWide from "../assets/home/map-wide.jpg";
import cabinetChzEn from "../assets/home/screens/en/cabinet-chz.png";
import cabinetShiftsEn from "../assets/home/screens/en/cabinet-shifts.png";
import stationAggregationEn from "../assets/home/screens/en/station-aggregation.png";
import stationBoxEn from "../assets/home/screens/en/station-box.png";
import stationConflictsEn from "../assets/home/screens/en/station-conflicts.png";
import stationOfflineEn from "../assets/home/screens/en/station-offline.png";
import cabinetChzRu from "../assets/home/screens/ru/cabinet-chz.png";
import cabinetShiftsRu from "../assets/home/screens/ru/cabinet-shifts.png";
import handheld from "../assets/home/screens/ru/handheld.png";
import kiosk from "../assets/home/screens/ru/kiosk.png";
import stationAggregationRu from "../assets/home/screens/ru/station-aggregation.png";
import stationBoxRu from "../assets/home/screens/ru/station-box.png";
import stationConflictsRu from "../assets/home/screens/ru/station-conflicts.png";
import stationOfflineRu from "../assets/home/screens/ru/station-offline.png";
import type { PlantSpotId } from "../scripts/film/world/plant";
import type { Locale } from "./pages";

export type HomeScreenId =
  | "station-aggregation"
  | "station-box"
  | "station-offline"
  | "station-conflicts"
  | "handheld"
  | "kiosk"
  | "cabinet-shifts"
  | "cabinet-chz";

// The kiosk and the handheld ship a Russian interface, so both locales show the Russian frames.
const SCREENS: Readonly<Record<Locale, Readonly<Record<HomeScreenId, ImageMetadata>>>> = {
  ru: {
    "station-aggregation": stationAggregationRu,
    "station-box": stationBoxRu,
    "station-offline": stationOfflineRu,
    "station-conflicts": stationConflictsRu,
    handheld,
    kiosk,
    "cabinet-shifts": cabinetShiftsRu,
    "cabinet-chz": cabinetChzRu,
  },
  en: {
    "station-aggregation": stationAggregationEn,
    "station-box": stationBoxEn,
    "station-offline": stationOfflineEn,
    "station-conflicts": stationConflictsEn,
    handheld,
    kiosk,
    "cabinet-shifts": cabinetShiftsEn,
    "cabinet-chz": cabinetChzEn,
  },
};

export function homeScreen(locale: Locale, id: HomeScreenId): ImageMetadata {
  return SCREENS[locale][id];
}

/** The screen each map hotspot previews in its tooltip. */
export const SPOT_SCREENS: Readonly<Record<PlantSpotId, HomeScreenId>> = {
  line: "station-aggregation",
  packing: "station-box",
  warehouse: "handheld",
  kiosk: "kiosk",
  office: "cabinet-shifts",
};

export const HOME_MAP_IMAGE = mapWide;
export const HOME_MAP_PHONE_IMAGE = mapPhone;
export const HOME_FILM_PAGE_IMAGE = filmPage;
export const HOME_LABELS = { juices: juicesLabel, cosmetics: cosmeticsLabel } as const;

export type HomeCoverCode = "mkr-ins-01" | "mkr-ins-02" | "mkr-ins-09";

const COVERS = import.meta.glob<{ default: ImageMetadata }>("../assets/home/docs/*.png", {
  eager: true,
});

/** The first page of the newest published release (the file name carries the release). */
export function homeCover(locale: Locale, code: HomeCoverCode): ImageMetadata {
  const entry = Object.entries(COVERS).find(
    ([file]) => file.includes(`/${code}_`) && file.endsWith(`_${locale}.png`),
  );
  if (entry === undefined) throw new Error(`missing home cover ${code} (${locale})`);
  return entry[1].default;
}
```

- [ ] **Step 5: Write the hero component**

Create `apps/landing/src/components/home/HomeMapHero.astro`:

```astro
---
import { Picture, getImage } from "astro:assets";

import { findFilmPage } from "../../content/film";
import { posterFor } from "../../content/film-posters";
import {
  HOME_MAP_IMAGE,
  HOME_MAP_PHONE_IMAGE,
  SPOT_SCREENS,
  homeScreen,
} from "../../content/home-images";
import type { Locale } from "../../content/pages";
import { getUiCopy } from "../../content/ui";
import type { PublicPhone } from "../../lib/site-config";
import { projectHomeMap } from "../../scripts/film/world/home-map";

interface Props {
  locale: Locale;
  phone: PublicPhone | null;
}

const { locale, phone } = Astro.props;
const ui = getUiCopy(locale);
const copy = ui.home.mapHero;
const points = new Map(projectHomeMap().map((point) => [point.id, point]));
// Phones get the crop around the hall; both stills share the stage's 16:10 shape.
const [wideAvif, wideWebp, phoneAvif, phoneWebp] = await Promise.all([
  getImage({ src: HOME_MAP_IMAGE, widths: [1440, 2160, 2880], format: "avif" }),
  getImage({ src: HOME_MAP_IMAGE, widths: [1440, 2160, 2880], format: "webp" }),
  getImage({ src: HOME_MAP_PHONE_IMAGE, widths: [780, 1170, 1500], format: "avif" }),
  getImage({ src: HOME_MAP_PHONE_IMAGE, widths: [780, 1170, 1500], format: "webp" }),
]);
---

<section class="home-hero" id="hero" aria-labelledby="hero-title">
  <div class="home-hero__stage">
    <picture>
      <source media="(max-width: 1023px)" type="image/avif" srcset={phoneAvif.srcSet.attribute} sizes="100vw" />
      <source media="(max-width: 1023px)" type="image/webp" srcset={phoneWebp.srcSet.attribute} sizes="100vw" />
      <source type="image/avif" srcset={wideAvif.srcSet.attribute} sizes="100vw" />
      <source type="image/webp" srcset={wideWebp.srcSet.attribute} sizes="100vw" />
      <img
        class="home-hero__image"
        src={wideWebp.src}
        width={HOME_MAP_IMAGE.width}
        height={HOME_MAP_IMAGE.height}
        alt={copy.imageAlt}
        loading="eager"
        fetchpriority="high"
        decoding="sync"
        data-hero-image
      />
    </picture>
    <ul class="home-hero__spots" aria-label={copy.stripLabel}>
      {copy.spots.map((spot) => {
        const point = points.get(spot.id);
        if (point === undefined) throw new Error(`no map point for ${spot.id}`);
        return (
          <li
            class="map-spot"
            data-map-spot
            data-tip={point.y < 0.55 ? "below" : "above"}
            style={`left: ${(point.x * 100).toFixed(2)}%; top: ${(point.y * 100).toFixed(2)}%;`}
          >
            <a class="map-spot__link" href={spot.target} aria-describedby={`map-tip-${spot.id}`}>
              <span class="map-spot__dot" aria-hidden="true"></span>
              <span class="map-spot__label">{spot.label}</span>
            </a>
            <div class="map-spot__tip" role="tooltip" id={`map-tip-${spot.id}`}>
              <p class="map-spot__title">{spot.label}</p>
              <p class="map-spot__line">{spot.line}</p>
              <Picture
                src={homeScreen(locale, SPOT_SCREENS[spot.id])}
                alt={spot.screenAlt}
                widths={[480, 720]}
                formats={["avif", "webp"]}
                sizes="15.25rem"
                loading="lazy"
              />
            </div>
          </li>
        );
      })}
    </ul>
  </div>

  <div class="container home-hero__content">
    <p class="section-index">{copy.kicker}</p>
    <h1 id="hero-title">{copy.heading[0]}<br />{copy.heading[1]}</h1>
    <p class="home-hero__lead">{copy.lead}</p>
    <div class="home-hero__actions">
      <a class="button" href="#demo" data-analytics="landing_demo_click" data-placement="hero">
        {ui.common.requestDemoShort} <span aria-hidden="true">→</span>
      </a>
      {phone && (
        <a class="home-hero__phone" href={phone.href} data-analytics="landing_phone_click" data-placement="hero">
          {phone.display}
        </a>
      )}
      <a class="home-hero__film-link" href={findFilmPage(locale).path}>
        {copy.filmLink} <span aria-hidden="true">→</span>
      </a>
    </div>
    <p class="home-hero__hint">{copy.hint}</p>
  </div>

  <nav class="home-hero__strip" aria-label={copy.stripLabel}>
    {copy.spots.map((spot) => (
      <a class="home-hero__stop" href={spot.target}>
        <Picture
          src={posterFor(spot.id).wide}
          alt=""
          widths={[264, 396]}
          formats={["avif", "webp"]}
          sizes="8.25rem"
          loading="lazy"
        />
        <span>{spot.label} <span aria-hidden="true">→</span></span>
      </a>
    ))}
  </nav>
</section>
```

The hotspot ids are a subset of the film's chapter ids, so `posterFor(spot.id)` type-checks without a mapping.

- [ ] **Step 6: Write the home styles and the hero rules**

Create `apps/landing/src/styles/home.css`:

```css
/* Home page (`/`, `/en/`). Light tokens from @markiro/ui; dark parts set data-theme="dark". */

.home .section-index {
  color: var(--fg-3);
  font: 500 0.8125rem / 1.3 var(--font-mono);
}

.home-kicker {
  margin: 0;
  color: var(--fg-3);
  font: 500 0.75rem / 1.3 var(--font-mono);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.home-caption {
  color: var(--fg-3);
  font: 500 0.6875rem / 1.35 var(--font-mono);
  letter-spacing: 0.08em;
}

.home-list {
  display: grid;
  gap: 0.625rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.home-list li {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  font: 400 0.9375rem / 1.4 var(--font-ui);
}

.home-list li::before {
  flex: none;
  width: 6px;
  height: 6px;
  background: var(--accent);
  content: "";
}

/* A real screen: white frame, soft shadow, mono caption under it (right-aligned by default). */
.screen-frame {
  display: grid;
  gap: 0.75rem;
  margin: 0;
  justify-items: end;
}

.screen-frame > picture {
  justify-self: stretch;
}

.screen-frame img {
  display: block;
  width: 100%;
  height: auto;
  border: 6px solid var(--surface-card);
  border-radius: 6px;
  box-shadow: 0 1.125rem 2.75rem rgb(23 22 26 / 19%);
}

/* Hero: the plant map. The stage keeps the stills' 16:10 shape so the dots stay on their places. */

.home-hero {
  position: relative;
  background: var(--surface-page);
}

.home-hero__stage {
  position: relative;
  aspect-ratio: 16 / 10;
}

.home-hero__stage picture {
  position: absolute;
  inset: 0;
}

.home-hero__image {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

/* The header sits over the still; a paper fade keeps its links readable. */
.home-hero__stage::before {
  position: absolute;
  z-index: 1;
  top: 0;
  right: 0;
  left: 0;
  height: 6.5rem;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--surface-page) 88%, transparent) 40%,
    transparent
  );
  content: "";
  pointer-events: none;
}

/* The left of the still fades into the page under the text. */
.home-hero__stage::after {
  position: absolute;
  z-index: 1;
  inset: 0;
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--surface-page) 94%, transparent) 0%,
    color-mix(in srgb, var(--surface-page) 80%, transparent) 30%,
    transparent 52%
  );
  content: "";
  pointer-events: none;
}

.home-hero__content {
  position: absolute;
  z-index: 2;
  top: clamp(6.5rem, 10.5vw, 9.5rem);
  left: 50%;
  transform: translateX(-50%);
  pointer-events: none;
}

.home-hero__content > * {
  pointer-events: auto;
}

.home-hero h1 {
  max-width: 38rem;
  margin: 0;
  font: var(--landing-display-xl);
  letter-spacing: -0.055em;
}

.home-hero__lead {
  max-width: 32.5rem;
  margin: var(--sp-6) 0 0;
  color: var(--fg-2);
  font: var(--landing-lead);
}

.home-hero__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-5) var(--sp-7);
  margin-top: var(--sp-7);
}

.home-hero__phone,
.home-hero__film-link {
  color: var(--fg-1);
  font: 600 0.9375rem / 1 var(--font-ui);
  text-underline-offset: 0.3em;
}

.home-hero__phone {
  font-family: var(--font-mono);
}

.home-hero__hint {
  margin: 2.5rem 0 0;
  color: var(--fg-3);
  font: 500 0.75rem / 1.4 var(--font-mono);
}

/* Only the dots take the pointer; the list lets clicks through to the text under it. */
.home-hero__spots {
  position: absolute;
  z-index: 3;
  inset: 0;
  margin: 0;
  padding: 0;
  list-style: none;
  pointer-events: none;
}

.map-spot {
  position: absolute;
  transform: translate(-0.375rem, -50%);
  pointer-events: auto;
}

.map-spot__link {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--fg-1);
  text-decoration: none;
}

.map-spot__link:focus-visible {
  border-radius: var(--r-1);
  outline: var(--focus-ring-w) solid var(--focus-ring);
  outline-offset: 0.25rem;
}

.map-spot__dot {
  position: relative;
  flex: none;
  width: 0.75rem;
  height: 0.75rem;
  border: 2px solid #fff;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 0.5rem color-mix(in srgb, var(--accent) 20%, transparent);
}

.map-spot__label {
  padding: 0.375rem 0.625rem;
  border: 1px solid var(--line);
  border-radius: var(--r-1);
  background: color-mix(in srgb, var(--surface-card) 94%, transparent);
  font: 600 0.8125rem / 1 var(--font-ui);
  white-space: nowrap;
}

.map-spot__tip {
  position: absolute;
  z-index: 4;
  left: 50%;
  width: 17rem;
  padding: 0.875rem;
  visibility: hidden;
  opacity: 0;
  transform: translateX(-50%);
  border: 1px solid var(--line);
  border-radius: var(--r-2);
  background: var(--surface-card);
  box-shadow: 0 1rem 2.5rem rgb(23 22 26 / 18%);
  transition:
    opacity 140ms ease,
    visibility 140ms;
}

.map-spot[data-tip="above"] .map-spot__tip {
  bottom: calc(100% + 0.75rem);
}

.map-spot[data-tip="below"] .map-spot__tip {
  top: calc(100% + 0.75rem);
}

.map-spot:hover .map-spot__tip,
.map-spot:focus-within .map-spot__tip {
  visibility: visible;
  opacity: 1;
}

.map-spot[data-dismissed] .map-spot__tip {
  visibility: hidden;
  opacity: 0;
}

.map-spot__title {
  margin: 0;
  font: 700 0.9375rem / 1.2 var(--font-ui);
}

.map-spot__line {
  margin: 0.375rem 0 0.625rem;
  color: var(--fg-2);
  font: 400 0.8125rem / 1.45 var(--font-ui);
}

.map-spot__tip img {
  display: block;
  width: 100%;
  height: auto;
  border-radius: var(--r-1);
}

@media (prefers-reduced-motion: no-preference) {
  .map-spot__dot::after {
    position: absolute;
    inset: -0.625rem;
    border-radius: 50%;
    background: color-mix(in srgb, var(--accent) 30%, transparent);
    content: "";
    animation: map-spot-pulse 2.4s var(--landing-ease) infinite;
  }
}

@keyframes map-spot-pulse {
  from {
    opacity: 0.9;
    transform: scale(0.6);
  }

  to {
    opacity: 0;
    transform: scale(1.8);
  }
}

.home-hero__strip {
  display: none;
}

/* Tablets and phones: the crop sits under the header, the text follows, then the card strip. */
@media (max-width: 1023px) {
  .home-hero__stage {
    margin-top: 5rem;
  }

  .home-hero__stage::before,
  .home-hero__stage::after,
  .home-hero__spots,
  .home-hero__hint {
    display: none;
  }

  .home-hero__content {
    position: static;
    padding-block: var(--sp-6) var(--sp-5);
    transform: none;
  }

  .home-hero h1 {
    font-size: clamp(2.25rem, 8vw, 3rem);
  }

  .home-hero__strip {
    display: flex;
    gap: var(--sp-3);
    padding: 0 3rem var(--sp-8);
    overflow-x: auto;
    scroll-snap-type: x mandatory;
  }

  .home-hero__stop {
    display: grid;
    flex: 0 0 8.25rem;
    gap: var(--sp-2);
    color: var(--fg-1);
    font: 600 0.8125rem / 1.2 var(--font-ui);
    text-decoration: none;
    scroll-snap-align: start;
  }

  .home-hero__stop img {
    display: block;
    width: 100%;
    height: auto;
    aspect-ratio: 16 / 10;
    object-fit: cover;
    border-radius: var(--r-1);
  }
}

@media (max-width: 767px) {
  .home-hero__stage {
    margin-top: 4.5rem;
  }

  .home-hero__actions .button {
    width: 100%;
  }

  .home-hero__strip {
    padding-inline: 1rem;
  }
}
```

Projected at film time 0.8 the dots sit at x 0.59-0.75 and y 0.32-0.63 of the still (line 0.587 / 0.487, packing 0.677 / 0.433, warehouse 0.742 / 0.466, kiosk 0.593 / 0.625, office 0.752 / 0.316). The text column ends left of x 0.56 from 1024 px up, and every tooltip except the kiosk's opens downwards so none runs under the header.

- [ ] **Step 7: Put the hero on the page**

In `apps/landing/src/components/HomePage.astro`:

1. Remove the imports of `Picture` (`astro:assets`), `factoryImage` and `LineConsole`; add `import HomeMapHero from "./home/HomeMapHero.astro";` and, after the `BaseLayout` import, `import "../styles/home.css";`.
2. Change `<BaseLayout metadata={page} graph={buildPageGraph(page)}>` to `<BaseLayout metadata={page} graph={buildPageGraph(page)} theme="light">`.
3. Change `<main id="main">` to `<main id="main" class="home">`.
4. Replace the whole `<section class="hero" id="hero" …>…</section>` element with `<HomeMapHero locale={page.locale} phone={siteConfig.phone} />`. The continuity section below it still uses `copy`; leave it.
5. In the `<script>` block add `import { initHomeMap } from "../scripts/home/map";` and call `initHomeMap(document);` after `initLanding(…)`.

- [ ] **Step 8: Run the tests**

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/landing exec vitest run test/rendered-page.test.ts src/scripts/home/map.test.ts src/scripts/film/world/home-map.test.ts`
Expected: PASS, including "renders the approved semantic section hierarchy" (the new hero keeps `section#hero[aria-labelledby]`), "gives the above-the-fold factory image stable dimensions" and "preloads the above-the-fold font subsets that the stylesheet actually uses". The last one reads the first `<link rel="stylesheet">`; if `home.css` now comes out as a separate first stylesheet and the test fails, make the test look for the preloaded font names in every stylesheet the page links, without loosening its other assertions.

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/landing typecheck && pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/landing lint`
Expected: no errors.

- [ ] **Step 9: Look at the hero**

Serve the built site outside the sandbox (`node tools/production-browser/scripts/serve-landing.mjs`, port 5473) and take screenshots of `/` at 1440 × 900 and 390 × 844, for example with a one-off Playwright script under `$TMPDIR`. Compare with the pen.dev frames `HP-H5 · Hero «Карта» · 1440×900` and `HM · Главная · телефон · hero с лентой · 390×844`: the dots sit on the conveyor, the packing table, the pallet, the kiosk and the office; hovering a dot shows its screen; at 390 px the crop shows the hall and the card strip scrolls sideways under the text. Stop the server afterwards.

- [ ] **Step 10: Commit**

```bash
git add apps/landing/src/content/home-images.ts apps/landing/src/components/home/HomeMapHero.astro apps/landing/src/scripts/home apps/landing/src/styles/home.css apps/landing/src/components/HomePage.astro apps/landing/test/rendered-page.test.ts
git commit -m "feat(landing): the plant map hero on a light home page" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Product section with real screens

**Files:**

- Create: `apps/landing/src/components/home/ScreenFrame.astro`
- Create: `apps/landing/src/components/home/HandheldFrame.astro`
- Create: `apps/landing/src/components/home/HomeProduct.astro`
- Modify: `apps/landing/src/styles/home.css` (append)
- Modify: `apps/landing/src/components/HomePage.astro`
- Test: `apps/landing/test/rendered-page.test.ts`

**Interfaces:**

- Consumes: `homeScreen()`, `HomeScreenId` (Task 8); `copy.home.productSection` (Task 2); `.home-kicker`, `.home-caption`, `.home-list`, `.screen-frame` (Task 8).
- Produces: `ScreenFrame` props `{ image: ImageMetadata; alt: string; caption: string; widths: number[]; sizes: string }` (Tasks 10-11 use it); anchors `#product`, `#product-line`, `#product-handheld`, `#product-office`, `#product-kiosk`, `#product-integrations`.

- [ ] **Step 1: Write the failing test**

Add to `apps/landing/test/rendered-page.test.ts`:

```ts
  it("shows every product part on a framed screen and links it to its page", () => {
    for (const [route, links] of [
      [
        "/",
        [
          "/markirovka-chestny-znak/",
          "/kak-rabotaet/#warehouse",
          "/instruktsii/",
          "/kiosk-samovydachi/",
          "/integratsiya-1c/",
        ],
      ],
      [
        "/en/",
        [
          "/en/chestny-znak-serialization/",
          "/en/how-it-works/#warehouse",
          "/en/instructions/",
          "/en/self-service-pickup-kiosk/",
          "/en/1c-integration/",
        ],
      ],
    ] as const) {
      const section = documents.get(route)?.querySelector("section#product");
      const parts = [...(section?.querySelectorAll("article[id^='product-']") ?? [])];
      expect(
        parts.map((part) => part.id),
        route,
      ).toEqual([
        "product-line",
        "product-handheld",
        "product-office",
        "product-kiosk",
        "product-integrations",
      ]);
      expect(parts.map((part) => part.querySelector("a.text-link")?.getAttribute("href"))).toEqual(
        links,
      );
      expect(section?.querySelectorAll("figure.screen-frame img[alt]")).toHaveLength(4);
      expect(section?.querySelectorAll("figure.handheld-frame img[alt]")).toHaveLength(1);
      for (const image of section?.querySelectorAll("img") ?? []) {
        expect(image.getAttribute("loading")).toBe("lazy");
      }
      expect(section?.textContent ?? "").not.toMatch(/НАСТОЯЩИЙ ЭКРАН|REAL SCREEN/u);
    }
  });
```

In the test "renders the approved semantic section hierarchy" replace the list of section ids with:

```ts
    for (const sectionId of ["hero", "continuity", "product", "traceability", "implementation", "demo"]) {
```

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/landing exec vitest run test/rendered-page.test.ts -t "product part"`
Expected: FAIL (the old product section has no `article[id^='product-']`).

- [ ] **Step 2: Write the frames**

Create `apps/landing/src/components/home/ScreenFrame.astro`:

```astro
---
import type { ImageMetadata } from "astro";
import { Picture } from "astro:assets";

interface Props {
  image: ImageMetadata;
  alt: string;
  caption: string;
  widths: number[];
  sizes: string;
}

const { image, alt, caption, widths, sizes } = Astro.props;
---

<figure class="screen-frame">
  <Picture src={image} alt={alt} widths={widths} formats={["avif", "webp"]} sizes={sizes} loading="lazy" />
  <figcaption class="home-caption">{caption}</figcaption>
</figure>
```

Create `apps/landing/src/components/home/HandheldFrame.astro`:

```astro
---
import type { ImageMetadata } from "astro";
import { Picture } from "astro:assets";

interface Props {
  image: ImageMetadata;
  alt: string;
  caption: string;
}

const { image, alt, caption } = Astro.props;
---

<figure class="handheld-frame">
  <div class="handheld-frame__body">
    <span class="handheld-frame__scanner" aria-hidden="true"></span>
    <span class="handheld-frame__speaker" aria-hidden="true"></span>
    <Picture src={image} alt={alt} widths={[296, 592, 888]} formats={["avif", "webp"]} sizes="18.5rem" loading="lazy" />
  </div>
  <figcaption class="home-caption">{caption}</figcaption>
</figure>
```

- [ ] **Step 3: Write the section**

Create `apps/landing/src/components/home/HomeProduct.astro`:

```astro
---
import { findFilmPage } from "../../content/film";
import { homeScreen, type HomeScreenId } from "../../content/home-images";
import { hubPath } from "../../content/hubs";
import type { Locale } from "../../content/pages";
import { getUiCopy } from "../../content/ui";
import HandheldFrame from "./HandheldFrame.astro";
import ScreenFrame from "./ScreenFrame.astro";

interface Props {
  locale: Locale;
}

type ProductPartId = "line" | "handheld" | "office" | "kiosk" | "integrations";

const { locale } = Astro.props;
const copy = getUiCopy(locale).home.productSection;
const ru = locale === "ru";
const LINKS: Readonly<Record<ProductPartId, string>> = {
  line: ru ? "/markirovka-chestny-znak/" : "/en/chestny-znak-serialization/",
  handheld: `${findFilmPage(locale).path}#warehouse`,
  office: hubPath(locale, "instructions"),
  kiosk: ru ? "/kiosk-samovydachi/" : "/en/self-service-pickup-kiosk/",
  integrations: ru ? "/integratsiya-1c/" : "/en/1c-integration/",
};
const SCREENS: Readonly<Record<ProductPartId, HomeScreenId>> = {
  line: "station-box",
  handheld: "handheld",
  office: "cabinet-shifts",
  kiosk: "kiosk",
  integrations: "cabinet-chz",
};
---

<section class="section home-product" id="product" aria-labelledby="product-title">
  <div class="container">
    <p class="section-index">{copy.kicker}</p>
    <h2 id="product-title" class="display-heading display-heading--sentence">{copy.heading}</h2>

    {copy.rows.map((row, index) => (
      <article
        class:list={["home-product__row", { "home-product__row--reverse": index % 2 === 1 }]}
        id={`product-${row.id}`}
        aria-labelledby={`product-${row.id}-title`}
      >
        <div class="home-product__text">
          <p class="home-kicker">{row.kicker}</p>
          <h3 id={`product-${row.id}-title`}>{row.title}</h3>
          <p class="home-product__body">{row.text}</p>
          <ul class="home-list">{row.bullets.map((bullet) => <li>{bullet}</li>)}</ul>
          <a class="text-link" href={LINKS[row.id]}>{row.link} <span aria-hidden="true">→</span></a>
        </div>
        {row.id === "handheld" ? (
          <HandheldFrame image={homeScreen(locale, SCREENS[row.id])} alt={row.screenAlt} caption={row.caption} />
        ) : (
          <ScreenFrame
            image={homeScreen(locale, SCREENS[row.id])}
            alt={row.screenAlt}
            caption={row.caption}
            widths={[640, 960, 1520]}
            sizes="(max-width: 1023px) 100vw, 47.5rem"
          />
        )}
      </article>
    ))}

    <div class="home-product__cards">
      {copy.cards.map((card) => (
        <article class="home-product__card" id={`product-${card.id}`} aria-labelledby={`product-${card.id}-title`}>
          <p class="home-kicker">{card.kicker}</p>
          <h3 id={`product-${card.id}-title`}>{card.title}</h3>
          <p class="home-product__body">{card.text}</p>
          <ScreenFrame
            image={homeScreen(locale, SCREENS[card.id])}
            alt={card.screenAlt}
            caption={card.caption}
            widths={[480, 720, 1200]}
            sizes="(max-width: 1023px) 100vw, 36.75rem"
          />
          <a class="text-link" href={LINKS[card.id]}>{card.link} <span aria-hidden="true">→</span></a>
        </article>
      ))}
    </div>
  </div>
</section>
```

- [ ] **Step 4: Write the section styles**

Append to `apps/landing/src/styles/home.css` (sizes follow the pen.dev frame `HP · Главная · направление A · полная страница · 1440`: 7rem vertical rhythm, 27.5rem text column, 34 px row titles, 26 px card titles):

```css
/* 01 Product */

.home-product {
  padding-block: 7rem;
}

.home-product__row {
  display: grid;
  grid-template-columns: minmax(0, 27.5rem) minmax(0, 1fr);
  align-items: center;
  gap: 4.5rem;
  margin-top: 7rem;
}

.home-product__row--reverse {
  grid-template-columns: minmax(0, 1fr) minmax(0, 27.5rem);
}

.home-product__row--reverse > .home-product__text {
  order: 2;
}

.home-product__text,
.home-product__card {
  display: grid;
  align-content: start;
  justify-items: start;
  gap: 1.125rem;
}

.home-product__text h3,
.home-product__card h3 {
  margin: 0;
  font: 700 clamp(1.625rem, 2.4vw, 2.125rem) / 1.1 var(--font-ui);
  letter-spacing: -0.03em;
}

.home-product__body {
  margin: 0;
  color: var(--fg-2);
  font: 400 1.0625rem / 1.55 var(--font-ui);
}

.home-product__cards {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: start;
  gap: 1.5rem;
  margin-top: 7rem;
}

.home-product__card {
  padding: 2rem;
  border-radius: 6px;
  background: var(--surface-panel);
}

.home-product__card h3 {
  font-size: 1.625rem;
}

.home-product__card .home-product__body {
  font-size: 1rem;
}

.home-product__card .screen-frame {
  width: 100%;
  justify-items: start;
}

/* The handheld is drawn as a device: graphite body, red scanner window, side scan triggers. */
.handheld-frame {
  display: grid;
  gap: 0.75rem;
  margin: 0;
  justify-items: center;
}

.handheld-frame__body {
  position: relative;
  width: 20.75rem;
  padding: 2.75rem 1.125rem;
  border: 1px solid #44464e;
  border-radius: 2.625rem;
  background: linear-gradient(180deg, #2c2d33, #1e1f24);
  box-shadow: 0 1.625rem 3.125rem rgb(23 22 26 / 27%);
}

.handheld-frame__body::before,
.handheld-frame__body::after {
  position: absolute;
  top: 14.75rem;
  width: 0.5rem;
  height: 4.75rem;
  border-radius: 3px;
  background: #3b3d44;
  content: "";
}

.handheld-frame__body::before {
  left: -0.5rem;
}

.handheld-frame__body::after {
  right: -0.5rem;
}

.handheld-frame__scanner {
  position: absolute;
  top: 0;
  left: 50%;
  width: 6.25rem;
  height: 0.5625rem;
  transform: translateX(-50%);
  border-radius: 0 0 5px 5px;
  background: #6b2323;
}

.handheld-frame__speaker {
  position: absolute;
  top: 1.375rem;
  left: 50%;
  width: 3.5rem;
  height: 0.3125rem;
  transform: translateX(-50%);
  border-radius: 3px;
  background: #121317;
}

.handheld-frame img {
  display: block;
  width: 100%;
  height: auto;
  border: 2px solid #0e0f12;
  border-radius: 0.75rem;
}

@media (max-width: 1023px) {
  .home-product__row,
  .home-product__row--reverse {
    grid-template-columns: minmax(0, 1fr);
    gap: 2.5rem;
    margin-top: 4.5rem;
  }

  .home-product__row--reverse > .home-product__text {
    order: 0;
  }

  .home-product__cards {
    grid-template-columns: minmax(0, 1fr);
    margin-top: 4.5rem;
  }
}

@media (max-width: 767px) {
  .home-product {
    padding-block: 4.5rem;
  }

  .home-product__card {
    padding: 1.25rem;
  }

  .handheld-frame__body {
    width: 16.5rem;
    padding: 2.25rem 0.875rem;
    border-radius: 2.125rem;
  }

  .handheld-frame__body::before,
  .handheld-frame__body::after {
    top: 11.75rem;
  }
}
```

- [ ] **Step 5: Put the section on the page**

In `apps/landing/src/components/HomePage.astro` remove the imports and elements of `ProductionCycle`, `ProductModes` and `PlatformModules`, add `import HomeProduct from "./home/HomeProduct.astro";` and place `<HomeProduct locale={page.locale} />` right after `<HomeMapHero … />`.

- [ ] **Step 6: Run the tests**

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/landing exec vitest run test/rendered-page.test.ts`
Expected: PASS.

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/landing typecheck && pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/landing lint`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/landing/src/components/home apps/landing/src/styles/home.css apps/landing/src/components/HomePage.astro apps/landing/test/rendered-page.test.ts
git commit -m "feat(landing): product section with framed real screens" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 10: Offline, traceability and the film block

**Files:**

- Create: `apps/landing/src/components/home/HomeOffline.astro`
- Create: `apps/landing/src/components/home/HomeTraceability.astro`
- Create: `apps/landing/src/components/home/HomeFilmBlock.astro`
- Modify: `apps/landing/src/styles/home.css` (append)
- Modify: `apps/landing/src/components/HomePage.astro`
- Test: `apps/landing/test/rendered-page.test.ts`

**Interfaces:**

- Consumes: `ScreenFrame` (Task 9); `homeScreen()`, `HOME_FILM_PAGE_IMAGE` (Task 8); `posterFor("offline").wide` from `src/content/film-posters.ts`; `findFilmPage(locale).path`; `copy.home.offline`, `copy.home.traceability`, `copy.home.filmBlock` (Task 2).
- Produces: `section#offline` with `data-theme="dark"`, `section#traceability`, `section#film` with a `data-theme="dark"` panel; the rules `.home [data-theme="dark"]` (text colour, colour scheme and button hover of dark parts on the light page), which Task 11's demo section relies on.

- [ ] **Step 1: Write the failing test**

Add to `apps/landing/test/rendered-page.test.ts`:

```ts
  it("renders the offline, traceability and film sections", () => {
    for (const [route, filmPath] of [
      ["/", "/kak-rabotaet/"],
      ["/en/", "/en/how-it-works/"],
    ] as const) {
      const page = documents.get(route);
      const offline = page?.querySelector("section#offline");
      expect(offline?.getAttribute("data-theme"), route).toBe("dark");
      expect(offline?.querySelectorAll(".home-offline__points li")).toHaveLength(3);
      expect(offline?.querySelectorAll("img[alt]")).toHaveLength(2);
      expect(
        page?.querySelector("section#traceability figure.screen-frame img[alt]"),
      ).not.toBeNull();
      const panel = page?.querySelector("section#film [data-theme='dark']");
      expect(panel?.querySelector("a.button")?.getAttribute("href")).toBe(filmPath);
      expect(panel?.querySelector("img[alt]")).not.toBeNull();
    }
  });
```

Delete the test "does not expose a fake retry control in the illustrative event log" (the event log leaves the page with this task). In "renders the approved semantic section hierarchy" replace the list of section ids with:

```ts
    for (const sectionId of [
      "hero",
      "product",
      "offline",
      "traceability",
      "film",
      "implementation",
      "demo",
    ]) {
```

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/landing exec vitest run test/rendered-page.test.ts -t "offline, traceability|section hierarchy"`
Expected: FAIL.

- [ ] **Step 2: Write the offline section**

Create `apps/landing/src/components/home/HomeOffline.astro`:

```astro
---
import { Picture } from "astro:assets";

import { posterFor } from "../../content/film-posters";
import { homeScreen } from "../../content/home-images";
import type { Locale } from "../../content/pages";
import { getUiCopy } from "../../content/ui";
import ScreenFrame from "./ScreenFrame.astro";

interface Props {
  locale: Locale;
}

const { locale } = Astro.props;
const copy = getUiCopy(locale).home.offline;
---

<section class="section home-offline" id="offline" data-theme="dark" aria-labelledby="offline-title">
  <div class="container home-offline__grid">
    <div>
      <p class="section-index">{copy.kicker}</p>
      <h2 id="offline-title" class="display-heading display-heading--sentence">
        {copy.heading[0]}<br />{copy.heading[1]}
      </h2>
      <p class="section-lead">{copy.lead}</p>
      <ul class="home-offline__points">
        {copy.points.map(([title, text], index) => (
          <li>
            <span class="home-offline__number" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
            <div>
              <h3>{title}</h3>
              <p>{text}</p>
            </div>
          </li>
        ))}
      </ul>
    </div>
    <div class="home-offline__visual">
      <Picture
        src={posterFor("offline").wide}
        alt={copy.imageAlt}
        widths={[720, 1080, 1440]}
        formats={["avif", "webp"]}
        sizes="(max-width: 1023px) 100vw, 42.5rem"
        loading="lazy"
        class="home-offline__scene"
      />
      <ScreenFrame
        image={homeScreen(locale, "station-offline")}
        alt={copy.screenAlt}
        caption={copy.caption}
        widths={[480, 960]}
        sizes="(max-width: 1023px) 60vw, 28.75rem"
      />
    </div>
  </div>
</section>
```

- [ ] **Step 3: Write the traceability section**

Create `apps/landing/src/components/home/HomeTraceability.astro` (the text comes first in the markup so phones read the heading before the screen; on desktop CSS puts the screen on the left):

```astro
---
import { homeScreen } from "../../content/home-images";
import type { Locale } from "../../content/pages";
import { getUiCopy } from "../../content/ui";
import ScreenFrame from "./ScreenFrame.astro";

interface Props {
  locale: Locale;
}

const { locale } = Astro.props;
const copy = getUiCopy(locale).home.traceability;
---

<section class="section home-traceability" id="traceability" aria-labelledby="traceability-title">
  <div class="container home-traceability__grid">
    <div>
      <p class="section-index">{copy.kicker}</p>
      <h2 id="traceability-title" class="display-heading display-heading--sentence">{copy.heading}</h2>
      <p class="section-lead">{copy.lead}</p>
    </div>
    <ScreenFrame
      image={homeScreen(locale, "station-conflicts")}
      alt={copy.screenAlt}
      caption={copy.caption}
      widths={[720, 1080, 1440]}
      sizes="(max-width: 1023px) 100vw, 45rem"
    />
  </div>
</section>
```

- [ ] **Step 4: Write the film block**

Create `apps/landing/src/components/home/HomeFilmBlock.astro`:

```astro
---
import { Picture } from "astro:assets";

import { findFilmPage } from "../../content/film";
import { HOME_FILM_PAGE_IMAGE } from "../../content/home-images";
import type { Locale } from "../../content/pages";
import { getUiCopy } from "../../content/ui";

interface Props {
  locale: Locale;
}

const { locale } = Astro.props;
const copy = getUiCopy(locale).home.filmBlock;
---

<section class="section home-film" id="film" aria-labelledby="film-title">
  <div class="container">
    <div class="home-film__panel" data-theme="dark">
      <div class="home-film__text">
        <p class="section-index">{copy.kicker}</p>
        <h2 id="film-title">{copy.heading}</h2>
        <p class="home-film__lead">{copy.lead}</p>
        <a class="button" href={findFilmPage(locale).path}>{copy.button} <span aria-hidden="true">→</span></a>
      </div>
      <Picture
        src={HOME_FILM_PAGE_IMAGE}
        alt={copy.imageAlt}
        widths={[880, 1320, 1760]}
        formats={["avif", "webp"]}
        sizes="(max-width: 1023px) 100vw, 46rem"
        loading="lazy"
        class="home-film__image"
      />
    </div>
  </div>
</section>
```

- [ ] **Step 5: Write the section styles**

Append to `apps/landing/src/styles/home.css`:

```css
/* Dark parts of the light page. `color` is inherited already computed from the light body, so a
   dark part sets it again from its own tokens. The light page darkens the button hover
   (landing.css); dark parts keep the dark theme's hover. */
.home [data-theme="dark"] {
  color: var(--fg-1);
  color-scheme: dark;
}

.home [data-theme="dark"] .button:hover {
  border-color: var(--accent-strong);
  background: var(--accent-strong);
}

/* 02 Without a network */

.home-offline {
  padding-block: 7rem;
  background: var(--surface-page);
}

.home-offline__grid {
  display: grid;
  grid-template-columns: minmax(0, 31.25rem) minmax(0, 1fr);
  align-items: start;
  gap: 4.5rem;
}

.home-offline__points {
  display: grid;
  margin: 2rem 0 0;
  padding: 0;
  list-style: none;
}

.home-offline__points li {
  display: flex;
  gap: 1rem;
  padding-block: 1rem;
  border-top: 1px solid var(--line);
}

.home-offline__number {
  flex: none;
  color: var(--fg-3);
  font: 500 0.75rem / 1.6 var(--font-mono);
}

.home-offline__points h3 {
  margin: 0;
  font: 600 1rem / 1.3 var(--font-ui);
}

.home-offline__points p {
  margin: 0.25rem 0 0;
  color: var(--fg-2);
  font: 400 0.9375rem / 1.45 var(--font-ui);
}

/* The sunset scene with the station's offline screen over its lower left. */
.home-offline__visual {
  position: relative;
  padding-bottom: 7rem;
}

.home-offline__visual > picture {
  display: block;
}

.home-offline__scene {
  display: block;
  width: calc(100% - 2.5rem);
  height: auto;
  margin-left: 2.5rem;
  border-radius: 6px;
}

.home-offline__visual .screen-frame {
  position: absolute;
  bottom: 0;
  left: 0;
  width: 61%;
  justify-items: start;
}

.home-offline .home-caption {
  padding: 0.3125rem 0.5625rem;
  border: 1px solid var(--line);
  border-radius: 2px;
  background: var(--surface-card);
}

/* 03 Traceability */

.home-traceability {
  padding-block: 7rem;
}

.home-traceability__grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 30rem);
  align-items: center;
  gap: 4.5rem;
}

.home-traceability .screen-frame {
  order: -1;
  justify-items: start;
}

/* 04 The film: a dark panel inside the light page. */

.home .home-film {
  padding-block: 0 7rem;
  border-top: 0;
}

.home-film__panel {
  display: grid;
  grid-template-columns: minmax(0, 28.75rem) minmax(0, 1fr);
  min-height: 33.75rem;
  overflow: hidden;
  border-radius: var(--r-2);
  background: var(--surface-page);
}

.home-film__text {
  display: grid;
  align-content: center;
  justify-items: start;
  gap: 1.25rem;
  padding: 3.5rem;
}

.home-film__text .section-index {
  margin: 0;
}

.home-film h2 {
  margin: 0;
  font: 700 clamp(1.75rem, 2.5vw, 2.25rem) / 1.1 var(--font-ui);
  letter-spacing: -0.03em;
}

.home-film__lead {
  margin: 0;
  color: var(--fg-2);
  font: 400 1.0625rem / 1.55 var(--font-ui);
}

.home-film__panel .button {
  border-color: var(--fg-1);
  background: var(--fg-1);
  color: var(--fg-on-inverse);
}

.home .home-film__panel .button:hover {
  border-color: var(--fg-2);
  background: var(--fg-2);
}

.home-film__panel > picture {
  display: block;
}

.home-film__image {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

@media (max-width: 1023px) {
  .home-offline__grid,
  .home-traceability__grid,
  .home-film__panel {
    grid-template-columns: minmax(0, 1fr);
    gap: 3rem;
  }

  .home-traceability .screen-frame {
    order: 0;
  }

  .home-film__panel {
    gap: 0;
    min-height: 0;
  }

  .home-film__image {
    height: auto;
    aspect-ratio: 16 / 10;
  }
}

@media (max-width: 767px) {
  .home-offline,
  .home-traceability {
    padding-block: 4.5rem;
  }

  .home .home-film {
    padding-bottom: 4.5rem;
  }

  .home-film__text {
    padding: 2rem 1.25rem;
  }
}
```

- [ ] **Step 6: Put the sections on the page**

In `apps/landing/src/components/HomePage.astro`:

1. Delete the whole `<section class="section section--continuity" id="continuity" …>…</section>` element, the `<TraceLog locale={page.locale} />` element and the `TraceLog` import.
2. `copy` is now unused: delete `const copy = getUiCopy(page.locale);` and the `getUiCopy` import.
3. Add the imports of `HomeOffline`, `HomeTraceability` and `HomeFilmBlock` from `./home/` and place, right after `<HomeProduct locale={page.locale} />`:

```astro
    <HomeOffline locale={page.locale} />
    <HomeTraceability locale={page.locale} />
    <HomeFilmBlock locale={page.locale} />
```

- [ ] **Step 7: Run the tests**

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/landing exec vitest run test/rendered-page.test.ts`
Expected: PASS.

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/landing typecheck && pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/landing lint`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/landing/src/components/home apps/landing/src/styles/home.css apps/landing/src/components/HomePage.astro apps/landing/test/rendered-page.test.ts
git commit -m "feat(landing): offline, traceability and film sections on the home page" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Rollout, documents, articles and the demo form

**Files:**

- Create: `apps/landing/src/components/home/HomeRollout.astro`
- Create: `apps/landing/src/components/home/HomeDocuments.astro`
- Modify: `apps/landing/src/components/HomeMaterials.astro` (rewrite)
- Modify: `apps/landing/src/components/DemoSection.astro` (theme attribute)
- Modify: `apps/landing/src/content/ui.ts` (RU and EN `home.materials`, `home.demo`)
- Modify: `apps/landing/src/styles/landing.css` (the "Home: materials section" block moves out)
- Modify: `apps/landing/src/styles/home.css` (append)
- Modify: `apps/landing/src/components/HomePage.astro`
- Test: `apps/landing/test/rendered-page.test.ts`

**Interfaces:**

- Consumes: `HOME_LABELS`, `homeCover()` (Task 8); `hubPath()` from `src/content/hubs.ts`; `copy.home.rollout`, `copy.home.documents` (Task 2); `.home [data-theme="dark"]` (Task 10).
- Produces: `section#implementation` (rollout), `section#documents`, the restyled `section#materials`, `section#demo[data-theme="dark"]` and the final section order `hero, product, offline, traceability, film, implementation, documents, materials, demo`.

- [ ] **Step 1: Write the failing tests**

In `apps/landing/test/rendered-page.test.ts`:

1. Replace the test "publishes the current product-category boundary on the home and SSCC pages" with the version below. The home pages now state the new boundary; `/sscc-i-agregatsiya/` and the serialization pages keep their current wording until their own redesign, so their assertions are carried over unchanged.

```ts
  it("states the product-group boundary on the home pages and keeps the SSCC pages' current one", () => {
    for (const [route, groups, check] of [
      ["/", "любой маркируемой продукции", "Особенности вашей товарной группы сверяем до запуска"],
      ["/en/", "any marked goods", "We check the rules of your product group before launch"],
    ] as const) {
      const text = documents.get(route)?.body.textContent?.replace(/\s+/g, " ") ?? "";
      expect(text, route).toContain(groups);
      expect(text, route).toContain(check);
      expect(text, route).not.toContain("Сейчас — пиво, сидр");
      expect(text, route).not.toContain("Currently focused on beer");
      expect(text, route).not.toContain("Новые товарные группы добавляются поэтапно");
      expect(text, route).not.toContain("Additional product categories are being added gradually");
    }

    const ruCategory = "Пиво, напитки, изготавливаемые на основе пива, слабоалкогольные напитки";
    const enCategory = "Beer, beverages made from beer and low-alcohol beverages";
    const ruSsccText =
      documents.get("/sscc-i-agregatsiya/")?.body.textContent?.replace(/\s+/g, " ") ?? "";
    expect(ruSsccText).toContain(ruCategory);
    expect(ruSsccText.toLowerCase()).toContain("сидр");
    expect(ruSsccText).toContain("Новые товарные группы добавляются поэтапно");
    expect(ruSsccText).not.toContain("внедряется для производителей");
    const enSsccText =
      documents.get("/en/sscc-and-aggregation/")?.body.textContent?.replace(/\s+/g, " ") ?? "";
    expect(enSsccText).toContain(enCategory);
    expect(enSsccText.toLowerCase()).toContain("cider");
    expect(enSsccText).toContain("Additional product categories are being added gradually");
    expect(enSsccText).not.toContain("is currently deployed");

    const ruSscc = documents.get("/sscc-i-agregatsiya/")?.body.textContent ?? "";
    expect(ruSscc).toContain("Текущий поддерживаемый уровень — цепочка «единица → короб»");
    expect(ruSscc).toContain("Паллетная агрегация");
    expect(ruSscc).toContain("будет добавлена отдельным следующим этапом");

    const enSscc = documents.get("/en/sscc-and-aggregation/")?.body.textContent ?? "";
    expect(enSscc).toContain("The currently supported level is the item-to-case chain");
    expect(enSscc).toContain("Pallet aggregation");
    expect(enSscc).toContain("will be added as a separate next stage");

    const ruSerialization = documents.get("/markirovka-chestny-znak/")?.body.textContent ?? "";
    expect(ruSerialization).toContain("связь единицы с коробом");
    expect(ruSerialization).not.toContain("связь единицы с коробом или паллетой");

    const enSerialization =
      documents.get("/en/chestny-znak-serialization/")?.body.textContent ?? "";
    expect(enSerialization).toContain("the relationship between an item and its case");
    expect(enSerialization).not.toContain("the relationship between an item, case, or pallet");
  });
```

2. Add:

```ts
  it("renders the rollout, documents, articles and demo sections", () => {
    for (const [route, instructionsPath, legalPath, articlesHeading] of [
      ["/", "/instruktsii/", "/legal/", "Разборы задач с линии."],
      ["/en/", "/en/instructions/", "/en/legal/", "Field notes from the line."],
    ] as const) {
      const page = documents.get(route);
      const rollout = page?.querySelector("section#implementation");
      expect(rollout?.querySelectorAll(".home-rollout__steps li"), route).toHaveLength(4);
      expect(rollout?.querySelectorAll(".home-rollout__label img[alt]")).toHaveLength(2);
      const docs = page?.querySelector("section#documents");
      expect(docs?.querySelectorAll(".home-documents__covers img[alt]")).toHaveLength(3);
      expect([...(docs?.querySelectorAll("a") ?? [])].map((link) => link.getAttribute("href"))).toEqual([
        instructionsPath,
        legalPath,
      ]);
      expect(page?.querySelector("section#materials h2")?.textContent).toBe(articlesHeading);
      expect(page?.querySelector("section#demo")?.getAttribute("data-theme")).toBe("dark");
    }
  });

  it("numbers the home sections in page order", () => {
    for (const route of ["/", "/en/"] as const) {
      const kickers = [
        ...(documents.get(route)?.querySelectorAll("main section:not(#hero) .section-index") ?? []),
      ].map((kicker) => kicker.textContent?.trim().slice(0, 2));
      expect(kickers, route).toEqual(["01", "02", "03", "04", "05", "06", "07", "08"]);
    }
  });
```

3. In "links the cluster from the header, footer and a home materials section" replace `expect(materialLinks).toContain("/instruktsii/");` with `expect(document.querySelector('#documents a[href="/instruktsii/"]')).not.toBeNull();` (the instructions link moves to the documents section).

4. In "renders the approved semantic section hierarchy" replace the list of section ids with:

```ts
    for (const sectionId of [
      "hero",
      "product",
      "offline",
      "traceability",
      "film",
      "implementation",
      "documents",
      "materials",
      "demo",
    ]) {
```

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/landing exec vitest run test/rendered-page.test.ts -t "product-group boundary|rollout, documents|page order|home materials|section hierarchy"`
Expected: FAIL.

- [ ] **Step 2: Update the articles and demo copy**

In `apps/landing/src/content/ui.ts` replace the RU `materials` object with:

```ts
    materials: {
      allArticles: "Все статьи",
      heading: "Разборы задач с линии.",
      kicker: "07 / СТАТЬИ",
    },
```

and the EN one with:

```ts
    materials: {
      allArticles: "All articles",
      heading: "Field notes from the line.",
      kicker: "07 / ARTICLES",
    },
```

In the RU `demo` object set `lead: "Разберём ваш процесс, сверим правила вашей товарной группы и покажем сценарий на вашем продукте.",`. In the EN `demo` object set `heading: "We will show Markiro on your line.",` and `lead: "We will walk through your process, check the rules of your product group and show the scenario on your product.",`. The demo form is shared with the film page, which picks up the same copy.

- [ ] **Step 3: Rewrite the articles section**

Replace `apps/landing/src/components/HomeMaterials.astro` with:

```astro
---
import { formatLegalEffectiveDate } from "@markiro/legal-documents";

import { articlesForLocale } from "../content/articles";
import { hubPath } from "../content/hubs";
import type { Locale } from "../content/pages";
import { getUiCopy } from "../content/ui";

interface Props { locale: Locale }
const { locale } = Astro.props;
const copy = getUiCopy(locale).home.materials;
const minutes = getUiCopy(locale).hub.minutes;
const articles = articlesForLocale(locale).slice(0, 3);
---

<section class="section home-materials" id="materials" aria-labelledby="materials-title">
  <div class="container">
    <p class="section-index">{copy.kicker}</p>
    <h2 id="materials-title" class="home-materials__heading">{copy.heading}</h2>

    <div class="home-materials__grid">
      {articles.map((article) => (
        <article class="materials-card" data-materials-card>
          <h3><a class="materials-card__link" href={article.path}>{article.navigationLabel}</a></h3>
          <p>{article.description}</p>
          <span class="materials-card__meta">
            <time datetime={article.publishedAt}>{formatLegalEffectiveDate(article.publishedAt, locale)}</time>
            <span>{" · "}{article.readingTimeMinutes} {minutes}</span>
          </span>
        </article>
      ))}
    </div>

    <a class="text-link" href={hubPath(locale, "articles")}>{copy.allArticles} <span aria-hidden="true">→</span></a>
  </div>
</section>
```

- [ ] **Step 4: Write the rollout section**

Create `apps/landing/src/components/home/HomeRollout.astro`:

```astro
---
import { Picture } from "astro:assets";

import { HOME_LABELS } from "../../content/home-images";
import type { Locale } from "../../content/pages";
import { getUiCopy } from "../../content/ui";

interface Props {
  locale: Locale;
}

const { locale } = Astro.props;
const copy = getUiCopy(locale).home.rollout;
---

<section class="section home-rollout" id="implementation" aria-labelledby="implementation-title">
  <div class="container">
    <div class="home-rollout__top">
      <div>
        <p class="section-index">{copy.kicker}</p>
        <h2 id="implementation-title" class="display-heading display-heading--sentence">{copy.heading}</h2>
        <p class="section-lead">{copy.lead}</p>
      </div>
      <div class="home-rollout__labels">
        {copy.labels.map((label) => (
          <figure class="home-rollout__label">
            <Picture
              src={HOME_LABELS[label.id]}
              alt={label.alt}
              widths={[180, 360, 540]}
              formats={["avif", "webp"]}
              sizes="11.25rem"
              loading="lazy"
            />
            <figcaption class="home-caption">{label.caption}</figcaption>
          </figure>
        ))}
      </div>
    </div>
    <ol class="home-rollout__steps" role="list">
      {copy.steps.map(([title, text], index) => (
        <li>
          <span class="home-rollout__number" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
          <h3>{title}</h3>
          <p>{text}</p>
        </li>
      ))}
    </ol>
  </div>
</section>
```

(`role="list"` keeps the list semantics that Safari drops from lists styled with `list-style: none`.)

- [ ] **Step 5: Write the documents section**

Create `apps/landing/src/components/home/HomeDocuments.astro`:

```astro
---
import { Picture } from "astro:assets";

import { homeCover } from "../../content/home-images";
import { hubPath } from "../../content/hubs";
import type { Locale } from "../../content/pages";
import { getUiCopy } from "../../content/ui";

interface Props {
  locale: Locale;
}

const { locale } = Astro.props;
const copy = getUiCopy(locale).home.documents;
const legalPath = locale === "ru" ? "/legal/" : "/en/legal/";
---

<section class="section home-documents" id="documents" aria-labelledby="documents-title">
  <div class="container home-documents__grid">
    <div>
      <p class="section-index">{copy.kicker}</p>
      <h2 id="documents-title" class="display-heading display-heading--sentence">{copy.heading}</h2>
      <p class="section-lead">{copy.lead}</p>
      <p class="home-documents__links">
        <a class="text-link" href={hubPath(locale, "instructions")}>{copy.allInstructions} <span aria-hidden="true">→</span></a>
        <a class="text-link" href={legalPath}>{copy.legal} <span aria-hidden="true">→</span></a>
      </p>
    </div>
    <ul class="home-documents__covers" role="list">
      {copy.covers.map((cover) => (
        <li>
          <figure>
            <Picture
              src={homeCover(locale, cover.code)}
              alt={cover.alt}
              widths={[240, 480, 720]}
              formats={["avif", "webp"]}
              sizes="(max-width: 767px) 30vw, 14.75rem"
              loading="lazy"
            />
            <figcaption class="home-caption">{cover.caption}</figcaption>
          </figure>
        </li>
      ))}
    </ul>
  </div>
</section>
```

- [ ] **Step 6: Dark demo section**

In `apps/landing/src/components/DemoSection.astro` change the section's opening tag to:

```astro
<section class="section section--demo" id="demo" data-theme="dark" aria-labelledby="demo-title">
```

On the dark pages this changes nothing; on the light home page the form keeps its dark look.

- [ ] **Step 7: Move the articles styles and add the new ones**

In `apps/landing/src/styles/landing.css` delete everything from the comment `/* Home: materials section */` up to, not including, `/* Hubs: article and instruction lists reuse the registry list */`, and the `.materials-grid { … }` rule inside the `@media (max-width: 767px)` block near the end of the file.

Append to `apps/landing/src/styles/home.css`:

```css
/* 05 Rollout */

.home-rollout {
  padding-block: 7rem;
  background: var(--surface-panel);
}

.home-rollout__top {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end;
  gap: 4.5rem;
}

.home-rollout__labels {
  display: flex;
  gap: 1.25rem;
}

.home-rollout__label {
  display: grid;
  gap: 0.625rem;
  margin: 0;
}

.home-rollout__label img {
  display: block;
  width: 11.25rem;
  height: auto;
  border: 1px solid var(--line);
  background: #fff;
  box-shadow: 0 0.625rem 1.5rem rgb(23 22 26 / 12%);
}

.home-rollout__steps {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin: 3.5rem 0 0;
  padding: 0;
  list-style: none;
}

.home-rollout__steps li {
  display: grid;
  align-content: start;
  gap: 0.625rem;
  padding: 1.5rem 1.5rem 0 0;
  border-top: 1px solid var(--line-strong);
}

.home-rollout__number {
  color: var(--fg-3);
  font: 500 0.75rem / 1.3 var(--font-mono);
}

.home-rollout__steps h3 {
  margin: 0.25rem 0 0;
  font: 600 1.125rem / 1.3 var(--font-ui);
}

.home-rollout__steps p {
  margin: 0;
  color: var(--fg-2);
  font: 400 0.9375rem / 1.5 var(--font-ui);
}

/* 06 Open documents */

.home-documents {
  padding-block: 7rem;
}

.home-documents__grid {
  display: grid;
  grid-template-columns: minmax(0, 28.75rem) minmax(0, 1fr);
  align-items: center;
  gap: 4.5rem;
}

.home-documents__links {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem 1.75rem;
  margin: 2rem 0 0;
}

.home-documents__covers {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1.5rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.home-documents__covers figure {
  display: grid;
  gap: 0.75rem;
  margin: 0;
}

.home-documents__covers img {
  display: block;
  width: 100%;
  height: auto;
  border: 1px solid var(--line);
  background: #fff;
  box-shadow: 0 0.75rem 2rem rgb(23 22 26 / 12%);
}

/* 07 Articles: follows the documents without a divider. */

.home .home-materials {
  padding-block: 0 7rem;
  border-top: 0;
}

.home-materials__heading {
  margin: 0;
  font: 700 clamp(1.75rem, 2.4vw, 2.125rem) / 1.15 var(--font-ui);
  letter-spacing: -0.03em;
}

.home-materials__grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1.5rem;
  margin: 2.5rem 0;
}

.materials-card {
  position: relative;
  display: grid;
  align-content: start;
  gap: 0.75rem;
  padding-top: 1.5rem;
  border-top: 1px solid var(--line-strong);
}

/* The title is the only anchor text; its pseudo-element makes the whole card clickable. */
.materials-card__link {
  color: inherit;
  text-decoration: none;
}

.materials-card__link::after {
  position: absolute;
  inset: 0;
  content: "";
}

.materials-card:hover {
  border-top-color: var(--fg-1);
}

.materials-card h3 {
  margin: 0;
  font: 600 1.1875rem / 1.3 var(--font-ui);
}

.materials-card p {
  margin: 0;
  color: var(--fg-2);
  font: 400 0.9375rem / 1.5 var(--font-ui);
}

.materials-card__meta {
  display: flex;
  gap: 0.25rem;
  color: var(--fg-3);
  font: 500 0.75rem / 1.4 var(--font-mono);
}

@media (max-width: 1023px) {
  .home-rollout__top,
  .home-documents__grid,
  .home-materials__grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .home-rollout__top,
  .home-documents__grid {
    gap: 2.5rem;
  }

  .home-rollout__steps {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    row-gap: 2rem;
  }
}

@media (max-width: 767px) {
  .home-rollout,
  .home-documents {
    padding-block: 4.5rem;
  }

  .home .home-materials {
    padding-bottom: 4.5rem;
  }

  .home-rollout__steps {
    grid-template-columns: minmax(0, 1fr);
  }

  .home-rollout__label img {
    width: 9rem;
  }

  .home-documents__covers {
    gap: 0.75rem;
  }
}
```

- [ ] **Step 8: Put the sections on the page**

In `apps/landing/src/components/HomePage.astro` replace `<ImplementationSteps locale={page.locale} />` with:

```astro
    <HomeRollout locale={page.locale} />
    <HomeDocuments locale={page.locale} />
```

replace the `ImplementationSteps` import with imports of `HomeRollout` and `HomeDocuments` from `./home/`, and keep `<HomeMaterials … />` and `<DemoSection … />` after them.

- [ ] **Step 9: Run the tests**

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/landing exec vitest run test/rendered-page.test.ts src/content/home-copy.test.ts`
Expected: PASS, including "keeps card links short so the anchor text is the title alone" and "renders English pages without Russian interface copy".

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/landing typecheck && pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/landing lint`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add apps/landing/src/components/home apps/landing/src/components/HomeMaterials.astro apps/landing/src/components/DemoSection.astro apps/landing/src/content/ui.ts apps/landing/src/styles/landing.css apps/landing/src/styles/home.css apps/landing/src/components/HomePage.astro apps/landing/test/rendered-page.test.ts
git commit -m "feat(landing): rollout, documents, articles and demo on the home page" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Remove the old home and run the release gates

**Files:**

- Delete: `apps/landing/src/components/LineConsole.astro`, `ProductionCycle.astro`, `ProductModes.astro`, `TraceLog.astro`, `PlatformModules.astro`, `ImplementationSteps.astro`; `apps/landing/src/assets/factory-line.jpg`
- Modify: `apps/landing/src/content/ui.ts` (old `home` keys), `apps/landing/src/styles/landing.css` (old home rules)
- Test: `apps/landing/test/rendered-page.test.ts`, `tools/production-browser/tests/landing-seo.spec.ts`

**Interfaces:**

- Consumes: everything from Tasks 1-11.
- Produces: the finished home page; no new names.

- [ ] **Step 1: Delete the old components and the photograph**

```bash
git rm apps/landing/src/components/LineConsole.astro apps/landing/src/components/ProductionCycle.astro apps/landing/src/components/ProductModes.astro apps/landing/src/components/TraceLog.astro apps/landing/src/components/PlatformModules.astro apps/landing/src/components/ImplementationSteps.astro apps/landing/src/assets/factory-line.jpg
```

Run: `grep -rnE "LineConsole|ProductionCycle|ProductModes|TraceLog|PlatformModules|ImplementationSteps|factory-line" apps/landing/src apps/landing/test`
Expected: no matching lines.

`apps/landing/src/components/HomePage.astro` must now read:

```astro
---
import type { SeoPageDefinition } from "../content/pages";
import { readPublicSiteConfig } from "../lib/site-config";
import { buildPageGraph } from "../lib/seo";
import BaseLayout from "../layouts/BaseLayout.astro";
import "../styles/home.css";
import DemoSection from "./DemoSection.astro";
import HomeMaterials from "./HomeMaterials.astro";
import LandingFooter from "./LandingFooter.astro";
import LandingHeader from "./LandingHeader.astro";
import HomeDocuments from "./home/HomeDocuments.astro";
import HomeFilmBlock from "./home/HomeFilmBlock.astro";
import HomeMapHero from "./home/HomeMapHero.astro";
import HomeOffline from "./home/HomeOffline.astro";
import HomeProduct from "./home/HomeProduct.astro";
import HomeRollout from "./home/HomeRollout.astro";
import HomeTraceability from "./home/HomeTraceability.astro";

interface Props { page: SeoPageDefinition }
const { page } = Astro.props;
const siteConfig = readPublicSiteConfig(
  {
    PUBLIC_DEMO_SUBMISSION_ENABLED: import.meta.env.PUBLIC_DEMO_SUBMISSION_ENABLED,
    PUBLIC_PHONE: import.meta.env.PUBLIC_PHONE,
    PUBLIC_SMARTCAPTCHA_CLIENT_KEY: import.meta.env.PUBLIC_SMARTCAPTCHA_CLIENT_KEY,
  },
  page.locale,
);
---

<BaseLayout metadata={page} graph={buildPageGraph(page)} theme="light">
  <LandingHeader page={page} phone={siteConfig.phone} />

  <main id="main" class="home">
    <HomeMapHero locale={page.locale} phone={siteConfig.phone} />
    <HomeProduct locale={page.locale} />
    <HomeOffline locale={page.locale} />
    <HomeTraceability locale={page.locale} />
    <HomeFilmBlock locale={page.locale} />
    <HomeRollout locale={page.locale} />
    <HomeDocuments locale={page.locale} />
    <HomeMaterials locale={page.locale} />
    <DemoSection
      locale={page.locale}
      phone={siteConfig.phone}
      demoEndpoint={siteConfig.demoEndpoint}
      legalLinks={siteConfig.legalLinks}
      captchaClientKey={siteConfig.captchaClientKey}
      consentVersion={siteConfig.consentVersion}
      sourcePath={page.path}
    />
  </main>

  <LandingFooter page={page} />

  <script>
    import { browserDemoFormRuntime, initDemoForm } from "../scripts/demo-form";
    import { initHomeMap } from "../scripts/home/map";
    import { browserLandingRuntime, initLanding } from "../scripts/site";

    initLanding(document, browserLandingRuntime(window));
    initHomeMap(document);
    const demoForm = document.querySelector<HTMLFormElement>("[data-demo-form]");
    if (demoForm !== null) initDemoForm(demoForm, browserDemoFormRuntime(window));
  </script>
</BaseLayout>
```

If the file differs only in import order required by the linter, keep the linter's order.

- [ ] **Step 2: Delete the old home copy**

In `apps/landing/src/content/ui.ts` delete the keys `continuity`, `cycle`, `hero`, `implementation`, `lineConsole`, `platform`, `product` and `trace` from both the RU and the EN `home` objects. `home` keeps `demo`, `materials`, `mapHero`, `productSection`, `offline`, `traceability`, `filmBlock`, `rollout` and `documents`.

Run: `grep -nE "^    (continuity|cycle|hero|implementation|lineConsole|platform|product|trace): \{" apps/landing/src/content/ui.ts`
Expected: no matching lines.

- [ ] **Step 3: Delete the old home styles**

The old home used these classes, and nothing else on the site does (checked with `grep -rl` over `apps/landing/src` when this plan was written): `.hero` and `.hero__*`, `.line-console*`, `.interface-kicker`, `.section--continuity`, `.continuity-*`, `.section--cycle`, `.cycle-*`, `.process-list`, `.code-result*`, `.label-result`, `.label-sheet*`, `.label-status`, `.progress-track`, `.result-ok`, `.scan-symbol`, `.status-inline`, `.section--product`, `.product-scene*`, `.product-scenes`, `.scene-number`, `.scene-toolbar`, `.section--trace`, `.trace-*`, `.section--platform`, `.module-*`, `.section--implementation`, `.implementation-*`, `.compact-benefits`.

In `apps/landing/src/styles/landing.css` delete every rule whose selectors are all in that list, including the copies inside `@media` blocks, and delete a `@media` block left empty. Where a selector list mixes them with other selectors, delete only the old selectors and keep the rule; the ones known today are `.implementation-grid, .demo-grid` (keep `.demo-grid`), `.cycle-grid, .trace-layout, .implementation-grid, .demo-grid` (keep `.demo-grid`) and `.section--continuity, … , .section--demo` (keep `.section--demo`). Blocks that only contain `hero` in a longer name (`.article-hero`, `.film-hero`, `.topic-hero` and so on) stay.

Run: `grep -nE '(^|[[:space:],(>+~])\.(hero([[:space:],:{.>]|__)|line-console|interface-kicker|section--(continuity|cycle|product|trace|platform|implementation)|continuity-|cycle-|process-list|code-result|label-result|label-sheet|label-status|progress-track|result-ok|scan-symbol|status-inline|product-scene|scene-number|scene-toolbar|trace-|module-|implementation-|compact-benefits)' apps/landing/src/styles/landing.css`
Expected: no matching lines.

- [ ] **Step 4: Test the home images in the built page**

Add to `apps/landing/test/rendered-page.test.ts`:

```ts
  it("gives every home image alt text and loads only the map eagerly", () => {
    for (const route of ["/", "/en/"] as const) {
      const images = [...(documents.get(route)?.querySelectorAll("main img") ?? [])];
      expect(images.length, route).toBeGreaterThan(15);
      expect(images.filter((image) => image.hasAttribute("data-hero-image")), route).toHaveLength(1);
      for (const image of images) {
        const name = image.getAttribute("src") ?? route;
        expect(image.hasAttribute("alt"), name).toBe(true);
        expect(image.getAttribute("loading"), name).toBe(
          image.hasAttribute("data-hero-image") ? "eager" : "lazy",
        );
      }
    }
  });
```

Run: `pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/landing exec vitest run test/rendered-page.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the browser tests**

Append to `tools/production-browser/tests/landing-seo.spec.ts`:

```ts
test.describe("home page", () => {
  test("hotspots show their screen on hover and focus, and Escape hides it", async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "phones get the card strip instead of hotspots");
    await page.goto("/");
    await page.locator("[data-consent-reject]").click();
    const spot = page.locator("[data-map-spot]").filter({ hasText: "Склад" });
    const tip = spot.locator('[role="tooltip"]');
    await expect(tip).toBeHidden();
    await spot.locator("a").hover();
    await expect(tip).toBeVisible();
    await expect(tip.locator("img")).toHaveAttribute("alt", /ТСД/u);
    await page.mouse.move(1, 1);
    await expect(tip).toBeHidden();
    await spot.locator("a").focus();
    await expect(tip).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(tip).toBeHidden();
  });

  test("the warehouse hotspot or card leads to the handheld row", async ({ page, isMobile }) => {
    await page.goto("/");
    await page.locator("[data-consent-reject]").click();
    const link = isMobile
      ? page.locator(".home-hero__strip a").filter({ hasText: "Склад" })
      : page.locator("[data-map-spot]").filter({ hasText: "Склад" }).locator("a");
    await link.click();
    await expect(page).toHaveURL(/#product-handheld$/u);
    await expect(page.locator("#product-handheld")).toBeInViewport();
  });

  test("loads no 3D code", async ({ page }) => {
    const scripts: Promise<string>[] = [];
    page.on("response", (response) => {
      if (response.request().resourceType() === "script") scripts.push(response.text());
    });
    await page.goto("/", { waitUntil: "networkidle" });
    await page.evaluate(() =>
      window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" }),
    );
    await page.waitForLoadState("networkidle");
    const bodies = await Promise.all(scripts);
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) expect(body).not.toContain("WebGLRenderer");
  });

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
  ] as const) {
    test(`fits ${viewport.width} px without horizontal scrolling`, async ({ page }) => {
      await page.setViewportSize(viewport);
      for (const route of ["/", "/en/"]) {
        await page.goto(route, { waitUntil: "networkidle" });
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          route,
        ).toBe(true);
      }
    });
  }
});
```

Every three.js build carries the `THREE.WebGLRenderer:` message strings, so a script body without `WebGLRenderer` is not three.js. The existing tests keep covering the three phone links (`demo`, `header`, `hero`), GTM, consent, captcha and the demo form on `/`.

- [ ] **Step 6: Run the landing gates**

```bash
pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/landing test
pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/landing typecheck
pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/landing lint
pnpm_config_verify_deps_before_run=false pnpm --filter @markiro/landing build
pnpm --dir tools/production-browser --ignore-workspace typecheck
```

Expected: all pass.

- [ ] **Step 7: Run the browser suite and Lighthouse**

Outside the sandbox, with nothing listening on port 5473:

```bash
CI=1 pnpm test:landing:browser
env -u CLAUDECODE pnpm test:landing:lighthouse
```

Expected: every landing browser test passes in the desktop and mobile projects, including the film page's tests with the restyled header; Lighthouse meets its thresholds on `/` (mobile performance ≥ 0.9, accessibility 1, SEO 1, best practices ≥ 0.95) and on the other `LIGHTHOUSE_ROUTES`. `CI=1` makes Playwright build and serve the current site instead of reusing a stale server.

- [ ] **Step 8: Formatting and whitespace**

```bash
pnpm format:check
git diff --check origin/main...HEAD
```

Expected: both clean. Fix formatting with `pnpm exec prettier --write <file>` on the files this plan touched only.

- [ ] **Step 9: Visual comparison**

Serve the built site (`node tools/production-browser/scripts/serve-landing.mjs`, outside the sandbox) and take full-page screenshots of `/` and `/en/` at 1440 × 900 and 390 × 844 (reduced motion, consent panel hidden). Compare them with the pen.dev frames `HP · Главная · направление A · полная страница · 1440` and `HM · Главная · телефон · hero с лентой · 390×844`: section order, dark sections (02, the film panel, 08), screen frames and captions, the handheld device, kickers «01 / …» to «08 / …» in grey. Fix differences in `home.css` and rerun Step 6. Stop the server afterwards. Show the screenshots to the owner with the spec's open items: the screen set with demo products and the English bullets and captions.

- [ ] **Step 10: Commit**

```bash
git add -A apps/landing/src/components apps/landing/src/assets apps/landing/src/content/ui.ts apps/landing/src/styles/landing.css apps/landing/test/rendered-page.test.ts tools/production-browser/tests/landing-seo.spec.ts
git status --short
git commit -m "refactor(landing): remove the old home sections" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Check `git status --short` before committing: only the files above are staged, and nothing under `output/`, `.claude/` or `.superpowers/`.
