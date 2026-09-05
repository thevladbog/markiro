# US-00 — Regulatory baseline, ADR and tenant regulatory profile shell — Design Spec

> Revised 2026-09-04: read the [shared MVP contract](../../us/mvp-contract.md) first. It resolves cross-slice scope and safety rules and supersedes conflicting draft recommendations below. Design only; implementation is not claimed.

**Date:** 2026-09-03

**Status:** Partially implemented, 2026-09-05. Domain helpers, local runtime boundary, profile persistence and the independent US HTTP/session/MFA integration exist. Frontend, explicit user provisioning, recovery, remaining US-00 acceptance and hosted acceptance remain open. See the current [implementation plan](../../us/implementation-plan.md). The sections below remain the target design, not a completion report.

**Slice:** US-00 from docs/us/implementation-plan.md; depends on nothing (opens the U.S. series)

**Requirements:** REG-001, REG-002, REG-003, REG-004, REG-005, REG-006, REG-007, REG-008, REG-009, REG-010, REG-011, REG-012, PRO-001, PRO-002, PRO-003, PRO-005 (starred), PRO-006 (starred), INT-004 (starred), INT-007 (starred), NFR-016

**Related:**

- `docs/superpowers/specs/2026-09-03-us-traceability-design.md` — founding ADR (bounded context, profile mechanism, schema conflicts 1–4).
- `docs/superpowers/specs/2026-09-03-us-01-parties-locations-design.md` — first consumer of the gating helper and the U.S. capability set.
- `docs/superpowers/specs/2026-08-03-capability-rbac-design.md` — capability RBAC the U.S. roles extend.
- `docs/us/regulatory-basis.md` (baseline `US-REG-2026-09-03`, source register, review log), `docs/us/limitations.md` (wording matrix), `docs/us/requirements.md`, `docs/us/data-dictionary.md` §2, §8, §9, §10, `docs/us/acceptance.md` §2.4, §5.

## Problem

Markiro has no notion of deployment edition, jurisdiction or regulatory regime: gating is by capability and subscription only, and every tenant is implicitly a Russian Chestny ZNAK tenant. The U.S. slices US-01…US-11 need two trusted server facts: an immutable deployment edition and the tenant's active U.S. regulatory profile. Together they (a) prevent a U.S. deployment from provisioning `RU_CHZ`, (b) keep Russian regulatory surfaces out of the U.S. interface, (c) block U.S. endpoints in the Russian deployment, (d) carry the regulatory baseline ID that every compliance-oriented export must print, and (e) provide a small U.S. role/capability set with denial tests. US-00 delivers that shell, the data-location boundary in NFR-016, the content test for prohibited wording and the boundary rules INT-004/INT-007. It does not design lots, events, plan, request or export.

## Key facts of the codebase

