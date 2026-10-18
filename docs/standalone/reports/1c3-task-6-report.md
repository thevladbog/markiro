# Task 6 report — Офисная страница «Устройства» и диалог кода подключения

## Summary

Implemented exactly as specified in `1c3-task-6-brief.md`: the office
«Устройства» page (device list, line names from local copies), the
pairing-code dialog (DataMatrix, code, fingerprint, host addresses,
countdown, poll-and-close-on-join behavior), the lazily-loaded
`PairingDataMatrix` component, the `office-local.tsx` context for the
local executor, the two new `HostApi` methods, the `useOfficeQuery`
`refetchInterval` option, the new `officeKeys` entries, the nav entry and
route, i18n strings, and the two documentation updates.

## What was implemented

**New files**

- `apps/standalone/src/office/devices/DevicesPage.tsx` — the device list
  (name, kind, line, paired-at, last-seen, status), the «Подключить
  устройство» action, the join notice, and wiring to `PairingCodeDialog`.
  Line names come from a local `useQuery` (`officeKeys.lineNames`) against
  `ref_lines` through `useOfficeLocal()`, never from the host.
- `apps/standalone/src/office/devices/PairingCodeDialog.tsx` — the
  pairing-code dialog: DataMatrix (via lazy `PairingDataMatrix`), the code
  in 5+5 groups, the fingerprint and host addresses (`DefinitionGrid`), the
  countdown, the «Новый код» button (always present), and the "no address"
  warning. Polls `officeKeys.devices` every `DEVICE_POLL_MS` (3000 ms)
  while open, since a claim raises no host revision.
- `apps/standalone/src/office/devices/PairingDataMatrix.tsx` — the default
  export used by `React.lazy`; renders `renderLiteralDataMatrixSvg`'s SVG
  or nothing on failure (the typed code and fingerprint remain the
  fallback path), after `apps/admin/src/pages/devices/PairingBarcode.tsx`.
