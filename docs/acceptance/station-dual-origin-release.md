# Station dual-origin release acceptance

This is the durable evidence template for the Phase 3 bootstrap beta, the
strictly newer validation/candidate beta, the first dual-origin stable, and
later stable-to-stable proof. Copy it for an approved live rollout. Allowed
results are `PASS`, `FAIL`, and `NOT_RUN` only.

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
  `https://github.com/thevladbog/markiro-station-releases/releases/download/station-stable-channel/latest.json`
- GitHub beta channel:
  `https://github.com/thevladbog/markiro-station-releases/releases/download/station-beta-channel/latest.json`

These URLs are contracts, not evidence that DNS, TLS, Object Storage, GitHub,
or a customer network served them in a particular run. Historical immutable
releases are not retrofitted; the beta baseline is a new strict release and the
stable first-run baseline retains the accepted legacy stable bytes.

## Gate model

The `Required for` value defines applicability. A `NOT_RUN` result blocks a
sign-off only when the row's `Required for` value belongs to that sign-off. A
`FAIL` blocks every sign-off to which its row applies. A row for a later gate
may remain `NOT_RUN` without blocking an earlier gate:

1. Phase 2 must first create the strict DNS-disabled pre-transition beta
   rollback baseline. `BASELINE-01` alone must be `PASS`; that result permits
   bootstrap beta publication but does not claim the bootstrap beta is ready.
2. The Phase 3 bootstrap beta is the first dual-origin-adapter build. After it
   is published, every `BOOTSTRAP_READY` row must be `PASS` and the bootstrap
   beta Overall result must be `PASS`. This bounded publication, preservation,
   and basic-operation gate permits publication of the next
   validation/candidate beta. It does not sign off that candidate.
3. The validation/candidate beta must be a strictly newer canonical beta than
   the recorded bootstrap beta. `BETA_SIGN_OFF` applies only to the
   validation/candidate beta and its bootstrap-to-candidate tests. Set the
   validation/candidate beta Overall result to `PASS` only after every
   `BETA_SIGN_OFF` row is `PASS`, including rollback to the bootstrap
   predecessor and successful restoration of the exact candidate.
4. First stable publication requires the validation/candidate beta Overall
   result `PASS`. Its stable `source_beta_tag` must equal the exact
   validation/candidate beta tag recorded below; its `baseSha`, `releaseSha`,
   and both origin evidence hashes are the accepted provenance. Stable rows may
   still be `NOT_RUN`; in particular, `PUBLISH-01` does not block the act of
   first stable publication needed to exercise it.
5. First stable sign-off happens after first stable publication and requires
   every `FIRST_STABLE_SIGN_OFF` and `EVERY_STABLE_SIGN_OFF` row to be `PASS`.
6. A subsequent stable sign-off requires every `SUBSEQUENT_STABLE_SIGN_OFF` and
   `EVERY_STABLE_SIGN_OFF` row to be `PASS`. A
   `SUBSEQUENT_STABLE_SIGN_OFF` row does not block first stable publication or
   first stable sign-off because a stable-to-stable predecessor does not yet
   exist at that boundary. A subsequent rollback drill is not complete until
   the exact current candidate stable is restored; candidate-restoration
   failure forces Overall `FAIL`.

Do not convert an inapplicable row to `PASS`. Leave it `NOT_RUN`, use the gate
rules above, and keep bootstrap readiness, candidate beta sign-off, and stable
decisions as separate records. Never mark an Overall result `PASS` while its
channel remains deliberately rolled back.

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

## Bootstrap beta readiness record

The bootstrap beta is the first build that contains the fixed dual-origin
adapter. It is not the validation/candidate beta and cannot be promoted to
stable from this readiness record.

### Bootstrap beta identity

| Field                                | Value |
| ------------------------------------ | ----- |
| Exact bootstrap beta tag             |       |
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
| Previous installer SHA-256           |       |
| SQLite compatibility window          |       |
| Phase 2 pre-transition baseline tag  |       |

