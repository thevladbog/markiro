# Markiro U.S. Traceability: implementation plan

- Source: MUS-001 v0.1 (2026-09-03), sections 11, 11.1, 11.2, 13.1–13.4, 15 and the final rule of Appendix D
- Status: baseline, not yet implemented
- Owner: Vladislav Bogatyrev

![Architecture scope](diagrams/architecture_scope.png)

Figure 1. Architecture scope of the U.S. adaptation as a bounded context inside the existing Markiro repository.

This plan breaks the U.S. adaptation into slices US-00..US-12, schedules them over 8 weeks, and states the sufficiency boundary and the risk register. Slice status is maintained here; per-requirement status is maintained in [requirements-traceability.md](requirements-traceability.md). Requirements themselves are in [requirements.md](requirements.md), acceptance gates and the case-ready checklist in [acceptance.md](acceptance.md), the demo dataset in [demo-scenario.md](demo-scenario.md), the regulatory reasoning in [regulatory-basis.md](regulatory-basis.md), non-goals in [limitations.md](limitations.md), and the working protocol for coding agents in [agent-master-prompt.md](agent-master-prompt.md).

Capacity check: the slice estimates sum to 115–156 hours, while 8 weeks at 12–15 hours per week give 96–120 hours. The lower bound fits only if US-10 and US-12 slip to the P1 tail; the upper bound does not fit. How to reconcile (cut scope, add capacity, extend the schedule) is GQ-32 in [open-questions.md](open-questions.md).

STN-001 (preserve existing station invariants) is P0 even though the rest of US-10 is P1: it is satisfied by the full repository gates that every slice must keep green, and US-10's own work is the P1 enhancement on top of it.

The requirement ranges in the slice table are copied from spec section 11. Where [requirements-traceability.md](requirements-traceability.md) assigns additional IDs to a slice (marked `*`), the matrix is normative and the slice spec claims those IDs; see GQ-18 in [open-questions.md](open-questions.md).

## 1. Slices

| Slice | Result                                    | Requirements               | Hours | Depends     | Status      |
| ----- | ----------------------------------------- | -------------------------- | ----- | ----------- | ----------- |
| US-00 | Regulatory baseline + ADR + profile shell | REG-001..012, PRO-001..003 | 5–7   | -           | Not started |
| US-01 | Parties and locations                     | LOC-001..008               | 8–10  | US-00       | Not started |
| US-02 | Product FTL profiles and TLC lots         | PRD-001..010, LOT-001..009 | 12–15 | US-01       | Not started |
| US-03 | Receiving CTE                             | REC-001..008, DOC-001..002 | 8–10  | US-02       | Not started |
| US-04 | Transformation + shift/box bridge         | TRN-001..014, LOT-010      | 14–18 | US-02/03    | Not started |
| US-05 | Shipping CTE                              | SHP-001..010               | 8–11  | US-04       | Not started |
| US-06 | Trace graph, search, completeness         | TRC-001..010               | 9–12  | US-03/04/05 | Not started |
| US-07 | FDA-aligned XLSX adapter                  | EXP-001..012               | 12–16 | US-06       | Not started |
| US-08 | Traceability Plan                         | PLN-001..010               | 7–10  | US-00/02    | Not started |
| US-09 | Trace request / mock recall               | RQ-001..008                | 8–11  | US-06/07/08 | Not started |
| US-10 | Station/label lot link                    | STN-001..009               | 8–12  | US-02/04    | Not started |
| US-11 | Demo seed, evidence mode, release         | EVD-001..012               | 10–14 | US-09       | Not started |
| US-12 | Landing/demo video/outreach package       | case assets                | 6–10  | US-11       | Not started |

Slice status values: Not started, In progress, Done. A slice is Done only when its Definition of Done from MUS-001 §10.2 is met and its verification report (see [acceptance.md](acceptance.md)) is filed.

## 2. 8-week schedule at 12–15 h/week

| Week | Focus                  | Exit criterion                                       |
| ---- | ---------------------- | ---------------------------------------------------- |
| 1    | US-00 + US-01          | Profile, ADR, source registry, locations.            |
| 2    | US-02                  | Product classifications, lots/TLC/source.            |
| 3    | US-03                  | Receiving event complete.                            |
| 4    | US-04                  | Transformation and genealogy complete.               |
| 5    | US-05 + US-06          | Shipping and full trace.                             |
| 6    | US-07 + US-08          | XLSX and plan PDF.                                   |
| 7    | US-09 + selected US-10 | Mock request; optional Station link.                 |
| 8    | US-11 + US-12          | Tagged release, evidence, video and outreach assets. |

