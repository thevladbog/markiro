# Catalog version editor design

**Date:** 2026-08-11
**Status:** Awaiting written-spec review

## Goal

Make catalog versioning understandable and safe for platform administrators. An operator must be able to create a new draft from an existing version, see and edit every commercial term that will be billed, and understand whether a catalog item changes subscription entitlements or represents a one-time service.

## Scope

This change covers the SaaS-admin catalog UI and its existing platform catalog API contract. It does not change invoice calculation, subscription assignment semantics, or the immutable-history model.

## Catalog item semantics

### Plans

Plans are recurring subscription products. They define base quotas and features and use recurring billing units.

### Add-ons

Add-ons are recurring subscription extensions. Every add-on must expose at least one explicit effect:

- quota increment for lines, stations, kiosks, or cabinet users; or
- feature enablement for the label editor, public API, or pallet workflows.

An add-on may combine several distinct effects. The creation form must never inject a hidden default effect. Published versions show the complete effect summary.

### Services

Services are one-time billable items such as implementation, training, setup, or consulting. They do not change subscription quotas or features.

## Creating a new version

Published and retired version panels expose a primary action named `Новая версия` / `New version`. Draft versions do not show this action.

Activating the action:

1. Builds a complete create payload from the selected version, including localized text, descriptions, billing terms, price, VAT, plan entitlements, and add-on effects.
2. Sends the payload to the existing `POST /platform/catalog/items/:code/versions` endpoint using the same catalog item code.
3. Relies on the existing locked backend transaction to allocate the next version number.
4. Adds the returned draft to the catalog query cache and opens it immediately in the editor.

The action is disabled while the request is pending. A conflict or validation failure leaves the source version open and shows a translated error. Clicking the action twice must not create two requests from one UI interaction.

The new version is a durable draft immediately after the action succeeds. Subsequent edits use the existing draft `PATCH` flow.

## Units of measure

The unit field becomes a catalog-kind-aware custom select.

Plans and add-ons offer:

- month (`month`);
- year (`year`);
- other.

Services offer:

- item (`unit`);
- hour (`hour`);
- person (`person`);
- person-day (`person_day`);
- day (`day`);
- project (`project`);
- session (`session`);
- package (`package`);
- other.

Selecting `other` reveals a required free-text input. Existing or cloned values that are not in the standard list automatically select `other` and preserve the exact stored value. The API continues to store a bounded string, so no schema migration is required.

## VAT

VAT is visible in create, draft edit, read-only version details, and cloned versions.

The selector offers:

- without VAT (`null`);
- 0%;
- 5%;
- 7%;
- 10%;
- 20%;
- 22%;
- other rate.

An `other` rate accepts a percentage from 0 through 100 with at most two decimal places and converts it to integer basis points for the API. New catalog items default to 22%. Cloned versions preserve the exact source rate.

For every non-null rate the UI sends `vatIncluded: true` and explicitly states that VAT is included in the unit price. `Without VAT` sends `vatRateBps: null`; the included flag is false for that representation. Existing read-only data is displayed truthfully even if it predates this rule.

## Add-on effect editor

The add-on creation form and draft editor use the same effect-editor behavior:

- at least one effect is required;
- an effect key may appear only once;
- quota effects require a positive PostgreSQL-safe integer;
- feature effects require no numeric value and display an enabled state;
- operators can add and remove effects up to the backend limit of seven;
- a live summary explains the resulting entitlement changes in plain language.

This shared behavior replaces the current hidden `+1 station` default. A newly opened add-on form may start with a visible `stations +1` row for convenience, but it is part of the editable form and is never submitted invisibly.

## Drawer behavior

Catalog create and version panels are fixed drawers above the catalog with a visible backdrop.

- Clicking the backdrop closes a read-only panel immediately.
- Clicking the backdrop or pressing Escape closes an unchanged create/draft panel.
- If a create or draft form has unsaved changes, backdrop, Escape, close, tab switch, row switch, and route navigation use the same confirmation guard.
- Confirming discard closes the drawer; cancelling keeps the drawer and form state.
- Keyboard focus moves into the drawer when it opens, remains trapped while open, and returns to the triggering control after close.
- The drawer remains fully usable at desktop and 390 px mobile widths without page-level horizontal overflow.

## Component boundaries

- `CatalogPage` owns active kind, pagination, selected version, create state, and the clone-version mutation result.
- `CatalogVersionPanel` owns draft editing and exposes the new-version action for immutable versions.
- `CatalogCreatePanel` owns new-item creation and the complete plan/add-on/service form.
- A shared unit selector encapsulates standard/custom unit behavior.
- A shared VAT selector encapsulates percentage parsing and basis-point conversion.
- A shared add-on effect editor is used by both creation and draft editing.
- A shared catalog drawer layer owns backdrop, Escape handling, focus management, and discard confirmation integration.

These are UI boundaries only. The existing backend endpoint, validation schemas, locking, version numbering, and audit behavior remain authoritative.

## Error handling

- Backend validation errors produce translated form-level messages and preserve entered values.
- Duplicate catalog codes and concurrent version conflicts use the existing conflict message path.
- A failed clone leaves the source version selected and does not mutate the local catalog cache.
- Invalid custom units, VAT rates, money values, quotas, or duplicate effects are blocked before an API write.
- Published and retired versions remain immutable; only the new draft can be edited.

## Verification

Automated coverage must include:

- cloning plan, add-on, and service versions with exact payloads;
- next-version response opening as a draft;
- clone failure and double-submit protection;
- standard and custom units for every catalog kind;
- VAT presets, custom basis-point conversion, without-VAT representation, and included-price copy;
- visible add-on effects during creation with no hidden defaults;
- quota/feature effect validation and preservation;
- backdrop/Escape close behavior with clean and dirty forms;
- focus entry, focus return, and keyboard operation;
- existing publish, retire, archive, default-demo, support-redaction, pagination, and row-opening flows.

Browser verification must cover the real local API data at desktop and 390 px widths, including visible drawers, backdrop dismissal, no horizontal overflow, and no console errors.

## Out of scope

- New database tables or migrations.
- Changing how subscriptions apply plan or add-on effects.
- Adding service fulfillment workflows.
- Changing invoice totals or offer snapshot semantics.
- Removing arbitrary legacy unit values.
