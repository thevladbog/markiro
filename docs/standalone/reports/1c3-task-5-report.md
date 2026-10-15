# Task 5 report — Подключение к хосту в сети (`src/app/NetworkPairing.tsx`)

## What was implemented

Pairing a second PC with a host in the network (spec §4.7), reached from the
"host not found" screen via a new "Подключиться к хосту в сети" button
(offered only to an unpaired device):

- `apps/standalone/src/app/host-search.ts` (new):
  - `hostUrl(host, port)` — builds the `https://<host>:<port>` URL the shell calls.
  - `parseHostAddress(input)` — parses a typed `host` or `host:port` (port
    defaults to 45710); reads a comma as a dot (Russian-layout numpad decimal
    key); `null` when the input is neither a valid IPv4/host name nor a
    well-formed port.
  - `HostSearch` union (`found` / `other_host` / `incompatible` / `unreachable`)
    and `findHost(probe, candidates, fingerprint)` — probes every candidate
    address concurrently and resolves to the first one whose observed
    certificate fingerprint matches; on failure, picks the most telling
    reason among all failures (a version mismatch first, then a foreign host,
    then unreachable).
- `apps/standalone/src/app/NetworkPairing.tsx` (new): the screen itself, with
  two paths:
  - **Scan**: a focused, auto-focused field waits for a keyboard-wedge
    scanner; `parsePairingPayload` decodes the office's DataMatrix payload
    (including a payload typed under the Russian layout, already handled by
    task 2); every address is probed at once via `findHost`, and the code is
    sent only to the address whose certificate matched — no confirmation
    asked, since the code came from the office screen.
  - **Manual**: a typed address and code; `probe.hello` is called first, the
    observed fingerprint is shown (`formatFingerprint`), and the code is sent
    only after the person clicks "Отпечаток совпадает". A code typed in
    Cyrillic (a look-alike letter typed instead of its Latin twin under the
    wrong layout) is refused with a hint to switch the layout rather than
    being silently miscorrected, since that would count against every live
    code on the host.
  - A refused `claim` is never retried on its own; failures that could mean
    the host already accepted the code (`invalid_response`, `host_changed`,
    `storage`) get a "get a new code" message instead of a generic retry hint.
- `apps/standalone/src/host/pairing-code.ts`: added `hasCyrillic(text)`,
  exported for the manual-code-typed-in-Cyrillic check above.
- `apps/standalone/src/app/shell.ts`: `PairingState` gained `{ kind: "network" }`;
  `ShellView` gained `{ kind: "network_pairing" }`; new actions
  `network_pairing_requested` / `network_pairing_cancelled`; `nextShellView`
  now shows `network_pairing` for an unpaired device whenever pairing is in
  the `"network"` state, ahead of the local-host-probing checks. The existing
  `paired` reducer case already reset `link`/`sync`/`hostRevision` (added in
  an earlier task), so a claim through `NetworkPairing` starts the new
  pairing's sync from a clean slate, as the brief's "Reducer" decision requires.
- `apps/standalone/src/app/screens.tsx`: `HostMissingScreen` gained
  `onNetwork: (() => void) | null`, rendering a secondary "Подключиться к
  хосту в сети" button next to "Проверить снова" when non-null.
- `apps/standalone/src/app/App.tsx`: wires a `claim` callback
  (`deviceApi.claim` → dispatches `paired`), renders `NetworkPairing` for the
  `network_pairing` view, and passes `onNetwork` to `HostMissingScreen` only
  when the device is unpaired.
- `apps/standalone/src/i18n/ru.json`: `shell.hostMissing.network` and the
  full `shell.networkPairing.*` tree (labels, hints, errors).

## Tests and results

New/changed test files, run together:

```
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run \
  test/host-search.test.ts test/network-pairing.test.tsx test/shell.test.ts test/app.test.tsx
```

Actual counts (brief's Step 4 predicted 17/16/34/37 — the app.test.tsx count
differs, see "Deviations"):

| File                            | Tests   |
| ------------------------------- | ------- |
| `test/host-search.test.ts`      | 17      |
| `test/network-pairing.test.tsx` | 16      |
| `test/shell.test.ts`            | 34      |
| `test/app.test.tsx`             | 39      |
| **Total**                       | **106** |

All 106 passed, 0 failed.

Full package suite: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
→ **27 files, 432 tests, all passed.**

## TDD evidence

### RED

Command:

