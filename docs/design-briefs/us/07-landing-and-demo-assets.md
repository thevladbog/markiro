# U.S. Design Brief 07 — U.S. Landing Page and Demo Assets

> U.S. series, office mode + full brand. One public English page and a Russian alternate stub in
> the existing landing (`apps/landing`, Astro), plus a printable demo kit. Desktop 1440 first,
> fully responsive to 390. EN primary; the RU stub is secondary. The landing ships in the **dark
> page theme** approved in RU brief 09; draw dark first and a light variant only if the landing
> gains one. This is a **delta to RU briefs 05 (landing) and 09 (landing handoff)**: same header,
> footer, tokens, typography, `DemoForm` contract, motion and accessibility rules. Do not redesign
> the RU landing, the header or the form; add one page pair and a set of documents. Grounded in
> slice specs US-12 (landing, video, demo assets) and US-11 (evidence: screenshots, ribbon, video).

## Purpose

The page `/en/us-food-traceability/` presents **Markiro U.S. Traceability** to small and mid-sized
U.S. food processors as a **traceability readiness demonstrator** — a working product that shows
how lot-level records for three critical tracking events, a versioned Traceability Plan and a
24-hour trace request package fit together. It is not a product launch, has no pricing and makes
**no compliance claim**. Its conversions are a demo request and a link to the narrated video. The
same content, restated for print, becomes the demo kit used in discovery calls, a specialist
review and requests for structured product feedback.

Everything public is scanned by the prohibited-wording test (REG-002). A headline that fails the
test does not ship, however good it looks.

## The core idea: evidence, not promises

The RU landing sells continuity ("the line keeps running"). The U.S. page cannot sell an outcome —
"compliant", "certified", "guaranteed" are all prohibited — so it sells **evidence**: real screens
from a seeded, tagged build with the evidence ribbon visible, real numbers from a synthetic
dataset, a real 24-hour clock, a real hash on a real package, and a limitations block quoted
verbatim from the public documentation. The reader should leave knowing exactly what the product
does, what it does not do, and that nothing was hidden.

This is a deliberate departure from brief 09's rule "product scenes are drawn interfaces, not admin
screenshots": on this page the screenshots _are_ the argument. Drawn scenes remain allowed in the
hero; screenshots carry the sections that make claims.

## Page structure

Sections in order, matching the US-12 spec so the build and the design agree:

| #   | Section                        | Content                                                                                                                                                                                                                           |
| --- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | Hero                           | Headline from the allowed list below, lead sentence, primary CTA, video link, drawn scene or the ribbon-bearing readiness dashboard frame                                                                                         |
| 1   | Three critical tracking events | Receiving → Transformation → Shipping as three steps, each naming its KDE groups (Lot, Quantity, Product, Previous source / Recipient, Location, Date, References) and a screenshot                                               |
| 2   | Lot-level, not item-level      | "Lot-level workflow with optional case scanning"; SSCC / GS1-128 / QR shown as optional carriers                                                                                                                                  |
| 3   | 24-hour readiness              | The request story: received → due-at clock → validation → package (workbook, plan PDF, validation report, request report, manifest, ZIP with SHA-256) — with the elapsed time visible                                             |
| 4   | Built on a working platform    | Offline-first station, scanner-first input, tenancy, audit, label engine; link to `/en/offline-production/`                                                                                                                       |
| 5   | What the demo shows            | Scenario A numbers (2 input lots, 1 output lot, 100 cases, 0 missing required KDEs, package < 60 s), the video poster with a link, "all parties and lots are synthetic"                                                           |
| 6   | Limitations and non-goals      | The "No certification statement" paragraph of docs/us/limitations.md **verbatim**, plus the bullet list of excluded CTEs, exemptions engine, EPCIS, direct FDA submission                                                         |
| 7   | Talk to us                     | Existing `DemoSection` with `market: "us"`, phone `+1 (202) 555-0114` placeholder, note "Synthetic demo only; no customer data is shown"                                                                                          |
|     | Footer                         | Existing footer plus the one-line disclaimer "Designed to support applicable FSMA 204 recordkeeping requirements. Traceability readiness demonstrator; packages are prepared locally, not submitted to FDA." and links to docs/us |

