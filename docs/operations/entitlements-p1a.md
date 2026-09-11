# Entitlements P1A: preparation and recovery

This guide covers the [approved P1A design](../superpowers/specs/2026-09-11-entitlements-p1-foundation-design.md).
The server and client implementation has passed its task reviews. Integrated checks and the
independent whole-change review have run; both findings were corrected and the scoped
re-review found no remaining or new issues.
The full-run timing evidence below remains explicit.
P1A adds a server projection of rights,
prepared sources and shadow observations. Production activation remains P1D; this guide does not
approve customer assignments, lifecycle policies, new production tariffs or deployment.

## Current access and prepared conditions

The commercial module `chzIntegration` includes both Chestny ZNAK and National Catalog. The other
new modules are `inventory`, `commerceMl` and `handheld`. Existing `labelEditor`, `publicApi` and
`pallets` keep their current meanings. Station and handheld consume the shared `stations` quota;
kiosks remain separate. The Start example offers CHZ/National Catalog as a paid add-on and is not
a published production tariff.

The V1 entitlement snapshot separates:

- `current`: actual subscription access, write permission, quota limits and usage, and the three
  existing feature flags;
- `candidate`: the P1 calculation, including the four new nullable module flags and prepared
  sources;
- `sources`: contributing plan/add-on conditions and prepared temporary/compatibility intervals;
- `connectivity`: a separately timed observation of stored CHZ/National Catalog connection
  readiness, which does not establish a commercial right or permission for an operation.

`null` for a new module means its mapping has not been established. It is neither an explicit
prohibition nor unrestricted access. `null` for a quota limit continues to mean unlimited, while
zero means no capacity. These meanings must not be interchanged. Current usage is measured at
`countedAt`; rights are calculated at `asOf`. There is no reconstruction of past usage from today's
rows: `historical.available` is false.

Prepared rights affect the candidate projection only. Existing security, subscription and quota
checks remain authoritative, including `SUBSCRIPTION_ENFORCEMENT_MODE=all`. A prepared feature
summary does not authorize every operation in that module: an NK-only compatibility source keeps
its explicit operation-version allowlist and does not grant a fresh CHZ export.

## Read and prepare sources

Cabinet members read their own safe snapshot through `GET /access/entitlements`. Restricted
subscriptions retain this read. Internal reasons, platform actors and decision references are
not included in that customer response.

Platform readers with `tenants.read` can use:

| Route                                            | Result                                        |
| ------------------------------------------------ | --------------------------------------------- |
| `GET /platform/tenants/:id/entitlements`         | `{snapshot, detailsVisible, sourceDetails}`   |
| `GET /platform/tenants/:id/entitlements/sources` | The same source list and snapshot shape       |
| `GET /platform/tenants/:id/entitlements/impact`  | A bounded current observation for this tenant |

Internal source details additionally require `billing.read`; support receives an empty
`sourceDetails` array and `detailsVisible: false`. Neither platform read changes customer rights.
The impact report identifies unmanaged tenants, missing mapping/policy, representation limits
and candidate operation decisions. Its scope is `tenant_current_observation`; it does not
inventory installed native binaries or prove a historical entitlement. `nativeP1Verified: false`
is an explicit limit, not an instruction to activate a client.

Preparing or revoking a source requires both `tenants.write` and `billing.write`. Access and
platform factor state are reloaded at the service boundary. The operator flow is:

1. Select an explicit temporary or compatibility intent, its allowed effects and operation
   versions, interval, reason and decision reference. Temporary sources require a finite end.
   Compatibility sources describe only new modules; they cannot add quotas or old features.
2. Send the intent with a new request UUID to `POST /platform/tenants/:id/entitlements/preview`.
   Review the server's before/after projection, exact scope and interval. Preparing a source
   requires an effective managed base subscription; no source extends that base.
3. Confirm the returned preview with its `previewId` and unchanged `requestId` using
   `POST /platform/tenants/:id/entitlements/confirm`. This records a prepared source and its audit
   fact. It does not activate P1 restrictions or change current admission.
4. To revoke, use the same preview/confirm flow with the explicit revoke intent. The original
   payload and version remain immutable. Revocation is allowed for a tenant-owned source after
   its base expires or is replaced; it does not renew that source or its old base.

Source intervals are instants with an exclusive end. They are not printed label dates or a
whole-day inclusive shelf-life rule. The technical preview TTL is at most five minutes and may
end earlier at a relevant subscription, source, add-on or invitation boundary. It is not a
commercial grace period or an offline work allowance.

