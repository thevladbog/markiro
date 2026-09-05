# US browser client foundation

Status: local development increment, 2026-09-05. The client is now connected to the [separate US browser entry](browser-entry.md). Release locks remain active.

## Implemented boundary

`apps/admin/src/us/client.ts` is independent of the RU auth client, router and translations. It exposes only password sign-in, session projection, TOTP enrollment/verification, backup-code verification, organization list/selection, initial profile read/provisioning and sign-out. It has no public signup, password reset, factor replacement or role-changing method.

Every request uses a fixed same-origin US path with cookies, `no-store` and redirect refusal. There is no configurable remote base URL, automatic retry, bearer-token storage or raw error logging. Login reports either a password session or an MFA challenge; neither is client-side proof of tenant access. Server authorization remains authoritative on organization/profile requests.

Auth responses are projected to the fields the interface needs: bearer tokens and organization metadata are not returned. Enrollment is the only operation that returns its TOTP URI and backup codes. The connected UI keeps enrollment material only in short-lived component state, never URLs, analytics, persisted query caches or browser storage, and clears it on verification, session loss or sign-out. UI lifecycle and real browser verification are recorded in the browser entry increment; client tests alone do not prove them.

The profile uses one strict shared request/response contract from `@markiro/platform-contracts`, now a workspace dependency of admin. Missing persisted retention is rejected rather than defaulted; the five-year default remains input-only. OpenAPI uses the same response schema. No dependency version changed.

Errors expose translation-ready codes only, with no raw response or nested cause. In particular, only `503 traceability_profile_not_provisioned` from a profile GET permits initial setup; generic infrastructure failures and the same payload on an auth route do not.

## Browser integration boundary

Do not connect the existing RU admin to the US API. Its current Vite configuration forwards to the primary API, its entry imports RU translations and its router includes registration and RU business modules. None of those were changed by this increment.

The separate US entry/build configuration now verifies its edition against the server before sign-in and allowlists proxy routes:

- `/api/us-auth/*` forwards unchanged to the isolated US API;
- `/api/us/deployment` forwards to `/deployment` on that same API;
- `/api/us/traceability/profile` forwards to `/traceability/profile` on that same API;
- no generic `/api` fallback to the primary product.

The connected screens use the approved EN/ES design baseline and shared UI components for login, MFA enrollment/challenge, organization selection and initial profile setup. The server supports initial provisioning, not profile editing. Recovery and business features remain unavailable. See the [browser entry verification](browser-entry.md) for the actual Vite, Chromium and cookie checks and their limits.

## Client foundation verification (before the browser entry increment)

The 21 client boundary tests failed against the empty implementation before development and then passed. Seven new shared response-contract tests likewise failed before implementation; the complete shared-contract suite now has 102 passing tests. The client tests cover safe transport options, projected results, strict mutation inputs, malformed data, cross-edition refusal and sanitized failures.

The API HTTP suite has 24 passing cases, including the real browser client through sign-in, initial TOTP enrollment, organization selection, absent profile, profile creation/read, sign-out and subsequent backup-code login. It uses a randomly named disposable US database and a test-only same-origin proxy/cookie jar. This verifies the client/server wire contract, not browser cookie policy or a real Vite proxy. It does not migrate or provision the base US database.

The US check-only workflow includes the focused browser client tests and the existing HTTP suite. No remote workflow, browser, hosted infrastructure or deployment was exercised. Independent read-only review found no actionable client-contract issues.

Additional local gates: all 1,003 admin tests passed across 91 files; admin and API typecheck/build passed. API lint and the complete shared-contract lint/typecheck/build passed. Admin lint has no errors and five existing hook-dependency warnings in the unchanged boxes/conflicts pages; the existing admin build reports large chunks. JSDOM reports unsupported canvas/navigation operations in existing tests, so those tests are not visual proof. Repository formatting, whitespace and 11 release-isolation contract tests passed.

The full API run completed with 1,574 passing tests and 1,411 skipped. The same eight main-product test files listed in [local owner verification](local-owner-provisioning.md) still fail suite setup in the clean US-only environment; the full API gate is not green. All six US test files passed. No main-product credentials or database were loaded to address those setup failures.

Dependency setup required reading missing registry metadata for the existing lockfile's supply-chain policy check; no policy was disabled. The lockfile change is solely the internal admin-to-contracts workspace link. Initial admin typecheck lacked built UI declarations and passed after building the existing shared UI package. The cross-package HTTP test loads the actual browser client through Vitest at runtime, keeping the API compiler's package root unchanged.
