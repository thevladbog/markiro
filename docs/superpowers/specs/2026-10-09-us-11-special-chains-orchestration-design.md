# US-11 special chains orchestration

Status: accepted under the user's standing implementation approval. Internal
synthetic dataset tooling only; no runtime registration or publication.

## Outcome and boundaries

Provide one bounded internal initializer/verifier for the two special units in
`us-processor-six-month-v1`. Compose existing native stores instead of inventing
new native writes, receipts, stock rules or an encompassing transaction.

Order: authorize target through the dataset journal; references; correction
Receiving and amendment; corrected Transformation; corrected Cases; corrected
Shipping; orphan Receiving and void. Verification uses only existing stores'
verify methods and never installs missing state. Initialization resumes existing
compatible stages; a later failure leaves earlier committed stage transactions
intact for retry. Each native stage remains its own atomic proof boundary.

Return an owned deeply frozen bounded summary with actual dataset ID, version,
definition digest, state `special_chains_shipping_verified`, literal
`datasetComplete: false`, and correction/orphan unit keys and canonical digests
of the verified native results. The correction summary also reports its actual
shipment count. No new journal stage or summary receipt is created. This is a
sequential verified summary, not an all-dataset transactional snapshot or a
Trace/Readiness certification. Do not infer allocation to specific SSCCs.

Errors retain original identity and cause. Preserve a native store's existing
unit/stage annotations; add the current unit/stage only when missing and safely
possible. Frozen/non-Error failures propagate without replacement.

## Evidence

Use real disposable PostgreSQL fixtures: fresh assembly, exact current corrected
60/50/10 case balance with active output, amended Receiving history, orphan
void/current-origin absence, actual journal completion, deterministic no-write
replay and verify, incomplete and pending-stage no-write verify, partial resume,
denied target/actor and content-drift rejection. Exercise actual native stores,
not mocked forwarding. Preserve all existing test bodies and fixture teardown.

Tests extend the existing corrected Cases/Shipping native suite owned by the US
development workflow. No workflow change is needed for that existing owner.

No CLI, HTTP, UI, schema, dependency, environment, shared database seed, full
260-chain population, trace_readiness, Plan/Requests/artifacts, push or deployment
is in this increment. These remain separately evidenced follow-up work.
