# Task 2 report — pairing-code shape and machine-readable payload (plan 1c3)

## Status: DONE

Commit: `6217987aa0f0063e6811217247e57da37772b365`
`feat(standalone): вид кода подключения и разбор машиночитаемого кода в вебвью`

## What was implemented

1. `apps/standalone/proto/fixtures/pairing-codes.json` — the shared fixture: 24
   cases pinning `normalizePairingCode` (TypeScript) to
   `markiro_proto::pairing::normalize` (Rust). Extracted byte-for-byte from the
   brief (via `sed`, not retyped) so the `\u` escape sequences for invisible and
   hyphen-lookalike characters are preserved literally, as the brief requires.
2. `apps/standalone/proto/tests/fixtures.rs` — added
   `the_pairing_code_fixture_matches_normalize`, which loads the fixture and
   asserts `markiro_proto::pairing::normalize` answers every case exactly.
3. `apps/standalone/src/host/pairing-code.ts` — new module:
   - `PAIRING_CODE_ALPHABET`, `PAIRING_CODE_LENGTH`;
   - `normalizePairingCode(input): string | null` — the Rust rule rewritten
     (Unicode `White_Space` skipped, ASCII hyphen and the dashes U+2010–U+2015
     and U+2212 skipped, only ASCII letters upper-cased, O→0, I/L→1, result
     must be exactly 10 Crockford base32 symbols);
   - `PairingPayload` interface (`addresses`, `port`, `fingerprint`, `code`);
   - `fromRussianLayout(text): string` — maps ЙЦУКЕН key positions back to US
     keys, position by position;
   - `parsePairingPayload(text): PairingPayload | null` — parses
     `markiro-host:1?h=<a,b>&p=<port>&f=<fingerprint>&c=<code>`, transliterating
     Cyrillic input first, trimming, stripping a leading AIM identifier
     (`]d<digit>`), case-insensitive scheme/field names, validating IPv4
     addresses, port range 1–65535, 64-hex-char fingerprint (lower-cased), and
     the code via `normalizePairingCode`.
4. `apps/standalone/test/pairing-code.test.ts` — new Vitest file (20 tests):
   fixture-driven normalization parity, payload parsing from the host's own
   fixture, Russian-layout typing, Caps Lock, AIM prefix + surrounding spaces,
   empty-address reporting, code normalization inside a payload, and 13
   rejection cases (`it.each`).
5. `apps/standalone/AGENTS.md` — appended the specified paragraph to the end of
   "Local pairing trust", documenting the webview-side check and its pinning to
   the Rust rule via the shared fixture.

All file content for the fixture JSON, the two TypeScript files, and the
AGENTS.md paragraph was extracted verbatim from the brief with `sed` (not
retyped) and diffed byte-for-byte against the brief's source ranges after
creation — all four diffs were empty (see Self-review).

## TDD evidence

### RED — Rust fixture test (sanity check, not a real failure)

The Rust `normalize` rule already existed (plan 1c1); this task only adds a
test that locks the fixture to it. There is no Rust RED phase — the new test
is expected to pass immediately if (and only if) the fixture's expected values
already agree with the existing rule. I ran it right after creating the
fixture and the Rust test, before touching TypeScript, to confirm agreement
(this doubles as the "stop and report if they disagree" check the task calls
for):

Command: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test fixtures --offline`

```
running 20 tests
...
test the_pairing_code_fixture_matches_normalize ... ok
...
test result: ok. 20 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

No disagreement found between the fixture and `markiro_proto::pairing::normalize`
— all 24 cases (verified by manual trace of each Unicode edge case: NEL
U+0085, ideographic space U+3000, line separator U+2028, soft hyphen U+00AD,
zero-width space U+200B, BOM U+FEFF, ß U+00DF, dotless ı U+0131, long s U+017F,
fullwidth ７ U+FF17, double vertical line U+2016) agree with the Rust rule.

### RED — Vitest (real failure: implementation module did not exist yet)

Command: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/pairing-code.test.ts`

```
FAIL  test/pairing-code.test.ts [ test/pairing-code.test.ts ]
Error: Failed to resolve import "../src/host/pairing-code.js" from "test/pairing-code.test.ts". Does the file exist?
...
Test Files  1 failed (1)
     Tests  no tests
