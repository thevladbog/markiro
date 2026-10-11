# План УСТ: установщик «Markiro Автоном» — роли ПК, служба `MarkiroHost`, брандмауэр, ПК офиса без киоск-режима, смена адреса хоста — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** «Markiro Автоном» ставится на площадку пилота одним установщиком NSIS с тремя ролями ПК: на ПК станции — служба `MarkiroHost` (автозапуск без входа в Windows, перезапуск после сбоя, учётная запись LocalService, закрытый от пользователей каталог данных, правило брандмауэра для TCP 45710, проверка профиля сети) и приложение в киоск-режиме; на ПК администратора — приложение без киоск-режима, которое подключается к хосту как устройство офиса и умеет сменить адрес хоста с тем же сертификатом. Удаление и обновление не трогают данных. Задание CI `standalone-windows-build` собирает установщик, ставит его на своём раннере, проверяет обещанное и выкладывает артефакт с хешами.

**Architecture:**

- Хост (задачи 1–2): `host/src/install.rs` — шов `Services` (диспетчер служб) и `Commands` (внешние программы) и порядок шагов `install`, `uninstall`, `stop`: права каталога данных через `icacls` по SID, конфигурация службы `MarkiroHost`, правило брандмауэра PowerShell-скриптом в `-EncodedCommand`, ожидания с пределом 30 с. `host/src/network_profile.rs` — `network-check [--make-private]`. `host/src/install_windows.rs` — `Services` на `windows-service` 0.8.1 (`cfg(windows)`). `main.rs` — подкоманды `install`, `uninstall`, `stop-service`, `network-check`. Тесты с подделками идут на любой ОС; адаптер Windows проверяется крейтом-пробником под `x86_64-pc-windows-msvc` и в CI.
- Оболочка (задача 3): `src-tauri/src/installation.rs` читает роль из `installation.json` рядом с исполняемым файлом; `DeviceState::with_install_role`, ПК офиса подключается по коду видом `office`; `DeviceState::change_address` и команда `device_change_address`; команда `install_role`.
- Вебвью (задача 4): `DeviceApi.installRole`, `DeviceApi.changeAddress`, код `address_other_host`; ПК офиса не входит в киоск-режим, его дом — «Вход в офис» без «В цех», в шапке «Выйти»; «Сменить адрес хоста» на входе в офис для подключения к хосту на другом ПК (`src/app/HostAddressDialog.tsx`); действие оболочки `address_changed`.
- Установщик (задача 5): оверлей `src-tauri/tauri.installer.conf.json` (`externalBin` хоста, `perMachine`, русский язык, хуки), хуки `src-tauri/windows/installer-hooks.nsh` (UTF-8 с BOM: роль из `/ROLE=`, реестра или двух вопросов; служба только для роли `host`; автозапуск станций; удаление не стирает данных), `tools/standalone-release/prepare.mjs` (артефакт с `release-evidence.json` и `SHA256SUMS`), `sign-overlay.mjs` (оверлей подписи Authenticode для владельца), контрактные тесты, скрипт `test:standalone-release:contract`, строка `tools/ci/affected.mjs`.
- CI (задача 6): задание `standalone-windows-build` вместо `tauri build --debug --no-bundle` собирает хост и установщик в release, запускает `tools/standalone-release/smoke.ps1` на раннере и выкладывает `standalone-installer-<sha>` на 30 дней.
- Документы (задача 7): памятка для ИТ и ручной список `docs/runbooks/standalone-install.md`, раздел «Installer and service» в `apps/standalone/AGENTS.md`.
- Новых крейтов, признаков и npm-пакетов нет: `windows-service` 0.8.1 уже в манифесте хоста под `cfg(windows)` и содержит `service_manager`, `base64` и `serde_json` у хоста есть. Шага владельца с зависимостями нет; `Cargo.lock` и `pnpm-lock.yaml` не меняются.

**Tech Stack:** Rust — `windows-service` 0.8.1, `base64` 0.22.1, `serde_json`, Tauri 2.11 (mock runtime); TypeScript 6 strict, React 19, zod 4.4.3, Vitest 4; Node 24 `node:test`, `js-yaml` (корень); NSIS шаблона Tauri CLI 2.11.4; PowerShell 7 на раннере Windows.

**Спецификации:**

- `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md` — §3 (хост на ПК станции), §4.1 строка 15, §9.4 «Сеть», §10 «Установка, служба, роли ПК», §13 п. 11, §14 (П1, П9, П11, П12, П13), §15 первая строка, §17.
- `docs/superpowers/specs/2026-09-26-standalone-station-design.md` — §5.1 (роли), §6.10 (связь), §9.1 «Установка и первый запуск», §9.2 «Памятка для ИТ», §12.2 «Приёмка на Windows».
- `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` — §4.1 (каталог данных, `service`), §5.1 (киоск-режим и открытый вопрос о ПК офиса), §5.2 (`device.json`), §10 (сертификат хоста, macOS).
- `apps/standalone/AGENTS.md` — «Local pairing trust», «Network and TLS», «Device key and office session», «App shell» (киоск-режим), «Verification».
- Итоговое ревью 1f2 (`.superpowers/sdd/1f2-final-review-report.md`): I1 (каждый ПК под киоск-режимом), ни разу не скомпилированный `cfg(windows)`, зависающий тест вместо падающего, тесты плана, при которых мутанты выживают.
- Образцы выпуска: `apps/signer/src-tauri/tauri.conf.json` и `windows/installer-hooks.nsh`, `tools/signer-release/{prepare,manifest}.mjs` и их тесты, `.github/workflows/signer-stable-release.yml`.

## Допущения по вопросам владельцу

Владелец ответил только на П1; остальное план исполняет по рекомендациям спецификации пилота (§14) и называет здесь:

- **П1 — Б (ответ владельца).** Хост на ПК станции, ПК администратора — офис. Станция на ПК хоста ходит к хосту по `127.0.0.1` и от адреса в сети не зависит.
- **П9 — как рекомендовано.** Резервирование адреса ПК хоста обязательно, Ethernet к станции — если можно; профиль сети «частная». Правило брандмауэра открывает TCP 45710 только в частной и доменной сетях и только для локальной подсети (`-RemoteAddress LocalSubnet`); установщик после установки службы проверяет профили (`network-check`) и предлагает перевести общедоступную сеть в частную. Правило «для всех профилей» план не делает: это решение владельца с ИТ клиента, памятка описывает ручной путь.
- **П11 — А.** ПК офиса не запирается. Признак — роль установщика «только офис» в `installation.json` рядом с исполняемым файлом, а не в `device.json`, как предлагает §10 п. 5 спецификации пилота; причины — в «Решениях планировщика». ПК хоста остаётся станцией и запирается.
- **П12 — без подписи.** Пилот ставим мы сами; SmartScreen покажет «неизвестный издатель», памятка описывает путь. Подпись — `tools/standalone-release/sign-overlay.mjs` на машине владельца с сертификатом в хранилище Windows; в CI подписи нет.
- **П13 — да.** Без лицензии; обновление переустановкой тем же установщиком; обновления из файла и автообновления нет.
- **Учётная запись службы — `NT AUTHORITY\LocalService`** (предположение §17 спецификации пилота): каталог данных получает права по SID, служба в нём пишет, пользователи не читают базу и закрытый ключ TLS.
- **Автозапуск приложения на станциях** (`HKLM\…\Run\MarkiroStandalone` для ролей `host` и `station`, не для `office`) — решение планировщика ради непрерывности линии после перезагрузки; владелец может отменить.
- **WebView2** — режим Tauri по умолчанию (`downloadBootstrapper`): площадка работала с облаком, интернет на ней есть, а на ПК, где стояла облачная станция, WebView2 уже установлен.
- Поиск хоста в сети (mDNS, родительская спецификация §6.10) в пилот не входит: вместо него постоянный адрес и «Сменить адрес хоста» (§9.4 спецификации пилота).

## Global Constraints

**Из спецификаций** (дословные значения)

- Windows 10/11 x64. «Один установщик NSIS, как у станции. При установке выбирается роль: «хост и станция», «только станция» или «только офис».» (родительская §9.1).
- Служба `MarkiroHost` (имя уже в `host/src/service.rs`), подкоманды `markiro-host install` и `uninstall`, автозапуск, действия восстановления при сбое и `sc failureflag MarkiroHost 1` (пилот §10 п. 3).
- Брандмауэр: правило для TCP 45710 и предупреждение о профиле сети; порт открыт «только для частной и доменной сети» (родительская §9.1, пилот §9.4 и §10 п. 4).
- «Удаление программы не стирает каталог данных хоста» (пилот §10). Каталог данных — `%ProgramData%\Markiro\Host` (этап 1 §4.1).
- «Смена адреса хоста с тем же отпечатком»: «новый адрес принимается, только если отпечаток сертификата совпадает с запомненным, поэтому ключ и копии сохраняются» (пилот §9.4, §10 п. 6).
- Памятка для ИТ: служба, порт, каталоги данных и копий, исключения антивируса, отсутствие исходящих соединений (пилот §10 п. 6, родительская §9.2).
- Исходящих соединений в интернет нет (родительская §5.2 п. 4).
- Ключ устройства не пересекает IPC и не уходит на хост, чей сертификат не закреплён (`AGENTS.md`, «Network and TLS»).
- Новые крейты и зависимости — только шагом владельца; этому плану они не нужны: `cargo` везде с `--offline --locked`, `Cargo.lock` и `pnpm-lock.yaml` не меняются.

**Код и процесс**

- Rust: `cargo fmt` чистый, сборка без предупреждений, отказы команд оболочки — голые коды через `code()`, без `unwrap` в коде команд. TypeScript strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`: без `any`, приведений и `!` в исходниках; `import type` для типов; тексты — через `src/i18n/ru.json`, элементы — из `@markiro/ui`.
- Тесты, которые ждут, ограничены и падают, а не висят: ожидания службы — не больше 60 чтений с подложным `sleep`, который считает вызовы; ни один тест не спит по-настоящему.
- Windows-код (`install_windows.rs`, ветки `cfg(windows)` в `main.rs` и `service.rs`, хуки NSIS, `smoke.ps1`) на macOS не исполняется: план говорит, что проверено где (раздел «Что проверяется где»).
- Коммиты — явные пути, трейлер ровно одной строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; push и PR не разрешены.

## Решения планировщика

- **NSIS, а не WiX.** Станция и подписант уже выпускаются NSIS (`bundle.targets: ["nsis"]`, `installerHooks`), Tauri CLI сам скачивает NSIS на раннере, шаблон Tauri даёт хуки до и после копирования файлов и `installMode: "perMachine"`. MSI потребовал бы WiX и своих диалогов и действий для ролей и службы.
- **Роль — два вопроса `MessageBox` в `NSIS_HOOK_PREINSTALL` и `/ROLE=` для тихой установки.** Хуки Tauri не добавляют страниц; свой шаблон `installer.nsi` скопировал бы около 900 строк шаблона Tauri CLI 2.11.4 и ломался бы при обновлении CLI. Роль хранится в `HKLM\Software\Markiro\Standalone\Role` для следующего установщика и в `$INSTDIR\installation.json` для приложения; смена роли — только удалением.
- **Хост — sidecar `bundle.externalBin`, и только в оверлее.** `tauri-build` копирует sidecar во время компиляции и падает без файла (проверено: `resource path 'binaries/markiro-host-aarch64-apple-darwin' doesn't exist`), а `tauri.windows.conf.json` он подмешивает в любую сборку под Windows. Поэтому sidecar — в `tauri.installer.conf.json`, который передаётся только сборке установщика (`--config`); `cargo test` и `tauri build --debug --no-bundle` его не видят.
- **Служба управляется из Rust, а не `sc.exe` из NSIS.** Шов с подделками закрепляет порядок шагов и командные строки тестами на любой ОС, а вывод `sc.exe` на русской Windows не разбирается. Хуки только зовут `markiro-host install | uninstall | stop-service | network-check`.
- **Брандмауэр — PowerShell (`NetSecurity`) в `-EncodedCommand`**, а не `netsh`: путь с пробелами и имя правила в кавычках `netsh` разбирает по своим правилам, а закодированный скрипт ничем не искажается. Правило без `-Program` (порт и локальная подсеть): путь установки не может сделать правило молча нерабочим; привязка к программе — в «Перенесено».
- **Права каталога — `icacls` по SID** (`*S-1-5-18`, `*S-1-5-32-544`, `*S-1-5-19`): имена групп на русской Windows переведены.
- **Признак ПК офиса — `installation.json` рядом с исполняемым файлом, не `device.json`.** `device_forget` удаляет `device.json` — ПК офиса после «Сбросить подключение» заперся бы; `device.json` лежит в `%LOCALAPPDATA%` пользователя и доступен ему на запись — оператор мог бы сделать станцию «ПК офиса»; установщик с правами администратора пишет не в профиль того, кто будет работать; `device.json` читается с `deny_unknown_fields`, и новое поле сломало бы откат на старую сборку. `Program Files` пишут только администраторы. Нет файла или он нечитаем — роли нет, приложение работает станцией (киоск-режим включается).
- **ПК офиса подключается видом `office`.** Хост знает этот вид с этапа 1: маршруты станции (смены, блоки SSCC, линия) ему отказывают, вход в офис разрешён. Дом ПК офиса — «Вход в офис»; на его цех никто не входит.
- **Смена адреса — закреплённый сертификат плюс ключ устройства.** Тот же сертификат значит тот же хост (закрытый ключ есть только у него), а `GET /v1/device` с ключом доказывает, что устройство не отозвано; ключ при этом уходит только хосту с закреплённым сертификатом. Другой сертификат — новый код `address_other_host`, а не `certificate_mismatch`: последний вебвью считает отказом устройства и уводит на повторное подключение.
- **Нового задания CI нет.** `standalone-windows-build` уже запускается на любые изменения автонома; его шаг `tauri build --debug --no-bundle` заменяется сборкой установщика (она компилирует то же приложение в release), а `classify-changes`, `required-results` и их тесты не меняются. В `affected.mjs` — одна строка для `tools/standalone-release/`.
- **Подписи в CI нет.** Секреты задания пулл-реквеста доступны коду этого пулл-реквеста; сертификат подписи кода туда класть нельзя. Хук подписи — оверлей Tauri (`certificateThumbprint`) для машины владельца; состояние подписи записывается в `release-evidence.json`.
- **Удаление не исполняет флажок Tauri «удалить данные приложения»**: локальная база станции может хранить неотправленные факты (план 2a4, «забывание»).
- **Артефакт — только в CI на 30 дней.** Публикации и канала обновлений нет (П13).

## Заметки для исполнения

**Правки**

- «Фрагмент … заменить на …» дан ровно так, как он стоит в файле на начало правки; он встречается в файле один раз. Фрагменты построены сценарием из разности рабочих копий и проверены повторным применением по порядку к копии репозитория на `7cf28790e`: результат совпал с кодом плана байт в байт. Фрагменты одного файла внутри шага идут сверху вниз; шаг 1 (тесты) применяется раньше реализации, поэтому у файла, чьи тесты лежат рядом с кодом (`host/src/main.rs`, `src-tauri/src/device.rs`), фрагмент шага 1 имеет больший номер.
- «Создать» — новый файл ровно как в блоке. `src-tauri/windows/installer-hooks.nsh` после создания получает BOM отдельной командой (шаг задачи 5): блок плана его не показывает.
- `<!-- prettier-ignore -->` перед блоком — пометка для форматирования самого плана, не часть фрагмента. Код в блоках отформатирован prettier и `cargo fmt`.
- Русский текст в коде и в `ru.json` — буквами. Каждая задача с вебвью кончается `grep -rnF '\u04' apps/standalone/src apps/standalone/test`: единственное совпадение — `src/host/pairing-code.ts:66`.

**База и соседние планы**

План написан и проверен на `7cf28790e`. Поток Г исполняет его после 2a4 и ИМП, а поток А параллельно пишет 2a5. Фрагмент, который из-за них не находится, применяется к тому же месту по смыслу, а расхождение записывается в «Отклонения при исполнении»:

- **2a4** (`claude/2a4-shell`): `src-tauri/src/device.rs` (`device_name` в `DeviceConfig` и `DeviceStatus`, `remember` пишет имя), `src-tauri/src/lib.rs` (`host_request` с `timeoutMs`, `device_forget` с `keepUnsent`, команды печати, сканеров и питания в `invoke_handler`), `src-tauri/tests/ipc.rs`, `src/host/device.ts` (`forget(options)`, `deviceName`), `test/app.test.tsx` (`fakeDevice.forget`), `src/i18n/ru.json`. По смыслу: в `remember` заменить только `kind: DeviceKind::Station,` на `kind,` и оставить строку имени; в `invoke_handler` добавить `device_change_address, install_role` после `device_forget`; в `fakeDevice` добавить два члена после `refresh`. `change_address` строит конфигурацию через `..device.config.clone()`, так что поле имени переходит само.
- **ИМП**: `host/src/lib.rs` (`pub mod cloud_import;`), `package.json` (`test:standalone-export`), `.github/workflows/ci.yml`, `tools/ci/affected.mjs` и его тест, `apps/standalone/AGENTS.md`, `src/i18n/ru.json` — только добавления.
- **2a5**: `src/app/App.tsx`, `src/app/shell.ts`, `test/app.test.tsx`, `test/shell.test.ts`. Новое действие оболочки из 2a5 требует строки в исчерпывающей таблице `TABLE` (`test/shell.test.ts`), как `address_changed` здесь.

**Мутации**

- Шаг мутаций проверяет, что тест ловит снятие защиты. Для каждой мутации: `cp <файл> /tmp/claude/before` и `shasum -a 256 <файл>`; правка из блока; команда — ожидаемый FAIL с названным тестом; затем `cp /tmp/claude/before <файл>`, `cmp /tmp/claude/before <файл>` (молчит) и снова `shasum -a 256 <файл>` — тот же хеш. Мутацию не коммитить. Все мутации плана проверены на его коде: каждая валит названный тест.

**Перед каждым коммитом**

