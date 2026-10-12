# US-11 full native assembly input

Status: implementation under the owner's standing approval; separate implementer
and independent review. No publication or shared-data operations authorized.

## Outcome

Introduce the pure input boundary for a subsequent single-run native dataset
coordinator. Existing regular-range and special-chain stores remain authoritative
for persisted business proofs. This increment does not run them or claim that the
dataset is installed. The next coordinator will consume this contract after
calling both stores; trace_readiness, Plan, Requests and full-volume measurements
remain separate acceptance boundaries.

## Contract

Export `makeUsDatasetNativeAssemblyInput(regular: unknown, special: unknown)` and
`UsDatasetNativeAssemblyInput` from a new US-only demo contract module. Return an
owned recursively frozen object with `datasetId`, `version`, `definitionDigest`,
`state: native_assembly_input_validated`, `datasetComplete: false`, and the full
validated `regular` and `special` summaries using their existing exact shapes.
No totals are labelled observed persisted counts; no new journal receipt exists.

Both summaries must have the same canonical lowercase UUID dataset ID and pinned
`us-processor-six-month-v1` version and current six-month definition digest.
Regular evidence must have the exact range `{ startIndex: 0, count: 260 }`, its
existing state and false completion flag, exactly 260 ordered rows indexed0–259,
canonical chain keys and recipe-exact shipment counts (440 total). Digests are
lowercase hexadecimal SHA256 values and regular shipping digests are distinct.
Special evidence must retain its existing exact state and false completion flag,
correction_0001 and orphan_0001, all five lifecycle/stage digests and one corrected
shipment. Its shipping digest must not duplicate a regular shipping digest.
Reject unknown fields, missing/extra/reordered/duplicate chains, partial ranges,
wrong recipe identity, malformed digests, coercion and negative zero indices.

Validate the combined envelope with the existing descriptor-safe 256KiB synthetic
JSON guard before property/schema/hash traversal. Reject caller accessors, symbol
or non-enumerable evidence, cycles, sparse arrays and custom array prototypes;
never invoke caller getters or inherited array methods. Do not modify the shared
JSON guard. Validation copies do not freeze or alias caller objects. Every invalid
input produces only `us_dataset_native_assembly_input_invalid`, without payload,
provider details or claims that a valid checksum proves actual DB state.

## Alternatives and limits

A summary accepting a selected range could make an incomplete dataset appear
full; reject it. A completion flag or receipt would imply unimplemented artifact
and trace checks; retain false and no writes. Re-running business validation here
would duplicate native services; validate their summary relationships only.

No coordinator, CLI, runtime/HTTP/UI registration, native database operations,
schema/dependency/environment edits, full population, release or deployment are
part of this foundation. Test pure valid/invalid evidence and owned immutability.
Existing native stores, their shapes and all prior tests remain unchanged.
