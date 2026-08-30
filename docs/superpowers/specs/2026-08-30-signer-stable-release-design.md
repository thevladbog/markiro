# Signer Agent Stable Release — Design Spec

**Date:** 2026-08-30

**Status:** Implemented; extended with the versionless first-install alias on 2026-08-31

**Scope:** Publishing a signed, installable Windows build of the Chestny ZNAK signer agent, and teaching the installed agent to update itself. One channel, `stable`.

## Why this is the last thing missing

The agent itself has shipped: `signer-core` with both signing backends, DPAPI secret storage, the Tauri tray shell, and a CI job that compiles the Windows-only modules and runs their tests. What has never existed is a way to get it onto a customer's machine.

`ci.yml`'s `signer-windows-build` runs `tauri build --debug --no-bundle` — deliberately, because its job is to prove the Windows code compiles, not to produce artifacts. There is no release workflow for `apps/signer`, unlike the Station's two. And `apps/signer/src-tauri/tauri.conf.json` still carries `"pubkey": "REPLACE_WITH_SIGNER_MINISIGN_PUBLIC_KEY"`, left as an owner action because an updater signing key is what authenticates every future update on a customer's machine and had no business being generated inside a coding session.

So the token refresh that three merged slices depend on runs, today, only where someone has built the agent from source.

## What is not being rebuilt

The Station's release machinery is two workflows totalling 93 KB over fourteen tooling modules: beta→stable promotion, dual-origin acceptance, rollback baselines, seeded legacy migration. Almost none of that is warranted here.

The Station is a fleet of terminals where a bad build strands a production line, so it earns a staged rollout. The signer agent is one tray application on one machine per tenant, whose failure mode is "the token stops refreshing" — visible in the integrations panel within minutes and recoverable by reinstalling. It gets one channel.

`tools/station-release/object-storage.mjs` is likewise not reusable: it validates that every key begins with `station` and throws otherwise. Only `normalize-signing-key.mjs` is generic, and it is reused as-is.

## Where the release goes

`releases.markiro.app` is the existing Yandex Object Storage mirror the Station already publishes to under `station/`. The signer publishes under `signer/stable/` in the same bucket, reusing `YANDEX_STATION_RELEASE_ACCESS_KEY_ID` and `YANDEX_STATION_RELEASE_SECRET_ACCESS_KEY` — this is the owner's decision, on the grounds that a separate service account would draw a boundary nobody needs between two artifacts of the same product.

**The channel split already exists in the app and is left alone.** `apps/signer/src-tauri/tauri.conf.json` carries the beta endpoint and the pubkey; `tauri.stable.conf.json` is an overlay that only overrides the endpoint to `signer/stable/latest.json`, and `apps/signer/test/tauri-release-config.test.ts` pins both. The release builds with `--config src-tauri/tauri.stable.conf.json`, exactly as the Station's stable workflow does.

"One channel" therefore means one release workflow, not one config: nothing publishes to `signer/beta/` and no agent is configured to read it, but the two-file arrangement the agent already ships costs nothing to keep and is what a future beta channel would need.

Two targets:

- **the mirror** — the installer, the updater artifacts and `latest.json`, which is what the running agent reads, plus `https://releases.markiro.app/signer/download`, the versionless stable URL shown in the cabinet;
- **a GitHub Release** — the installer attached and release notes pointing to the same versionless URL.

There is no beta alias. A stable publication copies the exact immutable signed
installer to `signer/download` and publicly verifies both URLs before advancing
`latest.json`. A separate owner-gated workflow can rebuild only this alias from
the exact installer named by the current validated stable manifest; it neither
creates nor changes a release and exists for bootstrap and recovery.

**The mirror is written first.** The updater endpoint reads from it, so a failure after the mirror but before GitHub leaves clients with a consistent, fetchable update; the reverse order would announce a release the updater cannot download.

## The workflow

`workflow_dispatch` only. A release is a deliberate act, and there is nothing about a merge to `main` that should ship one. Gated the way the Station's is: a typed confirmation string, and a check that the dispatching actor is the repository owner.

Build on `windows-latest` with `tauri build` — no `--no-bundle`, unlike CI. `createUpdaterArtifacts` is already true, so the build yields the NSIS installer plus the `.nsis.zip` and its `.sig`.

