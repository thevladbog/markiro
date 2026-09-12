# Markiro — Catalog, Subscription Entitlements and Billing Controls

## Functional Requirements for Development and Enhancement

| Attribute           | Value                                                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Document ID         | MKR-FR-COMMERCIAL-002                                                                                                         |
| Version             | 1.3                                                                                                                           |
| Date                | 2026-09-10                                                                                                                    |
| Status              | Proposed implementation baseline; subject to product-owner approval                                                           |
| Product             | Markiro                                                                                                                       |
| Primary audience    | Product owner, backend and frontend developers, desktop and Android developers, QA                                            |
| Repository baseline | `thevladbog/markiro`, commit `9cdd7f634949fde28528f4ca172ac8ed9769796a`                                                       |
| Scope               | Catalog, plans, add-ons, services, entitlement enforcement, device licensing, subscription lifecycle and commercial documents |

> This document specifies target behavior. It is not a statement that the described functionality already exists. Repository observations are separated from requirements. Example plans and operating policies are not authorization to change existing customer contracts, publish prices or enable untested features.

**Revision 1.1 — product-owner decisions, 2026-09-10:** Chestny ZNAK and National Catalog access form one commercial module, `chzIntegration`. In the illustrative Start plan this module is a paid add-on; in Workshop and Production it is included. Separate operational capabilities, release eligibility and recovery controls remain mandatory. These decisions do not authorize production catalog publication or migration of existing customer terms.

**Revision 1.2 — approved P0 design, 2026-09-10:** Use explicit workflows in the existing services with shared internal calculations. New paid terms use `Europe/Moscow`; immediate activation begins when confirmed payment is applied, and renewal begins at the current term end. Documents issued before an unknown activation date retain the duration and activation rule; the resolved interval is recorded once at activation without rewriting the issued snapshot.

**Revision 1.3 — product-owner correction, 2026-09-12:** Unfinished P1 lifecycle-policy administration must not block current sales. Plans, add-ons and services may be created and published without an additional lifecycle policy and used in offers and invoices under current subscription rules. A selected policy still requires approval and integrity validation. Catalog publication alone does not activate new P1 module restrictions or offline grants; the enforcement rollout gate remains separate. Existing commercial, tax, authorization and historical-document safeguards remain mandatory.

**Normative language:** MUST indicates a mandatory requirement within the stated delivery phase. SHOULD indicates a recommendation that may be changed through a recorded design decision. Proposed field names are logical contract names; an equivalent implementation is acceptable if behavior, compatibility and traceability are preserved.

---

## 1. Purpose and expected outcome

Extend the existing commercial subsystem so that Markiro can sell and enforce understandable subscription packages without compromising production continuity or data recovery.

The subsystem must independently represent:

1. **Commercial entitlements:** which modules and resource quantities a customer has purchased or explicitly received.
2. **User and device authorization:** which authenticated principal may perform an operation within its tenant.
3. **Operational availability:** whether a module is released, available to this tenant and correctly configured.
4. **Technical safeguards:** request throttling, external-provider quotas, job concurrency and resource-protection limits.

A paid entitlement does not bypass authorization, external-system permissions, release readiness or safety checks. A technical limit does not automatically represent a paid-plan restriction.

Success means that an administrator can publish a valid monthly or annual offer, explain the resulting customer rights, enforce those rights consistently across all product surfaces, and change or expire the subscription without losing already-recorded production facts.

## 2. Scope and delivery phases

### 2.1 In scope

- Catalog creation, version editing, publication and document names.
- Zero, finite and unlimited quota semantics.
- Monthly and annual license periods.
- Seller-profile-derived VAT handling.
- One commercial entitlement for Chestny ZNAK including the National Catalog, plus separate entitlements for inventory, CommerceML and handheld devices.
- Shared licensing of desktop stations and handheld terminals.
- Server-side enforcement and client-side explanations.
- Safe expiration, feature withdrawal, downgrade and recovery behavior.
- Effective-entitlement inspection and temporary customer-specific grants.
- Recurring service orders and service-minute accounting.
- Migration, compatibility, audit, test coverage and rollout controls.

### 2.2 Out of scope

This work does not implement missing production or regulatory functions merely because an entitlement exists. In particular, it does not deliver universal Chestny ZNAK document submission, code ordering, pallet aggregation, compatibility with every 1C configuration, or hardware acceptance for every scanner.

The following are also excluded: hardware resale, resale of third-party licenses, agency payment collection, automatic tax filing, automatic My Tax receipt issuance, payment-card recurring charging, a full CRM/helpdesk, separate commercial handheld quotas, commercial per-code billing, multi-site authorization redesign, and a new general-purpose policy engine.

Existing integrations, billing workflows and authorization components must be extended rather than duplicated.

### 2.3 Delivery phases

| Phase                               | Scope                                                                                                                                                     | Release gate                                                                                              |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **P0 — Catalog correctness**        | Quota semantics, billing-period correctness, VAT defaults and validation, document naming, historical-data safeguards                                     | Required before entering new paid plans through the affected forms                                        |
| **P1 — Entitlements and lifecycle** | New module entitlements, shared device licensing, consistent enforcement, safe recovery, customer-specific grants, downgrade preview, effective-rights UI | Required before publishing plans that restrict the new modules or deploying new restrictions to customers |
| **P2 — Recurring services**         | Periodic service orders, service allowances, usage ledger and related document flows                                                                      | Required before selling an automatically managed recurring support package                                |

P0 and P1 together form the minimum commercial-control release. P2 may follow independently; until then, unsupported recurring services must not be disguised as license add-ons.

---

## 3. Observed repository baseline

The following observations are based on the inspected repository snapshot, not on a production-environment audit.

| ID      | Observation                                                                                                                             | Consequence                                                                                                                                     | Source  |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| BASE-01 | Plan quantities accept a positive integer or `null`; database checks also require positive values when present                          | A plan cannot explicitly express zero kiosks through the current contract                                                                       | S1, S3  |
| BASE-02 | Empty quantity fields are submitted as `null`                                                                                           | An empty field must not be presented as “not included”                                                                                          | S2      |
| BASE-03 | Plan and add-on creation submit `billingPeriod: "month"` regardless of the selected unit label                                          | Selecting a yearly unit alone does not establish annual entitlement duration                                                                    | S2      |
| BASE-04 | The create form initializes VAT to `2200` basis points                                                                                  | Seller-specific VAT defaults and validation are needed                                                                                          | S2      |
| BASE-05 | Existing feature keys are `labelEditor`, `publicApi` and `pallets`                                                                      | The newly introduced modules have no independent catalog entitlement keys                                                                       | S1, S4  |
| BASE-06 | Add-on effects are limited to seven entries and use the existing key set                                                                | Adding features requires updating effect validation, database constraints and associated contracts                                              | S1, S3  |
| BASE-07 | `service` is restricted to `one_time` in both the API contract and the database check                                                   | Recurring support requires an end-to-end model change                                                                                           | S1, S3  |
| BASE-08 | Existing entitlement resolution already combines plans and add-ons and distinguishes managed, read-only and unmanaged access            | Extend the existing resolver instead of introducing a competing source of truth                                                                 | S4, S5  |
| BASE-09 | Station usage counts non-revoked station-device records; member usage includes valid pending invitations                                | Counting semantics must remain explicit during migration                                                                                        | S5      |
| BASE-10 | The handheld design reuses station identity and consumes a station slot                                                                 | Preserve a shared station/handheld commercial quota in this release                                                                             | S7      |
| BASE-11 | Existing subscription guards support read-only and recovery policies                                                                    | Recovery needs operation-specific constraints, not an unrestricted bypass                                                                       | S6      |
| BASE-12 | National Catalog and Chestny ZNAK export controllers check subscription write access but do not reference dedicated module entitlements | Add the unified Chestny ZNAK entitlement check and operation-specific capability checks without removing existing tenant and role authorization | S9, S10 |
| BASE-13 | Handheld workflows are documented, but scanner vendor-intent settings are explicitly not yet hardware-verified                          | Commercial availability must be distinct from implementation presence                                                                           | S8      |

Revalidate this baseline against the implementation branch before development. A newer implementation that already satisfies a requirement must be retained and tested, not rewritten solely to match this document.

---

## 4. Terminology and actors

### 4.1 Terms

