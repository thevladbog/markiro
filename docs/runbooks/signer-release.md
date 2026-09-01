# Signer agent — cutting a stable release

This is how a signed Windows installer of the Chestny ZNAK signer agent reaches
a customer, and how an already-installed agent learns there is a newer one.

The signing path through CryptoPro is **not** exercised by anything here. That
is [`signer-agent-manual-e2e.md`](signer-agent-manual-e2e.md), and it should be
green before you cut a release, not after.

## What the release produces

Two targets, completed in this order:

1. **A draft GitHub Release** in `thevladbog/markiro-station-releases`, tagged
   `signer-v<version>`. It holds the installer, detached signature,
   `latest.json`, `SHA256SUMS`, and source-SHA evidence. The draft preserves
   the exact signed bytes if publication is interrupted.
2. **The mirror** — `https://releases.markiro.app/signer/stable/`. This is what
   a running agent polls. The mirror also exposes the versionless first-install
   URL `https://releases.markiro.app/signer/download`.
3. **The published GitHub Release** — the draft is made public only after the
   mirror and both mutable pointers have been read back and verified.

Send customers the versionless URL, not an immutable path containing a version.
Each stable release server-side copies the exact signed installer to
`signer/download`, reads both URLs back over public HTTPS, and only then advances
`latest.json`. There is no beta download alias.

The GitHub draft goes first but is not an announcement. It is the recovery
source. The mirror goes live before the draft is published, so clients never
see a release page whose updater bytes are unavailable.

The packaged agent calls `/signer-agent/*` directly on
`https://admin.markiro.app`. The production edge proxies that namespace to the
API and the public smoke sends an empty, invalid pairing body expecting the
API's JSON `400`. This proves routing without creating an agent or consuming a
real pairing code.

## Prerequisites

Everything lives in the **`station-release`** GitHub environment. Nothing is a
repository-level secret.

| Name                                        | Kind     | What it is                                                                         |
| ------------------------------------------- | -------- | ---------------------------------------------------------------------------------- |
| `SIGNER_TAURI_SIGNING_PRIVATE_KEY`          | secret   | The minisign private key that signs every update on every customer machine         |
| `SIGNER_TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | secret   | Its password                                                                       |
| `STATION_RELEASE_REPOSITORY_TOKEN`          | secret   | Fine-grained token with release Contents read/write in the distribution repository |
| `YANDEX_STATION_RELEASE_ACCESS_KEY_ID`      | secret   | Object storage credential, shared with the Station's releases                      |
| `YANDEX_STATION_RELEASE_SECRET_ACCESS_KEY`  | secret   | Object storage credential                                                          |
| `YANDEX_STATION_RELEASE_BUCKET`             | variable | The bucket behind `releases.markiro.app`                                           |
| `YANDEX_STATION_RELEASE_ENDPOINT`           | variable | `https://storage.yandexcloud.net`                                                  |

The matching **public** key is committed as `plugins.updater.pubkey` in
`apps/signer/src-tauri/tauri.conf.json`. It is not secret, and replacing it
strands every already-installed agent — an agent only accepts updates signed by
the key it shipped with.

The environment is protected by `required_reviewers`, so a dispatch waits for an
approval before the job starts. That is deliberate: the approval is the second
pair of eyes on a build that will install itself on customer machines.

The bucket's policy lives in `infra/yandex/modules/station-releases/main.tf`
and grants the publisher **and the public** both `station/*` and `signer/*`.
The public grant matters as much as the write grant: without it the workflow's
read-back fails and, worse, the agent's updater could never fetch
`latest.json` — a release that goes green and silently never reaches anyone.
The module is still named `station-releases` because renaming it would change
the terraform address and destroy the bucket; it serves both products.

## Cutting a release

1. Dispatch **Publish signer stable** from `main` with `mode=publish`.
2. Select `bump=patch`, `minor`, or `major`; `patch` is the default. The
   workflow reads the current GitHub/Yandex stable state, calculates the next
   version, and injects it into the build without committing a version-only PR.
3. Type `PUBLISH-SIGNER-STABLE` into `owner_confirmation`. Only the repository
   owner may dispatch.
4. Approve the `station-release` environment when GitHub asks.

The job then runs the tooling contract, the signer's tests, typecheck, lint and
`cargo test`, builds with `--config src-tauri/tauri.stable.conf.json`, signs,
creates the draft, uploads the exact prepared assets, reads the mirror back over
public HTTPS, compares SHA-256, advances the public pointers, and only then
publishes the GitHub Release.

