# Markiro Legal Artifacts and Publication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate and publish branded DOCX/PDF-A documents with literal Data Matrix verification, immutable hashes, production-bundle contracts, and a controlled form-publication runbook.

**Architecture:** Extend `@markiro/domain` with a bounded literal Data Matrix renderer distinct from GS1 KM rendering. `@markiro/legal-documents` renders the approved typed source into temporary DOCX, converts it with pinned LibreOffice PDF/A-2b options, validates it with veraPDF, and writes versioned public artifacts plus a SHA-256 manifest. Astro consumes only committed validated artifacts; production Caddy serves static files and never contains office/rendering tools.

**Tech Stack:** Node.js 24, TypeScript 6, `bwip-js` 4.11.2, `docx` 9.7.1, `fflate` 0.8.3 (tests), LibreOffice 26.2.5, veraPDF CLI 1.30.2, Astro 7, Caddy 2.11.4, Docker/Podman, Vitest 4, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-15-legal-document-system-design.md`

## Global Constraints

- Execute only after the RU/EN source checkpoint in `2026-08-15-legal-source-and-pages.md` is accepted for publication.
- The approved paper direction is compact hybrid C: first header about 12 mm, continuation header 8–9 mm, first footer at most 16 mm, continuation footer 13–14 mm, Data Matrix 11–12 mm plus white quiet zone.
- Common Data Matrix payload is the exact released revision URL, for example `https://markiro.app/d/MKR-PD-01/2026.08.01/2026-08-15`.
- Data Matrix contains no subject, operator-contact, tenant, database, signature, or secret data.
- Do not reuse the GS1/KM `renderDataMatrixSvg()` because it parses KM and prepends FNC1.
- HTML is canonical. Public legal documents are PDF/A-2b; editable DOCX is only for `MKR-BRD-01` and clearly marked templates.
- Generated release files are immutable and tracked. A stale digest, missing file, normal PDF masquerading as PDF/A, or repeated code/revision filename fails verification.
- No LibreOffice, Java, veraPDF, internal DOCX source, or generator cache enters the runtime edge image.
- Unique tenant-document issuance remains out of scope; only its numbering/route grammar is tested and reserved.
- Form enablement, live DNS, Postbox, SmartCaptcha, sender identity, and real email delivery remain explicit external actions requiring the user's production approval.

---

### Task 1: Add a literal non-GS1 Data Matrix renderer

**Files:**

- Modify: `packages/domain/src/barcodes/svg.ts`
- Modify: `packages/domain/src/index.ts`
- Modify: `packages/domain/test/barcodes.test.ts`

**Interfaces:**

- Consumes: `bwip-js` already pinned at 4.11.2 and `DomainError`.
- Produces from the package-only `./artifacts` subpath (the root `.` export
  remains registry/content-only for API and landing consumers):

```ts
export function renderLiteralDataMatrixSvg(text: string): string;
```

The function accepts 1–512 UTF-8 bytes, applies no GS1/FNC1 transformation,
and returns a deterministic SVG with opaque white background/quiet zone owned
by the document renderer.

- [ ] **Step 1: Write failing literal-code tests**

```ts
const payload = "https://markiro.app/d/MKR-PD-01/2026.08.01/2026-08-15";
expect(renderLiteralDataMatrixSvg(payload)).toBe(
  bwipjs.toSVG({ bcid: "datamatrix", text: payload, scale: 3 }),
);
expect(renderLiteralDataMatrixSvg(payload)).not.toBe(renderDataMatrixSvg(PRODUCTION_LIKE_KM));
expect(() => renderLiteralDataMatrixSvg("")).toThrow(DomainError);
expect(() => renderLiteralDataMatrixSvg("я".repeat(257))).toThrow(DomainError);
```

Add a decoding test using bwip-js/raw symbol inspection or the repository's
established decoder helper; it must recover the exact URL without `]d2`, FNC1,
or character normalization.

- [ ] **Step 2: Run focused tests to verify RED**

```bash
corepack pnpm --filter @markiro/domain exec vitest run test/barcodes.test.ts
```

Expected: FAIL because the literal renderer is not exported.

- [ ] **Step 3: Implement the bounded renderer**