| Term               | Definition                                                                              |
| ------------------ | --------------------------------------------------------------------------------------- |
| Tenant             | The isolated customer account in Markiro                                                |
| Plan               | A versioned base subscription defining feature rights and resource ceilings             |
| Add-on             | A versioned additional license entitlement attached to a subscription                   |
| Service            | Work performed by the provider; not a software permission                               |
| Entitlement        | A contractual feature grant or quantitative allowance                                   |
| Capability         | A specific operation, such as requesting code-status information                        |
| Availability       | Whether an implemented capability is released and permitted for this tenant             |
| Working device     | A licensed desktop station or Android handheld terminal                                 |
| Kiosk              | A separately counted pickup device                                                      |
| Recovery operation | A narrowly scoped action that safely preserves or reconciles previously authorized work |
| Offline grant      | A server-issued, integrity-protected authorization snapshot with bounded validity       |
| Technical policy   | Noncommercial limits protecting the service or respecting external-provider constraints |

### 4.2 Actors and permission boundaries

Existing platform capability-based authorization must remain authoritative. The following are responsibilities, not a requirement to replace the current role model.

| Actor                                    | Required responsibilities                                                                      |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Platform catalog administrator           | Manage catalog drafts, view validation, publish eligible versions                              |
| Platform commercial administrator        | Assign subscriptions, approve changes, manage explicit grants                                  |
| Platform finance administrator           | Manage seller tax configuration, commercial documents and payment application                  |
| Platform support operator                | Inspect effective rights, assist recovery and record service work within assigned permissions  |
| Tenant owner or authorized administrator | View own subscription, manage permitted devices, inspect upcoming changes and request upgrades |
| Tenant operator                          | Perform authorized production operations; no catalog or commercial-policy administration       |
| Desktop station, handheld or kiosk       | Execute device-scoped operations using its own identity and bounded permissions                |
| Background worker                        | Execute authorized jobs and reconcile accepted work without acquiring broader tenant rights    |

All privileged changes must have an attributable actor or service identity. Support access must not silently grant finance or catalog-publication permissions.

---

## 5. Catalog structure and commercial presentation — P0

### FR-CAT-01 — Preserve item identity and versioned terms

Catalog items MUST retain an immutable machine code and a distinct kind: `plan`, `addon` or `service`. Prices, names used in documents, billing periods, entitlement effects and applicable policy references MUST belong to a version.

Published versions MUST NOT be edited in a way that changes issued offers, paid subscriptions or previously generated documents. Changes require a new version and, where applicable, an explicit future subscription transition.

Archiving an item MUST prevent new ordinary sales without revoking existing customer rights. Historical versions and document references MUST remain readable.

### FR-CAT-02 — Separate display names from document names

A catalog version MUST support localized display names and localized document names. Existing `nameRu` and `nameEn` may remain display names; suggested additional fields are `documentNameRu` and `documentNameEn`.

The display name may be short, for example “Markiro — Workshop.” The document name must describe the actual license right, service or work. New versions MUST have a valid Russian document name before publication for the current Russian sales scope. An English document name MUST be present before generating an English-language commercial document.

Legacy items may initially fall back to their existing names, with an explicit migration-review marker. This fallback MUST NOT alter already-issued documents.

### FR-CAT-03 — Distinguish catalog kind from the subject of sale

The model MUST distinguish the technical catalog kind from the documentary subject of sale. Suggested subject values are `software_license`, `service` and `development_work`.

Plans and license add-ons use `software_license`. Service items use a subject matching the actual engagement. A user-entered name or keyword MUST NOT serve as proof that a transaction is legally eligible for a tax regime.

The catalog in this scope MUST NOT offer third-party hardware, third-party license resale or intermediary payment collection as ordinary Markiro license items.

### FR-CAT-04 — Make publication a validated transition

Before publication, the system MUST validate names, monetary values, quantity semantics, billing mode and period, seller tax policy, entitlement keys, module dependencies, release availability and required lifecycle-policy references.

Errors MUST identify the affected field or dependency. Publication MUST fail atomically; a partly published item must not become assignable or billable.

The preview MUST show the actual period, total payable amount, VAT treatment, resource limits, included modules and major exclusions. A marketing description MUST NOT override structured entitlement data.

### FR-CAT-05 — Separate public availability from pilot assignment

Module availability MUST support at least `unavailable`, `pilot` and `generally_available` states, whether stored as those values or an equivalent existing release mechanism.

An unavailable module MUST NOT be sold as usable. A pilot module may be assigned only through explicit tenant eligibility and clearly identified pilot terms. A paid feature flag alone MUST NOT bypass release readiness.

A feature switch for future pallet operations may remain visible to platform staff as unavailable, but it MUST NOT imply working pallet aggregation.

---

## 6. Billing periods and money — P0

### FR-PER-01 — Persist the selected subscription period

Plans and license add-ons MUST support an explicit `month` or `year` billing period. The selected period MUST be submitted, stored, returned, displayed and applied consistently.

The unit label MUST NOT independently determine the entitlement term. For recurring licenses, the UI should derive the display unit from the explicit period and prevent contradictory combinations.

All create, edit, duplicate-version and offer/invoice paths MUST use the same rules. Fixing only `CatalogCreatePanel` is insufficient.

### FR-PER-02 — Treat annual price as the annual amount

For a plan priced at 69,000 RUB per year, one annual subscription MUST produce one annual entitlement term and a 69,000 RUB base charge before any explicitly applied adjustments. It MUST NOT produce a one-month term or multiply the annual price by twelve.

A displayed monthly equivalent is informational and MUST be calculated from the annual amount. It MUST NOT replace the invoice amount.

License add-on quantity represents resource units. Purchasing two additional device slots for one year grants two slots for that year; it does not extend one slot for two years.

### FR-PER-03 — Define calendar boundaries deterministically

Subscription validity MUST use start-inclusive, end-exclusive intervals. Store unambiguous timestamps and an explicit billing timezone; do not use the browser timezone as the billing authority.

Monthly and annual periods MUST use calendar arithmetic rather than fixed 30-day or 365-day durations. New paid terms use the explicit billing timezone `Europe/Moscow`. Preserve the original local day and time as the renewal anchor. Clamp a missing day to the last day of that month without replacing the original anchor: January 31 produces February 28 and then March 31; February 29 produces February 28 in a non-leap year and returns to February 29 in a leap year.

The server MUST calculate period boundaries. When the start is known at issuance, the document MUST contain the resolved interval. When activation depends on a future payment application, the issued document MUST instead retain the agreed duration and activation rule. The server MUST record the actual interval exactly once at activation, linked to the source document line; subscription records, activation records, subsequent documents that state the resolved interval, and entitlement snapshots MUST agree. Applying payment MUST NOT rewrite a previously issued document.

### FR-PER-04 — Separate payment, activation and renewal

A recurring catalog item MUST NOT imply permission for automatic card debits. Existing payment confirmation and manual invoice workflows remain valid. A base-plan order line represents one tenant subscription; increasing its quantity must not create overlapping base subscriptions. Multiple terms require explicit period selection or an expressly supported renewal order, not ambiguous multiplication of plan quantity.

License activation MUST follow the confirmed order policy: immediate activation begins at the server time when confirmed payment is applied, not the earlier bank payment timestamp; activation after the current term begins at its end. A delay in manual application must not silently shorten the purchased immediate term. Payment retries and repeated confirmation events MUST return the already-resolved interval and MUST NOT create duplicate periods or duplicate add-ons.

An add-on MUST NOT authorize new operations outside a valid base-subscription period. Monthly add-ons on annual plans may retain their own renewal dates, but their effective license interval is constrained by the base subscription and their own paid validity.

### FR-PER-05 — Keep changes commercially explicit

An immediate upgrade, future downgrade or early cancellation MUST have an explicit effective date and a preview of its monetary and entitlement consequences.

This release MUST NOT introduce hidden proration, refunds or overage charges. Where automated proration is not already supported and tested, the administrator must issue an explicit adjustment or quotation through the existing commercial workflow.

### FR-PER-06 — Use exact monetary calculations

Prices and calculated amounts MUST use decimal-safe arithmetic or integer minor units. Do not calculate payable totals using unrestricted binary floating-point operations.

The system MUST distinguish invoice quantity, entitlement quantity and service allowance. Rounding policy MUST be consistent between preview, stored line amounts and generated documents.

---

## 7. VAT and documentary safeguards — P0

### FR-TAX-01 — Derive defaults from the seller profile

The catalog editor MUST obtain applicable tax defaults from the Markiro seller profile, not from the customer profile and not from a hardcoded VAT rate.

For the current NPD seller profile and the ordinary domestic software-license and service sales covered by this specification, the required treatment is **Without VAT**. This must remain distinct from **VAT at 0%**. The Federal Tax Service describes the NPD VAT treatment and an import exception; imports are outside this scope. [S11]

Suggested compatibility mapping for the existing API is `vatRateBps: null` and `vatIncluded: false` for Without VAT. A numeric zero must continue to mean a zero rate where that treatment is otherwise applicable.

### FR-TAX-02 — Validate on the server and at document issuance

