# SaaS Admin Redesign and Legal Profiles Design

**Status:** Approved in product review on 2026-08-22

**Design source:** `docs/design-briefs/saas.pen`

## 1. Goal

Turn the internal SaaS administration application into the primary operational console for the
Markiro platform. The console must let platform staff understand platform state, create and manage
tenants, maintain catalog and subscription products, issue commercial documents, reconcile
payments, and audit every material change without interrupting an active tenant's factory work.

The redesign also completes the legal-data foundation that the current backend only partially
exposes: one current legal profile for Markiro, one current legal profile for every tenant, multiple
bank accounts for both parties, and server-side DaData suggestions for organizations, addresses,
and banks.

This is an architectural redesign, not a visual reskin. It changes information architecture,
contract ownership, legal-profile storage, billing readiness, and the application shell while
preserving the already implemented subscription, invoice, payment, and fulfilment behavior.

## 2. Sources and reconciliation

The source order for this design is:

1. the decisions approved in the 2026-08-22 review;
2. `docs/design-briefs/06-saas-admin.md`;
3. `docs/superpowers/specs/2026-08-09-saas-catalog-subscriptions-design.md`;
4. `docs/superpowers/specs/2026-08-11-tenant-billing-documents-design.md`;
5. current API, database, and `apps/saas-admin` source;
6. the visual system and flows in `docs/design-briefs/saas.pen`.

| Concern        | Original requirement                                         | Current implementation                                                            | Target state                                                                    |
| -------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Start page     | Operational dashboard                                        | `/` redirects to `/catalog`                                                       | `/` opens operational overview                                                  |
| Navigation     | Dashboard, tenants, plans, billing, monitoring, audit        | Large horizontal header with tenants, catalog, offers, billing, team, audit       | Left operational rail grouped into Operations, Commerce, Platform, and Settings |
| Tenants        | List and detail with subscription and activity               | List/detail, activation, subscription and usage are implemented                   | Add legal data, documents, payments, usage, and event tabs                      |
| Monitoring     | Platform health and incidents                                | No route                                                                          | Monitoring route plus health summary on overview                                |
| Legal profiles | One Markiro profile and one current profile per tenant       | Versioned DB tables and GET/PUT API exist; no SaaS UI                             | Full settings and tenant legal-data UI with readiness and history               |
| Bank details   | Required for documents                                       | Opaque `bankDetails` JSON on a billing profile                                    | Multiple first-class bank accounts for both parties, one default per party      |
| DaData         | Optional adapter; confirmed data stays authoritative locally | No code or configuration                                                          | Server-side party, address, and bank suggestions with manual fallback           |
| Documents      | Frozen seller/buyer history                                  | Invoice issuance freezes profile snapshots                                        | Also freeze the selected seller bank account and relevant payer account data    |
| Contracts      | Explicit loading/error states                                | Frontend duplicates response Zod schemas and has already rejected valid responses | One shared runtime contract source for API and SaaS client                      |
| Authentication | Same product identity and secure 2FA                         | Functional flow, but visual language diverges; QR was previously absent           | Markiro identity, split-screen auth, working QR and consistent recovery states  |

## 3. Scope

### In scope

- A new SaaS application shell and operational overview.
- Complete navigation and routes for tenants, catalog, offers, invoices, payments, monitoring,
  team, audit, and settings.
- One versioned legal profile for Markiro and one versioned legal profile for every tenant.
- Legal-profile kinds `individual`, `self_employed`, `sole_proprietor`, and `legal_entity` for
  tenants; Markiro uses `legal_entity`.
- Multiple active or archived bank accounts for Markiro and for every tenant.
- One active default bank account for each party.
- DaData organization, address, and bank suggestions through a server-side adapter.
- Explicit billing readiness without blocking tenant operations.
- Shared platform API contracts and precise contract-error diagnostics.
- Redesigned login, activation, recovery, and 2FA surfaces.
- RU and EN copy for every new user-visible state.
- Accessibility, browser checks, and production smoke coverage.

### Out of scope

- Multiple Markiro legal entities.
- Multiple concurrent legal profiles for one tenant.
- Foreign-currency invoices; current commercial documents remain RUB-only.
- EDI, Диадок, electronic signatures, fiscal receipts, or tax accounting.
- Automatic correction of operator-confirmed data from DaData.
- Automatic bank polling or recurring invoice generation.
- A redesign of customer cabinet, kiosk, or station applications.