Section 3 is the page's money shot, as the box-fill visual was for the RU page: draw the due-at
countdown chip, the validation result with "0 missing required KDEs" and the artifacts table with
hashes as one continuous story.

Rules carried over from brief 09: one H1; content-driven heights (validation errors and RU copy must
never clip); 1200 px content width; green only on actions and real positive states; motion 5/10,
one-shot reveals, reduced-motion respected; no pricing block.

## Headline and CTA copy

Candidates that pass the wording matrix (use as drawn, or vary within the allowed column):

- "Markiro U.S. Traceability — a traceability readiness demonstrator for small and mid-sized food
  processors" (the spec's hero)
- "Lot-level records for Receiving, Transformation and Shipping — designed to support applicable
  FSMA 204 recordkeeping requirements"
- "A trace request arrives. The clock says 24 hours. Here is the package."
- "Every lot has a code and a source. Every case knows its lot."
- "An FDA-aligned electronic sortable spreadsheet, prepared locally in under a minute"

CTAs that pass: **Request a demo**, **Watch the 7-minute demo**, **Read the limitations**, **See
the synthetic dataset**, **Talk to us**.

Examples that **fail** and must not appear anywhere on the page, its metadata or its images:

- "FDA-approved traceability" / "FDA certified" — prohibited outright
- "FSMA 204 compliant" / "compliance in one click" / "guarantees compliance"
- "Compliance-ready" — blocked on public surfaces until the specialist review exists (OQ-US12-7)
- "FDA requires SSCC — we print it" / "EPCIS is required by FDA" — false requirement claims
- "Never fail an FDA audit" / "Submit to FDA directly" — outcome and integration claims
- Any compliance **date** — dates live in docs/us/regulatory-basis.md and change; the page links
  there instead of printing one

The only EPCIS mention allowed is "EPCIS-ready architecture (future)".

## Visual assets

- **Screenshot frames** from the US-11 evidence set (18 frames, 1440×900, `en-US`,
  `America/Los_Angeles`, each with the evidence ribbon `Synthetic demo · <seed> · build <sha7> ·
baseline US-REG-2026-09-03 · <date>`). Map: frames 06/07/08 to section 1; 05 and 17–18 (station,
  only if the station slice ships) to section 2; 11/12/13 to section 3; 01 to the hero; 14 (plan
  preview) and 15 (limitations panel) to section 6. Crop for composition but **never crop the
  ribbon out** — it is the provenance. Frames are exported as WebP under 300 KB with factual alt
  text ("Trace request REQ-2026-APPLE-001, due in 21 h 10 m, validation with 0 errors").
- **Demo chain diagram** (`docs/us/diagrams/demo_chain.png`): optionally redrawn in brand style
  (IBM Plex, `--line` strokes, accent only on the output lot) for section 1; the redrawn version
  must keep the same nodes and labels as the source so it can be checked against it.
- **Video**: a poster still (1920×1080 frame from scene 1 with the ribbon) and a link that states
  format and size ("MP4, ~300 MB, 6:50, captions included"). **No embedded player, no iframe**
  (CSP stays unchanged; OQ-US12-2). Optional YouTube link only in e-mail, never on the page.
- **OG image** `og-us-food-traceability.jpg` at 1376×768 derived from the section 3 composition,
  not a raw admin screenshot; no prohibited phrase in the image text.

## Demo kit

All documents are English, U.S. Letter (8.5×11 in) unless the designer argues for A4, on the
English letterhead layout (`MKR-BRD-01` en), IBM Plex, monochrome with a single accent, and each
carries the same footer disclaimer as the page. They are templates: no recipient names, no
customer data. Private feedback records and memos never enter the repository.

