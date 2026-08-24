# Station dual-origin release acceptance

This is the durable evidence template for the transitional beta, the first
dual-origin stable, and later stable-to-stable proof. Copy it for an approved
live rollout. Allowed results are `PASS`, `FAIL`, and `NOT_RUN` only.

Every live publication, Windows, customer-network, and hardware row starts as
`NOT_RUN`. Operator, UTC timestamp, device identity, and evidence stay blank
until that exact scenario is exercised. Never invent tags, hashes, timings, or
hardware results, and never record credentials, pairing codes, badge/PIN
values, signed headers, or customer production data.

## Fixed public surfaces

- Stable installer: `https://releases.markiro.app/station/download`
- Explicit beta installer: `https://releases.markiro.app/station/beta/download`
- Yandex stable channel:
  `https://releases.markiro.app/station/stable/latest.json`
- Yandex beta channel: `https://releases.markiro.app/station/beta/latest.json`
- GitHub stable channel:
  `https://github.com/thevladbog/markiro/releases/download/station-stable-channel/latest.json`
- GitHub beta channel:
  `https://github.com/thevladbog/markiro/releases/download/station-beta-channel/latest.json`

These URLs are contracts, not evidence that DNS, TLS, Object Storage, GitHub,
or a customer network served them in a particular run. Historical immutable
releases are not retrofitted; the beta baseline is a new strict release and the
stable first-run baseline retains the accepted legacy stable bytes.

## Gate model

The `Required for` value defines applicability. A `NOT_RUN` result blocks a
sign-off only when the row's `Required for` value belongs to that sign-off. A
`FAIL` blocks every sign-off to which its row applies. A row for a later gate
may remain `NOT_RUN` without blocking an earlier gate:

1. Transitional beta sign-off requires every `BETA_SIGN_OFF` row to be `PASS`.
   Record the exact beta identity and set its Overall result to `PASS` only
   after those rows pass.
2. First stable publication requires a completed transitional beta record with
   Overall result `PASS`. Stable rows may still be `NOT_RUN`; they do not block
   the publication needed to exercise them. In particular, `PUBLISH-01` does
   not block the act of first stable publication.
3. First stable sign-off happens after first stable publication and requires
   every `FIRST_STABLE_SIGN_OFF` and `EVERY_STABLE_SIGN_OFF` row to be `PASS`.
4. A subsequent stable sign-off requires every `SUBSEQUENT_STABLE_SIGN_OFF` and
   `EVERY_STABLE_SIGN_OFF` row to be `PASS`. A
   `SUBSEQUENT_STABLE_SIGN_OFF` row does not block first stable publication or
   first stable sign-off because a stable-to-stable predecessor does not yet
   exist at that boundary.

Do not convert an inapplicable row to `PASS`. Leave it `NOT_RUN`, use the gate
rules above, and keep the beta and stable decisions as separate records.

## Evidence boundary

### Automated CI and host proof

Record Node release contracts, workflow contracts, Yandex infrastructure
contracts, Terraform format/init/validate, Rust format/test/clippy, Station
test/typecheck/lint/build, dependency policy, repository format, and diff checks
in the implementation or workflow report. Their `PASS` proves only the named
source, fixture, or host gate. Loopback Rust tests do not prove a customer
proxy, DNS, CDN, Windows, NSIS, or hardware path and do not populate the tables
below.

### Live publication proof

A named release operator may update a live-publication row only after the real
protected workflow and public read-backs exercise it. Use an ISO-8601 UTC
timestamp and a durable workflow/evidence URL or file path plus SHA-256. The
device field may remain blank for a publication-only row.

### Windows, hardware, and customer proof

Only a named operator on the identified Windows station may update these rows.
Record Windows edition/build and a non-secret station/asset identity. A file
evidence path requires its SHA-256. CI, browser DOM tests, macOS/Linux host
tests, Terraform validation, and generic public HTTP checks cannot promote
Windows, hardware, or customer-network rows.

