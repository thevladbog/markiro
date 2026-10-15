# Task 5 report: Клиент хоста, API устройства и тексты ошибок в вебвью

## What was implemented

Followed `.superpowers/sdd/1b2-task-5-brief.md` steps 1–6 in order (TDD), using
the brief's code verbatim (no deviations were needed).

1. **Error texts (`apps/standalone/src/i18n/ru.json`).** Added the top-level
   `errors` key next to `shell`: `unknown`, `transport` (6 codes),
   `unauthorized` (3 credentials), `api` (14 protocol codes), `device` (13
   shell codes) — exactly the brief's Step 1 block. Validated as JSON with
   `node -e "JSON.parse(...)"` before proceeding.

2. **Host client (`apps/standalone/src/host/client.ts`).** `HttpMethod`;
   `TRANSPORT_CODES` (6 codes) and `TransportCode`; `HostError` (`kind:
"transport" | "api"`, `code`, `status: number | null`, `details`, plus
   `credential`/`field` getters that only resolve for `unauthorized` /
   `validation_failed` respectively); `HostRequestOptions<T>`; `HostClient`
   interface; `createTauriHostClient(call = invoke)`, which calls
   `host_request`, treats any shell rejection not in `TRANSPORT_CODES` as
   `unreachable`, validates the `{status, body}` envelope and the 2xx body
   against the caller's schema, and turns a non-2xx status into an `api`
   `HostError` (or `invalid_response` if the error body itself doesn't parse).

3. **Device API (`apps/standalone/src/host/device.ts`).** `DEVICE_ERROR_CODES`
   (13 codes) and `DeviceErrorCode`; `DeviceError`; `DeviceApi` (`status`,
   `pairLocally`, `forget`); `createTauriDeviceApi(call = invoke)`, mirroring
   the same shell-rejection-code-passthrough pattern as `client.ts` and
   validating both `device_status` and `host_local_pair` answers against
   `deviceStatusSchema`.

4. **Host API (`apps/standalone/src/host/api.ts`).** `HostApi` (`bootstrap`,
   `officeLogin`, `officeLogout`) and `createHostApi(client)`, a thin
   typed wrapper over `HostClient.request` for the three endpoints this plan
   stage needs; office-only endpoints are left for plan 1b3 per the brief's
   comment.

5. **Error-to-i18n mapping (`apps/standalone/src/host/errors.ts`).**
   `API_ERROR_CODES` (14 codes) and `errorMessageKey(error)`: transport errors
   map to `errors.transport.<code>`, an `unauthorized` API error with a
   recognized `credential` detail maps to `errors.unauthorized.<credential>`
   (checked before the generic API-code path, so a rejected credential always
   wins), other known API codes map to `errors.api.<code>`, `DeviceError` maps
   to `errors.device.<code>`, and anything else (unknown code, a plain
   `Error`, a non-Error thrown value) falls back to `errors.unknown`.

6. **Shared test fixtures (`apps/standalone/test/support/fixtures.ts`).**
   `HOST_ID`, `DEVICE_STATUS`, `observation(initialized)`, `SESSION` — created
   for this task's own `device.test.ts` and for tasks 6–8 to reuse, per the
   brief.

7. **Tests.** `apps/standalone/test/client.test.ts`, `test/device.test.ts`,
   `test/errors.test.ts` — created verbatim from the brief's Step 2.

## TDD evidence

**RED** (`pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/client.test.ts test/device.test.ts test/errors.test.ts`,
captured before writing any of the four `src/host/*` modules — `ru.json` and
the tests/fixtures already existed at this point): all three suites failed
outright with `Failed to resolve import ".../client.js"` /
`".../device.js"` (Vite import-analysis errors, not assertion failures) —
`Test Files 3 failed (3)`, `Tests no tests`. This confirms the RED was for the
right reason (the modules under test did not exist yet), not a fixture or
i18n-content mistake.

**GREEN** (same command, after implementing `client.ts`, `device.ts`,
`api.ts`, `errors.ts`): `Test Files 3 passed (3)`, `Tests 36 passed (36)` —
14 in `client.test.ts` (6 transport codes + 3 invalid-response cases + 5
single tests), 19 in `device.test.ts` (13 device codes + 6 single tests), 3 in
`errors.test.ts` — matching the brief's Step 5 count exactly.

Full suite (`pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`):
`Test Files 8 passed (8)`, `Tests 87 passed (87)` (adds the pre-existing
`app.test.tsx`, `fingerprint.test.ts`, `phc-contract.test.ts`, `probe.test.ts`,
`protocol.test.ts` from earlier tasks, untouched by this one).

## Final checks (all green)

- `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test` → 8 files, 87 tests passed.
- `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck` → clean (`tsc -p tsconfig.json --noEmit`, no errors). In particular, the `HostClient` interface's generic `request<T>(...)` method, implemented as a plain object-literal method inside `createTauriHostClient`, type-checked without any explicit generic annotation or cast — TypeScript's contextual typing of generic methods against the `HostClient` interface handled it.
- `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint` → clean, no changes needed.
- `node_modules/.bin/prettier --write` then `--check` on all nine changed/created files → all reported "unchanged" / "use Prettier code style"; no reformatting was necessary.
- `git diff --check` → clean (no whitespace errors).

## Files changed

- `apps/standalone/src/i18n/ru.json` — added the `errors` key (modified).
- `apps/standalone/src/host/client.ts` — new.
- `apps/standalone/src/host/device.ts` — new.
- `apps/standalone/src/host/api.ts` — new.
- `apps/standalone/src/host/errors.ts` — new.
- `apps/standalone/test/support/fixtures.ts` — new.
- `apps/standalone/test/client.test.ts` — new.
- `apps/standalone/test/device.test.ts` — new.
- `apps/standalone/test/errors.test.ts` — new.

## Deviations from the brief, with reasons

None. Every module, type, export, and test in the brief compiled and passed
exactly as written; no TS-strictness fix-ups (`noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`) were required.

## Concerns

- `HostApi` and `DeviceApi`/`HostClient` are not yet wired into any component
  or screen — this task only produces the typed plumbing plan 1b2 Tasks 6–8
  (wizard form, office screens, app shell) consume next. That is the intended
  scope boundary per the brief's file list, not a gap in this task.
- `createHostApi` covers only `bootstrap`, `officeLogin`, `officeLogout`
  (per the brief's comment, "office screens add their own (plan 1b3)"), so
  the office-management endpoints already modeled in `protocol.ts`
  (`orgProfileSchema`, `ssccStateSchema`, `officeUserRecordSchema`, etc.) have
  no `HostApi` methods yet. This matches the brief; flagging only so a later
  task doesn't assume `api.ts` is meant to be exhaustive today.
