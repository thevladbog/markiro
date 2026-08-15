# Landing Localized Brand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the landing's approximate green-dot wordmark with the exact Markiro modular symbol and localized live text: `маркиро` on Russian pages and `MARKIRO` on English pages.

**Architecture:** Keep one framework-local `BrandMark.astro` component that renders the repository's accepted eight-module geometry and receives the page locale from existing header/footer callers. Keep the wordmark as live text and align the favicon/manifests with the same geometry; do not introduce remote assets or a second token system.

**Tech Stack:** Astro 7, TypeScript 6, CSS, Vitest/JSDOM, SVG, Playwright production-browser checks.

**Spec:** `docs/superpowers/specs/2026-08-14-landing-demo-email-and-brand-design.md`

## Global Constraints

- Russian landing surfaces display the live wordmark `маркиро`; English landing surfaces display `MARKIRO`.
- Reproduce the exact eight-module geometry already encoded by `apps/admin/src/assets/markiro-logo-on-light.svg` and `packages/email/src/layout.tsx`; do not approximate it with one square.
- The symbol is decorative when adjacent live text identifies the brand; accessible labels are `Маркиро` for RU and `Markiro` for EN.
- No remote image, font, CDN, JavaScript, animation, or new dependency is allowed.
- Preserve the current header height, mobile navigation behavior, focus visibility, contrast, and exact RU/EN counterpart links.
- Use existing landing tokens and styles; do not copy handoff CSS or create a parallel token system.
- Automated checks do not replace desktop/mobile visual review.

---

### Task 1: Render the exact localized brand in header and footer

**Files:**

- Modify: `apps/landing/src/components/BrandMark.astro`
- Modify: `apps/landing/src/components/LandingHeader.astro`
- Modify: `apps/landing/src/components/LandingFooter.astro`
- Modify: `apps/landing/src/styles/landing.css`
- Test: `apps/landing/test/rendered-page.test.ts`

**Interfaces:**

- Consumes: `Locale = "ru" | "en"` from `apps/landing/src/content/pages.ts`.
- Produces: `<BrandMark locale={page.locale} />`, containing `[data-brand-symbol]`, exactly eight `[data-brand-module]` elements, one `[data-brand-accent]`, and localized `.brand-mark__word` text.

- [ ] **Step 1: Write the failing rendered-page test**

Add a focused assertion that checks both locale output and exact symbol structure:

```ts
it("renders the exact localized Markiro brand", () => {
  const ruBrand = documents.get("/")?.querySelector("header .brand-mark");
  const enBrand = documents.get("/en/")?.querySelector("header .brand-mark");

  expect(ruBrand?.querySelector(".brand-mark__word")?.textContent).toBe("маркиро");
  expect(ruBrand?.getAttribute("aria-label")).toBe("Маркиро");
  expect(enBrand?.querySelector(".brand-mark__word")?.textContent).toBe("MARKIRO");
  expect(enBrand?.getAttribute("aria-label")).toBe("Markiro");

  for (const brand of [ruBrand, enBrand]) {
    expect(brand?.querySelectorAll("[data-brand-module]")).toHaveLength(8);
    expect(brand?.querySelectorAll("[data-brand-accent]")).toHaveLength(1);
  }
});
```

- [ ] **Step 2: Run the test to verify RED**

Run:

```bash
corepack pnpm --filter @markiro/landing exec vitest run test/rendered-page.test.ts --no-file-parallelism
```

Expected: FAIL because `BrandMark` has no locale prop, still renders `MARKIRO` on RU, and has no exact module structure.

- [ ] **Step 3: Implement the locale-aware component and callers**

Use a fixed row model rather than hand-positioning unrelated spans:

```astro
---
import type { Locale } from "../content/pages";

interface Props { locale: Locale }
const { locale } = Astro.props;
const label = locale === "ru" ? "Маркиро" : "Markiro";
const word = locale === "ru" ? "маркиро" : "MARKIRO";
const modules = ["0-0", "0-2", "1-1", "2-0", "2-2", "3-0", "3-2", "4-1"];
---
<span class="brand-mark" aria-label={label}>
  <span class="brand-mark__symbol" data-brand-symbol aria-hidden="true">
    {modules.map((position, index) => (
      <span
        class:list={["brand-mark__module", { "brand-mark__module--accent": index === 7 }]}
        data-position={position}
        data-brand-module
        data-brand-accent={index === 7 ? "" : undefined}
      />
    ))}
  </span>
  <span class="brand-mark__word" lang={locale}>{word}</span>
</span>
```

Update both callers to pass `page.locale`. Replace `.brand-mark__signal` CSS with a compact 3-column/5-row symbol. Map the eight `data-position` values to the same module positions as the accepted SVG, use `var(--fg-1)` for ordinary modules and `var(--accent)` only for the final module, and keep the total mark within the current header line box.