Disallowed VAT choices MUST be blocked or unavailable in the UI and rejected by the server. A modified request must not bypass seller policy.

Tax configuration MUST be checked when a catalog version is published and again when a new commercial document is issued. If the seller regime changed after the draft or quotation was prepared, issuance MUST stop for review rather than silently change the customer’s price or tax treatment.

Tax-policy changes MUST NOT rewrite historical documents. Store the relevant seller-profile revision and tax treatment in each issued document snapshot.

### FR-DOC-01 — Render contractual wording from controlled data

Document line names MUST be rendered from the versioned document name and a controlled set of values, such as the plan name, period and task reference. Do not evaluate arbitrary templates or executable expressions supplied as catalog text.

The system MUST retain a resolved line description in the issued-document snapshot. Subsequent renaming must not alter reprints.

Illustrative English wording, requiring commercial/legal review before use:

- License: “Grant of a non-exclusive right to use the Markiro computer program, Workshop plan, for [period].”
- Device add-on: “Grant of an additional right to use the Markiro computer program on one additional working device for [period].”
- Setup: “Installation and initial configuration services for the Markiro computer program on the customer’s equipment.”
- Development: “Adaptation and modification of the Markiro computer program under Statement of Work [reference], milestone [reference].”

Do not label a license payment as consultation merely to change its apparent classification.

### FR-DOC-02 — Preserve the distinction between commercial and tax documents

An invoice, offer, acceptance document or payment record MUST NOT be labeled as a My Tax receipt. If receipt-reference fields are added, they must refer to an actual separately issued receipt; this project does not implement receipt issuance. The Federal Tax Service describes receipt generation in My Tax. [S11]

---

## 8. Quantitative limits — P0/P1

### FR-QUO-01 — Introduce explicit zero, finite and unlimited values

For resource quotas, the contract MUST support:

| Value            | Meaning                                                  |
| ---------------- | -------------------------------------------------------- |
| `0`              | No resource allowance is included                        |
| Positive integer | A finite resource ceiling                                |
| `null`           | Unlimited commercially; technical safeguards still apply |

Reject negative numbers, fractions, nonfinite values, numeric coercion errors and values outside the supported database range. Apply the same semantics in database checks, request/response contracts, UI validation, billing snapshots and entitlement calculations.

The UI MUST present an explicit choice: **Not included / Limited / Unlimited**. An empty numeric field in Limited mode is invalid; it must not silently become unlimited.

### FR-QUO-02 — Preserve distinct trial semantics

`demoDurationDays` MUST NOT share the zero/unlimited quota interpretation.

For this release: a positive integer means the configured trial duration; `null` means that the plan has no configured automatic trial duration. Zero is invalid. Disabling trials must not create an unlimited trial.

Changing a plan’s trial duration MUST NOT restart or extend already-created trials. Renewal, device re-pairing or add-on purchase must not restart a trial.

### FR-QUO-03 — Calculate additive entitlements consistently

Effective finite quota equals the base quota plus the sum of active add-on increments multiplied by their quantities, plus explicit active quota grants.

For an unlimited base quota, the effective quota remains unlimited. Add-on increments MUST remain strictly positive integers; zero, negative and null increments are invalid. Detect arithmetic overflow before persistence or entitlement application.

Feature grants combine by logical OR among active applicable grants. A repeated feature grant must not disable another valid grant when one source expires.

The existing maximum effect count MUST be updated to match the supported entitlement registry, rather than remaining a hardcoded seven. Unknown keys and duplicate effects within one add-on remain invalid.

### FR-QUO-04 — Make resource counting explicit

Preserve existing counting semantics unless an explicitly approved migration changes them:

| Resource       | Required meaning in this release                                                                                      |
| -------------- | --------------------------------------------------------------------------------------------------------------------- |
| `stations`     | Shared count of license-reserving desktop-station and handheld records                                                |
| `kiosks`       | Separately counted active/license-reserving kiosks                                                                    |
| `cabinetUsers` | Current members plus valid pending invitations, without double-counting an accepted invitation                        |
| `lines`        | Existing line-counting behavior; do not silently reinterpret this as sites, warehouses or concurrent production lines |

Show how usage is counted. Operators authenticating on a device MUST NOT consume additional cabinet-user slots unless they actually hold a cabinet membership.

### FR-QUO-05 — Enforce quota changes atomically

Creating or reserving the last available resource slot MUST be checked in the same transactional boundary as consuming it. Concurrent requests must not both obtain the last slot.

Invitations, API-based resource creation, device reactivation and administrative workflows MUST use the same quota rules. A trusted platform override must be explicit, permission-controlled and audited rather than bypassing the calculation invisibly.

Zero cabinet-user capacity must not lock an existing tenant owner out of the specifically permitted billing, export and recovery functions. Publication validation must flag plans that cannot support their intended administrative workflow.

---

## 9. Feature-entitlement registry — P1

### FR-MOD-01 — Add the following four commercial features

| Catalog field           | Effective key    | Scope                                                                                                                                      |
| ----------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `chzIntegrationEnabled` | `chzIntegration` | One module: supported Chestny ZNAK operations and National Catalog external card retrieval, import proposals and import/update application |
| `inventoryEnabled`      | `inventory`      | New inventory and repacking tasks and their supported execution modes                                                                      |
| `commerceMlEnabled`     | `commerceMl`     | Existing standard CommerceML/1C connector                                                                                                  |
| `handheldEnabled`       | `handheld`       | New handheld enrollment and handheld operational access, within shared device quota                                                        |

Preserve existing `labelEditor`, `publicApi` and `pallets` keys. The new keys must be supported through the full plan/add-on pipeline, not only as form fields.

There MUST NOT be a separate commercial `nationalCatalogImport` entitlement, plan switch or mandatory National Catalog add-on. Operational capability names for catalog lookup, import and update may remain separate from other Chestny ZNAK operations; they are not separately sold feature rights in this release.

All new catalog drafts MUST have explicit feature values. Legacy customers must be migrated under Section 17 rather than defaulted to denied access.

### FR-MOD-02 — Version the operations behind a module

A module grant MUST resolve to a documented set of operational capabilities. A broad “Chestny ZNAK integration” entitlement must not automatically grant every future regulatory operation.

At minimum, distinguish retrieval/status/export operations from future external document submission. When a materially new operation is introduced, its commercial inclusion must be an explicit versioning or migration decision.

Operation names may follow the existing codebase, but each protected operation must be traceable to its entitlement requirements and release status.

### FR-MOD-03 — Keep public API separate from internal product clients

`publicApi` governs customer-facing API access. Disabling it MUST NOT disable the tenant cabinet, station protocol, handheld protocol, kiosk protocol, signer agent or shared authentication required by included native integrations.

Conversely, an existing customer API key MUST NOT bypass a disabled public API entitlement. Check use of the key, not only creation of new keys.

A public API operation affecting a gated module requires both public API entitlement and the corresponding module entitlement. Existing key scopes and user/device authorization remain mandatory.

### FR-MOD-04 — Keep CommerceML independent

The standard CommerceML connector MUST be controlled by `commerceMl`, independently from generic public API access. Its credential purpose and routes must remain scoped to the connector.

If an existing credential infrastructure is shared, use explicit credential purpose and permitted-route mapping. Do not enable arbitrary API calls merely because CommerceML is included.

### FR-MOD-05 — Use one commercial module and a shared connection

The `chzIntegration` entitlement MUST cover both the supported Chestny ZNAK operations and National Catalog functionality listed in FR-MOD-01. The customer-facing module name MUST make this inclusion clear. A customer must not purchase or receive a second commercial entitlement merely to import National Catalog cards.

Reuse the existing Chestny ZNAK connection, tenant-scoped authentication and Signer/token-refresh infrastructure. Keep commercial entitlement, connection readiness, external permissions and operation release eligibility distinct. A successful shared authentication session MUST NOT authorize an unavailable operation or bypass its capability and principal checks. Future external document submission is not automatically included merely because the unified module is enabled.

When `chzIntegration` is false, new controlled Chestny ZNAK and National Catalog operations MUST be denied. Feature withdrawal MUST NOT delete the connection credentials, imported customer data or retained evidence; result retrieval and other already-authorized work follow the bounded recovery policy in Section 12. Connection and credential revocation for security remain separate controls.

### FR-MOD-06 — Enforce each National Catalog action

Check the unified `chzIntegration` entitlement and the applicable operational capability when starting a fresh external lookup, creating an import proposal and applying an import or external update. An old proposal must not become a bypass after entitlement removal.

Previously imported product data and retained snapshots MUST remain readable and usable in ordinary authorized production workflows. Disabling import must not delete or invalidate the customer’s own catalog.

### FR-MOD-07 — Gate new inventory work without stranding existing work

