# US-01 — Parties and locations — Design Spec

**Revised:** 2026-09-05. Owner-approved design; server implementation in progress, not a completed slice.

Read the [shared MVP contract](../../us/mvp-contract.md), [access foundation](../../us/access-foundation.md) and [server implementation plan](../plans/2026-09-05-us-01-master-data-server.md). This revision replaces earlier proposals for a RU counterparty bridge, profile-dependent draft restrictions and registration in the RU application.

**Requirements:** LOC-001 through LOC-008. LOC-003 is consumed by US-02; LOC-005 and LOC-007 remain P1. UI and downstream finalization acceptance are separate from this server increment.

## Accepted behavior

1. A party describes who the organization deals with; a location describes a physical site. One party can have zero or many locations. US entities have no RU counterparty link and no mandatory GLN.
2. Both US profiles allow incomplete location descriptions. Internal name, business name and parent party remain required. Supplied values must be valid; missing description fields are readiness issues rather than draft-save errors.
3. A complete description is required when a later operation builds a finalized snapshot. Completeness is not an applicability decision or a legal-compliance verdict.
4. Archive and restore replace deletion. Archiving a party does not cascade to locations. Archived records remain available for authorized reads and historical references.
5. Creating, editing or restoring a location requires an active parent. Archiving a location under an archived party is permitted. Its parent cannot change after creation.
6. QA, manager, owner and admin can edit master data. Other recognized US roles can read; an ordinary member or unknown role receives no implicit access. Each operation checks current membership and a persisted valid US profile.
7. Finalized events retain copied descriptions. This slice supplies the pure snapshot builder; downstream event storage must separately prove historical immutability.

## Persistence

New module: `packages/db/src/schema/traceability-master-data.ts`, exported through the DB package. Generate the next forward migration; never rewrite applied migrations or bootstrap from RU records.

`traceability_parties` stores UUID and tenant identity, name, optional legal name, contact name/phone/email, notes, archived flag and timestamps. A case-insensitive active-name unique index is tenant-scoped. Archived names may be reused; restoring into an active-name conflict is rejected.

`traceability_locations` stores UUID, tenant and party identity, internal name, business name, phone, street address or decimal coordinates, city, state/region, ZIP/postal code, country code, roles, archive flag and timestamps.

- Composite `(tenant_id, id)` unique keys anchor the location's tenant/party foreign key. No delete cascade.
- Coordinates use `numeric(9,6)` and remain decimal strings across the API. Phone and postal code are text.
- Description fields other than business name are nullable. Street addresses reject coordinates; coordinate addresses reject street text but allow an incomplete pair in drafts.
- Database checks enforce nonblank names, coordinate ranges, uppercase two-letter country format and bounded non-null roles. Country format is not country recognition or address verification.
- Roles: `supplier`, `processor`, `ship_from`, `receive_at`, `recipient`, `tlc_source`. Multiple role filters use AND semantics. Tenant/party and role indexes support bounded queries.
- P1 GLN, FFRN and reference-URL fields remain deferred. No RU bridge column exists.

## Domain and contracts

`packages/domain/src/traceability/location-description.ts` owns the role constant, draft/export-ready validation and deterministic snapshot builder. Drafts validate supplied fields and address shape. Export-ready validation additionally requires business name, phone, street or both coordinates, city, region, postal code and country. Foreign addresses use comparable regional/postal fields, not a mandatory U.S. state/ZIP pattern.

Phones retain extensions; coordinates reject exponents, excessive precision and out-of-range values without rounding. The version-1 snapshot contains copied strings and a discriminated address. Country display uses fixed US/CA/MX names with code fallback; no clock, network or runtime-dependent display names.

Strict contracts live in `packages/platform-contracts/src/traceability/master-data.ts`: create/update/response schemas for parties and locations, bounded query/list schemas, and their inferred types. The domain package supplies shared rules through a workspace dependency.

Create defaults optional fields to null or the specified empty value. PATCH has no create defaults, requires at least one field and rejects parent-identity changes. Responses expose business fields, UUID, archive state and ISO timestamps, never tenant/actor inputs. Location responses include `descriptionStatus: { exportReady, issues }`.

Lists support archive state, literal substring search and bounded pagination; locations additionally support party/role filters. Default limit 50, maximum 100, maximum offset 100000; numeric query strings must be canonical decimal integers. No implicit totals or P1 same-address query. The implementation plan specifies exact field limits and interfaces.

## US-only API and authorization