## Transitional beta acceptance record

### Transitional beta identity

| Field                                | Value |
| ------------------------------------ | ----- |
| Exact release tag                    |       |
| `baseSha`                            |       |
| `releaseSha`                         |       |
| GitHub evidence SHA-256              |       |
| Yandex evidence SHA-256              |       |
| Installer SHA-256                    |       |
| Updater bundle SHA-256               |       |
| GitHub immutable URL                 |       |
| Yandex immutable URL                 |       |
| GitHub channel URL                   |       |
| Yandex channel URL                   |       |
| Installer URL                        |       |
| Workflow URL                         |       |
| Transaction backup verification step |       |
| Previous accepted beta tag           |       |
| Previous installer SHA-256           |       |
| SQLite compatibility window          |       |

| Scenario                                                                                                                                                                                                                             | Required for  | Evidence class                        | Result  | Operator | UTC timestamp | Device / Windows identity | Evidence path / SHA-256 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | ------------------------------------- | ------- | -------- | ------------- | ------------------------- | ----------------------- |
| BASELINE-01 — DNS-disabled first-run rollback baselines exist independently for beta and stable; beta uses a new strict dual-origin pre-transition release and neither historical beta nor stable immutable releases are retrofitted | BETA_SIGN_OFF | Live cloud/publication                | NOT_RUN |          |               |                           |                         |
| BETA-PUBLISH-01 — normal `mode=publish` produces and publicly revalidates both beta immutable origin trees before GitHub manifest, Yandex manifest, and beta installer alias promotion                                               | BETA_SIGN_OFF | Live publication                      | NOT_RUN |          |               |                           |                         |
| BETA-RECOVERY-01 — mutable-only recovery uses `mode=promote-existing` with one exact `repair_tag` after both existing immutable trees validate and match                                                                             | BETA_SIGN_OFF | Live publication recovery             | NOT_RUN |          |               |                           |                         |
| BETA-RECOVERY-02 — a partial origin or origin mismatch is preserved as an incident; no overwrite, cross-copy, or mutable promotion occurs                                                                                            | BETA_SIGN_OFF | Live publication incident             | NOT_RUN |          |               |                           |                         |
| BETA-UPDATE-01 — beta → beta Yandex primary update succeeds with GitHub blocked, including Yandex metadata selection and Yandex package download                                                                                     | BETA_SIGN_OFF | Customer restricted network           | NOT_RUN |          |               |                           |                         |
| BETA-METADATA-FALLBACK-01 — beta update metadata request fails at Yandex before candidate selection, then the exact GitHub fallback metadata is rechecked and visibly used                                                           | BETA_SIGN_OFF | Customer fallback network             | NOT_RUN |          |               |                           |                         |
| BETA-PACKAGE-FALLBACK-01 — beta Yandex metadata selects a candidate, its package download fails before install, then the exact GitHub fallback is rechecked and visibly supplies the package                                         | BETA_SIGN_OFF | Customer fallback network             | NOT_RUN |          |               |                           |                         |
| BETA-NO-UPDATE-01 — a valid Yandex beta no-update response is authoritative and causes no GitHub request                                                                                                                             | BETA_SIGN_OFF | Customer network/diagnostics          | NOT_RUN |          |               |                           |                         |
| BETA-INTEGRITY-01 — origin version, date, target, or signature mismatch is terminal; no package request, install, or silent fallback starts                                                                                          | BETA_SIGN_OFF | Windows integrity boundary            | NOT_RUN |          |               |                           |                         |
| BETA-INTEGRITY-02 — a bad updater signature is terminal; no fallback or installer process starts                                                                                                                                     | BETA_SIGN_OFF | Windows integrity boundary            | NOT_RUN |          |               |                           |                         |
| MIGRATION-01 — a GitHub-reachable GitHub-only beta receives the transitional beta through its existing updater                                                                                                                       | BETA_SIGN_OFF | Windows migration                     | NOT_RUN |          |               |                           |                         |
| MIGRATION-02 — a GitHub-blocked GitHub-only installation uses the verified explicit Yandex beta installer for manual install-over                                                                                                    | BETA_SIGN_OFF | Restricted-network migration          | NOT_RUN |          |               |                           |                         |
| BETA-PRESERVE-01 — application ID is `app.markiro.station` before and after transitional beta install-over                                                                                                                           | BETA_SIGN_OFF | Windows data preservation             | NOT_RUN |          |               |                           |                         |
| BETA-PRESERVE-02 — the resolved Station SQLite path and `station-mirror.db` remain unchanged and readable                                                                                                                            | BETA_SIGN_OFF | Windows data preservation             | NOT_RUN |          |               |                           |                         |
| BETA-PRESERVE-03 — station identity and pairing remain usable without re-pairing or exposing credentials                                                                                                                             | BETA_SIGN_OFF | Windows data preservation             | NOT_RUN |          |               |                           |                         |
| BETA-PRESERVE-04 — local hardware and operator settings remain present                                                                                                                                                               | BETA_SIGN_OFF | Windows data preservation             | NOT_RUN |          |               |                           |                         |
| BETA-PRESERVE-05 — scan and print journals retain safe before/after identifiers and counts                                                                                                                                           | BETA_SIGN_OFF | Windows data preservation             | NOT_RUN |          |               |                           |                         |
| BETA-PRESERVE-06 — open/closed boxes and pending print recovery retain safe identifiers and SSCC relationships                                                                                                                       | BETA_SIGN_OFF | Windows data preservation             | NOT_RUN |          |               |                           |                         |
| BETA-PRESERVE-07 — exceptions remain visible, recoverable, and synchronized according to prior state                                                                                                                                 | BETA_SIGN_OFF | Windows data preservation             | NOT_RUN |          |               |                           |                         |
| BETA-PRESERVE-08 — pending outbox entries survive install/restart and later synchronize without duplication or deletion                                                                                                              | BETA_SIGN_OFF | Windows data preservation             | NOT_RUN |          |               |                           |                         |
| BETA-SHIFT-01 — an active shift denies installation while scans, printing, journals, boxes, exceptions, and outbox continue; install becomes available only after safe shift closure                                                 | BETA_SIGN_OFF | Packaged Windows/active shift         | NOT_RUN |          |               |                           |                         |
| BETA-RECOVERY-03 — restart while offline and later reconnect preserve the selected beta state and all durable Station work                                                                                                           | BETA_SIGN_OFF | Packaged Windows/recovery             | NOT_RUN |          |               |                           |                         |
| BETA-HARDWARE-01 — configured scanner serial and keyboard-wedge paths accept production-like scans after update                                                                                                                      | BETA_SIGN_OFF | Physical scanner                      | NOT_RUN |          |               |                           |                         |
| BETA-HARDWARE-02 — configured printer prints, reports failure, retries, and supports scan-back without losing the pending box                                                                                                        | BETA_SIGN_OFF | Physical printer                      | NOT_RUN |          |               |                           |                         |
| BETA-HARDWARE-03 — operator sounds remain audible and correctly mapped after update                                                                                                                                                  | BETA_SIGN_OFF | Physical audio                        | NOT_RUN |          |               |                           |                         |
| BETA-HARDWARE-04 — touch controls, fullscreen, and supported viewport remain operable after update                                                                                                                                   | BETA_SIGN_OFF | Physical touch/display                | NOT_RUN |          |               |                           |                         |
| BETA-WINDOWS-01 — packaged Station starts and updates under the identified Windows and WebView2 runtime                                                                                                                              | BETA_SIGN_OFF | Windows/WebView2                      | NOT_RUN |          |               |                           |                         |
| BETA-WINDOWS-02 — unsigned NSIS and the actual SmartScreen/unknown-publisher outcome are recorded without treating the Tauri updater signature as Authenticode                                                                       | BETA_SIGN_OFF | Windows NSIS/SmartScreen              | NOT_RUN |          |               |                           |                         |
| BETA-OFFLINE-01 — a complete shift continues offline through scan, journal, box/exception handling, restart, and later outbox reconnect                                                                                              | BETA_SIGN_OFF | Packaged Windows/offline shift        | NOT_RUN |          |               |                           |                         |
| BETA-ROLLBACK-01 — the previous accepted beta is deliberately re-promoted by exact `repair_tag`, both channel manifests and the beta alias are verified, and any installed downgrade is manual                                       | BETA_SIGN_OFF | Live publication and Windows rollback | NOT_RUN |          |               |                           |                         |

