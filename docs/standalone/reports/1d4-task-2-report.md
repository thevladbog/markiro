# Plan 1d4, Task 2 report: wire layer for operators and badges

Status: DONE_WITH_CONCERNS (one concern, about `badgeSaltSchema`; see "Issues and concerns").
Commit `d2e241891 feat(standalone): провод офиса для операторов и бейджей`
(branch `claude/autonomous-desktop-station-9e6f13`, on top of `8493a2edc`; not pushed).

## What I implemented

Everything in the brief, in its step order, applied from the brief's own text: a scratch script (kept in
`$TMPDIR/t2`, outside the repo) reads the brief's code blocks and applies each «фрагмент … заменить на …»
with an exactly-once assertion (nothing is written if any anchor fails), so nothing was retyped.
`test/protocol.test.ts` was written from the brief's block and then compared to the brief's own line range
(`sed -n '26,361p'`) with `cmp`: byte-identical.

- `src/host/protocol.ts`: `badgeInfoSchema`/`BadgeInfo`, `officeOperatorSchema`/`OfficeOperator`,
  `badgeSaltSchema`/`BadgeSalt` (non-strict responses); `operatorCreateSchema`/`OperatorCreate`,
  `operatorUpdateSchema`/`OperatorUpdate`, `badgeCreateSchema`/`BadgeCreate` (`.strict()` bodies).
- `src/host/requests.ts`: `OperatorInput` + `operatorCreate`, `OperatorChange` + `operatorUpdate`
  (only the fields that differ from the loaded operator, `pinPhc` always when passed, `expectedRev` always),
  `BadgeInput` + `badgeCreate`; each names every field, no spread.
- `src/host/api.ts`: `HostApi.listOperators`, `createOperator`, `updateOperator`, `createBadge` (answers
  `BadgeInfo`), `revokeBadge` (`DELETE`, 204 read by the existing `NO_CONTENT`, resolves `void`), `getBadgeSalt`.
- `test/support/office.tsx`: six `vi.fn` fakes whose default is `unexpected(...)`.
- `test/protocol.test.ts` (whole file) and `test/api.test.ts` (three fragments): five fixtures
  (`office-operator`, `badge-salt` as responses; `operator-create`, `operator-update`, `badge-create` as requests)
  are parsed by their schema and the three request ones are produced exactly (`toStrictEqual`) by their builder;
  six `HostApi` route cases; the "names only the operator fields that differ" test.
- Step 6 (docs): none, as the brief says (the «Protocol» rule and spec §4.5 already cover this).

Nothing changed under `apps/station`, `apps/standalone/proto|host|src-tauri` or any Rust file; the fixtures are
untouched; no dependency added; no `pnpm install`/`add`; no stash; no push; no new branch.

Cross-check against the host (read-only, nothing contradicted the brief): the Rust `proto` types
(`BadgeInfo`, `OfficeOperator`, `OperatorCreate`, `OperatorUpdate`, `BadgeCreate`, `BadgeSalt`) have exactly the
Zod field names, `deny_unknown_fields` on the four request types, and `role` as the only double-optional field;
`host/src/server.rs` registers `GET|POST /v1/office/operators`, `PUT /v1/office/operators/{id}`,
`POST /v1/office/operators/{id}/badges`, `DELETE /v1/office/operators/{id}/badges/{badge_id}` and
`GET /v1/office/badge-salt`, the same paths and methods `api.ts` uses; `HttpMethod` already includes `DELETE`.

## Anchors

All 14 «фрагмент» anchors (3 in Step 1, all in `api.test.ts`; 11 in Step 3) matched exactly once against
HEAD `8493a2edc`, checked with a dry run before writing anything. The two mutation fragments matched when
their mutation was applied (they describe the code after Step 3). Nothing was improvised.

## Baseline

`pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test` before any edit:
34 files / 664 tests passed; stderr only `$ vitest run`. This is the controller's number.

## TDD evidence

### RED (Step 2)

