# Handheld agent instructions

These instructions supplement the [root AGENTS.md](../../AGENTS.md) for the
native Android application. Start with [README.md](README.md) for current setup,
supported flows, debug scan inputs and hardware-validation limits.

## Build and verification

This is a Gradle project outside the pnpm workspace. A passing pnpm/Turbo run does
not verify Android. Use the JDK and Android SDK declared by the Gradle project,
README and `handheld-android` job in `.github/workflows/ci.yml`.

From `apps/handheld`:

```bash
./gradlew --no-daemon testDebugUnitTest lintDebug assembleDebug
```

Keep machine-specific SDK paths in ignored `local.properties`; never commit them.
Run focused Kotlin/Compose tests during iteration and the gates above before
completion. Emulator/Robolectric tests and a debug APK do not prove vendor scanner
support or production-device acceptance.

## Shared protocol and domain parity

- Handheld uses station-device authentication with device kind `handheld`.
  Preserve server-side device-kind restrictions and the distinction between
  device credentials and offline operator identity. Do not infer permission
  merely because a station API route exists or another client uses it.
- Kotlin KM parsing, inventory classification and batch digests must remain
  compatible with the TypeScript domain implementation. Do not independently
  normalize separators, canonical codes, JSON or hashing inputs.
- When those rules change, review and regenerate the affected tracked fixtures
  from the repository root, then test both producers and Android consumers:

```bash
pnpm --filter @markiro/domain fixtures:km
pnpm --filter @markiro/domain fixtures:inventory
pnpm --filter @markiro/domain fixtures:product-labels
```

Use only the generator relevant to the changed contract. Review generated changes
in `app/src/test/resources/`; do not hand-edit expected values to conceal a parity
failure. Domain fixture tests check the committed data against the generator;
Android tests must also verify its interpretation.

## Offline state and scanner integration

- Treat accepted scans, outbox events, device sequence and snapshot/digest state
  as durable facts. Preserve retry identity and per-record acknowledgements;
  do not recreate accepted events when retrying a batch or leaving a task.
- Android persistence is implemented under `core/storage/` in the application
  source. Inspect its upgrade path and pending queues before changing it; Station
  migrations under `packages/db` do not migrate the Android database.
- Preserve restart/resume of snapshot downloads and queues. Test disconnect,
  reconnect, process recreation and leave with pending work for affected flows.
- Vendor intents, keyboard wedge and debug scans are distinct input sources.
  Keep debug controls/debug HTTP restricted to debug builds; do not loosen the
  release configuration to make emulator testing easier.
- Ship Russian and English strings together using `res/values/strings.xml` and
  `res/values-en/strings.xml`. Keep fonts and required assets bundled for offline
  operation. Validate layout on the intended handheld screen as well as tests.

## Host mode

- `StationBackend` (`core/backend`) is the seam: `CloudBackend` forwards `StationApi`
  unchanged, `HostBackend` translates host answers into the same DTOs. Selection is
  by `device_config.backend`; the cloud OkHttp client has `BackendGuardInterceptor`
  first, so a host device cannot call the cloud.
- The host network layer (`core/network/host`) is HTTPS only, no proxy, no redirects,
  `MODERN_TLS`, with `PinnedTrust` comparing the SHA-256 of the leaf DER to the pinned
  fingerprint. System trust never applies. The observe-only client may send nothing but
  `GET /v1/hello` and exists only before the pairing code is sent. Never add cleartext
  or a debug-HTTP dependency to host mode; never log keys, codes, claim bodies or
  fingerprints.
- Host facts and pallet events are frozen once into `host_outbox` (`HostRecordFreezer`,
  `HostPalletEvents`) and resent as the same bytes by `HostSyncEngine`; during normal
  synchronization only receipts remove rows. The cloud `SyncEngine` returns early
  on a host device.
