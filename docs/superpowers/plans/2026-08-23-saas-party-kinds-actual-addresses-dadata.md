# SaaS Party Kinds, Actual Addresses, and DaData Dismissal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support every billing-party kind for seller and tenant profiles, add versioned actual
addresses, close DaData suggestions correctly, and issue commercial documents without requiring a
known buyer bank account.

**Architecture:** Extend the existing discriminated billing-profile contracts and the two versioned
profile tables rather than introducing a new party subsystem. Keep suggestion fetching unchanged,
but put visibility, dismissal, and keyboard behavior in one shared UI control. Commercial issuance
continues to freeze seller and buyer profiles; the buyer bank-account snapshot becomes nullable.

**Tech Stack:** TypeScript 6, Zod 4, Drizzle/PostgreSQL, NestJS 11, React 19, TanStack Query,
Vitest/Testing Library, Vite, pnpm 11

**Spec:**
`docs/superpowers/specs/2026-08-23-saas-party-kinds-actual-addresses-dadata-design.md`

## Global Constraints

- Use Node 24+ and the repository-pinned pnpm through Corepack.
- Preserve the append-only profile revision model; never update an old profile revision in place.
- Add migration `0065`; do not edit already-applied migrations `0060` through `0064`.
- Existing operator rows stay `legal_entity`; only new confirmed revisions may choose another kind.
- Both party scopes accept `legal_entity`, `sole_proprietor`, `self_employed`, and `individual`.
- Legal/registration address is required. Actual and postal addresses independently support
  `sameAsLegal`.
- Seller bank account remains required for publication/issuance. Buyer bank account is optional.
- Tenant authorization and audit evidence must remain exact and deny-by-default.
- DaData remains assistive: automated tests use deterministic responses and never production
  credentials.
- Build `@markiro/db` and `@markiro/platform-contracts` before API consumers to avoid stale `dist`.
- Do not commit `dist`, coverage, `.turbo`, local environment files, or Graphify output.
- Every behavior change follows RED -> GREEN -> refactor; record the expected failing assertion
  before production edits.

---

### Task 1: Broaden party contracts and add actual-address inputs

**Files:**

- Modify: `packages/platform-contracts/src/commercial.ts`
- Modify: `packages/platform-contracts/test/legal-profiles.test.ts`
- Verify exports: `packages/platform-contracts/src/index.ts`

**Interfaces:**

- Produces: `billingActualAddressInputSchema`, accepting either `{ sameAsLegal: true }` or
  `{ sameAsLegal: false, raw, normalized? }`.
- Produces: `operatorBillingProfileInputSchema` and `operatorBillingProfileSchema` with the same four
  party kinds as tenant profiles.
- Adds response fields `actualSameAsLegal: boolean`, `actualAddressRaw: string | null`, and
  `actualAddress: NormalizedBillingAddress | null`.
- Keeps exported type names `OperatorBillingProfileInput` and `OperatorBillingProfile` stable.

- [ ] **Step 1: Write failing contract tests for actual addresses and seller kinds**

Add literal fixtures to `legal-profiles.test.ts`:

```ts
const actualMatchesLegal = { sameAsLegal: true } as const;

expect(
  contracts.operatorBillingProfileInputSchema.safeParse({
    kind: "individual",
    fullName: "Иванов Иван Иванович",
    displayName: "Иванов И. И.",
    legalAddressRaw: "г Москва",
    actualAddress: actualMatchesLegal,
    postalAddress: { sameAsLegal: true },
    contact: { name: null, email: null, phone: null },
  }).success,
).toBe(true);

expect(
  contracts.billingProfileInputSchema.safeParse({
    kind: "self_employed",
    fullName: "Петров Пётр Петрович",
    displayName: "Петров П. П.",
    inn: "123456789012",
    legalAddressRaw: "г Казань",
    actualAddress: { sameAsLegal: false },
    postalAddress: { sameAsLegal: true },
    contact: { name: null, email: null, phone: null },
  }).success,
).toBe(false);
```

