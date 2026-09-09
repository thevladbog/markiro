# National Catalog product import: operation and enablement

Implementation is delivered behind disabled provider import flags. Local fixtures and
integration tests do not authorize production enablement. The dated
[delivery evidence](../evidence/national-catalog-import/delivery-verification.md)
separates local proof, review status and outstanding live acceptance.

## Model and operator workflow

The cabinet has two entries: own catalog and GTIN lookup. A session retains up to
100,000 inputs, explicit selection across pages, completeness and progress. One
apply accepts at most 100 positions. Draft and published cards are eligible;
archived cards are hidden by default and cannot be imported in v1. Unknown status
is not archive. An explicitly archived linked source suppresses comparison and
`hasChanges`, preserving accepted baselines and evidence; comparison resumes when
it is no longer archived. `hasChanges: false` does not attest every field or photo.

An existing GTIN is a suggestion to link, never automatic consent. The saved link
pins tenant, environment, card identity, canonical GTIN and revision. Several GTINs
may belong to one card. Exact-card comparison reads the complete fresh accessible
GTIN session and selects only one uniquely matching selectable card; ambiguous,
incomplete, inaccessible and missing identities require recovery. Public `product`
lookup does not prove ownership or granted access and is not an import fallback.

Product creation or accepted changes, initial category, link, source snapshot and
exact audit evidence commit atomically for each position. Manual names remain
manual provenance. `externalRef` remains the independent 1C identity. A canonical
GTIN change on a linked product requires explicit removal of the pinned revision
in the same product transaction; a stale revision produces a conflict. Removing
only the local link retains product values, photo, source snapshots and history.

A source snapshot is immutable evidence. An observed projection records the latest
provider observation; the reviewed projection records accepted choices. Background
refresh does not overwrite accepted name, attributes, category, photo or reviewed
baseline. Confirmation/rejection baselines preserve the source name and meaningful
values. Public preview identity and field-dependency projection are additive;
the narrow legacy reader projects old rows without rewriting their bytes or hashes.

Photo application has an independent durable result. READY candidates serve the
same normalized cached WebP bytes used by application; selection pins a candidate,
not an arbitrary provider URL. Replacing an existing photo requires explicit choice.
A product can succeed while its photo fails; eligible retry resumes the photo from
accepted cached bytes without recreating the product. Merely ready, unviewed or
unaccepted bytes do not become a reviewed photo baseline. An accepted photo receipt
keeps its candidate/assets beyond temporary expiry while eligible recovery needs
them; unaccepted temporary data expires. GC uses a short locked claim and reference
recheck; it does not hold a DB lock while deleting an object.

## Cabinet and API boundaries

Cabinet routes are `/catalog/import`, saved `sessionId`, `preparationId` and
`operationId` query parameters, `/catalog/:productId/chz`, and existing product
edit routes. The production router writes normal routes. Browser fixture tests use
MemoryRouter and explicitly reopen `?route=` and reload; they do not prove real
address-bar history or production routing.

API paths below omit the deployment `/api` prefix:

| Path                                                   | Operation / access                                     |
| ------------------------------------------------------ | ------------------------------------------------------ |
| `/national-catalog/capabilities`                       | GET; current cabinet READ                              |
| `/national-catalog/import-sessions`                    | POST; start own/GTIN session, WRITE                    |
| `/national-catalog/import-sessions/:sessionId`         | GET; saved session, READ                               |
| `…/:sessionId/items`                                   | GET; cursor/search/status/archive page, READ           |
| `…/:sessionId/selection`                               | PUT; selected IDs with expected revision, WRITE        |
| `…/:sessionId/retries`                                 | POST; enumeration recovery, WRITE                      |
| `…/:sessionId/previews`                                | POST; immutable preparation request, WRITE             |
| `…/:sessionId/preparations/:preparationId`             | GET; preparation, READ                                 |
| `…/:sessionId/preparations/:preparationId/retries`     | POST; comparison recovery, WRITE                       |
| `…/:sessionId/previews/:previewId/images/:candidateId` | POST; alternative photo preparation, WRITE             |
| `…/:sessionId/images/:candidateId`                     | GET; authorized cached preview bytes, READ             |
| `…/:sessionId/applies`                                 | POST; accepted decisions and request ID, WRITE         |
| `…/:sessionId/applies/:operationId`                    | GET; durable result, READ even after session TTL       |
| `…/:sessionId/applies/:operationId/retries`            | POST; explicit failed-position recovery, WRITE         |
| `…/:sessionId/cancel`                                  | POST; stop future work, retain accepted results, WRITE |
| `/products/:id/national-catalog/link`                  | GET detail; DELETE with expected revision, WRITE       |
| `/products/:id/national-catalog/link/refresh`          | POST; request observation refresh, WRITE               |

