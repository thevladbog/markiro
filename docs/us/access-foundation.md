# Isolated US access policy

Status: local development increment, 2026-09-05. Owner-approved separate US policy; PRO-006 and US-00 remain in progress. Release locks are unchanged.

## Scope and policy

`packages/domain/src/traceability/access.ts` owns the US capability matrix. It does not extend the RU cabinet resolver or shared Better Auth organization roles. Both products can reuse the domain package without recognizing the other product's operational roles. No US role grants RU operations, integration, billing, API-key or credential permissions.

| Role                      | US permissions                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| `traceability_receiving`  | Read; receiving write                                                                        |
| `traceability_production` | Read; transformation write                                                                   |
| `traceability_shipping`   | Read; shipping write                                                                         |
| `traceability_qa`         | Read; master data; all three event write capabilities; QA management; export read            |
| `traceability_auditor`    | Read; export read                                                                            |
| `manager`                 | Read; master data; all three event write capabilities; no QA/export/settings/team permission |
| `owner`, `admin`          | All seven traceability capabilities plus `tenant.settings.manage` and `members.manage`       |
| `member`, unknown role    | No business capabilities                                                                     |

Comma-separated recognized roles are trimmed, deduplicated and unioned. Capability requirements use AND, not OR. Unknown names, including prototype-property names, grant nothing. Resolved arrays are fresh per call. The matrix describes authorization policy, not implemented operational features.

## Current enforcement

The existing MFA principal query derives tenant, user, active session and membership from the database on every request. It now resolves the current membership's roles and capabilities, not a role stored in cookie/session metadata. Revoked membership and missing MFA assurance remain denied. An authenticated member without business rights may have a principal with no capabilities; that principal is not permission to access an endpoint.

The profile store independently reloads and locks the actor's membership within its transaction. Reading a stored profile requires `traceability.read`. Initial provisioning, including an identical retry, requires `tenant.settings.manage`. Downgrading a user does not let them retrieve a previous write result through PUT.

When no profile exists, owner/admin receive the precise `503 traceability_profile_not_provisioned` signal that opens initial setup. Other readers receive `403 insufficient_permission`; the existing browser does not offer a form they cannot submit. Invalid persisted profiles still fail closed. Successful reads do not write audit events; profile provisioning retains its existing exact atomic audit event.

The existing US controller's OpenAPI descriptions now distinguish profile read from initial provisioning. No new HTTP routes, response fields, migrations or UI controls are introduced. The RU access resolver, organization roles, entry and interface are unchanged.

## Verification

- TDD: 18 domain tests initially failed because the US resolver was absent; the independent RU-isolation regression already passed. All 19 tests passed after implementation.
- Three existing real-database suites initially had eight failures: the principal lacked capabilities and the six reader roles plus the HTTP auditor were denied stored profile reads. All 77 tests passed after the policy was connected.
- Full domain regression: 587 tests passed across 39 files, including the unchanged RU role tests. Domain source/test typechecks, API typecheck, domain/API lint and API build passed.
- Tests cover exact least-privilege grants, unknown/multiple roles, role changes during the same MFA session, membership revocation, cross-tenant denial, read-only profile access, initial-setup refusal and unauthorized idempotent PUT retries. Fixtures use only randomly named disposable US PostgreSQL databases; no base database provisioning occurs.
- Independent read-only review found no actionable defects in the policy, existing consumer or browser error contract.
- The existing real Chromium access/profile scenario passed against the rebuilt API, including TOTP enrollment, profile persistence, logout ordering and backup-code login. This is owner-flow regression coverage, not a browser test of role administration. The API test separately verifies that an auditor can enroll/select an organization before any role changes.
- All 17 entry/release-isolation contracts passed; full-worktree formatting and whitespace checks passed. No RU access-policy or operational-workflow diff was introduced.
- Full API run: 1,585 tests passed and 1,411 skipped; all six US suites passed. The same eight RU suite-setup failures documented in [local owner verification](local-owner-provisioning.md) remain in the clean US-only environment: billing accounts, exchange credentials/import/orders/protocol, integrations delete, integrations and subscription route inventory. The full API gate is not green. No primary credentials or database were loaded to make those suites start.

The cloud isolation run for the preceding checkpoint `1341c0a59` passed; it is not evidence for these subsequent local changes. This increment does not enable release, push new changes or modify hosted configuration.

## Remaining work

Team invitation/role assignment, event/QA/export endpoint enforcement and client-side capability-driven navigation remain separate consumers. Each must resolve the current server membership and verify its own capabilities and tenant boundary. Do not register RU Team, API-key or regulatory routes to make these features appear available.

Account recovery, authentication-event audit, hosted TLS/cookies and data-location acceptance are still open. No real accounts, external mail, hardware or hosted access-control behavior were exercised. This policy is not evidence that the complete MVP or PRO-006 is finished.
