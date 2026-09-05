# US parties and locations foundation

Status: server runtime, typed browser transport and office UI delivered and reviewed locally, 2026-09-05; the subsequent US01-UI-01 recovery correction is implemented below. This is a partial increment of US-01, not completion of event workflows or release. See the [accepted design](../superpowers/specs/2026-09-03-us-01-parties-locations-design.md), [server plan](../superpowers/plans/2026-09-05-us-01-master-data-server.md) and [office UI plan](../superpowers/plans/2026-09-05-us-01-master-data-ui.md).

## Product rules

Parties and physical locations are separate US entities. One party can have multiple locations; no RU counterparty bridge or mandatory GLN is involved. Each record is owned by one tenant. Location parent identity is immutable after creation.

Both US profiles permit incomplete descriptions. Internal name, business name and parent identity are required, and supplied values must be valid. A missing phone, region, postal code or address produces an explanatory readiness issue, not a draft-save error. Building a complete description snapshot remains blocked until the required fields are present. This status describes data completeness, not legal compliance or applicability.

Master data is archived/restored, never deleted. A party archive does not cascade. Creating, editing or restoring a location requires an active parent; archiving a location under an archived parent remains possible. Later finalized events must retain copied description values rather than reading current master data.

Read and write rights follow the [US capability matrix](access-foundation.md): recognized US readers can read; QA, manager, owner and admin can edit. Authorization is a server responsibility, not a hidden-button convention.

## Implementation boundaries

- Domain owns description validation, the role inventory and fixed-key version-1 snapshot values. Phone extensions and postal strings retain their values; coordinates have explicit precision/range checks.
- Shared strict contracts own create/PATCH/list/response shapes. PATCH does not default omitted values or accept parent changes. Lists have bounded pagination and reject oversized response envelopes.
- Persistence owns tenant-scoped keys and lifecycle constraints. A forward migration adds US tables without altering RU counterparties or copying their records.
- The US-only store/controller owns fresh transactional authorization, profile validation, safe errors and atomic before/after audit. Identical updates preserve timestamps and create no extra audit.

Verification below distinguishes delivered server evidence from remaining UI and downstream work.

## Verification record

### Domain and contracts

The domain suite passes 599 tests; the final contracts suite passes 130 tests. After review found an unbounded list-response array, four regression cases were added: oversized arrays and arrays larger than the declared limit, for both resources. All 28 focused master-data contract tests pass after the fix. Domain/contracts typechecks, lint and builds pass. Independent task review accepts the corrected contracts.

The package relationship adds only `@markiro/domain: workspace:*` to contracts. No third-party version changes; the dependency policy check passes. These unit and build results do not prove persistence, HTTP, browser or hosted behavior.

### Persistence

Migration `0115_traceability_master_data.sql` adds two tables and two enums; the generated snapshot comparison shows no existing table/enum changes. All six schema tests and five migration tests pass against a disposable US database upgraded through the full previous chain. They cover tenant-key denial, active-name/restore conflicts, draft/coordinate/role checks, unchanged RU counterparties and absence of cascading archive/deletion. Independent task review accepts the migration.

The DB package passes 230 tests, typecheck, lint and build; 141 unrelated infrastructure-gated tests are skipped. Only explicit `US_TEST_DATABASE_URL` and the loopback-only disposable fixture helper were used. Neither the main product's database nor the base US development database was provisioned.

### HTTP

The US-only API provides GET/POST collection and GET/PATCH item routes for `/traceability/parties` and `/traceability/locations`. No DELETE route or RU registration is added. The subsequent browser transport increment permits only these exact collection and UUID item paths through the local US proxy; it does not open other US or RU business routes.

All 28 new store/HTTP tests and the complete 142-test US API suite pass with real PostgreSQL transactions and session/MFA HTTP fixtures, including a fresh run after the OpenAPI correction. Coverage includes draft location create/read/update under both profiles, role changes, tenant denial, strict input, lifecycle/parent restrictions, coordinate no-op retries, exact audit/rollback, filters and safe errors. API typecheck, lint and build pass. Missing profiles return `403 traceability_profile_required`, never the profile endpoint's initial-setup signal; invalid persisted profiles produce a safe 503 response. Independent API task and broad integration reviews accept the runtime implementation. The subsequent scoped review of the OpenAPI correction and browser transport reports no remaining findings.

