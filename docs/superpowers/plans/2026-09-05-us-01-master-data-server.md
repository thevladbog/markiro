# US-01 master data server implementation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Preserve existing uncommitted US access changes. No commits/pushes in this increment.

**Goal:** Implement isolated US parties and locations with draft validation, archive/restore, transactional authorization and audit.

**Architecture:** Pure domain location rules, strict shared contracts, additive US tables, transaction-backed services and controllers mounted only in UsDevelopmentModule. The RU app and counterparties remain unchanged.

**Tech Stack:** Existing Node 24, TypeScript, Zod, Drizzle/PostgreSQL, NestJS and Vitest. No new third-party dependencies. The contracts package may add a `workspace:*` dependency on domain, with a pnpm-generated lockfile update, to share rules.

**Spec:** `docs/superpowers/specs/2026-09-03-us-01-parties-locations-design.md`; owner-approved corrections below supersede its historical examples.

## Global Constraints

- Work only in `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, branch `codex/us-mvp`. Keep previous uncommitted access work. No commit, push, PR, release, hosted resource or base database provisioning.
- US parties and physical locations are independent entities; one party has many locations. No `counterparty_id`, RU bridge, mandatory GLN or RU module registration.
- Draft location descriptions can be incomplete in both US profiles. Required identity: internal name, business name and partyId. All supplied values must be structurally valid. Export-ready description validation belongs to the snapshot builder, not every CRUD write.
- Archive/restore only, no DELETE. No cascade archive. Archived records remain retrievable; list defaults to active. Creating/editing/restoring locations requires an active party; archiving a location under an archived party is allowed. Historical snapshots are values, never live references.
- All queries and relationships tenant-scoped. MFA principal comes from server session. Reads require `US_CAPABILITY.READ`; writes require `MASTER_DATA_WRITE`. Resolve current membership inside each transaction with a row lock. User IDs/tenant IDs/request IDs come from server, never payload.
- Requires a persisted, valid US profile. Missing/RU/invalid profile fails closed. Do not reuse profile store read to authorize master data, since its missing-profile error opens setup.
- Preserve local-only Host/Origin, 16KiB JSON, safe503 mapping, no external requests. No third-party dependency installs or primary `.env`/DATABASE_URL; only the Task1 internal workspace link is permitted. Test only explicit `US_TEST_DATABASE_URL` on loopback55432 with disposable `markiro_us_profile_*` databases.
- P1 optional GLN/FFRN/reference URL and same-address warnings are not added here. No UI, CSV, CTE, lot or Team endpoint in this increment. Do not claim those finished.

## Task 1: Pure location rules and shared contracts

**Files:** create `packages/domain/src/traceability/location-description.ts`, `packages/domain/test/traceability-location-description.test.ts`; append exports in domain index. Create `packages/platform-contracts/src/traceability/master-data.ts`, `packages/platform-contracts/test/us-master-data.test.ts`; append exports in contracts index. Add the domain workspace dependency in the contracts manifest and generate the scoped pnpm lock update. Do not edit DB/API files.

**Interfaces:**

```ts
type TraceabilityLocationRole = 'supplier'|'processor'|'ship_from'|'receive_at'|'recipient'|'tlc_source';
interface LocationDescriptionInput {
  businessName: string;
  phoneNumber: string | null;
  addressKind: 'street'|'coordinates';
  streetAddress: string | null;
  latitude: string | null;
  longitude: string | null;
  city: string | null;
  stateOrRegion: string | null;
  zipOrPostalCode: string | null;
  countryCode: string | null;
}
type LocationDescriptionIssue = {field: keyof LocationDescriptionInput; code:'required'|'format'};
validateLocationDescription(input: LocationDescriptionInput, mode:'draft'|'export_ready'): LocationDescriptionIssue[];
buildLocationDescriptionSnapshot(location: LocationDescriptionInput & {id:string;partyId:string}):
  {ok:true;snapshot:LocationDescriptionSnapshot}|{ok:false;issues:LocationDescriptionIssue[]};
