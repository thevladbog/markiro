# Station dual-origin release acceptance

This is the durable evidence record for the transitional beta and the first
dual-origin stable. Copy it for an approved live rollout; do not replace this
template with a workflow summary. Allowed results are `PASS`, `FAIL`, and
`NOT_RUN`.

All live publication, Windows, customer-network, and hardware scenarios below
start as `NOT_RUN`. Operator, timestamp, device, and evidence cells remain blank
until the named scenario has actually been exercised. Never paste credentials,
pairing codes, badge/PIN values, signed request headers, or customer production
data into evidence.

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

The aliases and channel URLs are contracts, not proof that DNS, TLS, CDN,
Object Storage, GitHub, or a customer network served them in a particular run.

## Release identity

Fill one copy for each transitional beta or stable acceptance. Use the exact
values from the independently downloaded origin evidence and workflow; do not
infer a tag or hash from `main`, a channel alias, or the newest release.

| Field                       | Value |
| --------------------------- | ----- |
| Channel                     |       |
| Exact release tag           |       |
| `baseSha`                   |       |
| `releaseSha`                |       |
| GitHub evidence SHA-256     |       |
| Yandex evidence SHA-256     |       |
| Installer SHA-256           |       |
| Updater bundle SHA-256      |       |
| GitHub immutable URL        |       |
| Yandex immutable URL        |       |
| GitHub channel URL          |       |
| Yandex channel URL          |       |
| Installer URL               |       |
| Workflow URL                |       |
| Mutable backup/record path  |       |
| Previous rollback tag       |       |
| Previous installer SHA-256  |       |
| SQLite compatibility window |       |

## Evidence boundary

### Automated CI and host proof

Record Node release contracts, Yandex infrastructure contracts, Terraform
format/init/validate, Rust format/test/clippy, Station test/typecheck/lint/build,
dependency policy, repository format, and diff checks in the implementation or
workflow report. A `PASS` there proves only the named source, fixture, or host
gate. Local loopback Rust tests prove the bounded adapter behavior exercised by
their fixtures; they do not prove a customer proxy, DNS, CDN, Windows, NSIS, or
hardware path.

### Windows, hardware, and customer proof

Only a named operator on an identified Windows station may change a scenario
below from `NOT_RUN`. Use an ISO-8601 UTC timestamp and record the Windows
edition/build plus a non-secret station/asset identity. Evidence must be a
durable path or URL accompanied by its SHA-256 where the artifact is a file.
CI, a browser DOM test, macOS/Linux host tests, Terraform validation, and public
HTTP checks cannot promote these rows.

## Acceptance matrix

