# US-11: six-month synthetic demo dataset

Status: owner-approved written specification, 2026-10-06. The owner approved six
months of substantial synthetic activity, resumable generation through existing
services and this written specification. Implementation still requires review of
the relevant written plan. This does not authorize hosting, reset, commit, push
or release.

## 1. Outcome and boundaries

Populate the single reserved U.S. demo tenant with enough coherent history to
explore Events, lots, SSCC lookup, Search, Trace, Readiness, Plan and prepared
Requests. Preserve the existing EN/ES cabinet and read-only visitor boundary,
including authorized downloads but no business mutations or package generation.
No new customer provisioning, Station, scanning, printing, billing or production
infrastructure is included. Hosting and storage must remain outside RF; provider,
domain and external deployment are a later separately reviewed increment.

This expands the dataset scope of the accepted
[single-tenant design](2026-10-06-us-11-single-tenant-demo-seed-design.md).
Its isolation, provenance, viewer, private-artifact and honest-timestamp rules
remain applicable. The accepted foundation and reference implementation remain
valid for compact Scenario A. The unapproved
[Receiving plan](../plans/2026-10-06-us-11-demo-receiving-seed.md) must not be
executed unchanged as acceptance of this larger dataset; its transaction seams
can be incorporated into a revised implementation plan.

Work stays in the existing US worktree and branch. Preserve all unrelated and
accepted changes. No shared-base database writes, environment/dependency edits,
archive/design-file edits, staging, commit, push or deployment are included.

## 2. Versioned recipe and proposed volume

Introduce a separate immutable recipe identity, `us-processor-six-month-v1`.
Pin business dates to `2026-04-01` through `2026-09-30`, six complete calendar
months, in `America/Los_Angeles`. A rerun does not move dates to follow today.
Changing content or dates requires a new reviewed recipe version, not a reset or
silent replacement of an installed dataset.

| Content                     | Required recipe                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Regular chains              | 260 independent production chains: 34, 38, 42, 46, 48 and 52 by month                                                    |
| Regular events              | 260 Receiving + 260 Transformation + 440 Shipping = 960 current finalized events                                         |
| Shipping distribution       | 180 chains with two shipments; 80 with one shipment                                                                      |
| Regular lots                | Two new inbound lots and one output per chain: 780 lots                                                                  |
| Regular boxes               | Scenario A output has 100; other 259 outputs average 60: 15,640 distinct synthetic boxes                                 |
| Products                    | 16: eight inbound fresh-cut apple variants and eight finished apple variants                                             |
| Parties                     | 10 suppliers, 12 recipients, one processor; 23 fictional parties                                                         |
| Locations                   | One fictional location per party; 23 locations                                                                           |
| Problem/correction examples | One voided Receiving with two retained lots; one additional corrected full production chain with three lots and 60 boxes |
| Total business records      | 964 event roots, 963 current finalized events, 785 lots, 15,700 boxes; revisions/history counted separately              |

The corrected chain adds one Receiving, one Transformation and one Shipping;
its Receiving is amended and re-finalized before downstream use. The orphan
example adds one Receiving finalized then voided before downstream use. It has
no Transformation output or Shipping. Revision counts are derived from actual
service results and checked against the recipe's expected history, not equated
with event-root counts.

Embed Scenario A as one September regular chain with its exact accepted dates,
TLCs, quantities and 100 SSCCs. Preserve the original compact recipe version and
digest for tests and guided demo; do not mutate its descriptor to contain the
large history. The large recipe is self-contained, not an automatic upgrade or
adoption of an already populated compact installation.

## 3. Coherent activity, not repeated filler

Allocate dates deterministically across working days, with uneven daily volumes,
quiet days and occasional bursts. Each chain orders Receiving before
Transformation before Shipping; later shipment dates remain inside the pinned
period. Use distinct batch lots so unrelated chains do not become one connected
lot graph merely because they share products, parties or locations.

Except for Scenario A, vary inbound quantities and output case counts using a
fixed, reviewed recipe. Positive paired output adjustments around 60 preserve
the regular total of 15,640 boxes. Vary supplier, recipient, product and document
references consistently. Shipments include full and partial shipments: some
output lots retain stock, some split across recipients, some finish at zero.
All quantities use exact decimals and existing UOMs. Inbound consumption uses
the source UOM; output shipments use `case`. No hidden lb-to-case conversion,
mass reconciliation, fabricated process-loss ledger or overshipping is allowed.

Use fictional contact data and explicit synthetic provenance. Product profiles
carry manual synthetic classification review metadata, not regulatory approval
claims. Documents are typed fictional references without remote fetching or
real attachments. Boxes use domain-valid distinct SSCCs with synthetic markers;
the fictional namespace must cover the full set without collisions and must not
suggest an allocated GS1 company prefix or physical production.

Corrections and problems use supported service actions, not SQL corruption:

- Amend the correction example's Receiving quantity before downstream use;
  finalize the amendment, then consume only its current quantity. Keep prior
  revision history visible and current balances consistent.
- Void the orphan example before any downstream finalization. Retain its lots
  and show missing current origin in Trace/Readiness. Do not create new case
  links or finalize downstream consumption from those lots.
