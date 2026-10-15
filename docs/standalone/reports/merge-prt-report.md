# Merge report: claude/prt (plans ДРВ + А4) into claude/integration

Status: DONE_WITH_CONCERNS. Worktree /tmp/claude/wt/integ, base 0ca4d78d0, merged claude/prt f82ba4b0f,
merge commit 8c3011c9c (parents 0ca4d78d0, f82ba4b0f), one trailer, tree clean.
Logs: /tmp/claude/merge-prt/logs/. Mutant proofs: /tmp/claude/merge-prt/mut/ (mut.py, summary.txt, per-mutant logs).

## Conflicts (4 files, resolved as unions)

- `src/floor/print/label-render.ts`: СКЛ added `options: { kmDataMatrix }` as the 5th parameter and А4 added `logo` as the 5th.
  Union: `renderLabel(spec, fields, printer, rasterize?, logo = null, options = {})`. RAW emitters get
  `{ rasterizeText: rasterize ?? rasterizeText, logo, ...options }`. A driver page goes through `renderMonoLabel`
  with `rasterize ?? rasterizeDriverText` and the logo; it draws every code as dots, so the option is RAW-only.
  Callers updated: `warehouse-work-guards.test.ts` (`fakeRaster, null, options`) and the mock in
  `floor-app-warehouse-real.test.tsx` (`_logo` before `options`).
- `test/app.test.tsx`: both imports kept (warehouse-store; `HardwareApi, WindowsPrinting`).
- `AGENTS.md`: the А4 logo/sheets paragraph stays in the label section, followed by the ИМП `## Cloud import`
  section. The `##` headings were checked and none is duplicated.
- Pilot spec: the sections now run in numeric order 24, 25 ХП, 26 I1, 27 ОЧ, 28 ДРВ, 29 А4, 30 СКЛ, 31 ИМП.
  The stale «разделы 25–29 приходят при слиянии» sentence in §30 was removed.
- Auto-merged and checked by hand:
  - host `server.rs`/`routes/mod.rs`: org logo, pallet sheets, warehouse and cloud import routes;
  - proto `lib.rs` and the fixture lists;
  - shell `lib.rs` handlers: `print_windows_raster` (with `paper`), `get_windows_print_job`, `supports_windows_printing`;
  - office `nav.ts`/`routes.tsx`/`api.ts`: pallet sheets and import;
  - ru.json: keys unique (script-checked).

## Mechanical fixes found by the merge

- `host/tests/org_logo.rs::a_database_with_0016_takes_a_lower_migration_late` asserted 13..=15 absent. 0015 (СКЛ) is
  now present, so it asserts 13..=14 absent and 15 present.
- New test `a_host_takes_0015_and_0016_together_and_a_later_0013_and_0014_on_top`. It covers:
  - MIGRATOR is 0001–0012, 0015, 0016;
  - a host through 0012 takes 0015 and 0016 in one start, keeping `site.initialized_at`, with the new tables empty;
  - a СКЛ-build host (through 0015) takes 0016 alone;
  - synthetic late 0013 and 0014 apply on top of both, keeping the org_logo row.
  - Existing tests still pass: warehouse.rs `a_database_without_0013_and_0014_takes_0015_and_the_others_late`
    and `a_database_without_0016_takes_it…`.
- Two fake `PrintRuntime`s in `warehouse-work-guards.test.ts` lacked ДРВ's `checkWindowsJob`/`supportsWindowsDriver`
  (typecheck), so stubs were added.
- `no_secrets_in_logs` source walk: the union is unchanged. prt adds no facts/import module (`office_shifts.rs` is still
  0 `tracing::`), so `facts_files == 18` and `import_files == 2` pass with no change to the expected numbers.

## I3 seam (warehouse reprint × А4/ДРВ) — fixed in the merge commit

Module: `src/floor/warehouse/warehouse-work.ts` (+ new `warehouse-logo.ts`, helper in `print/shift-render.ts`).

- **(a) Logo.**
  - `shiftLabelRender`'s thermal branch was extracted unchanged into `renderLogoLabel(spec, fields, printer,