`inventory` governs creating and starting new inventory/repacking tasks. In this release, checking and repacking are one commercial module; do not add per-inventory charges or separate mode pricing.

An inventory populated from a customer-provided file does not require the unified `chzIntegration` entitlement. Requesting a fresh direct Chestny ZNAK export requires both `inventory` and `chzIntegration`, plus the applicable released export capability. National Catalog import is included in that same commercial `chzIntegration` module.

Reading historical inventory results, uploading previously authorized events and completing permitted recovery are governed by the recovery policy. Generating a local document for a frozen existing result is distinct from sending a new document to an external regulator.

### FR-MOD-08 — Preserve core production functionality

Disabling label editing MUST NOT prevent printing an already-authorized, retained template. Disabling future pallet functions MUST NOT disable ordinary box aggregation.

Basic code validation, duplicate detection, local journaling, integrity checks and required recovery safeguards MUST NOT become optional premium safety features.

---

## 10. Working-device licensing — P1

### FR-DEV-01 — Use a shared station and handheld quota

The external UI label for `maxStations` MUST communicate **Working devices: stations and handhelds**. Keep the existing wire/storage key where feasible to avoid unnecessary compatibility changes.

One desktop station consumes one slot. One handheld consumes one slot. A scanner or printer attached to that device does not consume another slot. Different operators using the same device do not consume additional device slots.

Kiosks remain separate. No separate `maxHandhelds` ceiling or second mandatory mobile-license charge is introduced in this release.

### FR-DEV-02 — Require feature access and capacity for handheld enrollment

New handheld enrollment requires `handheld`, an available shared device slot, the correct device identity/capability handshake and ordinary tenant authorization.

A handheld must not pair as a desktop device to bypass restrictions. Pairing must preserve the existing kind/client compatibility check. Changing the device kind after pairing must not silently change license identity.

### FR-DEV-03 — Show slot lifecycle accurately

Expose at least the concepts of **Reserved**, **Paired** and **Retired/Revoked**, mapping them to existing states where possible.

A non-revoked reservation consumes a slot, consistent with the current model. Going offline does not release it. Unused reservations may be cancelled explicitly and must then release capacity atomically.

Do not introduce automatic reservation expiry or disconnect-based reclamation without a separately specified policy and migration.

### FR-DEV-04 — Support replacement and re-pairing

Re-pairing the same durable device record MUST rotate credentials without charging or counting a second slot. Replacing a device MUST offer a deliberate transfer workflow that retires the old operational authority and identifies outstanding local data.

Do not erase journals, outboxes, unresolved print work, inventory evidence or stable idempotency identifiers as a side effect of a commercial device transfer.

When an old device cannot upload because its credential was revoked for security, recovery must use an authorized re-pairing or administrator-mediated evidence-import path. An expired license must not make a revoked credential valid again.

### FR-DEV-05 — Make downgrade selection deterministic

When a future quota is below current usage, the customer or authorized platform user MUST be able to select which devices retain permission to start new work.

The system MUST NOT pick devices randomly, delete them or revoke security credentials purely to resolve billing overage. Devices outside the retained set become recovery-only under the commercial policy.

If no selection is made by the effective date, use the explicit fallback in Section 12; never silently retain a more expensive plan or create an overage charge.

---

## 11. Entitlement evaluation and enforcement — P1

### FR-ACC-01 — Use one authoritative decision model

Extend the existing entitlement service and shared contracts. All enforcement paths MUST derive decisions from the same effective entitlement calculation at a specified time.

A new operation is allowed only when tenant isolation, principal authorization, commercial validity, required feature rights, applicable resource capacity and release/configuration prerequisites are satisfied.

Evaluate authorization before exposing sensitive tenant or subscription details. Commercial grants must never override a security denial.

### FR-ACC-02 — Enforce beyond UI visibility

Checks MUST cover HTTP endpoints, existing API keys, station/handheld/kiosk commands, connector routes, scheduled tasks, background workers and alternative ways of performing the same business action.

A GET request that starts an external lookup or incurs a controlled operation must not be treated as harmless merely because of its HTTP method. Each affected route/job must have an explicit operation classification.

Perform the decisive check near the state transition or external side effect. A queued job must not rely indefinitely on the entitlement result from when its UI button was displayed.

### FR-ACC-03 — Explain denials consistently

The system MUST distinguish at least:

| Reason                           | Customer-facing meaning                                              |
| -------------------------------- | -------------------------------------------------------------------- |
| Feature not included             | The current commercial entitlement does not include this module      |
| Subscription not active          | New operations are unavailable under the current lifecycle state     |
| Resource quota reached           | All licensed slots are used or reserved                              |
| Insufficient permissions         | The principal lacks the required role or scope                       |
| Integration not configured       | Commercial rights exist, but connection setup is incomplete          |
| Module unavailable or pilot-only | Release availability prevents ordinary use                           |
| Technical throttling             | Retry or wait; buying a plan is not automatically the remedy         |
| Client update required           | This client cannot safely enforce or interpret the required contract |
| Recovery-only device/task        | Existing evidence can be reconciled, but new work cannot begin       |

Reuse existing domain error codes where possible. New machine-readable details must follow the established safe error envelope and be introduced compatibly. Do not leak credentials, request bodies or raw marking codes into error messages or logs.

### FR-ACC-04 — Invalidate decisions safely

Changes to a subscription, add-on, explicit grant, device assignment or release availability MUST change the relevant decision revision and invalidate cached online decisions.

Expiration must be calculated from timestamps even if a scheduled job or notification failed. The job that marks a row expired cannot be the only enforcement mechanism.

Clients must refresh on startup/reconnection and before online admission of new controlled work. Offline validity is governed by the issued grant, not by an indefinitely cached boolean.

### FR-ACC-05 — Keep production tenants explicitly managed

Ordinary production tenants MUST have an explicit subscription or an explicit managed free/pilot arrangement. `unmanaged` must not function as an invisible commercial bypass.

A readiness report MUST identify unmanaged tenants before full enforcement is enabled. Development/test exceptions must be environment-scoped and visible. Do not enable global strict enforcement until migration and recovery validation are complete.

---

## 12. Subscription lifecycle, offline operation and recovery — P1

### FR-LIF-01 — Define operational states without replacing history

The implementation MUST expose the operational meaning of pending, scheduled, trial, active, grace, expired/read-only, recovery-only and security-suspended conditions. These may be a projection of existing persisted states and policy timestamps; replacing the existing subscription status model is not required.

| Condition                                    | Start new work                                              | Enroll devices         | Recover prior work                                 | Read retained customer data            |
| -------------------------------------------- | ----------------------------------------------------------- | ---------------------- | -------------------------------------------------- | -------------------------------------- |
| Pending or future-only subscription          | No                                                          | No                     | Only previously authorized evidence, if any        | According to existing access rights    |
| Active or valid trial                        | Yes, within rights                                          | Yes, within rights     | Yes                                                | Yes                                    |
| Explicit billing grace                       | Existing-device work only, if the configured policy permits | No                     | Yes                                                | Yes                                    |
| Expired or feature withdrawn                 | No affected new work                                        | No affected enrollment | Bounded recovery only                              | Yes, within retention/access policy    |
| Commercially deactivated device              | No                                                          | Not applicable         | Bounded recovery only                              | Through permitted device/cabinet paths |
| Security suspension or credential revocation | No                                                          | No                     | Only through an independently authorized safe path | According to security authorization    |

### FR-LIF-02 — Make lifecycle policy explicit

New sellable plans MUST reference a versioned policy covering grace, offline validity, task-completion boundaries and post-expiry data access/retention references.

The safe default for additional billing grace is zero. Any nonzero grace is an explicit commercial decision. Existing customer terms must not be shortened by this default.

Offline grant duration and task-completion limits require an approved operational configuration before strict enforcement is activated. The system must not invent values from a price tier. Retention remains governed by existing approved data policies and contracts; this specification does not introduce a shorter retention period.

### FR-LIF-03 — Issue bounded, integrity-protected offline grants

Desktop and handheld clients MUST persist a server-signed grant that can be validated without contacting the server. Reuse an existing equivalent mechanism where available. Verification material may be distributed to clients; the server signing secret must not be. The technical design must specify the accepted signature format, key identifiers, rotation and treatment of unknown or retired verification keys.

A grant must identify the tenant, durable device, credential generation, entitlement/policy revision, permitted capabilities, issuance time and validity boundaries. Task-specific authority must additionally identify the task and immutable snapshot or equivalent bounded scope.

Grant validity for starting new work must not exceed the effective paid/trial/grace interval or the approved maximum offline interval. New work after the known boundary is blocked; already-recorded evidence is retained.

