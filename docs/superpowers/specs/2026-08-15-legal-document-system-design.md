# Markiro Legal Document System — Design Spec

**Date:** 2026-08-15
**Status:** Approved in design discussion; document wording and external legal
review remain pending.
**Scope:** Public privacy documents, a tenant data-processing instruction
template, branded downloadable documents, document numbering, a public
registry/archive, common-document verification, and landing-form consent
version binding.
**Related:**
`docs/superpowers/specs/2026-08-14-landing-demo-email-and-brand-design.md`,
`docs/runbooks/landing-publication.md`, `apps/landing`, `packages/domain`, and
`deploy/production`.

## Status and legal boundary

This specification translates the approved product decisions into a software
and publication contract. It is not a legal opinion and must not be described
as confirmation that the operator complies with every applicable requirement.
The Russian texts require review by a qualified Russian personal-data lawyer;
the English texts are informational translations.

At approval time the operator had not filed a personal-data processing
notification with Roskomnadzor. The user explicitly directed publication of the
documents and acceptance of the temporary risk before the first real lead. The
repository must not claim that the notification was filed, that Markiro is in a
public operator register, or that publication of these documents replaces that
external obligation. The publication runbook keeps the filing as an explicit
open compliance item and records the planned update after the operator changes
legal form.

The design is based on the current text of Federal Law No. 152-FZ, including:

- the duty to make the processing policy accessible when collecting personal
  data over a network;
- the operator's burden to prove consent or another legal basis;
- the required content of an operator's instruction to a processor;
- the general duty to notify Roskomnadzor before processing unless a statutory
  exception applies; and
- the Russian-database localization requirement for initial collection of
  Russian citizens' personal data.

