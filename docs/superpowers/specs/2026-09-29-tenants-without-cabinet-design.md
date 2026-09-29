# Tenants without cabinet access — design

**Status:** design approved by the owner on 2026-09-29. Implemented on
branch `claude/tenants-without-cabinet-access-76528f` with the owner-approved
changes recorded in "Implementation notes and changes" below; where this text
and those notes differ, the notes win.

## Summary

Two products now run offline with no internet access. Their customers need a
tenant in the platform so the operator can issue invoices and acts, record
payments and service periods, and keep the commercial history — but the
customer has no cabinet. Today provisioning always creates a cabinet owner,
sends an activation e-mail and starts a demo. This design adds a tenant that
has **no cabinet access**, plus an operator action to grant it later.

Decisions taken with the owner:

- **Explicit flag** on the tenant (`organization.cabinet_access`), not a
  value derived from "no owner member".
- **Documents are sent by the operator by hand.** No contact entity, no
  billing e-mail field. The platform sends nothing to such a tenant.
- **No demo, no licenses.** Only catalog items of kind `service` may be
  ordered; `plan` and `addon` are refused server-side. When the cabinet is
  granted later, the default demo is created then (owner decision
  2026-09-29, section 4).
- **The cabinet can be granted later** (`none` → `enabled`, one way). It is
  not a permanent tenant type.
- **The offer editor can create such a tenant inline** (section 5). The
  owner said "from the offer"; this design reads that as the tenant picker of
  `CreateOfferPage`. Confirm on review if another entry point was meant.

## What was verified in code

- `tenant-provisioning.service.ts` — the owner user, `member` row, activation
  token and mail, and demo `lockDefaultDemo` are all in
  `provisionInTransaction`. The organization, `pickup_tenant_policies`, stock
  label templates and `org_profiles` do not depend on the owner.
- `billing-acts`, `platform-billing-requests`, `service-periods` and
  `platform-offers` key on `tenantId` only. None reads `tenant_subscriptions`
  or `member`, so invoices, acts, requests and service periods need no change
  for a tenant without a subscription.
- `entitlements.service.ts` resolves a tenant with **no subscription rows**
  to `access: "unmanaged"`: null (unlimited) quotas and every feature on, and
  under the default `SUBSCRIPTION_ENFORCEMENT_MODE=managed_only` it is not
  enforced. (An earlier draft of this section said such a tenant resolves to
  `read_only`; that was wrong. `read_only` with zero quotas is what a
  `pending_activation` or expired subscription resolves to.) For a tenant
  without a cabinet this does not matter, since no cabinet or device uses its
  entitlements; it is the reason a granted cabinet must get the default demo
  (section 4).
- `tenant-billing-notifications.service.ts` mails only members with role
  `owner` or `admin`; with no members it sends nothing and does not fail.
- `platform-tenants.service.ts` reads the owner for the detail view
  (`ownerActivation`, nullable in `tenantDetailSchema`) and for owner-mail
  resend (`tenant_owner_not_found`).
- There is no support-ticket module in the repository (only
  `demo-requests`). Handling customer enquiries needs no change here; if a
  ticket feature is meant, it is out of scope.

## 1. Data and contracts

- Migration adds `organization.cabinet_access text not null default
  'enabled'` with a check constraint for `('enabled','none')`. Existing rows
  become `enabled`. Add a new migration; do not edit applied ones. Update the
  schema test and the runtime-migration test. Rebuild `@markiro/db` before
  consumers.
- `provisionTenantSchema` (`platform-tenants/dto.ts`) gains
  `cabinetAccess: "enabled" | "none"`, default `enabled`. One refinement
  shared by the CLI and saas-admin: `enabled` requires `email`; `none`
  rejects `email`.
- `platform-contracts/src/tenants.ts`: add `cabinetAccess` to
  `tenantDetailSchema` and to the list item schema. The schemas are
  `.strict()`, so the consumers (API, saas-admin fixtures) are updated in the
  same change. Add the request/response schemas of the grant action.
- Introduce one API error code per refusal (section 3, 4); no message text
  matching in the client.

## 2. Creating a tenant without cabinet

In `provisionInTransaction`, when `cabinetAccess === "none"`:

- Take the slug advisory lock only; skip the `tenant-owner-email` lock.
- Insert the organization with `cabinet_access = 'none'`, `pickup_tenant_
  policies`, the stock label templates and `org_profiles` exactly as today.
