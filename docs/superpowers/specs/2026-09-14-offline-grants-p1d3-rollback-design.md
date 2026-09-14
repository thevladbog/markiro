# Offline grants P1D.3: selective confirmed rollback

**Status:** approved product direction

**Date:** 2026-09-14

**Depends on:** P1C offline grants, P1D.1 readiness and P1D.2 activation

**Requirement scope:** FR-LIF-03, FR-ACC-05, AC-40, AC-41, AC-54

## 1. Goal

P1D.3 lets two platform administrators return an exact subset of active
`offline-grants-v1` devices from `strict` to `observe`. The rollback is prepared
from current persisted activation facts, confirmed by a different operator and
applied only after the server rechecks every selected device.

Devices outside the exact rollback set keep their current mode. The operation
does not change catalog versions, subscriptions, prices, terms, offers, invoices,
feature quantities, completed work or retained recovery evidence.

## 2. Chosen model

Use a purpose-specific three-step operation:

1. A platform administrator selects one to 200 currently active strict device
   activations and prepares a rollback with a decision reference.
2. A different platform administrator reviews the immutable snapshot.
3. Confirmation atomically creates an approved `observe` policy revision and
   records a terminal rollback transition for every selected activation.

The exact subset model is preferred to whole-cohort rollback because it limits
customer impact and permits staged pilot replacement. One rollback may select
devices from several P1D.2 activation preparations only when all selected
devices share the exact base policy revision. Different base revisions require
separate operations, even when their grant limits happen to match.

Rollback is an operational overlay. It does not replace the subscription's
`planVersionId` or mutate the base catalog lifecycle policy.

## 3. Authorization

All routes are platform routes protected by `PlatformAuthGuard`.

- List and detail require `tenants.read` and `catalog.read`.
- Prepare, cancel and confirm require `tenants.read`, `catalog.read`,
  `catalog.write` and `offlineGrants.activate`.
- Confirm requires a current platform principal different from the preparer.

Cabinet sessions, public integration keys, native device credentials and a
rollback identifier never authorize these operations.

## 4. Contracts and routes

The platform API adds:

| Method | Route                                            | Purpose                             |
| ------ | ------------------------------------------------ | ----------------------------------- |
| `GET`  | `/platform/offline-grants/rollbacks/candidates`  | List active strict activations      |
| `GET`  | `/platform/offline-grants/rollbacks`             | List rollback preparations          |
| `GET`  | `/platform/offline-grants/rollbacks/:id`         | Read one preparation or receipt     |
| `POST` | `/platform/offline-grants/rollbacks`             | Prepare an exact selective rollback |
| `POST` | `/platform/offline-grants/rollbacks/:id/confirm` | Confirm with a second operator      |
| `POST` | `/platform/offline-grants/rollbacks/:id/cancel`  | Cancel an unconfirmed preparation   |

Prepare accepts protocol `offline-grants-rollback-v1`, one to 200 unique active
activation UUIDs, a bounded decision reference and a request UUID. The server
derives tenant, device, subscription and policy identities from the activation
rows; clients cannot supply those authority facts.

The candidates route is cursor-paginated and returns current active activation
IDs with display-only tenant, device, strict-policy and decision-reference facts.
It is the selection source for SaaS Admin; prepare still re-derives and locks all
authority facts and never trusts candidate-list output.

Confirm accepts the saved rollback digest and a request UUID. Cancel accepts a
bounded reason and its own request UUID. Exact retries replay the persisted
response. Changed input under a reused request ID returns
`GRANT_ROLLBACK_REQUEST_CONFLICT`.

## 5. Preparation snapshot

Prepare runs in a repeatable-read transaction and:

1. Locks and loads the exact activation IDs in canonical order.
2. Requires every row to be active and backed by a confirmed P1D.2 preparation.
3. Resolves the current subscription base policy and hash-verifies the strict
   rollout policy.
4. Requires current tenant, subscription, device, credential epoch and assignment
   ownership to match the activation.
5. Requires every device to still resolve to that exact strict activation.
6. Requires one common base policy revision and strict overlays that preserve
   its offline durations and task bounds.
7. Stores a canonical digest over all derived facts.

The snapshot contains the exact activation, device, tenant, subscription, base
policy, strict rollout policy, credential epoch and latest configuration
identities. It never contains device credentials, private signing keys or JWS
bytes.

Preparations expire after 30 minutes and never extend on retry. At most one
non-expired rollback preparation may reserve an active activation. Expired,
cancelled and needs-review preparations release reservations while preserving
history.

Prepare performs no runtime or commercial mutation.

## 6. Confirmation

Confirm locks the preparation, selected activations and all current authority
facts in the established global order. It rejects expired, cancelled, confirmed
or superseded preparations and enforces the second-operator rule.

The server recomputes the preparation digest. Any activation, subscription,
policy, assignment, credential, configuration or ownership drift produces a
durable `needs_review` result and releases reservations without partial rollback.

When the snapshot still matches, confirmation atomically:

1. Allocates the next lifecycle-policy version for the common policy key.
2. Copies the base policy payload byte-for-byte except for an exact rollout:
   `mode: "observe"`, sorted device IDs and the saved decision reference.
