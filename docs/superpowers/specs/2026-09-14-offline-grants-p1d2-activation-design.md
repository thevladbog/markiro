# Offline grants P1D.2: prepared pilot activation

**Status:** approved product direction; engineering design awaiting final review

**Date:** 2026-09-14

**Depends on:** P1C offline grants and P1D.1 rollout readiness

**Requirement scope:** FR-LIF-03, FR-ACC-05, AC-40, AC-41, AC-54

## 1. Goal

P1D.2 lets two platform operators prepare and confirm an exact pilot group for
`offline-grants-v1` strict admission. Confirmation creates an immutable rollout
policy revision and device-scoped activation records only after the server has
re-read every readiness fact.

The change must be invisible to customers and devices outside the confirmed
pilot. It must not change a subscription's plan version, price, term, commercial
documents, feature quantities or existing task history.

P1D.2 provides the controlled activation mechanism. It does not select a real
production cohort, choose production durations, deploy clients, prove hardware
behavior or authorize a broad production rollout.

## 2. Existing authority and compatibility

P1D.1 already provides:

- authenticated client readiness reports from Station, Handheld and kiosk;
- a platform readiness inventory derived from current server facts;
- a read-only preview for up to 200 exact device IDs;
- a deterministic digest containing the target policy, device identities,
  credential epochs, assignments, configurations, client reports, keyset and
  eligibility results.

An approved lifecycle policy is currently attached to an immutable catalog item
version, and an active subscription refers to that catalog version. Replacing the
subscription's plan version to activate a device would mix operational rollout
with commercial history. P1D.2 therefore keeps `planVersionId` and the base
lifecycle policy unchanged.

Old clients and all devices outside an active assignment continue to receive
`observe`. A selected device changes mode only after it authenticates and fetches
new configuration. Existing queues, frozen work, recovery evidence, reprints and
already saved task state keep their current paths.

## 3. Chosen model

Use a durable three-step flow:

1. P1D.1 creates a read-only readiness preview.
2. The first platform operator prepares activation from that exact preview.
3. A different platform operator confirms it after a fresh server-side check.

Confirmation atomically creates:

- an approved immutable lifecycle policy revision whose `offlineGrant.rollout`
  contains the exact sorted pilot device IDs and decision reference;
- one activation record per selected device, binding the current subscription
  base policy to the new rollout policy;
- complete platform audit events and an idempotent response receipt.

The activation record is an operational overlay for mode selection only. Grant
durations and task bounds are read from the rollout policy, and confirmation must
prove they are byte-equivalent to the base approved policy. The overlay cannot
alter feature entitlements or any commercial field.

Direct activation from an unsaved preview is rejected. A generic approval engine
is outside scope because the existing platform audit, request identity and
purpose-specific preparation patterns are sufficient.

## 4. Roles and authorization

Every route is a platform route protected by `PlatformAuthGuard`.

- List and detail require `tenants.read` and `catalog.read`.
- Prepare, cancel and confirm require `tenants.read`, `catalog.read`,
  `catalog.write` and the new `offlineGrants.activate` capability. That capability
  belongs only to `platform_admin` in P1D.2.
- Confirm additionally requires a principal whose `userId` differs from
  `preparedByPlatformUserId`.

The platform role alone is insufficient if one of the required capabilities is
missing. Cabinet sessions, public API keys, Station or Handheld keys, kiosk
credentials and possession of a preparation ID cannot authorize these routes.

The server reloads the current platform principal at each protected request.
Disabling or downgrading the preparing operator does not invalidate the immutable
preparation, but the confirming operator must have current access.

## 5. Contracts and routes

The platform API adds:

| Method | Route                                              | Purpose                                     |
| ------ | -------------------------------------------------- | ------------------------------------------- |
| `GET`  | `/platform/offline-grants/activations`             | List preparations and confirmed activations |
| `GET`  | `/platform/offline-grants/activations/:id`         | Read one exact preparation or receipt       |
| `POST` | `/platform/offline-grants/activations`             | Prepare from a P1D.1 preview                |
| `POST` | `/platform/offline-grants/activations/:id/confirm` | Confirm with a second operator              |
| `POST` | `/platform/offline-grants/activations/:id/cancel`  | Cancel an unconfirmed preparation           |

Prepare accepts:

```ts
{
  protocol: "offline-grants-activation-v1";
  previewRequestId: string;
  previewDigest: string;
  policyId: string;
  deviceIds: string[];
  decisionReference: string;
  requestId: string;
}
```

`deviceIds` contains 1 to 200 unique UUIDs. The contract requires the same
sorted set represented by the preview. `decisionReference` is human-readable
approval evidence, not an authorization token.

Confirm accepts:

```ts
{
  protocol: "offline-grants-activation-v1";
  preparationDigest: string;
  requestId: string;
}
```

Cancel accepts its own `requestId` and a bounded reason. Unchanged retries replay
the exact saved response. Reusing a request ID with changed input returns a typed
conflict and performs no mutation.

