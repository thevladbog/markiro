# Standalone online updates implementation plan

Goal: manually discover and download signed releases from Office, then reuse existing installation.
Spec: ../specs/2026-10-30-standalone-online-updates-design.md
Execution: inline; user explicitly requested implementation, then authorized commit, push and PR on 2026-10-30. Merge, publication and deployment are not requested.

- [x] Shell: add update/online.rs and commands for channel check/download, bounded HTTPS transport, signature/pointer matching, version compatibility, resume and hash validation. Add tests before implementation and exercise IPC rejection paths.
- [x] Office: add typed injected online API and OnlineUpdateBlock; stable/beta choice, no mount request, signed notes, size, progress and retry. Pass downloaded path into UpdateFromFile's existing verification/report/confirmation pipeline. Test explicit check, current version, download without installation, error/retry, role restriction and unchanged manual flow.
- [x] Documentation and gates: update network promises and scoped instructions. Run focused and package UI tests, lint/typecheck/build, Rust tests, release contracts and diff checks. Review complete diff before reporting.

Review focus: unsigned pointer cannot authorize a package; beta/stable mismatch; CDN redirects/excess body; failed download cannot become installable; unmount or channel change cannot publish stale results; Host backup and confirmation remain required.

Ledger: dependency install requires Corepack pnpm 11.22.0 (system pnpm rejects packageManager lock metadata); corepack install succeeded with frozen lockfile and guard intact.

## Verification ledger

- Focused Office/API/control suites: 43 tests passed. Download leads to the existing report; cancelling confirmation starts neither backup nor install. Confirming on Host runs backup, audit and install. Failed download is retryable; a result after unmount is ignored.
- Online Rust module: 8 tests passed, including signed-only notes, pointer mismatch rejection, fixed destinations, bounded responses, redirect refusal, interrupted resume, a server restarting a range with 200, changed-manifest partial invalidation, hash failure and promotion into the existing installer verifier.
- Existing shell lib/IPC/Host-fetch/update suites passed; the added Internet-versus-Host classification integration test passed with a live synthetic Host on loopback.
- Typecheck, lint and Vite production build passed; Vite reports the existing large-chunk warning. Prettier repository check, rustfmt and git diff --check passed.
- Release contracts: 104 passed, no skips. CI affected-path rules already select standalone UI/Rust/Windows jobs; no ownership change needed.
- Independent source review found no important correctness/security issue. Its minor contradictory network statement in the runbook was corrected. Additional range-reset and online-versus-Host compatibility cases requested by review were added and passed.
- Local browser smoke exercised the component with synthetic release data (offer, signed-note presentation, progress and completed handoff); the temporary harness/server were removed. Windows WebView2/UAC/NTFS and real installation were not exercised on this macOS host.
- Public stable CDN read on 2026-10-30: version 1.1.1, manifest signature verified with the embedded production key, streamed installer size 13,902,807 bytes and SHA-256 match. No installer was executed. Main source version is 1.1.2, so this source correctly has no newer stable offer today.
- Initial full UI run: 8,674 passed, 1 failed, 3 skipped. Failure identified a native Select; corrected to the shared custom Select and the focused 43 tests passed.
- The first full workspace Cargo attempt exhausted disk during linking. Its own disposable target was cleaned (15.3 GiB), no other worktree or user data was removed. This also caused explicit ENOSPC errors while two UI modules loaded. Two unrelated template-code-download assertions timed out in that same wide run; their exact timing cause was not independently established. All three affected files then passed unchanged (146 tests). Full reruns use lower concurrency; Cargo disables debug/incremental artifacts only, with unchanged assertions and timeouts.
- The three intentional UI skips require PLAYWRIGHT_CORE (two station layout suites) and STANDALONE_HISTORY_ACCEPTANCE_OUT (PostgreSQL report seam), neither supplied for this task.
- Implementation was verified in the attached isolated checkout. The owner subsequently authorized a commit and PR; publication and deployment remain outside scope.

- Final full UI run after storage recovery and completion of heavy compilation: **383 files passed, 8,675 tests passed, 3 intentional skips**, no source/assertion/timeout changes. Earlier broad-run SQLite timeouts were recorded; 72 affected tests also passed in isolation. The isolated and final successes do not independently establish the exact timing cause of the earlier run.

- The next full Cargo run reached the shell and exposed a fixture bug: on macOS the accepted TCP stream inherited nonblocking mode from the test listener, so a request split over packets could raise WouldBlock. A deterministic split-header regression failed against the old helper in 0.1 s. Explicitly returning the accepted stream to blocking mode fixed it; the existing 3 s read bound was retained, product transport code was unchanged, and all 333 shell unit tests passed. The final full workspace run passed with the same compiled artifacts.

- Final full Cargo workspace run: **2758 passed, 0 failed, 12 intentionally ignored**, exit 0. No Windows or actual installer execution is inferred from this macOS run.
- Final status: implementation and local gates complete, with no unresolved review findings. The owner authorized committing the scoped changes and opening a PR.

- The 12 Cargo ignores are the dedicated PostgreSQL seam, the million-scan benchmark, live Yandex OAuth/upload and explicitly opt-in spawned-host/load/kill/restart checks; they require dedicated external infrastructure or trusted-machine manual execution.

## Follow-up: automatic Host staging

Owner authorized automatic staging of a verified Internet download. Add the existing authenticated
stage command after local verification, retain a local-package retry, block install during transfer,
and keep manual-file upload and installer confirmation. Initial focused tests reproduced missing
automation (6 failed, 2 passed); after implementation the 39 focused update/API/Host tests passed.
Backend IPC, protocol, Rust and server storage behavior are reused without modification.

### Automatic-staging follow-up verification

- Full Office UI package: **8,685 passed, 3 intentional skips**, exit 0. Focused update/Host/API/control checks: **63 passed**.
- Existing Rust stage transport against synthetic loopback Host: **4 passed**, covering staged storage, current-package repair and refused bad/old packages. No Rust, Host or protocol code was changed by this follow-up; the earlier full workspace result (2,758 passed, 12 ignored) applies to the unchanged backend. The full Rust workspace was not repeated for this TypeScript-only orchestration change.
- Package typecheck, lint and build passed, as did formatting of changed files and git diff --check. Vite retains the existing large-chunk warning.
- Independent review of the follow-up found no actionable issue. Runtime order, administrator session, pending-transfer install exclusion, local retry, exact-version status recovery and manual-file staging were checked.
- This follow-up did not perform a transfer to a real factory Host, Windows/WebView2/UAC installation or physical LAN/device acceptance. No installer is launched by download or staging.
- UI tests explicitly cover both Host and separate Office PCs, failed signature/hash verification, section removal during verification, retry without a second download, delayed transfer preventing installation, a confirmed current/staged package after response loss, and refusal to call a different Host version a successful transfer.
