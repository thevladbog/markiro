# Markiro Landing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the approved responsive Markiro marketing landing as a new Astro 7 workspace application with accessible navigation, restrained motion, custom product scenes, and a deploy-safe demo form contract.

**Architecture:** Add a static `apps/landing` Astro application that consumes `@markiro/ui/styles.css`, renders semantic `.astro` components, and hydrates no framework runtime. Keep site configuration and lead validation in small TypeScript modules tested with Vitest; enhance navigation, reveals, analytics dispatch, and form submission with one browser script. The page builds without customer contact secrets, but only exposes a phone link or network submission when validated public environment values are configured.

**Tech Stack:** Astro 7.1.6, TypeScript 6, Vitest 4, jsdom 29, shared `@markiro/ui` tokens and Fontsource IBM Plex assets.

**Spec:** `docs/design-briefs/09-landing-handoff.md`

## Global Constraints

- Final visual source is the local-only Pencil canvas: desktop `BBcHk`, tablet
  `ESUfk`, mobile `S1sumZ`. The container itself is not versioned because it
  carries an editor cloud token; the handoff records its stable contract.
- Use the dark `@markiro/ui` token theme; green is reserved for actions and real semantic status.
- Use custom HTML/CSS product scenes, not admin screenshots.
- The page must remain readable without JavaScript and must honor `prefers-reduced-motion`.
- Do not add React, a motion library, a runtime CDN, fake customer claims, a fake phone number, or a fake lead endpoint.
- Form fields are name, company, and phone. Client validation does not replace backend validation.
- Use test-first RED/GREEN cycles for configuration, validation, analytics, form submission, and menu behavior.
- Preserve unrelated untracked `.pnpm-store/` content.

---

### Task 1: Scaffold the Astro workspace and public configuration

**Files:**