Measure `Buffer.byteLength(text, "utf8")`; reject empty or over-512-byte input
with a stable `DomainError`. Call `bwipjs.toSVG({ bcid: "datamatrix", text,
scale: 3 })` directly. Do not route through `toGs1Data()`.

- [ ] **Step 4: Run domain gates and commit**

```bash
corepack pnpm --filter @markiro/domain test
corepack pnpm --filter @markiro/domain typecheck
corepack pnpm --filter @markiro/domain lint
corepack pnpm --filter @markiro/domain build
git add packages/domain/src/barcodes/svg.ts packages/domain/src/index.ts packages/domain/test/barcodes.test.ts
git commit -m "feat(domain): render literal data matrix codes"
```

---

### Task 2: Build deterministic branded DOCX sources

**Files:**

- Modify: `packages/legal-documents/package.json`
- Create: `packages/legal-documents/src/artifacts/names.ts`
- Create: `packages/legal-documents/src/artifacts/brand.ts`
- Create: `packages/legal-documents/src/artifacts/docx.ts`
- Create: `packages/legal-documents/src/artifacts/manifest.ts`
- Create: `packages/legal-documents/src/artifacts/index.ts`
- Create: `packages/legal-documents/test/docx.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes: legal releases/operator snapshots from phase one and `renderLiteralDataMatrixSvg()` from Task 1.
- Produces:

```ts
export interface LegalArtifactRequest {
  readonly code: LegalDocumentCode;
  readonly revision: string;
  readonly effectiveDate: string;
  readonly locale: LegalLocale;
  readonly kind: "legal-pdf" | "template-docx";
  readonly verificationUrl: string;
}

export interface LegalArtifactDescriptor extends LegalArtifactRequest {
  readonly fileName: string;
}

