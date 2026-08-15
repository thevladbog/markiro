# Markiro Legal Source and Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one typed bilingual legal-document source, publish the first legal HTML pages, remove the CRM placeholder copy, and bind the landing/API demo consent to the same immutable document revision.

**Architecture:** A new lightweight `@markiro/legal-documents` workspace package owns operator snapshots, document metadata, bilingual normalized content, lifecycle validation, and the current consent identifier. Astro renders legal HTML directly from that package; the Nest demo service imports only the consent identifier. Downloadable PDF/DOCX generation and Data Matrix verification are delivered by the follow-up artifact plan.

**Tech Stack:** Node.js 24, TypeScript 6, Astro 7, NestJS 11, Vitest 4, JSDOM, ESLint, Prettier.

**Spec:** `docs/superpowers/specs/2026-08-15-legal-document-system-design.md`

## Global Constraints

- The first operator snapshot is Богатырев Владислав Сергеевич, address `353745, Краснодарский край, Ленинградский район, ст. Ленинградская, ул. Грузская, д. 26`, email `hello@v-b.tech`, phone `+7 934 355-14-90`.
- Stable codes are exactly `MKR-PD-01`, `MKR-PD-02`, `MKR-DPA-01`, and `MKR-BRD-01`; the first revision is `2026.08.01`, effective `2026-08-15`.
- Russian is authoritative; English is an informational translation with the same code and revision.
- The current form consent identifier is exactly `MKR-PD-02/2026.08.01` and is at most 64 characters.
- No marketing, analytics, profiling, CRM forwarding, lead enrichment, arbitrary URL, or new form field is added.
- The tenant is operator for employee-data purposes it determines; Markiro is processor under written instruction and does not disclaim its own confidentiality, security, incident, assistance, or deletion duties.
- The one-year business correspondence boundary is stated separately from existing shorter encrypted mail-delivery retention.
- Legal HTML is public in both enabled and disabled form builds.
- Form disabled copy says only that online submission is temporarily unavailable; it does not mention CRM or unapproved internal dependencies.
- This phase does not claim legal review, Roskomnadzor filing, provider-contract validation, PDF/A conformance, physical barcode acceptance, or live form delivery.
- Use exact dependency versions and `workspace:*` for internal packages. Do not edit applied migrations or unrelated landing/product code.

---

### Task 1: Create the typed legal registry package

**Files:**

- Create: `packages/legal-documents/package.json`
- Create: `packages/legal-documents/tsconfig.json`
- Create: `packages/legal-documents/tsconfig.test.json`
- Create: `packages/legal-documents/src/types.ts`
- Create: `packages/legal-documents/src/operator.ts`
- Create: `packages/legal-documents/src/registry.ts`
- Create: `packages/legal-documents/src/index.ts`
- Create: `packages/legal-documents/test/registry.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes: no application package; only repository-authored trusted source data.
- Produces:

```ts
export type LegalLocale = "ru" | "en";
export type LegalDocumentCode = "MKR-PD-01" | "MKR-PD-02" | "MKR-DPA-01" | "MKR-BRD-01";
export type LegalDocumentStatus = "draft" | "active" | "superseded" | "withdrawn";
export type LegalBlock =
  | { readonly kind: "paragraph"; readonly text: string }
  | { readonly kind: "ordered-list" | "unordered-list"; readonly items: readonly string[] }
  | {
      readonly kind: "definition-list";
      readonly items: readonly { term: string; detail: string }[];
    };

export interface LegalDocumentLocaleContent {
  readonly locale: LegalLocale;
  readonly title: string;
  readonly summary: string;
  readonly sections: readonly {
    readonly id: string;
    readonly heading: string;
    readonly blocks: readonly LegalBlock[];
  }[];
}

export interface LegalDocumentRelease {
  readonly code: LegalDocumentCode;
  readonly revision: `${number}.${number}.${number}`;
  readonly effectiveDate: `${number}-${number}-${number}`;
  readonly status: LegalDocumentStatus;
  readonly operatorProfileId: "operator-2026-08-15";
  readonly routes: Readonly<Record<LegalLocale, `/${string}/`>>;
  readonly supersedes?: `${LegalDocumentCode}/${number}.${number}.${number}`;
}