| Scenario                                                                                                                                                                                            | Required for    | Evidence class               | Result  | Operator | UTC timestamp | Device / Windows identity | Evidence path / SHA-256 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ---------------------------- | ------- | -------- | ------------- | ------------------------- | ----------------------- |
| BASELINE-01 — the strict DNS-disabled Phase 2 pre-transition beta rollback baseline is complete, publicly/provider-read verified, and no historical immutable release was retrofitted               | BOOTSTRAP_READY | Live cloud/publication       | NOT_RUN |          |               |                           |                         |
| BOOTSTRAP-PUBLISH-01 — the first dual-origin-adapter bootstrap beta normal `mode=publish` produces and publicly revalidates both immutable trees before both manifests and the beta alias promotion | BOOTSTRAP_READY | Live publication             | NOT_RUN |          |               |                           |                         |
| BOOTSTRAP-MIGRATION-01 — a GitHub-reachable legacy client uses the exact public binary-repository installer for a manual install-over to the bootstrap beta                                         | BOOTSTRAP_READY | Windows migration            | NOT_RUN |          |               |                           |                         |
| BOOTSTRAP-MIGRATION-02 — a GitHub-blocked legacy client uses the verified explicit Yandex beta installer for a manual install-over to the bootstrap beta                                            | BOOTSTRAP_READY | Restricted-network migration | NOT_RUN |          |               |                           |                         |
| BOOTSTRAP-PRESERVE-01 — application ID `app.markiro.station` is unchanged across bootstrap install-over                                                                                             | BOOTSTRAP_READY | Windows data preservation    | NOT_RUN |          |               |                           |                         |
| BOOTSTRAP-PRESERVE-02 — the resolved Station SQLite path and `station-mirror.db` remain unchanged, readable, and contain the prior data                                                             | BOOTSTRAP_READY | Windows data preservation    | NOT_RUN |          |               |                           |                         |
| BOOTSTRAP-PRESERVE-03 — station identity and pairing remain usable without re-pairing or exposing credentials                                                                                       | BOOTSTRAP_READY | Windows data preservation    | NOT_RUN |          |               |                           |                         |
| BOOTSTRAP-PRESERVE-04 — local hardware and operator settings remain present after bootstrap install-over                                                                                            | BOOTSTRAP_READY | Windows data preservation    | NOT_RUN |          |               |                           |                         |
| BOOTSTRAP-PRESERVE-05 — scan and print journals retain safe before/after identifiers and counts                                                                                                     | BOOTSTRAP_READY | Windows data preservation    | NOT_RUN |          |               |                           |                         |
| BOOTSTRAP-PRESERVE-06 — open/closed boxes and pending print recovery retain safe identifiers and SSCC relationships                                                                                 | BOOTSTRAP_READY | Windows data preservation    | NOT_RUN |          |               |                           |                         |
| BOOTSTRAP-PRESERVE-07 — exceptions remain visible, recoverable, and synchronized according to prior state                                                                                           | BOOTSTRAP_READY | Windows data preservation    | NOT_RUN |          |               |                           |                         |
| BOOTSTRAP-PRESERVE-08 — pending outbox entries survive bootstrap install/restart and later synchronize without duplication or deletion                                                              | BOOTSTRAP_READY | Windows data preservation    | NOT_RUN |          |               |                           |                         |
| BOOTSTRAP-BASIC-01 — packaged bootstrap Station starts on the identified Windows and WebView2 runtime, opens the manual update center, and completes a manual update check                          | BOOTSTRAP_READY | Windows basic operation      | NOT_RUN |          |               |                           |                         |
| BOOTSTRAP-BASIC-02 — the configured scanner accepts a production-like scan through the supported serial or keyboard-wedge path                                                                      | BOOTSTRAP_READY | Physical scanner smoke       | NOT_RUN |          |               |                           |                         |
| BOOTSTRAP-BASIC-03 — the configured printer completes a print and preserves recoverability across a reported failure and retry                                                                      | BOOTSTRAP_READY | Physical printer smoke       | NOT_RUN |          |               |                           |                         |

Bootstrap beta Overall result: `NOT_RUN`

## Validation/candidate beta acceptance record

This is the strictly newer beta exercised from the recorded bootstrap beta.
Only this record's accepted identity may later be supplied as the first stable
`source_beta_tag`.

### Validation/candidate beta identity

