# Plan 1e1 — final fix wave re-review (e02cac6d8..a4709973b), condensed by the controller from the reviewer's hand-back

Reviewer: final whole-plan reviewer (opus, a2f4c0c905a653292), resumed. Tree clean before and after.

## Verdict

**APPROVED. Plan 1e1 can close.** Critical 0, Important 0; three wording nits (fixed by the controller in `82faaa94e`), two flagged concerns rated «ignore» (wizard test D checks only `templateCount`; test A now compares the whole `host.bootstrap` row) and «nit» (AGENTS F1 sentence in the present tense).

## Items

Every FIX item CLOSED, none PARTIAL or OPEN; no existing assertion weakened (only removed assertion lines: the moved trigger `unwrap()`s and test A's `templateCount` spot check, now a whole-row compare). Evidence lines: minor 4 `tests/product_groups.rs:328-358`; 5-rest `:7-13`; 6 `tests/changes.rs:839-866`; 7 `changes.rs:1040-1048`; 10 `src/error.rs:110`; 12 products `tests/products.rs:451-489`; 12 siblings `counterparties.rs:124`, `lines.rs:160`, `operators.rs:285`, `bootstrap.rs:524`, `office_admin.rs:308/:366/:739` (block sizes and users had no stale case before); 13 `AGENTS.md:390-395`, `proto/src/lib.rs:1083-1085`; 14 `products.rs:746`, `:792-800`; 18 `src/validate.rs:1182-1238`, `tests/templates.rs:1504-1559`; 19 `AGENTS.md:440-441`, `validate.rs:400-401`/`:1264-1265`; 20 `tests/template_defaults.rs:616-664`; 21 `AGENTS.md:482-485`, spec `:259-265`; 22 `tests/no_secrets_in_logs.rs:353-378`; 23 `AGENTS.md:497-501`, spec §4.5 `:327`/`:347-351`; 24 `bootstrap.rs:726-753`; 25+F7 `tests/support/app.rs:328-353`; 26+F6 `AGENTS.md:508-510`/`:461-462`, spec §4.5 `:396-398`, §5.3 `:613-616`, §6 `:795-798`; F1 `AGENTS.md:413-418`; F2 `products.rs:535-559`; F3 `:496-533`; F4 `templates.rs:999-1003`; F5 `AGENTS.md:418-423`; N10 `tests/feed_machine.rs` (435 lines).

## Mutants the reviewer ran (each fails exactly the named test; restores byte-identical, sha256 + cmp)

W1 products stale `!=` → `>` (products 16/1: `a_put_over_a_revision_older_or_ahead_of_the_product_is_stale`, side «ahead»); W2 minor-6 mutant (changes 20/1: `a_byte_cut_inside_a_count_cut_ends_the_page_at_the_last_revision_it_holds`; `feed_machine` also fails at `:340`); W3 `DOCUMENT_REV` without the entity filter (template_defaults 17/1: `an_unrelated_tombstone_does_not_move_the_documents_revision`; the machine also fails at `:161`); W4 office users `!=` → `>` (office_admin 10/1: `a_user_put_over_a_revision_older_or_ahead_of_the_user_is_stale`); W5 machine: a cleared category default writes no tombstone (`feed_machine.rs:364`). Restored tree: focused suites (lib, bootstrap, changes, counterparties, feed_machine, lines, office_admin, operators, product_groups, products, template_defaults, templates) 201 passed, 0 failed, 0 warnings; fmt and prettier clean.

## feed_machine.rs

Deterministic (8 green runs, 0.70–0.75 s; no assertion depends on the order of random template ids inside a revision; item sizes constant, so the byte cut is stable: four big layouts ≈ 1.0008 MB against 1 048 576, five ≈ 1.25 MB). Assertions follow the plan's guarantees (never back, items in `(since, rev]`, a key at most once, order by `(rev, entity, id)`, a tombstone carries no data, no `hasMore` on an empty page; at the end all four stations equal the from-zero one in rows and `rev`, the from-zero `rev` equals the host's, keys equal the host's live keys, tombstones exactly `15:box` and the deleted template). «A revision is never split» is enforced indirectly (an honest split breaks `item.rev <= page_rev`; a dishonest one loses items). Coupling acceptable: the live-keys SQL mirrors `FEED_KEYS`; the `24` depends on `bootstrap_body()` having two lines (commented); `[4, 2]` deliberately pins `MAX_PAGE_BYTES`. Four independent stations + a fifth from-zero; they model only the station's apply rules, not the real reference-sync, quarantine or `local_transaction`.

## Documents, helpers, production code

No contradiction between the documents or with the code; the 2 MiB statements agree; the reverse-staleness clause is in AGENTS and spec §4.3; «Plan 1e1 is host-only» agrees with spec §6 and §5.3. Helpers correct (`nested` identical to the removed copies; the trigger helper unwraps and its fixed trigger name makes a second call fail loudly; `Admin::feed` asserts 200; `technologist_session` goes through an asserting `login`; `audit_row` a pure builder). Production code changed only in comments (`error.rs:110`, `validate.rs:400-401`, `proto/src/lib.rs:1083-1085`; the other `validate.rs` hunks are inside `mod tests`, which opens at `:482`).

## Minors carried / closed

1. `AGENTS.md:420-423` «predates the product preferences» is inaccurate (the same migration defines them) → «omits the product's preference» — FIXED `82faaa94e`.
2. Spec §6 `:795-798` omitted the product groups (`product-group.json`) in the list of fixtures only Rust checks — FIXED `82faaa94e`.
3. `AGENTS.md:417-418` add «(plan 1e2)» to the F1 clause — FIXED `82faaa94e`.
4. Ignore: two short reflowed lines (`AGENTS.md:395`, `:444`; prettier is clean); `feed_machine`'s `by_one.len() >= 10` is a loose bound (13 today).

Not run by the reviewer: the loopback suites (`no_secrets_in_logs`, `hello`, `platform`, `changes_stream`, `pairing`, `pairing_codes`), the full host and proto run (the controller ran all 346 green), Windows, Vitest (webview untouched).
