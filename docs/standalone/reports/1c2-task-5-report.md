# Task 5 report — webview bindings: `device.ts`, `connection.ts`, `local/executor.ts`

Plan: 1c2 ("Markiro Автоном" — host connection, local database, IPC bindings). Task 5 of 5 (last task).
Commit: `6065521bedd418d5d8c9c4608e3350646d37ecd9` (branch `claude/autonomous-desktop-station-9e6f13`).

## What was implemented

1. **`src/host/device.ts`** — `DEVICE_ERROR_CODES` extended with `pairing_code_invalid`,
   `pairing_code_expired`, `rate_limited`, `line_rejected`, `key_rejected`, `request_failed`
   (mirroring `DeviceError::code()` in `src-tauri/src/device.rs`). New `ClaimInput` interface
   (`address`, `fingerprint`, `code`, `name`). `DeviceApi` gained `claim(input): Promise<DeviceStatus>`
   (→ `host_claim`) and `selectLine(lineId): Promise<DeviceStatus>` (→ `device_select_line`),
   implemented in `createTauriDeviceApi` the same way as the existing `pairLocally`/`forget`
   methods (shell call wrapped in `run`, response validated through `parseStatus`).

2. **`src/i18n/ru.json`** — added `errors.device.{pairing_code_invalid,pairing_code_expired,
rate_limited,line_rejected,key_rejected,request_failed}` texts, required by
   `test/errors.test.ts`'s "have a text for every code" assertion.

3. **`src/host/protocol.ts`** — added `hostStatusSchema` (strict; `state` enum
   `online|connecting|offline`, `lastContactAt` nullable non-negative int, `lastError` nullable
   enum of the five link-error codes, `seq` non-negative int) with exported `HostStatus` type, and
   `hostRevisionSchema` (strict; `{ rev: non-negative int }`). Placed right after
   `hostResponseSchema`, in the "Rust shell's own payloads (strict)" section, as the brief specified.

4. **`src/host/connection.ts`** (new) — `HOST_STATUS_EVENT` / `HOST_REVISION_EVENT` constants;
   `ConnectionHandlers` (function-typed properties `onStatus`/`onRevision`, not methods — see
   Deviations/notes) and `ConnectionApi` (`watch` as a function-typed property returning
   `Promise<() => void>`); `createTauriConnectionApi(call = invoke, subscribe = (event, handler) =>
listen(event, handler))`. `watch` subscribes to both events first, then calls
   `connection_status`, folding the snapshot through the same `seq`-gated `accept` used for live
   events so nothing already-seen is replayed and nothing racing ahead is dropped. A snapshot that
   fails `hostStatusSchema.parse` unsubscribes both listeners before rethrowing.

5. **`src/local/executor.ts`** (new) — `LocalStatement` (`sql`, optional `values`, optional
   `expectedChanges`); `LOCAL_DB_ERROR_CODES` (mirroring `LocalDbError::code()` in
   `src-tauri/src/local_db.rs`) plus the client-side `invalid_response`; `LocalDbError`;
   `LocalExecutor` interface (`query<T>(sql, params, row: ZodType<T>)`, `transaction(statements)`);
   `createTauriLocalExecutor(call = invoke)` calling `local_query` / `local_transaction`,
   validating rows/changes with Zod and mapping an unrecognized rejection to `statement_failed`.

6. **`test/support/local-db.ts`** (new) — `openLocalDb()` opens a `node:sqlite` `DatabaseSync`
   in memory, applies every `.sql` file under `src-tauri/migrations/` in filename order, and wraps
   it in a `LocalExecutor` implementation (`nodeExecutor`) with the same statement/transaction/
   rollback semantics the Rust shell has, including a `toSqlValue` guard that accepts only
   `null | string | number | boolean` (booleans become 0/1) and throws `unsupported_value`
   otherwise — this is what plan 1c3's reference-sync tests will run their SQL against.

7. **Tests** — `test/device.test.ts` (2 new cases: `claim`, `selectLine`), `test/app.test.tsx`
   (`claim`/`selectLine` stubs added to `fakeDevice()`), `test/connection.test.ts` (new, 5 cases),
   `test/local-executor.test.ts` (new, 10 cases including 3 against real `node:sqlite`).

8. **`apps/standalone/AGENTS.md`** — "Network and TLS" now lists `connection.ts` and
   `src/local/executor.ts` alongside `client.ts`/`device.ts`/`probe.ts` as files that change
   together with the IPC contract; "Local database" gained a closing paragraph naming
   `LocalExecutor` and `test/support/local-db.ts` as the only webview entry point and its test
   parity mechanism.