- `apps/standalone/src/office/office-local.tsx` — `OfficeLocalProvider` /
  `useOfficeLocal()`, a `LocalExecutor | null` context, `null` by default
  (matches office tests that don't pass one).
- `apps/standalone/test/devices-page.test.tsx` — 8 tests (see below).

**Modified files**

- `apps/standalone/src/host/api.ts` — added `listDevices` and
  `createPairingCode` to `HostApi` and `createHostApi`.
- `apps/standalone/src/office/office-query.ts` — added `officeKeys.devices`
  and `officeKeys.lineNames`; added `OfficeQueryOptions.refetchInterval`
  to `useOfficeQuery` (defaults to `false`, i.e. no polling).
- `apps/standalone/src/office/Office.tsx` — added the `local` prop and
  wrapped the router in `OfficeLocalProvider`.
- `apps/standalone/src/app/App.tsx` — passes `local={localDb}` to `Office`.
- `apps/standalone/src/office/nav.ts` — new `/devices` entry, section
  «Производство», `roles: ["admin"]`, placed before `/users`.
- `apps/standalone/src/office/routes.tsx` — new `/devices` route wrapped
  in `RequireRole roles={["admin"]}`.
- `apps/standalone/src/app/shell.css` — `.pairing-code`,
  `.pairing-code__matrix` (+ its `svg` child), `.pairing-code__digits`.
- `apps/standalone/src/i18n/ru.json` — `office.nav.sections.production`,
  `office.nav.devices`, and the full `office.devices.*` tree (table
  headers, kinds, status, and the `pairing.*` dialog strings).
- `apps/standalone/test/support/office.tsx` — added `listDevices` and
  `createPairingCode` mocks to `fakeHostApi`.
- `apps/standalone/test/api.test.ts` — added `listDevices` and
  `createPairingCode` cases to `CASES`.
- `apps/standalone/test/office-query.test.tsx` — added the
  "reads again at the interval it is given, and never without one" test.
- `apps/standalone/AGENTS.md` — new bullet at the end of "Office pages"
  documenting the devices page, local line names, `lastSeenAt` semantics,
  the 3 s poll, and the lazy DataMatrix encoder.
- `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`
  (§5.5) — expanded the devices bullet: fingerprint/addresses in the
  dialog, the 3 s poll and self-close behavior, `lastSeenAt` semantics,
  and the plan-1c/1d split (list+dialog now; rename/line/revoke later).

## Fragment verification

Every fragment quoted in the brief for existing files (`api.ts`,
`Office.tsx`, `office-query.ts`, `nav.ts`, `routes.tsx`, `App.tsx`,
`shell.css`, `ru.json`, `office.tsx`, `api.test.ts`,
`office-query.test.tsx`, `AGENTS.md`, the spec) was read from the current
file and matched byte for byte before editing. No fragment mismatches.
The two proto fixtures the brief's `api.test.ts` fragment references
(`device-record.json`, `pairing-code.json`) already existed in
`proto/fixtures/` (created by earlier plan work) and parse correctly
against `deviceRecordSchema` / `pairingCodeSchema`.

## TDD evidence

**RED** — `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/devices-page.test.tsx test/api.test.ts test/office-query.test.tsx`

```
FAIL  test/api.test.ts > ... > listDevices sends the office token to the right route
TypeError: api.listDevices is not a function
FAIL  test/api.test.ts > ... > createPairingCode sends the office token to the right route
TypeError: api.createPairingCode is not a function
FAIL  test/devices-page.test.tsx > office devices > lists the devices, naming lines from the local copies
TypeError: Cannot read properties of undefined (reading 'mockResolvedValue')
... (5 more devices-page.test.tsx failures, same cause)
FAIL  test/office-query.test.tsx > useOfficeQuery > reads again at the interval it is given, and never without one
AssertionError: expected 1 to be greater than 2

 Test Files  3 failed (3)
      Tests  10 failed | 18 passed (28)
```

10 failed / 18 passed — matches the brief's prediction exactly (7 of the 8
new `devices-page.test.tsx` tests fail; only "is in the menu for
administrators only" passes since it never touches `listDevices`).

**GREEN** — same command, after implementation:

```
 Test Files  3 passed (3)
      Tests  28 passed (28)
```

## Tests and results (actual counts)

- `test/devices-page.test.tsx`: **8 tests, 8 passed**.
- `test/api.test.ts`: **15 tests, 15 passed** (13 original + 2 new).
- `test/office-query.test.tsx`: **5 tests, 5 passed** (4 original + 1 new).
- Full `@markiro/standalone` suite: **460 tests across 28 files, all
  passed** (`pnpm --config.verifyDepsBeforeRun=false --filter
@markiro/standalone test`).

Pristine-output check (`--reporter=verbose` on the three focused files):
after a deviation described below, zero warnings/console noise. Also ran
the full 460-test suite to a log file and grepped for
`"not wrapped in act"` / `console.error` / `console.warn` / `Warning:` —
no matches; exit code 0.

## Verification commands and results

| Command                                                                                                                                                             | Result                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/devices-page.test.tsx test/api.test.ts test/office-query.test.tsx` (RED) | 10 failed, 18 passed — as predicted                                |
| Same command (GREEN, after implementation)                                                                                                                          | 28 passed                                                          |
| Same command with `--reporter=verbose`                                                                                                                              | 28 passed, **no console/act warnings** (after the deviation below) |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`                                                                                         | **460 passed (28 files)**                                          |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`                                                                                    | clean, no output                                                   |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`                                                                                         | clean, no output                                                   |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build`                                                                                        | succeeds; see chunk detail below                                   |
| `node_modules/.bin/prettier --write <18 files>` then `--check`                                                                                                      | all "unchanged"; check passes                                      |
| `git diff --check`                                                                                                                                                  | clean                                                              |
| `git log -1 --format=%B`                                                                                                                                            | exactly the required subject + trailer, no other `Co-Authored-By`  |

**Build chunk for `PairingDataMatrix`**: the build emits a separate chunk,
`dist/assets/PairingDataMatrix-Cg6Op1iX.js` — **925.90 kB** (gzip
254.08 kB), confirming the `React.lazy` split isolates the DataMatrix
encoder from the main bundle. The main bundle,
`dist/assets/index--PWPHJm_.js`, is 683.27 kB (gzip 209.29 kB). Vite's
"(!) Some chunks are larger than 500 kB after minification" warning
fires for both chunks; the main-bundle instance of this warning already
existed before this task (683 kB > 500 kB regardless of this change), so
no new regression was introduced, consistent with the brief's expectation.

## Files changed

```
 apps/standalone/AGENTS.md                                       |   9 +
 apps/standalone/src/app/App.tsx                                 |   1 +
 apps/standalone/src/app/shell.css                                |  28 +++
 apps/standalone/src/host/api.ts                                  |  16 ++
 apps/standalone/src/i18n/ru.json                                 |  44 ++++-
 apps/standalone/src/office/Office.tsx                            |  10 +-
 apps/standalone/src/office/devices/DevicesPage.tsx (new)         | 164 +++++++++
 apps/standalone/src/office/devices/PairingCodeDialog.tsx (new)   | 142 ++++++++
 apps/standalone/src/office/devices/PairingDataMatrix.tsx (new)   |  25 ++
 apps/standalone/src/office/nav.ts                                |   6 +
 apps/standalone/src/office/office-local.tsx (new)                |  21 ++
 apps/standalone/src/office/office-query.ts                       |  15 +-
 apps/standalone/src/office/routes.tsx                            |   9 +
 apps/standalone/test/api.test.ts                                 |  12 ++
 apps/standalone/test/devices-page.test.tsx (new)                 | 192 +++++++++++
 apps/standalone/test/office-query.test.tsx                       |  17 ++
 apps/standalone/test/support/office.tsx                          |   2 +
 docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md | 7 +-
 18 files changed, 715 insertions(+), 5 deletions(-)
```

`git diff --stat` against the pre-task tree touches only files listed in
the brief's "Files" section. `apps/station`, `apps/admin` and every Rust
crate are untouched.

Commit: `9e909b1d8` — "feat(standalone): офисная страница «Устройства» и
диалог кода подключения".

## Deviations

1. **Test file: added `act()` wrapping around the fake-timer advance.**
   The brief's `devices-page.test.tsx` code (the "reads the list every 3 s
   ..." test) calls `await vi.advanceTimersByTimeAsync(3000);` directly.
   Running it produced six `"An update to ... was not wrapped in act(...)"`
   warnings (from `PairingCodeDialog`'s countdown-tick state and the
   polled query's own state, both firing during the advance). The task's
   hard rule requires pristine output verified with `--reporter=verbose`,
   and the codebase's own established pattern for this exact situation
   (`apps/admin/test/kiosk-pairing.test.tsx`,
   `apps/admin/test/national-catalog-import.test.tsx`,
   `apps/kiosk/test/pairing-screen.test.tsx`, `apps/kiosk/test/app.test.tsx`,
   etc.) is `await act(async () => { await vi.advanceTimersByTimeAsync(ms); });`.
   I applied that pattern: added `act` to the `@testing-library/react`
   import and wrapped the one call. No assertion was weakened or removed;
   all 8 tests still pass with identical expectations, now with zero
   console/act noise.
2. No other deviations. Every other fragment (source and doc) matched the
   current file byte for byte and was applied verbatim from the brief.

## Self-review findings

- **Completeness**: every file in the brief's "Files" list was
  created/modified; every "Produces" interface item
  (`HostApi.listDevices`/`createPairingCode`, `officeKeys.devices`/
  `lineNames`, `OfficeQueryOptions`, `OfficeLocalProvider`/`useOfficeLocal`,
  `DevicesPage`, `PairingCodeDialogProps`/`PairingCodeDialog`,
  `DEVICE_POLL_MS`, `PairingDataMatrix` default export, the `/devices` nav
  entry) exists with the exact signature given.
- **Names**: unchanged from the brief; consistent with sibling pages
  (`OfficeUsersPage.tsx`, `SsccPage`) — same `useOfficeQuery`/
  `useOfficeMutation`/`Card`/`Table`/`PageHeader` idioms.
- **No overbuilding**: no extra abstraction was added beyond the brief;
  `DevicesPage.tsx` is the same shape and length as the brief specifies,
  matching `OfficeUsersPage.tsx`'s existing size/structure.
- **Tests verify behavior, not mocks**: `devices-page.test.tsx` renders
  the real `Office` tree and asserts on DOM text/roles (table rows,
  dialog `role="dialog"`/`role="img"`, the countdown text, the i18n
  strings), not on mock call shapes alone (the one mock-call assertion,
  `createPairingCode` called with the token, is a boundary check, not the
  test's substance).
- **Pristine output**: confirmed via `--reporter=verbose` on the three
  focused files (no warnings) and a full-suite run grepped for warning
  markers (none found), after the `act()` deviation above.
- Re-checked `noUncheckedIndexedAccess`/`exactOptionalPropertyTypes`
  concerns: `useLineNames()`'s `Map.get` returns `string | undefined`
  handled with `??`; `payload.addresses[0]`-style indexing is not used
  (only `.map`/`.length`/`.join`); `create.mutateAsync()` called with no
  argument against a `void`-typed variables mutation compiles cleanly
  (confirmed by `typecheck`, matching the existing TS behavior for
  `void`-parameter function types).

## Concerns

None. All of this task's own gates (RED, GREEN, full suite, typecheck,
lint, build, prettier, `git diff --check`, commit trailer) are green.

## Explicitly not run (out of this task's scope)

- The plan's own "Итоговая проверка плана" section (end of
  `1c3-constraints.md`) additionally lists `turbo run build
--filter='@markiro/standalone...'`, `cargo test --manifest-path
apps/standalone/Cargo.toml --workspace --offline`, and `cargo fmt
--check` outside the sandbox. This task's diff touches no Rust code
  (constraints: "Rust меняется только в задаче 2"), so these were not run;
  they verify the plan as a whole, not this task's change set.
- Manual/external checks the brief itself flags as out of scope for any
  task in this plan: pairing a second physical PC over a real LAN
  (scanning the DataMatrix off the office screen, manual entry with
  fingerprint comparison, the change stream and sync over the network);
  a real keyboard-wedge scanner under the Russian layout (with and
  without Caps Lock); `tauri dev` (real webview link events, the local
  database through shell commands, dark/light theme rendering of the new
  page and dialog); the `standalone-windows-build` CI job (needs a push);
  and how the DataMatrix reads off a physical screen to a warehouse
  scanner (module size, glare). None of these were exercised — this
  report only covers the Vitest/typecheck/lint/build gates above.

---

# Fix round 1 (on top of 9e909b1d8)

The coordinator's reviewer confirmed the Task 6 implementation matches the
brief and asked for five specific fixes, nothing else, in one new commit.

## Item 1 — the countdown used this PC's clock against the host's `expiresAt`

**Problem.** `PairingCodeDialog`'s `useRemainingMs(code.expiresAt)` computed
`expiry - Date.now()`. The office can run on a PC other than the host, and a
cloud-less LAN site does not promise the two clocks agree: a PC more than
10 minutes ahead of the host would show "Срок кода истёк" for every fresh
code; a PC hours behind would show an oversized countdown for a code the
host already expired.

**Fix.** The countdown is now anchored to when _this PC_ received the code,
never to the host's `expiresAt`:

- `DevicesPage`'s `Pairing` interface gained a `deadline: number` field.
- In `newCode()`'s `try` block, right after `await create.mutateAsync()`
  resolves (and after the staleness check — see item 2), `const receivedAt =
Date.now();` is captured and `deadline: receivedAt + CODE_LIFETIME_MS` is
  stored alongside the code.
- `issuedAt = Date.parse(code.expiresAt) - CODE_LIFETIME_MS` is untouched —
  it stays host-clock arithmetic, used only for join detection (comparing
  two host-clock values against each other, so a PC's own clock skew never
  enters that comparison).
- `PairingCodeDialogProps` gained `deadline: number`; `PairingCodeDialog`
  passes it to `useRemainingMs`, which now takes `deadline: number` directly
  (no more `useMemo(() => new Date(expiresAt).getTime(), ...)` — the value
  arrives as a number already) and returns `Math.max(0, deadline - now)`.
  `Date.now()` is still only read inside the `useEffect`/interval, never
  during render.

## Item 2 — a stale open or «Новый код» completion reopening the dialog

**Problem.** `newCode()` called `setPairing`/`setFailure` after the `await`
with no staleness guard: closing the dialog (by hand, or because a device
joined) while a request was in flight let that request's answer reopen the
dialog or show a stray failure once it resolved.

**Fix.** `DevicesPage` now keeps `const requestGeneration = useRef(0)`.
`newCode()` captures `const generation = ++requestGeneration.current;`
before awaiting the mutation, and checks `generation !== requestGeneration
.current` before acting on both the success and the failure path (returning
early, doing nothing, if the generation moved on). A single effect
invalidates any in-flight request when the dialog stops being open, for
either reason (manual close or an automatic join-close, both of which drive
`dialogOpen` to `false`):

```ts
useEffect(() => {
  if (!dialogOpen) requestGeneration.current++;
}, [dialogOpen]);
```

This one effect covers both required scenarios without a separate manual
bump inside `close()`: a manual close sets `pairing` to `null`, which alone
drives `dialogOpen` to `false` and fires the effect; a join does the same
through the `joined`/`dialogOpen` derivation. Both are proven by dedicated
tests (below).

## Item 3 — `PairingDataMatrix` re-encoding every second

**Problem.** The countdown re-renders `PairingCodeDialog` every second,
and `PairingDataMatrix` re-ran the (expensive, bwip-js-based)
`renderLiteralDataMatrixSvg` call on every one of those re-renders, since it
was a plain, unmemoized function component.

**Fix.** The encoding is now wrapped in `useMemo(() => { try { return
renderLiteralDataMatrixSvg(payload); } catch { return null; } }, [payload])`,
so it only re-runs when `payload` itself changes (a new code), not on every
parent re-render.

## Coverage (item 4) and the item 5 pristine-output rule

Added to `apps/standalone/test/devices-page.test.tsx`:

- `it.each` over the host clock an hour ahead (`secondsAgo = -3600`) and an
  hour behind (`secondsAgo = 3600`) this PC's: in both, the dialog shows the
  code and a fresh `10:00`/`09:59` countdown, never "Срок кода истёк" and
  never an inflated duration.
- "does not reopen once closed while a new code was still on its way" —
  closes the dialog while a `mockImplementationOnce`-controlled pending
  `createPairingCode` request is in flight, resolves it afterward, and
  asserts the dialog stays closed.
- "keeps the join notice when a device joins while a new code was still on
  its way" — same shape, but the dialog auto-closes on a join instead of a
  manual close; asserts the join notice is still shown (not replaced or
  hidden) after the stale second code resolves.
- "replaces the old code and restarts the countdown when a new one is
  requested while one is live" — regenerates over a live code (`AAAAABBBBB`
  replacing `7K3MQ9XV2D`) and checks the old code is gone, the new one shows,
  and the countdown reads a fresh `10:00`/`09:59`.
- "shows a failed regenerate's error inside the dialog and keeps the old
  code" — a `forbidden` rejection on regenerate shows
  "Недостаточно прав для этого действия." _inside_ the still-open dialog,
  next to the still-visible old code.
- "closes on a join even when this PC's clock is skewed from the host's" —
  fixed host-clock ISO timestamps (`expiresAt`/`pairedAt`) with
  `vi.setSystemTime` set an hour ahead of them; the join still closes the
  dialog with the notice, proving join detection (already host-clock-only)
  stays immune to local clock skew.
- "encodes the DataMatrix once and reuses it while the countdown ticks" —
  wraps the real `@markiro/domain` export in `vi.fn(actual...)` via
  `vi.mock` (`importOriginal`) so the rendered SVG stays genuine, and
  asserts the encoder was called exactly once across five countdown ticks
  (`vi.advanceTimersByTimeAsync(5000)`), where it was called 3 times on the
  pre-fix code (see the red run below).

Also updated (required by item 1's behavior change, not a separate ask):

- "shows a new code with its DataMatrix..." — the countdown assertion
  changed from the old timing-sensitive `/^Код действует ещё 09:(30|29)$/`
  to `/^Код действует ещё (10:00|09:59)$/`, since a fresh code now always
  starts a full local countdown regardless of `secondsAgo`.
- "offers a new code once the code expired" — under the old design, a code
  the host reported as already expired (`pairingCode(601)`) showed "Срок
  кода истёк" immediately; under the fix, only _this PC's own elapsed
  local time_ can expire a freshly received code, so the test now advances
  fake time by the full `CODE_LIFETIME_MS` (10 minutes) while the dialog is
  open, using `mockImplementationOnce` (not `mockResolvedValueOnce`) for
  both codes so each `pairingCode(0)` call's `expiresAt` is evaluated
  lazily, at the moment the host is actually asked, not eagerly when the
  test body runs (an eager evaluation would give the second code an
  `expiresAt` already 10 minutes stale by the time it's requested — this
  was an actual bug I hit and fixed while writing the test, not a change to
  the reviewer's ask).

Item 5 (pristine output): every new fake-timer interaction uses `vi
.useFakeTimers({ shouldAdvanceTime: true })` and `await act(async () => {
await vi.advanceTimersByTimeAsync(...); })`, matching the pattern from fix
round 0. The full `devices-page.test.tsx` file was run once with
`--reporter=verbose`; no act/console warnings.

## RED run (before the fix)

To get an honest red run without `git stash` (forbidden) or touching git
history, the three pre-fix implementation files were temporarily restored
from the base commit with `git show 9e909b1d8:<path> > <path>` (plain
working-tree file overwrite, no git state change), the new test file (already
written) was run against them, and then the fixed implementation files were
written back from the exact content captured before the swap. `git diff
--stat` against `9e909b1d8` was checked immediately after restoring to
confirm the swap round-tripped exactly (64 insertions/15 deletions across
the 3 files, matching the intended fix, no drift).

Command: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/devices-page.test.tsx --reporter=verbose`

Result against the pre-fix files: **6 failed, 10 passed (16)**, exit code 1.

```
 × shows a new code with its DataMatrix, the code, the fingerprint and the host's addresses
   TestingLibraryElementError: Unable to find an element with the text: /^Код действует ещё (10:00|09:59)$/.

 × shows a fresh 10:00 countdown even when the host clock is an hour ahead of this PC's
   TestingLibraryElementError: Unable to find an element with the text: /^Код действует ещё (10:00|09:59)$/.

 × shows a fresh 10:00 countdown even when the host clock is an hour behind this PC's
   TestingLibraryElementError: Unable to find an element with the text: 7K3MQ 9XV2D.
   (the old code showed "Срок кода истёк" instead, for a code that had just been issued)

 × does not reopen once closed while a new code was still on its way
   AssertionError: expected <div role="dialog" …(5)>…(3)</div> to be null

 × keeps the join notice when a device joins while a new code was still on its way
   TestingLibraryElementError: Unable to find an element with the text: Устройство «Станция во время перевыпуска» подключено..

 × encodes the DataMatrix once and reuses it while the countdown ticks
   AssertionError: expected "vi.fn()" to be called 1 times, but got 3 times
```

The other 10 tests, including the rewritten "offers a new code once the code
expired", passed even against the pre-fix files — expected, since that test
(after the lazy-evaluation fix above) exercises a full genuine 10-minute
local elapse with no clock skew, where old and new logic agree; it is a
flow-coverage test, not a targeted regression test. The three items' own
targeted tests (the two `it.each` cases, the two staleness tests, and the
memoization test) are the ones that isolate each bug, and all six failed
exactly as expected.

## GREEN run (after the fix)

Same command, after writing the three fixed files back:

```
 Test Files  1 passed (1)
      Tests  16 passed (16)
```

No act/console warnings in the verbose output (grepped for `"not wrapped in
act"`, `console.error`, `console.warn`, `Warning:` — no matches).

## Every verification command and result

| Command                                                                                  | Result                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RED: `... exec vitest run test/devices-page.test.tsx --reporter=verbose` (pre-fix files) | 6 failed, 10 passed (16)                                                                                                                                                                                                                                                                                                                                                              |
| GREEN: same command (fixed files)                                                        | 16 passed, no warnings                                                                                                                                                                                                                                                                                                                                                                |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`              | **468 passed (28 files)** (460 + 8 net new tests: the two `it.each` cases plus six more)                                                                                                                                                                                                                                                                                              |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`         | clean, no output                                                                                                                                                                                                                                                                                                                                                                      |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`              | one error on the first pass (`@typescript-eslint/consistent-type-imports` on an inline `importOriginal<typeof import("@markiro/domain")>()`); fixed by adding `import type * as MarkiroDomain from "@markiro/domain"` and using `importOriginal<typeof MarkiroDomain>()`, matching the established pattern in `apps/api/test/jobs-readiness.test.ts` and others. Clean after the fix. |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build`             | succeeds; `PairingDataMatrix-Fv6cwG_O.js` still its own chunk (925.97 kB, gzip 253.78 kB); main bundle `index-DhmFfOdc.js` 683.40 kB — same pre-existing >500 kB warning, no new regression                                                                                                                                                                                           |
| `node_modules/.bin/prettier --write` then `--check` on the 4 changed files               | all "unchanged"; check passes                                                                                                                                                                                                                                                                                                                                                         |
| `git diff --check`                                                                       | clean                                                                                                                                                                                                                                                                                                                                                                                 |
| `grep -n '\u04' <changed files>`                                                         | no new literal escapes                                                                                                                                                                                                                                                                                                                                                                |
| `git log -1 --format=%B`                                                                 | exactly the required subject + trailer, no other Co-Authored-By line                                                                                                                                                                                                                                                                                                                  |

## Files changed (fix round 1)

```
 apps/standalone/src/office/devices/DevicesPage.tsx       |  36 +++-
 apps/standalone/src/office/devices/PairingCodeDialog.tsx |  25 ++-
 apps/standalone/src/office/devices/PairingDataMatrix.tsx |  18 +-
 apps/standalone/test/devices-page.test.tsx               | 215 ++++++++++++++++++++-
 4 files changed, 276 insertions(+), 18 deletions(-)
```

No other files touched, matching "these five items, nothing else."

Commit: `ee52dc437` — "fix(standalone): ревью задачи 6 плана 1c3 — таймер
кода от получения, устаревшие ответы, DataMatrix без перекодирования".

## Self-review (fix round 1)

- All five items addressed; nothing else touched (diff is exactly the 4
  files above).
- `close()` needs no separate generation bump: the single `useEffect` keyed
  on `dialogOpen` covers both the manual-close and the join-auto-close path,
  confirmed by both dedicated tests passing.
- Considered whether the `useOfficeQuery` polling inside `PairingCodeDialog`
  could race the generation guard (poll and mutation resolving in the same
  tick) — the two staleness tests exercise exactly this interleaving
  (poll-driven join arriving while a mutation is pending) and pass.
- The `it.each` labels ("ahead of" / "behind") read naturally in the
  generated test names (see the GREEN output above).
- No `any`, no non-null assertions beyond the pre-existing
  `let resolveSecond!: (code: PairingCode) => void;` pattern (definite
  assignment assertion on a `let` immediately assigned inside a `Promise`
  executor, an established pattern for capturing a promise's resolver in a
  test — not a cast on a value flowing through application logic).

## Concerns

None. All requested checks are green; the diff is scoped to exactly the
four files the five items touch.

---

# Fix round 2 (on top of ee52dc437)

The re-review confirmed the fix-round-1 production fixes, including the
effect-based generation bump under React 19.2, and asked for eight further
items, nothing else, in one new commit.

## Item 1 — the memo test only passed because earlier tests warmed the lazy chunk

**Problem.** `test/devices-page.test.tsx`'s "encodes the DataMatrix once…"
waited for `findByRole("dialog")`, then asserted `encode` was called exactly
once. `PairingDataMatrix` loads behind `React.lazy` + `Suspense`; the outer
`Modal` already has `role="dialog"` before that lazy chunk resolves, so when
run alone (`-t "encodes the DataMatrix once"`, nothing else in the file has
imported `PairingDataMatrix.js` yet) the dialog can appear with zero encodes
so far — the assertion of exactly `1` is order-dependent on an earlier test
having already warmed the dynamic import. Waiting for the image instead is
not sufficient either, per the coordinator: the first mount while the chunk
is still loading can run the memoized factory more than once.

**Fix.** Wait for the image (`within(dialog).findByRole("img", …)`), record
`shown = encode.mock.calls.length` at that point, assert `shown > 0` (proves
encoding happened at all, however many times), advance 5 s, then assert the
count is still exactly `shown` (proves ticking added none).

**Verification.**

- Ran alone 3 times: `vitest run test/devices-page.test.tsx -t "encodes the
DataMatrix once" --reporter=verbose` — passed all 3 times. The isolated
  run's own output showed `shown` was `2` (not `1`) at the image, directly
  confirming the coordinator's "can compute the memo twice while loading" —
  the old hard-coded `toHaveBeenCalledTimes(1)` would have been wrong even
  with the real fix in place, alone.
- Mutation test: temporarily reverted `PairingDataMatrix.tsx` to the
  pre-`useMemo` version (plain try/catch, no fix-round-1 memoization),
  confirmed the test now fails both alone and in the full file, then
  restored the fixed file (`git diff --stat` showed no residual diff against
  HEAD afterward, confirming an exact round trip). Alone:
  `AssertionError: expected "vi.fn()" to be called 2 times, but got 4 times`.
  In the full file: 16 passed, 1 failed (only this test).

## Item 2 — the generation-bump comment described renders, not the effect

**Problem.** The comment said the generation was "bumped on every render
where the dialog is not open." The code is a `useEffect` with a `[dialogOpen]`
dependency array, so it actually only runs when `dialogOpen`'s value
_changes_, not on every render.

**Fix.** Rewrote the comment in `DevicesPage.tsx` to say what the code does
(runs when `dialogOpen` changes, not every render) and added the mechanism
it depends on: React flushing passive effects synchronously for a
synchronous-lane commit — a click on "Закрыть", an Escape keydown, or the
`useSyncExternalStore` update React Query uses to publish a fresh poll
result (the joined device arriving) — so the bump has already happened by
the time a pending request's `await` settles, in both the manual-close and
the auto-close-on-join case.

## Item 3 — the failure path's staleness check had no test

**Problem.** `catch (error) { if (generation !== requestGeneration.current)
return; setFailure(...); }` — the `if` guard on the failure path was
untested. Removing it kept all 16 (at the time) tests green.

**Fix.** Added "shows no stray failure when a request abandoned by closing
the dialog later fails": opens the dialog, starts a "Новый код" request that
never settles until told to (`mockImplementationOnce` capturing `reject`),
closes the dialog, then rejects the abandoned request and asserts no
page-level error text appears and the dialog stays closed.

**Mutation check.** Temporarily removed the `if (generation !== ...)  return;`
line from the `catch` block only (not the `try` block's, which already has
its own coverage from fix round 1). Result:

- The new test alone: `AssertionError` — expected `null`, received a `<div>`
  containing "Недостаточно прав для этого действия." (the stray page-level
  error the guard exists to prevent).
- Full file: **16 passed, 1 failed** (only the new test) — confirming the
  coordinator's exact claim that the other 16 tests do not exercise this
  path at all.

Restored the guard immediately after; `git diff` showed the file back to
exactly the pre-mutation content.

## Item 4 — "…restarts the countdown" didn't actually check a restart

**Problem.** Both the first and second code were freshly issued in the same
test tick, so `(10:00|09:59)` would read true whether or not `newCode`
actually recomputed `deadline` on regenerate — the assertion could not have
caught a regression that stopped resetting the countdown.

**Fix.** Added `vi.useFakeTimers({ shouldAdvanceTime: true })` and a 2-minute
`vi.advanceTimersByTimeAsync` advance before requesting the second code, with
an intermediate assertion that the countdown text no longer matches the
fresh pattern (`queryByText(/^Код действует ещё (10:00|09:59)$/)).toBeNull()`).
Only after that does it request the second code and assert the countdown is
back to `10:00`/`09:59` — now a real restart, not a coincidence of both
codes being new.

## Item 5 — capture `Date.now()` before the request, not after

**Problem.** `newCode()` read `Date.now()` right before `setPairing`, i.e.
_after_ `await create.mutateAsync()` resolved. The host stamps a code's
`expiresAt` before a database write that can wait up to its 5 s busy
timeout, so a deadline taken after the answer arrives can read later than
the host's own expiry — the opposite of the safe direction.

**Fix.** Moved the `Date.now()` capture (renamed `receivedAt` →
`requestedAt` for accuracy) to immediately after computing `generation`,
_before_ the `try`/`await`. `deadline: requestedAt + CODE_LIFETIME_MS` now
uses that pre-request reading. Updated both doc comments (`Pairing.deadline`
in `DevicesPage.tsx`, `useRemainingMs` in `PairingCodeDialog.tsx`) to say
"requestedAt" and explain why it is taken before, not after.

## Item 6 — `let resolveSecond!: …` used a banned `!`

**Problem.** Two existing tests declared `let resolveSecond!: (code:
PairingCode) => void;` — a definite-assignment assertion (`!`), which the
plan's "без `any`, приведений и `!`" rule forbids.

**Fix.** Replaced both with the package's own established pattern (see
`test/app.test.tsx`'s `resolveFirst`): `let resolveSecond: (code:
PairingCode) => void = () => undefined;`. The new item-3 test's own resolver
variable (`rejectSecond`) was written with the same pattern from the start.
Grepped the whole file for `!` afterward: the only match is the pre-existing
`if (!row) throw ...` in the `rowOf` helper, a plain boolean negation, not a
non-null assertion or definite-assignment `!`.

## Item 7 — clamp the countdown to `CODE_LIFETIME_MS`

**Problem.** The first render after a fresh `deadline` arrives can still be
using a `now` value from the previous tick (up to a second stale, since
`useState`'s initializer only runs once and the effect's `setNow(Date.now())`
has not committed yet), so `deadline - now` could transiently exceed
`CODE_LIFETIME_MS` and read "10:01" for one frame.

**Fix.** `useRemainingMs` now returns `Math.max(0, Math.min(deadline - now,
CODE_LIFETIME_MS))`. `CODE_LIFETIME_MS` itself moved: it now lives in
`PairingCodeDialog.tsx` (exported, alongside the pre-existing `DEVICE_POLL_MS`
— the same file already had precedent for owning a shared timing constant),
and `DevicesPage.tsx` imports it from there instead of keeping its own local
copy — avoiding a circular import in the other direction, since `DevicesPage`
already imports `PairingCodeDialog` from that file. `test/devices-page.test
.tsx`'s own local duplicate `const CODE_LIFETIME_MS = 10 * 60 * 1000;` was
removed in favor of importing the same exported constant.

## Item 8 — `AGENTS.md` sentence

Added one sentence to the end of the «Устройства» bullet under "Office
pages": the countdown runs on this PC's own clock from the moment the code
was requested, since the host and the office PCs on a cloud-less LAN are not
promised to agree on the time, and join detection compares host timestamps
only. Line wrapping matches the rest of the paragraph (all lines land in the
existing 66–85-character range the bullet already uses).

## Every verification command and result

| Command                                                                           | Result                                                                                                                                               |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `... exec vitest run test/devices-page.test.tsx --reporter=verbose`               | **17 passed**, no act/console warnings                                                                                                               |
| Isolated memo test × 3: `... -t "encodes the DataMatrix once" --reporter=verbose` | passed all 3 times                                                                                                                                   |
| Mutation (item 1): pre-`useMemo` `PairingDataMatrix.tsx`, memo test alone         | failed: `expected 1 to be called, but got... "vi.fn()" to be called 2 times, but got 4 times` (`shown` was 2, not 1)                                 |
| Mutation (item 1): same, full file                                                | 16 passed, 1 failed (only the memo test)                                                                                                             |
| Mutation (item 3): `catch` staleness check removed, new test alone                | failed: expected `null`, received the stray error text                                                                                               |
| Mutation (item 3): same, full file                                                | 16 passed, 1 failed (only the new test) — confirms all pre-existing 16 stay green without the guard, exactly as the coordinator said                 |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`       | **469 passed (28 files)** (468 + 1 net new test)                                                                                                     |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`  | clean, no output                                                                                                                                     |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`       | clean, no output                                                                                                                                     |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build`      | succeeds; `PairingDataMatrix-C2-YzrWi.js` still its own chunk (925.97 kB, gzip 253.78 kB); main bundle 683.41 kB — same pre-existing >500 kB warning |
| `node_modules/.bin/prettier --write` then `--check` on the 4 changed files        | all "unchanged"; check passes                                                                                                                        |
| `git diff --check`                                                                | clean                                                                                                                                                |
| `grep -n '\u04' <changed files>`                                                  | no new literal escapes                                                                                                                               |
| `git log -1 --format=%B`                                                          | exactly the required subject + trailer, no other Co-Authored-By line                                                                                 |

Every mutation-test revert/restore used a targeted `Edit`/`Write` on the one
file involved (never a whole-file `git show` swap this round, since the
mutations were single lines/blocks), and each restore was confirmed with
`git diff --stat` showing no residual difference from the prior commit
before moving on.

## Files changed (fix round 2)

```
 apps/standalone/AGENTS.md                                 |  5 +-
 apps/standalone/src/office/devices/DevicesPage.tsx         | 44 +++++++++-------
 apps/standalone/src/office/devices/PairingCodeDialog.tsx   | 21 +++++---
 apps/standalone/test/devices-page.test.tsx                 | 61 +++++++++++++++++++---
 4 files changed, 96 insertions(+), 35 deletions(-)