| Field                                                 | Value |
| ----------------------------------------------------- | ----- |
| Exact validation/candidate beta tag                   |       |
| `baseSha`                                             |       |
| `releaseSha`                                          |       |
| GitHub evidence SHA-256                               |       |
| Yandex evidence SHA-256                               |       |
| Installer SHA-256                                     |       |
| Updater bundle SHA-256                                |       |
| GitHub immutable URL                                  |       |
| Yandex immutable URL                                  |       |
| GitHub channel URL                                    |       |
| Yandex channel URL                                    |       |
| Installer URL                                         |       |
| Workflow URL                                          |       |
| Transaction backup verification step                  |       |
| Previous installer SHA-256                            |       |
| SQLite compatibility window                           |       |
| Exact bootstrap predecessor tag                       |       |
| Strict ordering proof (`candidate > bootstrap`)       |       |
| First-stable `source_beta_tag` (must equal candidate) |       |
| Rollback-to-bootstrap workflow/evidence               |       |
| Candidate-restoration workflow/evidence               |       |

| Scenario                                                                                                                                                                                                       | Required for  | Evidence class                 | Result  | Operator | UTC timestamp | Device / Windows identity | Evidence path / SHA-256 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------ | ------- | -------- | ------------- | ------------------------- | ----------------------- |
| BETA-PUBLISH-01 — the strictly newer validation/candidate beta normal `mode=publish` produces and publicly revalidates both immutable trees before both manifests and the beta alias promotion                 | BETA_SIGN_OFF | Live publication               | NOT_RUN |          |               |                           |                         |
| BETA-RECOVERY-01 — mutable-only recovery uses `mode=promote-existing` with the exact validation/candidate `repair_tag` after both existing immutable trees validate and match                                  | BETA_SIGN_OFF | Live publication recovery      | NOT_RUN |          |               |                           |                         |
| BETA-RECOVERY-02 — a partial origin or origin mismatch is preserved as an incident; no overwrite, cross-copy, or mutable promotion occurs                                                                      | BETA_SIGN_OFF | Live publication incident      | NOT_RUN |          |               |                           |                         |
| BETA-UPDATE-01 — bootstrap beta → validation/candidate beta Yandex primary update succeeds with GitHub blocked, including Yandex metadata selection and Yandex package download                                | BETA_SIGN_OFF | Customer restricted network    | NOT_RUN |          |               |                           |                         |
| BETA-METADATA-FALLBACK-01 — validation/candidate metadata request at Yandex fails before selection, then the exact GitHub fallback metadata is rechecked and visibly used                                      | BETA_SIGN_OFF | Customer fallback network      | NOT_RUN |          |               |                           |                         |
| BETA-PACKAGE-FALLBACK-01 — validation/candidate Yandex metadata selects the candidate, its package download fails before install, then the exact GitHub fallback is rechecked and visibly supplies the package | BETA_SIGN_OFF | Customer fallback network      | NOT_RUN |          |               |                           |                         |
| BETA-NO-UPDATE-01 — a valid validation/candidate Yandex beta no-update response is authoritative and causes no GitHub request                                                                                  | BETA_SIGN_OFF | Customer network/diagnostics   | NOT_RUN |          |               |                           |                         |
| BETA-INTEGRITY-01 — validation/candidate origin version, date, target, or signature mismatch is terminal; no package request, install, or silent fallback starts                                               | BETA_SIGN_OFF | Windows integrity boundary     | NOT_RUN |          |               |                           |                         |
| BETA-INTEGRITY-02 — a bad validation/candidate updater signature is terminal; no fallback or installer process starts                                                                                          | BETA_SIGN_OFF | Windows integrity boundary     | NOT_RUN |          |               |                           |                         |
| BETA-PRESERVE-01 — application ID `app.markiro.station` is unchanged from bootstrap through validation/candidate update                                                                                        | BETA_SIGN_OFF | Windows data preservation      | NOT_RUN |          |               |                           |                         |
| BETA-PRESERVE-02 — the resolved Station SQLite path and `station-mirror.db` remain unchanged and readable after validation/candidate update                                                                    | BETA_SIGN_OFF | Windows data preservation      | NOT_RUN |          |               |                           |                         |
| BETA-PRESERVE-03 — station identity and pairing remain usable without re-pairing or exposing credentials                                                                                                       | BETA_SIGN_OFF | Windows data preservation      | NOT_RUN |          |               |                           |                         |
| BETA-PRESERVE-04 — local hardware and operator settings remain present after validation/candidate update                                                                                                       | BETA_SIGN_OFF | Windows data preservation      | NOT_RUN |          |               |                           |                         |
| BETA-PRESERVE-05 — scan and print journals retain safe before/after identifiers and counts                                                                                                                     | BETA_SIGN_OFF | Windows data preservation      | NOT_RUN |          |               |                           |                         |
| BETA-PRESERVE-06 — open/closed boxes and pending print recovery retain safe identifiers and SSCC relationships                                                                                                 | BETA_SIGN_OFF | Windows data preservation      | NOT_RUN |          |               |                           |                         |
| BETA-PRESERVE-07 — exceptions remain visible, recoverable, and synchronized according to prior state                                                                                                           | BETA_SIGN_OFF | Windows data preservation      | NOT_RUN |          |               |                           |                         |
| BETA-PRESERVE-08 — pending outbox entries survive validation/candidate install/restart and later synchronize without duplication or deletion                                                                   | BETA_SIGN_OFF | Windows data preservation      | NOT_RUN |          |               |                           |                         |
| BETA-SHIFT-01 — an active shift denies installation while scans, printing, journals, boxes, exceptions, and outbox continue; install becomes available only after safe shift closure                           | BETA_SIGN_OFF | Packaged Windows/active shift  | NOT_RUN |          |               |                           |                         |
| BETA-RECOVERY-03 — restart while offline and later reconnect preserve the selected validation/candidate beta and all durable Station work                                                                      | BETA_SIGN_OFF | Packaged Windows/recovery      | NOT_RUN |          |               |                           |                         |
| BETA-HARDWARE-01 — configured scanner serial and keyboard-wedge paths accept production-like scans after update                                                                                                | BETA_SIGN_OFF | Physical scanner               | NOT_RUN |          |               |                           |                         |
| BETA-HARDWARE-02 — configured printer prints, reports failure, retries, and supports scan-back without losing the pending box                                                                                  | BETA_SIGN_OFF | Physical printer               | NOT_RUN |          |               |                           |                         |
| BETA-HARDWARE-03 — operator sounds remain audible and correctly mapped after update                                                                                                                            | BETA_SIGN_OFF | Physical audio                 | NOT_RUN |          |               |                           |                         |
| BETA-HARDWARE-04 — touch controls, fullscreen, and supported viewport remain operable after update                                                                                                             | BETA_SIGN_OFF | Physical touch/display         | NOT_RUN |          |               |                           |                         |
| BETA-WINDOWS-01 — packaged Station starts and updates under the identified Windows and WebView2 runtime                                                                                                        | BETA_SIGN_OFF | Windows/WebView2               | NOT_RUN |          |               |                           |                         |
| BETA-WINDOWS-02 — unsigned NSIS and the actual SmartScreen/unknown-publisher outcome are recorded without treating the Tauri updater signature as Authenticode                                                 | BETA_SIGN_OFF | Windows NSIS/SmartScreen       | NOT_RUN |          |               |                           |                         |
| BETA-OFFLINE-01 — a complete shift continues offline through scan, journal, box/exception handling, restart, and later outbox reconnect                                                                        | BETA_SIGN_OFF | Packaged Windows/offline shift | NOT_RUN |          |               |                           |                         |
| BETA-ROLLBACK-01 — the bootstrap predecessor is deliberately re-promoted by exact `repair_tag`; both beta channel manifests and the beta alias are verified against its immutable trees                        | BETA_SIGN_OFF | Live publication rollback      | NOT_RUN |          |               |                           |                         |
| BETA-ROLLBACK-02 — the validation/candidate beta is then re-promoted by exact `repair_tag`; both beta channel manifests and the beta alias are verified again before beta Overall can pass                     | BETA_SIGN_OFF | Live publication restoration   | NOT_RUN |          |               |                           |                         |