Update every existing valid profile input fixture in this test file to include
`actualAddress: { sameAsLegal: true }`. Extend the response fixture with the three persisted actual
address fields.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
corepack pnpm --filter @markiro/platform-contracts exec vitest run test/legal-profiles.test.ts
```

Expected: FAIL because seller input rejects `individual` and actual-address properties are not part
of the strict schemas.

- [ ] **Step 3: Implement the shared actual-address union and broaden operator schemas**

In `commercial.ts`, define the actual-address input alongside the postal union:

```ts
const actualMatchesLegalSchema = z.object({ sameAsLegal: z.literal(true) }).strict();
const separateActualAddressSchema = z
  .object({
    sameAsLegal: z.literal(false),
    raw: z.string().trim().min(1).max(1_000),
    normalized: normalizedBillingAddressSchema.nullable().optional(),
  })
  .strict();

export const billingActualAddressInputSchema = z.discriminatedUnion("sameAsLegal", [
  actualMatchesLegalSchema,
  separateActualAddressSchema,
]);
```

Add `actualAddress: billingActualAddressInputSchema` to `billingProfileInputCommonFields`. Rename the
current legal-entity input to an internal `legalEntityBillingProfileInputSchema`, build the four-kind
`billingProfileInputSchema`, and alias the operator request schema to that union:

```ts
export const billingProfileInputSchema = z.discriminatedUnion("kind", [
  individualBillingProfileInputSchema,
  selfEmployedBillingProfileInputSchema,
  soleProprietorBillingProfileInputSchema,
  legalEntityBillingProfileInputSchema,
]);
export const operatorBillingProfileInputSchema = billingProfileInputSchema;
```

Add the three actual-address response properties to `billingProfileSchema` and set
`operatorBillingProfileSchema = billingProfileSchema`. Do not loosen identifier regexes.

- [ ] **Step 4: Verify GREEN and package gates**

Run:

```bash
corepack pnpm --filter @markiro/platform-contracts test
corepack pnpm --filter @markiro/platform-contracts typecheck
corepack pnpm --filter @markiro/platform-contracts lint
corepack pnpm --filter @markiro/platform-contracts build
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit the contract slice**

```bash
git add packages/platform-contracts/src/commercial.ts \
  packages/platform-contracts/test/legal-profiles.test.ts \
  packages/platform-contracts/src/index.ts
git diff --cached --check
git commit -m "feat(billing): broaden party profile contracts"
```

---

### Task 2: Add actual-address persistence and remove the seller-kind constraint

**Files:**

- Modify: `packages/db/src/schema/billing.ts`
- Create: `packages/db/migrations/0065_saas_party_actual_addresses.sql`
- Create: `packages/db/migrations/meta/0065_snapshot.json`
- Modify: `packages/db/migrations/meta/_journal.json`
- Modify: `packages/db/test/billing-schema.test.ts`
- Modify: `packages/db/test/saas-legal-profile-migration.test.ts`

**Interfaces:**

- Produces Drizzle fields `actualSameAsLegal`, `actualAddressRaw`, and `actualAddress` on both
  profile tables.
- Removes the database check `operator_billing_profiles_legal_entity_check`.
- Produces checks `operator_billing_profiles_actual_same_check` and
  `tenant_billing_profiles_actual_same_check`.

- [ ] **Step 1: Write failing schema and migration assertions**

In `billing-schema.test.ts`, require the three columns on both profile tables and assert that the
operator-only kind check is absent:

```ts
expect(columnNames).toEqual(
  expect.arrayContaining(["actual_same_as_legal", "actual_address_raw", "actual_address"]),
);
expect(operatorCheckNames).not.toContain("operator_billing_profiles_legal_entity_check");
expect(operatorCheckNames).toContain("operator_billing_profiles_actual_same_check");
```

Extend `saas-legal-profile-migration.test.ts` so the legacy copy excludes migration `0065`, then
assert after the full migration set:

```ts
expect(operator.rows[0]).toMatchObject({
  kind: "legal_entity",
  actual_same_as_legal: true,
  actual_address_raw: null,
  actual_address: null,
});
expect(constraints.rows).toEqual([]);
```