ownLogo, deps, options)`, which applies the same rule: the logo is read only for a layout with an
    `organization_logo` box; own logo else bundled Markiro else an empty box plus `LOGO_UNAVAILABLE_LINE`; the
    rasterizer is passed through untouched.
  - The warehouse default render is `warehouseLabelRender(local, pairing, deps)` → `renderLogoLabel` with
    `ownLogo = readKnownOrganizationLogo`.
  - SOURCE USED: the organization logo frozen in the newest shift snapshot of THIS pairing that has an
    `organization`. The query is `KNOWN_ORGANIZATION_SQL` on `floor_shifts`, `snapshot -> '$.organization'`,
    `ORDER BY opened_at DESC, id DESC LIMIT 1`, and the result is parsed with `shiftSnapshotOrganizationSchema` +
    `logoFromWire`.
  - I found no other station-side source: the logo is in no reference copy and no feed (А4-6). If there is no
    such snapshot, the organization froze no logo, or the logo is unreadable, the bundled Markiro logo is used,
    exactly as `labelLogo` does for a shift.
  - The subject's own shift is deliberately not preferred: the controller asked for the logo "currently known".
  - The new SQL is pinned in BOTH lists: TS warehouse STATEMENTS and Rust `the_warehouse_reads_search_an_index`,
    with the text-agreement test. The pin is `(host_id=? AND device_id=?)`, because Node 3.53 plans
    `floor_shifts_line` while the key is equally valid; there is no SCAN.
- **(b) Mode.** `runtime.send(job.id, target, bytes, printerMode(printer), printer.paper)`, the same runtime as the floor
  (FloorApp hands `printing`). A retry or new attempt re-renders when the MODE differs (plus language/dpi as before),
  so RAW bytes never reach a driver queue and a driver page never reaches a RAW printer. A driver page gets
  `rasterizeDriverText` (the bundled face; refusal → `render_failed`, nothing sent).
- **(c) A4.** `warehousePrinter()`: an assigned printer with `paper === "a4"` gives the new code `printer_a4`.
  - Prepare: the job fails `printer_a4` with no render and no send. The record goes to the host, whose rule
    accepts any code word.
  - Retry/again: `WarehousePrinterError("printer_a4")` before anything is written.
  - A job carrying an A4 printer is never sent (`first` guard).
  - Box and unit purposes never get an A4 printer (`printsPurpose`, tested via raw stored settings).
  - UI: `floor.warehouse.printerA4` «Принтер паллет настроен на листы А4, а повторная печать — это термоэтикетка.
    Назначьте паллетам принтер этикеток в «Рабочее место».» plus the «Рабочее место» button.
- **(d) Tests.**
  - New `test/warehouse-print-a4-logo.test.ts` (17 tests). It uses a fake print runtime that records
    mode/paper/target/bytes, a spy-through real `renderLabel` that records rasterize/logo/options, and spied app
    rasterizers. Its cases:
    - newest snapshot wins, ordered by opening rather than by insertion or id, ignoring another pairing's shifts;
    - Markiro in 4 cases;
    - no logo read without a box;
    - logo failure → empty box with one line, label still sent;
    - unit gets `kmDataMatrix: raster`;
    - a driver box sends `windows_driver` and a decodable 203-dpi mono-raster, drawn with the driver face only;
    - RAW → `raw`, best-effort rasterizer;
    - face unavailable → `render_failed`, nothing sent;
    - a retry after RAW→driver re-renders;
    - the A4 refusals (prepare / retry / again / first) and box-with-A4.
  - Screen test in `warehouse-screen-flows.test.tsx`: shows the А4 text, sends nothing, `wh_jobs` error_code
    `printer_a4`, and has the «Рабочее место» button.
- **Mutants: 16 one-line mutants, 16 killed.** Each restore was sha256-equal, `cmp`-equal and touched. The
  mutants were:
  - logo source ignored;
  - ASC order;
  - order by id;
  - any pairing;
  - deps dropped;
  - send always raw;
  - send paper a4;
  - no re-render on mode change;
  - A4 not refused at prepare;
  - A4 job sent on first;
  - options dropped;
  - driver fallback face;
  - kmDataMatrix lost in RAW deps;
  - UI text;
  - UI setup button;
  - own logo ignored in the helper.
- **Docs.**
  - AGENTS warehouse section: a new paragraph, retry wording "mode, language or resolution", and the stale "no
    driver path" line fixed.
  - Spec §30: a «Стык с ДРВ и А4» bullet, and the stale «Не сделано» wording fixed.

## Gates (one run, after the last edit)

- turbo build (`@markiro/standalone^...`, `@markiro/domain`) with `pnpm -C`: 3 tasks OK. (`pnpm --dir` was rewritten
  by the local hook into an EACCES spawn, so `-C` is used.)
- standalone typecheck 0, lint 0 (one `require-await` fixed), build 0.
- Full standalone Vitest (`--testTimeout=60000 --hookTimeout=60000`): 187 files, 5555 passed, 0 failed, stderr 0 bytes.
  - Prettier then reformatted 2 test files (whitespace only), and those were re-run alone together with
    protocol/forms-parity: 409 passed.
- Parity: export-parity + forms-parity, 253 passed. Rust proto fixtures ran in the workspace run.
- `pnpm test:standalone-export`: 120 tests, 119 pass, 1 skipped (live Postgres), 0 fail.
- `cargo fmt --check` clean (after rustfmt of the new test).
- ONE `cargo test --workspace --offline --locked --no-fail-fast`, unsandboxed: rc 0, 80 result lines, 1447 passed,
  0 failed, 0 ignored, 0 warnings. The restore.rs flake did not occur.
- Prettier gate: probe exit 1 (proven live, deleted), then 109 changed prettier-handled files (.rs/.sql/.toml and
  lockfiles excluded) clean.
- `git diff --check` clean; `grep '\u04'` only `pairing-code.ts:66`; git status empty.

Not exercised: Windows, WebView2, printers (driver/A4/thermal logo), live Postgres export test, real host over LAN.

## Concerns

1. The merge commit carries the I3 seam fix and the mechanical test fixes, not only conflict text (same as the m1
   precedent).
2. Logo source choice: a reprint of another station's or an older shift's label prints the logo of the newest snapshot
   this pairing holds. A station that never entered a shift since А4 prints Markiro even if the organization has its
   own logo, and a logo uploaded after the newest shift opened is not seen until the next shift.
3. `printer_a4` is a new error code word in `wh_outbox` records. The host accepts it (`is_code_word`) and the proto has
   no closed list, but no fixture pins it.
4. The A4 review's I3 alternative "render the sheet from the subject shift's snapshot" was not done. A4 sheets are
   still printed only by the shift's own pallet close.
