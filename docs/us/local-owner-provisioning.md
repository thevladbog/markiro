# Local synthetic US owner

Status: local development increment, 2026-09-05. This is not production provisioning, a recovery mechanism or public signup. Use only the isolated US worktree and synthetic PostgreSQL described in [development isolation](development-isolation.md).

## Contract

The compiled `apps/api/dist/main.us-provision.js` command requires matching US editions, development/test mode, the fixed loopback dependency addresses, database `markiro_us_dev`, PostgreSQL user `markiro_us` and exactly `--confirm-local-synthetic-owner`. Before writing, it also checks the actual database/user reported by PostgreSQL. It never migrates or repairs a database; an uninitialized schema is refused.

One transaction creates:

- reserved synthetic user `owner@us-development.example.test`, with a Better Auth password hash, unverified email and no MFA assurance;
- organization `us-development-demo`, with explicit synthetic/version metadata;
- the owner membership and an exact provisioning audit event.

The command creates no session, verified factor, regulatory profile, CTE or business seed. Use the ordinary sign-in → TOTP enrollment/verification → organization selection path afterward; profile provisioning still requires the authenticated MFA session. No email is sent. The fixed identity is for local development, not a default hosted administrator.

Repeat with the same password to obtain the existing IDs without changing records or adding another audit event. Concurrent runs create one identity. A conflicting email/slug, changed password, missing credential or revoked membership fails closed; there is no reset/repair flag and no automatic adoption of unrelated users. An audit insert failure rolls the entire creation back.

## Invocation

Build API dependencies and `@markiro/api` first. Database migration remains an explicit separate step against the isolated US database; this command must not be used as an automatic startup hook. Never source the main checkout's environment.

From the US worktree in zsh, with the isolated schema already initialized:

```sh
read -rs 'us_owner_password?Local synthetic owner password: '
printf '%s' "$us_owner_password" | env -i "$(command -v node)" --env-file=deploy/us-development/local.env.example apps/api/dist/main.us-provision.js --confirm-local-synthetic-owner
unset us_owner_password
```

The silent prompt keeps input out of terminal echo/history. Passwords are 12–128 characters, without newline/NUL; input is capped at 512 bytes. The command refuses direct terminal input, accepts a pipe and never accepts password arguments or reads a password environment variable. Success prints only status, IDs, synthetic email and the MFA-required marker. Errors are generic and never print driver SQL or password material. Use a password manager; do not commit a password file or put a literal password in a shell command.

Changing the development environment or removing the confirmation flag is not a way to use this tool against hosted data. A hosted provisioning path needs a separately reviewed design.

## Verification and remaining work

`apps/api/test/us-development-owner.e2e.test.ts` uses only its own randomly named disposable US database. It verifies hashed credentials, actual sign-in and mandatory TOTP before organization access, atomic audit/rollback, repeat/concurrent creation, collisions and no password/MFA/role resets. `apps/api/test/us-owner-command.test.ts` verifies argument/environment/input limits. The compiled command smoke test checks safe refusal and output redaction; it does not provision the base development database or exercise an actual database-identity mismatch.

Initial store tests failed before implementation; policy tests also demonstrated missing functions before implementation. An initial compiled smoke attempt failed because the new entry had not yet been built; this was not an application failure. The current check-only US workflow runs these tests with its disposable PostgreSQL service; no remote workflow run or publication is claimed.

Local verification on 2026-09-05:

- Focused owner, command, authentication, profile-store and HTTP suites: 89 tests passed across five files, no skips.
- Compiled owner-command refusal smoke: one test passed (five unsafe configurations). Isolation checker and its 11 contract tests passed.
- API build, typecheck and lint passed; repository formatting and whitespace checks passed.
- The full API run used a clean environment with only the synthetic US test database configured: 1,573 tests passed and 1,411 skipped; eight files failed during setup because main-product database/auth/origin/pepper settings were absent. The affected files were billing-accounts, exchange-credentials, exchange-import, exchange-orders, exchange-protocol, integrations-delete, integrations and subscription-route-inventory. Three exchange teardown errors followed their failed setup. This is not a green full API regression run; no main-product environment was loaded to make it pass.

The implementation does not initialize the local base database automatically. Browser integration, recovery, authentication-event auditing, production cookie/TLS policy and full end-to-end US business functionality remain open. No customer data, main-product database or hosted infrastructure was used.