Transitional beta Overall result: `NOT_RUN`

## Stable acceptance record

### Stable identity

| Field                                | Value |
| ------------------------------------ | ----- |
| Exact release tag                    |       |
| Exact `source_beta_tag`              |       |
| `baseSha`                            |       |
| `releaseSha`                         |       |
| GitHub evidence SHA-256              |       |
| Yandex evidence SHA-256              |       |
| Installer SHA-256                    |       |
| Updater bundle SHA-256               |       |
| GitHub immutable URL                 |       |
| Yandex immutable URL                 |       |
| GitHub channel URL                   |       |
| Yandex channel URL                   |       |
| Installer URL                        |       |
| Workflow URL                         |       |
| Transaction backup verification step |       |
| Previous accepted stable tag         |       |
| Previous stable `source_beta_tag`    |       |
| Previous installer SHA-256           |       |
| SQLite compatibility window          |       |

| Scenario                                                                                                                                                                                                             | Required for               | Evidence class                        | Result  | Operator | UTC timestamp | Device / Windows identity | Evidence path / SHA-256 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------- | ------- | -------- | ------------- | ------------------------- | ----------------------- |
| PUBLISH-01 — first dual-origin stable normal `mode=publish` creates and publicly revalidates both immutable trees before GitHub manifest, Yandex manifest, and default stable alias promotion                        | FIRST_STABLE_SIGN_OFF      | Live publication                      | NOT_RUN |          |               |                           |                         |
| STABLE-RECOVERY-01 — stable mutable-only repair revalidates the exact accepted beta and both stable immutable trees before using the protected promotion transaction                                                 | FIRST_STABLE_SIGN_OFF      | Live publication recovery             | NOT_RUN |          |               |                           |                         |
| STABLE-RECOVERY-02 — a partial origin or origin mismatch is preserved as an incident; no overwrite, cross-copy, or mutable promotion occurs                                                                          | FIRST_STABLE_SIGN_OFF      | Live publication incident             | NOT_RUN |          |               |                           |                         |
| STABLE-INSTALL-01 — beta → stable manual install-over uses the verified default Yandex installer outside an active shift                                                                                             | FIRST_STABLE_SIGN_OFF      | Packaged Windows migration            | NOT_RUN |          |               |                           |                         |
| STABLE-CURRENT-01 — the installed first stable receives an authoritative Yandex stable no-update response and makes no GitHub request                                                                                | FIRST_STABLE_SIGN_OFF      | Customer network/diagnostics          | NOT_RUN |          |               |                           |                         |
| STABLE-UPDATE-01 — stable → stable Yandex primary update succeeds with GitHub blocked, including Yandex metadata selection and Yandex package download                                                               | SUBSEQUENT_STABLE_SIGN_OFF | Customer restricted network           | NOT_RUN |          |               |                           |                         |
| STABLE-METADATA-FALLBACK-01 — stable update metadata request fails at Yandex before candidate selection, then the exact GitHub fallback metadata is rechecked and visibly used                                       | SUBSEQUENT_STABLE_SIGN_OFF | Customer fallback network             | NOT_RUN |          |               |                           |                         |
| STABLE-PACKAGE-FALLBACK-01 — stable Yandex metadata selects a candidate, its package download fails before install, then the exact GitHub fallback is rechecked and visibly supplies the package                     | SUBSEQUENT_STABLE_SIGN_OFF | Customer fallback network             | NOT_RUN |          |               |                           |                         |
| STABLE-INTEGRITY-01 — a stable origin mismatch is terminal; no package request, install, or silent fallback starts                                                                                                   | SUBSEQUENT_STABLE_SIGN_OFF | Windows integrity boundary            | NOT_RUN |          |               |                           |                         |
| STABLE-INTEGRITY-02 — a bad updater signature is terminal; no fallback or installer process starts                                                                                                                   | SUBSEQUENT_STABLE_SIGN_OFF | Windows integrity boundary            | NOT_RUN |          |               |                           |                         |
| PRESERVE-01 — application ID is `app.markiro.station` before and after stable install-over                                                                                                                           | EVERY_STABLE_SIGN_OFF      | Windows data preservation             | NOT_RUN |          |               |                           |                         |
| PRESERVE-02 — the resolved Station SQLite path and `station-mirror.db` remain unchanged and readable                                                                                                                 | EVERY_STABLE_SIGN_OFF      | Windows data preservation             | NOT_RUN |          |               |                           |                         |
| PRESERVE-03 — station identity and pairing remain usable without re-pairing or exposing credentials                                                                                                                  | EVERY_STABLE_SIGN_OFF      | Windows data preservation             | NOT_RUN |          |               |                           |                         |
| PRESERVE-04 — local hardware and operator settings remain present                                                                                                                                                    | EVERY_STABLE_SIGN_OFF      | Windows data preservation             | NOT_RUN |          |               |                           |                         |
| PRESERVE-05 — scan and print journals retain safe before/after identifiers and counts                                                                                                                                | EVERY_STABLE_SIGN_OFF      | Windows data preservation             | NOT_RUN |          |               |                           |                         |
| PRESERVE-06 — open/closed boxes and pending print recovery retain safe identifiers and SSCC relationships                                                                                                            | EVERY_STABLE_SIGN_OFF      | Windows data preservation             | NOT_RUN |          |               |                           |                         |
| PRESERVE-07 — exceptions remain visible, recoverable, and synchronized according to prior state                                                                                                                      | EVERY_STABLE_SIGN_OFF      | Windows data preservation             | NOT_RUN |          |               |                           |                         |
| PRESERVE-08 — pending outbox entries survive install/restart and later synchronize without duplication or deletion                                                                                                   | EVERY_STABLE_SIGN_OFF      | Windows data preservation             | NOT_RUN |          |               |                           |                         |
| SHIFT-01 — an active shift denies installation while scans, printing, journals, boxes, exceptions, and outbox continue; install becomes available only after safe shift closure                                      | EVERY_STABLE_SIGN_OFF      | Packaged Windows/active shift         | NOT_RUN |          |               |                           |                         |
| RECOVERY-03 — restart while offline and later reconnect preserve the selected stable state and all durable Station work                                                                                              | EVERY_STABLE_SIGN_OFF      | Packaged Windows/recovery             | NOT_RUN |          |               |                           |                         |
| HARDWARE-01 — configured scanner serial and keyboard-wedge paths accept production-like scans after update                                                                                                           | EVERY_STABLE_SIGN_OFF      | Physical scanner                      | NOT_RUN |          |               |                           |                         |
| HARDWARE-02 — configured printer prints, reports failure, retries, and supports scan-back without losing the pending box                                                                                             | EVERY_STABLE_SIGN_OFF      | Physical printer                      | NOT_RUN |          |               |                           |                         |
| HARDWARE-03 — operator sounds remain audible and correctly mapped after update                                                                                                                                       | EVERY_STABLE_SIGN_OFF      | Physical audio                        | NOT_RUN |          |               |                           |                         |
| HARDWARE-04 — touch controls, fullscreen, and supported viewport remain operable after update                                                                                                                        | EVERY_STABLE_SIGN_OFF      | Physical touch/display                | NOT_RUN |          |               |                           |                         |
| WINDOWS-01 — packaged Station starts and updates under the identified Windows and WebView2 runtime                                                                                                                   | EVERY_STABLE_SIGN_OFF      | Windows/WebView2                      | NOT_RUN |          |               |                           |                         |
| WINDOWS-02 — unsigned NSIS and the actual SmartScreen/unknown-publisher outcome are recorded without treating the Tauri updater signature as Authenticode                                                            | EVERY_STABLE_SIGN_OFF      | Windows NSIS/SmartScreen              | NOT_RUN |          |               |                           |                         |
| OFFLINE-01 — a complete shift continues offline through scan, journal, box/exception handling, restart, and later outbox reconnect                                                                                   | EVERY_STABLE_SIGN_OFF      | Packaged Windows/offline shift        | NOT_RUN |          |               |                           |                         |
| ROLLBACK-01 — the previous accepted stable is deliberately re-promoted using its recorded `source_beta_tag`, both stable channel manifests and the default alias are verified, and any installed downgrade is manual | SUBSEQUENT_STABLE_SIGN_OFF | Live publication and Windows rollback | NOT_RUN |          |               |                           |                         |