Also attempt an insert with `actual_same_as_legal = true` plus a raw actual address and expect the
new check constraint to reject it.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
corepack pnpm --filter @markiro/db exec vitest run test/billing-schema.test.ts
```

Expected: FAIL because the columns and actual-address checks do not exist and the legal-entity
constraint is still exported by the schema.

If `DATABASE_URL` is available, also run:

```bash
corepack pnpm --filter @markiro/db exec vitest run test/saas-legal-profile-migration.test.ts
```

Expected: FAIL on the new final-state assertions. If infrastructure is absent, retain the test and
record this gate as skipped until the local Postgres step.

- [ ] **Step 3: Update the Drizzle schema**

Add to `profileColumns`:

```ts
actualSameAsLegal: boolean("actual_same_as_legal").notNull().default(true),
actualAddressRaw: text("actual_address_raw"),
actualAddress: jsonb("actual_address"),
```

Delete `operator_billing_profiles_legal_entity_check`. Add a scope-specific check to each profile
table:

```ts
check(
  "operator_billing_profiles_actual_same_check",
  sql`${table.actualSameAsLegal} = false or (${table.actualAddressRaw} is null and ${table.actualAddress} is null)`,
),
```

Use the equivalent tenant constraint name. Contract validation, not SQL, enforces non-empty raw
text when `actualSameAsLegal` is false.

- [ ] **Step 4: Generate and inspect migration 0065**

Load the existing development environment without replacing `.env`, then run:

```bash
corepack pnpm --filter @markiro/db db:generate -- --name saas_party_actual_addresses
```

Verify the generated SQL contains only:

- dropping `operator_billing_profiles_legal_entity_check`;
- the three additive columns on both profile tables;
- the two actual-address equality checks.

Do not accept unrelated schema changes. Ensure the generated filename/tag is
`0065_saas_party_actual_addresses`; rename only through the supported Drizzle generation flow, not
by hand-editing prior snapshots.

- [ ] **Step 5: Verify migration and DB package GREEN**

Run:

```bash
corepack pnpm --filter @markiro/db build
corepack pnpm --filter @markiro/db exec vitest run test/billing-schema.test.ts
corepack pnpm --filter @markiro/db exec vitest run test/saas-legal-profile-migration.test.ts
corepack pnpm --filter @markiro/db test
corepack pnpm --filter @markiro/db typecheck
corepack pnpm --filter @markiro/db lint
```

Expected: all configured tests pass; database-backed tests must report real execution rather than a
missing-`DATABASE_URL` skip before release acceptance.

- [ ] **Step 6: Commit the persistence slice**

```bash
git add packages/db/src/schema/billing.ts \
  packages/db/migrations/0065_saas_party_actual_addresses.sql \
  packages/db/migrations/meta/0065_snapshot.json \
  packages/db/migrations/meta/_journal.json \
  packages/db/test/billing-schema.test.ts \
  packages/db/test/saas-legal-profile-migration.test.ts
