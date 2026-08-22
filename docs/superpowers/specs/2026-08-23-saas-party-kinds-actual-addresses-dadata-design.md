# SaaS party kinds, actual addresses, and DaData suggestion behavior

**Date:** 2026-08-23

**Status:** Proposed

**Scope:** `apps/saas-admin`, platform commercial contracts, billing profiles, commercial snapshots,
and the supporting Postgres migration

## 1. Context

The SaaS platform has one seller party ("Our organization") and one billing party per tenant. The
seller is a singleton, but it is not necessarily a legal entity: either side may be a legal entity,
sole proprietor, self-employed person, or individual.

The current implementation has three gaps:

1. organization and address suggestions remain visible after an operator selects a DaData result;
2. billing profiles have legal/registration and postal addresses but no separate actual address;
3. the seller form and contract are restricted to `legal_entity` even though the shared database
   enum already supports all four party kinds.

The current commercial readiness rule also requires a default buyer bank account. That prevents
issuing an invoice to an individual or another buyer whose paying account is not known in advance.

## 2. Goals

- Let both seller and tenant profiles use all four existing billing-profile kinds.
- Add an independently controlled actual address to every current and future profile revision.
- Make DaData suggestion menus dismiss correctly without losing manual-entry fallback.
- Keep seller bank details required for commercial issuance while making buyer bank details
  optional and available for payment matching when known.
- Preserve historical profile revisions and issued document snapshots.
- Keep tenant production access independent from billing completeness and DaData availability.

## 3. Non-goals

- Multiple seller legal parties.
- Detecting self-employed tax status through DaData.
- Replacing the existing versioned profile tables with a generic party/address subsystem.
- Rewriting already issued offers, invoices, or payment evidence.
- Adding consumer checkout, acquiring, receipt, or fiscalization flows.
- Changing the tenant-creation fields or owner activation flow.

## 4. Party kinds and required identity fields

Both operator and tenant profile inputs use the same discriminated union:

| Kind              | Required identity fields                          |
| ----------------- | ------------------------------------------------- |
| `legal_entity`    | full name, display name, 10-digit INN, KPP, OGRN  |
| `sole_proprietor` | full name, display name, 12-digit INN, OGRNIP     |
| `self_employed`   | full name, display name, 12-digit INN             |
| `individual`      | full name, display name; 12-digit INN is optional |

`operatorBillingProfileInputSchema` and `operatorBillingProfileSchema` remain exported names for
route compatibility, but their accepted kind is widened to the same union as tenant profiles. The
API remains authoritative and validates the discriminator-specific field set.

DaData organization suggestions continue to cover legal entities and sole proprietors. Selecting a
suggestion may set those kinds and prefill their applicable identifiers. Self-employed people and
ordinary individuals are entered manually; address suggestions remain available for them.

## 5. Address model

The persisted profile keeps the existing legal-address names for backward compatibility. The UI
interprets that address as the registration address for a person.

Every operator and tenant profile revision contains:

- `legalAddressRaw` and optional normalized `legalAddress`;
- `actualSameAsLegal`;
- nullable `actualAddressRaw` and normalized `actualAddress`;
- `postalSameAsLegal`;
- nullable `postalAddressRaw` and normalized `postalAddress`.

The rules are:

- legal/registration address is always required;
- when `actualSameAsLegal` is true, actual raw and normalized values are null;
- when `actualSameAsLegal` is false, actual raw value is required and normalized data is optional;
- postal address retains its existing independent `sameAsLegal` behavior;
- choosing a DaData address only fills the draft; explicit profile confirmation remains required.

The first migration adds `actual_same_as_legal boolean not null default true`,
`actual_address_raw text`, and `actual_address jsonb` to both versioned profile tables. Existing
revisions therefore mean "actual address equals legal address" without fabricating copied provider
metadata. A check constraint prevents stored actual-address values when the flag is true.

Saving still inserts a new current revision transactionally. No prior revision is updated in place.

## 6. Form behavior and copy

The party-kind selector is visible for both `operator` and `tenant` scopes.

Labels adapt to the selected kind:

- legal entity and sole proprietor: `Полное наименование` and `Юридический адрес`;
- self-employed and individual: `ФИО` and `Адрес регистрации`;
- the separate field is always `Фактический адрес`.

The address section order is:

1. legal/registration address;
2. `Фактический адрес совпадает с юридическим / адресом регистрации`;
3. actual-address field when the flag is false;
4. the existing postal-address equality control and conditional postal field.

Changing a party kind does not save anything. Inapplicable hidden identifiers are excluded from
the discriminated request payload.

## 7. DaData suggestion interaction

Organization, address, and bank suggestion inputs follow one shared visibility state model:

- an eligible manual edit opens the menu when a ready result contains items;
- selecting an option fills the draft and closes the menu immediately;
- the selected value is suppressed so the cached query result cannot reopen the menu on render;
- a subsequent manual edit clears suppression and may open a new result;
- `Escape`, focus leaving the complete field/menu control, and an outside click close the menu;
- a provider result arriving after dismissal stays hidden until the user edits again;
- no-result, unavailable, and unconfigured statuses remain non-blocking and do not disable input.

