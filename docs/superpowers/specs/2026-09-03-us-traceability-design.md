# Markiro U.S. Traceability — isolated deployment and bounded context — Design Spec

> Revised 2026-09-04: read the [shared MVP contract](../../us/mvp-contract.md) first. It resolves cross-slice scope and safety rules and supersedes conflicting draft recommendations below. Design only; implementation is not claimed.

**Date:** 2026-09-03

**Status:** Draft for review; not implemented. Read the shared MVP contract and resolve only outstanding choices material to the authorized slice.

**Scope:** Records the founding decisions for the U.S. adaptation described in MUS-001 v0.1 and now mirrored in `docs/us/`: where the work lives, how the dedicated U.S. deployment stays isolated from the existing Russian deployment, what the current schema already conflicts with, and what slice US-00 must deliver. It does not design the traceability entities themselves; that is US-01…US-09 and each gets its own spec.

**Related:**

- `docs/us/README.md` — index of the canonical U.S. documentation set.
- `docs/us/requirements.md` — 172 normative requirements (131 P0).
- `docs/us/implementation-plan.md` — slices US-00…US-12 and the dependency sequence and unvalidated estimates.
- `docs/us/data-dictionary.md` — entities, KDE dictionary, proposed tables and endpoints.
- `docs/superpowers/specs/2026-08-29-chz-product-groups-design.md` — the CHZ product group reference that must not be reused as an FTL category (PRD-009).
- `docs/superpowers/specs/2026-08-28-product-archived-flag-design.md` — the "hide, do not delete" idiom reused for lot and event lifecycles.

## MVP boundary

Markiro today is a Russian-market production and labeling platform (Chestny ZNAK, EGAIS, CommerceML). The U.S. MVP reuses its tenancy, RBAC, audit, label engine and evidence tooling while adding FSMA 204 concepts that have no Russian counterpart: traceability lots with TLC and TLC source, three critical tracking events, lot genealogy, a versioned Traceability Plan, a 24-hour trace request and an FDA-aligned sortable workbook. The MVP proves one reproducible synthetic processor scenario. It does not claim production readiness.

## Decision 1: one repository, separate deployments

U.S. functionality is added as a `traceability` bounded context in this monorepo. The code stays shared, but the U.S. and Russian products run as separate deployments with independent data planes.

Why:

- Tenancy, composite tenant FKs, capability RBAC with denial tests, exact audit, additive migrations, `ru`/`en` locales in admin and station, react-pdf and DOCX generation, and `tools/evidence-package` already exist here. Re-creating or extracting them would duplicate security-sensitive behavior and make fixes drift between products.
- Requirement PRO-003 (RU_CHZ without regression) is only meaningful and testable when both products share one test suite and CI.

Consequences:

- Every U.S. migration is additive. No existing table or column is renamed.
- No U.S. domain type imports from CommerceML, CHZ signer or CHZ product group modules (INT-004, PRD-009).
- The MVP release is a tag of this repository; a synthetic tenant in the dedicated U.S. deployment provides the demo surface.
- The U.S. deployment has independent databases, object storage, logs, telemetry payloads, mail processing, secrets, backups and disaster-recovery procedures. None of those persisted production surfaces may be hosted in the Russian Federation.
- Remote operator and developer access may originate from the Russian Federation, but it uses least privilege, multi-factor authentication and exact audit. This permission does not allow copying production data into Russian infrastructure, local fixtures or CI artifacts.

Placement (spec §5.1):

```text
docs/us/
packages/domain/src/traceability/
packages/db/src/schema/traceability.ts
packages/platform-contracts/src/traceability/
apps/api/src/modules/traceability/
apps/admin/src/pages/traceability/
apps/station/src/lib/traceability/
tools/us-demo/
```

## Decision 2: deployment edition plus tenant regulatory profile

The codebase has no jurisdiction or profile concept. `org_profiles` is a single-row-per-tenant table with GLN, GS1 prefixes, INN, timezone (default `Europe/Moscow`), logo and default box label template; the CHZ product group lives on `products` and in `org_box_label_template_defaults`. Gating today is by capability and subscription, not by regulatory regime.

US-00 introduces an immutable deployment edition (`RU` or `US`) and a tenant-level regulatory profile. A deployment edition limits which profiles may be provisioned:

| Code                          | Behavior                                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| `RU_CHZ`                      | Allowed only in the Russian deployment. Default for every existing tenant there.                      |
| `US_FSMA204_PROCESSOR`        | U.S. terminology, three CTEs, FTL classification, TLC, plan, trace request, export. RU fields hidden. |
| `US_GENERIC_LOT_TRACEABILITY` | Lot, case and recall-readiness workflows without any FTR coverage claim. RU fields hidden.            |

Design constraints for US-00 (details belong to its own slice spec):