First/subsequent stable Overall result: `NOT_RUN`

## Exact post-success acceptance rollback

This procedure is a deliberate rollback after a successful promotion. It is
different from the same-run compensation trap. It never mutates an immutable
release and it does not automatically downgrade an installed Station.

Prerequisites for both channels:

1. Select only a previous accepted release from its completed acceptance
   record; do not infer it from newest/latest ordering.
2. Independently download both immutable trees, compare the recorded evidence
   hashes, and stop on mismatch, missing assets, an unexpected release target,
   or an unaccepted release.
3. Keep the current channel evidence before dispatch. The protected run creates
   a complete temporary backup of current mutables before its first mutation.
   That backup supports in-run compensation and is not a durable backup
   artifact after a successful run; record the workflow URL and verification
   steps, not an invented backup path.

For beta, set `PREVIOUS_BETA_TAG` from the accepted beta record and run:

```bash
gh workflow run station-beta-release.yml --ref main \
  -f mode=promote-existing \
  -f repair_tag="$PREVIOUS_BETA_TAG"
```

The workflow must resolve exactly that published, non-draft prerelease, verify
its target SHA and evidence, validate and compare both immutable trees, back up
current mutables, then promote GitHub manifest, Yandex manifest, and beta alias
last. Verify both public channel manifests and
`https://releases.markiro.app/station/beta/download` against the selected
immutable beta.