Every business ID is tenant-scoped. Current membership, capabilities and subscription
are checked at the route and before background writes. Station/device tokens are
not cabinet actors. An old authenticated session does not preserve revoked WRITE.
READ access to existing receipts remains useful when import permission is absent.

Public session cancellation also stops accepted pending/running operations and finished
operations with remaining legitimate retries, even after temporary TTL or provider
configuration changes. It requires current WRITE/subscription access, uses the
subscription/session/operation/receipt lock order, and preserves committed outcomes,
immutable decisions/applied evidence and exact audit. Replaying cancellation does
not duplicate its audit. Pending photos become failed with a cancellation reason;
previous applied/unchanged photos and terminal nonretryable results remain intact.

Scheduled repair independently bounds expired session, item, preparation and
impossible receipt cleanup to 50 candidates per kind per pass (hard cap 500).
It removes transient input/provider/manual payloads, retaining small identity/FK/hash
stubs. Closed preparation requests become an empty object only behind closed-session
reader checks; checkpoints remain valid terminal records. Terminal core conflicts,
expiry-ended core work and cancellation clear impossible image eligibility. A
successfully applied product's eligible cached-photo retry retains its required
bytes and evidence after TTL. Cleanup does not delete accepted history or change
confirmed product values, and bounded batches may leave a short cleanup backlog.

Session/preparation responses expose server-derived `automaticWorkPending` for
focused-page polling through provider delays; legacy responses default false.
Terminal 401/403/404/410 polling stops. App-owned `labelKey` values are translated;
provider labels remain source text. Every mapped field requiring an initial
regulatory profile depends on the explicitly accepted category, including stable
print-name and shelf-life fields. Legacy saved previews are projected in memory
without rewriting stored source/diff/hash or accepted decisions.

Session and unconfirmed preparation lifetime is 24 hours. Accepted operations keep
immutable request/decision identity, per-item product/image results and applied
evidence. Same request replay returns the existing operation; different bytes for
an existing request ID conflict. Retrying does not silently accept a new comparison.
A specific stale-preview 409 marks the rejected rows and blocks apply until a new
preparation is accepted; legacy bare 409 never invents affected IDs.

The browser persists exact pending prepare/apply intent before POST and verifies
write/read equality. Unknown apply intent survives TTL or 403 for receipt recovery.
Expired prepare can be removed. Corrupt/unavailable storage blocks new mutations;
explicit abandonment explains that an earlier request may already have succeeded
and verifies removal. Identity observation outside the keyed auth-query boundary
clears old tenant/user intent even when storage cannot be read. Failed result rows
without product IDs show their display position and stable preview UUID, without
fetching expired previews or inventing a product name.

The local serialized-intent guard is 9,002,048 UTF-16 code units, enough for the
existing 9,001,024-byte import JSON transport limit plus its small local envelope.
It is not a storage quota guarantee or a bytes/characters equivalence. Actual
browser quota may be smaller; quota failures retain the same mandatory pre-POST
recovery path. Unrelated HTTP routes retain their existing 100 KiB body limit.

Confirming an older comparison advances its reviewed baseline without overwriting a
later provider observation or a newer failed attempt. Newly prepared previews use
a local fetch-completion timestamp; legacy rows retain their stored preparation
anchor. Confirmation is never displayed as a new provider request. Pending refresh
work is rebased to the new link revision with identity/step/run fencing; the same
logical step retains its actor, consumed attempts and provider delay. A changed
photo choice can start a new photo step only from the verified latest snapshot.
A checksum from another selector is not reused; an unavailable projection remains
unknown. Old in-flight completion cannot overwrite the new review.

## Jobs, limits and recovery

A session enumerates incrementally with durable windows, cursors and completeness.
`/v4/product-list` pages are at most 1,000, with 10,000 per time window; the adapter
splits 413 windows, preserves overlap and exposes unsplittable gaps. Feed batches
are at most 25 identifiers/GTINs. Do not claim complete own-feed discovery until
provider date-floor/timezone and catch-up behavior are verified live.