```

This was captured with only the fixture, the Rust test addition, and the new
Vitest test file in place — `src/host/pairing-code.ts` did not exist yet.

### GREEN — Vitest, after creating `src/host/pairing-code.ts`

Command: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/pairing-code.test.ts`

```
 Test Files  1 passed (1)
      Tests  20 passed (20)
```

Matches the brief's expectation exactly ("Expected: PASS — 20 тестов").

## Verification commands and results

| Command                                                                                                          | Result                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test fixtures --offline`               | PASS — 20/20 (see RED section above)                                                                       |
| `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline`                               | PASS — 22/22 (2 unit tests in `pairing.rs`, 20 in `fixtures.rs`, 0 doc-tests)                              |
| `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`                                          | PASS — no output, no diff                                                                                  |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/pairing-code.test.ts` | PASS — 20/20                                                                                               |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`                                      | PASS — 23 files, 352 tests (was 22 files / 332 tests per the brief's stated baseline; +1 file / +20 tests) |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`                                 | PASS — `tsc -p tsconfig.json --noEmit`, no errors                                                          |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`                                      | PASS — `eslint .`, no errors                                                                               |
| `node_modules/.bin/prettier --write <5 files>`                                                                   | all reported "unchanged"                                                                                   |
| `node_modules/.bin/prettier --check <5 files>`                                                                   | PASS — "All matched files use Prettier code style!"                                                        |
| `git diff --check`                                                                                               | PASS — exit 0, no whitespace errors                                                                        |

Full Rust output (`rtk proxy cargo test -p markiro-proto --offline`):

```
running 2 tests
test pairing::tests::a_typed_code_is_normalized_like_crockford_decoding ... ok
test pairing::tests::normalize_strips_whitespace_and_unicode_dash_separators ... ok
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

running 20 tests
... (all 20 fixtures.rs tests, including the_pairing_code_fixture_matches_normalize) ... ok
test result: ok. 20 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

Doc-tests markiro_proto
running 0 tests
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

## Files changed

- `apps/standalone/proto/fixtures/pairing-codes.json` (new, 28 lines)
- `apps/standalone/proto/tests/fixtures.rs` (modified, +15 lines: one new test
  appended at the end)
- `apps/standalone/src/host/pairing-code.ts` (new, 105 lines)
- `apps/standalone/test/pairing-code.test.ts` (new, 97 lines)
- `apps/standalone/AGENTS.md` (modified, +8 lines in "Local pairing trust")

Commit diffstat: `5 files changed, 253 insertions(+)`. No other file was
touched; `apps/station` and every other Rust file besides
`proto/tests/fixtures.rs` are untouched (verified via `git status --short`
before commit and `git diff --stat HEAD~1 HEAD` after).

## Deviations