9. **`src-tauri/tests/ipc.rs`** — module doc comment now names `src/host/connection.ts` and
   `src/local/executor.ts` alongside the three files it already listed as exercising this IPC
   contract (comment-only change, folded in from the Task 4 review).

## TDD evidence

### RED

Command:

```
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/device.test.ts test/connection.test.ts test/local-executor.test.ts
```

Output (abridged):

```
 ❯ test/local-executor.test.ts (0 test)
 ❯ test/connection.test.ts (0 test)
 ❯ test/device.test.ts (21 tests | 2 failed) 7ms
     × pairs by code with the host's address, the confirmed fingerprint and a name
     × selects the station's line

 FAIL  test/connection.test.ts [ test/connection.test.ts ]
Error: Failed to resolve import "../src/host/connection.js" from "test/connection.test.ts". Does the file exist?

 FAIL  test/local-executor.test.ts [ test/local-executor.test.ts ]
Error: Failed to resolve import "../src/local/executor.js" from "test/local-executor.test.ts". Does the file exist?

 FAIL  test/device.test.ts > Tauri device API > pairs by code with the host's address, the confirmed fingerprint and a name
TypeError: createTauriDeviceApi(...).claim is not a function

 FAIL  test/device.test.ts > Tauri device API > selects the station's line
TypeError: createTauriDeviceApi(...).selectLine is not a function

 Test Files  3 failed (3)
      Tests  2 failed | 19 passed (21)
EXIT_CODE=1
```

This confirms the tests actually exercise the not-yet-written code (missing modules, missing
`DeviceApi` methods), not a typo.

### GREEN

After implementing `device.ts`, `ru.json`, `protocol.ts`, `connection.ts`, `local/executor.ts`,
`test/support/local-db.ts`:

Command:

```
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/device.test.ts test/connection.test.ts test/local-executor.test.ts test/errors.test.ts test/app.test.tsx
```

Output:

```
 Test Files  5 passed (5)
      Tests  72 passed (72)
EXIT_CODE=0
```

All 5 targeted files pass, including `test/errors.test.ts` (proves every new `DEVICE_ERROR_CODES`
entry has an `errors.device.<code>` text) and `test/app.test.tsx` (proves the `fakeDevice()` stub
additions don't break the existing App suite).

Notably, `test/local-executor.test.ts`'s "upserts a whole page through json_each as the shell
does" test passed with the exact values the brief and the Rust side both assert
(`[1000]` on first insert of 1000 rows, `[0]` on a no-op re-upsert), so the
NEEDS_CONTEXT contingency in the brief did not trigger.

## Full verification commands and results

| Command                                                                                                            | Result                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`                                        | PASS — 21 files, 268 tests                                                                                   |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck` (`tsc -p tsconfig.json --noEmit`) | PASS — no output                                                                                             |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint` (`eslint .`)                           | PASS — no output, no warnings                                                                                |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build` (`vite build`)                        | PASS — `dist/` produced; pre-existing chunk-size advisory note only (unrelated to this change, not an error) |
| `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`                                            | PASS — no output, exit 0                                                                                     |
| `node_modules/.bin/prettier --write <12 changed files>`                                                            | all reported "(unchanged)"                                                                                   |
| `node_modules/.bin/prettier --check <12 changed files>`                                                            | PASS — "All matched files use Prettier code style!"                                                          |
| `git diff --check`                                                                                                 | PASS — no output                                                                                             |
| `git status --short` (pre-commit)                                                                                  | exactly the 12 intended files (7 modified, 5 new); nothing under `apps/station`, no `Cargo.lock` change      |
| `git status --short` (post-commit)                                                                                 | clean                                                                                                        |

Cargo tests were intentionally not run for this task: the only Rust change is the `ipc.rs` module
doc comment, which the task brief says needs only `cargo fmt --check`.

## Files changed

Modified:

- `apps/standalone/AGENTS.md`
- `apps/standalone/src-tauri/tests/ipc.rs` (comment-only)
- `apps/standalone/src/host/device.ts`
- `apps/standalone/src/host/protocol.ts`
- `apps/standalone/src/i18n/ru.json`
- `apps/standalone/test/app.test.tsx`
- `apps/standalone/test/device.test.ts`

Created:

- `apps/standalone/src/host/connection.ts`
- `apps/standalone/src/local/executor.ts`
- `apps/standalone/test/connection.test.ts`
- `apps/standalone/test/local-executor.test.ts`
- `apps/standalone/test/support/local-db.ts`

`apps/standalone/Cargo.lock` was not touched. No file under `apps/station` was touched.

## Deviations

None from the brief's specified code. All files were written verbatim (or, for `device.ts`/
`protocol.ts`/`ru.json`/`AGENTS.md`/`ipc.rs`, edited exactly as instructed) from
`.superpowers/sdd/1c2-task-5-brief.md`, and everything typechecked, linted and passed prettier on
the first attempt — no `tsc`/ESLint failure required a smallest-fix deviation.