- Do **not** insert a user, `user_profiles`, `member`, activation token,
  `verification` row, e-mail delivery or the `tenant.owner.provisioned`
  tenant audit event.
- Do **not** call `lockDefaultDemo`; a missing default demo must not block
  creation. No `tenant_subscriptions` or `subscription_events` rows. The
  demo is created only if and when the cabinet is granted (section 4).
- Platform audit `platform.tenant.created` with
  `after: { cabinetAccess: "none", subscriptionStatus: "none" }`. The
  `unmanaged` reason is not used: it means "managed tenant created without a
  default demo", which is a different fact.
- Idempotent retry: an existing slug with the same `cabinetAccess` returns
  the existing tenant; a slug that exists with a different `cabinetAccess`
  is a conflict (`tenant_cabinet_access_mismatch`), never a silent switch.

`TenantProvisioningResult.userId`, `memberId` and `deliveryId` become
nullable; the controller response and the OpenAPI schema follow.

## 3. Services only

Every path that creates a subscription, subscription add-on or order for a
tenant checks the tenant's `cabinet_access` inside the same transaction that
writes. When it is `none` and the catalog version kind is `plan` or `addon`,
the request fails with `catalog_kind_not_allowed_for_offline_tenant`
(HTTP 409). Kind `service` is allowed. Places to cover: the platform
subscription/demo/add-on endpoints under `subscriptions/` and
`platform-catalog/`, and any offer or billing-request line that would later
activate a plan or add-on. The client filters the catalog to services, but
the server is the authority.

Ordered services, invoices, acts, payments and service periods work as they
do today.

## 4. Granting the cabinet later

New platform action `POST /platform/tenants/:id/cabinet-access`
(`{ email }`), capability `tenants.write`, denied for role `accountant` as
tenant creation is.

In one transaction, with the same advisory-lock order as provisioning
(email, then slug; the full order is in "Implementation notes"): require
`cabinet_access = 'none'` (else `cabinet_access_already_enabled`), create or
reuse the user, create the owner `member`, enqueue the activation delivery
through the existing code, set `cabinet_access = 'enabled'`, and create the
default demo. The owner-creation part and the demo insert are shared private
methods of `TenantProvisioningService`, so provisioning and granting cannot
drift.

- The default demo is created on grant exactly as provisioning creates it
  for a new tenant: a `pending_activation` demo subscription plus a
  `demo.provisioned` subscription event, activated when the owner activates.
  Without it the new cabinet would have no subscription rows and resolve to
  `unmanaged` (unlimited). If no default demo is configured the grant fails
  with `default_demo_not_configured` (409) and changes nothing. A default
  demo switched while the grant waits retries the whole transaction, as
  provisioning does. (Owner decision 2026-09-29; it replaces the earlier
  "no demo is created retroactively".)
- Existing `tenant_first_owner_conflict` rules still apply when the tenant
  somehow already has members.
- Platform audit `platform.tenant.cabinet_access.granted` with the exact
  actor, tenant, target member, `before: { cabinetAccess: "none" }` and
  `after: { cabinetAccess: "enabled", ownerUserId, deliveryId,
  subscriptionId, subscriptionStatus: "pending_activation", planVersionId }`;
  tenant audit `tenant.owner.provisioned`.
- After the switch the tenant is a normal tenant, including the activation
  resend action. `enabled` → `none` is not offered.

## 5. saas-admin

- `CreateTenantPanel`: a "Cabinet access" switch, on by default. Off hides
  the e-mail field and replaces the demo notice with a note that no demo or
  licenses apply and documents are sent by hand. The zod schema mirrors the
  contract refinement.
- Tenant card: for `none` show "Cabinet not granted" with a "Grant cabinet
  access" button (form: owner e-mail) instead of the owner block. The panel
  text says the default demo subscription is created with the grant. Hide
  the owner-mail resend. Catalog pickers in offer/order forms show only
  `service` items for such a tenant (deferred, see below).
- Tenant list: a non-colour-only badge for `none`.
- Offer editor (`CreateOfferPage` / `DocumentComposer` tenant picker): an
  "Create tenant without cabinet" action, visible only with `tenants.write`.
  It asks for name and slug, calls the same create endpoint with
  `cabinetAccess: "none"`, invalidates the tenant queries and selects the new
  tenant. Legal requisites are entered afterwards in the tenant card as they
  are today.
