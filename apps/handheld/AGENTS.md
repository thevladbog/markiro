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
  `HostPalletEvents`) and resent as the same bytes by `HostSyncEngine`; only receipts
  remove rows. The cloud `SyncEngine` returns early on a host device.
- Off in host mode: grants, replacement, inventory, write-offs, update checks, duplicate
  DataMatrix print (`STATION_UPDATE_REQUIRED`). Protocol fixtures are read from
  `apps/standalone/proto/fixtures` (test resources); never hand-edit expected values.