Validation/candidate beta Overall result: `NOT_RUN`

## Stable acceptance record

### Stable identity

| Field                                   | Value |
| --------------------------------------- | ----- |
| Exact release tag                       |       |
| Exact `source_beta_tag`                 |       |
| `baseSha`                               |       |
| `releaseSha`                            |       |
| GitHub evidence SHA-256                 |       |
| Yandex evidence SHA-256                 |       |
| Installer SHA-256                       |       |
| Updater bundle SHA-256                  |       |
| GitHub immutable URL                    |       |
| Yandex immutable URL                    |       |
| GitHub channel URL                      |       |
| Yandex channel URL                      |       |
| Installer URL                           |       |
| Workflow URL                            |       |
| Transaction backup verification step    |       |
| Previous installer SHA-256              |       |
| SQLite compatibility window             |       |
| Previous accepted stable tag            |       |
| Previous stable `source_beta_tag`       |       |
| Rollback-to-previous workflow/evidence  |       |
| Candidate-restoration workflow/evidence |       |

| Scenario                                                                                                                                                                                                   | Required for               | Evidence class                 | Result  | Operator | UTC timestamp | Device / Windows identity | Evidence path / SHA-256 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------ | ------- | -------- | ------------- | ------------------------- | ----------------------- |
| PUBLISH-01 — first dual-origin stable normal `mode=publish` creates and publicly revalidates both immutable trees before GitHub manifest, Yandex manifest, and default stable alias promotion              | FIRST_STABLE_SIGN_OFF      | Live publication               | NOT_RUN |          |               |                           |                         |
| STABLE-RECOVERY-01 — stable mutable-only repair revalidates the exact accepted beta and both stable immutable trees before using the protected promotion transaction                                       | FIRST_STABLE_SIGN_OFF      | Live publication recovery      | NOT_RUN |          |               |                           |                         |
| STABLE-RECOVERY-02 — a partial origin or origin mismatch is preserved as an incident; no overwrite, cross-copy, or mutable promotion occurs                                                                | FIRST_STABLE_SIGN_OFF      | Live publication incident      | NOT_RUN |          |               |                           |                         |
| STABLE-INSTALL-01 — beta → stable manual install-over uses the verified default Yandex installer outside an active shift                                                                                   | FIRST_STABLE_SIGN_OFF      | Packaged Windows migration     | NOT_RUN |          |               |                           |                         |
| STABLE-CURRENT-01 — the installed first stable receives an authoritative Yandex stable no-update response and makes no GitHub request                                                                      | FIRST_STABLE_SIGN_OFF      | Customer network/diagnostics   | NOT_RUN |          |               |                           |                         |
| STABLE-UPDATE-01 — stable → stable Yandex primary update succeeds with GitHub blocked, including Yandex metadata selection and Yandex package download                                                     | SUBSEQUENT_STABLE_SIGN_OFF | Customer restricted network    | NOT_RUN |          |               |                           |                         |
| STABLE-METADATA-FALLBACK-01 — stable update metadata request fails at Yandex before candidate selection, then the exact GitHub fallback metadata is rechecked and visibly used                             | SUBSEQUENT_STABLE_SIGN_OFF | Customer fallback network      | NOT_RUN |          |               |                           |                         |
| STABLE-PACKAGE-FALLBACK-01 — stable Yandex metadata selects a candidate, its package download fails before install, then the exact GitHub fallback is rechecked and visibly supplies the package           | SUBSEQUENT_STABLE_SIGN_OFF | Customer fallback network      | NOT_RUN |          |               |                           |                         |
| STABLE-INTEGRITY-01 — a stable origin mismatch is terminal; no package request, install, or silent fallback starts                                                                                         | SUBSEQUENT_STABLE_SIGN_OFF | Windows integrity boundary     | NOT_RUN |          |               |                           |                         |
| STABLE-INTEGRITY-02 — a bad updater signature is terminal; no fallback or installer process starts                                                                                                         | SUBSEQUENT_STABLE_SIGN_OFF | Windows integrity boundary     | NOT_RUN |          |               |                           |                         |
| PRESERVE-01 — application ID is `app.markiro.station` before and after stable install-over                                                                                                                 | EVERY_STABLE_SIGN_OFF      | Windows data preservation      | NOT_RUN |          |               |                           |                         |
| PRESERVE-02 — the resolved Station SQLite path and `station-mirror.db` remain unchanged and readable                                                                                                       | EVERY_STABLE_SIGN_OFF      | Windows data preservation      | NOT_RUN |          |               |                           |                         |
| PRESERVE-03 — station identity and pairing remain usable without re-pairing or exposing credentials                                                                                                        | EVERY_STABLE_SIGN_OFF      | Windows data preservation      | NOT_RUN |          |               |                           |                         |
| PRESERVE-04 — local hardware and operator settings remain present                                                                                                                                          | EVERY_STABLE_SIGN_OFF      | Windows data preservation      | NOT_RUN |          |               |                           |                         |
| PRESERVE-05 — scan and print journals retain safe before/after identifiers and counts                                                                                                                      | EVERY_STABLE_SIGN_OFF      | Windows data preservation      | NOT_RUN |          |               |                           |                         |
| PRESERVE-06 — open/closed boxes and pending print recovery retain safe identifiers and SSCC relationships                                                                                                  | EVERY_STABLE_SIGN_OFF      | Windows data preservation      | NOT_RUN |          |               |                           |                         |
| PRESERVE-07 — exceptions remain visible, recoverable, and synchronized according to prior state                                                                                                            | EVERY_STABLE_SIGN_OFF      | Windows data preservation      | NOT_RUN |          |               |                           |                         |
| PRESERVE-08 — pending outbox entries survive install/restart and later synchronize without duplication or deletion                                                                                         | EVERY_STABLE_SIGN_OFF      | Windows data preservation      | NOT_RUN |          |               |                           |                         |
| SHIFT-01 — an active shift denies installation while scans, printing, journals, boxes, exceptions, and outbox continue; install becomes available only after safe shift closure                            | EVERY_STABLE_SIGN_OFF      | Packaged Windows/active shift  | NOT_RUN |          |               |                           |                         |
| RECOVERY-03 — restart while offline and later reconnect preserve the selected stable state and all durable Station work                                                                                    | EVERY_STABLE_SIGN_OFF      | Packaged Windows/recovery      | NOT_RUN |          |               |                           |                         |
| HARDWARE-01 — configured scanner serial and keyboard-wedge paths accept production-like scans after update                                                                                                 | EVERY_STABLE_SIGN_OFF      | Physical scanner               | NOT_RUN |          |               |                           |                         |
| HARDWARE-02 — configured printer prints, reports failure, retries, and supports scan-back without losing the pending box                                                                                   | EVERY_STABLE_SIGN_OFF      | Physical printer               | NOT_RUN |          |               |                           |                         |
| HARDWARE-03 — operator sounds remain audible and correctly mapped after update                                                                                                                             | EVERY_STABLE_SIGN_OFF      | Physical audio                 | NOT_RUN |          |               |                           |                         |
| HARDWARE-04 — touch controls, fullscreen, and supported viewport remain operable after update                                                                                                              | EVERY_STABLE_SIGN_OFF      | Physical touch/display         | NOT_RUN |          |               |                           |                         |
| WINDOWS-01 — packaged Station starts and updates under the identified Windows and WebView2 runtime                                                                                                         | EVERY_STABLE_SIGN_OFF      | Windows/WebView2               | NOT_RUN |          |               |                           |                         |
| WINDOWS-02 — unsigned NSIS and the actual SmartScreen/unknown-publisher outcome are recorded without treating the Tauri updater signature as Authenticode                                                  | EVERY_STABLE_SIGN_OFF      | Windows NSIS/SmartScreen       | NOT_RUN |          |               |                           |                         |
| OFFLINE-01 — a complete shift continues offline through scan, journal, box/exception handling, restart, and later outbox reconnect                                                                         | EVERY_STABLE_SIGN_OFF      | Packaged Windows/offline shift | NOT_RUN |          |               |                           |                         |
| ROLLBACK-01 — the previous accepted stable is deliberately re-promoted using its recorded `source_beta_tag`; both stable channel manifests and the default alias are verified against its immutable trees  | SUBSEQUENT_STABLE_SIGN_OFF | Live publication rollback      | NOT_RUN |          |               |                           |                         |
| ROLLBACK-02 — the current candidate stable is then re-promoted using its recorded `source_beta_tag`; both stable channel manifests and the default alias are verified again before stable Overall can pass | SUBSEQUENT_STABLE_SIGN_OFF | Live publication restoration   | NOT_RUN |          |               |                           |                         |