## 4. Information architecture

The application opens on **Overview**, not Catalog. The persistent left rail uses four groups:

1. **Operations:** Overview, Tenants.
2. **Commerce:** Catalog, Offers, Invoices, Payments.
3. **Platform:** Monitoring, Team, Audit.
4. **Settings:** Our organization.

The overview answers one question: "What requires a platform operator's decision now?" It shows
active tenants, tenants approaching a restriction, overdue invoices, API availability, a decision
queue, platform health, upcoming restriction decisions, and recent activity. It is not a generic
analytics dashboard.

Tenant detail uses stable tabs:

- **Overview:** identity, owner activation, current state, and immediate actions.
- **Legal data:** legal profile, DaData confirmation, addresses, and bank accounts.
- **Subscription:** current/scheduled plan, add-ons, limits, and paid-invoice application.
- **Documents:** offers and invoices.
- **Payments:** payment history, import matches, and payer-account evidence.
- **Usage:** current entitlement consumption.
- **Events:** tenant-scoped commercial and operational history.

Our Organization contains Markiro's legal profile, postal/legal addresses, bank accounts, profile
revision history, billing readiness, and the visible health state of DaData. API secrets are never
shown or edited in this screen.

## 5. Visual and interaction system

`docs/design-briefs/saas.pen` is the approved visual source. The implementation keeps its warm
paper surfaces, dark left rail, IBM Plex Sans/Mono typography, restrained green accent, square
operational geometry, and dense tables. The implementation must not reinterpret this as glass,
soft-bento, or rounded-card UI.

Rules:

- Use the dark left rail and remove the oversized horizontal application header.
- Optimize for 1440 px and preserve the hierarchy at 1024 px.
- Use compact tables for lists and financial data; cards exist only for real structural grouping.
- Give every page one primary action and one dominant content region.
- Show status using text and color, never color alone.
- Use 120-180 ms motion only for navigation, disclosure, and feedback.
- Preserve visible keyboard focus, semantic controls, 44 px touch targets where appropriate, and
  reduced-motion behavior.
- Use tabular numbers and monospaced secondary metadata for identifiers, money, timestamps, and
  revisions.

Tenant creation stays short: name, slug, and owner email create the tenant immediately. The tenant
then receives a readiness checklist for legal data, bank account, and subscription. Incomplete
billing data prevents publishing an offer or issuing an invoice, but never prevents the tenant from
operating the production application.

## 6. Legal profiles

The existing `operator_billing_profiles` and `tenant_billing_profiles` remain the versioned legal
profile history. A save never mutates the current record in place: the service marks the old record
non-current and inserts the next revision transactionally.

The common legal profile contains:

- profile kind;
- full and short/display names;
- INN, KPP, OGRN, or OGRNIP as applicable;
- raw legal address and confirmed normalized legal-address object;
- raw postal address and normalized postal-address object, or an explicit `sameAsLegal` marker;
- contact name, email, and phone;
- confirmation status, confirming platform user, and confirmation timestamp;
- actor, revision, and creation timestamp.

API validation is discriminated by profile kind:

- `legal_entity`: full name, INN, KPP, OGRN, and legal address are required;
- `sole_proprietor`: full name, INN, OGRNIP, and legal address are required;
- `self_employed`: full name, INN, and address are required;
- `individual`: full name and address are required; INN is optional.

The UI may prefill these values from DaData, but it must show the resulting fields for confirmation.
Selecting a DaData suggestion is not itself a save.

## 7. Bank accounts

Bank accounts are first-class records, not an array hidden inside a profile JSON value. Use separate
operator and tenant account tables so tenant scoping is structural and the operator singleton does
not introduce nullable-tenant ambiguity.

Each account stores:

- stable ID and, for tenant accounts, tenant ID;
- operator-defined label;
- settlement account number;
- BIC;
- bank name;
- correspondent account;
- currency;
- `active` or `archived` status;
- default flag;
- actor and timestamps.

For the current RUB billing flow, the settlement account and correspondent account are exactly 20
digits, BIC is exactly 9 digits, and currency is `RUB`. The schema keeps a currency column so the
record is explicit, but no non-RUB account is selectable for a commercial document in this scope.

There is exactly one active default account per party. A transaction locks the party's account set
when changing the default. Account identifiers are immutable after the account has been used in an
issued commercial document or a matched payment. Corrections create a new account and archive the
old one. Archiving an unused account is allowed; hard deletion is not part of the operator UI.

