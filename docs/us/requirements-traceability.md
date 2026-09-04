# Markiro U.S. Traceability — Requirements Traceability Matrix

- Source: MUS-001 v0.1 (2026-09-03), sections 6, 11 and 12; requirement EVD-005
- Status: baseline, no requirement implemented yet
- Owner: Vladislav Bogatyrev
  This matrix is the single place where per-requirement status is tracked. Every slice must update it (see [agent-master-prompt.md](agent-master-prompt.md), "Required output of every slice"). Requirement text lives in [requirements.md](requirements.md); slice definitions in [implementation-plan.md](implementation-plan.md); test strategy in [acceptance.md](acceptance.md).

## How to fill the columns

| Column   | Values                                                                                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Slice    | `US-00`…`US-12` from spec section 11. A trailing `*` means the spec leaves the requirement unassigned and the slice is a proposed placement; `cross-cutting` applies to every slice. |
| Status   | `not started`, `in progress`, `implemented`, `evidenced`, `deferred`, `dropped`. A P0 row may become `evidenced` only when the Test and Evidence cells point to real artifacts.      |
| Test     | Path(s) of the focused test(s) proving the acceptance criterion, or `manual` with a pointer to the checklist row in [acceptance.md](acceptance.md).                                  |
| Evidence | Screenshot, generated artifact, CI run, review memo or feedback record in the evidence package; hash or manifest entry when sealed.                                                  |
| Notes    | Deviations, ADR links, partial coverage.                                                                                                                                             |

## Matrix

