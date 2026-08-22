# Station stable release acceptance

Заполняется для каждого первого stable и последующих stable → stable переходов.
Не помещайте сюда signing secrets, pairing code, API key, PIN/badge или другие
учётные данные.

## Release identity

| Поле                      | Значение  |
| ------------------------- | --------- |
| Принятая beta tag         | `NOT RUN` |
| Beta `baseSha`            | `NOT RUN` |
| Beta `releaseSha`         | `NOT RUN` |
| Beta evidence SHA-256     | `NOT RUN` |
| Stable tag                | `NOT RUN` |
| Stable `releaseSha`       | `NOT RUN` |
| Stable evidence SHA-256   | `NOT RUN` |
| Installer SHA-256         | `NOT RUN` |
| Updater bundle SHA-256    | `NOT RUN` |
| Windows version/build     | `NOT RUN` |
| Station/hardware identity | `NOT RUN` |
| Workflow URL              | `NOT RUN` |
| Operator/date             | `NOT RUN` |

## Automated and publication evidence

| Проверка                                                      | Результат | Evidence |
| ------------------------------------------------------------- | --------- | -------- |
| Exact accepted beta provenance and successful base CI         | NOT RUN   | workflow |
| Stable version monotonicity and collision denial              | NOT RUN   | workflow |
| Immutable stable assets, signature, manifest and SHA256SUMS   | NOT RUN   | workflow |
| Stable evidence matches beta tag/base/release/evidence digest | NOT RUN   | workflow |
| Normal stable release published before stable channel         | NOT RUN   | workflow |
| `station-stable-channel/latest.json` byte comparison          | NOT RUN   | workflow |

## Windows and physical acceptance

| Проверка                                                   | Результат | Evidence required             |
| ---------------------------------------------------------- | --------- | ----------------------------- |
| SmartScreen/unknown-publisher path understood and recorded | NOT RUN   | Screenshot + operator result  |
| beta → stable manual NSIS install outside active shift     | NOT RUN   | Versions + installer hash     |
| Pairing identity and credentials retained                  | NOT RUN   | Outcome without credentials   |
| Station SQLite and migrations retained                     | NOT RUN   | Before/after record counts    |
| Scanner and printer configuration retained                 | NOT RUN   | Device models + screenshots   |
| Scan journal, boxes, exceptions and outbox retained        | NOT RUN   | Before/after safe identifiers |
| Scanner: serial and keyboard-wedge                         | NOT RUN   | Real scans                    |
| Printer: print, failure, retry and scan-back               | NOT RUN   | Physical labels               |
| Sound, touch and fullscreen                                | NOT RUN   | Real packaged Windows run     |
| Offline restart and reconnect                              | NOT RUN   | Journal/outbox evidence       |
| Pending outbox survives install and later synchronizes     | NOT RUN   | Counts and final outcome      |
| Stable → stable manual updater flow                        | NOT RUN   | Both immutable versions       |
| Installation is denied during an active shift              | NOT RUN   | Screen/video                  |
| Restart preserves operational state                        | NOT RUN   | Before/after evidence         |
| Manual rollback with retained immutable installer          | NOT RUN   | Version + schema window       |

## Final result

`NOT RUN`

Допустимые итоговые значения: `PASS`, `FAIL`, `NOT RUN`. Автоматизированные
проверки и публикация GitHub Release не заменяют Windows, scanner, printer,
touch, fullscreen, offline/reconnect, stable → stable или rollback acceptance.