3. Inserts the approved observe policy with the preparer as creator and confirmer
   as approver.
4. Marks each selected activation terminally rolled back with the rollback
   preparation, observe policy, confirming actor and timestamp.
5. Marks the rollback preparation confirmed and stores the exact receipt.
6. Writes complete platform audit records in the same transaction.

The strict activation's original policy, preparation, actor and time remain
unchanged. The rollback transition is a constrained one-way addition; rows are
never deleted and a rollback cannot be silently undone.

## 7. Runtime behavior

For an authenticated device, an active strict activation still has priority. If
there is no newer active strict activation and the latest matching activation has
a confirmed rollback, the approved observe policy becomes the effective policy.
This lets configuration history retain the rollback decision reference while the
wire contract continues to return the existing `observe` shape.

A later separately approved P1D.2 activation may put the device into strict
again. Its active row takes priority over historical rolled-back rows. Database
and transaction locks prevent two current overlays for the same device.

Rollback affects newly resolved configuration and new grant issuance. It does not
invalidate compact grants already held offline, erase frozen task authority or
block recovery evidence. Emergency signing-key retirement remains independent.

No Station, Handheld or kiosk DTO changes are required.

## 8. Persistence

Add forward-only tables for rollback preparations and exact rollback members.
They mirror P1D.2 request identity, actor separation, 30-minute expiry, canonical
snapshot, response persistence and member reservation constraints.

Extend `offline_grant_device_activations` with nullable rollback preparation,
observe policy, confirming actor and rollback timestamp columns. A database check
requires all rollback fields to be null or all present, requires rollback time at
or after activation, and requires strict and observe policy IDs to differ.
Foreign keys bind the transition to its preparation, policy and platform actor.

The existing `revoked_at` column records the same rollback timestamp for backward
compatibility. The new constraint requires `revoked_at` and `rolled_back_at` to be
equal when rollback provenance exists. P1D.3 does not reinterpret legacy rows
that might already have `revoked_at` without provenance; runtime treats those
rows as observe through the base policy and does not fabricate a decision.

## 9. SaaS Admin

The activation workspace shows confirmed strict cohorts and allows authorized
operators to select active member activations for rollback. The preparation card
shows exact devices, original activation references, decision reference,
preparer, expiry and drift state.

The preparer cannot confirm their own rollback. Uncertain prepare, confirm or
cancel responses retain the original request payload and request ID, keep the
drawer dirty and retry unchanged. Customer-facing pages gain no rollout control.

The UI states clearly that selected devices return to observe after their next
authenticated configuration refresh and that existing offline work remains
recoverable.

## 10. Errors and recovery

Stable outcomes distinguish missing activation, inactive activation, mixed base
policies, malformed persisted policy, overlapping preparation, expired
preparation, same-operator confirmation, snapshot drift and request-ID conflict.

Database and infrastructure failures propagate. Only a `23505` violation from
the exact prepare, confirm or cancel request-ID constraint maps to
`GRANT_ROLLBACK_REQUEST_CONFLICT`; unrelated unique violations are rethrown.

## 11. Audit and observability

Audit events record exact actor, role, request ID, operation, result, preparation,
digest, policy IDs, activation IDs, tenant count, device count, reason aggregates
and before/after mode. They exclude credentials and signed grant bytes.

Metrics distinguish prepared, stale, expired, cancelled, confirmed,
configuration-delivered and reactivated devices. Confirmation is not proof that a
device received observe configuration or passed physical acceptance.

## 12. Migration and deployment

The migration is additive and must complete before code reads rollback tables or
new activation columns. Foreign keys added to large existing tables use
`NOT VALID` and are validated in a following migration transaction.

Deploying code with no rollback rows leaves every current client unchanged.
Production cohort selection, two-person approval, device refresh and physical
tests remain separate operational gates.

## 13. Verification

Contracts and database tests cover strict schemas, 200-item bounds, duplicate
IDs, state constraints, actor separation, request replay, composite ownership,
reservation release and migration validation.

API tests cover selective rollback, devices outside the subset remaining strict,
same-operator denial, every drift boundary, concurrent confirmation, exact audit,
unchanged commercial rows, new observe configuration and preserved frozen-task
and evidence recovery.

SaaS Admin tests cover selection, two-operator UX, expiry, uncertain retries,
dirty-state protection, pagination and both locales. Existing Station, Handheld
and kiosk recovery suites prove wire compatibility; hardware acceptance remains
explicitly unrun unless exercised on real devices.

## 14. Completion criteria

P1D.3 is complete when an exact active subset can be prepared without mutation,
confirmed only by a different operator, atomically returned to observe, and
retried after ambiguous responses without changing request identity. Devices
outside the subset, commercial state, saved work and recovery evidence remain
unchanged, and all automated proof categories are recorded separately from
deployment and physical acceptance.

## 15. Outside P1D.3

- automatic rollback based on telemetry;
- instant invalidation of authority already held offline;
- automatic cohort expansion or broad strict rollout;
- customer-controlled rollout mode;
- changes to tariffs, services, offers, invoices or public inventory API;
- production deployment, real cohort selection and physical pilot acceptance.