| Deliverable                     | Content                                                                                                                                                                                                          | Layout guidance                                                                                   |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| One-pager (PDF)                 | Problem (24-hour records, lot-level KDEs, small processors); what it does (three CTEs, TLC/source, plan, request, spreadsheet); what it is not (limitations verbatim); demo numbers; page + video links; contact | One side; three columns or a 2/3 + 1/3 split; the limitations block boxed, not footnoted          |
| Deck outline (8–10 slides)      | Context and rule timeline (dated, from regulatory-basis.md); target users; three-CTE flow; data model; demo walkthrough stills; evidence ladder; platform foundation; limitations; roadmap (P1/P2); next steps   | Title + one idea per slide; stills with ribbon; limitations slide is mandatory, never an appendix |
| Discovery-call guide            | 30-minute agenda; 12 open questions (current lot records, how a request is answered today, who assigns TLCs, documents, case scanning, ERP/EDI); what to demo live vs. video; follow-up and note templates       | One sheet, two columns: agenda left, questions right; note template records business facts only   |
| Specialist review memo template | Purpose (scope and terminology review, explicitly not a legal opinion or certification); materials provided; questions on CTE/KDE mapping and wording; requested output; compensation disclosure; timeline       | Letter form; questions numbered so answers can be cited                                           |
| Product feedback guide          | A neutral question set for optional practitioner feedback, plus a short follow-up e-mail template                                                                                                                | Checklist style; business observations only, with explicit consent rules                          |

The feedback guide records what the participant reviewed, which workflow or artifact they found
useful, where the workflow differs from current practice, and any concerns or missing steps. It
must not solicit purchase commitments, commercial promises, endorsements, compliance claims or
confidential company data. A participant's name or organization is recorded only with explicit
consent; otherwise the evidence register uses a neutral participant id and hash.

## States to draw

- Page default (dark), 1440 / 834 / 390.
- **Form disabled variant**: when submissions are off site-wide, section 7 shows the phone and a
  mail link with "Requests are handled by e-mail at the moment" — no dead button.
- Form states from brief 09 §7 (idle, focus, invalid, submitting, success, recoverable error, rate
  limited, offline) with EN copy and the consent line referencing the EN consent artifact.
- **RU alternate stub** `/proslezhivaemost-pishchevoi-produktsii-ssha/`: a two-paragraph summary
  plus the limitations block, same header and footer, a link to the full EN page. It exists for
  hreflang reciprocity and honest cross-linking, not as a sales page.
- Video poster with the link, and the poster's fallback when the image fails (text card).
- Screenshot frame with a long ribbon at 390 px (the ribbon wraps, never truncates).
- Light variant of the page only if the landing gains a light theme; otherwise mark "dark only".

## Accessibility

Brief 09 §10 applies unchanged: one `<main>`, sequential headings, skip link, 44 px targets, AA
contrast on the dark theme, focus order equals DOM order, form errors announced. In addition: every
screenshot has factual alt text and its ribbon text is repeated in a caption; the limitations block
is live text, never an image; the countdown and hashes in section 3 are text; the video link names
its size and duration so nobody starts a 300 MB download by surprise; the diagram, if redrawn, has
a concise accessible summary listing the three events in order.

## SEO and hreflang

Title 30–70 characters and description 100–180 (enforced by the landing tests), both free of
prohibited phrases; canonical on `https://markiro.app`; hreflang `en` / `ru` / `x-default` for the
page pair; JSON-LD `SoftwareApplication.description` in allowed wording only; the page is in the
sitemap and `llms.txt` automatically once registered. The EN header gains a "U.S. traceability"
link; the RU header is unchanged. Zero Cyrillic on the EN route (existing test).

## How this grows

- A second scenario (Scenario B, generic beverage) becomes another card in section 5 with its own
  "not classified as FTR-covered" line; the grid already holds two.
- Product feedback records and the review memo, once obtained, are cited by id and hash in the evidence
  register; the page may then gain a short "Reviewed by" line — only after the memo exists.
- If a light landing theme arrives, this page follows the tokens with no structural change.
- A U.S.-specific pricing or sign-up flow is out of scope and must not be reserved for in layout.

## Questions for the designer

1. Should the U.S. page carry a distinct accent or imagery style (cooler palette, U.S. plant
   photography), or stay identical to the RU landing so the brand reads as one product?
2. Is the RU alternate a short summary (recommended by OQ-US12-1) or a full translation? A full
   translation doubles the wording-gate surface.
3. Hero: a drawn scene in the brief 09 style, or the ribbon-bearing readiness dashboard frame?
4. Should `x-default` for this pair point to the EN page rather than RU (the site default)? The
   audience is U.S.; the current site rule sends unknown locales to RU.
5. Printable demo documents: U.S. Letter or A4, given the existing document template was designed for A4?
6. Do we redraw `demo_chain.png` in brand style for the page and the deck, or keep the Graphviz
   original as-is to avoid a second source of truth?
