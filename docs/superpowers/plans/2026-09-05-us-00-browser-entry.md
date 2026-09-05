# US-00 browser entry implementation

Goal: make the approved US access and initial profile flow usable locally.

Architecture: independent Vite root and React entry; existing same-origin US
client; isolated EN/ES provider; shared Markiro UI components and tokens.

Tech stack: existing React, Vite, i18next, Vitest, testing-library and Playwright.

Spec: `docs/superpowers/specs/2026-09-03-us-00-regulatory-profile-design.md`,
`docs/us/development-isolation.md`, `docs/us/browser-client-foundation.md`.

## Global Constraints

- Work only in this US worktree. Preserve all existing edits. No commit, push,
  merge, deployment, base database provisioning, or release-lock changes.
- EN default and es-US secondary; no RU entry, auth client, routes or translations.
- No signup, password recovery, MFA replacement, operational modules or fake KPIs.
- Server owns MFA assurance, membership and profile permissions. Missing profile
  is only the client's precise `profile_not_provisioned` error.
- No persistent credentials, authenticator material, backup codes, or tokens.
- Initial profile configuration only: explicit profile and IANA time zone,
  retention default 5/minimum 2; show stored server summary without editing.
- All fixtures are synthetic, local, disposable; hosted operations remain locked.

## Task 1: Access and initial profile screens

Files: new `apps/admin/src/us/app.tsx`, focused subcomponents, EN/ES resources,
US stylesheet and `apps/admin/test/us-app.test.tsx`. You may add a deployment
attestation method in `src/us/client.ts` and tests in `test/us-client.test.ts`.
Do not edit manifests, Vite config, entry HTML, CI or existing RU components.

1. Write failing focused component tests before implementation. Exercise the real
   browser client with an injected fake fetch at the transport boundary.
2. Export `UsApp({client}: {client?: UsBrowserClient})`. It must work inside the
   existing shared ThemeProvider; create its own i18next instance/provider, never
   import RU i18n. The new entry will import `./app.js` and `./us.css`.
3. Attest `GET /api/us/deployment` before any auth calls. Expected response is
   `{edition:'US', releaseEnabled:false, interfaceLocales:['en-US','es-US'],
defaultInterfaceLocale:'en-US'}`. Invalid/unavailable metadata blocks login.
4. Session read -> sign in, password session -> enroll TOTP, existing MFA login
   challenge -> TOTP or backup code. Probe organization list to establish current
   server assurance; user.twoFactorEnabled alone is not assurance. Stale password
   session for an enabled user must sign out/re-login, not verify directly.
5. Enrollment material stays in short-lived component state, outside query caches.
   Show manual authenticator setup key and backup codes with a saved-codes
   acknowledgement before verification. Never link the secret URI externally.
   Insert-only enrollment conflict offers verification with an already saved key,
   explaining that lost-key replacement is unavailable; never regenerate it.
6. MFA success -> explicit organization selection -> profile GET. No organization
   offers explanation/sign out, not organization creation. Only precise missing
   profile opens setup. Profile denial/unavailable cannot open setup.
7. Profile selection: US_FSMA204_PROCESSOR / US_GENERIC_LOT_TRACEABILITY; explicit
   time zone from the eight documented US zones; retention 5 default and min 2.
   PUT -> read-only server profile summary and explicit unfinished-business notice.
   Differing existing profile returns conflict, offer reload without silent overwrite.
8. All reachable UI EN/ES, light/dark, narrow mobile. Language switching must not
   lose typed form values. Shared Button/Input/Select, approved compact split-shell.
   Logo reuse from existing assets, no new illustrations or token system.
9. Handle expired session, generic failures, denied permissions, pending operations,
   duplicate submit and stale responses after unmount/logout. Clear secrets on
   successful verification/logout. Failed logout must not claim server logout.
10. Run focused tests/typecheck/lint; self-review and report red/green evidence.

Design reference read in Pencil: NwjYS sign-in has a 30.5% dark left brand panel,
69.5% light content pane, form approx 420px wide centered, IBM Plex fonts,
Markiro wordmark, small top-right language/theme controls; heading “Sign in”,
description “Use the account provided by your organization.” Left panel heading
“Lot records, from receipt to shipment.” Existing recovery links are out of scope.
CSFYq settings uses shared compact form controls and a restrained profile summary.

## Task 2: Separate local build and runtime boundary

1. Add test-first explicit Vite US root, entry, output and fixed proxy contract.
2. Root `apps/admin/us`, entry `src/us/main.tsx`, output `dist-us`; no RU entry.
3. Dev and preview loopback localhost:5174 with strict port. Proxy only US auth,
   metadata and profile, target localhost:3100, appropriate rewrite and Host.
4. Require explicit US frontend edition and development/test mode; never load
   primary `.env`; output is local validation, not deployment configuration.
5. Add explicit package dev:us/build:us scripts and check-only CI verification.

## Task 3: Integration and browser verification

1. Verify assembled UI and run focused/full admin gates, isolation tests, format
   and diff checks; repeat unaffected RU build to establish separate output.
2. Browser test uses a disposable US database/API fixture and actual Vite proxy,
   exercises login -> enrollment -> organization -> provisioned profile and fresh
   MFA login; inspect desktop/mobile EN/ES and dark screenshots without secrets.
3. Review scope, record proof and remaining limits in US progress docs. No release.

## Execution record

- Preflight: tasks 1/2 share only the UsApp/client contract; config/entry consume
  the named app export. Task 3 consumes both and starts only afterward. Constraints
  agree with tests; no existing dirty files are overwritten.
- Initial state: HEAD b5478b1 with previous US increments uncommitted.
- Tasks 1–3 implemented locally. Entry contract tests first failed for the absent
  US config; real proxy verification caught and fixed the Vite-root HTML bridge.
- Client/component regressions cover session expiry, secret cleanup, body timeout,
  stale mutations, locale metadata and serialized logout. Independent review's
  final scoped pass reported no remaining blocker.
- Full admin suite: 1,018 passing tests in 92 files. Real Chromium verified the
  complete access/profile flow and a held MFA request followed by logout against
  disposable US PostgreSQL. Desktop/mobile and light/dark screenshots inspected.
- See `docs/us/browser-entry.md` for commands, evidence and remaining limits.
  Work remains local and uncommitted; base database and release locks unchanged.
