# Task 2 report — document draft model

## Changed paths

- `apps/saas-admin/src/pages/documents/types.ts`
  - Defines the shared document draft, line, activation-policy, reducer-action,
    and typed invoice/offer create-input contracts.
- `apps/saas-admin/src/pages/documents/documentDraft.ts`
  - Adds a pure reducer, deterministic catalog-line helper, bigint-cent preview
    totals, draft validation, and typed backend-boundary adapters.
- `apps/saas-admin/test/document-draft.test.ts`
  - Covers reducer, validation, exact VAT totals, and both request adapters.

## RED evidence

1. Before the module existed:

   ```text
   CI=true pnpm --filter @markiro/saas-admin exec vitest run test/document-draft.test.ts
   FAIL Failed to resolve import "../src/pages/documents/documentDraft.js"
   ```

2. Before guarding the incompatible offer policy:

   ```text
   11 tests | 1 failed
   rejects a manual policy before it can become an immediate offer policy
   AssertionError: expected [Function] to throw an error
   ```

## Automated checks

```text
CI=true pnpm --filter @markiro/saas-admin exec vitest run test/document-draft.test.ts
PASS 1 file, 11 tests

pnpm --filter @markiro/saas-admin typecheck
PASS (application and test TypeScript projects)

pnpm --filter @markiro/saas-admin lint
PASS

git diff --check
PASS
```

No browser, backend, database, or external-service checks were needed: this
task is a pure client-side model and does not change server or database
semantics.

## Self-review

- All total arithmetic is bigint cents; input money must match
  `/^\d{1,12}\.\d{2}$/`.
- The VAT formula mirrors the invoice backend: included VAT is truncated from
  gross cents, excluded VAT is truncated from net cents.
- Reducer IDs are supplied at the action boundary when available; its fallback
  is deterministic and contains no random-ID call.
- Validation enforces 1–100 lines, a tenant, positive integer quantities,
  two-decimal money, VAT-bps range, and explicit plan/add-on versus null service
  policy.
- The invoice adapter retains `immediate`; the offer adapter maps it to
  `immediately`, preserves `after_current`, and keeps service policy null.

## Commit

- `373ba9c3 feat(saas-admin): add document draft model`

## Concern for Task 3

The existing offer endpoint accepts only `immediately` and `after_current`.
The shared draft type also contains invoice-only `manual`; the offer adapter now
rejects it with `offer_manual_activation_policy_unsupported` rather than
silently changing the business meaning. The offer composer must therefore offer
only `immediate` and `after_current` for plan/add-on lines.

## Fix round 1 — offer rounding and action identities

### Root cause and RED evidence

- `calculateDocumentTotals` applied invoice truncation to every document.
  `PlatformOffersService` instead calls `calculateOfferTotals`, which rounds a
  VAT-excluded offer line as
  `floor((base * (10_000 + rate) + 5_000) / 10_000)`. Before the fix, the new
  literal offer test for `0.03 × 1` at 20% VAT excluded failed by entering the
  old function as its first argument and throwing
  `quantity_must_be_positive_integer`; the call form did not yet support an
  explicit document kind.
- `catalog.added` accepted a missing ID and recreated the fallback suffix after
  a line was removed. Before the fix, the new assertion requiring a missing
  action-boundary ID to throw failed: `expected [Function] to throw an error`.

### Fix

- `calculateDocumentTotals` now accepts an explicit `DocumentKind` either as
  `calculateDocumentTotals("offer", lines)` or as the optional second argument.
  Invoice calls retain their existing default/truncation semantics. Offer totals
  use the backend half-up line-total calculation with bigint cents; the preview
  derives the displayed VAT from that rounded offer total.
- `catalog.added.id` is required by the action type. The reducer rejects absent
  and duplicate IDs defensively, with no state-derived fallback.
- Tests add the `0.03` offer assertion and the separate-v1/v2/remove/v3 sequence
  proving both remaining IDs stay uniquely addressable.

### GREEN evidence

```text
CI=true pnpm --filter @markiro/saas-admin exec vitest run test/document-draft.test.ts
PASS 1 file, 14 tests

pnpm --filter @markiro/saas-admin typecheck
PASS

pnpm --filter @markiro/saas-admin lint
PASS

git diff --check
PASS
```

