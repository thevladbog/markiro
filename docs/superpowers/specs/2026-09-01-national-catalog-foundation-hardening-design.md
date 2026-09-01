# National Catalog Foundation Hardening — Design Addendum

**Date:** 2026-09-01

**Status:** Approved

**Parent specification:**
`docs/superpowers/specs/2026-08-31-category-product-attributes-national-catalog-design.md`

**Scope:** Correct the already merged category-attribute foundation and National Catalog
read client before enabling read-only import. This addendum narrows delivery to two
coherent pull requests and defines the invariants that the first one must establish.

## Decision summary

The remaining work is delivered in two pull requests, not a chain of small production
fixes:

1. **Foundation hardening and live contract proof.** Correct the domain and persistence
   model, make regulatory proposals source-aware and provenance-safe, extend the
   read-only client with the provider capabilities required for import, and replace the
   brittle live diagnostic with a bounded diagnostic that distinguishes operational
   compatibility from provider contract deviations. Deploy this pull request through the
   protected production workflow and capture sanitized live evidence.
2. **Complete server-side read-only import.** Add schema discovery, validation and
   activation; classifier mapping reports; tenant GTIN lookup; immutable per-card
   snapshots; strict preview/apply; freshness jobs; platform contracts; production
   configuration inventory; and the final live proof.

Admin editing, Station projection, 1C regulatory mapping, and National Catalog write
operations remain later slices. They are not added to either pull request merely to make
the feature look end-to-end.

PR 1 does not expose a tenant import endpoint, schedule provider reads, or change product
values from National Catalog data. Its purpose is to make PR 2 safe to build and safe to
operate.

## Evidence requiring this addendum

The merged implementation and the production diagnostic revealed assumptions that are
unsafe to carry into import:

- production authentication and schema access work, but the real `/v3/categories`
  response did not include the documented `ETag` header;
- diagnostic version 2 stops at the first missing ETag and therefore never proves the
  remaining methods;
- one arbitrary tenant GTIN is required to resolve to exactly one private card and
  exactly one published card, although the two methods deliberately expose different
  card states and ownership scopes;
- proposal apply requires an existing regulatory profile, so the same workflow cannot
  create the initial category binding;
- proposal JSON is cast rather than validated as a closed discriminated union;
- apply hard-codes `manual` provenance and reuses `sourceRef` to store the accepted entry
  selection, overwriting the proposal's source reference;
- schema-version deduplication is global by content hash instead of scoped by category and
  selectors;
- conditional requirements do not identify the readiness layer they affect;
- immutable snapshots exist, but there is no mutable per-card freshness cursor for 304,
  provider ETag, content-hash fallback, or last-checked timestamps;
- the client lacks category selectors, `/v3/etagslist`, usage-limit metadata, and a
  bounded response-body contract.

These are foundation defects, not optional import features.

## External National Catalog contract

The integration remains read-only and targets the production National Catalog endpoint.
The client must support only the methods needed by the approved read path:

| Method             | Purpose                          | Required request support                                        | Result interpretation                           |
| ------------------ | -------------------------------- | --------------------------------------------------------------- | ----------------------------------------------- |
| `/v3/categories`   | classifier discovery             | `cat_id`, `gismt_code`, `tnved`, conditional request            | zero or more categories                         |
| `/v3/attributes`   | attribute-schema discovery       | `cat_id` or `tnved`, `is_set`, `attr_type`, conditional request | zero or more definitions                        |
| `/v3/feed-product` | tenant-owned/delegated card read | 1–25 identifiers, conditional request where supported           | zero or more cards in provider-supported states |
| `/v3/product`      | published/archived card read     | 1–25 identifiers, conditional request                           | zero or more public cards                       |
| `/v3/etagslist`    | cheap freshness for owned cards  | bounded page/filter options                                     | per-card identifiers and provider ETags         |

An empty card result is valid data, not a transport failure. A private card and a
published card are separate capabilities; neither implies the other for the same GTIN.

### Client result envelope

Every successful response exposes:

- a parsed method-specific value;
- an optional provider ETag;
- a deterministic SHA-256 content hash computed from the bounded response bytes;
- parsed `API-Usage-Limit` and `API-Method-Usage-Limit` headers when present,
  separated into total and method usage/limit pairs;
- raw response data only at the narrowest useful item boundary.

The result union retains explicit `not_modified`, `not_found`, `unauthorized`,
`forbidden`, `rate_limited`, `invalid_response`, and `unavailable` outcomes. It does not
throw provider payloads or authorization material into logs.

### Bounds and validation

- product batches remain limited to 25 identifiers;
- `/v3/product` scheduling additionally respects its documented per-series private
  limit;