export function artifactFileName(input: LegalArtifactRequest): string;
export async function renderLegalDocx(input: LegalArtifactRequest): Promise<Uint8Array>;
```

- [ ] **Step 1: Add exact dependencies and write failing structure tests**

Add `docx: "9.7.1"` and `fflate: "0.8.3"` as build/test-only dev dependencies,
and `@markiro/domain: "workspace:*"`. Export renderers only from
`@markiro/legal-documents/artifacts`; do not re-export them from the root entry.
This keeps `docx` out of the API runtime dependency graph.

Inflate generated DOCX and inspect `word/document.xml`, `word/header1.xml`,
`word/footer1.xml`, relationships, media, and core properties. Assert:

```ts
expect(documentXml).toContain("Политика обработки персональных данных");
expect(headerXml).toContain("маркиро");
expect(footerXml).toContain("MKR-PD-01");
expect(footerXml).toContain("2026.08.01");
expect(footerXml).toContain("PAGE");
expect(mediaNames).not.toMatch(/signature|seal|stamp/i);
expect(allXml).not.toMatch(/Роскомнадзор.*уведомлени[ея] подан/i);
```

For `MKR-BRD-01`, assert the exact template warning. For legal-source DOCX,
assert no template warning. Pin A4 size/margins, different first-page
header/footer, IBM Plex font declarations, heading/list semantics, alt text for
the Markiro symbol/Data Matrix, and fixed core timestamps derived from the
effective date.

- [ ] **Step 2: Run the focused test to verify RED**

```bash
corepack pnpm --filter @markiro/domain build
corepack pnpm --filter @markiro/legal-documents exec vitest run test/docx.test.ts
```

Expected: FAIL because artifact renderers do not exist.

- [ ] **Step 3: Implement names and the compact document template**

Generate exact names such as
`markiro_mkr-pd-01_2026.08.01_ru.pdf` and
`markiro_mkr-brd-01_2026.08.01_ru.docx`. Reject uppercase, spaces, path
separators, non-current release descriptors, and DOCX requests for non-template
documents.

Render the real eight-module Markiro SVG/PNG from repository geometry. Use
millimetre-equivalent DXA measurements, a separate first-page header/footer,
real page fields, semantic heading levels, and a two-column metadata block. Put
the 11–12 mm literal Data Matrix on opaque white with adjacent human-readable
URL/code/revision/date. Do not encode the operator profile in the symbol.

- [ ] **Step 4: Normalize DOCX ZIP metadata**

Set document-created/modified timestamps to the effective date and sort ZIP
entries before output. A second render of the same input must be byte-identical:

```ts
expect(await renderLegalDocx(input)).toEqual(await renderLegalDocx(input));
```

- [ ] **Step 5: Run package gates and commit**

```bash
corepack pnpm --filter @markiro/legal-documents test
corepack pnpm --filter @markiro/legal-documents typecheck
corepack pnpm --filter @markiro/legal-documents lint
corepack pnpm --filter @markiro/legal-documents build
git add packages/legal-documents pnpm-lock.yaml
git commit -m "feat(legal): render branded document sources"
```

---

### Task 3: Generate, validate, hash, and track release artifacts

**Files:**

- Create: `packages/legal-documents/src/cli/generate-artifacts.ts`
- Create: `packages/legal-documents/src/cli/verify-artifacts.ts`
- Create: `packages/legal-documents/test/artifact-manifest.test.ts`
- Modify: `packages/legal-documents/package.json`
- Create: `apps/landing/public/legal/files/markiro_mkr-pd-01_2026.08.01_ru.pdf`
- Create: `apps/landing/public/legal/files/markiro_mkr-pd-01_2026.08.01_en.pdf`
- Create: `apps/landing/public/legal/files/markiro_mkr-pd-02_2026.08.01_ru.pdf`
- Create: `apps/landing/public/legal/files/markiro_mkr-pd-02_2026.08.01_en.pdf`
- Create: `apps/landing/public/legal/files/markiro_mkr-dpa-01_2026.08.01_ru.pdf`
- Create: `apps/landing/public/legal/files/markiro_mkr-dpa-01_2026.08.01_en.pdf`
- Create: `apps/landing/public/legal/files/markiro_mkr-dpa-01_2026.08.01_ru.docx`
- Create: `apps/landing/public/legal/files/markiro_mkr-dpa-01_2026.08.01_en.docx`
- Create: `apps/landing/public/legal/files/markiro_mkr-brd-01_2026.08.01_ru.pdf`
- Create: `apps/landing/public/legal/files/markiro_mkr-brd-01_2026.08.01_en.pdf`
- Create: `apps/landing/public/legal/files/markiro_mkr-brd-01_2026.08.01_ru.docx`
- Create: `apps/landing/public/legal/files/markiro_mkr-brd-01_2026.08.01_en.docx`
- Create: `apps/landing/public/legal/artifacts.json`

**Interfaces:**

- Consumes: deterministic DOCX bytes, LibreOffice 26.2.5, `pdftotext`, and veraPDF CLI 1.30.2.
- Produces an immutable manifest:

```ts
interface PublishedLegalArtifact {
  code: LegalDocumentCode;
  revision: string;
  effectiveDate: string;
  locale: LegalLocale;
  kind: "pdfa-2b" | "template-docx";
  fileName: string;
  bytes: number;
  sha256: string;
  mediaType:
    "application/pdf" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  generator: { docx: "9.7.1"; libreOffice?: "26.2.5"; veraPdf?: "1.30.2" };
}
```

- [ ] **Step 1: Write failing manifest verification tests**

Use a temporary artifact directory. Assert verification rejects missing files,
extra files, duplicate descriptors, unsafe names/symlinks, wrong size/hash,
unlisted current releases, DOCX for `MKR-PD-01`/`MKR-PD-02`, PDF without PDF/A
validation evidence, and manifest output outside the requested root. DOCX is
allowed only for `MKR-DPA-01` and `MKR-BRD-01`.

- [ ] **Step 2: Run the focused test to verify RED**

```bash
corepack pnpm --filter @markiro/legal-documents exec vitest run test/artifact-manifest.test.ts
```

Expected: FAIL because the CLIs/manifest verifier do not exist.

- [ ] **Step 3: Implement safe temporary generation**

Require explicit `--out-dir` and resolve it beneath the repository-selected
artifact root. Create a unique temporary directory with `mkdtemp`; never follow
symlinks or overwrite an existing released file unless `--check` proves its
bytes are identical.

For each PDF, generate internal DOCX then invoke exactly:

```text
soffice --headless --convert-to
pdf:writer_pdf_Export:{"SelectPdfVersion":{"type":"long","value":"2"},"UseTaggedPDF":{"type":"boolean","value":"true"},"EnableTextAccessForAccessibilityTools":{"type":"boolean","value":"true"},"ExportBookmarks":{"type":"boolean","value":"true"}}
--outdir <temp> <source.docx>
```

Resolve `SOFFICE_BIN` explicitly, run `--version`, and require `26.2.5` for a
release generation. A development preview may use another version only with
`--preview`, which cannot write the tracked release directory or manifest.

- [ ] **Step 4: Validate PDF/A and searchable text before publish**

Run veraPDF 1.30.2 with its PDF/A-2b profile in a container, mount only the
temporary artifact directory read-only, and parse its machine-readable result.
Use `pdftotext` to assert the title, code, revision, operator name, and first/last
section text are extractable. Reject empty output, missing Cyrillic, font
substitution warnings, page count zero, or a PDF over the documented bounded
size.

Resolve and record the exact container image digest used by the release; do not
use `latest`. The approved tool version is `verapdf/cli:v1.30.2`.

- [ ] **Step 5: Hash and publish atomically**

Compute lowercase 64-hex SHA-256 after validation. Write canonical sorted JSON
with a final newline, fsync files, then rename from the temporary directory into
the release directory. If any artifact fails, publish none.

- [ ] **Step 6: Generate the first artifacts and inspect them manually**

Run:

```bash
corepack pnpm --filter @markiro/legal-documents artifacts:generate
corepack pnpm --filter @markiro/legal-documents artifacts:verify
```

Render all PDF pages to images and inspect cover/continuation pages at 100%.
Open both DOCX templates in LibreOffice and current Microsoft Word. Record exact
tool versions and screenshots in the review report; do not claim Word
compatibility if Word was not exercised.

- [ ] **Step 7: Commit validated immutable artifacts**

```bash
git add packages/legal-documents/src/cli packages/legal-documents/test/artifact-manifest.test.ts packages/legal-documents/package.json apps/landing/public/legal pnpm-lock.yaml
git commit -m "feat(legal): publish validated document artifacts"
```

---

### Task 4: Publish downloads, hashes, and common-document verification

**Files:**

- Create: `apps/landing/src/lib/legal-artifacts.ts`
- Create: `apps/landing/src/lib/legal-artifacts.test.ts`
- Modify: `apps/landing/src/components/LegalDocument.astro`
- Modify: `apps/landing/src/components/LegalRegistry.astro`
- Create: `apps/landing/src/components/LegalVerification.astro`
- Create: `apps/landing/src/pages/d/[code]/[revision]/[date].astro`
- Modify: `apps/landing/src/lib/audit.ts`
- Modify: `apps/landing/src/lib/audit.test.ts`
- Modify: `apps/landing/test/legal-rendered-page.test.ts`
- Modify: `apps/landing/src/styles/landing.css`
- Modify: `tools/production-browser/tests/landing.spec.ts`

**Interfaces:**

- Consumes: tracked `artifacts.json` and files from Task 3.
- Produces: localized download controls, visible SHA-256/file size/type, real Data Matrix SVG, and bounded static verification routes for common documents.

- [ ] **Step 1: Write failing artifact/route tests**

Assert the loader validates manifest schema, computes current file hashes during
build/audit, and refuses path separators, symlinks, missing files, wrong media
types, or files outside `/legal/files/`.

Rendered route expectations:

```ts
expect(page.querySelector('a[download$=".pdf"]')).not.toBeNull();
expect(page.querySelector("[data-artifact-sha256]")?.textContent).toMatch(/^[a-f0-9]{64}$/);
expect(page.querySelector("[data-document-datamatrix] svg")).not.toBeNull();
expect(page.querySelector("[data-document-id]")?.textContent).toContain("MKR-PD-01");
```

Unknown/malformed verification routes must build to branded bounded 404
behavior without listing codes/files. There is no catch-all future
individual-document API. The common verification page itself is bilingual so
the one URL encoded in the document does not depend on cookies or request-time
language negotiation.

- [ ] **Step 2: Run focused tests to verify RED**

```bash
corepack pnpm --filter @markiro/landing exec vitest run src/lib/legal-artifacts.test.ts test/legal-rendered-page.test.ts src/lib/audit.test.ts
```

Expected: FAIL because artifact loader/download/verification UI is absent.

- [ ] **Step 3: Implement manifest loading and static paths**

Read and validate the manifest at Astro build time. `getStaticPaths()` emits one
path per common active/superseded/withdrawn release using exact lower/uppercase
normalization rules; canonical URL retains the stable uppercase code used in the
Data Matrix. Never accept arbitrary filesystem input from route params.

- [ ] **Step 4: Render compact real document controls**

Show status, code, revision, effective date, matching translation, PDF/A label,
human file size, SHA-256 with copy control, and download link. Show DOCX only for
template releases with the template warning. Render Data Matrix on opaque white
at the approved physical proportion with adjacent text URL.

- [ ] **Step 5: Extend audit and browser coverage**

The built-site audit hashes every linked artifact and compares manifest bytes.
Browser tests download each file, assert non-zero bounded size/content type, and
check verification pages at desktop/Pixel 7 without overflow/console errors.
Automated browser tests do not claim physical print scanning.

- [ ] **Step 6: Run landing gates and commit**

```bash
corepack pnpm --filter @markiro/landing test
corepack pnpm --filter @markiro/landing typecheck
corepack pnpm --filter @markiro/landing lint
corepack pnpm --filter @markiro/landing build
corepack pnpm --filter @markiro/landing run audit
corepack pnpm test:landing:browser
git add apps/landing tools/production-browser/tests/landing.spec.ts
git commit -m "feat(landing): verify and download legal documents"
```

---

### Task 5: Update production image, workflows, contracts, and runbook

**Files:**

- Modify: `deploy/production/edge.Dockerfile`
- Modify: `deploy/production/api.Dockerfile`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release-images.yml`
- Modify: `deploy/production/test/edge-contract.test.mjs`
- Modify: `deploy/production/test/workflow-contract.test.mjs`
- Modify: `deploy/production/test/runbook-contract.test.mjs`
- Modify: `deploy/production/test/smoke-route-table.test.mjs`
- Modify: `deploy/production/smoke.mjs`
- Modify: `docs/runbooks/landing-publication.md`
- Modify: `docs/runbooks/yandex-secrets.md`