For stable, obtain `PREVIOUS_STABLE_SOURCE_BETA_TAG` from both copies of the
previous accepted stable `release-evidence.json` and run:

```bash
gh workflow run station-stable-release.yml --ref main \
  -f mode=promote-existing \
  -f source_beta_tag="$PREVIOUS_STABLE_SOURCE_BETA_TAG" \
  -f acceptance_confirmed=true
```

The workflow derives the exact stable tag from that recorded source beta; it
does not require the target to be the newest stable. It validates the accepted
beta and both exact stable immutable trees, backs up current mutables, then
promotes GitHub manifest, Yandex manifest, and the default stable alias last.
Verify both public stable channel manifests and
`https://releases.markiro.app/station/download` against the selected immutable
stable.

For either command, the transaction's failure path restores only targets
changed by that run in reverse order: Yandex alias, Yandex manifest, then GitHub
manifest. Every restored target is publicly read back and compared to the
temporary backup. A restore mismatch is a separate hard failure. Stop on any
immutable or public mismatch; do not overwrite, cross-copy, delete, or repair an
immutable tree.

Channel rollback affects only clients that have not updated. For an already
updated station, close the active shift, confirm the SQLite compatibility
window and retained installer hash, and manually install the previous accepted
immutable NSIS. Preserve application ID, SQLite path, pairing, settings,
journals, boxes, exceptions, and outbox; deletion is not rollback.