- Tenant identity is `organization.id` (text, Better Auth) in `packages/db/src/schema/auth.ts`; membership role is the comma-separated text `member.role`; `unique("member_organization_id_uq")` on `(organization_id, id)` is the composite-FK anchor used by `packages/db/src/schema/team.ts`.
- `org_profiles` (`packages/db/src/schema/org-profile.ts`) is a single-row-per-tenant table keyed on `tenant_id` with `gln`, `gs1_prefixes`, `inn`, `time_zone text NOT NULL DEFAULT 'Europe/Moscow'` (added by migration `0087`, pinned by `packages/db/test/tenant-operational-timezone-migration.test.ts` and `packages/db/test/schema.test.ts`), `logo_asset_id`, `default_box_label_template_id`. The row is optional: `OrgProfileService.getProfile` falls back to defaults when no row exists (`apps/api/src/modules/org-profile/org-profile.service.ts` line 100) and `upsertProfile` creates it on first write; `tenant-provisioning.service.ts` line 141 inserts it for platform-provisioned tenants.
- No retention value is materialized anywhere; `docs/architecture.md` §4 only states "5 years default, configurable per tenant".
- Capabilities are the closed const `CABINET_CAPABILITY` in `packages/domain/src/access/cabinet.ts`; `ROLE_CAPABILITIES` maps the four roles `owner | admin | manager | member`; `resolveCabinetAccess(rawRole)` unions capabilities of recognized roles and ignores unknown ones; `hasCabinetCapabilities` requires every listed capability (AND, no OR).
- Better Auth organization roles are declared in `packages/db/src/organization-access.ts` (`organizationRoles`: owner, admin, manager, member). Assignable roles from the cabinet are `z.enum(["admin", "manager"])` in `apps/api/src/modules/team/dto.ts` and `canAssignTeamRole` in `team-policy.ts`; the admin offers the same two in `apps/admin/src/pages/team/InvitationForm.tsx` and `MemberActions.tsx`.
- Route policy: `RequirePermissions` / `AllowStationOrPermissions` / `RequireMembership` (`apps/api/src/authorization/access-policy.ts`) read by `AuthorizationGuard` (`authorization.guard.ts`), which reloads membership per request via `AuthorizationService.resolvePrincipal` and logs denials through `SecurityAuditService.authorizationDenied` (`security-audit.service.ts`, structured log, not a DB row). A controller without a policy is denied (`missing_policy`); `apps/api/test/authorization-metadata.test.ts` enumerates every controller and asserts its policy, so new controllers must be added there.
- Subscription gating: `SubscriptionAccessGuard` + `RequireSubscriptionWrite` / `AllowSubscriptionReadOnly("read")` (`apps/api/src/subscriptions/subscription-access-policy.ts`, `subscription-access.guard.ts`); non-GET routes without a policy are refused with `subscription_policy_missing`.
- `GET /access/me` (`apps/api/src/authorization/access.controller.ts`) returns roles, capabilities, subscription, usage, quotas, features; the admin loads it once in `apps/admin/src/pages/Shell.tsx` (`AccessGate`), renders `NoCabinetAccess` when `capabilities.length === 0`, and exposes `useAccess` / `useCan` / `RequireCapability` from `apps/admin/src/access/context.tsx`.
- Navigation: `NAV_ITEMS` in `apps/admin/src/layout/AppShell.tsx` (route, i18n key, section key, one capability); sections are `shell.sections.production|reference|equipment|organization` in `apps/admin/src/i18n/en.json` / `ru.json`. Routes are wrapped in `RequireCapability` in `apps/admin/src/app.tsx`.
- i18n: `apps/admin/src/i18n/index.ts` (i18next, `ru` default, missing key throws in tests); `apps/admin/test/i18n.test.tsx` asserts RU/EN key lockstep. Station has its own `apps/station/src/i18n/{en,ru}.json`; landing copy is in `apps/landing/src/content/*.ts`.
- Tenant audit rows: `tenant_audit_events` (`packages/db/src/schema/team.ts`) written inline in services, e.g. `action: "tenant.pickup_policy.updated", outcome: "success", targetType: "tenant", targetId: tenantId, before, after` in `org-profile.service.ts`.
- Cabinet DTOs are Zod schemas in `apps/api/src/modules/<module>/dto.ts` with hand-written OpenAPI `SchemaObject`s; `packages/platform-contracts` is consumed by `apps/api` and `apps/saas-admin` only — `apps/admin/package.json` does not depend on it and mirrors DTO types by hand (`apps/admin/src/pages/counterparties/api.ts`).
- Zod contracts in `packages/platform-contracts` are `.strict()` (AGENTS.md); primitives live in `packages/platform-contracts/src/primitives.ts`.
- IANA validation exists as `isIanaTimeZone` in `apps/api/src/lib/time-zone.ts`; the admin time-zone select is the Russian-only `OPERATIONAL_TIME_ZONES` list in `apps/admin/src/pages/settings/time-zones.ts`.
- Migrations: `packages/db/migrations/0112_requeue_beer_statuses_after_cis_fix.sql` is the latest in the reviewed main revision; migration tests read the SQL file and assert statements (`tenant-operational-timezone-migration.test.ts`), schema tests use `getTableConfig` (`schema.test.ts`), cross-tenant FK tests insert two organizations (`tenant-isolation.test.ts`).
- Root ESLint is a flat config `eslint.config.mjs`; no `no-restricted-imports` rule exists yet.
- The production bundle has no immutable market or deployment-edition setting. The existing production inventory targets Yandex Cloud and therefore cannot host the U.S. data plane.

## Design

### Data model

New schema module `packages/db/src/schema/traceability.ts` (exported from `packages/db/src/schema.ts`), migration `packages/db/migrations/NNNN_traceability_profiles.sql` (next free number at implementation time).