export const CURRENT_DEMO_CONSENT_ID = "MKR-PD-02/2026.08.01" as const;
export function validateLegalRegistry(releases: readonly LegalDocumentRelease[]): void;
export function findLegalRelease(code: LegalDocumentCode, revision?: string): LegalDocumentRelease;
```

- `package.json` exports `.` from compiled `dist/index.js`; `docx` and artifact-generation dependencies are not added in this task.

- [ ] **Step 1: Write the failing registry tests**

Create the package metadata/tsconfig/test harness without production source,
then add table-driven tests that assert the exact first release keys, operator
snapshot, revision grammar, locale route parity, route uniqueness, and consent
constant:

```ts
expect(LEGAL_RELEASES.map(({ code }) => code)).toEqual([
  "MKR-PD-01",
  "MKR-PD-02",
  "MKR-DPA-01",
  "MKR-BRD-01",
]);
expect(OPERATOR_PROFILES["operator-2026-08-15"]).toEqual({
  name: "Богатырев Владислав Сергеевич",
  address:
    "353745, Краснодарский край, Ленинградский район, ст. Ленинградская, ул. Грузская, д. 26",
  email: "hello@v-b.tech",
  phone: "+7 934 355-14-90",
  site: "https://markiro.app",
});
expect(CURRENT_DEMO_CONSENT_ID).toBe("MKR-PD-02/2026.08.01");
```

Mutation cases must reject duplicate code/revision, duplicate route, invalid code, invalid calendar revision, invalid ISO date, missing RU/EN pair, mismatched locale marker, two active releases for one code, `supersedes` pointing forward/unknown, and an active consent release inconsistent with `CURRENT_DEMO_CONSENT_ID`.

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```bash
corepack pnpm --filter @markiro/legal-documents test
```

Expected: package is selected and the test import fails because the registry
source does not exist.

- [ ] **Step 3: Add the package and minimal validator**

Use pure deterministic validation. Parse revisions with
`/^(\d{4})\.(0[1-9]|1[0-2])\.(0[1-9]|[1-9]\d)$/`, validate dates by round-tripping
`new Date(`${value}T00:00:00.000Z`)`, reject unexpected external routes, and
build keys with `${code}/${revision}`. Do not use broad casts or `any`.

The operator profile is immutable and referenced by id from each release so a
future legal-form change creates a new snapshot without rewriting archived
metadata.

- [ ] **Step 4: Run package gates to verify GREEN**

Run:

```bash
corepack pnpm --filter @markiro/legal-documents test
corepack pnpm --filter @markiro/legal-documents typecheck
corepack pnpm --filter @markiro/legal-documents lint
corepack pnpm --filter @markiro/legal-documents build
```

Expected: all pass with no skipped tests.

- [ ] **Step 5: Commit the registry boundary**

```bash
git add packages/legal-documents pnpm-lock.yaml
git commit -m "feat(legal): add typed document registry"
```

---

### Task 2: Add the complete bilingual legal source drafts

**Files:**

- Create: `packages/legal-documents/src/documents/privacy.ts`
- Create: `packages/legal-documents/src/documents/consent.ts`
- Create: `packages/legal-documents/src/documents/tenant-processing.ts`
- Create: `packages/legal-documents/src/documents/brand-letterhead.ts`
- Create: `packages/legal-documents/test/content-contract.test.ts`
- Modify: `packages/legal-documents/src/registry.ts`

**Interfaces:**

- Consumes: `LegalDocumentLocaleContent`, `LegalDocumentRelease`, the first
  operator snapshot, and exact ids from Task 1.
- Produces four complete RU/EN normalized documents with stable section ids used
  by HTML and later DOCX/PDF rendering:

```ts
export interface LegalDocumentSource {
  readonly releaseKey: `${LegalDocumentCode}/${number}.${number}.${number}`;
  readonly content: Readonly<Record<LegalLocale, LegalDocumentLocaleContent>>;
}
export const LEGAL_DOCUMENTS: readonly LegalDocumentSource[];
export function findLegalDocument(code: LegalDocumentCode, revision?: string): LegalDocumentSource;
```

- [ ] **Step 1: Write failing content-contract tests**

Assert exact required section ids rather than weak substring counts:

```ts
expect(sectionIds("MKR-PD-01", "ru")).toEqual([
  "general",
  "principles",
  "subjects-and-data",
  "purposes-and-bases",
  "operations",
  "retention-and-destruction",
  "processors",
  "localization-and-transfer",
  "security-and-incidents",
  "subject-rights",
  "cookies-and-captcha",
  "tenant-data",
  "revisions",
]);
expect(sectionIds("MKR-PD-02", "ru")).toEqual([
  "operator",
  "data-and-purposes",
  "operations-and-processors",
  "term-and-withdrawal",
  "confirmation",
]);
```

Pin absence of claims and forbidden purposes:

```ts
for (const text of allPublicLegalText()) {
  expect(text).not.toMatch(
    /уведомлени[ея] подан|в реестре Роскомнадзора|сертифицирован[а-я]* Markiro/i,
  );
  expect(text).not.toMatch(/соглас(?:ен|ие).{0,40}(?:маркетинг|рассылк)|переда(?:м|ча).{0,40}CRM/i);
  expect(text).not.toContain("TODO");
}
```

Pin the exact one-year boundary, `hello@v-b.tech`, operator address, named
SmartCaptcha technical categories, Russian-database statement, intended absence
of cross-border transfer, the Russian-authoritative disclaimer, and tenant/
processor duties from the spec.

- [ ] **Step 2: Run the content tests to verify RED**

Run:

```bash
corepack pnpm --filter @markiro/legal-documents exec vitest run test/content-contract.test.ts
```

Expected: FAIL because the documents and sections are absent.

- [ ] **Step 3: Write the Russian source drafts**

Write complete prose, not fragments or placeholders. The policy must state the
actual demo fields (`name`, `company`, `email`, optional `phone`, source path,
request UUID, consent id, bounded captcha/anti-abuse technical data), the exact
purposes, one-year correspondence retention, existing shorter encrypted mail
retention, subject request/withdrawal routes, Russian storage boundary, no
intended cross-border transfer, no analytics/marketing/profiling/CRM forwarding,
and the processor services actually confirmed before release.

The consent must be a standalone first-person grant, not a policy summary. It
must name the operator/address, fields, purposes, operations, processors,
one-year term, withdrawal channels, and exact code/revision.

The tenant template must separately enumerate:

```text
Tenant/operator: legal basis, employee notice/consent, purpose and scope,
accuracy, documented instructions, and subject-request decisions.

