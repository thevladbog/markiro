# US-11 Native Assembly Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax.

**Goal:** Establish the strict pure input for full native dataset coordination.

**Architecture:** Bind the existing complete regular and special summaries to one
pinned recipe identity. Validate descriptor-safe bounded evidence first and return
owned frozen data, never persisted-state or full-demo acceptance.

**Tech Stack:** Existing TypeScript, Zod and Vitest; no dependencies added.

**Spec:** `docs/superpowers/specs/2026-10-12-us-11-native-assembly-input-design.md`

## Global Constraints

- Work only `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, branch `codex/us-mvp`; every patch path absolute.
- Preserve all inherited dirty/untracked work. No stage/commit/push/PR/merge, deployment or cleanup.
- Both DATABASE_URL and US_TEST_DATABASE_URL unset in all commands; no native/DB/env/dependency changes.
- Node24/Corepack; use PATH `/opt/homebrew/opt/node@24/lib/node_modules/corepack/shims:/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/bin:/bin`.
- Only new contract/test and append-only checkpoints in docs/us/development-isolation.md and docs/us/implementation-plan.md; spec/plan controller-owned.
- Combined descriptor-safe 256KiB boundary; fixed error `us_dataset_native_assembly_input_invalid`.
- State `native_assembly_input_validated`, datasetComplete:false; no observed row counts or completion proof.
- Existing stores/recipe/codec/CI/test configuration remain unchanged. No sibling SDD artifacts may be read or modified.

## Review Focus

- Custom array prototype methods/getters must not execute; explicitly test inherited getter counters remain0.
- Matching forged recipe digests must still fail against the pinned definition.
- A partial range padded to260 rows must not pass the full-range boundary.
- Copying another chain's shipping digest must fail even with distinct indices/keys.
- A mutable caller or returned nested array must not change accepted evidence.

### Task 1: Pure full-native input codec

**Files:**

- Create: apps/api/src/modules/traceability/demo/us-dataset-native-assembly-contract.ts
- Create: apps/api/test/us-dataset-native-assembly-contract.test.ts
- Append verified results: docs/us/development-isolation.md, docs/us/implementation-plan.md

**Interfaces:** Consume existing UsDatasetRegularResult and UsDatasetSpecialChainsResult
as types, usSixMonthDefinition and makeUsSixMonthRegularChain as pinned recipe
sources, assertBoundedSyntheticJson as the combined guard. Produce:

```ts
export type UsDatasetNativeAssemblyInput = Readonly<{
  datasetId: string;
  version: "us-processor-six-month-v1";
  definitionDigest: string;
  state: "native_assembly_input_validated";
  datasetComplete: false;
  regular: UsDatasetRegularResult;
  special: UsDatasetSpecialChainsResult;
}>;
export function makeUsDatasetNativeAssemblyInput(
  regular: unknown,
  special: unknown,
): UsDatasetNativeAssemblyInput;
```

- [ ] Write behavioral tests first. Construct independently labelled structural
      synthetic summaries, not fake DB evidence. Canonical identity is
      11111111-1111-4111-8111-111111111111; pin literal chain_0000/chain_0259,
      row counts260, shipment totals440 and correction1. Use independently generated
      SHA256 test values unique by row; do not generate expected schema via the codec.

```ts
expect(input.state).toBe("native_assembly_input_validated");
expect(input.datasetComplete).toBe(false);
expect(input.regular.chains).toHaveLength(260);
expect(input.regular.chains[259]?.unitKey).toBe("chain_0259");
expect(input.regular.chains.reduce((n, row) => n + row.shipmentCount, 0)).toBe(440);
```

- [ ] Cover every rejection in the spec and five Review Focus cases with literal
      invalid error and getter counters0. Include unknown fields at every object
      level, missing/extra/reordered/duplicate rows, all identity mismatches, malformed
      digests, special stage/key/count drift, negative zero, coerced values, sparse
      arrays, accessors/symbols/non-enumerable evidence, cycles and oversized envelope.
      Check accepted output recursively frozen, distinct references, mutable inputs
      retained and later input mutations unable to change result.
- [ ] Record genuine assertion RED (minimal unimplemented interface permitted;
      missing module errors are not behavioral RED):

```sh
corepack pnpm --filter @markiro/api exec vitest run test/us-dataset-native-assembly-contract.test.ts
```

- [ ] Implement the smallest codec. Guard combined `{regular,special}` before
      caller reads; reject custom arrays using descriptors/prototype checks, then
      parse exact existing shapes with strict Zod schemas. Bind identities and pinned
      digest; validate ordered rows against recipe shipment counts, distinct digest
      ownership, special shipment1. Clone/freeze only accepted owned evidence.

```ts
try {
  assertBoundedSyntheticJson({ regular, special });
  // Descriptor/prototype validation, strict schema and recipe binding follow.
  // No DB proof or new receipt is produced.
} catch {
  throw new Error("us_dataset_native_assembly_input_invalid");
}
```

- [ ] Run GREEN and adjacent unchanged regular range/recipe/corrected contracts
      with both DB variables unset; preserve every existing assertion and timer.
- [ ] Self-review exact scope, append honest verified docs, and report commands,
      RED/GREEN output, warnings, limits and all changed paths to task report.
      No subagents and no commits; controller owns independent task/final review and
      package static/build/format/isolation gates. No full API/DB readiness claim.

## Accepted pure checkpoint — 2026-10-12

Task1 source implementation and both reviews accepted. Focused138/138 and adjacent
503passed/3existingnative-skips; controller API static/build/format/isolation51/51
passed. Full API remains failed at eight legacy environment setups:3234passed,
4650skipped. This completes the pure contract only, not its future coordinator or
installed dataset. Detailed evidence/limits are appended to the two US documents.