| ID      | P   | Slice         | Status      | Test | Evidence | Notes |
| ------- | --- | ------------- | ----------- | ---- | -------- | ----- |
| REG-001 | P0  | US-00         | not started |      |          |       |
| REG-002 | P0  | US-00         | not started |      |          |       |
| REG-003 | P0  | US-00         | not started |      |          |       |
| REG-004 | P0  | US-00         | not started |      |          |       |
| REG-005 | P0  | US-00         | not started |      |          |       |
| REG-006 | P0  | US-00         | not started |      |          |       |
| REG-007 | P0  | US-00         | not started |      |          |       |
| REG-008 | P0  | US-00         | not started |      |          |       |
| REG-009 | P0  | US-00         | not started |      |          |       |
| REG-010 | P1  | US-00         | not started |      |          |       |
| REG-011 | P0  | US-00         | not started |      |          |       |
| REG-012 | P0  | US-00         | not started |      |          |       |
| PRO-001 | P0  | US-00         | not started |      |          |       |
| PRO-002 | P0  | US-00         | not started |      |          |       |
| PRO-003 | P0  | US-00         | not started |      |          |       |
| PRO-004 | P0  | US-11*        | not started |      |          |       |
| PRO-005 | P0  | US-00*        | not started |      |          |       |
| PRO-006 | P0  | US-00*        | not started |      |          |       |
| LOC-001 | P0  | US-01         | not started |      |          |       |
| LOC-002 | P0  | US-01         | not started |      |          |       |
| LOC-003 | P0  | US-01         | not started |      |          |       |
| LOC-004 | P0  | US-01         | not started |      |          |       |
| LOC-005 | P1  | US-01         | not started |      |          |       |
| LOC-006 | P0  | US-01         | not started |      |          |       |
| LOC-007 | P1  | US-01         | not started |      |          |       |
| LOC-008 | P0  | US-01         | not started |      |          |       |
| PRD-001 | P0  | US-02         | not started |      |          |       |
| PRD-002 | P0  | US-02         | not started |      |          |       |
| PRD-003 | P0  | US-02         | not started |      |          |       |
| PRD-004 | P0  | US-02         | not started |      |          |       |
| PRD-005 | P1  | US-02         | not started |      |          |       |
| PRD-006 | P1  | US-02         | not started |      |          |       |
| PRD-007 | P0  | US-02         | not started |      |          |       |
| PRD-008 | P0  | US-02         | not started |      |          |       |
| PRD-009 | P0  | US-02         | not started |      |          |       |
| PRD-010 | P1  | US-02         | not started |      |          |       |
| LOT-001 | P0  | US-02         | not started |      |          |       |
| LOT-002 | P0  | US-02         | not started |      |          |       |
| LOT-003 | P0  | US-02         | not started |      |          |       |
| LOT-004 | P0  | US-02         | not started |      |          |       |
| LOT-005 | P0  | US-02         | not started |      |          |       |
| LOT-006 | P0  | US-02         | not started |      |          |       |
| LOT-007 | P0  | US-02         | not started |      |          |       |
| LOT-008 | P0  | US-02         | not started |      |          |       |
| LOT-009 | P0  | US-02         | not started |      |          |       |
| LOT-010 | P0  | US-04         | not started |      |          |       |
| LOT-011 | P1  | US-02*        | not started |      |          |       |
| LOT-012 | P0  | US-06*        | not started |      |          |       |
| REC-001 | P0  | US-03         | not started |      |          |       |
| REC-002 | P0  | US-03         | not started |      |          |       |
| REC-003 | P0  | US-03         | not started |      |          |       |
| REC-004 | P0  | US-03         | not started |      |          |       |
| REC-005 | P0  | US-03         | not started |      |          |       |
| REC-006 | P0  | US-03         | not started |      |          |       |
| REC-007 | P1  | US-03         | not started |      |          |       |
| REC-008 | P1  | US-03         | not started |      |          |       |
| TRN-001 | P0  | US-04         | not started |      |          |       |
| TRN-002 | P0  | US-04         | not started |      |          |       |
| TRN-003 | P0  | US-04         | not started |      |          |       |
| TRN-004 | P0  | US-04         | not started |      |          |       |
| TRN-005 | P0  | US-04         | not started |      |          |       |
| TRN-006 | P1  | US-04         | not started |      |          |       |
| TRN-007 | P0  | US-04         | not started |      |          |       |
| TRN-008 | P0  | US-04         | not started |      |          |       |
| TRN-009 | P0  | US-04         | not started |      |          |       |
| TRN-010 | P0  | US-04         | not started |      |          |       |
| TRN-011 | P0  | US-04         | not started |      |          |       |
| TRN-012 | P1  | US-04         | not started |      |          |       |
| TRN-013 | P1  | US-04         | not started |      |          |       |
| TRN-014 | P0  | US-04         | not started |      |          |       |
| SHP-001 | P0  | US-05         | not started |      |          |       |
| SHP-002 | P0  | US-05         | not started |      |          |       |
| SHP-003 | P0  | US-05         | not started |      |          |       |
| SHP-004 | P0  | US-05         | not started |      |          |       |
| SHP-005 | P0  | US-05         | not started |      |          |       |
| SHP-006 | P1  | US-05         | not started |      |          |       |
| SHP-007 | P0  | US-05         | not started |      |          |       |
| SHP-008 | P1  | US-05         | not started |      |          |       |
| SHP-009 | P1  | US-05         | not started |      |          |       |
| SHP-010 | P0  | US-05         | not started |      |          |       |
| DOC-001 | P0  | US-03         | not started |      |          |       |
| DOC-002 | P0  | US-03         | not started |      |          |       |
| DOC-003 | P1  | US-03*        | not started |      |          |       |
| DOC-004 | P0  | US-03*        | not started |      |          |       |
| DOC-005 | P0  | US-11*        | not started |      |          |       |
| DOC-006 | P1  | US-03*        | not started |      |          |       |
| TRC-001 | P0  | US-06         | not started |      |          |       |
| TRC-002 | P0  | US-06         | not started |      |          |       |
| TRC-003 | P0  | US-06         | not started |      |          |       |
| TRC-004 | P0  | US-06         | not started |      |          |       |
| TRC-005 | P0  | US-06         | not started |      |          |       |
| TRC-006 | P0  | US-06         | not started |      |          |       |
| TRC-007 | P1  | US-06         | not started |      |          |       |
| TRC-008 | P0  | US-06         | not started |      |          |       |
| TRC-009 | P0  | US-06         | not started |      |          |       |
| TRC-010 | P1  | US-06         | not started |      |          |       |
| RQ-001  | P0  | US-09         | not started |      |          |       |
| RQ-002  | P0  | US-09         | not started |      |          |       |
| RQ-003  | P0  | US-09         | not started |      |          |       |
| RQ-004  | P0  | US-09         | not started |      |          |       |
| RQ-005  | P0  | US-09         | not started |      |          |       |
| RQ-006  | P0  | US-09         | not started |      |          |       |
| RQ-007  | P0  | US-09         | not started |      |          |       |
| RQ-008  | P1  | US-09         | not started |      |          |       |
| EXP-001 | P0  | US-07         | not started |      |          |       |
| EXP-002 | P0  | US-07         | not started |      |          |       |
| EXP-003 | P0  | US-07         | not started |      |          |       |
| EXP-004 | P0  | US-07         | not started |      |          |       |
| EXP-005 | P0  | US-07         | not started |      |          |       |
| EXP-006 | P0  | US-07         | not started |      |          |       |
| EXP-007 | P0  | US-07         | not started |      |          |       |
| EXP-008 | P0  | US-07         | not started |      |          |       |
| EXP-009 | P1  | US-07         | not started |      |          |       |
| EXP-010 | P0  | US-07         | not started |      |          |       |
| EXP-011 | P0  | US-07         | not started |      |          |       |
| EXP-012 | P0  | US-07         | not started |      |          |       |
| PLN-001 | P0  | US-08         | not started |      |          |       |
| PLN-002 | P0  | US-08         | not started |      |          |       |
| PLN-003 | P0  | US-08         | not started |      |          |       |
| PLN-004 | P0  | US-08         | not started |      |          |       |
| PLN-005 | P0  | US-08         | not started |      |          |       |
| PLN-006 | P0  | US-08         | not started |      |          |       |
| PLN-007 | P0  | US-08         | not started |      |          |       |
| PLN-008 | P0  | US-08         | not started |      |          |       |
| PLN-009 | P1  | US-08         | not started |      |          |       |
| PLN-010 | P0  | US-08         | not started |      |          |       |
| STN-001 | P0  | US-10         | not started |      |          |       |
| STN-002 | P1  | US-10         | not started |      |          |       |
| STN-003 | P1  | US-10         | not started |      |          |       |
| STN-004 | P1  | US-10         | not started |      |          |       |
| STN-005 | P1  | US-10         | not started |      |          |       |
| STN-006 | P1  | US-10         | not started |      |          |       |
| STN-007 | P1  | US-10         | not started |      |          |       |
| STN-008 | P1  | US-10         | not started |      |          |       |
| STN-009 | P1  | US-10         | not started |      |          |       |
| STN-010 | P2  | US-10*        | not started |      |          |       |
| INT-001 | P0  | US-03*        | not started |      |          |       |
| INT-002 | P0  | US-03*        | not started |      |          |       |
| INT-003 | P1  | US-03*        | not started |      |          |       |
| INT-004 | P1  | US-00*        | not started |      |          |       |
| INT-005 | P2  | future        | not started |      |          |       |
| INT-006 | P2  | future        | not started |      |          |       |
| INT-007 | P0  | US-00*        | not started |      |          |       |
| INT-008 | P1  | US-03*        | not started |      |          |       |
| NFR-001 | P0  | cross-cutting | not started |      |          |       |
| NFR-002 | P0  | cross-cutting | not started |      |          |       |
| NFR-003 | P0  | cross-cutting | not started |      |          |       |
| NFR-004 | P0  | cross-cutting | not started |      |          |       |
| NFR-005 | P0  | cross-cutting | not started |      |          |       |
| NFR-006 | P0  | cross-cutting | not started |      |          |       |
| NFR-007 | P0  | cross-cutting | not started |      |          |       |
| NFR-008 | P0  | cross-cutting | not started |      |          |       |
| NFR-009 | P0  | cross-cutting | not started |      |          |       |
| NFR-010 | P0  | cross-cutting | not started |      |          |       |
| NFR-011 | P0  | cross-cutting | not started |      |          |       |
| NFR-012 | P0  | cross-cutting | not started |      |          |       |
| NFR-013 | P1  | cross-cutting | not started |      |          |       |
| NFR-014 | P0  | cross-cutting | not started |      |          |       |
| NFR-015 | P0  | cross-cutting | not started |      |          |       |
| NFR-016 | P0  | US-00         | not started |      |          |       |
| EVD-001 | P0  | US-11         | not started |      |          |       |
| EVD-002 | P0  | US-11         | not started |      |          |       |
| EVD-003 | P0  | US-11         | not started |      |          |       |
| EVD-004 | P0  | US-11         | not started |      |          |       |
| EVD-005 | P0  | US-11         | not started |      |          |       |
| EVD-006 | P0  | US-11         | not started |      |          |       |
| EVD-007 | P0  | US-11         | not started |      |          |       |
| EVD-008 | P0  | US-11         | not started |      |          |       |
| EVD-009 | P1  | US-11         | not started |      |          |       |
| EVD-010 | P1  | US-11         | not started |      |          |       |
| EVD-011 | P0  | US-11         | not started |      |          |       |
| EVD-012 | P0  | US-11         | not started |      |          |       |