None. The brief's code compiled and passed strict TypeScript
(`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), ESLint, and
Prettier without modification. No fixture case disagreed with the Rust
`normalize` rule, so there was nothing to escalate as NEEDS_CONTEXT. No `any`,
no `!`, no broad casts were needed or used.

## Self-review

- **Verbatim fidelity**: the fixture JSON, both TypeScript files, and the
  AGENTS.md paragraph were extracted from the brief with `sed` line ranges
  rather than retyped, specifically to avoid transcription risk on the
  Unicode escape sequences and the mixed Cyrillic/Latin test data (e.g.
  `TYPED_IN_RUSSIAN`). I then re-diffed each created file against the same
  brief ranges after creation; all four diffs were empty. One real mistake
  happened along the way: my first attempt at the fixture file used the
  `Write` tool with literal Unicode characters instead of the brief's `\u`
  escape sequences (functionally equivalent JSON, since JSON permits both
  forms, but not what the brief specified for reviewability). I caught this
  before running any tests and redid it with `sed` extraction directly from
  the brief file, which produced byte-identical output.
- **Scope**: only the five files the brief lists were staged and committed.
  `apps/station`, `apps/admin`, and every Rust file other than
  `proto/tests/fixtures.rs` are untouched. No new dependency was added; no
  `pnpm install`/`pnpm add` was run; `git stash` was never used.
- **Test count sanity check**: the task's stated baseline (22 files / 332
  tests) plus the new file (20 tests) predicts 23 files / 352 tests, which is
  exactly what the full suite reported — no other test file was accidentally
  affected.
- **Semantic check on the fixture**: I hand-traced every one of the 24 cases
  against Rust's `normalize` (whitespace/dash classification, the O/I/L
  aliases, the ASCII-only upper-casing, and each of the ten "trap" Unicode
  characters meant to catch a naive non-ASCII `.toUpperCase()`/whitespace
  implementation) before running the Rust test, then confirmed the actual
  test run agreed. I did not just trust the brief's text — I independently
  verified the Unicode property classifications (e.g., NEL U+0085 and
  ideographic space U+3000 **are** `White_Space`; soft hyphen U+00AD, ZWSP
  U+200B, and BOM U+FEFF are **not**) against what `char::is_whitespace()`
  and the `is_separator_dash` range actually accept.
- **Known, accepted limitation** (per the brief, not a defect): Caps Lock
  under the Russian layout is not restored by `fromRussianLayout` — it only
  remaps the ЙЦУКЕН letter positions, not the punctuation keys (`:`, `.`, `,`)
  that swap places under Russian Caps Lock. The brief explicitly scopes this
  out ("остаётся ручной ввод"), so no code handles it and no test exercises
  it.
- **Nothing left half-done**: all six of the brief's steps were completed in
  order (fixture + failing tests, run and observe RED, implementation, run
  and observe GREEN, docs, final gates and commit). No TODO or stub was left
  in the new code.

## Fix round 1

Commit: `0c9e6d8fe7a78aa9457051ef7e32123605e49f6f`
`fix(standalone): ревью задачи 2 плана 1c3 — сканер с Caps Lock и AIM, полный алфавит в фикстуре`

The reviewer did an exhaustive pass (every Unicode code point against Rust, the
full ЙЦУКЕН rows) and found two real scanner-parsing bugs, one fixture gap that
let the alphabet silently shrink, one real IPv4 gap, and several test-coverage
and consistency nits. All six numbered items were addressed; every existing
assertion from the initial commit still holds (verified below).

### Item 1 — Caps Lock + AIM prefix (`]D1`) was refused

**Bug**: `parsePairingPayload`'s AIM-prefix strip at the old line 82
(`typed.replace(/^\]d\d/, "")`) only matched a lowercase `d`. A scanner with
Caps Lock on (US layout) sends `]D1` (uppercase D comes from the same
unshifted letter key, inverted by Caps Lock), which the old regex left
attached to the front of the scheme, breaking the `"markiro-host:1"` match.

**Fix**: the prefix-strip regex in the new `parseTyped` helper is
`/^\][dD]\d/` (`apps/standalone/src/host/pairing-code.ts:109`).

**Test added**: `test/pairing-code.test.ts` — `"drops an upper-case AIM
identifier typed with Caps Lock on"`, asserting that parsing `]D1` prepended
to the Caps-Lock payload equals `PARSED`. `CAPS_LOCK` was hoisted from an
inline `const` in the existing Caps-Lock test to a shared top-level constant
(pure rename, both tests use it now, no behavior change).

### Item 2 — the shared fixture didn't pin the full alphabet

**Gap**: the 24 original cases' accepted outputs used only 12 of the 32
Crockford symbols; dropping a symbol from `PAIRING_CODE_ALPHABET` (e.g. by a
future typo) would have left both suites green.

**Fix**: added the reviewer's 7 example cases to
`proto/fixtures/pairing-codes.json` — `"0123456789"`, `"ABCDEFGHJK"`,
`"abcdefghjk"`, `"MNPQRSTVWX"`, `"mnpqrstvwx"`, `"YZ45678000"`,
`"yz45678000"` — each verbatim with its normalized output, covering all 22
non-alias letters and all 10 digits in both cases. Raised the pinned count
from 24 to 31 in both `proto/tests/fixtures.rs` and
`test/pairing-code.test.ts`.