Primary and official references used for the design are the
[current consolidated text of 152-FZ](https://ips.pravo.gov.ru/api/ips/legislation/document?baseid=None&hash=98490812b3409e2a8d78a11ca9010f434ea3d9250a11dbbdb78690cd5551bdd6),
the [Yandex Cloud processing terms](https://yandex.ru/legal/cloud_termsofuse/ru/),
the [Yandex Cloud data-processing explanation](https://yandex.cloud/ru/docs/troubleshooting/legal/how-to/fl-152),
and the [SmartCaptcha privacy description](https://yandex.ru/legal/confidential/ru/).

## Problem

The landing demo form is production-disabled until same-origin privacy and
personal-data consent documents exist. Its disabled copy currently mentions a
future CRM connection, although the implemented temporary channel is a durable
transactional email pipeline rather than a CRM. Legal routes are absent, there
is no public document register, and the form's consent version is supplied as a
separate build variable that can drift from the text shown to a visitor.

Markiro also has no reusable official-document identity. A downloaded file
cannot currently be tied to a stable document code, publication date, archived
revision, or verifiable artifact hash. Future tenant-specific documents would
have no collision-resistant human number or safe verification boundary.

## Goals

1. Publish a Russian privacy policy and personal-data consent plus matched
   English informational translations.
2. Publish a tenant data-processing instruction template that describes the
   tenant/operator and Markiro/processor boundary without disclaiming Markiro's
   own duties.
3. Establish a durable, attractive numbering system for all Markiro documents.
4. Add branded A4 cover/continuation templates with compact header and footer.
5. Produce downloadable PDF/A-2b documents and clearly marked editable DOCX
   templates from one typed source model.
6. Publish an immutable document registry, artifact hashes, archive, and a
   common-document verification page.
7. Encode only safe identifiers in a Data Matrix; never encode tenant or
   subject personal data.
8. Make the current personal-data consent revision a compiled contract shared
   by the landing and API so it cannot drift through an independent public
   build variable.
9. Remove every public statement that submission awaits a CRM connection.
10. Preserve the landing's bilingual SEO, accessibility, CSP, abuse protection,
    exact-route proxy, and deny-by-default behavior.

## Non-goals

- Filing the Roskomnadzor notification or representing the user before the
  regulator.
- Substituting generated text for external legal review.
- Marketing consent, newsletters, analytics, advertising cookies, profiling,
  CRM forwarding, or lead enrichment.
- Public access to tenant-specific document contents.
- Electronic signatures, qualified signatures, facsimiles, seals, or claims of
  signed-document authenticity.
- Generating individual tenant documents before the contract and authenticated
  cabinet lifecycle is designed.
- Runtime PDF/DOCX generation on the public edge or API.
- Replacing existing tenant billing/invoice print forms.

## Operator identity and publication data

The first published Russian documents identify the operator as:

- **Operator:** Богатырев Владислав Сергеевич;
- **Address:** 353745, Краснодарский край, Ленинградский район,
  ст. Ленинградская, ул. Грузская, д. 26;
- **Email for data-subject requests:** `hello@v-b.tech`;
- **Telephone:** `+7 934 355-14-90`;
- **Site:** `https://markiro.app`.

These details are intentionally public at the user's direction. They live in
one typed operator profile used by every document, not as independently copied
paragraphs. A change of legal form creates new document revisions and an
operator-profile update; already published versions remain archived with their
historical operator snapshot.

## Document identity

### Stable codes

The namespace starts with the following stable codes:

| Code         | Document                                                 |
| ------------ | -------------------------------------------------------- |
| `MKR-PD-01`  | Personal-data processing policy                          |
| `MKR-PD-02`  | Website personal-data processing consent                 |
| `MKR-DPA-01` | Tenant instruction/addendum for processing personal data |
| `MKR-BRD-01` | Branded editable letterhead/template                     |

Additional namespaces such as `LGL`, `SEC`, and `OPS` are introduced only when
the first real document in that family is approved. Codes are never recycled.
Renaming or revising a document does not change its stable code; a materially
different purpose or legal instrument receives a new code.

### Calendar revisions

A common document revision has the form `YYYY.MM.NN`, for example
`2026.08.01`:

- `YYYY.MM` is the publication year and month;
- `NN` is the two-digit publication sequence within that month;
- the effective date is a separate ISO date, for example `2026-08-15`;
- every publicly visible content change creates a new revision;
- an already released code/revision pair is immutable;
- Russian and English artifacts share the same code and revision and add a
  language tag.

The Russian version is authoritative. The English page and artifact state that
they are informational translations and link to the matching Russian revision.

Public filenames use lowercase ASCII and contain every selection dimension:

```text
markiro_mkr-pd-01_2026.08.01_ru.pdf
markiro_mkr-pd-01_2026.08.01_en.pdf
markiro_mkr-brd-01_2026.08.01_ru.docx
```

### Future individual numbers

The reserved individual-document form is:

```text
MKR-DPA-26-000184-X7
```

- `DPA` identifies the document family;
- `26` is the issue year;
- `000184` is a zero-padded unique sequence for that family/year;
- `X7` is a human transcription check suffix, not an access secret.

An individual document separately records the stable template code and
revision from which it was produced. The public identifier is not an
authorization mechanism. A future verification page may reveal only number,
type, issue date, status, and artifact fingerprint; content and tenant identity
require authenticated tenant-scoped access.

## Visual system

The approved direction is the compact hybrid concept C:

- actual eight-module Markiro symbol plus localized `маркиро`/`MARKIRO`
  wordmark;
- IBM Plex typography and existing Markiro black, warm white, neutral, and
  `#3ddc7a` accent;
- restrained document-class line and revision badge;
- no invented signature, seal, certification mark, or legal-entity details;
- a cover page with stronger title hierarchy and quiet continuation pages.

The A4 geometry is pinned:

- first-page header approximately 12 mm high;
- continuation header 8–9 mm;
- first-page footer at most 16 mm;
- continuation footer 13–14 mm;
- Data Matrix 11–12 mm plus the required white quiet zone;
- at least 80% of the usable page height remains available to document content.

The header uses the full mark and wordmark on the cover. Continuation pages use
a reduced mark, short wordmark, stable code, and revision. The footer contains
the Data Matrix, human-readable code/revision/date, canonical verification URL,
and page number. The human-readable identifier is never replaced by the
machine-readable code.

## Data Matrix contract

Use an ordinary, non-GS1 Data Matrix with black modules on an opaque white
surface. The existing `renderDataMatrixSvg()` is specific to Chestny ZNAK/GS1
KM values: it parses KM segments and prepends FNC1. It must not be reused for
document URLs. `@markiro/domain` gains a separately named literal Data Matrix
renderer with bounded UTF-8 input and no FNC1 transformation.

For a common document the payload identifies the exact released revision and
effective date, for example:

```text
https://markiro.app/d/MKR-PD-01/2026.08.01/2026-08-15
```

For a future individual document the payload contains only its unique number
and verification route:

```text
https://markiro.app/d/MKR-DPA-26-000184-X7
```

No name, email, phone, address, tenant name, database id, signature token, or
document body is encoded. Verification routes are exact, bounded, and do not
turn adjacent `/d/*` paths into an API or file listing.

## Public registry and lifecycle

`/legal/` and `/en/legal/` are the public document registers. Each entry shows:

- title, stable code, language, revision, effective date, and status;
- HTML reading link and PDF/A download;
- SHA-256 of the final downloadable artifact;
- matching translation and authoritative Russian revision;
- superseding revision where applicable;
- verification link and archived revisions.

Public statuses are `active`, `superseded`, and `withdrawn`. `draft` exists only
in source metadata and is never emitted into the site or sitemap. Released
artifacts are content-addressed and never overwritten. A new revision may point
back to the exact prior revision; a withdrawn document remains verifiable but
is not presented as current.

The final binary SHA-256 is shown in the HTML registry/verification result, not
inside the PDF whose bytes it hashes. The PDF footer carries the stable
identifier and verification URL. The build fails if an artifact is missing,
its manifest digest is stale, a release is duplicated, a current pointer is
ambiguous, or RU/EN revision pairing is incomplete.

## Routes and downloadable formats

The first route set is:

| Russian route                    | English route                          | Purpose             |
| -------------------------------- | -------------------------------------- | ------------------- |
| `/legal/`                        | `/en/legal/`                           | Public register     |
| `/privacy/`                      | `/en/privacy/`                         | `MKR-PD-01`         |
| `/personal-data-consent/`        | `/en/personal-data-consent/`           | `MKR-PD-02`         |
| `/legal/tenant-data-processing/` | `/en/legal/tenant-data-processing/`    | `MKR-DPA-01`        |
| `/legal/brand-letterhead/`       | `/en/legal/brand-letterhead/`          | `MKR-BRD-01`        |
| `/d/<code>/<revision>/<date>`    | same route with localized presentation | Common verification |

HTML is the canonical public reading format. Public legal documents offer an
immutable PDF/A-2b download. Editable DOCX is published only for
`MKR-BRD-01` and contract templates, with a prominent
`ШАБЛОН / TEMPLATE — НЕ ЯВЛЯЕТСЯ ДЕЙСТВУЮЩИМ ДОКУМЕНТОМ` marking and no
signature/seal. An individual issued document will eventually be PDF-only.

## One source and artifact generation

Add a focused workspace package, `@markiro/legal-documents`, that owns:

- typed operator profile, document registry, revisions, and status validation;
- normalized section/list/table content for RU and EN;
- the exported current demo-consent code/revision contract;
- DOCX construction and the static-artifact generator;
- artifact manifest generation and hash verification.

`apps/landing` consumes the normalized model for HTML pages. The API consumes
only the lightweight current-consent identifier; it does not import document
rendering code. Rendering dependencies remain build/dev dependencies and do not
enter the API runtime bundle.

The pipeline is:

```text
typed registry + normalized bilingual content
  -> Astro legal HTML
  -> generated internal DOCX
  -> LibreOffice Writer PDF/A-2b export
  -> veraPDF conformance validation
  -> SHA-256 artifact manifest
  -> Astro registry/download/verification pages
```

The DOCX generator uses the exact pinned `docx` dependency and embeds local
brand assets and local fonts. LibreOffice exports with
`SelectPdfVersion=2`, tagged PDF, and text access enabled. PDF/A is a claimed
format only when veraPDF reports conformance. The build uses pinned tooling and
must not silently fall back to a normal browser-print PDF.

The public edge contains only generated static HTML and artifacts. LibreOffice,
Java, veraPDF, and source DOCX files used only for legal PDF construction remain
in build/validation stages, not in the production edge image.

## Legal content contract

### `MKR-PD-01` processing policy

The Russian policy contains at least:

1. operator identity and contacts;
2. definitions and applicable principles;
3. data-subject categories;
4. exact data categories and sources;
5. purposes and legal bases;
6. processing operations and methods;
7. retention, deletion, blocking, and destruction rules;
8. recipients/processors and the reason for using each service;
9. Russian-database localization and the actual storage boundary;
10. intended absence of cross-border transfer unless separately disclosed and
    lawfully activated;
11. security and incident-handling measures described without publishing
    exploitable detail;
12. subject rights and request procedure;
13. consent withdrawal procedure and consequences;
14. strictly necessary cookies/technical storage and SmartCaptcha processing;
15. tenant-employee processing roles;
16. revision/publication rules and authoritative-language statement.

For the public demo flow, the policy describes name, company, email, optional
phone, source page, consent revision, request id, and bounded technical
anti-abuse/captcha data. The purposes are responding to a request, arranging a
demonstration, sending a transactional confirmation, preventing abuse, and
protecting service security. There is no marketing, analytics, profiling, or
future CRM forwarding in this revision.

The business lead/correspondence retention period is no more than one year from
the last substantive contact unless a contract, legal duty, or live claim
requires another documented basis. Existing encrypted mail-delivery operational
retention remains shorter (terminal payload erasure and bounded delivery-row
cleanup) and is stated separately. The operator needs an operational procedure
to delete or archive the mailbox copy at the one-year boundary; policy text
alone is not evidence that deletion occurred.

The policy identifies the actually used services, including Yandex Cloud
hosting/Lockbox/Postbox/SmartCaptcha and the mailbox provider, and links to the
applicable provider terms. Provider legal names and roles are verified against
the operator's active contracts immediately before publication rather than
guessed from product branding.

### `MKR-PD-02` website consent

The consent is separate from the policy and contains:

- subject action that supplies the consent;
- operator name and address;
- exact purposes and data fields;
- exact operations and automated/mixed processing description;
- named processor/service categories where applicable;
- one-year validity/retention boundary;
- withdrawal route through `hello@v-b.tech` or the postal address;
- statement that withdrawal does not invalidate prior lawful processing and
  that another legal basis may require continued limited processing;
- stable document code, revision, and effective date.

The landing checkbox is initially unchecked and required. Russian copy is:

> Даю согласие на обработку персональных данных на условиях согласия и
> подтверждаю, что ознакомился с политикой обработки персональных данных.

The two document titles are separate links. English copy carries the same
meaning and revision. The accepted request stores the full consent identifier,
for example `MKR-PD-02/2026.08.01`, not only a date.

### `MKR-DPA-01` tenant instruction

When a tenant determines why and how its employees' personal data is processed,
the tenant remains the operator and Markiro acts as the person processing data
under the tenant's documented instruction. The template assigns the tenant
responsibility for lawful grounds, employee notices/consents where required,
data accuracy, purpose and scope instructions, and handling subject requests as
operator.

It does not disclaim Markiro's duties. The Markiro side accepts bounded
instructions, confidentiality, security measures, processor/subprocessor
control, incident notification, evidence/assistance obligations, request
support, and return/deletion rules. If Markiro independently determines a
purpose—for example its own billing, platform security, abuse response, or
statutory recordkeeping—the document identifies that processing separately
rather than falsely calling Markiro a processor for everything.

The downloadable `MKR-DPA-01` remains a template until party details and
instructions are completed and the parties execute it through an approved
process. A future issued instance receives the unique individual number.

### `MKR-BRD-01` letterhead

The editable letterhead contains the approved compact header/footer, styles,
page numbering, placeholders, and template warning. It contains no prefilled
counterparty details, signature, seal, approval claim, or verification status.
Its Data Matrix links to the template's own registry entry, not to a completed
document.

## Cookies and technical processing

The landing adds no analytics or marketing cookies. The policy discloses
strictly necessary browser/server data and SmartCaptcha's possible technical
processing, including IP/network metadata, browser/device characteristics,
referrer, time zone, token, and provider cookies where applicable. The captcha
script is loaded only when public submission is enabled. No cookie banner is
introduced merely for decoration; if later functionality adds non-essential
storage or tracking, it receives a separate consent design before deployment.

## Consent-version integration

`@markiro/legal-documents` exports the exact current consent identifier. The
landing renders it into `data-consent-version`; the API compares every request
against the same compiled identifier. `PUBLIC_DEMO_CONSENT_VERSION` and
`LANDING_DEMO_CONSENT_VERSION` cease to be independent configuration sources.

This change is released atomically with both landing and API images. The edge
image is deployed after the API so a newly rendered form does not temporarily
submit a revision the old API rejects. A test proves the rendered RU/EN forms,
API validator/service, confirmation email, and stored encrypted notification
all use the same identifier.

## SEO, accessibility, and AI discovery

Legal pages receive unique titles, descriptions, canonicals, RU/EN alternates,
breadcrumbs, one `h1`, dates, stable identifiers, and links from the site
footer. Active public documents are included in the sitemap and `llms.txt`.
Archived and verification pages remain indexable only when their status copy is
unambiguous; unique future tenant-document checks are `noindex`.

HTML remains the accessible source. Downloads use meaningful link text and
include file type/size. PDF has searchable text, embedded fonts, tagged
structure, reading order, real headings/lists/tables, page numbers, sufficient
contrast, and human-readable identifiers. Data Matrix has an adjacent text URL
and is never the only verification mechanism.

## Failure behavior

- A malformed registry, duplicate revision, broken translation pair, invalid
  code, invalid date, unsafe link, or missing operator field fails the build.
- A DOCX generation or LibreOffice conversion error fails the artifact job.
- A veraPDF failure prevents publishing the artifact as PDF/A.
- A digest mismatch prevents the registry and edge image from building.
- A verification lookup for an unknown or malformed common identifier returns a
  bounded branded 404 without filesystem paths or internal manifest details.
- Public form disabled mode stays functional and removes captcha/consent runtime
  data, but its copy says only that online submission is temporarily
  unavailable; it does not mention a CRM or unapproved internal dependency.
- Legal HTML remains available whether or not public submission is enabled.

## Verification

Automated verification includes:

- legal registry schema and lifecycle unit tests;
- exact code/revision/date/filename and RU/EN pairing tests;
- policy/consent required-section and operator-profile tests;
- literal Data Matrix rendering and decoded-payload tests distinct from GS1;
- DOCX structure tests for header/footer, styles, template warning, and no fake
  signature/seal;
- PDF/A-2b validation through veraPDF and searchable-text checks;
- generated SHA-256 manifest and stale-artifact rejection tests;
- rendered Astro tests for all legal/verification routes, links, downloads,
  consent copy, and shared consent identifier;
- sitemap, `llms.txt`, canonical, hreflang, structured-data, broken-link, and
  accessibility audit coverage;
- API focused tests proving old/unknown consent revisions are rejected and the
  current shared revision is accepted;
- production-bundle contracts proving build tooling stays out of the runtime
  edge and legal assets are present.

Manual/external acceptance remains separate:

- visual review of every RU/EN HTML page at desktop and mobile widths;
- 100% and print-preview review of cover and continuation PDF pages;
- DOCX review in current Microsoft Word and LibreOffice;
- Data Matrix scan from a physical A4 print with two ordinary phone cameras;
- external legal review of Russian source text and translation consistency;
- confirmation of active provider contracts, data locations, and processor
  names;
- live DNS/TLS/site verification and one controlled form/email delivery.

Automated tests do not prove physical scan quality, Word fidelity, provider
contract scope, Roskomnadzor filing, or legal correctness.

## Publication order and rollback

1. Finalize and legally review the Russian sources; generate the English
   informational translations.
2. Confirm provider legal names, contracts, Russian storage boundary, and
   retention operations.
3. Build and validate common artifacts, registry, archive, and legal pages while
   the demo form remains disabled.
4. Deploy the API with the shared consent identifier.
5. Deploy the edge with legal pages and enabled-form configuration only after
   SmartCaptcha, Postbox sender identity, SPF/DKIM/DMARC, and protected runtime
   variables pass their existing gates.
6. Verify live pages, hashes, Data Matrix, exact POST behavior, internal
   delivery, and visitor confirmation in RU and EN.

Rollback disables public submission first without removing legal pages or
already queued mail. A document release is never overwritten or deleted to
hide an error: publish a corrected revision, point `current` to it, and mark the
prior revision `superseded` or `withdrawn` with an accurate reason. Retain the
old artifact and digest for verification.

## Approved decisions

- Compact hybrid visual direction C with the real Markiro symbol.
- Data Matrix rather than Code 128 for document verification.
- Stable document code plus calendar revision and separate effective date.
- Unique future instance number with a check suffix.
- Public HTML as canonical reading source and immutable PDF/A-2b downloads.
- Editable DOCX only for clearly marked templates.
- Public immutable register, archived revisions, SHA-256, and status checks.
- Russian authoritative text plus matched English informational translations.
- One-year lead/correspondence retention boundary.
- No marketing, CRM forwarding, profiling, or analytics in this release.
- Tenant is operator for employee data purposes it determines; Markiro is its
  processor under written instruction while retaining its own statutory and
  security obligations.
- Individual tenant-document generation is reserved, not implemented in the
  first public release.
