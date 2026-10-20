# US-11 prerequisite: structured Transformation snapshot v2

Date: 2026-10-20
Status: implementation basis within the owner's standing MVP implementation
approval. Discovered by the real Request-package integration, not a new product
feature or permission to deploy.

## Evidence and why this is required

Scenario A's native Request snapshot selects the exact owned complete chain and
effective Plan, but the export validator reports 30 `REQUIRED_KDE_MISSING` errors:
12 product fields across two inputs/one output, nine output TLC-source location
fields and nine transformation-location fields. Three additional numeric-lexeme
findings are informational, not missing-KDE errors.

`us-transformation-snapshot.ts` currently builds complete product/location
descriptions, flattens them into strings, discards the structure and emits v1.
The v1 contracts, database guard and export adapter intentionally preserve that
opaque text. Export must not split the text or hydrate it from current master
data. Therefore an adapter-only fix cannot truthfully produce export_ready.

Add a new version for newly finalized revisions. Do not change existing stored
v1 bytes, recalculate historical facts, remove findings or omit Transformation.
No production/base database is migrated by this work.

## Frozen v2 contract

Retain every v1 business field, identity, description string, reviewed coverage,
reference discriminator and lifecycle rule. A v2 snapshot has `snapshotVersion: 2`
and adds exactly one field to each captured product and location:

- `product.kdes`: the existing strict `productDescriptionSnapshotSchema` value,
  including `sourceProductId`, product name, optional brand/commodity/variety,
  exact packaging value/UOM/style and GTIN. Its sourceProductId must equal
  `product.id`.
- `processor.kdes` and each `source.kdes`: the existing strict
  `locationDescriptionSnapshotSchema` value. Its locationId must equal the outer
  location/source id. A reference source retains its exact reference kind/value
  and the resolved location's own structured snapshot.

Preserve the existing display descriptions exactly as built today; they remain
the display/legacy-compatible text, not a source for KDE reconstruction. The
output source must equal the complete captured processor plus `kind: location`,
including kdes, not merely share its ID or display text.

Export `transformationFinalizationSnapshotV2Schema` and type, plus a strict
versioned `transformationFinalizationSnapshotSchema` and union type. Keep the
original V1 exports and their validation behavior unchanged. Common structural
rules may be shared without weakening the legacy schema or copying its complete
refinement logic. Reject unknown versions, missing/extra fields and mismatched
nested IDs/output processor facts.

Finalized-record, genealogy and export contracts accept the versioned union.
No route or request-body changes. API, admin and downstream readers must parse
the union where they read actual persisted snapshots; V1-specific fixtures and
compatibility tests still exercise V1 explicitly.

## Native capture and replay

Use the same already locked finalization context and existing domain snapshot
builders; retain `built.snapshot` as kdes while deriving the same display string.
Do not add fresh unlocked reads, caller-supplied structured facts or asynchronous
hydration. New original finalizations and newly finalized amendments emit v2.

Amending a V1 event creates a new V2 revision with facts captured at that new
finalization time. It keeps output ID/product/TLC/source identity and does not
rewrite the predecessor. Saved old command receipts replay their original V1
snapshot and bytes unchanged. Voids, genealogy edges, quantity/UOMs, source locks,
audits and authorization semantics are unchanged.

Trace, genealogy, Readiness and lot-card consumers accept and verify either
version. Readiness must validate the actual chosen strict schema, including v2
KDEs, before using any narrow shared evidence projection. SQL candidate filters
must not silently exclude v2 or treat malformed v2 as complete. Display strings
remain available, so this does not require new UI controls or inferred text.

## Database guard

Add migration `0145_us_transformation_structured_snapshot.sql`; never edit an
applied migration. Preserve all current header, source identity, coverage,
typed-line, output identity, genealogy, revision and immutability checks.

Extend the finalization guard to accept v1 or v2 only. For v2, separately enforce
strict added KDE shape and exact equality to tenant-owned product/profile and
location facts at finalization. Reuse `receiving_product_snapshot_matches` and
`receiving_location_snapshot_matches` through narrow structural wrappers where
their semantics match; do not maintain a divergent normalization implementation.
The original source-identity comparison projects out the new kdes field, while
the new guard validates it completely. Do not accept v2 on the strength of the
version number alone.

Use the repository's guarded function-replacement migration pattern: require the
expected predecessor form, retain older checks verbatim, fail migration on shape
drift and add focused strict v2 checks. Existing finalized historical rows are
not revalidated against today's master data or rewritten. New v1 finalizations
remain accepted under the original rules for backward compatibility.

Verify fresh migration, prefix upgrade and runtime no-op replay in disposable
children, plus malicious SQL finalization attempts with missing/forged/wrong-
tenant KDEs. A versioned application parser is not a substitute for DB evidence.

## Export projection and findings

For v2 only, map captured kdes with the existing product/location context helpers.
Keep original display columns too. Preserve exact strings and reference values;
never consult current master data while exporting. For v1, leave split fields
unavailable and preserve every original source-linked missing-field finding.
Do not weaken the registry's required-field rules or severity classifications.

The dataset adapter may accept informational native findings (including exact
numeric text preservation) while retaining them in the frozen snapshot, report
and manifest. It must reject every warning/error in this no-autoack recipe.
This clarifies 'unexpected findings' in the parent design; it is not suppression
or a change to the native validator's export_ready eligibility.

## Acceptance and isolation

Pure contract/domain tests distinguish v1/v2 and forged bindings; v1 missing-KDE
findings remain literal regression expectations. Native tests prove actual v2
capture from locked facts, amendment/old receipt compatibility, DB rejection,
trace/genealogy/Readiness/lot-card and Request/export support. Current master-data
changes after finalization must not alter exported v2 values.

Only after this prerequisite is independently reviewed and native regression
gates pass may the pending dataset adapter resume. It then must earn actual
Ready/private-byte/ZIP proof; no acceptance is transferred from this prerequisite.
Newly seeded synthetic datasets use v2; already completed older dataset receipts
are not repaired or silently adopted.

US worktree/branch only. Root owns user-authored/committed scoped backup pushes.
No main/PR/release/deployment, operational lock removal, destructive cleanup,
unknown DB/process action, dependency policy or environment-file change. Existing
assertions/timeouts/phase budgets stay; version-sensitive expectations may change
only to assert the new explicit contract while preserving separate V1 proof.