### Commit

- `444f23d1 fix(saas-admin): align document preview totals`

### Follow-up concern

Task 3 must pass `"offer"` to `calculateDocumentTotals` for an offer composer;
the array-only call remains invoice-compatible deliberately so existing invoice
consumers retain their truncation semantics.

## Fix round 2 — policy capability contract and strict adapters

### Root cause and RED evidence

- `toOfferCreateInput` preserved `after_current` for add-on lines even though
  the offers backend persists activation policy only for plans and fulfils
  add-ons immediately. It also converted any non-`after_current` non-service
  value into `immediately`, including untrusted runtime strings.
- `toInvoiceCreateInput` forwarded missing plan/add-on policies and normalized a
  non-null service policy to `null`, allowing the invoice backend to apply its
  default `manual` policy.
- `validateDocumentDraft` only recognized missing non-service policies; a
  runtime string outside the `ActivationPolicy` union was accepted.

After adding the focused tests, the prescribed command produced four expected
failures: the supported-policy helper was absent, runtime `"later"` passed
validation, the invoice adapter did not throw for a missing policy, and the
offer adapter accepted add-on `after_current`.

```text
CI=true pnpm --filter @markiro/saas-admin exec vitest run test/document-draft.test.ts
FAIL 18 tests | 4 failed
```

### Fix

- Added `getSupportedActivationPolicies(documentKind, lineKind)` for the Task 3
  composer: invoice plan/add-on allow `immediate`, `after_current`, and
  `manual`; offer plan allows `immediate` and `after_current`; offer add-on
  allows only `immediate`; services return no activation policies.
- `validateDocumentDraft` now rejects runtime policy strings outside the shared
  union.
- Both adapters now reject missing non-service policies, non-null service
  policies, and unknown strings before producing a request. The offer adapter
  rejects add-on `after_current` and maps a policy through an exhaustive switch,
  so an unknown value cannot fall through to `immediately`.

### GREEN evidence

```text
CI=true pnpm --filter @markiro/saas-admin exec vitest run test/document-draft.test.ts
PASS 1 file, 18 tests

pnpm --filter @markiro/saas-admin typecheck
PASS

pnpm --filter @markiro/saas-admin lint
PASS

git diff --check
PASS
```

### Self-review

- The capability helper returns only client draft policies; `immediate` is
  converted to backend `immediately` only after strict offer validation.
- Invoice plan/add-on support remains unchanged, including `manual`; offer
  add-on policy is constrained to the single behavior the backend fulfils.
- No server, database, or browser surface changed; these pure-model tests do
  not prove end-to-end request handling.

## Fix round 3 — offer add-on fulfilment policy

### Root cause and RED evidence

`PlatformOffersService.create` stores `activationPolicy` only when a line is a
plan. Its paid-offer fulfilment creates add-ons at `payment.paidAt`, regardless
of any add-on policy. The previous client contract was therefore too strict and
could send a meaningless add-on policy.

After updating the contract assertions, the focused suite failed in three
places: the offer adapter emitted `"immediately"` for the baseline add-on,
offer add-on exposed `"immediate"` as a selectable policy, and an
`after_current` add-on was rejected instead of being omitted from the payload.

```text
CI=true pnpm --filter @markiro/saas-admin exec vitest run test/document-draft.test.ts
FAIL 18 tests | 3 failed
```

### Fix and GREEN evidence

- Offer policy controls are now supported for plans only; offer add-ons and
  services expose no selectable policy.
- `validateDocumentDraft(draft, "offer")` accepts the fixed add-on baseline
  `immediate` and reports non-immediate add-on values as
  `offer_addon_activation_policy_must_be_immediate`.
- `toOfferCreateInput` serializes `activationPolicy: null` for every add-on and
  service. Plan policies alone remain required and map to the offer backend
  values.

```text
CI=true pnpm --filter @markiro/saas-admin exec vitest run test/document-draft.test.ts
PASS 1 file, 18 tests

pnpm --filter @markiro/saas-admin typecheck
PASS

pnpm --filter @markiro/saas-admin lint
PASS

git diff --check
PASS
```

### Commit

- `72770a85 fix(saas-admin): omit offer addon policies`
