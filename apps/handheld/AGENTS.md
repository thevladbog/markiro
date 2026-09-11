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