```sql
CREATE TYPE traceability_profile_code AS ENUM (
  'RU_CHZ', 'US_FSMA204_PROCESSOR', 'US_GENERIC_LOT_TRACEABILITY');

CREATE TABLE traceability_profiles (
  tenant_id            text PRIMARY KEY REFERENCES organization(id),
  code                 traceability_profile_code NOT NULL,
  baseline_version     text,
  effective_at         timestamptz NOT NULL DEFAULT now(),
  retention_years       integer NOT NULL DEFAULT 5,
  updated_by_user_id   text REFERENCES "user"(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT traceability_profiles_baseline_for_us
    CHECK (code = 'RU_CHZ' OR baseline_version IS NOT NULL),
  CONSTRAINT traceability_profiles_retention_min
    CHECK (retention_years >= 2)
);

INSERT INTO traceability_profiles (tenant_id, code, effective_at)
SELECT id, 'RU_CHZ', created_at FROM organization
ON CONFLICT (tenant_id) DO NOTHING;
```

- One row per tenant, same shape as `org_profiles`. The migration backfills every existing tenant to `RU_CHZ`; `effective_at` is `organization.created_at`. New provisioning always writes an explicit profile selected from the deployment edition's allow-list, so a U.S. database cannot inherit a Russian default.
- `baseline_version` is `NULL` for `RU_CHZ` and the current `REGULATORY_BASELINE.id` (`US-REG-2026-09-03`) for both U.S. codes; the CHECK makes a U.S. row without baseline impossible. The generic profile also stores it because its exports must still say which source set the terminology follows (PRO-005 forbids only coverage claims, not the baseline stamp).
- `retention_years` resolves founding-ADR conflict 3: retention becomes a **profile field**, default 5 calendar years (matching `docs/architecture.md` §4), floor 2 calendar years (REG-009), enforced by CHECK and by the contract. It is a policy value only; no purge job is introduced (see Out of scope). US-08 (plan versions) and US-09 (export runs) read it through the profile DTO.
- Timezone is **not** duplicated: `org_profiles.time_zone` stays the single operational zone (conflict 2). The default `'Europe/Moscow'` and its migration test remain untouched (PRO-003). Instead, a transition to a U.S. code requires an explicit IANA zone in the same request and the service writes it to `org_profiles.time_zone` in the same transaction (see API).
- In the Russian deployment, a missing row is read as `RU_CHZ` to preserve existing behavior. In the U.S. deployment, a missing row returns `503 traceability_profile_not_provisioned`; it never falls back across editions. `tenant-provisioning.service.ts` and `apps/api/src/cli/provision-tenant-owner.ts` insert the row explicitly.
- No column is added to `org_profiles`, `products`, `member` or any other existing table.

### Domain rules

New folder `packages/domain/src/traceability/` (pure, framework-free, exported from `packages/domain/src/index.ts`):

- `deployment-edition.ts`: `DEPLOYMENT_EDITION = "RU" | "US"`, `allowedProfiles(edition)` and `assertProfileAllowed(edition, profile)`. The API obtains the edition from validated server configuration; clients never send or change it.
- `profile.ts`: `TRACEABILITY_PROFILE_CODE` const + `TraceabilityProfileCode`; `profileFeatures(code)` returning a frozen `{ traceability: boolean; ftrClaims: boolean; ruRegulatory: boolean; cteSet: readonly ("receiving" | "transformation" | "shipping")[] }` (`RU_CHZ` → traceability false, ruRegulatory true; `US_FSMA204_PROCESSOR` → all true except ruRegulatory; `US_GENERIC_LOT_TRACEABILITY` → traceability true, ftrClaims false). `OUT_OF_SCOPE_CTES` lists harvesting, cooling, initial packing and first land-based receiving for REG-004 display text.
- `regulatory-baseline.ts`: `REGULATORY_BASELINE = { id: "US-REG-2026-09-03", verifiedAt: "2026-09-03", reviewer, sources: [{ id: "FDA-01", title, url, checkedAt }, …] }` transcribed from `docs/us/regulatory-basis.md`; `buildBaselineStamp(profile)` returns `{ baselineId, verifiedAt, sourceIds, sources }` that US-07/08/09 print in workbook, plan PDF and manifest (REG-001). Source URLs are documentation strings only; nothing in the domain or API fetches them (INT-007).
- `claims.ts`: `PROHIBITED_CLAIM_PATTERNS` — case-insensitive regexes for the "Not allowed" column of `docs/us/limitations.md` in English and Spanish (FDA approved/-approved, FDA certified, certified compliant, guarantees compliance, official FDA integration, FDA requires serialization/SSCC, EPCIS is required by FDA; aprobado por la FDA, certificado por la FDA, garantiza el cumplimiento, integración oficial con la FDA) and `findProhibitedClaims(text): string[]`.
- `access/cabinet.ts` gains the U.S. capabilities and roles below; `resolveCabinetAccess` is unchanged in shape.

