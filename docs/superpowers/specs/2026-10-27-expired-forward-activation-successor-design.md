# Successor after an expired forward activation before API replacement

Approved by the owner on 2026-10-27 from the independently reviewed private design
`expired-before-api-replacement-successor-design.md`. The detailed host observation
stays in the private release preparation package.

## Goal and exact boundary

Continue the existing release after activation run40452889331 refused its expired
admission. Its canonical journal is sequence10/api-started/recovery-required; the
before-activation journal remains sequence6/backup-verified/completed. Actual API
and edge IDs, images and stopped timestamps predate the failed run. PostgreSQL,
schema and all202 migration ledger entries remain unchanged. A known owned probe
exited0, all worker processes ceased, and the original lock remains preserved.
These facts must be measured again; this document grants no execution authority.

Keep the existing sequence2 pre-backup successor unchanged. Introduce the separate
admission kind `platform-forward-activation-successor`, admitting only the measured
expired-before-API-replacement class. The two preceding forward operations are the
failed activation and its pre-backup predecessor; the new successor is the third.
Reject additional or unrecognized generations. Do not generalize to running,
replaced or unhealthy application containers, other failure phases or causes.

## Exact history and authority

Bind the failed current state and unchanged before-activation bytes, both phase
consumptions, independently approved dispatches, immutable envelopes, delivery,
execution and command receipts, structured failure, installed executor and full
historical source closures. Bind retained runtime, backup runtime, current index,
predecessor index and durable handoff receipts and metadata. Validate the exact
older forward predecessor and original upgrade/recovery chain with genuine
product migration proofs and historical clocks. Preserve the recorded
`terminationConfirmed=false`; later process absence is a separate measured fact.

The new admission binds durable lock-preservation and exact-probe-cleanup receipts
including original metadata and a fresh no-surviving-worker observation. Its
prepare dispatch, executor CI, product artifact, plan and source closure are fresh
and independent. The failed activation's approval or consumed preparation never
serves as new execution authority.

## Reconciliation and physical guard

Prepare separately reviewed one-shot operator code and a new waiting protected
prepare run. Before each mutation verify exact source/history/receipt bytes and
physical identities, no surviving worker, no other active production operation,
and the fresh waiting run's exact provenance. Preserve the private regular lock
by exclusive same-filesystem rename with durable intent/success, retaining
bytes/dev/inode/uid/gid/mode/size/mtime and recording resulting ctime. Never unlink
an unknown lock or bypass ordinary lock acquisition in application code.

Preserve private inspection evidence for the exact exited probe. Cleanup may
remove only its exact ID after image/labels/mounts/command/state/timestamps checks,
without force or volume removal. Preserve its image and original app containers.
An ambiguous answer stops; inspect evidence instead of repeating removal by name.

Protected prepare acquires the normal lock and durably hands off only the current
index into the successor's predecessor-index. Never restore an older index,
rewrite/move a failed journal, change old expiry, or relabel historical executors.
A partial preservation/handoff stops with all evidence retained.

## Backup, activation and release acceptance

Require a new actual source backup, isolated restore and cleanup, canonical
independent readback, new unique encrypted Mac/Timeweb copies and fresh key,
roles/TLS/target/source-hold proofs. Preserve all previous copies and keys. Never
upload the recovery key. Use a separate protected activation with immutable input;
request second-account approval only after loader and independent readback READY.
Do not run migrations, return an old version, replay a consumed operation, extend
an expired input, or weaken a check.

Before production activation, measure the genuine native202-migration chain and
both successful and controlled-failure outcomes with cleanup. Measure the entire
interval from proof creation through provisioning, approval/queue and activation
completion, leaving an explicit margin before unchanged expiry limits. Optimize
only deterministic computation/allocation while retaining fresh physical reads,
assertions, diagnostics and call ordering. The reproduced private-buffer retention
bug is a valid narrow fix; it alone does not prove the cause of the40-minute delay.

After exact-main CI, artifact/source verification and protected execution, require
independent actual healthy journal/containers/schema and strict external
TLS/admin/API/landing checks. Release DNS/catalog acceptance and the previously
authorized Yandex retirement remain later gates. CI is not production acceptance.
