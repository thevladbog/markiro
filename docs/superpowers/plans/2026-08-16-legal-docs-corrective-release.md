# Legal Documents Corrective Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the one-time corrected current legal release as revision `2026.08/01`, repair all localized date, language, document-layout, and legal-site presentation defects, and preserve exact legacy verification redirects without enabling the public lead form.

**Architecture:** Add one canonical identity/presentation module to `@markiro/legal-documents`; every artifact, HTML page, verification route, filename, Data Matrix, and consent consumer derives from it. Regenerate the complete atomic legal artifact root and trusted PDF attestation, then make the landing consume the regenerated contract. Keep machine dates ISO inside manifests, but format every visible value by locale.

**Tech Stack:** TypeScript 6, Vitest 4, Astro 7, docx 9, LibreOffice 26.2.5, veraPDF 1.30.2, Poppler, Playwright, Caddy 2.11.

**Spec:** `docs/superpowers/specs/2026-08-16-legal-docs-corrective-release-design.md`

## Global Constraints

- This is the explicitly authorized one-time correction of `2026.08.01` to `2026.08/01`; do not create `/02` or retain the old value as a second registry release.
- Keep the structured effective date as `2026-08-15`; format it only at presentation boundaries.
- Keep `PUBLIC_DEMO_SUBMISSION_ENABLED=false` and do not change captcha, SMTP, CRM, analytics, form fields, operator identity, legal basis, or retention semantics.
- Write a focused failing test before each production change and capture the exact RED reason.
- Never hand-edit generated PDFs, DOCX ZIP contents, `artifacts.json`, or the attestation. Regenerate them through the pinned pipeline.
- Immediately before the first DOCX edit/generation operation, follow the `documents:documents` marker requirement. Immediately before the first PDF generation/edit operation, follow the `pdf:pdf` marker requirement.
- Preserve the publication lock, atomic directory replacement, PDF/A validation, font embedding, full-text equivalence, symlink defenses, and deterministic normalization from the existing generator.
- Stage only the files named in the current task and inspect `git diff --cached` before every commit.

---

## Task 1: Make legal identity and localized display a single typed contract

**Interfaces**