## 3. Critical path

```text
Profile → locations/products → lots → receiving → transformation → shipping →
trace → export + plan → mock request → release/evidence.
```

Station integration must not block the main critical path. If the timeline compresses, US-10 remains P1: the administrative end-to-end workflow, generated artifacts and repeatable demo already create a filing-ready product exhibit.

## 4. Sufficiency boundary for EB-2 NIW

### 4.1 P0: required before filing freeze

- this approved specification and the regulatory source register;
- working code for Receiving, Transformation, Shipping, TLC/source, genealogy, plan, request and XLSX;
- reproducible synthetic fresh-cut apple demo;
- tagged public release with commit SHA and hashes;
- CI/test report and limitations;
- architecture/data dictionary/requirement traceability;
- generated XLSX, plan PDF, validation report, request report, manifest;
- 12–18 screenshots and a 5–8 minute English video;
- clear link from the existing Markiro foundation to the U.S. adaptation.

### 4.2 P1: strongly strengthens but does not block

- review by a U.S. food-safety/traceability professional;
- 1–2 authentic Letters of Interest after real calls/demo;
- design-partner or limited pilot discussion;
- Station offline case-to-lot demonstration;
- signed memo explaining why the scope is useful to small/medium manufacturers.

### 4.3 Not required before filing

Briefly (the full list and the reasoning are carried in [limitations.md](limitations.md)): two years of U.S. operations; U.S. revenue or an LLC; a full live U.S. production deployment; all CTEs and exemptions; direct FDA integration; EPCIS, RFID or full EDI; SOC 2 / enterprise security certification; any statement of guaranteed compliance.

### 4.4 How the product package supports NIW logic

| Element                                 | What the product exhibit shows                                                                                         |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Substantial merit / national importance | Digital traceability, faster recall readiness, accessibility for smaller producers, consistency of supply-chain data.  |
| Well positioned                         | Working Russian Markiro + new U.S. implementation + public release + demo + artifacts + external feedback.             |
| Benefit of waiver                       | Founder-led platform/consulting model extends across several enterprises and is not tied to a single vacancy/employer. |

> Important for the legal brief: the product itself does not "prove" NIW automatically. It provides verifiable facts for the attorney's argument: progress already achieved, a transferable technical platform, a realistic U.S. plan and early market interest.

## 5. Risks and scope control

P/I = probability / impact.

| ID   | Risk                               | P/I           | Mitigation                                                                            |
| ---- | ---------------------------------- | ------------- | ------------------------------------------------------------------------------------- |
| R-01 | Regulatory change before filing    | Medium/High   | Baseline + source refresh per release; versioned adapters; specialist review.         |
| R-02 | Scope creep into full U.S. ERP     | High/High     | Only CTE/lot/request/export; no accounting/inventory rebuild.                         |
| R-03 | Automatic legal classification     | Medium/High   | Manual reviewed coverage status; disclaimer; no exemptions engine.                    |
| R-04 | Overengineering item serialization | High/Medium   | Lot-level core; SSCC/case optional; no item requirement.                              |
| R-05 | No U.S. feedback before filing     | Medium/Medium | Warm introductions; 3–5 discovery calls; 1–2 LOIs desirable.                          |
| R-06 | Export diverges from FDA template  | Medium/High   | Versioned field registry + golden fixtures + source mapping review.                   |
| R-07 | Russian workflow regression        | Low/High      | Feature profiles, additive migrations, full repo gates.                               |
| R-08 | Synthetic demo looks artificial    | Medium/Medium | Coherent quantities/docs; external reviewer; show real Markiro foundation separately. |
| R-09 | Evidence claims exceed tests       | Medium/High   | Verification report separates automated/browser/hardware/external.                    |
| R-10 | Personal/confidential data leak    | Low/High      | Synthetic dataset, privacy scan, redaction, separate private evidence.                |
| R-11 | 8-week schedule slips              | Medium/Medium | Station/EPCIS/EDI are P1/P2; protect critical path.                                   |
| R-12 | Product presented as legal advice  | Medium/High   | Claim language matrix and counsel disclaimer.                                         |

## 6. Final rule

> When the P0 checklist is closed, the product block is frozen for legal review. New ideas are not added to the filing release unless they fix a bug, close a regulatory gap or create obvious evidence of external interest.