- Rust — `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; TS, JS, JSON, MD, YAML — `node_modules/.bin/prettier --check` на изменённые файлы; `git diff --check`.

**pnpm, git, Cargo и тесты**

- pnpm — только с `--config.verifyDepsBeforeRun=false`; `pnpm install` и `pnpm add` не запускать. Команды — из корня репозитория, без `cd`. Не использовать `git stash`. Не передавать вывод тестов в `tail` или `grep`, когда нужен код возврата; если обёртка `rtk` урезала вывод, `rtk proxy <команда>`.
- В свежем worktree сначала: `pnpm --config.verifyDepsBeforeRun=false exec turbo run build --filter='@markiro/standalone^...'`, затем `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build` (оболочка встраивает `apps/standalone/dist`).
- Cargo — с `--offline --locked`. В песочнице проходят наборы хоста `install`, `network_profile` и юнит-тесты `main.rs`, библиотека оболочки; наборы, которые слушают loopback (`host_address`, `ipc`, весь `cargo test --workspace`), — вне песочницы. `node --test tools/ci/test/*.test.mjs` тоже вне песочницы: два теста классификатора зовут `mktemp`, который песочница запрещает (`mkstemp failed … Operation not permitted`), — это не регрессия.
- Под нагрузкой машины (параллельные сборки других потоков) отдельные офисные тесты Vitest с `findBy…` превышали срок ожидания (`devices-page`, `template-editor`, `templates-page`); повторный прогон всего набора зелёный дважды подряд. Это не связано с планом; сроки ожидания не увеличивать, а повторить прогон и записать это в отчёт.

**Что проверяется где**

- **На macOS (исполнитель):** тесты хоста с подделками (`host/tests/install.rs`, `host/tests/network_profile.rs`, разбор команд `main.rs`); крейт-пробник `cargo check --offline --target x86_64-pc-windows-msvc` для `install.rs` и `install_windows.rs` (цель уже установлена: `rustup target list --installed` показывает `x86_64-pc-windows-msvc`; в песочнице проходит); тесты оболочки против настоящего хоста на loopback; Vitest; контрактные тесты Node (оверлей, хуки, шаги задания, проверки `smoke.ps1`); схема оверлея — настоящим Tauri CLI (`tauri build --config src-tauri/tauri.installer.conf.json --debug --no-bundle` с копией хоста под тройкой macOS, задача 5); пробный прогон `prepare.mjs` на подложном установщике.
- **Только в CI (`standalone-windows-build`):** компиляция `main.rs` и `service.rs` под Windows; компиляция хуков NSIS (только сборка установщика их компилирует — `makensis` на macOS нет); `smoke.ps1` на раннере (Windows Server): тихая установка трёх ролей и отказ без роли, учётная запись, автозапуск и действия при сбое службы, перезапуск после убитого процесса, правило брандмауэра, права каталога и ключа TLS, переустановка с тем же хостом, отказ при смене роли, удаление с сохранением данных. PowerShell на macOS не установлен: синтаксис `smoke.ps1` проверяет только CI.
- **Владелец, на Windows 10/11 у себя и у клиента:** установка с окнами (вопросы, русский текст, предупреждение о профиле), SmartScreen и антивирус клиента, два ПК через Wi-Fi, перезагрузка без входа в Windows, отключение питания, смена адреса через роутер, обновление поверх работающей станции, флажок «удалить данные приложения» — список «Ручная проверка на Windows» в памятке (задача 7).

**Счёт тестов** (измерено на копии репозитория на `7cf28790e` с кодом плана; если раньше исполнены 2a4 или ИМП, итоги больше на их тесты)

- До плана: Vitest — 67 файлов, 1744 теста; cargo — 46 наборов, 525 тестов (разбор `main.rs` хоста — 3, библиотека оболочки — 47, `ipc` — 12).
- По задачам: 1 — `install` 11 (новый); 2 — разбор `main.rs` 5, `network_profile` 5 (новый); 3 — библиотека оболочки 52, `host_address` 5 (новый), `ipc` 13; 4 — Vitest 1758 (`device` 29 → 32, `shell` 108 → 112, `app` 91 → 98); 5 — Node: `prepare` 6, `sign-overlay` 2, `installer` 7, `tools/ci/test/affected.test.mjs` 20 (число тестов то же); 6 — Node: `workflow` 2.
- После: Vitest — 67 файлов, 1758 тестов; cargo — 49 наборов, 554 теста; `pnpm test:standalone-release:contract` — 17.

## Файлы

Задачи выполняются по порядку; 1–2 (хост), 3 (оболочка) и 5–6 (установщик и CI) друг от друга по коду не зависят, но 5–6 вызывают подкоманды задачи 2 и команды задачи 3 через установщик, а 4 зовёт команды задачи 3.

<!-- prettier-ignore -->
```text
apps/standalone/host/src/install.rs (новый), host/tests/install.rs (новый),
apps/standalone/host/src/{lib,service}.rs                                  задача 1
apps/standalone/host/src/{network_profile,install_windows}.rs (новые),
apps/standalone/host/tests/network_profile.rs (новый),
apps/standalone/host/src/{lib,main}.rs                                     задача 2
apps/standalone/src-tauri/src/installation.rs (новый),
apps/standalone/src-tauri/src/{device,lib}.rs,
apps/standalone/src-tauri/tests/host_address.rs (новый), tests/ipc.rs      задача 3
apps/standalone/src/host/device.ts, src/app/{App.tsx,shell.ts},
apps/standalone/src/app/HostAddressDialog.tsx (новый),
apps/standalone/src/office/{OfficeLogin,OfficeShell,office-session}.tsx,
apps/standalone/src/i18n/ru.json,
apps/standalone/test/{device.test.ts,shell.test.ts,app.test.tsx}           задача 4
apps/standalone/src-tauri/tauri.installer.conf.json (новый),
apps/standalone/src-tauri/windows/installer-hooks.nsh (новый),
apps/standalone/.gitignore, package.json,
tools/standalone-release/{prepare,sign-overlay}.mjs (новые),
tools/standalone-release/test/{prepare,sign-overlay,installer}.test.mjs (новые),
tools/ci/affected.mjs, tools/ci/test/affected.test.mjs                     задача 5
.github/workflows/ci.yml, tools/standalone-release/smoke.ps1 (новый),
tools/standalone-release/test/workflow.test.mjs (новый)                    задача 6
docs/runbooks/standalone-install.md (новый), apps/standalone/AGENTS.md     задача 7
```

---

### Task 1: Хост — служба `MarkiroHost`: шов, порядок шагов, права каталога, брандмауэр (`host/src/install.rs`)

Что делает установка, закреплено тестами раньше, чем появится Windows-код: порядок `icacls` → остановка прежней службы → конфигурация → правило брандмауэра → запуск → ожидание; точные командные строки; предел ожиданий. Шов `Services` заменяет диспетчер служб, `Commands` — внешние программы, а подложный `sleep` считает паузы, так что ни один тест не ждёт по-настоящему и не висит: служба, которая не запускается, кончается `Timeout` после 60 чтений.

**Files:**

- Create: `apps/standalone/host/src/install.rs`
- Modify: `apps/standalone/host/src/lib.rs`, `apps/standalone/host/src/service.rs`
- Test: `apps/standalone/host/tests/install.rs` (Create)

**Interfaces:**

- Consumes: ничего.
- Produces (`markiro_host::install`):
  - `SERVICE_NAME = "MarkiroHost"`, `FIREWALL_RULE = "MarkiroHost"`, `SERVICE_ACCOUNT = r"NT AUTHORITY\LocalService"`, `WAIT_LIMIT = 30 s`, `POLL_EVERY = 500 ms`, `DATA_DIR_GRANTS: [&str; 3]`;
  - `enum ServiceState { Stopped, StartPending, StopPending, Running, Other }`, `struct ServiceSpec { name, display_name, description, executable: PathBuf, arguments: Vec<String>, account, automatic: bool, restart_delays: [Duration; 3], reset_after: Duration, failure_actions_on_non_crash: bool }`, `fn service_spec(executable: &Path) -> ServiceSpec`;
  - `trait Services { state() -> Result<Option<ServiceState>, InstallError>; configure(&ServiceSpec); start(); stop(); delete() }` (все `&mut self`, ошибка `InstallError`);
  - `struct CommandOutput { code: Option<i32>, stdout: Vec<u8> }`, `trait Commands { fn run(&mut self, program: &str, args: &[String]) -> Result<CommandOutput, InstallError> }`, `struct SystemCommands` (на `std::process::Command`, без окна консоли на Windows);
  - `enum InstallError { Service(String), Spawn { program, reason }, Command { program, code: Option<i32> }, Output { program }, Timeout { waiting_for: ServiceState }, StoppedAfterStart }` (`Display`, `Error`, `Clone`, `PartialEq`);
  - `fn install(data_dir: &Path, executable: &Path, port: u16, services: &mut dyn Services, commands: &mut dyn Commands, sleep: &mut dyn FnMut(Duration)) -> Result<(), InstallError>`, `fn uninstall(services, commands, sleep) -> Result<(), InstallError>`, `fn stop(services, sleep) -> Result<bool, InstallError>` (`false` — службы нет);
  - `fn run_checked(commands, program, args) -> Result<CommandOutput, InstallError>`, `fn icacls_args(&Path) -> Vec<String>`, `fn powershell_args(script: &str) -> Vec<String>`, `fn encode_command(&str) -> String`, `fn firewall_open_script(port: u16) -> String`, `fn firewall_close_script() -> String`.
  - `service::SERVICE_NAME` теперь ссылается на `install::SERVICE_NAME` (под `cfg(windows)`).

- [ ] **Step 1: Тесты порядка шагов, командных строк и пределов ожидания**

Создать `apps/standalone/host/tests/install.rs`:

<!-- prettier-ignore -->
```rust
//! `markiro-host install`, `uninstall` and `stop-service` against fakes of
//! the service manager and of external programs: the order of the steps,
//! the exact command lines, the waits and their limits. The Windows side of
//! the seams (`install_windows.rs`) runs only in `standalone-windows-build`.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::path::Path;
use std::rc::Rc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use markiro_host::install::{
    self, encode_command, firewall_close_script, firewall_open_script, icacls_args, service_spec,
    CommandOutput, Commands, InstallError, ServiceSpec, ServiceState, Services, POLL_EVERY,
};

type Log = Rc<RefCell<Vec<String>>>;

/// The service manager: `state` answers from `states` in order, the last
/// one repeating; every call is logged.
struct FakeServices {
    log: Log,
    states: VecDeque<Option<ServiceState>>,
    configured: Vec<ServiceSpec>,
}

impl FakeServices {
    fn new(log: &Log, states: &[Option<ServiceState>]) -> Self {
        Self {
            log: log.clone(),
            states: states.iter().copied().collect(),
            configured: Vec::new(),
        }
    }
}

impl Services for FakeServices {
    fn state(&mut self) -> Result<Option<ServiceState>, InstallError> {
        self.log.borrow_mut().push("state".into());
        let state = if self.states.len() > 1 {
            self.states.pop_front().expect("a scripted state")
        } else {
            *self.states.front().expect("a scripted state")
        };
        Ok(state)
    }

    fn configure(&mut self, spec: &ServiceSpec) -> Result<(), InstallError> {
        self.log.borrow_mut().push("configure".into());
        self.configured.push(spec.clone());
        Ok(())
    }

    fn start(&mut self) -> Result<(), InstallError> {
        self.log.borrow_mut().push("start".into());
        Ok(())
    }

    fn stop(&mut self) -> Result<(), InstallError> {
        self.log.borrow_mut().push("stop".into());
        Ok(())
    }

    fn delete(&mut self) -> Result<(), InstallError> {
        self.log.borrow_mut().push("delete".into());
        Ok(())
    }
}

/// External programs: each run is logged as `run <program>` and its
/// arguments kept; `codes` answers per program (0 when not named), and
/// `stdout` answers in order.
struct FakeCommands {
    log: Log,
    runs: Vec<(String, Vec<String>)>,
    codes: Vec<(&'static str, i32)>,
    stdout: VecDeque<Vec<u8>>,
}

impl FakeCommands {
    fn new(log: &Log) -> Self {
        Self {
            log: log.clone(),
            runs: Vec::new(),
            codes: Vec::new(),
            stdout: VecDeque::new(),
        }
    }
}

impl Commands for FakeCommands {
    fn run(&mut self, program: &str, args: &[String]) -> Result<CommandOutput, InstallError> {
        self.log.borrow_mut().push(format!("run {program}"));
        self.runs.push((program.to_owned(), args.to_vec()));
        let code = self
            .codes
            .iter()
            .find(|(name, _)| *name == program)
            .map_or(0, |(_, code)| *code);
        Ok(CommandOutput {
            code: Some(code),
            stdout: self.stdout.pop_front().unwrap_or_default(),
        })
    }
}

/// The script inside `powershell.exe … -EncodedCommand <base64>`.
fn script_of(args: &[String]) -> String {
    assert_eq!(
        args[..5],
        [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand"
        ]
    );
    assert_eq!(args.len(), 6);
    let bytes = STANDARD.decode(&args[5]).expect("base64");
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    String::from_utf16(&units).expect("UTF-16LE")
}

const DATA_DIR: &str = r"C:\ProgramData\Markiro\Host";
const EXE: &str = r"C:\Program Files\Markiro Standalone\markiro-host.exe";

/// The waits' sleeps, counted.
fn counting_sleep(count: &Rc<RefCell<Vec<Duration>>>) -> impl FnMut(Duration) {
    let count = count.clone();
    move |delay| count.borrow_mut().push(delay)
}

#[test]
fn install_hardens_the_data_dir_registers_the_service_opens_the_port_and_waits_until_it_runs() {
    let log = Log::default();
    let mut services = FakeServices::new(
        &log,
        &[
            None,
            Some(ServiceState::StartPending),
            Some(ServiceState::StartPending),
            Some(ServiceState::Running),
        ],
    );
    let mut commands = FakeCommands::new(&log);
    let sleeps = Rc::new(RefCell::new(Vec::new()));
    install::install(
        Path::new(DATA_DIR),
        Path::new(EXE),
        45710,
        &mut services,
        &mut commands,
        &mut counting_sleep(&sleeps),
    )
    .unwrap();

    assert_eq!(
        *log.borrow(),
        [
            "run icacls",
            "state",
            "configure",
            "run powershell.exe",
            "start",
            "state",
            "state",
            "state",
        ]
    );
    assert_eq!(*sleeps.borrow(), [POLL_EVERY, POLL_EVERY]);
    assert_eq!(services.configured, [service_spec(Path::new(EXE))]);
    assert_eq!(
        commands.runs[0],
        (
            "icacls".to_owned(),
            vec![
                DATA_DIR.to_owned(),
                "/inheritance:r".to_owned(),
                "/grant:r".to_owned(),
                "*S-1-5-18:(OI)(CI)F".to_owned(),
                "*S-1-5-32-544:(OI)(CI)F".to_owned(),
                "*S-1-5-19:(OI)(CI)M".to_owned(),
            ]
        )
    );
    assert_eq!(commands.runs[1].0, "powershell.exe");
    assert_eq!(script_of(&commands.runs[1].1), firewall_open_script(45710));
}

#[test]
fn the_service_runs_as_local_service_at_boot_and_restarts_after_any_failure() {
    let spec = service_spec(Path::new(EXE));
    assert_eq!(
        spec,
        ServiceSpec {
            name: "MarkiroHost",
            display_name: "Markiro Хост",
            description: "Главная база Markiro Автоном: станции и офис площадки подключаются к ней по HTTPS, порт 45710.",
            executable: EXE.into(),
            arguments: vec!["service".to_owned()],
            account: r"NT AUTHORITY\LocalService",
            automatic: true,
            restart_delays: [
                Duration::from_secs(5),
                Duration::from_secs(30),
                Duration::from_secs(60),
            ],
            reset_after: Duration::from_secs(86_400),
            failure_actions_on_non_crash: true,
        }
    );
}

#[test]
fn install_over_a_running_service_stops_it_first_and_starts_it_again() {
    let log = Log::default();
    let mut services = FakeServices::new(
        &log,
        &[
            Some(ServiceState::Running),
            Some(ServiceState::StopPending),
            Some(ServiceState::Stopped),
            Some(ServiceState::Running),
        ],
    );
    let mut commands = FakeCommands::new(&log);
    let sleeps = Rc::new(RefCell::new(Vec::new()));
    install::install(
        Path::new(DATA_DIR),
        Path::new(EXE),
        45710,
        &mut services,
        &mut commands,
        &mut counting_sleep(&sleeps),
    )
    .unwrap();
    assert_eq!(
        *log.borrow(),
        [
            "run icacls",
            "state",
            "stop",
            "state",
            "state",
            "configure",
            "run powershell.exe",
            "start",
            "state",
        ]
    );
    assert_eq!(sleeps.borrow().len(), 1);
}

#[test]
fn a_refused_access_list_registers_nothing() {
    let log = Log::default();
    let mut services = FakeServices::new(&log, &[None]);
    let mut commands = FakeCommands::new(&log);
    commands.codes.push(("icacls", 5));
    let result = install::install(
        Path::new(DATA_DIR),
        Path::new(EXE),
        45710,
        &mut services,
        &mut commands,
        &mut |_| panic!("nothing waits"),
    );
    assert_eq!(
        result,
        Err(InstallError::Command {
            program: "icacls".into(),
            code: Some(5)
        })
    );
    assert_eq!(*log.borrow(), ["run icacls"]);
}

#[test]
fn a_service_that_stops_right_after_its_start_fails_the_install() {
    let log = Log::default();
    let mut services = FakeServices::new(
        &log,
        &[
            None,
            Some(ServiceState::StartPending),
            Some(ServiceState::Stopped),
        ],
    );
    let mut commands = FakeCommands::new(&log);
    let sleeps = Rc::new(RefCell::new(Vec::new()));
    let result = install::install(
        Path::new(DATA_DIR),
        Path::new(EXE),
        45710,
        &mut services,
        &mut commands,
        &mut counting_sleep(&sleeps),
    );
    assert_eq!(result, Err(InstallError::StoppedAfterStart));
}

#[test]
fn a_service_that_never_runs_fails_after_the_wait_limit_instead_of_hanging() {
    let log = Log::default();
    let mut services = FakeServices::new(&log, &[None, Some(ServiceState::StartPending)]);
    let mut commands = FakeCommands::new(&log);
    let sleeps = Rc::new(RefCell::new(Vec::new()));
    let result = install::install(
        Path::new(DATA_DIR),
        Path::new(EXE),
        45710,
        &mut services,
        &mut commands,
        &mut counting_sleep(&sleeps),
    );
    assert_eq!(
        result,
        Err(InstallError::Timeout {
            waiting_for: ServiceState::Running
        })
    );
    // 30 s in steps of 0.5 s: sixty reads, a sleep after each.
    assert_eq!(sleeps.borrow().len(), 60);
}

#[test]
fn uninstall_stops_and_removes_the_service_and_the_rule_and_never_touches_the_data() {
    let log = Log::default();
    let mut services = FakeServices::new(
        &log,
        &[Some(ServiceState::Running), Some(ServiceState::Stopped)],
    );
    let mut commands = FakeCommands::new(&log);
    let sleeps = Rc::new(RefCell::new(Vec::new()));
    install::uninstall(&mut services, &mut commands, &mut counting_sleep(&sleeps)).unwrap();
    assert_eq!(
        *log.borrow(),
        ["state", "stop", "state", "delete", "run powershell.exe"]
    );
    assert_eq!(script_of(&commands.runs[0].1), firewall_close_script());
    assert!(commands.runs.iter().all(|(program, _)| program != "icacls"));
}

#[test]
fn uninstall_without_a_service_still_removes_the_rule() {
    let log = Log::default();
    let mut services = FakeServices::new(&log, &[None]);
    let mut commands = FakeCommands::new(&log);
    install::uninstall(&mut services, &mut commands, &mut |_| {
        panic!("nothing waits")
    })
    .unwrap();
    assert_eq!(*log.borrow(), ["state", "run powershell.exe"]);
}

#[test]
fn stop_answers_whether_there_was_a_service_and_waits_for_it_to_stop() {
    let log = Log::default();
    let mut missing = FakeServices::new(&log, &[None]);
    assert_eq!(install::stop(&mut missing, &mut |_| ()), Ok(false));
    let mut stopped = FakeServices::new(&log, &[Some(ServiceState::Stopped)]);
    assert_eq!(install::stop(&mut stopped, &mut |_| ()), Ok(true));
    assert_eq!(
        *log.borrow(),
        ["state", "state"],
        "nothing was asked to stop"
    );

    let mut stuck = FakeServices::new(&log, &[Some(ServiceState::StopPending)]);
    let sleeps = Rc::new(RefCell::new(Vec::new()));
    assert_eq!(
        install::stop(&mut stuck, &mut counting_sleep(&sleeps)),
        Err(InstallError::Timeout {
            waiting_for: ServiceState::Stopped
        })
    );
    assert_eq!(sleeps.borrow().len(), 60);
}

#[test]
fn the_firewall_rule_opens_the_port_on_private_and_domain_networks_from_the_local_subnet_only() {
    assert_eq!(
        firewall_open_script(45710),
        "$ErrorActionPreference = 'Stop'; \
Remove-NetFirewallRule -Name 'MarkiroHost' -ErrorAction SilentlyContinue; \
New-NetFirewallRule -Name 'MarkiroHost' -DisplayName 'Markiro Хост (TCP 45710)' \
-Direction Inbound -Action Allow -Protocol TCP -LocalPort 45710 \
-Profile Private,Domain -RemoteAddress LocalSubnet | Out-Null"
    );
    assert_eq!(
        firewall_close_script(),
        "Remove-NetFirewallRule -Name 'MarkiroHost' -ErrorAction SilentlyContinue; exit 0"
    );
}

#[test]
fn an_encoded_command_is_base64_of_utf16le() {
    // `powershell -EncodedCommand ZABpAHIA` runs `dir` (Microsoft's own example).
    assert_eq!(encode_command("dir"), "ZABpAHIA");
    assert_eq!(
        icacls_args(Path::new(DATA_DIR))[..3],
        [DATA_DIR, "/inheritance:r", "/grant:r"]
    );
}
```

- [ ] **Step 2: Убедиться, что набор не собирается**

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test install`
Expected: FAIL — ``error[E0432]: unresolved imports `markiro_host::install` ``.

- [ ] **Step 3: Модуль `install.rs`, его строка в `lib.rs` и имя службы в `service.rs`**

Создать `apps/standalone/host/src/install.rs`:

<!-- prettier-ignore -->
```rust
//! Installing `markiro-host` as the Windows service `MarkiroHost` (plan УСТ):
//! the data directory's permissions, the service with its restart policy,
//! the firewall rule for the host's port, and taking them away again. The
//! installer runs `markiro-host install`, `uninstall` and `stop-service`
//! (`src-tauri/windows/installer-hooks.nsh`).
//!
//! Everything here goes through two seams, so the order of the steps and the
//! exact command lines are tested on any OS: [`Services`] (the Windows
//! service manager: `install_windows::WindowsServices`) and [`Commands`]
//! (external programs: [`SystemCommands`]). Uninstalling never touches the
//! data directory.

use std::fmt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;

/// The service name; `service.rs` dispatches under the same one.
pub const SERVICE_NAME: &str = "MarkiroHost";
/// The firewall rule's name (`Get-NetFirewallRule -Name MarkiroHost`).
pub const FIREWALL_RULE: &str = "MarkiroHost";
/// `NT AUTHORITY\LocalService`: no password, no administrator rights, and the
/// network as an anonymous user, which a host that only listens never needs.
pub const SERVICE_ACCOUNT: &str = r"NT AUTHORITY\LocalService";
/// How long `install` waits for the service to run, and any command for it to stop.
pub const WAIT_LIMIT: Duration = Duration::from_secs(30);
/// How often the state is read while waiting.
pub const POLL_EVERY: Duration = Duration::from_millis(500);

/// The data directory's access list: inheritance from `ProgramData` off
/// (users lose read access to the database and the TLS key), full control
/// for SYSTEM (`S-1-5-18`) and Administrators (`S-1-5-32-544`), modify for
/// the service's LocalService (`S-1-5-19`), inherited by everything inside.
/// SIDs, not names, because names are translated on a Russian Windows.
pub const DATA_DIR_GRANTS: [&str; 3] = [
    "*S-1-5-18:(OI)(CI)F",
    "*S-1-5-32-544:(OI)(CI)F",
    "*S-1-5-19:(OI)(CI)M",
];

/// What a service reports while `install` and `stop` wait for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServiceState {
    Stopped,
    StartPending,
    StopPending,
    Running,
    /// Paused, or a state this code has no use for.
    Other,
}

/// The service as `install` registers it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceSpec {
    pub name: &'static str,
    pub display_name: &'static str,
    pub description: &'static str,
    pub executable: PathBuf,
    pub arguments: Vec<String>,
    pub account: &'static str,
    /// Starts with Windows, before anybody signs in.
    pub automatic: bool,
    /// One restart per failure, after these delays; the last repeats.
    pub restart_delays: [Duration; 3],
    /// A day without failures starts the count again.
    pub reset_after: Duration,
    /// `sc failureflag MarkiroHost 1`: an exit with an error code
    /// (`service.rs` reports `ServiceSpecific(1)`) counts as a failure too,
    /// not only a crash.
    pub failure_actions_on_non_crash: bool,
}

/// The service `install` registers for the host binary at `executable`.
pub fn service_spec(executable: &Path) -> ServiceSpec {
    ServiceSpec {
        name: SERVICE_NAME,
        display_name: "Markiro Хост",
        description: "Главная база Markiro Автоном: станции и офис площадки подключаются к ней по HTTPS, порт 45710.",
        executable: executable.to_path_buf(),
        arguments: vec!["service".to_owned()],
        account: SERVICE_ACCOUNT,
        automatic: true,
        restart_delays: [
            Duration::from_secs(5),
            Duration::from_secs(30),
            Duration::from_secs(60),
        ],
        reset_after: Duration::from_secs(24 * 60 * 60),
        failure_actions_on_non_crash: true,
    }
}

/// The Windows service manager, as far as installing needs it.
pub trait Services {
    /// `None` when no service of this name is installed.
    fn state(&mut self) -> Result<Option<ServiceState>, InstallError>;
    /// Creates the service, or rewrites the whole configuration of an existing one.
    fn configure(&mut self, spec: &ServiceSpec) -> Result<(), InstallError>;
    /// Asks a stopped service to start; a running one stays as it is.
    fn start(&mut self) -> Result<(), InstallError>;
    /// Asks a running service to stop; a stopped one stays as it is.
    fn stop(&mut self) -> Result<(), InstallError>;
    /// Removes the registration; Windows finishes once the last handle closes.
    fn delete(&mut self) -> Result<(), InstallError>;
}

/// A finished external program.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandOutput {
    /// `None` when the program ended without a code.
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
}

/// External programs (`icacls`, `powershell`).
pub trait Commands {
    fn run(&mut self, program: &str, args: &[String]) -> Result<CommandOutput, InstallError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallError {
    /// The service manager refused; the text is the system's.
    Service(String),
    /// A program could not be started.
    Spawn { program: String, reason: String },
    /// A program ended with another code than 0.
    Command { program: String, code: Option<i32> },
    /// A program's output is not what it should print.
    Output { program: String },
    /// The service did not reach `waiting_for` within [`WAIT_LIMIT`].
    Timeout { waiting_for: ServiceState },
    /// The service stopped right after it was started: see the host's log.
    StoppedAfterStart,
}

impl fmt::Display for InstallError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            InstallError::Service(reason) => write!(formatter, "service manager: {reason}"),
            InstallError::Spawn { program, reason } => {
                write!(formatter, "{program} could not start: {reason}")
            }
            InstallError::Command { program, code } => match code {
                Some(code) => write!(formatter, "{program} ended with code {code}"),
                None => write!(formatter, "{program} ended without a code"),
            },
            InstallError::Output { program } => {
                write!(formatter, "{program} printed an unexpected answer")
            }
            InstallError::Timeout { waiting_for } => write!(
                formatter,
                "the service did not reach {waiting_for:?} in {} s",
                WAIT_LIMIT.as_secs()
            ),
            InstallError::StoppedAfterStart => write!(
                formatter,
                "the service stopped right after it started; see logs in the host's data directory"
            ),
        }
    }
}

impl std::error::Error for InstallError {}

/// Register and start the host service (the installer's role «хост и станция»):
/// harden `data_dir`, stop a service an earlier version left running, write
/// the configuration, open `port` in the firewall, start, and wait until it
/// runs. Repeating it over an installed service converges on the same state.
pub fn install(
    data_dir: &Path,
    executable: &Path,
    port: u16,
    services: &mut dyn Services,
    commands: &mut dyn Commands,
    sleep: &mut dyn FnMut(Duration),
) -> Result<(), InstallError> {
    run_checked(commands, "icacls", &icacls_args(data_dir))?;
    stop(services, sleep)?;
    services.configure(&service_spec(executable))?;
    run_checked(
        commands,
        "powershell.exe",
        &powershell_args(&firewall_open_script(port)),
    )?;
    services.start()?;
    wait_until_running(services, sleep)
}

/// Stop and remove the host service and its firewall rule. The data
/// directory stays: the database, the TLS identity and the logs survive an
/// uninstall, so a reinstall brings back the same host for every paired device.
pub fn uninstall(
    services: &mut dyn Services,
    commands: &mut dyn Commands,
    sleep: &mut dyn FnMut(Duration),
) -> Result<(), InstallError> {
    if stop(services, sleep)? {
        services.delete()?;
    }
    run_checked(
        commands,
        "powershell.exe",
        &powershell_args(&firewall_close_script()),
    )?;
    Ok(())
}

/// Stop the service and wait until it has stopped; `Ok(false)` when there is
/// no such service. The installer calls it before it replaces the binary.
pub fn stop(
    services: &mut dyn Services,
    sleep: &mut dyn FnMut(Duration),
) -> Result<bool, InstallError> {
    match services.state()? {
        None => return Ok(false),
        Some(ServiceState::Stopped) => return Ok(true),
        Some(_) => services.stop()?,
    }
    for _ in 0..polls() {
        match services.state()? {
            None | Some(ServiceState::Stopped) => return Ok(true),
            Some(_) => sleep(POLL_EVERY),
        }
    }
    Err(InstallError::Timeout {
        waiting_for: ServiceState::Stopped,
    })
}

fn wait_until_running(
    services: &mut dyn Services,
    sleep: &mut dyn FnMut(Duration),
) -> Result<(), InstallError> {
    for _ in 0..polls() {
        match services.state()? {
            Some(ServiceState::Running) => return Ok(()),
            Some(ServiceState::Stopped) | None => return Err(InstallError::StoppedAfterStart),
            Some(_) => sleep(POLL_EVERY),
        }
    }
    Err(InstallError::Timeout {
        waiting_for: ServiceState::Running,
    })
}

fn polls() -> u32 {
    (WAIT_LIMIT.as_millis() / POLL_EVERY.as_millis()) as u32
}

/// Runs `program` and requires exit code 0.
pub fn run_checked(
    commands: &mut dyn Commands,
    program: &str,
    args: &[String],
) -> Result<CommandOutput, InstallError> {
    let output = commands.run(program, args)?;
    if output.code == Some(0) {
        Ok(output)
    } else {
        Err(InstallError::Command {
            program: program.to_owned(),
            code: output.code,
        })
    }
}

/// `icacls <dir> /inheritance:r /grant:r <DATA_DIR_GRANTS…>`.
pub fn icacls_args(data_dir: &Path) -> Vec<String> {
    let mut args = vec![
        data_dir.display().to_string(),
        "/inheritance:r".to_owned(),
        "/grant:r".to_owned(),
    ];
    args.extend(DATA_DIR_GRANTS.iter().map(|grant| (*grant).to_owned()));
    args
}

/// Windows PowerShell with a script passed as `-EncodedCommand`, so no
/// quoting rule of the command line can change it.
pub fn powershell_args(script: &str) -> Vec<String> {
    vec![
        "-NoProfile".to_owned(),
        "-NonInteractive".to_owned(),
        "-ExecutionPolicy".to_owned(),
        "Bypass".to_owned(),
        "-EncodedCommand".to_owned(),
        encode_command(script),
    ]
}

/// `-EncodedCommand`'s form: base64 of the script in UTF-16LE.
pub fn encode_command(script: &str) -> String {
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    STANDARD.encode(bytes)
}

/// The inbound rule for the host's port: TCP only, private and domain
/// networks only, and only from the local subnet. A Wi-Fi network Windows
/// counts as public is left closed; `network-check` offers to change that.
pub fn firewall_open_script(port: u16) -> String {
    format!(
        "$ErrorActionPreference = 'Stop'; \
Remove-NetFirewallRule -Name '{FIREWALL_RULE}' -ErrorAction SilentlyContinue; \
New-NetFirewallRule -Name '{FIREWALL_RULE}' -DisplayName 'Markiro Хост (TCP {port})' \
-Direction Inbound -Action Allow -Protocol TCP -LocalPort {port} \
-Profile Private,Domain -RemoteAddress LocalSubnet | Out-Null"
    )
}

/// Removes the rule; a rule that is already gone is no error.
pub fn firewall_close_script() -> String {
    format!("Remove-NetFirewallRule -Name '{FIREWALL_RULE}' -ErrorAction SilentlyContinue; exit 0")
}

/// External programs through `std::process::Command`, without a console
/// window on Windows (the installer is a window of its own).
pub struct SystemCommands;

impl Commands for SystemCommands {
    fn run(&mut self, program: &str, args: &[String]) -> Result<CommandOutput, InstallError> {
        let mut command = std::process::Command::new(program);
        command.args(args);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // `CREATE_NO_WINDOW`.
            const NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(NO_WINDOW);
        }
        let output = command.output().map_err(|error| InstallError::Spawn {
            program: program.to_owned(),
            reason: error.to_string(),
        })?;
        Ok(CommandOutput {
            code: output.status.code(),
            stdout: output.stdout,
        })
    }
}
```

Правка `apps/standalone/host/src/lib.rs`:

Фрагмент 1:

<!-- prettier-ignore -->
```rust
pub mod error;
pub mod feed;
pub mod logging;
pub mod network;
```

заменить на:

<!-- prettier-ignore -->
```rust
pub mod error;
pub mod feed;
pub mod install;
pub mod logging;
pub mod network;
```

Правка `apps/standalone/host/src/service.rs`:

Фрагмент 1:

<!-- prettier-ignore -->
```rust
//! Windows service entry point. The installer registers `MarkiroHost` in
//! stage 5; this module only answers the service manager.

use std::ffi::OsString;
```

заменить на:

<!-- prettier-ignore -->
```rust
//! Windows service entry point. `markiro-host install` (`install.rs`, plan
//! УСТ) registers `MarkiroHost`; this module only answers the service manager.

use std::ffi::OsString;
```

Фрагмент 2:

<!-- prettier-ignore -->
```rust
use crate::{BoxError, StartOptions};

pub const SERVICE_NAME: &str = "MarkiroHost";

/// Recovery actions configured on the service (installer, stage 5) must see a
/// failure, not a clean stop. The installer must also enable failure actions
/// for non-crash exits (`sc failureflag MarkiroHost 1`), or Windows ignores
/// this exit code.
const FAILURE_EXIT_CODE: u32 = 1;

```

заменить на:

<!-- prettier-ignore -->
```rust
use crate::{BoxError, StartOptions};

pub const SERVICE_NAME: &str = crate::install::SERVICE_NAME;

/// Recovery actions configured on the service (`install::service_spec`) must
/// see a failure, not a clean stop. `install` also enables failure actions
/// for non-crash exits (`sc failureflag MarkiroHost 1`), without which
/// Windows ignores this exit code.
const FAILURE_EXIT_CODE: u32 = 1;

```

`service.rs` компилируется только под Windows: его правку проверяет задание `standalone-windows-build` (задача 6). Строки описания службы — буквами; длинные строки `cargo fmt` не переносит.

- [ ] **Step 4: Набор проходит, библиотека собирается без предупреждений**

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test install --lib`
Expected: PASS — `install` 11 тестов, библиотека хоста 57; ни одного `warning`.

- [ ] **Step 5: Мутации**

В `apps/standalone/host/src/install.rs` фрагмент

<!-- prettier-ignore -->
```rust
        failure_actions_on_non_crash: true,
    }
}
```

заменить на

<!-- prettier-ignore -->
```rust
        failure_actions_on_non_crash: false,
    }
}
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test install`
Expected: FAIL — `the_service_runs_as_local_service_at_boot_and_restarts_after_any_failure`. Затем вернуть файл (`cp /tmp/claude/before <файл>`, `cmp` молчит, `shasum -a 256` — тот же хеш).

В `apps/standalone/host/src/install.rs` фрагмент

<!-- prettier-ignore -->
```rust
    run_checked(commands, "icacls", &icacls_args(data_dir))?;
    stop(services, sleep)?;
```

заменить на

<!-- prettier-ignore -->
```rust
    run_checked(commands, "icacls", &icacls_args(data_dir))?;
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test install`
Expected: FAIL — `install_over_a_running_service_stops_it_first_and_starts_it_again`. Затем вернуть файл (`cp /tmp/claude/before <файл>`, `cmp` молчит, `shasum -a 256` — тот же хеш).

В `apps/standalone/host/src/install.rs` фрагмент

<!-- prettier-ignore -->
```rust
            Some(ServiceState::Stopped) | None => return Err(InstallError::StoppedAfterStart),
```

заменить на

<!-- prettier-ignore -->
```rust
            Some(ServiceState::Stopped) | None => sleep(POLL_EVERY),
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test install`
Expected: FAIL — `a_service_that_stops_right_after_its_start_fails_the_install` (вместо `StoppedAfterStart` — `Timeout` после 60 пауз, тест кончается сразу). Затем вернуть файл (`cp /tmp/claude/before <файл>`, `cmp` молчит, `shasum -a 256` — тот же хеш).

В `apps/standalone/host/src/install.rs` фрагмент

<!-- prettier-ignore -->
```rust
    if stop(services, sleep)? {
        services.delete()?;
    }
```

заменить на

<!-- prettier-ignore -->
```rust
    stop(services, sleep)?;
    services.delete()?;
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test install`
Expected: FAIL — `uninstall_without_a_service_still_removes_the_rule` (в журнале лишний `delete`). Затем вернуть файл (`cp /tmp/claude/before <файл>`, `cmp` молчит, `shasum -a 256` — тот же хеш).

- [ ] **Step 6: Коммит**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
git diff --check
git add apps/standalone/host/src/install.rs apps/standalone/host/src/lib.rs \
  apps/standalone/host/src/service.rs apps/standalone/host/tests/install.rs
git commit -m "feat(standalone): the host installs itself as the MarkiroHost service behind a testable seam" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Хост — профиль сети, адаптер Windows и подкоманды `install`, `uninstall`, `stop-service`, `network-check`

Установщик зовёт хост его же подкомандами. `network-check` читает профили сети одной командой PowerShell и отвечает кодом 3, пока сеть общедоступна; с `--make-private` сначала переводит такие сети в частные. Разбор вывода и решение «какие сети менять» — платформенно-независимые и закреплены тестами с подложной оболочкой; категория идёт текстом (`[string]$_.NetworkCategory`), а не числом, которым Windows PowerShell 5.1 пишет перечисление, и в UTF-8 — имя адаптера на русской Windows кириллическое. `install_windows.rs` реализует `Services` на `windows-service` и компилируется только под Windows; на macOS его проверяет крейт-пробник (шаг 5).

**Files:**

- Create: `apps/standalone/host/src/network_profile.rs`, `apps/standalone/host/src/install_windows.rs`
- Modify: `apps/standalone/host/src/lib.rs`, `apps/standalone/host/src/main.rs`
- Test: `apps/standalone/host/tests/network_profile.rs` (Create), разбор команд в `main.rs` (`mod tests`)

**Interfaces:**

- Consumes: `install::{Commands, CommandOutput, InstallError, powershell_args, run_checked, SystemCommands, install, uninstall, stop, Services, ServiceSpec, ServiceState, SERVICE_NAME}` (задача 1).
- Produces:
  - `markiro_host::network_profile`: `PUBLIC_REMAINS: u8 = 3`, `struct NetworkProfile { index: u32, alias: String, category: String }` с `is_public()`, `LIST_SCRIPT: &str`, `fn make_private_script(index: u32) -> String`, `fn parse_profiles(&[u8]) -> Result<Vec<NetworkProfile>, InstallError>`, `fn check(commands: &mut dyn Commands, make_private: bool) -> Result<Vec<NetworkProfile>, InstallError>`;
  - `markiro_host::install_windows::WindowsServices` (`cfg(windows)`): `fn connect() -> Result<Self, InstallError>` и `impl Services`;
  - командная строка: `markiro-host install` (код 0 или 1), `uninstall`, `stop-service` (вне Windows — отказ «only available on Windows»), `network-check [--make-private]` (0 — общедоступных сетей нет, 3 — осталась, 1 — ошибка). Эти имена и коды читают хуки NSIS (задача 5).

- [ ] **Step 1: Тесты разбора профилей и разбора команд**

Создать `apps/standalone/host/tests/network_profile.rs`:

<!-- prettier-ignore -->
```rust
//! `markiro-host network-check` against a fake PowerShell: reading what
//! `Get-NetConnectionProfile` prints, and making a public network private.

use std::collections::VecDeque;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use markiro_host::install::{CommandOutput, Commands, InstallError};
use markiro_host::network_profile::{
    check, make_private_script, parse_profiles, NetworkProfile, LIST_SCRIPT,
};

fn profile(index: u32, alias: &str, category: &str) -> NetworkProfile {
    NetworkProfile {
        index,
        alias: alias.into(),
        category: category.into(),
    }
}

#[test]
fn reads_an_array_one_profile_or_nothing() {
    let wifi = profile(12, "Беспроводная сеть", "Public");
    let cable = profile(7, "Ethernet", "Private");
    assert_eq!(
        parse_profiles(
            r#"[{"index":12,"alias":"Беспроводная сеть","category":"Public"},{"index":7,"alias":"Ethernet","category":"Private"}]"#
                .as_bytes()
        ),
        Ok(vec![wifi.clone(), cable])
    );
    assert_eq!(
        parse_profiles(
            "\u{feff}{\"index\":12,\"alias\":\"Беспроводная сеть\",\"category\":\"Public\"}\r\n"
                .as_bytes()
        ),
        Ok(vec![wifi])
    );
    assert_eq!(parse_profiles(b""), Ok(vec![]));
    assert_eq!(parse_profiles(b"  \r\n"), Ok(vec![]));
    assert_eq!(parse_profiles(b"[]"), Ok(vec![]));
    assert_eq!(
        parse_profiles(b"Get-NetConnectionProfile : access denied"),
        Err(InstallError::Output {
            program: "Get-NetConnectionProfile".into()
        })
    );
}

#[test]
fn only_a_public_network_is_public() {
    assert!(profile(1, "Wi-Fi", "Public").is_public());
    assert!(!profile(1, "Wi-Fi", "Private").is_public());
    assert!(!profile(1, "Wi-Fi", "DomainAuthenticated").is_public());
}

/// PowerShell: answers each run with the next output, and keeps the scripts.
struct FakeShell {
    outputs: VecDeque<&'static str>,
    scripts: Vec<String>,
}

impl Commands for FakeShell {
    fn run(&mut self, program: &str, args: &[String]) -> Result<CommandOutput, InstallError> {
        assert_eq!(program, "powershell.exe");
        let bytes = STANDARD.decode(args.last().expect("a script")).unwrap();
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        self.scripts.push(String::from_utf16(&units).unwrap());
        Ok(CommandOutput {
            code: Some(0),
            stdout: self.outputs.pop_front().unwrap_or_default().into(),
        })
    }
}

const PUBLIC_WIFI_AND_PRIVATE_CABLE: &str = r#"[{"index":12,"alias":"Wi-Fi","category":"Public"},{"index":7,"alias":"Ethernet","category":"Private"}]"#;

#[test]
fn make_private_changes_only_the_public_networks_and_reads_them_again() {
    let mut shell = FakeShell {
        outputs: [
            PUBLIC_WIFI_AND_PRIVATE_CABLE,
            "",
            r#"[{"index":12,"alias":"Wi-Fi","category":"Private"},{"index":7,"alias":"Ethernet","category":"Private"}]"#,
        ]
        .into(),
        scripts: Vec::new(),
    };
    let profiles = check(&mut shell, true).unwrap();
    assert_eq!(
        shell.scripts,
        [
            LIST_SCRIPT.to_owned(),
            make_private_script(12),
            LIST_SCRIPT.to_owned()
        ]
    );
    assert!(profiles.iter().all(|profile| !profile.is_public()));
    assert_eq!(
        make_private_script(12),
        "$ErrorActionPreference = 'Stop'; Set-NetConnectionProfile -InterfaceIndex 12 -NetworkCategory Private"
    );
}

#[test]
fn without_make_private_the_check_only_reads() {
    let mut shell = FakeShell {
        outputs: [PUBLIC_WIFI_AND_PRIVATE_CABLE].into(),
        scripts: Vec::new(),
    };
    let profiles = check(&mut shell, false).unwrap();
    assert_eq!(shell.scripts, [LIST_SCRIPT.to_owned()]);
    assert_eq!(
        profiles,
        vec![
            profile(12, "Wi-Fi", "Public"),
            profile(7, "Ethernet", "Private")
        ]
    );
}

#[test]
fn the_list_script_reports_the_category_as_text_in_utf8() {
    assert!(LIST_SCRIPT.contains("[Console]::OutputEncoding = [System.Text.Encoding]::UTF8"));
    assert!(LIST_SCRIPT.contains("category = [string]$_.NetworkCategory"));
    assert!(LIST_SCRIPT.contains("ConvertTo-Json -Compress -InputObject $profiles"));
}
```

Правка `apps/standalone/host/src/main.rs`:

Фрагмент 6:

<!-- prettier-ignore -->
```rust

    #[test]
    fn print_fingerprint_on_an_empty_dir_is_an_error_and_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
```

заменить на:

<!-- prettier-ignore -->
```rust

    #[test]
    fn the_installer_commands_take_no_arguments_but_the_network_flag() {
        assert_eq!(parse(&args(&["install"])), Ok(Command::Install));
        assert_eq!(parse(&args(&["uninstall"])), Ok(Command::Uninstall));
        assert_eq!(parse(&args(&["stop-service"])), Ok(Command::StopService));
        assert_eq!(
            parse(&args(&["network-check"])),
            Ok(Command::NetworkCheck {
                make_private: false
            })
        );
        assert_eq!(
            parse(&args(&["network-check", "--make-private"])),
            Ok(Command::NetworkCheck { make_private: true })
        );
        for invalid in [
            &["install", "--data-dir", "/tmp/h"][..],
            &["uninstall", "now"][..],
            &["stop-service", "--port", "1"][..],
            &["network-check", "--private"][..],
            &["network-check", "--make-private", "--make-private"][..],
        ] {
            assert!(parse(&args(invalid)).is_err(), "{invalid:?}");
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn the_service_commands_refuse_outside_windows() {
        assert!(install_service().is_err());
        assert!(uninstall_service().is_err());
        assert!(stop_service().is_err());
    }

    #[test]
    fn print_fingerprint_on_an_empty_dir_is_an_error_and_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
```

- [ ] **Step 2: Убедиться, что ничего не собирается**

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test network_profile --bin markiro-host`
Expected: FAIL — ``error[E0432]: unresolved import `markiro_host::network_profile` ``; разбор команд — ``no variant or associated item named `Install` ``.

- [ ] **Step 3: Модули, их строки в `lib.rs`, подкоманды**

Создать `apps/standalone/host/src/network_profile.rs`:

<!-- prettier-ignore -->
```rust
//! `markiro-host network-check`: which networks Windows counts as public.
//! The firewall rule `install` adds opens the host's port only on private
//! and domain networks (spec §9.1), and Windows often files a new Wi-Fi
//! network as public, so the station would stay unreachable from the office
//! PC. The installer runs this check after `install` and offers to make a
//! public network private (`--make-private`, pilot spec §9.4).

use serde::Deserialize;

use crate::install::{powershell_args, run_checked, Commands, InstallError};

/// The exit code of `network-check` while a public network remains.
pub const PUBLIC_REMAINS: u8 = 3;

/// One connection profile as `Get-NetConnectionProfile` reports it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct NetworkProfile {
    /// `InterfaceIndex`: what `Set-NetConnectionProfile` takes.
    pub index: u32,
    /// `InterfaceAlias` («Беспроводная сеть»), for the installer's log only.
    pub alias: String,
    /// `NetworkCategory` as text: `Public`, `Private` or `DomainAuthenticated`.
    pub category: String,
}

impl NetworkProfile {
    pub fn is_public(&self) -> bool {
        self.category == "Public"
    }
}

/// Lists the profiles as JSON in UTF-8. The category goes out as text, not
/// as Windows PowerShell's number for the enum, and `-InputObject` keeps one
/// profile an array.
pub const LIST_SCRIPT: &str = "$ErrorActionPreference = 'Stop'; \
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; \
$profiles = @(Get-NetConnectionProfile | ForEach-Object { [pscustomobject]@{ \
index = [int]$_.InterfaceIndex; alias = [string]$_.InterfaceAlias; \
category = [string]$_.NetworkCategory } }); \
ConvertTo-Json -Compress -InputObject $profiles";

/// Makes the network on interface `index` private.
pub fn make_private_script(index: u32) -> String {
    format!(
        "$ErrorActionPreference = 'Stop'; \
Set-NetConnectionProfile -InterfaceIndex {index} -NetworkCategory Private"
    )
}

/// Reads `LIST_SCRIPT`'s output: an array, one object (an older shell that
/// unrolled the array), or nothing at all when there is no connection.
pub fn parse_profiles(stdout: &[u8]) -> Result<Vec<NetworkProfile>, InstallError> {
    let text = String::from_utf8_lossy(stdout);
    let text = text.trim().trim_start_matches('\u{feff}');
    if text.is_empty() {
        return Ok(Vec::new());
    }
    let unexpected = |_| InstallError::Output {
        program: "Get-NetConnectionProfile".to_owned(),
    };
    if text.starts_with('[') {
        serde_json::from_str(text).map_err(unexpected)
    } else {
        serde_json::from_str::<NetworkProfile>(text)
            .map(|profile| vec![profile])
            .map_err(unexpected)
    }
}

/// The profiles after the check: with `make_private`, every public one is
/// made private first, and the list is read again.
pub fn check(
    commands: &mut dyn Commands,
    make_private: bool,
) -> Result<Vec<NetworkProfile>, InstallError> {
    let profiles = list(commands)?;
    if !make_private || !profiles.iter().any(NetworkProfile::is_public) {
        return Ok(profiles);
    }
    for profile in profiles.iter().filter(|profile| profile.is_public()) {
        run_checked(
            commands,
            "powershell.exe",
            &powershell_args(&make_private_script(profile.index)),
        )?;
    }
    list(commands)
}

fn list(commands: &mut dyn Commands) -> Result<Vec<NetworkProfile>, InstallError> {
    let output = run_checked(commands, "powershell.exe", &powershell_args(LIST_SCRIPT))?;
    parse_profiles(&output.stdout)
}
```

Создать `apps/standalone/host/src/install_windows.rs`:

<!-- prettier-ignore -->
```rust
//! [`Services`] on the Windows service manager (`windows-service`). Compiled
//! only for Windows: the `standalone-windows-build` job builds it, and its
//! installer smoke test (`tools/standalone-release/smoke.ps1`) drives it.

use std::ffi::OsString;

use windows_service::service::{
    ServiceAccess, ServiceAction, ServiceActionType, ServiceErrorControl, ServiceFailureActions,
    ServiceFailureResetPeriod, ServiceInfo, ServiceStartType, ServiceState as WinState,
    ServiceType,
};
use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};

use crate::install::{InstallError, ServiceSpec, ServiceState, Services, SERVICE_NAME};

/// `ERROR_SERVICE_DOES_NOT_EXIST`.
const DOES_NOT_EXIST: i32 = 1060;
/// `ERROR_SERVICE_NOT_ACTIVE`: a stop for a service that is not running.
const NOT_ACTIVE: i32 = 1062;
/// `ERROR_SERVICE_ALREADY_RUNNING`.
const ALREADY_RUNNING: i32 = 1056;

/// The access `configure` and the waits need on the service.
fn access() -> ServiceAccess {
    ServiceAccess::QUERY_STATUS
        | ServiceAccess::QUERY_CONFIG
        | ServiceAccess::CHANGE_CONFIG
        | ServiceAccess::START
        | ServiceAccess::STOP
        | ServiceAccess::DELETE
}

/// The local service manager, opened for creating services (administrators only).
pub struct WindowsServices {
    manager: ServiceManager,
}

impl WindowsServices {
    pub fn connect() -> Result<Self, InstallError> {
        let manager = ServiceManager::local_computer(
            None::<&str>,
            ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE,
        )
        .map_err(service_error)?;
        Ok(Self { manager })
    }

    fn open(&self) -> Result<Option<windows_service::service::Service>, InstallError> {
        match self.manager.open_service(SERVICE_NAME, access()) {
            Ok(service) => Ok(Some(service)),
            Err(error) if os_code(&error) == Some(DOES_NOT_EXIST) => Ok(None),
            Err(error) => Err(service_error(error)),
        }
    }

    fn existing(&self) -> Result<windows_service::service::Service, InstallError> {
        self.open()?
            .ok_or_else(|| InstallError::Service(format!("{SERVICE_NAME} is not installed")))
    }
}

impl Services for WindowsServices {
    fn state(&mut self) -> Result<Option<ServiceState>, InstallError> {
        let Some(service) = self.open()? else {
            return Ok(None);
        };
        let status = service.query_status().map_err(service_error)?;
        Ok(Some(match status.current_state {
            WinState::Stopped => ServiceState::Stopped,
            WinState::StartPending => ServiceState::StartPending,
            WinState::StopPending => ServiceState::StopPending,
            WinState::Running => ServiceState::Running,
            _ => ServiceState::Other,
        }))
    }

    fn configure(&mut self, spec: &ServiceSpec) -> Result<(), InstallError> {
        let info = ServiceInfo {
            name: OsString::from(spec.name),
            display_name: OsString::from(spec.display_name),
            service_type: ServiceType::OWN_PROCESS,
            start_type: if spec.automatic {
                ServiceStartType::AutoStart
            } else {
                ServiceStartType::OnDemand
            },
            error_control: ServiceErrorControl::Normal,
            executable_path: spec.executable.clone(),
            launch_arguments: spec.arguments.iter().map(OsString::from).collect(),
            dependencies: Vec::new(),
            account_name: Some(OsString::from(spec.account)),
            account_password: None,
        };
        let service = match self.open()? {
            Some(service) => {
                service.change_config(&info).map_err(service_error)?;
                service
            }
            None => self
                .manager
                .create_service(&info, access())
                .map_err(service_error)?,
        };
        service
            .set_description(spec.description)
            .map_err(service_error)?;
        service
            .update_failure_actions(ServiceFailureActions {
                reset_period: ServiceFailureResetPeriod::After(spec.reset_after),
                reboot_msg: None,
                command: None,
                actions: Some(
                    spec.restart_delays
                        .iter()
                        .map(|delay| ServiceAction {
                            action_type: ServiceActionType::Restart,
                            delay: *delay,
                        })
                        .collect(),
                ),
            })
            .map_err(service_error)?;
        service
            .set_failure_actions_on_non_crash_failures(spec.failure_actions_on_non_crash)
            .map_err(service_error)
    }

    fn start(&mut self) -> Result<(), InstallError> {
        match self.existing()?.start::<&str>(&[]) {
            Ok(()) => Ok(()),
            Err(error) if os_code(&error) == Some(ALREADY_RUNNING) => Ok(()),
            Err(error) => Err(service_error(error)),
        }
    }

    fn stop(&mut self) -> Result<(), InstallError> {
        match self.existing()?.stop() {
            Ok(_) => Ok(()),
            Err(error) if os_code(&error) == Some(NOT_ACTIVE) => Ok(()),
            Err(error) => Err(service_error(error)),
        }
    }

    fn delete(&mut self) -> Result<(), InstallError> {
        self.existing()?.delete().map_err(service_error)
    }
}

fn os_code(error: &windows_service::Error) -> Option<i32> {
    match error {
        windows_service::Error::Winapi(io) => io.raw_os_error(),
        _ => None,
    }
}

fn service_error(error: windows_service::Error) -> InstallError {
    InstallError::Service(match &error {
        windows_service::Error::Winapi(io) => format!("{error}: {io}"),
        _ => error.to_string(),
    })
}
```

Правка `apps/standalone/host/src/lib.rs`:

Фрагмент 1:

<!-- prettier-ignore -->
```rust
pub mod feed;
pub mod install;
pub mod logging;
pub mod network;
pub mod pairing_code;
pub mod rate_limit;
```

заменить на:

<!-- prettier-ignore -->
```rust
pub mod feed;
pub mod install;
#[cfg(windows)]
pub mod install_windows;
pub mod logging;
pub mod network;
pub mod network_profile;
pub mod pairing_code;
pub mod rate_limit;
```

Правка `apps/standalone/host/src/main.rs`:

Фрагмент 1:

<!-- prettier-ignore -->
```rust
//!   service                                   run under the Windows service manager
//!   print-fingerprint [--data-dir <path>]     print the certificate fingerprint

use std::path::PathBuf;
```

заменить на:

<!-- prettier-ignore -->
```rust
//!   service                                   run under the Windows service manager
//!   print-fingerprint [--data-dir <path>]     print the certificate fingerprint
//!   install                                   register and start the service (Windows, administrator)
//!   uninstall                                 stop and remove it; the data stays (Windows, administrator)
//!   stop-service                              stop it and wait (Windows, administrator)
//!   network-check [--make-private]            list networks; exit 3 while one is public

use std::path::PathBuf;
```

Фрагмент 2:

<!-- prettier-ignore -->
```rust

use markiro_host::config::{HostConfig, HostPaths};
use markiro_host::{BoxError, StartOptions};

```

заменить на:

<!-- prettier-ignore -->
```rust

use markiro_host::config::{HostConfig, HostPaths};
use markiro_host::install::SystemCommands;
use markiro_host::network_profile::{self, PUBLIC_REMAINS};
use markiro_host::{BoxError, StartOptions};

```

Фрагмент 3:

<!-- prettier-ignore -->
```rust
        data_dir: PathBuf,
    },
}

const USAGE: &str = "usage: markiro-host run [--data-dir <path>] [--port <port>]
       markiro-host service
       markiro-host print-fingerprint [--data-dir <path>]";

fn parse(args: &[String]) -> Result<Command, String> {
    let (command, rest) = args.split_first().ok_or_else(|| USAGE.to_owned())?;
    let mut data_dir = None;
    let mut port = None;
```

заменить на:

<!-- prettier-ignore -->
```rust
        data_dir: PathBuf,
    },
    Install,
    Uninstall,
    StopService,
    NetworkCheck {
        make_private: bool,
    },
}

const USAGE: &str = "usage: markiro-host run [--data-dir <path>] [--port <port>]
       markiro-host service
       markiro-host print-fingerprint [--data-dir <path>]
       markiro-host install | uninstall | stop-service
       markiro-host network-check [--make-private]";

fn parse(args: &[String]) -> Result<Command, String> {
    let (command, rest) = args.split_first().ok_or_else(|| USAGE.to_owned())?;
    match (command.as_str(), rest) {
        ("install", []) => return Ok(Command::Install),
        ("uninstall", []) => return Ok(Command::Uninstall),
        ("stop-service", []) => return Ok(Command::StopService),
        ("network-check", []) => {
            return Ok(Command::NetworkCheck {
                make_private: false,
            })
        }
        ("network-check", [flag]) if flag == "--make-private" => {
            return Ok(Command::NetworkCheck { make_private: true })
        }
        ("install" | "uninstall" | "stop-service" | "network-check", _) => {
            return Err(USAGE.to_owned())
        }
        _ => {}
    }
    let mut data_dir = None;
    let mut port = None;
```

Фрагмент 4:

<!-- prettier-ignore -->
```rust
        Command::Service => run_service(),
        Command::PrintFingerprint { data_dir } => print_fingerprint(data_dir),
    };
    match result {
```

заменить на:

<!-- prettier-ignore -->
```rust
        Command::Service => run_service(),
        Command::PrintFingerprint { data_dir } => print_fingerprint(data_dir),
        Command::Install => install_service(),
        Command::Uninstall => uninstall_service(),
        Command::StopService => stop_service(),
        Command::NetworkCheck { make_private } => {
            return match network_check(make_private) {
                Ok(false) => ExitCode::SUCCESS,
                Ok(true) => {
                    eprintln!("markiro-host: a network is public; the host's port is closed on it");
                    ExitCode::from(PUBLIC_REMAINS)
                }
                Err(error) => {
                    eprintln!("markiro-host: {error}");
                    ExitCode::FAILURE
                }
            }
        }
    };
    match result {
```

Фрагмент 5:

<!-- prettier-ignore -->
```rust
fn run_service() -> Result<(), BoxError> {
    Err("the service command is only available on Windows".into())
}

```

заменить на:

<!-- prettier-ignore -->
```rust
fn run_service() -> Result<(), BoxError> {
    Err("the service command is only available on Windows".into())
}

/// The host's port for the firewall: `host.json`'s when the host has
/// started before (a `--port` it was given), the default otherwise.
#[cfg(windows)]
fn configured_port(paths: &HostPaths) -> u16 {
    HostConfig::load(paths)
        .map(|config| config.port)
        .unwrap_or(markiro_proto::DEFAULT_PORT)
}

#[cfg(windows)]
fn install_service() -> Result<(), BoxError> {
    let paths = HostPaths::new(HostPaths::default_data_dir());
    paths.ensure()?;
    let executable = std::env::current_exe()?;
    let mut services = markiro_host::install_windows::WindowsServices::connect()?;
    let mut sleep = std::thread::sleep;
    markiro_host::install::install(
        &paths.data_dir,
        &executable,
        configured_port(&paths),
        &mut services,
        &mut SystemCommands,
        &mut sleep,
    )?;
    println!(
        "{} is running; data in {}",
        markiro_host::install::SERVICE_NAME,
        paths.data_dir.display()
    );
    Ok(())
}

#[cfg(windows)]
fn uninstall_service() -> Result<(), BoxError> {
    let mut services = markiro_host::install_windows::WindowsServices::connect()?;
    let mut sleep = std::thread::sleep;
    markiro_host::install::uninstall(&mut services, &mut SystemCommands, &mut sleep)?;
    println!("the service is removed; the data directory stays");
    Ok(())
}

#[cfg(windows)]
fn stop_service() -> Result<(), BoxError> {
    let mut services = markiro_host::install_windows::WindowsServices::connect()?;
    let mut sleep = std::thread::sleep;
    markiro_host::install::stop(&mut services, &mut sleep)?;
    Ok(())
}

#[cfg(not(windows))]
fn install_service() -> Result<(), BoxError> {
    Err("install is only available on Windows".into())
}

#[cfg(not(windows))]
fn uninstall_service() -> Result<(), BoxError> {
    Err("uninstall is only available on Windows".into())
}

#[cfg(not(windows))]
fn stop_service() -> Result<(), BoxError> {
    Err("stop-service is only available on Windows".into())
}

/// Prints every network and whether any of them is still public.
fn network_check(make_private: bool) -> Result<bool, BoxError> {
    let profiles = network_profile::check(&mut SystemCommands, make_private)?;
    for profile in &profiles {
        println!("{}: {}", profile.alias, profile.category);
    }
    Ok(profiles
        .iter()
        .any(network_profile::NetworkProfile::is_public))
}

```

- [ ] **Step 4: Наборы проходят**

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test install --test network_profile --bin markiro-host`
Expected: PASS — `install` 11, `network_profile` 5, разбор `main.rs` 5; ни одного `warning`.

- [ ] **Step 5: Адаптер Windows компилируется под `x86_64-pc-windows-msvc`**

`cargo check` всего хоста под Windows на macOS невозможен: сборочный сценарий `aws-lc-sys` ищет `windows.h` (проверено: `fatal error: 'windows.h' file not found`). Поэтому крейт-пробник вне репозитория компилирует только `install.rs` и `install_windows.rs` с теми же версиями крейтов:

```bash
mkdir -p /tmp/claude/ust-probe/src
cat > /tmp/claude/ust-probe/Cargo.toml <<'EOF'
[package]
name = "ust-probe"
version = "0.0.0"
edition = "2021"
publish = false

[dependencies]
base64 = "=0.22.1"

[target.'cfg(windows)'.dependencies]
windows-service = "=0.8.1"
EOF
cat > /tmp/claude/ust-probe/src/lib.rs <<EOF
#[path = "$PWD/apps/standalone/host/src/install.rs"]
pub mod install;
#[cfg(windows)]
#[path = "$PWD/apps/standalone/host/src/install_windows.rs"]
pub mod install_windows;
EOF
cp apps/standalone/Cargo.lock /tmp/claude/ust-probe/Cargo.lock
RUSTFLAGS=-Dwarnings cargo check --offline --manifest-path /tmp/claude/ust-probe/Cargo.toml --target x86_64-pc-windows-msvc
```

Expected: ``Finished `dev` profile`` без предупреждений (проверено при написании плана). Ветки `cfg(windows)` в `main.rs` и `service.rs` пробник не видит: их компилирует CI (задача 6). Пробник удалить: `rm -r /tmp/claude/ust-probe`.

- [ ] **Step 6: Мутация**

В `apps/standalone/host/src/network_profile.rs` фрагмент

<!-- prettier-ignore -->
```rust
    if !make_private || !profiles
```

заменить на

<!-- prettier-ignore -->
```rust
    if !profiles
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test network_profile`
Expected: FAIL — `without_make_private_the_check_only_reads` (лишний `Set-NetConnectionProfile`). Затем вернуть файл (`cp /tmp/claude/before <файл>`, `cmp` молчит, `shasum -a 256` — тот же хеш).

- [ ] **Step 7: Коммит**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
git diff --check
git add apps/standalone/host/src/network_profile.rs apps/standalone/host/src/install_windows.rs \
  apps/standalone/host/src/lib.rs apps/standalone/host/src/main.rs \
  apps/standalone/host/tests/network_profile.rs
git commit -m "feat(standalone): markiro-host install, uninstall, stop-service and network-check for the installer" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Оболочка — роль установки, ПК офиса подключается видом `office`, новый адрес хоста

Приложение узнаёт роль из `installation.json`, который пишет только установщик (задача 5), в каталоге установки под `Program Files`. Роль решает две вещи в оболочке: вид устройства при подключении по коду и ответ `install_role` для вебвью (киоск-режим, задача 4). `device_change_address` переносит подключение на новый адрес того же хоста: ключ уходит только через клиент, закрепивший прежний сертификат, а сохраняется адрес, только если хост по нему принял ключ.

**Files:**

- Create: `apps/standalone/src-tauri/src/installation.rs` (с юнит-тестами)
- Modify: `apps/standalone/src-tauri/src/device.rs`, `apps/standalone/src-tauri/src/lib.rs`
- Test: `apps/standalone/src-tauri/tests/host_address.rs` (Create), `apps/standalone/src-tauri/tests/ipc.rs`, юнит-тест в `device.rs`

**Interfaces:**

- Consumes: `PinnedClient`, `Credentials`, `RequestError::CertificateMismatch` (`host_client.rs`); `GET /v1/device` хоста.
- Produces:
  - `markiro_standalone_lib::installation`: `FILE_NAME = "installation.json"`, `enum InstallRole { Host, Station, Office }` (serde `snake_case`: `"host"`, `"station"`, `"office"`), `fn read(dir: &Path) -> Option<InstallRole>`, `fn read_beside_executable() -> Option<InstallRole>`; формат файла — `{"role":"office"}`, незнакомые ключи и роли — `None`;
  - `DeviceState::with_install_role(self, Option<InstallRole>) -> Self`, `DeviceState::install_role(&self) -> Option<InstallRole>`, `DeviceState::change_address(&self, address: &str) -> Result<DeviceStatus, DeviceError>`;
  - `DeviceError::AddressOtherHost` с кодом `"address_other_host"`;
  - команды IPC: `install_role` (без аргументов) → `"host" | "station" | "office" | null`; `device_change_address { address }` → `DeviceStatus`, отказы — `address_other_host`, `unreachable`, `invalid_request`, `key_rejected`, `request_failed`, `not_paired`, `config_unreadable`, `storage`.
  - `host_claim` подключает видом `office`, если роль `office`; `host_local_pair` — всегда станцией.

- [ ] **Step 1: Тесты нового адреса, вида подключения и IPC**

Создать `apps/standalone/src-tauri/tests/host_address.rs`:

<!-- prettier-ignore -->
```rust
//! A new address for the paired host (plan УСТ, pilot spec §9.4) against a
//! real `markiro-host` on 127.0.0.1: the host PC got another IP address, and
//! the device keeps its pairing when the new address presents the pinned
//! certificate and still knows the device's key. The old address is played
//! by a port where nothing listens.

use std::path::Path;

use markiro_host::config::HostPaths;
use markiro_host::{start, RunningHost, StartOptions};
use markiro_proto::DeviceKind;
use markiro_standalone_lib::device::{DeviceError, DeviceState};
use markiro_standalone_lib::device_config::{self, DeviceConfig};
use markiro_standalone_lib::host_client::RequestError;
use markiro_standalone_lib::installation::InstallRole;
use serde_json::Value;

const BOOTSTRAP: &str = include_str!("../../proto/fixtures/bootstrap-request.json");

async fn start_host(dir: &Path) -> RunningHost {
    start(
        &HostPaths::new(dir),
        StartOptions {
            port_override: None,
            bind: Some("127.0.0.1:0".parse().unwrap()),
        },
    )
    .await
    .unwrap()
}

fn address(host: &RunningHost) -> String {
    format!("https://{}", host.addr)
}

/// A local address where nothing listens: the host's old address.
fn closed_address() -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    format!("https://127.0.0.1:{port}")
}

/// The host PC's installation after the wizard, and the administrator's token.
async fn office(host: &RunningHost, dir: &Path) -> (DeviceState, String) {
    let office = DeviceState::load(dir.to_path_buf());
    office
        .local_pair(&address(host), "Рабочее место хоста", "0.1.0")
        .await
        .unwrap();
    let wizard: Value = serde_json::from_str(BOOTSTRAP).unwrap();
    let created = office
        .request("POST", "/v1/bootstrap", Some(&wizard), None)
        .await
        .unwrap();
    assert_eq!(created.status, 200, "{:?}", created.body);
    let token = created.body.unwrap()["session"]["token"]
        .as_str()
        .unwrap()
        .to_owned();
    (office, token)
}

/// An office PC paired by code, then moved to `old` in its `device.json`, as
/// if the host had answered there when it paired; loaded again from disk.
async fn office_pc_at(
    host: &RunningHost,
    office: &DeviceState,
    token: &str,
    dir: &Path,
    old: &str,
) -> DeviceState {
    let created = office
        .request("POST", "/v1/office/pairing-codes", None, Some(token))
        .await
        .unwrap();
    let code = created.body.unwrap()["code"].as_str().unwrap().to_owned();
    let pc = DeviceState::load(dir.to_path_buf()).with_install_role(Some(InstallRole::Office));
    pc.claim(
        &address(host),
        &host.fingerprint,
        &code,
        "ПК администратора",
        "0.1.0",
    )
    .await
    .unwrap();
    let config = device_config::load(dir).unwrap().unwrap();
    device_config::save(
        dir,
        &DeviceConfig {
            host_address: old.to_owned(),
            ..config
        },
    )
    .unwrap();
    DeviceState::load(dir.to_path_buf()).with_install_role(Some(InstallRole::Office))
}

fn saved(dir: &Path) -> DeviceConfig {
    device_config::load(dir).unwrap().unwrap()
}

#[tokio::test]
async fn the_same_host_at_a_new_address_keeps_the_pairing() {
    let host_dir = tempfile::tempdir().unwrap();
    let office_dir = tempfile::tempdir().unwrap();
    let pc_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let (office, token) = office(&host, office_dir.path()).await;
    let old = closed_address();
    let pc = office_pc_at(&host, &office, &token, pc_dir.path(), &old).await;
    let before = saved(pc_dir.path());
    assert_eq!(
        pc.request("GET", "/v1/device", None, None).await,
        Err(DeviceError::Request(RequestError::Unreachable))
    );
    let mut link = pc.watch_link();
    assert_eq!(link.borrow_and_update().as_ref().unwrap().address, old);

    let status = pc
        .change_address(&format!("{}/", address(&host)))
        .await
        .unwrap();
    assert_eq!(status.host_address, address(&host));
    assert_eq!(status.kind, DeviceKind::Office);
    assert_eq!(
        saved(pc_dir.path()),
        DeviceConfig {
            host_address: address(&host),
            ..before
        },
        "only the address changes: the key, the fingerprint and the device stay"
    );
    assert!(
        link.has_changed().unwrap(),
        "the connection task follows the new address"
    );
    assert_eq!(
        link.borrow_and_update().as_ref().unwrap().address,
        address(&host)
    );
    let device = pc.request("GET", "/v1/device", None, None).await.unwrap();
    assert_eq!(device.status, 200);
    assert_eq!(device.body.unwrap()["kind"], "office");
    host.stop().await.unwrap();
}

#[tokio::test]
async fn another_host_at_the_new_address_changes_nothing() {
    let host_dir = tempfile::tempdir().unwrap();
    let other_dir = tempfile::tempdir().unwrap();
    let office_dir = tempfile::tempdir().unwrap();
    let pc_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let other = start_host(other_dir.path()).await;
    let (office, token) = office(&host, office_dir.path()).await;
    let old = closed_address();
    let pc = office_pc_at(&host, &office, &token, pc_dir.path(), &old).await;
    let before = saved(pc_dir.path());

    assert_eq!(
        pc.change_address(&address(&other)).await,
        Err(DeviceError::AddressOtherHost)
    );
    assert_eq!(saved(pc_dir.path()), before);
    assert_eq!(pc.status().unwrap().unwrap().host_address, old);
    other.stop().await.unwrap();
    host.stop().await.unwrap();
}

#[tokio::test]
async fn nothing_at_the_new_address_changes_nothing() {
    let host_dir = tempfile::tempdir().unwrap();
    let office_dir = tempfile::tempdir().unwrap();
    let pc_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let (office, token) = office(&host, office_dir.path()).await;
    let old = closed_address();
    let pc = office_pc_at(&host, &office, &token, pc_dir.path(), &old).await;
    let before = saved(pc_dir.path());

    assert_eq!(
        pc.change_address(&closed_address()).await,
        Err(DeviceError::Request(RequestError::Unreachable))
    );
    assert_eq!(
        pc.change_address("http://127.0.0.1:45710").await,
        Err(DeviceError::Request(RequestError::InvalidRequest))
    );
    assert_eq!(saved(pc_dir.path()), before);
    host.stop().await.unwrap();
}

#[tokio::test]
async fn a_revoked_device_is_refused_at_the_new_address_and_keeps_the_old_one() {
    let host_dir = tempfile::tempdir().unwrap();
    let office_dir = tempfile::tempdir().unwrap();
    let pc_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let (office, token) = office(&host, office_dir.path()).await;
    let old = closed_address();
    let pc = office_pc_at(&host, &office, &token, pc_dir.path(), &old).await;
    let before = saved(pc_dir.path());
    let revoked = office
        .request(
            "POST",
            &format!("/v1/office/devices/{}/revoke", before.device_id),
            None,
            Some(&token),
        )
        .await
        .unwrap();
    assert_eq!(revoked.status, 200, "{:?}", revoked.body);

    assert_eq!(
        pc.change_address(&address(&host)).await,
        Err(DeviceError::KeyRejected)
    );
    assert_eq!(saved(pc_dir.path()), before);
    host.stop().await.unwrap();
}

#[tokio::test]
async fn an_unpaired_device_has_no_address_to_change() {
    let host_dir = tempfile::tempdir().unwrap();
    let pc_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let pc = DeviceState::load(pc_dir.path().to_path_buf());
    assert_eq!(
        pc.change_address(&address(&host)).await,
        Err(DeviceError::NotPaired)
    );
    assert!(!pc_dir.path().join(device_config::FILE_NAME).exists());
    host.stop().await.unwrap();
}
```

Правка `apps/standalone/src-tauri/tests/ipc.rs`:

Фрагмент 1:

<!-- prettier-ignore -->
```rust
use markiro_standalone_lib::device::DeviceState;
use markiro_standalone_lib::device_config::{self, DeviceConfig};
use markiro_standalone_lib::local_db::{LocalDbState, FILE_NAME};
use markiro_standalone_lib::secret_store::{ProtectedSecret, Scheme};
```

заменить на:

<!-- prettier-ignore -->
```rust
use markiro_standalone_lib::device::DeviceState;
use markiro_standalone_lib::device_config::{self, DeviceConfig};
use markiro_standalone_lib::installation::InstallRole;
use markiro_standalone_lib::local_db::{LocalDbState, FILE_NAME};
use markiro_standalone_lib::secret_store::{ProtectedSecret, Scheme};
```

Фрагмент 2:

<!-- prettier-ignore -->
```rust
        Ok(json!({ "state": "offline", "lastContactAt": null, "lastError": null, "seq": 0 }))
    );
}
```

заменить на:

<!-- prettier-ignore -->
```rust
        Ok(json!({ "state": "offline", "lastContactAt": null, "lastError": null, "seq": 0 }))
    );
}

#[test]
fn the_install_role_and_a_new_host_address_have_the_webview_shapes() {
    let dir = tempfile::tempdir().unwrap();
    let (_app, webview) = mock_app(DeviceState::load(dir.path().to_path_buf()));
    assert_eq!(invoke(&webview, "install_role", json!({})), Ok(Value::Null));
    // `src/host/device.ts` sends `address`; an unpaired device has none to change.
    assert_eq!(
        invoke(
            &webview,
            "device_change_address",
            json!({ "address": "https://192.168.1.20:45710" })
        ),
        Err(json!("not_paired"))
    );

    let office_dir = tempfile::tempdir().unwrap();
    let (_office_app, office) = mock_app(
        DeviceState::load(office_dir.path().to_path_buf())
            .with_install_role(Some(InstallRole::Office)),
    );
    assert_eq!(
        invoke(&office, "install_role", json!({})),
        Ok(json!("office"))
    );
}
```

Правка `apps/standalone/src-tauri/src/device.rs`:

Фрагмент 11:

<!-- prettier-ignore -->
```rust
        assert_eq!(DeviceError::KeyRejected.code(), "key_rejected");
        assert_eq!(DeviceError::RequestFailed.code(), "request_failed");
    }

```

заменить на:

<!-- prettier-ignore -->
```rust
        assert_eq!(DeviceError::KeyRejected.code(), "key_rejected");
        assert_eq!(DeviceError::RequestFailed.code(), "request_failed");
        assert_eq!(DeviceError::AddressOtherHost.code(), "address_other_host");
    }

    #[test]
    fn only_an_office_pc_pairs_by_code_as_an_office_device() {
        let dir = tempfile::tempdir().unwrap();
        let state = |role| DeviceState::load(dir.path().to_path_buf()).with_install_role(role);
        assert_eq!(state(None).claim_kind(), DeviceKind::Station);
        assert_eq!(
            state(Some(InstallRole::Host)).claim_kind(),
            DeviceKind::Station
        );
        assert_eq!(
            state(Some(InstallRole::Station)).claim_kind(),
            DeviceKind::Station
        );
        assert_eq!(
            state(Some(InstallRole::Office)).claim_kind(),
            DeviceKind::Office
        );
        assert_eq!(
            state(Some(InstallRole::Office)).install_role(),
            Some(InstallRole::Office)
        );
    }

```

- [ ] **Step 2: Убедиться, что наборы не собираются**

Run (вне песочницы): `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test host_address --test ipc`
Expected: FAIL — ``unresolved import `markiro_standalone_lib::installation` ``, ``no method named `with_install_role` ``, ``no method named `change_address` ``.

- [ ] **Step 3: `installation.rs`, роль и новый адрес в `device.rs`, команды в `lib.rs`**

Создать `apps/standalone/src-tauri/src/installation.rs`:

<!-- prettier-ignore -->
```rust
//! The role the installer gave this computer (plan УСТ): `installation.json`
//! next to the app's executable, which only the installer writes
//! (`src-tauri/windows/installer-hooks.nsh`). The install directory is under
//! `Program Files`, writable by administrators only, so a person at the
//! station cannot make it an office PC and leave kiosk mode that way. A
//! development build has no such file.

use std::path::Path;

use serde::{Deserialize, Serialize};

pub const FILE_NAME: &str = "installation.json";

/// «хост и станция», «только станция», «только офис».
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallRole {
    Host,
    Station,
    Office,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Installation {
    role: InstallRole,
}

/// The role in `dir/installation.json`; `None` when there is no file, or a
/// file this build cannot read (logged): such a computer works as a station,
/// kiosk mode included, which is the safe side for the floor.
pub fn read(dir: &Path) -> Option<InstallRole> {
    let text = match std::fs::read_to_string(dir.join(FILE_NAME)) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(_) => {
            eprintln!("standalone: {FILE_NAME} is unreadable; working as a station");
            return None;
        }
    };
    match serde_json::from_str::<Installation>(text.trim_start_matches('\u{feff}')) {
        Ok(installation) => Some(installation.role),
        Err(_) => {
            eprintln!("standalone: {FILE_NAME} is not a known role; working as a station");
            None
        }
    }
}

/// The directory of the running executable, where the installer puts the file.
pub fn read_beside_executable() -> Option<InstallRole> {
    let executable = std::env::current_exe().ok()?;
    read(executable.parent()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, text: &str) {
        std::fs::write(dir.join(FILE_NAME), text).unwrap();
    }

    #[test]
    fn reads_the_three_roles_the_installer_writes() {
        let dir = tempfile::tempdir().unwrap();
        for (text, role) in [
            ("{\"role\":\"host\"}\r\n", InstallRole::Host),
            ("{\"role\":\"station\"}\r\n", InstallRole::Station),
            ("{\"role\":\"office\"}\r\n", InstallRole::Office),
        ] {
            write(dir.path(), text);
            assert_eq!(read(dir.path()), Some(role), "{text}");
        }
    }

    #[test]
    fn no_file_or_an_unknown_one_means_no_role() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read(dir.path()), None);
        for text in [
            "",
            "{",
            "{\"role\":\"Office\"}",
            "{\"role\":\"admin\"}",
            "{\"role\":\"office\",\"kiosk\":false}",
            "\"office\"",
        ] {
            write(dir.path(), text);
            assert_eq!(read(dir.path()), None, "{text:?}");
        }
    }

    #[test]
    fn a_byte_order_mark_is_no_reason_to_refuse_the_file() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "\u{feff}{\"role\":\"office\"}");
        assert_eq!(read(dir.path()), Some(InstallRole::Office));
    }

    #[test]
    fn the_role_crosses_ipc_in_snake_case() {
        assert_eq!(
            serde_json::to_value(InstallRole::Host).unwrap(),
            serde_json::json!("host")
        );
        assert_eq!(
            serde_json::to_value(InstallRole::Office).unwrap(),
            serde_json::json!("office")
        );
    }
}
```

Правка `apps/standalone/src-tauri/src/device.rs`:

Фрагмент 1:

<!-- prettier-ignore -->
```rust
use crate::host_client::{Credentials, HostResponse, PinnedClient, RequestError};
use crate::host_probe::{self, HelloObservation, ProbeError};
use crate::secret_store;

```

заменить на:

<!-- prettier-ignore -->
```rust
use crate::host_client::{Credentials, HostResponse, PinnedClient, RequestError};
use crate::host_probe::{self, HelloObservation, ProbeError};
use crate::installation::InstallRole;
use crate::secret_store;

```

Фрагмент 2:

<!-- prettier-ignore -->
```rust
    /// The host answered a device request with another error.
    RequestFailed,
}

```

заменить на:

<!-- prettier-ignore -->
```rust
    /// The host answered a device request with another error.
    RequestFailed,
    /// The address given for the paired host answers with another
    /// certificate: another host lives there.
    AddressOtherHost,
}

```

Фрагмент 3:

<!-- prettier-ignore -->
```rust
            DeviceError::KeyRejected => "key_rejected",
            DeviceError::RequestFailed => "request_failed",
        }
    }
```

заменить на:

<!-- prettier-ignore -->
```rust
            DeviceError::KeyRejected => "key_rejected",
            DeviceError::RequestFailed => "request_failed",
            DeviceError::AddressOtherHost => "address_other_host",
        }
    }
```

Фрагмент 4:

<!-- prettier-ignore -->
```rust
    pairing: tokio::sync::Mutex<()>,
    /// The host the connection task should hold a stream to; `None` while
    /// unpaired. Replaced on pairing and forgetting.
    link: watch::Sender<Option<Arc<HostLink>>>,
}

```

заменить на:

<!-- prettier-ignore -->
```rust
    pairing: tokio::sync::Mutex<()>,
    /// The host the connection task should hold a stream to; `None` while
    /// unpaired. Replaced on pairing, forgetting and a new host address.
    link: watch::Sender<Option<Arc<HostLink>>>,
    /// The installer's role for this computer (`installation.rs`); `None`
    /// in a development build.
    role: Option<InstallRole>,
}

```

Фрагмент 5:

<!-- prettier-ignore -->
```rust
            pairing: tokio::sync::Mutex::new(()),
            link: watch::channel(link).0,
        }
    }
```

заменить на:

<!-- prettier-ignore -->
```rust
            pairing: tokio::sync::Mutex::new(()),
            link: watch::channel(link).0,
            role: None,
        }
    }

    /// This computer's role from the installer: an office PC pairs by code
    /// as a device of kind `office` (pilot spec §9.4), every other one as a
    /// station.
    pub fn with_install_role(mut self, role: Option<InstallRole>) -> Self {
        self.role = role;
        self
    }

    pub fn install_role(&self) -> Option<InstallRole> {
        self.role
    }

    /// The kind `claim` pairs as.
    fn claim_kind(&self) -> DeviceKind {
        match self.role {
            Some(InstallRole::Office) => DeviceKind::Office,
            Some(InstallRole::Host | InstallRole::Station) | None => DeviceKind::Station,
        }
    }
```

Фрагмент 6:

<!-- prettier-ignore -->
```rust
            return Err(DeviceError::PairRejected);
        }
        self.remember(address, observation, client, response.body)
    }

```

заменить на:

<!-- prettier-ignore -->
```rust
            return Err(DeviceError::PairRejected);
        }
        self.remember(
            address,
            observation,
            client,
            response.body,
            DeviceKind::Station,
        )
    }

```

Фрагмент 7:

<!-- prettier-ignore -->
```rust
        }
        let client = PinnedClient::new(address, fingerprint).map_err(DeviceError::Request)?;
        let request = ClaimRequest {
            code: Secret::new(code),
            kind: DeviceKind::Station,
            name: name.to_owned(),
            app_version: app_version.to_owned(),
```

заменить на:

<!-- prettier-ignore -->
```rust
        }
        let client = PinnedClient::new(address, fingerprint).map_err(DeviceError::Request)?;
        let kind = self.claim_kind();
        let request = ClaimRequest {
            code: Secret::new(code),
            kind,
            name: name.to_owned(),
            app_version: app_version.to_owned(),
```

Фрагмент 8:

<!-- prettier-ignore -->
```rust
            return Err(claim_refusal(response.body.as_ref()));
        }
        self.remember(address, observation, client, response.body)
    }

```

заменить на:

<!-- prettier-ignore -->
```rust
            return Err(claim_refusal(response.body.as_ref()));
        }
        self.remember(address, observation, client, response.body, kind)
    }

    /// Reach the paired host at another `address` (it got another IP
    /// address), keeping the pairing: the key, the line and the local
    /// copies. The new address is kept only when it presents the pinned
    /// certificate — the same host, since nobody else holds its private
    /// key — and the host still accepts this device's key (`GET
    /// /v1/device`); the pin stops the key before it could reach any other
    /// machine. Another certificate is `address_other_host` and changes
    /// nothing: the device stays paired with its old address. Serialised
    /// with pairing, forgetting and line changes.
    pub async fn change_address(&self, address: &str) -> Result<DeviceStatus, DeviceError> {
        let _pairing = self.pairing.lock().await;
        let device = self.paired()?;
        let address = address.trim_end_matches('/');
        let client =
            PinnedClient::new(address, &device.config.fingerprint).map_err(DeviceError::Request)?;
        let response = match client
            .send(
                "GET",
                DEVICE_ROUTE,
                None,
                Credentials {
                    device_key: Some(&device.key),
                    office_token: None,
                },
            )
            .await
        {
            Ok(response) => response,
            Err(RequestError::CertificateMismatch) => return Err(DeviceError::AddressOtherHost),
            Err(error) => return Err(DeviceError::Request(error)),
        };
        match response.status {
            200 => {}
            401 => return Err(DeviceError::KeyRejected),
            _ => return Err(DeviceError::RequestFailed),
        }
        let config = DeviceConfig {
            host_address: address.to_owned(),
            ..device.config.clone()
        };
        device_config::save(&self.dir, &config).map_err(|_| DeviceError::Storage)?;
        let updated = Arc::new(PairedDevice {
            config,
            key: device.key.clone(),
            client,
        });
        let status = updated.status();
        let link = updated.link();
        *self.current.lock().expect("device lock") = Current::Paired(updated);
        self.link.send_replace(Some(link));
        Ok(status)
    }

```

Фрагмент 9:

<!-- prettier-ignore -->
```rust
        client: PinnedClient,
        body: Option<Value>,
    ) -> Result<DeviceStatus, DeviceError> {
        let pair: PairResponse = body
```

заменить на:

<!-- prettier-ignore -->
```rust
        client: PinnedClient,
        body: Option<Value>,
        kind: DeviceKind,
    ) -> Result<DeviceStatus, DeviceError> {
        let pair: PairResponse = body
```

Фрагмент 10:

<!-- prettier-ignore -->
```rust
            host_id: pair.host_id,
            device_id: pair.device_id,
            kind: DeviceKind::Station,
            line_id: None,
            device_key: secret_store::protect(pair.device_key.expose())
```

заменить на:

<!-- prettier-ignore -->
```rust
            host_id: pair.host_id,
            device_id: pair.device_id,
            kind,
            line_id: None,
            device_key: secret_store::protect(pair.device_key.expose())
```

Правка `apps/standalone/src-tauri/src/lib.rs`:

Фрагмент 1:

<!-- prettier-ignore -->
```rust
pub mod host_client;
pub mod host_probe;
pub mod local_db;
pub mod lockdown;
```

заменить на:

<!-- prettier-ignore -->
```rust
pub mod host_client;
pub mod host_probe;
pub mod installation;
pub mod local_db;
pub mod lockdown;
```

Фрагмент 2:

<!-- prettier-ignore -->
```rust
use device::{DeviceError, DeviceState, DeviceStatus};
use host_client::HostResponse;
use local_db::{LocalDbState, LocalStatement};

```

заменить на:

<!-- prettier-ignore -->
```rust
use device::{DeviceError, DeviceState, DeviceStatus};
use host_client::HostResponse;
use installation::InstallRole;
use local_db::{LocalDbState, LocalStatement};

```

Фрагмент 3:

<!-- prettier-ignore -->
```rust
}

/// Read this device's record from the host again and keep the line the
/// office assigned; the webview calls it at the same moments as the
```

заменить на:

<!-- prettier-ignore -->
```rust
}

/// The installer's role for this computer: `"host"`, `"station"`,
/// `"office"`, or `null` in a development build (plan УСТ).
#[tauri::command]
fn install_role(state: tauri::State<'_, DeviceState>) -> Option<InstallRole> {
    state.install_role()
}

/// Reach the paired host at a new address with the same certificate
/// (`DeviceState::change_address`).
#[tauri::command]
async fn device_change_address(
    state: tauri::State<'_, DeviceState>,
    address: String,
) -> Result<DeviceStatus, String> {
    state
        .change_address(&address)
        .await
        .map_err(|error| error.code().to_owned())
}

/// Read this device's record from the host again and keep the line the
/// office assigned; the webview calls it at the same moments as the
```

Фрагмент 4:

<!-- prettier-ignore -->
```rust
        device_refresh,
        device_forget,
        local_query,
        local_transaction,
```

заменить на:

<!-- prettier-ignore -->
```rust
        device_refresh,
        device_forget,
        device_change_address,
        install_role,
        local_query,
        local_transaction,
```

Фрагмент 5:

<!-- prettier-ignore -->
```rust
            // computer and never follow a Windows user profile elsewhere.
            let dir = app.path().app_local_data_dir()?;
            let device = DeviceState::load(dir.clone());
            let link = device.watch_link();
            app.manage(device);
```

заменить на:

<!-- prettier-ignore -->
```rust
            // computer and never follow a Windows user profile elsewhere.
            let dir = app.path().app_local_data_dir()?;
            let device = DeviceState::load(dir.clone())
                .with_install_role(installation::read_beside_executable());
            let link = device.watch_link();
            app.manage(device);
```

Проверки идентификатора устройства в ответе `GET /v1/device` нет намеренно: ключ называет ровно одно устройство, и такая проверка не может не пройти — её мутант выжил бы.

- [ ] **Step 4: Наборы проходят**

Run (вне песочницы): `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib --test host_address --test ipc`
Expected: PASS — библиотека 52, `host_address` 5, `ipc` 13; ни одного `warning`.

- [ ] **Step 5: Мутации**

В `apps/standalone/src-tauri/src/device.rs` фрагмент

<!-- prettier-ignore -->
```rust
            Some(InstallRole::Office) => DeviceKind::Office,
```

заменить на

<!-- prettier-ignore -->
```rust
            Some(InstallRole::Office) => DeviceKind::Station,
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test host_address`
Expected: FAIL — `the_same_host_at_a_new_address_keeps_the_pairing` (вид `Station` вместо `Office`); юнит-тест `only_an_office_pc_pairs_by_code_as_an_office_device` тоже падает. Затем вернуть файл (`cp /tmp/claude/before <файл>`, `cmp` молчит, `shasum -a 256` — тот же хеш).

В `apps/standalone/src-tauri/src/device.rs` фрагмент

<!-- prettier-ignore -->
```rust
            Err(RequestError::CertificateMismatch) => return Err(DeviceError::AddressOtherHost),
```

заменить на

<!-- prettier-ignore -->
```rust

```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test host_address`
Expected: FAIL — `another_host_at_the_new_address_changes_nothing` (`certificate_mismatch` вместо `address_other_host`). Затем вернуть файл (`cp /tmp/claude/before <файл>`, `cmp` молчит, `shasum -a 256` — тот же хеш).

В `apps/standalone/src-tauri/src/device.rs` фрагмент

<!-- prettier-ignore -->
```rust
            401 => return Err(DeviceError::KeyRejected),
            _ => return Err(DeviceError::RequestFailed),
        }
        let config = DeviceConfig {
            host_address
```

заменить на

<!-- prettier-ignore -->
```rust
            _ => {}
        }
        let config = DeviceConfig {
            host_address
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test host_address`
Expected: FAIL — `a_revoked_device_is_refused_at_the_new_address_and_keeps_the_old_one`. Затем вернуть файл (`cp /tmp/claude/before <файл>`, `cmp` молчит, `shasum -a 256` — тот же хеш).

В `apps/standalone/src-tauri/src/device.rs` фрагмент

<!-- prettier-ignore -->
```rust
        *self.current.lock().expect("device lock") = Current::Paired(updated);
        self.link.send_replace(Some(link));
        Ok(status)
    }

    /// Choose the line
```

заменить на

<!-- prettier-ignore -->
```rust
        *self.current.lock().expect("device lock") = Current::Paired(updated);
        drop(link);
        Ok(status)
    }

    /// Choose the line
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test host_address`
Expected: FAIL — `the_same_host_at_a_new_address_keeps_the_pairing` (задача связи не узнаёт новый адрес). Затем вернуть файл (`cp /tmp/claude/before <файл>`, `cmp` молчит, `shasum -a 256` — тот же хеш).

В `apps/standalone/src-tauri/src/installation.rs` фрагмент

<!-- prettier-ignore -->
```rust
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Installation
```

заменить на

<!-- prettier-ignore -->
```rust
#[derive(Debug, Deserialize)]
struct Installation
```

Run: `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib installation`
Expected: FAIL — `no_file_or_an_unknown_one_means_no_role` (файл с лишним ключом принят). Затем вернуть файл (`cp /tmp/claude/before <файл>`, `cmp` молчит, `shasum -a 256` — тот же хеш).

- [ ] **Step 6: Коммит**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
git diff --check
git add apps/standalone/src-tauri/src/installation.rs apps/standalone/src-tauri/src/device.rs \
  apps/standalone/src-tauri/src/lib.rs apps/standalone/src-tauri/tests/host_address.rs \
  apps/standalone/src-tauri/tests/ipc.rs
git commit -m "feat(standalone): the installer's role, an office PC pairs as an office device, and a new host address keeps the pairing" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Вебвью — ПК офиса без киоск-режима, его дом «Вход в офис», «Сменить адрес хоста»

`App` спрашивает роль у оболочки раньше, чем запирает окно: киоск-режим включается, только когда ответ пришёл и это не ПК офиса (роль `office` или подключение видом `office`). Ответ, который оболочка не дала, — станция, окно запирается: для цеха это безопасная сторона. На ПК офиса закрытый офис — это «Вход в офис» без «В цех», «Выйти» в шапке возвращает на вход, а оператор на его цех не входит. На входе в офис устройства, подключённого к хосту на другом ПК, есть «Сменить адрес хоста»: адрес вводится как при подключении (`parseHostAddress`: порт 45710 по умолчанию, кириллица по позициям клавиш), отказ «другой хост» и «не отвечает» объясняется про адрес, а отказ ключа — экран отказа устройства.

**Files:**

- Create: `apps/standalone/src/app/HostAddressDialog.tsx`
- Modify: `apps/standalone/src/host/device.ts`, `apps/standalone/src/app/shell.ts`, `apps/standalone/src/app/App.tsx`, `apps/standalone/src/office/OfficeLogin.tsx`, `apps/standalone/src/office/OfficeShell.tsx`, `apps/standalone/src/office/office-session.tsx`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/device.test.ts`, `apps/standalone/test/shell.test.ts`, `apps/standalone/test/app.test.tsx`

**Interfaces:**

- Consumes: команды `install_role` и `device_change_address`, код `address_other_host` (задача 3); `parseHostAddress` (`src/app/host-search.ts`); `FormDialog` (`src/office/FormDialog.tsx`).
- Produces:
  - `src/host/device.ts`: `installRoleSchema`, `type InstallRole = "host" | "station" | "office" | null`; `DeviceApi.installRole(): Promise<InstallRole>`, `DeviceApi.changeAddress(address: string): Promise<DeviceStatus>`; `DEVICE_ERROR_CODES` с `"address_other_host"`;
  - `src/app/shell.ts`: действие `{ type: "address_changed"; status: DeviceStatus }` (принимается только для того же `hostId` и `deviceId`); `nextShellView` даёт подключению видом `office` при закрытом офисе `{ kind: "office_login", notice: null }`;
  - `OfficeLoginProps.onBack: (() => void) | null`, `hostAddress?: string | null`, `onChangeAddress?: (address: string) => Promise<void>`; `OfficeSessionValue.exitTo?: "floor" | "sign_in"`;
  - `HostAddressDialog({ onChange, onClose })`;
  - тексты: `office.header.signOut`, `office.login.address.*`, `errors.device.address_other_host`.

- [ ] **Step 1: Тесты обёртки, оболочки и приложения**

Правка `apps/standalone/test/device.test.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
  });

  it("selects the station's line", async () => {
    const lineId = "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61";
```

заменить на:

<!-- prettier-ignore -->
```ts
  });

  it("reads the installer's role, and null in a development build", async () => {
    for (const role of ["host", "station", "office", null] as const) {
      const call = vi.fn().mockResolvedValue(role);
      await expect(createTauriDeviceApi(call).installRole()).resolves.toBe(role);
      expect(call).toHaveBeenCalledWith("install_role", {});
    }
    const call = vi.fn().mockResolvedValue("admin");
    expect((await failure(createTauriDeviceApi(call).installRole())).code).toBe("invalid_response");
  });

  it("moves the pairing to the host's new address", async () => {
    const address = "https://192.168.1.20:45710";
    const call = vi.fn().mockResolvedValue({ ...DEVICE_STATUS, hostAddress: address });
    await expect(createTauriDeviceApi(call).changeAddress(address)).resolves.toEqual({
      ...DEVICE_STATUS,
      hostAddress: address,
    });
    expect(call).toHaveBeenCalledWith("device_change_address", { address });
    const refused = vi.fn().mockRejectedValue("address_other_host");
    expect((await failure(createTauriDeviceApi(refused).changeAddress(address))).code).toBe(
      "address_other_host",
    );
  });

  it("selects the station's line", async () => {
    const lineId = "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61";
```

Правка `apps/standalone/test/shell.test.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
      device: { kind: "ready", status: { ...NEW_STATION, kind: "office" } },
    });
    expect(nextShellView(office, ADDRESS)).toEqual({ kind: "floor" });
  });

```

заменить на:

<!-- prettier-ignore -->
```ts
      device: { kind: "ready", status: { ...NEW_STATION, kind: "office" } },
    });
    expect(nextShellView(office, ADDRESS)).toEqual({ kind: "office_login", notice: null });
  });

  it("gives an office PC the office sign-in for a home, never the floor", () => {
    const officePc = paired({
      device: { kind: "ready", status: { ...DEVICE_STATUS, kind: "office" } },
    });
    expect(nextShellView(officePc, ADDRESS)).toEqual({ kind: "office_login", notice: null });
    expect(
      nextShellView(
        { ...officePc, office: { kind: "signing_in", notice: "session_ended" } },
        ADDRESS,
      ),
    ).toEqual({ kind: "office_login", notice: "session_ended" });
    expect(
      nextShellView({ ...officePc, office: { kind: "open", session: SESSION } }, ADDRESS),
    ).toEqual({ kind: "office", session: SESSION });
    // Leaving the office comes back to the sign-in.
    const left = shellReducer(
      { ...officePc, office: { kind: "open", session: SESSION } },
      { type: "office_closed" },
    );
    expect(nextShellView(left, ADDRESS)).toEqual({ kind: "office_login", notice: null });
  });

```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
      forgotten,
    );
  });

```

заменить на:

<!-- prettier-ignore -->
```ts
      forgotten,
    );
  });

  it("takes the host's new address only for its own pairing", () => {
    const remote = paired({
      device: {
        kind: "ready",
        status: { ...DEVICE_STATUS, hostAddress: "https://192.168.1.10:45710" },
      },
    });
    const moved = { ...DEVICE_STATUS, hostAddress: "https://192.168.1.20:45710" };
    expect(shellReducer(remote, { type: "address_changed", status: moved }).device).toEqual({
      kind: "ready",
      status: moved,
    });
    const otherDevice = { ...moved, deviceId: "5d2f0a1c-3b4e-4f6a-8c9d-0e1f2a3b4c5d" };
    expect(shellReducer(remote, { type: "address_changed", status: otherDevice })).toBe(remote);
    const otherHost = { ...moved, hostId: "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f" };
    expect(shellReducer(remote, { type: "address_changed", status: otherHost })).toBe(remote);
    const forgotten = shellReducer(remote, { type: "forgotten" });
    expect(shellReducer(forgotten, { type: "address_changed", status: moved })).toBe(forgotten);
  });

```

Фрагмент 3:

<!-- prettier-ignore -->
```ts
      },
    ],
    // A sign-in never replaces a session that is running: the answer of
    // another check, or of the same operator again, is refused.
```

заменить на:

<!-- prettier-ignore -->
```ts
      },
    ],
    // A new address of the same host keeps the pairing, the line and the
    // operator (plan УСТ); one of another pairing changes nothing.
    address_changed: [
      {
        action: {
          type: "address_changed",
          status: { ...DEVICE_STATUS, hostAddress: "https://192.168.1.20:45710" },
        },
        survives: true,
      },
      {
        action: {
          type: "address_changed",
          status: {
            ...DEVICE_STATUS,
            deviceId: OTHER_DEVICE,
            hostAddress: "https://192.168.1.20:45710",
          },
        },
        survives: true,
      },
    ],
    // A sign-in never replaces a session that is running: the answer of
    // another check, or of the same operator again, is refused.
```

Фрагмент 4:

<!-- prettier-ignore -->
```ts
  });

  it("signs in a device of the office or the handheld kind without a line", () => {
    for (const kind of ["office", "handheld"] as const) {
      const state = paired({
        device: { kind: "ready", status: { ...DEVICE_STATUS, kind, lineId: null } },
      });
      const floor = shellReducer(state, { ...signIn, lineId: null });
      expect(floor.operator).toEqual(ANNA);
      expect(nextShellView(floor, ADDRESS)).toEqual({ kind: "floor_operator", operator: ANNA });
      // An answer that began on a line is not this device's: it has none.
      expect(shellReducer(state, signIn)).toBe(state);
    }
  });

```

заменить на:

<!-- prettier-ignore -->
```ts
  });

  it("signs in a handheld without a line, and nobody on an office PC", () => {
    const handheld = paired({
      device: { kind: "ready", status: { ...DEVICE_STATUS, kind: "handheld", lineId: null } },
    });
    const floor = shellReducer(handheld, { ...signIn, lineId: null });
    expect(floor.operator).toEqual(ANNA);
    expect(nextShellView(floor, ADDRESS)).toEqual({ kind: "floor_operator", operator: ANNA });
    // An answer that began on a line is not this device's: it has none.
    expect(shellReducer(handheld, signIn)).toBe(handheld);
    // An office PC has no floor (plan УСТ): no answer signs anybody in there.
    const officePc = paired({
      device: { kind: "ready", status: { ...DEVICE_STATUS, kind: "office", lineId: null } },
    });
    expect(shellReducer(officePc, { ...signIn, lineId: null })).toBe(officePc);
  });

```

Правка `apps/standalone/test/app.test.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
    refresh: vi.fn<DeviceApi["refresh"]>(async () => {
      if (!paired) throw new DeviceError("not_paired", "not paired");
      return paired;
    }),
```

заменить на:

<!-- prettier-ignore -->
```tsx
    refresh: vi.fn<DeviceApi["refresh"]>(async () => {
      if (!paired) throw new DeviceError("not_paired", "not paired");
      return paired;
    }),
    // A development build's answer; a test sets the installer's role.
    installRole: vi.fn<DeviceApi["installRole"]>(async () => null),
    changeAddress: vi.fn<DeviceApi["changeAddress"]>(async (address) => {
      if (!paired) throw new DeviceError("not_paired", "not paired");
      paired = { ...paired, hostAddress: address };
      return paired;
    }),
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
    unmount();
  });
});
```

заменить на:

<!-- prettier-ignore -->
```tsx
    unmount();
  });
});

describe("an office PC and the host's address (plan УСТ)", () => {
  /** An office PC paired with the host on the station PC. */
  const OFFICE_PC: DeviceStatus = {
    ...DEVICE_STATUS,
    hostAddress: REMOTE_ADDRESS,
    kind: "office",
    lineId: null,
  };

  function officePc() {
    const device = fakeDevice(OFFICE_PC);
    device.installRole.mockResolvedValue("office");
    return device;
  }

  it("never locks an office PC, opens on the office sign-in and comes back to it", async () => {
    const kiosk = recordingLockdown();
    const device = officePc();
    renderApp({ probe: probeAnswering(true), device, host: fakeHost(), lockdown: kiosk.lockdown });
    expect(await screen.findByText("Вход в офис")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "В цех" })).toBeNull();
    await signIn();
    expect(await screen.findByText("Вы вошли как Ирина Смирнова.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Выйти в цех" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Выйти" }));
    expect(await screen.findByText("Вход в офис")).toBeTruthy();
    expect(screen.queryByText("Цех")).toBeNull();
    expect(device.installRole).toHaveBeenCalled();
    expect(kiosk.commands).toEqual([]);
  });

  it("still locks a station when the shell reports no role", async () => {
    const kiosk = recordingLockdown();
    renderApp({
      probe: probeAnswering(true),
      device: fakeDevice(DEVICE_STATUS),
      host: fakeHost(),
      lockdown: kiosk.lockdown,
    });
    expect(await screen.findByText("Цех")).toBeTruthy();
    await waitFor(() => expect(kiosk.commands).toEqual(["enter_lockdown"]));
  });

  it("locks a station whose role the shell could not tell", async () => {
    const kiosk = recordingLockdown();
    const device = fakeDevice(DEVICE_STATUS);
    device.installRole.mockRejectedValue(new DeviceError("invalid_response", "role"));
    renderApp({ probe: probeAnswering(true), device, host: fakeHost(), lockdown: kiosk.lockdown });
    expect(await screen.findByText("Цех")).toBeTruthy();
    await waitFor(() => expect(kiosk.commands).toEqual(["enter_lockdown"]));
  });

  it("moves the pairing to the host's new address from the office sign-in", async () => {
    const device = officePc();
    renderApp({ probe: probeAnswering(true), device, host: fakeHost() });
    expect(await screen.findByText(`Хост: ${REMOTE_ADDRESS}`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Сменить адрес хоста" }));
    fireEvent.change(await screen.findByLabelText("Адрес хоста"), {
      target: { value: "192.168.1.20" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Проверить и сохранить" }));
    expect(
      await screen.findByText("Адрес хоста изменён: https://192.168.1.20:45710."),
    ).toBeTruthy();
    expect(device.changeAddress).toHaveBeenCalledWith("https://192.168.1.20:45710");
    expect(screen.getByText("Хост: https://192.168.1.20:45710")).toBeTruthy();
    expect(screen.queryByText("Новый адрес хоста")).toBeNull();
  });

  it("keeps the dialog open and explains an address that is not the paired host or answers nothing", async () => {
    const device = officePc();
    device.changeAddress.mockRejectedValueOnce(
      new DeviceError("address_other_host", "another certificate"),
    );
    renderApp({ probe: probeAnswering(true), device, host: fakeHost() });
    fireEvent.click(await screen.findByRole("button", { name: "Сменить адрес хоста" }));
    const field = await screen.findByLabelText("Адрес хоста");
    fireEvent.change(field, { target: { value: "адрес хоста" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить и сохранить" }));
    expect(
      await screen.findByText(
        "Введите IP-адрес или имя ПК хоста, при необходимости с портом через двоеточие.",
      ),
    ).toBeTruthy();
    expect(device.changeAddress).not.toHaveBeenCalled();

    fireEvent.change(field, { target: { value: "192.168.1.30" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить и сохранить" }));
    expect(
      await screen.findByText(
        "По этому адресу отвечает другой хост: его сертификат не совпадает с сохранённым при подключении. Проверьте адрес на ПК хоста.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Новый адрес хоста")).toBeTruthy();
    expect(screen.getByText(`Хост: ${REMOTE_ADDRESS}`)).toBeTruthy();

    // Nothing answers there: about the address, not about this computer's service.
    device.changeAddress.mockRejectedValueOnce(new DeviceError("unreachable", "no answer"));
    fireEvent.click(screen.getByRole("button", { name: "Проверить и сохранить" }));
    expect(
      await screen.findByText(
        "По этому адресу хост не отвечает. Проверьте адрес, сеть и что ПК хоста включён.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Служба хоста на этом компьютере не отвечает.")).toBeNull();
  });

  it("treats a key the host no longer accepts at the new address as a rejected device", async () => {
    const device = officePc();
    device.changeAddress.mockRejectedValueOnce(new DeviceError("key_rejected", "revoked"));
    renderApp({ probe: probeAnswering(true), device, host: fakeHost() });
    fireEvent.click(await screen.findByRole("button", { name: "Сменить адрес хоста" }));
    fireEvent.change(await screen.findByLabelText("Адрес хоста"), {
      target: { value: "192.168.1.20" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Проверить и сохранить" }));
    expect(await screen.findByText("Хост не принимает это устройство")).toBeTruthy();
  });

  it("offers no address change for the host on this computer", async () => {
    renderApp({ probe: probeAnswering(true), device: fakeDevice(DEVICE_STATUS), host: fakeHost() });
    fireEvent.click(await screen.findByRole("button", { name: "Офис" }));
    expect(await screen.findByText("Вход в офис")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Сменить адрес хоста" })).toBeNull();
    expect(screen.getByRole("button", { name: "В цех" })).toBeTruthy();
  });
});
```

Первый фрагмент `test/shell.test.ts` меняет прежнее ожидание: подключение видом `office` без линии раньше показывало цех, теперь — вход в офис. Четвёртый — бывший тест «signs in a device of the office or the handheld kind without a line»: вход оператора остаётся у ТСД, а на ПК офиса ни один ответ никого не впускает. Третий добавляет `address_changed` в исчерпывающую таблицу действий (компилятор требует строку для каждого нового действия).

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/device.test.ts test/shell.test.ts test/app.test.tsx`
Expected: FAIL — 12 тестов (`device` 2, `shell` 6, `app` 4), остальные 229 проходят: `installRole is not a function`, `office_login` вместо `floor` и т. п.

- [ ] **Step 3: Реализация**

Правка `apps/standalone/src/host/device.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
import { invoke } from "@tauri-apps/api/core";

import { deviceStatusSchema, type DeviceStatus } from "./protocol.js";
```

заменить на:

<!-- prettier-ignore -->
```ts
import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

import { deviceStatusSchema, type DeviceStatus } from "./protocol.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
  "key_rejected",
  "request_failed",
] as const;
export type DeviceErrorCode = (typeof DEVICE_ERROR_CODES)[number];
```

заменить на:

<!-- prettier-ignore -->
```ts
  "key_rejected",
  "request_failed",
  "address_other_host",
] as const;
export type DeviceErrorCode = (typeof DEVICE_ERROR_CODES)[number];
```

Фрагмент 3:

<!-- prettier-ignore -->
```ts
}

/** The pairing of this installation, kept by the shell (`device.json`). */
export interface DeviceApi {
```

заменить на:

<!-- prettier-ignore -->
```ts
}

/**
 * The role the installer gave this computer (`installation.json`, plan УСТ):
 * «хост и станция», «только станция», «только офис». `null` in a development
 * build, which works as a station.
 */
export const installRoleSchema = z.enum(["host", "station", "office"]).nullable();
export type InstallRole = z.infer<typeof installRoleSchema>;

/** The pairing of this installation, kept by the shell (`device.json`). */
export interface DeviceApi {
```

Фрагмент 4:

<!-- prettier-ignore -->
```ts
   */
  refresh: () => Promise<DeviceStatus>;
}

```

заменить на:

<!-- prettier-ignore -->
```ts
   */
  refresh: () => Promise<DeviceStatus>;
  /** The installer's role for this computer (`install_role`). */
  installRole(): Promise<InstallRole>;
  /**
   * Reach the paired host at a new address (`https://host:port`) with the
   * same certificate (`device_change_address`); the pairing stays.
   */
  changeAddress(address: string): Promise<DeviceStatus>;
}

```

Фрагмент 5:

<!-- prettier-ignore -->
```ts
    },
    refresh: async () => parseStatus(await run("device_refresh", {})),
  };
}
```

заменить на:

<!-- prettier-ignore -->
```ts
    },
    refresh: async () => parseStatus(await run("device_refresh", {})),
    async installRole() {
      const parsed = installRoleSchema.safeParse(await run("install_role", {}));
      if (!parsed.success) throw new DeviceError("invalid_response", parsed.error.message);
      return parsed.data;
    },
    async changeAddress(address) {
      return parseStatus(await run("device_change_address", { address }));
    },
  };
}
```

Правка `apps/standalone/src/app/shell.ts`:

Фрагмент 1:

<!-- prettier-ignore -->
```ts
  | { type: "line_selected"; status: DeviceStatus }
  | { type: "device_refreshed"; status: DeviceStatus }
  // `deviceId` and `lineId`: the pairing and the line the sign-in began on, as
  // the screen that asked had them (not what the shell has by now);
```

заменить на:

<!-- prettier-ignore -->
```ts
  | { type: "line_selected"; status: DeviceStatus }
  | { type: "device_refreshed"; status: DeviceStatus }
  /** The shell reached the paired host at a new address (plan УСТ). */
  | { type: "address_changed"; status: DeviceStatus }
  // `deviceId` and `lineId`: the pairing and the line the sign-in began on, as
  // the screen that asked had them (not what the shell has by now);
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
  switch (state.office.kind) {
    case "closed":
      // A station works on one line and chooses it before the floor.
      if (status.kind === "station" && status.lineId === null) return { kind: "line_select" };
```

заменить на:

<!-- prettier-ignore -->
```ts
  switch (state.office.kind) {
    case "closed":
      // An office PC (the installer's role «только офис», plan УСТ) has no
      // floor: its home is the office sign-in.
      if (status.kind === "office") return { kind: "office_login", notice: null };
      // A station works on one line and chooses it before the floor.
      if (status.kind === "station" && status.lineId === null) return { kind: "line_select" };
```

Фрагмент 3:

<!-- prettier-ignore -->
```ts
      };
    }
    case "operator_signed_in": {
      // Only onto the floor the sign-in started from: a late answer must not
```

заменить на:

<!-- prettier-ignore -->
```ts
      };
    }
    case "address_changed": {
      // Only the pairing the answer belongs to: same host, same device.
      if (state.device.kind !== "ready" || state.device.status === null) return state;
      const current = state.device.status;
      if (current.deviceId !== action.status.deviceId || current.hostId !== action.status.hostId) {
        return state;
      }
      return { ...state, device: { kind: "ready", status: action.status } };
    }
    case "operator_signed_in": {
      // Only onto the floor the sign-in started from: a late answer must not
```

Создать `apps/standalone/src/app/HostAddressDialog.tsx`:

<!-- prettier-ignore -->
```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Input } from "@markiro/ui";

import { DeviceError } from "../host/device.js";
import { errorMessageKey } from "../host/errors.js";
import { errorProp } from "../lib/form-error.js";
import { FormDialog } from "../office/FormDialog.js";
import { parseHostAddress } from "./host-search.js";

export interface HostAddressDialogProps {
  /**
   * Moves the pairing to the address (`https://host:port`); rejects with a
   * `DeviceError` the dialog explains. A function-typed property, passed
   * unbound.
   */
  onChange: (address: string) => Promise<void>;
  onClose: () => void;
}

/**
 * What a refused change says. `unreachable` is about the typed address here,
 * not about the service on this computer (`errors.device.unreachable`).
 */
function failureKey(error: unknown): string {
  if (error instanceof DeviceError && error.code === "unreachable") {
    return "office.login.address.unreachable";
  }
  return errorMessageKey(error);
}

/**
 * «Сменить адрес хоста» (plan УСТ, pilot spec §9.4): the host PC got another
 * IP address. The address is typed as for pairing (`parseHostAddress`: the
 * port 45710 when left out, Cyrillic read by key position); the shell keeps
 * it only if the same host answers there, so a typo never loses the pairing.
 */
export function HostAddressDialog({ onChange, onClose }: HostAddressDialogProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const submit = async () => {
    setFailure(null);
    const address = parseHostAddress(value);
    setInvalid(address === null);
    if (address === null) return;
    try {
      await onChange(address);
    } catch (error) {
      setFailure(failureKey(error));
    }
  };

  return (
    <FormDialog
      title={t("office.login.address.title")}
      submitLabel={t("office.login.address.submit")}
      onSubmit={submit}
      onClose={onClose}
      alert={failure && <Alert tone="error">{t(failure)}</Alert>}
    >
      <Input
        label={t("office.login.address.label")}
        hint={t("office.login.address.hint")}
        value={value}
        autoComplete="off"
        onChange={(event) => setValue(event.target.value)}
        {...errorProp(invalid ? t("office.login.address.invalid") : undefined)}
      />
    </FormDialog>
  );
}
```

Правка `apps/standalone/src/office/OfficeLogin.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
import { Alert, Button, Card, Input } from "@markiro/ui";

import type { OfficeLoginNotice } from "../app/shell.js";
import { errorMessageKey } from "../host/errors.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { Alert, Button, Card, Input } from "@markiro/ui";

import { HostAddressDialog } from "../app/HostAddressDialog.js";
import type { OfficeLoginNotice } from "../app/shell.js";
import { errorMessageKey } from "../host/errors.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
   */
  onLogin: (request: OfficeLoginRequest) => Promise<void>;
  onBack: () => void;
}

```

заменить на:

<!-- prettier-ignore -->
```tsx
   */
  onLogin: (request: OfficeLoginRequest) => Promise<void>;
  /** Back to the floor; `null` on an office PC, which has no floor (plan УСТ). */
  onBack: (() => void) | null;
  /**
   * The paired host's address when it is another computer's, with
   * «Сменить адрес хоста» (plan УСТ); `null` (the default) shows neither.
   */
  hostAddress?: string | null;
  /** Moves the pairing to a new address; rejects with a `DeviceError`. */
  onChangeAddress?: (address: string) => Promise<void>;
}

```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
};

export function OfficeLogin({ notice, onLogin, onBack }: OfficeLoginProps) {
  const { t } = useTranslation();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const {
    register,
```

заменить на:

<!-- prettier-ignore -->
```tsx
};

export function OfficeLogin({
  notice,
  onLogin,
  onBack,
  hostAddress = null,
  onChangeAddress,
}: OfficeLoginProps) {
  const { t } = useTranslation();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [addressOpen, setAddressOpen] = useState(false);
  const [addressChanged, setAddressChanged] = useState<string | null>(null);
  const {
    register,
```

Фрагмент 4:

<!-- prettier-ignore -->
```tsx
        />
        <div className="standalone-form__actions">
          <Button variant="secondary" onClick={onBack} disabled={isSubmitting}>
            {t("office.login.back")}
          </Button>
          <Button type="submit" loading={isSubmitting}>
            {t("office.login.submit")}
```

заменить на:

<!-- prettier-ignore -->
```tsx
        />
        <div className="standalone-form__actions">
          {onBack && (
            <Button variant="secondary" onClick={onBack} disabled={isSubmitting}>
              {t("office.login.back")}
            </Button>
          )}
          <Button type="submit" loading={isSubmitting}>
            {t("office.login.submit")}
```

Фрагмент 5:

<!-- prettier-ignore -->
```tsx
        </div>
      </form>
    </Card>
  );
```

заменить на:

<!-- prettier-ignore -->
```tsx
        </div>
      </form>
      {hostAddress !== null && onChangeAddress && (
        <div className="standalone-form">
          {addressChanged && (
            <Alert tone="ok">{t("office.login.address.done", { address: addressChanged })}</Alert>
          )}
          <p>{t("office.login.address.current", { address: hostAddress })}</p>
          <div className="standalone-form__actions">
            <Button variant="secondary" onClick={() => setAddressOpen(true)}>
              {t("office.login.address.open")}
            </Button>
          </div>
        </div>
      )}
      {addressOpen && onChangeAddress && (
        <HostAddressDialog
          onChange={async (address) => {
            await onChangeAddress(address);
            setAddressOpen(false);
            setAddressChanged(address);
          }}
          onClose={() => setAddressOpen(false)}
        />
      )}
    </Card>
  );
```

Правка `apps/standalone/src/office/office-session.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
   */
  logout: () => void;
  /** Re-reads the signed-in user (name, role) from the host into the shell. */
  refreshUser: () => Promise<void>;
```

заменить на:

<!-- prettier-ignore -->
```tsx
   */
  logout: () => void;
  /**
   * Where `logout` leads: the floor (the default), or the office sign-in on
   * an office PC, which has no floor (plan УСТ); the header names it so.
   */
  exitTo?: "floor" | "sign_in";
  /** Re-reads the signed-in user (name, role) from the host into the shell. */
  refreshUser: () => Promise<void>;
```

Правка `apps/standalone/src/office/OfficeShell.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
            </Button>
            <Button variant="secondary" onClick={session.logout}>
              {t("office.header.logout")}
            </Button>
          </div>
```

заменить на:

<!-- prettier-ignore -->
```tsx
            </Button>
            <Button variant="secondary" onClick={session.logout}>
              {t(session.exitTo === "sign_in" ? "office.header.signOut" : "office.header.logout")}
            </Button>
          </div>
```

Правка `apps/standalone/src/app/App.tsx`:

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
  type DeviceApi,
  type DeviceErrorCode,
} from "../host/device.js";
import { createTauriHostProbe, HostProbeError, type HostProbe } from "../host/probe.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
  type DeviceApi,
  type DeviceErrorCode,
  type InstallRole,
} from "../host/device.js";
import { createTauriHostProbe, HostProbeError, type HostProbe } from "../host/probe.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
  const kioskSnapshot = useSyncExternalStore(kiosk.subscribe, kiosk.getSnapshot);
  const [state, dispatch] = useReducer(shellReducer, initialShellState);
  const [probeAttempt, setProbeAttempt] = useState(0);
  const [repairState, setRepairState] = useState<"idle" | "busy" | DeviceErrorCode>("idle");
```

заменить на:

<!-- prettier-ignore -->
```tsx
  const kioskSnapshot = useSyncExternalStore(kiosk.subscribe, kiosk.getSnapshot);
  const [state, dispatch] = useReducer(shellReducer, initialShellState);
  // The installer's role, `"unknown"` until the shell answers (plan УСТ).
  const [role, setRole] = useState<InstallRole | "unknown">("unknown");
  const [probeAttempt, setProbeAttempt] = useState(0);
  const [repairState, setRepairState] = useState<"idle" | "busy" | DeviceErrorCode>("idle");
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
      () => {
        if (!cancelled) dispatch({ type: "device_unreadable" });
      },
    );