## Stale previews and transport retries

Preview confirmation binds the canonical intent, actor, tenant, source/subscription identity,
terms revision, usage revision/fingerprint, registry/policy identity and time boundary. Terms
and occupied capacity changes can invalidate it even if the operator has not edited the form.

| Result                          | Recovery                                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `entitlement_preview_stale`     | Retain editable intent, request a new preview with a new request UUID, and review it before confirming. The old proof remains stored. |
| `entitlement_request_conflict`  | Reconcile the request identity and payload; do not overwrite the stored request or retry changed intent under its UUID.               |
| `entitlement_base_required`     | Inspect the current base subscription. A prepared source cannot replace or extend an absent/expired base.                             |
| Uncertain confirmation response | Retry the same preview and request UUID to retrieve the immutable result; do not create a second source.                              |

The platform form retains the same confirmation identifiers after a network, response-contract
or server failure leaves the outcome uncertain. It blocks local edits and ordinary navigation
until an exact retry resolves that outcome. A later 401, 403 or 429 does not prove that the first
attempt failed: access and session checks precede immutable result replay. Restore access or
wait for the request limit, then retry the same confirmation. Only a validated domain409
`entitlement_preview_stale`, checked after replay, permits a new preview and request UUID for
that unresolved intent. A successful confirmation followed by a failed snapshot refresh is
displayed separately from an unconfirmed mutation.

An exact completed confirmation returns its original `{previewId, requestId, sourceId,
confirmedAt, after}`, including after later revocation. It does not return today's recalculated
state as the prior result. Reload the current projection separately when it is needed.

## Shadow operation observations

The [adapter inventory](entitlements-p1a-adapters.md) identifies actual NK/CHZ callsites and their
existing owners. P1A observes new work at those boundaries. It does not turn a stored receipt or
a known provider task into permission for a fresh request.

The admission facade captures coherent committed facts before opening an owner's transaction.
After the owner checks its current resource, actor and attempt, the observation compares current
terms/usage revisions and referenced catalog/policy identities using that same DB connection.
It also checks the next time boundary and a five-second technical age bound. Stale or missing
facts yield `unknown`; the facade does not reuse an old allow/deny result or acquire a second
connection while holding the business transaction. These five seconds do not define a grace
period or offline allowance. They are independent of the source-preview TTL above.

Observation reads and writes use savepoints when there is an owner transaction. A shadow failure
does not leave that transaction aborted, and the existing action retains its own result/error.
Evidence records the fixed operation/version, tenant/actor, revisions, fact and observation times,
policy identity, candidate result, a scope hash and an attempt identity when present. It does not
store raw provider cards, URLs, tokens or credentials. Release/configuration observation is
separate; absent server readiness is unknown, not inferred from registry text or a usable token.

Fresh CHZ export creation reloads current creator access and the subscription write policy.
After owner lock and authorization waits, it also reads current INN, product group and GTIN
through the same transaction connection. Missing or unsupported context fails before spending
a create attempt. The checked context is used by the observation and provider create payload;
poll/download in that pass retains its group for the exact claimed attempt and task.
`CHZ_ACTION_ACCESS_DENIED` uses the existing failed/retry path and does not spend a create attempt
before any provider request. Restore the actual access condition before retrying. Known tasks in
the same pass retain their existing polling/import recovery path. A competing worker cannot fail
another worker's live final-budget claim merely because its attempt count reached the cap.

Run transitions and their journal writes compare the actual claim's attempt and timestamp. New
receipt ingestion also checks the precise CHZ run/task/result identity under the inventory and
run locks before inserting evidence or its audit. Already stored deterministic receipts retain
their replay behavior. A stale worker cannot replace the winning result or delete its evidence.
External storage stays outside the database transaction, with the existing uncertain-commit
reconciliation and cleanup procedure.

The provider adoption algorithm remains deliberately narrow. An ambiguous or unavailable match
can still lead to a separately checked fresh create within the existing attempt cap; local
fencing does not prove exactly-once creation at the provider. No new retry state, provider
cancellation operation or device recovery protocol is introduced by P1A.

## Commercial V3 and lifecycle policy

Updated selection and catalog clients explicitly send `X-Markiro-Commercial-Version: 3`.
Omission and `2` retain their exact old schemas. Duplicate and unsupported version headers fail
with `commercial_version_unsupported`. Old clients receive `client_update_required` for live
terms containing explicit new-module flags, effects or lifecycle policy references; the API
checks new ID-only selections within the owning transaction before committing a write.

