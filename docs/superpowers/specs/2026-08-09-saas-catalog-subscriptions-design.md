# SaaS Catalog, Tenant Provisioning, and Subscriptions Design

**Status:** Approved in product review on 2026-08-09

**Scope:** The first usable vertical slice of the separate Markiro platform-operations panel:
versioned commercial catalog, secure platform access, tenant provisioning with activation-timed
demo subscriptions, enforceable entitlements, individual commercial offers, manual full-payment
recording, and idempotent fulfilment.

**Source:** `docs/design-briefs/06-saas-admin.md`, narrowed by the decisions in this design.

## 1. Goal

Give the Markiro team a separate, audited application for onboarding new tenants and managing the
commercial conditions that determine their product limits. A new tenant receives a demo only when
its first owner activates their account. Published commercial terms are immutable, tenant-specific
extensions are explicit, and recording a paid offer can safely provision a plan, add-ons, and
ordered services exactly once.

The product must enforce subscription limits at server write boundaries. Limits are not advisory
fields shown only in the platform UI.

## 2. In scope

- A separate `apps/saas-admin` React/Vite application on its own origin.
- A separate platform authentication surface with mandatory 2FA and no public sign-up.
- Platform roles `platform_admin`, `support`, and `accountant`.
- A versioned catalog containing plans, recurring add-ons, and one-time services.
- Immutable published catalog versions and explicit replacement by a new version.
- A configurable default demo plan version.
- Tenant creation with the first owner activation flow already used by Markiro.
- Demo activation at the instant the first owner completes activation, not tenant creation time.
- Subscription history, scheduled plan changes, and additive tenant-specific add-ons.
- Four quantitative entitlements: production lines, station devices, kiosks, and cabinet users.
- Three feature entitlements: label editor, public API, and pallets.
- Individual commercial offers built from catalog versions, with audited price overrides.
- Manual recording of one full payment with date, exact amount, and bank reference.
- Atomic, idempotent fulfilment of paid offer lines.
- A customer-cabinet subscription banner and current usage/limits view.
- Server-side quota and read-only enforcement, including offline-recovery exceptions.
- Append-only platform audit, subscription events, payment facts, and fulfilment facts.
- Production routing and configuration for the new platform origin.

## 3. Explicitly out of scope

- PDF invoice generation and invoice numbering.
- Sending invoices or reminders by email.
- Bank, payment-provider, or accounting-system integrations.
- Partial payments, refunds, chargebacks, credits, or payment allocation across documents.
- Automatic recurring invoice runs.
- Revenue recognition, general-ledger integration, and tax reporting.
- Impersonating a tenant user.
- Platform monitoring dashboards and operational alerting from design brief 06.
- The future customer-facing self-checkout flow.
- Implementing pallets themselves. This slice only defines and enforces the entitlement consumed by
  a future pallet implementation.

The schema and fulfilment boundary must leave room for the deferred billing features, but this
slice must not simulate them with incomplete accounting behavior.

## 4. Trust boundaries and application architecture

### 4.1 Separate platform surface

`apps/saas-admin` is not a hidden route or role inside `apps/admin`. It is a separate workspace
application, deployment artifact, origin, navigation tree, and browser session.

The NestJS API exposes a dedicated `/api/platform/*` surface. It has a separate authentication
handler under `/api/platform-auth/*`, a separate session cookie namespace, a separately configured
secret, and an exact platform-origin allowlist. A valid customer-cabinet session or organization
membership grants no access to `/api/platform/*`.

Platform authentication data is stored separately from customer Better Auth tables so a customer
identity cannot accidentally acquire platform authority through tenant membership. Public platform
sign-up is disabled. A service command provisions the first `platform_admin` without accepting or
printing a password; the recipient chooses a password through a one-time activation and must enroll
2FA before reaching an operational screen.

### 4.2 Platform roles

| Capability                                 | Platform admin | Support                | Accountant                   |
| ------------------------------------------ | -------------- | ---------------------- | ---------------------------- |
| View tenants and subscription state        | yes            | yes                    | yes                          |
| Create tenants and renew owner activation  | yes            | yes                    | no                           |
| View catalog names and entitlement effects | yes            | yes                    | yes                          |
| View prices, offers, and payments          | yes            | no                     | yes                          |
| Publish catalog versions                   | yes            | no                     | yes                          |
| Assign or schedule plans/add-ons           | yes            | no                     | yes, through paid fulfilment |
| Record payment                             | yes            | no                     | yes                          |
| Manage platform team and roles             | yes            | no                     | no                           |
| View platform audit                        | yes            | tenant operations only | financial operations only    |

