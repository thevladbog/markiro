# Plan 1c3 final-review fix wave — report

Commit: `899698b82` — `fix(standalone): итоговое ревью 1c3 — фокус, дата связи, повтор отказанного кода, тесты`

Items A–I done as specified in `1c3-final-fix-brief.md`. No changes outside
the eleven files listed below; `apps/station`, `apps/admin` and the Rust
crates are untouched.

## Files changed

```
apps/standalone/AGENTS.md
apps/standalone/src/app/HostStatusLine.tsx
apps/standalone/src/app/LineSelect.tsx
apps/standalone/src/app/NetworkPairing.tsx
apps/standalone/src/app/shell.ts
apps/standalone/src/i18n/ru.json
apps/standalone/test/app.test.tsx
apps/standalone/test/host-status-line.test.tsx
apps/standalone/test/line-select.test.tsx
apps/standalone/test/network-pairing.test.tsx
apps/standalone/test/reference-sync.test.ts
```

## A. Rollback + failed refetch keeps the copies

No production-code change: `syncReferences` already defers the wipe into the
first new page's transaction, so a refetch that never lands never wipes.
Added a regression test to `test/reference-sync.test.ts`:

> `keeps the previous copies when the rollback's own refetch fails` — seeds
> two synced lines, the feed answers `since=20` with a rollback to rev 12,
> the refetch at `since=0` rejects with `"host unreachable"`; asserts
> `syncReferences` rejects and `tables(db)` still equals the pre-rollback
> snapshot (rows and `sync_state` both).

**Mutation check** — temporarily added `await local.transaction(WIPE);`
right in the `page.rev < since` branch (wiping immediately instead of
deferring), reverted after:

```
FAIL  test/reference-sync.test.ts > reference sync > keeps the previous copies when the rollback's own refetch fails
AssertionError: expected { org: [], site: [], lines: [], …(1) } to deeply equal { org: [], site: [], …(2) }
- Expected  (has the two lines + sync_state)
+ Received  (lines: [], state: [])
 ❯ test/reference-sync.test.ts:348:24
```

Reverted (`git diff` on `src/local/reference-sync.ts` is empty); test passes
again against the real source.

## B. Race-test comment read backwards

`test/app.test.tsx` — "stops at another host even when a revision arrives
during the first sync": rewrote the comment. It now says the second call
would _succeed_ against the default fake host and, without the reducer's
`other_host` guard, would flip the screen back to the floor — and that the
request-count assertion (`getChanges` called once) is what catches that even
with the guard in place, since it proves the second run never reached the
host at all. Comment-only change; no test behavior change.

## C. HostStatusLine: date for a non-today contact; live region always rendered

**C1** — `HostStatusLine.tsx`: added a `DATE` formatter
(`Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit" })`) and a
`sameLocalDay` helper; when `lastContactAt` falls on a different local
calendar day than now, the label uses a new key `link.offlineSinceDate`
("Нет связи с хостом с {{date}} {{time}}"); same-day text is unchanged.
Tests in `test/host-status-line.test.tsx` use `vi.useFakeTimers()` /
`vi.setSystemTime` and an `afterEach(() => vi.useRealTimers())`:

- `says since when the host is silent and why, on the same day` — "now"
  pinned to the same local day as `AT_14_05`; unchanged text.
- `adds the date when the last contact fell on an earlier local day` — "now"
  the next morning, contact the day before at 14:05; expects
  `"Нет связи с хостом с 26.09 14:05"`.

**Red run** (component reverted to pre-fix, tests as committed):

```
FAIL  … adds the date when the last contact fell on an earlier local day
AssertionError: … screen.getByText("Нет связи с хостом с 26.09 14:05")
Unable to find an element with the text: Нет связи с хостом с 26.09 14:05.
(actual DOM showed "Нет связи с хостом с 14:05" — the date was missing)

FAIL  … renders the live region empty before the first status, so a screen reader already watches it
AssertionError: expected null to be truthy
 ❯ … container.querySelector(".host-status")   (component returned null)

Test Files  1 failed (1)
     Tests  2 failed | 5 passed (7)
```

Restored the fix; full file green again (7/7).

**C2** — same file: the component now always renders the
`role="status" aria-live="polite"` container, empty (`content = null`)
before the first status, so the region exists before it has anything to
announce. Adjusted the null-status test (renamed) to assert the container
exists, has both attributes, and `textContent === ""`, instead of asserting
`container.innerHTML === ""`. Covered by the same red run above.

## D. NetworkPairing focus