git diff --cached --check
git commit -m "feat(db): store billing actual addresses"
```

---

### Task 3: Persist broadened profiles and exact actual-address audit state

**Files:**

- Modify: `apps/api/src/modules/billing-profiles/billing-profiles.service.ts`
- Verify: `apps/api/src/modules/billing-profiles/dto.ts`
- Modify: `apps/api/test/billing-profiles.service.test.ts`
- Modify: `apps/api/test/platform-contract-openapi.test.ts`

**Interfaces:**

- Consumes: broadened `OperatorBillingProfileInput` and the three DB actual-address fields.
- Produces: append-only seller and tenant revisions with normalized actual-address values.
- Produces audit summaries containing `actualSameAsLegal` without raw provider payloads.

- [ ] **Step 1: Write failing service and response-boundary tests**

Add `actualAddress: { sameAsLegal: false, raw: "г Москва, ул Тверская, 2", normalized: { value:
"г Москва, ул Тверская, 2", city: "Москва" } }` to the operator input fixture. Assert inserted
values exactly contain:

```ts
actualSameAsLegal: false,
actualAddressRaw: "г Москва, ул Тверская, 2",
actualAddress: { value: "г Москва, ул Тверская, 2", city: "Москва" },
```

Replace the current test that rejects an individual seller response with one that expects the
controller to return it. Give all response fixtures the three actual-address fields. Assert audit
`before` and `after` include the boolean equality state but not raw/normalized addresses.

- [ ] **Step 2: Run the service test and verify RED**

Run:

```bash
corepack pnpm --filter @markiro/db build
corepack pnpm --filter @markiro/platform-contracts build
corepack pnpm --filter @markiro/api exec vitest run test/billing-profiles.service.test.ts
```

Expected: FAIL because `profileValues()` does not persist actual-address input and the old operator
response test still reflects the removed restriction.

- [ ] **Step 3: Map actual-address input and bounded audit metadata**

In `profileValues()` map the discriminated input exactly:

```ts
const actual = input.actualAddress;
actualSameAsLegal: actual.sameAsLegal,
actualAddressRaw: actual.sameAsLegal ? null : actual.raw,
actualAddress: actual.sameAsLegal ? null : (actual.normalized ?? null),
```

Extend `ExistingBillingProfile` and `auditProfileSummary()` with `actualSameAsLegal`. Keep
`addressRaw`/`address` mirroring the legal address for legacy compatibility. Do not copy actual
address data into legacy fields.

- [ ] **Step 4: Verify API contract and service GREEN**

Run:

```bash
corepack pnpm --filter @markiro/api exec vitest run \
  test/billing-profiles.service.test.ts \
  test/platform-contract-openapi.test.ts
corepack pnpm --filter @markiro/api typecheck
```

Expected: focused tests and typecheck pass.

- [ ] **Step 5: Commit the profile-service slice**

```bash
git add apps/api/src/modules/billing-profiles/billing-profiles.service.ts \
  apps/api/src/modules/billing-profiles/dto.ts \
  apps/api/test/billing-profiles.service.test.ts \
  apps/api/test/platform-contract-openapi.test.ts
git diff --cached --check
git commit -m "feat(api): persist every billing party kind"
```

---

### Task 4: Make buyer bank accounts optional and freeze actual addresses

**Files:**

- Modify: `apps/api/src/modules/billing/commercial-snapshots.ts`
- Modify: `apps/api/src/modules/billing/billing.service.ts`
- Modify: `apps/api/src/modules/platform-offers/platform-offers.service.ts`
- Modify: `apps/api/test/commercial-readiness.test.ts`
- Modify: `apps/api/test/document-account-snapshot.test.ts`
- Modify when fixture compilation requires it: `apps/api/test/platform-offers.service.test.ts`
- Modify when fixture compilation requires it: `apps/api/test/platform-operations.service.test.ts`

**Interfaces:**

- Changes `resolveCommercialBillingDetails()` result to
  `{ seller, buyer, sellerAccount, buyerAccount: TenantAccount | null }`.
- Extends `billingProfileSnapshot()` with `actualSameAsLegal`, `actualAddressRaw`, and
  `actualAddress`.
- Keeps `bankAccountSnapshot()` non-null and calls it conditionally for buyers.

- [ ] **Step 1: Write failing issuance/publication tests without a buyer account**

In `commercial-readiness.test.ts`, create confirmed profiles plus only a default seller account,
then assert:

```ts
const issued = await service.issue(principal, draft.id);
expect(issued.status).toBe("issued");
expect(issued.buyerBankAccountSnapshot).toBeNull();
```

In `document-account-snapshot.test.ts`, add a case that publishes an offer and issues an invoice
without inserting `tenantBankAccounts`. Assert both raw snapshots contain:

```ts
buyerBankAccountSnapshot: null,
buyerSnapshot: expect.objectContaining({
  actualSameAsLegal: false,
  actualAddressRaw: "г Казань, ул Баумана, 2",
}),
```

Assert the exact audit `after` payload has `buyerAccountId: null` and
`buyerAccountLast4: null`. Retain the existing known-account freeze test unchanged.

- [ ] **Step 2: Run focused tests and verify RED**

Run with a migrated development database:

```bash
corepack pnpm --filter @markiro/db build
corepack pnpm --filter @markiro/api exec vitest run \
  test/commercial-readiness.test.ts \
  test/document-account-snapshot.test.ts