## Coverage by slice

| Slice         | Requirements | P0  | P1  | P2  |
| ------------- | ------------ | --- | --- | --- |
| US-00         | 20           | 18  | 2   | 0   |
| US-01         | 8            | 6   | 2   | 0   |
| US-02         | 20           | 16  | 4   | 0   |
| US-03         | 17           | 11  | 6   | 0   |
| US-04         | 15           | 12  | 3   | 0   |
| US-05         | 10           | 7   | 3   | 0   |
| US-06         | 11           | 9   | 2   | 0   |
| US-07         | 12           | 11  | 1   | 0   |
| US-08         | 10           | 9   | 1   | 0   |
| US-09         | 8            | 7   | 1   | 0   |
| US-10         | 10           | 1   | 8   | 1   |
| US-11         | 14           | 12  | 2   | 0   |
| cross-cutting | 15           | 14  | 1   | 0   |
| future        | 2            | 0   | 0   | 2   |
| US-12         | 0            | 0   | 0   | 0   |

US-12 (landing and demo assets) carries demo assets rather than requirement IDs; its deliverables are tracked in [acceptance.md](acceptance.md) checklist rows C-016 and C-017.

## Requirements the spec does not assign to a slice

Spec section 11 maps requirement ranges to slices but leaves the following IDs without a slice. The placements above (marked `*`) are proposals to be confirmed when each slice is assigned; they are not part of MUS-001.

