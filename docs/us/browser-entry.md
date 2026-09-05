# US browser access and profile entry

Status: implemented and verified locally on 2026-09-05; development-only, release locked. US-00 remains in progress.

## Available flow

The separate admin entry supports English (`en-US`) and Spanish (`es-US`), light/dark themes and narrow mobile layouts. It uses the approved Pencil access/profile layouts and shared Markiro UI components and tokens.

The reachable flow is server edition attestation → password sign-in → authenticator enrollment or fresh MFA challenge → organization selection → initial traceability profile setup → stored, read-only profile summary. A one-use backup code can satisfy the login challenge. Profile and IANA time zone require explicit choices; retention defaults to five calendar years with a minimum of two. Server authorization, baseline, timestamps and persisted retention remain authoritative.

Public signup, password recovery, factor replacement, organization creation, profile editing and operational modules are absent. A profile summary explicitly states that receiving, transformation, shipping, plan, request and export workflows are not implemented. It is not an operational dashboard or regulatory-compliance claim.

Enrollment keys, backup codes and passwords stay in transient component state. Enrollment material clears on successful verification, session loss and logout. Late responses cannot restore obsolete UI state. Logout waits for an already-started mutation to settle before sending sign-out, so a delayed MFA response cannot set a new session cookie after successful logout. A failed sign-out does not claim that the server session ended.

## Local build boundary

`apps/admin/vite.us.config.ts` uses `apps/admin/us` as its own HTML root and writes only `apps/admin/dist-us`. It does not load primary environment files or copy the RU public directory. The entry rejects imports of other admin application modules, except bundled assets. The ordinary RU entry, router, translations and Vite configuration remain unchanged.

Explicit US configuration and development/test mode are mandatory. Dev and preview bind only to `localhost:5174` with a strict port. The proxy targets the separate local US API on port 3100 and forwards only US auth, deployment metadata and the traceability profile. Unknown `/api` requests return 404; there is no primary API fallback. Client requests have a 15-second deadline covering headers and response-body parsing, no automatic retry, no stored bearer tokens and no redirect following.

After building the existing shared UI and contracts packages, run from the US worktree:

```sh
VITE_DEPLOYMENT_EDITION=US pnpm --filter @markiro/admin dev:us
VITE_DEPLOYMENT_EDITION=US pnpm --filter @markiro/admin build:us
```

The build command creates optimized assets for local validation, not an authorized deployment. See [development isolation](development-isolation.md) for the separate API/dependency setup. Auth requires an explicitly initialized isolated database and owner; this increment did not initialize or provision the base `markiro_us_dev` database.

## Verification

- Focused client/component tests: 36 passed, including timeout, session loss, cross-account cleanup, duplicate actions, stale responses and serialized logout. Tests were added before the corresponding implementation/fixes.
- Full admin suite: 1,018 tests passed across 92 files. Admin typecheck passed; lint reported zero errors and five existing hook-dependency warnings in unchanged RU pages. Existing JSDOM canvas/navigation warnings are not browser proof.
- Separate US build and unchanged RU build passed. The RU build retains its existing large-chunk warning. No dependency version changed in this browser increment.
- All 17 entry and release-isolation tests passed. They check explicit edition/mode, isolated imports/output, proxy allowlist, generated-output lint exclusion, CI dependency build order and release locks. Final checks exposed the missing `dist-us` lint exclusion and shared UI build ordering; failing regression tests preceded both configuration fixes.
- All 24 US HTTP integration tests passed against disposable local databases.
- The actual Vite/API proxy smoke test checks US metadata, anonymous profile denial, unknown/RU route refusal and untrusted mutation Origin refusal.
- Real Chromium exercised password login, initial TOTP enrollment, backup-code acknowledgement, organization selection, profile creation/reload, exact profile audit, sign-out and fresh backup-code login. A held real MFA request verifies that logout waits for verification to settle and the final server session is absent. The fixture creates and drops only its own randomly named local US database.
- Browser checks verify no page errors, external requests or additional persistent browser state beyond the theme preference. Desktop EN, mobile ES and light/dark screenshots were inspected; no enrollment secrets were captured in screenshots or traces.
- Independent review findings about expired sessions, secret cleanup, request deadlines, stale async state and logout cookie ordering were fixed and regression-tested. Final scoped review reported no remaining blocker.

For the local proxy check, after building the API and shared packages:

```sh
US_TEST_DATABASE_URL=postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev node --test tools/us-development/test/browser-proxy.smoke.mjs
```

The full browser check additionally requires the separately pinned `tools/production-browser` Playwright dependencies and Chromium; it does not add a browser dependency to the product bundle:

```sh
US_TEST_DATABASE_URL=postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev node --test tools/us-development/test/browser-flow.smoke.mjs
```

Both checks reserve ports 3100 and 5174; stop manually started US application servers first. Never substitute a primary database URL. During local verification the existing main-checkout Playwright runtime was consumed read-only through `NODE_PATH`; no main-checkout files were changed.

## Remaining limits

The check-only workflow runs focused UI tests, entry contracts, the US build and HTTP persistence checks. Full Chromium verification is local-only. The entire API suite was not rerun for this frontend increment; its previously recorded RU-environment setup failures remain unresolved in the isolated US environment, as documented in [client foundation verification](browser-client-foundation.md).

No remote CI, hosted TLS/cookie behavior, real authenticator device, mail, object storage, hardware, production-data geography or recovery delivery was verified. Auth-event audit and remaining US-00/P0 acceptance are open. No commit, push, merge, deployment or release was performed, and the main checkout was preserved.
