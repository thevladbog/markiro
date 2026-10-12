# US-11 corrected Transformation input foundation

Status: approved for implementation under the owner's standing implementation authorization. Development-only.

## Goal and scope

Establish the bounded input contract needed to execute the existing corrected special chain after its completed Receiving amendment. This increment does not execute Transformation, Cases or Shipping. The recipe, public services, regular-chain codecs and release lock remain unchanged.

The immutable `us-processor-six-month-v1` correction consumes 300/400 lb from the retained Receiving lots, produces 60 case on 2026-06-11, and later ships 50 case. The original Receiving's 250/400 lb acknowledgement is historical evidence, not the downstream prerequisite.

## Approaches

1. A dedicated corrected-chain input codec bound to the completed amendment: recommended. It keeps regular receipt semantics strict and avoids duplicating native business/result verification.
2. Broaden the regular Transformation codec: rejected because it would conflate original and amended origins and affect accepted regular consumers.
3. Invoke public services without a journal-owned transaction: rejected because business writes and dataset receipt publication would not be atomic.

Separate this input foundation from the forthcoming native executor/result verifier. The latter requires root/revision-before-lot locks across original and amended Receiving plus Transformation; this pure contract does not claim to establish that protocol.

## Contract

Add `us-dataset-corrected-transformation-contract.ts` with an exported immutable input type, parser and factory. Its codec is `us-dataset-corrected-transformation-input-v1`; version and definition digest match the existing descriptor. Its exact fields are `codec`, `version`, `definitionDigest`, `references`, `amendment`, `receivingOrigin` and `chain`: the exact shared reference identity, completed amendment identity, current Receiving origin and unchanged `makeUsSixMonthSpecialExamples().correction.correctedChain`.

The amendment identity contains datasetId, unitKey `correction_0001`, stage `amend_receiving`, journal revision 2, operationKey, inputDigest and resultDigest. Journal revision is not event revision. `receivingOrigin` contains `rootId`, `eventId`, `revision: 2`, `lifecycleVersion: 4` and `inputLots`, two ordered `{ lineNo, lotId }` mappings. Root and event differ; both lots and both event identities are distinct canonical lowercase UUIDs. Reference and amendment operation keys differ. Dataset identities agree.

`makeUsDatasetCorrectedTransformationInput(references, amendmentStage)` accepts only a structurally safe completed correction amendment row. It validates the existing intent/receipt/result codecs, matching input, digest, operation key and exact canonical record IDs; the result's shared-reference identity must match the supplied one. It derives the current origin from the finalized amendment record and retained lot IDs, not from the original result. Valid pending amendment evidence yields `us_dataset_corrected_transformation_prerequisite_incomplete`; incompatible/forged evidence yields `us_dataset_corrected_transformation_dependency_conflict`.

`parseUsDatasetCorrectedTransformationInput(raw)` rejects unknown fields, altered recipe/date/quantity/UOM, unsupported units/stages/versions, malformed UUIDs/digests, duplicate origin IDs, incomplete mappings and contradictory dataset identities. It uses `us_dataset_corrected_transformation_input_invalid`. Unsafe accessors, cycles, symbols, exotic prototypes, nonfinite values and combined evidence over 256 KiB fail before getters execute. Both APIs return deeply frozen owned copies and never freeze or mutate caller objects. Error context is fixed unit `correction_0001` and stage `transformation`, with the original cause retained and no raw input in the message.

These contracts establish internal evidence consistency, not current database ownership, authorization or immutable origin acceptance. The future executor must independently lock and verify actual current rows before business writes and receipt publication.

The inherited bounded walker does not reject exotic array prototypes. This module therefore adds a local descriptor-only array-prototype check after bounded traversal and before Zod, nested codecs or canonical digests. Only ordinary `Array.prototype` arrays pass; inherited iterator getters are never invoked. Shared helpers and accepted older consumers are unchanged and are not certified by this local repair.

## Verification and boundaries

Extend the existing CI-owned `us-dataset-special-contract.test.ts`; preserve its original assertions and disposable fixture lifecycle. Pure behavioral tests cover the parser and rejection paths. Its existing owned PostgreSQL witness additionally builds a completed-row envelope from genuine native amendment results and checks exact derived current identity, digests, retained lots and rejection of forged envelopes. That envelope is a codec witness, not a claim that the amendment journal stage was persisted by this test.

No new workflow owner is necessary: the existing special three-suite step already selects this exact test file after builds with the explicit US fixture URL and one worker. Verify current ownership and unchanged workflow bytes locally. Run focused old/new contracts, the configured native witness, API static/build gates and the ordinary API test command; report any broad failures/skips rather than declaring an unverified green package. No dependency, migration, HTTP/UI, initializer, shared-base population, Git publication, hosted resource or deployment change is authorized.