**D1** — after "Далее" on the manual form, focus moves to the fingerprint
block, not to «Отпечаток совпадает» and not to `<body>`. The confirmation
JSX is now wrapped in `<div ref={fingerprintRef} tabIndex={-1}
className="standalone-form">` (kept the existing `standalone-form` gap
styling, so nothing shifts visually), focused via
`useEffect(() => { if (confirmation) fingerprintRef.current?.focus(); },
[confirmation])`.

**D2** — after any notice on the scan form (not a code, no addresses, no
host found, a refused claim), focus returns to the scan field instead of
staying on the now-disabled «Подключить». `Input` (`@markiro/ui`) does not
forward a ref, so the scan `Input` is wrapped in a plain
`<div ref={scanFieldHostRef}>` and the effect queries
`scanFieldHostRef.current?.querySelector("input")?.focus()` when
`!manual && !confirmation && notice`.

Tests in `test/network-pairing.test.tsx`:

- New: `moves focus to the fingerprint block after confirming the manual
form, never to the confirm button` (D1) — focuses «Далее» first
  (`act(() => nextButton.focus())`), clicks it, asserts
  `document.activeElement` is the `[tabindex="-1"]` ancestor of the
  fingerprint-body text, and is neither the confirm button nor `<body>`.
- The shared `scan()` test helper now does `act(() => button.focus())`
  before `fireEvent.click`, matching the existing focus-test pattern, so
  every scan-path test simulates a real mouse click's focus first.
- Added a focus assertion (D2) to the four existing scan-form-notice tests:
  `explains a scan that is not a pairing code, without probing`, `warns when
the code carries no host address`, `names the addresses when none answers
with the code's certificate`, and `explains a refused code and never sends
it again on its own`.

**Red run** (component reverted to pre-fix; test file as committed) — full
`network-pairing.test.tsx`, 7 of 25 failed, exactly the D/H additions:

```
FAIL  … moves focus to the fingerprint block after confirming the manual form, never to the confirm button   (D1)
FAIL  … explains a scan that is not a pairing code, without probing                                          (D2)
FAIL  … warns when the code carries no host address                                                          (D2)
FAIL  … names the addresses when none answers with the code's certificate                                    (D2)
FAIL  … explains a refused code and never sends it again on its own                                          (D2)
FAIL  … does not probe or claim again with a code the host already refused on this screen (scan path)         (H)
FAIL  … does not probe or claim again with a code the host already refused on this screen (manual path)       (H)

Test Files  1 failed (1)
     Tests  7 failed | 18 passed (25)
```

Restored the fix; full file green again (25/25).

## E. LineSelect refusal wording on a remote station

