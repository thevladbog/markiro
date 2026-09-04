# Limitations and non-goals

- Source: MUS-001 v0.1 (2026-09-03), sections 1.4, 4.5, 13.3 and 14
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
records to FDA; trace request packages are prepared locally and delivered by
the covered entity (REG-008). MUS-001 is not an opinion of a U.S. attorney or a
food-safety consultant.

## What is not in P0

The following items are deliberately excluded from the filing-ready P0 scope
(MUS-001 section 1.4):

- a full exemptions/waivers engine;
- the Harvesting, Cooling, Initial Packing and First Land-Based Receiving CTEs
  (P0 covers Receiving, Transformation and Shipping only, see REG-004);
- direct FDA submission or integration with the Safety Reporting Portal;
- an EPCIS/CBV adapter;
- mandatory item serialization, RFID or case-by-case scanning;
- SOC 2, production U.S. hosting, a U.S. payment/billing stack;
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
| EPCIS-ready architecture (future).                                  | EPCIS is required by FDA.        |

The wording "compliance-ready" may be used only after a review by a U.S.
food-safety specialist (see the change-control procedure in
[regulatory-basis.md](regulatory-basis.md)).

## Not required before filing

The following are not required before the filing (MUS-001 section 13.3) and
are therefore not part of the P0 demonstrator:

- two years of operation in the United States;
- U.S. revenue or an LLC;
- a full live U.S. production deployment;
- all CTEs and exemptions;
- direct FDA integration;
- EPCIS, RFID or full EDI;
- SOC 2 / enterprise security certification;
- a statement of guaranteed compliance.

## Deferred after filing

The following directions are consciously deferred (MUS-001 section 14). Each
has a reason and a trigger that would reopen it; none of them is a P0
dependency.

| Direction                   | Why deferred                                                  | Trigger                                 |
| --------------------------- | ------------------------------------------------------------- | --------------------------------------- |
| EPCIS / CBV 2.0.1           | Not required by FDA; adds significant interoperability scope. | A real partner/customer requires it.    |
| All CTEs                    | The processor demo covers the selected role.                  | Expansion to farms/seafood.             |
| Exemptions engine           | High legal-maintenance risk.                                  | Counsel-reviewed product line.          |
| Direct FDA/SRP submission   | No need and no stable public contract for P0.                 | Official API/process and client demand. |
| ASN/EDI providers           | Vendor-specific scope.                                        | Design partner selected.                |
| U.S. hosting / billing      | Not needed for the synthetic case exhibit.                    | Pilot/commercial launch.                |
| SOC 2 / enterprise controls | Cost and timeline are disproportionate to P0.                 | Enterprise customer due diligence.      |
| Advanced buyer profiles     | Real buyer formats are needed.                                | Discovery identifies a pattern.         |

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