Route policy is explicit and server-side. UI visibility is only a usability layer.

### 4.3 Shared subscription authority

One API-owned `EntitlementsService` resolves effective entitlements for all customer surfaces. The
platform UI, customer UI, stations, kiosks, and public API do not independently reproduce plan
math. Quantitative checks and resource creation run inside one database transaction under a
tenant-scoped advisory lock.

## 5. Commercial catalog and immutable versioning

### 5.1 Stable catalog items

`catalog_items` provides stable commercial identities:

- `id`
- unique machine-readable `code`
- RU and EN display names
- `kind`: `plan`, `addon`, or `service`
- `status`: `active` or `archived`
- timestamps

Archiving prevents new use but never changes existing offers, subscriptions, add-ons, ordered
services, or historical documents.

### 5.2 Catalog item versions

`catalog_item_versions` stores numbered revisions of a stable item:

- `(catalog_item_id, version)` is unique;
- lifecycle is `draft`, `published`, or `retired`;
- document name and description in RU and EN;
- unit of measure;
- billing mode `one_time` or `recurring`;
- recurring period `month` or `year` where applicable;
- RUB unit price as an exact decimal string/`numeric` value, never floating point;
- configurable VAT rate and whether VAT is included; `null` rate means "without VAT";
- publication timestamp and publishing platform user.

Drafts are editable. Publishing validates the complete commercial and fulfilment contract. A
published version and its entitlement extension rows cannot be updated or deleted. Corrections
require a new numbered version. Database constraints or triggers enforce this in addition to
service checks.

### 5.3 Plan entitlement extension

A `plan` version has exactly one plan-entitlement row with:

- `max_lines`
- `max_stations`
- `max_kiosks`
- `max_cabinet_users`
- `label_editor_enabled`
- `public_api_enabled`
- `pallets_enabled`
- optional positive `demo_duration_days`

All quantitative values are positive integers. Unlimited is represented explicitly as `null`, not
as a magic large number. A demo plan must have a finite positive duration; a standard plan must
not.

### 5.4 Add-on entitlement extension

An `addon` version contains one or more additive effects:

- a strictly positive increment to one quantitative entitlement; or
- enabling one feature entitlement.

An add-on can never reduce a quota or disable a feature. Quantity multiplies a quantitative
increment. Feature-enabling add-ons behave as a set and do not stack numerically.

### 5.5 Services

A `service` version has no entitlement effect. Examples include implementation, training, and data
migration. Payment registers an ordered service for operational follow-up without changing product
access.

### 5.6 Default demo setting

A singleton platform setting references one exact published demo plan version. Changing the setting
affects only tenants created afterwards. A catalog item or version referenced by this setting cannot
be archived or retired until another published demo version becomes the default.

## 6. Tenant subscriptions and history

### 6.1 Subscription records

`tenant_subscriptions` references an exact published plan version and records:

- tenant ID;
- status `pending_activation`, `scheduled`, `trial`, `active`, `expired`, `superseded`, or
  `cancelled`;
- `starts_at` and `ends_at`;
- source: demo provisioning, manual platform assignment, or paid offer line;
- source document/line where applicable;
- creating platform user and timestamps.

There is at most one effective current subscription and at most one scheduled successor per tenant.
Changing a plan never rewrites the old subscription. Immediate replacement marks the old row
`superseded`; scheduled replacement starts after the current subscription ends. The new row keeps
its own exact plan version.

### 6.2 Subscription add-ons

`subscription_addons` references an exact published add-on version and one subscription. It records
quantity, `starts_at`, `ends_at`, status `scheduled`, `active`, `expired`, or `revoked`, and the
source offer line or manual operation. Revocation is a visible status transition; rows are not
deleted.

If an add-on expires or is revoked and actual usage is now above the effective quota, existing
resources remain. Only further creation is blocked until usage is within the effective limit.

### 6.3 Subscription events

`subscription_events` is append-only. It records at minimum tenant, subscription, event kind,
effective timestamp, actor/source, reason, and a bounded before/after snapshot. Events cover demo
activation, plan assignment, scheduled activation, supersession, expiration, add-on activation,
add-on revocation, and fulfilment failure/retry.

Access decisions do not depend on a periodic expiration job running on time. `EntitlementsService`
treats `ends_at <= now` as expired immediately. A pg-boss job materializes the status/event exactly
once for reporting and UI history.

## 7. Tenant provisioning and activation-timed demo

### 7.1 Create tenant

The platform create form requires organization name, valid unique slug, and first-owner email. The
API performs one transaction that:

1. Locks the normalized owner email and tenant slug in the same deterministic order as the existing
   provisioning command.
