# Entitlements P1A operation adapters

This inventory accompanies the [P1A guide](entitlements-p1a.md) and
[approved design](../superpowers/specs/2026-09-11-entitlements-p1-foundation-design.md).
Implementation, integrated checks and final review are complete; the
[acceptance record](entitlements-p1a.md#acceptance-evidence) retains the remaining full-run and
external-validation limits. Registry
definitions live in `packages/platform-contracts/src/entitlements.ts`; executable coverage lives
in `apps/api/test/entitlement-operation-inventory.test.ts`.

An adapter observes the candidate commercial decision after the real action owner performs its
current checks. It does not replace those checks. API-key composition is a tested facade rule;
this inventory does not introduce an API-key route or enable P1B enforcement.

## New-work callsites

Paths below are relative to `apps/api/src/modules/`. Methods identify the actual callable body,
not an entire controller assumed covered because another method has an adapter. The AST inventory
checks actual calls, including separate card/category and download/staging boundaries; service
and integration tests exercise their behavior and factory wiring.

| Operation              | File and callable owner                                                             | Observed action and preserved boundary                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `nk.lookup.v1`         | `national-catalog/national-catalog-products.service.ts`: `lookup`, `selectCardRead` | Feed lookup and published-card fallback; existing cabinet guards, product ownership and token/config checks |
| `nk.proposal.v1`       | `national-catalog/national-catalog-proposal.service.ts`: `preview`                  | Snapshot-backed proposal insert after current profile/schema/mapping checks                                 |
| `nk.lookup.v1`         | `national-catalog/national-catalog-import.service.ts`: `start`                      | New enumeration intent after current actor, subscription, mode and environment checks                       |
| `nk.worker.v1`         | `national-catalog/national-catalog-import.service.ts`: `resume`                     | Each actual list/feed request after current session/checkpoint attempt and actor checks                     |
| `nk.proposal.v1`       | `national-catalog/national-catalog-import-preview.service.ts`: `prepare`            | New preparation intent; exact request replay exits before observation                                       |
| `nk.worker.v1`         | `national-catalog/national-catalog-import-preview.service.ts`: `resumePreparation`  | Separate card and category requests, each under the current preparation identity                            |
| `nk.apply.v1`          | `national-catalog/national-catalog-import-apply.service.ts`: `start`                | New immutable accepted operation; existing accepted request/decision replay returns first                   |
| `nk.worker.v1`         | `national-catalog/national-catalog-import-apply.service.ts`: `resume`               | New item application; applied/conflict/cancelled receipts and ineligible retries return first               |
| `nk.apply.v1`          | `product-regulatory/product-regulatory-writer.ts`: `applyInTransaction`             | Only the `national_catalog_import` branch, after saved-selection replay and current field/schema checks     |
| `nk.refresh.v1`        | `national-catalog/national-catalog-link-refresh.service.ts`: `enqueue`              | Fresh refresh checkpoint; pending checkpoint replay returns first                                           |
| `nk.worker.v1`         | `national-catalog/national-catalog-link-refresh.service.ts`: `admit`                | Actual card/photo request after link revision, environment, step/run and policy checks                      |
| `nk.worker.v1`         | `national-catalog/national-catalog-image.service.ts`: `resume`                      | Photo download and asset staging, separately, with current image attempt and preparation actor              |
| `nk.worker.v1`         | `national-catalog/national-catalog-image-apply.ts`: `applyAcceptedImage`            | Accepted image swap after receipt, attempt, accepted selection and staging-asset checks                     |
| `chz.export.create.v1` | `chz-exports/chz-export-runner.service.ts`: `claim` before `createTask`             | Claimable run, fresh creator/write-policy/group checks, fenced claim and observation before provider HTTP   |

Legacy NK HTTP guard ownership remains `TenantGuard` → `AuthorizationGuard` →
`SubscriptionAccessGuard`, followed by service resource checks. Modern worker owners reload
current actor and subscription state. Legacy proposal/apply and accepted-image application
keep release readiness unknown where there is no server release-policy observation. Cached
accepted-image application does not acquire a new preparation-configuration gate. Other adapters
use their current checked server configuration. No static registry eligibility label is treated as a release switch.

## Recovery and deferred families

| Registry entry or family                           | P1A treatment                                                                                                                     |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `chz.export.poll.v1`                               | Known-task continuation; retains existing resource/state and token handling, without a fresh-create observation                   |
| `chz.export.receipt.v1`                            | Stored-result read/recovery; receipt ingestion retains deduplication and checks a supplied server CHZ attempt before new evidence |
| `inventory.file.create.v1`                         | Classified, new module enforcement/adapters deferred to P1B                                                                       |
| `commerceMl.exchange.v1`                           | Classified by its own purpose/module; deferred to P1B                                                                             |
| `labelEditor.template.write.v1`                    | Existing label-template write capability remains; new operation adapter deferred to P1B                                           |
| `pallets.shift.configure.v1`                       | Existing pallet-enabled shift configuration remains; new operation adapter deferred to P1B                                        |
| `publicApi.request.v1`                             | Fixed composition rule for verified API-key actors; route adapters deferred to P1B                                                |
| `handheld.work.start.v1`                           | Classified; native work/offline adapter deferred to P1C                                                                           |
| Global scheduled NK schema/catalog refresh         | Infrastructure maintenance, outside tenant new-work admission                                                                     |
| Manual product/profile/image edits unrelated to NK | Existing owners remain; no NK observation inferred from a shared writer                                                           |
| Future regulator document submission               | Absent from this registry; a module flag does not release a new operation                                                         |

## Transaction boundaries

The admission service takes an independent read-only repeatable-read capture before an owner
transaction, then compares a current proof through the owner's executor after its resource and
attempt checks. A changed revision, usage, policy/version identity or time boundary produces
unknown. Observation persistence and journal writes use savepoints to isolate their errors.
No provider request or external storage operation is moved into a DB transaction.

CHZ fresh creation takes the subscription timeline lock before the run row. Result/failure
transitions conditionally match the run identity and append their journal in the same transaction.
Receipt ingestion takes inventory, then the exact CHZ run, then its existing product lock before
new evidence. Modified run/journal paths do not take an inventory lock after the run lock.

After those waits and current actor/subscription checks, a single query through the owner
executor reloads inventory/product/profile INN, product group and GTIN. Missing or unsupported
current context fails before spending a create attempt. That checked context binds the
observation scope, runtime timestamp and provider create payload. Poll/download group selection
for tasks created in this pass is attached to the exact run/attempt/claim/task identity;
known or adopted recovery retains the pass context. This adds no persisted provider-context
protocol and does not establish exactly-once provider behavior.

NK retains the existing session/checkpoint and preparation locks; item application retains
timeline → session → operation → receipt → product/application locks. Refresh retains timeline →
product → link; image preparation and application retain their current session, operation,
receipt and asset ownership. The legacy regulatory path retains product → profile → proposal.
Shadow reads do not add entitlement revision/catalog row locks to those orders.

The focused regression evidence includes a one-connection pool, a revision change during an
owner lock wait, failed observation inserts with successful business commits, revoked CHZ
creators, current-context edits during adoption, a preceding create and a run-lock wait, late
create replies, a live final-budget claim, stale receipt ingestion, deterministic
receipt replay, uncertain storage/commit outcomes and the distinct image preparation actor.
Local provider/storage doubles establish these code paths; they do not prove real provider or
MinIO behavior. The final acceptance record will distinguish those surfaces explicitly.
