# Regulatory basis: FDA Food Traceability Rule (FSMA 204)

- Source: MUS-001 v0.1 (2026-09-03), sections 2.1-2.9 and 16
- Status: baseline, not yet implemented
- Owner: Vladislav Bogatyrev

This document is the regulatory baseline for the `US_FSMA204_PROCESSOR` profile
of Markiro U.S. Traceability. It records what the FDA Food Traceability Rule
(FTR, 21 CFR Part 1 Subpart S) currently states, which parts are in P0 scope,
and how the baseline is re-verified before every release (requirement REG-001,
REG-012). It is a source register and a working summary, not a legal opinion
from a U.S. independent reviewer or food-safety consultant. Permitted and prohibited
wording is defined in [limitations.md](limitations.md); the requirements
derived from this baseline live in [requirements.md](requirements.md).

## Baseline record

- Baseline ID: `US-REG-2026-09-03`
- Verified: 2026-09-03
- Reviewer: Vladislav Bogatyrev
- Next review: before every tagged release (see
  [Regulatory change control](#regulatory-change-control))
- Sources checked: FDA-01 to FDA-10, GS1-01, GS1-02, MKR-01 to MKR-03 (see
  [Source register](#source-register))

The baseline ID, the verification date and the list of sources must be shown
in the tenant profile and in every compliance-oriented export (REG-001).

## Current status of the rule

The FTR establishes additional recordkeeping requirements for persons who
manufacture, process, pack or hold foods on the Food Traceability List (FTL).
FDA states that records must contain the Key Data Elements (KDE) associated
with the relevant Critical Tracking Events (CTE) and must be made available on
request within 24 hours. The timeline, as stated on FDA-01 on 2026-09-03, has
three distinct parts that must not be collapsed into one date:

- The original compliance date for all persons subject to the rule was
  January 20, 2026.
- FDA has proposed extending the compliance date by 30 months to July 20, 2028. This is a proposed rule, not a finalized change to the compliance date.
- The Continuing Appropriations, Agriculture, Legislative Branch, Military
  Construction and Veterans Affairs, and Extensions Act of 2026 directed FDA
  not to enforce the rule before July 20, 2028, and FDA states it intends to
  comply with that directive.

For every release the regulatory information must be re-verified against the
official sources. [FDA-01]

Practical meaning for the product: the non-enforcement window until July 20,
2028 is not a reason to postpone development. It allows P0 to be positioned as a readiness
platform and to run pilots before enforcement starts, while keeping cautious
wording.

## Applicability and the Food Traceability List

The additional requirements do not automatically apply to all foods. P0
includes a manual, reviewed classification for every SKU (REG-003, PRD-003,
PRD-004). Fresh-cut fruits are included in the FTL, so the synthetic scenario
with fresh-cut apple slices and snack cups gives an unambiguous regulatory
teaching example. [FDA-02]

## Critical Tracking Events

| CTE                                                                 | Meaning for P0                                                                               | Status |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------ |
| Receiving                                                           | Receipt of food after transport from another location.                                       | P0     |
| Transformation                                                      | Manufacturing/processing, commingling, repacking/relabeling, when the output is an FTL food. | P0     |
| Shipping                                                            | Arranging transport from one location to another, except direct-to-consumer/donation.        | P0     |
| Harvesting / Cooling / Initial Packing / First Land-Based Receiving | Other supply-chain roles.                                                                    | P2     |

Only the three processor CTEs are available in the P0 profile; the other CTEs
are explicitly marked as out of scope (REG-004). [FDA-01] [FDA-03]

## Traceability Lot Code

- The TLC is the identifier of a traceability lot in the records of the source.
- A new TLC is assigned at initial packing, first land-based receiving or
  transformation.
- Shipping must not create a new TLC (REG-005, SHP-003).
- The TLC must be linked to a TLC source, the physical location where the code
  was assigned, or to an acceptable TLC source reference (LOC-003, LOT-003).
- The rule does not impose a specific TLC format and does not require printing
  the TLC on the package (LOT-002).

[FDA-09]

## Traceability Plan

For the processor profile the plan must describe: where and in what format the
records are kept; how FTL foods are identified; how TLCs are assigned; who is
the point of contact; how and when the plan is updated. A farm map does not
apply to the selected processor scenario. Previous versions of the plan must be
retained for at least two years after an update (REG-007, REG-009). [FDA-04]

## Electronic sortable spreadsheet

FDA publishes an illustrative workbook: separate tabs per CTE, with composite
KDEs (for example, Location Description) decomposed into separate columns. The
specific template is not the only acceptable form, but for an export-ready P0 it
is advantageous to build a versioned adapter that stays as close as possible to
the published structure for Receiving, Transformation and Shipping. [FDA-05]

## Technology-neutral recordkeeping and EPCIS

FDA does not require a specific application, barcode or EPCIS. EPCIS is a
useful standard for exchanging event data and a possible future adapter,
but it is not a blocker for P0 (REG-010). Markiro must deliver value through
data quality, workflow and export, not through a claim that the chosen
technology is prescribed by the regulator. [FDA-07] [GS1-01]

## Findings from the FDA 2026 tabletop exercises

- Most participants met the 24-hour window, but partner alignment mattered more
  than any specific technology.
- TLC and TLC source were the most difficult KDEs: complete linkage across all
  CTEs was noticeably weaker than partial data availability.
- Missing quantities, incomplete CTE coverage and inconsistent buyer-specific
  formats were problems.
- The Traceability Plan helped FDA interpret the data and discover gaps.
- Therefore P0 must make TLC/TLC source and data completeness visually
  unavoidable, and keep buyer-specific extras separate from the regulatory
  minimum.

[FDA-06]

## Regulatory change control

1. Before every public/tagged release open FDA-01, FDA-02, FDA-07, FDA-05 and
   FDA-06.
2. Record the verification date and any changes in this file (the
   [Review log](#review-log) below). MUS-001 section 2.9 refers to this file as
   `docs/us/regulatory-baseline.md`; the canonical path in this repository is
   `docs/us/regulatory-basis.md` as listed in MUS-001 section 5.1.
3. If a norm or a form has changed, create a separate ADR and a new
   migration/adapter version; do not rewrite previously finalized records.
4. Check public claims and demo narration against
   [limitations.md](limitations.md).
5. Obtain a review by a U.S. food-safety specialist before using the words
   "compliance-ready".

The release checklist must contain a mandatory source refresh with date,
reviewer and diff note (REG-012).

## Source register

The register was verified on 2026-09-03. Re-verification is mandatory before a
tagged release. The links below are a source register, not a legal opinion.

| ID     | Source                                                 | Purpose                                                                                                                         | URL                                                                                                                                    |
| ------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| FDA-01 | Food Traceability Rule main page                       | Official rule overview, CTEs, TLC, traceability plan, 24-hour availability, current enforcement direction.                      | https://www.fda.gov/food/food-safety-modernization-act-fsma/fsma-final-rule-requirements-additional-traceability-records-certain-foods |
| FDA-02 | Food Traceability List                                 | Current FTL categories; fresh-cut fruits are included.                                                                          | https://www.fda.gov/food/food-safety-modernization-act-fsma/food-traceability-list                                                     |
| FDA-03 | Critical Tracking Events and Key Data Elements         | Official KDE summaries for shipping, receiving and transformation.                                                              | https://www.fda.gov/media/163132/download?attachment=                                                                                  |
| FDA-04 | Traceability Plan Example for Food Processor           | Processor plan structure, FTL flagging, TLC assignment and two-year prior-plan retention.                                       | https://www.fda.gov/media/188100/download?attachment=                                                                                  |
| FDA-05 | Electronic Sortable Spreadsheet template               | Illustrative FDA workbook layout and composite KDE field decomposition.                                                         | https://www.fda.gov/media/179616/download?attachment=                                                                                  |
| FDA-06 | Traceability Readiness Tabletop Exercises Final Report | 2026 readiness findings: 24-hour requests, TLC/TLC source gaps, data completeness and partner alignment.                        | https://www.fda.gov/media/192993/download?attachment=                                                                                  |
| FDA-07 | Food Traceability Rule FAQs                            | Technology-neutral recordkeeping; EPCIS optional; third parties may maintain records while covered entities remain responsible. | https://www.fda.gov/food/food-safety-modernization-act-fsma/frequently-asked-questions-fsma-food-traceability-rule                     |
| FDA-08 | Product Tracing System                                 | FDA intake concepts; spreadsheet is required only in specified situations; EPCIS is not an industry submission requirement.     | https://www.fda.gov/food/new-era-smarter-food-safety/product-tracing-system                                                            |
| FDA-09 | Traceability Lot Code                                  | TLC assignment rules, TLC source, packaging/label flexibility.                                                                  | https://www.fda.gov/food/food-safety-modernization-act-fsma/traceability-lot-code                                                      |
| FDA-10 | Low- or No-Cost Food Traceability                      | FDA policy interest in affordable traceability tools for smaller operations.                                                    | https://www.fda.gov/food/new-era-smarter-food-safety/low-or-no-cost-food-traceability                                                  |
| GS1-01 | EPCIS & CBV                                            | Optional interoperability model describing what, when, where, why and how of supply-chain events.                               | https://www.gs1.org/standards/epcis                                                                                                    |
| GS1-02 | EPCIS / CBV 2.0.1 artefacts                            | Current normative schemas and OpenAPI artefacts for a later interoperability phase.                                             | https://ref.gs1.org/standards/epcis/artefacts                                                                                          |
| MKR-01 | Markiro README                                         | Current product capabilities and public architecture overview.                                                                  | https://github.com/thevladbog/markiro/blob/main/README.md                                                                              |
| MKR-02 | Markiro Architecture                                   | Current monorepo, station, offline/sync, data retention, public API and tenant boundaries.                                      | https://github.com/thevladbog/markiro/blob/main/docs/architecture.md                                                                   |
| MKR-03 | Markiro AGENTS.md                                      | Repository-specific source-of-truth order, TDD workflow, migration rules and verification commands.                             | https://github.com/thevladbog/markiro/blob/main/AGENTS.md                                                                              |

The MKR-01…MKR-03 links point at `main`; the revision checked for this baseline is commit `4e3a7380eb169cf4cb56a5333fc96fd1ac0447c7` (main, 2026-09-03). Cite that SHA when a reader needs the exact text.

## Review log

| Date       | Reviewer            | Sources checked                                    | Changes                                                                                                    |
| ---------- | ------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 2026-09-03 | Vladislav Bogatyrev | FDA-01 to FDA-10, GS1-01, GS1-02, MKR-01 to MKR-03 | Initial baseline `US-REG-2026-09-03`.                                                                      |
| 2026-09-04 | Vladislav Bogatyrev | Owner product and deployment decisions             | Defined the bounded MVP and dedicated U.S. deployment/data-location boundary; no regulatory-source change. |

## Related documents

- [README.md](README.md) - overview of the U.S. bounded context
- [requirements.md](requirements.md) - requirement register (REG, PRO, LOC,
  PRD, LOT, REC, TRN, SHP, TRC, PLN, EXP, STN, INT, NFR, EVD)
- [requirements-traceability.md](requirements-traceability.md) - requirement
  to test/evidence matrix
- [data-dictionary.md](data-dictionary.md) - KDE and CTE field dictionary
- [limitations.md](limitations.md) - limitations, non-goals and language rules
- [implementation-plan.md](implementation-plan.md) - slices US-00 to US-12