Capability set (PRO-006), added to `CABINET_CAPABILITY`:

| Capability                          | Meaning                                                      |
| ----------------------------------- | ------------------------------------------------------------ |
| `traceability.read`                 | View parties, locations, lots, events, trace, plan, requests |
| `traceability.master_data.write`    | Create/edit parties, locations, product traceability profile |
| `traceability.receiving.write`      | Draft and edit Receiving events                              |
| `traceability.transformation.write` | Draft and edit Transformation events                         |
| `traceability.shipping.write`       | Draft and edit Shipping events                               |
| `traceability.qa.manage`            | Finalize/amend/void, FTL review, plan approve, trace request |
| `traceability.export.read`          | Download export runs, plan PDFs, request packages            |

New Better Auth organization roles (registered in `organization-access.ts` with `memberAc.statements` and `apiKey: []`, exactly like `manager`) and their capabilities in `ROLE_CAPABILITIES`:

| Role                        | Capabilities                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| `traceability_receiving`    | read, receiving.write                                                                    |
| `traceability_production`   | read, transformation.write                                                               |
| `traceability_shipping`     | read, shipping.write                                                                     |
| `traceability_qa`           | read, master_data.write, receiving/transformation/shipping.write, qa.manage, export.read |
| `traceability_auditor`      | read, export.read                                                                        |
| `manager` (existing)        | existing + read, master_data.write, receiving/transformation/shipping.write              |
| `admin`, `owner` (existing) | existing + all seven                                                                     |

Multi-role memberships (`manager,traceability_qa`) already union. The five roles are cabinet users (Better Auth), never station operators (NFR-002). Profile PUT reuses the existing `tenant.settings.manage`; no new settings capability.

### Contracts and API

Contracts live in `packages/platform-contracts/src/traceability/profile.ts` per the founding ADR (see OQ-US00-1 for the admin dependency question): `traceabilityProfileCodeSchema`, `traceabilityProfileSchema` (response, `.strict()`), `putTraceabilityProfileSchema`. The API module `apps/api/src/modules/traceability/profile/` re-exports them from its `dto.ts` and adds the OpenAPI `SchemaObject`.

`GET /traceability/profile` — `@RequirePermissions(traceability.read)`, `@AllowSubscriptionReadOnly("read")`. Response:

```json
{
  "code": "US_FSMA204_PROCESSOR",
  "baselineVersion": "US-REG-2026-09-03",
  "effectiveAt": "2026-09-03T00:00:00.000Z",
  "retentionYears": 5,
  "timeZone": "America/Los_Angeles",
  "features": {
    "traceability": true,
    "ftrClaims": true,
    "ruRegulatory": false,
    "cteSet": ["receiving", "transformation", "shipping"]
  },
  "baseline": {
    "baselineId": "US-REG-2026-09-03",
    "verifiedAt": "2026-09-03",
    "sources": [{ "id": "FDA-01", "title": "…", "url": "…", "checkedAt": "2026-09-03" }]
  },
  "outOfScopeCtes": ["harvesting", "cooling", "initial_packing", "first_land_based_receiving"]
}
```

`PUT /traceability/profile` — available only in the U.S. deployment, `@RequirePermissions(tenant.settings.manage)`, `@RequireSubscriptionWrite()`. Body `{ code, timeZone?, retentionYears? }`, partial merge like `PUT /org/profile`. The `code` schema contains only the two U.S. profiles. Rules, in the service and inside one transaction:

1. Initial U.S. provisioning requires `timeZone` (400 `time_zone_required` otherwise); it is validated by `isIanaTimeZone` and written to `org_profiles.time_zone` (upsert, same as `OrgProfileService.upsertProfile`).
2. `baseline_version` is set by the server to `REGULATORY_BASELINE.id`; clients cannot set it.
3. `retentionYears` below 2 → 400 `retention_below_minimum` (contract `z.number().int().min(2)`).
4. `effective_at` is set to `now()` when `code` changes, else unchanged.
5. A code change is refused with 409 `profile_has_traceability_records` once U.S. tables owned by later slices contain rows for the tenant (US-01 registers `traceability_parties`/`traceability_locations` in a small `TRACEABILITY_PROFILE_LOCK_TABLES` list; later slices append). Switching an empty tenant back and forth stays allowed for demos.
6. Audit row in `tenant_audit_events`: `actorUserId = req.userId`, `action = "traceability.profile.updated"`, `outcome = "success"`, `targetType = "tenant"`, `targetId = tenantId`, `before/after = { code, baselineVersion, effectiveAt, retentionYears, timeZone }`, `requestId`. Written only when something changed.