Coordination permits one external request per tenant across workers and four in a
process. Durable fencing, attempts and next-attempt timestamps survive worker
reconstruction. Lease/quota deferral does not consume an HTTP attempt. After the
first failure, three automatic retries use 60–900 seconds, respecting a larger
Retry-After. Authorization/configuration changes block visible work; fixing them
and explicitly retrying resumes eligible checkpoints. No transaction sleeps while
waiting on a provider. The 30-minute refresh schedule enqueues checks; it does not
promise that every product is checked within 30 minutes.

Dispatch repair scans durable enumeration, preparation, apply, image and refresh
work. Stable work IDs and receipt checks make repeated delivery safe. The additive
0122 dispatch-attempt table records fairness, not completion or HTTP attempts.
Completed dispatch history is retained and cascades on tenant deletion; storage
grows per logical work step and requires later retention planning. No extra history
GC or destructive receipt cleanup is part of this delivery.

Observe saved session/preparation/result reasons, per-item outcomes, link last
attempt/success, and exact tenant/actor/action/target/outcome audit events. A photo
refresh error retains the successful card status/time and reports
`photo_unavailable`. Do not expose provider errors, token values, headers or card
payloads in logs. A repair incident requires scoped IDs, sanitized reason codes,
queue/lease status and timestamp evidence; do not manually edit receipt hashes.

## Configuration and additive rollback

`NATIONAL_CATALOG_OWN_IMPORT_ENABLED`, `NATIONAL_CATALOG_GTIN_IMPORT_ENABLED` and
`NATIONAL_CATALOG_IMAGE_IMPORT_ENABLED` default to false.
`NATIONAL_CATALOG_IMAGE_ALLOWED_HOSTS` stays empty until live photo validation.
Capabilities use `ownCatalog`, `gtinLookup`, `photos`; unavailable reason keys use
`ownCatalog`, `gtinLookup`, `images`. Connection is missing/integration_missing,
blocked/integration_unavailable|provider_unconfigured|token_unavailable, or ready.
Never guess a tenant token, provider environment, base URL or CDN host.

Confirmed-link refresh requires the explicitly validated provider base URL,
environment, credential and business eligibility independently of the enumeration
flags. Disabling those flags alone does not stop existing-link refresh; clearing
the shared `NATIONAL_CATALOG_BASE_URL` stops provider refresh too. Cached accepted
photo completion and local unlink remain independent of provider flags/token,
subject to current authorization. Preserve this distinction when diagnosing disabled
features or planning rollback.

Rollback is additive: disable new provider import work, stop provider refresh when
needed by clearing its configured base URL, retain receipts/checkpoints/history,
and verify visible blocked/recoverable states. Already accepted local cached-photo
work may still complete. Do not reverse migrations by deleting links, sessions,
accepted image references, dispatch history or snapshots. Resume only after the
configuration/credential cause is understood and accepted work is reconciled.

## Live acceptance before limited enablement

Use an explicitly authorized test tenant/token and the existing protected
[live diagnostic procedure](national-catalog-live-validation.md). That diagnostic
has its own legacy public-card read checks; they never authorize an import public
fallback. The diagnostic alone does not exercise every import/photo/recovery path.
Record sanitized evidence and approval before changing runtime flags or hosts.

- [ ] Own list matches the cabinet across old/new drafts, published and archive,
      multiple pages, accepted lower date bound and timezone; no silent truncation;
      413 splitting, overlap, unsplittable gap and catch-up are visible.
- [ ] Owned and granted-access GTIN/card lookups distinguish not-found/no-access;
      several GTINs on one card retain exact identity; real statuses are understood;
      no public fallback can establish new import access.
- [ ] Actual photo hosts and each redirect are allowed explicitly; no bearer is
      sent to CDN; stored bytes/checksum equal preview; 5 MiB, 15 seconds, two redirects,
      JPEG/PNG/WebP normalization, animation rejection and failure states are proven.
- [ ] Expired token, environment mismatch, multiple-worker quota, 429/Retry-After
      and restored connection produce correct visible recovery.
- [ ] Real worker/process restart during enumeration, apply and photo processing,
      replay and cancellation preserve receipts without duplicates and expose partial
      results. The local two-PgBoss-instance test proves retry after a synthetic lost
      acknowledgement, not an OS crash or all deployment stages.
- [ ] Station/Kiosk physical offline restart/reconnect and supported Windows/media
      delivery are checked separately; host image-cache tests do not prove hardware.

Until these checks are recorded, rollout remains disabled and evidence is described
as local integration plus fixtures. This runbook does not authorize deployment,
provider writes, paid resources, external messages or production configuration edits.
