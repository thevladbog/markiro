# Entitlements P1B.1: same-device recovery

Status: P1B.1 implementation, local acceptance, the required whole-workspace gate
and independent final review passed before integration with current main. The
integrated source has passed Android, production-contract and exact-APK emulator
checks; independent integration review passed with no findings. Publication follows separate
user authorization; deployment remains a separate step.

The [approved design](../superpowers/specs/2026-09-11-entitlements-p1b1-device-recovery-design.md)
covers recovery after a Station or handheld credential is rejected. Saved work
belongs to the normalized API origin, tenant, durable device record and device
kind. Replacing a key does not replace that owner. A line, operator or device name
is not sufficient to establish ownership.

## Recovery procedure

1. Wait for the client to finish sealing the rejected connection. Productive work
   and operator sign-in remain unavailable until the transition is resolved. A
   failure to finish sealing requires retrying recovery, not clearing local data.
2. Inspect the saved device identity and pending-work summary. An unavailable
   count means unknown; it does not mean that the queue is empty.
3. In the cabinet, have an authorized user issue a pairing code for the same
   existing device record. Preserve its device kind. Creating a replacement record
   does not recover work owned by the previous record.
4. Enter the code on the recovery screen. The client checks the saved API origin,
   tenant, device ID and kind before publishing credentials or an operator roster.
5. After successful connection, inspect synchronization separately. Pairing success
   establishes a usable connection; it does not assert that every saved event has
   been accepted. Pending uploads, conflicts/quarantine and uncertain print results
   remain separate outcomes.

Keep the device's retained evidence while resolving a failed attempt. Recovery
does not rewrite event IDs, device sequence, batch IDs/digests, task snapshots or
saved print bytes. The rejected key remains invalid.

## Refusal and uncertain outcomes

| Result                                           | Operator action                                                                                                                                                                                                                                      |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Code belongs to another tenant, device or kind   | Obtain a code for the saved device record. The recovery mismatch does not consume the wrong code or replace its device's active key.                                                                                                                 |
| API origin differs                               | Restore the expected environment. An address change is not automatically a transfer of ownership.                                                                                                                                                    |
| Recovery route is unavailable (404/405)          | Update the API before retrying. A client with retained data does not fall back to ordinary pairing.                                                                                                                                                  |
| Code is expired, invalid or rate-limited         | Use the existing pairing-code workflow or wait for the request limit. Retained data stays sealed.                                                                                                                                                    |
| Pairing response is lost or malformed            | Keep the saved state and obtain a new code for the same device record if another attempt is needed. A lost response may follow a successful server-side key rotation.                                                                                |
| Credential/config publication fails              | Retry recovery. Station checks the actual saved configuration: it completes an already-published connection or permits a fresh authorized code if publication did not complete. Restart also reconciles this state before workers or sign-in resume. |
| Subscription disallows writes                    | Resolve the existing subscription condition through its normal authorized process. This recovery route does not grant access after expiry.                                                                                                           |
| A revoked record no longer fits the device quota | Resolve capacity through the existing authorized process. Restoration of a revoked record still requires capacity.                                                                                                                                   |
| Owner is unresolved or contradictory             | Preserve the data for support investigation. Ordinary pairing cannot assign it to the next device or tenant. This stage supplies no administrative import or automatic reassignment.                                                                 |

An active device rotating its key keeps the same durable ID and does not consume
an additional station slot. This does not waive the quota when restoring a
revoked record. Pairing codes are single use. Keep returned credentials private;
the recovery response uses `Cache-Control: no-store`.

## Printing and retained work

A print interrupted while sending has an unknown delivery outcome. Reconnection
does not automatically print it again. Use the existing explicit print-recovery
flow, its saved bytes, task scope and required reason/verification. A connection
repair alone cannot determine whether a physical label left the printer.

Station also keeps the single-unresolved-label rule across old and new keys. A
reprint of a completed saved job cannot open another unresolved job while a
different unit still awaits completion.

The client preserves scan queues, box closures, labels, exceptions, shift closes,
inventory, conflicts and their retry identities. A new key may resume a previous
credential owner's work only through the verified relation to the same durable
owner. Late responses from the old connection cannot clear the new key or commit
acknowledgements as work of a new owner.

## Compatibility and rollout order

1. Deploy the API that exposes `POST /station/pair/recovery` while preserving the
   existing unversioned `/station/pair` contract.
2. Verify the recovery API and normal pairing against the intended environment.
   Release/install the separately accepted Station and handheld builds using their
   existing release processes.
3. Verify local upgrade and recovery before relying on retained-work guarantees
   for an installed device. These guarantees apply to updated clients; updating
   only the API does not replace an old client's cleanup behavior.