**The version has one source:** `tauri.conf.json`'s `version`. The workflow reads it, refuses to proceed if a release for that tag already exists, and tags `signer-v<version>`. Refusing rather than overwriting matters because a re-dispatch after a partial failure is the normal way this workflow will be used, and silently replacing a published artifact would break the signature clients already trust.

`latest.json` is the Tauri updater manifest: the version, the publication date, the signature read from the `.sig` file, and the mirror URL of the `.nsis.zip`.

**Verification before announcing.** After upload, the workflow reads `latest.json` and the artifact back over public HTTPS and compares SHA-256 against what it uploaded. The Station does this, and it is the step that catches a truncated or half-propagated upload — the failure that otherwise reaches a customer as a broken update rather than a red build.

## Updating an installed agent

The plugin is registered and nothing calls it. This adds the call.

The agent checks at startup and once every 24 hours. When an update exists it raises a tray notification and waits for **explicit operator confirmation** before downloading and installing.

Never silently: installing restarts the agent, and the agent is what keeps the tenant's True API token fresh. A restart the operator did not ask for, in the middle of a working day, presents to the cabinet as an integration that went quiet — indistinguishable from a fault, at the moment the operator has least reason to suspect an update.

A failed check is journalled and never fatal. An agent that cannot reach the mirror must keep signing; losing token refresh because an update check failed would be a far worse outcome than running an old build.

## Errors

- **Refuse before doing anything** — wrong actor, wrong confirmation string, a tag that already exists, a missing signing secret. All are checked before the build starts, so a misdispatch costs seconds rather than a Windows build.
- **Build or signing failure** — the workflow fails with nothing published. There is no partial state to clean up because nothing has been uploaded yet.
- **Mirror upload failure** — fails before the GitHub Release exists, so the two targets cannot disagree. A re-dispatch re-uploads; object storage puts are idempotent for the same version.
- **Verification failure** — the artifacts are on the mirror but do not match. The workflow fails loudly and does **not** create the GitHub Release, because `latest.json` is what the updater reads and a mismatch means clients would fetch something that fails signature validation.

## Testing

The YAML stays thin; the logic lives in `tools/signer-release/*.mjs` with node tests, which is how the Station's release tooling is arranged and why its workflows are testable at all.

- The manifest builder: the shape `latest.json` must have, the signature read from the `.sig`, and a URL that matches the endpoint the agent is configured to poll — a manifest that points somewhere the agent does not look is the defect most likely to ship unnoticed.
- The version gate: a tag that already exists refuses; a fresh one proceeds.
- The object-storage helper: keys are confined to the `signer/` prefix, mirroring the guard that makes the Station's helper safe.
- A workflow-shape test, following `tools/station-release/test/stable-workflow.test.mjs`, pinning the owner gate, the dispatch inputs, and the mirror-before-GitHub ordering — the ordering is a correctness property and belongs in a test rather than a comment.
- The updater wiring: vitest in `apps/signer`, covering that a check failure does not stop the agent, and that nothing installs without confirmation.

## What the owner must do, and why it cannot be automated

1. Generate a minisign keypair with `tauri signer generate` and set `SIGNER_TAURI_SIGNING_PRIVATE_KEY` and `SIGNER_TAURI_SIGNING_PRIVATE_KEY_PASSWORD` as repository secrets. The private key signs every future update on every customer machine; it must never exist in a session transcript, a log, or a file this repository can read.
2. Supply the public key, which replaces the placeholder in `tauri.conf.json`. It is not secret and is committed.

Until both are done the workflow can be written, reviewed and its tooling tested, but a dispatch will refuse at the secret check.

## Out of scope

- A beta channel and beta→stable promotion. One tray app per tenant does not earn a staged rollout; if that changes, the Station's promotion model is the precedent to copy.
- Rollback tooling. Reinstalling a prior GitHub Release asset is the recovery path, and it is adequate for a single-machine agent.
- macOS or Linux builds. The agent is Windows-only by design — CryptoPro and DPAPI have no counterpart elsewhere.
- Auto-update of the Station. It has its own release workflows and is not touched.
- Publishing to any store or registry.
