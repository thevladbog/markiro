# Station stable release acceptance

Заполняется отдельно для первого dual-origin stable и каждого stable → stable
перехода. Не помещайте сюда signing secrets, pairing code, API key, PIN/badge
или другие учётные данные. Допустимые результаты: `PASS`, `FAIL`, `NOT RUN`.

## Release identity

| Поле                           | Значение  |
| ------------------------------ | --------- |
| Принятая beta tag              | `NOT RUN` |
| Beta `baseSha`                 | `NOT RUN` |
| Beta `releaseSha`              | `NOT RUN` |
| GitHub beta evidence SHA-256   | `NOT RUN` |
| Yandex beta evidence SHA-256   | `NOT RUN` |
| Stable tag                     | `NOT RUN` |
| Stable `releaseSha`            | `NOT RUN` |
| GitHub stable evidence SHA-256 | `NOT RUN` |
| Yandex stable evidence SHA-256 | `NOT RUN` |
| Installer SHA-256              | `NOT RUN` |
| Updater bundle SHA-256         | `NOT RUN` |
| GitHub immutable URL           | `NOT RUN` |
| Yandex immutable URL           | `NOT RUN` |
| GitHub/Yandex channel URLs     | `NOT RUN` |
| Default installer URL          | `NOT RUN` |
| Mutable rollback evidence path | `NOT RUN` |
| Windows version/build          | `NOT RUN` |
| Station/hardware identity      | `NOT RUN` |
| Workflow URL                   | `NOT RUN` |
| Operator / UTC timestamp       | `NOT RUN` |

## Automated and publication evidence

| Проверка                                                         | Результат | Evidence |
| ---------------------------------------------------------------- | --------- | -------- |
| Exact dual-origin accepted beta provenance and successful CI     | NOT RUN   | workflow |
| GitHub beta tag target equals evidence `releaseSha`              | NOT RUN   | workflow |
| Stable version monotonicity and immutable collision denial       | NOT RUN   | workflow |
| One stable build/sign supplies both immutable origin trees       | NOT RUN   | workflow |
| GitHub and Yandex common stable assets are byte-identical        | NOT RUN   | hashes   |
| Both public immutable trees validate before mutable backup       | NOT RUN   | workflow |
| GitHub stable manifest promoted before Yandex manifest           | NOT RUN   | workflow |
| Yandex default alias `/station/download` promoted last           | NOT RUN   | workflow |
| All three mutable targets publicly match the accepted stable     | NOT RUN   | URLs     |
| Reverse rollback restores alias, Yandex manifest, GitHub pointer | NOT RUN   | artifact |
| `promote-existing` performs mutable-only recovery                | NOT RUN   | workflow |

## Install-over and preservation evidence

Для каждой строки укажите `PASS`, `FAIL` или `NOT RUN`, оператора, UTC timestamp,
идентификатор устройства/Windows и безопасный evidence path/hash.

| Проверка                                                       | Результат | Evidence required             |
| -------------------------------------------------------------- | --------- | ----------------------------- |
| SmartScreen/unsigned NSIS boundary recorded                    | NOT RUN   | Screenshot + operator result  |
| Restricted-network install-over from Yandex default alias      | NOT RUN   | URL + installer hash          |
| beta → stable manual install outside active shift              | NOT RUN   | Versions + installer hash     |
| stable → stable manual updater flow                            | NOT RUN   | Both immutable versions       |
| Application identity remains unchanged                         | NOT RUN   | Before/after application ID   |
| Station SQLite path and database remain unchanged              | NOT RUN   | Path + before/after counts    |
| Pairing identity and credentials remain usable                 | NOT RUN   | Outcome without credentials   |
| Local settings remain present                                  | NOT RUN   | Safe settings inventory       |
| Scan/print journals and boxes remain present                   | NOT RUN   | Before/after safe identifiers |
| Exceptions remain visible and recoverable                      | NOT RUN   | Before/after safe identifiers |
| Pending outbox survives install and later synchronizes         | NOT RUN   | Counts and final outcome      |
| Scanner serial and keyboard-wedge paths                        | NOT RUN   | Real scans                    |
| Printer print, failure, retry and scan-back                    | NOT RUN   | Physical labels               |
| Sound, touch, fullscreen and WebView2                          | NOT RUN   | Packaged Windows evidence     |
| Offline restart and reconnect                                  | NOT RUN   | Journal/outbox evidence       |
| Installation denied during active shift without blocking work  | NOT RUN   | Screen/video                  |
| Stable rollback uses retained immutable installer without loss | NOT RUN   | Version + schema window       |

## Final result

`NOT RUN`

Автоматизированные contracts и публикация GitHub/Yandex не заменяют Windows,
SmartScreen, scanner, printer, touch, WebView2, restricted-network, offline,
data-retention или rollback acceptance. Непроведённые проверки не повышаются
выше `NOT RUN`.