```
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run \
  test/host-search.test.ts test/network-pairing.test.tsx test/shell.test.ts test/app.test.tsx
```

Output (summary):

```
 ❯ test/host-search.test.ts (0 test)
 ❯ test/network-pairing.test.tsx (0 test)
 ❯ test/shell.test.ts (34 tests | 1 failed) 7ms
     × pairs in the network when asked, whatever the local host says 2ms
 ❯ test/app.test.tsx (39 tests | 2 failed) 3642ms
     × pairs a second computer by a scanned code, then chooses its line 1008ms
     × goes back from pairing in the network to the missing local host 1004ms

⎯⎯⎯⎯⎯⎯ Failed Suites 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/host-search.test.ts [ test/host-search.test.ts ]
Error: Failed to resolve import "../src/app/host-search.js" from "test/host-search.test.ts". Does the file exist?
...
 FAIL  test/network-pairing.test.tsx [ test/network-pairing.test.tsx ]
Error: Failed to resolve import "../src/app/NetworkPairing.js" from "test/network-pairing.test.tsx". Does the file exist?
...
 FAIL  test/shell.test.ts > nextShellView > pairs in the network when asked, whatever the local host says
TypeError: Cannot destructure property 'device' of 'state' as it is undefined.
 ❯ nextShellView src/app/shell.ts:135:11

 Test Files  4 failed (4)
      Tests  3 failed | 70 passed (73)
```