```

Snapshot schemaVersion1, locationId, partyId, businessName, phoneNumber, address discriminated `{kind:'street',streetAddress}` or `{kind:'coordinates',latitude,longitude}`, city/stateOrRegion/zipOrPostalCode/countryCode/countryDisplay. Country display fixed US/Canada/Mexico names, fallbackcode; no clock/Intl/network. Required description fields are all nonempty. Identity `locationId` and `partyId` must be validated as UUIDs by the caller before builder invocation; description validation does not validate identity. Return only fixed keys, copy strings; preserve phone extension and numeric postal strings. Readiness means complete description, not compliance approval.

Draft: nonblank businessName; optional text null or nonblank; phone 3–40 allowed digits, whitespace, +()-.,x/ext and at least one digit; countryCode exactly2 uppercase ASCII letters (format only); coordinate plain decimal strings, no exponent, finite, <=6fractiondigits, lat[-90,90]/lon[-180,180]; street kind disallows any coordinates, coordinate kind disallows streetAddress. Null partial coordinates allowed as draft, both required export_ready. Export_ready also requires phone, city, region, postal, country and street-or-coordinate pair. Preserve supplied textual values; no silent rounding or converting ZIP/phone to numbers.

Strict Zod contracts, exported names and inferred types:

```ts
createUsPartySchema; updateUsPartySchema; usPartySchema;
createUsLocationSchema; updateUsLocationSchema; usLocationSchema;
listUsPartiesQuerySchema; listUsLocationsQuerySchema;
usPartyListSchema; usLocationListSchema;
type CreateUsParty; type UpdateUsParty; type UsParty;
type CreateUsLocation; type UpdateUsLocation; type UsLocation;
type ListUsPartiesQuery; type ListUsLocationsQuery;
```

Party create: name required trimmed1..200; legalName/contactName nullable1..200; contactPhone nullable3..40 phoneformat; contactEmail nullable email<=254; notes nullable1..2000. Optional fields omitted become null on create. No archived/IDs/timestamps in create. Patch samefields optional plus archivedboolean, at least onefield, no create defaults. Response all fields required plus UUIDid, archivedboolean and ISOdatetime createdAt/updatedAt. No tenantId/actor.

Location create: UUIDpartyId, name and businessName trimmed1..200; nullable phoneNumber/addressfields, streetAddress<=500, city/region<=200, postal<=32, country2uppercase, lat/lonstrings; addressKind defaultstreet; roles array of fixedrole enum default[], max6, duplicates rejected. Optional fields defaultnull onlyoncreate. Partial patch has same fields except partyId (immutable) optional + archivedboolean, no defaults; merged row gets domain validation in server. Response all persistent fields plus id/archived/ISOtimestamps and descriptionStatus `{exportReady:boolean,issues:LocationDescriptionIssue[]}`. Snapshot readiness uses the domain helper in API. Export domain role constant for contracts (avoid another enum copy).

List query strict, archived `'true'|'false'|'all'` defaultfalse, search trimmed<=200, limit integer1..100 default50, offset integer>=0 max100000 default0. Query numeric conversion only canonical decimal text, reject blank/fraction/exponent/arrays. Locations additionally optional UUIDpartyId and roles single string or repeated-array, closed values, AND semantics. List response `{items:UsParty[]|UsLocation[],limit:number,offset:number}` bounded; no implicit totals.

- [ ] Write focused tests first. Example valid/invalid expectations:

```ts
expect(validateLocationDescription({ ...draft, phoneNumber: null }, "draft")).toEqual([]);
expect(validateLocationDescription({ ...draft, phoneNumber: null }, "export_ready")).toContainEqual(
  { field: "phoneNumber", code: "required" },
);
expect(createUsPartySchema.safeParse({ name: "Synthetic", tenantId: "forged" }).success).toBe(
  false,
);
expect(updateUsPartySchema.parse({ archived: true })).toEqual({ archived: true });
expect(listUsPartiesQuerySchema.safeParse({ limit: "1e2" }).success).toBe(false);
```

- [ ] Run RED, implement deterministic rules/contracts, run focused/full domain and contracts tests, typecheck/lint/build. Update report with exact commands/output. No commit.

## Task 2: Additive tenant-scoped persistence

**Files:** create `packages/db/src/schema/traceability-master-data.ts`; add schema export and drizzle config source; generate next migration after0114 and metadata with repository Drizzle tool. Create focused schema/migration tests under packages/db/test. Do not edit API/contracts/domain.

**Consumes:** Task1 shapes. **Produces:** `schema.traceabilityParties`, `schema.traceabilityLocations`, `traceabilityLocationRole`, `traceabilityAddressKind`.

Tables use UUIDdefault PK, tenantIdtext FKorganization, archivedfalse, timestamptzcreatedAt/updatedAt defaultnow. Party fields exactly contractfields; location fields exactly contractfields withoutcomputedstatus; decimal coordinates numeric(9,6) exposed as strings; roleenumarraydefaultempty. No RU bridge or foreign identifier columns.

Composite UNIQUE(tenantId,id) for both and locationFK(tenantId,partyId)->party(tenantId,id). Unique active party name on tenantId+lower(name), partial archived=false. Names trim nonempty checks, businessNametrimnonempty, countryuppercase2letters, coordinatesrange, address-shape check allowing null partialdraftcoordinates but rejecting incompatiblevariant. Roles max6 and no null elements; API rejects duplicates. Index locationtenant/party, tenant/rolesGIN as supported. No deletecascade and no backfill from RU entities.

- [ ] Add failing schema assertions and disposableDB migration tests for newrelations. Generate forward migration; inspect no unrelated schema alterations. Never rewrite0113/0114. Test upgrade full existing chain, cross-tenant FK23503, active-name23505 vs archived reuse, archived restoreconflict, null drafts, invalid coordinate ranges/mixedvariant, no RU data/table changes.
- [ ] RebuildDB before consumer tests; package test/typecheck/lint/build. Use established `packages/db/test/support/us-profile-database.ts`. If its migration resolver needs latestgeneratedmigration no process-globalenvmutations. No baseDBchanges.
- [ ] Report exact red/green and generated migration path. No commit.

## Task 3: US-only transaction stores and HTTP routes

**Files:** create `apps/api/src/modules/traceability/master-data/us-master-data-store.ts` and focused helper modules only if needed (authorization, party/location) to avoid oversizedmonolith; create `apps/api/src/deployment/us-master-data.controller.ts`; connect UsRuntime/UsDevelopmentModule. Reuse/export UsSessionGuard/UsRequest as needed from current profile controller; do not changeRUmain app. New `apps/api/test/us-master-data.e2e.test.ts` (store), `us-master-data-http.e2e.test.ts` (HTTP), testhelpers undertest/support only. AddfocusedUS testfilesto check-onlyCI persistence step. No UI/Vite proxy expansion yet.

**Consumes:** task1contracts and task2schema, current `resolveUsPrincipal`, `US_CAPABILITY`/`resolveUsAccess`, serverusRequestId, runtime.databaseOperation.

**Produces:** `UsMasterDataStore(db)` methods `listParties(tenantId,actorUserId,query)`, `getParty(tenantId,actorUserId,id)`, `createParty(tenantId,actorUserId,input,requestId)`, `updateParty(tenantId,actorUserId,id,input,requestId)` and equivalentLocations. Each returns sharedcontractresponse (Dates serializedISO; descriptionStatus recomputed domainexportready). Inputsunknown strictparse, includingpath UUIDs; invalidinput400safeissues; foreign/missingentity404without existenceleak; missing/invalidUSprofile503/403safe, nonpermittedrole403.

Eachtransaction: membership FOR SHARE (freshrole), assertrequiredcapability, persistedprofile FOR SHARE (UScode baseline/currenttimezonevalid), then entity/parent locks. Writes enforce permissions before anyno-op/idempotentreturn. Updateentity FOR UPDATE, mergepatchvalidate; identicalpatchreturnsunchangedtimestamp/noaudit. Parentmustactive for locationcreate/edit/restore; locationarchive allowed underarchivedparent. Lock parent consistently beforelocation whereapplicable; partyId immutable onlocationPATCH (omitfrompatchcontract) to avoid movingidentity/history; rejectattempt400. Archivepartynevercascades. Existingarchivedlocationsnotlisteddefault butgetallowsauthorizedread.

Partyactive-nameconflict oncreate/update/restore ->409 `party_name_taken` withexact constraintcheck; sanitizeallotherunexpectedDBerrors toexistingruntime503, not400. No tenantwide seriallocking and no unboundedqueries. Search literal substring ILIKE withescaped `%`, `_`, `\\`; stable ordername,id; roles ANDcontains; archived+partyfilterscombined; boundedlimit/offset.

Auditatomic: actor/tenant/requestIDserverderived; actions `traceability.party.created|updated|archived|restored` andlocationequivalents; outcome`success`, targetType`traceability_party|traceability_location`, targetIdUUID; before/after fullsafe persistentbusinesssnapshot (no deriveddescriptionStatus, no tenant/accountsecret), nullbeforecreate. Archiveactiontakesprecedence whenarchivedchanges; no-opnoaudit. Testexactaudit androllbackonforcedauditfailure.

HTTP `/traceability/parties` and`/traceability/locations` GETlist/POSTcreate plus`/:id` GET/PATCH; noDELETE. GuardUsSessionGuard; assertguardprincipal+requestID; onlyUSmodule registers; no automaticmigrate/seed. SwaggerApiZod body/query/response reuse, currentHost/Origin/16KiB wrappers. Newdatabasepreflight optional scoped tostores, don'tmakeauthdepend onnewtableswithoutmigration; missingtablesfail503 atoperation.

- [ ] Write RED directstore tests usingdisposableDB forCRUDdraftbothprofiles, permissionsowner/admin/manager/QA vsreaders, crosstenantIDs/partylinks, archive/restoreincludingconflicts, partialmerge, role revocation, no-op, exactaudit/rollback, boundedfilter/pagination. Example:

```ts
expect(
  (
    await store.createLocation(
      tenant,
      actor,
      { partyId, name: "Dock", businessName: "Synthetic Dock" },
      request,
    )
  ).descriptionStatus.exportReady,
).toBe(false);
await expect(
  store.createParty(tenant, auditor, { name: "Blocked" }, request),
).rejects.toMatchObject({ status: 403 });
await expect(store.getParty(tenant, actor, foreignPartyId)).rejects.toMatchObject({ status: 404 });
```

- [ ] Implementstore andsharedprofile/membershiphelper, verifyfocusedtests. WriteHTTPtestsusingrealMFAfixture/ephemeralUSlistener fromexistingus-http.e2e patterns beforecontrollers. Coverbothresourcesend-to-end, freshsessioncapabilities, foreignIDs/forgedpayload, wrongOrigin, noDELETE, noRUroutes, missingprofile/schema, OpenAPIstrictcontracts. Nofakedevcredentialsinproductioncode.
- [ ] Addcontroller/runtime/module/CIwiring; fullUSsuite/APItypecheck/lint/build; outputreport. FullAPIRUenvironmentfailures recordedseparately, neverloadprimaryenv tosilence.

For no-op detection, compare valid coordinates in the database's fixed-six-decimal representation: a retry with `47.1` after storage as `47.100000` must not emit another audit. This is exact scale normalization after precision validation, not rounding or phone/postal normalization. Test a coordinate retry explicitly.

The archived-parent exception is archive-only: `{ archived: true }` may archive or retry an archive under an archived party. Combining an archive with edits to other fields still requires an active parent. Test this mixed PATCH to prevent bypassing the active-parent editing rule.

Search matches party `name` OR `legalName`, and location `name` OR `businessName`. Combine this literal substring condition with tenant, archive, parent and role filters using AND; contact/address search is outside this increment.

Missing profile on a master-data route returns `403 traceability_profile_required`, not the profile endpoint's administrator-only `traceability_profile_not_provisioned` setup signal. Test the distinction for both an owner and a non-settings US reader.

## Completion

Controller validates integrations, fullrelevantpackagegates, releaseisolation andupdateddocs. Browser UI notintroduced; no screencompletionclaim. Update US-01 status andLOC001/002/004/006 partial evidence, retainUI/CTE historicalacceptanceopen. Independent taskreviews and finalincrementreview. No push or release.