2. Resolves the current default published demo version.
3. Creates the organization, owner identity/membership, activation verification, and mail outbox
   record using the existing secure owner-provisioning behavior.
4. Creates one `pending_activation` demo subscription with no start/end timestamps.
5. Writes platform audit and subscription events.

A tenant cannot be created without a default demo version. Duplicate retries return the original
identifiers and must not enqueue a second activation or create another subscription. A slug owned by
a different first owner fails safely.

### 7.2 Complete owner activation

Completing the first-owner activation updates the credential/email state and the matching
`pending_activation` demo subscription in the same database transaction. The server uses one `now`
value for:

- `starts_at = now`;
- `ends_at = now + demo_duration_days` calendar days;
- status `trial`;
- the activation event.

Reading the activation page, sending an email, or merely signing in does not start the demo. Reusing
an already-consumed token cannot restart or extend it.

### 7.3 Demo expiry

When the demo expires, the tenant becomes subscription read-only until an active paid subscription
starts. Assigning a paid plan restores ordinary access immediately or at the explicitly scheduled
time; no old demo dates are rewritten.

## 8. Commercial offers, payment, and fulfilment

### 8.1 Offer and immutable revision

`commercial_offers` belongs to one tenant and has lifecycle `draft`, `published`, `paid`,
`cancelled`, or `expired`. Publishing creates an immutable revision; correcting a published offer
creates a new revision linked to the same offer family.

`commercial_offer_lines` stores a document snapshot:

- exact catalog version when catalog-backed;
- RU/EN name and description copied at publication;
- quantity and unit;
- catalog unit price and agreed unit price;
- VAT terms;
- price-override reason when agreed price differs;
- activation policy `immediately` or `after_current` for a base-plan line;
- calculated exact line total.

An ad-hoc service line is allowed with no catalog reference, but it can never grant entitlements.
Only a published catalog version can create a plan or add-on. A published offer contains no more
than one base-plan line. An add-on-only offer requires a compatible current or scheduled base
subscription.

### 8.2 Manual full payment

The first release records only one full payment for the exact published offer total. It requires:

- payment date/time;
- exact amount and currency RUB;
- non-empty bank reference;
- platform actor;
- client idempotency key.

Amount mismatch, draft/cancelled/expired offer state, already-paid state with a different key, or an
invalid fulfilment contract is rejected before any access change. Financial fields are hidden from
support-role responses, not merely from the UI.

### 8.3 Atomic idempotent fulfilment

Payment creation, fulfilment facts, subscription/add-on/service creation, subscription events, and
platform audit run in one transaction. Each offer line has at most one fulfilment row, enforced by a
unique constraint. Repeating the same idempotency key returns the original result.

Fulfilment behavior:

- An immediate base-plan line supersedes the current subscription and starts the new one at the
  recorded payment time.
- An `after_current` base-plan line creates a scheduled successor at the current subscription's end;
  if the current subscription is already expired, the new plan starts at payment time.
- Add-on lines attach to the base subscription created by the same offer or to the selected current
  subscription. Their term cannot extend beyond the subscription unless a later design explicitly
  supports independent add-on renewal.
- Service lines create immutable `ordered_services` rows with status `ordered`.

No email, PDF, or external callback runs inside the payment transaction.

## 9. Effective entitlements and quota enforcement

### 9.1 Calculation

Effective entitlements are:

`published plan-version snapshot + currently active additive add-ons`

The response includes the source version, additive contributors, effective values, usage, remaining
capacity, subscription status, and relevant start/end timestamps. Consumers receive a typed DTO;
they do not parse catalog metadata or JSON expressions.

### 9.2 Usage definitions

| Entitlement   | Usage definition                                                             |
| ------------- | ---------------------------------------------------------------------------- |
| Lines         | All existing tenant production-line rows                                     |
| Stations      | Station-device rows whose credential/lifecycle has not been revoked          |
| Kiosks        | Kiosk rows with active lifecycle status                                      |
| Cabinet users | Active tenant members plus unexpired pending invitations that reserve a seat |

Counting pending invitations prevents parallel invitations from bypassing the user limit. Cancelled,
expired, or rejected invitations release their reservation. Resource lifecycle transitions that
release capacity and transitions that restore capacity use the same entitlement lock.

### 9.3 Transactional quantitative enforcement

For line, station, kiosk, and invitation creation, the service:

1. Starts or joins the resource write transaction.
2. Acquires a tenant-and-entitlement advisory transaction lock.
3. Resolves current effective entitlements and usage from authoritative tables.
4. Rejects when `usage >= limit`.
5. Creates the resource/reservation before releasing the transaction.

