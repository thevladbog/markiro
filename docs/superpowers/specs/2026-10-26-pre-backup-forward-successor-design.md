# Canonical successor for the exact pre-backup forward-admission failure

Status: owner-approved for implementation on2026-10-26; no production approval. This is the smallest extension needed to continue the release from terminal forward243; it is not a general retry/resume facility.

## Goal and current limit

Publish the accepted Autonom1.1.0/new landing product by restoring the platform without rerunning migrations, losing the already migrated database, rewriting history or lowering a check. The Autonom signed installer is already public; the landing/platform/cloud channel remain incomplete.

Exact main edd24d389f0986ff3da8d400c46b61abaeb60426 and CI40322234751 attempt1 passed all required checks and both real isolated recovery outcomes. Actual prepare40357752954 attempt1 nevertheless failed at admitted/verifyAdmission. Its terminal state is seq2/recovery-required/migrationEntered=true, SHA2c6bb13846b912f618e97448257805176747eef1347042a63bb595edfa553e6d. Its global forward index SHA is dc4bb20c4dc052aeabadfd45deee063679525f5f80220fe0076a52486d52c50a. Source-runtime, backup and preparation must be confirmed null by canonical validation before this design applies. No retained-runtime file exists, no application started and no backup adapter was reached. PostgreSQL/system/schema/full202ledger and the stopped API/edge identities remain unchanged.

The failure diagnostic lacks the original request stage. Its exact historical cause remains UNKNOWN. About33s elapsed between ownership handoff and failure; a timeout is possible but unproven. Current public GitHub metadata requests succeed. Neither observation is a root-cause fix or authorization to retry.

The existing loader accepts a failed upgrade predecessor, not a failed forward predecessor. Restoring the older upgrade index as current is rejected: it bypasses the chain even if its bytes are preserved. This design keeps terminal243 as the immediate authoritative predecessor.

## Narrow accepted predecessor

Only this shape may produce a successor: canonical forward prepare failure at seq2/admitted/recovery-required, migration latch true, sourceRuntime/backup/preparation null, no retained file, no activation phase/consumption, no backup invocation, no unconfirmed child/producer and no remaining shared lock. Exact terminal state/index, original admission/dispatch/input, consumption, handoff intent/success, archived prior index, installation receipt and runtime descriptor must match independently observed hashes and metadata.

The entire earlier chain remains required: original recovered authorities, failed upgrade b793db93-0e6b-4b1c-bb5e-5afc3a16230a seq14, and the old upgrade index preserved inside243/predecessor-index.json. Their original paths and bytes remain in place. Current physical PG/system/schema/full ordered migration ledger, exact stopped API/edge/images/configuration/mounts, roles/TLS and absence of producers must match. Any other phase, backup/source progress, uncertainty or mismatch is refused. No recursive arbitrary-depth successor path is added.

## Explicit admission and durable ownership

Add a separately discriminated strict successor admission/operation variant for this pre-backup failure; preserve the existing admission kind and its behavior. The successor records:

- a new operation UUID, new reviewed executor and its exact green main CI; the accepted product6e32/publisher40120442037/artifact12584215539 stay distinct and unchanged;
- immediate failed-forward identity and exact hashes for its terminal journal/current index/input/dispatch-consumption/handoff/archived predecessor/installation/runtime authorities;
- the complete original and failed-upgrade chain, fresh current physical baseline, fresh pinned-image migration proof and reviewed design/plan digest;
- a fresh independent protected dispatch/run attempt1 and bounded expiry.

Validation must read and validate every chain node, not merely trust an operator digest. Historical authorization is validated at its historical time without reviving it; the new authorization must be current. No optional fallback from the new variant to the old path.

Under the existing shared host lock, the successor durably archives the CURRENT243 forward index via RENAME_NOREPLACE, preserving bytes/dev/inode/uid/gid/mode/size/mtime and recording changed ctime. Fsync both parents, bind a create-only handoff intent/success receipt, and create the successor's own typed state/index. Never republish the older upgrade index, rename old journal trees, remove markers or patch prior bytes. The successor must explicitly validate243's archived index as its immediate predecessor and243's archived upgrade index as a distinct older chain node. Any uncertainty retains the lock.

Use the existing protected workflow/concurrency and separate prepare/activate approvals. No ad hoc application commands. Preparation creates a NEW actual dump/isolated full restore/ten checks/cleanup, then unique encrypted Mac and Timeweb copies with full verification. Activation uses fresh key/source/role/TLS/projection checks and immutable inputs; it never invokes a migrator or starts the old version. Exact same physical PG must remain. Only after external TLS/landing/API acceptance may release DNS/channel work continue.

## Bounded diagnostics without acceptance changes

Preserve the first failure with trusted finite read-stage metadata for GitHub publisher/artifact/product-CI/executor-CI/recheck, HTTP status where present, response-size limit, redirect-count and timeout category. Never retain request URL/query, Authorization, token, response body, argv, raw stack or private child output. Propagate only constructor-owned metadata through wrappers; caller-supplied properties are ignored. Existing timeouts, byte limits, redirect policy, required proofs and fail-closed behavior remain unchanged. Diagnostics do not claim to repair the historical cause or turn a failed read into success. No automatic network, workflow or operation retry is introduced.

## Verification and operational sequence

1. Focused RED denial tests for the exact successor chain and diagnostic provenance; implement only the strict variant and bounded diagnostics. Refuse any other phase, non-null backup/source/preparation, existing retained runtime, wrong index/chain/config/schema/product/dispatch, stale authorization, malformed/extra fields, rerun/self approval and replayed consumption.
2. Durability/failure-injection tests at each intent/rename/fsync/publication boundary; verify uncertainty retains the lock and all historical bytes remain unchanged. Test old paths are unaffected.
3. Reuse the two existing mandatory isolated Linux/Docker namespaces serially. In each, create the failed upgrade, then a failed forward admission at the exact pre-backup boundary, and execute the NEW canonical successor: one reaches healthy; one proves owned replacement-failure cleanup. Verify real backup/restore/ledger, direct ownership chain and no second migrator/old starts. Do not waive or replace either existing outcome. Keep cleanup and all per-process/expiry/freshness bounds.
4. Full scoped checks, independent whole-diff/security review, one scoped PR, exact-head CI/CodeQL, authorized merge and exact new main CI with both complete outcomes. No production source patching or execution before these gates.
5. Fresh read-only observation of243 and the complete chain. Independently reviewed/hash-bound create-only operational package. Reuse already verified immutable product/worker dependencies only where exact new executor provenance permits; do not relabel old source or worker proofs. New executor source closure/worker must have its own verified provenance.
6. One fresh protected successor prepare, immediate URL with approval withheld, immutable input/loader/readback first, then distinct second-account approval. New backup/restore/copies, then separately protected activate and external acceptance. Never rerun40356248549 or40357752954, reuse old inputs, overwrite copies or upload a recovery key.

## Scope and owner decision

This extends the previously approved predecessor shape. The owner explicitly approved this concrete design and sequential implementation on2026-10-26. It adds no future product features, generic recovery engine, ordinary deployment bypass, mutable release publication or relaxed security gate. It requires code review and real CI; no short completion time is promised. The rejected compensating-index protocol remains unimplemented. All current data and failed evidence are preserved while awaiting this decision.
