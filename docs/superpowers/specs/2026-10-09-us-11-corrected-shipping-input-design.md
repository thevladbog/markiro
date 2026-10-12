# US-11 corrected Shipping input foundation

## Outcome and boundary

Establish the strict internal input needed for the corrected recipe's Shipping
stage after completed special Receiving amendment, corrected Transformation and
corrected Cases. This increment does not write Shipping events or stock effects.
The unchanged recipe ships lot quantity 50 case from the 60-case output on
2026-06-12 to recipient_02, leaving a recipe forecast of 10 case. It does not
allocate quantity to 50 specific SSCC boxes.

The owner preapproved implementation and waived routine approval questions.
Keep a separate implementer, independent task review and final increment review.
Work only in the existing isolated codex/us-mvp checkout. No commit/push, release,
cleanup, install, schema, environment, runtime/CLI or shared-base population change.

## Chosen approach

Use a distinct corrected Shipping input, reusing the accepted corrected Cases
input/result validators and upstream factory. Keep the regular Shipping codec,
plan and executor unchanged. Broadening the regular index codec would mix regular
and corrected origins; copying upstream evidence validation would diverge.

Carry the validated Cases input as a nested structural field rather than copying
its amendment/origin/support fields into a second schema. A separate completed
Cases identity binds the saved journal operation/input/result digests. This is
stored-evidence coherence, not authorization or current-row ownership.

## Exact contract

New module `us-dataset-corrected-shipping-contract.ts` exports:

- `UsDatasetCorrectedShippingInput`, immutable fields exactly `codec`, `version`,
  `definitionDigest`, `casesInput`, `cases`, `chain`.
- `parseUsDatasetCorrectedShippingInput(raw: unknown)`.
- `makeUsDatasetCorrectedShippingInput(references: unknown, amendmentStage: unknown,
transformationStage: unknown, casesStage: unknown)`.
- `makeUsDatasetCorrectedShippingPlan(input: UsDatasetCorrectedShippingInput)`,
  returning an owned frozen readonly array of `UsDatasetShippingPlanRow`.

Codec is `us-dataset-corrected-shipping-input-v1`, version/digest match the existing
descriptor. `casesInput` is the unchanged corrected Cases input. `cases` is strict:
datasetId, unitKey correction_0001, stage cases, journal revision 2, canonical
lowercase UUID operationKey, lowercase SHA256 inputDigest/resultDigest. Its dataset
matches casesInput.references.datasetId; inputDigest equals the canonical digest
of casesInput. `chain` equals the entire unchanged corrected recipe exactly.
The Shipping parser does not accept a regular index/alias or legacy normalization.

Before reading caller properties, either API validates the entire bounded combined
envelope using the existing descriptor-safe corrected JSON guard (256 KiB),
including ordinary array prototypes. Reject own/inherited accessors, symbols,
cycles, exotic prototypes, nonfinite values and normalization. Return deeply frozen
owned copies; never freeze/mutate caller objects. Input errors use
us_dataset_corrected_shipping_input_invalid, fixed unit correction_0001/stage
shipping, cause retained, no raw data in diagnostic messages.

The factory validates a strict Cases stage envelope (unitKey, stage, revision,
intent, receipt). It parses the existing intent and corrected Cases input first,
reconstructs that input with the actual supplied references/amendment/Transformation
and its captured support, and compares them exactly. A valid revision-1/null-receipt
pending row yields us_dataset_corrected_shipping_prerequisite_incomplete. A
completed row must have revision 2 and a receipt; parse its existing receipt and
corrected Cases result, bind the exact input, intent operationKey/result.operationKey,
requestId `dataset-cases:<operationKey>`, canonical digest and all 121 ordered owned
record IDs. Derive the Cases identity from those validated facts. Contradictory,
malformed or forged evidence yields us_dataset_corrected_shipping_dependency_conflict;
valid pending upstream amendment/Transformation propagates the incomplete category.
Missing stages are detected by the forthcoming executor; a malformed stage envelope
is not treated as a valid pending row. Operation keys remain a separate namespace.

The plan has one row: shipmentNo 1; date 2026-06-12; quantity 50; UOM case;
shippingLocationKey processor; recipientLocationKey recipient_02; BOL then invoice
numbers from the exact recipe; output IDs from casesInput; plannedAvailableBefore
60 and plannedRemainingAfter 10. These are immutable recipe forecasts, not queried
current stock or reconstructed historical balances.

## Verification and next boundary

New pure Shipping contract tests run through the unchanged aggregate API glob.
Extend the already CI-owned corrected Cases native seed suite with one genuine
completed-journal codec witness; retain its one native gate, fixture scope, existing
assertions, timers and cleanup. It uses actual refs/amendment/Transformation/Cases,
checks exact binding, valid pending versus forged evidence, and complete unchanged
database snapshot after all factory/plan calls. This witness does not finalize
Shipping or certify current authorization through a pure factory.

Run pure regressions, the configured witness/full touched native suite, API package
and static/build/format/isolation checks, source-byte preservation and independent
reviews. Disclose inherited broad setup failures, skips, Vite warning and unresolved
regular chain-259 timing limitation; local tests are not remote CI or demo hosting.
The next increment adds guarded atomic native Shipping and current verification,
with operation/root/revision/lot ordering and actual stock checks. No full population,
browser/hardware, hosting/residency/backup, production or regulatory claim here.