```

Expected: FAIL with `billing_buyer_account_required`.

- [ ] **Step 3: Return a nullable buyer account from readiness resolution**

Delete the `billing_buyer_account_required` branch and return an explicit null:

```ts
return {
  seller,
  buyer,
  sellerAccount: selectedSellerAccount,
  buyerAccount: buyerAccount ?? null,
};
```

Add actual-address fields to `billingProfileSnapshot()`.

- [ ] **Step 4: Store and audit buyer account conditionally**

In invoice issue and offer publication, use:

```ts
buyerBankAccountSnapshot: buyerAccount ? bankAccountSnapshot(buyerAccount) : null,
```

and bounded audit values:

```ts
buyerAccountId: buyerAccount?.id ?? null,
buyerAccountLast4: buyerAccount ? bankAccountLast4(buyerAccount) : null,
```

Do not change seller account validation. Do not infer an account from profile JSON.

- [ ] **Step 5: Verify commercial flows GREEN**

Run:

```bash
corepack pnpm --filter @markiro/api exec vitest run \
  test/commercial-readiness.test.ts \
  test/document-account-snapshot.test.ts \
  test/platform-offers.service.test.ts \
  test/print-document-model.test.ts
corepack pnpm --filter @markiro/api typecheck
```

Expected: focused tests and typecheck pass with both null and known buyer-account cases.

- [ ] **Step 6: Commit the commercial snapshot slice**

```bash
git add apps/api/src/modules/billing/commercial-snapshots.ts \
  apps/api/src/modules/billing/billing.service.ts \
  apps/api/src/modules/platform-offers/platform-offers.service.ts \
  apps/api/test/commercial-readiness.test.ts \
  apps/api/test/document-account-snapshot.test.ts \
  apps/api/test/platform-offers.service.test.ts \
  apps/api/test/platform-operations.service.test.ts
git diff --cached --check
git commit -m "fix(billing): allow unknown buyer bank accounts"
```

---

### Task 5: Centralize suggestion dismissal and keyboard interaction

**Files:**

- Create: `apps/saas-admin/src/pages/legal/SuggestionField.tsx`
- Modify: `apps/saas-admin/src/pages/legal/SuggestionMenu.tsx`
- Modify: `apps/saas-admin/src/pages/legal/OrganizationSuggestField.tsx`
- Modify: `apps/saas-admin/src/pages/legal/AddressSuggestField.tsx`
- Modify: `apps/saas-admin/src/pages/legal/BankSuggestField.tsx`
- Modify: `apps/saas-admin/test/dadata-fields.test.tsx`

**Interfaces:**

- Produces generic `SuggestionField<T>` with controlled `value`, query result, label/key accessors,
  `onValueChange`, and `onSelect`.
- `SuggestionMenu<T>` becomes presentational and accepts `id`, `activeIndex`,
  `onActiveIndexChange`, and `onSelect`.
- Organization, address, and bank wrappers retain their public props.

- [ ] **Step 1: Write pointer-selection regression tests for organization and address fields**

Use a harness whose `onSelect` applies the selected value to state. Return a complete real contract
fixture from `fetch`, select the visible option, and assert:

```ts
expect(screen.getByLabelText("Организация или ИНН")).toHaveValue("ПАО СБЕРБАНК");
expect(screen.queryByRole("listbox")).toBeNull();
```

Repeat with `AddressSuggestField`, asserting the selected address is present and the menu is gone.
After selection, advance timers and resolve any pending request; the listbox must remain absent.
Then type one additional character and assert a new result can appear.

- [ ] **Step 2: Write keyboard and focus-dismissal tests**

For an open result list:

```ts
await user.keyboard("{ArrowDown}{Enter}");
expect(screen.queryByRole("listbox")).toBeNull();
```

Add separate assertions that `Escape` closes without selecting and that tabbing to a control outside
the suggestion wrapper closes the menu. Include `BankSuggestField` in at least one dismissal test so
all wrappers prove they use the shared behavior.

- [ ] **Step 3: Run the focused UI test and verify RED**

Run:

```bash
corepack pnpm --filter @markiro/ui build
corepack pnpm --filter @markiro/platform-contracts build
corepack pnpm --filter @markiro/saas-admin exec vitest run test/dadata-fields.test.tsx
```

Expected: FAIL because cached query results remain rendered after selection and the input does not
implement the approved keyboard dismissal contract.

- [ ] **Step 4: Implement one shared suggestion visibility state machine**

`SuggestionField<T>` owns:

```ts
const [dismissedValue, setDismissedValue] = useState<string | null>(null);
const [focused, setFocused] = useState(false);
const [activeIndex, setActiveIndex] = useState(-1);
const visible =
  focused && dismissedValue !== value && result?.status === "ready" && Boolean(result.items.length);