One resolved ambiguity, not a deviation: for `createTauriConnectionApi`'s `subscribe` default, I
used the wrapped form `(event, handler) => listen(event, handler)` directly rather than first
trying the bare `subscribe: Listen = listen` and falling back only on a typecheck failure. The
brief pre-authorized this exact wrapper for the case where the real `listen`'s generic
`EventCallback<T>` handler is not assignable to the brief's non-generic `Listen` handler type. Both
forms are behaviorally identical and neither uses a cast; I applied the sanctioned form up front to
avoid a redundant compile-fail-then-fix cycle. I did not separately verify whether the bare
reference would have failed on its own.

## Self-review

- Verified the TypeScript bindings against the actual Rust source rather than trusting the brief
  blind: `src-tauri/src/lib.rs` (`host_claim`, `device_select_line`, `local_query`,
  `local_transaction`, `connection_status` command names and their `tauri::generate_handler!`
  registration), `src-tauri/src/device.rs` (`DeviceError::code()` producing exactly
  `pairing_code_invalid`, `pairing_code_expired`, `rate_limited`, `line_rejected`, `key_rejected`,
  `request_failed`), `src-tauri/src/connection.rs` (`STATUS_EVENT`/`REVISION_EVENT` constants equal
  to `standalone://host-status`/`standalone://host-revision`, the `ConnectionStatus` field names
  `last_contact_at`/`last_error`/`seq` and its own serialization test asserting the exact JSON
  shape `{ state, lastContactAt, lastError, seq }`), and `src-tauri/src/local_db.rs`
  (`LocalDbError::code()` producing `local_db_unavailable`, `invalid_statement`,
  `unsupported_value`, `statement_failed`, `changes_mismatch`, and `expected_changes` semantics).
  Everything the brief specified matched the shipped Rust exactly.
- Verified `src-tauri/migrations/0001_reference_data.sql` defines exactly `ref_org`, `ref_site`,
  `ref_lines`, `sync_state` — matching the "has exactly the shell's reference tables" test and the
  column names/types the executor tests bind against (`archived` as `INTEGER CHECK (archived IN
(0,1))`, hence the boolean→0/1 coercion in `toSqlValue`).
- Confirmed `apps/standalone` has only `ru.json` (no `en.json`), so no second locale file needed
  updating; `test/errors.test.ts` covers this via `i18n.exists(key)` against the loaded instance.
- Confirmed the `ConnectionHandlers`/`ConnectionApi.watch` function-typed-property pattern (not
  methods) both compiles under the repo's strict `tsconfig.base.json`
  (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) and satisfies
  `@typescript-eslint/unbound-method` under `recommendedTypeChecked`, since `src/host/connection.ts`
  is not covered by the root ESLint config's `disableTypeChecked` override for `**/test/**` — the
  lint run's clean exit confirms this rather than assuming it.
  `test/support/local-db.ts` does fall under `**/test/**` (type-checked rules disabled there), which
  is why its more liberal `node:sqlite` typing works without extra guards.
  `apps/standalone/dist` already existed from the shared worktree, so `vite build` did not need a
  prior `turbo` bootstrap for this task; `pnpm --filter @markiro/standalone build` ran clean.
- Confirmed no unrelated files were staged: `git status --short` before commit listed exactly the
  12 files in the plan's file table for Task 5, and `apps/standalone/Cargo.lock`/`apps/station/**`
  are untouched.
- Commit message and trailer verified verbatim with `git log -1 --format=%B`, matching the brief's
  subject and the exact required `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` trailer
  (consistent with the four prior commits on this branch for the same plan).

## Not verified (out of this task's automated scope)

Per the plan's own "Итоговая проверка плана" checklist, the following remain unverified after this
task and need the plan's later manual/CI steps, not because this task's gates skipped them:

- A real `tauri dev` window: Tauri events reaching a real webview, and the local database actually
  opening at app startup. Automated coverage here is limited to the mock-runtime IPC contract
  (`src-tauri/tests/ipc.rs`, unchanged by this task except its doc comment) and this task's direct
  module tests (`connection.test.ts`, `local-executor.test.ts` against `node:sqlite`).
- The `standalone-windows-build` CI job (the shell compiled with `sqlx` for Windows, DPAPI tests) —
  needs a push to run.
- A second PC on the LAN: pairing by code and the change-stream connection over a real network —
  deferred to after plan 1c3 ships screens that call `claim`/`watch`.

## Commit

```
6065521be feat(standalone): привязки вебвью к подключению по коду, линии, связи и локальной базе

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```
