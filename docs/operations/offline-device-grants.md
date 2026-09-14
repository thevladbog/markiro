# Offline device grants v1

The negotiated native API issues signed, finite authority for devices and already
frozen tasks. Existing Station, Handheld and kiosk responses are unchanged. The
default mode is `observe`. Strict mode requires an explicit device-scoped rollout
in an approved policy; no production cohort, activation or offline durations are
provided by this change.

## Native routes

| Method and route                        | Authentication                 | Purpose                                                             |
| --------------------------------------- | ------------------------------ | ------------------------------------------------------------------- |
| `POST /station/grants/v1/configuration` | Station or Handheld device key | Current mode, owner, clock and keys during subscription restriction |
| `POST /station/grants/v1/device`        | Station or Handheld device key | Device capabilities                                                 |
| `POST /station/grants/v1/tasks`         | Station or Handheld device key | Frozen shift or inventory task                                      |
| `POST /station/grants/v1/readiness`     | Station or Handheld device key | Durable client readiness report                                     |
| `GET /station/grants/v1/keyset`         | Station or Handheld device key | Verifier keys, including during subscription restriction            |
| `POST /kiosk/grants/v1/configuration`   | Kiosk token                    | Current mode, owner, clock and keys during subscription restriction |
| `POST /kiosk/grants/v1/device`          | Kiosk token                    | Kiosk device capabilities                                           |
| `POST /kiosk/grants/v1/reservations`    | Kiosk token                    | Canonical order attestation and frozen reservation                  |
| `POST /kiosk/grants/v1/tasks`           | Kiosk token                    | Frozen reservation task                                             |
| `POST /kiosk/grants/v1/readiness`       | Kiosk token                    | Durable client readiness report                                     |
| `GET /kiosk/grants/v1/keyset`           | Kiosk token                    | Verifier keys, including during subscription restriction            |

Cabinet sessions and public API keys cannot authorize these routes. Device bodies
contain only `{protocol:"offline-grants-v1", capability:"offline-grants-v1",
requestId:<UUID>}`. Task bodies additionally contain `taskKind` and `taskId`.
Unknown fields, client-selected origins, owners, capabilities and bounds are
rejected. Subscription restriction prohibits new issuance. Missing approved
policy or absent signing configuration produces the typed grant-only denial
`{status:"denied",reason:"policy_not_configured"}`.

An issued result contains `envelope: {protocol, serverTime, owner, mode, grants,
taskSnapshots}`. `owner` includes tenant, device, kind and current credential
epoch. `grants` contains original compact JWS strings. Device grants have an empty
`taskSnapshots`; each task binding contains `{taskKind,taskId,snapshotDigest,
canonical}`. SHA-256 of the original UTF-8 `canonical` bytes equals the signed
snapshot digest. The canonical object is `{taskKind,taskId,scope}`, loaded from
immutable server provenance. Clients hash the received bytes, verify the signed
claim and compare the semantic execution scope against their actual durable task
snapshot and authenticated bundle provenance before installation or execution.
Matching task IDs or storing a server-provided digest alone is insufficient. A
cache lacking required execution fields needs an authenticated refresh.
Shift scope includes the tenant-scoped `counterpartyName` used in printed labels;
renaming that reference changes the frozen digest while earlier sources remain immutable.
The explicit `allowPreviouslyAcceptedCodes` flag is also part of shift scope. A
grant issued without that permission cannot authorize reprocessing after the live
shift policy changes; clients must bind the newly issued scope before new work.
Capacities use the raw shift values consumed by native clients; null does not
introduce a product-default fallback.

## Approved rollout and recovery configuration

Platform operators manage offline grant policy versions in SaaS Admin under
**Catalog → Offline policies**. Creating a version stores a draft with a verified
payload hash. Approval is a separate `catalog.write` action that requires a
decision reference and records the exact actor, policy identity and hash in the
platform audit log. An approved version is immutable; changed durations, bounds
or rollout require a new version. The matching platform API is:

