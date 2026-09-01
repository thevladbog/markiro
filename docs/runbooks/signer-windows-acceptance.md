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

## Evidence

Attach screenshots of all five badge colors on both taskbar themes, the manual
update results, and the installed version after relaunch. Export the Signer
journal and record the matching GitHub release tag and `release-evidence.json`
SHA-256. Do not include pairing codes, agent secrets, tokens, or certificate
private-key material.
