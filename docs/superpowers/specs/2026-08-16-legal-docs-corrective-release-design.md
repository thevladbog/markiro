# Legal Documents Corrective Release — Design Spec

**Date:** 16.08.2026

**Status:** Approved in design discussion

**Scope:** Corrective publication of the current legal-document set, legal HTML
presentation, document verification routes, and production-deploy diagnostics.

**Related:**
`docs/superpowers/specs/2026-08-15-legal-document-system-design.md`,
`docs/runbooks/landing-publication.md`, `packages/legal-documents`,
`apps/landing`, and `deploy/yandex`.

## Context and authority

The first legal-document release is live, but visual inspection exposed
presentation and numbering defects in the site, PDF, and DOCX outputs. The
production rollout also demonstrated that the hosted deploy wrapper hides the
failing stage behind the single message `remote deployment failed`. The exact
runtime inventory correctly rejected a retired Lockbox key, but the operator
could not distinguish that failure from SSH, transfer, migration, smoke, or
rollback failures without separate cloud inspection.

This specification records the user's explicit one-time authorization to
correct the current revision identifier from `2026.08.01` to `2026.08/01`
without publishing a second revision. The prior identifier and artifacts are
treated as a pre-acceptance formatting error rather than a historical legal
revision. Old verification URLs remain continuity aliases to the corrected
address, but the registry presents only the corrected current revision.

After this corrective release, the immutability, archive, supersession, and
withdrawal rules in the original legal-document specification apply without
exception. Any later public content or presentation change that affects an
artifact creates a new revision.

## Goals

1. Make every Russian human-readable date use `DD.MM.YYYY`.
2. Make every document revision use `YYYY.MM/NN`, distinct from a date.
3. Repair the legal-site footer, document cards, verification panels, and
   responsive alignment shown in the acceptance screenshots.
4. Repair PDF/DOCX header and footer layout without increasing page furniture.
5. Apply consistent Russian and English brand naming and definition punctuation.
6. Keep verification routes and Data Matrix payloads readable and stable after
   the numbering correction.
7. Report a bounded, non-secret failing deploy stage and reject runtime inventory
   drift before service mutation.

## Non-goals

- Changing the operator identity, legal basis, retention period, tenant/operator
  boundary, or form data fields.
- Enabling the public demo form, SmartCaptcha, Postbox delivery, analytics, CRM,
  or marketing during this corrective release.
- Redesigning the landing page outside the footer and legal-document surfaces.
- Printing, signing, sealing, or issuing tenant-specific documents.
- Exposing remote stderr, environment values, Lockbox payload values, registry
  credentials, paths containing credentials, or form data in deploy diagnostics.

## Identity, revisions, and dates

The canonical structured values remain separate:

- stable code: `MKR-PD-01`;
- revision: `2026.08/01`;
- effective date: the machine value `2026-08-15`;
- Russian effective-date display: `15.08.2026`;
- English effective-date display: `15 August 2026`.

The revision is not parsed or presented as a date. Filenames use an ASCII-safe
revision token, for example:

```text
markiro_mkr-pd-01_2026.08-01_ru.pdf
markiro_mkr-dpa-01_2026.08-01_en.docx
```

The normalized model owns locale-aware display formatters. Russian pages,
cards, metadata tables, document headers, footers, verification results, and
visible verification URLs must not expose ISO dates. English documents and
pages use English words for dates and labels. Machine-only manifest fields may
retain ISO dates, but they are not rendered verbatim in Russian UI.

## Verification identity and compatibility

The corrected common-document URL is:

```text
https://markiro.app/d/MKR-PD-01/2026.08/01/15.08.2026
```

The route has exact, bounded segments: stable code, publication year/month,
monthly sequence, and effective date. The Data Matrix encodes this exact URL.
Adjacent, truncated, extra-segment, case-mutated, or malformed routes remain
bounded branded 404 responses.