`LineSelect.tsx`: added `failureKey(code)`, analogous to
`NetworkPairing.failureKey` — maps `unreachable` to `errors.link.unreachable`
("Хост не отвечает."), the existing neutral link text, instead of
`errors.device.unreachable` ("Служба хоста на этом компьютере не
отвечает."). Every other code still uses `errors.device.<code>`.

Test in `test/line-select.test.tsx`: `explains an unreachable host in words
true for a remote station too` — `onSelect` rejects with
`DeviceError("unreachable", …)`; asserts the neutral text shows and the
"this computer" text does not. Verified red against the pre-fix
`LineSelect.tsx` (failed waiting for "Хост не отвечает." — the DOM only had
the old "this computer" text), green after the fix; not one of the five
items the brief requires a recorded red/mutation output for, but checked the
same way.

`errors.device.unreachable` itself is untouched, since `test/wizard.test.tsx`
still relies on it for the (genuinely local) bootstrap-wizard repair screen.

## F. `paired` comment in shell.ts

Corrected: `paired` is dispatched from `pairLocally` (on its own when
pairing is due, or from `bootstrap`) **and** from network pairing's `claim`
(`App.tsx`'s `claim` callback, `onClaim` for `NetworkPairing`) — not only
from `pairLocally`/`bootstrap` as the old comment said. The invariant itself
("only from an unpaired device") is unchanged and still holds: `claim`
throws `already_paired` if a status is already set, same as `pairLocally`.

## G. "First sync only after watch resolves" pin

Added `syncs only after watch settles, not before, even though the fake
connection usually resolves at once` to `test/app.test.tsx`: a `ConnectionApi`
whose `watch` returns a promise resolved by hand. Asserts `host.getChanges`
is not called before `resolveWatch` runs (after a flushed microtask/timer
tick) and is called exactly once after.

**Mutation check** — temporarily added `scheduler.trigger();` in
`host-link.ts` right after `createSyncScheduler(...)`, before
`connection.watch(...)`, reverted after:

```
FAIL  … syncs only after watch settles, not before, even though the fake connection usually resolves at once
AssertionError: expected "vi.fn()" to not be called at all, but actually been called 1 times
 ❯ test/app.test.tsx:711:33
    expect(host.getChanges).not.toHaveBeenCalled();
```

Reverted (`git diff` on `src/app/host-link.ts` is empty); full `app.test.tsx`
green again (40/40).

## H. A code refused on this screen is not sent again

`NetworkPairing.tsx`: new `REMEMBER_REFUSAL` set
(`pairing_code_invalid`, `pairing_code_expired`, plus `MAYBE_SPENT`'s
`invalid_response`/`host_changed`/`storage`) and a `refusedCodes` state
(`Map<canonical code, notice key>`). `claim`'s catch records the code it was
called with when the error is a `DeviceError` in that set — never for
`rate_limited` or anything not in the set (including a non-`DeviceError`
transport failure, which can't match `instanceof DeviceError` at all).
`submitScan` and `submitManual` both check `refusedCodes.get(canonical)`
right after validating the code and before doing anything network-facing
(`findHost`/`probe.hello`); if found, they show the remembered notice and
return without probing or claiming.

Tests (see D above for the red run, same commit — both new tests are in the
7-of-25 failures):

- `does not probe or claim again with a code the host already refused on
this screen (manual path)` — refused once with `pairing_code_invalid` via
  the confirm step (`probe.hello` called once, `onClaim` once), submits
  "Далее" again with the same still-populated code field; asserts
  `probe.hello` and `onClaim` both stay at their post-refusal counts.
- `… (scan path)` — same payload scanned twice; asserts `probe.hello` stays
  at 2 (both addresses probed once on the first, genuine attempt) and
  `onClaim` stays at 1.

## I. AGENTS.md wording

Three edits in `apps/standalone/AGENTS.md`, "Local pairing trust" and "App
shell":

1. "A typed address is read by key position…" → "A typed address's Cyrillic
   characters are read by key position under the Russian layout, and
   everything else is kept — …", matching `parseHostAddress`'s actual
   per-character behavior (only `hasCyrillic` characters go through
   `fromRussianLayout`).
2. Added, in "App shell": "A refused device key or a changed certificate
   from that call is a rejected device — `key_rejected` or `host_changed` —
   exactly as on every other host path," right after the
   `device_select_line` sentence.
3. Added, in "Local pairing trust": "…a refused claim is never retried on
   its own — nor sent again from the same screen: the screen remembers a
   code the host already refused there and repeats the same refusal for it
   without probing or claiming again."

Re-wrapped both touched paragraphs to the file's own line-length convention
(checked every line's true character count with Python, all ≤ 79).

## Verification

Focused run, changed test files, verbose (no console output beyond one
pre-existing, unrelated warning — see Deviations):

```
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run \
  test/reference-sync.test.ts test/app.test.tsx test/host-status-line.test.tsx \
  test/network-pairing.test.tsx test/line-select.test.tsx --reporter=verbose

Test Files  5 passed (5)
     Tests  104 passed (104)
```

Full suite, typecheck, lint, build:

```
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test
Test Files  28 passed (28)
     Tests  476 passed (476)        (see Deviations: flaked once in 5 full runs, unrelated test)

pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck
$ tsc -p tsconfig.json --noEmit                       (clean, no output)

pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint
$ eslint . --ignore-pattern 'target/**' …             (clean, no output)

pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build
✓ built in 289ms                                      (pre-existing >500kB chunk-size
                                                        notice for the lazy DataMatrix
                                                        encoder, unrelated to this change)
```

Formatting and whitespace:

```
node_modules/.bin/prettier --check <the 11 changed files>
All matched files use Prettier code style!             (after one --write pass on two
                                                         test files' new blocks; both
                                                         reverified clean afterwards)

git diff --check
(no output, exit 0)
```

Literal-escape check (Cyrillic added through the edit tool):

```
grep -n '\u04' <changed ru.json, AGENTS.md, and all touched test/*.tsx>
(no matches in any file)
git show --format="" HEAD | grep -n '\u04'
(no matches)
```

Commit trailer:

```
git log -1 --format=%B
fix(standalone): итоговое ревью 1c3 — фокус, дата связи, повтор отказанного кода, тесты

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

Exactly one commit, explicit paths only (the 11 files above staged by name,
`git status --short` was empty of anything else before staging).

## Deviations / things worth flagging

- **Pre-existing, unrelated flake in the full suite.** Across 5 full
  `pnpm … test` runs of `@markiro/standalone` in this session, one run
  failed:
  `test/app.test.tsx > App > stops the link and shows the rejected-device
screen when a sync's error refuses the device's key` —
  `expect(link.stop).toHaveBeenCalledTimes(1)` saw 0 calls. That test is
  untouched by this change (confirmed via `git diff`, which shows no edits
  near it), and it never failed in this session's many isolated/five-file
  runs of `test/app.test.tsx`, only once in the wider 28-file run. The
  assertion checks that a `useEffect` cleanup (`unwatch()` →
  `connection.stop()`) has already run immediately after `findByText`
  resolves, with no `waitFor` around it — a timing-sensitive pattern that
  can lose a race under the extra scheduling pressure of the full suite,
  independent of anything in items A–I (`host-link.ts` and `App.tsx`, the
  files that test exercises, are not part of this change; `shell.ts`'s only
  edit here is the comment in item F). Not fixed, per "do items A–I and
  nothing else" — flagging per the root `AGENTS.md` instruction to record,
  not silently retry past, a wider-run-only failure.
- Item E's `LineSelect` fix and test are not in the brief's explicit
  red/mutation list (only A, C1, D, G, H are), but a red run was taken
  anyway (see above) since it's a real behavior change, not just a pin.
- No other deviations: every fragment/behavior matched the brief as
  written; nothing in items A–I required a design judgment call beyond
  picking `errors.link.unreachable` over adding a new
  `shell.lineSelect.unreachable` key for item E, which the brief listed as
  the preferred option ("Reuse the existing link text … If no key fits, add
  one") and which fit directly (`errors.link.unreachable` is already the
  neutral "Хост не отвечает." used by `HostStatusLine` for the same
  situation).

## Follow-up (on top of 57717c3a8)

Base for this pass: `57717c3a8` — the coordinator's own flake fix on top of
`899698b82` (`fakeConnection`'s `status`/`revision` now wait for the app's
subscription and are `await`ed; `NetworkPairing`'s two focus effects moved
to `useLayoutEffect`). Re-review found no production defect. Three
test-only items, one new commit, no production file touched (confirmed
after every mutation check below: `git diff --stat` on the production file
was empty each time).

Commit: `a27c7beef` — `test(standalone): итоговое ревью 1c3 — какие отказы
запоминаются, ожидание планировщика, смена месяца`

### 1. `network-pairing.test.tsx` — which refusals item H remembers

Added `refuseManual(onClaim)` (types the address/code, confirms, lets the
claim be refused, then `await waitFor(() => expect(onClaim).toHaveBeenCalledTimes(1))`
before returning — needed so the caller's assertions never race the
rejection; without it the first draft of these tests logged a stray "not
wrapped in act(...)" warning that the pre-existing tests never do) plus two
`it.each` tables on the manual path:

- Positive (`pairing_code_invalid`, `pairing_code_expired`,
  `invalid_response`, `host_changed`, `storage`): after the refusal, a
  second "Далее" with the same code shows the same refusal text again
  without a second `probe.hello` or a second `onClaim` call.
- Negative (`rate_limited`, `unreachable`): a second "Далее" with the same
  code goes through the full flow again — `probe.hello` and `onClaim` both
  reach 2.

**Mutation check 1** — added `"rate_limited"` to `REMEMBER_REFUSAL`, ran only
the negative table, reverted after:

```
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run \
  test/network-pairing.test.tsx -t "does not remember" --reporter=verbose

FAIL  … does not remember a rate_limited refusal: a second submit of the same code probes and claims again
AssertionError: expected "vi.fn()" to be called 2 times, but got 1 times
 ❯ test/network-pairing.test.tsx:410

Test Files  1 failed (1)
     Tests  1 failed | 1 passed | 30 skipped (32)
```

(The `unreachable` case in the same table still passed — only the mutated
code broke.)

**Mutation check 2** — narrowed `REMEMBER_REFUSAL` to
`new Set(["pairing_code_invalid"])`, ran only the positive table, reverted
after:

```
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run \
  test/network-pairing.test.tsx -t "remembers a" --reporter=verbose

Test Files  1 failed (1)
     Tests  4 failed | 1 passed | 27 skipped (32)
```

(`pairing_code_expired`, `invalid_response`, `host_changed` and `storage`
each failed at the "no second call" assertion; `pairing_code_invalid` still
passed, since the mutation kept it.)

Both reverted (`git diff --stat apps/standalone/src/app/NetworkPairing.tsx`
empty each time); full file green again (32/32) after each.

### 2. `app.test.tsx` — scheduler wait for the revision-refresh test

Replaced `await act(async () => {});` with two real `setImmediate` turns and
a comment on why:

```ts
// Two setImmediate turns, not act(async () => {}): a passive effect that
// invalidated queries on every session change would run in a later
// setImmediate task, which only real turns like these wait for.
await new Promise((resolve) => setImmediate(resolve));
await new Promise((resolve) => setImmediate(resolve));
expect(host.getOrg).toHaveBeenCalledTimes(1);
```

(Tried wrapping the two turns in one `await act(async () => { ... })` first,
to see whether it would additionally quiet a pre-existing "not wrapped in
act" warning on this exact test — see Deviations below — but the warning
turned out to already exist on `57717c3a8` unmodified, so kept the literal
form the brief specified rather than deviating for a side effect that
wasn't actually caused by this fix.)

**Mutation check** — added the exact effect from the brief to `Office.tsx`
(`shownSession` ref + `useEffect` invalidating `queryClient` on every
`session` identity change), reverted after:

```
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run \
  test/app.test.tsx -t "reads the signed-in user again when the host announces a revision" --reporter=verbose

FAIL  test/app.test.tsx > App > reads the signed-in user again when the host announces a revision and leaves the open page alone
AssertionError: expected "vi.fn()" to be called 1 times, but got 2 times
 ❯ test/app.test.tsx:879
    877|     await new Promise((resolve) => setImmediate(resolve));
    878|     await new Promise((resolve) => setImmediate(resolve));
    879|     expect(host.getOrg).toHaveBeenCalledTimes(1);

Test Files  1 failed (1)
     Tests  1 failed | 39 skipped (40)
```

Reverted (`git diff --stat apps/standalone/src/office/Office.tsx` empty);
full file green again (40/40).

### 3. `host-status-line.test.tsx` — C1's day check, same day-of-month

Added `shows the date when the last contact was the same day of an earlier
month`: "now" 27 September 09:00, last contact 27 August 14:05 (same
day-of-month, different month) — expects `"Нет связи с хостом с 27.08
14:05"`.

**Mutation check** — narrowed `sameLocalDay` to `a.getDate() === b.getDate()`
(day-of-month only), reverted after:

```
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run \
  test/host-status-line.test.tsx -t "shows the date when the last contact was the same day of an earlier month" --reporter=verbose

FAIL  … shows the date when the last contact was the same day of an earlier month
Unable to find an element with the text: Нет связи с хостом с 27.08 14:05.
(actual: "Нет связи с хостом с 14:05" — the mutated comparison called 27
August "today")

Test Files  1 failed (1)
     Tests  1 failed | 7 skipped (8)
```

Reverted (`git diff --stat apps/standalone/src/app/HostStatusLine.tsx`
empty); full file green again (8/8).

### Verification

```
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run \
  test/network-pairing.test.tsx test/app.test.tsx test/host-status-line.test.tsx --reporter=verbose
Test Files  3 passed (3)
     Tests  80 passed (80)

pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test
Test Files  28 passed (28)
     Tests  484 passed (484)

pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck
$ tsc -p tsconfig.json --noEmit                (clean)

pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint
$ eslint . …                                    (clean)

node_modules/.bin/prettier --check apps/standalone/test/{app,host-status-line,network-pairing}.test.tsx
All matched files use Prettier code style!      (after one --write pass on
                                                  network-pairing.test.tsx;
                                                  reverified clean, tests
                                                  re-run and still 32/32)

git diff --check
(no output, exit 0)

grep -n '\u04' <the three changed files>
(no matches)

git log -1 --format=%B
test(standalone): итоговое ревью 1c3 — какие отказы запоминаются, ожидание планировщика, смена месяца

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

### Deviations

- **Two pre-existing "not wrapped in act(...)" warnings**, both already
  present on `57717c3a8` before this commit (confirmed by running the
  unmodified `git show 57717c3a8:apps/standalone/test/app.test.tsx` filtered
  to each test in isolation): `App > ignores a late answer from a session
the user already left` and `App > reads the signed-in user again when the
host announces a revision and leaves the open page alone` (the exact test
  item 2 touches). Neither is caused by this commit's two-line change —
  swapping it back to the original `await act(async () => {});` reproduces
  the same warning on the same test. Not investigated further or fixed:
  out of scope for "these three items, nothing else," and orthogonal to
  the setImmediate-timing question item 2 actually asks the test to answer
  (which the mutation check above confirms it does).
- No other deviations. All three items match the brief's wording; the
  refusal texts quoted in item 1's tables were read from `ru.json` via the
  already-committed `NetworkPairing.tsx` (`errors.device.*` and
  `shell.networkPairing.errors.*`), not re-typed from memory.