| Method and route                                        | Capability      | Purpose                       |
| ------------------------------------------------------- | --------------- | ----------------------------- |
| `GET /platform/catalog/lifecycle-policies`              | `catalog.read`  | List offline grant policies   |
| `POST /platform/catalog/lifecycle-policies`             | `catalog.write` | Create a validated draft      |
| `POST /platform/catalog/lifecycle-policies/:id/approve` | `catalog.write` | Approve the immutable version |

The SaaS Admin form deliberately does not select a strict cohort. It accepts
finite offline and completion windows plus explicit task-bound JSON, and creates
an observe-ready policy without `rollout`. Attach only an approved policy to a
new catalog version. Existing published catalog versions are immutable; assigning
the new policy requires the normal new-version review and publication flow.

The existing approved lifecycle policy may include optional `offlineGrant.rollout`:
`{protocol:"offline-grants-v1",mode:"observe"|"strict",deviceIds:[<UUID>],decisionReference:<approved decision>}`.
The existing policy approval and payload hash cover this exact choice. Omission
keeps observation. Strict requires an exact listed authenticated device and configured
signing keys; a client-supplied mode is never authority. Commercial catalog items,
services, subscriptions, offers and invoices gain no new policy prerequisite.

The negotiated `configuration` POST takes the same three negotiation fields as
`device`. It returns `{protocol,owner,serverTime,mode,policyRevision,keyset}`;
`policyRevision` and `keyset` can be null. Current device authentication is always
required. This recovery request remains available when new grants are denied,
including after expiry. Clients install configuration independently of productive
issuance, persist retired-key tombstones, and prevent a late envelope from
replacing a newer configuration. Clock installation accounts conservatively for
elapsed time since the request began; network delay cannot extend signed deadlines.

Mode transitions are retained in `device_grant_configurations` under the device
row lock. A missing or invalid policy cannot silently undo a previously delivered
strict mode. An approved replacement policy selecting observation is the rollback
authority. Credential recovery preserves this mode history. Fresh unconfigured
clients remain in observation; they acquire no signed authority from absent data.
The transition records do not enable a production cohort on their own.

## Rollout readiness and pilot preview

P1D.1 adds a readiness inventory under **Catalog → Offline policies → Pilot
readiness**. It remains an observation tool. It neither changes a policy nor
enables strict admission. The platform routes are:

| Method and route                                  | Capabilities                                    | Purpose                         |
| ------------------------------------------------- | ----------------------------------------------- | ------------------------------- |
| `GET /platform/offline-grants/readiness`          | `tenants.read`, `catalog.read`                  | Filter current readiness        |
| `POST /platform/offline-grants/readiness/preview` | `tenants.read`, `catalog.read`, `catalog.write` | Snapshot a proposed pilot group |

Station, Handheld and kiosk create a readiness report only after configuration,
keyset and a verified server-issued device grant have been written to their
durable store and read back. The report is append-only and scoped to the current
device credential epoch. `accepted: true` confirms that the server retained the
report; it does not mean the device is eligible. The server derives eligibility
again from current subscription, policy, assignment, credential, keyset,
configuration, issuance and authentication facts.

A current report is at most 24 hours old according to server time. Missing,
older or contradictory facts block the row and produce stable reason codes.
Client build and storage revision are diagnostics. Accepted offline evidence is
shown separately because it records protocol use but is neither required for a
new client nor proof of physical acceptance.

Preview accepts up to 200 unique device IDs and returns an eligible or blocked
result for every ID, a single `asOf`, the exact rows, reason aggregates and a digest. A new successful preview gets a
new request ID, time and digest; retry after an uncertain HTTP outcome reuses the
unchanged request. The digest is input for the future P1D.2 prepare/confirm flow.
P1D.1 has no confirm, activation or cohort-policy mutation route.

### Deployment order for P1D.1

1. Back up the production PostgreSQL database and record the restore point.
2. Apply migration `0149_offline_grant_readiness` before starting any API binary
   that accepts readiness reports or reads the platform readiness inventory.
3. Deploy the API while every device remains in `observe`.
4. Deploy Station, Handheld and kiosk client versions with durable readiness
   reporting.
5. Wait for reports no older than 24 hours and resolve every blocking reason.
6. Create and review a pilot preview in SaaS Admin.
7. Stop before activation and pass the preview digest and exact cohort to P1D.2.