```

заменить на:

<!-- prettier-ignore -->
```tsx
      () => {
        if (!cancelled) dispatch({ type: "device_unreadable" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [deviceApi]);

  useEffect(() => {
    let cancelled = false;
    deviceApi.installRole().then(
      (installed) => {
        if (!cancelled) setRole(installed);
      },
      // An answer the shell could not give: work as a station, kiosk mode included.
      () => {
        if (!cancelled) setRole(null);
      },
    );
```

Фрагмент 4:

<!-- prettier-ignore -->
```tsx
      try {
        dispatch({ type: "line_selected", status: await deviceApi.selectLine(lineId) });
      } catch (error) {
        const reason = deviceRejection(error);
```

заменить на:

<!-- prettier-ignore -->
```tsx
      try {
        dispatch({ type: "line_selected", status: await deviceApi.selectLine(lineId) });
      } catch (error) {
        const reason = deviceRejection(error);
        if (reason !== null) {
          dispatch({ type: "device_rejected", reason });
          return;
        }
        throw error;
      }
    },
    [deviceApi],
  );

  const changeAddress = useCallback(
    async (newAddress: string) => {
      try {
        dispatch({ type: "address_changed", status: await deviceApi.changeAddress(newAddress) });
      } catch (error) {
        const reason = deviceRejection(error);
```

Фрагмент 5:

<!-- prettier-ignore -->
```tsx
  const session = view.kind === "office" ? view.session : null;

  // Kiosk mode whenever no office session is open: at start, when the office
  // closes and when its session ends. Only an open session's administrator
  // turns it off («Оконный режим»), and only until that session ends.
  const officeOpen = session !== null;
  useEffect(() => {
    if (!officeOpen) void kiosk.enter();
  }, [kiosk, officeOpen]);
  const leaveKiosk = useCallback(async (): Promise<boolean> => {
    await kiosk.exit();
```

заменить на:

<!-- prettier-ignore -->
```tsx
  const session = view.kind === "office" ? view.session : null;

  // An office PC (the installer's role «только офис», or a device paired as
  // one) has no floor and is never locked (plan УСТ, owner question П11).
  const officePc = role === "office" || pairedStatus?.kind === "office";
  // Kiosk mode whenever no office session is open: at start, when the office
  // closes and when its session ends — once the role is known, and never on
  // an office PC. Only an open session's administrator turns it off
  // («Оконный режим»), and only until that session ends.
  const officeOpen = session !== null;
  const roleKnown = role !== "unknown";
  useEffect(() => {
    if (!officeOpen && roleKnown && !officePc) void kiosk.enter();
  }, [kiosk, officeOpen, roleKnown, officePc]);
  const leaveKiosk = useCallback(async (): Promise<boolean> => {
    await kiosk.exit();
```

Фрагмент 6:

<!-- prettier-ignore -->
```tsx
      call,
      refreshUser,
      logout: () => {
        dispatch({ type: "office_closed" });
```

заменить на:

<!-- prettier-ignore -->
```tsx
      call,
      refreshUser,
      exitTo: officePc ? "sign_in" : "floor",
      logout: () => {
        dispatch({ type: "office_closed" });
```

Фрагмент 7:

<!-- prettier-ignore -->
```tsx
      },
    };
  }, [session, hostApi]);

  if (session && officeSession) {
```

заменить на:

<!-- prettier-ignore -->
```tsx
      },
    };
  }, [session, hostApi, officePc]);

  if (session && officeSession) {
```

Фрагмент 8:

<!-- prettier-ignore -->
```tsx
          notice={view.notice}
          onLogin={login}
          onBack={() => dispatch({ type: "office_closed" })}
        />
      )}
```

заменить на:

<!-- prettier-ignore -->
```tsx
          notice={view.notice}
          onLogin={login}
          onBack={officePc ? null : () => dispatch({ type: "office_closed" })}
          hostAddress={remoteAddress}
          onChangeAddress={changeAddress}
        />
      )}
```

Правка `apps/standalone/src/i18n/ru.json`:

Фрагмент 1:

<!-- prettier-ignore -->
```json
      "sessionEnded": "Сессия офиса закончилась. Войдите снова.",
      "alreadyInitialized": "Хост уже настроен. Войдите в офис.",
      "required": "Заполните поле"
    },
    "nav": {
```

заменить на:

<!-- prettier-ignore -->
```json
      "sessionEnded": "Сессия офиса закончилась. Войдите снова.",
      "alreadyInitialized": "Хост уже настроен. Войдите в офис.",
      "required": "Заполните поле",
      "address": {
        "current": "Хост: {{address}}",
        "open": "Сменить адрес хоста",
        "title": "Новый адрес хоста",
        "label": "Адрес хоста",
        "hint": "IP-адрес ПК хоста, например 192.168.1.20. Порт 45710 подставится сам.",
        "invalid": "Введите IP-адрес или имя ПК хоста, при необходимости с портом через двоеточие.",
        "submit": "Проверить и сохранить",
        "unreachable": "По этому адресу хост не отвечает. Проверьте адрес, сеть и что ПК хоста включён.",
        "done": "Адрес хоста изменён: {{address}}."
      }
    },
    "nav": {
```

Фрагмент 2:

<!-- prettier-ignore -->
```json
    "header": {
      "logout": "Выйти в цех",
      "darkTheme": "Включить тёмную тему",
      "lightTheme": "Включить светлую тему"
```

заменить на:

<!-- prettier-ignore -->
```json
    "header": {
      "logout": "Выйти в цех",
      "signOut": "Выйти",
      "darkTheme": "Включить тёмную тему",
      "lightTheme": "Включить светлую тему"
```

Фрагмент 3:

<!-- prettier-ignore -->
```json
      "line_rejected": "Хост не принял эту линию: её убрали в архив или удалили. Выберите линию заново.",
      "key_rejected": "Хост больше не принимает это устройство. Подключите его заново.",
      "request_failed": "Хост не выполнил запрос. Повторите попытку."
    }
  }
```

заменить на:

<!-- prettier-ignore -->
```json
      "line_rejected": "Хост не принял эту линию: её убрали в архив или удалили. Выберите линию заново.",
      "key_rejected": "Хост больше не принимает это устройство. Подключите его заново.",
      "request_failed": "Хост не выполнил запрос. Повторите попытку.",
      "address_other_host": "По этому адресу отвечает другой хост: его сертификат не совпадает с сохранённым при подключении. Проверьте адрес на ПК хоста."
    }
  }