**Optional nit applied**: replaced the ß case's input from `"ß7K3MQ9XV2"`
(ß + 9 symbols, 10 total) with `"ß7K3MQ9XV"` (ß + 8 symbols, 9 total), so it
would catch a regression to a whole-string `toUpperCase()` (which turns "ß"
into "SS", i.e. 2 characters instead of 1). With the old 10-total-character
input, a buggy whole-string-uppercase implementation would expand it to
"SS" + 9 symbols = 11 characters, which still fails the length check and
returns `null` — the same answer as the correct implementation, so that case
could never have caught this specific regression. With the new 9-total
input, the same buggy implementation expands it to "SS" + 8 symbols = exactly
10 characters, all of them valid alphabet symbols ("S" is a real Crockford
symbol) — a false accept the correct per-character implementation still
correctly rejects (it returns `null` immediately on the non-ASCII ß, before
ever looking at the rest of the string). Verified: all 31 cases match
`markiro_proto::pairing::normalize` (Rust test run below), so this is a
coverage improvement, not a behavior change.

### Item 3 — IPv4 octets with a leading zero were accepted

**Bug**: `IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/` accepted
`"010.0.0.5"` and returned it unchanged, unlike Rust's `Ipv4Addr::from_str`
(which rejects leading zeros) and unlike how a URL parser would read `010` as
octal.

**RED** (`pnpm ... exec vitest run test/pairing-code.test.ts`, before the fix,
with only the test added):

```
FAIL  test/pairing-code.test.ts > pairing payload > refuses an address with a leading zero
AssertionError: expected { …(4) } to be null
+ Received:
{ "addresses": ["010.0.0.5", "192.168.1.10"], "code": "7K3MQ9XV2D", "fingerprint": "ab...ab", "port": 45710 }
```

**Fix**: `IPV4 = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/`
(`apps/standalone/src/host/pairing-code.ts:68`) — each octet is either a bare
`0` or a non-zero-leading 1-3 digit number; `isIpv4`'s existing `<= 255` check
is kept (the regex alone still allows syntactic 256-999).

**GREEN**: same test, after the fix, passes (see full-suite run below).

**Tests added**: the refusal case `["an address with a leading zero",
PAYLOAD.replace("10.0.0.5", "010.0.0.5")]` in the `it.each` table, and a
companion positive test `"accepts an address that is all zeros, unlike one
with a leading zero"` asserting `0.0.0.0` still parses (proving the fix
didn't also reject bare-zero octets).

### Item 4 — Russian layout + Caps Lock is now recovered

**Gap** (by original design, not a regression): Caps Lock under the Russian
layout inverts the case of every Cyrillic letter key, including the three
that type `,`, `.` and `:`/`;` on the US layout (they are genuine Cyrillic
letters — б, ю and ж/Ж — so Caps Lock affects them like any other letter).
The original `parsePairingPayload` mapped the scan once and never retried, so
a Caps-Lock-affected Russian scan (which maps to a scheme with `;` instead of
`:`) was refused.

**RED** (before the fix, with only the test added):

```
FAIL  test/pairing-code.test.ts > pairing payload > reads a payload typed under the Russian layout with Caps Lock on
AssertionError: expected null to deeply equal { …(4) }
```

**Fix**: split `parsePairingPayload` into a dispatcher and a `parseTyped`
helper (`apps/standalone/src/host/pairing-code.ts:100-105`). For Cyrillic
input, it tries `fromRussianLayout(text)` first; if that doesn't parse, it
retries once with `withCyrillicCaseSwapped(text)` (new private helper,
lines 84-90) mapped through `fromRussianLayout` again. `withCyrillicCaseSwapped`
inverts the case of every character in the Cyrillic Unicode block and leaves
everything else (digits, `-`, `=`, the shifted digit-row symbols like `?`/`&`)
unchanged, mirroring exactly what Caps Lock does to a physical keyboard scan.
Per the reviewer's note, the two variants can never both parse, because the
`:`-vs-`;` scheme separator is the one place a case-flip changes which literal
character comes out (the scheme comparison already lower-cases everything
else), so trying "plain first, swapped second" is unambiguous and safe.

**GREEN**: same test, after the fix, passes (see full-suite run below).

**Test added**: `"reads a payload typed under the Russian layout with Caps
Lock on"`, using a new test-local `flipCyrillicCase` helper (built
independently from the implementation's `withCyrillicCaseSwapped`, using a
plain `/[а-яё]/i` test and per-character `toUpperCase`/`toLowerCase`) applied
to the already-verified `TYPED_IN_RUSSIAN` constant, so the test doesn't
share code with the fix it's checking, only the physical-keyboard model both
independently implement.

**Module comment updated**: `parsePairingPayload`'s doc comment
(`pairing-code.ts:92-99`) no longer lists "the Russian layout" and "Caps
Lock" as if they were mutually exclusive; it now says Caps Lock is included
under the Russian layout too, recovered by the retry, in addition to Caps
Lock under the US layout. `AGENTS.md`'s "Local pairing trust" paragraph (added
in the initial commit) was reviewed and left unchanged: it only says the
webview reads "a payload a keyboard-wedge scanner typed under the Russian
layout," which remains true and doesn't claim Caps Lock is unhandled, so no
wording there was stale.