`GET /access/me` gains `traceabilityProfile: { code, features }` (also in `accessDocumentOpenApiSchema`) so the shell can gate navigation before any page-level capability query; `AuthorizationService` reads it through the resolver below.

Gating helper (server): `TraceabilityProfileResolver` (`apps/api/src/modules/traceability/profile/traceability-profile.resolver.ts`) with `resolve(tenantId): Promise<{ code, features }>` — one PK read, no cache across requests (same reload discipline as membership). Decorators `RequireDeploymentEdition(...editions)` and `RequireTraceabilityProfile(...codes)` are enforced after `SubscriptionAccessGuard`. An edition mismatch returns 404 so a disabled product surface is not advertised; a profile mismatch returns 403 `{ code: "traceability_profile_required", required: [...] }`. `authorization-metadata.test.ts` asserts that every controller under `modules/traceability/**` carries both boundaries.

Idempotency: `PUT` is naturally idempotent; no key. INT-004 is enforced by an ESLint `no-restricted-imports` block in `eslint.config.mjs` for files under `packages/domain/src/traceability/**`, `packages/platform-contracts/src/traceability/**`, `apps/api/src/modules/traceability/**`, `apps/admin/src/pages/traceability/**`, forbidding `**/exchange/**`, `**/signer-agents/**`, `**/chz-*`, `**/national-catalog/**`, `**/product-regulatory/**`, `@markiro/db/schema/chz`, `@markiro/db/schema/integrations`, `@markiro/platform-contracts/chz-signer`.

### Admin UI

- Access: `AccessDocument` gains `traceabilityProfile`; `apps/admin/src/access/context.tsx` adds `useTraceabilityProfile()` and `useProfileFeature(feature)`; a `ProfileOnly` component (`profiles` or `feature` prop) renders children or nothing (not `ForbiddenPage` — hidden, not denied).
- Navigation: `NAV_ITEMS` entries get an optional `edition?: DeploymentEdition` and `feature?: keyof ProfileFeatures`. RU regulatory items (`/codes`, `/conflicts`, `/pickup`, `/disaggregation`, `/integrations`) and their route modules are omitted from the U.S. build; the API composition root likewise does not register their controllers in the U.S. deployment. The new section `shell.sections.traceability` with `nav.traceability` (`/traceability`, capability `traceability.read`, feature `traceability`) is available only in the U.S. edition. `AppShell` still filters by tenant capability and profile feature inside that edition. Direct navigation to a route excluded by the deployment edition returns 404 and no corresponding API route exists.
- Index route: when the principal lacks `operations.read` but has `traceability.read`, `/` redirects to `/traceability`, so a `traceability_receiving` user does not land on `ForbiddenPage`.
- `/traceability` page (`apps/admin/src/pages/traceability/index.tsx`, "Traceability overview" in US-00): active profile card (code, effective date, baseline ID, verified date, source list with links, retention calendar years, timezone), the REG-004 CTE scope block (three CTEs in scope, out-of-scope list), and the fixed footer text "Designed to support applicable FSMA 204 recordkeeping requirements. Traceability readiness demonstrator." For `US_GENERIC_LOT_TRACEABILITY` the card says "Generic lot traceability — no FTR coverage claims" and hides the CTE block. Later slices add tabs/links here.
- Settings (`apps/admin/src/pages/settings/OrgProfilePage.tsx`): the U.S. deployment shows a "Regulatory profile" section with only `US_FSMA204_PROCESSOR` and `US_GENERIC_LOT_TRACEABILITY`, a U.S. timezone list, retention calendar years with the 2-calendar-year floor, and a confirm dialog on profile change. The Russian deployment does not render this section. Sections `inn`, CHZ category defaults and pickup policy are not registered in the U.S. navigation; GLN, GS1 prefixes, logo and SSCC counters stay because SSCC is the optional case layer.
- Header (`apps/admin/src/layout/Header.tsx`): a non-color profile badge next to the organization name (`US · FSMA 204`, `US · Generic`, nothing for RU) — PRO-005 visibility on every screen.
- i18n: `nav.traceability`, `shell.sections.traceability`, `access.profile.*`, `pages.traceability.overview.*`, `pages.settings.regulatoryProfile.*` in both `en.json` and `es.json` (edition-aware key test). U.S. locales are `en-US` (default) and `es-US`, with English fallback; preserve the separate RU edition's existing locale support.
- Accessibility (NFR-012): select and inputs with labels, the badge carries text not only color, confirm dialog is focus-trapped (`ConfirmDialog` from `@markiro/ui`), errors are rendered as text under fields.