Rollback deploys a compatible API and client set that preserves observation.
Keep migration 0149, readiness history, verified grant stores and native outboxes.
Do not delete local stores to manufacture a clean status. If a client is rolled
back, its earlier report naturally becomes stale after 24 hours and cannot make
the device eligible for a new strict preview.

## Retry and authority boundaries

Issuance identity is authenticated tenant/device/kind/credential epoch, operation
(`device` or `task`) and caller `requestId`. Task input and policy provenance do
not create new idempotency namespaces. An unchanged request replays the original
saved compact bytes and original frozen binding after current authentication and
entitlement checks. A different task identity with the same request ID returns
`409 GRANT_REQUEST_CONFLICT`. Policy updates cannot silently renew a saved grant;
a new request ID requests new issuance. Retired signing keys prohibit replay.
Fresh envelope `serverTime` is transport context, not a replacement signed time.

The reservation endpoint additionally accepts `order`, using the existing
canonical admission DTO, validation and nonce rules. It returns
`{status:"reserved",protocol,admission:{claimedAt,admissionProof},
task:{taskKind:"pickup",taskId,snapshotDigest}}`. Reservation idempotency remains
owned by the existing kiosk `deviceSeq` and admission nonce. The outer
`requestId` correlates audit events; it is not a durable reservation idempotency
key and does not provide an independent changed-input conflict guarantee.
Task-grant issuance subsequently resolves the saved reservation identity; its
caller supplies no authority-bearing order counts or scope.

Reservation attestation binds canonical device/order authority. It does not
replace operator or pickup authorization, the opaque admission proof, or existing
productive-owner validation. New work, completion and reconciliation must enforce
those independent checks. Signed scope includes badge/body identity binding to
prevent transfer to a different order.

Issuance locks the established quota, timeline, subscription/device,
credential/policy/revision and task owners in order. It requires consistent
working-device assignment, effective retention membership, resolved capacity,
current kiosk lifecycle/quota and applicable Handheld/inventory/pallet features.
A reached retention choice is ongoing membership authority, not an equality check
against mutable preview work counters. An intervening capacity restoration retires
an old choice; a later reduction needs its own selection. Ambiguous historical
terms cannot revive a choice. Prepared replacement denies new authority. A deleted Station key is rechecked
even before its separate durable revoke transaction updates the epoch. Issuance
and its exact actor/revision audit commit atomically. Epoch changes invalidate
current native authentication; immutable old grants and source history remain.
Completion grants carry explicit event and dimension maxima from an approved
versioned policy. Zero is exhausted. Missing finite bounds deny issuance.

## Offline evidence and reconciliation

The negotiated uploads keep the original native payload in `payload`:

| Route                                                            | Native operation                                     |
| ---------------------------------------------------------------- | ---------------------------------------------------- |
| `POST /station/grants/v1/evidence/scans`                         | Shift scans, boxes, pallets and product label events |
| `POST /station/grants/v1/evidence/shift-closures`                | Shift closure                                        |
| `POST /station/grants/v1/evidence/inventories/:id/event-batches` | Inventory scan and repacking events                  |
| `POST /station/grants/v1/evidence/inventories/:id/leave`         | Inventory participant completion                     |
| `POST /kiosk/grants/v1/evidence/orders`                          | Pickup completion                                    |

The validated envelope is `{protocol,batchId,payloadDigest,grants,eventGrants,payload}`.
`payloadDigest` is the shared canonical `productLabelValueDigest(payload)`, not a
hash of arbitrary JSON property order. `grants` holds the original compact JWS;
`eventGrants` maps a native JSON pointer plus event type to its grant ID, for
example `/events/0#inventory.scan.v1`. A repack item that also closes its box has
two links and consumes both effects atomically. Recovery-only records need no
productive grant link. A saved label’s later print attempts are recovery: the
initial accepted scan and initial label preparation each consume their own bound,
while reprinting the saved job consumes neither again.

