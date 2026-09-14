# Public API and offline grants acceptance

Scope: P1B.3b public product/inventory API and P1C bounded native grants. This is
engineering evidence, not authorization to activate strict production enforcement.
Policy durations, approved device cohort and physical pilot acceptance belong to P1D.

## Automated evidence

| Boundary                                    | Evidence                                                                                                                                 | Status                                                                                                                                            |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public token scopes and current credentials | Real HTTP tests, foreign tenant denial, key/scope revocation and request identity                                                        | Full API suite and separate Turbo inventory coverage passed                                                                                       |
| Inventory preparation                       | Public create, exact source imports, selected snapshot and start; original public-key actor                                              | Real HTTP workflow passed through bounded evidence acceptance, over-budget rollback, public access removal and exact replay after expiry          |
| Signed protocol                             | Original JWS bytes, ES256/P-256, strict claims and portable TypeScript/Kotlin fixtures                                                   | Focused checks passed                                                                                                                             |
| Clock and finite budgets                    | Exclusive deadlines, independent wall/server high-water, restart/session changes, replay and all event dimensions                        | 899 domain tests passed; Station, handheld and kiosk owner checks passed                                                                          |
| Issuer and recovery configuration           | Current native owner, immutable history, expiry, strict cohort, approved rollback, key retirement and final asynchronous authority fence | Focused PostgreSQL/HTTP checks passed                                                                                                             |
| Station productive owners                   | Atomic SQLite effects/outbox, serial consumption, print recovery and credential fencing                                                  | 1,716 Station tests and 97 host Cargo tests passed; final evidence and mixed-queue recovery independently approved with 155 focused tests         |
| Handheld productive owners                  | Real Room/Robolectric, issued envelope, retirement, actual executed snapshot, delayed response and settings                              | 904 tests in 129 suites passed with no skips; lintDebug and assembleDebug passed; evidence transport independently approved with 63 focused tests |
| Kiosk productive owners                     | IndexedDB generation/sequence fencing, real signatures, current employee policy and reservation identity                                 | 670 tests passed; evidence adapter independently approved; 33 focused tests rerun                                                                 |
| Server evidence and native upload           | Retained chronology/provenance, bounded classification, unchanged native idempotency and quarantine                                      | 366 related API tests passed; five real HTTP workflows and strict zero-budget saved-label reprint/replay passed                                   |
| CI ownership                                | Protocol and shared fixture changes select all three native consumers; Kotlin fixture parity precedes Gradle                             | 45 contract tests passed                                                                                                                          |
| Full branch                                 | Changed packages, migration forward upgrade, production contracts, formatting and diff checks                                            | 52/52 Turbo tasks passed without cache; 559 production bundle, 394 Station release and 45 CI contracts passed; formatting and diff checks passed  |

The complete workspace run passed 10,903 tests across 13 packages, including
1,408 cabinet, 1,716 Station, 670 kiosk, 535 DB and 312 contract tests. All 52
`lint`, `typecheck`, `test` and `build` tasks passed without cache.

The full API package run passed 4,208 tests. It initially skipped 26: the API
Turbo override omitted `INVENTORY_TEST_DATABASE_URL`, disabling 22 database tests.
The override and CI regression check were corrected; both omitted suites then
passed through real Turbo against a fresh migrated PostgreSQL database, with
22 passed and zero skipped. The four remaining opt-in cases were not run: live
National Catalog, the local Mailpit/MinIO lifecycle, private MinIO image bytes,
and the infrastructure-backed owner-provisioning command. Their external service
configuration was not enabled. This is not a claim of live provider acceptance.

## Browser, emulator and physical evidence

DOM and fake IndexedDB tests do not establish installed-browser or multi-tab behavior.
Robolectric and APK assembly do not establish Android vendor boot identity or scanner
behavior. Host Cargo tests do not establish Windows printer/scanner behavior.

Local Chromium cabinet component checks passed at 1280×900 and 390×900 with
synthetic API responses: keyboard scope selection, exact creation payload, one-time
secret removal on the next failed request, retained draft, failed scope update and
successful retry, and revocation. Screenshots were inspected; the narrow table
keeps its own horizontal scroll without overflowing the page. This does not
exercise full-application authentication.

Local Chromium kiosk checks passed with synthetic credentials and blocked API traffic:
signed new-work decision, disconnected operation, reload causing clock distrust,
retained existing queue, visible warning and approved observation recovery. Both
1180×800 and 800×1180 layouts had no horizontal overflow; both screenshots were
inspected. Station FloorShell/ShiftSelection browser checks also passed at 1280×800
and 1024×768 with a simulated native denial: complete warning text, working setup
and conflict actions, no horizontal overflow. These do not exercise a full Tauri
offline flow. A separate two-tab Chromium check passed with a shared real
IndexedDB queue: identical saved envelopes, concurrent accepted/duplicate responses
and one atomic receipt, journal entry and outcome. The responses were synthetic;
installed-PWA checks remain pending.

The debug Android APK installed and opened on a local API 36 emulator. Process
restart preserved the OS boot counter; an emulator reboot advanced it and the APK
opened again. This exercised the unpaired screen, not a paired grant workflow or
industrial scanner. Emulator-only Digital Wellbeing interference was dismissed
before visually checking Markiro. No physical Station, Windows printer,
industrial handheld, kiosk installation, network appliance or production key has been
used for acceptance in this change.

## Production acceptance to record separately

Record the exact application/API source versions, migration completion, approved
policy revision and device cohort. Exercise the actual printer/scanner, interruption
and restart, finite final unit, recovered credentials, retained disputed evidence and
approved rollback on the selected devices. A merged PR or green CI does not prove
that those devices have been upgraded or that production strict mode is active.