```

On manual input, clear `dismissedValue`, reset the active index, and call `onValueChange`. On option
selection, set suppression to the exact value the parent will apply, close first, then call the
wrapper's `onSelect`. On `Escape` or focus leaving the complete wrapper, suppress the current value.
Use `relatedTarget`/wrapper containment so moving focus into an option is not treated as an outside
blur. Prevent pointer focus ordering from unmounting an option before its click handler runs.

Expose `role="combobox"`, `aria-expanded`, `aria-controls`, and the active option relationship on the
input through supported `Input` props. Use deterministic option IDs; do not use array indexes as
React keys.

- [ ] **Step 5: Adapt the three thin wrappers**

Each wrapper continues to call `useDadataSuggestions()` and supplies the selected value explicitly:

```tsx
<SuggestionField
  label={label}
  value={value}
  result={suggestions.data}
  pending={suggestions.isFetching}
  error={suggestions.error}
  getKey={(item) => item.fiasId ?? item.value}
  getLabel={(item) => item.value}
  getSelectedValue={(item) => item.value}
  onValueChange={onValueChange}
  onSelect={onSelect}
/>
```

Retain exact-INN/BIC immediate query behavior and the current translated degraded-state messages.

- [ ] **Step 6: Verify suggestion controls GREEN**

Run:

```bash
corepack pnpm --filter @markiro/saas-admin exec vitest run test/dadata-fields.test.tsx
corepack pnpm --filter @markiro/saas-admin typecheck
corepack pnpm --filter @markiro/saas-admin lint
```

Expected: pointer, keyboard, late-response, escape, blur, debounce, and exact-INN tests pass.

- [ ] **Step 7: Commit the suggestion-control slice**

```bash
git add apps/saas-admin/src/pages/legal/SuggestionField.tsx \
  apps/saas-admin/src/pages/legal/SuggestionMenu.tsx \
  apps/saas-admin/src/pages/legal/OrganizationSuggestField.tsx \
  apps/saas-admin/src/pages/legal/AddressSuggestField.tsx \
  apps/saas-admin/src/pages/legal/BankSuggestField.tsx \
  apps/saas-admin/test/dadata-fields.test.tsx