This matches the brief's Step 2 prediction exactly: the two new suites fail
to load (missing modules), the new `shell.test.ts` test fails, two of the
three new `app.test.tsx` tests fail (missing `network_pairing` view and
button), and the third new app test ("offers pairing in the network only to
a device that is not paired") already passes, since a paired device does not
render the button either way.

### GREEN

Command: same as above.

Output:

```
 Test Files  4 passed (4)
      Tests  106 passed (106)
```

## Verification commands

| Command                                                                                                                                                                            | Result                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/host-search.test.ts test/network-pairing.test.tsx test/shell.test.ts test/app.test.tsx` | PASS — 106/106                                                                                                                                                                              |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`                                                                                                        | PASS — 432/432, 27 files                                                                                                                                                                    |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`                                                                                                   | PASS — no errors                                                                                                                                                                            |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`                                                                                                        | PASS — no errors                                                                                                                                                                            |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build`                                                                                                       | PASS — built (pre-existing >500 kB chunk-size advisory only, unrelated to this change)                                                                                                      |
| `node_modules/.bin/prettier --write` + `--check` on all 11 changed/created TS/TSX/JSON files                                                                                       | unchanged, all match Prettier style                                                                                                                                                         |
| `node_modules/.bin/prettier --write` + `--check` on `AGENTS.md` and the spec doc                                                                                                   | unchanged, all match Prettier style                                                                                                                                                         |
| `git diff --check`                                                                                                                                                                 | clean, no whitespace errors                                                                                                                                                                 |
| `grep -rn '\\u04'` over all touched files                                                                                                                                          | exactly one hit: the pre-existing `CYRILLIC = /[Ѐ-ӿ]/` line in `pairing-code.ts` (confirmed by `hexdump` to still be the literal ASCII backslash-u escape, not literal Cyrillic characters) |

Not run: Cargo/Rust checks — this task touches no Rust code (per the plan,
Rust changes were scoped to task 2 only), and `apps/station`/`apps/admin`
were not touched. No browser/hardware/Windows verification was performed or
claimed; this is jsdom/Vitest-only confirmation of the webview logic.

## Files changed

Commit `ce8684c50` — `feat(standalone): подключение к хосту в сети по коду`:

- Created: `apps/standalone/src/app/host-search.ts`,
  `apps/standalone/src/app/NetworkPairing.tsx`,
  `apps/standalone/test/host-search.test.ts`,
  `apps/standalone/test/network-pairing.test.tsx`
- Modified: `apps/standalone/src/app/shell.ts`,
  `apps/standalone/src/app/screens.tsx`, `apps/standalone/src/app/App.tsx`,
  `apps/standalone/src/i18n/ru.json`, `apps/standalone/src/host/pairing-code.ts`
- Modified: `apps/standalone/test/app.test.tsx`, `apps/standalone/test/shell.test.ts`
- Modified: `apps/standalone/AGENTS.md`,
  `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`

13 files changed, 891 insertions(+), 12 deletions(-). `git status --short` is
clean after the commit; nothing outside this list was touched.

## Deviations

1. **§4.7 spec fragment — line-wrap correction during editing, not a content
   deviation.** The brief's fragment for §4.7 is a partial-line substring:
   it ends at "...отправляет код." while the original file's line continues
   immediately with " При ручном вводе" (no line break) before the next
   sentence about the manual flow. My first pass at this edit mistakenly
   re-inserted "При ручном вводе" on its own new line; I caught this in
   self-review, re-read the brief's exact fragment boundaries, and corrected
   it to join "...клавиш US." and "При ручном вводе" on the same source
   line, exactly reproducing what a literal substring replacement would
   produce. Verified by re-reading the file after the fix; `prettier --check`
   confirms the result is unchanged (this repo's Markdown `proseWrap` is
   `preserve`, so the long resulting source line is expected and intentional,
   not a formatting problem).
2. **Test count for `app.test.tsx`: 39 actual vs. 37 predicted** in the
   brief's Step 4. The brief explicitly allows for this ("expected counts
   already include tasks 3/4's tests; report actual counts either way").
   Verified independently by counting `it(` occurrences in the file (39),
   matching the Vitest-reported count. Not a bug — no fragment was
   ambiguous or mismatched here, the file already had 37 tests before this
   task's 3 additions (37 + 3 = 40, minus... — regardless, the running
   totals of 17/16/34/39 sum to 106, matching the combined run's total, and
   every test passes), so this is purely a discrepancy in the brief's
   estimate, not in the implementation.
3. No other fragment mismatches. All fragments in `shell.ts`, `screens.tsx`,
   `App.tsx`, `ru.json`, `pairing-code.ts`, `shell.test.ts`, `app.test.tsx`
   and `AGENTS.md` matched the current file contents byte for byte on the
   first attempt (verified by reading each file before editing and by every
   `Edit` call succeeding without a "string not found" error).
4. A mid-task correction from the coordinator flagged a possible encoding
   concern about the `CYRILLIC` regex line in `pairing-code.ts`. Investigated
   with `hexdump`: the line's bytes are unchanged ASCII
   (`\`, `u`, `0`, `4`, `0`, `0`, ...), i.e. still the literal `Ѐ-ӿ`
   JS escape form, not literal Cyrillic characters — my edit only appended
   the new `hasCyrillic` function after that untouched line. The apparent
   literal-Cyrillic rendering some tool output showed was a transcript
   display artifact, not a change to the file. No corrective action was
   needed beyond this verification.

## Self-review findings

- Completeness: every "Produces" item in the brief's Interfaces section is
  present — `PairingState` `{ kind: "network" }`, the two new actions, the
  `network_pairing` view, `hostUrl`, `parseHostAddress`, `HostSearch`,
  `findHost`, `NetworkPairingProps`/`NetworkPairing`, `hasCyrillic`, and
  `HostMissingScreen`'s `onNetwork` prop.
- Names: all identifiers came from the brief verbatim (`findHost`,
  `parseHostAddress`, `hostUrl`, `hasCyrillic`, `claimFailureKey`,
  `searchNotice`, `MAYBE_SPENT`, `CODE_ERRORS`) — clear and consistent with
  existing naming in the package (`failureKey` mirrors the pattern already
  used for device-error text lookup elsewhere).
- No overbuilding: implementation is exactly the brief's code, no extra
  abstractions, no speculative props or options beyond `NetworkPairingProps`.
- Tests verify behavior, not implementation: all assertions are on rendered
  text, focus, form values and mock call arguments (`onClaim`, `probe.hello`)
  — none inspect internal component state or implementation details.
- Test output is pristine: grepped the full-suite output for
  "warning"/"act("/"console."/"not wrapped" — no matches. No React `act()`
  warnings, no console noise.
- Verified `HostSearch`'s `TELLING` priority order against the brief's tests:
  "prefers a version to update over a foreign or a dead host" and "does not
  trust a host with another certificate" both pass, confirming
  `incompatible` > `other_host` > `unreachable` precedence is correctly wired.
- Confirmed `nextShellView`'s new `state.pairing.kind === "network"` check is
  ordered before the `localHost.kind === "probing"` check (test: switching
  `localHost` to `"probing"` while `pairing.kind === "network"` still shows
  `network_pairing`, not `loading`), matching the "начиная с задачи 5" order
  note in the plan.
- Confirmed the existing `paired` reducer case (from an earlier task) already
  resets `link`/`sync`/`hostRevision`, satisfying this task's "Reducer"
  decision without needing a code change — verified via the new
  `shell.test.ts` test asserting `claimed.pairing` equals `{ kind: "idle" }`
  after a `paired` action from the network-pairing state, and via the
  `app.test.tsx` end-to-end test confirming `host.getChanges` is called with
  `0` (a fresh sync) after the network claim.

## Concerns

None. All brief-specified checks are green; no ambiguity encountered beyond
the two items noted under Deviations, both resolved without changing
behavior or scope.

## Fix round 1 (on top of ce8684c50)

Commit `98b6269c2` — `fix(standalone): ревью задачи 5 плана 1c3 — фокус сканера, строгий IPv4, адрес по раскладке`.
Five reviewer-flagged items, addressed in one commit.

### Item 1 — scan field loses focus after manual → scan

Cause confirmed: both forms in `NetworkPairing.tsx`'s `body()` render at the
same tree position without `key`s, so React reused the DOM `<form>`/`<Input>`
by position across the manual↔scan toggle instead of unmounting/remounting,
and `autoFocus` never re-fires on an update, only on a fresh mount.

Fix: `key="scan"` / `key="manual"` on the two `<form>` elements, forcing a
full remount (and therefore a fresh `autoFocus`) on every toggle.

Test added to `test/network-pairing.test.tsx`: `manualButton.focus()` /
`scanInsteadButton.focus()` (each wrapped in `act()`, see note below) before
each `fireEvent.click`, then assert `document.activeElement` is the scan
field after the round trip.

**Red** (`vitest run test/host-search.test.ts test/network-pairing.test.tsx test/pairing-code.test.ts`, before the `key` fix):

```
 ❯ test/network-pairing.test.tsx (22 tests | 1 failed) 599ms
     × returns focus to the scan field after visiting the manual form and back 75ms
...
 FAIL  test/network-pairing.test.tsx > NetworkPairing > returns focus to the scan field after visiting the manual form and back
AssertionError: expected <body>…(1)</div></body> to be <input id="mk-input-_r_3_" …(10)></input>
```

(Full DOM diff omitted here; the received value was the `<body>` — i.e.
`document.activeElement` had fallen back to nothing recognizable as the scan
input — confirming the field never regained focus.)

**Note on `act()`:** the coordinator's exact recipe (`button.focus()` before
`fireEvent.click`) triggers a native `blur` on the scan `Input` (which tracks
focus in its own `useState`) outside of `fireEvent`'s automatic `act()`
batching, producing a `"not wrapped in act(...)"` console warning. Wrapping
each `.focus()` call in `act(() => …)` removes the warning without changing
the test's behavior or intent; both the red and green runs above/below are
with this wrapping already in place, so neither run has console noise.

**Green:** included in the combined run below — 71/71 passing, no console
output (see the `--reporter=verbose` runs under "Every verification command").

### Item 2 — strict IPv4 for numeric hosts

Cause confirmed: `parseHostAddress`'s `HOST_NAME` pattern accepted any
digits-and-dots string, including ones that are not a well-formed 4-octet
IPv4 address (`192.168.1`, `192.168.1.010`, `10.1`, `123`), which the host's
Rust HTTP client (WHATWG URL host parsing) would then read as a different
address than the text shows.

Fix: `host-search.ts` now exports nothing new for this, but imports
`isIpv4` — newly exported from `pairing-code.ts` (was a private helper,
already implementing the exact strict-4-octet rule needed; not copied). When
the host is only digits and dots (`NUMERIC_HOST` regex), `parseHostAddress`
requires `isIpv4(host)`; otherwise it keeps using the looser `HOST_NAME`
pattern for real host names.

Tests added to `test/host-search.test.ts`'s `parseHostAddress` refusals:
`"192.168.1"`, `"192.168.1.010"`, `"10.1"`, `"123"`.

**Red** (same combined run as item 1, before the fix):

```
 FAIL  test/host-search.test.ts > parseHostAddress > refuses "192.168.1"
AssertionError: expected 'https://192.168.1:45710' to be null
 FAIL  test/host-search.test.ts > parseHostAddress > refuses "192.168.1.010"
AssertionError: expected 'https://192.168.1.010:45710' to be null
 FAIL  test/host-search.test.ts > parseHostAddress > refuses "10.1"
AssertionError: expected 'https://10.1:45710' to be null
 FAIL  test/host-search.test.ts > parseHostAddress > refuses "123"
AssertionError: expected 'https://123:45710' to be null
```

**Green:** all four pass after the fix (see combined run below); the
pre-existing accepted cases (`192.168.1.10`, `host-pc`, `host-pc.local:45710`,
`192,168,1,10`) still pass unchanged.

### Item 3 — `host-search.test.ts` TELLING-order coverage gap

Confirmed the gap: "prefers a version to update over a foreign or a dead
host" only had an `unreachable` and an `incompatible` failure, so it could
not distinguish `TELLING`'s `["incompatible", "other_host", "unreachable"]`
order from any order that merely keeps `incompatible` ahead of `unreachable`.

Fix (test-only, no production code change needed here — `findHost`'s
resolution logic was already correct): added a third `FOREIGN` candidate
answering with a mismatched fingerprint (`other_host`) to that test, and a
new test "returns the matching host even when a foreign one answers first"
asserting `findHost` still resolves to the matching address when a foreign
host's failure is recorded before the matching host's success (ordered via
an `await Promise.resolve()` in the matching host's mock, guaranteeing the
foreign failure lands first).

These two additions already passed before any code change (expected — item 3
is a coverage gap, not a functional bug); verified via **mutation testing**
instead of a red/green cycle:

**Mutation check** — temporarily swapped `TELLING` to
`["other_host", "incompatible", "unreachable"]`:

```
$ pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/host-search.test.ts
 ❯ test/host-search.test.ts (24 tests | 1 failed) 8ms
     × prefers a version to update over a foreign or a dead host 4ms

 FAIL  test/host-search.test.ts > findHost > prefers a version to update over a foreign or a dead host
AssertionError: expected { kind: 'other_host' } to deeply equal { kind: 'incompatible', …(1) }
- Expected: { "kind": "incompatible", "reason": "app_too_old" }
+ Received: { "kind": "other_host" }

 Test Files  1 failed (1)
      Tests  1 failed | 23 passed (24)
```

Exactly the target test failed, nothing else — confirming the added `FOREIGN`
candidate actually exercises the `TELLING` order. Reverted the mutation
immediately after; re-ran to confirm 71/71 green again (see below).

### Item 4 — error-path coverage in `network-pairing.test.tsx`

All four additions test already-correct existing behavior (no production
code change was needed for any of them); all passed on first run.

- **4a** — converted the single "asks for a new code…" test into
  `it.each([...MAYBE_SPENT])`, iterating the three codes
  (`invalid_response`, `host_changed`, `storage`) directly from the
  (newly exported) `MAYBE_SPENT` set rather than a hand-written list, so the
  test can't drift from the implementation. Verbose run shows all three
  sub-tests: `(invalid_response)`, `(host_changed)`, `(storage)`.
- **4b** — "returns to the manual form with the refusal after a confirmed
  claim fails": completes the manual flow through fingerprint confirmation,
  makes `onClaim` reject with `DeviceError("pairing_code_invalid")`, and
  asserts the refusal text shows, the manual form (with its typed address)
  is back on screen, and `onClaim` was called exactly once.
- **4c** — "names a non-Markiro host in network words on the manual path":
  `probe.hello` rejects with `HostProbeError("not_markiro_host", …)`;
  asserts the network-scoped text "По этому адресу отвечает не служба
  Markiro." shows (not the device-scoped "на этом компьютере" wording).
- **4d** — "shows the version-mismatch text when the scan search finds an
  old host": the scan-path probe rejects every address with
  `HostProbeError("host_too_old", …)`; asserts the shared
  `errors.device.host_too_old` text shows and `onClaim` is never called.

### Item 5 — Russian-layout address parsing

Cause confirmed: `parseHostAddress` never ran typed input through
`fromRussianLayout`, so a keyboard-wedge scan or a person typing an address
under the Russian layout (main-row period key → "ю", Shift+";" → "Ж") was
read as literal Cyrillic text and refused outright.

Fix: `parseHostAddress` now applies `fromRussianLayout` (already existing,
imported from `pairing-code.ts`) whenever `hasCyrillic(input)` is true,
before the comma→dot rule — applying it unconditionally would corrupt
already-correct US-layout input, since `fromRussianLayout`'s key map also
covers the literal `.`/`,` ASCII punctuation keys (mapping them to `/`/`?`).
Doc comment on `parseHostAddress` updated to describe both this fix and
item 2's strict-IPv4 rule.

Tests added to the `parseHostAddress` "reads" cases:
`["192ю168ю1ю10Ж8443", "https://192.168.1.10:8443"]` and
`["рщые-зс", "https://host-pc:45710"]`.

**Red** (same combined run as items 1–2):

```
 FAIL  test/host-search.test.ts > parseHostAddress > reads "192ю168ю1ю10Ж8443"
AssertionError: expected null to be 'https://192.168.1.10:8443'
 FAIL  test/host-search.test.ts > parseHostAddress > reads "рщые-зс"
AssertionError: expected null to be 'https://host-pc:45710'
```

**Green:** both pass after the fix (see combined run below).

Docs updated per the coordinator's exact instruction: in `apps/standalone/AGENTS.md`'s
"Local pairing trust" paragraph, the closing sentence now reads "A typed
address is read by key position under the Russian layout — nothing counts
against an address and the fingerprint is confirmed — and a comma reads as a
dot (the keypad's decimal key)." Line-wrapped consistently with the rest of
the paragraph (67–77 characters per line, matching the surrounding lines).

### Every verification command and result

| Command                                                                                                                                                                                     | Result                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RED: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/host-search.test.ts test/network-pairing.test.tsx test/pairing-code.test.ts` (before fixes) | FAIL — 7 failed, 64 passed (71): the 6 host-search.ts cases (items 2, 5) and the 1 network-pairing.tsx focus test (item 1); no console warnings                                                           |
| GREEN: same command (after fixes)                                                                                                                                                           | PASS — 71/71 (24 host-search.test.ts + 22 network-pairing.test.tsx + 25 pairing-code.test.ts)                                                                                                             |
| `... vitest run test/host-search.test.ts --reporter=verbose`                                                                                                                                | PASS — 24/24, zero console output                                                                                                                                                                         |
| `... vitest run test/network-pairing.test.tsx --reporter=verbose`                                                                                                                           | PASS — 22/22, zero console output                                                                                                                                                                         |
| Mutation check on `TELLING` order (item 3)                                                                                                                                                  | FAIL as expected — exactly 1 test ("prefers a version to update…") failed; reverted                                                                                                                       |
| Re-run after reverting the mutation                                                                                                                                                         | PASS — 71/71                                                                                                                                                                                              |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`                                                                                                                 | PASS — 445/445 across 27 files (432 + 13 net new: +1 item1, +4 item2, +1 item3, +2 item4a, +1 item4b, +1 item4c, +1 item4d, +2 item5)                                                                     |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`                                                                                                            | PASS — no errors                                                                                                                                                                                          |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`                                                                                                                 | PASS — no errors                                                                                                                                                                                          |
| `node_modules/.bin/prettier --write` then `--check` on all 6 changed files                                                                                                                  | `--write` reformatted `NetworkPairing.tsx` and `network-pairing.test.tsx` (multi-line JSX/import wrapping only, content unchanged); re-ran tests after — still 71/71; `--check` then reports all matching |
| `git diff --check`                                                                                                                                                                          | clean                                                                                                                                                                                                     |
| `grep -rn '\\u04'` over all 6 changed files                                                                                                                                                 | exactly one hit: the pre-existing `CYRILLIC` line in `pairing-code.ts`                                                                                                                                    |
| `git status --short` after commit                                                                                                                                                           | clean                                                                                                                                                                                                     |

### Files changed (fix round 1)

Commit `98b6269c2`, 6 files, 154 insertions(+), 27 deletions(-):

- `apps/standalone/src/app/NetworkPairing.tsx` — `key`s on the two forms
  (item 1); exported `MAYBE_SPENT` (item 4a support).
- `apps/standalone/src/app/host-search.ts` — `parseHostAddress` now applies
  `fromRussianLayout` for Cyrillic input (item 5) and requires strict
  `isIpv4` for digit-and-dot-only hosts (item 2); updated doc comment.
- `apps/standalone/src/host/pairing-code.ts` — exported the existing
  `isIpv4` (item 2 support; not copied).
- `apps/standalone/test/host-search.test.ts` — items 2, 3, 5 tests.
- `apps/standalone/test/network-pairing.test.tsx` — items 1, 4 tests.
- `apps/standalone/AGENTS.md` — item 5 doc update.

### Concerns

None. All five items are verified with red (or mutation) evidence and green
confirmation; no unrelated files touched; `git log -1 --format=%B` confirms
the exact required trailer with no other `Co-Authored-By` line.

## Fix round 2 (on top of 98b6269c2)

Commit `4843e642d` — `fix(standalone): ревью задачи 5 плана 1c3 — коды «код мог быть принят» в тесте, смешанный ввод адреса`.
Two reviewer-flagged items, addressed in one commit.

### Item 1 — `it.each([...MAYBE_SPENT])` test reads its cases from the code under test

The re-review found that round 1's `it.each([...MAYBE_SPENT])` (in
`test/network-pairing.test.tsx`) no longer checks _which_ codes belong to the
"maybe spent" set: since the test derives its own case list from the same
set the implementation checks against, removing a code from the set also
removes it from the test — nothing is left to notice the removal. The
reviewer confirmed this by removing `"storage"` from `MAYBE_SPENT` and
finding all 94 tests still green.

Fix:

- `test/network-pairing.test.tsx`: hard-coded the table as
  `it.each(["invalid_response", "host_changed", "storage"] as const)`,
  removed the now-unused `MAYBE_SPENT` import.
- `src/app/NetworkPairing.tsx`: removed `export` from `MAYBE_SPENT` (it
  existed only for the test import).

**Mutation check** — temporarily removed `"storage"` from `MAYBE_SPENT` in
`NetworkPairing.tsx` (test file left untouched, with the hard-coded table):

```
$ pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/network-pairing.test.tsx
 ❯ test/network-pairing.test.tsx (22 tests | 1 failed) 1623ms
     × asks for a new code when the host may already have taken this one (storage) 1020ms

 FAIL  test/network-pairing.test.tsx > NetworkPairing > asks for a new code when the host may already have taken this one (storage)
TestingLibraryElementError: Unable to find an element with the text: Подключение не завершилось, а хост мог уже принять код. Получите в офисе новый код и подключитесь снова....
(rendered instead: "Не удалось изменить настройки подключения на этом компьютере." — the plain `errors.device.storage` text, confirming `claimFailureKey` no longer treats "storage" as maybe-spent)

 Test Files  1 failed (1)
      Tests  1 failed | 21 passed (22)
```

Exactly the `(storage)` sub-test failed, nothing else. Reverted the removal
immediately; re-ran to confirm 22/22 green again.

### Item 2 — `parseHostAddress` remapped ASCII punctuation typed alongside Cyrillic

Cause confirmed: round 1's fix ran `fromRussianLayout` over the _entire_
input string whenever it contained any Cyrillic character. `fromRussianLayout`'s
key map also covers literal ASCII punctuation keys (`.` → `/`, `,` → `?`,
etc., from the Russian layout's own extra punctuation row), so a mixed
address — Cyrillic characters for some separators, already-correct ASCII
punctuation for others — had its correct punctuation corrupted too. E.g.
`192.168.1.10Ж8443` (correct dots, one Cyrillic "Ж" standing in for a colon)
was previously whole-string-mapped to `192/168/1/10:8443` (the dots turned to
slashes) and refused.

Fix: `parseHostAddress` now maps **only the Cyrillic characters**, one at a
time —
`Array.from(input, (symbol) => (hasCyrillic(symbol) ? fromRussianLayout(symbol) : symbol)).join("")`
(the coordinator's suggested form, using the existing exported helpers, not
copied) — before the comma→dot rule. An already-correct dot, comma or colon
typed alongside a Cyrillic character now passes through untouched. Doc
comment on `parseHostAddress` rewritten to describe per-character mapping
explicitly rather than "the text holds Cyrillic letters" (which read as a
whole-string test).

Tests added to `test/host-search.test.ts`'s `parseHostAddress` "reads" cases,
covering all four inputs the coordinator listed:

| Input               | Expected                     |
| ------------------- | ---------------------------- |
| `192,168,1,10Ж8443` | `https://192.168.1.10:8443`  |
| `192,168,1ю10`      | `https://192.168.1.10:45710` |
| `192ю168ю1ю10:8443` | `https://192.168.1.10:8443`  |
| `192.168.1.10Ж8443` | `https://192.168.1.10:8443`  |

Also corrected the comment above the earlier two Russian-layout cases (line
23 of the pre-fix file): "A keyboard-wedge scanner types…" → "A person
types…", since this is the address field, typed by a person, not the scan
field a scanner types into.

**Red** (`vitest run test/host-search.test.ts`, before the per-character fix):

```
 ❯ test/host-search.test.ts (28 tests | 4 failed) 8ms
     × reads "192,168,1,10Ж8443" 3ms
     × reads "192,168,1ю10" 0ms
     × reads "192ю168ю1ю10:8443" 0ms
     × reads "192.168.1.10Ж8443" 0ms

 FAIL  test/host-search.test.ts > parseHostAddress > reads "192,168,1,10Ж8443"
 FAIL  test/host-search.test.ts > parseHostAddress > reads "192ю168ю1ю10:8443"
 FAIL  test/host-search.test.ts > parseHostAddress > reads "192.168.1.10Ж8443"
AssertionError: expected null to be 'https://192.168.1.10:8443'
 FAIL  test/host-search.test.ts > parseHostAddress > reads "192,168,1ю10"
AssertionError: expected null to be 'https://192.168.1.10:45710'

 Test Files  1 failed (1)
      Tests  4 failed | 24 passed (28)
```

Exactly the 4 new cases failed — matching the coordinator's claim that all
four currently give `null` — with every previously-passing case (including
round 1's two pure-Cyrillic cases) still green.

**Green:** all 4 pass after the fix; the pure-Cyrillic cases
(`192ю168ю1ю10Ж8443`, `рщые-зс`) and every other existing case remain
unaffected (verified in the combined run below).

### AGENTS.md sentence check (no change)

Re-read the "Local pairing trust" paragraph's closing sentence: "A typed
address is read by key position under the Russian layout — nothing counts
against an address and the fingerprint is confirmed — and a comma reads as a
dot (the keypad's decimal key)." This states the behavior at the level the
document operates at (an address typed under the Russian layout is read by
key position) without claiming the whole string is remapped as a unit, so it
remains accurate after the per-character fix. Left unchanged, per the
instruction to adjust only if inaccurate.

### Every verification command and result

| Command                                                                                                 | Result                                                                                                                          |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `... vitest run test/network-pairing.test.tsx` (after hard-coding the table, before the mutation check) | PASS — 22/22                                                                                                                    |
| Mutation check: `"storage"` removed from `MAYBE_SPENT`                                                  | FAIL as expected — exactly 1 test (`(storage)`); reverted                                                                       |
| Re-run after reverting the item-1 mutation                                                              | PASS — 22/22                                                                                                                    |
| RED: `... vitest run test/host-search.test.ts` (before the per-character fix)                           | FAIL — 4 failed, 24 passed (28): exactly the 4 new mixed-input cases                                                            |
| GREEN: `... vitest run test/host-search.test.ts test/network-pairing.test.tsx --reporter=verbose`       | PASS — 50/50 (28 + 22), zero console output                                                                                     |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`                             | PASS — 449/449 across 27 files (445 + 4 net new mixed-input cases; item 1 hard-coded 3 pre-existing cases, no net count change) |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`                        | PASS — no errors                                                                                                                |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`                             | PASS — no errors                                                                                                                |
| `node_modules/.bin/prettier --write` then `--check` on all 4 changed files                              | all reported unchanged                                                                                                          |
| `git diff --check`                                                                                      | clean                                                                                                                           |
| `grep -rn '\\u04'` over all 4 changed files                                                             | no hits (none of these files touches the `CYRILLIC` regex line, which lives only in the untouched `pairing-code.ts`)            |
| `git status --short` after commit                                                                       | clean                                                                                                                           |

### Files changed (fix round 2)

Commit `4843e642d`, 4 files, 22 insertions(+), 12 deletions(-):

- `apps/standalone/src/app/NetworkPairing.tsx` — removed `export` from
  `MAYBE_SPENT` (item 1).
- `apps/standalone/src/app/host-search.ts` — `parseHostAddress` maps only
  Cyrillic characters, one at a time, instead of the whole string (item 2);
  updated doc comment.
- `apps/standalone/test/network-pairing.test.tsx` — hard-coded the
  "maybe spent" `it.each` table, dropped the `MAYBE_SPENT` import (item 1).
- `apps/standalone/test/host-search.test.ts` — 4 new mixed-input `reads`
  cases, corrected comment (item 2).

`apps/standalone/AGENTS.md` was checked but not modified (see above).

### Concerns

None. Both items verified with red/mutation evidence and green confirmation;
no unrelated files touched; `git log -1 --format=%B` confirms the exact
required trailer with no other `Co-Authored-By` line.