- request timeout remains configuration-bound;
- response bytes are capped before JSON parsing with method-specific limits large enough
  for the documented endpoints and small enough to prevent unbounded memory use;
- URLs are HTTPS without userinfo and identifier/filter combinations are validated before
  the request;
- provider usage headers are optional data, never assumed present;
- ETag is an optimization and provider-conformance signal, not the only permitted
  freshness validator.

If a documented ETag is absent, the client records that fact and provides the content
hash. It must not fabricate an ETag or treat a hash as an HTTP validator.

## Diagnostic version 3

The live diagnostic answers two separate questions:

1. **Can Markiro safely operate the read-only integration with this token and provider
   behavior?**
2. **Does the provider response conform to the currently documented optional and caching
   behavior?**

The output is a closed, versioned, sanitized JSON schema. It contains no tenant IDs,
GTINs, card IDs, tokens, raw provider messages, database error strings, or decrypted
values.

The top-level fields are:

- `version: 3`;
- `passed`: operational compatibility result used by the host command exit code;
- `sourceStatus`: token/database/source acquisition state;
- `contractStatus`: `conformant` or `degraded`;
- `capabilities`: independently observed schema-read, owned-card-read, and
  published-card-read states;
- `checks`: closed method/outcome/count/cache-observation records;
- `violations`: closed symbolic contract-deviation codes.

### Execution behavior

The phases are independent where safe. A missing ETag, empty card result, or unavailable
card scope does not prevent later non-dependent checks.

- Categories and attributes prove schema-read capability.
- When an ETag is present, the diagnostic performs a conditional repeat and expects 304.
- When an ETag is absent, it performs one bounded repeat and compares content hashes.
  Equality proves repeat stability for the sample; it does not prove HTTP caching.
- Feed-product and product checks classify access and card visibility independently.
- A zero-card result remains a successful read capability if the provider returned a
  valid envelope.
- Authorization, invalid response, rate limiting without a safe completion, source
  acquisition failure, or transport failure makes the relevant capability unavailable.
- Documented-header absence or a conditional repeat that returns a valid unchanged 200
  produces `contractStatus: degraded`; it does not by itself fail `passed` when the
  bounded fallback proves a safe read.

`passed` is true only when schema reads are valid and the integration demonstrates at
least one safe card-read path or an explicitly classified valid empty result for the
token. The exact boolean rule is encoded in one pure evaluator and covered by table tests;
the CLI and host validator do not reimplement it.

The host-side validator accepts version 3 only after the matching API image is deployed.
There is no permissive `version: 2 | 3` production window. Image and host script are
promoted together by the protected deployment contract.

## Corrected domain schema

### Requirement rules

An attribute definition no longer combines unconditional layers with layerless
conditions. New definitions carry `formatVersion: 2` and contain explicit requirement
rules:

```ts
type RequirementLevel = "mandatory" | "recommended" | "optional";

type RequirementRule = {
  layer: "code_ordering" | "circulation";
  level: RequirementLevel;
  when: AttributeCondition | null;
};
```

This represents, for example, an attribute that is mandatory for circulation only when
the package is a keg. A condition must reference an attribute in the same schema and its
operator/value must be compatible with that trigger's value type. Duplicate equivalent
rules are rejected.

Only `mandatory` rules create `not_ready` readiness reasons. `recommended` rules are
reported separately for UI guidance. `optional` preserves provider metadata without
affecting readiness.

Existing format-v1 definitions are not rewritten because a stored schema version is
immutable evidence. A closed compatibility parser normalizes them in memory:

- every `requiredLayers` entry becomes an unconditional mandatory rule for that layer;
- every `requiredWhen` entry becomes a mandatory circulation rule, preserving the only
  layer where the current evaluator applies conditions;
- the compatibility form cannot be inserted or newly activated after PR 1.

This preserves current behavior while ensuring all newly discovered schemas use the
unambiguous format. A later reviewed v2 schema supersedes, rather than mutates, a v1
version.

### Value shape and units

The existing strict value discriminators remain. Numeric units are schema metadata, not
free-form guesses made during import. A schema can declare a reviewed unit or an explicit
set of allowed units. Unknown or conflicting provider unit semantics keep a schema in
`observed` state and block activation.

Provider types, multiplicity variants, or dependency expressions that the normalizer
cannot represent are retained in raw schema evidence but cannot be activated. In
particular, unique-multiplicity groups and dependent-rule combinations are not silently
flattened into ordinary lists.

Preset metadata distinguishes `none`, `suggested`, and `restricted`. Suggested values are
UI guidance and do not reject a custom value; only a reviewed restricted preset set is a
validation boundary. Legacy definitions cannot prove `attr_preset_only`, so non-empty
legacy presets normalize to `suggested` rather than becoming a new restriction.