git diff --cached --check
git commit -m "fix(saas-admin): dismiss selected dadata suggestions"
```

---

### Task 6: Add seller kind selection, actual-address form fields, and scope-aware readiness

**Files:**

- Modify: `apps/saas-admin/src/pages/legal/LegalProfileForm.tsx`
- Modify: `apps/saas-admin/src/pages/legal/BillingReadiness.tsx`
- Modify: `apps/saas-admin/src/pages/legal/LegalDataWorkspace.tsx`
- Modify: `apps/saas-admin/src/i18n/ru.json`
- Modify: `apps/saas-admin/src/i18n/en.json`
- Modify: `apps/saas-admin/test/legal-profile-form.test.tsx`
- Modify: `apps/saas-admin/test/organization-settings.test.tsx`
- Modify as needed: `apps/saas-admin/test/tenant-detail.test.tsx`

**Interfaces:**

- Extends the local `Draft` with `actualSameAsLegal`, `actualAddressRaw`, and `actualAddress`.
- `BillingReadiness` accepts `scope: "operator" | "tenant"`.
- `LegalDataWorkspace` passes its existing scope to readiness and profile form.

- [ ] **Step 1: Write failing form tests for seller kinds and dynamic labels**

Render `LegalProfileForm` with `scope="operator"`, select `individual`, and assert:

```ts
expect(screen.getByLabelText("Тип плательщика")).toHaveValue("individual");
expect(screen.getByLabelText("ФИО")).toBeDefined();
expect(screen.getByLabelText("Адрес регистрации")).toBeDefined();
expect(screen.queryByLabelText("КПП")).toBeNull();
expect(screen.queryByLabelText("ОГРН")).toBeNull();
```

Fill and confirm the form, then assert the saved operator input has `kind: "individual"` and
`actualAddress: { sameAsLegal: true }`.

- [ ] **Step 2: Write failing actual-address and readiness tests**

For a tenant form, uncheck `Фактический адрес совпадает с юридическим`, fill the visible actual
address, save, and assert:

```ts
actualAddress: {
  sameAsLegal: false,
  raw: "Москва, Тверская, 2",
  normalized: null,
},
```

Check that re-checking the equality control removes the visible field and sends
`{ sameAsLegal: true }`.

In organization settings, assert seller readiness is false without a default account. In tenant
detail, assert the same confirmed profile is ready even when its account list is empty and that the
UI labels buyer accounts as optional matching data.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
corepack pnpm --filter @markiro/saas-admin exec vitest run \
  test/legal-profile-form.test.tsx \
  test/organization-settings.test.tsx \
  test/tenant-detail.test.tsx
```

Expected: FAIL because operator kind selection is hidden, actual-address controls do not exist, and
readiness is not scope-aware.

- [ ] **Step 4: Extend the draft and request mapping**

Initialize profile drafts with:

```ts
actualSameAsLegal: profile?.actualSameAsLegal ?? true,
actualAddressRaw: profile?.actualAddressRaw ?? "",
actualAddress: profile?.actualAddress ?? null,
```

Show the kind selector for both scopes. Use kind-derived translation keys for the full-name and
legal/registration-address labels. Add the actual equality checkbox and conditional
`AddressSuggestField`. Map the draft to:

```ts
actualAddress: draft.actualSameAsLegal
  ? { sameAsLegal: true }
  : {
      sameAsLegal: false,
      raw: draft.actualAddressRaw.trim(),
      normalized: draft.actualAddress,
    },
```

Do not clear or persist the form when kind changes. Existing `toInput()` branches must continue to
omit inapplicable identifiers.

- [ ] **Step 5: Make readiness depend on scope**

Change readiness construction to use blocking and informational items:

```ts
const blockingItems = [profileItem, legalAddressItem];
if (scope === "operator") blockingItems.push(defaultAccountItem);
const ready = blockingItems.every((item) => item.ready);
```

For tenant scope, render the account item with translated optional wording and do not include it in
`ready`. Keep the note that incomplete billing data never blocks production operations.

- [ ] **Step 6: Add Russian and English copy**

Add exact keys for:

- person name (`ФИО` / `Full name`);
- registration address (`Адрес регистрации` / `Registration address`);
- actual address (`Фактический адрес` / `Actual address`);
- actual-equals-legal and actual-equals-registration variants;
- optional buyer account for payment matching.

Do not rename persisted fields or route paths.

- [ ] **Step 7: Verify UI GREEN and package gates**

Run:

```bash
corepack pnpm --filter @markiro/saas-admin exec vitest run \
  test/legal-profile-form.test.tsx \
  test/organization-settings.test.tsx \
  test/tenant-detail.test.tsx
corepack pnpm --filter @markiro/saas-admin test
corepack pnpm --filter @markiro/saas-admin typecheck
corepack pnpm --filter @markiro/saas-admin lint
corepack pnpm --filter @markiro/saas-admin build
```

Expected: all SaaS-admin tests and gates pass.

- [ ] **Step 8: Commit the legal-form slice**

