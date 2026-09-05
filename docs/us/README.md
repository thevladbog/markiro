# Markiro U.S. Traceability — Documentation Index

> Revised 2026-09-05: read the [shared MVP contract](mvp-contract.md) first. It resolves cross-slice scope and safety rules and supersedes conflicting draft recommendations below. The design baseline is ready for implementation; US-00 includes domain, isolated local runtime, profile persistence and session/MFA foundations; business modules and hosted enforcement remain unfinished.

- Source: MUS-001 v0.1 "Product & Technical Specification for Agent-Assisted U.S. Adaptation" (2026-09-03)
- Status: design baseline revised by [MUS-CR-001](p0-change-decision.md) and [MUS-CLAR-001](development-clarifications.md), 2026-09-05; US-00 in progress, no slice complete
- Owner: Vladislav Bogatyrev

Markiro U.S. Traceability is an intentionally bounded minimum viable product (MVP) for U.S. food-processor traceability. It proves one synthetic end-to-end processor workflow inside a dedicated U.S. deployment while reusing the current Markiro codebase. It is designed to support applicable FSMA 204 (FDA Food Traceability Rule) recordkeeping and recall-readiness workflows for small and medium-sized food manufacturers. It is not a production-ready service, a legal opinion, an FDA certification, or a guarantee of compliance. See [limitations.md](limitations.md).

The U.S. product uses the same monorepo as the Russian product but runs as a separate deployment. Its production database, object storage, logs, telemetry payloads, mail processing, secrets and backups must not be hosted or persisted in the Russian Federation. Remote access is allowed through the normal least-privilege, multi-factor authentication and audit controls.

This directory is the canonical, agent-readable form of MUS-001. The original package (PDF, DOCX, condensed Markdown, master prompt, checklist CSV, diagram sources) stays outside the repository; when the two disagree, fix this directory and record the change in the review log of [regulatory-basis.md](regulatory-basis.md).

## Documents

Development is isolated on `codex/us-mvp` with publication disabled. Read [development-isolation.md](development-isolation.md) before running, synchronizing or publishing US work.

| File                                                         | What it holds                                                                                                                                | Spec sections      |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| [regulatory-basis.md](regulatory-basis.md)                   | Regulatory baseline record, FTR/FTL/CTE/TLC/plan/spreadsheet summary, tabletop findings, change-control, dated source register               | 2, 16              |
| [requirements.md](requirements.md)                           | All 172 normative requirements with priority, acceptance and basis; language rules                                                           | 4.5, 6             |
| [requirements-traceability.md](requirements-traceability.md) | Per-requirement slice, status, test and evidence matrix; the only place status is tracked                                                    | 6, 11, 12          |
| [data-dictionary.md](data-dictionary.md)                     | Entities, relationships, lifecycle, identifiers, KDE field dictionary, proposed endpoints and table names, glossary                          | 5, 7, A, B, D      |
| [demo-scenario.md](demo-scenario.md)                         | Profiles, personas, Scenario A (fresh-cut apple) and B (generic beverage), synthetic parties, lots, documents, script, target numbers        | 4, 8               |
| [acceptance.md](acceptance.md)                               | Performance targets, test strategy, negative and overclaim cases, evidence QA, release bundle, MVP acceptance checklist C-001…C-024          | 9.4, 12, C, CSV    |
| [limitations.md](limitations.md)                             | Public limitations and non-goals statement, allowed/not-allowed wording, deferred items                                                      | 1.4, 4.5, 13.3, 14 |
| [implementation-plan.md](implementation-plan.md)             | Slices US-00…US-12 with hours and dependencies, proposed schedule, MVP boundary and risk register                                            | 11, 15             |
| [agent-master-prompt.md](agent-master-prompt.md)             | Prompt to paste at the start of every agent thread, slice assignment template, minimum verification commands                                 | 10, master prompt  |
| [open-questions.md](open-questions.md)                       | Register of every contested point: cross-cutting questions, per-slice questions copied from the design specs, documentation-vs-code findings | all                |
| [diagrams/](diagrams/)                                       | Architecture scope, demo chain and evidence ladder as PNG plus Graphviz `.dot` sources                                                       | figures 1–3        |

The design decision that opens the work (bounded context, tenant profile mechanism, schema conflicts) is recorded in `docs/superpowers/specs/2026-09-03-us-traceability-design.md`. Each slice has a draft design spec in the same directory, originally drafted against the code and revised by the shared MVP contract; implementation approval is separate:

| Slice | Spec                                                    |
| ----- | ------------------------------------------------------- |
| US-00 | `2026-09-03-us-00-regulatory-profile-design.md`         |
| US-01 | `2026-09-03-us-01-parties-locations-design.md`          |
| US-02 | `2026-09-03-us-02-product-profiles-and-lots-design.md`  |
| US-03 | `2026-09-03-us-03-receiving-and-documents-design.md`    |
| US-04 | `2026-09-03-us-04-transformation-design.md`             |
| US-05 | `2026-09-03-us-05-shipping-design.md`                   |
| US-06 | `2026-09-03-us-06-trace-search-completeness-design.md`  |
| US-07 | `2026-09-03-us-07-xlsx-export-adapter-design.md`        |
| US-08 | `2026-09-03-us-08-traceability-plan-design.md`          |
| US-09 | `2026-09-03-us-09-trace-request-design.md`              |
| US-10 | `2026-09-03-us-10-station-lot-link-design.md`           |
| US-11 | `2026-09-03-us-11-demo-seed-evidence-release-design.md` |
| US-12 | `2026-09-03-us-12-landing-video-demo-assets-design.md`  |

Every contested point from these specs is collected in [open-questions.md](open-questions.md).