First/subsequent stable Overall result: `NOT_RUN`

## Exact post-success acceptance rollback

This procedure is a deliberate rollback after a successful promotion. It is
different from the same-run compensation trap. It never mutates an immutable
release and it does not automatically downgrade an installed Station.

Prerequisites for both channels:

1. Select only the recorded predecessor and current candidate from the relevant
   acceptance identities; do not infer either from newest/latest ordering.
2. Before moving a channel, independently download both immutable trees for
   both releases, compare their recorded evidence hashes and targets, and stop
   on mismatch, missing assets, or an unaccepted release.
3. Keep the current candidate channel evidence before dispatch. Each protected
   run creates a complete temporary backup of current mutables before its first
   mutation. That backup supports in-run compensation and is not a durable
   backup artifact after a successful run; record both workflow URLs and both
   public verification outputs, not an invented backup path.
4. Every promote-existing run keeps the protected transaction order: GitHub
   manifest, Yandex manifest, then the channel installer alias last. Its failure
   path compensates in reverse order.

For beta, set `BOOTSTRAP_BETA_TAG` and `VALIDATION_BETA_TAG` from the two beta
identity tables. First move the channel back to the exact bootstrap predecessor:

```bash
gh workflow run station-beta-release.yml --ref main \
  -f mode=promote-existing \
  -f repair_tag="$BOOTSTRAP_BETA_TAG"
```