| IDs                                | Proposed placement | Reason                                                                                                      |
| ---------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------- |
| PRO-005, PRO-006                   | US-00              | Profile visibility and role/capability boundary belong with the profile shell.                              |
| PRO-004, DOC-005                   | US-11              | Synthetic seed/reset and "no sensitive documents in demo" are evidence-mode concerns.                       |
| LOT-011                            | US-02              | Operational lot dates extend the lot entity.                                                                |
| LOT-012                            | US-06              | Lot search is part of trace/search.                                                                         |
| DOC-003, DOC-004, DOC-006          | US-03              | Reference documents are first introduced with Receiving.                                                    |
| STN-010                            | US-10              | Deferred station modes stay with the station slice as a P2 note.                                            |
| INT-001, INT-002, INT-003, INT-008 | US-03              | OpenAPI exposure and CSV import first appear with the Receiving API.                                        |
| INT-004, INT-007                   | US-00              | Isolation from CommerceML/CHZ and no external runtime dependency are boundary rules set in the profile ADR. |
| INT-005, INT-006                   | future             | P2 by definition.                                                                                           |
| NFR-001…NFR-015                    | cross-cutting      | Every slice must satisfy them; tests are attached per slice.                                                |
| NFR-016                            | US-00              | The deployment and data-residency boundary must exist before U.S. feature slices start.                     |