- All text through the existing i18n keys, RU and EN.
- Where billing notifications would go, the tenant card and document views
  state that the platform sends nothing and the operator downloads and sends
  the documents, so a missing e-mail is not read as a failure.

## Tests and verification

- API (DB-backed): create with `none` writes no user, member, token,
  delivery or subscription and does not need a default demo; audit rows
  asserted for exact actor, tenant, action, target and metadata; `enabled`
  behaviour unchanged; e-mail rules of the schema; slug retry and mismatch.
- Refusal of `plan`/`addon` for `none` on every write path, allowance of
  `service`, and cross-tenant denial (another tenant unaffected).
- Grant: success, already-enabled, e-mail already owner elsewhere, accountant
  denied, exact audit; activation mail queued once.
- Billing notification service with zero members sends nothing.
- Route inventory: `platform-route-contracts`, `platform-contract-openapi`,
  and the subscription route inventory for the new route.
- Migration and schema tests; `tools/ci/affected.mjs` unchanged unless a
  surface is added.
- saas-admin: form (switch, validation), tenant card, offer-editor inline
  creation, catalog filtering, fixtures updated.
- Not verifiable here: real mail delivery and a browser run of the UI; they
  will be reported as not exercised.

## Implementation notes and changes

Recorded after implementation (2026-09-29); these supersede the sections
above where they differ.

- **Demo on grant** (owner decision): see section 4. `grantCabinetAccess`
  reuses `lockDefaultDemo` and the provisioning demo insert; the demo is
  inserted directly, not through plan assignment, so the licence guard of
  section 3 does not apply to it.
- **Support may grant.** The grant requires `tenants.write`, which `support`
  holds (support may also create tenants); `accountant` does not and is
  refused with 403.
- **Grant lock order:** owner e-mail advisory lock → tenant slug advisory
  lock → tenant subscription timeline advisory lock → `organization` row
  `FOR NO KEY UPDATE` → default demo (candidate catalog version `FOR KEY
  SHARE` → `platform-default-demo-setting` advisory lock → `platform_settings`
  row `FOR SHARE`). E-mail then slug is the provisioning order. Lifecycle
  paths take the timeline lock first and never an e-mail or slug lock. The
  timeline lock makes the licence guard see either `none` or the committed
  `enabled` and puts the demo insert under the lock every timeline write
  takes. Default-demo selection and retirement take the catalog version then
  the setting and never a tenant lock; provisioning takes e-mail, slug, then
  the same catalog/setting pair and no tenant lock after it. Tenant locks
  therefore always precede catalog locks, and no holder of the setting lock
  waits for a lock the grant took earlier.
- **`FOR NO KEY UPDATE`, not `FOR UPDATE`,** on the organization row: it is
  the strength the `cabinet_access` update needs, and it does not conflict
  with the `FOR KEY SHARE` locks that foreign-key inserts into tenant tables
  take, so a path that inserts tenant rows before taking the timeline lock
  cannot deadlock against a grant holding the timeline lock.
- **Re-provisioning a granted tenant** with `cabinetAccess: "none"` (for
  example re-running the original offline creation) returns
  `tenant_cabinet_access_mismatch`, like any slug reused with a different
  cabinet access.
- **Licences refused at document creation.** Besides the subscription
  lifecycle, the API refuses `plan` and `addon` lines at offer and invoice
  creation for a `none` tenant with `catalog_kind_not_allowed_for_offline_tenant`
  (409); saas-admin shows a dedicated message for it.
- **Unmanaged report.** `report-unmanaged-tenants` does not list tenants with
  `cabinet_access = 'none'`.

### Deferred follow-ups

- `DocumentComposer` catalog filter: for a `none` tenant offer only
  `service` items (the server already refuses licences).
- A "the platform sends nothing; the operator sends the documents by hand"
  notice on the invoice, act and offer document views. Only the tenant card
  shows it now; the composer and detail pages need the tenant's
  `cabinetAccess` first.
- A tenant without a cabinet still shows the "Unmanaged" subscription chip
  next to "No cabinet" in saas-admin.

## Out of scope

- Any station/kiosk/device behaviour for a tenant without a cabinet (the
  offline products are not connected to the cloud; device pairing is not
  changed).
- A contact entity or billing e-mail for such tenants.
- A support-ticket feature.
- Reverting a tenant to `none`.