```

- [ ] **Step 4: Тесты, типы, линт, сборка**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/device.test.ts test/shell.test.ts test/app.test.tsx`
Expected: PASS — 242 теста (`device` 32, `shell` 112, `app` 98).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck && pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint && pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run build && pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run test`
Expected: всё зелёное; Vitest — 67 файлов, 1758 тестов. `grep -rnF '\u04' apps/standalone/src apps/standalone/test` — одно совпадение, `src/host/pairing-code.ts:66`.

- [ ] **Step 5: Мутации**

В `apps/standalone/src/app/App.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
if (!officeOpen && roleKnown && !officePc) void kiosk.enter();
```

заменить на

<!-- prettier-ignore -->
```tsx
if (!officeOpen && roleKnown) void kiosk.enter();
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/app.test.tsx -t 'plan УСТ'`
Expected: FAIL — «never locks an office PC, opens on the office sign-in and comes back to it» (`enter_lockdown` на ПК офиса). Затем вернуть файл (`cp /tmp/claude/before <файл>`, `cmp` молчит, `shasum -a 256` — тот же хеш).

В `apps/standalone/src/app/App.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
if (!officeOpen && roleKnown && !officePc) void kiosk.enter();
```

заменить на

<!-- prettier-ignore -->
```tsx
if (!officeOpen && !officePc) void kiosk.enter();
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/app.test.tsx -t 'plan УСТ'`
Expected: FAIL — «never locks an office PC, …»: окно заперто до ответа о роли. Затем вернуть файл (`cp /tmp/claude/before <файл>`, `cmp` молчит, `shasum -a 256` — тот же хеш).

В `apps/standalone/src/app/shell.ts` фрагмент

<!-- prettier-ignore -->
```ts
      if (status.kind === "office") return { kind: "office_login", notice: null };