V3 reads retain legacy null mapping. New plan drafts require all four explicit module values.
Draft preparation can proceed without an approved lifecycle policy, but V3 publication cannot.
Editor context offers only approved policy references with valid canonical payload digests,
identified by readable policy key and version. P1A supplies neither an approval endpoint nor an
approved production policy seed.

Publication review binds the exact catalog version, draft timestamp, seller policy revision and
lifecycle policy ID/version/hash. `commercial_review_stale` requires a fresh review. An old
client cannot publish new conditions it cannot represent. The server remains authoritative even
when a browser previously displayed a valid review.

Offers, invoices and workspace documents retain their existing saved schemas and bytes under
V3. New selections require version-aware writers. An already committed exact request replay
retains its result. A validated invoice continuation from an accepted immutable source offer
uses saved line conditions; attaching a `sourceRequestId` to caller-selected lines is not that
continuation. Existing payment, download, cancellation and paid-fulfillment behavior remains
separate from new selection checks.

## Migration order and recovery limits

Use the established protected deployment workflow if deployment is separately authorized:

1. Record the accepted source/artifact identities and back up the database with the existing
   operational procedure. Inventory affected platform and tenant clients.
2. Apply additive `0131_entitlements_p1a.sql` after `0130_cynical_warstar.sql`. It retains legacy
   nullable values and historical records, adds source/preview/policy/observation storage, and
   increments terms and usage revisions in the same transaction as their owning writes.
3. Deploy the compatible API before clients that request V3 or the V1 entitlement snapshot.
   Verify platform/cabinet isolation, read access for restricted subscriptions, contract
   negotiation and the existing P0 recovery checks.
4. Inspect read-only tenant impact and the explicit source/policy evidence. Customer assignment,
   production policy approval, client rollout and activation require the later agreed P1D
   procedure. A successful migration or a clean report does not perform those actions.

Source payloads, approved policies and preview proof are immutable; source revocation and preview
confirmation are one-way facts. Do not reset revision counters, rewrite applied migrations,
remove new effect keys, erase proof or hydrate historical documents from current catalog rows.
Once V3 terms exist, reverting to an older client/API cannot truthfully represent them. Retain
the compatible API and use a forward fix. Any database restore is a separate recovery decision
that must reconcile work accepted after the backup.

## Acceptance evidence

The numbered criteria below match the approved design. Tasks 1–6 and their corrections have
passed independent reviews. Task 7's evidence review and its corrections are approved. The
whole-change review found two defects in fresh CHZ context and uncertain confirmation retries;
both were corrected in one bundled fix wave and accepted by the scoped re-review.

| Criterion                                      | Evidence                                                                                                                                                                               |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Registry and compatible contracts           | Shared registry/V3 schema tests, API version negotiation and nested commercial fixtures; frozen V1/V2 schemas and historical documents                                                 |
| 2. Persistence, projection and source commands | Actual PostgreSQL schema/migration, coherent projection, source preview/confirm/revoke, tenant isolation and exact audit tests                                                         |
| 3. Shadow operation boundaries                 | Executable callsite inventory, real resolver/admission, usage/catalog/policy drift, query/insert failures with preserved owner commits, CHZ competing-worker and NK replay/image tests |
| 4. Platform and customer views                 | Server totals, source scope, current/prepared states, safe payloads, V3 drafts and RU/EN normal/narrow browser checks                                                                  |
| 5. Read-only readiness report                  | Tenant-scoped impact and authorization tests in the source service and platform HTTP suites; no customer assignment                                                                    |

The required sequential Turbo command stopped on the SaaS test suite after 30 successful tasks.
All 21 remaining package gates then ran sequentially. Every lint, typecheck and build gate passed.
The initial combined execution had three UI failures. After the scoped test improvements and
SaaS worker limit described below, its ordinary full test command passed 342/342; after the
final recovery correction and new regressions it passed 346/346. The customer
full-run failure remains unresolved; this is still not a green full workspace run.

| Test suite                                    | Full-run result                                                                  |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| API                                           | 3,603 passed; 26 conditional skips                                               |
| DB / platform contracts / shared UI           | 438 / 208 / 177 passed; no skips                                                 |
| Domain / email / legal documents              | 712 / 23 / 165 passed; no skips                                                  |
| SaaS admin                                    | Final 346 passed; earlier corrected 342 passed; initial 340 passed, 2 failed     |
| Customer admin                                | 1,183 passed, 1 failed: the unchanged 100-checkbox late-events selection timeout |
| Station / signer / kiosk / landing JavaScript | 1,423 / 40 / 617 / 232 passed                                                    |