**Interfaces:**

- Consumes: committed validated static artifacts and shared consent id.
- Produces: edge image containing legal pages/files but no generation toolchain; workflows no longer accept independent legal path/version variables.

- [ ] **Step 1: Write failing production contracts**

Change the public landing build variable inventory to exactly:

```js
["PUBLIC_DEMO_SUBMISSION_ENABLED", "PUBLIC_SMARTCAPTCHA_CLIENT_KEY", "PUBLIC_PHONE"];
```

Assert Docker copies/builds `packages/legal-documents`, contains all tracked
artifact paths in `/srv/landing`, and has no `soffice`, LibreOffice, Java,
veraPDF, internal DOCX, generation temp directory, or unvalidated manifest in
the final Caddy layer.

Assert CI/release workflows and protected env no longer mention
`PUBLIC_DEMO_CONSENT_VERSION`, `PUBLIC_PRIVACY_POLICY_PATH`,
`PUBLIC_PERSONAL_DATA_CONSENT_PATH`, or `LANDING_DEMO_CONSENT_VERSION`.

- [ ] **Step 2: Run focused production tests to verify RED**

```bash
node --test deploy/production/test/edge-contract.test.mjs deploy/production/test/workflow-contract.test.mjs deploy/production/test/runbook-contract.test.mjs deploy/production/test/smoke-route-table.test.mjs
```

