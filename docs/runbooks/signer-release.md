# Signer agent — cutting a stable release

This is how a signed Windows installer of the Chestny ZNAK signer agent reaches
a customer, and how an already-installed agent learns there is a newer one.

The signing path through CryptoPro is **not** exercised by anything here. That
is [`signer-agent-manual-e2e.md`](signer-agent-manual-e2e.md), and it should be
green before you cut a release, not after.

## What the release produces

Two targets, written in this order:

1. **The mirror** — `https://releases.markiro.app/signer/stable/`. The installer,
   its detached minisign signature, and `latest.json`. This is what a running
   agent polls.
2. **A GitHub Release** in `thevladbog/markiro`, tagged `signer-v<version>`,
   with the installer attached. This is the page to send a customer for a first
   install.

The mirror goes first on purpose. A failure between the two leaves clients with
a consistent, fetchable update; the reverse order would announce a release the
updater cannot download.

## Prerequisites

Everything lives in the **`station-release`** GitHub environment. Nothing is a
repository-level secret.

| Name                                        | Kind     | What it is                                                                 |
| ------------------------------------------- | -------- | -------------------------------------------------------------------------- |
| `SIGNER_TAURI_SIGNING_PRIVATE_KEY`          | secret   | The minisign private key that signs every update on every customer machine |
| `SIGNER_TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | secret   | Its password                                                               |
| `YANDEX_STATION_RELEASE_ACCESS_KEY_ID`      | secret   | Object storage credential, shared with the Station's releases              |
| `YANDEX_STATION_RELEASE_SECRET_ACCESS_KEY`  | secret   | Object storage credential                                                  |
| `YANDEX_STATION_RELEASE_BUCKET`             | variable | The bucket behind `releases.markiro.app`                                   |
| `YANDEX_STATION_RELEASE_ENDPOINT`           | variable | `https://storage.yandexcloud.net`                                          |

The matching **public** key is committed as `plugins.updater.pubkey` in
`apps/signer/src-tauri/tauri.conf.json`. It is not secret, and replacing it
strands every already-installed agent — an agent only accepts updates signed by
the key it shipped with.

The environment is protected by `required_reviewers`, so a dispatch waits for an
approval before the job starts. That is deliberate: the approval is the second
pair of eyes on a build that will install itself on customer machines.

## Cutting a release

1. On `main`, bump `version` in `apps/signer/src-tauri/tauri.conf.json`. That
   field is the single source of the release version and of the tag; nothing
   else names it. The workflow **refuses** a version whose tag already exists
   rather than overwriting it, because replacing a published artifact breaks
   the signature clients already trust.
2. Dispatch **Publish signer stable** from `main` and type
   `PUBLISH-SIGNER-STABLE` into `owner_confirmation`. Only the repository owner
   may dispatch.
3. Approve the `station-release` environment when GitHub asks.

The job then runs the tooling contract, the signer's tests, typecheck, lint and
`cargo test`, builds with `--config src-tauri/tauri.stable.conf.json`, signs,
uploads, reads the uploads back over public HTTPS and compares SHA-256, and
only then creates the GitHub Release.

## What to check afterwards

```bash
curl -s https://releases.markiro.app/signer/stable/latest.json
```

- `version` is the version you bumped to.
- `platforms."windows-x86_64".url` is under `signer/stable/releases/<version>/`
  and downloads.
- `gh release view signer-v<version>` shows the `-setup.exe` attached.

The workflow already verified the bytes; this is confirming the _right thing_
was published, which no automated check can do for you.

## Verifying the update path end to end

Do this once per release on a Windows machine. It is the part nobody works out
under pressure, and it is the only check that covers the whole loop.

1. Install the **previous** stable version and pair it with a tenant.
2. Cut the new release as above.
3. Open the agent's window. Within a moment it offers the new version and
   raises one tray notification.
4. **Confirm nothing has installed yet.** The agent must still be signing, on
   the old version, until someone presses the button. Installing restarts the
   agent, and the agent is what keeps the tenant's True API token fresh — a
   restart the operator did not ask for presents to the cabinet as an
   integration that went quiet, which is indistinguishable from a fault.
5. Press **Обновить и перезапустить**. The agent installs, relaunches on the
   new version, and stays paired.

## When it fails

| Failed at                        | State                                                                        | What to do                                                                                                                           |
| -------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `authorize`, or the version gate | Nothing published                                                            | Fix the input or bump the version; re-dispatch                                                                                       |
| The build or the signing step    | Nothing published                                                            | Fix and re-dispatch; no cleanup needed                                                                                               |
| Publish to the mirror            | Artifacts may be uploaded with no `latest.json` naming them                  | Inert — no agent looks at them. A successful re-dispatch of the same version overwrites them                                         |
| Read-back verification           | Artifacts on the mirror do not match what was built                          | Do **not** create the release by hand. Re-dispatch; if it fails twice, the mirror or its CDN is the problem                          |
| Announce the GitHub Release      | The mirror is live, so clients **will** update, but there is no release page | Create the release by hand from the built installer. Do not re-dispatch: the tag gate will refuse, and the mirror is already correct |

A failed _update check_ on an installed agent is not an incident. It is logged
to the console and the agent keeps signing; losing token refresh because a
mirror was unreachable would be far worse than running an old build.

## Rolling back

There is no rollback tooling, deliberately. One tray agent per tenant does not
earn a staged rollout. To recover, install a prior version's `-setup.exe` from
its GitHub Release. Note that the agent will then offer the newer version again
on its next daily check, so a rollback is a stopgap until a fixed version is
published — bump and cut a new one rather than living on a downgraded install.
