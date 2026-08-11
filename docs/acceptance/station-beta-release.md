# Station beta release acceptance

| Проверка                                             | Результат | Evidence                              |
| ---------------------------------------------------- | --------- | ------------------------------------- |
| Canonical `station-v1.2.3-beta.N` tag/version        | PASS      | `test:station-release:contract`       |
| Manifest, signature, URL and SHA-256 validation      | PASS      | `artifacts.test.mjs`                  |
| Protected main-only workflow and pinned actions      | PASS      | `workflow.test.mjs`                   |
| Manual `promote-existing` path                       | PASS      | workflow contract + staged validation |
| beta.1 install on Windows                            | NOT RUN   | Requires Windows operator station     |
| beta.1 → beta.2 manual update and active-shift block | NOT RUN   | Requires Windows station              |
| Offline restart preserves pending outbox             | NOT RUN   | Requires real station data            |
| Rollback to prior immutable installer                | NOT RUN   | Requires Windows installer run        |
| SmartScreen/reputation prompt                        | NOT RUN   | Requires downloaded production asset  |
| Scanner/printer/sound after update                   | NOT RUN   | Separate hardware acceptance          |

Automated checks do not prove Windows, Tauri updater UI, scanner, printer,
audio, outage recovery, or manual installation. Record station serial, Windows
version, app version, commit digest and operator for each external check.
