# Task 12 — Billing notifications and tenant attention badge

## Result

Tenant billing now emits one durable `tenant-billing-notification` delivery per normalized current
owner/admin email for user-actionable billing events: clarification required, a current offer
published or revised for decision, a due-soon invoice, and an issued act document. The strict mail
payload contains only locale, recipient and organization display names, event kind, bounded subject
name, and one cabinet action URL. RU and EN renderers escape user text and render exactly one link;
bank references, import payloads, comments, attachments, object keys, and storage data never enter
the template.

Recipient selection reloads current tenant membership in the authoritative write transaction and
uses the established structured role resolver. Owner/admin roles are exact; manager/member,
removed rows, invalid addresses, duplicate users, and case-equivalent duplicate addresses are
excluded deterministically. The source identity is
`billing:{eventKind}:{entityId}:{revision}`. Migration 0073 adds a partial unique index over the
persisted tenant, kind, source, and normalized recipient only for this mail kind. Concurrent exact
replays map only that index conflict to success, and the delivery plus outbox row are inserted in
the caller's transaction. A rollback therefore leaves neither delivery nor outbox work.

`GET /billing/attention` is a small `BILLING_READ` projection returning `{ count }`. With the
server's Moscow business date and `BILLING_DUE_SOON_DAYS = 7`, it counts clarification-required
requests, only the latest published undecided/unexpired offer in each family, and issued or
partially-paid invoices due today through day +7 inclusive. Past, day +8, paid/cancelled,
superseded/expired/decided, historical, and foreign-tenant rows are excluded in one bounded SQL
projection.

The tenant shell loads that narrow query only when the billing capability exists. A positive count
uses the existing compact sidebar badge and RU/EN accessible link name. Loading, zero, and failed
queries show no count and do not break navigation. The query key remains inside the
`tenant-billing` family.

## RED / GREEN

- **RED:** email render coverage failed 6/6 before the typed template branch existed.
- **GREEN:** complete email suite passes 3 files / 21 tests.
- **RED:** the isolated notification API suite initially had no notification service; the first
  unique-insert attempt also proved PostgreSQL would reject an unmatched conflict target.
- **GREEN:** isolated Postgres notification coverage passes 1 file / 3 tests. It applies every
  migration to a UUID-named scratch database and proves role filtering/deduplication, encrypted
  real delivery/outbox rows, exact replay, four concurrent insertions, rollback, fixed-clock
  today/+7/+8/past/paid/partial boundaries, offer currentness, and cross-tenant isolation.
- **GREEN:** the four authoritative billing workflow suites pass 4 files / 113 tests against their
  isolated scratch databases after notification transaction wiring.
- **GREEN:** focused schema/migration coverage passes 7 files / 23 tests, including the 0072 → 0073
  snapshot chain and the narrow partial unique index.
- **RED:** the new shell badge test could not find its accessible positive-count link before the
  query and badge implementation.
- **GREEN:** complete billing routing passes 1 file / 15 tests; i18n lockstep passes 1 file / 4
  tests. The routing fixture was brought to the current invoice DTO and current visible labels.

### Review fix round 1

- **RED:** a newer draft revision incorrectly hid the still-actionable published offer; the fixed
  clock scratch assertion returned 3 instead of 4. **GREEN:** published filtering now happens
  inside the per-family CTE while later terminal revisions still exclude history.
- **RED:** upstream organization, profile-name, and act-number lengths produced a permanent
  `RENDER` delivery. **GREEN:** one exported strict payload schema now normalizes accepted display
  strings before encryption and parses the same shape in the worker. The real test decrypts,
  parses, and renders 200/300/200-code-point maxima without replacement characters. Action URLs
  remain strict and are rejected, never truncated, before a durable row exists.
- **RED:** a queued clarification delivery still sent after the tenant replied. **GREEN:** the mail
  worker now tenant-scopes and validates the exact event/entity/revision against authoritative
  current state immediately before send. Replied, cancelled, decided, superseded, paid, day +8,
  and invalid act-document cases cancel; a live event sends.
- All four authoritative services now require `TenantBillingNotificationsService`; no optional
  injection or optional call remains. Request, offer, invoice, and act scratch suites prove the
  authoritative state/history and delivery/outbox share the transaction, while forced notifier
  failure rolls database state/history back. The dedicated invoice suite additionally proves a
  concurrent issue produces one committed issue and exactly one recipient delivery/outbox.

## Changed areas

- `packages/email` — strict typed RU/EN billing notification renderer and escaping/bounds tests.
- `packages/db` — forward-only 0073 migration, snapshot/journal, partial delivery uniqueness index,
  and migration/schema coverage.
- `apps/api/src/modules/mail` — strict job schema and transaction-aware unique delivery/outbox
  insertion.
- billing request, offer, invoice, and act services — actionable notification insertion inside
  their existing authoritative transactions.
- tenant billing API — recipient service, fixed-clock attention projection, DTO, guarded route,
  and application wiring.
- `apps/admin` — narrow attention query, capability-safe compact badge, RU/EN accessibility copy,
  and routing/i18n coverage.

## Verification

- PASS — email Vitest 21/21, source/test TypeScript, ESLint, and build.
- PASS — DB focused billing schema/migrations 23/23, source/test TypeScript, ESLint, and build.
- PASS — API notification + OpenAPI + route inventory 12/12; authoritative workflow regression
  113/113. All database suites used disposable UUID-named scratch databases and dropped them.
- PASS — review-fix combined API notification/mail/workflow run: 6 files / 138 tests. Dedicated
  authoritative invoice notification coverage: 2/2. OpenAPI: 13/13; route inventory: 4/4.
- PASS — review-fix API TypeScript no-emit, ESLint, Nest TypeScript build, and `git diff --check`.
- PASS — API TypeScript no-emit, ESLint, and Nest build.
- PASS — admin billing routing 15/15, i18n 4/4, TypeScript, ESLint, and production Vite build. ESLint
  retains five inherited hook warnings outside the changed billing files; the build retains the
  inherited large-chunk advisory.
- PASS — scoped Prettier, `git diff --check`, and staged-diff review.

The package manager bootstrap could not reach the configured private registry, so verification used
the already-installed package binaries with temporary current-worktree workspace aliases. Those
aliases and temporary test-config allowances were removed before commit; no manifest, registry
configuration, or lockfile changed.

After restoring the original shared dependency links, a diagnostic admin ESLint retry was not
accepted as a product gate: stale shared `@markiro/domain` output produced nine unsafe-type errors
in existing capability consumers. The current-worktree alias run immediately before restoration
passed with only the five inherited hook warnings above. Likewise, the restored Vitest path cannot
read font assets outside the worktree allowlist; the valid 15/15 routing run used the temporary
current-worktree-only allowance and it was removed afterward.

A full DB package attempt was not accepted as a green gate: 28 files / 135 tests passed while 16
files / 22 tests failed and 46 skipped. Failures came from the inherited shared development schema
drift (`products.print_name`, `tenant_billing_profiles.full_name`, and missing later billing
relations) plus older migration fixtures already stopping before Tasks 3–6. The Task 12 migration,
schema, concurrency, and rollback paths instead passed on clean disposable databases. The shared
database was not migrated, dropped, or repaired.

A final read-only `pg_database` query returned no Task 12 scratch database names.

## Limits

No external SMTP/Mailpit delivery inspection, live browser visual pass, responsive screenshot, or
deployment was run. These remain Task 13/external gates; DOM, render, database, type, lint, and build
evidence does not claim live mail-client or browser confirmation.

## Commit

The scoped commit SHA is reported in the handoff because a commit cannot contain its own SHA.