Command: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts test/api.test.ts`
(stdout and stderr to separate files; exit 1; vitest writes failure details to stderr).

    Test Files  2 failed (2)
         Tests  13 failed | 71 passed (84)

- `test/api.test.ts` does not load: `TypeError: Cannot read properties of undefined (reading 'parse')` at
  `test/api.test.ts:57` (`officeOperatorSchema.parse(...)`, the new schemas do not exist yet).
- `test/protocol.test.ts`: 13 of 84 fail, exactly the brief's split:
  - `response fixture office-operator.json` and `badge-salt.json`, "parses without losing a field"
    (`reading 'parse'`) and "tolerates a field added by a newer host" (`reading 'safeParse'`): 4;
  - `request fixture operator-create.json`, `operator-update.json`, `badge-create.json`, "parses without
    losing a field" (`reading 'parse'`) and "rejects an unknown field, like the host" (`reading 'safeParse'`): 6;
  - "request builders produce their fixtures exactly": "an operator to create, and one to update that clears
    the role, turns off and gets a new PIN" (`operatorCreateSchema` undefined) and "a badge to add"
    (`badgeCreateSchema` undefined): 2;
  - "request builders send only what changes > names only the operator fields that differ…":
    `TypeError: operatorUpdate is not a function`: 1.
- Expected: the schemas, builders and methods did not exist; no other test failed (71 passed).

### GREEN (Step 4)

Same command after Step 3 (exit 0, stderr empty):

    Test Files  2 passed (2)
         Tests  114 passed (114)

With `--reporter=verbose`: 84 `protocol.test.ts` + 30 `api.test.ts` = 114, stderr 0 bytes; the six new API
cases (`listOperators`, `createOperator`, `updateOperator`, `createBadge`, `revokeBadge`, `getBadgeSalt`
"sends the office token to the right route") and the 13 tests that failed in RED all pass. Rerun once more on the
committed state through `rtk proxy` (raw output, no wrapper trimming): same 114, stderr 0 bytes.

## Mutation evidence

Each: `shasum -a 256` before, a copy of the file, the scratch edit (fragments cut from the brief), the named
command, the reverse edit, `shasum -a 256` after, `cmp` against the copy.

### Mutation 1: `requests.ts` sends the role always

`if (next.role !== undefined && next.role !== operator.role) update.role = next.role;` became
`if (next.role !== undefined) update.role = next.role;`

Command: `... exec vitest run test/protocol.test.ts -t "names only the operator fields"` (exit 1):

    FAIL  test/protocol.test.ts > request builders send only what changes > names only the operator fields
          that differ, clears a role with null and always sends a new PIN
    AssertionError: expected { expectedRev: 55, role: 'Упаковщик' } to strictly equal { expectedRev: 55 }
    Tests  1 failed | 83 skipped (84)

Revert: sha256 before `8620d8f73faf3ad1f9352c6cd47b28b4ba816db38cd092317a9261ae710c817a`, after the same;
`cmp` against the pre-mutation copy: byte-identical.

### Mutation 2: `protocol.ts` drops `.strict()` from the new operator body

Command: `... exec vitest run test/protocol.test.ts -t "operator-create.json"` (exit 1):

    FAIL  test/protocol.test.ts > request fixture operator-create.json > rejects an unknown field, like the host
    AssertionError: expected true to be false // Object.is equality
    Tests  1 failed | 1 passed | 82 skipped (84)

Revert: sha256 before `a7c7df6ebc0e6875bbc24306ffc7bdcc53c5f988e5f51e84e845d361d6348f53`, after the same;
`cmp` against the pre-mutation copy: byte-identical. Neither mutation was committed; `git status` was clean
afterwards except for the six intended files.

## Checks (Step 7), all from the repository root, no `cd`

| Check                                                                                                                           | Result                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`                                                     | 34 files / 683 tests passed (664 + 19, the brief's number); stderr only `$ vitest run`; rerun through `rtk proxy` with the same result and no `act(...)`/Warning/Error text in stdout or stderr |
| `... typecheck`                                                                                                                 | exit 0                                                                                                                                                                                          |
| `... lint`                                                                                                                      | exit 0                                                                                                                                                                                          |
| `... build`                                                                                                                     | exit 0 (Vite's chunk-size warning is about the existing `PairingDataMatrix` and main chunks)                                                                                                    |
| `node_modules/.bin/prettier --check` on the six files                                                                           | all formatted                                                                                                                                                                                   |
| `grep -rnF '\u04' apps/standalone/src apps/standalone/test`                                                                     | only `src/host/pairing-code.ts:66`                                                                                                                                                              |
| `git diff --check` (and `--cached`)                                                                                             | clean                                                                                                                                                                                           |
| Changed test files with `--reporter=verbose`                                                                                    | 114 tests, stderr 0 bytes                                                                                                                                                                       |
| Same two files under the delayed-`setImmediate` stand (two temp files created exactly as in the plan, run, deleted before lint) | 114 passed, stderr 0 bytes; both temp files removed, `git status` showed only the six files                                                                                                     |

Not exercised by this task (and not claimed): the Rust workspace (no Rust file changed), a browser, Windows.
`graphify update .` was not run: this worktree has no `graphify-out/graph.json`.

## Files changed (6, 293 insertions, 0 deletions)

- `apps/standalone/src/host/protocol.ts` (+60)
- `apps/standalone/src/host/requests.ts` (+69)
- `apps/standalone/src/host/api.ts` (+52)
- `apps/standalone/test/support/office.tsx` (+6)
- `apps/standalone/test/protocol.test.ts` (+57; whole-file replacement, the old content is a subset)
- `apps/standalone/test/api.test.ts` (+49)

Commit message: the brief's subject, a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`;
`git log -1 --format=%B | grep -c Co-Authored-By` prints 1, and the raw commit object shows nothing else after it.
Explicit paths were staged; no `git add -A`.

## Self-review

- Completeness: every brief step ran in order (RED, implementation, GREEN, both mutations shown failing and
  reverted with proof, docs step: none, checks, commit). All 14 anchors applied; the whole-file replacement is
  byte-identical to the brief.
- Quality: builders name every field and never spread; response schemas are non-strict `z.object`, bodies
  `.strict()`; ids appear only in paths; `revokeBadge` reuses `NO_CONTENT`; fakes default to `unexpected()`;
  `import type` and function-typed `HostApi` members follow the file's existing pattern. No duplication added.
- Discipline: nothing beyond the brief. The temporary files (a salt probe test, the delay stand) were created
  and removed inside the same command sequence; my scratch scripts live only in `$TMPDIR/t2`.
- Testing: output is pristine (raw stderr empty on every passing run).

## Issues and concerns

### `badgeSaltSchema` does not guarantee a canonical 16-byte salt (the point the controller asked about)

The brief's schema is `z.object({ badgeSalt: z.base64().length(24) })`. I applied it as written and did not
change it. It accepts the fixture, but it also accepts strings the host refuses. `hashBadge` embeds the salt
verbatim, and the host's `secrets::parse_phc` → `decode_canonical` requires standard base64 that re-encodes to
the same text and holds exactly 16 bytes, so a badge hash under any of these salts would be refused as
`validation_failed` (`badgePhc`). Measured with the real exported `badgeSaltSchema` (temporary probe test,
removed) against a Node mirror of `decode_canonical` (`Buffer` decode gives 16 bytes and re-encodes to the same text):

    schema ACCEPTS | host accepts  | 24 chars | fixture badge-salt.json (canonical 16 bytes)
    schema ACCEPTS | host REFUSES | 24 chars | 24 chars, no padding = 18 bytes          (AAECAwQFBgcICQoLDA0ODwAB)
    schema ACCEPTS | host REFUSES | 24 chars | 24 chars of A, no padding = 18 bytes     (AAAAAAAAAAAAAAAAAAAAAAAA)
    schema ACCEPTS | host REFUSES | 24 chars | 23 chars + one '=' = 17 bytes            (AAECAwQFBgcICQoLDA0ODwA=)
    schema ACCEPTS | host REFUSES | 24 chars | 16 bytes, non-canonical trailing bits   (AAECAwQFBgcICQoLDA0ODx==)
    schema ACCEPTS | host REFUSES | 24 chars | 16 bytes, non-canonical trailing bits   (AAAAAAAAAAAAAAAAAAAAAB==)
    schema rejects | host REFUSES | 24 chars | url-safe alphabet '-'
    schema rejects | host REFUSES | 16 chars | too short
    schema rejects | host REFUSES | 28 chars | too long (20 bytes)

Why: Zod 4.4.3's base64 regex is `^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$`
and does not check the padding shape, the decoded length or the trailing bits; a length of 24 is also reached by
six unpadded groups (18 bytes) or 23 characters plus `=` (17 bytes). Only the 22 characters plus `==` shape
holds 16 bytes, and only when the 22nd character is one of `A Q g w` (its low four bits are zero).

Practical impact is small, because the host generates the salt itself and always answers a canonical one; it
matters only for a malformed answer, which would pass the wire layer and then fail later, in the badge dialog, as
a host `validation_failed` under the code field instead of an `invalid_response` at the wire. The same
expression already stands in `siteRecordSchema.badgeSalt` (feed record, before this task), which Task 6 makes
strict, and no test in this task pins the salt's shape beyond the fixture and the "extra field" case.

Suggested replacement, not applied: `z.object({ badgeSalt: z.string().regex(/^[A-Za-z0-9+/]{21}[AQgw]==$/) })`.
I checked it against the host's rule on 600 000 random strings (200 000 canonical encodings of random 16-byte
values plus 400 000 strings in every padding shape and with the last character on and just off the canonical
set): 0 mismatches. It still parses `badge-salt.json` (`AAECAwQFBgcICQoLDA0ODw==`, last data char `w`), so the
brief's tests would keep passing; a negative test for the three refused shapes would go with it. Decision for the
controller: apply it here, in Task 6 together with `siteRecordSchema`, or leave it.

### Nothing else in the brief looked odd

Counts matched everywhere: 13 RED failures of 84, 114 GREEN (84 + 30), 683 in the full run over 34 files. The
baseline (664) was as stated. One environment note: the local `rtk` wrapper swallowed `console.log` output in a
vitest run (a probe that printed to the console showed nothing), so the probe wrote its table to a file, and the
"stderr is empty" claims were re-checked through `rtk proxy`.

# Fix round 1: `badgeSaltSchema` takes only a canonical 16-byte salt

Status: DONE. Commit `b55afa9fd fix(standalone): ревью задачи 2 плана 1d4 — соль бейджей только каноническая (16 байт, base64 с выравниванием)`
(on top of `d2e241891`; two files, +97 -1; not pushed). The subject is byte-equal to the coordinator's text and
`git log -1 --format=%B` shows `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` exactly once.

## What changed

- `src/host/protocol.ts`: a named export `canonicalSaltSchema = z.string().regex(/^[A-Za-z0-9+/]{21}[AQgw]==$/)`
  with a doc comment, right before `badgeSaltSchema`, which is now `z.object({ badgeSalt: canonicalSaltSchema })`.
  `siteRecordSchema` is not touched (its `badgeSalt: z.base64().length(24)` is still on line 159), so Task 6's
  three anchors on `protocol.ts` (the file head, `OrgRecord` to `siteRecordSchema`, `lineRecordSchema` to
  `officeUserSchema`) still match: a dry run of Task 6's whole Step 3 against this commit (the anchor-applying
  script, nothing written) finds every anchor of the step exactly once.