## Persistence corrections in PR 1

All schema changes use a forward-only migration. Applied migrations are not rewritten.

### Schema versions

- replace global `content_hash` uniqueness with `(scope_key, content_hash)` uniqueness;
- preserve at most one active version per scope;
- validate stored definitions through the corrected strict domain schema before use;
- keep provider ETag nullable and content hash mandatory.

### Regulatory profiles and binding history

The current profile remains the fast tenant-scoped projection. A new append-only binding
history records every initial binding and category/schema transition with:

- tenant and product;
- prior and next category/schema identity;
- resulting profile revision;
- source and immutable source reference;
- actor and timestamp;
- proposal reference when applicable.

Existing profiles are backfilled with a migration history entry without changing their
visible revision or attribute values.

### Proposals

Proposal persistence gains:

- a closed proposal kind such as `category_binding`, `category_change`, or
  `national_catalog_import`;
- an expiry timestamp;
- terminal-state metadata;
- a separately stored applied selection and selection hash;
- timestamps and actors for apply/reject/stale transitions.

`sourceRef` always identifies the source observation. A National Catalog import uses the
canonical `national-catalog-snapshot:<snapshot UUID>` form and must match `snapshotId`
exactly. It is immutable and is never reused for accepted entry IDs or UI state.

Proposal `diff` is parsed by a strict, versioned discriminated union before it is shown or
applied. Unsupported fields, duplicate entry IDs, inconsistent current values, and
source/kind mismatches are rejected.

Existing proposals are handled without rewriting their immutable diff:

- the migration classifies them as `category_change`;
- a closed legacy parser accepts exactly the already persisted category-change shape,
  while every new proposal stores an explicit diff version;
- for applied manual proposals, the existing sorted UUID array in `sourceRef` is copied
  into the new applied-selection column and `sourceRef` is cleared because it was never a
  source identifier; the selection hash stays nullable for these legacy rows because the
  migration must not introduce a new database crypto-extension dependency;
- a legacy row whose selection cannot be parsed is retained for audit but cannot use the
  replay shortcut until explicitly reviewed;
- existing proposals receive a deterministic 24-hour expiry derived from `createdAt`;
  an already expired preview becomes stale when next read or applied.

### Card snapshots and freshness cursor

Snapshots remain immutable, tenant scoped, product scoped, and deduplicated by content
within the exact card and source method identity.
Each snapshot stores one card item rather than a whole multi-card response envelope and
records which read method observed it. A payload format version distinguishes new
per-card snapshots from any legacy whole-envelope rows. Existing rows whose method cannot
be proven are retained as `legacy_unknown`; new writes may use only `feed_product` or
`product`, and freshness scheduling ignores `legacy_unknown` until a new lookup replaces
it.

A separate mutable freshness row tracks the current observation for a tenant product and
provider card identity:

- last snapshot ID;
- source method (`feed-product` or `product`);
- provider ETag when present;
- content hash;
- last checked and last changed timestamps;
- last outcome needed for safe scheduling.

Its snapshot reference includes tenant, product, card ID, source method, and snapshot ID,
so a cursor cannot silently point at another card or read method belonging to the same
product.

A 304 or unchanged hash updates the freshness cursor, never the immutable snapshot. A
changed card creates or reuses the new immutable snapshot and advances the cursor in one
transaction.

## Proposal state machine and apply invariants

The lifecycle is:

`preview -> applied | rejected | stale`

Terminal states cannot transition again. Expired previews are treated as stale before
apply. Repeating an apply with the same proposal and selection returns the already
recorded result without writing duplicate values or audit rows. A different selection
after application conflicts.

### Initial binding

An initial category-binding proposal uses `baseRevision: 0`. Apply creates the regulatory
profile at revision 1 and appends its first binding-history row. It does not require a
manually pre-seeded profile.

### Existing binding or import

Apply locks the tenant product and current profile, then validates inside the transaction:

- product still belongs to the tenant and is not archived where the operation forbids it;
- proposal is a non-expired preview for the same tenant and product;
- current revision equals `baseRevision`;
- target schema is still active and compatible with the current coarse product group;
- every selected entry belongs to the stored diff;
- the stored `currentValue` still matches the current value being replaced;
- every target value parses against the target attribute definition;
- stable-field mappings are exact, reviewed, and version-compatible.

Any failed invariant writes no partial profile, value, EGAIS, history, or proposal state.
A revision mismatch or changed current value makes the proposal stale.

Values written by apply inherit the proposal source. National Catalog values use
`source: national_catalog` and retain the immutable snapshot reference. Manual category
changes remain manual. Apply never substitutes `manual` merely because a cabinet user
confirmed the operation.

### Reject and retrieve

