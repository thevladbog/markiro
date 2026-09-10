# Station agent instructions

These instructions supplement the [root AGENTS.md](../../AGENTS.md) for
`apps/station`, including its Tauri shell. Read
[the Station architecture](../../docs/architecture.md) and the relevant tests
before changing a production or recovery flow.

## Pooled SQLite and durable commands

- Consecutive `SqlExecutor` calls may use different connections in
  `tauri-plugin-sql`. Do not wrap several calls in `BEGIN`/`COMMIT` and assume
  they form one transaction unless connection ownership is guaranteed.
- Reuse the established single-statement commands/triggers or a transaction on
  an explicitly held connection. Related scan, print-job, event and outbox writes
  must commit atomically where their contract requires it. Other multi-step
  operations must persist a recovery fact first and finish idempotently.
- Read `src/lib/shift-close.ts` and
  `packages/db/src/sqlite/migrations.ts` at the repository root for existing
  patterns. Keep authoritative DDL in the DB package; do not create an app-local
  alternative schema. Test interruption between steps, restart and duplicate
  invocation without losing or duplicating a production fact.

## Physical printing and saved jobs

- A transport exception or process restart does not prove that nothing printed.
  Preserve the distinction between prepared, sending, delivery unknown and
  verified. Persist the sending claim before transport; interrupted sending must
  enter recovery rather than automatically resending bytes.
- A product Data Matrix duplicate is one label for one accepted unit. It must
  contain the full code, including separators and crypto tail; it does not create
  another unit, an SSCC or aggregation.
- For product-duplicate jobs, preparation freezes fields, dates, template and
  print bytes. Explicit reprints require a reason and replay the saved bytes on
  a compatible language/DPI. Do not rebuild them from the current catalog,
  template or clock. Other box-label paths may regenerate from their model;
  inspect the actual path before claiming historical byte preservation.
- Keep logical template dimensions separate from the configured printer DPI.
  Preserve required full-code verification before accepting the next unit.
  Do not count a send or a reprint request as verified physical output.
- Retention must preserve unresolved jobs and every unacknowledged channel,
  pinned request, conflict or quarantine. Disabling new duplicate-print policy
  creation must not disable recovery/sync of existing jobs.

The implementation is under `src/lib/product-labels/`. Exercise the relevant
`test/product-labels-*.test.ts` suites; physical acceptance is described in
[the duplicate-print runbook](../../docs/acceptance/validation-dm-duplicate.md).

## Task closure, credentials and late responses

- A durable local close overrides a stale server response that still says
  `active`, including after the close outbox is acknowledged. A closing or closed
  shift must not become enterable again through refresh, polling or navigation.
- Preserve the existing credential generation, task activation and commit-lease
  checks. Work started under an old owner must not commit into a newly paired
  device or another task. Reuse the queue/drain and entry coordination rather
  than adding independent flags or uncoordinated requests.
- On close, leave, credential reset or task replacement, account for in-flight
  scans, mirror writes, printing and synchronization. Navigation or unmount is
  not proof that work has stopped or persisted.
- Test delayed responses after close/credential replacement, duplicate clicks,
  restart with pending work, and interrupted closure. Useful entry points are
  `src/lib/credential-recovery.ts`, `src/lib/shift-bundle.ts`,
  `src/lib/shift-close.ts` and `test/shift-selection-close.test.tsx`.

## Verification

Use the root Station gates and build workspace dependencies first. Include
consumer-visible field/byte assertions when changing dates or rendering, and
exercise both ZPL and TSPL plus applicable printer DPIs. A mocked transport or
DOM test does not establish Windows, scanner, printer or paper-label acceptance;
report those checks separately.