- The deployment edition is set by trusted runtime configuration and cannot be changed through tenant UI or a public API.
- A U.S. deployment accepts only `US_FSMA204_PROCESSOR` and `US_GENERIC_LOT_TRACEABILITY`; a Russian deployment accepts only `RU_CHZ`.
- The profile carries `code`, `baseline_version` (initially `US-REG-2026-09-03`) and `effective_at` (REG-001). Every compliance-oriented export prints these.
- Backfill sets `RU_CHZ` for all existing tenants in the existing Russian database so no tenant is ever profile-less. New U.S. databases start without Russian tenants.
- Gating is read at protected server boundaries the same way tenant and permission state is reloaded today; the admin shows the active profile (PRO-005).
- U.S. roles (receiving, production, shipping, QA, auditor) are capabilities in the existing RBAC model, not a parallel identity domain (PRO-006, NFR-002).
- Regulatory profile is separate from `product_regulatory_profiles`, which is the existing per-product CHZ/national-catalog record; the U.S. per-product record is a new `ProductTraceabilityProfile` (PRD-001).

## Decision 3: `docs/us/` is the canonical specification

The MUS-001 package ships a condensed English Markdown (sections 1–7 only) and a full Russian PDF/DOCX. Neither is suitable as an agent source of truth on its own. `docs/us/` now carries the full content in English, split by concern, with one per-requirement status file (`requirements-traceability.md`). The original package stays outside the repository. Changes to regulatory content go through the review log in `docs/us/regulatory-basis.md` and, when data semantics change, a new spec here (spec §2.9).

## Conflicts found in the current schema

These were verified in source on 2026-09-03 and are inputs to US-00 and US-02, not yet decisions.

1. `products.gtin14` is `char(14) NOT NULL` (`packages/db/src/schema/platform.ts`); its unique index `products_tenant_gtin_unarchived_uq` is already partial (`WHERE archived = false`), and `createProductSchema.gtin` in the products DTO is required. PRD-007 and the KDE dictionary make GTIN optional. Options: drop NOT NULL by additive migration (NULLs are distinct in the partial index, so no index change) and require GTIN only for `RU_CHZ`; or keep GTIN mandatory and document a deviation. Recommendation: drop NOT NULL, decided in US-02 (OQ-US02-1), because the blast radius is confined to API files that select `gtin14` and GTIN-less products cannot reach a shift or a kiosk.
2. `org_profiles.time_zone` defaults to `Europe/Moscow`. U.S. profile creation must require an explicit IANA zone; NFR-008 tests cover midnight and DST boundaries.
3. Retention. `docs/architecture.md` §4 states a five-year default configurable per tenant, but no schema column or job encodes it. REG-009 needs a materialized policy value to assert against; US-00 decides whether that is a profile field or a platform setting.
4. No XLSX writer dependency exists (only `fflate`); shift exports are txt/csv/xml. US-07 selects a macro-free writer and records the choice (OQ-US07-1).
5. `ProductsService.computeStatus` yields `active` only with a non-null `chz_product_group_code`, and `ShiftsService.createShift` rejects draft products, so a U.S. product without a CHZ group can never have a shift. This blocks TRN-001 and TRN-010 unless US-02 makes status computation profile-aware (OQ-US02-2).
6. `boxes` rows exist only once a first KM item is scanned; U.S. products have no KM codes, so the demo's 100 cases must be seeded by US-11 or come from a case-only station mode in US-10 (OQ-US04-1).
7. `tools/evidence-package` accepts only inventory operation IDs (`^INV-…`), so it cannot seal a trace package or the U.S. evidence bundle unchanged (OQ-US09-4).
8. No software-version helper (`{ version, gitSha }`) exists, yet EXP-007 and the request report need one (OQ-US07-10, OQ-US09-17).

## Slice US-00 deliverables

- Regulatory baseline document with dated source register (done in `docs/us/regulatory-basis.md`; the code must expose the same baseline ID).
- Tenant regulatory profile schema, migration with `RU_CHZ` backfill, contract in `packages/platform-contracts`, API read/update, admin visibility.
- Feature gating helper used by admin navigation and API guards; RU test suite unchanged and green.
- U.S. capability set with denial tests.
- Dedicated U.S. deployment boundary and infrastructure validation for NFR-016.
- Its own design spec before code (`2026-09-03-us-00-regulatory-profile-design.md`) resolving conflicts 2 and 3 above.
- `docs/us/requirements-traceability.md` rows REG-001…REG-012, PRO-001…PRO-003, PRO-005, PRO-006, INT-004, INT-007 updated.

## Testing expectations set by this spec

- Fresh and upgrade migration paths for the profile table and backfill.
- Cross-tenant denial for the profile endpoint.
- A content test that fails on the prohibited wording matrix in `docs/us/limitations.md` for admin, station and landing strings in U.S. profiles.
- Full repository gates (`pnpm turbo lint typecheck test build --concurrency=1 --force`, `pnpm format:check`) remain green.

## Out of scope for this spec

Entity design for lots, events, plan, request and export; XLSX adapter; Station lot link; EPCIS; any CTE other than Receiving, Transformation and Shipping; automatic exemption decisions; direct FDA submission.