| Scenario                                                                                                                                                                                                                                                 | Evidence class                   | Result  | Operator | UTC timestamp | Device / Windows identity | Evidence path / SHA-256 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------- | -------- | ------------- | ------------------------- | ----------------------- |
| BASELINE-01 — DNS-disabled first-run rollback baselines exist independently for beta and stable; stable uses the exact accepted legacy stable, while beta uses a new strict dual-origin pre-transition release and never retrofits an old immutable beta | Live cloud/publication           | NOT_RUN |          |               |                           |                         |
| PUBLISH-01 — normal `mode=publish` produces and publicly revalidates both immutable origin trees before GitHub manifest, Yandex manifest, and installer alias promotion                                                                                  | Live publication                 | NOT_RUN |          |               |                           |                         |
| RECOVERY-01 — `mode=promote-existing` repairs only mutable targets after both existing immutable trees validate and match                                                                                                                                | Live publication recovery        | NOT_RUN |          |               |                           |                         |
| RECOVERY-02 — a missing, partial, or mismatched immutable origin is preserved as an incident; no overwrite/cross-copy/`promote-existing` occurs and a new authorized version is required                                                                 | Live publication incident        | NOT_RUN |          |               |                           |                         |
| NETWORK-01 — with GitHub blocked and Yandex healthy, update metadata check and package download complete through Yandex primary                                                                                                                          | Customer restricted network      | NOT_RUN |          |               |                           |                         |
| NETWORK-02 — with Yandex metadata or package delivery blocked before install, an exact GitHub mirror is rechecked and used; fallback is visible                                                                                                          | Customer fallback network        | NOT_RUN |          |               |                           |                         |
| NETWORK-03 — a valid Yandex no-update response is authoritative and causes no GitHub request                                                                                                                                                             | Customer network/diagnostics     | NOT_RUN |          |               |                           |                         |
| INTEGRITY-01 — origin version/date/target/signature mismatch is terminal; no package install or silent fallback starts                                                                                                                                   | Windows integrity boundary       | NOT_RUN |          |               |                           |                         |
| INTEGRITY-02 — bad updater signature is terminal; no fallback or installer process starts                                                                                                                                                                | Windows integrity boundary       | NOT_RUN |          |               |                           |                         |
| MIGRATION-01 — a GitHub-reachable GitHub-only beta receives the new transitional beta through its existing updater                                                                                                                                       | Windows migration                | NOT_RUN |          |               |                           |                         |
| MIGRATION-02 — a GitHub-blocked GitHub-only installation uses the verified explicit Yandex beta installer for manual install-over                                                                                                                        | Restricted-network migration     | NOT_RUN |          |               |                           |                         |
| PRESERVE-01 — application ID is `app.markiro.station` before and after install-over                                                                                                                                                                      | Windows data preservation        | NOT_RUN |          |               |                           |                         |
| PRESERVE-02 — the resolved Station SQLite path and `station-mirror.db` remain unchanged and readable before and after install-over                                                                                                                       | Windows data preservation        | NOT_RUN |          |               |                           |                         |
| PRESERVE-03 — station identity and pairing remain usable without re-pairing or exposing credentials                                                                                                                                                      | Windows data preservation        | NOT_RUN |          |               |                           |                         |
| PRESERVE-04 — local hardware and operator settings remain present                                                                                                                                                                                        | Windows data preservation        | NOT_RUN |          |               |                           |                         |
| PRESERVE-05 — scan/print journals retain their safe before/after identifiers and counts                                                                                                                                                                  | Windows data preservation        | NOT_RUN |          |               |                           |                         |
| PRESERVE-06 — open/closed boxes and pending print recovery retain their safe identifiers and SSCC relationships                                                                                                                                          | Windows data preservation        | NOT_RUN |          |               |                           |                         |
| PRESERVE-07 — exceptions remain visible, recoverable, and synchronized according to their prior state                                                                                                                                                    | Windows data preservation        | NOT_RUN |          |               |                           |                         |
| PRESERVE-08 — pending outbox entries survive install/restart and later synchronize without duplication or deletion                                                                                                                                       | Windows data preservation        | NOT_RUN |          |               |                           |                         |
| SHIFT-01 — an active shift denies installation while scans, printing, local journals, boxes, exceptions, and outbox work continue; install becomes available only after safe shift closure                                                               | Packaged Windows/active shift    | NOT_RUN |          |               |                           |                         |
| RECOVERY-03 — restart while offline and later reconnect preserve the selected release state and all durable Station work                                                                                                                                 | Packaged Windows/recovery        | NOT_RUN |          |               |                           |                         |
| HARDWARE-01 — configured scanner serial and keyboard-wedge paths still accept production-like scans after update                                                                                                                                         | Physical scanner                 | NOT_RUN |          |               |                           |                         |
| HARDWARE-02 — configured printer prints, reports failure, retries, and supports scan-back without losing the pending box                                                                                                                                 | Physical printer                 | NOT_RUN |          |               |                           |                         |
| HARDWARE-03 — operator sounds remain audible and correctly mapped after update                                                                                                                                                                           | Physical audio                   | NOT_RUN |          |               |                           |                         |
| HARDWARE-04 — touch controls, fullscreen, and supported viewport remain operable after update                                                                                                                                                            | Physical touch/display           | NOT_RUN |          |               |                           |                         |
| WINDOWS-01 — packaged Station starts and updates under the identified Windows/WebView2 runtime                                                                                                                                                           | Windows/WebView2                 | NOT_RUN |          |               |                           |                         |
| WINDOWS-02 — unsigned NSIS/no Authenticode and the actual SmartScreen/unknown-publisher outcome are recorded without claiming the Tauri updater signature is Authenticode                                                                                | Windows NSIS/SmartScreen         | NOT_RUN |          |               |                           |                         |
| OFFLINE-01 — a complete shift can continue offline through scan, journal, box/exception handling, restart, and later outbox reconnect                                                                                                                    | Packaged Windows/offline shift   | NOT_RUN |          |               |                           |                         |
| ROLLBACK-01 — the previous accepted stable is restored with its retained immutable installer inside the compatibility window, without deleting/changing SQLite path or losing pairing, settings, journals, boxes, exceptions, or outbox                  | Packaged Windows/stable rollback | NOT_RUN |          |               |                           |                         |

## Exact rollback procedure

1. Stop. Do not delete or overwrite an immutable GitHub release or Yandex
   `releases/<version>/` key. Preserve both origin trees, workflow summary,
   mutable backup, bootstrap record, and public read-back evidence.
2. If the immutable trees are both complete, independently valid, and equal on
   common assets but mutable promotion failed, use the exact release inputs with
   `mode=promote-existing`. It must not rebuild, sign, create a tag, upload an
   immutable object, or guess a different version.
3. On promotion failure, restore only targets changed by that transaction in
   exact reverse order: Yandex installer alias, Yandex channel manifest, then
   GitHub channel manifest. Publicly download and compare every restored target
   to its recorded backup. A restoration verification failure is a separate hard
   failure.
4. If either immutable origin is absent, partial, or mismatched, do not use
   `promote-existing` and do not copy the surviving tree over it. Keep the
   incident evidence and publish a new explicitly authorized version after the
   cause is corrected.
5. Rolling a channel pointer back affects only clients that have not updated.
   It never downgrades an installed Station. For an already updated station,
   close the active shift, verify the compatibility window and retained hash,
   then manually install the previous accepted immutable NSIS. Never delete or
   replace SQLite, station configuration, or outbox as a rollback technique.

## Final decision

Overall result: `NOT_RUN`

Do not accept the transitional beta or promote the first dual-origin stable
while any required row is `FAIL` or `NOT_RUN`. Record automated proof, live
publication proof, and Windows/customer proof as separate conclusions.
