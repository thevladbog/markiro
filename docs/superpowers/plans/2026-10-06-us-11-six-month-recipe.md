# US-11 Six-Month Recipe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Define and verify the complete deterministic six-month synthetic recipe before introducing a runnable business generator.

**Architecture:** Supply the accepted dataset journal with a compact, immutable, code-owned definition. Expand one bounded chain at a time into fictional references, civil dates, exact quantities and domain-valid SSCCs. Keep definition identity separate from generated runtime IDs, journal operation UUIDs, receipts and actual timestamps.

**Tech Stack:** Node 24+, repository Corepack pnpm, strict TypeScript, existing domain/contract validators, Vitest. No dependencies added.

**Spec:** `docs/superpowers/specs/2026-10-06-us-11-six-month-demo-design.md`, owner-approved 2026-10-06. This is the next independently testable recipe increment, not service orchestration, CLI or full-demo acceptance.

Status: proposed for owner review. The execution method remains a separate implementer and independent reviewer per task, followed by a whole-increment review. Do not implement before this written plan is approved.

## Global Constraints

- Work stays in `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, branch `codex/us-mvp`; preserve accepted and unrelated dirty work.
- No staging, commit, push, PR, release, deployment, shared-base database writes, dependency/environment edits or archive/design-file edits.
- Recipe identity `us-processor-six-month-v1`; pinned business period `2026-04-01` through `2026-09-30`; timezone `America/Los_Angeles`.
- 260 regular chains with monthly counts 34/38/42/46/48/52; 180 double-shipment and 80 single-shipment chains.
- Required totals: 964 event roots, 963 current finalized events, 785 lots, 15,700 distinct synthetic boxes. Revision counts are separate.
- Preserve compact Scenario A descriptor, version, digest, dates, quantities, TLCs and all 100 SSCCs. Do not edit its source or compact reference recipe.
- Retain combined definition and per-stage evidence limits of 256 KiB. Never serialize all expanded chains/documents/boxes into the manifest.
- Request limits remain 500 revisions and 16 MiB; no truncation or hidden expansion. This increment defines selection identities, not actual prepared artifacts.
- Civil business dates are not creation/audit/approval/auth/package times. No clock override, synthetic actual timestamps or request deadline renewal.
- No database writes, transaction seams, business commands, snapshots, balances, case links, approvals, request publication, CLI, transport or runtime registration in this increment.
- No real contacts, fetched documents, allocated GS1 prefix claim, physical-production claim or regulatory-approval claim.
- Record byte baselines and exact changed paths; no attribution from the historical dirty branch-wide diff. No commits or cleanup despite generic skill examples.

## Review Focus

1. Scenario A must remain byte/meaning-equivalent when embedded, rather than a visually similar regenerated chain: Task 2 exact deep-equality tests.
2. Machine timezone, daylight-saving changes or wall-clock date must not change the recipe or digest: Tasks 2/3 cross-process timezone tests.
3. SSCC allocation must cover regular and correction examples without colliding with Scenario A's reserved serials: Task 2 full-set checksum/uniqueness tests.
4. Runtime IDs, operation UUIDs, timestamps or expanded-volume evidence must not leak into definition identity: Task 3 secret/runtime-key, size and canonical-body tests.
5. Selection/catalogue/date/quantity drift can produce a consistent-looking but impossible demo: Tasks 1–3 referential closure, exact decimal and independent census tests.

## Source map and boundaries

Read root `AGENTS.md`, primary `apps/api/AGENTS.md` if absent in the worktree, the approved spec, and these current files before implementation:

- `apps/api/src/modules/traceability/demo/us-demo-definition.ts`: immutable compact Scenario A; unchanged.
- `us-demo-reference-recipe.ts`: existing DTO construction/manual synthetic review; unchanged.
- `us-dataset-contract.ts`: strict immutable definition parser and stage sequences; unchanged.
- `packages/domain/src/gs1/sscc.ts`: `buildSscc` and `isValidSscc`; unchanged.
- Existing compact definition/codec tests and `tools/us-development/check-isolation.mjs`.

New files under `apps/api/src/modules/traceability/demo/`:

| File                         | Responsibility                                                                                                               |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `us-six-month-references.ts` | Stable 23-party/location and 16-product catalogue, validated DTO inputs and synthetic review metadata                        |
| `us-six-month-chains.ts`     | One-chain expansion, weekday scheduling, exact quantities, typed fictional documents and disjoint SSCC allocation            |
| `us-six-month-definition.ts` | Compact manifest, ordered 267-unit catalogue, special examples, three request selections and final parsed immutable identity |

New tests: `apps/api/test/us-six-month-references.test.ts`, `us-six-month-chains.test.ts`, `us-six-month-definition.test.ts`; one test-only subprocess helper `apps/api/test/support/us-six-month-recipe-child.mjs` for timezone invariance. CI/docs integration belongs to Task 3. No shared package, migration or admin changes.

## Shared interfaces

Task 1 exports the following from `us-six-month-references.ts`; contract types are imported as types from `@markiro/platform-contracts`:

```ts
type UsSixMonthCatalogue = Readonly<{
  parties: readonly Readonly<{ key: string; input: CreateUsParty }>[];
  locations: readonly Readonly<{
    key: string;
    partyKey: string;
    input: Omit<CreateUsLocation, "partyId">;
  }>[];
  products: readonly Readonly<{
    key: string;
    input: CreateUsProductInput;
    profile: PutProductTraceabilityProfile;
  }>[];
}>;
function makeUsSixMonthCatalogue(): UsSixMonthCatalogue;
```

Task 2 exports the types and functions below from `us-six-month-chains.ts`. All outputs are owned recursively frozen JSON; invalid indices throw `us_six_month_chain_invalid`. Document input uses the existing `ReferenceDocumentInput` contract, not a new persistence format.

```ts
type UsSixMonthDocument = Readonly<{
  key: string;
  partyKey: string;
  input: Omit<ReferenceDocumentInput, "partyId">;
}>;
type UsSixMonthLotLine = Readonly<{
  productKey: string;
  tlc: string;
  quantity: string;
  unitOfMeasure: "lb";
}>;
type UsSixMonthShipment = Readonly<{
  eventDate: string;
  tlc: string;
  quantity: string;
  unitOfMeasure: "case";
  shippingLocationKey: string;
  recipientLocationKey: string;
  references: readonly string[];
}>;
type UsSixMonthChain = Readonly<{
  unitKey: string;
  receiving: Readonly<{
    eventDate: string;
    previousSourceLocationKey: string;
    receivingLocationKey: string;
    references: readonly string[];
    lines: readonly UsSixMonthLotLine[];
  }>;
  transformation: Readonly<{
    eventDate: string;
    locationKey: string;
    references: readonly string[];
    inputs: readonly UsSixMonthLotLine[];
    output: Readonly<{
      productKey: string;
      tlc: string;
      quantity: string;
      unitOfMeasure: "case";
      tlcSourceLocationKey: string;
    }>;
  }>;
  shipping: readonly UsSixMonthShipment[];
  cases: readonly string[];
  documents: readonly UsSixMonthDocument[];
}>;
function makeUsSixMonthRegularChain(index: number): UsSixMonthChain;
```

Task 3 exports from `us-six-month-definition.ts`:

```ts
type UsSixMonthSpecialExamples = Readonly<{
  correction: Readonly<{
    initialReceiving: UsSixMonthChain["receiving"];
    amendmentReason: string;
    correctedChain: UsSixMonthChain;
  }>;
  orphan: Readonly<{
    unitKey: "orphan_0001";
    receiving: UsSixMonthChain["receiving"];
    documents: readonly UsSixMonthDocument[];
    voidReason: string;
  }>;
}>;
type UsSixMonthRequestSelection = Readonly<{
  unitKey: "request_scenario_a" | "request_april" | "request_september";
  reference: string;
  chainKeys: readonly string[];
}>;
function makeUsSixMonthSpecialExamples(): UsSixMonthSpecialExamples;
const usSixMonthRequestSelections: readonly UsSixMonthRequestSelection[];
const usSixMonthDefinition: UsDatasetDefinition;
```

These are static recipe interfaces. They are not event command DTOs: future orchestration resolves stable keys to journal-owned UUIDs, uses current services and records actual times. Recipe keys are not operation UUIDs.

## Concrete version-1 recipe decisions

These proposed concrete values implement the approved variation requirements and are part of this plan's review, not already deployed facts.

### Catalogue

Keep compact keys `previous_source`, `processor`, `recipient`, `inbound`, `output` for its existing three parties/locations/two products, copying validated values from `makeUsDemoReferenceRecipe()`. Add suppliers `supplier_02` through `supplier_10`, recipients `recipient_02` through `recipient_12`, inbound variants `inbound_02` through `inbound_08` and output variants `output_02` through `output_08`.

Additional suppliers use names `Example Orchard Supply NN LLC`, phone `+1 509-555-01NN`, street `NN00 Example Orchard Rd`, Yakima/WA/98901. Additional recipients use `Example Market Distribution NN LLC`, phone `+1 206-555-01NN`, street `NN00 Example Harbor Ave`, Seattle/WA/98134. Contacts/email/coordinates stay null; country US; roles match the compact supplier/recipient roles. Processor is unchanged. These are explicit fictional fixtures, not named real organizations.

Inbound variety list in order: Red Delicious, Gala, Fuji, Granny Smith, Honeycrisp, Golden Delicious, Pink Lady, Braeburn. Variant NN uses `Fresh-Cut <variety> Apple Slices`; corresponding output NN uses `Fresh-Cut <variety> Apple Snack Cups`. Preserve compact names for ordinal 1. All default input quantities use lb, all outputs use case; packaging and synthetic manual-review rationale/version/source are copied from the appropriate validated compact profile with product name/variety changed. No automatic classification or operational-assessment claim.

### Regular chains

- Indices 0..259 have keys `chain_0000`..`chain_0259`. Index 259 is exact Scenario A, including its existing six document inputs, one shipping record and SSCC array. Do not regenerate it using the general algorithm.
- Month ordinal/local index derive from cumulative counts `[34,38,42,46,48,52]`, not from generated dates.
- Enumerate civil weekdays in the month with UTC calendar arithmetic; remove its last four weekdays as Receiving candidates, then remove candidate positions where `position % 5 === 2`. Expand remaining dates into slots with repeated weights `[1,3,2,1]` by candidate position. Choose slot `floor(localIndex * slots.length / monthlyCount)`. This gives ordered uneven activity, quiet weekdays and bursts without randomness. It is a weekday fixture, not a holiday-aware operational calendar.
- Transformation is the next weekday after Receiving; first Shipping the next weekday after Transformation; second Shipping, if present, the next weekday after the first. Every date remains in its assigned month. Scenario A is the explicit date exception.
- Supplier ordinal `(index % 10)+1`; first recipient ordinal `(index % 12)+1`; second recipient ordinal `((index+1) % 12)+1`. Resolve ordinal 1 to the compact key. Product ordinal `(index % 8)+1`; both Receiving lines and Transformation inputs use that inbound variant, output uses corresponding output variant. Processor key unchanged.
- Inbound quantities are exact strings: first `String(300 + 25*(index%9))` with suffix `.5` for odd indices; second `String(325 + 25*((index+3)%9))`. Transformation consumes the exact two source quantities in lb; no conversion to output cases.
- For indices 0..257, pair them: `delta=[5,10,15,20][floor(index/2)%4]`, cases `60-delta` for even indices and `60+delta` for odd. Index 258 has 60; Scenario A has 100. The 259 non-A counts sum to 15,540.
- Indices 0..179 have two shipments. Retain 10 cases when `index%3===0`, otherwise zero. First quantity `floor(caseCount*2/5)`; second `caseCount-retained-first`. Indices 180..258 have one shipment; odd indices retain `floor(caseCount/4)`, even indices ship all. Scenario A ships all 100. All shipment quantities are positive, sums never exceed output, and two shipments use distinct recipients.
- TLCs are `MUS-IN-<YYYYMMDD>-<unitKey>-A1/A2` and `MUS-OUT-<YYYYMMDD>-<unitKey>`, except unchanged Scenario A. Every lot is chain-local; sharing a supplier/product never shares a TLC.
- Non-A SSCC serial start is `101 + sum(caseCounts of earlier non-A indices)`; use `buildSscc(9,"9999999",serial)`. Reserve 1..100 for Scenario A, 101..15640 for non-A chains and 15641..15700 for correction. Explicitly label this namespace synthetic and unallocated; no change to GS1/domain validation.
- Each non-A chain has Receiving ASN/BOL, Transformation work_order/batch_log, and BOL/invoice per shipment. Keys `<unitKey>_<stage>_<kind>` with shipment ordinals, numbers `MUS-<unitKey>-<stage>-<kind>`, issuedOn equal to its event date; party keys follow previous source, processor or relevant recipient. Notes exactly `Synthetic demo metadata only; no source attachment.` No URL/attachment fetch.

### Special examples and requests

Correction key `correction_0001`: Receiving 2026-06-10, Transformation 2026-06-11, Shipping 2026-06-12. Supplier/product/recipient ordinal 2, processor unchanged. Initial Receiving quantities 250 and 400 lb; amendment changes the first to 300 lb, reason `Correct synthetic receiving quantity before downstream use.` Corrected Transformation consumes 300 and 400 lb, output 60 case, one shipment 50 case, retains 10. Use unique correction TLC/document keys and serials 15641..15700. Identity/TLC stays unchanged through the intended amendment.

Orphan key `orphan_0001`: Receiving 2026-08-10, supplier/product ordinal 3, processor unchanged, two distinct 200 lb inbound lots. Reason `Void synthetic receipt before downstream use.` Define two typed Receiving ASN/BOL documents using the same per-unit patterns and previous-source party; no Transformation/Shipping documents, output/boxes/shipment. Both special examples use the regular TLC pattern with their own unit key/date, never an existing chain TLC. Future execution must finalize then void via supported services, retain lots and reject downstream use.

Request selections are ordered immutable chain-key lists: Scenario A `[chain_0259]`, April `chain_0000`..`chain_0011`, September `chain_0208`..`chain_0219`. References `REQ-2026-APPLE-001`, `MUS-REQ-APRIL-001`, `MUS-REQ-SEPTEMBER-001`. No receivedAt/dueAt is defined here; current request rules capture them once at real execution. Selected chains are complete provenance units; future service prevalidation must still prove actual revision/byte limits before Prepare.

## Task 1: Expanded validated catalogue

**Files:** Create `us-six-month-references.ts` and `apps/api/test/us-six-month-references.test.ts`.

**Interfaces:** Consumes existing compact DTO factory and shared create/profile schemas; produces `UsSixMonthCatalogue` and `makeUsSixMonthCatalogue()` as defined above.

- [ ] **Step 1 — write failing catalogue tests.** Test exact counts/order, unique stable keys, parent/role resolution, every product profile, fictional contacts and preservation of all compact entries. Use the independent expected key lists rather than the factory's loop as the test oracle.

```ts
const catalogue = makeUsSixMonthCatalogue();
expect(catalogue.parties).toHaveLength(23);
expect(catalogue.locations).toHaveLength(23);
expect(catalogue.products).toHaveLength(16);
const compact = makeUsDemoReferenceRecipe();
for (const item of compact.products)
  expect(catalogue.products.find((candidate) => candidate.key === item.key)).toEqual(item);