```bash
git add apps/saas-admin/src/pages/legal/LegalProfileForm.tsx \
  apps/saas-admin/src/pages/legal/BillingReadiness.tsx \
  apps/saas-admin/src/pages/legal/LegalDataWorkspace.tsx \
  apps/saas-admin/src/i18n/ru.json \
  apps/saas-admin/src/i18n/en.json \
  apps/saas-admin/test/legal-profile-form.test.tsx \
  apps/saas-admin/test/organization-settings.test.tsx \
  apps/saas-admin/test/tenant-detail.test.tsx
git diff --cached --check
git commit -m "feat(saas-admin): support every billing party kind"
```

---

### Task 7: Run cross-package, migration, and browser acceptance

**Files:**

- Modify only if a real contract fixture requires it:
  `apps/api/test/platform-route-contracts.ts`
- Modify only if public architecture text is now false: `docs/architecture.md`
- No production code should be introduced solely in this task.

**Interfaces:**

- Consumes all prior tasks as one release candidate.
- Produces verification evidence and a review-ready branch; it does not deploy or mutate production
  data.

- [ ] **Step 1: Rebuild shared packages before consumers**

```bash
corepack pnpm --filter @markiro/platform-contracts build
corepack pnpm --filter @markiro/db build
corepack pnpm --filter @markiro/ui build
```

Expected: all three builds exit 0.

- [ ] **Step 2: Run complete scoped package gates**

```bash
corepack pnpm --filter @markiro/platform-contracts test
corepack pnpm --filter @markiro/platform-contracts typecheck
corepack pnpm --filter @markiro/platform-contracts lint
corepack pnpm --filter @markiro/db test
corepack pnpm --filter @markiro/db typecheck
corepack pnpm --filter @markiro/db lint
corepack pnpm --filter @markiro/api test
corepack pnpm --filter @markiro/api typecheck
corepack pnpm --filter @markiro/api lint
corepack pnpm --filter @markiro/api build
corepack pnpm --filter @markiro/saas-admin test
corepack pnpm --filter @markiro/saas-admin typecheck
corepack pnpm --filter @markiro/saas-admin lint
corepack pnpm --filter @markiro/saas-admin build
```

Run DB-backed gates with the development `DATABASE_URL`. Report any intentional skip separately;
do not call skipped database tests passing migration proof.

- [ ] **Step 3: Run repository hygiene gates**

```bash
corepack pnpm format:check
git diff --check origin/main...HEAD
git status --short
```

Expected: formatting and diff checks pass; only scoped files are tracked in the branch.

- [ ] **Step 4: Refresh the local code graph**

Because `graphify-out/graph.json` exists, run:

```bash
graphify update .
```

Verify the generated `graphify-out/` changes remain ignored and are not staged.

- [ ] **Step 5: Run local browser acceptance without saving test legal data**

Start the migrated development stack and SaaS admin. In an authenticated local session verify:

1. seller and tenant forms both expose all four kinds;
2. person kinds show `ФИО` and `Адрес регистрации`;
3. actual and postal equality controls reveal independent address fields;
4. organization, legal/registration, actual, postal, and bank menus close after pointer selection;
5. `Escape`, focus departure, arrow navigation, and `Enter` behave as specified;
6. a new manual edit reopens suggestions;
7. a draft invoice can be issued with a seller account and no buyer account;
8. no test profile or bank account is saved unless the local disposable database is used.

Capture DOM/screenshot evidence for the menu-closed state and inspect network responses for failed
contracts. Automated DOM tests are not a substitute for this browser check.

- [ ] **Step 6: Review final diff against the accepted spec**

Walk sections 4 through 12 of the spec and map every requirement to a test or browser observation.
Confirm no raw DaData response, credential, or full bank account number appears in audit assertions
or captured logs.

- [ ] **Step 7: Commit any verification-only fixture or documentation correction**

Only if Step 2 or Step 6 required a scoped fixture/doc correction:

```bash
git add apps/api/test/platform-route-contracts.ts docs/architecture.md
git diff --cached --check
git commit -m "test(saas): close party profile acceptance"
```

Otherwise leave the branch unchanged and report the existing task commits. Push, pull-request
creation, deployment, and production DaData acceptance require separate explicit authorization.
