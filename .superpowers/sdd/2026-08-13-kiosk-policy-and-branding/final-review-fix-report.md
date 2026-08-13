# Final review fix report — kiosk policy and branding

Date: 2026-08-13

Workspace: `/Users/thevladbog/PRSOME/q/.worktrees/kiosk-self-service-redesign-impl`

Branch: `codex/kiosk-self-service-redesign-impl`

Base reviewed commit: `f963d833`

## Status

All five Important final-review findings are addressed. The affected DB, API,
kiosk and admin package gates pass. The final diff contains no migration changes;
in particular, migrations 0035 and 0036 were not modified.

## Finding 1 — serialize the authoritative employee/day limit

### Behavior changed

- `POST /kiosk/orders` takes a transaction-scoped PostgreSQL advisory lock on a
  stable `tenant + employee + UTC day` key. It does not lock a whole tenant.
- After that lock, the transaction rechecks the `(tenant, kiosk, deviceSeq)`
  idempotency key, reads the live tenant and employee policy rows, counts the
  employee's accepted items for that UTC day, decides accepted/overflow items,
  inserts the order/items/rejection record, and consumes the admission.
- A conflicting open KM retry re-runs the complete live-policy/count/insert
  decision. It can therefore promote a previously overflowing item when a raced
  duplicate did not consume this employee's allowance.
- The pre-existing fast replay and rejection semantics remain: an order replay
  returns the winner with no new conflicts, while an all-conflict request creates
  no empty pending order and durably records the rejection.
- Writeoff permission is re-read inside the same serialized transaction before
  an order can be inserted; the earlier check remains only a conservative fast
  denial and cannot grant stale permission.

### TDD evidence

- RED: the new two-request regression submitted distinct `deviceSeq` values
  through two different kiosks for one employee with `dayLimit=1`; before the
  fix the accepted total was `2` instead of `1`.
- The regression holds two kiosk-specific insert barriers and waits for both API
  requests through the blocker PID's exact lock chain, so it does not depend on
  a timing sleep or unrelated test locks.
- GREEN: `apps/api/test/kiosk-orders.e2e.test.ts` — 34/34 tests passed against
  local PostgreSQL. The regression asserts both HTTP outcomes, exactly one
  `over_limit` conflict, and exactly one accepted database item.

## Finding 2 — use effective policy in the shipped kiosk flow

### Behavior changed

- Cart/session logic now resolves the complete tenant + employee policy through
  the fail-closed runtime helper rather than reading the legacy kiosk limit.
- Tenant limits off and employee `unlimited` both bypass local numeric refusal.
  A limited employee uses their own `dayLimit` together with the existing local
  plus other-kiosk day count.
- `canWriteoff=false` prevents the reducer from entering writeoff state, hides
  writeoff and its reasons in the production Cart component, reverts a stale
  writeoff selection after a refresh, blocks submission in Cart, and is checked
  again at the shell/enqueue boundary.
- An old cached snapshot with an incomplete current policy tuple falls back
  atomically to its positive legacy kiosk limit (or deny-all zero) and never
  gains writeoff permission.
- Unlimited UI copy is added in both RU and EN resources.

### TDD evidence

- RED: six production-path assertions failed before wiring: the legacy kiosk
  limit overrode the employee limit, tenant-off and employee-unlimited still
  refused scans, and writeoff remained exposed/enterable without permission.
- GREEN: focused kiosk policy/cart/API tests — 125/125 passed; the broader
  affected kiosk set — 294/294 passed; final full kiosk suite — 455/455 passed.
- Production component coverage includes employee-limit override, tenant-off,
  employee-unlimited, hidden/non-submitted writeoff, and a legacy cached
  snapshot. Reducer tests independently pin the writeoff denial.

## Finding 3 — deny raw Better Auth tenant creation in production

### Behavior changed

- `mountAuth` now returns 404 for Better Auth's raw
  `/api/auth/organization/create` route, including the trailing-slash form, when
  the explicit test bootstrap mode is disabled.
- Test mode retains the organization helper used by e2e fixtures and its
  test-only policy-row hook.
- Managed creation through `TenantProvisioningService` is unchanged. Production
  callers cannot bypass its atomic owner, subscription/entitlement and pickup
  policy provisioning.
- Inspection of the installed Better Auth 1.6.23 organization routes found no
  second organization-creation alias.

### TDD evidence

- RED: an authenticated request through a production-configured `mountAuth`
  returned 200 from the raw route.
- GREEN: the same exact and trailing-slash requests return 404; the full auth
  e2e file passed 7/7, including the retained test-mode helper flow.

## Finding 4 — preserve organization-profile drafts across card updates

### Behavior changed

