# Task 7 report — kiosk lifecycle revoke and unbind

## Result

GREEN. Implementation commit: `d60e94230f170c54389e307d4d0396f56c83ec21`
(`fix(api): harden kiosk lifecycle revocation`).

## RED → GREEN

- RED: the initial controller audit test failed because `unbindKiosk` did not
  exist. On a migrated UUID-named disposable Postgres database, the archive
  test retained `deviceTokenHash` and the new unbind route returned 404.
- RED: the first implementation used SQL `= NULL` to select live pairing
  codes. The hash was cleared but the live code remained, so the lifecycle
  tests failed. Replacing it with `IS NULL` retired the code in the same
  transaction.
- RED: a legacy archived kiosk with a retained hash became authenticated again
  after `PATCH { status: "active" }` (expected 401, received 200). Reactivation
  now follows the credential-clearing transaction before the kiosk is active.

## Behavior delivered

- `DELETE /kiosks/:id` preserves the kiosk and pickup history, while
  transactionally archiving it, clearing `deviceTokenHash`, and retiring live
  kiosk pairing codes. Repeating the request is safe.
- `POST /kiosks/:id/unbind` returns 204 and is capability-gated with
  `credentials.manage`. It preserves the kiosk, makes it active and awaiting
  pairing, clears the credential and live codes transactionally, and is
  idempotent.
- An archived kiosk can be explicitly reactivated/unbound, but no historic
  token is restored. The legacy enrollment endpoint also rejects archived rows.
- Archive and unbind write exact success/failed credential audit events using
  only tenant, actor, action, durable kiosk ID, and outcome; neither token nor
  hash is emitted.
- Successful fresh kiosk pairing still uses the existing atomic redemption
  path, issuing a new token while preserving bootstrap data and the next device
  sequence.

## Verification

- `pnpm --filter @markiro/db build` — pass.
- Migrated UUID-named disposable Postgres database: `kiosks.e2e`,
  `kiosk-device.guard`, `kiosk-pairing.e2e`, `credential-audit`, and affected
  `devices.e2e` — 76/76 pass. The database was removed after the run.
- `pnpm --filter @markiro/api typecheck` — pass.
- `pnpm --filter @markiro/api lint` — pass.
- `pnpm --filter @markiro/api build` — pass.
- Scoped Prettier and `git diff --check` — pass.
- Repository `pnpm format:check` remains red only for four pre-existing,
  unrelated files: two admin custom-controls docs and two DB tests.

## Hash

`d60e94230f170c54389e307d4d0396f56c83ec21`