The public error is HTTP 409 with code `subscription_limit_reached`, entitlement key, used count,
and effective limit. It does not expose other tenants or commercial prices.

### 9.4 Feature enforcement

- Label editor disabled: existing templates can be viewed and used for preview/print; creating or
  modifying templates is blocked.
- Public API disabled: new keys and write-scoped requests are blocked; existing read/export access
  remains available so the tenant can retrieve its data.
- Pallets disabled: future pallet creation and mutation endpoints must declare this entitlement.
  Existing pallet data remains readable if a later downgrade disables the feature.

Feature checks are explicit route/service policies. UI hiding never substitutes for the API policy.

### 9.5 Read-only subscription state

An expired demo with no active successor denies new customer business mutations. Authentication,
profile/security maintenance, reads, and exports remain available.

Factory continuity exceptions are narrow and explicit:

- A shift opened before subscription expiry may finish and deliver its scan batches, box closures,
  and operator exceptions after expiry.
- Starting or creating another shift after expiry is denied.
- Station sync remains idempotent and accepts recovery data for an eligible pre-expiry shift.
- Kiosk queue records created before expiry may synchronize; new orders created after expiry are
  rejected with a per-record subscription error rather than wedging the queue.
- Pairing, enrollment, and creation of new devices are denied.

The server is authoritative. Station and kiosk bootstrap payloads also carry status/end timestamps
for honest offline UI, but device clocks do not become the authorization source.

## 10. Platform API surface

The exact controller split may follow existing NestJS conventions, but the public contracts are:

- `/api/platform-auth/*`: platform sign-in, 2FA enrollment/challenge, sign-out, recovery.
- `GET /api/platform/me`: platform identity, role, 2FA readiness, capabilities.
- `/api/platform/team`: platform-user invitation, role changes, suspension, recovery.
- `/api/platform/catalog/items`: catalog list/create/archive.
- `/api/platform/catalog/items/:id/versions`: draft, publish, retire, and version history.
- `/api/platform/settings/demo-plan`: read/change the exact default demo version.
- `/api/platform/tenants`: list, create, and tenant detail.
- `/api/platform/tenants/:id/subscription`: history, effective entitlements, usage, and manual
  subscription/add-on operations allowed by role.
- `/api/platform/offers`: draft, publish revision, cancel, and tenant-scoped list/detail.
- `POST /api/platform/offers/:id/payment`: record the exact full payment and fulfil atomically.
- `/api/platform/audit`: role-filtered append-only audit queries.

Customer-facing access contracts expose subscription status and entitlement usage without prices.
Existing `/api/access/me` is extended or paired with a focused tenant-subscription endpoint so the
cabinet can render navigation, banners, and errors from one server authority.

## 11. User experience

### 11.1 Platform application

The first release contains:

- Sign-in, mandatory 2FA enrollment/challenge, and recovery states.
- Tenants list with demo/subscription status, plan, expiry, and quota pressure.
- Tenant creation flow with owner email and a clear statement that demo time starts on activation.
- Tenant detail tabs: overview, subscription, offers, services, and history.
- Catalog grouped into plans, add-ons, and services, with draft/published version history.
- Offer builder with catalog picker, quantity, price override/reason, totals, and activation policy.
- Payment confirmation showing exact amount, bank reference, and the access changes it will trigger.
- Platform team management for platform admins.
- Role-filtered platform audit.

The app reuses `@markiro/ui`, established office-mode tokens, visible focus, semantic controls,
RU/EN i18n, and loading/empty/error states. No credential, activation token, or 2FA secret appears
in logs or generic error toasts.

### 11.2 Customer cabinet

The customer cabinet adds:

- a subscription banner for pending demo activation, trial time remaining, scheduled plan,
  over-limit state, and read-only expiry;
- current plan name/version, limits, usage, and active add-ons;
- localized actionable messages for `subscription_limit_reached` and `subscription_read_only`;
- no platform prices, other tenants, platform-user identities, or internal payment facts.

## 12. Audit and data handling

`platform_audit_events` is separate from tenant audit. Every platform mutation records actor,
platform role, action, outcome, tenant when applicable, target type/id, reason where required,
timestamp, and bounded before/after metadata. The audit includes failed authorization and failed
payment/fulfilment attempts without storing passwords, activation URLs, 2FA secrets, bank
credentials, or raw session tokens.

Price overrides, catalog publication, default-demo changes, tenant creation, activation renewal,
plan changes, add-on changes, payment recording, fulfilment, and platform-role changes are audited.

Commercial text and prices are snapshotted on published offers. Historical documents never render
from a mutable current catalog name or price.