### Item 5 — test gaps

- Added `"maps the full Russian digit and letter rows to their US positions"`
  pinning the two full-row assertions the reviewer gave verbatim: the digit
  row plus one letter row (`fromRussianLayout("ё1234567890-=йцукенгшщзхъ\\фывапролджэячсмитьбю.")` → ``"`1234567890-=qwertyuiop[]\\asdfghjkl;'zxcvbnm,./"``)
  and its shifted counterpart. Both assertions passed on the first run
  (existing `fromRussianLayout` table was already correct; this closes a
  coverage gap, not a bug).
- Renamed the refusal case `"a field without a value"` to `"a field without
="`, matching what `${PAYLOAD}&x` actually exercises (a field with no `=`
  at all, not merely an empty value).

### Item 6 — one alphabet in the webview

`src/host/protocol.ts`'s `pairingCodeSchema.code` regex was hand-written as
`/^[0-9A-HJKMNP-TV-Z]{10}$/`, a second, independent transcription of the same
32-symbol Crockford alphabet already defined in `pairing-code.ts` (verified by
hand that the two character classes denote the identical 32 symbols before
touching anything).

**Chosen direction**: `protocol.ts` now imports `PAIRING_CODE_ALPHABET` and
`PAIRING_CODE_LENGTH` from `./pairing-code.js` and builds the regex as
`new RegExp(\`^[${PAIRING_CODE_ALPHABET}]{${PAIRING_CODE_LENGTH}}$\`)`. This
is the direction that stays acyclic: `pairing-code.ts`had zero imports
before this change and still has zero after it, so it qualifies as "the
module with no dependencies" the task described;`protocol.ts` already
depended on nothing that could depend back on it. I did not add a
regex-vs-constant agreement test, since building the regex from the constant
makes such a test redundant (there is only one alphabet now, not two to
compare). Confirmed no other source file depends on the old hand-written
pattern (`grep -rn "0-9A-HJKMNP-TV-Z" apps/standalone/src apps/standalone/test
apps/standalone/proto packages/`— no hits outside the gitignored`apps/standalone/dist` build artifact).

### Full verification (fix round 1)