Expected: FAIL on old variable inventory and missing artifact/runtime-isolation
contracts.

- [ ] **Step 3: Update edge/workflow inputs**

Copy `packages/legal-documents/package.json` before install and its source before
both API and landing builds. Add the workspace package to both Docker build
contexts; build `@markiro/domain`, `@markiro/legal-documents`, and each consumer
in dependency order. Remove the obsolete public args/env. Keep
`PUBLIC_DEMO_SUBMISSION_ENABLED=false` and blank captcha/phone as safe CI
defaults.

- [ ] **Step 4: Strengthen smoke and runbook gates**

Disabled and enabled smoke both require `200` for `/legal/`, `/privacy/`, and
`/personal-data-consent/`, correct PDF content type, and a manifest/hash match.
They continue to distinguish disabled `404 + submission_disabled` from enabled
`400 + invalid_request` using an empty POST that creates no email.

Update the runbook to require external legal review, provider contract/name and
Russian storage confirmation, explicit record of the unfiled/filed
Roskomnadzor state, PDF/A validation, Word/LibreOffice review, physical A4 scan,
and one-year mailbox deletion procedure. Do not make filing status a secret or
claim repository tests prove it.

- [ ] **Step 5: Run the production bundle exactly once after focused GREEN**

```bash
node --test deploy/production/test/edge-contract.test.mjs deploy/production/test/workflow-contract.test.mjs deploy/production/test/runbook-contract.test.mjs deploy/production/test/smoke-route-table.test.mjs
corepack pnpm test:production-bundle:contract
```