for (const location of catalogue.locations) {
  expect(catalogue.parties.some((party) => party.key === location.partyKey)).toBe(true);
  expect(location.input.countryCode).toBe("US");
}
```

- [ ] **Step 2 — run RED.** `corepack pnpm --filter @markiro/api exec vitest run test/us-six-month-references.test.ts`; missing module/export must fail, not skip.
- [ ] **Step 3 — implement the concrete catalogue.** Parse all DTOs with existing schemas; use the compact placeholder-and-destructure pattern solely to validate required parent IDs, never retain that UUID in output. Return a fresh recursively frozen owned copy on each call. The following loop shape pins ordinal naming; apply the concrete names/contact/profile rules above without a second synthetic classification policy.

```ts
const addedSupplierOrdinals = Array.from({ length: 9 }, (_, index) => index + 2);
const addedRecipientOrdinals = Array.from({ length: 11 }, (_, index) => index + 2);
const ordinalText = (ordinal: number) => String(ordinal).padStart(2, "0");
// All new input fields are parsed by the same schemas used by the compact factory.
```

- [ ] **Step 4 — add ownership/security regression tests.** Check Object.isFrozen recursively, attempted mutation fails, repeated calls equal but do not alias. Validate every location/profile after supplying a test-only placeholder parent for schema parsing; output itself contains no parent UUID, email, coordinates, secret or operational approval fields.
- [ ] **Step 5 — GREEN and gate.** Run new test plus `us-demo-definition.test.ts`; API typecheck/lint. Capture exact new-file hashes for independent review. No source changes to compact factory/definition.

## Task 2: Deterministic bounded chain expansion

**Files:** Create `us-six-month-chains.ts`, `apps/api/test/us-six-month-chains.test.ts`.

**Interfaces:** Consumes Task 1 stable catalogue and existing compact definition/reference recipe; produces all Task 2 interfaces above. No imports from DB/runtime or event stores.

- [ ] **Step 1 — write failing boundary and Scenario A tests.** Include invalid -1/260/fraction/NaN/Infinity inputs. Assert index259 exact equivalence independently:

```ts
const scenario = makeUsSixMonthRegularChain(259);
expect(scenario.receiving).toEqual(usDemoDefinition.receiving);
expect(scenario.transformation).toEqual(usDemoDefinition.transformation);
expect(scenario.shipping).toEqual([usDemoDefinition.shipping]);
expect(scenario.cases).toEqual(usDemoDefinition.cases);
expect(scenario.documents).toEqual(makeUsDemoReferenceRecipe().documents);
```

- [ ] **Step 2 — run RED.** `corepack pnpm --filter @markiro/api exec vitest run test/us-six-month-chains.test.ts`; require actual missing-export/assertion failure.
- [ ] **Step 3 — implement weekday and chain algorithms.** Use UTC getters/increments on a civil-date calendar, never local getters or current time. Date scheduling uses the concrete weighted-slot algorithm; ensure optional second shipment cannot exceed the month. Resolve keys against the catalogue and fail on missing/duplicate references. Exact integer case calculations use safe integers only; inbound decimal strings are not converted through floating-point arithmetic. Core count formula:

```ts
function regularCaseCount(index: number): number {
  if (index === 259) return 100;
  if (index === 258) return 60;
  const deltas = [5, 10, 15, 20] as const;
  const delta = deltas[Math.floor(index / 2) % deltas.length];
  if (delta === undefined) throw new Error("us_six_month_chain_invalid");
  return index % 2 === 0 ? 60 - delta : 60 + delta;
}
```

- [ ] **Step 4 — implement bounded typed document and SSCC expansion.** Use the existing document schema, parent-placeholder removal and domain `buildSscc`, not bespoke checksum code. A call creates at most 100 boxes/eight documents, never the entire dataset. Freeze copied arrays and nested objects; do not expose shared mutable compact arrays.
- [ ] **Step 5 — exhaustive independent census.** Enumerate 260 outputs in tests only. Check month counts, 260R/260T/440S,780 lots,15,640 unique valid SSCCs; two-shipment count180, full/partial/split stock, distinct TLCs, every key resolves, every date is weekday and inside assigned month, strict event order. Sum quantities using integer thousandths/BigInt in the test oracle rather than Number(decimal). Check each definition-shape chain with `assertBoundedSyntheticJson`; positive shipment quantities and preserved source UOM must hold for every index.

```ts
const chains = Array.from({ length: 260 }, (_, index) => makeUsSixMonthRegularChain(index));
expect(chains.reduce((count, chain) => count + chain.shipping.length, 0)).toBe(440);
const ssccs = chains.flatMap((chain) => chain.cases);
expect(ssccs).toHaveLength(15640);
expect(new Set(ssccs).size).toBe(15640);
expect(ssccs.every(isValidSscc)).toBe(true);
```

- [ ] **Step 6 — GREEN and gate.** Run new chain/catalogue and unchanged compact definition tests; API typecheck/lint. Independent reviewer must inspect schedule boundaries, allocation math and preservation, not merely count assertions. No database acceptance implied.

## Task 3: Complete compact definition and integration gates

**Files:** Create `us-six-month-definition.ts`, `apps/api/test/us-six-month-definition.test.ts`, `apps/api/test/support/us-six-month-recipe-child.mjs`; modify `.github/workflows/us-development.yml`, `docs/us/development-isolation.md`, `docs/us/implementation-plan.md` only for precise check ownership/partial status.

**Interfaces:** Consumes Tasks1/2, `UsDatasetDefinition`/parser; produces all Task3 exports above. The child helper loads `apps/api/dist/modules/traceability/demo/us-six-month-definition.js` with `createRequire(import.meta.url)` after an explicit API build; it prints only digest/census, never environment or credentials. Native Node type-stripping does not resolve the source tree's relative `.js` imports to `.ts`, so do not use it as the subprocess loader. It is not a CLI/runtime entry.

- [ ] **Step 1 — write failing special-example/selection tests.** Assert exact initial/current correction quantities with stable identity, 60 disjoint correction SSCCs and10 remaining cases; orphan two retained-lot definitions with no downstream recipe. Resolve all three selection lists, prove April/September membership and ScenarioA exclusion from September subset. No fabricated event revision/approval/deadline timestamps.
- [ ] **Step 2 — write failing definition tests.** Require267 ordered units: references,260 regular chains,correction,orphan,plan,three requests. Map exact per-kind sequences accepted by the existing parser. Manifest includes complete compact Scenario A and catalogue plus algorithm identity/parameters, special examples and stable selection keys, but not expanded regular rows. Store the actual full algorithm parameter values above, including weekday weights, formulas' scalar constants, namespace range and document patterns; an opaque algorithm name alone is insufficient evidence.

```ts
expect(usSixMonthDefinition.units).toHaveLength(267);
expect(parseUsDatasetDefinition(usSixMonthDefinition)).toEqual(usSixMonthDefinition);
expect(usSixMonthDefinition.digest).toBe(
  canonicalExportDigest({
    version: usSixMonthDefinition.version,
    manifest: usSixMonthDefinition.manifest,
    units: usSixMonthDefinition.units,
  }),
);
expect(usSixMonthDefinition.manifest["expectedTotals"]).toEqual({
  eventRoots: 964,
  currentFinalizedEvents: 963,
  lots: 785,
  boxes: 15700,
});
```

- [ ] **Step 3 — run RED.** `corepack pnpm --filter @markiro/api exec vitest run test/us-six-month-definition.test.ts`; missing definition must fail.
- [ ] **Step 4 — implement definition assembly and special recipes.** Explicitly assemble the267 units from stable keys; use the existing parser to clone/freeze the final definition. The manifest uses `algorithmVersion: "markiro-us-six-month-expansion-v1"`, `synthetic: true`, period/timezone/expectedTotals, complete catalogue, compact descriptor/digest, exact expansion parameters and special/selection definitions. Do not include package receivedAt/dueAt or operationUUIDs. Census regular960 plus corrected3 plus orphan1 roots=964; current excludes only orphan=963;780+3+2 lots=785;15640+60 boxes=15700. Revision counts are deliberately not declared as event-root counts.

```ts
const body = {
  version: "us-processor-six-month-v1" as const,
  manifest,
  units,
};
export const usSixMonthDefinition = parseUsDatasetDefinition({
  ...body,
  digest: canonicalExportDigest(body),
});
```

- [ ] **Step 5 — prove bounds, identity and timezone independence.** Test canonical combined body <=256KiB through actual existing parser, all bounded chain/special inputs, owned freeze/mutation resistance and absence of runtime/secret keys. Pin a reviewed golden digest after the complete recipe first passes, then assert it on fresh module import. Run `corepack pnpm --filter @markiro/api build` with no active fixtures before the subprocess tests. Use `execFile` with process.execPath and the test-only helper under TZ=UTC/America/Los_Angeles/Asia/Tokyo and fake Date.now in a pure test; compiled-child digest/census must match the current source imported by Vitest, rejecting stale build output. Keep child environment identical except TZ; never print it. Actual request500/16MiB freeze gate stays a future service-level obligation, not a guessed estimate here.
- [ ] **Step 6 — CI/docs ownership.** Add exact three new pure files to the existing serial check-only workflow after shared and API builds, without a new operational job/token/environment. The definition timezone suite must run after its compiled module exists. Docs must say recipe verified, business generation not implemented and viewer/deployment not accepted; preserve previous partial-foundation history.
- [ ] **Step 7 — final gates and review.** Run all three new files plus the eight accepted compact/dataset regression files; configured DB regression uses helper-owned disposable US children, ambient DATABASE_URL unset, no shared-base writes. Run API package tests/typecheck/lint/build, root format and `git diff --check`, checker and52-test isolation suite. No builds during live fixtures. Save machine-readable results and failures/skips separately; the existing full API eight setup failures cannot be called green or presumed harmless. Independent final review uses byte range for this increment only. No stage/commit/push/cleanup.

## Self-review coverage and handoff

Spec sections2/3: catalogue, date/quantity variations, special-recipe definitions and unique TLC/SSCC census are covered by Tasks1/2/3. Section4's immutable complete definition and bounded per-unit expansion are Task3; the accepted durable journal stays unchanged. Section5's stable three selections and honest absence of runtime clocks are Task3. Section6's recipe-level tests and independent review apply here.

Separate approved execution increments still own reference persistence and native atomic dataset-stage seams; Receiving/Transformation/Cases/Shipping service orchestration; special actions/current-state replay verification; Plan/Request artifacts and actual bounds; explicit CLI/viewer; measured full generation/browser/hosting gates. This plan does not manufacture evidence for them. In particular, recipe presence is not permission to initialize a target or write business data.

No placeholders, broadened evidence limits, changed compact contract or newly public command path are part of this plan. Execution starts only after owner review of this written plan, with the preserved separate-implementer/reviewer method.