```

заменить на

<!-- prettier-ignore -->
```ts

```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shell.test.ts`
Expected: FAIL — «gives an office PC the office sign-in for a home, never the floor». Затем вернуть файл (`cp /tmp/claude/before <файл>`, `cmp` молчит, `shasum -a 256` — тот же хеш).

В `apps/standalone/src/app/HostAddressDialog.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
  if (error instanceof DeviceError && error.code === "unreachable") {
```

заменить на

<!-- prettier-ignore -->
```tsx
  if (error instanceof DeviceError && error.code === "invalid_request") {
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/app.test.tsx -t 'plan УСТ'`
Expected: FAIL — «keeps the dialog open and explains an address that is not the paired host or answers nothing» (вместо слов про адрес — «Служба хоста на этом компьютере не отвечает.»). Затем вернуть файл (`cp /tmp/claude/before <файл>`, `cmp` молчит, `shasum -a 256` — тот же хеш).

В `apps/standalone/src/office/OfficeShell.tsx` фрагмент

<!-- prettier-ignore -->
```tsx
session.exitTo === "sign_in" ? "office.header.signOut" : "office.header.logout"
```

заменить на

<!-- prettier-ignore -->
```tsx
"office.header.logout"
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/app.test.tsx -t 'plan УСТ'`
Expected: FAIL — «never locks an office PC, …» (кнопки «Выйти» нет). Затем вернуть файл (`cp /tmp/claude/before <файл>`, `cmp` молчит, `shasum -a 256` — тот же хеш).

В `apps/standalone/src/app/shell.ts` фрагмент

<!-- prettier-ignore -->
```ts
      if (current.deviceId !== action.status.deviceId || current.hostId !== action.status.hostId) {
```

заменить на

<!-- prettier-ignore -->
```ts
      if (current.hostId !== action.status.hostId) {
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shell.test.ts`
Expected: FAIL — «takes the host's new address only for its own pairing». Затем вернуть файл (`cp /tmp/claude/before <файл>`, `cmp` молчит, `shasum -a 256` — тот же хеш).

- [ ] **Step 6: Коммит**