If Podman/Docker fails with socket refusal or EOF before the Caddy adapter runs,
record the primary infrastructure error and do not claim the canonical bundle
green. Retry only after demonstrating the failure is infrastructure and only
once if the execution instruction permits.

- [ ] **Step 6: Commit production integration**

```bash
git add deploy/production .github/workflows docs/runbooks
git commit -m "feat(deploy): publish legal document bundle"
```

---

### Task 6: Complete external acceptance and prepare the production release

**Files:**

- Create: `docs/reviews/2026-08-15-legal-artifacts-and-publication.md`
- Modify if required by verified findings only: files owned by Tasks 1–5

**Interfaces:**

- Consumes: completed code/artifacts, external legal review, provider/DNS/captcha state, and an explicitly approved production deployment.
- Produces: release evidence or a precise blocked-state report; it does not infer authorization for DNS/secret/deploy changes.

- [ ] **Step 1: Run final repository gates**

```bash
corepack pnpm --filter @markiro/domain test
corepack pnpm --filter @markiro/domain typecheck
corepack pnpm --filter @markiro/domain lint
corepack pnpm --filter @markiro/domain build
corepack pnpm --filter @markiro/legal-documents artifacts:verify
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
corepack pnpm test:production-bundle:contract
corepack pnpm test:landing:browser
corepack pnpm test:landing:lighthouse
corepack pnpm format:check
git diff --check
```

Report exact passes, skips, and infrastructure failures. Use a migrated unique
scratch DB for API database tests and drop only that DB afterward.

- [ ] **Step 2: Perform manual document acceptance**

Inspect RU/EN HTML at desktop and Pixel 7; every PDF page at 100% and print
preview; both DOCX templates in current Word and LibreOffice. Print one common
document on A4 and scan its Data Matrix with two ordinary phone cameras. Verify
the decoded URL, status, revision, date, and SHA-256 against the downloaded
file. Record failures; do not resize below the approved scan floor merely to fit
copy.

- [ ] **Step 3: Complete the external legal/provider gate**

Record reviewer identity/date/version for the Russian drafts and translation
consistency; confirm active Yandex Cloud/Postbox/SmartCaptcha/mailbox processor
contracts, legal names, Russian storage boundary, and the actual Roskomnadzor
notification state. If any is unknown, state it as unknown and do not mark the
gate complete.

- [ ] **Step 4: Request separate production approval**

Before changing repository variables, protected secrets, DNS, SmartCaptcha,
Postbox identity, or production services, present the exact targets and current
read-only evidence to the user. Use the existing publication runbook order:
legal deploy disabled, API enable, controlled RU/EN delivery, edge enable,
monitoring. A prior approval to write code is not deployment approval.

- [ ] **Step 5: Verify the live release after approved deployment**

Check DNS/TLS, legal HTML, files/hashes, verification URLs, disabled/enabled POST
contract, RU/EN form consent id, SmartCaptcha, internal delivery, visitor
confirmation, Postbox events, and absence of the CRM placeholder. Do not include
form values, tokens, SMTP credentials, or personal data in evidence.

- [ ] **Step 6: Write and commit the final report**

```bash
git add docs/reviews/2026-08-15-legal-artifacts-and-publication.md
git commit -m "docs: record legal publication verification"
```

The report separates repository, local visual, physical print, external legal,
provider/DNS, and live production evidence. If production is not authorized or
an external gate is incomplete, stop with that exact blocker while leaving the
validated code/artifacts ready for release.
