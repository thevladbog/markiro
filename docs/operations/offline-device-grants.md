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
| `GET /station/grants/v1/keyset`         | Station or Handheld device key | Verifier keys, including during subscription restriction            |
| `POST /kiosk/grants/v1/configuration`   | Kiosk token                    | Current mode, owner, clock and keys during subscription restriction |
| `POST /kiosk/grants/v1/device`          | Kiosk token                    | Kiosk device capabilities                                           |
| `POST /kiosk/grants/v1/reservations`    | Kiosk token                    | Canonical order attestation and frozen reservation                  |
| `POST /kiosk/grants/v1/tasks`           | Kiosk token                    | Frozen reservation task                                             |
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

All four variables absent or blank leave normal API startup available:
`OFFLINE_GRANT_ORIGIN`, `OFFLINE_GRANT_KID`, `OFFLINE_GRANT_PRIVATE_KEY_PEM`,
`OFFLINE_GRANT_KEYSET_JSON`. Grant issuance then denies without disabling the API.
Any partial or inconsistent configuration fails startup validation. No private
key or production offline policy is seeded by this change.

The Yandex runtime inventory requires every key in `.env.production.example` to
exist in Lockbox. Before deploying this version, add all four entries to the
runtime secret; keep their values empty until signing is configured as a complete
set. Missing entries fail inventory validation even though empty values preserve
normal API startup.

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