```ts
export type LegalRevision = `${number}.${number}/${number}`;

export interface LegalRevisionParts {
  readonly yearMonth: `${number}.${number}`;
  readonly sequence: `${number}`;
}

export function parseLegalRevision(value: string): LegalRevisionParts;
export function legalRevisionFileToken(value: LegalRevision): `${number}.${number}-${number}`;
export function formatLegalEffectiveDate(value: string, locale: LegalLocale): string;
export function legalVerificationPath(
  release: LegalIdentity,
): `/d/${string}/${string}/${string}/${string}`;
export function legalVerificationUrl(
  release: LegalIdentity,
): `https://markiro.app/d/${string}/${string}/${string}/${string}`;
```

**Files**

- Create: `packages/legal-documents/src/identity.ts`
- Modify: `packages/legal-documents/src/types.ts`
- Modify: `packages/legal-documents/src/registry.ts`
- Modify: `packages/legal-documents/src/index.ts`
- Modify: `packages/legal-documents/test/registry.test.ts`
- Modify: `packages/legal-documents/test/content-contract.test.ts`
- Modify: `apps/api/test/demo-request.service.test.ts`
- Modify: `apps/api/test/demo-request.e2e.test.ts`
- Modify: `apps/api/test/demo-request-pipeline.e2e.test.ts`

- [ ] Add registry tests that accept exactly `2026.08/01`, reject date-shaped `2026.08.01`, reject non-two-digit and out-of-range sequences, and prove the active consent ID is `MKR-PD-02/2026.08/01`.
- [ ] Add table tests for RU `15.08.2026`, EN `15 August 2026`, filename token `2026.08-01`, and exact verification path `/d/MKR-PD-01/2026.08/01/15.08.2026`.
- [ ] Run RED:

```bash
corepack pnpm --filter @markiro/legal-documents exec vitest run test/registry.test.ts test/content-contract.test.ts
corepack pnpm --filter @markiro/api exec vitest run test/demo-request.service.test.ts
```

Expected RED: the old calendar-revision type and validator reject slash revisions; display and route helpers are absent; consent still expects `2026.08.01`.

- [ ] Implement `identity.ts` without `Date` locale dependence. Parse ISO dates with an exact regular expression, validate the UTC calendar date, and use fixed month names for EN.
- [ ] Change `LegalDocumentRelease.revision`, `LegalDocumentSource.releaseKey`, and `supersedes` to `LegalRevision`-based template types.
- [ ] Replace all four current registry/source keys and `CURRENT_DEMO_CONSENT_ID` with `2026.08/01`; update API fixtures that assert the shared consent boundary without weakening the service check.
- [ ] Export the identity helpers from the root package so API and landing consumers cannot invent their own formatting.
- [ ] Run GREEN with the two commands above, then:

```bash
corepack pnpm --filter @markiro/legal-documents typecheck
corepack pnpm --filter @markiro/legal-documents lint
corepack pnpm --filter @markiro/legal-documents build
corepack pnpm --filter @markiro/api typecheck
```

- [ ] Review that ISO dates remain stored, revision comparison is numeric rather than lexical, and no public formatter can emit ISO for RU.
- [ ] Commit: `feat(legal): normalize revision and date identity`

---

## Task 2: Normalize bilingual legal language and definition punctuation

**Files**

- Modify: `packages/legal-documents/src/documents/privacy.ts`
- Modify: `packages/legal-documents/src/documents/consent.ts`
- Modify: `packages/legal-documents/src/documents/tenant-processing.ts`
- Modify: `packages/legal-documents/src/documents/brand-letterhead.ts`
- Modify: `packages/legal-documents/test/content-contract.test.ts`

- [ ] Add contract helpers that flatten each RU/EN document in source order and identify definition-list entries independently of prose.
- [ ] Add failing assertions that every RU document's first substantive product mention is exactly `Маркиро (англ. — Markiro)`, all later substantive mentions use `Маркиро`, and no standalone `Markiro` remains in RU prose.
- [ ] Add failing assertions that EN prose contains `Markiro` and contains no `Маркиро`.
- [ ] Add failing assertions that every definition item renders semantically as `term — detail`, while source `term` values do not end in punctuation.
- [ ] Update revision/effective-date prose to `2026.08/01`, `15.08.2026` in RU, and `15 August 2026` in EN.
- [ ] Run RED:

```bash
corepack pnpm --filter @markiro/legal-documents exec vitest run test/content-contract.test.ts
```

Expected RED: current RU content uses standalone `Markiro`, definition rendering expects a period, and visible dates use old/ISO forms.

- [ ] Edit only the affected content strings. Do not change legal meaning, actors, data inventory, purposes, processors, retention, RKN-risk wording, or tenant responsibilities.
- [ ] Use the exact first-use phrase once per RU document; preserve `markiro.app`, codes, URLs, `SmartCaptcha`, and other machine/service names.
- [ ] Run GREEN and full package static checks:

```bash
corepack pnpm --filter @markiro/legal-documents exec vitest run test/content-contract.test.ts
corepack pnpm --filter @markiro/legal-documents typecheck
corepack pnpm --filter @markiro/legal-documents lint
```

- [ ] Read all eight localized sources end-to-end and confirm that the automated brand scan has not produced unnatural Russian.
- [ ] Commit: `fix(legal): normalize bilingual legal wording`

---

## Task 3: Repair DOCX/PDF header, metadata, footer, and definition rendering

**Interfaces**

```ts
interface LegalDocumentDisplay {
  readonly revision: LegalRevision;
  readonly effectiveDate: string;
  readonly verificationUrl: string;
}