## 6. Preparation snapshot

Prepare runs in one repeatable-read transaction and performs these checks:

1. Load the referenced P1D.1 preview audit record by its request ID.
2. Verify actor-independent request identity, preview digest, policy ID and exact
   sorted device set.
3. Load and hash-verify the approved base lifecycle policy.
4. Read current readiness facts for every device using one bounded batch path.
5. Require every device to be `eligible` for that same base policy.
6. Require every selected subscription to still resolve to that base policy.
7. Compute a new activation snapshot digest from the fresh facts.

The durable preparation stores the full canonical input needed to explain and
recheck the decision:

- protocol, preparation ID, request ID and request hash;
- base policy ID, key, version, payload hash and policy revision;
- sorted device IDs and each tenant, kind, credential epoch and assignment;
- configuration, client report, verified grant and keyset identities;
- entitlement revision and current subscription identity for each tenant;
- preview request ID, preview digest and preparation digest;
- decision reference, preparing actor and role;
- `preparedAt`, `expiresAt` and state.

Preparations expire after 30 minutes and never extend on retry. Expiry is a
technical confirmation window, not an offline grant duration or subscription
term. Only one non-expired prepared activation may own the same base policy and
device. Overlapping groups are rejected with the conflicting preparation IDs.

No policy, activation assignment or device configuration changes during prepare.

## 7. Confirmation transaction

Confirm locks the preparation and rejects cancelled, expired or superseded
states. It then:

1. Verifies request replay or changed-input conflict.
2. Enforces the second-operator rule.
3. Locks the base policy and all selected subscription and device authority rows
   in the established global order.
4. Re-reads every fact used by readiness classification.
5. Recomputes the preparation snapshot digest at one server `asOf`.
6. Requires the base policy, selected devices and all eligibility results to
   match the saved preparation.
7. Allocates the next policy version for the same policy key under a key-level
   advisory lock.
8. Creates an approved lifecycle policy payload by copying the base
   `offlineGrant` values and adding the exact strict rollout.
9. Creates the device-scoped activation records.
10. Marks the preparation confirmed and records the exact response and audits.

The rollout policy records the preparing operator as
`createdByPlatformUserId` and the confirming operator as
`approvedByPlatformUserId`. Its approval time is the confirmation commit time,
and its decision reference is the immutable reference captured by prepare.

The new policy payload differs from the base only by:

```ts
rollout: {
  protocol: "offline-grants-v1";
  mode: "strict";
  deviceIds: string[];
  decisionReference: string;
}
```

Any drift returns a stale result with stable reason codes and current facts. It
does not partially create a policy or activation. The operator must create a new
readiness preview and preparation.

The response identifies the preparation, approved rollout policy, exact cohort,
confirmation actors, timestamps and activation digest. It never contains signing
private keys, device credentials or compact grants.

## 8. Runtime mode resolution

Runtime mode resolution starts with the subscription's existing approved base
policy. For the authenticated device, the server then loads at most one current
activation whose:

- tenant, subscription, base policy and device identity all match;
- rollout policy is approved and hash-valid;
- rollout payload contains that exact device ID in `strict` mode;
- copied durations and task bounds equal the base policy;
- activation has not been cancelled or superseded.

If every check passes, the rollout policy supplies the grant policy revision and
`strict` mode. If the active binding is absent, revoked or invalid, the current
base policy applies and the next authenticated refresh returns `observe`.
Already signed task authority and recovery evidence keep their existing paths;
invalid activation data cannot retain or broaden device authority.

Configuration issuance records the activation ID as provenance. Device and task
grant issuance, local admission, evidence upload and recovery continue to use the
existing P1C protocol.

No client contract changes are required for P1D.2. Current capable clients already
understand authenticated `observe` and `strict` configurations.

## 9. Cancellation and rollback

An unconfirmed preparation may be cancelled by an authorized operator other than
or equal to the preparer. Cancellation is immutable and idempotent.

Cancelling an already confirmed activation is a separate rollback operation and
is not hidden inside preparation cancellation. P1D.2 records enough provenance
for P1D.3 to create an explicit approved observe rollback revision. Direct row
deletion, activation expiry or removal of a device ID is not rollback authority.

Emergency signing-key retirement remains independent and may deny new issuance;
it does not rewrite the approved rollout decision or erase historical grants.

## 10. Persistence

Add forward-only tables for:

- activation preparations and their immutable canonical snapshots;
- preparation members with composite tenant and concrete-device ownership plus a
  constrained prepared/released reservation state;
- active device assignments referencing base and rollout policies;
- idempotent prepare, confirm and cancel responses where the preparation row does
  not already own the request identity.

Constraints enforce state transitions, distinct prepare/confirm actors, finite
timestamps, request hashes, JSON object size, exact owner kind, policy references
and one current activation per device. Composite tenant foreign keys prevent a
member or activation from naming another tenant's device or subscription.

