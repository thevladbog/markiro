# Signer Release, Update, Connectivity, and Tray Resilience — Design Spec

**Date:** 2026-09-01

**Status:** Approved

**Scope:** Move future stable Signer releases into the Station distribution repository, remove source-version-only pull requests, make update checks explicitly available in the client while preserving operator consent, suppress transient polling noise for five minutes, and expose the resulting runtime state through a compact tray badge.

## Outcome

The Signer remains a quiet Windows background agent. It updates only when an operator asks it to, tolerates short deployment and network interruptions without alarming the operator, and makes persistent loss of service visible once per incident. Stable release artifacts are stored with Station artifacts in `thevladbog/markiro-station-releases`, while the public Yandex mirror remains the installation and updater channel.

The release workflow owns the released semantic version. A release no longer requires a pull request that changes only `tauri.conf.json`. The version embedded in the Windows package, updater manifest, filenames, User-Agent, journal export, and GitHub tag is still identical for a given release.

## Current behavior being changed

- `.github/workflows/signer-stable-release.yml` reads the version committed in `apps/signer/src-tauri/tauri.conf.json` and publishes `signer-v<version>` into the source repository.
- The Yandex stable mirror already publishes immutable versioned artifacts, a signed `latest.json`, and the versionless `/signer/download` installer. This remains the client-facing channel.
- The React client already checks for updates at startup and once per day and installs only after an operator presses the install button. It has no explicit "check now" action and collapses "up to date" and "check failed" into the same `null` result.
- Every polling transport failure immediately emits `Degraded`. The Tauri shell sends a notification for every degraded status callback, so a deployment or short network interruption can create repeated alerts.
- The tray uses one static application icon and does not expose agent state.

## Release destinations and history

Future stable tags matching `signer-v<major>.<minor>.<patch>` are created in `thevladbog/markiro-station-releases`, alongside the Station's `station-v*` tags. The prefixes keep the two products unambiguous.

Existing Signer releases `signer-v0.1.0` through `signer-v0.1.4` remain in `thevladbog/markiro`. They are immutable history and existing links must not be deleted or redirected. The first release in the distribution repository is the first version produced by the new workflow.

The Yandex mirror remains authoritative for:

- `https://releases.markiro.app/signer/stable/latest.json`;
- immutable updater artifacts under `/signer/stable/releases/<version>/`;
- the public versionless installer at `https://releases.markiro.app/signer/download`.

The installed client never needs GitHub credentials. Making the distribution repository private later therefore does not break installation or updates.

## Workflow-owned versions

The stable workflow receives:

- `mode`: `publish` or `repair`;
- `bump`: `patch`, `minor`, or `major`, defaulting to `patch` and used only by `publish`;
- the existing owner confirmation string.

For `publish`, the workflow reads stable state from both channels:

1. the highest non-draft `signer-v*` release in `thevladbog/markiro-station-releases`;
2. the validated Yandex stable `latest.json` version, if present.

If both channels have a version, they must agree. The one migration exception is an empty distribution repository paired with the already published Yandex `0.1.4` baseline; that state calculates `0.1.5` without copying historical releases. Any other state where only one channel has the newest version refuses a new release and directs the owner to `repair`. This prevents a partial publication from being skipped by an automatic bump.

The next version is calculated from the agreed version using the selected semantic bump. The workflow writes that version into a temporary Tauri configuration overlay in `$RUNNER_TEMP`. It does not commit or push a version change to `main`. The release contract verifies the effective merged Tauri configuration before packaging.

The base `tauri.conf.json` retains a valid development version but is no longer a release ledger. `tools/signer-release/version.mjs` becomes the source for parsing, comparing, and bumping release versions and for producing the temporary override.

## Publication and recovery

Publication uses the built artifacts as the immutable unit of recovery:

1. Authorize the owner and validate secrets, inputs, source `main` SHA, and channel agreement.
2. Calculate the next version and create the temporary version overlay.
3. Run Signer build, test, typecheck, lint, Cargo tests, and the release contract.
4. Build and sign the Windows NSIS installer with the effective version.
5. Create a draft GitHub release in the distribution repository and upload the installer, detached updater signature, updater manifest, checksums, and release evidence containing the source repository and exact source SHA.
6. Publish immutable versioned objects to Yandex and verify their hashes over public HTTPS.
7. Advance the Yandex `latest.json` and versionless installer only after immutable verification succeeds.
8. Publish the prepared GitHub draft.

The draft retains the exact signed bytes if a later publication step fails. `repair` resumes from those bytes; it never rebuilds or replaces an immutable version.

`repair` validates the draft assets, checksums, signatures, release evidence, and existing Yandex state. It then completes only the missing side:

- Yandex ahead, GitHub draft present: verify Yandex and publish the draft;
- GitHub draft ahead, Yandex pointer absent: publish and verify those exact draft assets to Yandex, advance the pointer, then publish the draft;
- both already complete and identical: exit successfully without mutation;
- bytes, version, evidence, or signatures disagree: fail closed and require investigation.

The cross-repository GitHub calls use `STATION_RELEASE_REPOSITORY_TOKEN`, as the Station workflows do. The source workflow keeps `contents: read`; it does not need permission to write releases into the source repository.

## Client update experience

Update checks have two triggers with different presentation:

- background: at startup and once every 24 hours; failures remain quiet;
- manual: the operator presses `Проверить обновления`; the result is shown in the window.

The update service returns a discriminated result rather than `SignerUpdate | null`:

- `available` with version, notes, and an install function;
- `current` when no newer version exists;
- `failed` with an operator-safe message while retaining the technical detail in the local journal/console boundary.

Only one check may run at a time. The manual button is disabled and displays `Проверяем…` while the shared request is pending.

The status screen displays the installed version and the manual check action. A found update is shown in the existing banner with `Установить и перезапустить`. Download, installation, and relaunch occur only after that second explicit operator action. There is no automatic installation and no automatic restart.

An update check or download failure cannot stop polling or signing. A failed installation leaves the update banner available for retry.

## Polling incident model

The five-minute grace period applies only to transport failures while polling the Markiro cloud. It does not defer:

- agent revocation or authentication failure;
- invalid local configuration or unreadable DPAPI credentials;
- certificate, CryptoPro, PIN, signing, True API, or task-report failures.

Runtime connectivity has these states:

- `connected`: the latest poll completed successfully;
- `reconnecting`: at least one polling transport failure has occurred, for less than five continuous minutes;
- `unavailable`: polling transport failures have continued for five minutes or more.

The incident starts at the first polling transport failure using monotonic time. It ends only after a successful poll response, including a successful empty long-poll response. Backoff continues with the existing two-to-sixty-second bounds.

Journal behavior is transition-based:

- first failure: one `Connection interrupted; reconnecting` entry;
- retry attempts during the grace period: no repeated user-facing entries;
- five-minute threshold: one `Connection unavailable for five minutes` entry with the latest safe error detail;
- recovery: one `Connection restored` entry with incident duration and attempt count.

The window may show a quiet `Переподключение` state immediately, but no error alert or operating-system notification appears before the threshold. At the threshold it shows `Нет связи` and emits exactly one notification for that incident.

Immediate task errors keep their existing degraded behavior and are not routed through the polling incident timer.

## Tray indicator

The base Signer icon remains unchanged. A small circular badge is composited over its lower-right corner with a contrasting one-pixel outline so it remains visible against both light and dark Windows taskbars.

States:

| Runtime state                   | Badge  | Motion                           | Tooltip                                        |
| ------------------------------- | ------ | -------------------------------- | ---------------------------------------------- |
| Unpaired                        | Gray   | Static                           | `Markiro Подписант — не привязан`              |
| Connected / idle                | Green  | Static                           | `Markiro Подписант — работает`                 |
| Working                         | Blue   | Gentle two- or three-frame pulse | `Markiro Подписант — выполняет подпись`        |
| Reconnecting under five minutes | Yellow | Static                           | `Markiro Подписант — переподключение`          |
| Unavailable for five minutes    | Red    | Static                           | `Markiro Подписант — нет связи`                |
| Installing update               | Blue   | Gentle pulse                     | `Markiro Подписант — устанавливает обновление` |

Persistent states never animate. Motion is reserved for bounded active work, avoids rapid flashing, and stops when the state changes. Tooltip text carries the same meaning as the color, so status is not color-only.

The Tauri shell owns the icon state because it owns the native tray. It keeps a handle to the tray icon, maps `AgentStatus` transitions to badge frames and tooltips, and compares the previous alert category before sending a notification. Repeated callbacks in the same category do not repeat notifications. Returning to a healthy state resets the gate so a later independent incident can notify once.

## Testing and acceptance

### Release contracts

- semantic bump tests for patch, minor, and major;
- malformed and prerelease tag rejection;
- channel agreement, split-brain refusal, and first-release behavior;
- temporary Tauri version overlay generation;
- workflow-shape tests pinning the distribution repository, cross-repository token, draft-before-Yandex ordering, immutable verification, pointer-last behavior, and `repair` path;
- repair tests proving exact-byte reuse and disagreement refusal.

### Client tests

- manual check reports current, available, and failed states;
- background failure stays quiet;
- concurrent checks coalesce and the button remains disabled until completion;
- an available update never installs before the operator presses the install button;
- installation failure remains retryable.

### Runtime tests

- first polling transport failure enters reconnecting without degraded notification;
- repeated failures below five minutes remain one incident;
- crossing five minutes enters unavailable exactly once;
- successful empty and task-bearing polls recover the incident;
- a later independent incident can notify once again;
- revocation and actionable signing failures remain immediate;
- monotonic time is injected or abstracted so tests do not sleep for five minutes.

### Tray tests and external proof

- pure mapping tests cover every runtime state, badge asset, motion mode, and tooltip;
- notification transition tests prove deduplication and reset after recovery;
- Rust host tests prove state mapping, not Windows rendering;
- final acceptance requires a Windows installation to verify 16/20/24-pixel tray rendering, light and dark taskbars, animation cadence, manual update installation, relaunch, and continued pairing/configuration.

## Rollout

The implementation lands without a source version bump. The next stable dispatch uses the new workflow and creates the first Signer release in the distribution repository. Before dispatch, verify `STATION_RELEASE_REPOSITORY_TOKEN` can write release contents there.

After release, verify:

1. GitHub and Yandex expose the same version and hashes;
2. `/signer/download` resolves to that installer;
3. an installed older Signer finds the version through both background and manual checks;
4. installation occurs only after confirmation and relaunches successfully;
5. a controlled network interruption shorter than five minutes produces no notification;
6. a longer interruption produces one notification and recovery restores the green badge.

## Out of scope

- Silent or mandatory updates.
- A Signer beta channel or beta-to-stable promotion.
- Deleting or migrating historical releases from the source repository.
- Making the distribution repository private as part of this change.
- Changing the cloud-side five-minute `lastSeenAt` semantics or token refresh scheduler.
- macOS or Linux packaging.