- [ ] **Step 4: Run the focused test to verify GREEN**

Run:

```bash
corepack pnpm --filter @markiro/landing exec vitest run test/rendered-page.test.ts --no-file-parallelism
```

Expected: PASS, including the existing 16-route localized rendered-page assertions.

- [ ] **Step 5: Run package static checks**

Run:

```bash
corepack pnpm --filter @markiro/landing lint
corepack pnpm --filter @markiro/landing typecheck
```

Expected: both PASS with zero Astro diagnostics.

- [ ] **Step 6: Commit the localized component**

```bash
git add apps/landing/src/components/BrandMark.astro apps/landing/src/components/LandingHeader.astro apps/landing/src/components/LandingFooter.astro apps/landing/src/styles/landing.css apps/landing/test/rendered-page.test.ts
git commit -m "feat(landing): localize the Markiro brand"
```

---

### Task 2: Align favicon, manifests, audit, and visual acceptance

**Files:**

- Modify: `apps/landing/public/favicon.svg`
- Modify: `apps/landing/public/site.webmanifest`
- Modify: `apps/landing/src/lib/audit.test.ts`
- Modify: `apps/landing/src/lib/audit.ts`
- Modify: `tools/production-browser/tests/landing-seo.spec.ts`

**Interfaces:**

- Consumes: exact module geometry from Task 1 and existing `site.webmanifest` / `site.en.webmanifest` locale split.
- Produces: one shared symbol-only favicon, Russian manifest names `маркиро`, English manifest names `Markiro`, and build/browser assertions that prevent regression to the approximate four-block icon or Latin RU wordmark.

- [ ] **Step 1: Write failing favicon/manifest audit tests**

Extend the audit fixture and assertions to require the exact symbol marker count and localized manifest names. Keep the checks structural rather than pixel-snapshot-only:

```ts
expect(readJson("site.webmanifest")).toMatchObject({
  lang: "ru",
  name: "маркиро",
  short_name: "маркиро",
});
expect(readJson("site.en.webmanifest")).toMatchObject({
  lang: "en",
  name: "Markiro",
  short_name: "Markiro",
});
expect(readText("favicon.svg").match(/data-markiro-module/g)).toHaveLength(8);
```

Add a Playwright assertion on `/` and `/en/` for the localized header wordmark and eight modules.

- [ ] **Step 2: Run the focused checks to verify RED**

Run:

```bash
corepack pnpm --filter @markiro/landing exec vitest run src/lib/audit.test.ts --no-file-parallelism
corepack pnpm --filter @markiro/landing build
corepack pnpm --filter @markiro/landing run audit
```

Expected: FAIL because the RU manifest still says `Markiro` and the existing favicon has only the approximate four-block geometry.

- [ ] **Step 3: Replace the favicon geometry and localize the RU manifest**

Keep the current 64×64 dark tile and replace only its inner paths with eight explicit modules carrying `data-markiro-module`; the last module uses `#3ddc7a`, while ordinary modules use the existing off-white mark color. Do not add text to the favicon. Change only the RU manifest `name` and `short_name` to `маркиро`; keep the English manifest unchanged.

Teach `audit.ts` to parse the built manifest JSON and source favicon safely, produce bounded errors, and assert the exact locale/geometry contract without depending on build hashes.

- [ ] **Step 4: Run landing package verification**

Run:

```bash
corepack pnpm --filter @markiro/landing test
corepack pnpm --filter @markiro/landing lint
corepack pnpm --filter @markiro/landing typecheck
corepack pnpm --filter @markiro/landing build
corepack pnpm --filter @markiro/landing run audit
```

Expected: all PASS; Astro builds 16 HTML pages plus policy routes.

- [ ] **Step 5: Run browser and manual visual checks**

Run the established production-browser landing suite:

```bash
corepack pnpm test:landing:browser
```

Inspect RU and EN home screenshots at desktop and Pixel 7 widths. Confirm the symbol is crisp, the RU wordmark is Cyrillic, the EN wordmark is Latin, the header height/navigation do not shift, and the footer does not wrap unexpectedly. Record browser automation separately from the manual inspection.

- [ ] **Step 6: Run final hygiene and commit**

```bash
corepack pnpm format:check
git diff --check
git add apps/landing/public/favicon.svg apps/landing/public/site.webmanifest apps/landing/src/lib/audit.test.ts apps/landing/src/lib/audit.ts tools/production-browser/tests/landing-seo.spec.ts
git commit -m "feat(landing): align public brand assets"
```

Expected: clean formatting/diff and one scoped commit. Do not include generated `apps/landing/dist` output.