The implementation MUST detect a detectable backward clock change and must not extend a grant merely because the local clock was changed or the application restarted. It must document limitations after reboot or on a tampered device. An offline token cannot provide instantaneous remote revocation, and this release must not claim otherwise.

### FR-LIF-04 — Bound completion of already-authorized tasks

A recovery allowance must be tied to an identifiable task authorized before the relevant restriction. It must include a completion deadline and enforce the task’s frozen scope, allowed event types and applicable quantity/snapshot constraints.

Do not allow a customer to keep one old shift open indefinitely, replace its product, expand its task scope or create unrelated tasks under the same recovery grant.

Finishing an open physical container or a frozen inventory task must follow the issued policy. After its processing boundary, no new productive work is admitted; pending acknowledgements, evidence uploads and safe reconciliation remain separately handled.

### FR-LIF-05 — Preserve evidence independently from operational acceptance

Subscription expiration, downgrade, feature removal or payment failure MUST NOT delete local journals or pending outboxes.

With valid recovery authentication, already-recorded batches must be accepted for validation and durable evidence retention using existing idempotency and digest rules. Receiving evidence does not automatically mean accepting it as valid production output or sending it to a regulator.

Late, conflicting, unprovable or out-of-scope events must be retained in a bounded quarantine/review path instead of silently discarded. A device timestamp alone is not proof of entitlement at the time of work.

A processing deadline must not itself trigger destruction of evidence that has not yet been reconciled. Applicable storage and security policies still apply.

### FR-LIF-06 — Classify asynchronous work by side effect

| Job state/action                                         | Required expiration behavior                                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| New external request not yet dispatched                  | Recheck current authorization before dispatch; stop if unavailable                                            |
| External operation already submitted                     | Continue retrieving and preserving its result within the existing operation scope                             |
| Retry that could create a new external operation         | Treat as a new controlled action unless the provider guarantees continuation of the same authorized operation |
| Local document generation for a frozen authorized result | Permit under bounded completion/recovery policy                                                               |
| Submission of a new regulatory document                  | Require current permission and supported capability; local export permission is not sufficient                |
| Upload/reconciliation of existing device evidence        | Preserve and process through the recovery path                                                                |

Job records must retain authorization provenance, external operation identifiers and idempotency data where applicable. Commercial expiration must not cause duplicate external submissions.

### FR-LIF-07 — Preview and execute downgrades safely

A downgrade preview MUST show future features, resource ceilings, current usage, affected devices, active tasks, active add-ons, scheduled services and the exact effective time.

The transition must not delete resources or retroactively invalidate completed work. Losing feature access applies to new affected operations; prior work follows its bounded recovery policy.

If a device selection is still unresolved at the effective date, mark the affected device pool over-limit and block admission of new device work until an authorized retained set is selected. Preserve recovery. Do not choose an arbitrary retained set, extend the old plan for a fee or auto-purchase add-ons.

For an over-limit cabinet-user quota, block new invitations/activations that increase usage while preserving existing authorized read, billing and recovery access. Any further user deactivation policy requires an explicit selection rather than random removal.

### FR-LIF-08 — Restore rights on renewal without duplicating work

Confirmed renewal or an authorized extension MUST restore eligible online operations and allow refreshed offline grants. It must not reset task histories, replay successful external submissions, duplicate device identities or re-count already-consumed service minutes.

Queued evidence must continue from existing idempotency identities. A newly active subscription does not retrospectively legitimize quarantined events automatically.

### FR-LIF-09 — Notify without relying on notifications for enforcement

Support configurable advance-expiry, trial-end, scheduled-downgrade, over-limit and transition-to-read-only notifications. Show dates and the expected operational effect in the tenant cabinet.

Notifications must be idempotent and must not expose billing information to ordinary operators. Operational device warnings may explain local admission/recovery status without showing prices or confidential contract terms.

---

## 13. Effective rights and customer-specific grants — P1

### FR-ADM-01 — Explain the effective result

Provide an effective-rights view for platform staff and an appropriately limited view for tenant administrators. It MUST show the current plan/version, active period, feature availability, quantities, usage, remaining finite capacity and next scheduled change.

For every effective right, show its source: base plan, paid add-on, temporary grant or migration compatibility assignment. Distinguish licensed, configured and operationally available states.

For unlimited quantities, display Unlimited rather than a fabricated large number. For zero, display Not included. Historical calculations must use an explicit “as of” time and remain read-only.

### FR-ADM-02 — Support explicit, auditable grants

Support temporary feature grants and positive quota increments with a tenant, effective interval, reason, actor and reference to the commercial/pilot decision.

Temporary grants require an end time. Long-term free arrangements must be explicit managed plans or reviewed assignments, not an expired temporary grant or unmanaged bypass.

A temporary grant must not extend the underlying base subscription unless the administrator performs a separate, explicit subscription extension. Expiring one grant must not remove an entitlement still provided by another active source.

Negative commercial overrides are excluded from this release. Security suspension and operational kill switches remain separate controls.

### FR-ADM-03 — Audit commercial mutations

Audit publication, price/version changes, assignments, activation, add-on changes, grants, scheduled changes, tax-profile changes, device license transfers and service-allowance corrections.

Record actor, tenant where relevant, object identifiers, effective time, reason, safe before/after values, related order/document and request correlation ID. Do not place external access tokens, private keys or raw production datasets in audit metadata.

### FR-ADM-04 — Preview changes before applying them

Administrative changes that reduce rights or alter billing MUST have a preview and explicit confirmation. The preview must be tied to a revision; if relevant data changes concurrently, the server must recompute or reject the stale application.

Applying the same confirmed command twice must not duplicate grants, chargeable items or scheduled transitions.

---

## 14. Recurring services and service allowances — P2

### FR-SVC-01 — Support service recurrence as a first-class concept

Extend service catalog versions to support recurring service engagements in addition to one-time services. Monthly recurring services are mandatory for this phase. Annual services may be published only when their allowance-replenishment policy is explicitly implemented and tested.

Update database constraints, shared contracts, item editors, offers, invoices, payment application, fulfillment, tenant views and documents. A unit label of Month must not be used as a substitute for a recurring service model.

A service item does not grant software features unless a separate license item in the order does so.

### FR-SVC-02 — Create period-bound service orders

Each paid service period MUST have a unique entitlement to service delivery linked to the service-version snapshot, tenant, order/payment source and period boundaries.

Payment application must create or activate that period once. There must be no duplicated allowance on a retry, reissued notification or regenerated document.

The next period must not receive a paid allowance merely because a scheduler ran. It requires the applicable payment or an explicit authorized commercial arrangement.

### FR-SVC-03 — Represent the allowance explicitly

A support package may define included minutes, service scope, operating hours, scheduling terms, carryover policy and the process for approving excess work.

For a first monthly package, the recommended default is no carryover and no automatic overage billing, subject to approval before publication. Do not infer an allowance or guaranteed response time from the plan name.

An annual invoice must not silently cause twelve monthly budgets to be granted immediately. Billing interval and allowance-replenishment interval must be explicit before an annual support package is enabled.

### FR-SVC-04 — Maintain an append-only service ledger

Each usage entry MUST identify tenant, service period, operator, work reference, description, actual minutes, billable minutes and posting time.

Corrections must be compensating entries linked to the original, not silent edits. Prevent duplicate posting and concurrent allowance overspend unless an explicit approved excess-work order exists.

The customer-visible ledger must explain remaining minutes and the work charged against the allowance. Internal notes may be restricted separately.

### FR-SVC-05 — Do not charge for product-defect correction

Work classified as correction of a Markiro product defect must not consume a customer’s paid consultation allowance. Customer-requested configuration, data assistance, additional instruction or custom development may consume it when within the agreed service scope.

Classification must be recorded and correctable through an audited process. Do not automatically convert all support messages or diagnostic time into billable work.

### FR-SVC-06 — Require approval for excess work

When an allowance is insufficient, the system MUST indicate the deficit before additional chargeable work is posted. Excess work requires an explicit customer approval and associated order or agreed billing instruction.

Do not generate surprise charges or promise 24/7 support based on a generic support-package flag. Service cancellation and unused allowance follow the recorded service policy, not the license feature resolver.

---

## 15. User interface requirements

### FR-UI-01 — Organize catalog editing by meaning

The create/edit form SHOULD use the following sections:

| Section                   | Main content                                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Identity and presentation | Code, item kind, localized display names, localized document names, description                                  |
| Commercial terms          | Subject of sale, price, billing mode, actual billing period, service unit where relevant, VAT from seller policy |
| Resource limits           | Explicit zero/finite/unlimited controls; Working devices label; separate kiosks                                  |
| Included modules          | Existing and new feature switches with availability indicators and dependency explanations                       |
| Lifecycle policy          | Trial duration and references to approved grace/offline/recovery policies; show resolved values                  |
| Preview and validation    | Customer-facing summary, document line, effective rights and publication errors                                  |