Each previously published route of the form
`/d/<CODE>/2026.08.01/2026-08-15` receives an exact permanent redirect to the
matching corrected route. The redirect allowlist contains only the four known
document codes; it does not broaden `/d/*` routing or create a directory index.
Old artifact filenames and the old revision are not presented as a second
public revision.

## Russian and English legal language

In every Russian legal document, the first substantive product-name occurrence
is `Маркиро (англ. — Markiro)`. Later occurrences use `Маркиро`. The localized
wordmark remains `маркиро`, while the domain, URLs, document codes, service
names, and code literals keep their exact machine spelling.

English legal documents use `Markiro` only. They do not repeat the Russian name
or use mixed-language `Маркиро / Markiro` labels.

Definition entries use a dash rather than a full stop:

```text
Персональные данные — любая информация ...
Обработка — любое действие ...
Тенант — изолированная организация-заказчик ...
```

The rule applies to every definition list in Russian legal content. It does not
mechanically replace punctuation in ordinary prose, abbreviations, URLs, or
document codes.

## PDF and DOCX layout

### Header

The header is a compact two-column grid within the existing page margins:

- left: symbol and localized wordmark in one aligned group;
- right: document class, stable code, and revision on one line;
- the right group may reduce its internal gap within the approved type scale,
  but the revision must never wrap onto a second line;
- the title begins below the complete header with a consistent content gap and
  never drifts toward or away from the logo independently.

The existing page-height budgets remain maximums, not targets. Header and footer
must stay compact enough to preserve at least 80% of usable page height for
content.

### First-page metadata

The metadata table uses explicit widths, cell padding, and vertical centering.
It contains code, revision, effective date, language, operator, contacts, and a
separate `Проверка редакции` / `Revision verification` row with the full
verification URL. The URL may wrap inside that wide table cell at deliberate
boundaries; it is not repeated in the footer.

### Footer

Every PDF and DOCX footer contains only:

- Data Matrix with a white quiet zone;
- stable code;
- revision;
- localized effective date;
- localized page label and number.

The human-readable verification URL is removed from all footers. Footer items
share a baseline or a vertically centered grid, and the page label is never
wrapped together with a URL. The Data Matrix remains the compact exact-address
carrier; the first-page metadata table provides the accessible text equivalent.

### Content rhythm

Heading and paragraph spacing remain consistent across page breaks. Tables have
no fixed row height and use explicit geometry, adequate cell padding, and
vertical alignment. A correction must not squeeze body typography merely to
preserve an old page count; page-count changes are acceptable when the result
is more readable.

## Legal-site layout

The existing industrial/editorial visual direction remains unchanged. Fixes use
the current tokens and components rather than creating a parallel design system.

### Global footer

The site footer uses one bounded grid with the brand, navigation groups, and
copyright year aligned deliberately. The year belongs to the brand/meta column
and does not create its own bottom row. Desktop height is content-driven with
balanced top/bottom padding; mobile collapses to a compact vertical flow without
absolute positioning or large empty regions.

### Registry and verification cards

- Desktop card padding is consistent on all sides; mobile padding scales down
  through the existing spacing tokens.
- Status, code, revision, and effective date form one aligned header block.
- PDF and DOCX download cards use the same internal grid: format/size row,
  optional template notice, action, and hash/copy row.
- Hashes wrap as bounded tokens without pushing the copy control out of the
  card. Copy controls align to the hash row and remain keyboard accessible.
- The Data Matrix, verification label, URL, and translation link form one
  coherent grid with aligned starts and predictable gaps.
- A single-artifact card and a two-artifact card both use the same spacing
  rhythm; neither stretches child content awkwardly to fill height.

Acceptance covers the six supplied screenshots as regression references, plus
desktop and Pixel 7 views for every RU/EN legal and verification route.

## Deploy diagnostics and runtime inventory

The hosted deploy remains fail-closed and stderr-suppressing. Its public
diagnostic contract gains one final bounded event:

```text
MARKIRO_DEPLOY_FAILURE <stage>
```

