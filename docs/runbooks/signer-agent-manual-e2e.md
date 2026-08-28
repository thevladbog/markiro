# Signer agent — manual end-to-end verification

The signing path cannot be exercised in CI: it needs CryptoPro CSP, a GOST
certificate with a private key, and a live True API sandbox account. Run this
once per release candidate on a Windows machine that has all three.

**Before the first manual session:** `signer_capi.rs`, `storage_dpapi.rs`, and
`signer_cades.rs` are Windows-only (`#[cfg(windows)]`) and have never been
compiled or executed anywhere except locally by their author — the
`signer-windows-build` CI job (`.github/workflows/ci.yml`) is the first thing
that builds and tests them on a real Windows runner. Check that job is green
before scheduling a manual session; a red `signer-windows-build` is the
expected first signal of a problem, and it is cheaper to fix there than to
discover the same failure by hand.

## Prerequisites

- Windows 10/11 with CryptoPro CSP installed and a valid test certificate in
  the current user's **Личное / MY** store.
- A Markiro tenant with the Chestny ZNAK integration enabled and its
  `environment` setting set to `sandbox`.
- `CHZ_TOKEN_ENCRYPTION_KEY` configured on the API instance, otherwise the
  scheduler pauses and no task is ever enqueued.

## One-time setup: the updater signing key

The app ships with a placeholder `plugins.updater.pubkey` value
(`REPLACE_WITH_SIGNER_MINISIGN_PUBLIC_KEY`) in
`apps/signer/src-tauri/tauri.conf.json`. This is intentional: generating and
holding the updater's private key is a product-owner action, not something an
agent session should do, because whoever runs the keygen command ends up
holding (even briefly) the private key material and must be the one who
stores it as a repository secret. Do this once, before the first signed
release build (it is not required for the manual sandbox verification below,
which only needs `tauri build`, not a signed updater artifact):

1. Run, on a trusted machine, from the repo root:

   ```bash
   pnpm --filter @markiro/signer exec tauri signer generate -w ~/.markiro/signer-updater.key
   ```

   This prints a public key and writes the private key + password to
   `~/.markiro/signer-updater.key` (and prompts for or generates a password —
   keep it).

2. Replace `REPLACE_WITH_SIGNER_MINISIGN_PUBLIC_KEY` in
   `apps/signer/src-tauri/tauri.conf.json` (`plugins.updater.pubkey`) with the
   printed public key, and commit that change on its own.

3. Store the private key file's contents and its password as two GitHub
   repository secrets, never committed:
   - `SIGNER_TAURI_SIGNING_PRIVATE_KEY` — the contents of
     `~/.markiro/signer-updater.key`.
   - `SIGNER_TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the password chosen in
     step 1.

4. Delete the local private key file once it is safely stored, or keep it in
   a password manager — do not leave it on disk on a shared machine.

Until this is done, `tauri.stable.conf.json` and `tauri.conf.json` correctly
have no working updater signature, and
`apps/signer/test/tauri-release-config.test.ts` is written to pass either way
(it only asserts that a pubkey string is present in the base config, not that
it is real).

## Steps

1. Build the agent: `pnpm turbo build --filter '@markiro/signer...'` then
   `pnpm --filter @markiro/signer tauri build`. Install the NSIS package.
2. In the Markiro cabinet open **Интеграции → Честный ЗНАК** and press
   **Получить код привязки**.
3. In the agent's tray window enter the eight-digit code. Expect the tenant
   name to appear within a few seconds.
4. Choose the GOST certificate in the picker. The list only shows certificates
   with a private key and a GOST public key.
5. Force a refresh: in the cabinet, revoke nothing — instead wait for the
   scheduler (runs every 15 minutes) or delete the tenant's `chz_api_tokens`
   row so the next tick enqueues a task immediately.
6. Watch the agent journal. A healthy run reads: _Task received_ → _True API
   token delivered_.
7. Confirm in the cabinet that the token status shows **действует** with an
   expiry roughly ten hours out.

## The signature-format verdict

Step 6 is the decision point for the signing backend. Both backends already
ship in this codebase — `signer_capi.rs` (CryptoAPI, `CryptSignMessage`,
selected by default) and `signer_cades.rs` (CAdESCOM, selected by setting the
environment variable `MARKIRO_SIGNER_BACKEND=cades` before launching the
agent; see `signer_backend.rs`). CAdESCOM additionally requires the CryptoPro
CAdES SDK / browser plug-in installed on top of the CSP. There is no code to
write here — this step is purely about recording which backend ГИС МТ
actually accepts:

- **`True API token delivered`** — the current backend's signature was
  accepted. Record which backend that was (CryptoAPI is the default; only
  count as CAdESCOM if `MARKIRO_SIGNER_BACKEND=cades` was set for this run)
  and the verdict below. No further action needed.
- **`Signing failed` with a `TRUE_API` code mentioning the signature** — the
  attached-CMS shape from CryptoAPI was rejected. Set
  `MARKIRO_SIGNER_BACKEND=cades` (confirm the CAdES SDK is installed), repeat
  from step 5, and record the second attempt's verdict as well. If CAdESCOM
  is also rejected, stop and escalate — do not extend or fork the signing
  code as part of this runbook.

Record the date, the CryptoPro version, and the verdict below.

| Date | CryptoPro version | Backend | Verdict |
| ---- | ----------------- | ------- | ------- |
|      |                   |         |         |

## Failure cases worth exercising

- Pull the Rutoken mid-run: the journal must show
  `CRYPTO_CONTAINER_UNAVAILABLE` and the cabinet journal must show the same
  code — not a generic error.
- Revoke the agent in the cabinet: the tray window must return to the pairing
  screen on the next poll, and `%APPDATA%\app.markiro.signer\signer.json` must
  no longer contain `agentSecretProtected`.
- Stop the API: the agent must back off and recover on its own once the API
  returns, without failing the claimed task.