### Station

Not touched. The station receives no profile in US-00; the content test only scans `apps/station/src/i18n`.

### Profile gating and RU_CHZ safety

- Every existing tenant in the Russian database is backfilled to `RU_CHZ`; the resolver treats a missing row as `RU_CHZ` only in the Russian deployment. The Russian admin renders exactly as today.
- No existing table, column, default, enum or migration is modified; `org_profiles.time_zone` default remains `Europe/Moscow`.
- Existing controllers get no new decorator; only `AccessController` gains one response field (additive). `hasCabinetCapabilities` semantics are unchanged; existing roles keep every capability they have.
- U.S. routes are not registered in the Russian deployment. The selected RU regulatory route/controller modules are not registered in the U.S. deployment. Profile guards remain the tenant-level boundary between the two allowed U.S. profiles.
- Required proof (planned verification, not yet run): the full existing suites (`apps/api/test/authorization*.test.ts`, `org-profile*.test.ts`, `apps/admin/test/shell*.test.tsx`, `access-routing.test.tsx`, `packages/db/test/schema.test.ts`, `tenant-operational-timezone-migration.test.ts`) must run unchanged and pass; a new API test must assert that a RU tenant's `/access/me` equals the pre-change document plus `traceabilityProfile: { code: "RU_CHZ", … }`.

## Testing

- Unit (`packages/domain/test/traceability-profile.test.ts`, `regulatory-baseline.test.ts`, `claims.test.ts`, `cabinet-access.test.ts`): feature matrix per code; `REGULATORY_BASELINE.id` equals the `Baseline ID:` line of `docs/us/regulatory-basis.md` and every `FDA-xx`/`GS1-xx`/`MKR-xx` in its source register is present (drift test, REG-001/REG-012); exact capabilities for the five new roles, `manager,traceability_qa` union, unknown role still empty; `findProhibitedClaims` catches each matrix entry in both languages and passes the allowed column.
- Content test (REG-002, acceptance §2.4 "FDA-approved"): `apps/admin/test/us-claims.test.tsx`, `apps/station/test/us-claims.test.ts`, `apps/landing/src/lib/us-claims.test.ts` flatten `en.json`/`es.json` / `content/*.ts` and assert zero matches; a deliberately injected string in the test proves the scanner fails.
- DB (`packages/db/test/traceability-profile-migration.e2e.test.ts`, `traceability-profile-schema.test.ts`, `tenant-isolation.test.ts`): fresh migration creates enum, table and CHECKs; upgrade from the preceding migration backfills pre-existing organizations to `RU_CHZ` with `effective_at = organization.created_at` and leaves `org_profiles` untouched. CHECK rejects `US_*` without a nonblank baseline and `retention_years = 1`; retention is calendar years, not days.
- API e2e (`apps/api/test/traceability-profile.e2e.test.ts`): the RU edition provisions `RU_CHZ`, exposes no U.S. traceability controller and preserves its existing `/access/me` behavior plus the additive profile summary; the U.S. edition refuses provisioning without `timeZone`, provisions only one of the two U.S. profiles, writes `org_profiles.time_zone`, and asserts the audit row field by field (actor, action, target, outcome, before/after, requestId). `manager` PUT → 403 `insufficient_permission`; read-only subscription PUT → `SubscriptionReadOnlyException`; a second tenant's profile is never visible; a probe controller guarded for `US_FSMA204_PROCESSOR` answers 403 for the generic U.S. profile and 200 for the processor profile; edition-mismatched routes return 404; `authorization-metadata.test.ts` is extended.
- Admin (`apps/admin/test/traceability-overview.test.tsx`, `shell-layout.test.tsx`, `org-profile.test.tsx`): RU access document renders today's nav exactly; US document hides the five RU items, shows the Traceability section and the header badge; settings section switches timezone list and requires zone; i18n lockstep.
- Negative cases from acceptance §2.4 that apply: cross-tenant ID denied, prohibited wording fails, EPCIS absent (no code path references EPCIS).
- Deployment/data-location contract (NFR-016): production startup requires an explicit immutable `MARKIRO_DEPLOYMENT_EDITION`; the U.S. bundle fails closed if it is missing or if an RU-only profile/module is selected. A checked deployment inventory records the jurisdiction of database, object storage, logs, telemetry payloads, mail, secrets and backups, and rejects any U.S. production endpoint or region located in RF. Remote administrator sessions are separately tested for MFA policy, least-privilege roles and audit events; the runbook prohibits downloads, replicas and developer fixtures containing U.S. production data in RF.
- Gates: `pnpm turbo lint typecheck test build --concurrency=1 --force`, `pnpm format:check`.