Do not place advanced technical throttle values among commercial feature switches. Avoid duplicated page titles and redundant close controls when revising the existing drawer, but do not turn this work into an unrelated visual redesign.

### FR-UI-02 — Validate and preserve user input

Show field-level errors without clearing entered values. Prevent duplicate submission. Preserve dirty-state confirmation when closing a form.

All new controls and messages MUST have Russian and English translations. Keyboard access and clear focus behavior must be retained. The price and period preview must update together.

### FR-UI-03 — Present module state accurately

Distinguish Not included, Included but not configured, Ready, Pilot, Temporarily unavailable and Recovery only where applicable.

Show an upgrade/request-change action only for an actual commercial restriction. For missing setup, show setup guidance; for insufficient permissions, explain authorization; for technical throttling, show retry/wait information.

### FR-UI-04 — Expose usage and upcoming changes

The tenant subscription page MUST show devices used/reserved, included limits, relevant add-ons and upcoming entitlement changes. Device lists must identify which records consume a slot.

The platform customer page must additionally show entitlement provenance, compatibility grants, historical decisions and audited administrative actions. Tenant users must not gain access to other tenants or internal seller-only notes.

---

## 16. Technical contract and implementation requirements

### TR-01 — Extend the shared contract end to end

Use the existing shared contract package as the schema authority. Update request validation, response parsing, OpenAPI descriptions, database enums/checks, fixtures, UI types and offline-client contract handling together.

The logical contract must cover the following:

| Area                 | Required data                                                                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Catalog version      | Display/document names, item kind, subject of sale, actual billing mode/period, exact price, tax treatment, entitlement effects, policy references |
| Plan quotas          | `maxLines`, `maxStations`, `maxKiosks`, `maxCabinetUsers` as nonnegative integer or null                                                           |
| Features             | Existing three keys plus the four keys in Section 9; `chzIntegration` includes National Catalog operations                                         |
| Effective access     | As-of time, revision, source plan/period, effective features and quotas, usage, operational availability and next change                           |
| Grant                | Source, reason, actor, interval, explicit effects and audit linkage                                                                                |
| Device authorization | Device identity/generation, bounded offline authority, task scope and recovery rules                                                               |
| Recurring service    | Versioned engagement, paid period, allowance policy, fulfillment state and usage ledger                                                            |

Do not publish fields to strict legacy parsers without a compatibility strategy.

### TR-02 — Separate entitlement data from operational availability

An entitlement response must not claim an integration is ready merely because a paid flag is true. Keep fields such as licensed access, release eligibility and connection readiness distinguishable.

The same distinction must exist internally even if the UI presents a combined status. This prevents a shared connection being disabled by the wrong commercial switch.

### TR-03 — Keep mutations transactional and idempotent

Use existing locking and idempotency conventions for quota changes, commercial application, device transfer, downgrade selection and service-period creation.

A failed operation must not leave an invoice applied without its entitlement, a consumed device slot without a record, or a posted allowance without a corresponding service period. Database-backed concurrency tests are required for the affected transitions.

### TR-04 — Keep technical policies noncommercial by default

Maintain separate configuration for external request frequency, provider task quotas, job concurrency, import-size limits, retry policy and storage safeguards.

Do not introduce paid limits on individual codes, scans, boxes, inventories, ordinary exports or operator identities in this project. Collect usage telemetry for future capacity decisions without silently charging for it.

If a provider quota is exhausted, queue or reject with the relevant technical reason. Do not imply that a higher Markiro plan can override an external-provider limit.

### TR-05 — Protect sensitive data

Commercial inspection and audit endpoints must enforce tenant/platform boundaries. Never include private keys, certificate material, access tokens, full bank account details or raw production evidence in routine telemetry.

Offline grants must contain only the information needed for authorization and must be integrity-protected. Client-side capability flags are not an authorization source.

### TR-06 — Provide operational observability

Expose metrics or structured diagnostic events for denied operations by reason, quota contention, unmanaged tenants, expired-grant attempts, recovery backlog, quarantined batches, entitlement refresh failures and duplicate billing-application attempts.

Separate security failures, commercial restrictions and infrastructure errors. Dashboards must not misclassify a legitimate expiry as a platform outage, or a lost recovery queue as a normal billing denial.

---

## 17. Migration, compatibility and rollout

### MIG-01 — Produce an impact report before changing enforcement

Inventory active and future subscriptions, add-ons, unpaid offers/invoices, trials, free pilots, unmanaged tenants, paired/reserved devices, legacy client versions and recurring service-like items.

Identify catalog entries whose annual unit conflicts with the stored monthly period, items with suspect VAT defaults, missing document names and customers that would lose module access under default-false fields.

Repository code alone is not sufficient to determine these production-data cases.

### MIG-02 — Preserve historical monetary and contractual records

Do not bulk rewrite existing paid invoices, issued document snapshots, historical names, amounts, taxes or dates.

Suspect historical monthly/annual records must be flagged for review. Correct future entitlement or billing treatment only through an explicit, audited decision; never infer the customer’s agreement solely from the unit label.

### MIG-03 — Preserve existing quota meanings

Existing null resource quotas remain unlimited. Do not convert null to zero during migration.

Add zero support to contracts and database checks before publishing zero-quota plans. Keep trial-duration validation separate. Update add-on enums and effect-shape checks without weakening unrelated constraints.

### MIG-04 — Preserve existing feature access through explicit compatibility policy

Adding four default-false feature columns must not unexpectedly disable existing customers.

Before enforcement, generate a reviewed compatibility assignment that preserves the customer’s previously authorized module scope and applicable release eligibility. A valid implementation may use a versioned legacy compatibility profile, a new explicitly assigned plan version or an audited grant. It must not silently mutate the meaning of a historically published version.

A compatibility assignment for the unified `chzIntegration` module MUST preserve the previously authorized National Catalog and Chestny ZNAK operation scope. Consolidating the commercial feature MUST NOT silently grant additional operations to legacy customers; preserve any required operation-specific compatibility constraints explicitly.

Do not infer rights only from whether a customer used a feature recently. Also do not grant unavailable future operations. Unmanaged pilots must become explicit managed arrangements before strict production enforcement.

### MIG-05 — Support rolling client upgrades

Define a compatibility matrix for the backend, SaaS admin, tenant cabinet, desktop station, kiosk and handheld clients.

Add capability negotiation or response-version handling where required. Old clients may continue previously safe workflows during migration but must not receive new capabilities they cannot enforce. A required-update state must preserve read/export/recovery paths that remain technically safe.

Strict object parsers must be tested against both legacy and new payloads. Newly required fields must not be introduced without a staged compatibility plan.

### MIG-06 — Roll out in stages

Recommended sequence:

1. Add backward-compatible schema and contracts.
2. Fix P0 editors and document validation.
3. Backfill reviewed mappings and produce impact reports.
4. Deploy clients capable of interpreting new entitlements and recovery grants.
5. Run shadow evaluation, logging would-be commercial denials without applying new restrictions.
6. Enable enforcement for selected pilot tenants and verify real recovery scenarios.
7. Enable for additional managed tenants after approval and monitoring.
8. Enable recurring services only after P2 acceptance.

Shadow mode must not bypass existing security or tenant checks. Do not apply a new restriction silently to a customer solely because deployment completed.

### MIG-07 — Provide a non-destructive rollback

Rollback must be able to disable newly introduced commercial enforcement per module/tenant while retaining existing security controls, quota integrity, billing history and evidence.

Do not revert the production fleet to unrestricted unmanaged access. Do not roll the schema back to a version that cannot read newly stored zero quotas or recurring-service records. Retain a compatible server/recovery path while clients or feature rollout are reverted.

---

## 18. Acceptance criteria

Each test must link to the requirement IDs and produce repeatable evidence. The examples below define minimum coverage, not a substitute for existing tests.

### 18.1 Catalog, periods and tax

