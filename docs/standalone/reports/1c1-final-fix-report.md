# Plan 1c1 — final-review follow-up: report

Commit: `2d5b3e4894aabf4116c5a13fa2563e7c66cc8c8f` — `fix(standalone): итоговое
ревью 1c1 — лента, поток, формат кода подключения` (branch
`claude/autonomous-desktop-station-9e6f13`, on top of `9a1eaa7d5`).

All 11 items (A–K) are implemented as specified. One test (item H) had to be
rewritten from the brief's literal sequential shape to a concurrent one to
actually exercise the bug it was meant to pin — see "Deviations" below.

## A. `lan_ipv4_addresses()` runs in a test

`apps/standalone/host/src/network.rs`: added
`the_real_lan_addresses_are_sorted_deduped_and_exclude_reserved_ranges`,
calling the real `lan_ipv4_addresses()` (not the `usable` filter) and
asserting sorted-without-duplicates and the three exclusions, without
depending on the list being non-empty.

## B/C. `normalize` moves to `markiro-proto`, strips more separators

- New `apps/standalone/proto/src/pairing.rs`: `ALPHABET`, `CODE_LENGTH` and
  `normalize` moved from `host/src/pairing_code.rs` with their doc comments;
  `normalize` now skips any `char::is_whitespace`, the ASCII hyphen, and the
  Unicode dashes U+2010..=U+2015 and U+2212 (previously only `' '` and `'-'`).
  Declared via `pub mod pairing;` in `proto/src/lib.rs`.
- `host/src/pairing_code.rs`: re-exports the three via
  `pub use markiro_proto::pairing::{normalize, ALPHABET, CODE_LENGTH};`;
  `generate`, `payload`, `CODE_LIFETIME`, `MAX_FAILED_ATTEMPTS` stay. Module
  doc updated to say where the format now lives.
- Tests: the existing `a_typed_code_is_normalized_like_crockford_decoding`
  moved to `proto/src/pairing.rs`'s own `tests` module (host's copy removed
  from `pairing_code.rs`); a new `normalize_strips_whitespace_and_unicode_dash_separators`
  covers both B cases (`"7K3M\tQ9XV\u{2013}2D"`, `"7K3M\u{00A0}Q9XV\u{2212}2D"`),
  both normalizing to `"7K3MQ9XV2D"`.
- Call sites (`routes/pairing.rs`) compile unchanged against the re-export.

## D. No spurious `hasMore`

`host/src/routes/changes.rs::changes`: `has_more` is now
`page.more_after.is_some_and(|rev| rev < current)`; `rev` is unchanged
(`page.more_after.unwrap_or(current)`).

Test: `host/tests/changes.rs::a_page_never_splits_a_revision`, first-page
assertion changed to `(json!(1), json!(false))`; the follow-up
`?since=1&limit=2` assertion (already `false`) is untouched.

**Red run** (temporarily restored `has_more: page.more_after.is_some()`):

```
test a_page_never_splits_a_revision ... FAILED
assertion `left == right` failed: revision 1 is whole and also the host's current revision: nothing more follows
  left: (Number(1), Bool(true))
 right: (Number(1), Bool(false))
```

Fix restored (`git checkout HEAD --`); full suite green again.

## E. `rev = current` past the last item

New test `host/tests/changes.rs::the_last_page_carries_the_current_revision_past_its_items`:
wizard (rev 1) → `add_lines(&["Линия A"])` (rev 2) → `seed_office_user` (rev 3,
not in the feed) → `?since=1` must hold exactly the rev-2 line, with
`rev = 3`, `hasMore = false`. No red run given (not requested for E); the
scenario is a genuine gap in prior coverage — every existing test happens to
end on a revision that also carries a feed record, so a regression to "rev of
the last item" would still pass all of them, per the brief.

## F. Query guards

Extended `host/tests/changes.rs::the_feed_checks_its_query`:
`?foo=1` → 400 `validation_failed` (the query struct already had
`#[serde(deny_unknown_fields)]`, unchanged); `?limit=1` and `?limit=1000` → 200. No production code change was needed — both behaviors were already
correct; the test previously didn't pin them.

## G. Webview parity for the new response fixtures

- `apps/standalone/test/protocol.test.ts`: added `changes-response.json`
  (`changesResponseSchema`), `pairing-code.json` (`pairingCodeSchema`) and
  `device-record.json` (`deviceRecordSchema`) to `RESPONSES`. The "change
  feed" test now compares all three `data` records with `toEqual` against the
  fixture's own `items[i].data` (typed as `{ items: Array<{ data?: unknown }> }`)
  instead of spot-checking one field each.
- `apps/standalone/src/host/protocol.ts`: `siteRecordSchema.badgeSalt` is now
  `z.base64().length(24)` (was `z.string().min(1)`); the fixture salt
  `AAECAwQFBgcICQoLDA0ODw==` is exactly 24 characters and satisfies it.