Design briefs for external designers live in `docs/design-briefs/us/` as a delta series to the existing Markiro briefs (same brand and design system; new screens, states, U.S. language and formats):

| Brief | File                                                               | Covers                                                                       |
| ----- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| 00    | `00-overview.md`                                                   | Read first: scope, profiles, personas, hard requirements, glossary           |
| 01    | `01-language-and-adaptation.md`                                    | EN-first copy, claims matrix, terminology, U.S. formats, status chips        |
| 02    | `02-onboarding-and-master-data.md`                                 | Traceability area, profile settings, parties/locations, product FTL, lots    |
| 03    | `03-cte-events.md`                                                 | Receiving, Transformation, Shipping forms; completeness; amend/void          |
| 04    | `04-trace-and-readiness.md`                                        | Search, lot card, trace graph/table, readiness dashboard                     |
| 05    | `05-plan-and-trace-request.md`                                     | Traceability Plan versions and PDF; trace request wizard and package         |
| 06    | `06-station-lot-link.md`                                           | Floor-mode delta (P1): lot link, policies, print log, English locale         |
| 07    | `07-landing-and-demo-assets.md`                                    | U.S. landing page, video plan, demo kit                                      |
| 08    | [08-design-baseline.md](../design-briefs/us/08-design-baseline.md) | Finalized 128-screen atlas, implementation decisions and verification limits |

Designer questions from the briefs are collected in Part D of [open-questions.md](open-questions.md).

## Priority codes

| Code | Meaning           | Rule                                                                     |
| ---- | ----------------- | ------------------------------------------------------------------------ |
| P0   | MVP               | Required for the bounded end-to-end demonstrator.                        |
| P1   | Product hardening | Valuable for a pilot or production continuation; does not block the MVP. |
| P2   | Future            | Deferred until a concrete product or partner need appears.               |

Current totals: 131 P0, 38 P1, 3 P2. These are detailed acceptance rules, not 172 separate features. The MVP remains bounded to one processor scenario, three critical tracking events, trace, plan and export; P1 and P2 describe continuation paths.

## Source order for agents

1. Direct user instructions and assigned acceptance criteria.
2. The nearest applicable `AGENTS.md`.
3. Current code, tests, migrations, manifests and runtime configuration.
4. `README.md` and `docs/architecture.md`.
5. The [shared MVP contract](mvp-contract.md), requirements and relevant approved design.

The code describes existing behavior; this documentation describes the target. Do not infer an implemented feature from a design or an authorization from a document. The original archive is supporting input and is not edited.

The [shared MVP contract](mvp-contract.md) reconciles deployment, P0/P1, dates, retention, event revisions, export validation and artifact safety.

## Definition of Done for a slice

- Requirements implemented without scope creep.
- New migration when the schema changes; fresh and upgrade paths tested; applied migrations never rewritten.
- Unit plus integration/e2e tests, including tenant denial tests.
- [requirements-traceability.md](requirements-traceability.md) updated.
- Browser or generated-artifact evidence where applicable.
- Verification report that separates automated, browser, Windows/hardware and external checks and lists checks not run.
- Conventional commit and a clean diff.

## Open questions found against the current codebase

These were identified while establishing the baseline and must be resolved in slice US-00 or its ADR. None of them is answered by MUS-001.

| #   | Finding                                                                                                                                                  | Affects          | Proposed handling                                                                                                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `products.gtin14` is `char(14) NOT NULL` with a tenant-scoped unique index, while PRD-007 and the KDE dictionary treat GTIN as optional.                 | PRD-007, PRD-001 | Decide in US-00/US-02: make GTIN nullable for U.S. profiles via additive migration, or keep GTIN mandatory and document it as a deviation. |
| 2   | There is no tenant profile or jurisdiction concept. `org_profiles` holds GLN, GS1 prefixes, INN, timezone and a CHZ product group only.                  | PRO-001…PRO-005  | US-00 introduces the profile entity and feature gating; ADR describes how RU fields are hidden in U.S. tenants.                            |
| 3   | `org_profiles.time_zone` defaults to `Europe/Moscow`.                                                                                                    | NFR-008          | U.S. profiles set an explicit U.S. timezone at creation; DST boundary tests around midnight.                                               |
| 4   | The five-year retention default referenced by REG-009 exists in `docs/architecture.md` section 4 as a design statement; no schema or job encodes it yet. | REG-009, PLN-007 | REG-009 test asserts the configured policy value once retention configuration is materialized.                                             |
| 5   | The repository has no XLSX writer dependency; shift exports produce other formats.                                                                       | EXP-001…EXP-012  | US-07 selects a macro-free XLSX library and records the choice in the slice ADR.                                                           |
| 6   | Spec section 2.9 names the review-log file `regulatory-baseline.md`; section 5.1 names it `regulatory-basis.md`.                                         | REG-012          | `regulatory-basis.md` is used; the review log lives there.                                                                                 |

## Краткое резюме (RU)

Эта папка — каноническая, машиночитаемая версия спецификации MUS-001 v0.1 по адаптации Markiro к рынку США (FDA Food Traceability Rule, FSMA 204). Решение: не форк, а новый bounded context `traceability` в этом же монорепозитории с профилями тенанта `RU_CHZ`, `US_FSMA204_PROCESSOR` и `US_GENERIC_LOT_TRACEABILITY`. P0 ограничен тремя CTE процессора (Receiving, Transformation, Shipping), лотами с TLC и источником, версионированным Traceability Plan, FDA-aligned XLSX, trace request с 24-часовым сроком и синтетическим демо fresh-cut apple. Статус каждого требования ведётся только в `requirements-traceability.md`. Формулировки «FDA approved», «certified», «guarantees compliance» запрещены везде. Открытые вопросы к текущей кодовой базе перечислены выше и закрываются в слайсе US-00.