Tenant routes can retrieve a proposal and explicitly reject a preview. Retrieval is
tenant/product scoped. Reject is idempotent only for an already rejected proposal;
applied or stale proposals conflict.

Audit events identify the exact tenant, actor, product, proposal kind, source, source
reference, prior/resulting revision, selected entry IDs or their stable hash, and result.
They do not contain raw provider cards or secret material.

## PR 1 testing contract

Implementation follows test-first changes at each boundary.

### Domain

- conditional mandatory/recommended rules affect only their declared readiness layer;
- incompatible condition/value types and unknown trigger IDs are rejected;
- unsupported provider multiplicity/dependency forms cannot become active definitions;
- exact value/unit validation is deterministic.

### Database

- the migration is forward-only and works with existing regulatory rows;
- `(scope_key, content_hash)` deduplication and one-active-version constraints hold;
- all mutable product/proposal/snapshot/freshness/history relationships are tenant safe;
- initial binding and history backfill preserve current product state;
- immutable provenance fields are not used as lifecycle scratch storage.

### API service

- initial binding succeeds from revision 0;
- cross-tenant reads and mutations are denied;
- stale revision, expired proposal, changed current value, inactive schema, incompatible
  group, malformed diff, duplicate entries, and selection outside the diff write nothing;
- source-aware apply preserves National Catalog snapshot provenance;
- identical replay is idempotent and a different replay conflicts;
- reject/retrieve and exact audit metadata are covered.

### National Catalog client

- every selector combination and its validation;
- 25-item batch bound and etagslist pagination bound;
- success with and without ETag/usage headers;
- 304, empty results, known HTTP failures, malformed envelopes, timeout, body overflow,
  and truncated/invalid JSON;
- per-card raw item retention without authorization headers or error leakage.

### Diagnostic and deployment contract

- table-driven operational/contract-status decisions;
- continuation after missing ETag and valid empty results;
- conditional 304 and content-hash fallback paths;
- output schema contains no forbidden identifiers or free-form provider errors;
- CLI exit code matches `passed`;
- host validator rejects unknown keys, unknown enums, version 2, and inconsistent exit
  codes;
- production bundle contract proves the image and host validator are promoted together.

## Rollout and recovery

1. Merge PR 1 only after package checks, database-backed tests, production bundle
   contracts, and sanitized diff review pass.
2. Deploy it through the protected production workflow. No ad-hoc code or migration is
   copied to the host.
3. Run diagnostic version 3 against the existing production token. Record the sanitized
   result and explicitly distinguish `passed` from `contractStatus`.
4. Do not enable import if schema reads or both card-read capabilities are operationally
   unsafe. A documented-header deviation may remain as a monitored provider issue when
   the bounded fallback passes.
5. Begin PR 2 only from the merged PR 1 contract and production evidence.

PR 1 is forward-only and non-destructive. It does not delete current profiles, values,
snapshots, or proposals. It replaces the overly broad schema-content uniqueness
constraint and adds/backfills lifecycle and history data, but it does not reinterpret
accepted product values. If application rollout must be reverted, the new objects and
nullable/backfilled columns remain database-compatible with the previous application.
New proposal shapes are not exposed to old code before the protected deployment has
completed.

## Explicit PR 1 non-goals

- no tenant National Catalog lookup or import route;
- no background schema or freshness job;
- no automatic schema activation or classifier mapping decisions;
- no production Lockbox key mutation;
- no admin form or diff UI;
- no Station or kiosk payload change;
- no CommerceML/1C regulatory merge;
- no National Catalog card create, edit, sign, publish, archive, or other write call.

## PR 1 acceptance criteria

PR 1 is complete when:

- all corrected domain and persistence invariants above are implemented and migrated;
- proposal apply supports initial binding, preserves source provenance, is atomic,
  tenant-safe, stale-safe, and selection-idempotent;
- the client supports the complete bounded read surface needed by PR 2;
- diagnostic version 3 no longer stops on a missing documented ETag or assumes one GTIN
  must be visible in both card methods;
- the host validator and production image accept exactly the same diagnostic schema;
- relevant domain, DB, API, client, diagnostic, deployment-contract, typecheck, lint,
  build, format, and diff checks pass, with infrastructure skips reported explicitly;
- protected production deployment succeeds and the sanitized diagnostic result is
  reviewed before PR 2 begins.

## PR 2 boundary

PR 2 consumes these contracts without reopening them. It implements schema discovery and
reviewed activation, full-classifier exact/ambiguous/unmapped reporting, tenant-scoped
lookup and proposal creation, immutable card snapshots, strict preview/apply through the
PR 1 state machine, and bounded per-tenant freshness jobs. Production configuration and
Lockbox inventory are changed only in that PR, with their own deployment approval and
live verification.