## 13. Migration and compatibility

- Add new Postgres enums/tables through a new migration; do not rewrite applied migrations.
- Existing organizations are not silently assigned a plan. A migration/backfill report lists them
  as `unmanaged`; platform admin explicitly assigns a version before enforcement is enabled for that
  tenant.
- The rollout includes an enforcement feature switch whose default is observe-only for unmanaged
  tenants and authoritative for newly provisioned tenants. The switch is removed only after every
  existing tenant is reconciled.
- Existing tenant creation CLI delegates to the same provisioning service. It either creates the
  default pending demo or requires an explicit compatibility flag during the migration window; the
  CLI and UI must not diverge.
- Existing queued station/kiosk payloads remain accepted according to the recovery rules above.
- `@markiro/db` is rebuilt before API tests so consumers do not execute stale schema output.

## 14. Failure handling

- Missing/default-invalid demo configuration prevents tenant creation before any organization row
  is written.
- Activation mail failure remains an outbox/retry state and does not start the demo.
- Catalog publication reports precise validation errors and leaves the draft editable.
- Payment validation failure creates no payment or entitlement changes.
- Transaction failure rolls back payment and every fulfilment result together.
- A transient infrastructure error propagates for safe retry with the same idempotency key.
- A business conflict returns a stable error code and never relies on parsing a database error
  message in the UI.
- Expiration-job delay never grants write access beyond `ends_at` because access is derived at
  request time.

## 15. Verification and acceptance

### 15.1 Database and service tests

- Published catalog versions and entitlement rows cannot be edited or deleted.
- New catalog versions do not affect existing subscriptions or published offers.
- Only one effective and one scheduled subscription can exist per tenant.
- Add-ons cannot reduce quotas or disable features.
- Cross-tenant IDs cannot be assigned to a subscription, offer, payment, or fulfilment.
- Migration tests cover fresh apply and existing-tenant compatibility.

### 15.2 Authentication and authorization tests

- Customer sessions and device credentials receive 401/403 from every platform route.
- Platform sign-in cannot reach operational routes before 2FA enrollment/challenge.
- Each role matches the capability table, including response-level price redaction for support.
- Platform sign-up is unavailable outside explicit test setup.
- Exact-origin CORS and cookie isolation are covered.

### 15.3 Provisioning and demo tests

- Tenant, owner, activation, mail delivery, pending demo, and audit are atomic.
- Duplicate provisioning returns existing IDs without duplicate mail/subscription rows.
- Reading or resending activation does not start the demo.
- Completing activation uses one timestamp and starts demo once.
- Consumed, expired, malformed, or wrong-owner activation cannot start/extend a trial.
- The access resolver treats time expiry authoritatively even before the background job runs.

### 15.4 Entitlement tests

- Every quantitative limit passes below the boundary and rejects at the boundary.
- Two concurrent final-slot attempts create exactly one resource.
- Pending invitations reserve seats and cancellation/expiry releases them.
- Downgrade/expired add-on never deletes or disables an existing resource.
- Label/public-API feature gates retain the approved read/export paths.
- Expired demo blocks new shifts and writes while accepting eligible open-shift recovery sync.
- Kiosk sync returns a per-record result for pre-expiry versus post-expiry queued records.

### 15.5 Offer/payment tests

- Published offer text, price, VAT, catalog version, and effects are immutable snapshots.
- Price override requires a non-empty reason and exact audit fields.
- Ad-hoc service lines cannot carry entitlement effects.
- Payment requires exact full amount and a bank reference.
- Repeating one idempotency key returns one payment and one fulfilment per line.
- A different key cannot pay an already-paid offer again.
- Immediate and after-current policies produce the exact expected subscription timeline.
- A transaction failure leaves no partial payment, add-on, service, or subscription state.

### 15.6 UI and deployment tests

- Component tests cover loading, empty, error, forbidden, validation, concurrent conflict, and
  success states for all first-release screens.
- Browser tests cover 2FA, tenant/demo creation, catalog publication, offer publication, payment,
  fulfilment, and the customer subscription banner.
- Production bundle contracts prove the platform hostname routes only the platform UI and exact
  platform API/auth origins.
- Automated browser checks are reported separately from real SMTP, DNS/TLS, and production-cloud
  acceptance.

## 16. Success criteria

The slice is complete when a platform admin can securely create a tenant, the first owner can
activate and start a time-bounded demo, server mutations enforce the approved limits, an accountant
can publish an individual offer and record its exact full payment, and that payment provisions the
versioned plan/add-ons/services exactly once with complete visible history. No published catalog or
assigned plan changes retroactively, and expiration never loses offline production data.