The previously overlapping 400 `oneOf` alternatives are now distinct: the code-only middleware response is a closed object with code `us_invalid_body`, separate from `{code:"invalid_master_data",issues:[{path,message}]}`. A regression assertion converts the complete published schema using the existing pinned Zod library and validates a real HTTP validation response, accepted middleware/default shapes and malformed negative cases. It failed against the overlap before the fix; all seven focused HTTP tests pass afterward. No new validator dependency or runtime error payload change was introduced.

The CI persistence step includes new domain, contract, schema/migration and API tests. Before final coverage additions, local CI-equivalent focused groups passed 31 domain, 49 contract, 18 DB and 127 API tests. The final 142-test US API run includes that API subset and the two added cross-profile location cases. No primary development environment is loaded to make them pass.

The broad API diagnostic before final metadata/test polish is **not green**: 1611 assertions pass, 1411 are skipped, and eight test files fail during setup. They are the same files as the prior access increment: `billing-accounts`, `exchange-credentials`, `exchange-import`, `exchange-orders`, `exchange-protocol`, `integrations-delete`, `integrations` and `subscription-route-inventory`. Configuration validation reports absent primary auth/origin/pairing settings; those settings and the primary database were not substituted. All eight US files and their then-current 140 tests pass within this same broad run. The broad diagnostic was not repeated for metadata, test coverage and JSDoc-only polish. This does not establish full RU integration acceptance. The existing test-runner module-format warning is also recorded, not hidden by a configuration change.

### Browser transport

`apps/admin/src/us/client.ts` now exposes party/location list, get, create and update methods. Shared contracts validate inputs before any request and validate responses before returning them. UUIDs are normalized; pagination is bounded; search is encoded as a value; repeated roles preserve AND filtering. PATCH retains omitted fields and never accepts reparenting. Incomplete drafts remain valid, while phone extensions, leading-zero postal codes and coordinate strings retain their values.

The existing same-origin session transport retains its timeout, no-store policy, redirect refusal, safe errors and no automatic retry or persistence. Missing-profile errors on business routes never open administrator setup. At the transport checkpoint, the 17 new client tests and 25 existing client tests passed. The check-only US workflow includes the suite. The office increment below adds the connected forms and their separate acceptance evidence.

The real Vite/API proxy smoke passes: admitted party/location collection and UUID paths reach the session guard and return anonymous 401/no-store; unknown, malformed, future US and RU routes return 404. Host rewriting and untrusted mutation Origin refusal remain covered. This is local transport evidence, not an authenticated CRUD flow through new forms.

### Existing interface compatibility

After the transport increment, all 1035 admin tests in 93 files pass with no skips. Admin typecheck, lint, the ordinary build and the isolated US build pass. Lint retains five existing hook-dependency warnings in unchanged RU pages. The DOM suite reports canvas/navigation limitations of its test environment; the ordinary build reports an oversized-chunk warning.

The existing real Chromium flow passes after API integration: password/MFA, active organization, profile persistence, English/Spanish and mobile. Its safe-state screenshots are local test artifacts. The harness emits a module-type warning; no API package mode was changed to silence it. This is access/profile regression coverage, not browser acceptance of new master-data screens, which are not implemented here.

### Release isolation

The 17 existing release/browser-entry boundary tests pass. They verify locked operational workflows and the local US entry/proxy boundary, not live infrastructure. Work remains on `codex/us-mvp`, with no PR, merge, release or deployment from this increment.

### Office UI increment — 2026-09-05

The profile summary now opens an isolated reference-data workspace with Parties, Locations and a return to Profile. It uses the existing shared controls, typography and theme tokens. Only implemented sections appear; there is no fabricated event history or future-workflow navigation.

Parties have search, archive-state filters, pagination, details, create/edit and archive/restore. A party's detail view lists its locations and starts a location form with that party selected. Locations have search, parent and role filters, pagination, description readiness, details and lifecycle actions. Forms use shared input validation, preserve values after failed writes and confirm discarded edits. Location parent identity cannot be changed. An archived parent blocks editing/restoring a location but does not prevent archiving it. Incomplete descriptions remain saveable under both profiles.