- Explicit cloud-import replacement uses `Hello.datasetEpoch`, independently of
  restore replay. Send only the process-start epoch in the pinned client. Detect
  changes before bootstrap or restore reconciliation, freeze recovery admission
  and persist `DATASET_RESET_PENDING`. Purge classified business tables only in a
  fresh process, atomically with the new epoch/generation. Retain credentials,
  device configuration, printers/assignments and hardware preferences; do not use
  revocation/sealing to reset business data. A failed reset stays blocked and
  retryable. Never expose a new epoch to old callbacks or resume old outboxes.
- Off in host mode: grants, replacement, inventory, write-offs, update checks, duplicate
  DataMatrix print (`STATION_UPDATE_REQUIRED`). Protocol fixtures are read from
  `apps/standalone/proto/fixtures` (test resources); never hand-edit expected values.
- Several devices in one shift (plan 2b, host protocol 7; the handheld stays at protocol 6 and Room stays at 22):
  every entry names `multi-station-v1` (`HostApi.ENTER_SUPPORTS`; an older host ignores the name and still answers
  `shift_busy`, shown as «Смена занята»). A full line is `409 shift_line_full {maxStations, active}`
  (`EnterResult.LineFull`); `HostCalls` carries the two numbers to the loaders. The host's `maxStations`,
  `participants`, `myState`, `totals` and `byDevice` are reduced to one JSON value per shift in `meta`
  (`shift_participation:<id>`, `ShiftParticipationStore`; also `shift_close_note:` for the receipts and
  `shift_leave_pending:` for owed leaves) and refreshed by the host heartbeat (`HostParticipation`, 15 s) while a
  shift is active. An answer older than the stored one (`as_of` guard) is refused unless the stored value is more
  than 60 s old; a beat that does not reach the host marks the value stale and the strip says «данные на ЧЧ:ММ».
- `SharedShiftRules` is the only place of the shift-wide total and of the reason rule, pinned by
  `proto/fixtures/shift-close-reason-shared.json`; never re-derive it. The handheld has no displaced kind, so
  `lost` is the shift's own conflicted/rejected codes (`CodeDao.lostForShift`); it is required in
  `SharedShiftRules` and wired in the strip, the hub card and `ShiftCloser`. The 90 s freshness applies only to
  the close reason, not to the strip.
- Leaving writes the local mark and an owed-leave marker in one commit, then asks the host. An owed leave is
  compare-and-cleared and settles only when the answer's `myState` is `left` or `closed` (in `ShiftRepository`; a
  `null` answer settles nothing) or not `active` (in the heartbeat's `flushLeaves`, whose answer always names a
  state), or on a definite refusal (`not_found`, `shift_not_entered`, `validation_failed`). An `active` answer
  while the row says the device is out keeps it owed; the answer's token is kept and the next beat resends with it.
  Each owed leave is sent independently, so one stuck leave never blocks the rest. A re-entry before it was sent
  (`leftAt = null`) makes `flushLeaves` drop it (`stillOut` is false); `rejoinLeftPart` only skips while a leave is
  owed. A leave tapped while that automatic rejoin is in flight is owed again after the entry (`oweLeaveIfOut` re-reads
  the row in the commit that keeps the answer), so the slot the rejoin took is freed on the next beat with the new
  token. `StationBackend.leave` has no default: every backend, the production `BackendSelector` included, answers it.
- A closed part reads back as `myState: closed` and `toShiftDto` maps it to `status = "closed"`; it never opens
  work again. A full line never stops local production. Receipts `partClosed`/`reasonMissing` are noted by
  `HostAckMapper`. Closing a shared part offline sends no reason (the host marks `close_reason_missing`, the
  office supplies it); a single-device shift keeps the hard refusal and the reason.
- Known gaps: no layout/short-screen tests for the strip (only Robolectric at `w360dp`); nothing was run on a device
  or emulator; the vendor scanner path is untouched; the token race of the owed-leave sender is untested; a null
  `asOf` is taken from the incoming answer where the station refuses it within 60 s; a non-closed answer without
  totals and nothing stored creates a row with null figures; the hub card shows the corrected total only for shared
  shifts.