Markiro's default account is preselected for a draft offer or invoice. The operator may select a
different active Markiro account. Issuance or publication freezes its complete account snapshot in
the document. If the selected account is archived before issuance, the draft becomes not ready and
requires another account.

Tenant accounts are available for payer identification and payment matching. A default tenant
account is required for billing readiness, but a tenant may pay from any active known account or an
unknown account that the operator resolves manually. No account change rewrites an issued document
or historical payment evidence.

### Existing-data migration

The migration does not delete `bankDetails` from an existing profile or rewrite issued snapshots.
It attempts to create a first-class account only when the stored JSON contains a complete,
unambiguous Russian account number, BIC, bank name, and correspondent account. An imported account
is marked default and records migration provenance. Incomplete or unrecognized JSON remains in the
historical profile revision; the current party is marked not ready for new document issuance until
an operator confirms a first-class account. The legacy column is removed only in a later migration
after production verification proves that no current profile depends on it.

## 8. DaData adapter

DaData is an optional assistive integration and never the source of truth for saved billing data.
The browser calls bounded platform endpoints; only the API calls DaData. The token and any secret
remain in production secret configuration and are never returned, logged, or written into audit
metadata.

The adapter exposes internal normalized results for:

- organization suggestions by INN or name;
- address suggestions for legal and postal address fields;
- bank suggestions by BIC or bank name.

The client waits 250 ms after input, cancels superseded requests, and queries after three
non-whitespace characters. Exact INN and BIC input is accepted immediately when it reaches its
valid length. The API limits a normalized query to 300 characters, aborts the provider request
after two seconds, permits 60 suggestion requests per platform user per minute, and caches an
identical normalized successful query for 15 minutes. It maps the external payload to a small
internal DTO; raw DaData responses do not become platform contracts.

The normalized address DTO contains the original display value plus FIAS ID, KLADR ID, postal code,
region, city, settlement, street, house, block, flat, geocoordinates when returned, and DaData's
quality/completeness markers. Missing optional components remain `null`; the adapter does not invent
them.

If DaData is slow, unavailable, unconfigured, or returns no suggestion:

- the form remains editable;
- a non-blocking integration status explains the limitation;
- local validation still runs;
- confirmed saved data remains available;
- invoice, payment, and tenant operations that do not require new suggestions continue normally.

## 9. Commercial document readiness and snapshots

Publishing an offer or issuing an invoice requires:

- a confirmed current Markiro legal profile;
- an active selected Markiro bank account;
- a confirmed current tenant legal profile;
- at least one active tenant bank account with a default;
- valid document lines and current business invariants.

Draft creation remains possible before readiness is complete. The composer displays missing
requirements before the review step and links directly to the relevant settings surface.

At publication or issuance, one database transaction freezes:

- seller legal-profile snapshot;
- selected seller bank-account snapshot;
- buyer legal-profile snapshot;
- buyer default bank-account snapshot;
- all line, price, VAT, date, application-policy, and catalog-version fields already required by
  the billing model.

Historic PDFs, HTML views, and offer documents render only from their frozen snapshots. They never
read a current profile or account during download or re-render.

## 10. Platform contracts

Create a dedicated shared platform-contract package containing the runtime schemas and inferred
TypeScript types for SaaS platform endpoints. The package is the only definition of successful
request and response shapes used by `apps/api` and `apps/saas-admin`.

The API must:

- return explicit DTOs instead of `Promise<unknown>`;
- validate or serialize service results through the shared response schema at the controller
  boundary;
- publish the same schema in OpenAPI;
- keep stable machine-readable error codes and a request ID.

The SaaS client must:

- parse the response with the shared runtime schema;
- stop maintaining handwritten copies of API response schemas;
- distinguish network, authorization, domain, and contract failures;
- record a safe contract diagnostic containing endpoint, schema issue path, release SHA, and
  request ID without logging response bodies or secrets.

The UI shows a useful retry path and request ID for a contract failure instead of collapsing every
failure into "Не удалось загрузить". A single failed panel must not erase successfully loaded
independent data on the same page.

## 11. Authorization and audit

Server authorization remains authoritative:

- `platform_admin`: every platform surface and mutation;
- `accountant`: legal profiles, bank accounts, offers, invoices, payments, and financial audit;
- `support`: tenants and diagnostics without financial mutations.

The UI hides impossible primary actions and explains restricted read-only states, but it does not
replace server checks.