// Header right cell is a one-line identity row.
// Metadata owns the only visible full verification URL.
// Footer owns Data Matrix + code + revision + localized date + page only.
```

**Files**

- Modify: `packages/legal-documents/src/artifacts/docx.ts`
- Modify: `packages/legal-documents/test/docx.test.ts`

- [ ] Read the complete `documents:documents` edit/render instructions and load the workspace dependency runtime before authoring DOCX changes.
- [ ] Add XML-level failing tests for a two-column compact header with one no-wrap identity paragraph containing class, code, and revision; assert the wordmark/title geometry does not use newline positioning.
- [ ] Add failing tests that the metadata table contains localized revision/effective date plus `Проверка редакции` / `Revision verification` and the full URL.
- [ ] In footer XML, assert exact presence of Data Matrix, code, revision, localized effective date, page field, and exact absence of the human-readable URL.
- [ ] Add failing tests that definition runs contain `—` after the bold term and never use a period followed by a space after `${term}`.
- [ ] Add geometry assertions for compact maximum header/footer row heights, vertical centering, explicit cell padding, and no exact-height metadata rows.
- [ ] Run RED:

```bash
corepack pnpm --filter @markiro/legal-documents exec vitest run test/docx.test.ts
```

Expected RED: the current header inserts a newline before code/revision, metadata lacks verification URL, footer contains the URL and ISO date, and definition lists render a period.

- [ ] Immediately before the first document edit/generation operation, run the required artifact-operation marker exactly once for the expected DOCX output count and `docx` format.
- [ ] Refactor `createHeader` into an aligned logo cell and one-line right identity cell. Use fixed widths and smaller approved mono spacing; do not shrink body typography.
- [ ] Add the verification metadata row with a wide value cell and deliberate word wrapping. Format dates through the shared helper.
- [ ] Refactor the footer to two centered cells, remove the URL run, and keep page label/field on the same line as the compact identity.
- [ ] Render definition entries as bold term, normal em dash, detail.
- [ ] Run GREEN and independent ZIP integrity checks through the existing test suite:

```bash
corepack pnpm --filter @markiro/legal-documents exec vitest run test/docx.test.ts
corepack pnpm --filter @markiro/legal-documents test
corepack pnpm --filter @markiro/legal-documents typecheck
corepack pnpm --filter @markiro/legal-documents lint
corepack pnpm --filter @markiro/legal-documents build
```

- [ ] Inspect generated XML for URL absence in both first/default footers and URL presence in first-page body metadata only.
- [ ] Commit: `fix(legal): compact document furniture`

---

## Task 4: Regenerate the corrected atomic artifact release and attestation

**Files**

- Modify: `packages/legal-documents/src/artifacts/names.ts`
- Modify: `packages/legal-documents/src/cli/generate-artifacts.ts`
- Modify: `packages/legal-documents/src/cli/verify-artifacts.ts`
- Modify: `packages/legal-documents/test/artifact-manifest.test.ts`
- Replace generated tree: `apps/landing/public/legal/`
- Regenerate: `deploy/production/legal-artifacts-attestation.json`
- Modify: `deploy/production/test/legal-artifact-attestation.test.mjs`

- [ ] Add failing name tests for `markiro_mkr-pd-01_2026.08-01_ru.pdf` and safe DOCX equivalents; reject filenames containing revision slashes.
- [ ] Add failing generator/verifier tests that request URLs come only from `legalVerificationUrl`, manifest revision remains `2026.08/01`, effective date remains ISO, and the complete set is still exactly 12 artifacts / 8 PDF files.
- [ ] Add failing attestation tests for release ID `MKR-LEGAL-2026.08-01-2026-08-15`, the new PDF names, exact manifest digest, and rejection of every old filename.
- [ ] Run RED:

```bash
corepack pnpm --filter @markiro/legal-documents exec vitest run test/docx.test.ts test/artifact-manifest.test.ts
node --test deploy/production/test/legal-artifact-attestation.test.mjs
```

Expected RED: raw slash revisions leak into filenames/URLs, old generated artifacts are still the trusted set, and the attestation names/digests no longer match.

- [ ] Route every generator/verifier URL and filename through the shared identity helpers. Do not weaken current manifest schema, root-entry, symlink, collision, locking, PDF/A, or deterministic-byte validation.
- [ ] Immediately before the first PDF generation operation, run the required artifact-operation marker exactly once for 8 outputs and `pdf` format.
- [ ] Use exact LibreOffice 26.2.5 and pinned veraPDF 1.30.2 digest. Generate into the tracked public root using the existing atomic publisher.
- [ ] Recompute the trusted attestation from the freshly validated release; never edit hashes by hand.
- [ ] Run exact generation twice and prove the second verification is byte-identical:

```bash
corepack pnpm --filter @markiro/domain build
corepack pnpm --filter @markiro/legal-documents artifacts:generate
corepack pnpm --filter @markiro/legal-documents artifacts:verify
corepack pnpm --filter @markiro/legal-documents artifacts:verify
node deploy/production/verify-legal-artifacts.mjs apps/landing/public/legal deploy/production/legal-artifacts-attestation.json
```

- [ ] Assert the artifact root contains only `artifacts.json` and `files/`, exactly 12 listed regular files, 8 PDF/A-2b validations, embedded IBM Plex fonts, and no old filenames.
- [ ] Run package and attestation GREEN, Prettier, and `git diff --check`.
- [ ] Commit: `feat(legal): publish corrected artifact identity`

---

## Task 5: Update verification routing, exact legacy redirects, and landing legal presentation

**Files**

- Create: `apps/landing/src/pages/d/[code]/[yearMonth]/[sequence]/[date].astro`
- Delete: `apps/landing/src/pages/d/[code]/[revision]/[date].astro`
- Modify: `apps/landing/src/lib/legal-artifacts.ts`
- Modify: `apps/landing/src/lib/legal-artifacts.test.ts`
- Modify: `apps/landing/src/content/legal-pages.ts`
- Modify: `apps/landing/src/components/LegalDocument.astro`
- Modify: `apps/landing/src/components/LegalRegistry.astro`
- Modify: `apps/landing/src/components/LegalVerification.astro`
- Modify: `apps/landing/src/components/LegalArtifactControls.astro`
- Modify: `apps/landing/src/components/LandingFooter.astro`
- Modify: `apps/landing/src/styles/landing.css`
- Modify: `apps/landing/test/legal-rendered-page.test.ts`
- Modify: `apps/landing/test/site-audit.test.ts`
- Modify: `deploy/production/Caddyfile`
- Modify: `deploy/production/test/edge-contract.test.mjs`
- Modify: `deploy/production/test/smoke-route-table.test.mjs`
- Modify: `tools/production-browser/tests/landing-seo.spec.ts`

- [ ] Add rendered-page RED assertions for RU visible date `15.08.2026`, EN `15 August 2026`, revision `2026.08/01`, exact new static routes, and no visible RU ISO date.
- [ ] Add loader/audit RED assertions for safe-token filenames, corrected manifest descriptors, exact Data Matrix payloads, and the four corrected canonical verification routes.
- [ ] Add actual adapted-Caddy RED tests for exactly four `308` legacy redirects and rejection of adjacent/truncated/case-mutated/extra-segment paths with the branded 404 boundary.
- [ ] Add DOM/CSS regression contracts: footer year remains in the brand/meta column; legal cards have consistent token padding; file cards expose a shared row structure; hash/copy and verification address blocks have bounded alignment.
- [ ] Add Playwright assertions for desktop and Pixel 7: footer/card bounding boxes, no horizontal overflow, copy button focus, exact canonical URL, redirect target, and zero console errors.
- [ ] Run focused RED:

```bash
corepack pnpm --filter @markiro/landing exec vitest run src/lib/legal-artifacts.test.ts test/legal-rendered-page.test.ts test/site-audit.test.ts
node --test deploy/production/test/edge-contract.test.mjs deploy/production/test/smoke-route-table.test.mjs
```

Expected RED: old three-parameter Astro route, raw revision filename regex, ISO visible dates, no redirects, displaced footer year, and uneven artifact-card layout.

- [ ] Replace landing-local URL composition with the shared legal identity helpers; update the safe filename regex to `YYYY.MM-NN` while keeping basename/symlink/hash checks unchanged.
- [ ] Generate five route parameters from revision parts plus localized display date; verify the page props still carry the canonical structured release.
- [ ] Put four exact legacy `handle` matchers before generic landing documents in Caddy and use permanent redirects to the matching corrected path. Do not add a regex wildcard redirect.
- [ ] Format dates at every visible legal boundary, retaining `<time datetime="2026-08-15">` for machine semantics.
- [ ] Change RU legal registry/site prose to `Маркиро` where it is substantive; keep the exact localized wordmark component unchanged.
- [ ] Refactor footer grid so copyright shares the brand/meta column and remove the grid row that stretches the footer.
- [ ] Refactor artifact cards into consistent padding and explicit row grids; align status/identity, digest/copy, Data Matrix/address, and translation starts without fixed card heights.
- [ ] Run GREEN:

```bash
corepack pnpm --filter @markiro/legal-documents build
corepack pnpm --filter @markiro/landing test
corepack pnpm --filter @markiro/landing typecheck
corepack pnpm --filter @markiro/landing lint
corepack pnpm --filter @markiro/landing build
corepack pnpm --filter @markiro/landing audit
node --test deploy/production/test/edge-contract.test.mjs deploy/production/test/smoke-route-table.test.mjs
corepack pnpm --dir tools/production-browser exec tsc --noEmit
```

- [ ] Adapt the real Caddyfile and exercise redirect/status/header behavior with the repository's Caddy adapter/container contract, not source regex alone.
- [ ] Commit: `fix(landing): align corrected legal release`

---

## Task 6: Perform artifact, browser, consumer, and release-candidate verification

**Files**

- Create or modify only the required review report under `docs/reviews/`
- Do not change production behavior during this verification task unless a new RED test first reproduces a discovered defect

- [ ] Run fresh package gates:

```bash
corepack pnpm --filter @markiro/domain test
corepack pnpm --filter @markiro/domain typecheck
corepack pnpm --filter @markiro/domain lint
corepack pnpm --filter @markiro/domain build
corepack pnpm --filter @markiro/legal-documents test
corepack pnpm --filter @markiro/legal-documents typecheck
corepack pnpm --filter @markiro/legal-documents lint
corepack pnpm --filter @markiro/legal-documents build
corepack pnpm --filter @markiro/landing test
corepack pnpm --filter @markiro/landing typecheck
corepack pnpm --filter @markiro/landing lint
corepack pnpm --filter @markiro/landing build
corepack pnpm --filter @markiro/landing audit
corepack pnpm --filter @markiro/api test
corepack pnpm --filter @markiro/api typecheck
corepack pnpm --filter @markiro/api lint
corepack pnpm --filter @markiro/api build
```

- [ ] Report database skips or environment failures separately; use a unique scratch DB if API tests require one and drop only that DB after proving it absent.
- [ ] Run exact legal verifier, attestation verifier, and production bundle contract once. If a canonical wrapper fails before tests because of the known nested pnpm mismatch, record that primary error and run only the established direct equivalent.
- [ ] Render every page of all 8 PDFs with Poppler; verify A4, page count, no clipping, compact header/footer, localized dates, no footer URL, metadata URL, and Data Matrix quiet zone.
- [ ] Render all 4 DOCX files with exact LibreOffice 26.2.5 and inspect every page. Open/export all 4 in Microsoft Word read-only and record the Word version and limitations.
- [ ] Run Playwright over all RU/EN legal, registry, verification, legacy redirect, and malformed-route cases at desktop and Pixel 7. Inspect full-page screenshots for the six supplied defect classes.
- [ ] Verify Data Matrix payload textually and with the existing decoder; do not claim physical-phone or printer scanning.
- [ ] Run:

```bash
corepack pnpm format:check
git diff --check
git status --short
```

- [ ] Request an independent code review focused on identity agreement, route confinement, artifact immutability, layout regression, and accidental legal-semantic changes. Fix every verified blocker with its own RED/GREEN cycle.
- [ ] Write a report listing exact artifact hashes/tool versions, automated results, rendered/manual results, wrapper or infrastructure limits, and explicitly unrun physical print/phone scans.
- [ ] Commit: `docs: record corrective legal release verification`

---

## Task 7: Prepare the corrected candidate without deploying it

**Files**

- No code changes expected; update the review report only if verification evidence changes

- [ ] Confirm the branch contains no unrelated root-worktree changes, env files, temporary fonts, render directories, local stores, or `.superpowers` execution artifacts.
- [ ] Confirm `git diff <base> -- apps/landing/public/legal deploy/production/legal-artifacts-attestation.json` is exactly the intended complete release replacement.
- [ ] Confirm the public demo form remains compiled and smoked as disabled.
- [ ] Prepare the PR/release handoff with separate approval gates for merge, image release, production deploy, and later form enablement.
- [ ] Do not push, merge, release, or deploy unless the user explicitly requests that external action after reviewing the evidence.

## Plan Self-Review Checklist

- [ ] Every approved screenshot defect maps to a test and production file.
- [ ] Revision, safe filename token, ISO machine date, localized display date, URL segments, Data Matrix payload, manifest, attestation, and consent ID derive from one identity contract.
- [ ] Legacy compatibility is four exact redirects only.
- [ ] No change enables the form or changes legal processing semantics.
- [ ] No step hand-edits generated artifacts or weakens security/determinism checks.
- [ ] Search the plan for placeholders and unresolved choices:

```bash
rg -n 'TODO|TBD|FIXME|\.\.\.|similar to|as above|decide later' docs/superpowers/plans/2026-08-16-legal-docs-corrective-release.md
```

- [ ] Confirm all paths, exported names, commands, and expected RED failures match the current checkout.