The control exposes combobox semantics. Arrow keys move the active option, `Enter` selects it, and
`Escape` dismisses it. Pointer selection must complete before blur handling unmounts the option.
The menu does not reopen merely because the parent applies a selected DaData value.

The existing debounce, cancellation, server rate limit, normalized DTOs, and cache behavior do not
change.

## 8. Commercial readiness and bank accounts

Commercial issuance requires:

- confirmed current seller and buyer profiles;
- an active selected or default seller bank account.

A buyer bank account is optional for every profile kind. When an active default buyer account is
known, its immutable snapshot is stored on publication/issuance and it remains available for
automatic payment matching. When no buyer account is known:

- offer publication and invoice issuance still succeed;
- the buyer-account snapshot is null;
- audit metadata records a null buyer account rather than inventing one;
- payment evidence can later be matched by imported payer details or by an explicit operator
  decision.

Readiness is scope-aware: the seller workspace treats its default account as required; a tenant
workspace presents buyer accounts as optional payment-matching data and does not count them against
document readiness.

## 9. Snapshots and rendered documents

New seller and buyer profile snapshots include the actual-address fields and equality flag. Older
snapshot JSON remains valid when those fields are absent.

The standard invoice and offer renderers continue to show only applicable, non-empty party values.
They use OGRN for a legal entity, OGRNIP for a sole proprietor, INN when present, and omit missing
buyer bank details. The actual address is retained in the frozen snapshot for contractual and
future document use but is not added automatically to the current invoice layout.

No profile or bank-account edit rewrites an issued document.

## 10. API, audit, and authorization

- Existing operator and tenant billing-profile endpoints keep their paths and permissions.
- The broadened operator schemas and actual-address fields are added to the shared platform
  contracts and OpenAPI inventory.
- Tenant reads and writes remain tenant-scoped; operator singleton writes remain capability-gated.
- Profile audit snapshots include kind and address equality state without storing raw DaData
  responses.
- Invoice and offer audit events accept a null buyer-account identity and retain exact seller
  account evidence.
- DaData tokens and raw provider responses remain outside saved profiles and audit metadata.

## 11. Error and recovery behavior

- A dismissed suggestion stays dismissed even if its in-flight request resolves later.
- Manual entry remains available when DaData is unconfigured, unavailable, or returns no result.
- Invalid kind-specific identifiers or a missing independently entered actual address produce the
  existing local validation error and no write.
- Migration defaults preserve readable existing profiles; migration failure must roll back before
  application deployment.
- Existing documents with a non-null buyer account remain unchanged and readable.

## 12. Verification

### Contracts

- Accept every party kind for seller and tenant inputs.
- Reject identifiers that do not belong to the selected kind.
- Require actual-address raw text only when `actualSameAsLegal` is false.
- Parse old commercial snapshots without actual-address properties.

### Database and API

- Apply the migration on a fresh database and one containing existing profile revisions.
- Verify existing rows default to actual-equals-legal without copied address JSON.
- Verify profile revision, confirmation, actor, and tenant isolation behavior.
- Publish an offer and issue an invoice without a buyer account.
- Preserve optional buyer-account snapshots and payment matching when an account is known.
- Assert exact audit output for both null and known buyer accounts.

### SaaS admin

- Select all four kinds in both seller and tenant forms and submit their applicable payloads.
- Show kind-specific name and registration-address labels.
- Toggle and persist independent actual and postal addresses.
- Close organization, legal/registration, actual, postal, and bank suggestion menus after pointer
  and keyboard selection.
- Keep a dismissed menu closed after an in-flight response and reopen only after another edit.
- Close menus on `Escape` and focus leaving the complete control.
- Keep manual entry available for all DaData degraded states.
- Display scope-aware readiness without requiring a buyer bank account.

### Final gates

- Focused tests first, with each regression observed failing before implementation.
- Package tests, typecheck, lint, and build for platform contracts, DB, API, and SaaS admin.
- `git diff --check` and repository formatting checks for the scoped change.
- Browser acceptance against local API and SaaS admin for organization, every address field, kind
  switching, suggestion dismissal, and invoice issuance without a buyer account.
- Live DaData acceptance remains a separate production gate and must not mutate saved legal data.

## 13. Rollout

1. Apply the additive profile migration before starting the new API image.
2. Deploy API and SaaS admin from the same immutable release SHA.
3. Smoke-test existing seller and tenant profiles, then the four party kinds.
4. Exercise live organization, address, and bank suggestions without saving test values.
5. Verify issue/publication with and without a known buyer account.
6. Confirm existing issued documents still render from their frozen snapshots.

Rollback of application images remains possible because the migration is additive. Older code
ignores the new columns. The migration is not removed during rollback; saved new profile revisions
remain available to the restored release once application code is re-deployed.
