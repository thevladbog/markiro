# U.S. Design Brief 01 — Language, Formats and Adaptation Rules

> First stage of the U.S. series. This brief takes the slot that "Brand &
> naming" (RU brief 01) held: the brand, logo, palette and typography **stay
> exactly as approved**. What changes for the U.S. product is language, formats,
> terminology and — above all — what we are allowed to claim. Every later U.S.
> brief (02–07) and every string in a mockup must obey this document. Office
> and floor modes, light + dark, EN primary with RU strings kept alive. Delta to
> RU briefs 01 and 02; do not touch tokens or components — add vocabulary and
> patterns on top of them.

## Purpose

An FDA request is answered with records, not with reassurance. The U.S.
product therefore has to sound like a careful record-keeper: precise about
what it stores, quiet about what it promises. The RU product could say "no
fines"; the U.S. product may not say "compliant". This brief makes that
register concrete enough that a designer can write a chip label or an empty
state without a lawyer in the room — and gives the format rules (dates,
units, phones, addresses) that make a U.S. plant manager trust the screen at a
glance.

## The core idea: show the record, never the verdict

Every string in the U.S. area answers one of two questions: _what has been
recorded_ and _what is still missing_. It never answers _are we compliant_.
This is why:

- The rule places responsibility on the covered entity; a tool that implies a
  verdict misleads the buyer and is prohibited wording (REG-002).
- "What is missing" is more useful than a score: the QA manager can act on
  "Missing: phone, ZIP" and cannot act on "82 % compliant".
- It keeps the product honest under both U.S. profiles: the generic profile
  records the same facts without any FTR framing.

Practical consequence: prefer nouns and field names over adjectives. "Data
readiness 14 of 16 checks" beats "Almost ready". "Finalized 09/15/2026 by
J. Alvarez" beats "Locked".

## 1. Tone and copy rules

RU brief 01 set the tone: plain, businesslike, concrete, "the line keeps
running, no fines, reports in two minutes". The English mirror keeps the
plainness and swaps the promise for the deliverable:

| RU register (brief 01)            | U.S. register                                                                                                                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "No fines"                        | "Built for the 24-hour trace request" (capability wording; the measured criterion is a trained operator completing a mock request in under 15 minutes of human time, `docs/us/acceptance.md` §1) |
| "Reports in two minutes"          | "Package generation measured under 60 seconds on the demo dataset, with hashes" (`docs/us/acceptance.md` C-014; never an unqualified "under a minute")                                           |
| "The line keeps running"          | "Finalized records are never overwritten — every change is a revision" (a design fact, not a durability promise; no "nothing lost")                                                              |
| Imperative, friendly to operators | Same; sentence case; no exclamation marks; no legalese                                                                                                                                           |

Rules:

- Sentence case for labels and buttons ("Prepare package", not "Prepare
  Package"). Title case only for proper nouns: Traceability Plan, Food
  Traceability List, Receiving.
- Buttons are verbs that describe the local action: Save draft, Finalize,
  Amend, Void, Approve version, Run validation, Prepare package, Download
  package (ZIP). Never Submit, Send, Upload, File, Report to FDA.
- Say "FDA" only in nouns that are FDA's own (Food Traceability List, FDA
  Food Traceability Rule, FDA-aligned electronic sortable spreadsheet). Never
  in a verb phrase.
- Errors name the field and the fix: "Phone is required for a case-ready
  location." Not "Invalid location".
- Numbers carry units; dates carry the zone when the zone matters.
- Do not translate RU strings literally into EN; write EN first, then RU.

## 2. Claims matrix in microcopy

The binding matrix is in brief 00 and `docs/us/limitations.md`. Applied to
real UI elements:

| Element                      | Write this                                                                                                  | Never this                                 |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Overview footer              | Designed to support applicable FSMA 204 recordkeeping requirements. Traceability readiness demonstrator.    | FDA-compliant traceability. FDA certified. |
| Readiness metric label       | Data readiness — 14 of 16 checks; explanatory only, not a compliance score                                  | Compliance score 87 %                      |
| Coverage chip                | Covered · reviewed 09/10/2026                                                                               | FDA covered / Approved                     |
| Coverage banner (unknown)    | Coverage not yet reviewed — blocks a case-ready package until a reviewer sets a status and rationale        | Non-compliant product                      |
| Generic-profile statement    | Not classified as FTR-covered; general lot traceability only                                                | Exempt from FDA rule                       |
| Trace request wizard button  | Prepare package                                                                                             | Submit to FDA / Send / Upload              |
| Package ready panel          | Package prepared locally; delivery to the requester is performed by the covered entity                      | Sent to FDA / Filed                        |
| Case-ready chip              | Case-ready · 0 errors                                                                                       | Compliant / Certified                      |
| Export disclaimer (Metadata) | Prepared locally; not submitted to FDA. Coverage and exemption status are manual, reviewed classifications. | Official FDA export                        |
| Cases / SSCC hint            | Case scanning is an operational aid, not a regulatory requirement                                           | FDA requires SSCC on every case            |
| EPCIS mention (landing)      | EPCIS-ready architecture (future)                                                                           | EPCIS required by FDA / EPCIS certified    |
| Empty lots list              | Lots are created by Receiving and Transformation events. You can also add an imported lot.                  | No compliant lots yet                      |
| Empty trace requests         | Run a mock request to check how fast records can be prepared. Nothing leaves this system.                   | Practice your FDA submission               |
| Landing hero                 | Markiro U.S. Traceability — a traceability readiness demonstrator for small and mid-sized food processors   | FSMA 204 compliance, guaranteed            |
| Video / deck headline        | Three events, one lot code, a package in under a minute                                                     | FDA-approved recall software               |

## 3. Terminology: RU product concept → U.S. screen label

| RU concept (briefs 03–08)                              | U.S. label                                | Note                                                                             |
| ------------------------------------------------------ | ----------------------------------------- | -------------------------------------------------------------------------------- |
| Counterparty (контрагент)                              | Party                                     | Legal organization; a party owns one or more Locations (supplier, recipient, …). |
| Organization profile                                   | Organization profile + Regulatory profile | New Settings block; timezone list switches to U.S. zones.                        |
| Product card                                           | Product + FTL review (side panel)         | Coverage status and Product Description live beside the RU card, not inside it.  |
| Product group (Chestny ZNAK)                           | FTL category                              | Different field; never reuse the RU group as category.                           |
| Shift (production task)                                | Shift                                     | Unchanged; a Transformation may link one closed shift.                           |
| Box / pallet (aggregation)                             | Case                                      | Pallets are not in P0; "case" everywhere, "box" only in RU screens.              |
| SSCC (group label)                                     | Case identity (SSCC, optional)            | Chip/hint always says optional.                                                  |
| History & codes                                        | Trace search                              | Searches TLC, reference, SSCC, product — never marking codes.                    |
| Exports (GIS MT / 1C)                                  | Trace request package                     | Workbook + plan + validation report + manifest; not a channel (brief 08).        |
| Label template                                         | Label template                            | Adds a "Traceability (U.S.)" field group; U.S. stock sizes 4×6 in at 203 dpi.    |
| Operator PIN / badge                                   | Unchanged                                 | Station identity model is untouched.                                             |
| Codes, Conflicts, Pickup, Disaggregation, Integrations | —                                         | Hidden for U.S. profiles; no U.S. equivalent in P0.                              |

What must **not** be mapped or mentioned in U.S. profiles: Chestny ZNAK, KM /
marking code, DataMatrix validation, GIS MT, EGAIS, 1C / CommerceML, INN,
national catalog, tolling under a customer GLN. GLN and GS1 prefixes remain as
optional identifiers on locations and in Settings; the copy says "optional".

## 4. U.S. formats

| Item        | Rule                                                                                                                                                                                                  | Example                                                      |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Date        | `MM/DD/YYYY`, tenant timezone. Stored ISO; the UI never shows ISO except in monospace hash/metadata blocks. Date pickers open on U.S. week (Sunday first).                                            | 09/15/2026                                                   |
| Date + time | `MM/DD/YYYY h:mm AM/PM` with the zone abbreviation when a deadline is involved; 24 h clock nowhere on U.S. screens.                                                                                   | 09/17/2026 9:14 AM PDT                                       |
| Timezone    | One operational zone per tenant, chosen from the U.S. list (Eastern to Hawaii, Puerto Rico). Show the IANA name in settings, the abbreviation next to times.                                          | America/Los_Angeles → PDT / PST                              |
| DST         | The 24-hour due time is absolute (received + 24 elapsed hours), so across the fall-back on 11/01/2026 it displays one wall-clock hour earlier. Draw one screen state that shows this without comment. | Received 10/31/2026 3:14 PM PDT → due 11/01/2026 2:14 PM PST |
| Decimal     | Up to 3 fraction digits, `.` separator, `,` thousands in display only; no exponent; never rounded silently.                                                                                           | 1,000.5 lb                                                   |
| Unit        | Always explicit, from the closed list: lb, oz, kg, g, each, case, bag, cup, gal, l. Two fields (quantity + unit), never a combined string in a form. No conversion.                                   | 50 bag · 500 lb                                              |
| Phone       | Stored and displayed as typed (extensions preserved). Input placeholder `+1 (509) 555-0101`; validation is loose (digits, `+ - ( ) . x ext`).                                                         | +1 509-555-0101 x12                                          |
| Address     | Street, City, State (two-letter code, uppercase), ZIP (text, 5 or 5+4), Country (ISO code, display name). Coordinates variant: latitude / longitude, 6 decimals.                                      | 500 Example River Pkwy, Portland, OR 97203, US               |
| Country     | Default `US`; select with ISO codes and display names.                                                                                                                                                | US · United States                                           |
| Identifiers | TLC, SSCC, hashes, event numbers in tabular/monospace figures.                                                                                                                                        | NRF-260915-APL01                                             |
| Label sizes | Inches for U.S. stock templates (4×6 in); millimeters remain for RU templates.                                                                                                                        | Case 4×6 in (203 dpi) — TLC                                  |