## Evidence

- C-001: screenshot of the Traceability overview showing baseline ID, verified date and source list; link to `docs/us/regulatory-basis.md` review log.
- C-002: screenshot of the settings section with `US_FSMA204_PROCESSOR` active plus the green RU suite report; screenshot of a RU tenant unchanged.
- C-020: content test output (three packages) attached to the verification report.
- NFR-016: deployment inventory and preflight report showing every U.S. production persistence/processing service outside RF; access-control test and audit sample for a remote administrator; backup-restore evidence in the same non-RF data plane.
- Verification report separating automated / browser / not run (no station, no hardware, no external checks in this slice).
- `docs/us/requirements-traceability.md` rows REG-001…012, PRO-001…003, PRO-005, PRO-006, INT-004, INT-007 updated; REG-005…REG-008 are recorded as "boundary set here, evidenced by US-04/05/08/09" (see Open questions).

## Out of scope

Retention purge or archive jobs; any lot, event, plan, request or export entity; product-form hiding of `chz_product_group_code`, `egais_code` and the national-catalog tab (US-02, which owns the product traceability profile); station profile awareness (US-10); synthetic tenant seed (US-11); per-user grants or custom role editor; EPCIS; automatic exemption logic; any change to `RU_CHZ` behavior.

## Open questions

