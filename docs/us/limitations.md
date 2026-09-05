# Limitations and non-goals

> Revised 2026-09-04: read the [shared MVP contract](mvp-contract.md) first. It resolves cross-slice scope and safety rules and supersedes conflicting draft recommendations below. Design only; implementation is not claimed.

- Source: MUS-001 v0.1 (2026-09-03), sections 1.4, 4.5 and 14
- Status: baseline, not yet implemented
- Owner: Vladislav Bogatyrev

This file is the public "limitations and non-goals" statement required by
requirement EVD-007: the public documentation must list the excluded CTEs, the
exemptions engine, EPCIS and direct FDA integration as out of scope. It applies
to the `US_FSMA204_PROCESSOR` and `US_GENERIC_LOT_TRACEABILITY` profiles of
Markiro U.S. Traceability. The regulatory context is in
[regulatory-basis.md](regulatory-basis.md); the in-scope requirements are in
[requirements.md](requirements.md).

## No certification statement

Markiro U.S. Traceability is a traceability readiness demonstrator designed to
support applicable FSMA 204 recordkeeping requirements under the FDA Food
Traceability Rule (FTR, 21 CFR Part 1 Subpart S). It has not been approved or
certified by FDA, and it does not guarantee compliance with the FTR or any
other regulation. It does not automatically decide whether a product, a
supplier or a transaction is covered by, or exempt from, the FTR: coverage and
exemptions remain a manual, reviewed classification whose final assessment
stays with the user or their consultant (REG-003, REG-011). It does not submit
records to FDA; trace request packages are prepared in the U.S. instance and delivered by
the covered entity (REG-008). This document is not legal or food-safety advice.

## What is not in P0

The following items are deliberately excluded from the P0 MVP scope
(MUS-001 section 1.4):

- a full exemptions/waivers engine;
- the Harvesting, Cooling, Initial Packing and First Land-Based Receiving CTEs
  (P0 covers Receiving, Transformation and Shipping only, see REG-004);
- direct FDA submission or integration with the Safety Reporting Portal;
- an EPCIS/CBV adapter;
- mandatory item serialization, RFID or case-by-case scanning;
- SOC 2, commercial billing, payment and self-service onboarding;
- full integration with all ERP/EDI providers;
- any statement of certified compliance.

## Language rules

Wherever the UI, documentation, demo narration or public copy makes a
regulatory or compliance statement, it uses the wording in the "Allowed"
column (REG-002). Ordinary UI strings are not restricted; what is banned
everywhere is the "Not allowed" column, which lists prohibited claims. They
are reproduced here only so that reviewers and negative tests can recognise
them (MUS-001 section 4.5).

| Allowed                                                             | Not allowed                      |
| ------------------------------------------------------------------- | -------------------------------- |
| Designed to support applicable FSMA 204 recordkeeping requirements. | FDA approved / FDA certified.    |
| FDA-aligned electronic sortable spreadsheet.                        | Official FDA integration.        |
| Traceability readiness demonstrator.                                | Guarantees compliance.           |
| Lot-level workflow with optional case scanning.                     | FDA requires serialization/SSCC. |
| EPCIS integration is outside the MVP scope.                         | EPCIS is required by FDA.        |

The wording "compliance-ready" requires a separately approved, scope-specific wording decision after a review by a U.S.
food-safety specialist (see the change-control procedure in
[regulatory-basis.md](regulatory-basis.md)).

## Future product capabilities

The MVP proves one synthetic processor workflow. It does not include live customer operations,
all CTEs and exemptions, direct FDA integration, EPCIS, RFID, full EDI, commercial billing,
self-service onboarding, multi-region infrastructure or enterprise certification.

## Deferred beyond the MVP

The following directions are consciously deferred (MUS-001 section 14). Each
has a reason and a trigger that would reopen it; none of them is a P0
dependency.

| Direction                   | Why deferred                                                  | Trigger                                 |
| --------------------------- | ------------------------------------------------------------- | --------------------------------------- |
| EPCIS / CBV 2.0.1           | Not required by FDA; adds significant interoperability scope. | A real partner/customer requires it.    |
| All CTEs                    | The processor demo covers the selected role.                  | Expansion to farms/seafood.             |
| Exemptions engine           | High legal-maintenance risk.                                  | Specialist-reviewed product line.       |
| Direct FDA/SRP submission   | No need and no stable public contract for P0.                 | Official API/process and client demand. |
| ASN/EDI providers           | Vendor-specific scope.                                        | Design partner selected.                |
| Commercial billing          | Not needed to validate the traceability workflow.             | Pilot or commercial launch.             |
| SOC 2 / enterprise controls | Cost and timeline are disproportionate to P0.                 | Enterprise customer due diligence.      |
| Advanced buyer profiles     | Real buyer formats are needed.                                | Discovery identifies a pattern.         |

## Deployment and data location

The U.S. product runs as a separate deployment built from the shared Markiro repository. Its
production database, object storage, logs, telemetry payloads, mail processing, secrets and
backups must not be hosted or persisted in the Russian Federation (NFR-016). Remote access from
Russia is allowed through least-privilege, multi-factor authentication and audited access. This
does not permit production data to be copied into Russian infrastructure, development fixtures
or CI artifacts.

## Data limitations of the public demo

The public demo and evidence use synthetic data only: fictional parties, 555
telephone contacts and example.com addresses (LOC-008). No real addresses,
contacts or registration numbers are included. The demo shows two fresh-cut
apple lots transformed into snack cups and shipped to a distribution center;
it is an illustration of the workflow, not a record of any real supply chain
(see [demo-scenario.md](demo-scenario.md)).

## Related documents

- [README.md](README.md) - overview of the U.S. bounded context
- [regulatory-basis.md](regulatory-basis.md) - regulatory baseline and source
  register
- [requirements.md](requirements.md) - requirement register
- [acceptance.md](acceptance.md) - acceptance and negative/overclaim tests
- [implementation-plan.md](implementation-plan.md) - slices US-00 to US-12

## MVP publication boundary

A generic profile does not assess FTR applicability. Station-side case links, physical closure/printing, a second full scenario and acquisition materials are P1. Server-side case/SSCC links and 100 synthetic case records are P0; synthetic records do not prove physical operation. Any public landing is static until separate hosting and a non-RF contact-processing route are approved. No existing RU form, mail fallback or analytics path is reused. Synthetic data labelling is always visible. External review does not certify the product or automatically authorize stronger claims.
