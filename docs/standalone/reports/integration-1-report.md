# Integration 1 — claude/2a4-shell + claude/2a3-office

Worktree: `/tmp/claude/wt/integ`, branch `claude/integration`, cut from
`claude/autonomous-desktop-station-9e6f13` at `0ebfce8b4`. Nothing pushed.
`claude/2a2-facts` not merged.

Final tip: **`16fdf718a6856105a23e78bc7bbad948704cd967`**

```
16fdf718a Merge branch 'claude/2a3-office' into claude/integration   (2a3 tip 105ad8bca)
409d3e829 Merge branch 'claude/2a4-shell' into claude/integration    (2a4 tip ce6511b3b)
0ebfce8b4 (base) docs(standalone): plan РК — backups and restore …
```

Both are real merge commits (`--no-ff`), each with exactly one
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` trailer. No
fix-up commits were needed.

## Merge 1 — claude/2a4-shell (409d3e829)

No conflicts. Git auto-merged `apps/standalone/AGENTS.md` (the only file
both sides touched: main's 2a1 final wave and 2a4's table classes, forget
guard, host_request timeout and Hardware sections). Checked by hand: no
conflict leftovers, no duplicate `##` headings, lines over 80 columns are
17, all of them already in one side (main had 18, 2a4 had 17). The spec
`docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md`
took 2a4's §17 after main's §15 (no §16 yet).

## Merge 2 — claude/2a3-office (16fdf718a)

Auto-merged with no conflict: `src/host/protocol.ts` (2a4's `timeout`
transport code and `deviceName` beside 2a3's shift schemas),
`src/i18n/ru.json` (checked: valid JSON, no duplicate key at any level),
`test/protocol.test.ts`, `test/support/fixtures.ts`.
(`errors.ts`, `client.ts`, `api.ts` did not overlap.)

Conflicts, all resolved by meaning with both sides kept:

1. `apps/standalone/AGENTS.md`, «Operators and badges», the similar
   personnel number (В13). Main (2a1 final wave) added the host facts
   «Every operator counts, a deactivated one included; with two numbers in
   the way the answer names the same number first, then the lowest» to the
   old wording «which the office's form shows as a taken number»; 2a3
   replaced that wording with the form's new behaviour (named under the
   number, `operator-forms.ts`, cursor placed there). Result: the host
   facts, then 2a3's form sentence; the superseded «shows as a taken
   number» is dropped because 2a3 rewrote exactly that behaviour.
2. `apps/standalone/AGENTS.md`, «Shifts», SSCC blocks. Main added the
   same-prefix rule for a repeated `requestId`; 2a3 appended the
   «Номера закончились» sentence (`isExhausted`,
   `src/office/sscc/counter-kind.ts`). Result: main's paragraph followed by
   2a3's sentence, rewrapped at 80 columns.
3. `apps/standalone/AGENTS.md`, «Verification». 2a4's «Hardware in tests»,
   «Two things stay green…» and «Hardware by hand» items, followed by
   2a3's item on the office «Смены» checks run only under jsdom.
4. The stage 2a spec: §16 «Уточнения плана 2a3» placed before §17
   «Уточнения плана 2a4» (both texts unchanged).

After resolving: no markers, no duplicate `##`/`###` headings in
AGENTS.md; lines over 80 columns are 19, every one present verbatim in
one of the sides.

## Gates

Environment: macOS, load average 48–70 throughout.

Setup (once, after merge 1): `pnpm install --frozen-lockfile
--prefer-offline --filter '@markiro/standalone...'` passed (supply-chain
policy ok, 1766 entries); `package.json`/`pnpm-lock.yaml` untouched.
`turbo run build --filter='@markiro/standalone^...'` 3/3 successful.

### After merge 1 (409d3e829)

- build: ok (exit 0); typecheck: ok; lint: ok.
- test (whole package): 69 files, 1883 tests — 1879 passed, 4 failed, all
  `Test timed out in 5000ms` in `test/template-editor.test.tsx`. Re-runs
  of that file alone: 2 then 1 timeout (different tests each time); the
  four by name (`-t`): 5 passed. Neither branch changes that test or
  `src/office/templates`.
- prettier --check on the 15 changed ts/tsx/json/md/yml/css files: clean.
  `git diff --check 0ebfce8b4 HEAD`: clean.
- `cargo fmt --check --all`: clean.
- `cargo test -p markiro-standalone`: see the combined run below (the Rust
  tree did not change in merge 2).
- `cargo clippy -p markiro-standalone --all-targets -D warnings`: clean.

### After merge 2 (16fdf718a, final)

- build: ok; typecheck: ok; lint: ok.
- test (whole package): **79 files, 2166 tests — 2161 passed, 5 failed**,
  all 5 `Test timed out in 5000ms`: 2 in `test/shifts-page.test.tsx`, 3 in
  `test/template-editor.test.tsx`.
  - `shifts-page.test.tsx` alone: 33/33 passed.
  - `template-editor.test.tsx` alone, twice: 3 then 4 timeouts, a
    different set each run; the failing tests by name: all passed. Under
    this load the file does not pass whole at 5 s; I did not raise any
    timeout.
- prettier --check on all 61 changed ts/tsx/json/md/yml/css files vs the
  base: clean. `git diff --check 0ebfce8b4 HEAD`: clean.
- Rust (the src-tauri tree is identical after both merges):
  - `cargo test --offline --locked -p markiro-standalone`: in the sandbox
    lib 134 passed, main 0, `hardware_shapes` 1, `local_db` 26, `lockdown`
    4; the other 9 targets failed only with loopback EPERM (66 panics, all
    `Operation not permitted`). Those 9 re-run outside the sandbox: `claim`
    5, `connection` 6, `device` 15, `host_probe` 2, `host_probe_proxy` 1,
    `host_request_timeout` 6, `ipc` 26, `line` 16, `printer` 15 — all
    passed. Total **257 passed, 0 failed**.
  - `cargo test -p markiro-proto` (sandbox): 5 + 40 + 0 doc = **45
    passed**.
  - `cargo test -p markiro-host` (outside the sandbox, loopback): 31
    targets, **365 passed, 0 failed, 0 ignored**.
  - `cargo fmt --check --all`: clean.
  - `cargo clippy -p markiro-standalone --all-targets -D warnings`: clean.
    `cargo clippy --workspace -D warnings` (lib/bin targets): clean.
    `cargo clippy --workspace --all-targets -D warnings`: **fails in
    markiro-host test code** — `type_complexity` in
    `host/tests/support/app.rs:394`, `host/tests/sscc_blocks.rs:542`,
    `host/src/validate.rs:1194` and `:1256` (test module), and
    `assertions_on_constants` at `host/src/validate.rs:1319`. host/ and
    proto/ are byte-identical to the base `0ebfce8b4`, so these are
    pre-existing on the main branch, not integration breakage; CI runs no
    clippy. Left as is (outside the integration's scope).

## Not verified

- Anything Windows: the spooler, COM, power requests, kiosk mode, WebView2
  rendering of the office «Смены» pages; real printers and scanners; a
  real host with a real station. Only host-side cargo and jsdom tests ran.
- `test/template-editor.test.tsx` does not pass as a whole file at the
  5 s timeout under this machine's load (it failed after merge 1 too, and
  neither branch touches it); every failing test passes by name. Worth a
  re-run on an idle machine or in CI.
- The whole-package Vitest count is 79 files / 2166 tests, below the
  rough ~85 / ~2300 estimate; nothing was skipped by filtering, so the
  estimate was just high (2a2 is not merged).
- CI (`standalone-rust`, `standalone-windows-build`) has not run on this
  branch.