Of the 26 API skips, 22 inventory tests were subsequently enabled against the same dedicated
migrated PostgreSQL and all passed. Four external checks remain unrun: a real National Catalog
provider test and three opt-in local-infrastructure smokes for private bytes, provisioning CLI,
and Mailpit/MinIO lifecycle. The isolated environment does not provide those services or provider
credentials. Mocked-provider tests and real-DB tests establish different evidence from those checks.

The initial SaaS failures and focused passes are preserved separately. Removing duplicate
combobox searches alone did not eliminate the annual-plan timeout in a full run. A measured
full-run profile found 1.486 seconds in 21 global queries; the test now scopes queries to the
open form and listbox, retaining all 16 clicks, typing and assertions. Annual/catalog then passed
in the full suite, while initial-render waits failed in reports and a navigation test.

A controlled full run with two actual Vitest workers passed 342/342 under the same timeouts,
with fresh isolated fixtures and no source change. SaaS therefore caps its jsdom test workers
at two. Its final ordinary test command passed 342/342 without CLI overrides in 54.41 seconds,
compared with 34–43 seconds for earlier default runs. This bounds concurrent test CPU demand;
it does not change production behavior or increase test timeouts. It supports the worker-pressure
diagnosis without claiming every historical timing failure has the same cause.

The reports path is unchanged from the base. The customer late-events test, its component and
configuration are also unchanged; its earlier isolated pass does not explain the full-run
100-selection timeout. That separate failure remains an acceptance limitation. No assertion or
timeout was weakened to obtain a pass.

The final fix wave added a 12-case real-DB regression matrix for CHZ context changes during
adoption, a preceding create request and a claim-row lock wait. The final full runner suite
passed 45 tests; covering job/admission/journal/export tests passed 41; the two selected actual
receipt-owner tests passed (30 unrelated cases were deselected). API lint, typecheck and build
passed. These affected checks supplement the earlier API full run; no second whole-workspace
run is claimed. Same-pass task groups are fenced by run/attempt/claim/task identity, including
a late losing create reply.

The two source UI/router files passed all 18 tests, including lost response followed by valid
401/403/429 and immutable success, stale preview after uncertainty with a new UUID, and failed
refresh after success. The final ordinary SaaS full suite passed 346/346, 35 files, zero skips,
in 76.75 seconds; SaaS lint, typecheck and build passed. The original failing runs remain part
of the evidence history.

Local browser checks cover both languages at 1440 and 390 pixels, source preparation, stale
preview recovery, revocation and navigation during an uncertain confirmation. The fixtures use
actual components with synthetic HTTP and authorization; they do not establish live backend or
provider behavior. The final eight-screen matrix had no horizontal overflow, offscreen buttons
or browser errors. The actual tenant Legal-tab navigation is covered by integration tests;
network-loss retry also has browser evidence, while response-contract/503 variants have component
tests. After the final correction, narrow EN403 and RU429 browser flows each retained one
preview and identical identifiers across all three confirmations, blocked edits/close/navigation
while uncertain, then allowed navigation after success. Both had no horizontal overflow or
browser errors/warnings; the new recovery messages were visually inspected.

The final production bundle contract suite passed 547 tests without skips after the shared UI
workspace dependency change. Temporary Caddy containers and loopback health checks are local
contract evidence, not production deployment evidence. Legal artifact bytes and production legal
attestation/verifier files remain unchanged. Final format and diff hygiene are recorded with
Task 7 of the [implementation plan](../superpowers/plans/2026-09-11-entitlements-p1a.md).

No production, native-device, Windows, scanner/printer or real provider result is established by
local DB and mocked-provider tests. P1B device allocation, P1C offline grants and P1D customer
rollout remain separate. The maximum duration for offline new work is still unapproved and is
not inferred from a tariff or this preview TTL.

Before PR publication, the branch integrated `main` at `00e1716ca`. Its existing
`0130_cynical_warstar` migration and metadata were retained; the unpublished P1A migration
became `0131_entitlements_p1a`, preserving the reviewed SQL bytes and regenerating its snapshot
against the combined schema. The full chain applied successfully to a new dedicated test
database. Post-merge checks passed 439 DB tests, 209 contract tests, 184 selected API tests,
43 selected customer UI tests and 82 selected SaaS tests. These supplement the earlier full
runs above; they do not replace or explain the retained customer full-suite timeout.