| Command                                                                                                                                                                      | Result                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `pnpm ... exec vitest run test/pairing-code.test.ts` (RED, before fixing items 1/3/4)                                                                                        | 3 failed, 21 passed — exactly the 3 new bug-reproducing assertions failed                                                     |
| `pnpm ... exec vitest run test/pairing-code.test.ts` (GREEN, after fixing items 1/3/4)                                                                                       | 24/24 passed                                                                                                                  |
| `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test fixtures --offline -- the_pairing_code_fixture_matches_normalize` (after raising to 31 cases) | 1/1 passed (19 filtered out) — all 31 cases agree with `normalize`                                                            |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/pairing-code.test.ts test/protocol.test.ts`                                       | 73/73 passed                                                                                                                  |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`                                                                                             | clean, no errors                                                                                                              |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`                                                                                                  | clean, no errors                                                                                                              |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`                                                                                                  | 357/357 passed across 23 files (was 352; +5 new tests)                                                                        |
| `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline`                                                                                           | 22/22 passed (2 unit + 20 fixtures + 0 doc-tests; fixture test count unchanged, only its assertion's expected length changed) |
| `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`                                                                                                      | clean, no diff                                                                                                                |
| `node_modules/.bin/prettier --check` on the 4 changed TS/JSON files                                                                                                          | "All matched files use Prettier code style!"                                                                                  |
| `git diff --check`                                                                                                                                                           | exit 0, no whitespace errors                                                                                                  |

### Files changed (fix round 1)

- `apps/standalone/proto/fixtures/pairing-codes.json` (+9/-1: 7 new accepted
  cases, 1 case's input shortened by one symbol)
- `apps/standalone/proto/tests/fixtures.rs` (+1/-1: pinned count 24 → 31)
- `apps/standalone/src/host/pairing-code.ts` (+37/-6: leading-zero-aware
  `IPV4`, new `withCyrillicCaseSwapped`, `parsePairingPayload` split into a
  dispatcher + `parseTyped`, case-insensitive AIM prefix, updated doc comment)
- `apps/standalone/src/host/protocol.ts` (+3/-1: `pairingCodeSchema`'s regex
  built from `pairing-code.ts`'s constants)
- `apps/standalone/test/pairing-code.test.ts` (+52/-4: hoisted `CAPS_LOCK`,
  new `flipCyrillicCase` test helper, 5 new tests, 1 renamed case, is now
  25 `it`/`it.each`-row assertions plus the fixture-driven loop)

`apps/standalone/AGENTS.md` was reviewed and intentionally left unchanged
(see Item 4). No file outside the reviewer's listed scope was touched.

### Deviations (fix round 1)

None from the reviewer's numbered instructions. One process note: while
composing two of the new doc comments in `pairing-code.ts`, I typed three
Cyrillic letters and an em dash directly as part of the edit, intending them
to appear as ordinary readable characters. Checking with `od -c` afterward
showed they had instead landed as literal 6- and 7-character `\uXXXX`
escape-sequence _text_ in the comment — harmless to compilation (comments
aren't parsed for escapes) but it would have shown as garbled backslash-u
text in a normal editor instead of the intended letters. I caught this by
checking raw bytes (the same discipline from the initial commit's fixture
mistake) and rewrote both comments in plain ASCII, describing the letters by
the punctuation they type rather than naming them, which reads at least as
clearly and removes the encoding risk entirely. The test-file comment and the
two full-keyboard-row test strings, by contrast, verified as correct (real
UTF-8 bytes, or functionally correct inside string literals where `\u`
escapes and literal characters are equivalent) — I don't have a reliable rule
for predicting which way a given edit will land, so I verified each
non-ASCII edit individually with `od -c` rather than trusting the rendered
diff.

### Self-review (fix round 1)

- Every existing assertion from the initial commit still passes unmodified
  in behavior; the only pre-existing test line touched was the rename
  (`"a field without a value"` → `"a field without ="`, same input, same
  expectation) and the `capsLock` → `CAPS_LOCK` hoist (same literal value,
  now shared).
- RED was captured for exactly items 1, 3 and 4, each showing the specific
  bug (wrong prefix case, accepted leading zero, unrecovered Caps-Lock scan)
  before any implementation change, with the other 21 pre-existing/added
  tests staying green in the same run — confirming the new tests were
  correctly isolated to the reported bugs.
- Item 2's new fixture cases and item 5's row-pinning test were verified
  against the real Rust `normalize` and the real `fromRussianLayout` rather
  than assumed: the Rust fixture test was re-run after raising the pin to 31
  cases (all pass), and the keyboard-row test passed on its first run against
  the untouched `fromRussianLayout` table.
- Scope held exactly to the reviewer's file list
  (`src/host/pairing-code.ts`, `src/host/protocol.ts`,
  `test/pairing-code.test.ts`, `proto/fixtures/pairing-codes.json`,
  `proto/tests/fixtures.rs`'s case count); `AGENTS.md` was considered and
  deliberately left as-is with a stated reason, not silently skipped.
- No new dependency, no `pnpm install`/`add`, no `git stash`, one new commit
  on top of the initial one (not amended).