- Create: `apps/landing/package.json`
- Create: `apps/landing/astro.config.mjs`
- Create: `apps/landing/tsconfig.json`
- Create: `apps/landing/src/env.d.ts`
- Create: `apps/landing/src/lib/site-config.test.ts`
- Create: `apps/landing/src/lib/site-config.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes: root pnpm workspace, shared `@markiro/ui/styles.css` export.
- Produces: `readPublicSiteConfig(env): PublicSiteConfig` with optional validated `phone` and `demoEndpoint` values.

- [x] **Step 1: Add package configuration only**

  Create an exact-version Astro 7.1.6 workspace package with `dev`, `build`, `preview`, `test`, `typecheck`, and `lint` scripts. Add exact Vitest and jsdom development dependencies already used by this repository.

- [x] **Step 2: Install and lock Astro**

  Run `pnpm install --lockfile-only` after adding `astro` at the current 7.1 patch. Review that the lockfile change is limited to the new importer and Astro dependencies.

- [x] **Step 3: Write the failing public-config tests**

  Test literal behavior:

  ```ts
  expect(readPublicSiteConfig({})).toEqual({ phone: null, demoEndpoint: null });
  expect(readPublicSiteConfig({ PUBLIC_PHONE: "+7 999 123-45-67" }).phone?.href).toBe(
    "tel:+79991234567",
  );
  expect(() => readPublicSiteConfig({ PUBLIC_DEMO_ENDPOINT: "http://markiro.app/leads" })).toThrow(
    "PUBLIC_DEMO_ENDPOINT must use HTTPS",
  );
  ```

- [x] **Step 4: Run RED**

  Run `pnpm --filter @markiro/landing exec vitest run src/lib/site-config.test.ts`. Expected: fail because `site-config.ts` does not exist.

- [x] **Step 5: Implement the minimal config reader**

  Accept only an HTTPS endpoint without embedded credentials. Normalize a Russian phone into a `tel:` href while preserving the configured display string. Missing values remain `null`, so no placeholder contact reaches the rendered page.

- [x] **Step 6: Run GREEN**

  Run the focused test and `pnpm --filter @markiro/landing typecheck`.

### Task 2: Build semantic page structure and custom product scenes

**Files:**

- Create: `apps/landing/src/layouts/BaseLayout.astro`
- Create: `apps/landing/src/components/BrandMark.astro`
- Create: `apps/landing/src/components/LandingHeader.astro`
- Create: `apps/landing/src/components/LineConsole.astro`
- Create: `apps/landing/src/components/ProductionCycle.astro`
- Create: `apps/landing/src/components/ProductModes.astro`
- Create: `apps/landing/src/components/TraceLog.astro`
- Create: `apps/landing/src/components/PlatformModules.astro`
- Create: `apps/landing/src/components/ImplementationSteps.astro`
- Create: `apps/landing/src/components/DemoSection.astro`
- Create: `apps/landing/src/pages/index.astro`
- Create: `apps/landing/src/assets/factory-line.jpg`
- Create: `apps/landing/test/rendered-page.test.ts`

**Interfaces:**

- Consumes: `PublicSiteConfig`, source artboards and factory image.
- Produces: static `/index.html` with one H1, eight labelled sections, real anchors, optional phone contact, and a labelled three-field demo form.

- [x] **Step 1: Write the failing rendered-page contract**

  The test runs the Astro build in a temporary output directory and parses the real generated HTML. Assert one H1, landmark/navigation presence, section IDs, labels for all form controls, no admin screenshot reference, and no placeholder phone.

- [x] **Step 2: Run RED**

  Run `pnpm --filter @markiro/landing exec vitest run test/rendered-page.test.ts`. Expected: fail because the page and build output do not exist.

- [x] **Step 3: Add layout and eight semantic sections**

  Implement the approved copy hierarchy and anchors: hero, continuity, cycle, product modes, traceability, platform, implementation, and demo. Keep all operational meaning in text or semantic lists; illustrative console surfaces use `aria-hidden="true"`.

- [x] **Step 4: Draw the product scenes**

  Build the line console, code verification card, label construction card, and trace log from HTML/CSS. Use deterministic illustrative values (`18 / 24`, `1 248`) and label the surrounding text so they are not mistaken for live customer data.

- [x] **Step 5: Add the hero asset**

  Copy the approved factory image to `src/assets/factory-line.jpg` without altering the source design asset. Render it through Astro's image pipeline with explicit dimensions, responsive AVIF/WebP sources, responsive cropping, eager loading, and high fetch priority only above the fold.

- [x] **Step 6: Run GREEN**

  Run the focused rendered-page test and Astro build.

### Task 3: Implement responsive visual system and approved motion

**Files:**

- Create: `apps/landing/src/styles/landing.css`
- Create: `apps/landing/src/scripts/site.test.ts`
- Create: `apps/landing/src/scripts/site.ts`
- Modify: `apps/landing/src/layouts/BaseLayout.astro`
- Modify: `apps/landing/src/components/LandingHeader.astro`

**Interfaces:**

- Consumes: semantic `data-reveal`, menu, and analytics attributes from components.
- Produces: `initLanding(root, options)` cleanup function and responsive styling at 390, 834, and 1440 reference widths.

- [x] **Step 1: Write failing interaction tests**

  In jsdom, assert that opening the menu sets `aria-expanded=true`, Escape closes it and restores trigger focus, and reveal targets become visible immediately when `matchMedia('(prefers-reduced-motion: reduce)')` matches.

- [x] **Step 2: Run RED**

  Run `pnpm --filter @markiro/landing exec vitest run src/scripts/site.test.ts`. Expected: fail because `site.ts` does not exist.

- [x] **Step 3: Implement the browser initializer**

  Use one `IntersectionObserver`, one delegated click listener for analytics attributes, and explicit cleanup. Do not attach continuous scroll listeners.

- [x] **Step 4: Implement the visual system**

  Import shared tokens, apply `.theme-dark`, define only landing-local display and motion properties, and recreate the industrial grid, photographic hero, green status rails, alternating product panels, and dark form. Use content-driven heights.

- [x] **Step 5: Add responsive and reduced-motion rules**

  Verify the layout changes at 1200 and 768 px breakpoints, minimum 44 px targets, no page-level horizontal overflow, and complete transform/animation removal in reduced-motion mode.

- [x] **Step 6: Run GREEN**

  Run the interaction tests, typecheck, and build.

### Task 4: Implement demo validation and progressive submission

**Files:**

- Create: `apps/landing/src/lib/demo-form.test.ts`
- Create: `apps/landing/src/lib/demo-form.ts`
- Create: `apps/landing/src/scripts/demo-form.test.ts`
- Create: `apps/landing/src/scripts/demo-form.ts`
- Modify: `apps/landing/src/components/DemoSection.astro`
- Modify: `apps/landing/src/scripts/site.ts`

**Interfaces:**

- Consumes: optional HTTPS endpoint and `HTMLFormElement`.
- Produces: `validateDemoLead`, `submitDemoLead`, and `initDemoForm` with explicit idle, invalid, submitting, success, recoverable-error, rate-limit, and unavailable states.

- [x] **Step 1: Write failing validation tests**

  Cover trimmed name/company, Russian phone normalization, empty values, too-short phones, and oversized values with hand-derived expected results.

- [x] **Step 2: Run validation RED**

  Run the focused test. Expected: fail because `demo-form.ts` does not exist.

- [x] **Step 3: Implement and run validation GREEN**

  Return field-specific errors without leaking raw values. Keep the normalized payload separate from display values.

- [x] **Step 4: Write failing submission/controller tests**

  Use a narrow injected fetch function and real DOM form. Assert JSON request shape, duplicate-submit blocking, retained values on recoverable error, `429` guidance, unavailable-endpoint guidance, success replacement, focus movement, and `aria-live` messages.

- [x] **Step 5: Run controller RED**

  Expected: fail because the form controller does not exist.

- [x] **Step 6: Implement submission and controller**

  POST JSON only to the validated endpoint. Treat any non-2xx as failure, map 429 separately, never queue an unsent request, and never send form fields to analytics.

- [x] **Step 7: Run controller GREEN**

  Run all landing tests, typecheck, and build.

### Task 5: Polish metadata, validate responsive output, and complete repository gates

**Files:**

- Create: `apps/landing/public/favicon.svg`
- Create: `apps/landing/public/robots.txt`
- Create: `apps/landing/public/site.webmanifest`
- Modify: `apps/landing/src/layouts/BaseLayout.astro`
- Modify: `apps/landing/src/styles/landing.css`
- Modify: `docs/superpowers/plans/2026-08-14-markiro-landing.md`

**Interfaces:**

- Consumes: built landing and final artboards.
- Produces: buildable package, responsive browser evidence, and a checked implementation plan.

- [x] **Step 1: Add public metadata assets**

  Add Russian title/description, canonical `https://markiro.app/`, theme color,
  favicon, manifest, and conservative production robots directives. Do not add
  unverified organization structured data.

- [x] **Step 2: Run package gates**

  Run `test`, `typecheck`, `lint`, and `build` for `@markiro/landing`, followed
  by `git diff --check` and a focused Prettier check for all new landing files.

- [x] **Step 3: Run browser review**

  Start the landing dev server without changing other app processes. Capture
  390 x 844, 834 x 1112, and 1440 x 1000 screenshots. Compare hierarchy,
  spacing, crop, and product scenes to the source artboards; inspect browser
  console and keyboard behavior.

- [ ] **Step 4: Verify non-happy paths manually**

  Check missing endpoint, invalid fields, reduced motion, menu Escape/focus,
  320 px width, 200% zoom, and a simulated backend error. Do not claim real CRM,
  phone, analytics, DNS, TLS, or production Web Vitals verification.

  Verified invalid fields, missing-endpoint guidance, mobile menu Escape/focus,
  and zero horizontal overflow at 320 px in a live browser. Reduced motion and
  simulated network/server errors are covered by DOM tests. Actual browser-chrome
  200% zoom remains a manual release check.

- [x] **Step 5: Self-review and update plan checkboxes**

  Confirm every handoff requirement maps to implemented code or an explicitly
  listed external gate. Scan for placeholder markers and accidental admin
  screenshot references.