Note for the designer: the FDA-aligned workbook writes typed date cells as
`yyyy-mm-dd` (sortable, per the export spec), while every screen shows
`MM/DD/YYYY`. The run detail page should say so in one line under the
artifact list ("Dates in the workbook are ISO for sorting").

## 5. Snapshot vs current master data

A finalized event stores a **snapshot** of every Product Description and
Location Description it used. The screen shows the snapshot, not the live
record:

- Read-only KDE views render the frozen description; the location name is a
  link to the current record, the description text is not.
- When the master record has changed since finalization, add a subtle
  note under the block: "Master data changed since this record was finalized
  (09/20/2026). The record keeps the original values." No warning color — it
  is information, not a problem.
- Drafts show live master data and a one-line hint: "Values are copied into
  the record when you finalize."
- Archiving a party, location or product never changes a finalized record;
  the snapshot block shows an "Archived" text tag next to the link.

## 6. Immutability language

| Action on a finalized record | Label        | Dialog                                                                                                    |
| ---------------------------- | ------------ | --------------------------------------------------------------------------------------------------------- |
| Correct it                   | Amend        | "Create revision 2 of REC-26-0007" · reason field (required) · "The previous revision stays readable."    |
| Withdraw it                  | Void         | "Void REC-26-0007" · reason field (required) · "The record is kept and excluded from traces and exports." |
| Never                        | Edit, Delete | These words do not exist on finalized, amended or void records.                                           |

- Draft records may use Edit, Save draft and Discard draft (a draft is not a
  regulated record).
- Revision headers read "Revision 2 · amends revision 1 · reason: quantity
  corrected after recount · by M. Chen · 09/16/2026 3:40 PM PDT".
- Export runs and packages are named by revision: `REQ-2026-APPLE-001 · r2`.
  "Prepare new revision" explains: "Freezes current data as a new revision.
  Prior packages are never replaced."

## 7. Status vocabulary and chips

Map every U.S. status onto the existing chip statuses (`ok / error / warn /
info / neutral`, brief 02). Rule for each: color **and** glyph **and** text,
always; the text is the status word, never a symbol alone.

### Event lifecycle

| Status    | Chip    | Text      | Glyph        | Where it appears                                   |
| --------- | ------- | --------- | ------------ | -------------------------------------------------- |
| draft     | neutral | Draft     | pencil       | Lists, detail header; Finalize button present      |
| finalized | ok      | Finalized | check        | Detail header with date and actor                  |
| amended   | info    | Amended   | branch/arrow | Old revision; banner links to the new one          |
| void      | error   | Void      | slash-circle | Banner with reason and actor; excluded from traces |

Blocked finalize is not a status: the Finalize button is disabled with the
text "Complete data first — 3 errors" next to it, linking to the panel.

### Lot lifecycle

| Status      | Chip    | Text        | Notes                                                          |
| ----------- | ------- | ----------- | -------------------------------------------------------------- |
| active      | ok      | Active      | Derived text label "Partially shipped" when some quantity left |
| consumed    | neutral | Consumed    | Used by a Transformation                                       |
| shipped     | neutral | Shipped     | Balance reached zero                                           |
| quarantined | warn    | Quarantined | Disabled in shipping pickers with the reason                   |
| recalled    | error   | Recalled    | Disabled in shipping pickers with the reason                   |
| archived    | neutral | Archived    | Hidden by default filter, never deleted                        |

### Coverage status (product FTL review)

| Status                    | Chip    | Text                                | Effect shown in UI                        |
| ------------------------- | ------- | ----------------------------------- | ----------------------------------------- |
| covered                   | ok      | Covered                             | —                                         |
| contains_ftl_same_form    | ok      | Contains FTL ingredient (same form) | —                                         |
| not_covered               | neutral | Not covered                         | —                                         |
| unknown                   | warn    | Not reviewed                        | Inline alert: blocks a case-ready package |
| exemption_review_required | warn    | Exemption review required           | Inline alert: blocks a case-ready package |