| ID         | Question                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Options                                                                                                                                                                       | Recommendation                                                                                                                                                                                                            | Blocking? |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| OQ-US00-1  | ADR places Zod contracts in `packages/platform-contracts/src/traceability/`, but cabinet modules keep Zod in `apps/api/.../dto.ts` and `apps/admin` does not depend on platform-contracts.                                                                                                                                                                                                                                                                                                                                                        | (a) Follow ADR and add `@markiro/platform-contracts` to `apps/admin`; (b) keep the cabinet pattern (api dto + hand-mirrored admin types); (c) contracts in `@markiro/domain`. | (a): one `.strict()` source consumed by api, admin and later `tools/us-demo`; the admin dependency is additive. Decide once for all U.S. slices.                                                                          | yes       |
| OQ-US00-2  | Timezone (founding-ADR conflict 2): reuse `org_profiles.time_zone` or add `traceability_profiles.time_zone`?                                                                                                                                                                                                                                                                                                                                                                                                                                      | (a) Reuse, require explicit zone during U.S. provisioning; (b) separate column; (c) change the default.                                                                       | (a): one operational clock per tenant (shifts, labels, exports agree); default and its migration test untouched.                                                                                                          | no        |
| OQ-US00-3  | Retention (conflict 3): profile field, platform setting or catalog feature?                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | (a) `traceability_profiles.retention_years` default 5 floor 2; (b) `tenant_subscriptions` quota; (c) env-level constant.                                                      | Resolved: retention_years, default 5, minimum 2; shared MVP contract. See [MVP contract](../../us/mvp-contract.md).                                                                                                       | no        |
| OQ-US00-4  | Role names for the five U.S. roles in `member.role`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | (a) `traceability_receiving`…`traceability_auditor`; (b) `us_*`; (c) plain `receiving`, `qa`…                                                                                 | (a): profile-neutral (generic profile uses them too), unambiguous next to `manager`.                                                                                                                                      | no        |
| OQ-US00-5  | Does `manager` receive the three CTE write capabilities and `master_data.write`?                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | (a) Yes, not `qa.manage`; (b) manager gets read only; (c) manager gets everything.                                                                                            | (a): mirrors today's manager (operations read/write without settings).                                                                                                                                                    | no        |
| OQ-US00-6  | Which RU navigation and route modules are excluded from the U.S. deployment in US-00?                                                                                                                                                                                                                                                                                                                                                                                                                                                             | (a) codes, conflicts, pickup, disaggregation, integrations; (b) also shifts/lines/inventory/labels; (c) keep every module.                                                    | (a): those five are Chestny ZNAK/1C-specific; shifts, lines, inventory, labels and devices are generic and needed by US-04/US-10.                                                                                         | no        |
| OQ-US00-7  | Should a profile code change be refused once U.S. records exist (rule 5)? Sub-questions to settle with it: (i) are existing `US_GENERIC_LOT_TRACEABILITY` rows compatible with, reclassified for, or blocking a switch to `US_FSMA204_PROCESSOR`; (ii) is 409 `profile_has_traceability_records` the code for every refused direction; (iii) is a refused attempt audited (`traceability.profile.updated`, `outcome = "denied"`) and what happens to existing rows on an allowed switch. Empty-tenant switching stays allowed under every option. | (a) 409 when any traceability table has rows; (b) always allowed; (c) allowed only `US_GENERIC` → `US_FSMA204`.                                                               | (a) with (c) as an explicit exception: upgrading generic to FSMA is the natural onboarding path and loses nothing; generic rows stay as they are (no reclassification), the refusal is audited with `outcome = "denied"`. | no        |
| OQ-US00-8  | REG-005…REG-008 are assigned to US-00 in the matrix but can only be evidenced by US-04/05/08/09.                                                                                                                                                                                                                                                                                                                                                                                                                                                  | (a) Keep in US-00 with "boundary" note; (b) reassign rows to the implementing slices.                                                                                         | (b): status must point at real tests; US-00 records the constants (`cteSet`, baseline) only.                                                                                                                              | no        |
| OQ-US00-9  | `/access/me` carries the profile summary vs. a separate admin fetch of `/traceability/profile`.                                                                                                                                                                                                                                                                                                                                                                                                                                                   | (a) Summary in `/access/me`; (b) separate query gated by `traceability.read`.                                                                                                 | (a): the shell already blocks on `/access/me`; RU users never need a second request.                                                                                                                                      | no        |
| OQ-US00-10 | Should the content test also scan `docs/us/*.md` and this spec series?                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | (a) Only UI/landing strings; (b) also docs with an allow-list for `limitations.md` and `requirements.md` quotes.                                                              | (b) in US-11 evidence mode; US-00 ships (a).                                                                                                                                                                              | no        |
| OQ-US00-11 | Who may assign the new roles from the team UI?                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | (a) owner/admin as today via `canAssignTeamRole`; (b) also `traceability_qa`.                                                                                                 | (a): keep the team boundary unchanged.                                                                                                                                                                                    | no        |
| OQ-US00-12 | Should RU regulatory routes and APIs (`/codes`, `/conflicts`, `/pickup`, `/disaggregation`, `/integrations`) be registered in the U.S. deployment?                                                                                                                                                                                                                                                                                                                                                                                                | (a) Exclude the route/controller modules by deployment edition; (b) register them and add per-request profile guards; (c) navigation-only hiding.                             | (a): deployment-level composition is fail-closed and avoids exposing irrelevant APIs; retain RU regression tests against the RU edition.                                                                                  | no        |

## Revised implementation gates

Use calendar years for `retention_years` and `retentionYears` (default 5, floor 2), with no P0 purge. Validate `DEPLOYMENT_EDITION` at startup and ensure the frontend build matches; only explicit RU edition has a RU fallback. Unregister RU jobs and integration workers as well as routes in the US edition. Existing controllers still need edition-composition tests. Provision fresh U.S. data; do not restore a RU tenant snapshot.

Define build metadata once in US-00: immutable `{ version, gitSha }` injected by the build and reused by API, admin, exports and evidence. Do not execute git or expose environment values at runtime. New traceability roles need explicit shared Catalog/Team endpoint capabilities and denial tests; a hidden button is not authorization.

The claims test explicitly permits the approved negated disclaimer and negative fixtures. The profile read endpoint must also be reachable by a tenant-settings administrator during initial provisioning; do not require a profile-dependent capability before the profile exists.

## Calendar policy increment — 2026-09-05

[CLAR-02](../../us/development-clarifications.md) defines the domain policy for REG-009. `traceabilityRetention` in `packages/domain/src/traceability/retention.ts` accepts validated ISO civil dates, a record/plan anchor, calendar years, dated/indefinite holds and a persisted prior floor. It returns an inclusive `retainThrough` date or an explicit indefinite reason. February 29 rolls forward to March 1 in non-leap anniversary years; an effective plan, active indefinite hold or unrepresentable future date has no expiry. This pure helper is not yet wired into record/plan persistence; it does not add a deletion path or prove storage/backup enforcement.