Audit records are required for:

- legal-profile revisions;
- bank-account creation, default changes, and archival;
- DaData-assisted confirmation as bounded metadata, not raw provider payload;
- document account selection and issuance/publication snapshots;
- payment matching to a known tenant account;
- every existing subscription, invoice, payment, and fulfilment mutation.

Assertions must verify actor, role, tenant, action, target, outcome, and meaningful before/after
metadata.

## 12. Authentication surfaces

Login, activation, recovery, and 2FA use the same Markiro identity and visual system as the console.
The split-screen composition in `saas.pen` is the target. The production logo asset is used rather
than a synthetic letter or unrelated mark.

The 2FA enrollment state must show:

- a scannable QR code generated from the server-provided `otpauth` URI;
- the manual key as an accessible fallback;
- backup codes once, with a clear save/copy action;
- verification input and precise failure/retry states;
- no secret or backup-code logging.

## 13. Loading, empty, error, and success states

Every data surface explicitly implements:

- loading skeleton or progress state;
- truthful empty state with the next available action;
- retryable network/infrastructure error;
- permission state;
- contract mismatch state;
- mutation success confirmation;
- partial external-integration degradation where applicable.

Destructive or history-changing actions require confirmation. Unsaved legal-profile and document
forms participate in the existing navigation guard. DaData suggestions are transient and do not
mark a form dirty until the operator selects or edits a value.

## 14. Delivery decomposition

Implementation is staged into independently releasable slices:

1. **Contract foundation:** shared platform contracts, explicit API responses, removal of duplicate
   SaaS response schemas, and regression coverage for every existing route.
2. **Legal foundation:** migrations, discriminated validation, bank-account services, tenant
   isolation, audit, and snapshot invariants.
3. **DaData:** adapter, configuration, bounded endpoints, graceful degradation, and form controls.
4. **Shell and overview:** left rail, overview route, monitoring entry point, and responsive shell.
5. **Tenant and settings surfaces:** tenant tabs, readiness, Our Organization, legal forms, and bank
   account management.
6. **Commerce integration:** account selection, readiness links, frozen snapshots, payments, and
   document rendering.
7. **Remaining pages and authentication:** migrate catalog/offers/invoices/team/audit and complete
   login/2FA visual parity.

No slice may make tenant production access depend on billing completeness or DaData availability.

## 15. Verification

### Automated

- Shared-contract tests using production-like API payloads for every SaaS route.
- API controller tests proving response-schema validation and stable error codes.
- DB migration and schema tests for legal profiles and both bank-account tables.
- Cross-tenant denial for every tenant bank-account query and mutation.
- Transaction tests for revision increments and exactly one active default account.
- Snapshot invariance after legal-profile or bank-account changes.
- DaData adapter mapping, timeout, cancellation, rate limit, cache, no-result, and unconfigured tests.
- Invoice and offer readiness tests, including an account archived between draft and issuance.
- Payment matching tests for known, unknown, and archived tenant accounts.
- Component tests for lookup, address suggestions, manual fallback, account selection, and every
  loading/empty/error/permission state.
- Authentication tests for logo, QR rendering, manual key, backup-code lifecycle, and verification.
- Package test, typecheck, lint, build, format, and production bundle contract gates.

### Browser and external

- Keyboard-only review and accessibility audit of shell, tables, tabs, forms, dialogs, and auth.
- Visual review at 1024 and 1440 px in RU and EN.
- Browser flows for tenant creation, legal readiness, DaData/manual entry, multiple bank accounts,
  invoice account selection, payment confirmation, and subscription application.
- Production smoke against exact release SHA for overview, tenants, settings, invoice flow, login,
  and 2FA.
- A real DaData credential and live-provider acceptance check remain an external gate; automated
  tests use a deterministic adapter fake and must not contact production DaData.

## 16. Approved Pencil changes

The approved design source contains these additions:

- navigation entries for Payments and Settings / Our Organization;
- `16 / Наша организация` with DaData lookup, legal profile, multiple Markiro bank accounts,
  readiness, revision history, and integration status;
- `17 / Юридические данные тенанта` with address suggestions, multiple tenant accounts, billing
  readiness, and non-blocking operational warning;
- an updated `09 / Формирование счёта` with explicit Markiro bank-account selection and snapshot
  notice.

These frames extend the existing approved operational overview, tenant, subscription, invoice,
login, and 2FA screens; they do not replace the established visual identity.