The recovery request has `version: 1`, the code and the expected
`{tenantId, deviceId, kind}`. Its response has `version: 1`, `device`, `credential`,
`operators` and an optional subscription snapshot. Expected IDs constrain the
authorized code's destination; they do not authorize access by themselves.

Updating a client before the API leaves retained work sealed with an
update-required result. The client does not use the old route to bypass that
boundary. An incompatible response also preserves the saved state.

Station SQLite and handheld Room upgrades are additive. A consistent existing
configuration may identify the owner observed at upgrade. Missing or contradictory
identity leaves data unresolved. This observation is not proof of a historical
commercial right. Do not assume that an older binary can open a newly migrated
database; downgrade compatibility needs separate validation.

## Verification record

This record distinguishes the accepted P1B.1 implementation at `e32005dbc` from
its subsequent integration with `origin/main` at `fca8ba8d5` (Handheld PRs #519,
#520 and #521). The broad workspace proof below belongs to the pre-integration
source; scoped Android and production-contract checks cover the integration. The
complete commands, logs and skip reconciliation are preserved in the task
acceptance and integration reports.

| Boundary                                                                   | Evidence so far                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared recovery contract                                                   | 247 shared-contract tests passed; package gates passed. Android deserializes the same checked-in request/response fixtures.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| API recovery and compatibility                                             | Final focused run: 89 tests passed without skips, including real PostgreSQL pairing tests. API typecheck, lint and build passed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| API broader regression                                                     | 3,667 tests passed in the final full API run. Three skipped local infrastructure cases then passed separately; the live National Catalog test was not run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Inventory server regression                                                | An additional 22 PostgreSQL tests passed after enabling the dedicated inventory test database.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| SaaS-admin contract consumer                                               | 352 tests, typecheck, lint and build passed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Station retained-work integration                                          | 1,471 Station tests and 440 DB tests passed without skips. Both packages passed typecheck, lint and build. Two independent fix reviews closed the reprint, retry and test-synchronization findings.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Handheld retained-work integration before current main                     | 596 tests in 92 files passed without failures, errors or skips; `lintDebug` and `assembleDebug` passed. Pre-integration debug APK SHA-256: `acc302f8983cd06ed3d0edec1b0a4b6499b8e47caeb29835b9a26e874057ef77`.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Handheld after current-main integration                                    | 614 tests in 95 files passed without failures, errors or skips; `lintDebug` and `assembleDebug` passed. Focused integration regression: 23 tests with one intended failure before correction, then all 23 passed. Final integrated debug APK SHA-256: `02d5d9da45e448b8ca2ec8e91571859b756ee89c41c6a2aae4968886fc67e248`.                                                                                                                                                                                                                                                                                                                                                   |
| CI ownership                                                               | A focused 17-test CI policy run proves that the shared recovery producer and both checked-in recovery fixture files select `handheld_android`; the existing Android job already consumes the fixture directory, so workflow steps did not need duplication.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Browser and emulator                                                       | The real Station `Enrollment` passed RU/EN at 1280×800 and 1024×768 for recovery and ordinary pairing: heading, summary, code field, keypad and primary action are fully in the viewport, recovery columns do not overlap, and there are no console errors, external requests or horizontal overflow. The exact integrated handheld APK (`02d5d9da…`) passed six RU/EN 360×640dp emulator scenes for sealed recovery, real CTA navigation to empty code entry and unresolved owner; all six PNGs were visually inspected. No code was submitted. Earlier APK screenshots and acceptance metadata are preserved separately under `handheld-acceptance/pre-main-integration`. |
| Pre-integration workspace gate and review                                  | The required Turbo gate completed 52/52 lint, typecheck, test and build tasks with 9,392 passing tests and 26 skips. Turbo filtered the inventory DB variable; the 22 affected inventory tests then passed through the dedicated DB wrapper. Formatting and diff checks passed. Independent final review approved specification compliance and code quality with no critical, important or minor findings.                                                                                                                                                                                                                                                                  |
| Current-main integration contracts and review                              | All 549 production-bundle contract tests passed without skips against the merged configuration. Node/API/shared-contract runtime inputs were unchanged; their broad gates were not repeated. Independent integration review passed with no findings.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Physical printer/scanner, Windows, factory Android device and installation | Not performed. Automated storage or emulator tests do not establish hardware acceptance.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Deployment and live services                                               | Not performed. Local tests do not verify production or the live National Catalog.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

P1B.1 does not activate new commercial restrictions, transfer work to another
device, release a commercial seat, implement retained selection on downgrade,
provide signed offline task grants or introduce recovery access after subscription
expiry. These remain separate stages.