Under the generic profile the chip is replaced by the fixed text "Not
classified as FTR-covered".

### Readiness and validation severities

| Severity | Chip  | Text    | Meaning                                                  |
| -------- | ----- | ------- | -------------------------------------------------------- |
| error    | error | Error   | Blocks Finalize / case-ready until fixed or acknowledged |
| warning  | warn  | Warning | Does not block; some require an explicit acknowledgement |
| info     | info  | Info    | Provenance notes (superseded, excluded void row)         |

### Other chips used across the series

| Domain        | Values (chip → text)                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| Location      | ok → Case-ready; warn → Missing: phone, ZIP (list the fields)                                          |
| Trace request | neutral → Open; info → Validated; info → Package ready; ok → Case-ready; neutral → Closed              |
| Due time      | info → Due in 5 h 12 m; warn → Due in 58 m; error → Overdue by 40 m (glyph: clock; `aria-live` polite) |
| Plan version  | neutral → Draft; ok → Effective; neutral → Superseded                                                  |
| Station link  | ok → Linked; warn → Linked with override; error → Blocked; neutral → Not linked                        |
| Profile badge | text-only, no chip color: US · FSMA 204 / US · Generic                                                 |

## 8. The regulatory baseline stamp and the disclaimer block

Two patterns recur on the overview, the plan, every export run and the
evidence ribbon. Design them once as components:

**Baseline stamp** — a compact definition row: `Baseline US-REG-2026-09-03 ·
verified 09/03/2026 · sources FDA-01…FDA-10, GS1-01, GS1-02` with the source
list expandable (id, title, link, checked date). Monospace for the ID,
regular text otherwise. Never colored as a status; it is metadata.

**Disclaimer block** — fixed text, small, full width, above the footer of the
overview and the plan editor and inside the package-ready panel:

> Designed to support applicable FSMA 204 recordkeeping requirements.
> Traceability readiness demonstrator. Prepared locally; not submitted to FDA.
> Coverage and exemption status are manual, reviewed classifications.

The generic profile appends "Product(s) not classified as FTR-covered; general
lot traceability record." The block is never a dismissible banner.

## 9. RU-string resilience

Every U.S. key has an RU string for the lockstep test even though U.S. tenants
run in English. Layouts must survive it (brief 02 rule): chip labels
"Exemption review required" and its RU equivalent both fit without
truncation; KDE group headers wrap to two lines gracefully; date columns are
sized for `MM/DD/YYYY` and `DD.MM.YYYY` alike.

## 10. Dark mode notes

- Status chips keep the semantic tokens; the U.S. area adds no new colors.
- Monospace metadata (hashes, baseline ID, TLC) uses the neutral-fg token,
  not a dimmed one — auditors read these.
- The evidence ribbon and the disclaimer block must pass AA on both themes as
  plain text; no tinted background.
- Floor mode (brief 06): the "Traceability lot" card uses the same dark-first
  surfaces as the box-fill visual; the warn/block full-screen states reuse the
  amber/red signal screens of RU brief 04 with English copy.

## Cross-cutting notes

- Copy is data: designers hand over strings in a sheet keyed by screen and
  element so they can be pasted into `en.json` and pass the content test.
- Any new status word must be added to section 7 before it appears in a
  mockup — a chip with an unmapped word is a design defect.
- Where a slice spec leaves a choice open (event number format `REC-26-0007`
  is a recommendation, not a decision; per-line vs per-event previous source
  is decided as per-event), use the recommendation and mark it in the mockup.

## How this grows

More profiles (a distributor or a farm profile) add rows to the terminology
table and possibly new CTEs; they do not add a second tone or a second chip
family. More languages (Spanish for the shop floor is the obvious next one)
add a column to the copy sheet. New claims allowed after a specialist review
("compliance-ready") are added to the matrix by change control, never by a
designer's judgement.

## Questions for the designer

1. Distinct accent for U.S. tenants: none (our default) or a subtle sidebar
   section marker? Decide together with brief 00 question 1.
2. The existing `warn` glyph reads as "duplicate" (⧉). Propose a
   generic attention glyph for both products or a per-product glyph override.
3. Due-time chip: should the amber "Due in under 1 hour" threshold be fixed at
   60 minutes, or configurable per tenant? Draw the fixed version.
4. Phone display: we render as typed. Should the input offer a formatting
   helper (auto-inserting parentheses) or stay a plain text field?
5. Where the master-data-changed note and a revision banner both apply, do
   they merge into one line or stay separate?