The base `tauri.conf.json` version is a development value, not the stable
release ledger. Do not open a pull request merely to change it.

## Repairing an interrupted stable publication

If **Publish signer stable** leaves a draft `signer-v*` release, do not choose a
new bump and do not rebuild. Dispatch the same workflow with `mode=repair` and
approve `station-release`.

Repair requires exactly one pending Signer draft. It downloads and validates
all five draft assets, publishes those exact bytes to the missing Yandex side,
verifies the public hashes, and publishes the draft. Any checksum, signature,
source evidence, or channel-state disagreement fails closed.

## Repairing the versionless download

Use **Repair signer stable download alias** only when `signer/download` is
missing or does not match the installer named by the current stable manifest.
Dispatch it from `main`, type `REPAIR-SIGNER-DOWNLOAD`, and approve the
`station-release` environment.

The repair does not build, tag, or publish a new release. It validates the
public `signer/stable/latest.json`, requires its URL to be the exact immutable
installer for that manifest version, copies that object to `signer/download`,
and compares the public bytes. This is also the bootstrap path for stable
releases published before the versionless URL existed.

## What to check afterwards

```bash
curl -s https://releases.markiro.app/signer/stable/latest.json
curl -fL -o /dev/null https://releases.markiro.app/signer/download
```

- `version` is the version calculated from the selected bump.
- `platforms."windows-x86_64".url` is under `signer/stable/releases/<version>/`
  and downloads.
- `signer/download` downloads the same bytes as that immutable installer.
- `gh release view signer-v<version> --repo thevladbog/markiro-station-releases`
  shows the complete five-file evidence set.

The workflow already verified the bytes; this is confirming the _right thing_
was published, which no automated check can do for you.

## Verifying the update path end to end

Do this once per release on a Windows machine. It is the part nobody works out
under pressure, and it is the only check that covers the whole loop.
Record the complete Windows-only client and tray checks from
[`signer-windows-acceptance.md`](signer-windows-acceptance.md) at the same time.

1. Install the **previous** stable version and pair it with a tenant.
2. Cut the new release as above.
3. Open the agent's window and press **Проверить обновления**. Confirm that it
   offers the new version and raises no duplicate tray notification if the
   quiet background check found the same release first.
4. **Confirm nothing has installed yet.** The agent must still be signing, on
   the old version, until someone presses the button. Installing restarts the
   agent, and the agent is what keeps the tenant's True API token fresh — a
   restart the operator did not ask for presents to the cabinet as an
   integration that went quiet, which is indistinguishable from a fault.
5. Press **Обновить и перезапустить**. The agent installs, relaunches on the
   new version, and stays paired.

## When it fails

| Failed at                         | State                                                                        | What to do                                                                                                             |
| --------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `authorize`, or the version gate  | Nothing published                                                            | Fix the input or channel disagreement; use `repair` when a draft exists                                                |
| The build or the signing step     | Nothing published                                                            | Fix and re-dispatch; no cleanup needed                                                                                 |
| Draft creation or upload          | An absent or incomplete draft; public pointers unchanged                     | Inspect/delete an empty draft only with owner approval; otherwise use `repair`, which validates the complete asset set |
| Publish or read-back verification | A complete GitHub draft; public pointers may still name the previous version | Dispatch `mode=repair`; never rebuild or upload replacement bytes                                                      |
| Publish the GitHub draft          | The mirror may already be live while the GitHub release remains a draft      | Dispatch `mode=repair`; it verifies both sides and publishes the existing draft                                        |
| Repair download alias             | The current stable release is unchanged and the workflow is red              | Do not copy by hand. Fix the manifest/mirror issue and re-dispatch the protected repair workflow                       |

A failed _update check_ on an installed agent is not an incident. It is logged
to the console and the agent keeps signing; losing token refresh because a
mirror was unreachable would be far worse than running an old build.

## Rolling back

There is no rollback tooling, deliberately. One tray agent per tenant does not
earn a staged rollout. To recover, install a prior version's `-setup.exe` from
its GitHub Release in `thevladbog/markiro-station-releases` (or the historical
source-repository release for versions through `0.1.4`). The agent will then offer the newer version again
on its next daily check, so a rollback is a stopgap until a fixed version is
published — bump and cut a new one rather than living on a downgraded install.