History is append-only except for the constrained preparation state transition.
Confirmed policies and activation facts are never updated in place.

## 11. SaaS Admin flow

The existing readiness preview drawer gains **Prepare pilot** after all rows are
eligible. The confirmation workspace displays:

- exact devices grouped by tenant and kind;
- base policy revision and copied durations and limits;
- preview time, preparation time and expiry countdown;
- preparing operator and decision reference;
- any freshly detected drift or block reason;
- an explicit statement that tariff, subscription and existing work are
  unchanged.

The preparing operator sees the confirm action disabled with the explanation
that a second operator is required. Another authorized operator must review the
exact cohort and enter a new request identity to confirm. Closing dirty forms
uses the existing drawer protection. An uncertain response retains request
identity and polls the preparation before allowing another mutation.

No customer-facing page gains an activation control. Tenant administrators may
continue to see effective rights and device status but cannot choose rollout mode.

## 12. Errors and recovery

Stable outcomes distinguish:

- invalid or missing preview;
- digest or device-set mismatch;
- blocked readiness with per-device reasons;
- stale policy, subscription, assignment, credential, configuration, report,
  grant or keyset;
- overlapping preparation or active assignment;
- preparation expired, cancelled, confirmed or superseded;
- same-operator confirmation denied;
- changed payload under a reused request ID;
- malformed persisted policy or activation facts.

An ambiguous network response is recovered by repeating the same request ID and
payload or reading the preparation. The UI never creates a fresh request identity
until it knows the previous operation did not commit.

Infrastructure failures propagate as retryable errors. Domain conflicts return
typed envelopes and do not become empty or successful results.

## 13. Audit and observability

Platform audit records exact actor, role, request ID, action, outcome, policy,
preparation, digest, device count, tenant count, reason aggregates and before/after
state. It excludes credentials, JWS values and unbounded payloads.

Metrics distinguish prepared, stale, expired, cancelled, confirmed, active and
configuration-delivered counts. A confirmed activation is not evidence that the
device received strict configuration, performed offline work or passed a physical
pilot.

The readiness inventory shows preparation and activation status without deriving
physical acceptance from reports or grants.

## 14. Migration and deployment

The database migration must complete before an API binary reads or writes P1D.2
activation tables. It is additive and does not backfill, activate or alter any
existing policy, catalog version, subscription or device.

Deployment order:

1. Back up PostgreSQL and record the restore point.
2. Apply the P1D.2 migration.
3. Deploy API and SaaS Admin with no activation rows.
4. Verify every current device still resolves to its previous configuration.
5. Prepare a non-production or explicitly approved pilot.
6. Obtain second-operator confirmation.
7. Verify configuration delivery and recovery before P1D.3 physical acceptance.

Code rollback preserves preparation, policy and activation history. A compatible
rollback must retain safe configuration history and must not delete activation
rows to force observation.

## 15. Verification

Contracts and persistence tests cover strict schemas, 200-device bounds,
duplicate IDs, actor separation, request replay, changed-input conflicts, state
constraints, composite tenant ownership and migration from the previous schema.

API tests cover:

- cross-tenant and non-platform denial;
- exact capability requirements;
- stale facts at every prepare/confirm boundary;
- concurrent confirmations and policy version allocation;
- overlapping cohorts and one-device ownership;
- atomic policy, activation, state and audit commit;
- unchanged catalog version, subscription and commercial snapshots;
- configuration resolution for selected and unselected devices;
- retained frozen-task and evidence recovery after strict activation.

SaaS Admin tests cover second-operator UX, expiry, stale recovery, uncertain
requests, exact request reuse, dirty-state protection and both locales.

Whole-workspace, API/DB, Station, Handheld, kiosk and production-bundle gates run
because mode resolution affects all native clients. Automated checks do not prove
Windows hardware, vendor scanners, printers, a deployed production cohort or
customer acceptance; those remain P1D.3 gates.

## 16. Completion criteria

P1D.2 is complete when:

1. an exact eligible preview can become a durable preparation without mutation;
2. the preparer cannot confirm their own preparation;
3. confirmation rechecks every authority fact and atomically creates one approved
   rollout policy plus exact device activations;
4. subscriptions, commercial terms and devices outside the cohort are unchanged;
5. selected capable devices receive strict only through authenticated
   configuration refresh;
6. stale, cancelled, ambiguous and concurrent operations are recoverable and
   fully audited;
7. all required automated gates pass, with physical and production acceptance
   reported separately.

## 17. Outside P1D.2

- selecting or approving real production durations and pilot devices;
- deploying the pilot to customer hardware;
- physical offline, reboot, printer, scanner and network-loss acceptance;
- automatic cohort expansion;
- broad strict rollout;
- explicit confirmed-activation rollback and staged cohort replacement;
- instant revocation of authority already held by an offline device;
- changes to tariffs, services, offers, invoices or public inventory API.