```bash
node_modules/.bin/prettier --check apps/standalone/src apps/standalone/test
git diff --check
git add apps/standalone/src/host/device.ts apps/standalone/src/app/shell.ts \
  apps/standalone/src/app/App.tsx apps/standalone/src/app/HostAddressDialog.tsx \
  apps/standalone/src/office/OfficeLogin.tsx apps/standalone/src/office/OfficeShell.tsx \
  apps/standalone/src/office/office-session.tsx apps/standalone/src/i18n/ru.json \
  apps/standalone/test/device.test.ts apps/standalone/test/shell.test.ts \
  apps/standalone/test/app.test.tsx
git commit -m "feat(standalone): an office PC is never kiosk-locked and its home is the office sign-in; the host's address can change" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Установщик — оверлей Tauri, хуки NSIS с ролями, артефакт и оверлей подписи

Сборка установщика — `tauri build --config src-tauri/tauri.installer.conf.json --bundles nsis` после копирования `markiro-host.exe` в `src-tauri/binaries/markiro-host-x86_64-pc-windows-msvc.exe`. Хуки подключаются шаблоном Tauri CLI 2.11.4 в его `installer.nsi`: `NSIS_HOOK_PREINSTALL` — до проверки запущенного приложения и копирования файлов, `NSIS_HOOK_POSTINSTALL` — после файлов, деинсталлятора и ярлыков, `NSIS_HOOK_PREUNINSTALL` — до удаления файлов. В шаблоне уже есть `LogicLib` (через `x64.nsh`), `FileFunc` (`GetOptions`), переменные `$UpdateMode` и `$DeleteAppDataCheckboxState` (флажок «удалить данные приложения»), а Tauri копирует sidecar в `$INSTDIR\markiro-host.exe` без суффикса тройки. Тихая установка: `<установщик> /S /ROLE=host|station|office`; `/S` без роли и прежней установки отказывает кодом 2.

**Files:**

- Create: `apps/standalone/src-tauri/tauri.installer.conf.json`, `apps/standalone/src-tauri/windows/installer-hooks.nsh` (UTF-8 с BOM), `tools/standalone-release/prepare.mjs`, `tools/standalone-release/sign-overlay.mjs`
- Modify: `apps/standalone/.gitignore`, `package.json`, `tools/ci/affected.mjs`
- Test: `tools/standalone-release/test/{prepare,sign-overlay,installer}.test.mjs` (Create), `tools/ci/test/affected.test.mjs`

**Interfaces:**

- Consumes: подкоманды `markiro-host install | uninstall | stop-service | network-check [--make-private]` и их коды (задача 2); формат `installation.json` (задача 3); `MAINBINARYNAME`, `$UpdateMode`, `$DeleteAppDataCheckboxState`, `GetOptions`, `${Silent}` шаблона Tauri.
- Produces:
  - оверлей `tauri.installer.conf.json`: `bundle.externalBin = ["binaries/markiro-host"]`, `bundle.windows.nsis = { installMode: "perMachine", languages: ["Russian"], installerHooks: "windows/installer-hooks.nsh" }` (поверх `installerIcon` базового файла);
  - реестр `HKLM\Software\Markiro\Standalone\Role`, `HKLM\Software\Microsoft\Windows\CurrentVersion\Run\MarkiroStandalone`; файл `$INSTDIR\installation.json`;
  - `tools/standalone-release/prepare.mjs`: `STANDALONE_TAURI_CONFIG`, `EVIDENCE_FILE`, `CHECKSUM_FILE`, `ROLES`, `AUTHENTICODE_STATUSES = ["Valid", "NotSigned"]`, `standaloneInstallerName(version)` (`markiro-standalone-<version>-windows-x86_64-setup.exe`), `readStandaloneVersion()`, `prepareStandaloneRelease({ version, sourceRepository, sourceSha, bundleDir, outputDir, authenticode })`, `verifyPreparedStandaloneRelease({ directory, version })`; командная строка `--bundle-dir --output-dir --source-repository --source-sha --authenticode`;
  - `tools/standalone-release/sign-overlay.mjs`: `buildSignOverlay({ thumbprint, timestampUrl })`, командная строка `--thumbprint --timestamp-url`;
  - корневой скрипт `test:standalone-release:contract`; `affected.mjs`: `tools/standalone-release/**` → задания автонома.

- [ ] **Step 1: Контрактные тесты**

Создать `tools/standalone-release/test/prepare.test.mjs`:

<!-- prettier-ignore -->
```js
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  prepareStandaloneRelease,
  readStandaloneVersion,
  standaloneInstallerName,
  verifyPreparedStandaloneRelease,
} from "../prepare.mjs";

const VERSION = "0.1.0";
const INSTALLER = "markiro-standalone-0.1.0-windows-x86_64-setup.exe";
const SOURCE = { sourceRepository: "thevladbog/markiro", sourceSha: "a".repeat(40) };

async function bundle(...names) {
  const root = await mkdtemp(join(tmpdir(), "standalone-prepare-"));
  const bundleDir = join(root, "nsis");
  await mkdir(bundleDir);
  for (const name of names) await writeFile(join(bundleDir, name), `bytes of ${name}`);
  return { bundleDir, outputDir: join(root, "prepared") };
}

test("reads the version from the app's own Tauri config", async () => {
  assert.match(await readStandaloneVersion(), /^\d+\.\d+\.\d+$/);
});

test("names the installer by version and refuses anything that is not one", () => {
  assert.equal(standaloneInstallerName(VERSION), INSTALLER);
  for (const bad of ["", "0.1", "v0.1.0", "0.1.0-beta.1", "01.1.0", undefined]) {
    assert.throws(() => standaloneInstallerName(bad), /not a version/);
  }
});

test("prepares the installer, its evidence and checksums, and verifies them", async () => {
  const { bundleDir, outputDir } = await bundle("Markiro Standalone_0.1.0_x64-setup.exe");
  const prepared = await prepareStandaloneRelease({
    version: VERSION,
    ...SOURCE,
    bundleDir,
    outputDir,
    authenticode: "NotSigned",
  });
  assert.deepEqual((await readdir(outputDir)).sort(), [
    "SHA256SUMS",
    INSTALLER,
    "release-evidence.json",
  ]);
  assert.deepEqual(prepared.evidence, {
    schemaVersion: 1,
    product: "standalone",
    version: VERSION,
    source: { repository: "thevladbog/markiro", sha: "a".repeat(40) },
    roles: ["host", "station", "office"],
    authenticode: "NotSigned",
    assets: {
      [INSTALLER]: {
        sha256: "07fb0332d384ea8d15c76c2c6a4e176e93345d9f403b1cd17e8b0dd2e4d1ac62",
        size: 47,
      },
    },
  });
  const sums = await readFile(join(outputDir, "SHA256SUMS"), "utf8");
  assert.deepEqual(
    sums
      .trim()
      .split("\n")
      .map((line) => line.slice(66)),
    [INSTALLER, "release-evidence.json"],
  );
});

test("refuses a bundle with no installer or with two", async () => {
  for (const names of [[], ["a-setup.exe", "b-setup.exe"], ["Markiro Standalone.msi"]]) {
    const { bundleDir, outputDir } = await bundle(...names);
    await assert.rejects(
      prepareStandaloneRelease({
        version: VERSION,
        ...SOURCE,
        bundleDir,
        outputDir,
        authenticode: "NotSigned",
      }),
      /exactly one NSIS installer/,
    );
  }
});

test("refuses an unknown signature status, a short commit and a non-empty output", async () => {
  const { bundleDir, outputDir } = await bundle("x-setup.exe");
  const base = { version: VERSION, ...SOURCE, bundleDir, outputDir, authenticode: "NotSigned" };
  await assert.rejects(
    prepareStandaloneRelease({ ...base, authenticode: "HashMismatch" }),
    /neither signed nor unsigned/,
  );
  await assert.rejects(
    prepareStandaloneRelease({ ...base, sourceSha: "abc123" }),
    /full lowercase/,
  );
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, "left-over"), "");
  await assert.rejects(prepareStandaloneRelease(base), /not empty/);
});

test("rejects changed bytes and an extra file", async () => {
  const { bundleDir, outputDir } = await bundle("x-setup.exe");
  await prepareStandaloneRelease({
    version: VERSION,
    ...SOURCE,
    bundleDir,
    outputDir,
    authenticode: "Valid",
  });
  await writeFile(join(outputDir, INSTALLER), "other bytes of x-setup.exe");
  await assert.rejects(
    verifyPreparedStandaloneRelease({ directory: outputDir, version: VERSION }),
    /checksum mismatch/,
  );
  await writeFile(join(outputDir, INSTALLER), "bytes of x-setup.exe");
  await verifyPreparedStandaloneRelease({ directory: outputDir, version: VERSION });
  await writeFile(join(outputDir, "notes.txt"), "");
  await assert.rejects(
    verifyPreparedStandaloneRelease({ directory: outputDir, version: VERSION }),
    /unexpected asset set/,
  );
});
```

Создать `tools/standalone-release/test/sign-overlay.test.mjs`:

<!-- prettier-ignore -->
```js
import assert from "node:assert/strict";
import test from "node:test";

import { buildSignOverlay } from "../sign-overlay.mjs";

const THUMBPRINT = "0123456789abcdef0123456789abcdef01234567";

test("builds the Tauri overlay that signs with a certificate from the store", () => {
  assert.deepEqual(
    buildSignOverlay({
      thumbprint: "01 23 45 67 89 ab cd ef 01 23 45 67 89 ab cd ef 01 23 45 67",
      timestampUrl: "http://timestamp.example.org",
    }),
    {
      bundle: {
        windows: {
          certificateThumbprint: THUMBPRINT.toUpperCase(),
          digestAlgorithm: "sha256",
          timestampUrl: "http://timestamp.example.org/",
          tsp: true,
        },
      },
    },
  );
});

test("refuses a thumbprint that is not a SHA-1 and a timestamp server that is no URL", () => {
  for (const thumbprint of ["", "0123", `${THUMBPRINT}00`, "g".repeat(40), undefined]) {
    assert.throws(
      () => buildSignOverlay({ thumbprint, timestampUrl: "http://timestamp.example.org" }),
      /40 hex digits/,
    );
  }
  for (const timestampUrl of ["", "timestamp.example.org", "ftp://timestamp.example.org"]) {
    assert.throws(
      () => buildSignOverlay({ thumbprint: THUMBPRINT, timestampUrl }),
      /http or https/,
    );
  }
});
```

Создать `tools/standalone-release/test/installer.test.mjs`:

<!-- prettier-ignore -->
```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// CRLF on a Windows checkout: every anchor below works on LF.
const text = async (path) => (await readFile(path, "utf8")).replaceAll("\r\n", "\n");

const base = JSON.parse(await text("apps/standalone/src-tauri/tauri.conf.json"));
const overlay = JSON.parse(await text("apps/standalone/src-tauri/tauri.installer.conf.json"));
const hooksBytes = await readFile("apps/standalone/src-tauri/windows/installer-hooks.nsh");
const hooks = hooksBytes
  .toString("utf8")
  .replace(/^\uFEFF/, "")
  .replaceAll("\r\n", "\n");

/** The body of one hook macro. */
function macro(name) {
  const start = hooks.indexOf(`!macro ${name}\n`);
  assert.ok(start >= 0, `${name} is defined`);
  return hooks.slice(start, hooks.indexOf("!macroend", start));
}

test("only the installer build bundles the host: cargo and the debug build need no sidecar", () => {
  // tauri-build copies `externalBin` at compile time and fails without the
  // file, so a sidecar in tauri.conf.json would break `cargo test` everywhere.
  assert.equal(base.bundle.externalBin, undefined);
  assert.deepEqual(base.bundle.targets, ["nsis"]);
  assert.deepEqual(overlay.bundle.externalBin, ["binaries/markiro-host"]);
  assert.deepEqual(overlay.bundle.windows.nsis, {
    installMode: "perMachine",
    languages: ["Russian"],
    installerHooks: "windows/installer-hooks.nsh",
  });
});

test("the hooks file is UTF-8 with a byte order mark, or NSIS garbles the Russian text", () => {
  assert.deepEqual([...hooksBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.match(hooks, /[а-я]/);
});

test("the role comes from /ROLE=, the earlier installation or the questions, and never changes", () => {
  const preinstall = macro("NSIS_HOOK_PREINSTALL");
  assert.match(preinstall, /\$\{GetOptions\} \$CMDLINE "\/ROLE=" \$0/);
  assert.match(preinstall, /ReadRegStr \$1 HKLM "\$\{MARKIRO_ROLE_KEY\}" "Role"/);
  for (const role of ["host", "station", "office"]) {
    assert.match(preinstall, new RegExp(`StrCpy \\$0 "${role}"`), role);
  }
  assert.match(preinstall, /\$\{AndIf\} \$0 != \$1\n\s+!insertmacro MARKIRO_FAIL/);
  assert.match(preinstall, /\$\{AndIf\} \$\{Silent\}\n\s+!insertmacro MARKIRO_FAIL/);
  // The running service holds its binary: it stops before files are copied.
  assert.match(preinstall, /"\$INSTDIR\\markiro-host\.exe" stop-service/);
});

test("only the host role registers the service; the others drop the host binary", () => {
  const postinstall = macro("NSIS_HOOK_POSTINSTALL");
  assert.match(postinstall, /FileWrite \$0 '\{"role":"\$MarkiroRole"\}\$\\r\$\\n'/);
  assert.match(
    postinstall,
    /\$\{If\} \$MarkiroRole == "host"\n[\s\S]*"\$INSTDIR\\markiro-host\.exe" install'\n\s+Pop \$0\n\s+\$\{If\} \$0 != "0"\n\s+!insertmacro MARKIRO_FAIL/,
  );
  assert.match(postinstall, /"\$INSTDIR\\markiro-host\.exe" network-check'/);
  assert.match(postinstall, /\$\{If\} \$0 == "3"/);
  assert.match(
    postinstall,
    /\$\{Else\}\n\s+; Only the host role runs the host\.\n\s+Delete "\$INSTDIR\\markiro-host\.exe"/,
  );
  assert.match(
    postinstall,
    /\$\{If\} \$MarkiroRole == "office"\n\s+DeleteRegValue HKLM "\$\{MARKIRO_RUN_KEY\}"/,
  );
});

test("uninstall and upgrade never delete data", () => {
  const preuninstall = macro("NSIS_HOOK_PREUNINSTALL");
  assert.match(preuninstall, /StrCpy \$DeleteAppDataCheckboxState 0/);
  assert.match(
    preuninstall,
    /\$\{If\} \$UpdateMode = 1\n\s+nsExec::ExecToLog '"\$INSTDIR\\markiro-host\.exe" stop-service'\n\s+\$\{Else\}\n\s+nsExec::ExecToLog '"\$INSTDIR\\markiro-host\.exe" uninstall'/,
  );
  const code = hooks
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(";"))
    .join("\n");
  assert.doesNotMatch(code, /RMDir|RmDir|ProgramData|LOCALAPPDATA|\$APPDATA/);
  assert.doesNotMatch(hooks, /NSIS_HOOK_POSTUNINSTALL/);
});

test("every jump label in the hooks is defined exactly once", () => {
  const defined = [...hooks.matchAll(/^\s*(markiro_[a-z_]+):$/gm)].map((match) => match[1]);
  assert.equal(new Set(defined).size, defined.length);
  for (const target of hooks.matchAll(/\b(?:IDNO|IDYES|Goto) (markiro_[a-z_]+)/g)) {
    assert.ok(defined.includes(target[1]), target[1]);
  }
});

test("the host binary the build copies in stays out of git", async () => {
  assert.match(await text("apps/standalone/.gitignore"), /^\/src-tauri\/binaries\/$/m);
});
```

Правка `tools/ci/test/affected.test.mjs`:

Фрагмент 1:

<!-- prettier-ignore -->
```js
    ["tools/station-release/build-manifest.mjs", ["station_rust", "station_windows_build"]],
    ["tools/signer-release/build-manifest.mjs", ["signer_rust", "signer_windows_build"]],
  ];

```

заменить на:

<!-- prettier-ignore -->
```js
    ["tools/station-release/build-manifest.mjs", ["station_rust", "station_windows_build"]],
    ["tools/signer-release/build-manifest.mjs", ["signer_rust", "signer_windows_build"]],
    ["tools/standalone-release/smoke.ps1", ["standalone_rust", "standalone_windows_build"]],
  ];

```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `node --test tools/standalone-release/test/*.test.mjs`
Expected: FAIL — `ENOENT … tauri.installer.conf.json`, `ERR_MODULE_NOT_FOUND … prepare.mjs` и `… sign-overlay.mjs`.

Run (вне песочницы): `node --test tools/ci/test/affected.test.mjs`
Expected: FAIL — «deployment and release tooling selects its consuming jobs»: путь `tools/standalone-release/smoke.ps1` пока включает полный прогон, а не задания автонома.

- [ ] **Step 3: Оверлей, хуки, артефакт, оверлей подписи, скрипт и классификатор**

Создать `apps/standalone/src-tauri/tauri.installer.conf.json`:

<!-- prettier-ignore -->
```json
{
  "bundle": {
    "externalBin": ["binaries/markiro-host"],
    "windows": {
      "nsis": {
        "installMode": "perMachine",
        "languages": ["Russian"],
        "installerHooks": "windows/installer-hooks.nsh"
      }
    }
  }
}
```

Создать `apps/standalone/src-tauri/windows/installer-hooks.nsh`:

<!-- prettier-ignore -->
```text
;; Markiro Standalone installer hooks (plan УСТ), included by Tauri's
;; installer.nsi. Saved as UTF-8 with a byte order mark: without one NSIS
;; reads the Russian text in the build machine's ANSI code page.
;;
;; Roles: host (the host service MarkiroHost and the station), station (a
;; station that pairs with a host on another PC), office (the office only:
;; no host, no kiosk mode). The role comes from /ROLE=host|station|office,
;; else from the earlier installation, else from two questions; a silent
;; install without either fails. A role never changes on reinstall: uninstall
;; first. The role goes to HKLM\Software\Markiro\Standalone (Role) for the
;; next installer and to $INSTDIR\installation.json for the app
;; (src-tauri/src/installation.rs). Neither uninstall nor upgrade deletes
;; %ProgramData%\Markiro\Host or the app's data under %LOCALAPPDATA%.

!define MARKIRO_ROLE_KEY "Software\Markiro\Standalone"
!define MARKIRO_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define MARKIRO_RUN_VALUE "MarkiroStandalone"

Var MarkiroRole

!macro MARKIRO_FAIL message
  MessageBox MB_ICONSTOP "${message}" /SD IDOK
  SetErrorLevel 2
  Abort "${message}"
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; The role an earlier installation kept, and the one asked for.
  ClearErrors
  ReadRegStr $1 HKLM "${MARKIRO_ROLE_KEY}" "Role"
  ${If} ${Errors}
    StrCpy $1 ""
  ${EndIf}
  ClearErrors
  ${GetOptions} $CMDLINE "/ROLE=" $0
  ${If} ${Errors}
    StrCpy $0 ""
  ${EndIf}
  ${If} $0 != ""
  ${AndIf} $0 != "host"
  ${AndIf} $0 != "station"
  ${AndIf} $0 != "office"
    !insertmacro MARKIRO_FAIL "Неизвестная роль /ROLE=$0. Допустимо: host, station, office."
  ${EndIf}
  ${If} $0 != ""
  ${AndIf} $1 != ""
  ${AndIf} $0 != $1
    !insertmacro MARKIRO_FAIL "Этот компьютер уже установлен с ролью $1. Роль меняется удалением программы и установкой заново; данные при удалении сохраняются."
  ${EndIf}
  ${If} $0 == ""
    StrCpy $0 $1
  ${EndIf}
  ${If} $0 == ""
  ${AndIf} ${Silent}
    !insertmacro MARKIRO_FAIL "Тихая установка требует роль: /ROLE=host, /ROLE=station или /ROLE=office."
  ${EndIf}
  ${If} $0 == ""
    MessageBox MB_YESNO|MB_ICONQUESTION "На этом компьютере будет работать хост — главная база площадки? Обычно это ПК станции.$\n$\nДа — хост и станция.$\nНет — выбрать другую роль." IDNO markiro_not_host
    StrCpy $0 "host"
    Goto markiro_role_chosen
    markiro_not_host:
    MessageBox MB_YESNO|MB_ICONQUESTION "Этот компьютер — ПК офиса (администратора)?$\n$\nДа — только офис: без хоста и без киоск-режима.$\nНет — только станция: она подключится к хосту на другом ПК." IDNO markiro_station
    StrCpy $0 "office"
    Goto markiro_role_chosen
    markiro_station:
    StrCpy $0 "station"
    markiro_role_chosen:
  ${EndIf}
  StrCpy $MarkiroRole $0
  DetailPrint "Роль компьютера: $MarkiroRole"
  ; An earlier host service holds its binary: stop it before the files are
  ; replaced. `install` below starts it again.
  ${If} ${FileExists} "$INSTDIR\markiro-host.exe"
    nsExec::ExecToLog '"$INSTDIR\markiro-host.exe" stop-service'
    Pop $0
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKLM "${MARKIRO_ROLE_KEY}" "Role" $MarkiroRole
  FileOpen $0 "$INSTDIR\installation.json" w
  FileWrite $0 '{"role":"$MarkiroRole"}$\r$\n'
  FileClose $0
  ${If} $MarkiroRole == "host"
    DetailPrint "Установка службы MarkiroHost…"
    nsExec::ExecToLog '"$INSTDIR\markiro-host.exe" install'
    Pop $0
    ${If} $0 != "0"
      !insertmacro MARKIRO_FAIL "Служба MarkiroHost не установлена (код $0). Подробности — в журнале установки выше."
    ${EndIf}
    nsExec::ExecToLog '"$INSTDIR\markiro-host.exe" network-check'
    Pop $0
    ${If} $0 == "3"
      DetailPrint "Сеть отнесена к общедоступным: порт хоста на ней закрыт."
      ${IfNot} ${Silent}
        MessageBox MB_YESNO|MB_ICONEXCLAMATION "Windows относит сеть этого компьютера к общедоступным, и порт хоста 45710 в ней закрыт: ПК офиса не подключится.$\n$\nПеревести сеть в частную?" IDNO markiro_keep_profile
        nsExec::ExecToLog '"$INSTDIR\markiro-host.exe" network-check --make-private'
        Pop $0
        markiro_keep_profile:
      ${EndIf}
    ${EndIf}
  ${Else}
    ; Only the host role runs the host.
    Delete "$INSTDIR\markiro-host.exe"
  ${EndIf}
  ${If} $MarkiroRole == "office"
    DeleteRegValue HKLM "${MARKIRO_RUN_KEY}" "${MARKIRO_RUN_VALUE}"
  ${Else}
    ; A station opens by itself when anybody signs in to Windows.
    WriteRegStr HKLM "${MARKIRO_RUN_KEY}" "${MARKIRO_RUN_VALUE}" '"$INSTDIR\${MAINBINARYNAME}.exe"'
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; The app's data under %LOCALAPPDATA% may hold facts the host has not
  ; received yet: never delete it, whatever the checkbox says.
  StrCpy $DeleteAppDataCheckboxState 0
  ${If} ${FileExists} "$INSTDIR\markiro-host.exe"
    ${If} $UpdateMode = 1
      nsExec::ExecToLog '"$INSTDIR\markiro-host.exe" stop-service'
    ${Else}
      nsExec::ExecToLog '"$INSTDIR\markiro-host.exe" uninstall'
    ${EndIf}
    Pop $0
    ${If} $0 != "0"
      DetailPrint "Служба MarkiroHost не остановлена (код $0)."
    ${EndIf}
  ${EndIf}
  ${If} $UpdateMode <> 1
    DeleteRegValue HKLM "${MARKIRO_RUN_KEY}" "${MARKIRO_RUN_VALUE}"
    DeleteRegValue HKLM "${MARKIRO_ROLE_KEY}" "Role"
    DeleteRegKey /ifempty HKLM "${MARKIRO_ROLE_KEY}"
    DeleteRegKey /ifempty HKLM "Software\Markiro"
    Delete "$INSTDIR\installation.json"
  ${EndIf}
!macroend
```

Файл хуков должен начинаться с BOM, иначе NSIS прочтёт русский текст в кодовой странице машины сборки:

```bash
python3 -c "import pathlib; p = pathlib.Path('apps/standalone/src-tauri/windows/installer-hooks.nsh'); b = p.read_bytes(); p.write_bytes(b if b.startswith(b'\xef\xbb\xbf') else b'\xef\xbb\xbf' + b)"
head -c 3 apps/standalone/src-tauri/windows/installer-hooks.nsh | xxd
```

Expected: `00000000: efbb bf`.

Правка `apps/standalone/.gitignore`:

Фрагмент 1:

<!-- prettier-ignore -->
```text
# Tauri-generated capability schemas, regenerated on every build
/src-tauri/gen/schemas
```

заменить на:

<!-- prettier-ignore -->
```text
# Tauri-generated capability schemas, regenerated on every build
/src-tauri/gen/schemas
# The host binary the installer build copies in as the Tauri sidecar
/src-tauri/binaries/
```

Создать `tools/standalone-release/prepare.mjs`:

<!-- prettier-ignore -->
```js
// The installer of «Markiro Автоном» as a self-verifying artifact (plan УСТ):
// the NSIS installer under a stable name, `release-evidence.json` (version,
// source commit, roles, hash and size, Authenticode status) and `SHA256SUMS`.
// The `standalone-windows-build` job runs it after the installer's smoke test
// and uploads the directory; nothing is published anywhere else.
//
//   node tools/standalone-release/prepare.mjs --bundle-dir <nsis dir> --output-dir <dir> \
//     --source-repository <owner/repo> --source-sha <40 hex> --authenticode <status>

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const STANDALONE_TAURI_CONFIG = "apps/standalone/src-tauri/tauri.conf.json";
export const EVIDENCE_FILE = "release-evidence.json";
export const CHECKSUM_FILE = "SHA256SUMS";
/** The installer's roles (`src-tauri/windows/installer-hooks.nsh`). */
export const ROLES = Object.freeze(["host", "station", "office"]);
/** `Get-AuthenticodeSignature`'s status for a signed and for an unsigned file. */
export const AUTHENTICODE_STATUSES = Object.freeze(["Valid", "NotSigned"]);

const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export function standaloneInstallerName(version) {
  if (!VERSION.test(version ?? "")) throw new Error(`${String(version)} is not a version`);
  return `markiro-standalone-${version}-windows-x86_64-setup.exe`;
}

/** The single source of the version: the app's Tauri config. */
export async function readStandaloneVersion(configPath = STANDALONE_TAURI_CONFIG) {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  if (!VERSION.test(config?.version ?? "")) {
    throw new Error(`${configPath} has no usable version`);
  }
  return config.version;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateSource(repository, sha) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "")) {
    throw new Error("source repository is invalid");
  }
  if (!/^[a-f0-9]{40}$/.test(sha ?? "")) {
    throw new Error("source SHA must be a full lowercase Git commit SHA");
  }
}

export async function prepareStandaloneRelease({
  version,
  sourceRepository,
  sourceSha,
  bundleDir,
  outputDir,
  authenticode,
}) {
  validateSource(sourceRepository, sourceSha);
  if (!AUTHENTICODE_STATUSES.includes(authenticode)) {
    throw new Error(`Authenticode status ${String(authenticode)} is neither signed nor unsigned`);
  }
  const installers = (await readdir(bundleDir)).filter((name) => name.endsWith("-setup.exe"));
  if (installers.length !== 1) {
    throw new Error(`expected exactly one NSIS installer in ${bundleDir}`);
  }
  await mkdir(outputDir, { recursive: true });
  if ((await readdir(outputDir)).length !== 0) {
    throw new Error(`prepared release directory is not empty: ${outputDir}`);
  }
  const name = standaloneInstallerName(version);
  const bytes = await readFile(join(bundleDir, installers[0]));
  await writeFile(join(outputDir, name), bytes);
  const evidence = {
    schemaVersion: 1,
    product: "standalone",
    version,
    source: { repository: sourceRepository, sha: sourceSha },
    roles: [...ROLES],
    authenticode,
    assets: { [name]: { sha256: sha256(bytes), size: bytes.length } },
  };
  const evidenceBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  await writeFile(join(outputDir, EVIDENCE_FILE), evidenceBytes);
  const sums = [
    [EVIDENCE_FILE, sha256(evidenceBytes)],
    [name, sha256(bytes)],
  ]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([file, hash]) => `${hash}  ${file}\n`)
    .join("");
  await writeFile(join(outputDir, CHECKSUM_FILE), sums, "utf8");
  return verifyPreparedStandaloneRelease({ directory: outputDir, version });
}

export async function verifyPreparedStandaloneRelease({ directory, version }) {
  const name = standaloneInstallerName(version);
  const expected = [CHECKSUM_FILE, EVIDENCE_FILE, name].sort();
  const entries = (await readdir(directory)).sort();
  if (entries.join("\n") !== expected.join("\n")) {
    throw new Error("prepared standalone release has an unexpected asset set");
  }
  const bytes = Object.fromEntries(
    await Promise.all(
      entries.map(async (entry) => [entry, await readFile(join(directory, entry))]),
    ),
  );
  const evidence = JSON.parse(bytes[EVIDENCE_FILE].toString("utf8"));
  if (
    evidence?.schemaVersion !== 1 ||
    evidence?.product !== "standalone" ||
    evidence?.version !== version ||
    JSON.stringify(evidence?.roles) !== JSON.stringify(ROLES) ||
    !AUTHENTICODE_STATUSES.includes(evidence?.authenticode)
  ) {
    throw new Error("prepared standalone release evidence is invalid");
  }
  validateSource(evidence.source?.repository, evidence.source?.sha);
  const asset = evidence.assets?.[name];
  if (
    Object.keys(evidence.assets ?? {}).length !== 1 ||
    asset?.sha256 !== sha256(bytes[name]) ||
    asset?.size !== bytes[name].length
  ) {
    throw new Error(`prepared standalone release checksum mismatch: ${name}`);
  }
  const lines = bytes[CHECKSUM_FILE].toString("utf8").trim().split("\n");
  const sums = new Map();
  for (const line of lines) {
    const match = /^([a-f0-9]{64}) {2}([^/\\]+)$/.exec(line);
    if (!match || sums.has(match[2])) throw new Error("prepared standalone SHA256SUMS is invalid");
    sums.set(match[2], match[1]);
  }
  if ([...sums.keys()].sort().join("\n") !== [EVIDENCE_FILE, name].sort().join("\n")) {
    throw new Error("prepared standalone SHA256SUMS names unexpected assets");
  }
  for (const [file, hash] of sums) {
    if (sha256(bytes[file]) !== hash) {
      throw new Error(`prepared standalone release checksum mismatch: ${file}`);
    }
  }
  return { directory, name, evidence };
}