Wait for that protected run to succeed. Verify both public beta channel
manifests and `https://releases.markiro.app/station/beta/download` against the
bootstrap immutable trees, then record `BETA-ROLLBACK-01`. Immediately restore
the exact validation/candidate beta:

```bash
gh workflow run station-beta-release.yml --ref main \
  -f mode=promote-existing \
  -f repair_tag="$VALIDATION_BETA_TAG"
```

Wait for the restoration run to succeed and verify both public beta manifests
and the beta alias against the validation/candidate immutable trees. Record
`BETA-ROLLBACK-02` and its candidate-restoration workflow/evidence only after
those read-backs match.

For a subsequent stable, obtain `PREVIOUS_STABLE_SOURCE_BETA_TAG` and
`CANDIDATE_STABLE_SOURCE_BETA_TAG` from both matching copies of the respective
stable `release-evidence.json`. First move the stable channel to the exact
previous accepted stable:

```bash
gh workflow run station-stable-release.yml --ref main \
  -f mode=promote-existing \
  -f source_beta_tag="$PREVIOUS_STABLE_SOURCE_BETA_TAG" \
  -f acceptance_confirmed=true
```

Wait for success. Verify both public stable channel manifests and
`https://releases.markiro.app/station/download` against the previous immutable
stable, then record `ROLLBACK-01`. Immediately restore the current candidate
stable using its own recorded accepted-beta provenance:

```bash
gh workflow run station-stable-release.yml --ref main \
  -f mode=promote-existing \
  -f source_beta_tag="$CANDIDATE_STABLE_SOURCE_BETA_TAG" \
  -f acceptance_confirmed=true
```

Wait for success and verify both stable manifests and the default alias against
the current candidate immutable stable. Record `ROLLBACK-02` and its
candidate-restoration workflow/evidence only after every read-back matches. The
workflow derives each exact stable tag from its recorded source beta; neither
target has to be the newest stable.

For either command, the transaction's failure path restores only targets
changed by that run in reverse order: Yandex alias, Yandex manifest, then GitHub
manifest. Every restored target is publicly read back and compared to the
temporary backup. A restore mismatch is a separate hard failure. Stop on any
immutable or public mismatch; do not overwrite, cross-copy, delete, or repair an
immutable tree.

If either candidate restoration fails or any final read-back mismatches, set
the relevant beta or stable Overall result to `FAIL` and stop for incident
recovery. Do not leave a channel deliberately rolled back while marking
acceptance `PASS`; Overall cannot become `PASS` until the exact candidate is
again the verified public channel and alias target.

Channel rollback affects only clients that have not updated. For an already
updated station, close the active shift, confirm the SQLite compatibility
window and retained installer hash, and manually install the previous accepted
immutable NSIS. Preserve application ID, SQLite path, pairing, settings,
journals, boxes, exceptions, and outbox; deletion is not rollback.