`GET /traceability/access` supplies only a strict capability array from the freshly resolved session principal. It does not replace server authorization or provision a profile. Unknown roles receive an empty array. The UI shows mutations only with the write capability; a forbidden mutation refreshes access, and session loss returns to sign-in. Returning to Profile is disabled while a mutation settles, retaining the existing serialized logout path.

All 1,071 admin tests in 95 files pass with no skips after review fixes. The focused UI/form/client/app group passes 64 tests. Contracts pass 131 tests. Admin and contract typechecks, lint and builds pass, including both ordinary and isolated US admin builds. Existing RU hook warnings, JSDOM canvas/navigation warnings and the ordinary build's large-chunk warning remain recorded. These automated checks do not constitute full RU API acceptance.

Real Chromium passes the connected MFA/profile → party creation → incomplete location creation → archive/restore flow through the actual local proxy and disposable database. It also checks focus retention/trapping, a reachable mobile form footer, fresh auditor read-only controls, translated success notices, and EN/ES × light/dark × 1440/390 list layouts without page-level horizontal overflow. The controller inspected safe synthetic-data screenshots. A mobile drawer-footer defect and two visual/localization issues were found and corrected before repeated green browser runs. Captures disable finite drawer animations to avoid presenting an intermediate frame as layout evidence. No MFA secrets are captured.

The complete US API group passes 143 tests across eight files against disposable loopback databases, including eight focused real-MFA master-data HTTP tests. The capability endpoint is covered before profile creation, across role changes, without a session and after membership removal. API typecheck, lint and build pass. The real proxy smoke and all 17 isolation checks pass. The check-only workflow includes the new form/UI and capability-contract suites. Independent review and one scoped final re-review are complete, with no remaining Critical or Important findings.

Independent task review found and verified fixes for access-gate navigation, field-safe validation copy, the party-detail locations list's error/retry/stale states, workspace decomposition and genuine profile-dependent form coverage. The coordinator and each list now have separate modules. Pending archive and StrictMode lifecycle regressions were added during the split; the detected regressions were corrected and the full admin/browser gates rerun. Chromium additionally verifies Profile remains reachable while access loading is held and after an injected network failure. This network-failure exercise does not mock business response data. Component form saves cover both actual profile props; the browser fixture uses the FSMA profile only.

The final-review fix wave adds counted mutation ownership through post-write refresh, disabled conflicting entry points and editable fields while saving, and a stable selected-parent filter across searches. Read-only details expose saved contacts/notes and location description fields with named readiness gaps. A concurrent parent archive has its own error classification and refresh/recovery path while form input is retained; it is not misreported as a role change. Opening another party resets child rows/pagination, and an archived child explains that its parent must be restored first. Focused tests cover these cases; the separate correction below adds same-page parent-reselection coverage. Real Chromium holds actual POST and GET requests to verify field freezing and navigation guards, reads the saved fields as an auditor, and checks the updated detail drawer at 390px.

### Parent-picker recovery correction — 2026-09-05

US01-UI-01 is resolved in a separate follow-up. Freshly resolved parent rows are kept by ID for the lifetime of the open form, independently of the selected parent. Choosing active B no longer makes known-archived A selectable, and stale search-list results cannot replace that resolved state. Both same-page A → rejection → B → attempted A and search-reload variants have regression coverage, including preserved input and the exact submitted B identity. No server authorization, persistence, shared catalog or release configuration changed.

The two regressions failed on the original implementation, then passed after the correction. Full admin passes 1,073 tests in 95 files; the focused UI/form/client/app group passes 66. Typecheck, lint and ordinary/US builds pass with the previously recorded warnings. The existing real Chromium flow passes with no skips; the new same-page sequence is component-level coverage, not a new real-database browser acceptance claim. Independent scoped review found no Critical or Important findings.

## Still open

- Downstream work remains: actual finalized event storage and historical exports; typed lot source references (US-02); seed/reset and complete synthetic demo evidence (US-11). Optional identifiers and same-address warnings remain P1. Scanners, printers and Station remain outside this increment.