## H. Stream events strictly increasing; docs corrected

`host/src/routes/changes.rs::stream`: the `unfold` state gained the last sent
revision (`(Option<i64>, i64, watch::Receiver<i64>, watch::Receiver<bool>)`).
After the first event, the wait loop only returns when the newly observed
revision is strictly greater than `last`; anything else (including a lower
value) loops back to `select!` instead of emitting. The `select!`
restructuring itself is unchanged.

Docs:

- The comment above `select!` now attributes the borrow on `stopping` to the
  `watch::Ref` `wait_for` resolves to (alive in `select!`'s own output until
  the expression ends), not to "a live arm future", per the brief.
- "one `rev` event per commit" reworded in all three places: `changes.rs`'s
  `stream` doc and module doc (now mentions the stream, not just the feed),
  `apps/standalone/AGENTS.md` "Change feed", and spec §4.5's
  `GET /v1/changes/stream` row (reformatted by `prettier --write` afterward,
  whitespace-only, since the wider cell widened every row's padding).

Test: `host/tests/changes_stream.rs::a_lower_watch_value_never_produces_a_non_increasing_event`.

**Red run and a deviation from the brief's literal test shape** — see
"Deviations" below; this is the one substantive correction made during
verification.

## I. One home for "the current revision"

- `host/src/db.rs`: added `pub async fn current_revision(conn: &mut SqliteConnection) -> Result<i64, sqlx::Error>` next to `next_revision`.
- `changes.rs::changes` and `::stream` both use it now instead of their own
  `SELECT rev FROM host_revision WHERE id = 1`. `stream` acquires a pooled
  connection in a small scope (`state.pool.acquire()`) since it has no open
  transaction of its own.
- `server.rs`: `AppState.revisions`'s doc reworded to the exact sentence in
  the brief. `AppState::new`'s seeding (`watch::channel(0)`) is untouched.

No dedicated test (the brief says tests may keep their own SQL helper, e.g.
`host_revision()` in `changes_stream.rs`, which several tests still use
directly); covered indirectly by every test that already exercises `changes`
and `stream`.

## J. The stop test proves a clean end

- `host/tests/changes_stream.rs::open_streams_end_when_the_host_stops`: last
  assertion is now `assert!(matches!(stream.chunk().await, Ok(None)), "the
stream ended cleanly with the host")`; the redundant
  `started.elapsed() < 5s` assertion (and the now-unused `started` binding)
  removed.
- New in-process test `a_stream_ends_when_the_host_starts_stopping`: opens
  the stream, reads the first event, calls
  `app.state.stopping.send_replace(true)`, and asserts
  `body.frame().await` is `None` within 5 s.

`Ok(None)` does hold for the current implementation — confirmed by an actual
run (see below), so no `NEEDS_CONTEXT` was warranted.

**Red run for the new in-process test** (both places that check `stopping`
temporarily neutralized — the loop-top `if *stopping.borrow() {...}` replaced
with `if false {...}`, and the `select!` branch's predicate replaced with
`|_stopping| false`):

```
test a_stream_ends_when_the_host_starts_stopping ... FAILED
thread '...' panicked: the stream ends within 5 s of the host starting to stop: Elapsed(())
```

(Neutralizing only the `select!` predicate while leaving the loop-top check
in place still passed — that check alone is sufficient for this scenario,
since the test calls `send_replace(true)` and only then polls. This confirms
the test is not vacuous, but it does not by itself distinguish which of the
two stop paths is doing the work; noted as an observation, not a defect —
the brief's test is a black-box behavioral one.)

Fix restored; full suite green (see "open_streams_end_when_the_host_stops"
and "a_stream_ends_when_the_host_starts_stopping" in the final run below).

## K. Feed tie-break and the checklist

- `host/src/routes/changes.rs`: the page query orders by
  `rev, entity, id, deleted DESC`; the whole-revision fallback query orders by
  `entity, id, deleted DESC`.
- New test `host/tests/changes.rs::a_key_deleted_and_recreated_in_one_transaction_ends_live`:
  after the wizard, in one `begin_write` transaction with one `next_revision`,
  bumps an existing line's `rev` (keeping the row) and inserts a tombstone for
  the same id and revision. Asserts the feed lists the tombstone first, the
  live row second.
- `apps/standalone/AGENTS.md` "Change feed": the "a new feed entity needs…"
  sentence extended with "an index on the new table's `rev` (as
  `lines_rev`)" and "that re-creating a key deletes its tombstone".

**Red run** (temporarily dropped `, deleted DESC` from both `ORDER BY`
clauses), run three times to check determinism:

```
test a_key_deleted_and_recreated_in_one_transaction_ends_live ... FAILED (×3, identical shape each time)
assertion `left == right` failed: the tombstone sorts first: {...
  "items":[{"deleted":false, ...},{"deleted":true, ...}]}
  left: Bool(false)
 right: Bool(true)
```

Without the tie-break the live row consistently sorted before the tombstone
(SQLite's `UNION ALL` evaluates the `lines` arm before the `tombstones` arm
in `FEED_KEYS`, and nothing broke the tie) — exactly the bug K fixes: a
station applying the feed in order would end up thinking a still-live line
was deleted. Fix restored; test passes.

## Deviations

**H's test needed rewriting, not just adding.** The brief's literal
step order — send the lower value, then `.await` the real PUT to completion,
then read the next chunk — turns out not to exercise the bug in this
in-process (`Router::oneshot`) harness: nothing polls the SSE body in the
background the way a real hyper connection task would, so `send_replace(0)`
merely overwrites the watch cell before anything ever observes it; the real
commit then simply raises it further to the real revision, and even the
_pre-fix_ stream would only ever see the final value and emit the correct
event. I confirmed this by temporarily reverting the `stream` fix and running
the test exactly as first written: it passed. That would have shipped a test
with zero regression coverage.

The fix: read the next chunk _concurrently_ with the real commit
(`tokio::join!(next_text(&mut body), app.send(...))`), so the stream is
actually polled (and observes `0`) before the real commit lands. Re-running
against the reverted (pre-fix) `stream` with this shape now fails as expected
(see the "H" section above); against the fix it passes. This changed test is
included in the same commit (amended once, before any result was reported —
see below), since the brief calls for exactly one commit.

**The commit was amended once.** The above correction was made after the
first commit, during my own verification pass, before reporting completion.
Per the standing instructions I create new commits rather than amend once
work is "done"; here the brief explicitly asks for exactly one commit for
this whole follow-up, and the amendment fixes a self-authored test defect
discovered before any delivery — so I amended (`git commit --amend --no-edit`)
rather than adding a second commit. Final subject and trailer are unchanged
and still exactly as specified; verified again with `git log -1 --format=%B`.

**An unrelated file was already modified when I started, and stayed
unstaged.** `docs/superpowers/plans/2026-09-27-standalone-1c2-app-shell-sync.md`
appeared modified partway through this session (referencing
`markiro_proto::pairing::normalize`, i.e., anticipating item C's move) —
apparently a concurrent session drafting plan 1c2 in this same shared
worktree. It was never staged or touched by me and is not part of this
commit; `git status --short` still shows it modified after my commit.

## Verification

Rust, outside the sandbox (binds 127.0.0.1):

```
$ cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
(clean, no output)

$ cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline
26 suites, 171 passed, 0 failed
(includes host's 111 tests — 107 before this follow-up, net +4: +1 network,
+2 changes.rs, +2 changes_stream.rs, -1 pairing_code.rs moved out — proto's
21, and markiro-standalone's 39, unchanged there)
```

Full per-suite listing confirmed (not just the summary): every new/changed
test name above appears with `... ok`, including
`network::tests::the_real_lan_addresses_are_sorted_deduped_and_exclude_reserved_ranges`,
`pairing::tests::normalize_strips_whitespace_and_unicode_dash_separators`,
`a_key_deleted_and_recreated_in_one_transaction_ends_live`,
`the_last_page_carries_the_current_revision_past_its_items`,
`the_feed_checks_its_query`, `a_page_never_splits_a_revision`,
`a_lower_watch_value_never_produces_a_non_increasing_event`,
`a_stream_ends_when_the_host_starts_stopping`,
`open_streams_end_when_the_host_stops`.

TypeScript/JSON, in the sandbox:

```
$ pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts
1 file, 48 passed (up from 42: +6 for the 3 new RESPONSES entries × 2 checks each)

$ pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test
19 files, 242 passed

$ pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck
clean (no output)
```

Formatting and hygiene:

```
$ node_modules/.bin/prettier --check apps/standalone/AGENTS.md \
    docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md \
    apps/standalone/src/host/protocol.ts apps/standalone/test/protocol.test.ts
initially failed on the spec file (table re-alignment); `--write` on that
file, then `--check` again → all matched files use Prettier code style

$ git diff --check
(clean, exit 0 — checked before staging, and again with --cached after staging)
```

Not run / out of scope: lint, `pnpm build`, and anything under
`apps/station` (excluded by the brief). No database migration, audit-log, or
i18n surface was touched by these items, so those areas were not
separately re-verified beyond the full test suite above.

## Files changed

```
apps/standalone/AGENTS.md
apps/standalone/host/src/db.rs
apps/standalone/host/src/network.rs
apps/standalone/host/src/pairing_code.rs
apps/standalone/host/src/routes/changes.rs
apps/standalone/host/src/server.rs
apps/standalone/host/tests/changes.rs
apps/standalone/host/tests/changes_stream.rs
apps/standalone/proto/src/lib.rs
apps/standalone/proto/src/pairing.rs (new)
apps/standalone/src/host/protocol.ts
apps/standalone/test/protocol.test.ts
docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
```
