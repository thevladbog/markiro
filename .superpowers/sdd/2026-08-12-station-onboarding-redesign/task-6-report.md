# Task 6 report: Station onboarding beta acceptance handoff

## Scope and result

Commit `91d4fec5` (`docs(station): add onboarding beta acceptance`) updates only
the requested release and hardware-acceptance documentation:

- `docs/runbooks/station-beta-release.md` now makes the release sequence
  explicit: production runtime `STATION_ORIGIN=http://tauri.localhost`, live
  production preflight, beta workflow build, immutable artifact/hash/signature
  verification, and manual Windows installation acceptance.
- `docs/hardware-acceptance-checklist.md` now has unchecked evidence rows for
  the runtime-secret reference (without its payload), preflight, workflow,
  immutable artifacts, branded installer/taskbar/window icons, real
  `admin.markiro.app` pairing, touch keypad, physical keyboard, scanner,
  viewport, fullscreen exit/re-entry, active-shift confirmation, and preserved
  shift/outbox state.

`docs/acceptance/station-touch-workplace.md` was deliberately not changed. Its
existing browser-gallery evidence is not new Windows acceptance, and no Windows,
packaged WebView, pairing-code, scanner, touchscreen, or installer observation
was made during this task.

## Automated checks

| Command | Result | Evidence |
| --- | --- | --- |
| `pnpm --filter @markiro/station test` | PASS | Vitest: 58 test files and 619 tests passed. The only extra stderr was jsdom's existing `HTMLCanvasElement.getContext()` "Not implemented" notice. |
| `pnpm --filter @markiro/station typecheck` | PASS | `tsc -p tsconfig.json --noEmit` exited 0 with no diagnostics. |
| `pnpm --filter @markiro/station lint` | PASS | `eslint . --ignore-pattern 'src-tauri/target/**' --ignore-pattern 'src-tauri/gen/**'` exited 0 with no diagnostics. |
| `pnpm --filter @markiro/station build` | PASS | Vite 8.1.3 transformed 391 modules and completed `built in 238ms`. Generated `apps/station/dist` remains ignored. |
| `cargo test --manifest-path apps/station/src-tauri/Cargo.toml` | PASS | 27 library tests passed; binary and doc-test targets each ran 0 tests and passed. This is a host Cargo result, not Windows or hardware acceptance. |
| `pnpm test:station-release:contract` | PASS | 27/27 tests, including Station beta docs and exact Windows pairing-preflight contracts. |
| `pnpm exec prettier --check docs/runbooks/station-beta-release.md docs/hardware-acceptance-checklist.md` | PASS | Both changed documents are formatted. |
| `git diff --check` | PASS | No whitespace errors. |
| `git diff main...HEAD --check` | PASS | No whitespace errors across the branch. |
| `pnpm test:production-bundle:contract` | NOT COMPLETE: environment failures | 251 pass, 9 fail. The failures were outside the edited files: pnpm `why` could not open its SQLite metadata; direct Caddy adapter could not access the Podman API socket; seven healthcheck cases could not bind `127.0.0.1` (`EPERM`). |
| `pnpm format:check` | NOT COMPLETE: unrelated branch formatting | The current run flags five files not changed by Task 6: `apps/station/src/pages/Enrollment.tsx`, `apps/station/test/enrollment.test.tsx`, `docs/superpowers/plans/2026-08-11-tenant-billing-documents.md`, `docs/superpowers/plans/2026-08-12-station-onboarding-redesign.md`, and `docs/superpowers/specs/2026-08-11-tenant-billing-documents-design.md`. The changed runbook and checklist pass the targeted check above. |

The initial pnpm invocation was blocked before running tests because the inherited
`node_modules` requested an interactive purge. Retrying with
`pnpm_config_verify_deps_before_run=false` only suppressed that pre-run prompt;
it did not install, remove, or modify dependencies.

All pnpm commands in this table were executed as
`pnpm_config_verify_deps_before_run=false corepack pnpm …` so the required
commands could run without modifying the inherited dependency overlay. The five
Station/Cargo gates were rerun after the initial report and are the current
standard-gate evidence, not mapped replacements.

## Manual/external acceptance

Not run. No runtime secret was changed, no production preflight was called, no
workflow or release was started, and no Windows installer was downloaded or
installed. Consequently all new Windows checklist rows remain unchecked.

## Final review

- `git status --short` was clean immediately after commit, before this required
  local SDD report was written.
- `git diff main...HEAD --stat` contains the earlier Tasks 1–5 implementation
  plus this 2-file documentation commit; no secret payload, pairing code,
  signing key, generated cache, or Tauri target was introduced by Task 6.
- `git log --oneline main..HEAD` contains Task 6 at `91d4fec5` following
  completed Task 1–5 commits through `79c35cea`.

## Remaining concerns

The production-bundle suite needs an environment that permits loopback listeners
and Podman/Docker access, with a usable pnpm metadata SQLite database. Separate
from that automated limitation, the release is not accepted until a release
owner follows the runbook on a target Windows station and records all physical
results, particularly real pairing, icons, input methods, viewport fit and
fullscreen/state-preservation behavior.
