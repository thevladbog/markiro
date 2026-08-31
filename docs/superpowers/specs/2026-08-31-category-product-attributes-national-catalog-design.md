# Category-Specific Product Attributes and National Catalog Import — Design Spec

**Date:** 2026-08-31

**Status:** Approved in brainstorming; pending final spec review

**Scope:** Replace the current flat product details model with centrally managed,
versioned category schemas; add read-only import and freshness checks against the
National Catalog of Chestny ZNAK; and expose separate operational, code-ordering,
circulation, and EGAIS readiness without making Station depend on an external service.

## Decision summary

Markiro will use a hybrid model:

- stable production fields remain typed and directly queryable;
- regulatory/category-specific fields follow centrally managed, versioned schemas;
- each accepted value retains field-level provenance;
- raw National Catalog responses are retained as immutable tenant-scoped snapshots;
- National Catalog, 1C, and manual changes enter the same preview/diff/confirmation flow;
- Station receives only a compact operational projection and never calls the National
  Catalog directly;
- schemas are researched for the whole classifier, while the first implementation covers
  beer, non-alcoholic beer, dairy, packaged water, juices, and soft drinks;
- National Catalog integration is read-only in v1. Creating, editing, signing, or
  publishing cards is out of scope.

This design supersedes the assumption that every product category can be represented by
the same flat set of fields. It does not supersede the global Chestny ZNAK product-group
dictionary described in `2026-08-29-chz-product-groups-design.md`; it builds a finer
category binding beneath that dictionary.

## Why the current model is insufficient

The product row currently contains global scalar fields including
`chzProductGroupCode`, `egaisCode`, and `shelfLifeDays`. The admin form renders EGAIS and
shelf-life inputs for every product, regardless of category. Product `status` is derived
from the product group and box/pallet capacities, so it cannot explain whether a product
is ready for code ordering, circulation, or EGAIS.

This loses several material distinctions:

- beer requires a 19-digit EGAIS alcohol-product code and the National Catalog model
  permits multiple values, while `products.egais_code` is one unvalidated string;
- keg packaging activates an additional period-after-opening requirement;
- dairy has variable-weight and veterinary-control branches;
- packaged water may require underground-water and licence information depending on
  OKPD2;
- sweetener use activates additional fields for soft drinks;
- the dairy flag "shelf life no more than 40 days" is not the same datum as an arbitrary
  integer `shelfLifeDays`;
- the National Catalog distinguishes data required for ordering marking codes from data
  required for circulation.

The existing 1C CommerceML integration also does not provide a safe master-data merge:
Markiro remains the catalog master, while current import behavior updates price and
creates candidates. Category-specific imports therefore need explicit provenance and
conflict rules rather than an implicit new overwrite path.

## Source model and currency

The design is based on the official National Catalog sources current during research on
2026-08-31:

- [National Catalog API](https://docs.crpt.ru/gismt/API_%D0%9D%D0%9A/) — category,
  attribute, and product-card methods, authentication, ETag, and request limits;
- [official card attribute-model index](https://docs.crpt.ru/gismt/%D0%A0%D0%B0%D0%B7%D0%B4%D0%B5%D0%BB_%D0%BF%D0%BE_%D0%B0%D1%82%D1%80%D0%B8%D0%B1%D1%83%D1%82%D0%B8%D0%B2%D0%BD%D0%BE%D0%BC%D1%83_%D1%81%D0%BE%D1%81%D1%82%D0%B0%D0%B2%D1%83_%D0%BA%D0%B0%D1%80%D1%82%D0%BE%D1%87%D0%B5%D0%BA/)
  — downloadable attribute models and companion rules;
- [National Catalog overview](https://markirovka.ru/knowledge/fast_start/start/nk-natsionalnyy-katalog-zachem-opisyvat-tovary-kak-sozdat-kartochku-tovara-i-chto-s-ney-delat);
- [packaged-water licence rule](https://markirovka.ru/knowledge/tovarnye-gruppy/upakovannaya-voda/obyazatelnost-litsenzii-na-polzovanie-nedrami-pri-vvode-v-oborot-voda);
- [beer keg circulation rule](https://markirovka.ru/knowledge/tovarnye-gruppy/pivo-pivniye-napitki/kak-peredat-v-sistemu-informatsiyu-ob-ispolzovanii-kega-dlya-razliva-pivo).

These sources are not copied into application code as a timeless static truth. Markiro
stores fetched schema versions because the official models, presets, conditions, and
category coverage change independently of an application release.

## Classifier coverage

The seeded Markiro dictionary contains roughly fifty Chestny ZNAK product groups. The
official attribute-model index groups cards differently and currently exposes fewer
detailed model families. No permanent `one product group = one form` assumption is
allowed.

The full classifier deliverable is a versioned mapping matrix:

| Chestny ZNAK group | National Catalog category | TN VED / OKPD2 discriminator | Schema version | Mapping state                 |
| ------------------ | ------------------------- | ---------------------------- | -------------- | ----------------------------- |
| one group          | one or more categories    | zero or more refinements     | pinned version | exact, ambiguous, or unmapped |

The matrix is built from `/v3/categories` and `/v3/attributes`, then reviewed for
ambiguous or unmapped cases. The application must not guess a fine category from the
coarse product-group code. When a National Catalog card is available, Markiro proposes
its category and TN VED data from the GTIN lookup; a user confirms the binding. When no
card is available, the user selects the fine category manually.

A confirmed fine category must be compatible with the product's coarse Chestny ZNAK
group. An exact matrix match can proceed to confirmation; an ambiguous match requires an
explicit choice; an incompatible match produces a conflict and requires the coarse group
or selected card/category to be corrected first.

## Pilot field matrix

The following matrix is the first implementation scope. Names are normalized for the
Markiro UI; the stored schema retains the official attribute identifiers and definitions.

### Common pattern

Across the pilot categories, the recurring card data includes full product name, brand,
packaging type/material, product type, TN VED, composition, and a category-specific
quantity such as volume or weight. These are still separate schema attributes: matching
labels do not justify automatic merging when identifiers, units, multiplicity, or meaning
differ.

### Beer and low-alcohol beverages

Required core attributes include:

- full name, brand, product type;
- package characteristic, package type, and package material;
- consumer-package volume;
- alcohol volume fraction;
- filtration and pasteurization flags;
- composition and shelf life in days;
- TN VED;
- one or more 19-digit EGAIS alcohol-product codes (code AP).

When the package characteristic is a keg or another applicable specialist package, the
maximum sale period after opening becomes required. EGAIS therefore becomes a distinct
readiness dimension for this category.

### Non-alcoholic beer

Required core attributes include the common identity and packaging fields, consumer
volume, alcohol volume fraction, filtration, pasteurization, composition, and TN VED.
The researched model does not make EGAIS or shelf life part of the same required set as
alcoholic beer. Markiro must not show them as universally required merely because both
categories contain the word "beer".

### Dairy

Required core attributes include:

- full name, brand, packaging type/material, and product type;
- fixed- or variable-quantity flag and volume/weight;
- origin of raw materials and fat content;
- baby-food and specialized-food flags;
- composition;
- shelf-life-at-most-40-days flag;
- TN VED group and ten-digit TN VED;
- veterinary-control flag.

Variable quantity activates minimum/maximum weight requirements and changes how net
quantity is represented. Veterinary control activates VetIS classification data and
related product descriptors. `shelfLifeDays` remains an operational value unless an
explicit, reviewed rule safely derives the dairy boolean.

### Packaged water

Required core attributes include:

- full name, brand, product and packaging type/material;
- trade-unit volume;
- carbonation method and mineralization;
- baby-food flag and composition;
- expiry duration;
- TN VED and OKPD2.

OKPD2 controls additional circulation requirements. Depending on the product, Markiro
must ask whether it is extracted from underground water and request licence details or
other permit information only when applicable. An explicit "not extracted from
underground water" value can close that branch where official rules permit it.

### Juices, soft drinks, and related beverages

The model family generally requires:

- full name, brand, product and packaging type/material;
- package characteristic and product volume or weight;
- tonic, carbon-dioxide, baby-food, and specialized-food flags;
- sweetener flag, carbohydrate amount, composition;
- taste, or fruit/vegetable identity for juice subcategories;
- TN VED group and ten-digit TN VED;
- excisable-product code where defined by the category model.

Selecting "contains sweetener" activates one or more sweetener-name values. Keg packaging
activates the period-after-opening rule. Juice categories use their own quantity and
fruit/vegetable semantics rather than inheriting the soft-drink fields by label alone.

## Considered architectures

### A. Hybrid typed projection plus versioned attribute registry — chosen

Stable operational fields stay typed. Category schemas and category-specific values are
versioned and extensible. Raw external cards are retained separately, and explicit
mappings produce the operational projection.

This provides queryability and offline stability without forcing every evolving National
Catalog attribute into a Postgres migration.

### B. Full EAV

Every field and value would be represented as rows. It maximizes runtime flexibility but
makes validation, joins, forms, indexing, typing, and migrations unnecessarily complex
for stable production data.

### C. One JSON document per product

This is quick to introduce but weakens typed validation, field-level provenance,
conflict handling, audit, analytics, and controlled schema migration.

## Data model

Names below are semantic; the implementation plan may refine exact SQL names while
preserving these boundaries.

### Stable product and operational data

`products` continues to hold product identity and stable Markiro fields such as GTIN,
name, product-group code, packaging capacities, price, defaults, and archival state.

Operational fields that require stronger structure become typed data, not opaque schema
JSON. In particular, EGAIS AP codes require a product-scoped collection with:

- a validated 19-digit value;
- at most one primary code per product;
- field-level source and timestamps;
- tenant-scoped product ownership.

The old scalar API remains a compatibility projection during the Station/offline queue
horizon. `shelfLifeDays` is retained until every consumer is migrated; category mappings
may consume it only through an exact unit-and-meaning conversion.

### Global category schema versions

A global schema-version record contains:

- National Catalog category identifier and display metadata;
- applicable TN VED/OKPD2 selectors where supplied;
- attribute identifiers, data types, units, multiplicity, presets, required level, and
  conditional dependencies;
- source API version, ETag/content hash, fetch time, and raw definition;
- lifecycle state: `observed`, `validated`, `active`, or `retired`;
- activation and supersession metadata.

Global schemas contain no tenant product values. A new version is fetched and validated
before activation; it cannot silently rewrite products.

### Product category binding

A tenant-scoped binding connects a product to:

- the coarse Chestny ZNAK product group already stored on `products`;
- the confirmed National Catalog category;
- TN VED and, where relevant, OKPD2;
- the schema version used for current validation;
- binding source, confirming user, timestamps, and revision.

Changing the category closes the old binding rather than deleting it. A preview marks
values as transferable, convertible, inapplicable, or conflicting. Only confirmed
compatible values enter the new active profile.

### Category attribute values

The current value store is tenant- and product-scoped, keyed by schema attribute ID. Each
entry contains:

- typed value, including arrays for genuine multi-value attributes;
- unit where the schema uses one;
- source: `manual`, `1c`, `national_catalog`, or `migration`;
- source snapshot/import identifier and source observation time;
- applied user/time and product revision;
- active/inapplicable state without destructive deletion.

Historical changes remain reproducible through immutable import records and the business
audit trail. Sensitive tenant scoping uses the repository's composite foreign-key
pattern; no query relies on a client-supplied tenant identifier alone.

### National Catalog card snapshots and import previews

Card snapshots are immutable, tenant-scoped records containing GTIN, National Catalog
card/good identifier, card status, ETag/content hash, fetch time, and the raw response.
Keeping snapshots tenant-scoped makes the exact observation and access context auditable;
cross-tenant deduplication is not part of v1.

An import preview records its base product revision, source snapshot, normalized diff,
mapping warnings, conflicts, creator, expiry, and terminal state (`preview`, `applied`,
`rejected`, or `stale`). Apply is atomic and idempotent. A product revision mismatch makes
the preview stale and forces regeneration rather than overwriting intervening edits.

### Mapping registry

Only an explicit, centrally reviewed mapping can copy an external attribute into a stable
operational field. Each mapping pins:

- source category and attribute ID;
- target field;
- compatible source and target types;
- unit conversion and allowed multiplicity;
- direction (external-to-operational in v1);
- mapping version and tests.

Similar labels are not a mapping rule. If meaning or units do not match exactly, the
value remains category-specific and appears as a conflict or suggestion.

## Schema lifecycle

1. A background schema job calls the National Catalog category and attribute methods,
   using ETag/request limits and bounded retries.
2. A changed response is stored as an `observed` immutable version.
3. Structural validation checks attribute types, presets, dependency references,
   duplicate identifiers, and mappings.
4. The platform comparison reports added, removed, newly required, and semantically
   changed fields.
5. Markiro maintainers validate the version centrally and activate it.
6. Readiness is recalculated against the active version. Existing values are never
   rewritten by activation.
7. A schema change may make code-ordering or circulation readiness incomplete, but it
   does not invalidate the last operational projection or stop Station production.

Tenant administrators cannot create arbitrary schemas or custom fields in v1.

## National Catalog integration

### Authentication and client boundary

Official documentation allows a National Catalog API key or a GIS MT Bearer token
obtained through True API. Markiro already stores encrypted tenant-scoped True API tokens
maintained by the signer agent and exposes them server-side through the existing token
service.

The National Catalog client may reuse that server-side token path, but this is an
external-validation hypothesis, not an assumed guarantee: access to individual methods
depends on the tenant's role and rights. Tokens are never returned to admin or Station,
written into snapshots, or logged.

### Read-only v1 methods

The client uses the official category/attribute methods for schema discovery and product
methods such as `/v3/feed-product` or `/v3/product` for GTIN/card lookup, subject to their
visibility rules. `/v3/short-product` is not a baseline dependency because it requires a
specific integrator/developer role.

No v1 flow creates, edits, signs, publishes, or archives a National Catalog card.

### Initial import flow

1. A tenant user opens an existing Markiro product and requests a lookup by GTIN.
2. The server validates tenant access, obtains the tenant token, and queries the National
   Catalog.
3. Zero results produce a recoverable manual-path result. Multiple or ambiguous results
   require user selection.
4. The response is stored as a snapshot and normalized against its referenced schema.
5. Markiro proposes category/TN VED binding and a field-level diff.
6. Markiro checks the proposed fine category against the coarse Chestny ZNAK group; an
   incompatible pair cannot be applied as if it were valid.
7. The user confirms the binding and accepts or rejects individual changes.
8. Apply checks the base product revision, writes accepted values and mappings in one
   transaction, records exact audit metadata, and rebuilds readiness/projection.

### Freshness flow

After import, a background task checks ETag/content changes at a bounded frequency. A
changed card creates a new snapshot and pending preview/notification. It never silently
overwrites accepted Markiro values. The UI always shows the last successful check time
and whether a newer card or schema awaits review.

## 1C and manual sources

Manual Markiro values remain authoritative for operational fields unless a user accepts a
proposal. National Catalog attributes are authoritative reference values only within the
National Catalog card/schema boundary; they do not gain blanket authority over the whole
Markiro product.

Future category-field extraction from CommerceML enters the same preview/import model:

- no silent changes to name, category, EGAIS, permits, or regulatory attributes;
- source and source timestamp on every suggestion;
- field-by-field conflicts against the accepted value;
- normal tenant authorization and exact audit records.

This keeps Markiro the catalog master while allowing 1C and National Catalog to reduce
manual entry.

## Readiness model

Readiness is evaluated, not hand-edited. The public result contains independent
dimensions with `ready`, `not_ready`, `not_applicable`, or `stale` state and structured
reason codes.

### Production readiness

Represents whether the product can be selected for the existing Markiro production
workflow. The first slice preserves current group/box/pallet semantics unless a separate
product decision changes them. Existing `products.status` remains a compatibility
projection of this dimension during migration, not the source of every other readiness
answer.

### Code-ordering readiness

Validates the first-layer attributes required to order marking codes for the confirmed
category and active schema.

### Circulation readiness

Validates second-layer, conditional, and permit-related data needed for circulation. It
can be incomplete while code ordering and production remain ready.

### EGAIS readiness

Returns `not_applicable` outside applicable categories. For beer it validates required AP
codes, 19-digit format, multiplicity, and primary-code selection needed by the Markiro
operation.

Reasons identify the exact missing/conflicting attribute, condition that activated it,
schema version, and suggested user action. A color or one aggregate `draft/active` label
is insufficient.

## Operational projection and Station

The server builds a compact, versioned operational projection from accepted typed fields
and exact mappings. It may contain, when relevant:

- selected primary EGAIS code and compatible legacy scalar;
- shelf-life value in the established operational unit;
- keg/package parameters needed by the line process;
- label-template input values;
- projection version and creation time.

Station receives this projection through the existing tenant/shift/offline bundle and
stores only what its workflow needs. Raw National Catalog cards, category forms, source
conflicts, API tokens, and the complete regulatory schema do not enter the Station mirror.

No National Catalog outage, schema refresh, or pending diff may introduce a runtime
network dependency on the factory line. Old bundle and queued payload shapes remain
accepted until the documented offline queue horizon is closed.

## Admin experience

The product card is organized into four blocks:

1. **Основные данные** — GTIN, name, product group, price, packaging capacities, and
   existing Markiro defaults.
2. **Готовность** — production, code ordering, circulation, and EGAIS with concrete
   reasons and drill-downs.
3. **Категория и Национальный каталог** — confirmed category, TN VED/OKPD2, source,
   last successful check, and actions to find or refresh the card.
4. **Характеристики категории** — schema-driven required fields first, followed by
   recommended and optional fields.

Conditional fields appear immediately after their trigger is selected. Each value shows
its source in plain language. Technical National Catalog attribute identifiers stay out
of the main UI and are available only in diagnostic/audit detail.

Import uses a review screen with `current -> proposed` values. Empty additions, actual
conflicts, conversions, and ignored fields are visually distinct; each change can be
accepted separately. Category change presents transferable, inapplicable, and conflicting
values plus the readiness effect before confirmation.

Pilot copy uses domain terms such as "Код АП ЕГАИС", "Срок реализации кега после
вскрытия", "Ветеринарный контроль", "Лицензия на пользование недрами", and "Содержит
подсластитель" instead of generic custom-field language.

## Failure and recovery behavior

External errors are classified rather than collapsed into an invalid product:

- GTIN/card not found;
- card unavailable to the current tenant;
- missing role or method rights;
- expired/missing token;
- rate limit;
- transient National Catalog/network failure;
- malformed or unsupported external schema/card;
- stale import preview after concurrent product edit;
- active schema incompatible with an accepted value.

The last accepted product, snapshot, and operational projection remain available during
all external failures. Retry-safe jobs use bounded exponential backoff and respect ETag
and published limits. Failed preview apply writes no partial product changes. Operators
see the last successful check and a recoverable action; an external failure does not stop
an offline line.

Audit assertions must capture tenant, actor, action, product, snapshot/import identifiers,
base and resulting revision, accepted/rejected fields, and result. Raw bearer tokens and
unbounded card payloads are excluded from logs and ordinary audit metadata.

## Migration and compatibility

### Existing EGAIS value

For applicable beer products, a non-empty legacy `egaisCode` is proposed as the primary
AP code. A valid 19-digit value can be migrated with source `migration`; an invalid value
is retained for diagnosis and creates a readiness reason. Migration never truncates,
normalizes, or discards an invalid code silently.

The legacy scalar response and Station field remain derived from the selected primary AP
code during the compatibility window. Products with multiple codes must explicitly select
the operational primary code.

### Existing shelf life

`shelfLifeDays` remains the stable operational field in the first slice. It maps to a
category attribute only when source semantics are duration, source unit can be converted
without loss, and the category mapping is reviewed. Otherwise the UI presents a
suggestion/conflict.

No global migration derives the dairy `<= 40 days` flag merely because a numeric shelf
life exists. That derivation may be introduced only as an explicit tested category rule.

### Existing product status and clients

The first migration preserves `products.status` as the production-readiness compatibility
projection. New readiness endpoints/fields are additive before clients are switched.
Station schema and bundle changes follow a versioned compatibility sequence; old queued
payloads are accepted until the queue horizon is explicitly closed.

## API surface

Exact route naming is an implementation-plan concern, but the boundary requires:

- schema/form metadata and active version for a confirmed category;
- product regulatory profile, value provenance, and readiness;
- GTIN lookup and category proposal;
- immutable import preview creation and retrieval;
- atomic/idempotent preview apply or reject;
- category-change preview and confirmation;
- conflict/history retrieval;
- authorized schema refresh/activation as a platform operation, not a tenant field
  builder.

All product reads and writes are tenant-scoped on the server. Untrusted external values
are validated against the pinned schema before persistence. API responses use stable
reason codes with localized admin copy rather than persisting Russian UI messages as
business state.

## Testing strategy

### Schema and domain tests

- official pilot fixtures parse into the expected required, conditional, multi-value,
  unit, and preset representation;
- missing dependency targets, duplicate attribute IDs, incompatible types, and invalid
  mappings reject activation;
- first/second-layer and condition-trigger evaluation is deterministic;
- conversion tests cover exact unit conversions and reject lossy or semantic guesses;
- the pilot matrix pins critical anchors: beer EGAIS/keg, dairy variable weight/VetIS,
  water OKPD2/licence, and soft-drink sweetener/keg.

### Database and API tests

- composite tenant ownership and cross-tenant denial for bindings, values, snapshots,
  imports, and conflicts;
- immutable schema/card snapshots and valid lifecycle transitions;
- preview diff, stale-revision rejection, atomic apply, and idempotent retry;
- exact field-level provenance and audit metadata;
- category change preserves history and only transfers confirmed compatible values;
- readiness dimensions and structured reasons;
- legacy EGAIS/shelf-life migration and API compatibility;
- token absence, rights denial, rate limiting, timeouts, malformed payloads, and retries;
- background freshness creates a preview but never overwrites values.

### Admin tests

- correct schema-driven controls, required levels, presets, multiplicity, and conditional
  visibility;
- accessible labels, keyboard operation, focus, and inline errors;
- source indicators, import diff decisions, conflicts, and category-change preview;
- separate readiness states and actionable drill-down reasons;
- no tenant custom-field builder in v1.

### 1C and Station tests

- CommerceML proposals use the shared conflict/provenance path and do not silently modify
  protected fields;
- operational projection contains only accepted exact mappings;
- old/new bundle versions and restarted offline Station retain required fields;
- National Catalog downtime does not affect local production selection or queued work.

Host and browser automation do not prove real National Catalog rights, Windows Station,
scanner, printer, or factory network behavior. Those remain separate external gates.

## Rollout sequence

1. **External proof:** use a test tenant/token to verify category, attribute, and product
   methods, role requirements, ETag, limits, and representative GTIN responses.
2. **Classifier snapshot:** build the complete group/category/TN VED matrix and classify
   exact, ambiguous, and unmapped relationships.
3. **Foundation:** schema versions, product bindings/values, snapshots/import previews,
   provenance, audit, and readiness service behind a feature flag.
4. **Pilot schemas:** beer, non-alcoholic beer, dairy, packaged water, juices, and soft
   drinks with official fixtures and reviewed mappings.
5. **Admin read/manual entry:** category confirmation, dynamic forms, readiness, and
   category-change preview without external import.
6. **National Catalog import:** lookup, snapshot, diff, confirmation, and freshness
   notifications.
7. **1C proposal extension:** only after the shared conflict path is stable.
8. **Station projection:** additive bundle version, compatibility verification, then
   client adoption.
9. **Wider classifier activation:** category families graduate only after mapping review
   and fixtures; unsupported groups continue using stable product fields without a fake
   universal form.

## Acceptance criteria

- A product can have a confirmed fine National Catalog category distinct from its coarse
  Chestny ZNAK group.
- The active versioned schema determines applicable fields and conditions.
- Pilot categories expose the researched mandatory and conditional branches.
- Every accepted imported value has field-level source and reproducible snapshot/import
  history.
- National Catalog and 1C never silently overwrite an accepted value.
- Category changes preserve old values/history and require confirmation for transfers.
- Production, code-ordering, circulation, and EGAIS readiness are independent and
  explainable.
- Station receives only a versioned operational projection and remains fully usable
  without National Catalog connectivity.
- Cross-tenant reads/writes are denied and tested.
- Existing invalid EGAIS or ambiguous shelf-life data is surfaced, not silently destroyed
  or reinterpreted.
- The whole classifier has an explicit exact/ambiguous/unmapped matrix, while activation
  remains incremental and evidence-based.

## Out of scope

- tenant-defined custom fields or per-tenant schema editing;
- creating, editing, signing, publishing, or archiving National Catalog cards;
- automatic conflict resolution or blanket source priority;
- guessing category from a coarse product-group code without a card/user confirmation;
- storing all National Catalog data in Station;
- blocking an offline production line because an external card or schema is stale;
- silently migrating semantically similar fields solely by label;
- claiming production National Catalog compatibility before the real-token external gate
  passes.