| ID    | Scenario                                                                    | Expected result                                                                     | Requirements         |
| ----- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------- |
| AC-01 | Create a plan with zero kiosks                                              | Save/publish succeeds; kiosk creation is denied with a quota explanation            | FR-QUO-01, FR-QUO-05 |
| AC-02 | Choose Unlimited for devices                                                | API stores null; UI displays Unlimited; unrelated technical limits remain in force  | FR-QUO-01, TR-04     |
| AC-03 | Leave a Limited quantity empty; submit negative/fractional values           | Validation fails consistently in UI and API; no implicit unlimited value            | FR-QUO-01            |
| AC-04 | Add two copies of a one-device add-on to a base quota of three              | Effective capacity is five; repeated payment application does not increase it again | FR-QUO-03, FR-PER-04 |
| AC-05 | Submit duplicate, unknown or too many add-on effects                        | Validation follows the actual registry; duplicates/unknown keys fail                | FR-QUO-03, TR-01     |
| AC-06 | Create a 69,000 RUB annual plan through the UI and pay for one term         | Stored period is year; amount is 69,000; entitlement duration is one calendar year  | FR-PER-01, FR-PER-02 |
| AC-07 | Renew month-end and leap-day subscriptions                                  | Boundaries use the configured timezone and original calendar anchor without drift   | FR-PER-03            |
| AC-08 | Create a one-time setup item measured in hours                              | It does not become a recurring subscription or create license rights                | FR-CAT-03, FR-PER-06 |
| AC-09 | Open the catalog editor under the NPD seller profile                        | Without VAT is selected; zero-rated VAT is not treated as equivalent                | FR-TAX-01            |
| AC-10 | Modify a request to submit disallowed VAT; issue a stale-tax-policy draft   | Server rejects the request or stops issuance for review                             | FR-TAX-02            |
| AC-11 | Rename a published item or change the seller profile after invoice issuance | Historical document wording, amount and tax snapshot remain unchanged               | FR-CAT-01, FR-DOC-01 |
| AC-12 | Disable automatic trials or re-pair a device during a trial                 | No unlimited or restarted trial is created                                          | FR-QUO-02            |

### 18.2 Modules and devices

| ID    | Scenario                                                                                | Expected result                                                                                                                                                        | Requirements                    |
| ----- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| AC-13 | Public API is disabled while native clients and included integrations operate           | Native station, handheld, kiosk and permitted integrations continue; customer API-key usage is denied                                                                  | FR-MOD-03                       |
| AC-14 | CommerceML is included but generic public API is not                                    | The scoped connector works; arbitrary API access remains denied                                                                                                        | FR-MOD-04                       |
| AC-15 | Enable the unified Chestny ZNAK module and configure its shared connection              | Eligible National Catalog import and supported CHZ operations use one commercial entitlement; no second purchase is required; unavailable operations remain denied     | FR-MOD-01, FR-MOD-02, FR-MOD-05 |
| AC-16 | Remove `chzIntegration` after creating a National Catalog proposal                      | Applying the proposal and starting new controlled CHZ/NC operations are denied; previously imported products remain usable and eligible prior work remains recoverable | FR-MOD-05, FR-MOD-06            |
| AC-17 | Inventory is included but the unified CHZ module is not                                 | File-based inventory works; requesting a new direct CHZ export is denied                                                                                               | FR-MOD-07                       |
| AC-18 | A public API call targets a disabled inventory module                                   | A valid API key does not bypass the inventory entitlement                                                                                                              | FR-MOD-03, FR-ACC-02            |
| AC-19 | The plan includes three working devices; enroll two desktop stations and one handheld   | All three share the same quota; a fourth device cannot reserve a slot                                                                                                  | FR-DEV-01, FR-DEV-02            |
| AC-20 | Handheld access is disabled; submit a handheld enrollment or mismatched pairing request | Enrollment/pairing fails; desktop identity cannot be used as a bypass                                                                                                  | FR-DEV-02                       |
| AC-21 | Two requests concurrently reserve the final slot                                        | Exactly one succeeds and one resource is created                                                                                                                       | FR-QUO-05                       |
| AC-22 | A device goes offline; another operator signs in                                        | Slot usage remains unchanged; no additional license is charged                                                                                                         | FR-DEV-01, FR-DEV-03            |
| AC-23 | Re-pair the same device or transfer a license from an old device                        | No double-counted slot; credential generations and outstanding evidence are handled safely                                                                             | FR-DEV-04                       |
| AC-24 | A paid plan includes an unavailable or pilot-only module                                | Ordinary sale/use is blocked or explicitly restricted to eligible pilot terms                                                                                          | FR-CAT-05                       |
| AC-25 | Label editor is disabled but an existing template is needed for authorized work         | Printing remains available; editing is denied                                                                                                                          | FR-MOD-08                       |

### 18.3 Lifecycle, authorization and recovery

| ID    | Scenario                                                                             | Expected result                                                                                          | Requirements         |
| ----- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | -------------------- |
| AC-26 | Subscription expires while a station has unsent authorized scans                     | New work follows the boundary; pending evidence is retained and reconciled after reconnection            | FR-LIF-03, FR-LIF-05 |
| AC-27 | Expiry occurs during a frozen inventory task                                         | Only bounded task completion/recovery is available; a new task cannot be created                         | FR-LIF-04            |
| AC-28 | Client backdates an event or changes the local clock                                 | Timestamp alone does not prove authorization; grants are not extended; suspect evidence is quarantined   | FR-LIF-03, FR-LIF-05 |
| AC-29 | Restart the offline client after entitlement expiry                                  | Restart does not reset validity, lose outboxes or grant new work                                         | FR-LIF-03            |
| AC-30 | A queued external request has not been dispatched when rights expire                 | Dispatch is rechecked and blocked unless separately authorized under the defined policy                  | FR-LIF-06            |
| AC-31 | A CHZ operation was already submitted before expiry                                  | Its result can be retrieved and preserved without creating a duplicate external operation                | FR-LIF-06            |
| AC-32 | A retry might submit a new external document                                         | Current authorization is required; recovery is not an unlimited submission bypass                        | FR-LIF-06            |
| AC-33 | Device credential is revoked for security while its license is paid                  | Security denial wins; safe recovery requires a separate authorized path                                  | FR-DEV-04, FR-LIF-01 |
| AC-34 | Downgrade six devices to three with a confirmed retained set                         | Only selected devices start new work after the boundary; all eligible prior evidence remains recoverable | FR-DEV-05, FR-LIF-07 |
| AC-35 | The downgrade boundary arrives without device selection                              | Affected pool is over-limit; new admission waits for selection; no random deletion or automatic purchase | FR-LIF-07            |
| AC-36 | One of two overlapping feature grants expires                                        | Access persists if another applicable grant remains active                                               | FR-QUO-03, FR-ADM-02 |
| AC-37 | Temporary module grant remains dated beyond the base subscription                    | It does not extend base access implicitly                                                                | FR-ADM-02            |
| AC-38 | Scheduled expiry processing fails or a cached online result is stale                 | Timestamp-based decisions still deny new unauthorized work                                               | FR-ACC-04            |
| AC-39 | Call an affected endpoint directly or invoke a worker outside the UI path            | Identical commercial and security checks apply                                                           | FR-ACC-02            |
| AC-40 | Renew after expiry and resend an already-acknowledged batch                          | Access restores; successful batch/application effects are not duplicated                                 | FR-LIF-08            |
| AC-41 | Attempt to expand a recovery task or keep it open beyond its permitted work boundary | New productive scope is rejected; existing evidence is preserved for review                              | FR-LIF-04, FR-LIF-05 |
| AC-42 | Inspect another tenant or mutate a stale administrative preview                      | Tenant access fails; stale preview is recomputed or rejected                                             | FR-ACC-01, FR-ADM-04 |

### 18.4 Services and migration

| ID    | Scenario                                                                        | Expected result                                                                                      | Requirements         |
| ----- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------- |
| AC-43 | Purchase a monthly package with 180 included minutes                            | One paid period and one 180-minute allowance are created                                             | FR-SVC-01, FR-SVC-02 |
| AC-44 | Apply the same service payment twice                                            | No second period or allowance is created                                                             | FR-SVC-02            |
| AC-45 | Record 45 approved billable minutes                                             | Remaining allowance is 135; ledger identifies work and actor                                         | FR-SVC-03, FR-SVC-04 |
| AC-46 | Correct a time entry or classify work as a Markiro defect                       | Audited compensating entries preserve history; defect correction consumes no paid minutes            | FR-SVC-04, FR-SVC-05 |
| AC-47 | Attempt to exceed allowance without approval                                    | Posting/charging excess is blocked pending approval                                                  | FR-SVC-06            |
| AC-48 | Reach an unpaid next service period or an unimplemented annual allowance policy | No free renewed allowance; unsupported annual package cannot be published                            | FR-SVC-01, FR-SVC-02 |
| AC-49 | Migrate a customer with null quotas and existing module access                  | Unlimited quantities and reviewed existing feature rights are preserved                              | MIG-03, MIG-04       |
| AC-50 | Migrate a historical yearly-label/monthly-period record                         | It is flagged for review; no automatic price/date rewrite occurs                                     | MIG-01, MIG-02       |
| AC-51 | Run old and new strict clients during rollout                                   | Negotiated payloads parse; unsupported capabilities are not granted; safe recovery remains available | MIG-05               |
| AC-52 | Revert new commercial enforcement after rollout problems                        | No data loss, unrestricted unmanaged fallback or removal of existing security checks                 | MIG-07               |
| AC-53 | Exceed an external-provider quota                                               | A technical wait/retry reason is shown, not an unsupported paid-upgrade promise                      | TR-04                |
| AC-54 | Run enforcement-readiness checks with unmanaged production tenants              | The tenants are reported; global strict rollout remains blocked pending explicit migration           | FR-ACC-05, MIG-01    |

