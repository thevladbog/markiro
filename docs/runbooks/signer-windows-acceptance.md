# Signer Windows acceptance

Use this checklist for every Signer release that changes polling, updates,
notifications, tray presentation, CryptoAPI, or local credential handling.
Automated host tests do not exercise Windows tray scaling, DPAPI, CryptoAPI,
NSIS installation, or process relaunch.

Record the tested release, Windows build, taskbar scaling, light/dark mode,
operator, date, and result next to the release evidence.

## Setup

1. Install the previous stable Signer through
   `https://releases.markiro.app/signer/download` on the Windows acceptance PC.
2. Pair it with a test tenant, select a valid certificate, and obtain a token.
3. Publish the candidate stable release through **Publish signer stable**.
4. Keep the Signer window and Windows notification center available throughout
   the checks.

## Tray states

- [ ] Unpaired: a small gray lower-right badge is visible over the recognizable
      Signer icon; the tooltip says that the agent is not paired.
- [ ] Healthy: the badge is green; the tooltip says that the agent is ready.
- [ ] Reconnecting: after interrupting the network, the badge becomes yellow;
      the tooltip says that the agent is reconnecting.
- [ ] Unavailable: after five continuous minutes without polling connectivity,
      the badge becomes red; the tooltip says that there is no connection.
- [ ] Working: while signing, the badge is blue and changes gently at about an
      800 ms interval.
- [ ] Updating: while downloading and installing an approved update, the badge
      uses the same gentle blue pulse.
- [ ] Gray, green, yellow, and red states do not animate.
- [ ] Every badge remains legible on light and dark taskbars at each supported
      Windows scaling setting; the base icon remains recognizable.

## Connectivity and notifications

- [ ] A network interruption shorter than five minutes produces no Windows
      failure notification and does not fill the journal with retry messages.
- [ ] Five continuous minutes offline produces exactly one unavailable
      notification, even while retries continue.
- [ ] Restoring the network returns the tray to green and produces exactly one
      recovery notification after the five-minute alert.
- [ ] The journal contains one interruption record, one five-minute unavailable
      record, and one recovery record with duration and attempt count; it does
      not contain one entry per retry.
- [ ] Revocation, malformed protocol responses, certificate failures, signing
      failures, True API failures, and report failures remain immediate and do
      not wait for the polling grace period.

## Operator-driven update

- [ ] **Проверить обновления** shows the installed version and returns each
      applicable result: current, available, failed, and successful retry.
- [ ] A failed quiet background check does not interrupt signing or show an
      operator error until the operator performs a manual check.
- [ ] Concurrent background and manual checks result in one updater request.
- [ ] No installer download, installation, or restart begins merely because an
      update was found.
- [ ] Download and installation begin only after the operator presses
      **Обновить и перезапустить**.
- [ ] A failed installation leaves the window usable, stops the blue pulse, and
      allows another attempt.
- [ ] A successful installation relaunches the new version and retains pairing,
      certificate selection, and the DPAPI-protected agent credential.

## Local storage

Run these on the first release that moves the agent data out of the roaming
profile (`docs/superpowers/specs/2026-09-27-signer-local-storage-design.md`),
starting from a paired previous stable with a selected certificate. The Signer
has only a stable channel, so run this section on a manually installed build
of the release commit before **Publish signer stable**: once published, every
operator's agent moves its data on the next start.

- [ ] After the update the agent keeps its identity: the cabinet shows no new
      agent, the certificate selection is kept, and the next token refresh
      completes through CryptoPro.
- [ ] Repeat the upgrade check on Windows 10 and on Windows 11.
- [ ] `%LOCALAPPDATA%\app.markiro.signer\` holds `signer.json`,
      `signer-storage.json` and `journal\`; `%APPDATA%\app.markiro.signer\`
      no longer exists.
- [ ] The journal shows "Agent data moved out of the roaming profile" once, and
      the earlier events are still listed.
- [ ] Restarting the agent moves nothing again and adds no storage entry.
- [ ] Copy `signer.json` from the local folder into a new
      `%APPDATA%\app.markiro.signer\` and restart: the agent keeps working, the
      Status tab reports a copy of this agent's pairing in the roaming profile,
      and the copy is left untouched. Delete the copied folder afterwards.
- [ ] Credential from another Windows user (real DPAPI): copy `signer.json`
      from user A's `%LOCALAPPDATA%\app.markiro.signer\` into user B's and
      start the Signer as B: the pairing screen shows the unreadable-credential
      warning, the file stays unchanged, and pairing as B overwrites it.
- [ ] Deny write access to `%LOCALAPPDATA%\app.markiro.signer\` on a
      computer that has not moved yet and restart: the Status tab says the move
      was postponed, and the journal shows "Agent data storage fallback" with
      the failed step and the Windows error. Restore access afterwards.
- [ ] Uninstall without "Delete application data", then reinstall: the agent
      is still paired. Uninstall with it ticked: both
      `%LOCALAPPDATA%\app.markiro.signer` and `%APPDATA%\app.markiro.signer`
      are removed; an `app.markiro.signer.retired-*` folder, if any, stays.

### Domain checks (test Active Directory)

- [ ] Roaming profile: move on computer A, sign out, and check that the profile
      share no longer holds `app.markiro.signer`. Sign in on computer B with the
      Signer installed: it shows the pairing screen, not A's identity.
- [ ] AppData(Roaming) redirection: computer B still on the previous version
      shows the pairing screen within one poll after A upgrades.
- [ ] Redirection without Offline Files, share taken offline: the Status or
      pairing screen reports an unreadable credential, `signer.json` is kept,
      and the agent recovers when the share returns.
- [ ] `DeleteRoamingCache = 1`, a temporary profile and a mandatory profile:
      nothing moves and the Status tab explains why.
- [ ] First start of the new version with the redirected share offline:
      without Offline Files the Status tab says the move was postponed and
      nothing is committed (the move happens once the share is back); with
      Offline Files the move completes from the cached copy.

## Evidence

Attach screenshots of all five badge colors on both taskbar themes, the manual
update results, and the installed version after relaunch. Export the Signer
journal and record the matching GitHub release tag and `release-evidence.json`
SHA-256. Do not include pairing codes, agent secrets, tokens, or certificate
private-key material.