async function main() {
  const { values } = parseArgs({
    options: {
      "bundle-dir": { type: "string" },
      "output-dir": { type: "string" },
      "source-repository": { type: "string" },
      "source-sha": { type: "string" },
      authenticode: { type: "string" },
    },
    strict: true,
  });
  const prepared = await prepareStandaloneRelease({
    version: await readStandaloneVersion(),
    sourceRepository: values["source-repository"],
    sourceSha: values["source-sha"],
    bundleDir: values["bundle-dir"],
    outputDir: values["output-dir"],
    authenticode: values.authenticode,
  });
  process.stdout.write(
    `${prepared.name} ${prepared.evidence.assets[prepared.name].sha256} (${prepared.evidence.authenticode})\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
```

Создать `tools/standalone-release/sign-overlay.mjs`:

<!-- prettier-ignore -->
```js
// Authenticode for the installer (plan УСТ, owner question П12): the Tauri
// config overlay that makes `tauri build` sign with a code-signing
// certificate already in the Windows certificate store of the build machine.
// The pilot ships unsigned (the release evidence says `NotSigned`); with the
// owner's certificate the build becomes
//
//   node tools/standalone-release/sign-overlay.mjs --thumbprint <SHA-1> \
//     --timestamp-url <RFC 3161 URL of the certificate's CA> > sign.json
//   pnpm --filter @markiro/standalone tauri build \
//     --config src-tauri/tauri.installer.conf.json --config <path>/sign.json --bundles nsis
//
// The certificate itself, its password and the store stay outside the repo.

import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export function buildSignOverlay({ thumbprint, timestampUrl }) {
  const normalized = String(thumbprint ?? "")
    .replaceAll(/\s/g, "")
    .toUpperCase();
  if (!/^[0-9A-F]{40}$/.test(normalized)) {
    throw new Error("the certificate thumbprint must be 40 hex digits (SHA-1)");
  }
  let url;
  try {
    url = new URL(String(timestampUrl ?? ""));
  } catch {
    throw new Error("the timestamp server must be an http or https URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("the timestamp server must be an http or https URL");
  }
  return {
    bundle: {
      windows: {
        certificateThumbprint: normalized,
        digestAlgorithm: "sha256",
        timestampUrl: url.href,
        tsp: true,
      },
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { values } = parseArgs({
    options: { thumbprint: { type: "string" }, "timestamp-url": { type: "string" } },
    strict: true,
  });
  const overlay = buildSignOverlay({
    thumbprint: values.thumbprint,
    timestampUrl: values["timestamp-url"],
  });
  process.stdout.write(`${JSON.stringify(overlay, null, 2)}\n`);
}
```

Правка `package.json`:

Фрагмент 1:

<!-- prettier-ignore -->
```json
    "test:station-release:contract": "node --test tools/station-release/test/*.test.mjs",
    "test:signer-release:contract": "node --test tools/signer-release/test/*.test.mjs",
    "test:handheld-release:contract": "node --test tools/handheld-release/test/*.test.mjs",
    "verify:station-production-cors": "node tools/station-release/verify-api-cors.mjs https://admin.markiro.app",
```

заменить на:

<!-- prettier-ignore -->
```json
    "test:station-release:contract": "node --test tools/station-release/test/*.test.mjs",
    "test:signer-release:contract": "node --test tools/signer-release/test/*.test.mjs",
    "test:standalone-release:contract": "node --test tools/standalone-release/test/*.test.mjs",
    "test:handheld-release:contract": "node --test tools/handheld-release/test/*.test.mjs",
    "verify:station-production-cors": "node tools/station-release/verify-api-cors.mjs https://admin.markiro.app",
```

Правка `tools/ci/affected.mjs`:

Фрагмент 1:

<!-- prettier-ignore -->
```js
  if (path.startsWith("tools/signer-release/")) return signerJobs;
  if (path.startsWith("tools/station-release/")) return stationJobs;
  // Node contracts for the Android release, so they run in the Node job -- the
  // handheld job is Gradle-only and has no pnpm.
```

заменить на:

<!-- prettier-ignore -->
```js
  if (path.startsWith("tools/signer-release/")) return signerJobs;
  if (path.startsWith("tools/station-release/")) return stationJobs;
  // The installer's contracts and smoke test run in the standalone Windows job.
  if (path.startsWith("tools/standalone-release/")) return standaloneJobs;
  // Node contracts for the Android release, so they run in the Node job -- the
  // handheld job is Gradle-only and has no pnpm.
```

- [ ] **Step 4: Тесты проходят, CLI Tauri принимает оверлей, пробный прогон артефакта**

Run: `pnpm --config.verifyDepsBeforeRun=false run test:standalone-release:contract`
Expected: PASS — 15 тестов (`prepare` 6, `sign-overlay` 2, `installer` 7).

Run (вне песочницы): `node --test tools/ci/test/*.test.mjs`
Expected: PASS — 47 тестов.

Схема оверлея — настоящим CLI Tauri на macOS (собирает приложение в отладке с копией хоста под тройкой macOS; без копии `tauri-build` падает с ``resource path `binaries/markiro-host-aarch64-apple-darwin` doesn't exist``):

```bash
cargo build --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host
mkdir -p apps/standalone/src-tauri/binaries
cp apps/standalone/target/debug/markiro-host apps/standalone/src-tauri/binaries/markiro-host-aarch64-apple-darwin
pnpm_config_verify_deps_before_run=false pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec tauri build --config src-tauri/tauri.installer.conf.json --debug --no-bundle
node tools/standalone-release/sign-overlay.mjs --thumbprint 0123456789abcdef0123456789abcdef01234567 --timestamp-url http://timestamp.digicert.com > /tmp/claude/ust-sign.json
pnpm_config_verify_deps_before_run=false pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec tauri build --config src-tauri/tauri.installer.conf.json --config /tmp/claude/ust-sign.json --debug --no-bundle
rm -r apps/standalone/src-tauri/binaries /tmp/claude/ust-sign.json
git status --short
```

Expected: обе сборки кончаются `Built application at: …/debug/markiro-standalone`; `git status --short` не показывает `binaries` (каталог в `.gitignore`). Опечатка в ключе оверлея валит CLI до сборки (проверено: `"installmode"` → ``error on `bundle > windows > nsis`: … is not valid under any of the schemas``). Если в worktree задан общий `CARGO_TARGET_DIR`, копировать хост из него. Хуки NSIS на macOS не компилируются (`makensis` нет) — их компилирует сборка установщика в задаче 6.

Пробный прогон артефакта:

```bash
rm -rf /tmp/claude/ust-dry && mkdir -p /tmp/claude/ust-dry/nsis
printf 'fake installer' > "/tmp/claude/ust-dry/nsis/Markiro Standalone_0.1.0_x64-setup.exe"
node tools/standalone-release/prepare.mjs --bundle-dir /tmp/claude/ust-dry/nsis --output-dir /tmp/claude/ust-dry/out \
  --source-repository thevladbog/markiro --source-sha "$(git rev-parse HEAD)" --authenticode NotSigned
ls /tmp/claude/ust-dry/out && rm -r /tmp/claude/ust-dry
```

Expected: строка `markiro-standalone-0.1.0-windows-x86_64-setup.exe 941ef2fd249e8e3535908e3663515a85a291c538016f75be86032da473029b3e (NotSigned)`, затем `SHA256SUMS`, установщик и `release-evidence.json`.

- [ ] **Step 5: Мутации**

В `apps/standalone/src-tauri/windows/installer-hooks.nsh` фрагмент

<!-- prettier-ignore -->
```text
  StrCpy $DeleteAppDataCheckboxState 0
```

заменить на

<!-- prettier-ignore -->
```text

```

Run: `node --test tools/standalone-release/test/installer.test.mjs`
Expected: FAIL — «uninstall and upgrade never delete data». Затем вернуть файл (`cp /tmp/claude/before <файл>`, `cmp` молчит, `shasum -a 256` — тот же хеш).

В `tools/standalone-release/prepare.mjs` фрагмент

<!-- prettier-ignore -->
```js
  if (installers.length !== 1) {
```

заменить на

<!-- prettier-ignore -->
```js
  if (installers.length === 0) {
```

Run: `node --test tools/standalone-release/test/prepare.test.mjs`
Expected: FAIL — «refuses a bundle with no installer or with two». Затем вернуть файл (`cp /tmp/claude/before <файл>`, `cmp` молчит, `shasum -a 256` — тот же хеш).

- [ ] **Step 6: Коммит**

```bash
node_modules/.bin/prettier --check tools/standalone-release tools/ci package.json apps/standalone/src-tauri/tauri.installer.conf.json
git diff --check
git add apps/standalone/src-tauri/tauri.installer.conf.json apps/standalone/src-tauri/windows/installer-hooks.nsh \
  apps/standalone/.gitignore package.json tools/ci/affected.mjs tools/ci/test/affected.test.mjs \
  tools/standalone-release/prepare.mjs tools/standalone-release/sign-overlay.mjs \
  tools/standalone-release/test/prepare.test.mjs tools/standalone-release/test/sign-overlay.test.mjs \
  tools/standalone-release/test/installer.test.mjs
git commit -m "feat(standalone): the NSIS installer with three roles, the release artifact and the signing overlay" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: CI — сборка установщика, дымовая проверка на раннере, артефакт

`standalone-windows-build` — единственное место, где установщик собирается и ставится по-настоящему. Шаг `tauri build --debug --no-bundle` заменяется сборкой установщика в release: она компилирует то же приложение, а сверх того хуки NSIS. Затем `smoke.ps1` ставит установщик на раннере (у раннеров GitHub права администратора) и проверяет то, что обещают роли, служба, брандмауэр и удаление; `prepare.mjs` пишет артефакт, `actions/upload-artifact` (тот же пин, что у остальных заданий `ci.yml`) хранит его 30 дней. Срок задания — 75 минут вместо 40.

**Files:**

- Create: `tools/standalone-release/smoke.ps1`
- Modify: `.github/workflows/ci.yml` (задание `standalone-windows-build`)
- Test: `tools/standalone-release/test/workflow.test.mjs` (Create)

**Interfaces:**

- Consumes: сборка установщика и `prepare.mjs` (задача 5), подкоманды хоста (задача 2), `installation.json` (задача 3).
- Produces: `smoke.ps1 -BundleDir <каталог nsis>` (выход с исключением на первой несбывшейся проверке); артефакт `standalone-installer-<sha>` (`markiro-standalone-<версия>-windows-x86_64-setup.exe`, `release-evidence.json`, `SHA256SUMS`).

- [ ] **Step 1: Контракт задания и проверок дымового теста**

Создать `tools/standalone-release/test/workflow.test.mjs`:

<!-- prettier-ignore -->
```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { load } from "js-yaml";

// CRLF on a Windows checkout: every anchor below works on LF.
const text = async (path) => (await readFile(path, "utf8")).replaceAll("\r\n", "\n");

const workflow = await text(".github/workflows/ci.yml");
const job = load(workflow).jobs["standalone-windows-build"];
const runs = job.steps.map((step) => step.run ?? step.uses ?? "");

test("the Windows job builds, smoke-tests and keeps the installer, in that order", () => {
  assert.ok(job["timeout-minutes"] >= 60);
  const order = [
    "pnpm test:standalone-release:contract",
    "cargo test --manifest-path apps/standalone/Cargo.toml --workspace",
    "cargo build --release --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host",
    "apps/standalone/src-tauri/binaries/markiro-host-x86_64-pc-windows-msvc.exe",
    "tauri build --config src-tauri/tauri.installer.conf.json --bundles nsis",
    "./tools/standalone-release/smoke.ps1 -BundleDir apps/standalone/target/release/bundle/nsis",
    "node tools/standalone-release/prepare.mjs",
    "actions/upload-artifact@",
  ].map((needle) => runs.findIndex((run) => run.includes(needle)));
  assert.ok(
    order.every((index) => index >= 0),
    `every step is there: ${JSON.stringify(order)}`,
  );
  assert.deepEqual(
    order,
    [...order].sort((left, right) => left - right),
  );
  // A Windows-only overlay named tauri.windows.conf.json would be merged into
  // every Windows build by tauri-build, `cargo test` included.
  assert.doesNotMatch(workflow, /tauri\.windows\.conf\.json/);
  // The bundle lands under the workspace's target, not src-tauri's.
  assert.doesNotMatch(workflow, /apps\/standalone\/src-tauri\/target/);
  // A signing key or certificate never appears in CI (owner question П12).
  assert.doesNotMatch(workflow, /certificateThumbprint|signtool|STANDALONE_.*SIGN/);
});

test("the smoke test checks what the installer promises", async () => {
  const smoke = await text("tools/standalone-release/smoke.ps1");
  for (const promise of [
    "Install @('/S')",
    "/ROLE=host",
    "/ROLE=office",
    "/ROLE=station",
    "'NT AUTHORITY\\LocalService'",
    "RESTART -- Delay = 5000",
    "qfailureflag",
    "Stop-Process -Id $before -Force",
    "'Domain,Private'",
    "'LocalSubnet'",
    "S-1-5-18,S-1-5-19,S-1-5-32-544",
    "print-fingerprint",
    "'host.db', 'host.json', 'tls\\cert.der', 'tls\\key.der'",
  ]) {
    assert.ok(smoke.includes(promise), promise);
  }
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `node --test tools/standalone-release/test/workflow.test.mjs`
Expected: FAIL — 2 теста: «the Windows job builds, smoke-tests and keeps the installer, in that order» (первой падает `assert.ok(job["timeout-minutes"] >= 60)`: у задания 40 минут) и «the smoke test checks what the installer promises» (`ENOENT … smoke.ps1`).

- [ ] **Step 3: Дымовой тест и задание**

Создать `tools/standalone-release/smoke.ps1`:

<!-- prettier-ignore -->
```powershell
#requires -Version 7
<#
  The installer of «Markiro Автоном» on a disposable Windows machine (plan
  УСТ): the roles, the MarkiroHost service with its account and restart
  policy, the firewall rule, the data directory's access list, a restart
  after a crash, a reinstall that keeps the host, a refused role change, and
  uninstalls that keep the data. The standalone-windows-build job runs it on
  GitHub's runner, which has administrator rights. Never run it on a site's
  PC: it installs and removes the service and leaves the test host's data in
  %ProgramData%\Markiro\Host.
#>
param([Parameter(Mandatory)][string]$BundleDir)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$found = @(Get-ChildItem -Path $BundleDir -Filter '*-setup.exe')
if ($found.Count -ne 1) { throw "expected one installer in $BundleDir, found $($found.Count)" }
$installer = $found[0].FullName
$installDir = Join-Path $env:ProgramFiles 'Markiro Standalone'
$dataDir = Join-Path $env:ProgramData 'Markiro\Host'
$hostExe = Join-Path $installDir 'markiro-host.exe'
$roleFile = Join-Path $installDir 'installation.json'
$runKey = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run'

function Step([string]$text) { Write-Host "== $text" }
function Check([bool]$condition, [string]$text) {
  if (-not $condition) { throw "FAILED: $text" }
  Write-Host "ok  $text"
}
function Install([string[]]$arguments) {
  (Start-Process -FilePath $installer -ArgumentList $arguments -Wait -PassThru).ExitCode
}
function Uninstall {
  # `_?=` runs the uninstaller in place, so -Wait waits for the work itself.
  $uninstaller = Join-Path $installDir 'uninstall.exe'
  (Start-Process -FilePath $uninstaller -ArgumentList @('/S', "_?=$installDir") -Wait -PassThru).ExitCode
}
function WaitFor([scriptblock]$condition, [int]$seconds, [string]$what) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if (& $condition) { Write-Host "ok  $what"; return }
    Start-Sleep -Milliseconds 500
  }
  throw "FAILED: $what within $seconds s"
}
function Service { Get-CimInstance Win32_Service -Filter "Name='MarkiroHost'" }
function HostAnswers {
  try {
    $hello = Invoke-RestMethod -Uri 'https://127.0.0.1:45710/v1/hello' -SkipCertificateCheck -TimeoutSec 5
    $hello.product -eq 'markiro-host'
  } catch { $false }
}
function Role { (Get-Content -Raw $roleFile | ConvertFrom-Json).role }
function RunValue { (Get-ItemProperty -Path $runKey -ErrorAction SilentlyContinue).PSObject.Properties['MarkiroStandalone'] }
function Sids([string]$path) {
  @((Get-Acl $path).Access | ForEach-Object {
      $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    } | Sort-Object -Unique)
}

Step 'a silent install without a role installs nothing'
Check ((Install @('/S')) -ne 0) 'the installer refuses /S without /ROLE'
Check ($null -eq (Service)) 'no service was registered'

Step 'role host: the service, its account, its restart policy, the port'
Check ((Install @('/S', '/ROLE=host')) -eq 0) 'the installer succeeds'
Check ((Role) -eq 'host') 'installation.json says host'
$service = Service
Check ($null -ne $service) 'MarkiroHost is registered'
Check ($service.StartMode -eq 'Auto') 'it starts with Windows'
Check ($service.StartName -eq 'NT AUTHORITY\LocalService') 'it runs as LocalService'
Check ($service.PathName -eq "`"$hostExe`" service") 'it runs markiro-host service'
WaitFor { (Service).State -eq 'Running' } 60 'the service runs'
WaitFor { HostAnswers } 60 'the host answers on https://127.0.0.1:45710'
$failure = (& sc.exe qfailure MarkiroHost | Out-String)
Check ($failure -match 'RESTART -- Delay = 5000') 'the first failure restarts it after 5 s'
Check ($failure -match 'RESET_PERIOD \(in seconds\)\s*: 86400') 'the failure count resets after a day'
Check ((& sc.exe qfailureflag MarkiroHost | Out-String) -match 'TRUE') 'an exit with an error counts as a failure'
$rule = Get-NetFirewallRule -Name 'MarkiroHost'
Check ($rule.Enabled -eq 'True' -and $rule.Direction -eq 'Inbound' -and $rule.Action -eq 'Allow') 'an inbound allow rule'
Check (($rule.Profile.ToString() -split ', ' | Sort-Object) -join ',' -eq 'Domain,Private') 'on private and domain networks only'
Check ((Get-NetFirewallPortFilter -AssociatedNetFirewallRule $rule).LocalPort -eq '45710') 'for TCP 45710'
Check ((Get-NetFirewallAddressFilter -AssociatedNetFirewallRule $rule).RemoteAddress -eq 'LocalSubnet') 'from the local subnet'
Check ((Get-Acl $dataDir).AreAccessRulesProtected) 'the data directory inherits nothing from ProgramData'
Check (((Sids $dataDir) -join ',') -eq 'S-1-5-18,S-1-5-19,S-1-5-32-544') 'SYSTEM, LocalService and Administrators only'
$key = Join-Path $dataDir 'tls\key.der'
WaitFor { Test-Path $key } 30 'the host made its TLS key'
Check (((Sids $key) -join ',') -eq 'S-1-5-18,S-1-5-19,S-1-5-32-544') 'the TLS key is not readable by users'
Check ($null -ne (RunValue)) 'the station opens at sign-in'

Step 'a crash: Windows starts the service again'
$before = (Service).ProcessId
Stop-Process -Id $before -Force
WaitFor { $now = Service; $now.State -eq 'Running' -and $now.ProcessId -ne $before } 45 'the service runs again in a new process'
WaitFor { HostAnswers } 60 'the host answers again'

Step 'a reinstall keeps the role and the host'
$hostJson = Get-Content -Raw (Join-Path $dataDir 'host.json')
$fingerprint = & $hostExe print-fingerprint --data-dir $dataDir | Select-Object -First 1
Check ((Install @('/S')) -eq 0) 'the installer succeeds with the role it kept'
Check ((Role) -eq 'host') 'the role stays host'
Check ((Get-Content -Raw (Join-Path $dataDir 'host.json')) -eq $hostJson) 'the host identity is the same'
Check ((& $hostExe print-fingerprint --data-dir $dataDir | Select-Object -First 1) -eq $fingerprint) 'the certificate is the same'
WaitFor { HostAnswers } 60 'the host answers after the reinstall'

Step 'another role on a reinstall is refused'
Check ((Install @('/S', '/ROLE=office')) -ne 0) 'the installer refuses /ROLE=office over host'
Check ((Service).State -eq 'Running') 'the service keeps running'

Step 'uninstall removes the service and the rule and keeps the data'
Check ((Uninstall) -eq 0) 'the uninstaller succeeds'
WaitFor { $null -eq (Service) } 30 'MarkiroHost is gone'
Check ($null -eq (Get-NetFirewallRule -Name 'MarkiroHost' -ErrorAction SilentlyContinue)) 'the firewall rule is gone'
foreach ($kept in @('host.db', 'host.json', 'tls\cert.der', 'tls\key.der')) {
  Check (Test-Path (Join-Path $dataDir $kept)) "the data stays: $kept"
}
Check ($null -eq (RunValue)) 'nothing opens at sign-in any more'
Check (-not (Test-Path $roleFile)) 'installation.json is gone'

Step 'role office: no host, no service, no autostart'
Check ((Install @('/S', '/ROLE=office')) -eq 0) 'the installer succeeds'
Check ((Role) -eq 'office') 'installation.json says office'
Check (-not (Test-Path $hostExe)) 'no markiro-host.exe'
Check ($null -eq (Service)) 'no service'
Check ($null -eq (RunValue)) 'the office PC does not open the app at sign-in'
Check ((Uninstall) -eq 0) 'the uninstaller succeeds'

Step 'role station: no host, opens at sign-in'
Check ((Install @('/S', '/ROLE=station')) -eq 0) 'the installer succeeds'
Check ((Role) -eq 'station') 'installation.json says station'
Check (-not (Test-Path $hostExe)) 'no markiro-host.exe'
Check ($null -eq (Service)) 'no service'
Check ($null -ne (RunValue)) 'the station opens at sign-in'
Check ((Uninstall) -eq 0) 'the uninstaller succeeds'
Check (Test-Path (Join-Path $dataDir 'host.db')) 'the host data from the first install is still there'

Write-Host 'standalone installer smoke test passed'
```

Правка `.github/workflows/ci.yml`:

Фрагмент 1:

<!-- prettier-ignore -->
```yaml
    if: needs.classify-changes.outputs.standalone_windows_build == 'true'
    runs-on: windows-latest
    timeout-minutes: 40
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
```

заменить на:

<!-- prettier-ignore -->
```yaml
    if: needs.classify-changes.outputs.standalone_windows_build == 'true'
    runs-on: windows-latest
    # The release build of the app and the host, the installer and its smoke
    # test come on top of the debug test build.
    timeout-minutes: 75
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
```

Фрагмент 2:

<!-- prettier-ignore -->
```yaml
      - uses: dtolnay/rust-toolchain@4cda84d5c5c54efe2404f9d843567869ab1699d4 # stable
      - run: pnpm install --frozen-lockfile
      - name: Build standalone webview + workspace deps
        run: pnpm turbo build --filter '@markiro/standalone...'
      # The Windows service entry point only compiles on Windows, so this is
      # the only job that exercises it.
      - name: cargo test (Windows paths)
        run: cargo test --manifest-path apps/standalone/Cargo.toml --workspace
      - name: Compile the Windows Tauri application
        run: pnpm --filter @markiro/standalone tauri build --debug --no-bundle

  handheld-android:
```

заменить на:

<!-- prettier-ignore -->
```yaml
      - uses: dtolnay/rust-toolchain@4cda84d5c5c54efe2404f9d843567869ab1699d4 # stable
      - run: pnpm install --frozen-lockfile
      - run: pnpm test:standalone-release:contract
      - name: Build standalone webview + workspace deps
        run: pnpm turbo build --filter '@markiro/standalone...'
      # The Windows service entry point and its installer seam only compile on
      # Windows, so this is the only job that exercises them.
      - name: cargo test (Windows paths)
        run: cargo test --manifest-path apps/standalone/Cargo.toml --workspace
      - name: Build the host for the installer
        run: cargo build --release --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host
      # Tauri bundles `bundle.externalBin` from src-tauri/binaries under the
      # target triple; tauri.installer.conf.json names it.
      - name: Put the host beside the app as its sidecar
        shell: bash
        run: |
          mkdir -p apps/standalone/src-tauri/binaries
          cp apps/standalone/target/release/markiro-host.exe \
            apps/standalone/src-tauri/binaries/markiro-host-x86_64-pc-windows-msvc.exe
      - name: Build the installer (NSIS, per machine, with roles)
        run: pnpm --filter @markiro/standalone tauri build --config src-tauri/tauri.installer.conf.json --bundles nsis
      - name: Install, crash, reinstall and uninstall on this runner
        shell: pwsh
        run: ./tools/standalone-release/smoke.ps1 -BundleDir apps/standalone/target/release/bundle/nsis
      - name: Prepare the installer artifact
        shell: pwsh
        run: |
          $installer = Get-ChildItem apps/standalone/target/release/bundle/nsis/*-setup.exe
          $status = (Get-AuthenticodeSignature $installer.FullName).Status.ToString()
          node tools/standalone-release/prepare.mjs `
            --bundle-dir apps/standalone/target/release/bundle/nsis `
            --output-dir "$env:RUNNER_TEMP/standalone-installer" `
            --source-repository "$env:GITHUB_REPOSITORY" `
            --source-sha "$env:GITHUB_SHA" `
            --authenticode $status
      - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: standalone-installer-${{ github.sha }}
          path: ${{ runner.temp }}/standalone-installer
          if-no-files-found: error
          retention-days: 30

  handheld-android:
```

Что проверяет `smoke.ps1`, по порядку: `/S` без роли отказывает и службы нет; `/S /ROLE=host` — `installation.json`, служба `MarkiroHost` с `StartMode Auto`, `NT AUTHORITY\LocalService` и командой `"…\markiro-host.exe" service`, хост отвечает на `https://127.0.0.1:45710/v1/hello`, `sc qfailure` — перезапуск через 5 с и сброс через 86 400 с, `sc qfailureflag` — `TRUE`, правило `MarkiroHost` (входящее, разрешение, `Domain, Private`, TCP 45710, `LocalSubnet`), каталог данных без наследования и только с SID `S-1-5-18`, `S-1-5-19`, `S-1-5-32-544` (и `tls\key.der` так же), автозапуск; убитый процесс службы — служба снова работает в новом процессе; `/S` повторно — роль та же, `host.json` и отпечаток те же; `/S /ROLE=office` поверх `host` — отказ, служба работает; удаление — службы и правила нет, `host.db`, `host.json`, `tls\cert.der`, `tls\key.der` на месте, автозапуска и `installation.json` нет; `/ROLE=office` — нет `markiro-host.exe`, службы и автозапуска; `/ROLE=station` — нет хоста и службы, автозапуск есть. Каждое ожидание ограничено (`WaitFor`: 30–60 с).

- [ ] **Step 4: Тесты проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false run test:standalone-release:contract`
Expected: PASS — 17 тестов.

Run (вне песочницы): `node --test tools/ci/test/*.test.mjs`
Expected: PASS — 47 тестов (`ci-required` и классификатор не менялись).

Синтаксис и поведение `smoke.ps1`, компиляцию хуков NSIS, `main.rs` и `service.rs` под Windows проверяет только запуск задания в GitHub: push не разрешён, поэтому это проверка владельца при первом пулл-реквесте (раздел «Итоговая проверка плана»).

- [ ] **Step 5: Мутация**

В `.github/workflows/ci.yml` фрагмент

<!-- prettier-ignore -->
```yaml
      - name: Install, crash, reinstall and uninstall on this runner
        shell: pwsh
        run: ./tools/standalone-release/smoke.ps1 -BundleDir apps/standalone/target/release/bundle/nsis
```

заменить на

<!-- prettier-ignore -->
```yaml

```

Run: `node --test tools/standalone-release/test/workflow.test.mjs`
Expected: FAIL — «the Windows job builds, smoke-tests and keeps the installer, in that order». Затем вернуть файл (`cp /tmp/claude/before <файл>`, `cmp` молчит, `shasum -a 256` — тот же хеш).

- [ ] **Step 6: Коммит**

```bash
node_modules/.bin/prettier --check .github/workflows/ci.yml tools/standalone-release
git diff --check
git add .github/workflows/ci.yml tools/standalone-release/smoke.ps1 tools/standalone-release/test/workflow.test.mjs
git commit -m "ci(standalone): build the installer, install, crash, reinstall and uninstall it on the Windows runner, keep the artifact" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Документы — памятка для ИТ, порядок установки, ручная проверка на Windows, `AGENTS.md`

Памятка — то, что родительская спецификация требует поставлять с установщиком (§9.2) и что спецификация пилота называет в §10 п. 6: служба и её учётная запись, порт и правило, каталоги данных, реестр, антивирус, отсутствие исходящих соединений, сеть площадки (П9), порядок установки на два ПК, обновление переустановкой (П13), удаление, подпись (П12) и ручной список Windows-проверок, которых не делает CI. В `apps/standalone/AGENTS.md` — новый раздел «Installer and service», абзац о киоск-режиме вместо открытого вопроса I1 и строка в «Verification».

**Files:**

- Create: `docs/runbooks/standalone-install.md`
- Modify: `apps/standalone/AGENTS.md`

**Interfaces:**

- Consumes: всё, что сделали задачи 1–6.
- Produces: памятку `docs/runbooks/standalone-install.md` (на неё ссылаются `AGENTS.md` и ручная проверка в «Итоговой проверке плана»).

- [ ] **Step 1: Памятка**

Создать `docs/runbooks/standalone-install.md`:

<!-- prettier-ignore -->
````markdown
# Установка «Markiro Автоном»: роли ПК, служба, сеть — памятка для ИТ

Памятка к установщику пилота (план УСТ, спецификация пилота §9.4 и §10,
родительская спецификация §9.1–9.2). Площадка пилота — два ПК в одной сети
Wi-Fi: хост работает на ПК станции, ПК администратора — офис.

## Что ставится

Один установщик `markiro-standalone-<версия>-windows-x86_64-setup.exe` для
Windows 10/11 x64. Его собирает задание CI `standalone-windows-build`.
Артефакт `standalone-installer-<коммит>` хранится 30 дней и содержит:

- установщик;
- `release-evidence.json`: версия, коммит, роли, SHA-256 и размер, состояние
  подписи Authenticode;
- `SHA256SUMS`.

Перед установкой сверьте хеш: `Get-FileHash <файл> -Algorithm SHA256` должен
совпасть со строкой в `SHA256SUMS`.

Роль ПК выбирается при установке:

| Роль           | Ключ            | Что на ПК                                                                                        |
| -------------- | --------------- | ------------------------------------------------------------------------------------------------ |
| Хост и станция | `/ROLE=host`    | Служба `MarkiroHost` с главной базой, правило брандмауэра, приложение в киоск-режиме, автозапуск |
| Только станция | `/ROLE=station` | Приложение в киоск-режиме, автозапуск; подключается к хосту на другом ПК                         |
| Только офис    | `/ROLE=office`  | Приложение без киоск-режима и без автозапуска; подключается к хосту как устройство офиса         |

Без ключа установщик задаёт два вопроса. Тихая установка (`/S`) без роли
отказывает. При переустановке роль берётся прежняя. Чтобы сменить роль,
удалите программу и установите заново: данные при удалении сохраняются.

## Памятка для ИТ

**Служба**

- Имя `MarkiroHost`, отображаемое имя «Markiro Хост».
- Файл: `C:\Program Files\Markiro Standalone\markiro-host.exe service`.
- Учётная запись `NT AUTHORITY\LocalService`: без пароля и без прав
  администратора.
- Запуск автоматический, вход в Windows не нужен.
- При сбое служба перезапускается через 5, 30 и 60 секунд, дальше каждые 60
  секунд. Счётчик сбоев сбрасывается через сутки. Сбоем считается и выход с
  кодом ошибки (`sc qfailureflag MarkiroHost` — `TRUE`).
- Ставит, перерегистрирует и снимает службу установщик. Вручную, из консоли
  администратора: `markiro-host install`, `markiro-host uninstall`,
  `markiro-host stop-service`.

**Сеть**

- Входящий TCP 45710, только на ПК с ролью «хост и станция».
- Правило брандмауэра `MarkiroHost`: частная и доменная сети; удалённые
  адреса — только локальная подсеть.
- Исходящих соединений в интернет нет. Исключение — установщик: если на ПК нет
  WebView2, он скачивает его у Microsoft.

**Каталоги**

- `%ProgramData%\Markiro\Host` — данные хоста:
  - `host.db` с `-wal` и `-shm`;
  - `host.json` — идентификатор хоста и порт;
  - `tls\cert.der` и `tls\key.der` — сертификат, по которому устройства узнают
    хост;
  - `logs\` — журналы за 14 дней;
  - `host.lock`.

  Доступ: SYSTEM и Администраторы — полный, LocalService — изменение,
  пользователи — никакого. Поэтому `markiro-host print-fingerprint
--data-dir "%ProgramData%\Markiro\Host"` запускается от администратора.

- `%LOCALAPPDATA%\app.markiro.standalone` у каждого пользователя Windows —
  данные приложения:
  - `device.json` — подключение; ключ под защитой DPAPI этого пользователя;
  - `standalone-station.db` — локальная база станции, в том числе ещё не
    отправленные на хост факты.

**Реестр**

- `HKLM\Software\Markiro\Standalone`, значение `Role`.
- `HKLM\Software\Microsoft\Windows\CurrentVersion\Run`, значение
  `MarkiroStandalone`: автозапуск приложения на станциях.

**Антивирус**

Добавьте исключения:

- каталоги `%ProgramData%\Markiro\Host` и
  `%LOCALAPPDATA%\app.markiro.standalone` (базы SQLite в режиме WAL);
- процессы `markiro-host.exe` и `markiro-standalone.exe`.

Установщик пилота не подписан Authenticode (вопрос П12). SmartScreen покажет
«Неизвестный издатель». Запуск: «Подробнее» → «Выполнить в любом случае».

## Сеть площадки (вопрос П9)

1. **Постоянный адрес ПК хоста.** Это обязательно. Лучше всего — резервирование
   DHCP на роутере по MAC-адресу адаптера. Иначе — статический адрес вне пула
   DHCP. Станция на самом ПК хоста ходит к хосту по `127.0.0.1` и от адреса не
   зависит. ПК офиса хранит адрес хоста.
2. **Ethernet к ПК станции**, если можно протянуть кабель. Обрыв Wi-Fi тогда не
   трогает и офис.
3. **Профиль сети «Частная».** Windows часто относит новую сеть Wi-Fi к
   общедоступным, а правило открывает порт только в частной и доменной сетях.
   - Установщик проверяет профиль и предлагает перевести сеть в частную.
   - Вручную: «Параметры» → «Сеть и Интернет» → свойства сети → «Частная».
   - Или из консоли администратора: `markiro-host network-check
--make-private`. Без ключа команда только печатает сети; код 3 значит, что
     осталась общедоступная.
   - Если ИТ клиента против частного профиля, правило для всех профилей с
     ограничением локальной подсетью добавляется вручную. Это решение
     владельца вместе с ИТ клиента.
4. **Проверка с ПК офиса:** `Test-NetConnection <адрес ПК хоста> -Port 45710`
   должен вернуть `TcpTestSucceeded : True`.
5. **Адрес хоста всё же сменился.** На ПК офиса на экране «Вход в офис»
   нажмите «Сменить адрес хоста» и введите новый адрес. Приложение примет его,
   только если по нему отвечает тот же хост: сертификат совпадает с
   сохранённым при подключении и хост принимает ключ устройства. Подключение,
   ключ и копии остаются.

## Порядок установки на два ПК

1. **ПК станции (хост).**
   1. Запустите установщик и на первый вопрос ответьте «Да» (или
      `/S /ROLE=host`).
   2. Установщик ставит и запускает службу, открывает порт и проверяет
      профиль сети.
   3. Откройте приложение («Запустить» на последней странице установщика или
      ярлык). Начнётся мастер первого запуска, либо импорт из облака по
      памятке `docs/runbooks/standalone-cloud-cutover.md` (план ИМП).
   4. Станция этого ПК подключается к хосту сама. Затем выберите линию.
2. **ПК администратора (офис).**
   1. Запустите установщик: «Нет», затем «Да» (или `/S /ROLE=office`).
   2. Приложение покажет «Служба хоста не отвечает». Нажмите «Подключиться к
      хосту в сети».
   3. На ПК станции администратор входит в офис («Офис» → вход) и открывает
      «Устройства» → «Новый код».
   4. На ПК офиса отсканируйте код или введите адрес и код. Сверьте отпечаток
      сертификата с экраном офиса.
   5. ПК офиса подключается как устройство офиса и открывает «Вход в офис».
      Киоск-режима на нём нет, «Выйти» возвращает на вход.
3. **Проверка.**
   1. Перезагрузите ПК станции, не входя в Windows. С ПК офиса проверьте, что
      `Test-NetConnection` проходит и вход в офис работает.
   2. Войдите в Windows на ПК станции: приложение открывается само.

## Обновление (вопрос П13: переустановкой)

1. Закройте приложение. На станции:
   1. администратор входит в офис;
   2. нажимает «Оконный режим»;
   3. закрывает окно.

   Иначе установщик сам предложит закрыть приложение.

2. Запустите новый установщик.
   - Тихо: `<установщик> /S` — роль прежняя.
   - С окнами: на вопрос «уже установлено» можно оставить «удалить перед
     установкой». Тогда установщик снова спросит роль — ответьте как в
     прошлый раз.
3. Служба останавливается до замены файлов и запускается заново. Данные хоста
   и приложения остаются.
4. Не ставьте более старую версию поверх новой: миграции базы идут только
   вперёд, и старая служба не откроет новую базу.

## Удаление

«Приложения» → «Markiro Standalone» → «Удалить» (или `uninstall.exe /S`).

- Служба и правило брандмауэра удаляются.
- Данные остаются: `%ProgramData%\Markiro\Host` и данные приложения. Флажок
  «удалить данные приложения» в окне удаления не действует.

Стереть данные можно только вручную, при выводе ПК из работы и после
резервной копии.

## Если что-то не так

- `sc query MarkiroHost` — состояние службы.
- `sc qc MarkiroHost` — файл и учётная запись.
- `sc qfailure MarkiroHost` — действия при сбое.
- Журналы: `%ProgramData%\Markiro\Host\logs\host.*.log`.
- Журнал установки: окно установщика, «Подробнее».
- Повторная регистрация службы: из консоли администратора
  `"C:\Program Files\Markiro Standalone\markiro-host.exe" install`.

## Подпись Authenticode (вопрос П12)

Сейчас установщик не подписан. Подписывать будет владелец, когда у него
появится сертификат подписи кода.

1. Установите сертификат подписи кода в хранилище Windows на машине сборки.
2. Соберите оверлей подписи:

   ```text
   node tools/standalone-release/sign-overlay.mjs --thumbprint <SHA-1 сертификата> --timestamp-url <RFC 3161 URL удостоверяющего центра> > sign.json
   ```

3. Соберите установщик с оверлеем:

   ```text
   pnpm --filter @markiro/standalone tauri build --config src-tauri/tauri.installer.conf.json --config <путь>/sign.json --bundles nsis
   ```

4. Проверьте подпись: `Get-AuthenticodeSignature` для установщика,
   `markiro-standalone.exe`, `markiro-host.exe` и `uninstall.exe`. Какие из
   этих файлов Tauri подписывает сам, не проверено.

В CI подписи нет: сертификат не должен попадать в задания пулл-реквестов.

## Ручная проверка на Windows

Задание `standalone-windows-build` проверяет на своём раннере (Windows Server):

- тихую установку трёх ролей и отказ без роли;
- службу: учётную запись, автозапуск, действия при сбое, перезапуск после
  убитого процесса;
- правило брандмауэра и права каталога данных;
- переустановку с тем же хостом и отказ при смене роли;
- удаление, после которого данные остаются.

Чего оно не проверяет и что нужно пройти руками на двух ПК с Windows 10/11
через Wi-Fi:

- [ ] Установка с окнами: оба вопроса о роли, русский текст без искажений,
      отказ при смене роли, предупреждение о профиле сети и перевод в частную.
- [ ] SmartScreen и антивирус клиента на неподписанном установщике.
- [ ] Служба стартует после перезагрузки без входа в Windows; ПК офиса
      подключается к хосту по коду через Wi-Fi; `Test-NetConnection -Port 45710`
      с ПК офиса проходит, а в общедоступной сети — нет.
- [ ] Права каталога данных, созданного до установки (ручной запуск
      `markiro-host run`): `icacls "%ProgramData%\Markiro\Host\host.db"` — без
      `Users`.
- [ ] Отключение питания ПК станции: служба поднимается сама; перезапуск после
      сбоя виден в журнале событий «Система».
- [ ] ПК офиса: окно не запирается ни на входе, ни после «Выйти», ни после
      перезапуска; ярлык не открывается сам при входе в Windows.
- [ ] ПК станции: окно запирается; приложение открывается само при входе в
      Windows.
- [ ] «Сменить адрес хоста»: смена резервирования DHCP на роутере, новый адрес
      на ПК офиса, вход в офис без нового подключения; адрес другого ПК
      отвергается словами про другой хост.
- [ ] Обновление поверх работающей станции в киоск-режиме: окно установщика
      видно, приложение закрывается, служба перезапускается, смена
      продолжается.
- [ ] Удаление с отмеченным флажком «удалить данные приложения»: данные в
      `%LOCALAPPDATA%\app.markiro.standalone` остаются.
````

- [ ] **Step 2: `AGENTS.md`**

Правка `apps/standalone/AGENTS.md`:

Фрагмент 1:

<!-- prettier-ignore -->
```markdown
finished and an administrator signs in.

Kiosk mode locks EVERY PC that runs the app, not only the floor's stations:
whenever no office session is open, the host's own PC and a PC used only for
the office are behind the borderless, topmost, unclosable window too, and a
technologist cannot leave it (only an administrator can). Stage 1 always pairs
the app as a station (`DeviceKind::Station` in `device.rs`; `DeviceKind::Office`
exists in `proto` and nothing uses it), so the app has no way to tell a floor
station from an office PC. This is the plan's decision («whenever no office
session is open»), not a choice the owner made, and it is an open owner
question to settle before the Windows trial at a customer, where someone will
install the app on the host's PC. Options: accept it; lock only a window that
is a floor station (for example only once the device has a line, or leave the
line-selection screen unlocked); a per-device kiosk switch the administrator
sets in «Устройства» (host, `proto` and `device.json` change); a local
«office PC» flag in `device.json` set by an administrator.

An office session opens with the window still locked; the way out is «Оконный
```

заменить на:

<!-- prettier-ignore -->
```markdown
finished and an administrator signs in.

Kiosk mode locks every PC except an office PC (plan УСТ; owner question П11,
answered as recommended until the owner says otherwise). An office PC is one
the installer gave the role «только офис» (`installation.json`, see
«Installer and service»), or one paired as a device of kind `office`: `App`
asks the shell for the role first (`install_role`) and enters kiosk mode only
once the answer came and says it is not an office PC; an answer the shell
cannot give counts as a station, so the floor stays locked. The host's own PC
is the site's station (pilot spec §3) and stays locked. A technologist on a
station cannot leave the locked window (only an administrator can).

An office session opens with the window still locked; the way out is «Оконный
```

Фрагмент 2:

<!-- prettier-ignore -->
```markdown
The buttons of these shell screens are of ordinary size, not 64 px, although
kiosk mode shows them on the station.

## Office pages
```

заменить на:

<!-- prettier-ignore -->
```markdown
The buttons of these shell screens are of ordinary size, not 64 px, although
kiosk mode shows them on the station.

## Installer and service

Plan УСТ ships the app with one NSIS installer for Windows 10/11 x64 and
three roles: `host` (the `MarkiroHost` service and the station), `station`
(a station that pairs with a host on another PC) and `office` (the office
only). The operator's guide is `docs/runbooks/standalone-install.md`.

`markiro-host install`, `uninstall`, `stop-service` and `network-check
[--make-private]` (`host/src/main.rs`) are the installer's tools; the first
three refuse outside Windows. `install::install` (`host/src/install.rs`)
hardens the data directory with `icacls` by SID — inheritance off, SYSTEM and
Administrators full control, LocalService modify — so no user reads the
database or `tls/key.der`; stops a service an earlier version left running;
creates or rewrites `MarkiroHost` («Markiro Хост», own process, automatic
start, `NT AUTHORITY\LocalService`, `"<exe>" service`, restarts after 5, 30
and 60 s with the count reset after a day, failure actions on a non-crash exit
too, which `service.rs`'s `ServiceSpecific(1)` needs); replaces the firewall
rule `MarkiroHost` (TCP, `host.json`'s port or 45710, private and domain
networks, `LocalSubnet`); starts it and waits up to 30 s. `uninstall` stops and
deletes the service and the rule and never touches the data directory. The
service manager is behind `install::Services` (`install_windows.rs` on
`windows-service`) and external programs behind `install::Commands`
(PowerShell takes its script as `-EncodedCommand`, so no quoting rule can
change it), so `host/tests/install.rs` and `host/tests/network_profile.rs`
pin the order of the steps, the exact command lines and the bounded waits with
fakes on any OS; `install_windows.rs` compiles only for Windows.
`network-check` lists `Get-NetConnectionProfile` (the category as text, UTF-8)
and exits 3 while a network is public; `--make-private` makes the public ones
private first.

The installer build is `tauri build --config src-tauri/tauri.installer.conf.json
--bundles nsis` after `markiro-host.exe` was copied to
`src-tauri/binaries/markiro-host-x86_64-pc-windows-msvc.exe` (ignored by git).
The overlay adds the sidecar (`bundle.externalBin`), the per-machine install
and the Russian installer. Never move `externalBin` into `tauri.conf.json` or
a `tauri.windows.conf.json`: `tauri-build` copies the sidecar at compile time
and reads `tauri.windows.conf.json` on every Windows build, so `cargo test`
would fail without the binary. The hooks (`src-tauri/windows/installer-hooks.nsh`,
UTF-8 with a byte order mark, or NSIS reads the Russian text in the build
machine's code page) take the role from `/ROLE=`, else from
`HKLM\Software\Markiro\Standalone\Role`, else from two questions; a silent
install without a role fails, and a role never changes on reinstall. Before
files are copied an existing host binary stops its service; afterwards the
host role runs `install` (a failure fails the installation) and
`network-check`, offering to make a public network private; the other roles
delete `markiro-host.exe`; every role but `office` opens the app at sign-in
(`HKLM\…\Run\MarkiroStandalone`). Uninstalling ignores Tauri's «delete app
data» checkbox (the station's local database may hold unsent facts); a real
uninstall (not Tauri's `/UPDATE`) runs `markiro-host uninstall` and removes the
role, the autostart and `installation.json`, and an update only stops the
service.

The app reads its role from `installation.json` beside its executable
(`src-tauri/src/installation.rs`; `Program Files` is writable by
administrators only, so nobody at the station can make it an office PC). A
missing or unreadable file is no role: the app works as a station. An office
PC pairs by code as a device of kind `office` (`DeviceState::claim`); its
home is the office sign-in, which has no «В цех», its header says «Выйти»
(`OfficeSessionValue.exitTo`), and nobody signs in on its floor. It still
syncs the reference copies like a station (see «Перенесено» of plan УСТ).

`device_change_address` (`DeviceState::change_address`) moves a pairing to
the host's new address: it keeps the pairing only when the address presents
the pinned certificate and the host still accepts the device key (`GET
/v1/device`), so the key never reaches another machine; another certificate
is `address_other_host`, a refused key is `key_rejected` (a rejected device),
and nothing changes but `hostAddress` and the connection task's link. The
office sign-in of a pairing with a remote host offers it («Сменить адрес
хоста», `src/app/HostAddressDialog.tsx`, the address typed as for pairing).

`standalone-windows-build` builds the release host and the installer, runs
`tools/standalone-release/smoke.ps1` on its runner (the three roles and a
silent install without one, the service's account, start mode, restart
policy and a restart after a killed process, the firewall rule, the data
directory's access list, a reinstall that keeps the host's identity and
certificate, a refused role change, uninstalls that keep the data), then
`tools/standalone-release/prepare.mjs` writes the installer under its
release name with `release-evidence.json` (version, commit, roles, hash and
size, `Get-AuthenticodeSignature`'s status) and `SHA256SUMS`, uploaded as
`standalone-installer-<sha>` for 30 days. `pnpm test:standalone-release:contract`
pins the overlay, the hooks, the job's step order and the smoke test's checks.
The installer is not signed (owner question П12); `sign-overlay.mjs` builds
the Tauri overlay for a certificate in the build machine's store, and no
signing material ever reaches CI.

## Office pages
```

Фрагмент 3:

<!-- prettier-ignore -->
```markdown
- The Windows service and DPAPI run only in the `standalone-windows-build`
  job: it compiles the service and the Tauri app for Windows, and its cargo
  tests round-trip a key through DPAPI. A real Windows user profile, the
  service at runtime and kiosk mode still need a manual check on Windows; a
  run on macOS proves none of it.
- The owner step of plan 1f2 (Task 1) is not done: the two `windows-sys`
  features below are not in `src-tauri/Cargo.toml`, and the shell has never been
```

заменить на:

<!-- prettier-ignore -->
```markdown
- The Windows service and DPAPI run only in the `standalone-windows-build`
  job: it compiles the service and the Tauri app for Windows, and its cargo
  tests round-trip a key through DPAPI. Since plan УСТ it also builds the
  installer and runs its smoke test on the runner (see «Installer and
  service»). A real Windows user profile, two PCs over Wi-Fi, kiosk mode and
  the installer's windows still need a manual check on Windows
  (`docs/runbooks/standalone-install.md`, «Ручная проверка на Windows»); a run
  on macOS proves none of it.
- The owner step of plan 1f2 (Task 1) is not done: the two `windows-sys`
  features below are not in `src-tauri/Cargo.toml`, and the shell has never been
```

Если к этому времени ИМП добавил в `AGENTS.md` свой раздел перед «Office pages», «Installer and service» встаёт перед «Office pages» после него.

- [ ] **Step 3: Проверка и коммит**

```bash
node_modules/.bin/prettier --check docs/runbooks/standalone-install.md apps/standalone/AGENTS.md
git diff --check
git add docs/runbooks/standalone-install.md apps/standalone/AGENTS.md
git commit -m "docs(standalone): the installer, the service and the site's network for IT; the office PC is never kiosk-locked" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: prettier — `All matched files use Prettier code style!`.

---

## Итоговая проверка плана

Исполнитель, после задачи 7, из корня репозитория:

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml --workspace
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run test
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run build
pnpm --config.verifyDepsBeforeRun=false run test:standalone-release:contract
node --test tools/ci/test/*.test.mjs
node_modules/.bin/prettier --check $(git diff --name-only 7cf28790e -- '*.ts' '*.tsx' '*.mjs' '*.json' '*.md' '*.yml')
git diff --check 7cf28790e
grep -rnF '\u04' apps/standalone/src apps/standalone/test
git status --short
```

Expected (на `7cf28790e` с кодом плана; соседние планы добавляют свои тесты): `cargo test` вне песочницы — 49 наборов, 554 теста, 0 падений; Vitest — 67 файлов, 1758; контракт — 17; `tools/ci` вне песочницы — 47; prettier и `git diff --check` молчат; `\u04` — одно совпадение (`src/host/pairing-code.ts:66`); `git status --short` пуст. Плюс крейт-пробник задачи 2 (шаг 5) и сборка с оверлеем задачи 5 (шаг 4).

Проверки владельца, которых исполнитель сделать не может:

1. **CI на Windows.** Push и PR исполнителю не разрешены. При первом пулл-реквесте владелец смотрит задание `standalone-windows-build`: `cargo test` под Windows (впервые компилирует `install_windows.rs` в составе хоста, `main.rs` и `service.rs` под `cfg(windows)`), сборку установщика (компилирует хуки NSIS) и `smoke.ps1`. Задание компилирует `lockdown.rs` только с признаками `windows-sys` из шага владельца 1f2, который сделан в 2a4 (коммит `f459691dd` на `claude/2a4-shell`); на `7cf28790e` без них оно падало и до этого плана (см. «Verification» в `AGENTS.md`).
2. **Артефакт.** Скачать `standalone-installer-<sha>`, сверить `SHA256SUMS`, прочесть `release-evidence.json` (`authenticode: "NotSigned"`).
3. **Два ПК с Windows 10/11 через Wi-Fi** — список «Ручная проверка на Windows» в `docs/runbooks/standalone-install.md`.

## Перенесено

- **Копии справочников на ПК офиса.** ПК офиса синхронизирует справочники, как станция (`useHostLink`), и держит в своей локальной базе хеши PIN и бейджей операторов, которые ему не нужны. Исправление — не запускать синхронизацию для устройства вида `office` (вебвью) или отказывать ему в `/v1/changes` (хост); второе меняет предупреждение о синхронизации в шапке офиса.
- **Первый экран ПК офиса до подключения** — «Служба хоста не отвечает» про этот компьютер; ПК офиса мог бы сразу открывать подключение в сети.
- **Поиск хоста в сети (mDNS)**, родительская спецификация §6.10.
- **Правило брандмауэра с привязкой к программе** (`-Program …\markiro-host.exe`) и правило «для всех профилей с локальной подсетью» по решению ИТ клиента (П9).
- **Виртуальная учётная запись службы** (`NT SERVICE\MarkiroHost` или SID службы через `set_config_service_sid_info`): изоляция от других служб под LocalService.
- **Подпись в защищённом процессе выпуска** (окружение GitHub с ревьюерами, отдельный workflow по образцу подписанта), когда у владельца будет сертификат; проверка того, какие файлы подписывает Tauri (приложение, sidecar, деинсталлятор, установщик).
- **Публикация установщика и обновление из файла** (П13 — после пилота), резервная копия перед обновлением (план РК).
- **Смена роли без удаления** и вопрос о роли при выборе «удалить перед установкой» на странице Tauri «уже установлено» (сейчас роль спрашивается заново).
- **Колбэк single-instance** (итоговое ревью 1f2, M5): спрятанное окно киоск-режима не находится повторным запуском; важно и для «Запустить» на последней странице установщика поверх работающей станции.
- **`markiro-host reset-password`** (спецификация этапа 1, §10) — план 5.

## Отклонения при исполнении

Записано по итогам исполнения 2026-10-11. Задачи 1–7 исполнены в ветке `claude/infra-rk` после РК и ИМП-1 (основа `cf08ddf07`, семь коммитов: `297a00bf8`, `4f3fe0845`, `ec005105a`, `ccfd04bba`, `c9a8603d6`, `1972a0ebd`, `310bfed51`). Ревью задач не было; итоговое ревью части общее с РК и ИМП-1 (HEAD `310bfed51`: Critical 2, Important 2, Minor 9 — из них к УСТ относятся I2, M3, M4, M8 и общие тесты). Ничего из исполненного не запускалось на Windows. Фрагменты, не найденные из-за параллельных потоков (2a5, РК, ИМП), применены по смыслу рядом с тем же местом; расхождения названы по задачам ниже.

- **Задача 1** (`297a00bf8`). Бриф применён дословно, затем расширен тестами и защитой.
  - Откат неудавшейся **чистой** установки (`undo_fresh_install`: остановить, удалить службу, снять правило брандмауэра; собственные сбои отката ошибку установки не заменяют). После удавшегося `start` неудавшееся ожидание (`Timeout`, `StoppedAfterStart`) службу не откатывает: медленная миграция не должна её терять, а хост, отказавшийся стартовать из-за недоделанного восстановления, остаётся с политикой перезапуска. Неудавшееся **обновление** существующую службу не удаляет.
  - Текст `StoppedAfterStart` указывает на недоделанное восстановление (`markiro-host restore` ещё раз): маркер `host.restore-intent` заставляет `start` отказывать.
  - Тесты сверх брифа: неделимые аргументы с кириллицей и пробелами (без `"`), повторная установка поверх остановленной службы, случаи отката; `FakeServices` получил список `refuses`. `install` — 20 тестов (в плане 11), библиотека хоста — 89 (в плане 57), cargo workspace 980.
  - Якорь `lib.rs` (`pub mod error; pub mod feed; …`) сдвинут появившимся `pub mod facts;` — `pub mod install;` вставлен между `feed` и `logging`.
- **Задача 2** (`4f3fe0845`). Адаптер говорит со службами через API `windows-service` (числовые коды `winerror.h`), а не через `sc.exe`; `icacls` и PowerShell идут через `SystemCommands` задачи 1.
  - Сверх брифа:
    - программы запускаются по абсолютному пути из проверенного `%SystemRoot%` (`system_program`, `trusted_system_root`: буква диска, `:`, `\`, без `..`, кавычек, `< > | ? * ; /`, управляющих символов, UNC; иначе `C:\Windows`), а не через `PATH`;
    - остановка службы в `StartPending`: Windows всегда отказывает (1061, служба принимает `controls_accepted = empty()` при запуске); адаптер считает 1062 и 1061 безвредными, `install::stop` повторяет запрос на каждом опросе, пока состояние не `StopPending`, всё в пределах 30 с;
    - числовые предикаты и подсказки (`stop_refusal_is_harmless`, `start_refusal_is_harmless` 1056, `delete_refusal_is_harmless` 1072, `service_error_text`: код 5 — запустить из сеанса администратора) вынесены в `install.rs`, чтобы проверяться на любой ОС;
    - `install_host` создаёт каталог данных (`HostPaths::ensure`) до `icacls` и берёт порт из `host.json` (иначе 45710) — дополнение к задаче 2 из `ust-minors`;
    - **код выхода 4** у `install` — «служба зарегистрирована, но не осталась запущенной» (`StoppedAfterStart`), в брифе были только 0 и 1; нужен хуку NSIS (задача 5), хук с проверкой `!= 0` по-прежнему закрыт при сбое; у `network-check` — 0 / 3 (`PUBLIC_REMAINS`) / 1, ошибка использования — 2;
    - вложенная ветка `NetworkCheck` с `return match …` вынесена в `network_check_code`; Windows-ная `install_service` перенесена в `install::install_host`; в шапке `main.rs` перечислены коды.
  - Тест через настоящий бинарник (`host/tests/installer_cli.rs`, 7 тестов; поддельный `powershell.exe` на `PATH` — только Unix). `install` — 27 тестов, `network_profile` 8 (в плане 5), `--bin markiro-host` 8 (в плане 5), workspace 1005.
  - Якоря `lib.rs` и `main.rs` (`use`, `Command`, `USAGE`, диспетчер) применены по смыслу.
- **Задача 3** (`ec005105a`). Оболочка.
  - Сверх брифа:
    - адрес хоста проверяется `host_origin` до любого ввода-вывода (нет пробелов и управляющих, `https`, без имени и пароля, путь ровно `/`, без запроса и фрагмента; сохраняется `url.origin().ascii_serialization()`): иначе `https://user:pw@host`, путь или запрос прошли бы к хосту с ключом и в `device.json`; ограничения «только локальная сеть» нет, ограждение — закреплённый сертификат;
    - `host_local_pair` **отказан на ПК с ролью `office`** (иначе такой ПК получил бы ключ станции через сопряжение по loopback); роли исключают друг друга и меняются только удалением;
    - `manage_state` принимает роль третьим параметром (иначе мутант «состояние игнорирует роль» нечем убить): фрагмента `DeviceState::load(dir.clone())` в `run` в дереве нет;
    - роль читается оболочкой из `installation.json` рядом с исполняемым файлом; нечитаемый, неизвестный или с лишним ключом файл = нет роли = станция (киоск-режим остаётся включённым).
  - Тестов: библиотека оболочки 140 (было 134), `host_address` 7 (в плане 5), `ipc` 27 (было 26). Workspace 1019. Мутант S3 (аргумент `installation::read_beside_executable()` в замыкании настройки `run`) не убивается ни одним тестом — только настоящий запуск приложения.
  - Адаптации: в `device.rs` `remember` уже принимал `name`, `kind` добавлен после `body`; фрагмент 11 вставлен перед `device_status_serializes_…`; команды вставлены перед докстрингом `device_refresh`.
- **Задача 4** (`ccfd04bba`). Вебвью.
  - Сверх брифа:
    - `officePc = role === "office" || (role !== "host" && role !== "station" && kind === "office")`: хост или станция с чужим офисным сопряжением на диске (данные переживают удаление) остаются в киоск-режиме;
    - ПК офиса никогда не показывает цех и выбор линии, какое бы сопряжение ни лежало на диске (`App` подменяет `floor`/`floor_operator`/`line_select` входом в офис);
    - `invalid_request` от `device_change_address` показывается обычным текстом `office.login.address.invalid`;
    - сообщение «Адрес хоста изменён» — в постоянной вежливой области (`aria-live="polite"`, `role="presentation"`), фокус возвращается на «Сменить адрес хоста».
  - Прежние тесты изменены намеренно: `shell.test.ts` — «станция без линии выбирает её…» (устройство вида `office` без линии теперь `office_login`), «входит в ТСД и офис» заменён на «ТСД без линии, офис — никто», таблица сохранения оператора получила обязательные строки `address_changed`; `app.test.tsx` — `fakeDevice` получил `installRole` и `changeAddress`.
  - Тестов: device 39, shell 156, app 139 (334 в трёх файлах, было 309; в плане 32/112/98 на старом дереве), пакет — 107 файлов, 3141 тест (в плане 67 файлов, 1758).
- **Задача 5** (`c9a8603d6`). Установщик.
  - Сверх брифа: NSIS `==`/`!=` не различают регистр, поэтому `/ROLE=HOST` прошёл бы проверки брифа и записал `{"role":"HOST"}`, а оболочка принимает только строчные имена — ПК молча стал бы запертой станцией; хук переводит роль в точный литерал `"host"`/`"station"`/`"office"` (иначе падает, что ловит и испорченное значение реестра), файл — ровно `{"role":"…"}` и CRLF. Код 4 — предупреждение с советом о восстановлении; обновление останавливает службу.
  - Якорь: тест `installer.test.mjs` «only the host role registers the service…» намеренно изменён под ветку предупреждения кода 4 (регулярное выражение после `install`: `${If} $0 == "4"[\s\S]*?${ElseIf} $0 != "0"`).
  - Контрактных тестов 38 (в плане 15): `installer` 18, `prepare` 13, `sign-overlay` 7; `tools/ci` 47. Мутантов 74, все убиты. `makensis` и `pwsh` на машине не стояли: хуки ни разу не компилировались, проверены только текстом и балансом блоков `If/EndIf`/макросов.
- **Задача 6** (`1972a0ebd`). CI и дымовая проверка.
  - `smoke.ps1` сверх брифа:
    - код 4 хоста: остановить службу, положить `host.restore-intent`, переустановить с `/S` — установщик возвращает 0, служба остаётся зарегистрированной и не запущенной; маркер снимается в `finally`;
    - удаление при работающем хосте отдельным шагом (служба стоит и отвечает до, нет службы, процесса и порта после, `markiro-host.exe` и правило брандмауэра удалены, четыре файла данных и текст `host.json` сохранены, значение Run, роль в реестре и `installation.json` удалены);
    - точный файл роли `{"role":"<роль>"}` без BOM, роль в реестре, `/ROLE=HOST` принимается и записывается строчными, после отказанной установки без роли файла нет;
    - состояние службы числом (`[int](Get-Service …).Status`), одно правило брандмауэра после переустановок, `$PSNativeCommandUseErrorActionPreference = $false`.
  - Артефакт выкладывается и для пулл-реквестов из форков (без подписи и секретов). Тестов процесса: `workflow.test.mjs` 10 (бриф 2), контрактных всего 48 (в плане 17).
  - `affected.mjs` и его тест уже содержали выбор `tools/standalone-release/` (задача 5): правок не потребовалось.
- **Задача 7** (`310bfed51`). Документы.
  - Раздел спецификации — **§20 «Уточнения плана УСТ»** (следующий свободный на ветке потока); после слияния — §23. Памятка и AGENTS ссылаются на раздел по названию. Памятка для ИТ (491 строка) написана по коду; исправления брифа: кнопка «Подключить устройство» (`office.devices.add`), а не «Устройства → Новый код»; `docs/runbooks/standalone-cloud-cutover.md` не существует, ИМП приостановлен (хост стартует с пустой базы, обещать перенос данных нельзя); «журналы за 14 дней» — 14 последних суточных файлов `logs\host.<дата>.log`; список каталога данных дополнен `backups\`, `host.lock`, `host.restore-intent`; диалог адреса принимает `192.168.1.20[:45710]` или имя, а не `https://…`; утверждения «установщик просит закрыть приложение» и «уже установлено — роль спрашивается снова» помечены «не проверялось» (шаблон Tauri NSIS недоступен); найдено чтением `install_windows.rs`: обновление сбрасывало учётную запись службы (см. волну), а `Timeout` запуска был кодом 1 и отказом установки (см. волну).
  - В `AGENTS.md` фрагменты 1–3 совпали по одному разу; в первый добавлено, что роль сильнее сопряжения на диске, а абзац о киоск-режиме («`App` входит в киоск-режим всегда…») дополнен «(на любом ПК, кроме ПК офиса, ниже)».
  - Полная проверка потока на `310bfed51`: cargo workspace — 67 строк, 1019 пройдено, 0 отказов (в плане 49 наборов, 554 теста); Vitest — 107 файлов, 3141 тест (в плане 67 / 1758); `test:standalone-release:contract` 48 (в плане 17), `tools/ci` 47, `test:standalone-export` 37.
- **Итоговое ревью и волна исправлений** (ветка `claude/infra-rk`, `a88c6483c…bab6f7e5b`):
  - **I2.** Установка поверх переписывала учётную запись службы: `configure` вызывал `change_config` с `LocalService` при каждой установке, и после каждого обновления ломалась запись второй копии по сети (РК, раздел 2 памятки). Теперь `ServiceSpec.account: Option<&'static str>`: для существующей службы `None` (в `ChangeServiceConfigW` уходит NULL — учётная запись не меняется; проверено по исходникам `windows-service` 0.8.1), для новой — `Some(LocalService)`. Ручной шаг «задать учётную запись заново после обновления» из памятки и AGENTS убран.
  - **M3.** Не успевшая за 30 с запуститься служба (`Timeout { waiting_for: Running }`) — код 4, а не отказ установки (`Timeout { Stopped }` остаётся 1); текст NSIS (`DetailPrint` и `MessageBox`) — «не осталась запущенной или ещё запускается», совет `sc query` (мутант на тексте выжил и убит `bab6f7e5b`).
  - **M4.** Владелец каталога данных — Администраторы: перед выдачей прав `install` выполняет `icacls <Markiro> /setowner *S-1-5-32-544` (только если родитель называется `Markiro`, корень диска и `ProgramData` не трогаются) и `icacls <каталог данных> /setowner *S-1-5-32-544 /T /C`; `smoke.ps1` проверяет владельца обоих. Остаток: если пользователь заранее создал `%ProgramData%\Markiro`, у этой папки остаётся унаследованное CREATOR OWNER (в памятке сказано).
  - **M8.** Данные выпуска называют голову пулл-реквеста: шаг подготовки с `env: PR_HEAD_SHA` и `--source-sha "$env:PR_HEAD_SHA"`.
  - **M5.** Шаг `pnpm test:standalone-export` добавлен в `standalone-windows-build` после сборки домена (пункт ИМП-3, добавлен по поручению волны).
  - Памятка и AGENTS обновлены (коммит `f17381613`): учётная запись сохраняется, владелец, код 4 покрывает и «ещё запускается», список CI.
  - Счёт после волны (`bab6f7e5b`): cargo workspace 67 строк, 1029 пройдено (было 1019); `install` 28, `installer_cli` 7, `bin` 8, `lib` 90; `test:standalone-release:contract` 51; Vitest 107 файлов, 3142 теста.
- **Перенесено после ревью** (не вошло в волну): экран сопряжения ПК офиса с учётом роли (ПК офиса при хосте на 127.0.0.1 всё ещё пытается автосопряжение, оболочка отказывает, экран ошибки предлагает только «Повторить»); справочники на ПК офиса (хеши PIN в его базе); поиск хоста (mDNS); привязка правила брандмауэра к программе; подпись в защищённом выпуске; смена роли без удаления; сбой `uninstall`/`stop-service` в хуке удаления только пишется в журнал (дымовая проверка покрывает удаление при работающем хосте).
- **Не проверено.** Ничего не запускалось на Windows: служба и менеджер служб, `icacls` и распространение прав, правило брандмауэра, `Get/Set-NetConnectionProfile` (в русской локали), `CREATE_NO_WINDOW`, абсолютные пути программ, код 4 на настоящем SCM; хуки NSIS ни разу не компилировались (`makensis` нет), `smoke.ps1` не исполнялся (нет PowerShell 7 на macOS), задание `standalone-windows-build` ни разу не запускалось; чтение `installation.json` из `Program Files` (в том числе файл с BOM) и `current_exe()`; строка чтения роли в `run` (S3) тестом не покрыта; факты шаблона Tauri NSIS (`$UpdateMode`, `GetOptions`, положение хуков, оставляет ли `Abort` в POSTINSTALL запись удаления). `cfg(windows)`-код (`install.rs`, `install_windows.rs`, `network_profile.rs`, `main.rs`) скомпилирован пробным крейтом вне репозитория под `x86_64-pc-windows-msvc` без ошибок и предупреждений (в том числе `clippy`), но не исполнялся.