---

## 19. Example configuration fixtures

These fixtures express the proposed package structure from the product discussion. They are for development and review only. Production prices, feature inclusion and customer migrations require separate approval.

| Logical setting                                             | Start                                               | Workshop                                            | Production                                          |
| ----------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------- |
| Working devices                                             | 1                                                   | 3                                                   | 6                                                   |
| Kiosks                                                      | 0                                                   | 0                                                   | 1                                                   |
| Lines                                                       | Unlimited                                           | Unlimited                                           | Unlimited                                           |
| Cabinet users                                               | Unlimited                                           | Unlimited                                           | Unlimited                                           |
| Label editor                                                | Included                                            | Included                                            | Included                                            |
| Inventory/repacking                                         | Included                                            | Included                                            | Included                                            |
| Chestny ZNAK integration, including National Catalog import | Add-on available                                    | Included                                            | Included                                            |
| Standard CommerceML connector                               | Add-on available                                    | Included                                            | Included                                            |
| Public API                                                  | Add-on available                                    | Included                                            | Included                                            |
| Handheld client                                             | Included within shared slots after release approval | Included within shared slots after release approval | Included within shared slots after release approval |
| Pallet operations                                           | Not enabled by this fixture                         | Not enabled by this fixture                         | Not enabled by this fixture                         |

“Add-on available” means the base feature value is false and a separately defined add-on can grant it. It does not mean the feature is usable before purchasing or receiving that grant.

Representative fixture cases:

- One base plan with `maxKiosks = 0` and an add-on increment of one kiosk.
- One plan with a shared three-device quota occupied by two desktop stations and one handheld.
- A Start customer with the unified Chestny ZNAK add-on enabled: eligible National Catalog import and supported CHZ operations share one entitlement and connection.
- A Start customer without the unified add-on: file-based inventory remains available; new National Catalog lookups/imports and direct CHZ requests are denied, while eligible historical data and recovery remain available.
- One monthly support service with 180 included minutes, no carryover and approval required for excess work.
- A scheduled downgrade, a temporary pilot grant and an expired tenant with recoverable offline evidence.

Production-plan publication must not depend on these example names or prices. Enforcement must depend on structured rights, not string comparisons such as `plan.name === "Production"`.

---

## 20. Policy decisions required before production activation

The implementation can proceed with configurable policies. The following decisions must be recorded before the corresponding commercial behavior is activated.

| Decision                                                    | Safe implementation position until approved                                                              |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Exact production tariff prices and final module inclusion   | Keep illustrative fixtures separate from production catalog publication                                  |
| Additional billing grace                                    | Zero additional grace for new unapproved policies; preserve existing customer terms                      |
| Maximum offline validity and task-completion boundaries     | Require an explicit policy before strict offline enforcement; do not shorten existing operation silently |
| Post-expiry access and retention duration                   | Preserve current approved terms; require a retention-policy reference for new sellable plans             |
| Trial duration and eligibility                              | Use explicitly configured positive days; no automatic repeated trials                                    |
| First supported handheld models and release status          | Pilot only until the relevant end-to-end/hardware acceptance is recorded                                 |
| Support operating hours, response commitments and carryover | No implied SLA or automatic carryover; block unsupported promises in publication                         |
| Historical period/tax anomalies                             | Human review and audited future correction; do not rewrite issued records                                |

These are commercial or operational decisions, not reasons to implement unrestricted defaults. Where a required value is missing, the affected publication/activation must fail with a clear explanation.

---

## 21. Definition of done and handover

P0/P1 are complete when all applicable requirements and AC-01 through AC-42, AC-49 through AC-54 pass, the migration impact report is reviewed, and the approved pilot rollout demonstrates recovery on the supported clients. P2 additionally requires AC-43 through AC-48 and complete recurring-service fulfillment coverage.

The handover MUST include:

- A requirement-to-test matrix, schema migrations and a reviewed production-data impact report.
- Updated shared contracts, OpenAPI, UI translations and relevant desktop/Android compatibility documentation.
- A route/job inventory mapping each affected operation to its commercial, authorization and recovery policy.
- Automated unit, contract, integration, database-concurrency and browser tests as applicable.
- Desktop and Android offline/restart/reconnection evidence; hardware-specific claims backed by actual acceptance rather than browser mocks alone.
- An administrator guide for plan creation, module grants, device transfer, downgrade selection and recurring-service administration.
- A rollout and non-destructive rollback runbook, including monitoring and treatment of unmanaged/legacy tenants.
- Explicit records of unresolved hardware limitations and any approved deviations from SHOULD requirements.

No release is acceptable if it can lose unsynchronized production evidence, grant cross-tenant access, misstate a monthly/annual term, silently issue disallowed VAT treatment, or double-apply a payment.

---

## 22. Source register

Repository sources below refer to the inspected commit, not a moving `main` link. They establish the baseline; requirements elsewhere are proposed product and engineering decisions.

| Ref | Source                                                                                                                                                                                  | Relevance                                                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| S1  | [Catalog API contracts](https://github.com/thevladbog/markiro/blob/9cdd7f634949fde28528f4ca172ac8ed9769796a/packages/platform-contracts/src/catalog.ts)                                 | Quota validation, feature/effect keys, billing periods, recurring-service restriction |
| S2  | [Catalog creation panel](https://github.com/thevladbog/markiro/blob/9cdd7f634949fde28528f4ca172ac8ed9769796a/apps/saas-admin/src/pages/catalog/CatalogCreatePanel.tsx)                  | Empty-field mapping, hardcoded monthly period and VAT initialization                  |
| S3  | [SaaS database schema](https://github.com/thevladbog/markiro/blob/9cdd7f634949fde28528f4ca172ac8ed9769796a/packages/db/src/schema/saas.ts)                                              | Persisted catalog/version shapes, quota checks and billing-kind constraints           |
| S4  | [Entitlement types](https://github.com/thevladbog/markiro/blob/9cdd7f634949fde28528f4ca172ac8ed9769796a/apps/api/src/subscriptions/entitlements.types.ts)                               | Current quota/feature keys, effective access and subscription snapshot                |
| S5  | [Entitlement resolver](https://github.com/thevladbog/markiro/blob/9cdd7f634949fde28528f4ca172ac8ed9769796a/apps/api/src/subscriptions/entitlements.service.ts)                          | Current plan/add-on resolution, unmanaged behavior and usage counting                 |
| S6  | [Subscription access guard](https://github.com/thevladbog/markiro/blob/9cdd7f634949fde28528f4ca172ac8ed9769796a/apps/api/src/subscriptions/subscription-access.guard.ts)                | Existing feature, read-only and recovery enforcement boundary                         |
| S7  | [Handheld foundation design](https://github.com/thevladbog/markiro/blob/9cdd7f634949fde28528f4ca172ac8ed9769796a/docs/superpowers/specs/2026-09-10-handheld-foundation-design.md)       | Shared station identity, device kind and shared station quota                         |
| S8  | [Handheld README](https://github.com/thevladbog/markiro/blob/9cdd7f634949fde28528f4ca172ac8ed9769796a/apps/handheld/README.md)                                                          | Implemented/documented mobile workflows and hardware-verification caveat              |
| S9  | [National Catalog controller](https://github.com/thevladbog/markiro/blob/9cdd7f634949fde28528f4ca172ac8ed9769796a/apps/api/src/modules/national-catalog/national-catalog.controller.ts) | Existing lookup/import-proposal and subscription checks                               |
| S10 | [Chestny ZNAK exports controller](https://github.com/thevladbog/markiro/blob/9cdd7f634949fde28528f4ca172ac8ed9769796a/apps/api/src/modules/chz-exports/chz-exports.controller.ts)       | Current export ordering, retry and subscription boundary                              |
| S11 | [Federal Tax Service: Professional Income Tax](https://npd.nalog.ru/)                                                                                                                   | NPD VAT treatment and My Tax receipts; consulted 2026-09-10                           |

**Tax boundary:** This is a software requirements document, not a legal opinion or an automated determination of NPD eligibility. Seller configuration and final contractual wording must reflect the actual transaction and be reviewed before use. The specification does not claim that renaming a prohibited activity makes it permissible.