- `test/protocol.test.ts` (+85 lines): 22 new tests, the same 11 for each of two entry points (`badgeSaltSchema` and
  `canonicalSaltSchema`, via `describe.each`), so both the wiring and the constant are pinned:
  - takes the fixture's salt and a canonical salt with `+` and `/` in its text;
  - refuses, each also checked against the reference: 24 characters without padding (18 bytes), 23 characters and
    one `=` (17 bytes), `AAECAwQFBgcICQoLDA0ODx==` (non-canonical trailing bits), a `-` where the standard
    alphabet has a `+`, a `_` where it has a `/` (both derived from one named canonical salt), 15 bytes, 32 bytes, an
    empty string;
  - a truth table over all 64 characters as the last data character: exactly `A`, `Q`, `g`, `w` are taken, and
    every one of the 64 agrees with the reference;
  - 200 random 16-byte salts (`crypto.getRandomValues`, `btoa`) are all taken, and each with its last data
    character replaced by one outside `A Q g w` (all 60 in rotation) is refused; every assertion carries the salt
    as its message, so a failure names the input.
    The reference `isCanonicalSalt` restates the host's `decode_canonical`: `atob` decodes to exactly 16 bytes and
    `btoa` gives the same text back (`atob` throws on `-`/`_`).
- Docs: `apps/standalone/AGENTS.md` has no sentence that names the salt schema or its check (its salt sentences are
  about the host's `parse_phc` and `hashBadge`, and stay true), so it is unchanged.

Correction to the instruction's wording, not to its rule: the coordinator's text says the last data character
"carries 4 bits so its low 2 bits are zero (A, Q, g, w)". For 16 bytes it is the other way round: 22 characters
hold 132 bits for 128 of data, so the last one carries 2 data bits and its low 4 bits are zero, alphabet positions
0, 16, 32, 48 = `A`, `Q`, `g`, `w`. "Low 2 bits zero" would be 16 characters (`AEIMQUYcgkosw048`) and is the
17-byte case. The doc comment in `protocol.ts` and the comments in the test say 2 and 4; the regex is as specified.

## TDD evidence

### RED (tests first, old schema, constant not yet there)

`pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts`
(through `rtk proxy`, exit 1): `Tests  16 failed | 90 passed (106)`.

- `badgeSaltSchema` entry, 5 assertion failures, because the old `z.base64().length(24)` accepts the input:
  - `refuses 24 characters without padding (18 bytes)`: `AAECAwQFBgcICQoLDA0ODxAR: expected true to be false`
  - `refuses 23 characters and one = (17 bytes)`: `AAECAwQFBgcICQoLDA0ODxA=: expected true to be false`
  - `refuses a last data character with stray bits (x for w)`: `AAECAwQFBgcICQoLDA0ODx==: expected true to be false`
  - `takes A, Q, g and w as the last data character and no other`:
    `expected [ 'A', 'B', 'C', 'D', 'E', 'F', …(58) ] to strictly equal [ 'A', 'Q', 'g', 'w' ]`
  - `agrees with the reference on 200 random salts…`: `5z/5dNXFdiPvsYW9FA2UGB==: expected true to be false`
- `canonicalSaltSchema` entry, 11 failures: `TypeError: Cannot read properties of undefined (reading 'safeParse')`,
  because the constant does not exist yet (expected).
- The 90 passes are the 84 earlier tests and 6 new ones the old schema also satisfies (fixture, both URL-safe
  rows, 15 bytes, 32 bytes, empty).

### GREEN

Same file plus `test/api.test.ts` after the fix (exit 0, stderr 0 bytes): `Test Files 2 passed`,
`Tests 136 passed (136)` = 106 in `protocol.test.ts` (84 + 22) + 30 in `api.test.ts` (the `getBadgeSalt` case still
parses `badge-salt.json`).

## Mutation evidence

`protocol.ts` sha256 `475fafc1eab243c9b13525c3066b3a9f9943f05de0e6efff92ebf1c5ba5d6a3f`; each mutation was applied
with an exactly-once edit, run on the whole `test/protocol.test.ts`, and reverted with the reverse edit.

### Mutation A (the requested one): `export const canonicalSaltSchema = z.base64().length(24);`

`Tests  10 failed | 96 passed (106)`: for each of the two entry points, the five tests the old schema fails in RED
(`refuses 24 characters without padding (18 bytes)`, `refuses 23 characters and one = (17 bytes)`,
`refuses a last data character with stray bits (x for w)`, `takes A, Q, g and w … and no other`,
`agrees with the reference on 200 random salts…`), with the same messages as in RED, for example
`AAECAwQFBgcICQoLDA0ODxAR: expected true to be false`. The URL-safe, wrong-length and fixture tests, and all earlier
tests, stay green (those inputs are refused by `z.base64().length(24)` too). Revert: sha256 after
`475fafc1eab243c9b13525c3066b3a9f9943f05de0e6efff92ebf1c5ba5d6a3f` (equal), `cmp` against the pre-mutation copy:
byte-identical.

### Mutation B (wiring): `export const badgeSaltSchema = z.object({ badgeSalt: z.base64().length(24) });`

`Tests  5 failed | 101 passed (106)`: only the five `badgeSaltSchema …` tests fail; the whole `canonicalSaltSchema`
block stays green, so the response schema's use of the constant is pinned separately from the constant itself.
Revert: sha256 equal, `cmp` byte-identical.

Both mutations and GREEN were first run on a version of the test file whose two URL-safe rows were hand-typed
literals; I then derived them from one named salt (`SALT_WITH_PLUS_AND_SLASH.replaceAll(...)`, the same strings),
reworded one comment and one test title, and re-ran GREEN and both mutations on the final file: same results
(136 passed; 10 failed | 96 passed; 5 failed | 101 passed) and byte-identical reverts. The evidence above is for the
committed file.

## Checks, all from the repository root, no `cd`

| Check                                                                                                                        | Result                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`                                                  | 34 files / 705 tests passed (683 + 22); stderr only `$ vitest run`; no `act(...)`/Warning/Error text in stdout or stderr; run through `rtk proxy` |
| `... typecheck`, `... lint`, `... build`                                                                                     | exit 0 each (Vite's chunk-size warning is the existing one)                                                                                       |
| `node_modules/.bin/prettier --check` on `protocol.ts` and `protocol.test.ts`                                                 | all formatted                                                                                                                                     |
| `grep -rnF '\u04' apps/standalone/src apps/standalone/test`                                                                  | only `src/host/pairing-code.ts:66`                                                                                                                |
| `git diff --check`                                                                                                           | clean                                                                                                                                             |
| `test/protocol.test.ts` with `--reporter=verbose`                                                                            | 106 tests (22 new), stderr 0 bytes                                                                                                                |
| `test/protocol.test.ts` under the 3 ms delayed-`setImmediate` stand (temp files created as in the plan, deleted before lint) | 106 passed, stderr 0 bytes; both temp files removed, `git status` showed only the two files                                                       |

Nothing under `apps/station`, `proto`, `host`, `src-tauri` or any Rust file changed; no dependency, no stash, no push,
no branch, no `pnpm install`.

## Concerns for the coordinator

1. Order in `protocol.ts` matters for Task 6. `canonicalSaltSchema` sits at line 302, after `siteRecordSchema`
   (line 158, in the "Host responses" block), as instructed ("next to" `badgeSaltSchema`). A top-level `const` read
   before its initialization throws at module load: if Task 6's `siteRecordSchema` says
   `badgeSalt: canonicalSaltSchema` in place, every suite fails on import with
   `ReferenceError: Cannot access 'canonicalSaltSchema' before initialization`. Task 6 therefore has to move the
   constant (its doc comment plus the `export const`, both in the commit) above `siteRecordSchema`, best right before
   the `data of an org_profile item` comment, which is outside all three of its `protocol.ts` anchors, or the
   constant can be moved there before Task 6 starts. I did not do it now, because the instruction said "next to it" and
   to leave the `siteRecordSchema` area alone.
2. The committed plan (`docs/superpowers/plans/2026-09-29-standalone-1d4-office-operators-badges.md`, line 1900) and
   `.superpowers/sdd/1d4-task-2-brief.md` still show `z.base64().length(24)` for `badgeSaltSchema`. They are history and
   I did not edit them; if the plan is meant to stay true to the code, that line is the one to update.
