# Autonom office login implementation

Implement the approved OpenPencil login screen (2026-10-30), including the
rounded office kit, both themes, a compact window and licensed company branding.
The approved conversation and `output/autonom-office-login-2026-10-30` in the
original checkout are the visual specification. Commit, push and a PR targeting
main were authorized on 2026-10-30; deployment is outside this task.

## Tasks

- [x] Add focused failing host tests for a minimal paired-device branding read.
      Only station/office devices may read it, without an office session; the host
      applies the existing `customLogo` gate. Return the existing `OrgLogoState`
      contract, containing no profile, license or user information. Test disabled
      branding, missing/deleted logo, missing/revoked credentials, and handheld denial.
- [x] Implement the additive route, authorization/license tables and HostApi
      method. Keep protected office routes unchanged and reuse the existing schema.
- [x] Add failing login tests for licensed logo rendering, safe fallback,
      nonblocking loading, a failed image, reconnection, changed pairing and stale
      answers. Preserve validation, recent users, password visibility, theme, host
      address and station-only back action.
- [x] Implement the screen using shared UI tokens and components. Add a focused
      branding hook and component; reset on pairing/revision/reconnection. Keep logo
      proportions, white substrate and fixed slots. Use no network assets or stored
      session/branding credentials. Match the 1440x900 and 1024x768 layouts.
- [x] Run focused and package checks, relevant host/auth/license tests, build,
      formatting and browser checks (both themes, logo/default, compact/low window).
      Request an independent review and address material findings with tests.

## Review focus

1. Device key alone must still not open office profile, license or users.
2. Branding must come from the host's effective feature, never the client's clock.
3. A stale request must never display a previous host's logo after re-pairing.
4. Missing, malformed, blank or failed images must leave usable Markiro login.
5. Long recent logins, six entries, errors and low windows must remain usable.

## Progress

Base: origin/main, bfb71d106. Implementation in codex/autonom-office-login.

Focused red/green checks established the missing route and client read before
implementation. The final focused UI/API run passed 190 tests in four files;
27 host tests passed across branding, device-kind access, license route coverage,
organization logo and print branding. Typecheck, ESLint, the Vite build and the
repository Prettier check passed. The build retains the existing large-chunk
warning. Full Vitest passed: 390 files and 8,713 tests; three tests were skipped
because the separate floor browser harnesses need `PLAYWRIGHT_CORE` and the
PostgreSQL reporting seam needs `STANDALONE_HISTORY_ACCEPTANCE_OUT`. The full
Rust workspace run passed 2,779 tests with zero failures; 12 tests were ignored
for the dedicated PostgreSQL seam, million-scan performance run, live Yandex
OAuth and manual host-process/load scenarios. `cargo fmt --check` passed.

Browser verification used the real component with a local fixture host adapter
and the existing company bitmap: light/dark, default/company logo, 1440x900,
1024x768, six recent users with a long login, password focus, failed sign-in,
960x600 scrolling and offline fallback. No horizontal overflow was observed.
An independent read-only code review found no actionable issues.

Installed Windows/WebView pairing, real LAN/TLS and production were not exercised.
Rust integration tests exercised local host authorization and IPC shapes. No
local Graphify graph exists in the isolated worktree. These verification results
precede publication; no deployment was performed.