Allowed stages are `configuration`, `transfer`, `reconcile-host`,
`runtime-inventory`, `runtime-env`, `prepare`, `smoke`, `finalize`, and
`rollback`. No arbitrary exception message or subprocess output is appended.

Before `reconcile-host`, runtime refresh, migrations, image switching, or other
service mutation, the deploy performs a read-only runtime inventory probe on
the VM. The probe compares only the sorted key names from the release inventory
and current Lockbox payload. It never returns values. Missing, extra, duplicate,
or malformed keys produce `runtime-inventory` and stop the rollout before
mutation.

If a failure occurs after a candidate is prepared, the existing bounded rollback
still runs once. A rollback failure is reported as `rollback` while preserving
the original stage in private structured control flow; logs remain free of
remote details. Release records and durable application data are never deleted
to hide a failure.

## Artifact and build pipeline

The corrective generation order remains deterministic:

```text
typed bilingual sources
  -> localized HTML
  -> DOCX
  -> exact LibreOffice PDF/A-2b conversion
  -> deterministic normalization
  -> veraPDF validation
  -> full-text and embedded-font checks
  -> artifact hashes and attestation
  -> landing build and route audit
```

The generator publishes the corrected revision as one atomic artifact set. The
manifest, attestation, HTML metadata, filenames, verification routes, Data
Matrix payloads, and compiled consent identifier must agree. The API and landing
continue to consume the same consent identifier; the form remains disabled
during this release.

## Verification strategy

TDD begins with focused failing tests for:

- revision parsing and rejection of date-shaped `YYYY.MM.NN` values;
- Russian and English date presentation across model, HTML, DOCX, and PDF text;
- corrected verification URL/Data Matrix payload and exact legacy redirects;
- bilingual brand and dash-based definition contracts;
- compact header/footer semantics and absence of footer URLs;
- site-footer year alignment and registry-card spacing/alignment;
- safe deploy stage codes, forbidden-value absence, and pre-mutation inventory
  mismatch handling.

Final automated gates include domain, legal-documents, landing, API consumers,
Yandex runtime contracts, production bundle contracts, Astro typecheck/lint/
build/audit, and direct browser suites where the wrapper remains unavailable.

Artifact verification uses the pinned LibreOffice and veraPDF toolchain. Every
PDF page and every DOCX-rendered page is rendered to PNG and visually inspected.
DOCX files are also opened/exported in Microsoft Word. Browser inspection covers
RU/EN legal pages and every verification route at desktop and Pixel 7 widths,
including overflow, focus, copy controls, console errors, redirects, and
branded 404 boundaries.

Physical A4 print and phone/industrial Data Matrix scanning remain a separate
external acceptance gate and are not inferred from rendered pixels.

## Release and rollback

1. Keep public demo submission disabled in API and edge.
2. Generate and validate the corrected legal artifacts and site.
3. Publish immutable images and deploy with smoke expecting
   `404 + submission_disabled`.
4. Verify the corrected live routes, legacy redirects, hashes, dates, layouts,
   release SHA, TLS, and CSP.
5. Only after this corrective release is accepted resume the separate Postbox
   and SmartCaptcha enablement gates.

If the corrective release fails, application rollback restores the previous
healthy image pair. The currently deployed legal pages remain available; the
public form remains disabled. Lockbox payload values and durable data are not
destroyed by application rollback.

## Approved decisions

- One corrective current revision, `2026.08/01`; no `/02` revision.
- Russian dates are `DD.MM.YYYY`; revision is `YYYY.MM/NN`.
- Corrected verification routes use separate revision-sequence and localized
  effective-date path segments.
- Old verification routes redirect exactly to the corrected route.
- Footer URLs are removed; full verification URLs move to first-page metadata.
- Russian first use is `Маркиро (англ. — Markiro)`; English uses `Markiro` only.
- Definitions use a dash, not a full stop.
- Existing visual direction is retained and spacing/alignment defects are fixed.
- Deploy diagnostics expose only bounded stage codes and inventory key names are
  checked before mutation.
- Form enablement remains a separate rollout after this corrective release.