- Validate that attempting an invalid downstream action is rejected; the demo
  need not persist an extra draft merely to demonstrate the rejection.

## 4. Bounded durable progress

The existing journal supports exactly one fixed compact scenario header per
tenant and nine stage slots. Its input/result codec is bounded at 256 KiB.
Do not add a second header to that journal, repurpose its version/digest or raise
its limits to fit thousands of records.

Add a separate US-only dataset journal with an additive migration. Do not rewrite
migration 0141. The dataset header identifies tenant, original trusted owner,
recipe version/digest, pinned period and expected totals. Unique keys prevent
duplicate active initialization for this dataset. Child progress is uniquely
identified by tenant, dataset, stable unit key and stage. Every relationship is
tenant-scoped with composite foreign keys.

Units are shared references, each production chain, each special example, Plan
and each prepared Request package. Each chain has bounded Receiving,
Transformation, Cases and Shipping stages. Record compact per-stage intents,
operation keys, owned IDs and receipts, not a whole-dataset array in one row.
Retain the existing 256 KiB codec discipline per intent/result. Case work is
bounded within a chain; unit progress is read in bounded pages.

An explicit US-only initializer verifies actual database identity, reserved
tenant, original owner and synthetic provenance before writes. Initialize only
a fresh compatible target; unknown business records or a populated compact seed
cause a precise conflict, not name-based adoption, repair or deletion. Repeat
execution verifies the same installed recipe and resumes its incomplete stages.

Use existing services and their real readiness/finalization rules. Add native
transaction seams only where necessary, retaining public authorization and
validation behavior. Use current Receiving command/finalization paths, not
legacy snapshot writers. Only minimal seed-owned box/shift support rows may use
native persistence; all event snapshots, genealogy, balances, case links, Plan
approval and Request publication remain service-owned.

Commit one bounded business stage together with its receipt where both are
database-local. External artifact operations retain the existing idempotent
publication/recovery protocol; do not claim a transaction across PDF storage
and PostgreSQL or across all six months. Sequential execution is the initial
default: bounded memory and simpler recovery, not a new parallel job system.

Retries retain operation identity and verify canonical current state. A historical
command receipt alone does not prove an event or case link is still current.
Compare seed-owned business facts and expected revisions/history, not mutable
technical dependency tokens that legitimately change after downstream use.
Unexpected drift stops with unit/stage identifiers and never silently repairs
records. Additional independently created references do not invalidate unchanged
owned references. Completion requires all expected units and artifacts verified;
progress alone is not acceptance.

## 5. Plan, Requests and clocks

Create one approved synthetic Plan with the existing PDF marking, approver ID
and actual approval time. Prepare three complete Export-ready Request packages:
Scenario A, a bounded April subset and a bounded September subset excluding
Scenario A. Their exact stable selections belong to the recipe manifest and
include complete required provenance/dependency closure.

The limits remain 500 selected revisions and 16 MiB snapshot per Request.
Amendment history counts toward the revision limit. No truncation, omitted
dependencies or export-all workaround is permitted. Prevalidate the chosen
subsets against the limits; an oversized selection fails before preparation.
The six-month history is browsable without requiring one giant export.

Historic dates are business civil dates only. Creation, audit, authentication,
approval and package timestamps reflect actual initialization. Request receipt
time is captured once and its due time remains 24 elapsed hours later; a rerun
does not renew it. Synthetic history is never presented as six months of real
customer activity. Same-installation replay preserves IDs and immutable bytes;
fresh installations may differ in generated IDs, actual times and artifact hashes.

## 6. Verification and implementation boundaries

Implementation is divided into independently reviewed increments: large recipe
and progress foundation; reference expansion and Receiving seams; transformation,
case and shipping orchestration; special examples and artifacts; explicit CLI
and full-volume verification. Preserve the chosen separate implementer and
independent reviewer method. Each increment needs its written implementation
plan before execution; this document is not permission to run all stages now.

Acceptance uses owned disposable US PostgreSQL databases and private artifact
fixtures, never the shared base implicitly. Required evidence includes:

- Exact manifest counts, unique TLC/SSCC/operation identities, cross-tenant
  denial and original-owner/provenance rejection.
- Current service readiness, lineage, quantities, stock and synthetic markers;
  exact actor/tenant/action/target/result audit assertions.
- Failpoint/restart and same-installation replay with no duplicated business
  facts, approvals or published runs; concurrent initialization has one winner.
- Intended correction/void history and deliberate drift rejection; distinguish
  legitimate technical dependency changes from business tampering.
- Full dataset generation and verification, measured elapsed time, peak resource
  use and database/artifact size. No unmeasured free-tier or runtime promise.
- Browser inspection as a viewer: paging/filtering the larger history, search,
  an intact chain, partial stock, correction/history, missing origin, Plan and
  all three downloads; mutations and new package generation remain denied.
- Relevant package tests/typecheck/lint/build, formatting and US isolation gates,
  reporting database skips and unrelated baseline failures explicitly.

Local database/browser/PDF evidence does not establish external hosting, DNS/TLS,
backup recovery, actual cloud cost, physical boxes, regulatory acceptance or a
live visitor-accessible demo. Those remain separate gates.