Markiro/processor: instruction-only processing, confidentiality, security,
subprocessor control, incident notice, evidence, assistance, and return/deletion.

Markiro/independent operator: only separately stated billing, platform security,
abuse response, and statutory records for purposes Markiro determines itself.
```

The brand letterhead content is only usage instructions and the exact
`ШАБЛОН / TEMPLATE — НЕ ЯВЛЯЕТСЯ ДЕЙСТВУЮЩИМ ДОКУМЕНТОМ` warning.

- [ ] **Step 4: Add the matched English informational translations**

Keep identical section ids and legal facts. Begin each English document with an
unambiguous statement that the Russian revision is authoritative. Do not
translate the Russian operator name/address into different legal identity data.

- [ ] **Step 5: Run content and package gates to verify GREEN**

Run:

```bash
corepack pnpm --filter @markiro/legal-documents test
corepack pnpm --filter @markiro/legal-documents typecheck
corepack pnpm --filter @markiro/legal-documents lint
corepack pnpm --filter @markiro/legal-documents build
```

Expected: all pass. Record that automated assertions establish structure and
declared facts, not legal correctness or translation quality.

- [ ] **Step 6: Commit the source drafts**

```bash
git add packages/legal-documents/src/documents packages/legal-documents/src/registry.ts packages/legal-documents/test/content-contract.test.ts
git commit -m "feat(legal): add bilingual document sources"
```

---

### Task 3: Publish the legal registry and reading pages in Astro

**Files:**

- Modify: `apps/landing/package.json`
- Modify: `apps/landing/src/layouts/BaseLayout.astro`
- Modify: `apps/landing/src/components/HomePage.astro`
- Modify: `apps/landing/src/components/SeoArticle.astro`
- Modify: `apps/landing/src/components/LandingHeader.astro`
- Modify: `apps/landing/src/components/LandingFooter.astro`
- Create: `apps/landing/src/components/LegalDocument.astro`
- Create: `apps/landing/src/components/LegalRegistry.astro`
- Create: `apps/landing/src/content/legal-pages.ts`
- Create: `apps/landing/src/pages/legal/index.astro`
- Create: `apps/landing/src/pages/privacy/index.astro`
- Create: `apps/landing/src/pages/personal-data-consent/index.astro`
- Create: `apps/landing/src/pages/legal/tenant-data-processing/index.astro`
- Create: `apps/landing/src/pages/legal/brand-letterhead/index.astro`
- Create: `apps/landing/src/pages/en/legal/index.astro`
- Create: `apps/landing/src/pages/en/privacy/index.astro`
- Create: `apps/landing/src/pages/en/personal-data-consent/index.astro`
- Create: `apps/landing/src/pages/en/legal/tenant-data-processing/index.astro`
- Create: `apps/landing/src/pages/en/legal/brand-letterhead/index.astro`
- Modify: `apps/landing/src/styles/landing.css`
- Create: `apps/landing/test/legal-rendered-page.test.ts`

**Interfaces:**

- Consumes: `LEGAL_RELEASES`, `LEGAL_DOCUMENTS`, `findLegalRelease()`,
  `findLegalDocument()`, `LegalBlock`, and operator snapshots from Tasks 1–2.
- Produces: ten bilingual public HTML routes, stable heading anchors, locale alternates, visible status/code/revision/effective date. Production pages must not render broken download links before artifacts exist.

- [ ] **Step 1: Write failing rendered-page tests**

Build the real Astro site in a temporary directory and assert every route has:

```ts
expect(document.querySelectorAll("h1")).toHaveLength(1);
expect(document.querySelector("[data-legal-code]")?.textContent).toContain("MKR-");
expect(document.querySelector("[data-legal-revision]")?.textContent).toContain("2026.08.01");
expect(document.querySelector("main#main article[data-legal-document]")).not.toBeNull();
expect(document.querySelector('a[hreflang="ru"]')).not.toBeNull();
expect(document.querySelector('a[hreflang="en"]')).not.toBeNull();
```

Assert the registry contains all four codes once per locale, the English pages
show the authoritative-Russian notice, released HTML contains no draft marker,
and operator address/email/phone render as text with accessible mail/tel links.

- [ ] **Step 2: Run the test to verify RED**

Run:

```bash
corepack pnpm --filter @markiro/legal-documents build
corepack pnpm --filter @markiro/landing exec vitest run test/legal-rendered-page.test.ts
```

Expected: FAIL with missing routes/components.

- [ ] **Step 3: Generalize page metadata without weakening existing SEO**

Extract a narrow `PageMetadata` interface accepted by `BaseLayout`; pass JSON-LD
as a separate required prop so the layout never guesses a page kind:

```ts
interface PageMetadata {
  path: string;
  alternatePath: string;
  locale: "ru" | "en";
  title: string;
  description: string;
  socialImage: string;
  socialImageAlt: string;
}
```

Keep all existing canonical, hreflang, manifest, Open Graph, and JSON-LD output.
`HomePage` and `SeoArticle` pass `buildPageGraph(page)` explicitly. Legal
components pass their legal `WebPage` graph explicitly. Narrow
`LandingHeader`/`LandingFooter` props to the locale/path/alternate fields they
actually consume. Do not make `SeoPageDefinition` fields optional
repository-wide and do not cast legal metadata to `SeoPageDefinition`.

- [ ] **Step 4: Implement semantic legal components and compact layout**

Render each `LegalBlock` to semantic `<p>`, `<ol>`, `<ul>`, or `<dl>`. Use the
approved compact C visual system: real `BrandMark`, status pill, code/revision
line, readable 65–75 character measure, sticky table of contents only when it
does not obscure 390 px content, and existing focus/color tokens.

The registry is a list/table that remains readable at 390 px without page-level
horizontal overflow. Continue pages on the web do not imitate paper page
breaks. Do not render a fake Data Matrix or artifact hash before the artifact
plan creates real output.

- [ ] **Step 5: Add stable routes and footer discovery**

Use explicit route files listed above. Add localized footer links to the legal
registry, privacy policy, and data consent. Keep marketing navigation unchanged.

- [ ] **Step 6: Run landing focused and package gates**

Run:

```bash
corepack pnpm --filter @markiro/landing exec vitest run test/legal-rendered-page.test.ts test/rendered-page.test.ts
corepack pnpm --filter @markiro/landing test
corepack pnpm --filter @markiro/landing typecheck
corepack pnpm --filter @markiro/landing lint
corepack pnpm --filter @markiro/landing build
corepack pnpm --filter @markiro/landing run audit
```

Expected: all pass and the build reports 26 routes before artifact verification
routes are added.

- [ ] **Step 7: Commit the HTML publication surface**

```bash
git add apps/landing/package.json apps/landing/src/layouts/BaseLayout.astro apps/landing/src/components/HomePage.astro apps/landing/src/components/SeoArticle.astro apps/landing/src/components/LandingHeader.astro apps/landing/src/components/LandingFooter.astro apps/landing/src/components/LegalDocument.astro apps/landing/src/components/LegalRegistry.astro apps/landing/src/content/legal-pages.ts apps/landing/src/pages apps/landing/src/styles/landing.css apps/landing/test/legal-rendered-page.test.ts pnpm-lock.yaml
git commit -m "feat(landing): publish bilingual legal pages"
```

---

### Task 4: Bind demo consent to the shared legal release

**Files:**

- Modify: `apps/landing/src/lib/site-config.ts`
- Modify: `apps/landing/src/lib/site-config.test.ts`
- Modify: `apps/landing/src/components/HomePage.astro`
- Modify: `apps/landing/src/components/DemoSection.astro`
- Modify: `apps/landing/src/content/ui.ts`
- Modify: `apps/landing/test/rendered-page.test.ts`
- Modify: `apps/landing/src/scripts/demo-form.test.ts`
- Modify: `apps/api/package.json`
- Modify: `apps/api/src/env.ts`
- Modify: `apps/api/src/modules/demo-requests/demo-request.service.ts`
- Modify: `apps/api/src/modules/demo-requests/demo-requests.module.ts`
- Modify: `apps/api/test/mail-env.test.ts`
- Modify: `apps/api/test/demo-request.service.test.ts`
- Modify: `apps/api/test/demo-request-pipeline.e2e.test.ts`
- Modify: `.env.example`
- Modify: `.env.production.example`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes: `CURRENT_DEMO_CONSENT_ID`, `/privacy/`, and `/personal-data-consent/` from `@markiro/legal-documents`.
- Produces: a form payload and API comparison using exactly `MKR-PD-02/2026.08.01`; removes `PUBLIC_DEMO_CONSENT_VERSION`, `PUBLIC_PRIVACY_POLICY_PATH`, `PUBLIC_PERSONAL_DATA_CONSENT_PATH`, and `LANDING_DEMO_CONSENT_VERSION` as configuration inputs.

- [ ] **Step 1: Write failing landing and API tests**

Change enabled landing expectations to:

```ts
expect(config.consentVersion).toBe("MKR-PD-02/2026.08.01");
expect(config.legalLinks).toEqual({
  consent: "/personal-data-consent/",
  privacy: "/privacy/",
});
```

Assert unknown environment values cannot override those fields. Change the API
service test so the constructor no longer accepts `consentVersion`; a payload
with `MKR-PD-02/2026.08.01` reaches captcha/repository and old `2026-08-14`
returns `invalid_request` before captcha.

Assert disabled RU and EN builds contain no “CRM”, “подключения CRM”, or
“connection to the CRM” text.

- [ ] **Step 2: Run focused tests to verify RED**

Run:

```bash
corepack pnpm --filter @markiro/legal-documents build
corepack pnpm --filter @markiro/landing exec vitest run src/lib/site-config.test.ts test/rendered-page.test.ts src/scripts/demo-form.test.ts
corepack pnpm --filter @markiro/api exec vitest run test/mail-env.test.ts test/demo-request.service.test.ts
```

Expected: FAIL on env-driven consent/legal links and the CRM placeholder.

- [ ] **Step 3: Make the landing derive legal contract values**

When `PUBLIC_DEMO_SUBMISSION_ENABLED=true`, require only the public captcha key;
derive legal links and consent id from the package. Keep disabled mode from
emitting captcha, endpoint, or consent runtime data.

Use exact checkbox copy:

```text
RU: Даю согласие на обработку персональных данных на условиях согласия и подтверждаю, что ознакомился с политикой обработки персональных данных.
EN: I consent to the processing of my personal data under the personal-data consent and confirm that I have read the personal-data processing policy.
```

Keep “согласия”/“personal-data consent” and “политикой”/“policy” as separate
links. Replace disabled copy with `Онлайн-отправка временно недоступна. Напишите нам на hello@v-b.tech.` and its English equivalent; do not hard-code the email in multiple components—source it from the legal operator profile.

- [ ] **Step 4: Make the API compare the shared identifier**

Import `CURRENT_DEMO_CONSENT_ID` in the service or module and compare it after
the limiter/honeypot checks in the existing order. Remove the consent env field,
conditional validation, examples, and test fixtures. Keep enabled-mode
requirements for origin, recipient, reply-to, and SmartCaptcha server key.

- [ ] **Step 5: Rebuild dependencies and verify GREEN**

Run:

```bash
corepack pnpm --filter @markiro/legal-documents build
corepack pnpm --filter @markiro/landing test
corepack pnpm --filter @markiro/landing typecheck
corepack pnpm --filter @markiro/api exec vitest run test/mail-env.test.ts test/demo-request.service.test.ts test/demo-request-pipeline.e2e.test.ts
corepack pnpm --filter @markiro/api typecheck
```

Expected: focused tests pass. If the pipeline test skips without a configured
scratch database, report the skip and rerun it in Task 6 using a uniquely named
scratch DB.

- [ ] **Step 6: Commit the shared consent contract**

```bash
git add apps/landing apps/api/package.json apps/api/src/env.ts apps/api/src/modules/demo-requests apps/api/test/mail-env.test.ts apps/api/test/demo-request.service.test.ts apps/api/test/demo-request-pipeline.e2e.test.ts .env.example .env.production.example pnpm-lock.yaml
git commit -m "feat(landing): bind requests to legal consent revision"
```

---

### Task 5: Add legal SEO, sitemap, audit, and browser coverage

**Files:**

- Modify: `apps/landing/src/content/pages.ts`
- Modify: `apps/landing/src/lib/seo.ts`
- Modify: `apps/landing/src/lib/seo.test.ts`
- Modify: `apps/landing/src/lib/audit.ts`
- Modify: `apps/landing/src/lib/audit.test.ts`
- Modify: `apps/landing/src/pages/sitemap.xml.ts`
- Modify: `apps/landing/src/pages/llms.txt.ts`
- Modify: `apps/landing/test/site-audit.test.ts`
- Modify: `tools/production-browser/tests/landing.spec.ts`

**Interfaces:**

- Consumes: public non-draft legal routes and metadata from the registry.
- Produces: sitemap/LLM discovery, canonical/hreflang coverage, and desktop/Pixel 7 checks for the legal pages.

- [ ] **Step 1: Write failing SEO/audit tests**

Assert active RU/EN legal routes appear exactly once in the sitemap and
`llms.txt`, `lastmod` equals the effective date, and each pair has reciprocal
alternates. Add audit findings for a legal page missing code, revision,
effective date, authoritative-language link, or registry backlink.

Do not put future individual `/d/<id>` routes in sitemap/LLM output.

- [ ] **Step 2: Run focused tests to verify RED**

```bash
corepack pnpm --filter @markiro/landing exec vitest run src/lib/seo.test.ts src/lib/audit.test.ts test/site-audit.test.ts
```

Expected: FAIL because legal routes are not included in discovery/audit models.

- [ ] **Step 3: Extend SEO and audit from the legal registry**

Build one combined list of indexable page records rather than copying legal
paths into sitemap and `llms.txt` separately. Add `WebPage` JSON-LD with
`datePublished`, `dateModified`, `inLanguage`, and `isBasedOn` for English
translations; do not claim `DigitalDocument` signatures or certification.

- [ ] **Step 4: Add browser assertions**

For desktop and Pixel 7, visit the ten legal routes and assert one H1, no page
overflow, visible focus on registry/download links, working locale switch,
working heading anchors, no console errors, and no form/SmartCaptcha script on
legal-only routes when the form build is disabled.

- [ ] **Step 5: Run landing gates and direct browser suite**

```bash
corepack pnpm --filter @markiro/landing test
corepack pnpm --filter @markiro/landing typecheck
corepack pnpm --filter @markiro/landing lint
corepack pnpm --filter @markiro/landing build
corepack pnpm --filter @markiro/landing run audit
corepack pnpm test:landing:browser
```

If the canonical wrapper fails before Playwright because of the known pnpm
11.10/11.18 nested-workspace mismatch, record that exact infrastructure error
and run the repository-established direct Playwright binary once; do not call
the wrapper green.

- [ ] **Step 6: Commit legal discovery coverage**

```bash
git add apps/landing/src/content/pages.ts apps/landing/src/lib apps/landing/src/pages/sitemap.xml.ts apps/landing/src/pages/llms.txt.ts apps/landing/test tools/production-browser/tests/landing.spec.ts
git commit -m "test(landing): cover legal discovery and pages"
```

---

### Task 6: Run the phase-one integration gate and hand off for legal review

**Files:**

- Modify if required by verified findings only: files owned by Tasks 1–5
- Create: `docs/reviews/2026-08-15-legal-source-and-pages.md`

**Interfaces:**

- Consumes: the completed phase-one package, landing, and API changes.
- Produces: an evidence report that clearly separates automated structure checks from external legal approval and production enablement.

- [ ] **Step 1: Run package gates in dependency order**

```bash
corepack pnpm --filter @markiro/legal-documents test
corepack pnpm --filter @markiro/legal-documents typecheck
corepack pnpm --filter @markiro/legal-documents lint
corepack pnpm --filter @markiro/legal-documents build
corepack pnpm --filter @markiro/landing test
corepack pnpm --filter @markiro/landing typecheck
corepack pnpm --filter @markiro/landing lint
corepack pnpm --filter @markiro/landing build
corepack pnpm --filter @markiro/landing run audit
corepack pnpm --filter @markiro/api test
corepack pnpm --filter @markiro/api typecheck
corepack pnpm --filter @markiro/api lint
corepack pnpm --filter @markiro/api build
corepack pnpm format:check
git diff --check
```

Load only the repository development environment and use a uniquely named
scratch database for DB-backed API tests. Apply migrations to that scratch DB,
run the tests, then drop only that exact scratch DB and verify it is absent.
Never modify/reset the shared development database.

- [ ] **Step 2: Review the final diff for privacy and scope**

Confirm there is no new form field, analytics id, UTM/referrer/query capture,
cookie banner, marketing wording, CRM forwarding, provider secret, fake
signature/seal, or claim that the Roskomnadzor notification exists.

- [ ] **Step 3: Write the evidence report**

Record exact commands/results, skipped tests, browser evidence, route count,
and primary errors. List these as still unproved: legal correctness, external
lawyer review, translation quality, provider legal names/contracts, Russian
storage location, Roskomnadzor filing, PDF/A/DOCX/Data Matrix, live DNS/TLS,
SmartCaptcha, Postbox sender identity, and real email delivery.

- [ ] **Step 4: Commit the phase-one report**

```bash
git add docs/reviews/2026-08-15-legal-source-and-pages.md
git commit -m "docs: record legal page verification"
```

- [ ] **Step 5: Stop at the review checkpoint**

Provide the RU source drafts and their exact revision to the user/legal reviewer.
Do not enable the production form in this phase. Proceed to
`docs/superpowers/plans/2026-08-15-legal-artifacts-and-publication.md` only after
the source wording is accepted for publication.