`UsMasterDataStore` runs operations in transactions: lock/reload membership, validate and lock the persisted US profile, then consistently lock affected parent/entity rows. Reads require `traceability.read`; writes require `traceability.master_data.write`, including no-op PATCH. Profile-setup permissions do not substitute for master-data permissions.

Only `UsDevelopmentModule` registers the controller. Reuse its real session/MFA guard, server-derived principal/request ID and safe database wrapper. Do not register in the RU `AppModule` or inherit RU subscription gates. The subsequent typed browser/UI increment permits only its exact master-data routes and the presentation-only capability route; unrelated business paths stay closed.

| Method | Routes                                             | Behavior                                                             |
| ------ | -------------------------------------------------- | -------------------------------------------------------------------- |
| GET    | `/traceability/parties`, `/traceability/locations` | Bounded tenant-scoped list; active by default                        |
| POST   | The two collection routes                          | Strict create; write capability required                             |
| GET    | Each collection plus `/:id`                        | Archived records included; foreign/missing identity returns 404      |
| PATCH  | Each collection plus `/:id`                        | Merge/validate; update or archive/restore; no-op preserves timestamp |

No DELETE. Safe 400 for invalid inputs, 409 `party_name_taken` for the exact active-name conflict. Missing membership/profile or invalid profile fails closed; unexpected database errors become safe unavailable responses, not raw SQL or misleading validation errors.

Queries include tenant scope. Search escapes wildcard characters, with stable name/ID ordering. A foreign parent cannot create a location. Lifecycle locks serialize parent archival with location writes.

Each real mutation writes one atomic audit event: exact actor, tenant, request ID, target type/ID, success outcome and `traceability.party.created|updated|archived|restored` or location equivalent. Before/after contain full safe persistent business snapshots, not derived readiness; creation has null before. No-op creates no audit. Audit failure rolls back the write.

Preserve local Host/Origin rules, 16 KiB JSON, independent US cookies and safe errors. No startup migrations, seeds, deployment or external calls. Initial profile provisioning stays immutable; no profile-switch endpoint is introduced.

## UI handoff — subsequent increment

Follow [design brief 02](../../design-briefs/us/02-onboarding-and-master-data.md) and shared UI components. English and U.S. Spanish only; retain RU behavior separately.

- Party list/form: name, legal name, contact, notes; search, archive filter and capability-controlled actions. Party card contains its locations. No RU bridge or P1 identifiers.
- Location list: party/role filters, search, archive state and textual readiness. Form groups identity, description and roles. Parent picker is active-only on creation, read-only afterward.
- Both profiles allow incomplete drafts with “Required before this location can be used in a finalized event” hints. Format errors remain field errors. Name missing description fields precisely.
- Archive confirmations explain that history remains unchanged and children are not automatically archived. Read-only roles have no mutation actions.
- Include loading/empty/error/stale states, conflicts, archived parents, coordinate variants, keyboard/focus behavior and Spanish expansion. Status never relies on color alone.

No UI is claimed implemented or browser-verified by this server increment. P1 features extend existing groups later, without placeholders now.

## Verification and acceptance boundaries

- Domain/contracts: incomplete drafts, required snapshot fields, formats, source-mutation independence, strict unknown-field rejection, PATCH semantics, immutable parent, closed roles and bounded queries.
- DB: full migration chain in disposable US databases, composite tenant denial, active-name/restore conflicts, archived reuse, draft/address/range checks. Rebuild DB exports before consumer tests.
- Store: both profiles, role matrix and revocation, foreign IDs/parents, lifecycle conflicts, no-op behavior, exact audit/rollback, literal search and pagination.
- HTTP: real session/MFA, both resources, Host/Origin/body limits, forged input, safe profile/schema failures, absent DELETE/RU routes and strict OpenAPI contracts.
- UI/browser, finalized event history, seed/reset and hosted operation are separate gates. Builder tests do not prove an existing finalized event or package.

Track LOC-001/002/004/006 as partial only after corresponding server checks pass. LOC-003 belongs to lot source-reference integration; LOC-005/007 remain P1; LOC-008 synthetic test fixtures do not replace US-11's reproducible dataset. No complete-slice or release claim follows from this design.

## Deferred work

Lots and typed TLC source references (US-02); receiving/documents (US-03); transformation/shipping finalization and history (US-04/05); plan contacts (US-08); seed/reset/visual evidence (US-11); optional identifiers and same-address warnings (P1). Station, scanners, printers, geocoding and RU counterparties remain unchanged.