Current device authentication is required even for historical evidence. The first
transaction retains an immutable receipt before executing the existing native
owner. Receipt finalization, actual accepted effects and finite counter increments
commit in the native business transaction. A strict denial rolls that transaction
back and retains the disputed receipt as quarantined. Observation records the
diagnostic while preserving existing native authorization and reconciliation. A
new client uses this transport after authenticated protocol negotiation; a missing
grant is represented by empty grant links. Already accepted legacy queues keep
their native recovery path.
Counters identify the device and frozen task, independently of credential epoch,
grant renewal, policy revision and upload batch identity.

A response contains `{protocol,batchId,outcome,reason,receiptId,reconciliation}`.
`outcome` is `accepted`, `duplicate` or `quarantined`; `reconciliation` has
`status`, `statusCode` and the original native `result`. An accepted receipt does
not itself acknowledge successful production. Clients acknowledge using the
native result only when reconciliation is `applied`; rejected or quarantined
work remains visible. An exact retry returns `duplicate` with the original reason,
receipt ID and native result. Changed input under the same identity conflicts.

Client timestamps cannot establish completion before a signed deadline. An
existing exact effect or the original timely authenticated server receipt supplies
that evidence. A pending request interrupted before commit can resume with its
original authenticated body; it is not automatically reconstructed in a background
job. Saved manufacturing strings, including group separators, remain unchanged.
The retained copy replaces `badgeCode` and `admissionProof` with hashes; raw
transport bytes have a separate digest. Authentication secrets are not stored in
new receipts. Historical grants and receipts remain after credential recovery,
while current authentication and tenant isolation still apply.

## Signing configuration and deployment

Migrate PostgreSQL through **0148 before starting any new API binary**: ordinary
Station/kiosk queries also select the new credential epoch columns. The native
operation registry revision changes fingerprints and invalidates old previews.
Unconfirmed entitlement-source previews must be prepared again after the update;
confirmed receipts still replay their original result under current authorization.
Existing customers and old native DTOs retain their current flows.

Migration **0149 must complete before deploying any binary that accepts client
readiness reports or reads rollout readiness**. An older client remains compatible
and continues productive observation, but it is classified with
`client_report_missing` until upgraded and cannot enter a strict preview.

All four variables absent or blank leave normal API startup available:
`OFFLINE_GRANT_ORIGIN`, `OFFLINE_GRANT_KID`, `OFFLINE_GRANT_PRIVATE_KEY_PEM`,
`OFFLINE_GRANT_KEYSET_JSON`. Grant issuance then denies without disabling the API.
Any partial or inconsistent configuration fails startup validation. No private
key or production offline policy is seeded by this change.

The Yandex runtime inventory treats these four keys as one optional group because
Lockbox does not retain entries with empty values. Keep all four absent while
signing is disabled. Enabling signing requires all four non-empty entries in the
same Lockbox version; a partial group fails inventory validation before the
runtime environment is replaced.

`OFFLINE_GRANT_ORIGIN` is the server-configured canonical HTTP(S) origin, never a
body override. The private key must be EC P-256 and match the active `kid` and
public JWK `x`/`y` in the configured keyset. The keyset format is
`{protocol:"offline-grants-v1",origin,revision,keys:[{kid,jwk}],retiredKids:[]}`.
Only public JWK material is served. Signing uses ES256 over original protected
header/payload bytes with a 64-byte IEEE P1363 signature.

Distribute a keyset containing the next public key before switching the signer.
Retain earlier public keys so queued historical evidence remains verifiable.
Explicit `retiredKids` is a security decision, separate from routine rotation;
clients must persist retirement and keyset provenance according to their grant
store protocol. Never distribute the private key to a client or source repository.

Public OpenAPI is generated at runtime from controller decorators. The negotiated-route
Swagger contract, route-policy inventory and global documentation coverage are
tested; there is no checked-in OpenAPI JSON generation artifact.

Rollback preserves grants, task snapshots, counters, configuration history, evidence
and native queues. Do not install an older writer against unsupported new SQLite,
Room or IndexedDB versions. Disable strict admission through an approved observe
configuration and refresh devices; do not delete grant stores to reset admission.
Explicit retired keys remain retired across renewal and rollback. Production policy
values, the approved device cohort and physical acceptance belong to P1D.