```

`PairingDataMatrix.tsx` shows no diff against `ee52dc437`: it was touched
only for item 1's mutation test and restored to the exact committed byte
content, confirmed with `git diff --stat` before moving on. No other files
touched.

Commit: `64c3d75b1` — "fix(standalone): ревью задачи 6 плана 1c3 — тест
мемоизации без порядка, срок от запроса, правило двух часов".

## Self-review (fix round 2)

- All eight items addressed; nothing else touched (diff is exactly the 4
  files above; `PairingDataMatrix.tsx` round-tripped to no diff).
- Re-read `DevicesPage.tsx`'s new comment against the actual code once more
  after writing it: the effect's dependency array is `[dialogOpen]`, the
  claim "runs whenever `dialogOpen` changes value, not on every render" is
  accurate, and the two named synchronous-lane triggers (click/Escape,
  `useSyncExternalStore`) are the only two ways `dialogOpen` changes in this
  component (a manual close via `setPairing(null)`, or `joined` becoming
  defined via the polled query's cache update).
- Confirmed the `CODE_LIFETIME_MS` relocation does not introduce a circular
  import: `PairingCodeDialog.tsx` has no import from `DevicesPage.tsx` in
  either direction; only `DevicesPage.tsx → PairingCodeDialog.tsx`, matching
  the pre-existing `DEVICE_POLL_MS` direction.
- Grepped the full test file for `!` after the item 6 fix; only the
  pre-existing boolean negation in `rowOf` remains.
- Both required mutation tests were run to completion (not just reasoned
  about) and restored with a verified clean `git diff` before proceeding.

## Concerns

None. All eight items are implemented, tested, mutation-verified where asked,
and every requested check is green.