- The GLN/INN/GS1 form rehydrates query data only while the form is clean.
  Logo upload/delete, policy mutation, invalidation and background refetches no
  longer erase a dirty profile draft.
- A successful profile mutation response is synchronously installed as the
  query-cache value and reset as the form's accepted baseline before the
  invalidated refetch completes.
- Once clean, a later server refetch is adopted normally and does not create a
  false dirty state.

### TDD evidence

- RED: after editing INN/prefix, uploading a logo restored the old server values;
  the save/cache-race scenario also failed before the baseline change. The clean
  refetch characterization already passed, as expected.
- GREEN: all three new cross-card cases pass: dirty draft survives logo
  upload/delete and policy refetch; clean refetch updates the form; successful
  save becomes the baseline before a logo/cache update. The complete
  `org-profile.test.tsx` file passes 15/15.

## Finding 5 — make current bootstrap contracts complete and legacy explicit

### Behavior changed

- The pairing OpenAPI schema now requires and exactly documents:
  - `branding`: `organizationName`, `logoUrl`, `logoRevision`;
  - `pickupPolicy`: `limitsEnabled`;
  - employee policy: `limitMode`, `dayLimit`, `canWriteoff`,
    `takenTodayElsewhere`.
- The kiosk's current `KioskBootstrapDto` now requires the same branding,
  tenant-policy and employee-policy fields.
- `LegacyKioskBootstrapDto` and `KioskBootstrapSnapshotDto` explicitly model
  cached pre-upgrade snapshots. The cache, credential readers, scanner settings,
  day-count helper and Cart accept the snapshot union, while network pairing and
  refresh writes remain typed as the strict current DTO.
- Privilege-bearing legacy reads still use runtime tuple guards; missing or
  malformed current fields cannot grant unlimited operation or writeoff.

### TDD evidence

- RED: the exact OpenAPI test reported missing `branding` and `pickupPolicy`;
  kiosk typecheck rejected the current branding fixture because the client DTO
  had no `branding` field.
- GREEN: exact OpenAPI contract test passed; current API-client contract and
  legacy Cart compatibility tests passed; post-union focused kiosk cache,
  credentials, scanner and policy tests passed 130/130.

## Verification

### Focused regressions

| Area | Result |
| --- | --- |
| API policy/auth/pairing/bootstrap/OpenAPI set | 6 files, 96/96 passed |
| API `kiosk-orders.e2e.test.ts` after lock-chain strengthening | 34/34 passed |
| Kiosk API/day-count/cart component set | 4 files, 125/125 passed |
| Kiosk broader affected set | 8 files, 294/294 passed |
| Kiosk snapshot/cache/credentials/scanner set after union typing | 5 files, 130/130 passed |
| Admin `org-profile.test.tsx` | 15/15 passed |

### Full package gates

| Package / gate | Result |
| --- | --- |
| `@markiro/db test` with local `DATABASE_URL` | 20 files, 109/109 passed |
| `@markiro/db typecheck`, `lint`, `build` | passed |
| `@markiro/api test` with local DB/auth env | 122 files passed, 1 file skipped; 1269 tests passed, 2 skipped |
| `@markiro/api typecheck`, `lint`, `build` | passed |
| `@markiro/kiosk test` | 20 files, 455/455 passed |
| `@markiro/kiosk typecheck`, `lint`, `build` | passed |
| `@markiro/admin test` | 51 files, 646/646 passed |
| `@markiro/admin typecheck`, `lint`, `build` | passed; lint retains 5 pre-existing hook warnings outside changed files |
| `pnpm format:check` | passed |
| `git diff --check` | passed |

The API skips are the intentionally gated `LOCAL_INFRA_SMOKE` coverage: the
local Mailpit/MinIO lifecycle suite and the real subprocess tenant-owner
provisioning smoke. No test relevant to the five findings skipped its database.

## Self-review and scope

- Reviewed the final diff for policy ordering, idempotency, all-conflict
  persistence, KM-race retries, writeoff revocation, legacy cache behavior and
  dirty-form baseline transitions.
- The advisory lock scope is one employee in one tenant on one UTC day. Other
  employees, dates and tenants do not contend.
- No migrations, schema definitions, lockfile, environment files, secrets or
  unrelated source files were changed.
- Generated `dist` output from builds is ignored and not included.

## Manual and external checks not run

- No visual browser pass was run for the admin or kiosk UI.
- No physical kiosk, scanner, tablet or offline restart acceptance was run.
- The Mailpit/MinIO lifecycle smoke was not enabled (`LOCAL_INFRA_SMOKE` was not
  set). Local PostgreSQL-backed behavior was exercised fully.

These are external acceptance limits, not failing automated gates for this fix
wave.
