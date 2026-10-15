# Plan РК-С, Task 1 — report

Status: DONE. Commit `0b2bb9c0c` (feat(standalone): the station's link reads the host's restore epoch from hello before each stream) on `claude/floor-2a7` at /tmp/claude/wt/flr, base f5b1707f1. Working tree clean after the commit.

## What was done

`connection.rs`: the link task reads `GET /v1/hello` with the pinned client and no key right before each stream (`restore_epoch(link)` -> `epoch_of(&HostResponse)`, 200 only, via `host_probe::classify_hello`). The epoch goes into the `Online` status through `publish_with` (`HostStatus.restore_epoch`, JSON `restoreEpoch`, skipped when `None`). It is cleared on `unpaired` and on a fresh link's first `Connecting`. A failed read never stops the stream. `protocol.ts`: `hostStatusSchema.restoreEpoch: z.uuid().optional()`.

## RED / GREEN

- RED vitest: `Tests 1 failed | 5 passed (6)` (the new epoch test). RED `--lib connection`: 3 compile errors (E0560 x2, E0425 `epoch_of`). Outputs in /tmp/claude/impl-rks-t1/red-*.txt. The `--test connection` RED was not run separately (it fails to compile for the same reason).
- GREEN: vitest connection 6/6; `--lib connection` 13 passed (plan 13); `--test connection` unsandboxed 8 passed (plan 7, +1 test of mine).

## Tests beyond the brief (2)

1. In `the_online_status_names_the_epoch_of_a_restored_host` I added forget -> `Offline` with `restore_epoch None` (kills the `unpaired` clear).
2. New `a_link_swapped_for_another_host_does_not_inherit_the_epoch`: the link changes hands through a manual watch channel without passing through unpaired, and the new link's first `Connecting` must carry no epoch (kills the `fresh_link` clear). The brief says these clears are hygiene and not mutant-tested; I tested them anyway.

## Mutants (all restored: cmp silent, sha256 identical, files touched)

| #   | Mutant                                           | Killed by                                                                        |
| --- | ------------------------------------------------ | -------------------------------------------------------------------------------- |
| M1  | `restore_epoch(link).await` -> `None` (brief M1) | int: `the_online_status_names_the_epoch_of_a_restored_host`, `a_link_swapped...` |
| M2  | delete the `status != 200` guard (brief M2)      | lib: `the_epoch_comes_only_from_a_hello_that_reads` (503 case)                   |
| M3  | `z.uuid()` -> `z.string()` (brief M3)            | vitest: "passes on the restore epoch ... drops a malformed one"                  |
| M4  | `classify_hello` -> raw `Hello` parse            | lib: same test ("not a Markiro host")                                            |
| M5  | drop `skip_serializing_if`                       | lib: `statuses_and_revisions_serialize_to_the_webview_shape`                     |
| M6  | `restoreEpoch: z.uuid()` (not optional)          | vitest: 4 tests                                                                  |
| M7  | `.nullish()`                                     | vitest: the epoch test (null case)                                               |
| M8  | drop clear in `unpaired`                         | int: `the_online_status_names...` (forget assertion)                             |
| M9  | drop clear in `fresh_link`                       | int: `a_link_swapped_for_another_host...`                                        |
| M10 | Online publishes `None` instead of the epoch     | int: both epoch tests                                                            |

Backups and outputs are in /tmp/claude/impl-rks-t1/mut/.

## Gates

- `cargo fmt --check` clean. `cargo check --workspace --all-targets`: 0 warnings.
- Prettier gate (4 files; live proof with a scratch `zz.ts` -> `[warn]`, exit 1, scratch deleted): clean. `git diff --check` clean. `\u04` grep: only `pairing-code.ts:66`.
- typecheck, lint and build: exit 0. Verbose run of `connection.test.ts`: 6 passed, empty stderr. The delayed-`setImmediate` stand was not used: the file is a non-React unit test with no effects.
- Full package Vitest: 145/146 files, 4520/4522 tests. The 2 failures were 5 s timeouts in `template-editor.test.tsx` (the known old suite under load). Alone it passes 97/97, also with `--testTimeout=60000`.
- Parity: `test/protocol.test.ts` 352 passed. `proto/tests/fixtures.rs` passed in the full run.
- ONE final `cargo test --workspace --offline --locked` unsandboxed: exit 0, 71 `test result` lines, 1121 passed, 0 failed. The plan counted 63 lines and 962 tests on its scratch copy, whose base lacked later plans, so I report measured numbers.

## Anchor adaptations

None for the code: all 20 fragments matched exactly once, so Task 1 needed no meaning-based adaptation. `hello` at this base carries `restoreEpoch` as the brief assumes (`Hello.restore_epoch`, host `server.rs`, fixture `hello-restored.json`, `classify_hello` unchanged). The host's `restore` also sets `facts_held_since`; the test sets only `restore_epoch`, which `hello` reads.

For later tasks: the spec section for this plan is §24 (the plan text and the rks-constraints say §22 and "раздел 22"). Task 5 must write §24 and use shell migration number `0009` only if free (`0007`/`0008` are 2a7/ПЛ-Ц as the plan says; Task 2 should check the actual list).

## Self-review / concerns

- Not exercised: Windows, WebView2, a real `markiro-host restore`. The integration test writes the epoch into `site` the way `restore` does (rows_affected 1 asserted), restarts the host on the same address, and sees it in `Online`.
- One extra `hello` request per (re)connection, with the client's 10 s timeout, before the stream opens. A black-holed host delays the stream attempt by up to 10 s. The brief's design accepts this, and the stream open has its own failure path.
- Because of the `rtk` wrapper, the test-count grep was done with python on the saved output.
