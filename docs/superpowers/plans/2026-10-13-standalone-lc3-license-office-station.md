# План ЛЦ-3: лицензия в офисе и на станции — раздел «Лицензия» на странице «Информация» (состояние, сроки, рабочие места, возможности, ИНН и привязка), загрузка файла с предпросмотром «было → станет», запрос на активацию в папку `Документы\Markiro\Лицензия`, аварийное продление на 72 часа, блок «Лицензия» в сведениях для поддержки, полоса лицензии над страницами офиса и предупреждения «Обзора», строка состояния станции, объяснение и отказы открытия смены, отказы сопряжения по рабочим местам — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Показать лицензию площадки, которую с плана ЛЦ-2 считает хост, там, где её видят люди: администратор и технолог в офисе на странице «Информация» видят состояние, сроки, рабочие места «использовано / доступно», возможности, ИНН и привязку к хосту; администратор загружает файл `.mklic` после проверки и таблицы «было → станет», сохраняет запрос на активацию в `Документы\Markiro\Лицензия` и один раз включает аварийное продление; полоса над страницами офиса и «Обзор» предупреждают о пробном периоде (за 4 дня — другим тоном), конце срока, льготном сроке, ограничении, чужом хосте, расхождении ИНН и часах; сведения для поддержки получают блок «Лицензия» без секретов; станция молчит, пока всё работает, в льготный срок и в ограничении пишет строку состояния, на «Новой смене» и на карточке запланированной смены объясняет, почему открыть нельзя, и понятно показывает отказы хоста `license_restricted`, `feature_disabled` и `seat_limit` (в том числе на экранах сопряжения).

**Architecture:**

- Задача 1 — оболочка: корень `Лицензия` в `office_files::ROOTS` и расширение `json` в `FILE_EXTENSIONS`, чтобы офис сохранил запрос на активацию без диалога файлов (П16); открыть оттуда по-прежнему ничего нельзя (`existing_form` — только `Формы`).
- Задача 2 — чистая модель вида: `src/lib/license-dates.ts` (дни «включительно» в поясе организации, `lastMomentBefore`), `src/office/info/license/license-view.ts` (слово и тон состояния, сроки, строки мест и возможностей, предупреждения полосы и их тексты), ключ кэша `officeKeys.license`, тестовые лицензии `test/support/license.ts`, ответ поддельного `getLicense` по умолчанию «действует, предупреждать не о чем».
- Задача 3 — раздел «Лицензия» вместо заглушки ветки `claude/fb-about`: состояние (`Alert` со словом), сроки, таблица «Рабочие места», «Возможности», «Организация и привязка» с «Скопировать»; технолог видит всё, кроме действий (`useCan("manageLicense")`, новая возможность в `access.ts`).
- Задача 4 — загрузка: `license-load.ts` (чтение файла ≤ 16 КиБ, слова отказов раздела 9.7, строки «было → станет», превышения мест, итог загрузки), `LicenseLoad.tsx` (`FileDropZone` → `previewLicense` → таблица → «Загрузить» = `loadLicense` или «Отмена»; фокус на сообщении после ошибки).
- Задача 5 — «Сохранить запрос на активацию» (`getActivationRequest` → `files.save(["Лицензия", "Запрос на активацию <время>"], …)`) и «Открыть новые смены ещё 3 дня» (`FormDialog` → `enableLicenseEmergency`, отказ `emergency_used`).
- Задача 6 — сведения для поддержки: строка-заглушка `office.about.report.license` уходит из `support-report.ts`, вкладчик `licenseSupportBlock` встаёт в `SUPPORT_CONTRIBUTORS`; `SupportContext` получает `read` — чтение хоста через `session.call`.
- Задача 7 — полоса над страницами офиса (точка Т3, её нет в `fb-about` — вводится здесь, в `OfficeShell`), предупреждения «Обзора» (точка Т4) в общей вежливой области с копиями, закрытие «на сеанс», ссылка на `#license` с фокусом на разделе, перечитывание лицензии при каждой ревизии хоста (`Office.tsx`).
- Задача 8 — станция узнаёт лицензию: `HostApi.getDevice` (`GET /v1/device`, поле `license` плана ЛЦ-2), хук `useStationLicense` (последнее известное состояние в памяти, чтение при каждой ревизии и при выходе на связь), строка в `FloorStatusBar` для `grace`, `restricted`, `trial_expired`, `inn_mismatch`.
- Задача 9 — смены станции: `cardAction` даёт `blocked` для запланированной смены, `ShiftCard` пишет объяснение вместо кнопки, `ShiftList` прячет «Новая смена» за объяснением, `NewShift` — кнопку «Создать смену»; отказы хоста `license_restricted` (по `details.state`) и `feature_disabled` (паллеты) получают свои слова.
- Задача 10 — отказы сопряжения и офисных записей: `DeviceError::SeatLimit` / `FeatureDisabled` в оболочке (локальное сопряжение и `claim`), коды и тексты в вебвью; `alertFailure` пишет «Достигнут предел лицензии: N из M» и слова выключенной возможности для пользователей, линий, шаблонов и планирования смен.
- Задача 11 — документы: раздел `apps/standalone/AGENTS.md`, §21 спецификации, итоговые проверки.

**Tech Stack:** TypeScript 6 strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), zod 4, React 19.2, react-router 8, @tanstack/react-query 5, i18next 26, `@markiro/ui`, Vitest 4 с jsdom; Rust (Tauri 2, оболочка `markiro-standalone`).

**Спецификации и источники:**

- `docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md` — §3.2 (состояния, порог предупреждения), §3.3 (что закрывается), §3.4 (пробный период 14 дней, предупреждение за 4 дня), §3.5 (аварийное продление), §4.7 (места и возможности, отказы `seat_limit` и `feature_disabled`), §4.8–4.9 (предпросмотр, ИНН), §6.3 (запрос активации), §8.2 (маршруты и формы), §9.1, §9.2, §9.4–9.7, §12.1 («Webview»), §13 строка 4. Этот план дописывает §21.
- Бриф планов лицензии и обновлений (`/tmp/claude/fb/license-plans-brief.md`, «ЛЦ-2 produces»): имена `officeLicenseSchema`, `licensePreviewSchema`, `deviceLicenseSchema`, методы `HostApi` `getLicense`, `previewLicense`, `loadLicense`, `getActivationRequest`, `enableLicenseEmergency`, причины отказа файла, ограничения `license_restricted`, `seat_limit`, `feature_disabled`.
- Каркас страницы «Информация» — ветка `claude/fb-about` (`32d6aa5fa`): `apps/standalone/src/office/info/sections.tsx` (`ABOUT_SECTIONS`, `AboutSection`), `LicenseSection.tsx` (заглушка `office.about.license.notConnected`), `support-blocks.ts` (`SUPPORT_CONTRIBUTORS`, `SupportContributor`, `SupportContext`, `collectSupportBlocks`), `support-report.ts` (строка `[t("office.about.report.license"), t("office.about.license.notConnected")]`), `SupportSection.tsx`, `AboutPage.tsx`, `clipboard.ts`; тесты `test/about-page.test.tsx`, `test/support-report.test.ts`.
- Образцы кода: `src/office/org/OrgLogoCard.tsx` (`FileDropZone`, последний выбранный файл побеждает, повторное нажатие ничего не шлёт), `src/office/OfficeOverview.tsx` (`OverviewBackups`, вежливая область), `src/office/backups/backup-time.ts` (`useBackupTime`: пояс организации, чтение профиля только когда есть что писать), `src/office/backups/BackupWarnings.tsx` (скрытое слово тона), `src/floor/FloorStatusBar.tsx` (область `floor-status__alerts`), `src/floor/shifts/shift-entry.ts` (`CONFLICTS`), `src/floor/shifts/new-shift.ts` (`createStationShift`), `src-tauri/src/device.rs` (`claim_refusal`), `src-tauri/src/office_files.rs` (`ROOTS`, `FILE_EXTENSIONS`).

## Допущения

Решения этого плана (контроллер решает вопросы по рекомендации; ответ владельца «иначе» меняет названные задачи):

- **Д1 — ключи i18n `office.about.license.*`, а не `office.info.license.*`.** Спецификация (§9.7) писалась до каркаса и называет префикс `office.info`; настоящий каркас `claude/fb-about` положил страницу под `office.about.*` (`office.about.license.title`). План продолжает настоящий префикс; полоса — `office.banner.license.*`, станция — `floor.license.*`, как в спецификации. В приложении только `src/i18n/ru.json` (`en.json` нет — проверено).
- **Д2 — форма ответов ЛЦ-2 — по его плану** (`docs/superpowers/plans/2026-10-13-standalone-lc2-host-license.md`, задача 1, правка `src/host/protocol.ts`; его Д4 расширил §8.2):
  - `officeLicenseSchema`: `state: string` (слово; известные — `LICENSE_STATES`, новое слово хоста страницу не ломает), `since` (начало состояния, ISO), `flags: { clockBehindDays: number | null; clockAhead: boolean }`, `effectiveAt`, `phaseEndsAt: string | null` (конец фазы, исключительно), `daysLeft: number | null`, `warnDays`, `opensNewShifts` (с учётом аварийного продления), `license: { licenseId, sequence, kid, customer: { name, inn }, plan: string, planVersionId, issuedAt, validFrom, validUntil, graceDays } | null`, `trial: { startedAt, endsAt, inn: string | null } | null` (есть и при файле), `binding: { hostId, fingerprint, orgInn: string | null, innMatches: boolean | null }`, `quotas: { lines | stations | kiosks | cabinetUsers: { limit: number | null; used; over } }`, `features` (7 ключей), `emergency: { available; until: string | null }`, `warnings?: string[]` (ответ `PUT`).
  - `licensePreviewSchema`: `{ before: LicenseTerms; after: LicenseTerms; changes: string[]; warnings: string[] }`, `LicenseTerms` = `{ licenseId: string | null, sequence: number | null, plan, validFrom: string | null, validUntil: string | null, graceDays, quotas (как у `OfficeLicense`: у «станет» `used`и`over` посчитаны хостом), features }`; у пробного периода `before.plan = "trial"`; `changes` — имена `plan`, `validFrom`, `validUntil`, `graceDays`, `quotas.<ключ>`, `features.<ключ>`; `warnings` — из `LICENSE_WARNINGS` (`expired`, `not_yet_valid`, `over_limit`).
  - `deviceLicenseSchema`: `{ state: string; since; phaseEndsAt: string | null; emergencyUntil: string | null }`; `deviceInfoSchema.license` необязательное; фикстура `device-license.json` — ответ `GET /v1/device` целиком.
  - `HostApi.previewLicense(token, request)` и `loadLicense(token, request)` берут тело `licenseLoad(file)` (`src/host/requests.ts`); `getActivationRequest` отвечает `StandaloneActivationRequest` (`@markiro/domain`); константы `MAX_LICENSE_FILE_BYTES`, `LICENSE_REFUSALS`, `LICENSE_STATES`, `LICENSE_FEATURE_KEYS` — из `protocol.ts`, этот план их не дублирует.
  - Отказ файла: `validation_failed`, `details.field = "file"`, `details.reason` из `LICENSE_REFUSALS`, при `license_wrong_host` — `details.fileHostId`; других подробностей ЛЦ-2 не шлёт. Поэтому «№ N» у `license_older` берётся из действующего файла (`GET`), а `license_inn_mismatch` без ИНН файла говорится короче (`license_inn_mismatch_short`); пришлёт хост `details.fileInn` — текст возьмёт его.
  - Отказ аварийного продления — `conflict` на `emergency_used` или `emergency_not_needed`.
    Если исполненный ЛЦ-2 разошёлся со своим планом, задача 2 правит модули, читающие форму (`license-view.ts`, `license-load.ts`, `license-support.ts`, `src/floor/license.ts`, `test/support/license.ts`), и пишет расхождение в «Отклонения» и §21.
- **Д3 — `HostApi.getDevice` добавляет этот план** (в контракте брифа его нет). Строку `license` из `GET /v1/device` станция читает сама: оболочка уже пускает вебвью к `/v1/device` (`webview_may_reach` в `src-tauri/src/device.rs`), а `DeviceStatus` оболочки строгий и в `device.json` лицензии не место. Цена — ещё один короткий `GET /v1/device` на каждую ревизию хоста (тот же, что уже шлёт `device_refresh`). Если ЛЦ-2 уже добавил метод чтения `GET /v1/device` в `HostApi`, задача 8 берёт его вместо нового.
- **Д4 — последнее известное состояние станции живёт в памяти.** «Без связи с хостом станция показывает последнее известное состояние» (§9.6) выполняется в пределах запуска; после перезапуска без хоста станция молчит до первого ответа — открытие смены и так требует хоста. Хранить лицензию в локальной базе станции план не стал (новая миграция оболочки вне распределения).
- **Д5 — даты станции — в поясе этого ПК.** Строка состояния пишет «до DD.MM» в поясе ПК станции (пояс организации в её копиях есть только у мастера новой смены; на заводе ПК стоит в поясе площадки). Офис пишет даты в поясе организации (`useBackupTime`), как «Резервные копии».
- **Д6 — экраны сопряжения пишут отказ по местам без чисел.** Оболочка отдаёт вебвью только код (`DeviceError::code`), а до сопряжения у станции нет права прочитать лицензию; текст §9.7 «(N из M)» на экране сопряжения сокращён до «Все рабочие места лицензии заняты…». Числа видны в офисе (раздел «Лицензия», «Рабочие места»). Код подключения при `seat_limit` и `feature_disabled` не сгорает (ЛЦ-2, Д9: место и `handheld` проверяются до траты кода), поэтому экран сетевого сопряжения такой отказ не запоминает — как `rate_limited`.
- **Д7 — аварийное продление.** Кнопка видна администратору, когда хост говорит `emergency.available` (ЛЦ-2: только когда новые смены не открываются и продление этого файла или пробного периода ещё не тратилось). Время в вопросе «до DD.MM HH:MM» — `effectiveAt` хоста + 72 часа, в поясе организации: часы ПК офиса с часами хоста не сравниваются (`AGENTS.md`, «Office pages»). Станция при `emergencyUntil` открытие не закрывает (хост откроет; истёкшее продление хост откажет сам, и отказ будет сказан) и пишет строку «новые смены открываются по аварийному продлению до …».
- **Д8 — полоса для `inn_mismatch`** (в таблице §9.5 её нет, а состояние «как `restricted`»): опасность, без закрытия, текст без чисел ИНН (числа — в разделе). Строка «Киоски» в «Рабочих местах» не показывается: квота пока не применяется (§4.7). Прочие возможности показываются все семь.
- **Д9 — фокус после перехода по полосе.** `OfficeShell` после смены страницы ставит фокус на `main`; ссылка с якорем (`/about#license`) отдаёт фокус самому разделу (`tabIndex={-1}`), иначе программа прокрутила бы к разделу и тут же увела фокус наверх. Это правка двух строк каркаса.
- **Д10 — `SupportContext.read`.** Вкладчику лицензии нужен хост, а контекст каркаса даёт только `t`, `facts`, `about`. План добавляет одно общее поле `read` (чтение через `session.call`), а не поле `license`: план ОБН-2 читает хост тем же путём. Если ОБН-2 смёржен раньше и уже расширил контекст, задача 6 берёт его поле и пишет это в «Отклонения».

## Global Constraints

**Распределение (бриф, BINDING):**

- Миграции хоста: `0030_license.sql` — ЛЦ-2, `0031_device_versions.sql` — ОБН-1, `0032`–`0033` — резерв направления; `0017`–`0018` заняты открытыми ветками (`fb-codesearch`, `fb-people`, `fb-templates`, `fb-mode`) — не трогать. **Этот план миграций не добавляет** — ни хоста, ни оболочки (`src-tauri/migrations` `0030`–`0031` — резерв, не используется), ни облака.
- Разделы спецификации «Уточнения плана …» пишутся при исполнении: §18 ЛЦ-1, §19 ЛЦ-2, §20 ОБН-1, **§21 ЛЦ-3 (этот план)**, §22 ОБН-2, §23 ОБН-3, §24 ЛЦ-0.
- Порядок: ЛЦ-1 → (ЛЦ-0 ∥ ЛЦ-2 ∥ ОБН-1) → (**ЛЦ-3** ∥ ОБН-2) → ОБН-3.
- Имена контракта — ровно из брифа: `officeLicenseSchema`, `licensePreviewSchema`, `deviceLicenseSchema`, `HostApi.getLicense` / `previewLicense` / `loadLicense` / `getActivationRequest` / `enableLicenseEmergency`, маршруты `GET /v1/office/license`, `POST /v1/office/license/preview`, `PUT /v1/office/license`, `GET /v1/office/license/activation-request`, `POST /v1/office/license/emergency`, поле `license` в `GET /v1/device`, ограничения `license_restricted`, `seat_limit` (`quota`, `used`, `limit`), `feature_disabled` (`feature`), причины `license_malformed`, `license_unknown_key`, `license_signature`, `license_wrong_host`, `license_inn_mismatch`, `license_inn_missing`, `license_older`; константы `LICENSE_*` и построитель `licenseLoad` (ЛЦ-2). Отступления — только Д1 (префикс i18n), Д3 (`HostApi.getDevice`, нового в контракте нет) и Д10 (`SupportContext.read` — расширение каркаса, не контракта).
- Каркас `fb-about`: `ABOUT_SECTIONS` не меняет порядок (`license` — второй; раздел `update` добавляет ОБН-2 после него), `SUPPORT_CONTRIBUTORS` — список, куда ОБН-2 добавит свой блок после лицензии.

**Правила исполненного состояния**

- Формы на проводе не меняются этим планом (их ввёл ЛЦ-2); новые запросы — `GET /v1/device` (есть с плана 1d3) и офисные маршруты ЛЦ-2. Ответы читаются терпимо.
- Лицензия никогда не попадает в лог и в консоль: ни текст файла, ни подпись, ни ИНН, ни название клиента (§8.4). Новых `console.*` нет. Текст файла живёт только в состоянии компонента до загрузки или отмены и в переменных мутации; в `localStorage`, в URL и в кэш запросов он не кладётся (`useOfficeMutation` держит переменные только до конца мутации — `gcTime` мутаций по умолчанию; это то же, что с хешем PIN у «Операторов»).
- Сведения для поддержки: в блоке «Лицензия» — только состояние, флаги часов, первые 8 знаков `licenseId` и `hostId`, `sequence`, `validUntil`, `issuedAt`, `kid`, пробный период и аварийное продление; ни ИНН, ни названия клиента, ни отпечатка, ни текста файла, ни запроса активации (§9.4).
- Офис: каждый запрос — через `session.call` (`useOfficeQuery`, `useOfficeMutation`); успешное сообщение — `Alert`, уходит со следующим действием; повторное нажатие во время запроса ничего не шлёт; таблицы получают локализованный `empty`, диалоги — `FormDialog`; доступность: слово рядом с цветом и значком, скрытое слово тона в предупреждениях, вежливые области на экране до первого сообщения, фокус на сообщении после ошибки загрузки.
- Станция: новых кнопок нет (объяснение заменяет кнопку), тексты — в вежливых областях, экран работы, закрытие коробов, паллет и смены не меняются; повторный вход в свою открытую смену никогда не закрывается.
- Ключи `src/i18n/ru.json` уникальны; в тестах отсутствующий ключ бросает (`src/i18n/index.ts`), поэтому каждый новый ключ проверяется рендером или `i18n.exists`.

**Код и процесс**

- TypeScript strict: без `any`, приведений и `!` в исходниках; `import type` для типов; запрос строится по полям.
- Rust: `cargo fmt` чистый, сборка без предупреждений; `Cargo.toml`, `Cargo.lock`, `package.json`, `pnpm-lock.yaml` не меняются (новых зависимостей нет).
- Никогда `git stash`; команды из корня репозитория, без `cd`; pnpm — `pnpm --config.verifyDepsBeforeRun=false …`, без `pnpm install`/`add`; cargo — `--offline --locked`.
- TDD: сначала падающий тест, потом код; существующие утверждения не ослабляются (заменяемые утверждения о заглушке названы явно и заменены более строгими).
- Перед каждым коммитом: `node_modules/.bin/prettier --ignore-path .prettierignore --write`, затем `--check` на изменённые TS, TSX, JSON, CSS и MD (код плана местами шире 100 знаков — его выравнивает `--write`); `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck` и `run lint`; для задач с Rust — `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `git diff --check`.
- Коммиты — явные пути, сообщение из файла (`git commit -F`), ровно одна строка `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; push, PR, выпуск — не задачи плана.

## Заметки для исполнения

**Основа и предусловия.** Ветка от основы, в которую смёржены ЛЦ-1, ЛЦ-2 и `claude/fb-about`. Перед задачей 1 проверить и при любом «нет» остановиться и назвать это в отчёте:

<!-- prettier-ignore -->
```bash
test -f apps/standalone/src/office/info/sections.tsx && rtk proxy grep -n "SUPPORT_CONTRIBUTORS" apps/standalone/src/office/info/support-blocks.ts
rtk proxy grep -n "office.about.license.notConnected" apps/standalone/src/office/info/LicenseSection.tsx apps/standalone/src/office/info/support-report.ts
rtk proxy grep -n "officeLicenseSchema\|licensePreviewSchema\|deviceLicenseSchema" apps/standalone/src/host/protocol.ts
rtk proxy grep -n "getLicense\|previewLicense\|loadLicense\|getActivationRequest\|enableLicenseEmergency" apps/standalone/src/host/api.ts
ls apps/standalone/proto/fixtures/office-license.json apps/standalone/proto/fixtures/office-license-preview.json apps/standalone/proto/fixtures/device-license.json
rtk proxy grep -n "LICENSE_FEATURE_KEYS\|MAX_LICENSE_FILE_BYTES\|LicenseTerms" apps/standalone/src/host/protocol.ts
rtk proxy grep -n "export function licenseLoad" apps/standalone/src/host/requests.ts
```

Затем сверить настоящую форму `officeLicenseSchema`, `licensePreviewSchema`, `deviceLicenseSchema` с Д2 и с `deviceInfoSchema` (`license` необязательное). Расхождение — правится в модулях, названных в Д2, до задачи 2, и пишется в «Отклонения».

**Параллельный ОБН-2.** ОБН-2 трогает `sections.tsx` (раздел `update` после `license`), `ru.json` (`office.about.update.*`), тест оглавления в `test/about-page.test.tsx` и `src-tauri/src/office_files.rs` (новая константа `UPDATES_ROOT`; `ROOTS` он не меняет — его ожидание «прежние тесты `office_files` PASS» верно и с корнем «Лицензия» этого плана). При слиянии сохранить оба: порядок `ABOUT_SECTIONS` — `program`, `license`, `update`, `contacts`, `support`; `SUPPORT_CONTRIBUTORS` — `[licenseSupportBlock, <вкладчик ОБН-2>]`.

**Фрагменты.** Фрагменты взяты из `/tmp/claude/wt/fb-license` (`f38f4a3e9`, основа `a4eef5cd6`) и `/tmp/claude/wt/fb-about` (`32d6aa5fa`); код ЛЦ-2 при написании не существовал. «Фрагмент … заменить на …» дан так, как стоит в файле; не находится — применить по смыслу и записать в «Отклонения при исполнении».

**Сборка.** В свежем worktree: `pnpm --config.verifyDepsBeforeRun=false exec turbo run build --filter='@markiro/standalone^...'` (домен и `@markiro/ui` экспортируют `dist`). Перед `cargo test -p markiro-standalone` — `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build` (оболочка встраивает `dist`). Тесты библиотеки оболочки (`--lib`) сокета не открывают и идут в песочнице. Вывод тестов не передавать в `tail`/`grep`, когда нужен код возврата; урезанный вывод `rtk` — `rtk proxy <команда>`.

**React-тесты.** Новые и изменённые тестовые файлы с React — один прогон `--reporter=verbose`, в выводе нет `stderr |` (нет предупреждений `act` и утечек после теста).

**graphify.** После правок кода — `graphify update .` (если есть `graphify-out/graph.json`).

## Файлы

- Create (вебвью): `apps/standalone/src/lib/license-dates.ts`, `apps/standalone/src/office/info/license/license-view.ts`, `apps/standalone/src/office/info/license/license-load.ts`, `apps/standalone/src/office/info/license/license-files.ts`, `apps/standalone/src/office/info/license/license-support.ts`, `apps/standalone/src/office/info/license/LicenseLoad.tsx`, `apps/standalone/src/office/info/license/LicenseActions.tsx`, `apps/standalone/src/office/info/license/LicenseNotices.tsx`, `apps/standalone/src/office/LicenseBanner.tsx`, `apps/standalone/src/floor/license.ts`, `apps/standalone/src/app/use-station-license.ts`
- Create (тесты): `apps/standalone/test/support/license.ts`, `apps/standalone/test/license-dates.test.ts`, `apps/standalone/test/license-view.test.ts`, `apps/standalone/test/license-section.test.tsx`, `apps/standalone/test/license-load.test.ts`, `apps/standalone/test/license-banner.test.tsx`, `apps/standalone/test/station-license.test.tsx`
- Modify (оболочка): `apps/standalone/src-tauri/src/office_files.rs`, `apps/standalone/src-tauri/src/device.rs`
- Modify (вебвью): `apps/standalone/src/office/info/LicenseSection.tsx`, `apps/standalone/src/office/info/support-blocks.ts`, `apps/standalone/src/office/info/support-report.ts`, `apps/standalone/src/office/info/SupportSection.tsx`, `apps/standalone/src/office/info/AboutPage.tsx`, `apps/standalone/src/office/office-query.ts`, `apps/standalone/src/office/access.ts`, `apps/standalone/src/office/form-errors.ts`, `apps/standalone/src/office/page-state.tsx`, `apps/standalone/src/office/OfficeShell.tsx`, `apps/standalone/src/office/OfficeOverview.tsx`, `apps/standalone/src/office/Office.tsx`, `apps/standalone/src/office/exports/office-files.ts`, `apps/standalone/src/host/api.ts`, `apps/standalone/src/host/device.ts`, `apps/standalone/src/floor/FloorStatusBar.tsx`, `apps/standalone/src/floor/FloorApp.tsx`, `apps/standalone/src/floor/shifts/ShiftCard.tsx`, `apps/standalone/src/floor/shifts/ShiftList.tsx`, `apps/standalone/src/floor/shifts/NewShift.tsx`, `apps/standalone/src/floor/shifts/shift-entry.ts`, `apps/standalone/src/floor/shifts/new-shift.ts`, `apps/standalone/src/app/App.tsx`, `apps/standalone/src/app/shell.css`, `apps/standalone/src/i18n/ru.json`
- Modify (тесты): `apps/standalone/test/support/office.tsx`, `apps/standalone/test/about-page.test.tsx`, `apps/standalone/test/support-report.test.ts`, `apps/standalone/test/api.test.ts`, `apps/standalone/test/floor-status-bar.test.tsx`, `apps/standalone/test/floor-shift-list.test.tsx`, `apps/standalone/test/floor-new-shift.test.tsx`, `apps/standalone/test/network-pairing.test.tsx`, `apps/standalone/test/app.test.tsx`, `apps/standalone/test/form-errors.test.ts`
- Modify (документы): `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md` (§21)

---

### Task 1: Корень «Лицензия» и `.json` в файлах офиса (оболочка)

**Files:**

- Modify: `apps/standalone/src-tauri/src/office_files.rs`, `apps/standalone/src/office/exports/office-files.ts`
- Test: `apps/standalone/src-tauri/src/office_files.rs` (модуль `tests`)

**Interfaces:**

- Consumes: `save_files`, `existing_folder`, `existing_form`, `is_plain_file_name`, `ROOTS`, `FILE_EXTENSIONS`, `FORMS_ROOT`.
- Produces: `ROOTS = ["Выгрузки", "Формы", "Лицензия"]`, `pub const LICENSE_ROOT: &str = "Лицензия"`, `FILE_EXTENSIONS` с `json`; `files.save(["Лицензия", <папка>], [{ name: "*.json", … }])` в вебвью проходит, `open_office_file` из `Лицензия` по-прежнему отказывает.

- [ ] **Step 1: Написать падающий тест**

Правка `apps/standalone/src-tauri/src/office_files.rs` (модуль `tests`).

Фрагмент 1:

<!-- prettier-ignore -->
```rust
    fn both_roots_are_open_and_the_folder_is_markiro_under_documents() {
        assert_eq!(ROOTS, ["Выгрузки", "Формы"]);
```

заменить на:

<!-- prettier-ignore -->
```rust
    fn both_roots_are_open_and_the_folder_is_markiro_under_documents() {
        // Plan ЛЦ-3 adds the license's root for the activation request.
        assert_eq!(ROOTS, ["Выгрузки", "Формы", "Лицензия"]);
```

Фрагмент 2:

<!-- prettier-ignore -->
```rust
    fn a_file_name_ends_in_an_extension_the_office_writes() {
        assert_eq!(FILE_EXTENSIONS, ["csv", "txt", "xml", "html"]);
        for name in [
            "a.csv",
            "a.txt",
            "a.xml",
            "a.html",
            "A.TXT",
            "a.Xml",
            "Молоко (2).csv",
        ] {
```

заменить на:

<!-- prettier-ignore -->
```rust
    fn a_file_name_ends_in_an_extension_the_office_writes() {
        assert_eq!(FILE_EXTENSIONS, ["csv", "txt", "xml", "html", "json"]);
        for name in [
            "a.csv",
            "a.txt",
            "a.xml",
            "a.html",
            "a.json",
            "A.TXT",
            "A.JSON",
            "a.Xml",
            "Молоко (2).csv",
            "markiro-activation-request.json",
        ] {
```

Фрагмент 3 (в том же тесте, список отвергнутых):

<!-- prettier-ignore -->
```rust
            "a.csv.bat",
            "Молоко.csv.exe",
```

заменить на:

<!-- prettier-ignore -->
```rust
            "a.csv.bat",
            "Молоко.csv.exe",
            "a.json.exe",
            "a.jsonl",
```

Фрагмент 4 (перед тестом `a_file_of_another_shape_is_not_taken`):

<!-- prettier-ignore -->
```rust
    /// The IPC shape is closed: a file with a field of another name is not a
    /// file, and the content is `contentBase64`.
    #[test]
    fn a_file_of_another_shape_is_not_taken() {
```

заменить на:

<!-- prettier-ignore -->
```rust
    /// The activation request goes under `Лицензия` as JSON (plan ЛЦ-3), and
    /// nothing is opened from there: a form is opened from `Формы` only.
    #[test]
    fn the_license_root_takes_the_activation_request_and_opens_nothing() {
        let root = tempfile::tempdir().unwrap();
        let path = segments(&["Лицензия", "Запрос на активацию 2026-10-20_09-00-00"]);
        let saved = save_files(
            root.path(),
            &path,
            &[file("markiro-activation-request.json", b"{}\n")],
        )
        .unwrap();
        assert_eq!(saved.segments, path);
        assert_eq!(saved.files, ["markiro-activation-request.json"]);
        assert_eq!(
            fs::read(
                root.path()
                    .join("Лицензия")
                    .join("Запрос на активацию 2026-10-20_09-00-00")
                    .join("markiro-activation-request.json")
            )
            .unwrap(),
            b"{}\n"
        );
        assert!(existing_folder(root.path(), &saved.segments).is_ok());
        assert_eq!(
            existing_form(
                root.path(),
                &saved.segments,
                "markiro-activation-request.json"
            ),
            Err(OfficeFilesError::InvalidRequest)
        );
        assert_eq!(LICENSE_ROOT, "Лицензия");
    }

    /// The IPC shape is closed: a file with a field of another name is not a
    /// file, and the content is `contentBase64`.
    #[test]
    fn a_file_of_another_shape_is_not_taken() {
```

- [ ] **Step 2: Убедиться, что тест падает**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib office_files
```

Ожидается: сборка падает на `LICENSE_ROOT` (`cannot find value`); после временной заглушки — FAIL `both_roots_are_open…`, `a_file_name_ends_in_an_extension…`, `the_license_root_takes…` (`InvalidRequest` на корне и на `.json`).

- [ ] **Step 3: Реализация**

Правка `apps/standalone/src-tauri/src/office_files.rs`.

Фрагмент 1:

<!-- prettier-ignore -->
```rust
//! Files the office saves on this computer (plan ЧЗ): the parts of an export
//! and a printed form's HTML (plan О-Ф). Everything goes under
```

заменить на:

<!-- prettier-ignore -->
```rust
//! Files the office saves on this computer (plan ЧЗ): the parts of an export,
//! a printed form's HTML (plan О-Ф) and the license's activation request
//! (plan ЛЦ-3). Everything goes under
```

Фрагмент 2:

<!-- prettier-ignore -->
```rust
/// The first folders under `Документы\Markiro` the office writes into:
/// exports (plan ЧЗ) and forms (plan О-Ф).
pub const ROOTS: [&str; 2] = ["Выгрузки", "Формы"];
```

заменить на:

<!-- prettier-ignore -->
```rust
/// The first folders under `Документы\Markiro` the office writes into:
/// exports (plan ЧЗ), forms (plan О-Ф) and the license's activation request
/// (plan ЛЦ-3, license spec §6.3).
pub const ROOTS: [&str; 3] = ["Выгрузки", "Формы", LICENSE_ROOT];

/// The root the activation request is saved under (plan ЛЦ-3). Nothing is
/// opened from it: `open_office_file` opens forms only.
pub const LICENSE_ROOT: &str = "Лицензия";
```

Фрагмент 3:

<!-- prettier-ignore -->
```rust
/// The extensions of the files the office writes: the parts of an export
/// and a form's HTML. A file of another kind (a script, a shortcut, a
/// program) is never written, whatever the webview asks.
pub const FILE_EXTENSIONS: [&str; 4] = ["csv", "txt", "xml", "html"];
```

заменить на:

<!-- prettier-ignore -->
```rust
/// The extensions of the files the office writes: the parts of an export,
/// a form's HTML and the license's activation request (`json`, plan ЛЦ-3).
/// A file of another kind (a script, a shortcut, a program) is never
/// written, whatever the webview asks.
pub const FILE_EXTENSIONS: [&str; 5] = ["csv", "txt", "xml", "html", "json"];
```

Правка `apps/standalone/src/office/exports/office-files.ts`, фрагмент:

<!-- prettier-ignore -->
```ts
 * into a new folder under `Документы\Markiro\<segments…>`, the first segment
 * one of the shell's roots (`Выгрузки`, `Формы`); no file dialog.
```

заменить на:

<!-- prettier-ignore -->
```ts
 * into a new folder under `Документы\Markiro\<segments…>`, the first segment
 * one of the shell's roots (`Выгрузки`, `Формы`, `Лицензия` — the activation
 * request, plan ЛЦ-3); no file dialog.
```

- [ ] **Step 4: Убедиться, что тест проходит**

<!-- prettier-ignore -->
```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib office_files
```

Ожидается: PASS, все тесты модуля (в том числе `the_names_the_domain_makes_are_taken` и тесты `existing_form`).

- [ ] **Step 5: Гейты и коммит**

<!-- prettier-ignore -->
```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
node_modules/.bin/prettier --ignore-path .prettierignore --check apps/standalone/src/office/exports/office-files.ts
git diff --check
```

Сообщение (`/tmp/claude/lc3-t1-msg.txt`):

<!-- prettier-ignore -->
```text
feat(standalone): office files take the license root and JSON (plan ЛЦ-3)

The activation request is saved under Документы\Markiro\Лицензия as JSON
without a file dialog; nothing is opened from that root.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

<!-- prettier-ignore -->
```bash
git add apps/standalone/src-tauri/src/office_files.rs apps/standalone/src/office/exports/office-files.ts
git commit -F /tmp/claude/lc3-t1-msg.txt
```

---

### Task 2: Модель вида лицензии: даты, состояние, сроки, места, возможности, предупреждения

**Files:**

- Create: `apps/standalone/src/lib/license-dates.ts`, `apps/standalone/src/office/info/license/license-view.ts`, `apps/standalone/test/support/license.ts`
- Modify: `apps/standalone/src/office/office-query.ts`, `apps/standalone/src/office/access.ts`, `apps/standalone/test/support/office.tsx`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/license-dates.test.ts`, `apps/standalone/test/license-view.test.ts`

**Interfaces:**

- Consumes: `OfficeLicense`, `officeLicenseSchema`, `LICENSE_STATES`, `LICENSE_FEATURE_KEYS` (ЛЦ-2, `src/host/protocol.ts`), `isKnownTimeZone` (`src/lib/civil-date.ts`), `AlertTone` (`@markiro/ui`).
- Produces: `licenseDay`, `licenseDayMonth`, `licenseMinute`, `lastMomentBefore`, `EMERGENCY_MS`; `LicenseText`, `stateText`, `stateTone`, `planText`, `licenseTerms`, `SHOWN_QUOTAS`, `QuotaRow`, `quotaRows`, `featureRows`, `LicenseNoticeKind`, `LicenseNotice`, `licenseNotices`, `noticeNeedsTime`, `noticeText`, `shortLicenseId`; `officeKeys.license`; возможность `manageLicense` (только администратор); тестовые `ACTIVE_LICENSE`, `licenseOf`, `TRIAL`, `TRIAL_ENDING`, `DEMO`, `EXPIRING`, `GRACE`, `RESTRICTED`, `TRIAL_EXPIRED`, `WRONG_HOST`, `INN_MISMATCH`, `LICENSE_ID`, `HOST_FINGERPRINT`, `ORG_INN`, `OTHER_INN`; поддельный `getLicense` по умолчанию отвечает `ACTIVE_LICENSE`.

- [ ] **Step 1: Тестовые лицензии и падающие тесты**

Создать `apps/standalone/test/support/license.ts`:

```ts
import type { OfficeLicense } from "../../src/host/protocol.js";
import { HOST_ID } from "./fixtures.js";

export const LICENSE_ID = "5b1d7c2e-8f3a-4c6b-9d0e-1a2b3c4d5e6f";
export const HOST_FINGERPRINT = "cd".repeat(32);
/** INNs with a valid checksum (plan ЛЦ-2, Д10): the organization's and another one. */
export const ORG_INN = "7707083893";
export const OTHER_INN = "7802000015";

/**
 * A subscription valid through 31.10.2027 in Moscow (`validUntil` is the
 * exclusive 01.11.2027 00:00 MSK), nothing to warn of: the office's default
 * answer, so every office test that is not about the license stays silent.
 */
export const ACTIVE_LICENSE: OfficeLicense = {
  state: "active",
  since: "2026-10-01T00:00:00Z",
  flags: { clockBehindDays: null, clockAhead: false },
  effectiveAt: "2026-10-20T09:00:00Z",
  phaseEndsAt: "2027-10-01T21:00:00Z",
  daysLeft: 346,
  warnDays: 30,
  opensNewShifts: true,
  license: {
    licenseId: LICENSE_ID,
    sequence: 3,
    kid: "lic-2026-1",
    customer: { name: "ООО «Атолл»", inn: ORG_INN },
    plan: "subscription",
    planVersionId: "0d5c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a",
    issuedAt: "2026-10-01T08:00:00Z",
    validFrom: "2026-10-01T00:00:00Z",
    validUntil: "2027-10-31T21:00:00Z",
    graceDays: 14,
  },
  trial: null,
  binding: {
    hostId: HOST_ID,
    fingerprint: HOST_FINGERPRINT,
    orgInn: ORG_INN,
    innMatches: true,
  },
  quotas: {
    lines: { limit: 2, used: 1, over: false },
    stations: { limit: 5, used: 3, over: false },
    kiosks: { limit: null, used: 0, over: false },
    cabinetUsers: { limit: 3, used: 2, over: false },
  },
  features: {
    labelEditor: true,
    publicApi: false,
    pallets: true,
    chzIntegration: true,
    inventory: false,
    commerceMl: false,
    handheld: true,
  },
  emergency: { available: false, until: null },
};

export function licenseOf(patch: Partial<OfficeLicense>): OfficeLicense {
  return { ...ACTIVE_LICENSE, ...patch };
}

const TRIAL_PERIOD = {
  startedAt: "2026-10-10T09:00:00Z",
  endsAt: "2026-10-24T09:00:00Z",
  inn: ORG_INN,
};

/** The built-in trial, 12 days left of 14: the neutral line. */
export const TRIAL = licenseOf({
  state: "trial",
  since: TRIAL_PERIOD.startedAt,
  effectiveAt: "2026-10-12T09:00:00Z",
  phaseEndsAt: TRIAL_PERIOD.endsAt,
  daysLeft: 12,
  warnDays: 4,
  license: null,
  trial: TRIAL_PERIOD,
  quotas: {
    lines: { limit: null, used: 1, over: false },
    stations: { limit: null, used: 1, over: false },
    kiosks: { limit: null, used: 0, over: false },
    cabinetUsers: { limit: null, used: 1, over: false },
  },
});

/** The trial with 4 days left: the warning tone (spec §3.2, from the 10th day). */
export const TRIAL_ENDING = licenseOf({
  ...TRIAL,
  effectiveAt: "2026-10-20T09:00:00Z",
  daysLeft: 4,
});

/** A 14-day demo file, still valid. */
export const DEMO = licenseOf({
  phaseEndsAt: "2026-10-30T21:00:00Z",
  daysLeft: 14,
  warnDays: 4,
  license: {
    ...ACTIVE_LICENSE.license!,
    plan: "demo",
    graceDays: 0,
    validUntil: "2026-11-03T21:00:00Z",
  },
});

export const EXPIRING = licenseOf({
  state: "expiring",
  since: "2027-10-01T21:00:00Z",
  effectiveAt: "2027-10-11T09:00:00Z",
  phaseEndsAt: "2027-10-31T21:00:00Z",
  daysLeft: 20,
});

/** Expired 31.10.2027; the 14 days of grace end on 14.11.2027 inclusive. */
export const GRACE = licenseOf({
  state: "grace",
  since: "2027-10-31T21:00:00Z",
  effectiveAt: "2027-11-05T09:00:00Z",
  phaseEndsAt: "2027-11-14T21:00:00Z",
  daysLeft: 9,
});

/** Past the grace: no new shift since 15.11.2027 (Moscow), the emergency still unused. */
export const RESTRICTED = licenseOf({
  state: "restricted",
  since: "2027-11-14T21:00:00Z",
  effectiveAt: "2027-11-20T06:00:00Z",
  phaseEndsAt: null,
  daysLeft: null,
  opensNewShifts: false,
  emergency: { available: true, until: null },
});

export const TRIAL_EXPIRED = licenseOf({
  ...TRIAL,
  state: "trial_expired",
  since: TRIAL_PERIOD.endsAt,
  effectiveAt: "2026-10-25T09:00:00Z",
  phaseEndsAt: null,
  daysLeft: null,
  opensNewShifts: false,
  emergency: { available: true, until: null },
});

export const WRONG_HOST = licenseOf({
  state: "wrong_host",
  since: "2026-10-20T09:00:00Z",
  phaseEndsAt: "2026-11-19T09:00:00Z",
  daysLeft: 30,
});

/** The organization's INN changed after the load: no new shift since 18.10.2026. */
export const INN_MISMATCH = licenseOf({
  state: "inn_mismatch",
  since: "2026-10-18T09:00:00Z",
  phaseEndsAt: null,
  daysLeft: null,
  opensNewShifts: false,
  binding: { ...ACTIVE_LICENSE.binding, orgInn: OTHER_INN, innMatches: false },
  emergency: { available: true, until: null },
});
```

Создать `apps/standalone/test/license-dates.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  EMERGENCY_MS,
  lastMomentBefore,
  licenseDay,
  licenseDayMonth,
  licenseMinute,
} from "../src/lib/license-dates.js";

describe("the license's dates", () => {
  it("name the last day «включительно» of an exclusive end in the organization's zone", () => {
    // 01.11.2027 00:00 in Moscow is the exclusive end: the last day is 31.10.
    expect(licenseDay("2027-10-31T21:00:00Z", "Europe/Moscow")).toBe("01.11.2027");
    expect(licenseDay(lastMomentBefore("2027-10-31T21:00:00Z"), "Europe/Moscow")).toBe(
      "31.10.2027",
    );
    expect(licenseDayMonth(lastMomentBefore("2026-10-24T09:00:00Z"), "Europe/Moscow")).toBe(
      "24.10",
    );
    // The same instant is already 01.11 in Vladivostok.
    expect(licenseDay(lastMomentBefore("2027-10-31T21:00:00Z"), "Asia/Vladivostok")).toBe(
      "01.11.2027",
    );
  });

  it("write a minute as «DD.MM HH:MM» on a 24-hour clock", () => {
    expect(licenseMinute("2026-10-23T06:00:00Z", "Europe/Moscow")).toBe("23.10 09:00");
    expect(licenseMinute("2026-10-23T21:05:00Z", "Europe/Moscow")).toBe("24.10 00:05");
  });

  it("use this PC's zone without one, or with one this PC lacks", () => {
    const instant = "2027-02-28T12:00:00Z";
    expect(licenseDay(instant, "Mars/Olympus")).toBe(licenseDay(instant, null));
    expect(licenseMinute(instant, "Mars/Olympus")).toBe(licenseMinute(instant, null));
  });

  it("know a leap year's last day and the 72 hours of the emergency", () => {
    expect(licenseDay(lastMomentBefore("2028-03-01T00:00:00Z"), "UTC")).toBe("29.02.2028");
    expect(lastMomentBefore("2028-03-01T00:00:00Z")).toBe("2028-02-29T23:59:59.999Z");
    expect(EMERGENCY_MS).toBe(259_200_000);
  });
});
```

Создать `apps/standalone/test/license-view.test.ts`:

```ts
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { officeLicenseSchema, type OfficeLicense } from "../src/host/protocol.js";
import i18n from "../src/i18n/index.js";
import {
  featureRows,
  licenseNotices,
  licenseTerms,
  noticeNeedsTime,
  noticeText,
  planText,
  quotaRows,
  shortLicenseId,
  stateText,
  stateTone,
  type LicenseText,
} from "../src/office/info/license/license-view.js";
import {
  ACTIVE_LICENSE,
  DEMO,
  EXPIRING,
  GRACE,
  INN_MISMATCH,
  licenseOf,
  RESTRICTED,
  TRIAL,
  TRIAL_ENDING,
  TRIAL_EXPIRED,
  WRONG_HOST,
} from "./support/license.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;
const MSK = "Europe/Moscow";
const ALL: OfficeLicense[] = [
  TRIAL,
  TRIAL_ENDING,
  ACTIVE_LICENSE,
  DEMO,
  EXPIRING,
  GRACE,
  RESTRICTED,
  TRIAL_EXPIRED,
  WRONG_HOST,
  INN_MISMATCH,
];

function said(text: LicenseText): string {
  return i18n.t(text.key, text.values);
}

describe("the license as the office reads it", () => {
  it("reads the host's fixture and every test license with the wire's own schema", () => {
    const fixture: unknown = JSON.parse(
      readFileSync(new URL("../proto/fixtures/office-license.json", testModuleUrl), "utf8"),
    );
    expect(officeLicenseSchema.safeParse(fixture).success).toBe(true);
    for (const license of ALL) expect(officeLicenseSchema.parse(license)).toEqual(license);
  });

  it.each([
    [TRIAL, "Пробный период", "info"],
    [ACTIVE_LICENSE, "Действует", "ok"],
    [DEMO, "Демо-лицензия", "ok"],
    [EXPIRING, "Заканчивается", "warn"],
    [GRACE, "Льготный срок", "error"],
    [RESTRICTED, "Ограничена: новые смены не открываются", "error"],
    [TRIAL_EXPIRED, "Пробный период закончился: новые смены не открываются", "error"],
    [WRONG_HOST, "Выдана другому хосту", "warn"],
    [INN_MISMATCH, "ИНН организации не совпадает с лицензией", "error"],
  ] as const)("names the state in words with its tone (%#)", (license, word, tone) => {
    expect(said(stateText(license))).toBe(word);
    expect(stateTone(license.state)).toBe(tone);
  });

  it("names a state a newer host adds without failing, in the warning tone", () => {
    const future = licenseOf({ state: "some_future_state" });
    expect(said(stateText(future))).toBe("Неизвестное состояние лицензии (some_future_state)");
    expect(stateTone(future.state)).toBe("warn");
    expect(licenseNotices(future)).toEqual([]);
  });

  it("names the plan, a newer host's one as it is", () => {
    expect(said(planText("subscription"))).toBe("Подписка");
    expect(said(planText("demo"))).toBe("Демо-лицензия");
    expect(said(planText("trial"))).toBe("Пробный период");
    expect(said(planText("enterprise"))).toBe("enterprise");
  });

  it("writes the terms in the organization's zone, the last day inclusive", () => {
    const terms = (license: OfficeLicense) => licenseTerms(license, MSK).map(said);
    expect(terms(ACTIVE_LICENSE)).toEqual(["Действует по 31.10.2027 включительно."]);
    expect(terms(DEMO)).toEqual([
      "Демо-лицензия до 03.11.2026 включительно. По окончании демо новые смены не откроются.",
    ]);
    expect(terms(EXPIRING)).toEqual(["Действует по 31.10.2027 включительно.", "Осталось 20 дн."]);
    expect(terms(TRIAL)).toEqual(["Пробный период до 24.10.2026 включительно.", "Осталось 12 дн."]);
    expect(terms(GRACE)).toEqual([
      "Срок лицензии истёк 31.10. Новые смены открываются до 14.11.2027 включительно.",
      "Осталось 9 дн.",
    ]);
    expect(terms(RESTRICTED)).toEqual(["Новые смены не открываются с 15.11.2027."]);
    expect(terms(TRIAL_EXPIRED)).toEqual(["Новые смены не открываются с 24.10.2026."]);
    expect(terms(WRONG_HOST)).toEqual([
      "Всё работает до 19.11.2026 включительно; затем новые смены не будут открываться.",
    ]);
    expect(terms(INN_MISMATCH)).toEqual(["Новые смены не открываются с 18.10.2026."]);
    expect(
      terms({
        ...RESTRICTED,
        opensNewShifts: true,
        emergency: { available: false, until: "2027-11-23T06:00:00Z" },
      }),
    ).toEqual([
      "Новые смены не открываются с 15.11.2027.",
      "Аварийное продление: новые смены открываются до 23.11 09:00.",
    ]);
  });

  it("lists the seats of the stations, the office users and the lines, unlimited as null", () => {
    expect(quotaRows(ACTIVE_LICENSE)).toEqual([
      { key: "stations", limit: 5, used: 3, over: false },
      { key: "cabinetUsers", limit: 3, used: 2, over: false },
      { key: "lines", limit: 2, used: 1, over: false },
    ]);
    expect(quotaRows(TRIAL).map((row) => row.limit)).toEqual([null, null, null]);
  });

  it("lists every feature of the license in the cloud's order", () => {
    expect(featureRows(ACTIVE_LICENSE)).toEqual([
      { key: "labelEditor", on: true },
      { key: "publicApi", on: false },
      { key: "pallets", on: true },
      { key: "chzIntegration", on: true },
      { key: "inventory", on: false },
      { key: "commerceMl", on: false },
      { key: "handheld", on: true },
    ]);
  });

  it.each([
    [TRIAL, [["trial", "info", true]]],
    [TRIAL_ENDING, [["trialEnding", "warn", true]]],
    [ACTIVE_LICENSE, []],
    [DEMO, []],
    [EXPIRING, [["expiring", "warn", true]]],
    [licenseOf({ ...DEMO, state: "expiring" }), [["expiringDemo", "warn", true]]],
    [GRACE, [["grace", "error", false]]],
    [RESTRICTED, [["restricted", "error", false]]],
    [TRIAL_EXPIRED, [["trialExpired", "error", false]]],
    [WRONG_HOST, [["wrongHost", "warn", false]]],
    [INN_MISMATCH, [["innMismatch", "error", false]]],
    [
      licenseOf({ flags: { clockBehindDays: 2, clockAhead: false } }),
      [["clockBehind", "warn", true]],
    ],
    [
      licenseOf({ ...GRACE, flags: { clockBehindDays: null, clockAhead: true } }),
      [
        ["grace", "error", false],
        ["clockAhead", "warn", true],
      ],
    ],
  ] as const)("warns the office of what the state calls for (%#)", (license, expected) => {
    expect(
      licenseNotices(license).map((notice) => [notice.kind, notice.tone, notice.dismissible]),
    ).toEqual(expected);
  });

  it("writes each warning with its dates and days, and reads the zone only for the dates", () => {
    const text = (license: OfficeLicense) =>
      licenseNotices(license).map((notice) => said(noticeText(notice, license, MSK)));
    expect(text(TRIAL)).toEqual([
      "Пробный период: осталось 12 дн. Загрузите файл лицензии в разделе «Информация».",
    ]);
    expect(text(TRIAL_ENDING)).toEqual([
      "Пробный период заканчивается 24.10. После этого новые смены не будут открываться без файла лицензии.",
    ]);
    expect(text(EXPIRING)).toEqual([
      "Лицензия заканчивается 31.10.2027. Чтобы продлить, свяжитесь с Маркиро.",
    ]);
    expect(text(GRACE)).toEqual([
      "Срок лицензии истёк 31.10. До 14.11 всё работает; затем новые смены не будут открываться.",
    ]);
    expect(text(RESTRICTED)).toEqual([
      "Новые смены не открываются: лицензия площадки истекла. Начатые смены можно продолжать и закрывать, данные и выгрузки доступны.",
    ]);
    expect(text(licenseOf({ flags: { clockBehindDays: 2, clockAhead: false } }))).toEqual([
      "Часы ПК хоста отстают от последнего известного времени на 2 дн. Проверьте дату и время Windows.",
    ]);
    expect(licenseNotices(TRIAL).map(noticeNeedsTime)).toEqual([false]);
    expect(licenseNotices(GRACE).map(noticeNeedsTime)).toEqual([true]);
    expect(licenseNotices(RESTRICTED).map(noticeNeedsTime)).toEqual([false]);
  });

  it("has words for every key it produces", () => {
    for (const license of ALL) {
      expect(i18n.exists(stateText(license).key)).toBe(true);
      for (const term of licenseTerms(license, MSK)) {
        expect(i18n.exists(term.key), term.key).toBe(true);
      }
      for (const notice of licenseNotices(license)) {
        expect(i18n.exists(noticeText(notice, license, MSK).key)).toBe(true);
      }
    }
    for (const kind of ["clockBehind", "clockAhead", "trialExpired", "wrongHost", "innMismatch"]) {
      expect(i18n.exists(`office.banner.license.${kind}`), kind).toBe(true);
    }
  });

  it("shortens a license id to its first eight characters", () => {
    expect(shortLicenseId("5b1d7c2e-8f3a-4c6b-9d0e-1a2b3c4d5e6f")).toBe("5b1d7c2e");
    expect(shortLicenseId("not-an-id")).toBe("—");
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/license-dates.test.ts test/license-view.test.ts
```

Ожидается: FAIL — модулей `src/lib/license-dates.ts` и `license-view.ts` нет. Если падает уже разбор `office-license.json` или `officeLicenseSchema.parse(ACTIVE_LICENSE)` — исполненный ЛЦ-2 разошёлся с Д2: поправить `test/support/license.ts` и чтение в модулях этой задачи, записать в «Отклонения».

- [ ] **Step 3: Реализация**

Создать `apps/standalone/src/lib/license-dates.ts`:

```ts
import { isKnownTimeZone } from "./civil-date.js";

/** The emergency extension's length (license spec §3.5): 72 hours, the only one in the code. */
export const EMERGENCY_MS = 72 * 60 * 60 * 1000;

type Shape = "day" | "dayMonth" | "time";

const OPTIONS: Record<Shape, Intl.DateTimeFormatOptions> = {
  day: { day: "2-digit", month: "2-digit", year: "numeric" },
  dayMonth: { day: "2-digit", month: "2-digit" },
  time: { hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
};

const FORMATS = new Map<string, Intl.DateTimeFormat>();

function formatter(shape: Shape, zone: string | null): Intl.DateTimeFormat {
  const known = zone !== null && isKnownTimeZone(zone) ? zone : null;
  const key = `${shape}:${known ?? ""}`;
  const cached = FORMATS.get(key);
  if (cached !== undefined) return cached;
  const format = new Intl.DateTimeFormat("ru-RU", {
    ...OPTIONS[shape],
    ...(known === null ? {} : { timeZone: known }),
  });
  FORMATS.set(key, format);
  return format;
}

/**
 * «31.10.2027» of an instant the host reported, in `zone` (the
 * organization's); this PC's own zone without one, or with one this PC lacks.
 */
export function licenseDay(instant: string, zone: string | null): string {
  return formatter("day", zone).format(new Date(instant));
}

/** «31.10» of an instant, as `licenseDay`. */
export function licenseDayMonth(instant: string, zone: string | null): string {
  return formatter("dayMonth", zone).format(new Date(instant));
}

/** «23.10 09:00» of an instant, as `licenseDay`. */
export function licenseMinute(instant: string, zone: string | null): string {
  const date = new Date(instant);
  return `${formatter("dayMonth", zone).format(date)} ${formatter("time", zone).format(date)}`;
}

/**
 * The last moment before an exclusive end (`validUntil`, a phase's end): its
 * day is the one a person reads as «по … включительно».
 */
export function lastMomentBefore(end: string): string {
  return new Date(Date.parse(end) - 1).toISOString();
}
```

Создать `apps/standalone/src/office/info/license/license-view.ts`:

```ts
import type { AlertTone } from "@markiro/ui";

import {
  LICENSE_FEATURE_KEYS,
  LICENSE_STATES,
  type OfficeLicense,
} from "../../../host/protocol.js";
import {
  lastMomentBefore,
  licenseDay,
  licenseDayMonth,
  licenseMinute,
} from "../../../lib/license-dates.js";

/** A text of the license section: an i18n key and its values. */
export interface LicenseText {
  key: string;
  values?: Record<string, string | number>;
}

const KNOWN_STATES: ReadonlySet<string> = new Set(LICENSE_STATES);
const KNOWN_PLANS: ReadonlySet<string> = new Set(["trial", "demo", "subscription"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The state in words; a valid demo file is «Демо-лицензия» (spec §3.4), and a
 * state a newer host adds is named as it is (the wire's state is a word).
 */
export function stateText(license: OfficeLicense): LicenseText {
  if (license.state === "active" && license.license?.plan === "demo") {
    return { key: "office.about.license.state.demo" };
  }
  return KNOWN_STATES.has(license.state)
    ? { key: `office.about.license.state.${license.state}` }
    : { key: "office.about.license.state.unknown", values: { state: license.state } };
}

/** The tone of the state: an error where no new shift opens or soon will not. */
export function stateTone(state: string): AlertTone {
  switch (state) {
    case "active":
      return "ok";
    case "trial":
      return "info";
    case "grace":
    case "restricted":
    case "trial_expired":
    case "inn_mismatch":
      return "error";
    default:
      // `expiring`, `wrong_host`, and a state a newer host adds.
      return "warn";
  }
}

/** The plan in words; a newer host's plan as it is. */
export function planText(plan: string): LicenseText {
  return KNOWN_PLANS.has(plan)
    ? { key: `office.about.license.plans.${plan}` }
    : { key: "office.about.license.plans.other", values: { plan } };
}

/** The lines under the state: the term, the days left, the emergency (spec §9.2). */
export function licenseTerms(license: OfficeLicense, zone: string | null): LicenseText[] {
  const day = (end: string) => licenseDay(lastMomentBefore(end), zone);
  const file = license.license;
  const terms: LicenseText[] = [];
  switch (license.state) {
    case "trial":
      if (license.trial !== null) {
        terms.push({
          key: "office.about.license.terms.trial",
          values: { date: day(license.trial.endsAt) },
        });
      }
      break;
    case "active":
    case "expiring":
      if (file !== null) {
        terms.push({
          key:
            file.plan === "demo"
              ? "office.about.license.terms.demo"
              : "office.about.license.terms.validThrough",
          values: { date: day(file.validUntil) },
        });
      }
      break;
    case "grace":
      if (file !== null && license.phaseEndsAt !== null) {
        terms.push({
          key: "office.about.license.terms.grace",
          values: {
            expired: licenseDayMonth(lastMomentBefore(file.validUntil), zone),
            until: day(license.phaseEndsAt),
          },
        });
      }
      break;
    case "wrong_host":
      terms.push(
        license.phaseEndsAt === null
          ? { key: "office.about.license.terms.wrongHostNoDate" }
          : {
              key: "office.about.license.terms.wrongHost",
              values: { date: day(license.phaseEndsAt) },
            },
      );
      break;
    case "restricted":
    case "trial_expired":
    case "inn_mismatch":
      // `since` is the moment the state began: no new shift opens from then.
      terms.push({
        key: "office.about.license.terms.blockedSince",
        values: { date: licenseDay(license.since, zone) },
      });
      break;
  }
  const counts =
    license.state === "trial" || license.state === "expiring" || license.state === "grace";
  if (counts && license.daysLeft !== null) {
    terms.push({ key: "office.about.license.terms.daysLeft", values: { n: license.daysLeft } });
  }
  if (license.emergency.until !== null) {
    terms.push({
      key: "office.about.license.terms.emergency",
      values: { until: licenseMinute(license.emergency.until, zone) },
    });
  }
  return terms;
}

/** The quotas the host applies, in the order the section lists them; kiosks wait for a kiosk (spec §4.7). */
export const SHOWN_QUOTAS = ["stations", "cabinetUsers", "lines"] as const;

export interface QuotaRow {
  key: (typeof SHOWN_QUOTAS)[number];
  limit: number | null;
  used: number;
  over: boolean;
}

export function quotaRows(license: OfficeLicense): QuotaRow[] {
  return SHOWN_QUOTAS.map((key) => {
    const { limit, used, over } = license.quotas[key];
    return { key, limit, used, over };
  });
}

export function featureRows(license: OfficeLicense): { key: string; on: boolean }[] {
  return LICENSE_FEATURE_KEYS.map((key) => ({ key, on: license.features[key] }));
}

export type LicenseNoticeKind =
  | "trial"
  | "trialEnding"
  | "expiring"
  | "expiringDemo"
  | "grace"
  | "restricted"
  | "trialExpired"
  | "wrongHost"
  | "innMismatch"
  | "clockBehind"
  | "clockAhead";

/** A warning above the office's pages and on «Обзор» (spec §9.5). */
export interface LicenseNotice {
  kind: LicenseNoticeKind;
  tone: "info" | "warn" | "error";
  /** Hidden for the rest of the session by «Скрыть»; the serious ones never are. */
  dismissible: boolean;
}

function phaseNotice(license: OfficeLicense): LicenseNotice | null {
  switch (license.state) {
    case "trial":
      return license.daysLeft !== null && license.daysLeft <= license.warnDays
        ? { kind: "trialEnding", tone: "warn", dismissible: true }
        : { kind: "trial", tone: "info", dismissible: true };
    case "expiring":
      return {
        kind: license.license?.plan === "demo" ? "expiringDemo" : "expiring",
        tone: "warn",
        dismissible: true,
      };
    case "grace":
      return { kind: "grace", tone: "error", dismissible: false };
    case "restricted":
      return { kind: "restricted", tone: "error", dismissible: false };
    case "trial_expired":
      return { kind: "trialExpired", tone: "error", dismissible: false };
    case "wrong_host":
      return { kind: "wrongHost", tone: "warn", dismissible: false };
    case "inn_mismatch":
      return { kind: "innMismatch", tone: "error", dismissible: false };
    default:
      // `active`, and a state a newer host adds: the section names it.
      return null;
  }
}

/** The warnings of a license: its phase's, then the clock's. Nothing while all is well. */
export function licenseNotices(license: OfficeLicense): LicenseNotice[] {
  const notices: LicenseNotice[] = [];
  const phase = phaseNotice(license);
  if (phase !== null) notices.push(phase);
  if (license.flags.clockBehindDays !== null) {
    notices.push({ kind: "clockBehind", tone: "warn", dismissible: true });
  }
  if (license.flags.clockAhead) {
    notices.push({ kind: "clockAhead", tone: "warn", dismissible: true });
  }
  return notices;
}

/** Whether the warning writes a date, so the organization's zone has to be read for it. */
export function noticeNeedsTime(notice: LicenseNotice): boolean {
  return (
    notice.kind === "trialEnding" ||
    notice.kind === "expiring" ||
    notice.kind === "expiringDemo" ||
    notice.kind === "grace"
  );
}

/** The words of a warning, its dates in `zone`. */
export function noticeText(
  notice: LicenseNotice,
  license: OfficeLicense,
  zone: string | null,
): LicenseText {
  const key = `office.banner.license.${notice.kind}`;
  const dayMonth = (end: string | null | undefined) =>
    end === null || end === undefined ? "—" : licenseDayMonth(lastMomentBefore(end), zone);
  switch (notice.kind) {
    case "trial":
      return { key, values: { n: license.daysLeft ?? 0 } };
    case "trialEnding":
      return { key, values: { date: dayMonth(license.trial?.endsAt) } };
    case "expiring":
    case "expiringDemo":
      return {
        key,
        values: {
          date:
            license.license === null
              ? "—"
              : licenseDay(lastMomentBefore(license.license.validUntil), zone),
        },
      };
    case "grace":
      return {
        key,
        values: {
          expired: dayMonth(license.license?.validUntil),
          until: dayMonth(license.phaseEndsAt),
        },
      };
    case "clockBehind":
      return { key, values: { n: license.flags.clockBehindDays ?? 0 } };
    default:
      return { key };
  }
}

/** The first eight characters of a license's id, never the whole id; «—» for anything else. */
export function shortLicenseId(id: string): string {
  return UUID.test(id) ? id.slice(0, 8).toLowerCase() : "—";
}
```

Правка `apps/standalone/src/office/office-query.ts`, фрагмент:

<!-- prettier-ignore -->
```ts
  /** The copies of the database in both folders (plan РК). */
  backups: ["office", "backups"],
```

заменить на:

<!-- prettier-ignore -->
```ts
  /** The copies of the database in both folders (plan РК). */
  backups: ["office", "backups"],
  /** The site's license as the host computes it (`GET /v1/office/license`, plan ЛЦ-3). */
  license: ["office", "license"],
```

Правка `apps/standalone/src/office/access.ts`, фрагмент:

<!-- prettier-ignore -->
```ts
  /** «Сделать копию сейчас», the second folder of copies and resuming the stations' facts (plan РК); every role reads them. */
  manageBackups: ["admin"],
```

заменить на:

<!-- prettier-ignore -->
```ts
  /** «Сделать копию сейчас», the second folder of copies and resuming the stations' facts (plan РК); every role reads them. */
  manageBackups: ["admin"],
  /** Loading a license file, the activation request and the emergency extension (plan ЛЦ-3); every role reads the license. */
  manageLicense: ["admin"],
```

Правка `apps/standalone/test/support/office.tsx`: импорт

<!-- prettier-ignore -->
```ts
import { HEALTHY_BACKUPS } from "./backups.js";
```

заменить на:

<!-- prettier-ignore -->
```ts
import { HEALTHY_BACKUPS } from "./backups.js";
import { ACTIVE_LICENSE } from "./license.js";
```

и строку, которую добавил ЛЦ-2:

<!-- prettier-ignore -->
```ts
    getLicense: vi.fn<HostApi["getLicense"]>(() => unexpected("getLicense")),
```

заменить на:

<!-- prettier-ignore -->
```ts
    // The banner and «Обзор» read the license on every office test: a valid one warns of nothing.
    getLicense: vi.fn<HostApi["getLicense"]>(async () => ACTIVE_LICENSE),
```

Правка `apps/standalone/src/i18n/ru.json`: в объект `office.about.license` (рядом с `title` и `notConnected`, которые остаются до задачи 6) добавить:

<!-- prettier-ignore -->
```json
"state": {
  "trial": "Пробный период",
  "active": "Действует",
  "demo": "Демо-лицензия",
  "expiring": "Заканчивается",
  "grace": "Льготный срок",
  "restricted": "Ограничена: новые смены не открываются",
  "trial_expired": "Пробный период закончился: новые смены не открываются",
  "wrong_host": "Выдана другому хосту",
  "inn_mismatch": "ИНН организации не совпадает с лицензией",
  "unknown": "Неизвестное состояние лицензии ({{state}})"
},
"terms": {
  "trial": "Пробный период до {{date}} включительно.",
  "validThrough": "Действует по {{date}} включительно.",
  "demo": "Демо-лицензия до {{date}} включительно. По окончании демо новые смены не откроются.",
  "grace": "Срок лицензии истёк {{expired}}. Новые смены открываются до {{until}} включительно.",
  "wrongHost": "Всё работает до {{date}} включительно; затем новые смены не будут открываться.",
  "wrongHostNoDate": "Пока всё работает; через 30 дней после обнаружения новые смены перестанут открываться.",
  "blockedSince": "Новые смены не открываются с {{date}}.",
  "daysLeft": "Осталось {{n}} дн.",
  "emergency": "Аварийное продление: новые смены открываются до {{until}}."
},
"quotas": {
  "stations": "Станции и ТСД",
  "cabinetUsers": "Пользователи офиса",
  "lines": "Линии",
  "kiosks": "Киоски"
},
"features": {
  "labelEditor": "Редактор шаблонов этикеток",
  "publicApi": "Открытый API",
  "pallets": "Паллеты",
  "chzIntegration": "Обмен с Честным ЗНАКом",
  "inventory": "Инвентаризация",
  "commerceMl": "Обмен с 1С (CommerceML)",
  "handheld": "ТСД",
  "on": "включено",
  "off": "выключено"
},
"plans": {
  "trial": "Пробный период",
  "demo": "Демо-лицензия",
  "subscription": "Подписка",
  "other": "{{plan}}"
}
```

и в объект `office` новый ключ `banner`:

<!-- prettier-ignore -->
```json
"banner": {
  "license": {
    "trial": "Пробный период: осталось {{n}} дн. Загрузите файл лицензии в разделе «Информация».",
    "trialEnding": "Пробный период заканчивается {{date}}. После этого новые смены не будут открываться без файла лицензии.",
    "expiring": "Лицензия заканчивается {{date}}. Чтобы продлить, свяжитесь с Маркиро.",
    "expiringDemo": "Демо-лицензия заканчивается {{date}}. По окончании демо новые смены не откроются; чтобы оформить подписку, свяжитесь с Маркиро.",
    "grace": "Срок лицензии истёк {{expired}}. До {{until}} всё работает; затем новые смены не будут открываться.",
    "restricted": "Новые смены не открываются: лицензия площадки истекла. Начатые смены можно продолжать и закрывать, данные и выгрузки доступны.",
    "trialExpired": "Новые смены не открываются: пробный период закончился. Начатые смены можно продолжать и закрывать, данные и выгрузки доступны.",
    "wrongHost": "Лицензия выдана другому хосту. Сохраните запрос на активацию и отправьте его в Маркиро.",
    "innMismatch": "Новые смены не открываются: ИНН организации больше не совпадает с ИНН лицензии. Верните ИНН в «Профиле организации» или загрузите файл лицензии для нового ИНН.",
    "clockBehind": "Часы ПК хоста отстают от последнего известного времени на {{n}} дн. Проверьте дату и время Windows.",
    "clockAhead": "Часы ПК хоста ушли вперёд больше чем на 400 дней: лицензия считается по последнему известному времени. Проверьте дату и время Windows.",
    "tone": {
      "info": "Сведения:",
      "warn": "Внимание:",
      "error": "Ошибка:"
    },
    "link": "Открыть раздел «Лицензия»",
    "dismiss": "Скрыть до конца сеанса"
  }
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/license-dates.test.ts test/license-view.test.ts test/license-protocol.test.ts test/about-page.test.tsx test/office.test.tsx
```

Ожидается: PASS. `about-page` и `office` не изменились: `getLicense` ещё никто не читает; `license-protocol.test.ts` — тест ЛЦ-2, он не меняется.

- [ ] **Step 5: Гейты и коммит**

<!-- prettier-ignore -->
```bash
node_modules/.bin/prettier --ignore-path .prettierignore --write apps/standalone/src/lib/license-dates.ts apps/standalone/src/office/info/license/license-view.ts apps/standalone/src/office/office-query.ts apps/standalone/src/office/access.ts apps/standalone/src/i18n/ru.json apps/standalone/test/support/license.ts apps/standalone/test/support/office.tsx apps/standalone/test/license-dates.test.ts apps/standalone/test/license-view.test.ts
node_modules/.bin/prettier --ignore-path .prettierignore --check apps/standalone/src/lib/license-dates.ts apps/standalone/src/office/info/license/license-view.ts apps/standalone/src/office/office-query.ts apps/standalone/src/office/access.ts apps/standalone/src/i18n/ru.json apps/standalone/test/support/license.ts apps/standalone/test/support/office.tsx apps/standalone/test/license-dates.test.ts apps/standalone/test/license-view.test.ts
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint
git diff --check
```

Сообщение (`/tmp/claude/lc3-t2-msg.txt`):

<!-- prettier-ignore -->
```text
feat(standalone): the license's view model for the office (plan ЛЦ-3)

States in words and tones (a newer host's state named as it is), terms
with the last day inclusive in the organization's zone, seats and
features, and the banner's warnings with the 4-day trial warning and the
host's clock; test licenses and the office's silent default.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

<!-- prettier-ignore -->
```bash
git add apps/standalone/src/lib/license-dates.ts apps/standalone/src/office/info/license/license-view.ts apps/standalone/src/office/office-query.ts apps/standalone/src/office/access.ts apps/standalone/src/i18n/ru.json apps/standalone/test/support/license.ts apps/standalone/test/support/office.tsx apps/standalone/test/license-dates.test.ts apps/standalone/test/license-view.test.ts
git commit -F /tmp/claude/lc3-t2-msg.txt
```

---

### Task 3: Раздел «Лицензия» вместо заглушки: состояние, сроки, места, возможности, привязка

**Files:**

- Modify: `apps/standalone/src/office/info/LicenseSection.tsx`, `apps/standalone/src/app/shell.css`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/license-section.test.tsx` (новый), `apps/standalone/test/about-page.test.tsx`

**Interfaces:**

- Consumes: `officeKeys.license`, `useOfficeQuery`, `useBackupTime` (пояс организации, `ready`), `useCan("manageLicense")`, `copyText` (`src/office/info/clipboard.ts`, каркас), `stateText`, `planText`, `stateTone`, `licenseTerms`, `quotaRows`, `featureRows`, `shortLicenseId`; `@markiro/ui`: `Alert`, `Badge`, `Button`, `Card`, `DefinitionGrid`, `Table`.
- Produces: `LicenseSection` (тот же экспорт, то же место в `ABOUT_SECTIONS`), внутренний `LicenseBody` со слотом действий администратора (`{admin ? null : …}` — задачи 4 и 5 ставят туда `LicenseLoad` и `LicenseActions`); классы `license-state`, `license-part`, `license-features`.

- [ ] **Step 1: Написать падающие тесты**

Создать `apps/standalone/test/license-section.test.tsx`:

```tsx
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HostError } from "../src/host/client.js";
import type { OfficeLicense } from "../src/host/protocol.js";
import { HOST_ID } from "./support/fixtures.js";
import {
  ACTIVE_LICENSE,
  DEMO,
  EXPIRING,
  GRACE,
  HOST_FINGERPRINT,
  INN_MISMATCH,
  licenseOf,
  RESTRICTED,
  TRIAL,
  TRIAL_EXPIRED,
  WRONG_HOST,
} from "./support/license.js";
import { fakeOfficeFiles, type FakeOfficeFiles } from "./support/office-files.js";
import {
  fakeHostApi,
  fakeOfficeSession,
  ORG_PROFILE,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});

/** An office session whose host answers `license`, in an organization of Moscow. */
function sessionWith(
  license: OfficeLicense = ACTIVE_LICENSE,
  options: { technologist?: boolean } = {},
): FakeOfficeSession {
  const api = fakeHostApi();
  api.getLicense.mockResolvedValue(license);
  api.getOrg.mockResolvedValue(ORG_PROFILE);
  return fakeOfficeSession({
    api,
    ...(options.technologist === true ? { user: TECHNOLOGIST } : {}),
  });
}

/** «Информация» opened from the office's menu, and its license card once it has loaded. */
async function openLicense(
  session: FakeOfficeSession,
  files: FakeOfficeFiles = fakeOfficeFiles(),
): Promise<HTMLElement> {
  renderOffice(session, { files });
  const nav = await screen.findByRole("navigation", { name: "Разделы офиса" });
  fireEvent.click(within(nav).getByRole("link", { name: "Информация" }));
  const heading = await screen.findByRole("heading", { name: "Лицензия", level: 2 });
  const card = heading.closest(".mk-card");
  if (!(card instanceof HTMLElement)) throw new Error("no license card");
  await waitFor(() => expect(within(card).queryByRole("status")).toBeNull());
  return card;
}

/** The description of a term in the card's definition grid. */
function described(card: HTMLElement, term: string): string {
  const dt = within(card).getByText(term, { selector: "dt" });
  return dt.nextElementSibling?.textContent ?? "";
}

/** The cells of a table's body rows. */
function rowsOf(table: HTMLElement): string[][] {
  return Array.from(table.querySelectorAll("tbody tr")).map((row) =>
    Array.from(row.querySelectorAll("td")).map((cell) => cell.textContent ?? ""),
  );
}

describe("«Лицензия» on «Информация»", () => {
  it("shows a valid subscription: the state, the term, the seats, the features and the binding", async () => {
    const card = await openLicense(sessionWith());
    const state = card.querySelector(".license-state");
    expect(state?.classList.contains("mk-alert--ok")).toBe(true);
    expect(within(card).getByText("Действует")).toBeTruthy();
    expect(within(card).getByText("Действует по 31.10.2027 включительно.")).toBeTruthy();
    expect(rowsOf(within(card).getByRole("region", { name: "Рабочие места" }))).toEqual([
      ["Станции и ТСД", "3", "5", "в пределах лицензии"],
      ["Пользователи офиса", "2", "3", "в пределах лицензии"],
      ["Линии", "1", "2", "в пределах лицензии"],
    ]);
    const features = within(card).getByRole("region", { name: "Возможности" });
    expect(
      within(features)
        .getAllByRole("listitem")
        .map((item) => [
          item.querySelector("span")?.textContent,
          item.querySelector(".mk-badge")?.textContent,
        ]),
    ).toEqual([
      ["Редактор шаблонов этикеток", "включено"],
      ["Открытый API", "выключено"],
      ["Паллеты", "включено"],
      ["Обмен с Честным ЗНАКом", "включено"],
      ["Инвентаризация", "выключено"],
      ["Обмен с 1С (CommerceML)", "выключено"],
      ["ТСД", "включено"],
    ]);
    expect(described(card, "Клиент в лицензии")).toBe("ООО «Атолл»");
    expect(described(card, "ИНН в лицензии")).toBe("7707083893");
    expect(described(card, "ИНН организации в программе")).toBe("7707083893 — совпадает");
    expect(described(card, "Идентификатор хоста")).toBe(HOST_ID);
    expect(described(card, "Отпечаток сертификата хоста")).toBe(HOST_FINGERPRINT);
    expect(described(card, "Файл лицензии")).toBe("№ 3, 5b1d7c2e");
    expect(described(card, "Вид")).toBe("Подписка");
    expect(
      within(card).getByText("Сохраните файл лицензии вместе с документами договора."),
    ).toBeTruthy();
    expect(within(card).queryByText(/может администратор/)).toBeNull();
  });

  it.each([
    [TRIAL, "Пробный период", "mk-alert--info", "Пробный период до 24.10.2026 включительно."],
    [
      DEMO,
      "Демо-лицензия",
      "mk-alert--ok",
      "Демо-лицензия до 03.11.2026 включительно. По окончании демо новые смены не откроются.",
    ],
    [EXPIRING, "Заканчивается", "mk-alert--warn", "Осталось 20 дн."],
    [
      GRACE,
      "Льготный срок",
      "mk-alert--error",
      "Срок лицензии истёк 31.10. Новые смены открываются до 14.11.2027 включительно.",
    ],
    [
      RESTRICTED,
      "Ограничена: новые смены не открываются",
      "mk-alert--error",
      "Новые смены не открываются с 15.11.2027.",
    ],
    [
      TRIAL_EXPIRED,
      "Пробный период закончился: новые смены не открываются",
      "mk-alert--error",
      "Новые смены не открываются с 24.10.2026.",
    ],
    [
      WRONG_HOST,
      "Выдана другому хосту",
      "mk-alert--warn",
      "Всё работает до 19.11.2026 включительно; затем новые смены не будут открываться.",
    ],
  ] as const)(
    "says each state in words, with a tone and its term (%#)",
    async (license, word, tone, term) => {
      const card = await openLicense(sessionWith(license));
      const state = card.querySelector(".license-state");
      expect(state?.classList.contains(tone)).toBe(true);
      expect(within(card).getByText(word)).toBeTruthy();
      expect(within(card).getByText(term)).toBeTruthy();
    },
  );

  it("explains an INN that no longer matches, with both numbers", async () => {
    const card = await openLicense(sessionWith(INN_MISMATCH));
    expect(
      within(card).getByText(
        "ИНН организации (7802000015) больше не совпадает с ИНН лицензии (7707083893). Новые смены не открываются. Верните ИНН в «Профиле организации» или загрузите файл лицензии для нового ИНН.",
      ),
    ).toBeTruthy();
    expect(described(card, "ИНН организации в программе")).toBe("7802000015 — не совпадает");
  });

  it("says in words, not only in colour, that more seats are used than the license gives", async () => {
    const over = licenseOf({
      quotas: { ...ACTIVE_LICENSE.quotas, stations: { limit: 3, used: 5, over: true } },
    });
    const card = await openLicense(sessionWith(over));
    const table = within(card).getByRole("region", { name: "Рабочие места" });
    expect(rowsOf(table)[0]).toEqual([
      "Станции и ТСД",
      "5",
      "3",
      "превышено: новые не подключатся",
    ]);
    expect(within(card).getByText(/новые не подключатся, пока лишние не отозваны/)).toBeTruthy();
  });

  it("writes «без ограничения» for a quota without a limit", async () => {
    const card = await openLicense(sessionWith(TRIAL));
    expect(rowsOf(within(card).getByRole("region", { name: "Рабочие места" }))[0]).toEqual([
      "Станции и ТСД",
      "1",
      "без ограничения",
      "в пределах лицензии",
    ]);
    expect(described(card, "Файл лицензии")).toBe("файл лицензии не загружен");
  });

  it("asks for the organization's INN when the site has none", async () => {
    const card = await openLicense(
      sessionWith(
        licenseOf({ binding: { ...ACTIVE_LICENSE.binding, orgInn: null, innMatches: null } }),
      ),
    );
    expect(within(card).getByText(/Укажите ИНН организации в «Профиле организации»/)).toBeTruthy();
    expect(
      within(card)
        .getByRole("link", { name: "Открыть «Профиль организации»" })
        .getAttribute("href"),
    ).toBe("/org");
    expect(described(card, "ИНН организации в программе")).toBe("не указан");
  });

  it("shows the technologist everything but the actions", async () => {
    const card = await openLicense(sessionWith(ACTIVE_LICENSE, { technologist: true }));
    expect(within(card).getByText("Действует")).toBeTruthy();
    expect(
      within(card)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Скопировать идентификатор хоста"]);
    expect(within(card).getByText(/может администратор/)).toBeTruthy();
  });

  it("copies the host's id whole, and says so", async () => {
    const card = await openLicense(sessionWith());
    fireEvent.click(within(card).getByRole("button", { name: "Скопировать идентификатор хоста" }));
    expect(await within(card).findByText("Идентификатор хоста скопирован.")).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith(HOST_ID);
  });

  it("explains a host that does not answer in the section alone, and reads again", async () => {
    const session = sessionWith();
    // Every read fails until the retry: the band and «Обзор» (task 7) read the same license.
    session.api.getLicense.mockRejectedValue(
      new HostError({ kind: "transport", code: "unreachable", message: "down" }),
    );
    const card = await openLicense(session);
    expect(screen.getByRole("heading", { name: "Контакты и поддержка", level: 2 })).toBeTruthy();
    session.api.getLicense.mockResolvedValue(ACTIVE_LICENSE);
    fireEvent.click(within(card).getByRole("button", { name: "Повторить" }));
    expect(await within(card).findByText("Действует")).toBeTruthy();
  });
});
```

Правка `apps/standalone/test/about-page.test.tsx`.

Фрагмент 1 (импорты):

<!-- prettier-ignore -->
```tsx
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
```

Фрагмент 2 (в `renderAbout`):

<!-- prettier-ignore -->
```tsx
              <AboutProvider value={about}>
                <AboutPage />
              </AboutProvider>
```

заменить на:

<!-- prettier-ignore -->
```tsx
              <AboutProvider value={about}>
                {/* «Лицензия» links to the organization's profile (plan ЛЦ-3). */}
                <MemoryRouter>
                  <AboutPage />
                </MemoryRouter>
              </AboutProvider>
```

Фрагмент 3 (тест заглушки заменяется более строгим — раздел больше не заглушка):

<!-- prettier-ignore -->
```tsx
  it("keeps the license a placeholder: no license logic, only the empty state", async () => {
    renderAbout(fakeAbout());
    const license = card("Лицензия");
    expect(within(license).getByText("Лицензирование ещё не подключено")).toBeTruthy();
    expect(within(license).queryAllByRole("button")).toHaveLength(0);
    expect(within(license).queryAllByRole("textbox")).toHaveLength(0);
  });
```

заменить на:

<!-- prettier-ignore -->
```tsx
  it("shows the license the host computed in its section, no longer a placeholder", async () => {
    const { session } = renderAbout(fakeAbout());
    const license = card("Лицензия");
    expect(await within(license).findByText("Действует")).toBeTruthy();
    expect(within(license).queryByText("Лицензирование ещё не подключено")).toBeNull();
    expect(session.api.getLicense).toHaveBeenCalled();
    expect(within(license).queryAllByRole("textbox")).toHaveLength(0);
  });
```

- [ ] **Step 2: Убедиться, что тесты падают**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/license-section.test.tsx test/about-page.test.tsx
```

Ожидается: FAIL — раздел показывает «Лицензирование ещё не подключено», `getLicense` не вызывается.

- [ ] **Step 3: Реализация**

Заменить `apps/standalone/src/office/info/LicenseSection.tsx` целиком:

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import {
  Alert,
  Badge,
  Button,
  Card,
  DefinitionGrid,
  Table,
  type DefinitionGridItem,
  type TableColumn,
} from "@markiro/ui";

import type { OfficeLicense } from "../../host/protocol.js";
import { useCan } from "../access.js";
import { useBackupTime } from "../backups/backup-time.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading } from "../page-state.js";
import { copyText } from "./clipboard.js";
import {
  featureRows,
  licenseTerms,
  quotaRows,
  planText,
  shortLicenseId,
  stateText,
  stateTone,
  type QuotaRow,
} from "./license/license-view.js";

/**
 * «Лицензия» (license spec §9.2): the state the host computed, in words and
 * with the alert's glyph, the terms in the organization's zone, the seats
 * used of what the license gives, the features, and what binds the file to
 * this site. Every role reads it; the actions are the administrator's. A
 * host that does not answer is this section's error alone: the page stands.
 */
export function LicenseSection() {
  const { t } = useTranslation();
  const license = useOfficeQuery(officeKeys.license, (api, token) => api.getLicense(token));
  const time = useBackupTime(license.isSuccess);
  return (
    <Card title={t("office.about.license.title")} titleAs="h2">
      {license.isError ? (
        <LoadError error={license.error} onRetry={() => void license.refetch()} />
      ) : license.isSuccess && time.ready ? (
        <LicenseBody license={license.data} zone={time.zone} />
      ) : (
        <PageLoading />
      )}
    </Card>
  );
}

function LicenseBody({ license, zone }: { license: OfficeLicense; zone: string | null }) {
  const { t } = useTranslation();
  const admin = useCan("manageLicense");
  const state = stateText(license);
  return (
    <div className="standalone-form">
      <Alert
        className="license-state"
        tone={stateTone(license.state)}
        role="presentation"
        title={t(state.key, state.values)}
      >
        {licenseTerms(license, zone).map((term) => (
          <p key={term.key}>{t(term.key, term.values)}</p>
        ))}
      </Alert>
      {license.state === "inn_mismatch" && (
        <Alert tone="error" role="presentation">
          {t("office.about.license.innState", {
            orgInn: license.binding.orgInn ?? "—",
            fileInn: license.license?.customer.inn ?? "—",
          })}
        </Alert>
      )}
      {license.binding.orgInn === null && (
        <Alert tone="warn" role="presentation">
          {t("office.about.license.innNeeded")}{" "}
          <Link to="/org">{t("office.about.license.orgLink")}</Link>
        </Alert>
      )}
      <LicenseSeats rows={quotaRows(license)} />
      <LicenseFeatures license={license} />
      <LicenseBinding license={license} />
      {admin ? null : <p className="office-note">{t("office.about.license.readOnly")}</p>}
      <p className="office-note">{t("office.about.license.keepFile")}</p>
    </div>
  );
}

/** «Рабочие места»: used and given by quota, «без ограничения» for none, a row over its limit in words. */
function LicenseSeats({ rows }: { rows: QuotaRow[] }) {
  const { t } = useTranslation();
  const columns: TableColumn<QuotaRow>[] = [
    {
      key: "what",
      title: t("office.about.license.seats.what"),
      render: (row) => t(`office.about.license.quotas.${row.key}`),
    },
    {
      key: "used",
      title: t("office.about.license.seats.used"),
      align: "right",
      mono: true,
      render: (row) => String(row.used),
    },
    {
      key: "limit",
      title: t("office.about.license.seats.limit"),
      align: "right",
      render: (row) =>
        row.limit === null ? t("office.about.license.seats.unlimited") : String(row.limit),
    },
    {
      key: "state",
      title: t("office.about.license.seats.state"),
      wrap: true,
      render: (row) =>
        row.over ? (
          <Badge tone="error" wrap>
            {t("office.about.license.seats.over")}
          </Badge>
        ) : (
          t("office.about.license.seats.fits")
        ),
    },
  ];
  return (
    <section className="license-part" aria-label={t("office.about.license.seats.title")}>
      <h3>{t("office.about.license.seats.title")}</h3>
      <Table
        columns={columns}
        rows={rows}
        getRowKey={(row) => row.key}
        empty={t("office.about.license.seats.empty")}
      />
      {rows.some((row) => row.over) && (
        <p className="office-note">{t("office.about.license.seats.overNote")}</p>
      )}
    </section>
  );
}

/** «Возможности»: each feature of the license with «включено» or «выключено» in words. */
function LicenseFeatures({ license }: { license: OfficeLicense }) {
  const { t } = useTranslation();
  return (
    <section className="license-part" aria-label={t("office.about.license.featuresTitle")}>
      <h3>{t("office.about.license.featuresTitle")}</h3>
      <ul className="license-features">
        {featureRows(license).map((row) => (
          <li key={row.key}>
            <span>{t(`office.about.license.features.${row.key}`)}</span>
            <Badge tone={row.on ? "ok" : "neutral"}>
              {t(row.on ? "office.about.license.features.on" : "office.about.license.features.off")}
            </Badge>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** «Организация и привязка»: the file's customer and INN, the site's INN, the host and the file. */
function LicenseBinding({ license }: { license: OfficeLicense }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  const file = license.license;
  const { orgInn, innMatches, hostId, fingerprint } = license.binding;
  const items: DefinitionGridItem[] = [];
  if (file !== null) {
    items.push(
      {
        id: "customer",
        term: t("office.about.license.binding.customer"),
        description: file.customer.name,
      },
      {
        id: "fileInn",
        term: t("office.about.license.binding.fileInn"),
        description: file.customer.inn,
        mono: true,
      },
    );
  }
  items.push(
    {
      id: "orgInn",
      term: t("office.about.license.binding.orgInn"),
      description:
        orgInn === null
          ? t("office.about.license.binding.innMissing")
          : innMatches === false
            ? t("office.about.license.binding.innDiffers", { inn: orgInn })
            : innMatches === true
              ? t("office.about.license.binding.innMatches", { inn: orgInn })
              : orgInn,
    },
    {
      id: "hostId",
      term: t("office.about.license.binding.hostId"),
      description: hostId,
      mono: true,
    },
    {
      id: "fingerprint",
      term: t("office.about.license.binding.fingerprint"),
      description: fingerprint,
      mono: true,
    },
    {
      id: "file",
      term: t("office.about.license.binding.file"),
      description:
        file === null
          ? t("office.about.license.binding.noFile")
          : t("office.about.license.binding.fileValue", {
              sequence: file.sequence,
              id: shortLicenseId(file.licenseId),
            }),
    },
  );
  if (file !== null) {
    items.push({
      id: "plan",
      term: t("office.about.license.binding.plan"),
      description: t(planText(file.plan).key, planText(file.plan).values),
    });
  }
  const copy = async () => {
    setCopied(null);
    setCopied((await copyText(hostId)) ? "copied" : "failed");
  };
  return (
    <section className="license-part" aria-label={t("office.about.license.binding.title")}>
      <h3>{t("office.about.license.binding.title")}</h3>
      <DefinitionGrid items={items} />
      <div className="standalone-form__actions">
        <Button variant="secondary" size="compact" onClick={() => void copy()}>
          {t("office.about.license.copyHostId")}
        </Button>
      </div>
      <div aria-live="polite">
        {copied === "copied" && (
          <Alert tone="ok" role="presentation">
            {t("office.about.license.copied")}
          </Alert>
        )}
        {copied === "failed" && (
          <Alert tone="warn" role="presentation">
            {t("office.about.license.copyFailed")}
          </Alert>
        )}
      </div>
    </section>
  );
}
```

Правка `apps/standalone/src/app/shell.css`: после блока `.office-toc a { … }` (каркас `fb-about`) добавить:

<!-- prettier-ignore -->
```css
/* The license section (plan ЛЦ-3): its parts one under another, each feature as its name and a word. */
.license-part {
  display: grid;
  gap: 8px;
}

.license-part h3,
.license-part h4 {
  margin: 0;
  font-weight: 600;
}

.license-features {
  display: grid;
  gap: 6px;
  max-width: 480px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.license-features li {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
}
```

Правка `apps/standalone/src/i18n/ru.json`: в объект `office.about.license` добавить:

<!-- prettier-ignore -->
```json
"seats": {
  "title": "Рабочие места",
  "what": "Что",
  "used": "Использовано",
  "limit": "Доступно",
  "state": "Состояние",
  "unlimited": "без ограничения",
  "fits": "в пределах лицензии",
  "over": "превышено: новые не подключатся",
  "overNote": "Использовано больше, чем разрешает лицензия: новые не подключатся, пока лишние не отозваны. Работающие продолжают работать.",
  "empty": "Нет данных о рабочих местах"
},
"featuresTitle": "Возможности",
"binding": {
  "title": "Организация и привязка",
  "customer": "Клиент в лицензии",
  "fileInn": "ИНН в лицензии",
  "orgInn": "ИНН организации в программе",
  "innMatches": "{{inn}} — совпадает",
  "innDiffers": "{{inn}} — не совпадает",
  "innMissing": "не указан",
  "hostId": "Идентификатор хоста",
  "fingerprint": "Отпечаток сертификата хоста",
  "file": "Файл лицензии",
  "fileValue": "№ {{sequence}}, {{id}}",
  "noFile": "файл лицензии не загружен",
  "plan": "Вид"
},
"copyHostId": "Скопировать идентификатор хоста",
"copied": "Идентификатор хоста скопирован.",
"copyFailed": "Не удалось скопировать: выделите идентификатор вручную.",
"innState": "ИНН организации ({{orgInn}}) больше не совпадает с ИНН лицензии ({{fileInn}}). Новые смены не открываются. Верните ИНН в «Профиле организации» или загрузите файл лицензии для нового ИНН.",
"innNeeded": "Укажите ИНН организации в «Профиле организации»: лицензия выдаётся на ИНН.",
"orgLink": "Открыть «Профиль организации»",
"readOnly": "Загружать файл лицензии, сохранять запрос на активацию и включать аварийное продление может администратор.",
"keepFile": "Сохраните файл лицензии вместе с документами договора."
```

- [ ] **Step 4: Убедиться, что тесты проходят**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/license-section.test.tsx test/about-page.test.tsx test/support-report.test.ts --reporter=verbose
```

Ожидается: PASS, в выводе нет `stderr |`. `support-report.test.ts` ещё ждёт строку «Лицензия: Лицензирование ещё не подключено» — она остаётся до задачи 6.

- [ ] **Step 5: Гейты и коммит**

<!-- prettier-ignore -->
```bash
node_modules/.bin/prettier --ignore-path .prettierignore --write apps/standalone/src/office/info/LicenseSection.tsx apps/standalone/src/app/shell.css apps/standalone/src/i18n/ru.json apps/standalone/test/license-section.test.tsx apps/standalone/test/about-page.test.tsx
node_modules/.bin/prettier --ignore-path .prettierignore --check apps/standalone/src/office/info/LicenseSection.tsx apps/standalone/src/app/shell.css apps/standalone/src/i18n/ru.json apps/standalone/test/license-section.test.tsx apps/standalone/test/about-page.test.tsx
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint
git diff --check
```

Сообщение (`/tmp/claude/lc3-t3-msg.txt`):

<!-- prettier-ignore -->
```text
feat(standalone): «Лицензия» on «Информация» shows the host's license (plan ЛЦ-3)

The placeholder gives way to the state in words, the terms in the
organization's zone, the seats used of the license's, the features and
the binding with a copy of the host's id; the technologist reads it all.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

<!-- prettier-ignore -->
```bash
git add apps/standalone/src/office/info/LicenseSection.tsx apps/standalone/src/app/shell.css apps/standalone/src/i18n/ru.json apps/standalone/test/license-section.test.tsx apps/standalone/test/about-page.test.tsx
git commit -F /tmp/claude/lc3-t3-msg.txt
```

---

### Task 4: Загрузка файла лицензии с предпросмотром «было → станет»

**Files:**

- Create: `apps/standalone/src/office/info/license/license-load.ts`, `apps/standalone/src/office/info/license/LicenseLoad.tsx`
- Modify: `apps/standalone/src/office/info/LicenseSection.tsx`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/license-load.test.ts` (новый), `apps/standalone/test/license-section.test.tsx`

**Interfaces:**

- Consumes: `HostApi.previewLicense(token, request)`, `HostApi.loadLicense(token, request)`, `licenseLoad(file)` (`src/host/requests.ts`), `LicensePreview`, `LicenseTerms`, `OfficeLicense`, `MAX_LICENSE_FILE_BYTES`, `LICENSE_REFUSALS`, `LICENSE_FEATURE_KEYS`, `licensePreviewSchema` (ЛЦ-2), `HostError` (`field`, `details`), `errorMessageKey`, `SHOWN_QUOTAS`, `planText`, `lastMomentBefore`, `licenseDay`; `@markiro/ui`: `FileDropZone` (`data-testid="file-drop-input"`), `Table`, `Alert`, `Button`, `VisuallyHidden`.
- Produces: `LICENSE_FILE_ACCEPT = ".mklic"`, `readLicenseFile`, `loadFailureText`, `ComparisonRow`, `comparisonRows`, `overLimits`, `previewWarnings`, `loadedMessage`; компонент `LicenseLoad` в слоте администратора `LicenseBody`.

- [ ] **Step 1: Написать падающие тесты**

Создать `apps/standalone/test/license-load.test.ts`:

```ts
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import {
  licensePreviewSchema,
  MAX_LICENSE_FILE_BYTES,
  type LicensePreview,
  type LicenseTerms,
} from "../src/host/protocol.js";
import i18n from "../src/i18n/index.js";
import {
  comparisonRows,
  loadedMessage,
  loadFailureText,
  overLimits,
  previewWarnings,
  readLicenseFile,
} from "../src/office/info/license/license-load.js";
import type { LicenseText } from "../src/office/info/license/license-view.js";
import { ACTIVE_LICENSE, licenseOf, OTHER_INN } from "./support/license.js";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;
const MSK = "Europe/Moscow";
/** ЛЦ-2's preview: the trial before, a subscription after with more stations used than it gives. */
const FIRST_FILE: LicensePreview = licensePreviewSchema.parse(
  JSON.parse(
    readFileSync(new URL("../proto/fixtures/office-license-preview.json", testModuleUrl), "utf8"),
  ),
);

function said(text: LicenseText): string {
  return i18n.t(text.key, text.values);
}

function fileRefusal(details: Record<string, unknown>): HostError {
  return new HostError({
    kind: "api",
    code: "validation_failed",
    status: 400,
    message: "refused",
    details: { field: "file", ...details },
  });
}

describe("reading a license file", () => {
  it("takes the text up to the host's bound, trimmed, and refuses a larger file unread", async () => {
    await expect(
      readLicenseFile(new File(["  aGVhZA.cGF5.c2ln \r\n"], "site.mklic")),
    ).resolves.toEqual({ kind: "text", text: "aGVhZA.cGF5.c2ln" });
    await expect(
      readLicenseFile(new File(["a".repeat(MAX_LICENSE_FILE_BYTES)], "site.mklic")),
    ).resolves.toMatchObject({ kind: "text" });
    await expect(
      readLicenseFile(new File(["a".repeat(MAX_LICENSE_FILE_BYTES + 1)], "site.mklic")),
    ).resolves.toEqual({ kind: "too_large" });
  });
});

describe("a refused license file in words (spec §9.7)", () => {
  it.each([
    ["license_malformed", {}, "Это не файл лицензии Маркиро или файл повреждён."],
    [
      "license_unknown_key",
      {},
      "Файл подписан ключом, который эта версия не знает. Обновите программу или запросите файл заново.",
    ],
    [
      "license_signature",
      {},
      "Подпись файла не сходится: файл изменён после выпуска. Запросите файл заново.",
    ],
    [
      "license_wrong_host",
      { fileHostId: "9b2e4f60-1a3c-4d5e-8f70-1a2b3c4d5e6f" },
      "Файл выдан для другого хоста (9b2e4f60…). Этот хост: 3f1c2d4e… Отправьте запрос на активацию с этого ПК.",
    ],
    [
      "license_older",
      {},
      "У площадки уже есть более новый файл лицензии (№ 3). Этот файл не нужен.",
    ],
    [
      "license_inn_mismatch",
      {},
      "ИНН в файле лицензии не совпадает с ИНН организации в программе (7707083893). Исправьте ИНН в «Профиле организации» или запросите файл для этой организации.",
    ],
    [
      "license_inn_mismatch",
      { fileInn: OTHER_INN },
      "ИНН в файле лицензии (7802000015) не совпадает с ИНН организации в программе (7707083893). Исправьте ИНН в «Профиле организации» или запросите файл для этой организации.",
    ],
    [
      "license_inn_missing",
      {},
      "Укажите ИНН организации в «Профиле организации»: лицензия выдаётся на ИНН.",
    ],
    ["from_a_newer_host", {}, "Это не файл лицензии Маркиро или файл повреждён."],
  ] as const)("says %s", (reason, details, text) => {
    expect(said(loadFailureText(fileRefusal({ reason, ...details }), ACTIVE_LICENSE))).toBe(text);
  });

  it("explains anything else by its code, never as a bad file", () => {
    const limited = new HostError({ kind: "api", code: "rate_limited", status: 429, message: "x" });
    expect(loadFailureText(limited, ACTIVE_LICENSE)).toEqual({ key: "errors.api.rate_limited" });
    const transport = new HostError({ kind: "transport", code: "unreachable", message: "x" });
    expect(loadFailureText(transport, ACTIVE_LICENSE)).toEqual({
      key: "errors.transport.unreachable",
    });
    const otherField = new HostError({
      kind: "api",
      code: "validation_failed",
      status: 400,
      message: "x",
      details: { field: "body" },
    });
    expect(loadFailureText(otherField, ACTIVE_LICENSE)).toEqual({
      key: "errors.api.validation_failed",
    });
  });
});

describe("«было → станет»", () => {
  it("lists the plan, the term, the grace, the seats and the features, marked by the host's changes", () => {
    const rows = comparisonRows(FIRST_FILE, MSK);
    expect(rows.map((row) => row.id)).toEqual([
      "plan",
      "validUntil",
      "graceDays",
      "quotas.stations",
      "quotas.cabinetUsers",
      "quotas.lines",
      "features.labelEditor",
      "features.publicApi",
      "features.pallets",
      "features.chzIntegration",
      "features.inventory",
      "features.commerceMl",
      "features.handheld",
    ]);
    expect(rows.filter((row) => row.changed).map((row) => row.id)).toEqual(
      rows.map((row) => row.id).filter((id) => FIRST_FILE.changes.includes(id)),
    );
    const words = Object.fromEntries(
      rows.map((row) => [row.id, [said(row.before), said(row.after)]]),
    );
    expect(words["plan"]).toEqual(["Пробный период", "Подписка"]);
    expect(words["validUntil"]).toEqual(["20.10.2026", "20.10.2027"]);
    expect(words["quotas.stations"]).toEqual(["без ограничения", "3"]);
    expect(words["features.publicApi"]).toEqual(["включено", "выключено"]);
  });

  it("names the seats the file would leave over their limit, as the host counted them", () => {
    expect(overLimits(FIRST_FILE)).toEqual([{ key: "stations", used: 4, limit: 3 }]);
    const fits: LicensePreview = {
      ...FIRST_FILE,
      after: {
        ...FIRST_FILE.after,
        quotas: { ...FIRST_FILE.after.quotas, stations: { limit: 5, used: 4, over: false } },
      },
    };
    expect(overLimits(fits)).toEqual([]);
  });

  it("warns of a file already expired and of one not yet valid", () => {
    const after: LicenseTerms = {
      ...FIRST_FILE.after,
      validFrom: "2027-11-01T00:00:00Z",
      validUntil: "2026-09-30T21:00:00Z",
    };
    const warned: LicensePreview = { ...FIRST_FILE, after, warnings: ["expired", "not_yet_valid"] };
    expect(previewWarnings(warned, MSK).map(said)).toEqual([
      "Срок этого файла уже истёк 30.09.2026: после загрузки новые смены открываться не будут.",
      "Этот файл начнёт действовать 01.11.2027; до тех пор действует прежний.",
    ]);
    expect(previewWarnings(FIRST_FILE, MSK)).toEqual([]);
  });

  it("says what a loaded file gives, that it has already expired, or when it begins", () => {
    const loaded = FIRST_FILE.after;
    const now = licenseOf({ effectiveAt: "2026-10-20T10:00:00Z" });
    expect(said(loadedMessage(now, loaded, MSK).text)).toBe(
      "Лицензия загружена. Действует по 20.10.2027 включительно.",
    );
    expect(loadedMessage(now, loaded, MSK).tone).toBe("ok");
    const later = licenseOf({ effectiveAt: "2027-12-01T09:00:00Z" });
    expect(loadedMessage(later, loaded, MSK)).toEqual({
      tone: "warn",
      text: { key: "office.about.license.load.loadedExpired", values: { date: "20.10.2027" } },
    });
    const early = licenseOf({ effectiveAt: "2026-10-01T09:00:00Z" });
    expect(said(loadedMessage(early, loaded, MSK).text)).toBe(
      "Лицензия загружена и начнёт действовать 20.10.2026.",
    );
  });
});
```

Дописать в `apps/standalone/test/license-section.test.tsx`: импорт

<!-- prettier-ignore -->
```tsx
import type { OfficeLicense } from "../src/host/protocol.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import type { LicensePreview, LicenseTerms, OfficeLicense } from "../src/host/protocol.js";
```

и в конец файла:

<!-- prettier-ignore -->
```tsx
/** The terms of `license`'s file, as the preview answers them. */
function termsOf(license: OfficeLicense): LicenseTerms {
  const file = license.license;
  if (file === null) throw new Error("the fixture has a file");
  return {
    licenseId: file.licenseId,
    sequence: file.sequence,
    plan: file.plan,
    validFrom: file.validFrom,
    validUntil: file.validUntil,
    graceDays: file.graceDays,
    quotas: license.quotas,
    features: license.features,
  };
}

/** The next file: a year more and 8 stations. */
function upgradePreview(): LicensePreview {
  const before = termsOf(ACTIVE_LICENSE);
  return {
    before,
    after: {
      ...before,
      licenseId: "9c8b7a6f-5e4d-4c3b-8a29-1f0e9d8c7b6a",
      sequence: 4,
      validUntil: "2028-10-31T21:00:00Z",
      quotas: { ...before.quotas, stations: { limit: 8, used: 3, over: false } },
    },
    changes: ["validUntil", "quotas.stations"],
    warnings: [],
  };
}

const UPGRADED = licenseOf({
  license: { ...ACTIVE_LICENSE.license!, sequence: 4, validUntil: "2028-10-31T21:00:00Z" },
  quotas: { ...ACTIVE_LICENSE.quotas, stations: { limit: 8, used: 3, over: false } },
});

function pick(card: HTMLElement, file: File): void {
  fireEvent.change(within(card).getByTestId("file-drop-input"), { target: { files: [file] } });
}

const FILE_TEXT = "eyJ0eXAiOiJtYXJraXJvIn0.eyJ2ZXJzaW9uIjoxfQ.c2ln";

describe("loading a license file", () => {
  it("checks the file first, shows «было → станет», then loads it and says till when it runs", async () => {
    const session = sessionWith();
    session.api.previewLicense.mockResolvedValue(upgradePreview());
    session.api.loadLicense.mockResolvedValue(UPGRADED);
    const card = await openLicense(session);
    pick(card, new File([`${FILE_TEXT}\n`], "site.mklic"));
    const preview = await within(card).findByRole("region", { name: "Было → станет" });
    expect(session.api.previewLicense.mock.calls[0]?.[1]).toEqual({ file: FILE_TEXT });
    expect(session.api.loadLicense).not.toHaveBeenCalled();
    const stations = rowsOf(preview).find((row) => row[0] === "Станции и ТСД");
    expect(stations).toEqual(["Станции и ТСД", "5", "8 (изменится)"]);
    fireEvent.click(within(preview).getByRole("button", { name: "Загрузить" }));
    expect(
      await within(card).findByText("Лицензия загружена. Действует по 31.10.2028 включительно."),
    ).toBeTruthy();
    expect(session.api.loadLicense.mock.calls[0]?.[1]).toEqual({ file: FILE_TEXT });
    expect(within(card).queryByRole("region", { name: "Было → станет" })).toBeNull();
    expect(within(card).getByText("Действует по 31.10.2028 включительно.")).toBeTruthy();
  });

  it("warns before loading a file that leaves more devices than it gives", async () => {
    const session = sessionWith();
    const upgrade = upgradePreview();
    session.api.previewLicense.mockResolvedValue({
      ...upgrade,
      after: {
        ...upgrade.after,
        quotas: { ...upgrade.after.quotas, stations: { limit: 2, used: 3, over: true } },
      },
      warnings: ["over_limit"],
    });
    const card = await openLicense(session);
    pick(card, new File([FILE_TEXT], "site.mklic"));
    expect(
      await within(card).findByText(
        "Станции и ТСД: будет использовано 3 из 2. Новые устройства не подключатся, работающие продолжат.",
      ),
    ).toBeTruthy();
  });

  it("drops the checked file on «Отмена» and loads nothing", async () => {
    const session = sessionWith();
    session.api.previewLicense.mockResolvedValue(upgradePreview());
    const card = await openLicense(session);
    pick(card, new File([FILE_TEXT], "site.mklic"));
    const preview = await within(card).findByRole("region", { name: "Было → станет" });
    fireEvent.click(within(preview).getByRole("button", { name: "Отмена" }));
    expect(within(card).queryByRole("region", { name: "Было → станет" })).toBeNull();
    expect(session.api.loadLicense).not.toHaveBeenCalled();
  });

  it("explains a refused file and moves the focus to the explanation", async () => {
    const session = sessionWith();
    session.api.previewLicense.mockRejectedValue(
      new HostError({
        kind: "api",
        code: "validation_failed",
        status: 400,
        message: "x",
        details: { field: "file", reason: "license_signature" },
      }),
    );
    const card = await openLicense(session);
    pick(card, new File([FILE_TEXT], "site.mklic"));
    const text = await within(card).findByText(
      "Подпись файла не сходится: файл изменён после выпуска. Запросите файл заново.",
    );
    await waitFor(() => expect(document.activeElement?.contains(text)).toBe(true));
    expect(within(card).queryByRole("region", { name: "Было → станет" })).toBeNull();
  });

  it("refuses a file over 16 KiB and one of another type without asking the host", async () => {
    const session = sessionWith();
    const card = await openLicense(session);
    pick(card, new File(["a".repeat(16 * 1024 + 1)], "site.mklic"));
    expect(
      await within(card).findByText("Файл больше 16 КиБ: это не файл лицензии Маркиро."),
    ).toBeTruthy();
    pick(card, new File([FILE_TEXT], "site.txt"));
    expect(await within(card).findByText("Нужен файл лицензии с расширением .mklic.")).toBeTruthy();
    expect(session.api.previewLicense).not.toHaveBeenCalled();
  });

  it("sends a double click on «Загрузить» once", async () => {
    const session = sessionWith();
    session.api.previewLicense.mockResolvedValue(upgradePreview());
    let answer: (license: OfficeLicense) => void = () => undefined;
    session.api.loadLicense.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const card = await openLicense(session);
    pick(card, new File([FILE_TEXT], "site.mklic"));
    const preview = await within(card).findByRole("region", { name: "Было → станет" });
    const load = within(preview).getByRole("button", { name: "Загрузить" });
    fireEvent.click(load);
    fireEvent.click(load);
    answer(UPGRADED);
    await within(card).findByText(/Лицензия загружена/);
    expect(session.api.loadLicense).toHaveBeenCalledTimes(1);
  });

  it("offers no file to the technologist", async () => {
    const card = await openLicense(sessionWith(ACTIVE_LICENSE, { technologist: true }));
    expect(within(card).queryByTestId("file-drop-input")).toBeNull();
  });

  it("offers no file before the organization has an INN", async () => {
    const card = await openLicense(
      sessionWith(
        licenseOf({ binding: { ...ACTIVE_LICENSE.binding, orgInn: null, innMatches: null } }),
      ),
    );
    expect(within(card).getByTestId("file-drop-input")).toHaveProperty("disabled", true);
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/license-load.test.ts test/license-section.test.tsx
```

Ожидается: FAIL — модуля `license-load.ts` нет, на странице нет поля выбора файла.

- [ ] **Step 3: Реализация**

Создать `apps/standalone/src/office/info/license/license-load.ts`:

```ts
import { HostError } from "../../../host/client.js";
import { errorMessageKey } from "../../../host/errors.js";
import {
  LICENSE_FEATURE_KEYS,
  LICENSE_REFUSALS,
  MAX_LICENSE_FILE_BYTES,
  type LicensePreview,
  type LicenseTerms,
  type OfficeLicense,
} from "../../../host/protocol.js";
import { lastMomentBefore, licenseDay } from "../../../lib/license-dates.js";
import { planText, SHOWN_QUOTAS, type LicenseText } from "./license-view.js";

/** What the picker offers. */
export const LICENSE_FILE_ACCEPT = ".mklic";

export type LicenseFileRead =
  { kind: "text"; text: string } | { kind: "too_large" } | { kind: "unreadable" };

/** The file's text, trimmed; a file over the host's bound (16 KiB) is refused unread. */
export async function readLicenseFile(file: File): Promise<LicenseFileRead> {
  if (file.size > MAX_LICENSE_FILE_BYTES) return { kind: "too_large" };
  try {
    return { kind: "text", text: (await file.text()).trim() };
  } catch {
    return { kind: "unreadable" };
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INN = /^\d{10}(?:\d{2})?$/;

function shortHost(value: unknown): string {
  return typeof value === "string" && UUID.test(value) ? value.slice(0, 8).toLowerCase() : "—";
}

/**
 * A refused preview or load in words (spec §9.7): a refusal of the file by
 * its reason, an unknown reason as a bad file, anything else (the rate
 * limit, the host away, a refusal of another field) by its code. The host
 * names only the file's host (`fileHostId`); the file's INN is said when a
 * host sends it (`fileInn`), and the newest file's number comes from `GET`.
 */
export function loadFailureText(error: unknown, current: OfficeLicense | undefined): LicenseText {
  if (
    !(error instanceof HostError) ||
    error.code !== "validation_failed" ||
    error.field !== "file"
  ) {
    return { key: errorMessageKey(error) };
  }
  const reason =
    LICENSE_REFUSALS.find((known) => known === error.details.reason) ?? "license_malformed";
  const key = `office.about.license.errors.${reason}`;
  const orgInn = current?.binding.orgInn ?? "—";
  switch (reason) {
    case "license_wrong_host":
      return {
        key,
        values: {
          fileHost: shortHost(error.details.fileHostId),
          thisHost: shortHost(current?.binding.hostId),
        },
      };
    case "license_older":
      return { key, values: { sequence: current?.license?.sequence ?? "—" } };
    case "license_inn_mismatch": {
      const fileInn = error.details.fileInn;
      return typeof fileInn === "string" && INN.test(fileInn)
        ? { key, values: { fileInn, orgInn } }
        : { key: `${key}_short`, values: { orgInn } };
    }
    default:
      return { key };
  }
}

/** One row of «было → станет»; `id` is the name the host's `changes` uses. */
export interface ComparisonRow {
  id: string;
  label: LicenseText;
  before: LicenseText;
  after: LicenseText;
  changed: boolean;
}

const DASH: LicenseText = { key: "office.about.license.load.none" };

function limitText(limit: number | null): LicenseText {
  return limit === null
    ? { key: "office.about.license.seats.unlimited" }
    : { key: "office.about.license.load.value", values: { value: limit } };
}

function featureText(on: boolean): LicenseText {
  return { key: on ? "office.about.license.features.on" : "office.about.license.features.off" };
}

/**
 * The table a file is loaded after (spec §4.8, §9.2): the plan, the last day,
 * the grace, the seats and the features, before and after, each row marked
 * when the host names it in `changes`. Before the first file the host
 * answers the trial's terms (`plan: "trial"`, no limits, every feature).
 */
export function comparisonRows(preview: LicensePreview, zone: string | null): ComparisonRow[] {
  const day = (end: string | null): LicenseText =>
    end === null
      ? DASH
      : {
          key: "office.about.license.load.value",
          values: { value: licenseDay(lastMomentBefore(end), zone) },
        };
  const grace = (n: number): LicenseText => ({
    key: "office.about.license.load.days",
    values: { n },
  });
  const columns = (terms: LicenseTerms) => ({
    plan: planText(terms.plan),
    validUntil: day(terms.validUntil),
    graceDays: grace(terms.graceDays),
  });
  const before = columns(preview.before);
  const after = columns(preview.after);
  const rows: Omit<ComparisonRow, "changed">[] = [
    {
      id: "plan",
      label: { key: "office.about.license.load.rows.plan" },
      before: before.plan,
      after: after.plan,
    },
    {
      id: "validUntil",
      label: { key: "office.about.license.load.rows.validUntil" },
      before: before.validUntil,
      after: after.validUntil,
    },
    {
      id: "graceDays",
      label: { key: "office.about.license.load.rows.graceDays" },
      before: before.graceDays,
      after: after.graceDays,
    },
    ...SHOWN_QUOTAS.map((key) => ({
      id: `quotas.${key}`,
      label: { key: `office.about.license.quotas.${key}` },
      before: limitText(preview.before.quotas[key].limit),
      after: limitText(preview.after.quotas[key].limit),
    })),
    ...LICENSE_FEATURE_KEYS.map((key) => ({
      id: `features.${key}`,
      label: { key: `office.about.license.features.${key}` },
      before: featureText(preview.before.features[key]),
      after: featureText(preview.after.features[key]),
    })),
  ];
  return rows.map((row) => ({ ...row, changed: preview.changes.includes(row.id) }));
}

/** A quota the file would leave below what is used now, as the host counted it. */
export interface OverLimit {
  key: (typeof SHOWN_QUOTAS)[number];
  used: number;
  limit: number;
}

export function overLimits(preview: LicensePreview): OverLimit[] {
  return SHOWN_QUOTAS.flatMap((key) => {
    const { limit, used, over } = preview.after.quotas[key];
    return over && limit !== null ? [{ key, used, limit }] : [];
  });
}

/** The host's other warnings of the checked file: already expired, not yet valid (spec §4.3). */
export function previewWarnings(preview: LicensePreview, zone: string | null): LicenseText[] {
  const { validFrom, validUntil } = preview.after;
  const warnings: LicenseText[] = [];
  if (preview.warnings.includes("expired") && validUntil !== null) {
    warnings.push({
      key: "office.about.license.load.expired",
      values: { date: licenseDay(lastMomentBefore(validUntil), zone) },
    });
  }
  if (preview.warnings.includes("not_yet_valid") && validFrom !== null) {
    warnings.push({
      key: "office.about.license.load.notYetValid",
      values: { date: licenseDay(validFrom, zone) },
    });
  }
  return warnings;
}

/**
 * What the page says after a load of the file whose terms were `loaded`: when
 * it begins (a file issued ahead waits for its start, spec §4.4), that it has
 * already ended, or till when it runs — by the host's effective time.
 */
export function loadedMessage(
  next: OfficeLicense,
  loaded: LicenseTerms,
  zone: string | null,
): { tone: "ok" | "warn"; text: LicenseText } {
  const now = Date.parse(next.effectiveAt);
  if (loaded.validFrom !== null && Date.parse(loaded.validFrom) > now) {
    return {
      tone: "ok",
      text: {
        key: "office.about.license.load.loadedLater",
        values: { date: licenseDay(loaded.validFrom, zone) },
      },
    };
  }
  if (loaded.validUntil === null) {
    return { tone: "ok", text: { key: "office.about.license.load.loadedNoDate" } };
  }
  const date = licenseDay(lastMomentBefore(loaded.validUntil), zone);
  return Date.parse(loaded.validUntil) <= now
    ? { tone: "warn", text: { key: "office.about.license.load.loadedExpired", values: { date } } }
    : { tone: "ok", text: { key: "office.about.license.load.loaded", values: { date } } };
}
```

Создать `apps/standalone/src/office/info/license/LicenseLoad.tsx`:

```tsx
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, FileDropZone, Table, VisuallyHidden, type TableColumn } from "@markiro/ui";

import type { LicensePreview, OfficeLicense } from "../../../host/protocol.js";
import { licenseLoad } from "../../../host/requests.js";
import { officeKeys, useOfficeMutation } from "../../office-query.js";
import {
  comparisonRows,
  LICENSE_FILE_ACCEPT,
  loadedMessage,
  loadFailureText,
  overLimits,
  previewWarnings,
  readLicenseFile,
  type ComparisonRow,
} from "./license-load.js";
import type { LicenseText } from "./license-view.js";

type Message = { tone: "ok" | "warn" | "error"; text: LicenseText };

export interface LicenseLoadProps {
  license: OfficeLicense;
  zone: string | null;
}

/**
 * «Загрузить файл лицензии» (spec §4.8, §9.2): the file is read in the
 * webview (≤ 16 KiB), checked by the host without a write
 * (`POST /v1/office/license/preview`) and shown as «было → станет» with the
 * seats it would leave over their limit; «Загрузить» sends the same text
 * (`PUT /v1/office/license`), «Отмена» drops it. The latest picked file
 * wins; a second press while a load runs sends nothing. A refusal is said
 * in its own words and takes the focus. The text of the file stays in this
 * component only and is never logged.
 */
export function LicenseLoad({ license, zone }: LicenseLoadProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const queryClient = useQueryClient();
  const preview = useOfficeMutation((api, token, file: string) =>
    api.previewLicense(token, licenseLoad(file)),
  );
  const load = useOfficeMutation((api, token, file: string) =>
    api.loadLicense(token, licenseLoad(file)),
  );
  const pick = useRef(0);
  const loading = useRef(false);
  const messageRef = useRef<HTMLDivElement>(null);
  const [staged, setStaged] = useState<{ file: string; preview: LicensePreview } | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  useEffect(() => {
    if (message?.tone === "error") messageRef.current?.focus();
  }, [message]);

  const say = (text: LicenseText) => t(text.key, text.values);

  const choose = async (file: File) => {
    const mine = ++pick.current;
    setMessage(null);
    setStaged(null);
    const read = await readLicenseFile(file);
    if (mine !== pick.current) return;
    if (read.kind !== "text") {
      setMessage({ tone: "error", text: { key: `office.about.license.load.${read.kind}` } });
      return;
    }
    let checked: LicensePreview;
    try {
      checked = await preview.mutateAsync(read.text);
    } catch (error) {
      if (mine === pick.current)
        setMessage({ tone: "error", text: loadFailureText(error, license) });
      return;
    }
    if (mine === pick.current) setStaged({ file: read.text, preview: checked });
  };

  const submit = async () => {
    if (staged === null || loading.current) return;
    loading.current = true;
    setMessage(null);
    let next: OfficeLicense;
    try {
      next = await load.mutateAsync(staged.file);
    } catch (error) {
      loading.current = false;
      setMessage({ tone: "error", text: loadFailureText(error, license) });
      return;
    }
    loading.current = false;
    queryClient.setQueryData(officeKeys.license, next);
    setStaged(null);
    setMessage(loadedMessage(next, staged.preview.after, zone));
  };

  const columns: TableColumn<ComparisonRow>[] = [
    { key: "what", title: t("office.about.license.load.what"), render: (row) => say(row.label) },
    {
      key: "before",
      title: t("office.about.license.load.before"),
      wrap: true,
      render: (row) => say(row.before),
    },
    {
      key: "after",
      title: t("office.about.license.load.after"),
      wrap: true,
      render: (row) =>
        row.changed ? (
          <strong>
            {say(row.after)}
            <VisuallyHidden> ({t("office.about.license.load.changes")})</VisuallyHidden>
          </strong>
        ) : (
          say(row.after)
        ),
    },
  ];

  return (
    <section className="license-part" aria-labelledby={titleId}>
      <h3 id={titleId}>{t("office.about.license.load.title")}</h3>
      <div ref={messageRef} tabIndex={-1} className="backup-alerts" aria-live="polite">
        {message !== null && (
          <Alert tone={message.tone} role="presentation">
            {say(message.text)}
          </Alert>
        )}
      </div>
      {staged !== null && (
        <section className="license-part" aria-label={t("office.about.license.load.previewTitle")}>
          <h4>{t("office.about.license.load.previewTitle")}</h4>
          <Table
            columns={columns}
            rows={comparisonRows(staged.preview, zone)}
            getRowKey={(row) => row.id}
            empty={t("office.about.license.load.none")}
          />
          {overLimits(staged.preview).map((row) => (
            <Alert key={row.key} tone="warn" role="presentation">
              {t("office.about.license.load.overLimit", {
                quota: t(`office.about.license.quotas.${row.key}`),
                used: row.used,
                limit: row.limit,
              })}
            </Alert>
          ))}
          {previewWarnings(staged.preview, zone).map((warning) => (
            <Alert key={warning.key} tone="warn" role="presentation">
              {say(warning)}
            </Alert>
          ))}
          <div className="standalone-form__actions">
            <Button loading={load.isPending} onClick={() => void submit()}>
              {t("office.about.license.load.submit")}
            </Button>
            <Button
              variant="secondary"
              disabled={load.isPending}
              onClick={() => {
                pick.current += 1;
                setStaged(null);
              }}
            >
              {t("office.about.license.load.cancel")}
            </Button>
          </div>
        </section>
      )}
      <FileDropZone
        compact
        label={t("office.about.license.load.drop")}
        busyLabel={t("office.about.license.load.busy")}
        accept={LICENSE_FILE_ACCEPT}
        busy={preview.isPending}
        disabled={load.isPending || license.binding.orgInn === null}
        onFile={(file) => void choose(file)}
        onRejected={() => {
          pick.current += 1;
          setStaged(null);
          setMessage({ tone: "error", text: { key: "office.about.license.load.wrongType" } });
        }}
      />
    </section>
  );
}
```

Правка `apps/standalone/src/office/info/LicenseSection.tsx`.

Фрагмент 1 (импорты):

<!-- prettier-ignore -->
```tsx
import { copyText } from "./clipboard.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { copyText } from "./clipboard.js";
import { LicenseLoad } from "./license/LicenseLoad.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
      {admin ? null : <p className="office-note">{t("office.about.license.readOnly")}</p>}
```

заменить на:

<!-- prettier-ignore -->
```tsx
      {admin ? (
        <LicenseLoad license={license} zone={zone} />
      ) : (
        <p className="office-note">{t("office.about.license.readOnly")}</p>
      )}
```

Правка `apps/standalone/src/i18n/ru.json`: в объект `office.about.license` добавить:

<!-- prettier-ignore -->
```json
"load": {
  "title": "Загрузка файла лицензии",
  "drop": "Загрузить файл лицензии (.mklic)",
  "busy": "Проверяем файл…",
  "previewTitle": "Было → станет",
  "what": "Что",
  "before": "Было",
  "after": "Станет",
  "changes": "изменится",
  "rows": {
    "plan": "Вид",
    "validUntil": "Действует по",
    "graceDays": "Льготный срок"
  },
  "none": "—",
  "value": "{{value}}",
  "days": "{{n}} дн.",
  "overLimit": "{{quota}}: будет использовано {{used}} из {{limit}}. Новые устройства не подключатся, работающие продолжат.",
  "expired": "Срок этого файла уже истёк {{date}}: после загрузки новые смены открываться не будут.",
  "notYetValid": "Этот файл начнёт действовать {{date}}; до тех пор действует прежний.",
  "submit": "Загрузить",
  "cancel": "Отмена",
  "loaded": "Лицензия загружена. Действует по {{date}} включительно.",
  "loadedExpired": "Лицензия загружена, но её срок уже истёк {{date}}.",
  "loadedLater": "Лицензия загружена и начнёт действовать {{date}}.",
  "loadedNoDate": "Лицензия загружена.",
  "too_large": "Файл больше 16 КиБ: это не файл лицензии Маркиро.",
  "unreadable": "Не удалось прочитать файл. Скопируйте его на этот компьютер и попробуйте снова.",
  "wrongType": "Нужен файл лицензии с расширением .mklic."
},
"errors": {
  "license_malformed": "Это не файл лицензии Маркиро или файл повреждён.",
  "license_unknown_key": "Файл подписан ключом, который эта версия не знает. Обновите программу или запросите файл заново.",
  "license_signature": "Подпись файла не сходится: файл изменён после выпуска. Запросите файл заново.",
  "license_wrong_host": "Файл выдан для другого хоста ({{fileHost}}…). Этот хост: {{thisHost}}… Отправьте запрос на активацию с этого ПК.",
  "license_older": "У площадки уже есть более новый файл лицензии (№ {{sequence}}). Этот файл не нужен.",
  "license_inn_mismatch": "ИНН в файле лицензии ({{fileInn}}) не совпадает с ИНН организации в программе ({{orgInn}}). Исправьте ИНН в «Профиле организации» или запросите файл для этой организации.",
  "license_inn_mismatch_short": "ИНН в файле лицензии не совпадает с ИНН организации в программе ({{orgInn}}). Исправьте ИНН в «Профиле организации» или запросите файл для этой организации.",
  "license_inn_missing": "Укажите ИНН организации в «Профиле организации»: лицензия выдаётся на ИНН."
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/license-load.test.ts test/license-section.test.tsx --reporter=verbose
```

Ожидается: PASS, в выводе нет `stderr |`. Тест «lists the plan…» читает фикстуру предпросмотра ЛЦ-2 (`office-license-preview.json`: пробный период → подписка, станций 4 при 3); если исполненный ЛЦ-2 изменил в ней числа, ожидания этого теста правятся по фикстуре и пишутся в «Отклонения».

- [ ] **Step 5: Гейты и коммит**

<!-- prettier-ignore -->
```bash
node_modules/.bin/prettier --ignore-path .prettierignore --write apps/standalone/src/office/info/license/license-load.ts apps/standalone/src/office/info/license/LicenseLoad.tsx apps/standalone/src/office/info/LicenseSection.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/license-load.test.ts apps/standalone/test/license-section.test.tsx
node_modules/.bin/prettier --ignore-path .prettierignore --check apps/standalone/src/office/info/license/license-load.ts apps/standalone/src/office/info/license/LicenseLoad.tsx apps/standalone/src/office/info/LicenseSection.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/license-load.test.ts apps/standalone/test/license-section.test.tsx
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint
git diff --check
```

Сообщение (`/tmp/claude/lc3-t4-msg.txt`):

<!-- prettier-ignore -->
```text
feat(standalone): load a license file after «было → станет» (plan ЛЦ-3)

The office reads the .mklic file (16 KiB at most), has the host check it
without a write, shows the plan, the term, the grace, the seats and the
features before and after as the host marked them, with the seats a
smaller file would leave over their limit and a file expired or not yet
valid, and loads it only on «Загрузить»; every refusal of spec §9.7 in
its own words, with the focus on it.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

<!-- prettier-ignore -->
```bash
git add apps/standalone/src/office/info/license/license-load.ts apps/standalone/src/office/info/license/LicenseLoad.tsx apps/standalone/src/office/info/LicenseSection.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/license-load.test.ts apps/standalone/test/license-section.test.tsx
git commit -F /tmp/claude/lc3-t4-msg.txt
```

---

### Task 5: Запрос на активацию в «Документы\Markiro\Лицензия» и аварийное продление

**Files:**

- Create: `apps/standalone/src/office/info/license/license-files.ts`, `apps/standalone/src/office/info/license/LicenseActions.tsx`
- Modify: `apps/standalone/src/office/info/LicenseSection.tsx`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/license-section.test.tsx`

**Interfaces:**

- Consumes: `HostApi.getActivationRequest(token)`, `HostApi.enableLicenseEmergency(token)` (ЛЦ-2), `useOfficeFiles()` (`save`, `open`), `OfficeFilesError`, корень `Лицензия` и `.json` (задача 1), `emergency.available` (ЛЦ-2), `EMERGENCY_MS`, `licenseMinute`, `FormDialog`, `errorMessageKey`, `standaloneActivationRequestSchema` (`@markiro/domain`, ЛЦ-1, только в тесте).
- Produces: `LICENSE_FOLDER`, `ACTIVATION_FILE = "markiro-activation-request.json"`, `activationFolder(when)`, `activationBytes(request)`; компонент `LicenseActions` (сохранение запроса, «Показать папку», «Открыть новые смены ещё 3 дня» с подтверждением).

- [ ] **Step 1: Написать падающие тесты**

Дописать в `apps/standalone/test/license-section.test.tsx` (импорты — в начало файла):

<!-- prettier-ignore -->
```tsx
import { readFileSync } from "node:fs";

import { standaloneActivationRequestSchema } from "@markiro/domain";

import { OfficeFilesError } from "../src/office/exports/office-files.js";
```

и в конец файла:

<!-- prettier-ignore -->
```tsx
// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;
const ACTIVATION_REQUEST = standaloneActivationRequestSchema.parse(
  JSON.parse(
    readFileSync(
      new URL(
        "../../../packages/domain/fixtures/standalone-license/activation-request.json",
        testModuleUrl,
      ),
      "utf8",
    ),
  ),
);

describe("the activation request and the emergency extension", () => {
  it("saves the host's activation request as JSON under «Лицензия» and shows the folder", async () => {
    const session = sessionWith(WRONG_HOST);
    session.api.getActivationRequest.mockResolvedValue(ACTIVATION_REQUEST);
    const files = fakeOfficeFiles();
    const card = await openLicense(session, files);
    fireEvent.click(within(card).getByRole("button", { name: "Сохранить запрос на активацию" }));
    expect(await within(card).findByText(/^Запрос сохранён в папке /)).toBeTruthy();
    expect(files.save).toHaveBeenCalledTimes(1);
    const [segments, saved] = files.save.mock.calls[0]!;
    expect(segments[0]).toBe("Лицензия");
    expect(segments[1]).toMatch(/^Запрос на активацию \d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/);
    expect(saved.map((file) => file.name)).toEqual(["markiro-activation-request.json"]);
    expect(JSON.parse(new TextDecoder().decode(saved[0]!.bytes))).toEqual(ACTIVATION_REQUEST);
    expect(
      within(card).getByText(
        `Запрос сохранён в папке C:\\Users\\Оператор\\Documents\\Markiro\\${segments.join("\\")}. Отправьте файл в Маркиро.`,
      ),
    ).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "Показать папку" }));
    expect(files.open).toHaveBeenCalledWith(segments);
  });

  it("says when the request could not be saved", async () => {
    const session = sessionWith();
    session.api.getActivationRequest.mockResolvedValue(ACTIVATION_REQUEST);
    const files = fakeOfficeFiles();
    files.save.mockRejectedValue(new OfficeFilesError("storage", "disk full"));
    const card = await openLicense(session, files);
    fireEvent.click(within(card).getByRole("button", { name: "Сохранить запрос на активацию" }));
    expect(await within(card).findByText(/Не удалось сохранить запрос/)).toBeTruthy();
  });

  it("opens new shifts for 3 more days once, after asking, till the host's time plus 72 hours", async () => {
    const session = sessionWith(RESTRICTED);
    session.api.enableLicenseEmergency.mockResolvedValue({
      ...RESTRICTED,
      emergency: { available: false, until: "2027-11-23T06:00:00Z" },
    });
    const card = await openLicense(session);
    fireEvent.click(within(card).getByRole("button", { name: "Открыть новые смены ещё 3 дня" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(
        "Открывать новые смены ещё 3 дня, до 23.11 09:00? Это можно сделать один раз для каждой лицензии.",
      ),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Открыть на 3 дня" }));
    expect(await within(card).findByText("Новые смены открываются до 23.11 09:00.")).toBeTruthy();
    expect(session.api.enableLicenseEmergency).toHaveBeenCalledTimes(1);
    expect(
      within(card).getByText("Аварийное продление: новые смены открываются до 23.11 09:00."),
    ).toBeTruthy();
    expect(
      within(card).queryByRole("button", { name: "Открыть новые смены ещё 3 дня" }),
    ).toBeNull();
  });

  it("says the extension was already used for this license", async () => {
    const session = sessionWith(TRIAL_EXPIRED);
    session.api.enableLicenseEmergency.mockRejectedValue(
      new HostError({
        kind: "api",
        code: "conflict",
        status: 409,
        message: "used",
        details: { constraint: "emergency_used" },
      }),
    );
    const card = await openLicense(session);
    fireEvent.click(within(card).getByRole("button", { name: "Открыть новые смены ещё 3 дня" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Открыть на 3 дня" }));
    expect(
      await within(dialog).findByText("Аварийное продление для этой лицензии уже использовано."),
    ).toBeTruthy();
  });

  it.each([
    ["a valid license", ACTIVE_LICENSE],
    ["the grace", GRACE],
    ["a restriction whose extension the host no longer allows", licenseOf({ ...RESTRICTED, emergency: { available: false, until: null } })],
  ] as const)("does not offer the extension for %s", async (_, license) => {
    const card = await openLicense(sessionWith(license));
    expect(within(card).queryByRole("button", { name: "Открыть новые смены ещё 3 дня" })).toBeNull();
  });

  it("offers the technologist neither the extension nor the request", async () => {
    const tech = await openLicense(sessionWith(RESTRICTED, { technologist: true }));
    expect(within(tech).queryByRole("button", { name: "Открыть новые смены ещё 3 дня" })).toBeNull();
    expect(within(tech).queryByRole("button", { name: "Сохранить запрос на активацию" })).toBeNull();
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/license-section.test.tsx
```

Ожидается: FAIL — кнопок «Сохранить запрос на активацию» и «Открыть новые смены ещё 3 дня» нет.

- [ ] **Step 3: Реализация**

Создать `apps/standalone/src/office/info/license/license-files.ts`:

```ts
/** The root under `Документы\Markiro` the activation request goes to (the shell's `LICENSE_ROOT`). */
export const LICENSE_FOLDER = "Лицензия";

/** The request's file: JSON, which the SaaS panel takes as it is (license spec §6.3). */
export const ACTIVATION_FILE = "markiro-activation-request.json";

/** «2026-10-20_09-00-00» of an instant, UTC, for a folder's name (as the support text's file). */
function stamp(when: Date): string {
  return when.toISOString().slice(0, 19).replace("T", "_").replaceAll(":", "-");
}

/** A new folder for each saved request: the shell never writes over an earlier one. */
export function activationFolder(when: Date): readonly string[] {
  return [LICENSE_FOLDER, `Запрос на активацию ${stamp(when)}`];
}

/** The request as the host answered it, indented, with a final line break. It holds no secret. */
export function activationBytes(request: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(request, null, 2)}\n`);
}
```

Создать `apps/standalone/src/office/info/license/LicenseActions.tsx`:

```tsx
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button } from "@markiro/ui";

import { HostError } from "../../../host/client.js";
import { errorMessageKey } from "../../../host/errors.js";
import type { OfficeLicense } from "../../../host/protocol.js";
import { EMERGENCY_MS, licenseMinute } from "../../../lib/license-dates.js";
import { OfficeFilesError } from "../../exports/office-files.js";
import { useOfficeFiles } from "../../exports/office-files-context.js";
import { FormDialog } from "../../FormDialog.js";
import { officeKeys, useOfficeMutation } from "../../office-query.js";
import { ACTIVATION_FILE, activationBytes, activationFolder } from "./license-files.js";
import type { LicenseText } from "./license-view.js";

type Saved =
  | { kind: "saved"; path: string; segments: readonly string[] }
  | { kind: "failed"; text: LicenseText };

export interface LicenseActionsProps {
  license: OfficeLicense;
  zone: string | null;
}

/**
 * The administrator's actions besides a file (spec §9.2): «Сохранить запрос
 * на активацию» (the host builds it, the shell saves it under
 * `Документы\Markiro\Лицензия` without a file dialog) and, where no new
 * shift opens and the host allows it, «Открыть новые смены ещё 3 дня»
 * (spec §3.5), asked first, once per license.
 */
export function LicenseActions({ license, zone }: LicenseActionsProps) {
  const { t } = useTranslation();
  const files = useOfficeFiles();
  const queryClient = useQueryClient();
  const request = useOfficeMutation((api, token, _: null) => api.getActivationRequest(token));
  const saving = useRef(false);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [asking, setAsking] = useState(false);
  const [notice, setNotice] = useState<LicenseText | null>(null);
  // The host offers it only while no new shift opens and it was not used for this file (plan ЛЦ-2, Д6).
  const emergencyOffered = license.emergency.available;

  const save = async () => {
    if (saving.current) return;
    saving.current = true;
    setSaved(null);
    setNotice(null);
    try {
      const body = await request.mutateAsync(null);
      const folder = await files.save(activationFolder(new Date()), [
        { name: ACTIVATION_FILE, bytes: activationBytes(body) },
      ]);
      setSaved({ kind: "saved", path: folder.path, segments: folder.segments });
    } catch (error) {
      setSaved({
        kind: "failed",
        text:
          error instanceof OfficeFilesError
            ? { key: "office.about.license.activation.saveFailed" }
            : { key: errorMessageKey(error) },
      });
    } finally {
      saving.current = false;
    }
  };

  return (
    <section className="license-part" aria-label={t("office.about.license.actionsTitle")}>
      <p className="office-note">{t("office.about.license.activation.hint")}</p>
      <div className="standalone-form__actions">
        <Button variant="secondary" loading={request.isPending} onClick={() => void save()}>
          {t("office.about.license.activation.save")}
        </Button>
        {emergencyOffered && (
          <Button
            variant="secondary"
            onClick={() => {
              setNotice(null);
              setAsking(true);
            }}
          >
            {t("office.about.license.emergency.open")}
          </Button>
        )}
      </div>
      <div className="backup-alerts" aria-live="polite">
        {saved?.kind === "saved" && (
          <Alert
            tone="ok"
            role="presentation"
            action={
              <Button
                variant="secondary"
                size="compact"
                onClick={() => void files.open(saved.segments).catch(() => undefined)}
              >
                {t("office.about.license.activation.showFolder")}
              </Button>
            }
          >
            {t("office.about.license.activation.saved", { path: saved.path })}
          </Alert>
        )}
        {saved?.kind === "failed" && (
          <Alert tone="error" role="presentation">
            {t(saved.text.key, saved.text.values)}
          </Alert>
        )}
        {notice !== null && (
          <Alert tone="ok" role="presentation">
            {t(notice.key, notice.values)}
          </Alert>
        )}
      </div>
      {asking && (
        <EmergencyDialog
          license={license}
          zone={zone}
          onClose={() => setAsking(false)}
          onEnabled={(next) => {
            setAsking(false);
            queryClient.setQueryData(officeKeys.license, next);
            setNotice({
              key: "office.about.license.emergency.done",
              values: {
                until:
                  next.emergency.until === null ? "—" : licenseMinute(next.emergency.until, zone),
              },
            });
          }}
        />
      )}
    </section>
  );
}

function emergencyFailure(error: unknown): LicenseText {
  if (error instanceof HostError && error.code === "conflict") {
    if (error.details.constraint === "emergency_used") {
      return { key: "office.about.license.emergency.used" };
    }
    if (error.details.constraint === "emergency_not_needed") {
      return { key: "office.about.license.emergency.notNeeded" };
    }
  }
  return { key: errorMessageKey(error) };
}

function EmergencyDialog({
  license,
  zone,
  onClose,
  onEnabled,
}: {
  license: OfficeLicense;
  zone: string | null;
  onClose: () => void;
  onEnabled: (next: OfficeLicense) => void;
}) {
  const { t } = useTranslation();
  const [failure, setFailure] = useState<LicenseText | null>(null);
  const enable = useOfficeMutation((api, token, _: null) => api.enableLicenseEmergency(token));
  // The host's time, not this PC's: the office does not compare clocks with the host.
  const until = licenseMinute(
    new Date(Date.parse(license.effectiveAt) + EMERGENCY_MS).toISOString(),
    zone,
  );
  const submit = async () => {
    setFailure(null);
    let next: OfficeLicense;
    try {
      next = await enable.mutateAsync(null);
    } catch (error) {
      setFailure(emergencyFailure(error));
      return;
    }
    onEnabled(next);
  };
  return (
    <FormDialog
      title={t("office.about.license.emergency.title")}
      submitLabel={t("office.about.license.emergency.submit")}
      onSubmit={submit}
      onClose={onClose}
      alert={failure === null ? null : <Alert tone="error">{t(failure.key, failure.values)}</Alert>}
    >
      <p>{t("office.about.license.emergency.body", { until })}</p>
    </FormDialog>
  );
}
```

Правка `apps/standalone/src/office/info/LicenseSection.tsx`.

Фрагмент 1 (импорты):

<!-- prettier-ignore -->
```tsx
import { LicenseLoad } from "./license/LicenseLoad.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { LicenseActions } from "./license/LicenseActions.js";
import { LicenseLoad } from "./license/LicenseLoad.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
      {admin ? (
        <LicenseLoad license={license} zone={zone} />
      ) : (
```

заменить на:

<!-- prettier-ignore -->
```tsx
      {admin ? (
        <>
          <LicenseLoad license={license} zone={zone} />
          <LicenseActions license={license} zone={zone} />
        </>
      ) : (
```

Правка `apps/standalone/src/i18n/ru.json`: в объект `office.about.license` добавить:

<!-- prettier-ignore -->
```json
"actionsTitle": "Запрос на активацию и аварийное продление",
"activation": {
  "hint": "Запрос нужен, чтобы Маркиро выпустила файл лицензии для этого хоста. Секретов в нём нет.",
  "save": "Сохранить запрос на активацию",
  "saved": "Запрос сохранён в папке {{path}}. Отправьте файл в Маркиро.",
  "saveFailed": "Не удалось сохранить запрос: проверьте место на диске и права на папку «Документы».",
  "showFolder": "Показать папку"
},
"emergency": {
  "open": "Открыть новые смены ещё 3 дня",
  "title": "Аварийное продление",
  "body": "Открывать новые смены ещё 3 дня, до {{until}}? Это можно сделать один раз для каждой лицензии.",
  "submit": "Открыть на 3 дня",
  "done": "Новые смены открываются до {{until}}.",
  "used": "Аварийное продление для этой лицензии уже использовано.",
  "notNeeded": "Аварийное продление не нужно: новые смены и так открываются."
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/license-section.test.tsx --reporter=verbose
```

Ожидается: PASS, в выводе нет `stderr |`.

- [ ] **Step 5: Гейты и коммит**

<!-- prettier-ignore -->
```bash
node_modules/.bin/prettier --ignore-path .prettierignore --write apps/standalone/src/office/info/license/license-files.ts apps/standalone/src/office/info/license/LicenseActions.tsx apps/standalone/src/office/info/LicenseSection.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/license-section.test.tsx
node_modules/.bin/prettier --ignore-path .prettierignore --check apps/standalone/src/office/info/license/license-files.ts apps/standalone/src/office/info/license/LicenseActions.tsx apps/standalone/src/office/info/LicenseSection.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/license-section.test.tsx
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint
git diff --check
```

Сообщение (`/tmp/claude/lc3-t5-msg.txt`):

<!-- prettier-ignore -->
```text
feat(standalone): the activation request and the emergency extension (plan ЛЦ-3)

«Сохранить запрос на активацию» saves the host's request as JSON under
Документы\Markiro\Лицензия; «Открыть новые смены ещё 3 дня» asks first,
names the host's time plus 72 hours and says a second use is refused.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

<!-- prettier-ignore -->
```bash
git add apps/standalone/src/office/info/license/license-files.ts apps/standalone/src/office/info/license/LicenseActions.tsx apps/standalone/src/office/info/LicenseSection.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/license-section.test.tsx
git commit -F /tmp/claude/lc3-t5-msg.txt
```

---

### Task 6: Блок «Лицензия» в сведениях для поддержки

**Files:**

- Create: `apps/standalone/src/office/info/license/license-support.ts`
- Modify: `apps/standalone/src/office/info/support-blocks.ts`, `apps/standalone/src/office/info/support-report.ts`, `apps/standalone/src/office/info/SupportSection.tsx`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/support-report.test.ts`, `apps/standalone/test/about-page.test.tsx`

**Interfaces:**

- Consumes: `SupportContributor`, `SupportContext`, `collectSupportBlocks`, `SUPPORT_CONTRIBUTORS` (каркас), `shortId` (`support-report.ts`), `stateText`, `shortLicenseId`, `HostApi.getLicense`, `useOfficeSession` (`call`, `api`).
- Produces: `SupportContext.read: <T>(operation: (api: HostApi, token: string) => Promise<T>) => Promise<T>`; `licenseSupportLines(license, t)`, `licenseSupportBlock: SupportContributor`; `SUPPORT_CONTRIBUTORS = [licenseSupportBlock]`; базовый текст без строки «Лицензия: …» (ключи `office.about.report.license` и `office.about.license.notConnected` удалены).

- [ ] **Step 1: Написать падающие тесты**

Правка `apps/standalone/test/support-report.test.ts`.

Фрагмент 1 (импорты):

<!-- prettier-ignore -->
```ts
import i18n from "i18next";
import { describe, expect, it } from "vitest";

import type { AboutData } from "../src/office/info/about-data.js";
```

заменить на:

<!-- prettier-ignore -->
```ts
import i18n from "i18next";
import { describe, expect, it, vi } from "vitest";

import type { HostApi } from "../src/host/api.js";
import type { OfficeLicense } from "../src/host/protocol.js";
import type { AboutData } from "../src/office/info/about-data.js";
import { licenseSupportBlock } from "../src/office/info/license/license-support.js";
import type { SupportContext } from "../src/office/info/support-blocks.js";
import {
  ACTIVE_LICENSE,
  GRACE,
  HOST_FINGERPRINT,
  LICENSE_ID,
  licenseOf,
  ORG_INN,
  TRIAL,
} from "./support/license.js";
import { fakeHostApi } from "./support/office.js";
```

Фрагмент 2 (базовый текст больше не несёт заглушку — её место занял блок):

<!-- prettier-ignore -->
```ts
      "Последняя копия (UTC): 2026-10-13T08:00:00.000Z",
      "Лицензия: Лицензирование ещё не подключено",
      "",
    ]);
```

заменить на:

<!-- prettier-ignore -->
```ts
      "Последняя копия (UTC): 2026-10-13T08:00:00.000Z",
      "",
    ]);
```

Фрагмент 3:

<!-- prettier-ignore -->
```ts
describe("Блоки сведений для поддержки (точка расширения)", () => {
  const context = { t: i18n.t, facts: FACTS, about: {} as AboutData };
```

заменить на:

<!-- prettier-ignore -->
```ts
describe("Блоки сведений для поддержки (точка расширения)", () => {
  const context: SupportContext = {
    t: i18n.t,
    facts: FACTS,
    about: {} as AboutData,
    read: () => Promise.reject(new Error("no host in this test")),
  };
```

Фрагмент 4:

<!-- prettier-ignore -->
```ts
  it("has no contributors and no extra program rows until a feature adds them", () => {
    expect(SUPPORT_CONTRIBUTORS).toEqual([]);
    expect(PROGRAM_ROWS).toEqual([]);
  });
});
```

заменить на:

<!-- prettier-ignore -->
```ts
  it("has the license's contributor first and no extra program rows yet", () => {
    expect(SUPPORT_CONTRIBUTORS).toEqual([licenseSupportBlock]);
    expect(PROGRAM_ROWS).toEqual([]);
  });
});

/** A context whose host answers `license`, or fails. */
function licenseContext(license: OfficeLicense | Error): SupportContext {
  const api = fakeHostApi({
    getLicense: vi.fn<HostApi["getLicense"]>(async () => {
      if (license instanceof Error) throw license;
      return license;
    }),
  });
  return {
    t: i18n.t,
    facts: FACTS,
    about: {} as AboutData,
    read: (operation) => operation(api, "office-session-token"),
  };
}

describe("the license's block of the support text (plan ЛЦ-3)", () => {
  it("says the state, the clock, the file, the term, the key, the host, the trial and the emergency", async () => {
    const license = licenseOf({ ...GRACE, flags: { clockBehindDays: 2, clockAhead: false } });
    expect(await licenseSupportBlock(licenseContext(license))).toEqual({
      title: "Лицензия",
      lines: [
        ["Состояние", "Льготный срок (grace)"],
        ["Часы хоста", "отстают на 2 дн."],
        ["Файл", "№ 3, 5b1d7c2e"],
        ["Действует до (UTC)", "2027-10-31T21:00:00Z"],
        ["Выпущен (UTC)", "2026-10-01T08:00:00Z"],
        ["Подписано ключом (kid)", "lic-2026-1"],
        ["Хост", "3f1c2d4e"],
        ["Пробный период (UTC)", "нет"],
        ["Аварийное продление до (UTC)", "нет"],
      ],
    });
  });

  it("names the trial of a site without a file", async () => {
    const block = await licenseSupportBlock(licenseContext(TRIAL));
    expect(block?.lines).toContainEqual(["Файл", "нет"]);
    expect(block?.lines).toContainEqual([
      "Пробный период (UTC)",
      "2026-10-10T09:00:00Z — 2026-10-24T09:00:00Z",
    ]);
  });

  it("never carries the INN, the customer, the fingerprint or a whole id", async () => {
    const block = await licenseSupportBlock(licenseContext(ACTIVE_LICENSE));
    const text = buildSupportReport(FACTS, i18n.t, block === null ? [] : [block]);
    for (const secret of [LICENSE_ID, HOST_ID, HOST_FINGERPRINT, ORG_INN, "ООО «Атолл»"]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain("\r\nЛицензия\r\nСостояние: Действует (active)\r\n");
  });

  it("says it could not read the host, and loses nothing else", async () => {
    expect(await licenseSupportBlock(licenseContext(new Error("down")))).toEqual({
      title: "Лицензия",
      lines: [["Состояние", "не удалось прочитать у хоста"]],
    });
  });
});
```

Правка `apps/standalone/test/about-page.test.tsx`, тест «builds the support text from the allowlist…».

Фрагмент:

<!-- prettier-ignore -->
```tsx
    expect(text).toContain("Лицензия: Лицензирование ещё не подключено");
```

заменить на:

<!-- prettier-ignore -->
```tsx
    // The license is a block of its own after the base text (plan ЛЦ-3), read through the session.
    expect(text).toContain("\r\nЛицензия\r\nСостояние: Действует (active)\r\n");
    expect(text).not.toContain("Лицензирование ещё не подключено");
    expect(text).not.toContain("7707083893");
    expect(session.api.getLicense).toHaveBeenCalled();
```

- [ ] **Step 2: Убедиться, что тесты падают**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/support-report.test.ts test/about-page.test.tsx
```

Ожидается: FAIL — модуля `license-support.ts` нет, базовый текст ещё печатает «Лицензия: Лицензирование ещё не подключено».

- [ ] **Step 3: Реализация**

Создать `apps/standalone/src/office/info/license/license-support.ts`:

```ts
import type { TFunction } from "i18next";

import type { OfficeLicense } from "../../../host/protocol.js";
import type { SupportContributor } from "../support-blocks.js";
import { shortId } from "../support-report.js";
import { shortLicenseId, stateText } from "./license-view.js";

/**
 * The «Лицензия» block of the support text (license spec §9.4): the state
 * (its word and its code), the host's clock, the file's number with the
 * first eight characters of its id, till when it runs and when it was
 * issued (UTC, like the rest of the text), the key it was signed with, the
 * host (eight characters), the trial and the emergency. Never the INN, the
 * customer, the certificate's fingerprint or the file's text.
 */
export function licenseSupportLines(license: OfficeLicense, t: TFunction): [string, string][] {
  const none = t("office.about.license.support.none");
  const state = stateText(license);
  const clock = [
    license.flags.clockBehindDays === null
      ? null
      : t("office.about.license.support.clockBehind", { n: license.flags.clockBehindDays }),
    license.flags.clockAhead ? t("office.about.license.support.clockAhead") : null,
  ].filter((part): part is string => part !== null);
  const file = license.license;
  return [
    [t("office.about.license.support.state"), `${t(state.key, state.values)} (${license.state})`],
    [
      t("office.about.license.support.clock"),
      clock.length === 0 ? t("office.about.license.support.clockOk") : clock.join(", "),
    ],
    [
      t("office.about.license.support.file"),
      file === null
        ? none
        : t("office.about.license.support.fileValue", {
            sequence: file.sequence,
            id: shortLicenseId(file.licenseId),
          }),
    ],
    [t("office.about.license.support.validUntil"), file === null ? none : file.validUntil],
    [t("office.about.license.support.issuedAt"), file === null ? none : file.issuedAt],
    [t("office.about.license.support.kid"), file === null ? none : file.kid],
    [t("office.about.license.support.hostId"), shortId(license.binding.hostId) ?? none],
    [
      t("office.about.license.support.trial"),
      license.trial === null
        ? none
        : t("office.about.license.support.trialValue", {
            from: license.trial.startedAt,
            to: license.trial.endsAt,
          }),
    ],
    [t("office.about.license.support.emergency"), license.emergency.until ?? none],
  ];
}

/** The block, read from the host at the moment of the click; a host that does not answer is said in it. */
export const licenseSupportBlock: SupportContributor = async ({ t, read }) => {
  const title = t("office.about.license.support.title");
  try {
    const license = await read((api, token) => api.getLicense(token));
    return { title, lines: licenseSupportLines(license, t) };
  } catch {
    return {
      title,
      lines: [[t("office.about.license.support.state"), t("office.about.license.support.unread")]],
    };
  }
};
```

Правка `apps/standalone/src/office/info/support-blocks.ts`.

Фрагмент 1:

<!-- prettier-ignore -->
```ts
import type { TFunction } from "i18next";

import type { AboutData } from "./about-data.js";
import type { SupportBlock, SupportFacts } from "./support-report.js";

/** What a contributor may read: the facts the base text already carries and what the page learned. */
export interface SupportContext {
  t: TFunction;
  facts: SupportFacts;
  about: AboutData;
}
```

заменить на:

<!-- prettier-ignore -->
```ts
import type { TFunction } from "i18next";

import type { HostApi } from "../../host/api.js";
import type { AboutData } from "./about-data.js";
import { licenseSupportBlock } from "./license/license-support.js";
import type { SupportBlock, SupportFacts } from "./support-report.js";

/** What a contributor may read: the facts the base text already carries, what the page learned, and the host. */
export interface SupportContext {
  t: TFunction;
  facts: SupportFacts;
  about: AboutData;
  /**
   * Reads the host through the office session (`session.call`, plan ЛЦ-3):
   * an ended session and a rejected device go to the shell as everywhere, and
   * a contributor whose read fails says so in its block or loses it.
   */
  read: <T>(operation: (api: HostApi, token: string) => Promise<T>) => Promise<T>;
}
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
/** The contributors, in the order their blocks follow the base text; empty until a feature adds its own. */
export const SUPPORT_CONTRIBUTORS: readonly SupportContributor[] = [];
```

заменить на:

<!-- prettier-ignore -->
```ts
/** The contributors, in the order their blocks follow the base text: the license first (plan ЛЦ-3). */
export const SUPPORT_CONTRIBUTORS: readonly SupportContributor[] = [licenseSupportBlock];
```

Правка `apps/standalone/src/office/info/support-report.ts`, фрагмент:

<!-- prettier-ignore -->
```ts
    [t("office.about.report.lastBackup"), known(instant(facts.lastBackupAt))],
    [t("office.about.report.license"), t("office.about.license.notConnected")],
  ];
```

заменить на:

<!-- prettier-ignore -->
```ts
    [t("office.about.report.lastBackup"), known(instant(facts.lastBackupAt))],
  ];
```

Правка `apps/standalone/src/office/info/SupportSection.tsx`.

Фрагмент 1 (импорты):

<!-- prettier-ignore -->
```tsx
import { PROTOCOL_VERSION } from "../../host/protocol.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import type { HostApi } from "../../host/api.js";
import { PROTOCOL_VERSION } from "../../host/protocol.js";
```

и

<!-- prettier-ignore -->
```tsx
import { useOfficeLink } from "../office-link.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { useOfficeLink } from "../office-link.js";
import { useOfficeSession } from "../office-session.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
  const queryClient = useQueryClient();
  const backups = useOfficeQuery(officeKeys.backups, (api, token) => api.getBackups(token));
```

заменить на:

<!-- prettier-ignore -->
```tsx
  const queryClient = useQueryClient();
  const session = useOfficeSession();
  const backups = useOfficeQuery(officeKeys.backups, (api, token) => api.getBackups(token));

  /** The host through the session, for the contributors (`SupportContext.read`). */
  function readHost<T>(operation: (api: HostApi, token: string) => Promise<T>): Promise<T> {
    return session.call((token) => operation(session.api, token));
  }
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
    const blocks = await collectSupportBlocks(SUPPORT_CONTRIBUTORS, { t, facts, about: fresh });
```

заменить на:

<!-- prettier-ignore -->
```tsx
    const blocks = await collectSupportBlocks(SUPPORT_CONTRIBUTORS, {
      t,
      facts,
      about: fresh,
      read: readHost,
    });
```

Правка `apps/standalone/src/i18n/ru.json`:

- в `office.about.license` удалить `"notConnected": "Лицензирование ещё не подключено"` и добавить:

<!-- prettier-ignore -->
```json
"support": {
  "title": "Лицензия",
  "state": "Состояние",
  "clock": "Часы хоста",
  "clockOk": "в порядке",
  "clockBehind": "отстают на {{n}} дн.",
  "clockAhead": "ушли вперёд",
  "file": "Файл",
  "fileValue": "№ {{sequence}}, {{id}}",
  "validUntil": "Действует до (UTC)",
  "issuedAt": "Выпущен (UTC)",
  "kid": "Подписано ключом (kid)",
  "hostId": "Хост",
  "trial": "Пробный период (UTC)",
  "trialValue": "{{from}} — {{to}}",
  "emergency": "Аварийное продление до (UTC)",
  "none": "нет",
  "unread": "не удалось прочитать у хоста"
}
```

- в `office.about.report` удалить `"license": "Лицензия"`;
- `office.about.support.intro` заменить на: `"Кнопка собирает версии, роль компьютера, состояние связи с хостом, время последней копии и состояние лицензии и копирует их в буфер обмена. Паролей, PIN, бейджей, ключей, ИНН и путей с именем пользователя в них нет."`

Проверить, что удалённые ключи больше нигде не читаются: `rtk proxy grep -rn "notConnected\|report.license" apps/standalone/src apps/standalone/test` — пусто.

- [ ] **Step 4: Убедиться, что тесты проходят**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/support-report.test.ts test/about-page.test.tsx test/license-section.test.tsx --reporter=verbose
```

Ожидается: PASS, в выводе нет `stderr |`.

- [ ] **Step 5: Гейты и коммит**

<!-- prettier-ignore -->
```bash
node_modules/.bin/prettier --ignore-path .prettierignore --write apps/standalone/src/office/info/license/license-support.ts apps/standalone/src/office/info/support-blocks.ts apps/standalone/src/office/info/support-report.ts apps/standalone/src/office/info/SupportSection.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/support-report.test.ts apps/standalone/test/about-page.test.tsx
node_modules/.bin/prettier --ignore-path .prettierignore --check apps/standalone/src/office/info/license/license-support.ts apps/standalone/src/office/info/support-blocks.ts apps/standalone/src/office/info/support-report.ts apps/standalone/src/office/info/SupportSection.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/support-report.test.ts apps/standalone/test/about-page.test.tsx
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint
git diff --check
```

Сообщение (`/tmp/claude/lc3-t6-msg.txt`):

<!-- prettier-ignore -->
```text
feat(standalone): the license's block in the support text (plan ЛЦ-3)

The placeholder line leaves the base text; a contributor reads the license
through the office session and writes the state, the clock, the file's
short id, its term, its key, the host's short id, the trial and the
emergency, never the INN, the customer or the fingerprint.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

<!-- prettier-ignore -->
```bash
git add apps/standalone/src/office/info/license/license-support.ts apps/standalone/src/office/info/support-blocks.ts apps/standalone/src/office/info/support-report.ts apps/standalone/src/office/info/SupportSection.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/support-report.test.ts apps/standalone/test/about-page.test.tsx
git commit -F /tmp/claude/lc3-t6-msg.txt
```

---

### Task 7: Полоса лицензии над страницами офиса (Т3) и предупреждения «Обзора» (Т4)

**Files:**

- Create: `apps/standalone/src/office/info/license/LicenseNotices.tsx`, `apps/standalone/src/office/LicenseBanner.tsx`
- Modify: `apps/standalone/src/office/OfficeShell.tsx`, `apps/standalone/src/office/OfficeOverview.tsx`, `apps/standalone/src/office/info/AboutPage.tsx`, `apps/standalone/src/office/Office.tsx`, `apps/standalone/src/app/shell.css`
- Test: `apps/standalone/test/license-banner.test.tsx` (новый)

**Interfaces:**

- Consumes: `officeKeys.license`, `useOfficeQuery`, `useBackupTime(enabled)`, `licenseNotices`, `noticeNeedsTime`, `noticeText`, `LicenseNotice`, `LicenseNoticeKind`; `@markiro/ui`: `Alert` (`action`), `Button`, `VisuallyHidden`; `react-router`: `Link`, `useLocation`.
- Produces: `useLicenseNotices(): ShownNotices | null`, `LicenseNotices` (предупреждения со скрытым словом тона и ссылкой на `/about#license`, необязательная «Скрыть»), `LicenseBanner` (вежливая область `.office-banner` между шапкой и страницей, закрытие на сеанс по виду предупреждения); «Обзор» — одна вежливая область `.backup-alerts` на лицензию и копии; `AboutPage` фокусирует раздел по якорю; `Office` перечитывает `officeKeys.license` на каждую новую ревизию.

- [ ] **Step 1: Написать падающие тесты**

Создать `apps/standalone/test/license-banner.test.tsx`:

```tsx
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import type { OfficeLicense } from "../src/host/protocol.js";
import { Office } from "../src/office/Office.js";
import {
  ACTIVE_LICENSE,
  EXPIRING,
  GRACE,
  INN_MISMATCH,
  licenseOf,
  RESTRICTED,
  TRIAL,
  TRIAL_ENDING,
  TRIAL_EXPIRED,
  WRONG_HOST,
} from "./support/license.js";
import {
  fakeHostApi,
  fakeOfficeSession,
  ORG_PROFILE,
  quietLabelRendering,
  renderOffice,
  type FakeOfficeSession,
} from "./support/office.js";

function sessionWith(license: OfficeLicense): FakeOfficeSession {
  const api = fakeHostApi();
  api.getLicense.mockResolvedValue(license);
  api.getOrg.mockResolvedValue(ORG_PROFILE);
  return fakeOfficeSession({ api });
}

/** The band above the office's pages. */
function band(): HTMLElement {
  const found = document.querySelector(".office-banner");
  if (!(found instanceof HTMLElement)) throw new Error("no license band");
  return found;
}

/** «Обзор»'s one polite region of warnings. */
function overviewAlerts(): HTMLElement {
  const found = document.querySelector("main .backup-alerts");
  if (!(found instanceof HTMLElement)) throw new Error("no overview alerts");
  return found;
}

const DISMISS = "Скрыть до конца сеанса";

describe("the license's band above the office's pages", () => {
  it("shows the trial's days left, neutral, with a hidden word for its tone and a link", async () => {
    const session = sessionWith(TRIAL);
    renderOffice(session);
    expect(
      await within(band()).findByText(
        /Пробный период: осталось 12 дн\. Загрузите файл лицензии в разделе «Информация»\./,
      ),
    ).toBeTruthy();
    expect(within(band()).getByText("Сведения:")).toBeTruthy();
    expect(band().querySelector(".mk-alert--info")).not.toBeNull();
    expect(within(band()).getByRole("link", { name: "Открыть раздел «Лицензия»" })).toBeTruthy();
    // No date to write: the organization's profile is not read for it.
    expect(session.api.getOrg).not.toHaveBeenCalled();
  });

  it("hides a dismissed warning for the session, and shows the trial's last days again", async () => {
    const session = sessionWith(TRIAL);
    const view = renderOffice(session, { hostRevision: 1 });
    fireEvent.click(await within(band()).findByRole("button", { name: DISMISS }));
    await waitFor(() => expect(band().childElementCount).toBe(0));
    const nav = screen.getByRole("navigation", { name: "Разделы офиса" });
    fireEvent.click(within(nav).getByRole("link", { name: "Информация" }));
    await screen.findByRole("heading", { name: "Информация", level: 1 });
    expect(band().childElementCount).toBe(0);
    // A new revision reads the license again: four days left is another warning.
    session.api.getLicense.mockResolvedValue(TRIAL_ENDING);
    view.rerender(
      <ThemeProvider defaultTheme="dark">
        <Office session={session} labels={quietLabelRendering()} hostRevision={2} />
      </ThemeProvider>,
    );
    expect(
      await within(band()).findByText(
        /Пробный период заканчивается 24\.10\. После этого новые смены не будут открываться без файла лицензии\./,
      ),
    ).toBeTruthy();
    expect(band().querySelector(".mk-alert--warn")).not.toBeNull();
  });

  it("keeps the grace's warning, with both dates in the organization's zone, and no «Скрыть»", async () => {
    renderOffice(sessionWith(GRACE));
    expect(
      await within(band()).findByText(
        /Срок лицензии истёк 31\.10\. До 14\.11 всё работает; затем новые смены не будут открываться\./,
      ),
    ).toBeTruthy();
    expect(within(band()).getByText("Ошибка:")).toBeTruthy();
    expect(within(band()).queryByRole("button", { name: DISMISS })).toBeNull();
  });

  it.each([
    [RESTRICTED, /Новые смены не открываются: лицензия площадки истекла\./],
    [TRIAL_EXPIRED, /Новые смены не открываются: пробный период закончился\./],
    [WRONG_HOST, /Лицензия выдана другому хосту\. Сохраните запрос на активацию/],
    [INN_MISMATCH, /ИНН организации больше не совпадает с ИНН лицензии/],
  ] as const)("keeps a serious warning on every page (%#)", async (license, text) => {
    renderOffice(sessionWith(license));
    expect(await within(band()).findByText(text)).toBeTruthy();
    expect(within(band()).queryByRole("button", { name: DISMISS })).toBeNull();
  });

  it("warns of the license's end and of the host's clock, both dismissible", async () => {
    renderOffice(sessionWith({ ...EXPIRING, flags: { clockBehindDays: 3, clockAhead: false } }));
    expect(
      await within(band()).findByText(/Лицензия заканчивается 31\.10\.2027\. Чтобы продлить/),
    ).toBeTruthy();
    expect(
      within(band()).getByText(/Часы ПК хоста отстают от последнего известного времени на 3 дн\./),
    ).toBeTruthy();
    expect(within(band()).getAllByRole("button", { name: DISMISS })).toHaveLength(2);
  });

  it("is empty and reads nothing more while the license is well or the host is silent", async () => {
    const session = sessionWith(ACTIVE_LICENSE);
    renderOffice(session);
    await screen.findByText(/Вы вошли как/);
    await waitFor(() => expect(session.api.getLicense).toHaveBeenCalled());
    expect(band().childElementCount).toBe(0);
    expect(session.api.getOrg).not.toHaveBeenCalled();
  });

  it("is empty when the host does not answer", async () => {
    const session = sessionWith(ACTIVE_LICENSE);
    session.api.getLicense.mockRejectedValue(new Error("down"));
    renderOffice(session);
    await screen.findByText(/Вы вошли как/);
    await waitFor(() => expect(session.api.getLicense).toHaveBeenCalled());
    expect(band().childElementCount).toBe(0);
  });

  it("leads to «Лицензия» on «Информация» and gives the focus to that section", async () => {
    renderOffice(sessionWith(RESTRICTED));
    fireEvent.click(await within(band()).findByRole("link", { name: "Открыть раздел «Лицензия»" }));
    await screen.findByRole("heading", { name: "Информация", level: 1 });
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById("license")));
  });

  it("is repeated on «Обзор» in its one polite region, without «Скрыть»", async () => {
    renderOffice(sessionWith(licenseOf({ ...RESTRICTED })));
    const region = overviewAlerts();
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(
      await within(region).findByText(/Новые смены не открываются: лицензия площадки истекла\./),
    ).toBeTruthy();
    expect(within(region).queryByRole("button", { name: DISMISS })).toBeNull();
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/license-banner.test.tsx
```

Ожидается: FAIL — `no license band`.

- [ ] **Step 3: Реализация**

Создать `apps/standalone/src/office/info/license/LicenseNotices.tsx`:

```tsx
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { Alert, Button, VisuallyHidden } from "@markiro/ui";

import type { OfficeLicense } from "../../../host/protocol.js";
import { useBackupTime } from "../../backups/backup-time.js";
import { officeKeys, useOfficeQuery } from "../../office-query.js";
import { licenseNotices, noticeNeedsTime, noticeText, type LicenseNotice } from "./license-view.js";

export interface ShownNotices {
  license: OfficeLicense;
  notices: LicenseNotice[];
  /** The organization's zone, or `null` for this PC's. */
  zone: string | null;
}

/**
 * The license's warnings to show now (spec §9.5): none while the license
 * loads, when it does not (the section explains a host that does not answer),
 * or when it warns of nothing. The organization's profile is read only when a
 * warning writes a date, so an office whose license is well asks nothing more.
 */
export function useLicenseNotices(): ShownNotices | null {
  const license = useOfficeQuery(officeKeys.license, (api, token) => api.getLicense(token));
  const notices = license.isSuccess ? licenseNotices(license.data) : [];
  const time = useBackupTime(notices.some(noticeNeedsTime));
  if (!license.isSuccess || !time.ready || notices.length === 0) return null;
  return { license: license.data, notices, zone: time.zone };
}

export interface LicenseNoticesProps extends ShownNotices {
  /** «Скрыть до конца сеанса» on a dismissible warning; none — no button (on «Обзор»). */
  onDismiss?: (notice: LicenseNotice) => void;
}

/**
 * The warnings, one alert each with a hidden word for its tone (a screen
 * reader does not hear the colour or the glyph) and a link to «Лицензия».
 * They live inside a polite region their caller keeps on the screen, so they
 * lose their own `alert` role (`presentation`).
 */
export function LicenseNotices({ license, notices, zone, onDismiss }: LicenseNoticesProps) {
  const { t } = useTranslation();
  return (
    <>
      {notices.map((notice) => {
        const text = noticeText(notice, license, zone);
        return (
          <Alert
            key={notice.kind}
            tone={notice.tone}
            role="presentation"
            action={
              onDismiss !== undefined && notice.dismissible ? (
                <Button variant="secondary" size="compact" onClick={() => onDismiss(notice)}>
                  {t("office.banner.license.dismiss")}
                </Button>
              ) : undefined
            }
          >
            <VisuallyHidden>{t(`office.banner.license.tone.${notice.tone}`)}</VisuallyHidden>{" "}
            {t(text.key, text.values)}{" "}
            <Link to="/about#license">{t("office.banner.license.link")}</Link>
          </Alert>
        );
      })}
    </>
  );
}
```

Создать `apps/standalone/src/office/LicenseBanner.tsx`:

```tsx
import { useState } from "react";

import { LicenseNotices, useLicenseNotices } from "./info/license/LicenseNotices.js";
import type { LicenseNoticeKind } from "./info/license/license-view.js";

/**
 * The band above the office's pages (extension point T3 of the license spec,
 * §9.5): the license's warnings on every page, in a polite region that is on
 * the screen from the start. A dismissible warning hides for the rest of the
 * session (`Office` lives as long as one session, and the shell with this
 * band as long as `Office`); a new kind of warning — the trial's last four
 * days after its first ten — shows again. The serious ones never hide.
 */
export function LicenseBanner() {
  const shown = useLicenseNotices();
  const [dismissed, setDismissed] = useState<ReadonlySet<LicenseNoticeKind>>(() => new Set());
  const visible =
    shown === null
      ? []
      : shown.notices.filter((notice) => !(notice.dismissible && dismissed.has(notice.kind)));
  return (
    <div className="office-banner" aria-live="polite">
      {shown !== null && visible.length > 0 && (
        <LicenseNotices
          license={shown.license}
          notices={visible}
          zone={shown.zone}
          onDismiss={(notice) => setDismissed((previous) => new Set([...previous, notice.kind]))}
        />
      )}
    </div>
  );
}
```

Правка `apps/standalone/src/office/OfficeShell.tsx`.

Фрагмент 1 (импорты):

<!-- prettier-ignore -->
```tsx
import { ChangePasswordDialog } from "./ChangePasswordDialog.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { ChangePasswordDialog } from "./ChangePasswordDialog.js";
import { LicenseBanner } from "./LicenseBanner.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
  useEffect(() => {
    // After a menu navigation, move focus to the new page so a screen
    // reader announces it; the first page keeps the browser's focus.
    if (shownPath.current === location.pathname) return;
    shownPath.current = location.pathname;
    mainRef.current?.focus();
  }, [location.pathname]);
```

заменить на:

<!-- prettier-ignore -->
```tsx
  useEffect(() => {
    // After a menu navigation, move focus to the new page so a screen
    // reader announces it; the first page keeps the browser's focus. A link
    // to an anchor (the license band's `/about#license`) leaves the focus to
    // the page, which gives it to that section (plan ЛЦ-3).
    if (shownPath.current === location.pathname) return;
    shownPath.current = location.pathname;
    if (location.hash !== "") return;
    mainRef.current?.focus();
  }, [location.pathname, location.hash]);
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
        </header>
        <main ref={mainRef} tabIndex={-1} className="office-shell__content">
```

заменить на:

<!-- prettier-ignore -->
```tsx
        </header>
        <LicenseBanner />
        <main ref={mainRef} tabIndex={-1} className="office-shell__content">
```

Правка `apps/standalone/src/office/OfficeOverview.tsx`.

Фрагмент 1 (импорты):

<!-- prettier-ignore -->
```tsx
import { BackupWarnings } from "./backups/BackupWarnings.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { BackupWarnings } from "./backups/BackupWarnings.js";
import { LicenseNotices, useLicenseNotices } from "./info/license/LicenseNotices.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
      <PageHeader title={t("office.overview.title")} />
      <OverviewBackups />
```

заменить на:

<!-- prettier-ignore -->
```tsx
      <PageHeader title={t("office.overview.title")} />
      {/*
        One polite region for every warning of «Обзор» (extension point T4 of
        the license spec): the license's, then the copies'. It is on the
        screen from the start, empty, so each warning is heard once.
      */}
      <div className="backup-alerts" aria-live="polite">
        <OverviewLicense />
        <OverviewBackups />
      </div>
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
/**
 * The backup warnings where the office opens (plan РК: a failed copy is
 * visible, not a line in a log). Nothing while the state loads or when it
 * does not: «Резервные копии» explains a host that does not answer. The
 * region that announces them is on the screen from the start, empty. The
 * organization's profile is read only when a warning has a time to write
 * (a restore that holds the facts).
 */
function OverviewBackups() {
  const { t } = useTranslation();
  const backups = useOfficeQuery(officeKeys.backups, (api, token) => api.getBackups(token));
  const time = useBackupTime(backups.isSuccess && backups.data.restoreHold !== null);
  const state = backups.isSuccess && time.ready ? backups.data : null;
  const warned = state !== null && backupWarnings(state).length > 0;
  return (
    <div className="backup-alerts" aria-live="polite">
      {warned && (
        <>
          <BackupWarnings state={state} format={time.format} />
          <Link to="/backups">{t("office.backups.overviewLink")}</Link>
        </>
      )}
    </div>
  );
}
```

заменить на:

<!-- prettier-ignore -->
```tsx
/** The license's warnings where the office opens (spec §9.5: «Обзор» repeats the band), without «Скрыть». */
function OverviewLicense() {
  const shown = useLicenseNotices();
  if (shown === null) return null;
  return <LicenseNotices license={shown.license} notices={shown.notices} zone={shown.zone} />;
}

/**
 * The backup warnings where the office opens (plan РК: a failed copy is
 * visible, not a line in a log). Nothing while the state loads or when it
 * does not: «Резервные копии» explains a host that does not answer. The
 * region that announces them is `OfficeOverview`'s, on the screen from the
 * start. The organization's profile is read only when a warning has a time
 * to write (a restore that holds the facts).
 */
function OverviewBackups() {
  const { t } = useTranslation();
  const backups = useOfficeQuery(officeKeys.backups, (api, token) => api.getBackups(token));
  const time = useBackupTime(backups.isSuccess && backups.data.restoreHold !== null);
  const state = backups.isSuccess && time.ready ? backups.data : null;
  if (state === null || backupWarnings(state).length === 0) return null;
  return (
    <>
      <BackupWarnings state={state} format={time.format} />
      <Link to="/backups">{t("office.backups.overviewLink")}</Link>
    </>
  );
}
```

Правка `apps/standalone/src/office/info/AboutPage.tsx` (каркас `fb-about`).

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
import { useTranslation } from "react-i18next";

import { PageHeader } from "@markiro/ui";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router";

import { PageHeader } from "@markiro/ui";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
  const role = useOfficeSession().user.role;
  const sections = ABOUT_SECTIONS.filter((section) => section.roles.includes(role));
```

заменить на:

<!-- prettier-ignore -->
```tsx
  const role = useOfficeSession().user.role;
  const sections = ABOUT_SECTIONS.filter((section) => section.roles.includes(role));
  const location = useLocation();
  useEffect(() => {
    // A link to a section's anchor (the license band, plan ЛЦ-3) brings that
    // section into view with the focus, so a keyboard and a screen reader start there.
    if (location.hash === "") return;
    document.getElementById(decodeURIComponent(location.hash.slice(1)))?.focus();
  }, [location.hash, location.key]);
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
        <div key={id} id={id}>
```

заменить на:

<!-- prettier-ignore -->
```tsx
        <div key={id} id={id} tabIndex={-1}>
```

Правка `apps/standalone/src/office/Office.tsx`.

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
import { createOfficeQueryClient } from "./office-query.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { createOfficeQueryClient, officeKeys } from "./office-query.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
    void session.refreshUser().catch(() => undefined);
  }, [hostRevision, session]);
```

заменить на:

<!-- prettier-ignore -->
```tsx
    void session.refreshUser().catch(() => undefined);
    // A phase of the license changes with a revision of its own (license spec
    // §8.2): the band, «Обзор» and «Лицензия» read it again.
    void queryClient.invalidateQueries({ queryKey: officeKeys.license });
  }, [hostRevision, session, queryClient]);
```

Правка `apps/standalone/src/app/shell.css`: после блока `.license-features li { … }` (задача 3) добавить:

<!-- prettier-ignore -->
```css
/*
  The license's band above the office's pages (plan ЛЦ-3): a polite region on
  the screen from the start; empty, it takes no room.
*/
.office-banner {
  display: grid;
  gap: 8px;
  padding: 12px 24px 0;
}

.office-banner:empty {
  position: absolute;
  width: 0;
  height: 0;
  padding: 0;
  overflow: hidden;
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/license-banner.test.tsx test/backups-page.test.tsx test/office.test.tsx test/about-page.test.tsx --reporter=verbose
```

Ожидается: PASS, в выводе нет `stderr |`. Тесты «Обзора» в `backups-page.test.tsx` («says nothing on «Обзор» while the copies are well» и соседние) остаются зелёными: лицензия по умолчанию действует, предупреждений нет, профиль не читается.

- [ ] **Step 5: Гейты и коммит**

<!-- prettier-ignore -->
```bash
node_modules/.bin/prettier --ignore-path .prettierignore --write apps/standalone/src/office/info/license/LicenseNotices.tsx apps/standalone/src/office/LicenseBanner.tsx apps/standalone/src/office/OfficeShell.tsx apps/standalone/src/office/OfficeOverview.tsx apps/standalone/src/office/info/AboutPage.tsx apps/standalone/src/office/Office.tsx apps/standalone/src/app/shell.css apps/standalone/test/license-banner.test.tsx
node_modules/.bin/prettier --ignore-path .prettierignore --check apps/standalone/src/office/info/license/LicenseNotices.tsx apps/standalone/src/office/LicenseBanner.tsx apps/standalone/src/office/OfficeShell.tsx apps/standalone/src/office/OfficeOverview.tsx apps/standalone/src/office/info/AboutPage.tsx apps/standalone/src/office/Office.tsx apps/standalone/src/app/shell.css apps/standalone/test/license-banner.test.tsx
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint
git diff --check
```

Сообщение (`/tmp/claude/lc3-t7-msg.txt`):

<!-- prettier-ignore -->
```text
feat(standalone): the license's band above the office and on «Обзор» (plan ЛЦ-3)

The office shell gets a polite band for the license's warnings: the trial
with its last four days in another tone, the license's end, the grace,
the restriction, another host, a changed INN and the host's clock; the
light ones hide for the session, the serious ones never. «Обзор» repeats
them in one region with the copies'; the link focuses «Лицензия», and
every revision of the host reads the license again.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

<!-- prettier-ignore -->
```bash
git add apps/standalone/src/office/info/license/LicenseNotices.tsx apps/standalone/src/office/LicenseBanner.tsx apps/standalone/src/office/OfficeShell.tsx apps/standalone/src/office/OfficeOverview.tsx apps/standalone/src/office/info/AboutPage.tsx apps/standalone/src/office/Office.tsx apps/standalone/src/app/shell.css apps/standalone/test/license-banner.test.tsx
git commit -F /tmp/claude/lc3-t7-msg.txt
```

---

### Task 8: Станция узнаёт лицензию: `HostApi.getDevice`, `useStationLicense`, строка состояния

**Files:**

- Create: `apps/standalone/src/floor/license.ts`, `apps/standalone/src/app/use-station-license.ts`
- Modify: `apps/standalone/src/host/api.ts`, `apps/standalone/src/floor/FloorStatusBar.tsx`, `apps/standalone/src/app/App.tsx`, `apps/standalone/src/i18n/ru.json`, `apps/standalone/test/support/office.tsx`, `apps/standalone/test/support/license.ts`
- Test: `apps/standalone/test/station-license.test.tsx` (новый), `apps/standalone/test/api.test.ts`, `apps/standalone/test/floor-status-bar.test.tsx`

**Interfaces:**

- Consumes: `deviceInfoSchema` с полем `license` и `DeviceLicense` `{ state, since, phaseEndsAt, emergencyUntil }` (ЛЦ-2), фикстура `device-license.json` (ответ `GET /v1/device` целиком), `lastMomentBefore`, `licenseDayMonth`, `licenseMinute`, `ShellState.hostRevision`, `ShellState.link`.
- Produces: `HostApi.getDevice: () => Promise<DeviceInfo>` (`GET /v1/device`, ключ устройства, Д3); `LicenseRefusal = "license_restricted" | "license_trial_expired" | "license_inn_mismatch"`, `opensBlocked(license)`, `licenseRefusalOf(details)`, `floorLicenseLine(license)`; хук `useStationLicense({ pairing, read, revision, online }): DeviceLicense | null`; проп `FloorStatusBar.license`; `App` передаёт `stationLicense` в строку состояния (и в задаче 9 — в `FloorApp`); тестовые `DEVICE_INFO`, `deviceLicense`.

- [ ] **Step 1: Написать падающие тесты**

Дописать в `apps/standalone/test/support/license.ts` (импорты слить с существующими: `import type { DeviceInfo, DeviceLicense, OfficeLicense } from "../../src/host/protocol.js";` и `import { DEVICE_ID, HOST_ID } from "./fixtures.js";`):

<!-- prettier-ignore -->
```ts
/** `GET /v1/device` without a license (a host before plan ЛЦ-2): the station stays silent. */
export const DEVICE_INFO: DeviceInfo = {
  id: DEVICE_ID,
  kind: "station",
  name: "Станция линии 1",
  lineId: null,
  pairedAt: "2026-09-26T09:15:00Z",
};

/** The license line of `GET /v1/device` in `state`. */
export function deviceLicense(
  state: string,
  phaseEndsAt: string | null = null,
  emergencyUntil: string | null = null,
): DeviceLicense {
  return { state, since: "2027-11-14T21:00:00Z", phaseEndsAt, emergencyUntil };
}
```

Правка `apps/standalone/test/support/office.tsx`: импорт

<!-- prettier-ignore -->
```ts
import { ACTIVE_LICENSE } from "./license.js";
```

заменить на:

<!-- prettier-ignore -->
```ts
import { ACTIVE_LICENSE, DEVICE_INFO } from "./license.js";
```

и строку

<!-- prettier-ignore -->
```ts
    getDeviceShifts: vi.fn<HostApi["getDeviceShifts"]>(async () => []),
```

заменить на:

<!-- prettier-ignore -->
```ts
    getDeviceShifts: vi.fn<HostApi["getDeviceShifts"]>(async () => []),
    // The station reads its license with its record (plan ЛЦ-3); a host that says nothing keeps it silent.
    getDevice: vi.fn<HostApi["getDevice"]>(async () => DEVICE_INFO),
```

Создать `apps/standalone/test/station-license.test.tsx`:

```tsx
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useStationLicense, type StationLicenseOptions } from "../src/app/use-station-license.js";
import { floorLicenseLine, licenseRefusalOf, opensBlocked } from "../src/floor/license.js";
import type { DeviceInfo, DeviceLicense } from "../src/host/protocol.js";
import i18n from "../src/i18n/index.js";
import { lastMomentBefore, licenseDayMonth, licenseMinute } from "../src/lib/license-dates.js";
import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";
import { DEVICE_INFO, deviceLicense } from "./support/license.js";

const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };
const GRACE_END = "2027-11-14T21:00:00Z";
const EMERGENCY_END = "2027-11-23T06:00:00Z";

function said(line: ReturnType<typeof floorLicenseLine>): string | null {
  return line === null ? null : i18n.t(line.key, line.values);
}

describe("the license on the floor (spec §9.6)", () => {
  it("is silent in the trial, while the license runs, in its last weeks, on another host and for a newer state", () => {
    for (const state of ["trial", "active", "expiring", "wrong_host", "some_future_state"]) {
      expect(floorLicenseLine(deviceLicense(state, GRACE_END))).toBeNull();
      expect(opensBlocked(deviceLicense(state))).toBeNull();
    }
    expect(floorLicenseLine(null)).toBeNull();
    expect(opensBlocked(null)).toBeNull();
  });

  it("tells everyone in the grace till when new shifts open, in this PC's zone", () => {
    const line = floorLicenseLine(deviceLicense("grace", GRACE_END));
    expect(line?.tone).toBe("warn");
    expect(said(line)).toBe(
      `Лицензия площадки истекла. Новые смены откроются до ${licenseDayMonth(lastMomentBefore(GRACE_END), null)}. Сообщите администратору.`,
    );
    expect(opensBlocked(deviceLicense("grace", GRACE_END))).toBeNull();
  });

  it.each([
    [
      "restricted",
      "license_restricted",
      "Новые смены не открываются: лицензия площадки истекла. Сообщите администратору.",
    ],
    [
      "trial_expired",
      "license_trial_expired",
      "Новые смены не открываются: пробный период закончился. Сообщите администратору.",
    ],
    [
      "inn_mismatch",
      "license_inn_mismatch",
      "Новые смены не открываются: ИНН организации не совпадает с лицензией. Сообщите администратору.",
    ],
  ] as const)("says %s and opens no new shift", (state, refusal, text) => {
    const line = floorLicenseLine(deviceLicense(state));
    expect(line?.tone).toBe("error");
    expect(said(line)).toBe(text);
    expect(opensBlocked(deviceLicense(state))).toBe(refusal);
    expect(licenseRefusalOf({ constraint: "license_restricted", state })).toBe(refusal);
  });

  it("opens new shifts while the emergency extension runs, and says till when", () => {
    const line = floorLicenseLine(deviceLicense("restricted", null, EMERGENCY_END));
    expect(line?.tone).toBe("warn");
    expect(said(line)).toBe(
      `Лицензия площадки истекла: новые смены открываются по аварийному продлению до ${licenseMinute(EMERGENCY_END, null)}. Сообщите администратору.`,
    );
    expect(opensBlocked(deviceLicense("restricted", null, EMERGENCY_END))).toBeNull();
  });

  it("reads a host's refusal without a state it knows as the license's restriction", () => {
    expect(licenseRefusalOf({ constraint: "license_restricted" })).toBe("license_restricted");
    expect(licenseRefusalOf({ constraint: "license_restricted", state: "from_a_newer_host" })).toBe(
      "license_restricted",
    );
  });
});

function recordWith(license?: DeviceLicense): DeviceInfo {
  return license === undefined ? DEVICE_INFO : { ...DEVICE_INFO, license };
}

function hookWith(initial: StationLicenseOptions) {
  return renderHook((props: StationLicenseOptions) => useStationLicense(props), {
    initialProps: initial,
  });
}

describe("useStationLicense", () => {
  it("reads once online and after every revision, and keeps what the host said", async () => {
    const read = vi.fn(async () => recordWith(deviceLicense("restricted")));
    const hook = hookWith({ pairing: PAIRING, read, revision: 1, online: true });
    await waitFor(() => expect(hook.result.current?.state).toBe("restricted"));
    read.mockResolvedValueOnce(recordWith(deviceLicense("active")));
    hook.rerender({ pairing: PAIRING, read, revision: 2, online: true });
    await waitFor(() => expect(hook.result.current?.state).toBe("active"));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps the last known state when a read fails and while the link is down", async () => {
    const read = vi.fn(async () => recordWith(deviceLicense("grace", GRACE_END)));
    const hook = hookWith({ pairing: PAIRING, read, revision: 1, online: true });
    await waitFor(() => expect(hook.result.current?.state).toBe("grace"));
    read.mockRejectedValueOnce(new Error("down"));
    hook.rerender({ pairing: PAIRING, read, revision: 2, online: true });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(hook.result.current?.state).toBe("grace");
    hook.rerender({ pairing: PAIRING, read, revision: 3, online: false });
    expect(read).toHaveBeenCalledTimes(2);
    expect(hook.result.current?.state).toBe("grace");
    hook.rerender({ pairing: PAIRING, read, revision: 3, online: true });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
  });

  it("is silent for a host that sends no license, asks nothing without a pairing, and forgets another pairing's", async () => {
    const read = vi.fn(async () => recordWith());
    const hook = hookWith({ pairing: null, read, revision: 1, online: true });
    expect(read).not.toHaveBeenCalled();
    expect(hook.result.current).toBeNull();
    read.mockResolvedValue(recordWith(deviceLicense("restricted")));
    hook.rerender({ pairing: PAIRING, read, revision: 1, online: true });
    await waitFor(() => expect(hook.result.current?.state).toBe("restricted"));
    read.mockImplementation(() => new Promise<DeviceInfo>(() => undefined));
    hook.rerender({
      pairing: { hostId: HOST_ID, deviceId: "1d2e3f4a-5b6c-4d7e-8f90-a1b2c3d4e5f6" },
      read,
      revision: 1,
      online: true,
    });
    expect(hook.result.current).toBeNull();
  });
});
```

Дописать в конец `apps/standalone/test/api.test.ts`:

<!-- prettier-ignore -->
```ts
describe("the station's own record (plan ЛЦ-3)", () => {
  it("reads GET /v1/device with the device key only, the site's license with it", async () => {
    const record = fixture("device-license.json") as { license: unknown };
    const reading = recording(record);
    await expect(reading.api.getDevice()).resolves.toMatchObject({ license: record.license });
    expect(reading.sent).toEqual([
      { method: "GET", path: "/v1/device", body: undefined, officeToken: undefined },
    ]);
    // A host before plan ЛЦ-2 sends no license: still a record.
    await expect(
      recording(fixture("device-info.json")).api.getDevice(),
    ).resolves.not.toHaveProperty("license");
  });
});
```

Дописать в конец `apps/standalone/test/floor-status-bar.test.tsx` (импорты слить с существующими):

<!-- prettier-ignore -->
```tsx
import { lastMomentBefore, licenseDayMonth } from "../src/lib/license-dates.js";
import { deviceLicense } from "./support/license.js";

/** The bar's polite region of warnings. */
function alerts(): HTMLElement {
  const found = document.querySelector(".floor-status__alerts");
  if (!(found instanceof HTMLElement)) throw new Error("no alerts region");
  return found;
}

describe("the license on the floor's status bar (plan ЛЦ-3)", () => {
  it.each(["trial", "active", "expiring", "wrong_host"])(
    "says nothing in the state %s",
    async (state) => {
      render(
        bar({ local: await synced([ORG]), license: deviceLicense(state, "2027-11-14T21:00:00Z") }),
      );
      await screen.findByText("ООО «Атолл»");
      expect(within(alerts()).queryByText(/лицензи|смены/i)).toBeNull();
    },
  );

  it("tells everyone in the grace till when new shifts open", async () => {
    render(
      bar({ local: await synced([ORG]), license: deviceLicense("grace", "2027-11-14T21:00:00Z") }),
    );
    const date = licenseDayMonth(lastMomentBefore("2027-11-14T21:00:00Z"), null);
    expect(
      await within(alerts()).findByText(
        `Лицензия площадки истекла. Новые смены откроются до ${date}. Сообщите администратору.`,
      ),
    ).toBeTruthy();
  });

  it.each([
    ["restricted", "Новые смены не открываются: лицензия площадки истекла. Сообщите администратору."],
    [
      "trial_expired",
      "Новые смены не открываются: пробный период закончился. Сообщите администратору.",
    ],
    [
      "inn_mismatch",
      "Новые смены не открываются: ИНН организации не совпадает с лицензией. Сообщите администратору.",
    ],
  ] as const)("says that no new shift opens in the state %s", async (state, text) => {
    render(bar({ local: await synced([ORG]), license: deviceLicense(state) }));
    const shown = await within(alerts()).findByText(text);
    expect(shown.closest(".mk-alert")?.classList.contains("mk-alert--error")).toBe(true);
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/station-license.test.tsx test/api.test.ts test/floor-status-bar.test.tsx
```

Ожидается: FAIL — нет `src/floor/license.ts`, `use-station-license.ts`, `HostApi.getDevice`, пропа `license`.

- [ ] **Step 3: Реализация**

Создать `apps/standalone/src/floor/license.ts`:

```ts
import type { DeviceLicense } from "../host/protocol.js";
import { lastMomentBefore, licenseDayMonth, licenseMinute } from "../lib/license-dates.js";

/** The states in which the host opens no new shift (license spec §3.2–3.3). */
const BLOCKED: ReadonlySet<string> = new Set(["restricted", "trial_expired", "inn_mismatch"]);

/** Why the station opens no new shift: the host's state, or its refusal `license_restricted`. */
export type LicenseRefusal =
  "license_restricted" | "license_trial_expired" | "license_inn_mismatch";

function refusalOfState(state: unknown): LicenseRefusal {
  if (state === "trial_expired") return "license_trial_expired";
  if (state === "inn_mismatch") return "license_inn_mismatch";
  return "license_restricted";
}

/**
 * The refusal to say before asking the host, from the license the station
 * last heard (`GET /v1/device`); `null` while new shifts open, while the
 * emergency extension runs (the host opens; once it has ended the host
 * refuses for itself, and the refusal is said), or when nothing is known.
 */
export function opensBlocked(license: DeviceLicense | null): LicenseRefusal | null {
  if (license === null || !BLOCKED.has(license.state) || license.emergencyUntil !== null) {
    return null;
  }
  return refusalOfState(license.state);
}

/** A host's `conflict` on `license_restricted`, by its `details.state`. */
export function licenseRefusalOf(details: Readonly<Record<string, unknown>>): LicenseRefusal {
  return refusalOfState(details.state);
}

/**
 * The status bar's line (spec §9.6): silent in the trial, while the license
 * runs, in its last weeks, on another host (all works there for 30 days)
 * and for a state a newer host adds; the grace says till when new shifts
 * open, the emergency till when it runs (this PC's zone), the restricted
 * states that none opens.
 */
export function floorLicenseLine(
  license: DeviceLicense | null,
): { tone: "warn" | "error"; key: string; values?: Record<string, string> } | null {
  if (license === null) return null;
  if (license.state === "grace") {
    return license.phaseEndsAt === null
      ? { tone: "warn", key: "floor.license.graceNoDate" }
      : {
          tone: "warn",
          key: "floor.license.grace",
          values: { date: licenseDayMonth(lastMomentBefore(license.phaseEndsAt), null) },
        };
  }
  if (!BLOCKED.has(license.state)) return null;
  if (license.emergencyUntil !== null) {
    return {
      tone: "warn",
      key: "floor.license.emergency",
      values: { until: licenseMinute(license.emergencyUntil, null) },
    };
  }
  return { tone: "error", key: `floor.license.${license.state}` };
}
```

Создать `apps/standalone/src/app/use-station-license.ts`:

```ts
import { useEffect, useState } from "react";

import type { DeviceInfo, DeviceLicense } from "../host/protocol.js";

export interface StationLicenseOptions {
  /** The station whose host is asked; `null` asks nothing (unpaired, an office PC, a stopped link). */
  pairing: { hostId: string; deviceId: string } | null;
  /** `HostApi.getDevice`. */
  read: () => Promise<DeviceInfo>;
  /** `ShellState.hostRevision`: a phase of the license changes with a revision (spec §8.2), so each one reads again. */
  revision: number | null;
  /** The link to the host is online: going online reads again, and nothing is asked while it is not. */
  online: boolean;
}

/**
 * The site's license as the station last heard it (`GET /v1/device`, field
 * `license`; plan ЛЦ-3): read when the link comes online and after every
 * revision, kept in memory for this pairing only (spec §9.6: without the host
 * the last known state; after a restart the first answer). A failed read keeps
 * what was known: opening a shift needs the host anyway, and it then answers
 * for itself. A host before plan ЛЦ-2 sends no field, which is `null`: silence.
 */
export function useStationLicense({
  pairing,
  read,
  revision,
  online,
}: StationLicenseOptions): DeviceLicense | null {
  const key = pairing === null ? null : `${pairing.hostId}:${pairing.deviceId}`;
  const [known, setKnown] = useState<{ key: string; license: DeviceLicense | null } | null>(null);
  useEffect(() => {
    if (key === null || !online) return;
    let cancelled = false;
    read().then(
      (record) => {
        if (!cancelled) setKnown({ key, license: record.license ?? null });
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [key, read, revision, online]);
  return known !== null && known.key === key ? known.license : null;
}
```

Правка `apps/standalone/src/host/api.ts`.

Фрагмент 1 (импорты из `./protocol.js`):

<!-- prettier-ignore -->
```ts
  counterpartyRecordSchema,
  deviceRecordSchema,
```

заменить на:

<!-- prettier-ignore -->
```ts
  counterpartyRecordSchema,
  deviceInfoSchema,
  deviceRecordSchema,
```

и

<!-- prettier-ignore -->
```ts
  type CounterpartyUpdate,
  type DeviceRecord,
```

заменить на:

<!-- prettier-ignore -->
```ts
  type CounterpartyUpdate,
  type DeviceInfo,
  type DeviceRecord,
```

Фрагмент 2 (интерфейс):

<!-- prettier-ignore -->
```ts
  /**
   * The station's shifts, with the device key only: the planned and active
   * shifts of its line and those it entered, active or closed within 30
   * days. Stations only (`forbidden` for another kind).
   */
  getDeviceShifts: () => Promise<DeviceShift[]>;
```

заменить на:

<!-- prettier-ignore -->
```ts
  /**
   * This device's record (`GET /v1/device`) with the site's license (field
   * `license`, plan ЛЦ-2), with the device key only (plan ЛЦ-3). The shell's
   * `device_refresh` keeps the line from the same route; this read carries
   * only what the floor shows.
   */
  getDevice: () => Promise<DeviceInfo>;
  /**
   * The station's shifts, with the device key only: the planned and active
   * shifts of its line and those it entered, active or closed within 30
   * days. Stations only (`forbidden` for another kind).
   */
  getDeviceShifts: () => Promise<DeviceShift[]>;
```

Фрагмент 3 (реализация):

<!-- prettier-ignore -->
```ts
    getDeviceShifts: async () =>
      (await client.request("GET", "/v1/device/shifts", { schema: deviceShiftsSchema })).shifts,
```

заменить на:

<!-- prettier-ignore -->
```ts
    getDevice: () => client.request("GET", "/v1/device", { schema: deviceInfoSchema }),
    getDeviceShifts: async () =>
      (await client.request("GET", "/v1/device/shifts", { schema: deviceShiftsSchema })).shifts,
```

Правка `apps/standalone/src/floor/FloorStatusBar.tsx`.

Фрагмент 1 (импорты):

<!-- prettier-ignore -->
```tsx
import type { HostStatus } from "../host/protocol.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import type { DeviceLicense, HostStatus } from "../host/protocol.js";
```

и

<!-- prettier-ignore -->
```tsx
import { readFloorPlace, type FloorPlace } from "./floor-status.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { readFloorPlace, type FloorPlace } from "./floor-status.js";
import { floorLicenseLine } from "./license.js";
```

Фрагмент 2 (пропы):

<!-- prettier-ignore -->
```tsx
  /** `ShellState.factsFailure`: why the last send of the outbox failed; `null` when it did not. */
  factsFailure: FactsFailure | null;
```

заменить на:

<!-- prettier-ignore -->
```tsx
  /** `ShellState.factsFailure`: why the last send of the outbox failed; `null` when it did not. */
  factsFailure: FactsFailure | null;
  /** The site's license as the station last heard it (`useStationLicense`, plan ЛЦ-3); `null` — nothing to say. */
  license?: DeviceLicense | null;
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
  factsFailure,
  now = systemClock,
}: FloorStatusBarProps) {
  const { t } = useTranslation();
```

заменить на:

<!-- prettier-ignore -->
```tsx
  factsFailure,
  license = null,
  now = systemClock,
}: FloorStatusBarProps) {
  const { t } = useTranslation();
  const licenseLine = floorLicenseLine(license);
```

Фрагмент 4 (в области `floor-status__alerts`):

<!-- prettier-ignore -->
```tsx
          {deviceNotSaved && (
            <Alert tone="warn" role="presentation">
              {t("floor.status.deviceNotSaved")}
            </Alert>
          )}
```

заменить на:

<!-- prettier-ignore -->
```tsx
          {licenseLine !== null && (
            <Alert tone={licenseLine.tone} role="presentation">
              {t(licenseLine.key, licenseLine.values)}
            </Alert>
          )}
          {deviceNotSaved && (
            <Alert tone="warn" role="presentation">
              {t("floor.status.deviceNotSaved")}
            </Alert>
          )}
```

Правка `apps/standalone/src/app/App.tsx`.

Фрагмент 1 (импорты):

<!-- prettier-ignore -->
```tsx
import { NetworkPairing } from "./NetworkPairing.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { NetworkPairing } from "./NetworkPairing.js";
import { useStationLicense } from "./use-station-license.js";
```

Фрагмент 2 (сразу после вызова `useHostLink`):

<!-- prettier-ignore -->
```tsx
    sendWarehouseRecords: hostApi.sendWarehouseRecords,
    dispatch,
  });
```

заменить на:

<!-- prettier-ignore -->
```tsx
    sendWarehouseRecords: hostApi.sendWarehouseRecords,
    dispatch,
  });
  // The site's license as this station last heard it (plan ЛЦ-3): the floor's
  // status bar and, on the shifts, what cannot be opened. An office PC asks nothing.
  const stationLicense = useStationLicense({
    pairing:
      linked !== null && role !== "office" && linked.kind === "station"
        ? { hostId: linked.hostId, deviceId: linked.deviceId }
        : null,
    read: hostApi.getDevice,
    revision: state.hostRevision,
    online: state.link?.state === "online",
  });
```

Фрагмент 3 (строка состояния):

<!-- prettier-ignore -->
```tsx
            refusalHeld={state.pendingRejection !== null || state.pendingOtherHost}
            otherHostHeld={state.pendingRejection === null && state.pendingOtherHost}
          />
```

заменить на:

<!-- prettier-ignore -->
```tsx
            refusalHeld={state.pendingRejection !== null || state.pendingOtherHost}
            otherHostHeld={state.pendingRejection === null && state.pendingOtherHost}
            license={stationLicense}
          />
```

(Если переменная роли установки в `App` называется не `role` — взять ту, по которой `view` уводит офисный ПК на `office_login`; записать в «Отклонения».)

Правка `apps/standalone/src/i18n/ru.json`: в объект `floor` добавить:

<!-- prettier-ignore -->
```json
"license": {
  "grace": "Лицензия площадки истекла. Новые смены откроются до {{date}}. Сообщите администратору.",
  "graceNoDate": "Лицензия площадки истекла. Скоро новые смены перестанут открываться. Сообщите администратору.",
  "emergency": "Лицензия площадки истекла: новые смены открываются по аварийному продлению до {{until}}. Сообщите администратору.",
  "restricted": "Новые смены не открываются: лицензия площадки истекла. Сообщите администратору.",
  "trial_expired": "Новые смены не открываются: пробный период закончился. Сообщите администратору.",
  "inn_mismatch": "Новые смены не открываются: ИНН организации не совпадает с лицензией. Сообщите администратору."
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/station-license.test.tsx test/api.test.ts test/floor-status-bar.test.tsx test/app.test.tsx --reporter=verbose
```

Ожидается: PASS, в выводе нет `stderr |`. `app.test.tsx` зелёный: поддельный `getDevice` по умолчанию лицензии не несёт.

- [ ] **Step 5: Гейты и коммит**

<!-- prettier-ignore -->
```bash
node_modules/.bin/prettier --ignore-path .prettierignore --write apps/standalone/src/floor/license.ts apps/standalone/src/app/use-station-license.ts apps/standalone/src/host/api.ts apps/standalone/src/floor/FloorStatusBar.tsx apps/standalone/src/app/App.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/support/office.tsx apps/standalone/test/support/license.ts apps/standalone/test/station-license.test.tsx apps/standalone/test/api.test.ts apps/standalone/test/floor-status-bar.test.tsx
node_modules/.bin/prettier --ignore-path .prettierignore --check apps/standalone/src/floor/license.ts apps/standalone/src/app/use-station-license.ts apps/standalone/src/host/api.ts apps/standalone/src/floor/FloorStatusBar.tsx apps/standalone/src/app/App.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/support/office.tsx apps/standalone/test/support/license.ts apps/standalone/test/station-license.test.tsx apps/standalone/test/api.test.ts apps/standalone/test/floor-status-bar.test.tsx
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint
git diff --check
```

Сообщение (`/tmp/claude/lc3-t8-msg.txt`):

<!-- prettier-ignore -->
```text
feat(standalone): the station hears the site's license and says it (plan ЛЦ-3)

HostApi.getDevice reads GET /v1/device with its license field; the
station keeps the last state it heard for its pairing, reads again on
every revision and when the link comes back, and its status bar says the
grace with its date, the emergency extension with its end and that no
new shift opens, silent otherwise.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

<!-- prettier-ignore -->
```bash
git add apps/standalone/src/floor/license.ts apps/standalone/src/app/use-station-license.ts apps/standalone/src/host/api.ts apps/standalone/src/floor/FloorStatusBar.tsx apps/standalone/src/app/App.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/support/office.tsx apps/standalone/test/support/license.ts apps/standalone/test/station-license.test.tsx apps/standalone/test/api.test.ts apps/standalone/test/floor-status-bar.test.tsx
git commit -F /tmp/claude/lc3-t8-msg.txt
```

---

### Task 9: Смены станции: объяснение вместо открытия, отказы `license_restricted` и `feature_disabled`

**Files:**

- Modify: `apps/standalone/src/floor/shifts/ShiftCard.tsx`, `apps/standalone/src/floor/shifts/ShiftList.tsx`, `apps/standalone/src/floor/shifts/NewShift.tsx`, `apps/standalone/src/floor/shifts/shift-entry.ts`, `apps/standalone/src/floor/shifts/new-shift.ts`, `apps/standalone/src/floor/FloorApp.tsx`, `apps/standalone/src/app/App.tsx`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/floor-shift-list.test.tsx`, `apps/standalone/test/floor-new-shift.test.tsx`

**Interfaces:**

- Consumes: `opensBlocked`, `licenseRefusalOf`, `LicenseRefusal` (задача 8), `stationLicense` в `App`.
- Produces: `cardAction(copy, deviceId, online, blocked?: LicenseRefusal | null)` → `{ kind: "blocked"; refusal }` для запланированной смены; `EntryRefusal` и `CreateRefusal` получают `LicenseRefusal`, `CreateRefusal` ещё `"feature_pallets" | "feature_disabled"`; пропы `license?: DeviceLicense | null` у `ShiftList`, `NewShift`, `FloorApp`.

- [ ] **Step 1: Написать падающие тесты**

Правка `apps/standalone/test/floor-shift-list.test.tsx`.

Фрагмент 1 (импорты; слить с существующими):

<!-- prettier-ignore -->
```tsx
import type { DeviceLicense } from "../src/host/protocol.js";
import { HostError } from "../src/host/client.js";
import { deviceLicense } from "./support/license.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
  /** The queue of what was not sent (plan ОЧ); none — no button. */
  onQueue?: () => void;
}

function listOf(
```

заменить на:

<!-- prettier-ignore -->
```tsx
  /** The queue of what was not sent (plan ОЧ); none — no button. */
  onQueue?: () => void;
  /** The site's license as the station last heard it (plan ЛЦ-3). */
  license?: DeviceLicense | null;
}

function listOf(
```

Фрагмент 3 (в `listOf`):

<!-- prettier-ignore -->
```tsx
        {...(options.onQueue === undefined ? {} : { onQueue: options.onQueue })}
      />
```

заменить на:

<!-- prettier-ignore -->
```tsx
        {...(options.onQueue === undefined ? {} : { onQueue: options.onQueue })}
        {...(options.license === undefined ? {} : { license: options.license })}
      />
```

Фрагмент 4 — в конец файла:

<!-- prettier-ignore -->
```tsx
describe("the shifts while the site's license opens no new shift (plan ЛЦ-3)", () => {
  const BLOCKED = "Новые смены не открываются: лицензия площадки истекла. Сообщите администратору.";

  it("explains in place of «Открыть» and «Новая смена», and still continues this station's own shift", async () => {
    const { executor } = await copiesOf([PLANNED, MINE], [ENTERED_MINE]);
    // Without the host, so «Продолжить» works from the stored snapshot, as in the tests above.
    const { handlers } = renderList(executor, {
      license: deviceLicense("restricted"),
      online: false,
    });
    await screen.findByText("OCT26-005/S");
    const planned = card("OCT26-005/S");
    expect(within(planned).queryByRole("button")).toBeNull();
    expect(within(planned).getByText(BLOCKED)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Новая смена" })).toBeNull();
    expect(screen.getAllByText(BLOCKED)).toHaveLength(2);
    const mine = card(MINE.number);
    fireEvent.click(within(mine).getByRole("button", { name: "Продолжить" }));
    await waitFor(() => expect(handlers.onEntered).toHaveBeenCalledTimes(1));
  });

  it("opens as before in the grace", async () => {
    const { executor } = await copiesOf([PLANNED]);
    renderList(executor, { license: deviceLicense("grace", "2027-11-14T21:00:00Z") });
    expect(await screen.findByRole("button", { name: "Открыть" })).toHaveProperty("disabled", false);
    expect(screen.getByRole("button", { name: "Новая смена" })).toBeTruthy();
  });

  it("says the host's refusal to open by the state it names", async () => {
    const { executor } = await copiesOf([PLANNED]);
    renderList(executor, {
      enter: async () => {
        throw new HostError({
          kind: "api",
          code: "conflict",
          status: 409,
          message: "restricted",
          details: { constraint: "license_restricted", state: "trial_expired", since: "2026-10-24T09:00:00Z" },
        });
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Открыть" }));
    expect(
      await screen.findByText(
        "Новые смены не открываются: пробный период закончился. Сообщите администратору.",
      ),
    ).toBeTruthy();
  });
});
```

Правка `apps/standalone/test/floor-new-shift.test.tsx`.

Фрагмент 1 (импорты; слить с существующими):

<!-- prettier-ignore -->
```tsx
import type { DeviceLicense } from "../src/host/protocol.js";
import { deviceLicense } from "./support/license.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
interface Options {
  online?: boolean;
  create?: (create: DeviceShiftCreate) => Promise<DeviceShift>;
  enter?: (id: string) => Promise<EnteredShift>;
  now?: Date;
}
```

заменить на:

<!-- prettier-ignore -->
```tsx
interface Options {
  online?: boolean;
  create?: (create: DeviceShiftCreate) => Promise<DeviceShift>;
  enter?: (id: string) => Promise<EnteredShift>;
  now?: Date;
  /** The site's license as the station last heard it (plan ЛЦ-3). */
  license?: DeviceLicense | null;
}
```

Фрагмент 3 (в `renderNew`):

<!-- prettier-ignore -->
```tsx
        now={() => options.now ?? NOW}
      />
```

заменить на:

<!-- prettier-ignore -->
```tsx
        now={() => options.now ?? NOW}
        {...(options.license === undefined ? {} : { license: options.license })}
      />
```

Фрагмент 4 — в конец файла (если `HostError` ещё не импортирован — добавить `import { HostError } from "../src/host/client.js";`):

<!-- prettier-ignore -->
```tsx
describe("a new shift and the site's license (plan ЛЦ-3)", () => {
  function refusal(details: Record<string, unknown>): HostError {
    return new HostError({ kind: "api", code: "conflict", status: 409, message: "refused", details });
  }

  it("explains in place of «Создать и открыть» while no new shift opens, and asks the host nothing", async () => {
    const { handlers } = renderNew(await copiesOf(PALLET_COPIES), {
      license: deviceLicense("inn_mismatch"),
    });
    await chooseMilk();
    expect(screen.queryByRole("button", { name: "Создать и открыть" })).toBeNull();
    expect(
      screen.getByText(
        "Новые смены не открываются: ИНН организации не совпадает с лицензией. Сообщите администратору.",
      ),
    ).toBeTruthy();
    expect(handlers.create).not.toHaveBeenCalled();
  });

  it("says the host's refusal to create by the state it names", async () => {
    renderNew(await copiesOf(PALLET_COPIES), {
      create: async () => {
        throw refusal({ constraint: "license_restricted", state: "restricted" });
      },
    });
    await chooseMilk();
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
    expect(
      await screen.findByText(
        "Новые смены не открываются: лицензия площадки истекла. Сообщите администратору.",
      ),
    ).toBeTruthy();
  });

  it("says pallets are not in the license, and any other feature without its name", async () => {
    renderNew(await copiesOf(PALLET_COPIES), {
      create: async () => {
        throw refusal({ constraint: "feature_disabled", feature: "pallets" });
      },
    });
    await chooseMilk();
    fireEvent.click(screen.getByRole("button", { name: "Создать и открыть" }));
    expect(
      await screen.findByText(
        "Эта возможность не входит в лицензию площадки: паллеты. Создайте смену без паллет или сообщите администратору.",
      ),
    ).toBeTruthy();
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-shift-list.test.tsx test/floor-new-shift.test.tsx
```

Ожидается: FAIL — проп `license` не действует, отказы `license_restricted` и `feature_disabled` показываются как «failed».

- [ ] **Step 3: Реализация**

Правка `apps/standalone/src/floor/shifts/shift-entry.ts`.

Фрагмент 1 (импорты):

<!-- prettier-ignore -->
```ts
import { shellActionFor } from "../../app/shell.js";
```

заменить на:

<!-- prettier-ignore -->
```ts
import { shellActionFor } from "../../app/shell.js";
import { licenseRefusalOf, type LicenseRefusal } from "../license.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
  | "unreadable"
  | "local"
  | "failed";
```

заменить на (в типе `EntryRefusal`):

<!-- prettier-ignore -->
```ts
  | "unreadable"
  | "local"
  | "failed"
  /** The site's license opens no new shift (plan ЛЦ-3), by the state the host names. */
  | LicenseRefusal;
```

Фрагмент 3:

<!-- prettier-ignore -->
```ts
    if (error.code === "not_found") return { kind: "refused", reason: "not_found" };
    const constraint = error.details["constraint"];
```

заменить на:

<!-- prettier-ignore -->
```ts
    if (error.code === "not_found") return { kind: "refused", reason: "not_found" };
    if (error.code === "conflict" && error.details["constraint"] === "license_restricted") {
      return { kind: "refused", reason: licenseRefusalOf(error.details) };
    }
    const constraint = error.details["constraint"];
```

Правка `apps/standalone/src/floor/shifts/new-shift.ts`.

Фрагмент 1 (импорты; рядом с `shellActionFor`):

<!-- prettier-ignore -->
```ts
import { shellActionFor } from "../../app/shell.js";
```

заменить на:

<!-- prettier-ignore -->
```ts
import { shellActionFor } from "../../app/shell.js";
import { licenseRefusalOf, type LicenseRefusal } from "../license.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
export type CreateRefusal =
  | "no_link"
  | "product_inactive"
  | "template"
  | "pallet_template"
  | "invalid"
  | "no_line"
  | "failed";
```

заменить на:

<!-- prettier-ignore -->
```ts
export type CreateRefusal =
  | "no_link"
  | "product_inactive"
  | "template"
  | "pallet_template"
  | "invalid"
  | "no_line"
  | "failed"
  /** The site's license opens no new shift (plan ЛЦ-3), by the state the host names. */
  | LicenseRefusal
  /** The license lacks pallets, or another feature (`feature_disabled`, spec §4.7). */
  | "feature_pallets"
  | "feature_disabled";
```

Фрагмент 3:

<!-- prettier-ignore -->
```ts
      if (constraint === "shift_line") return { kind: "refused", reason: "no_line" };
      return { kind: "refused", reason: "failed" };
```

заменить на:

<!-- prettier-ignore -->
```ts
      if (constraint === "shift_line") return { kind: "refused", reason: "no_line" };
      if (constraint === "license_restricted") {
        return { kind: "refused", reason: licenseRefusalOf(error.details) };
      }
      if (constraint === "feature_disabled") {
        return {
          kind: "refused",
          reason: error.details["feature"] === "pallets" ? "feature_pallets" : "feature_disabled",
        };
      }
      return { kind: "refused", reason: "failed" };
```

Правка `apps/standalone/src/floor/shifts/ShiftCard.tsx`.

Фрагмент 1 (импорты):

<!-- prettier-ignore -->
```tsx
import type { ShiftCopy } from "./shift-copies.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import type { LicenseRefusal } from "../license.js";
import type { ShiftCopy } from "./shift-copies.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
export type CardAction =
  | { kind: "open"; enabled: boolean }
  | { kind: "continue"; enabled: boolean }
  | { kind: "finish" }
  | { kind: "busy" }
  | { kind: "closing" };
```

заменить на:

<!-- prettier-ignore -->
```tsx
export type CardAction =
  | { kind: "open"; enabled: boolean }
  | { kind: "continue"; enabled: boolean }
  | { kind: "finish" }
  | { kind: "busy" }
  | { kind: "closing" }
  /** A planned shift the site's license does not let open (plan ЛЦ-3): words in place of «Открыть». */
  | { kind: "blocked"; refusal: LicenseRefusal };
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
export function cardAction(copy: ShiftCopy, deviceId: string, online: boolean): CardAction {
  if (copy.localState === "closing") return { kind: "closing" };
  if (copy.status === "closed") return { kind: "finish" };
  if (copy.status === "active") {
    if (copy.ownerDeviceId !== deviceId) return { kind: "busy" };
    return { kind: "continue", enabled: online || copy.entered };
  }
  return { kind: "open", enabled: online };
}
```

заменить на:

<!-- prettier-ignore -->
```tsx
export function cardAction(
  copy: ShiftCopy,
  deviceId: string,
  online: boolean,
  blocked: LicenseRefusal | null = null,
): CardAction {
  if (copy.localState === "closing") return { kind: "closing" };
  if (copy.status === "closed") return { kind: "finish" };
  if (copy.status === "active") {
    if (copy.ownerDeviceId !== deviceId) return { kind: "busy" };
    // Never closed by the license: the station's own shift goes on (spec §3.3).
    return { kind: "continue", enabled: online || copy.entered };
  }
  if (blocked !== null) return { kind: "blocked", refusal: blocked };
  return { kind: "open", enabled: online };
}
```

Фрагмент 4:

<!-- prettier-ignore -->
```tsx
      <Button
        size="floor"
        fullWidth
        variant={action.kind === "continue" || action.kind === "finish" ? "primary" : "secondary"}
        disabled={busy || !enabled}
        onClick={onAction}
      >
        {t(`floor.shifts.action.${action.kind}`)}
      </Button>
```

заменить на:

<!-- prettier-ignore -->
```tsx
      {action.kind === "blocked" ? (
        // In place of «Открыть» (spec §9.6): the host would refuse, and the operator is told why.
        <p className="shift-card__hint">{t(`floor.shifts.refused.${action.refusal}`)}</p>
      ) : (
        <Button
          size="floor"
          fullWidth
          variant={action.kind === "continue" || action.kind === "finish" ? "primary" : "secondary"}
          disabled={busy || !enabled}
          onClick={onAction}
        >
          {t(`floor.shifts.action.${action.kind}`)}
        </Button>
      )}
```

Правка `apps/standalone/src/floor/shifts/ShiftList.tsx`.

Фрагмент 1 (импорты):

<!-- prettier-ignore -->
```tsx
import type { EnteredShift } from "../../host/protocol.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import type { DeviceLicense, EnteredShift } from "../../host/protocol.js";
```

и

<!-- prettier-ignore -->
```tsx
import { readRefusedCloses } from "../close/shift-close.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { readRefusedCloses } from "../close/shift-close.js";
import { opensBlocked } from "../license.js";
```

Фрагмент 2 (пропы):

<!-- prettier-ignore -->
```tsx
  /** The queue of what was not sent (plan ОЧ); none — no button. */
  onQueue?: () => void;
}
```

заменить на (в `ShiftListProps`):

<!-- prettier-ignore -->
```tsx
  /** The queue of what was not sent (plan ОЧ); none — no button. */
  onQueue?: () => void;
  /** The site's license as the station last heard it (plan ЛЦ-3); `null` — nothing known. */
  license?: DeviceLicense | null;
}
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
  onWarehouse,
  onQueue,
}: ShiftListProps) {
  const { t } = useTranslation();
```

заменить на:

<!-- prettier-ignore -->
```tsx
  onWarehouse,
  onQueue,
  license = null,
}: ShiftListProps) {
  const { t } = useTranslation();
  const blocked = opensBlocked(license);
```

Фрагмент 4:

<!-- prettier-ignore -->
```tsx
            action={cardAction(copy, deviceId, online)}
```

заменить на:

<!-- prettier-ignore -->
```tsx
            action={cardAction(copy, deviceId, online, blocked)}
```

Фрагмент 5:

<!-- prettier-ignore -->
```tsx
          <Button size="floor" disabled={busy || !online} onClick={onNew}>
            {t("floor.shifts.new")}
          </Button>
```

заменить на:

<!-- prettier-ignore -->
```tsx
          {blocked === null && (
            <Button size="floor" disabled={busy || !online} onClick={onNew}>
              {t("floor.shifts.new")}
            </Button>
          )}
```

Фрагмент 6:

<!-- prettier-ignore -->
```tsx
        {!online && <p className="shift-card__hint">{t("floor.shifts.newNeedsLink")}</p>}
```

заменить на:

<!-- prettier-ignore -->
```tsx
        {blocked !== null && (
          // In place of «Новая смена» (spec §9.6), from the license the station last heard.
          <p className="shift-card__hint">{t(`floor.shifts.refused.${blocked}`)}</p>
        )}
        {blocked === null && !online && (
          <p className="shift-card__hint">{t("floor.shifts.newNeedsLink")}</p>
        )}
```

Правка `apps/standalone/src/floor/shifts/NewShift.tsx`.

Фрагмент 1 (импорты):

<!-- prettier-ignore -->
```tsx
import type { DeviceShift, DeviceShiftCreate, EnteredShift } from "../../host/protocol.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import type {
  DeviceLicense,
  DeviceShift,
  DeviceShiftCreate,
  EnteredShift,
} from "../../host/protocol.js";
```

и

<!-- prettier-ignore -->
```tsx
import type { ScanSource } from "../scan-source.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { opensBlocked } from "../license.js";
import type { ScanSource } from "../scan-source.js";
```

Фрагмент 2 (пропы):

<!-- prettier-ignore -->
```tsx
  /** This computer's clock; tests give their own. */
  now?: () => Date;
}
```

заменить на (в `NewShiftProps`):

<!-- prettier-ignore -->
```tsx
  /** This computer's clock; tests give their own. */
  now?: () => Date;
  /** The site's license as the station last heard it (plan ЛЦ-3); `null` — nothing known. */
  license?: DeviceLicense | null;
}
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
  newRequestId = () => crypto.randomUUID(),
  now = () => new Date(),
}: NewShiftProps) {
  const { t } = useTranslation();
```

заменить на:

<!-- prettier-ignore -->
```tsx
  newRequestId = () => crypto.randomUUID(),
  now = () => new Date(),
  license = null,
}: NewShiftProps) {
  const { t } = useTranslation();
  const blocked = opensBlocked(license);
```

Фрагмент 4 (кнопка создания в `formStep`):

<!-- prettier-ignore -->
```tsx
        <div className="standalone-form__actions">
          <Button
            size="floor"
            loading={busy !== null}
```

заменить на:

<!-- prettier-ignore -->
```tsx
        {blocked !== null && (
          // In place of «Создать и открыть» (spec §9.6): the host would refuse to open it.
          <Alert tone="error">{t(`floor.newShift.refused.${blocked}`)}</Alert>
        )}
        <div className="standalone-form__actions">
          {blocked === null && (
          <Button
            size="floor"
            loading={busy !== null}
```

и закрыть условие после этой кнопки:

<!-- prettier-ignore -->
```tsx
            {form.created === null
              ? t("floor.newShift.create")
              : t("floor.newShift.openCreated", { number: form.created.shift.number })}
          </Button>
```

заменить на:

<!-- prettier-ignore -->
```tsx
            {form.created === null
              ? t("floor.newShift.create")
              : t("floor.newShift.openCreated", { number: form.created.shift.number })}
          </Button>
          )}
```

(prettier выровняет отступы.)

Правка `apps/standalone/src/floor/FloorApp.tsx`.

Фрагмент 1 (импорты):

<!-- prettier-ignore -->
```tsx
import type {
```

— в существующий импорт типов из `../host/protocol.js` добавить `DeviceLicense` (по алфавиту, рядом с `DeviceShift`).

Фрагмент 2 (пропы):

<!-- prettier-ignore -->
```tsx
  rejectionPending: boolean;
  /** `HostApi.enterShift`. */
  enter: (shiftId: string) => Promise<EnteredShift>;
```

заменить на:

<!-- prettier-ignore -->
```tsx
  rejectionPending: boolean;
  /** The site's license as the station last heard it (`useStationLicense`, plan ЛЦ-3). */
  license?: DeviceLicense | null;
  /** `HostApi.enterShift`. */
  enter: (shiftId: string) => Promise<EnteredShift>;
```

Фрагмент 3:

<!-- prettier-ignore -->
```tsx
  lineChangePending,
  rejectionPending,
  enter,
```

заменить на:

<!-- prettier-ignore -->
```tsx
  lineChangePending,
  rejectionPending,
  license = null,
  enter,
```

Фрагмент 4 (`NewShift`):

<!-- prettier-ignore -->
```tsx
        onBack={() => setView({ kind: "list" })}
      />
    );
  }
```

заменить на:

<!-- prettier-ignore -->
```tsx
        onBack={() => setView({ kind: "list" })}
        license={license}
      />
    );
  }
```

Фрагмент 5 (`ShiftList`):

<!-- prettier-ignore -->
```tsx
      onNew={() => setView({ kind: "new_shift" })}
```

заменить на:

<!-- prettier-ignore -->
```tsx
      onNew={() => setView({ kind: "new_shift" })}
      license={license}
```

Правка `apps/standalone/src/app/App.tsx`, фрагмент (у `FloorApp`):

<!-- prettier-ignore -->
```tsx
              rejectionPending={state.pendingRejection !== null || state.pendingOtherHost}
              enter={hostApi.enterShift}
```

заменить на:

<!-- prettier-ignore -->
```tsx
              rejectionPending={state.pendingRejection !== null || state.pendingOtherHost}
              license={stationLicense}
              enter={hostApi.enterShift}
```

Правка `apps/standalone/src/i18n/ru.json`:

- в `floor.shifts.refused` добавить:

<!-- prettier-ignore -->
```json
"license_restricted": "Новые смены не открываются: лицензия площадки истекла. Сообщите администратору.",
"license_trial_expired": "Новые смены не открываются: пробный период закончился. Сообщите администратору.",
"license_inn_mismatch": "Новые смены не открываются: ИНН организации не совпадает с лицензией. Сообщите администратору."
```

- в `floor.newShift.refused` добавить те же три ключа с теми же текстами и:

<!-- prettier-ignore -->
```json
"feature_pallets": "Эта возможность не входит в лицензию площадки: паллеты. Создайте смену без паллет или сообщите администратору.",
"feature_disabled": "Эта возможность не входит в лицензию площадки. Сообщите администратору."
```

- [ ] **Step 4: Убедиться, что тесты проходят**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/floor-shift-list.test.tsx test/floor-new-shift.test.tsx test/shift-list.test.ts test/app.test.tsx --reporter=verbose
```

Ожидается: PASS, в выводе нет `stderr |`; `shift-list.test.ts` (`cardAction` без четвёртого аргумента) не меняется.

- [ ] **Step 5: Гейты и коммит**

<!-- prettier-ignore -->
```bash
node_modules/.bin/prettier --ignore-path .prettierignore --write apps/standalone/src/floor/shifts/ShiftCard.tsx apps/standalone/src/floor/shifts/ShiftList.tsx apps/standalone/src/floor/shifts/NewShift.tsx apps/standalone/src/floor/shifts/shift-entry.ts apps/standalone/src/floor/shifts/new-shift.ts apps/standalone/src/floor/FloorApp.tsx apps/standalone/src/app/App.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/floor-shift-list.test.tsx apps/standalone/test/floor-new-shift.test.tsx
node_modules/.bin/prettier --ignore-path .prettierignore --check apps/standalone/src/floor/shifts/ShiftCard.tsx apps/standalone/src/floor/shifts/ShiftList.tsx apps/standalone/src/floor/shifts/NewShift.tsx apps/standalone/src/floor/shifts/shift-entry.ts apps/standalone/src/floor/shifts/new-shift.ts apps/standalone/src/floor/FloorApp.tsx apps/standalone/src/app/App.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/floor-shift-list.test.tsx apps/standalone/test/floor-new-shift.test.tsx
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint
git diff --check
```

Сообщение (`/tmp/claude/lc3-t9-msg.txt`):

<!-- prettier-ignore -->
```text
feat(standalone): the floor explains a shift the license does not open (plan ЛЦ-3)

A planned shift's card and «Новая смена» give way to the reason while the
site's license opens no new shift, the station's own open shift goes on,
and the host's refusals license_restricted (by its state) and
feature_disabled (pallets) are said in their own words.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

<!-- prettier-ignore -->
```bash
git add apps/standalone/src/floor/shifts/ShiftCard.tsx apps/standalone/src/floor/shifts/ShiftList.tsx apps/standalone/src/floor/shifts/NewShift.tsx apps/standalone/src/floor/shifts/shift-entry.ts apps/standalone/src/floor/shifts/new-shift.ts apps/standalone/src/floor/FloorApp.tsx apps/standalone/src/app/App.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/floor-shift-list.test.tsx apps/standalone/test/floor-new-shift.test.tsx
git commit -F /tmp/claude/lc3-t9-msg.txt
```

---

### Task 10: Отказы сопряжения по рабочим местам (оболочка) и отказы офисных записей по лицензии

**Files:**

- Modify: `apps/standalone/src-tauri/src/device.rs`, `apps/standalone/src/host/device.ts`, `apps/standalone/src/office/form-errors.ts`, `apps/standalone/src/office/page-state.tsx`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/src-tauri/src/device.rs` (модуль `tests`), `apps/standalone/test/network-pairing.test.tsx`, `apps/standalone/test/app.test.tsx`, `apps/standalone/test/form-errors.test.ts`

**Interfaces:**

- Consumes: `ErrorBody`, `codes::CONFLICT` (`markiro_proto`), `claim_refusal`, `DeviceState::local_pair`; `alertFailure`, `writeFailure`, `failureMessage`, `WriteFailureAlert`.
- Produces: `DeviceError::SeatLimit` (`"seat_limit"`), `DeviceError::FeatureDisabled` (`"feature_disabled"`), `fn license_refusal(body) -> Option<DeviceError>`; `DEVICE_ERROR_CODES` с двумя кодами; `AlertFailure` с необязательными `values`, `failureValues(failure)`; `alertFailure` пишет `seat_limit` (`office.about.license.refusals.seatLimit` с `used`, `limit`) и `feature_disabled` (по возможности).

- [ ] **Step 1: Написать падающие тесты**

Правка `apps/standalone/src-tauri/src/device.rs` (модуль `tests`), перед `fn line_refusals_keep_the_reason_the_webview_explains`:

<!-- prettier-ignore -->
```rust
    #[test]
    fn line_refusals_keep_the_reason_the_webview_explains() {
```

заменить на:

<!-- prettier-ignore -->
```rust
    #[test]
    fn license_refusals_of_a_pairing_keep_their_reason() {
        let conflict = |constraint: &str| {
            json!({ "error": { "code": "conflict", "message": "refused", "details": {
                "constraint": constraint, "quota": "stations", "used": 3, "limit": 3
            } } })
        };
        assert_eq!(
            claim_refusal(Some(&conflict("seat_limit"))),
            DeviceError::SeatLimit
        );
        assert_eq!(
            claim_refusal(Some(&conflict("feature_disabled"))),
            DeviceError::FeatureDisabled
        );
        assert_eq!(
            claim_refusal(Some(&conflict("license_restricted"))),
            DeviceError::PairRejected
        );
        assert_eq!(
            license_refusal(Some(&conflict("seat_limit"))),
            Some(DeviceError::SeatLimit)
        );
        // A constraint under another code is no license refusal.
        assert_eq!(
            license_refusal(Some(&json!({ "error": { "code": "validation_failed",
                "message": "", "details": { "constraint": "seat_limit" } } }))),
            None
        );
        assert_eq!(
            license_refusal(Some(&json!({ "error": { "code": "conflict", "message": "" } }))),
            None
        );
        assert_eq!(license_refusal(None), None);
        assert_eq!(DeviceError::SeatLimit.code(), "seat_limit");
        assert_eq!(DeviceError::FeatureDisabled.code(), "feature_disabled");
    }

    #[test]
    fn line_refusals_keep_the_reason_the_webview_explains() {
```

Правка `apps/standalone/test/network-pairing.test.tsx`, таблица «does not remember»:

<!-- prettier-ignore -->
```tsx
  it.each([
    ["rate_limited", "Слишком много попыток подключения. Подождите минуту и попробуйте снова."],
    ["unreachable", "Хост не отвечает по этому адресу. Проверьте адрес и что ПК-хост включён."],
  ] as const)(
    "does not remember a %s refusal: a second submit of the same code probes and claims again",
```

заменить на:

<!-- prettier-ignore -->
```tsx
  it.each([
    ["rate_limited", "Слишком много попыток подключения. Подождите минуту и попробуйте снова."],
    ["unreachable", "Хост не отвечает по этому адресу. Проверьте адрес и что ПК-хост включён."],
    // The license refuses before the host spends the code (plan ЛЦ-2, Д9): it stays good.
    [
      "seat_limit",
      "Все рабочие места лицензии заняты. Освободите место в офисе («Устройства» → «Отозвать») или расширьте лицензию.",
    ],
    [
      "feature_disabled",
      "Эта возможность не входит в лицензию площадки: подключение такого устройства. Расширьте лицензию.",
    ],
  ] as const)(
    "does not remember a %s refusal: a second submit of the same code probes and claims again",
```

Правка `apps/standalone/test/app.test.tsx` — после теста «retries a failed pairing by re-probing the host, not just the pairing» добавить:

<!-- prettier-ignore -->
```tsx
  it("explains a local pairing the license has no seat for", async () => {
    const device = fakeDevice(null);
    device.pairLocally.mockRejectedValueOnce(new DeviceError("seat_limit", "no seat"));
    renderApp({ probe: probeAnswering(true), device, host: fakeHost() });
    expect(await screen.findByText("Не удалось подключиться к хосту")).toBeTruthy();
    expect(
      screen.getByText(
        "Все рабочие места лицензии заняты. Освободите место в офисе («Устройства» → «Отозвать») или расширьте лицензию.",
      ),
    ).toBeTruthy();
  });
```

Правка `apps/standalone/test/form-errors.test.ts`.

Фрагмент 1 (импорты):

<!-- prettier-ignore -->
```ts
import { HostError } from "../src/host/client.js";
import { alertFailure, failureMessage, writeFailure } from "../src/office/form-errors.js";
```

заменить на:

<!-- prettier-ignore -->
```ts
import { HostError } from "../src/host/client.js";
import i18n from "../src/i18n/index.js";
import {
  alertFailure,
  failureMessage,
  failureValues,
  writeFailure,
} from "../src/office/form-errors.js";
```

Фрагмент 2 — в конец файла:

<!-- prettier-ignore -->
```ts
describe("a write the site's license refuses (plan ЛЦ-3)", () => {
  function licenseConflict(details: Record<string, unknown>): HostError {
    return new HostError({ kind: "api", code: "conflict", status: 409, message: "x", details });
  }

  it("says the seats used of the limit for a user or a line over the license", () => {
    const error = licenseConflict({ constraint: "seat_limit", quota: "cabinetUsers", used: 3, limit: 3 });
    const failure = alertFailure(error);
    expect(failure).toEqual({
      kind: "alert",
      message: "office.about.license.refusals.seatLimit",
      values: { used: 3, limit: 3 },
    });
    expect(i18n.t(failureMessage(failure), failureValues(failure))).toBe(
      "Достигнут предел лицензии: 3 из 3. Выключите ненужные записи или расширьте лицензию.",
    );
    expect(writeFailure(error, FIELDS)).toEqual(failure);
  });

  it("names the feature the license lacks, and any other without its name", () => {
    expect(
      i18n.t(failureMessage(alertFailure(licenseConflict({ constraint: "feature_disabled", feature: "labelEditor" })))),
    ).toBe(
      "Эта возможность не входит в лицензию площадки: редактор шаблонов этикеток. Печать по существующим шаблонам продолжается.",
    );
    expect(
      alertFailure(licenseConflict({ constraint: "feature_disabled", feature: "from_a_newer_host" })),
    ).toEqual({ kind: "alert", message: "office.about.license.refusals.featureDisabled" });
  });

  it("leaves a seat refusal without its figures, and any other conflict, to its code", () => {
    expect(alertFailure(licenseConflict({ constraint: "seat_limit" }))).toEqual({
      kind: "alert",
      message: "errors.api.conflict",
    });
    expect(alertFailure(conflict("line_name"))).toEqual({
      kind: "alert",
      message: "errors.api.conflict",
    });
    expect(failureValues({ kind: "stale" })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib device::
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/network-pairing.test.tsx test/app.test.tsx test/form-errors.test.ts test/errors.test.ts test/device.test.ts
```

Ожидается: cargo не собирается (`SeatLimit`, `license_refusal` нет); Vitest — FAIL: `DeviceError("seat_limit")` не принимается типом, `failureValues` нет, тексты отсутствуют.

- [ ] **Step 3: Реализация**

Правка `apps/standalone/src-tauri/src/device.rs`.

Фрагмент 1 (перечисление):

<!-- prettier-ignore -->
```rust
    /// The address given for the paired host answers with another
    /// certificate: another host lives there.
    AddressOtherHost,
}
```

заменить на:

<!-- prettier-ignore -->
```rust
    /// The address given for the paired host answers with another
    /// certificate: another host lives there.
    AddressOtherHost,
    /// The site's license has no seat left for this device (`conflict` on
    /// `seat_limit`, license spec §4.7): an administrator frees one in the
    /// office or extends the license. The pairing code is not spent.
    SeatLimit,
    /// The site's license does not include this kind of device (`conflict`
    /// on `feature_disabled`: a handheld without `handheld`).
    FeatureDisabled,
}
```

Фрагмент 2 (`code`):

<!-- prettier-ignore -->
```rust
            DeviceError::AddressOtherHost => "address_other_host",
        }
```

заменить на:

<!-- prettier-ignore -->
```rust
            DeviceError::AddressOtherHost => "address_other_host",
            DeviceError::SeatLimit => "seat_limit",
            DeviceError::FeatureDisabled => "feature_disabled",
        }
```

Фрагмент 3 (`local_pair`):

<!-- prettier-ignore -->
```rust
        if response.status != 200 {
            return Err(DeviceError::PairRejected);
        }
```

заменить на:

<!-- prettier-ignore -->
```rust
        if response.status != 200 {
            return Err(
                license_refusal(response.body.as_ref()).unwrap_or(DeviceError::PairRejected)
            );
        }
```

Фрагмент 4 (`claim_refusal` и новая функция):

<!-- prettier-ignore -->
```rust
/// The error for a refused claim: the host's reason when it is one the
/// webview explains, a plain refusal otherwise.
fn claim_refusal(body: Option<&Value>) -> DeviceError {
    let code = body
```

заменить на:

<!-- prettier-ignore -->
```rust
/// The license's refusal of a pairing (license spec §4.7): `conflict` with
/// `details.constraint` `seat_limit` (no seat left in the pool of stations
/// and handhelds) or `feature_disabled`; `None` for any other answer. The
/// host refuses before it spends the code (plan ЛЦ-2, Д9): the code stays good.
fn license_refusal(body: Option<&Value>) -> Option<DeviceError> {
    let body = serde_json::from_value::<ErrorBody>(body?.clone()).ok()?;
    if body.error.code != codes::CONFLICT {
        return None;
    }
    match body.error.details.as_ref()?.get("constraint")?.as_str()? {
        "seat_limit" => Some(DeviceError::SeatLimit),
        "feature_disabled" => Some(DeviceError::FeatureDisabled),
        _ => None,
    }
}

/// The error for a refused claim: the license's refusal, the host's reason
/// when it is one the webview explains, a plain refusal otherwise.
fn claim_refusal(body: Option<&Value>) -> DeviceError {
    if let Some(refusal) = license_refusal(body) {
        return refusal;
    }
    let code = body
```

Правка `apps/standalone/src/host/device.ts`, фрагмент:

<!-- prettier-ignore -->
```ts
  "unsent_facts",
  "address_other_host",
] as const;
```

заменить на:

<!-- prettier-ignore -->
```ts
  "unsent_facts",
  "address_other_host",
  // The site's license refused the pairing (plan ЛЦ-3): no seat left, or not this kind of device.
  "seat_limit",
  "feature_disabled",
] as const;
```

Правка `apps/standalone/src/office/form-errors.ts`.

Фрагмент 1:

<!-- prettier-ignore -->
```ts
export type WriteFailure<F extends string> =
  | { kind: "field"; field: F; message: string }
  | { kind: "stale" }
  | { kind: "alert"; message: string };
```

заменить на:

<!-- prettier-ignore -->
```ts
export type WriteFailure<F extends string> =
  | { kind: "field"; field: F; message: string }
  | { kind: "stale" }
  | { kind: "alert"; message: string; values?: Readonly<Record<string, string | number>> };
```

Фрагмент 2:

<!-- prettier-ignore -->
```ts
export function alertFailure(error: unknown): AlertFailure {
  if (error instanceof HostError && error.code === "stale_revision") return { kind: "stale" };
  return { kind: "alert", message: errorMessageKey(error) };
}
```

заменить на:

<!-- prettier-ignore -->
```ts
export function alertFailure(error: unknown): AlertFailure {
  if (error instanceof HostError && error.code === "stale_revision") return { kind: "stale" };
  const license = licenseRefusal(error);
  if (license !== null) return { kind: "alert", ...license };
  return { kind: "alert", message: errorMessageKey(error) };
}

/** The features whose refusal the office says by name (license spec §4.7, ЛО23). */
const NAMED_FEATURES: ReadonlySet<string> = new Set(["labelEditor", "pallets", "handheld"]);

/**
 * A write the site's license refuses (plan ЛЦ-3): `conflict` on `seat_limit`
 * with its figures (a user or a line over the license) or on
 * `feature_disabled` (a template without `labelEditor`, a shift with pallets
 * without `pallets`). `null` for anything else, and for a seat refusal without
 * its figures, which the code then explains.
 */
function licenseRefusal(
  error: unknown,
): { message: string; values?: Record<string, number> } | null {
  if (!(error instanceof HostError) || error.code !== "conflict") return null;
  const { constraint, used, limit, feature } = error.details;
  if (constraint === "seat_limit" && typeof used === "number" && typeof limit === "number") {
    return { message: "office.about.license.refusals.seatLimit", values: { used, limit } };
  }
  if (constraint === "feature_disabled") {
    return {
      message:
        typeof feature === "string" && NAMED_FEATURES.has(feature)
          ? `office.about.license.refusals.feature.${feature}`
          : "office.about.license.refusals.featureDisabled",
    };
  }
  return null;
}

/** The values of an alert's text (the seats of a refusal over the license); none for the rest. */
export function failureValues(
  failure: AlertFailure,
): Readonly<Record<string, string | number>> | undefined {
  return failure.kind === "alert" ? failure.values : undefined;
}
```

Правка `apps/standalone/src/office/page-state.tsx`.

Фрагмент 1:

<!-- prettier-ignore -->
```tsx
import { failureMessage, type AlertFailure } from "./form-errors.js";
```

заменить на:

<!-- prettier-ignore -->
```tsx
import { failureMessage, failureValues, type AlertFailure } from "./form-errors.js";
```

Фрагмент 2:

<!-- prettier-ignore -->
```tsx
  return <Alert tone="error">{t(failureMessage(failure))}</Alert>;
```

заменить на:

<!-- prettier-ignore -->
```tsx
  return <Alert tone="error">{t(failureMessage(failure), failureValues(failure))}</Alert>;
```

Правка `apps/standalone/src/i18n/ru.json`:

- в `errors.device` добавить:

<!-- prettier-ignore -->
```json
"seat_limit": "Все рабочие места лицензии заняты. Освободите место в офисе («Устройства» → «Отозвать») или расширьте лицензию.",
"feature_disabled": "Эта возможность не входит в лицензию площадки: подключение такого устройства. Расширьте лицензию."
```

- в `office.about.license` добавить:

<!-- prettier-ignore -->
```json
"refusals": {
  "seatLimit": "Достигнут предел лицензии: {{used}} из {{limit}}. Выключите ненужные записи или расширьте лицензию.",
  "featureDisabled": "Эта возможность не входит в лицензию площадки.",
  "feature": {
    "labelEditor": "Эта возможность не входит в лицензию площадки: редактор шаблонов этикеток. Печать по существующим шаблонам продолжается.",
    "pallets": "Эта возможность не входит в лицензию площадки: паллеты. Запланируйте смену без паллет или расширьте лицензию.",
    "handheld": "Эта возможность не входит в лицензию площадки: ТСД."
  }
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

<!-- prettier-ignore -->
```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib device::
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/network-pairing.test.tsx test/app.test.tsx test/form-errors.test.ts test/errors.test.ts test/device.test.ts --reporter=verbose
```

Ожидается: PASS (`errors.test.ts` «have a text for every code…» и `device.test.ts` «keeps the shell's %s code» берут новые коды сами), в выводе Vitest нет `stderr |`.

- [ ] **Step 5: Гейты и коммит**

<!-- prettier-ignore -->
```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
node_modules/.bin/prettier --ignore-path .prettierignore --write apps/standalone/src/host/device.ts apps/standalone/src/office/form-errors.ts apps/standalone/src/office/page-state.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/network-pairing.test.tsx apps/standalone/test/app.test.tsx apps/standalone/test/form-errors.test.ts
node_modules/.bin/prettier --ignore-path .prettierignore --check apps/standalone/src/host/device.ts apps/standalone/src/office/form-errors.ts apps/standalone/src/office/page-state.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/network-pairing.test.tsx apps/standalone/test/app.test.tsx apps/standalone/test/form-errors.test.ts
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint
git diff --check
```

Сообщение (`/tmp/claude/lc3-t10-msg.txt`):

<!-- prettier-ignore -->
```text
feat(standalone): pairing and office writes say the license's refusals (plan ЛЦ-3)

The shell keeps seat_limit and feature_disabled of a local pairing and a
claim as codes of their own, which the pairing screens explain and do not
remember (the code is not spent); an office write over the license says
«Достигнут предел лицензии: N из M» or the feature it lacks.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

<!-- prettier-ignore -->
```bash
git add apps/standalone/src-tauri/src/device.rs apps/standalone/src/host/device.ts apps/standalone/src/office/form-errors.ts apps/standalone/src/office/page-state.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/network-pairing.test.tsx apps/standalone/test/app.test.tsx apps/standalone/test/form-errors.test.ts
git commit -F /tmp/claude/lc3-t10-msg.txt
```

---

### Task 11: Документы: `AGENTS.md`, §21 спецификации; итоговые проверки

**Files:**

- Modify: `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md`

**Interfaces:**

- Consumes: всё сделанное задачами 1–10 и записи «Отклонения при исполнении».
- Produces: раздел «License in the office and on the floor» в `apps/standalone/AGENTS.md`; §21 «Уточнения плана ЛЦ-3» в спецификации.

- [ ] **Step 1: `apps/standalone/AGENTS.md`**

Фрагмент (заголовок следующего раздела):

<!-- prettier-ignore -->
```markdown
## Shifts
```

заменить на (если ЛЦ-2 уже завёл раздел о лицензии хоста — дописать пункты в него и не заводить второй):

<!-- prettier-ignore -->
```markdown
## License in the office and on the floor

- Plan ЛЦ-3 (license spec §9). The host computes the license (plan ЛЦ-2);
  the webview only shows it and never decides a state itself. Every reading
  of the wire's form is in `src/office/info/license/license-view.ts`,
  `license-load.ts`, `license-support.ts` and `src/floor/license.ts`.
- «Информация» → «Лицензия» (`LicenseSection`, the second of
  `ABOUT_SECTIONS`) reads `GET /v1/office/license` (`officeKeys.license`):
  the state in words with the alert's glyph, the terms in the organization's
  zone with the last day inclusive (`lastMomentBefore` of an exclusive end,
  `src/lib/license-dates.ts`), the seats used of the license's (stations
  and handhelds, office users, lines; kiosks are not shown while the host
  does not apply them), the seven features in words, the binding (the file's
  customer and INN, the site's INN and whether they match, the host's id
  with «Скопировать», the certificate's fingerprint, the file's number).
  Every role reads it; the administrator (`useCan("manageLicense")`) loads
  a file, saves the activation request and enables the emergency.
- A file (`.mklic`, at most 16 KiB, read in the webview, never logged or
  cached) is checked by `POST /v1/office/license/preview` and shown as
  «было → станет» (plan, last day, grace, seats, features; the seats a
  smaller file leaves over their limit; a file already expired), and loaded
  by `PUT /v1/office/license` on «Загрузить». A refusal is said in the words
  of spec §9.7 and takes the focus. Without the organization's INN the
  picker is off and the section links to «Профиль организации».
- «Сохранить запрос на активацию» saves the host's request as JSON in a new
  folder `Документы\Markiro\Лицензия\Запрос на активацию <UTC>` (the shell's
  `LICENSE_ROOT`; `json` is one of `FILE_EXTENSIONS`; nothing is opened from
  that root). «Открыть новые смены ещё 3 дня» shows only where the host
  offers it (`emergency.available`: no new shift opens, and the file's or the
  trial's extension is unused), names the host's `effectiveAt` plus 72 hours
  (no PC clock is compared with the host's) and explains `emergency_used` and
  `emergency_not_needed`. A state a newer host adds is named as it is.
- The band above the office's pages (`LicenseBanner` in `OfficeShell`,
  extension point T3) and «Обзор» (one polite region with the copies' warnings,
  T4) show the license's warnings (`licenseNotices`): the trial (neutral, its
  last `warnDays` in the warning tone), the end (subscription and demo), the
  grace, the restriction, the trial's end, another host, a changed INN and the
  host's clock. The light ones hide for the session by kind; the serious ones
  never. The organization's profile is read only for a warning with a date.
  Every revision of the host reads the license again (`Office`). A link to
  `/about#license` focuses that section (`AboutPage`), and `OfficeShell`
  leaves the focus to a page reached by an anchor.
- The support text's «Лицензия» block (`licenseSupportBlock`, the first of
  `SUPPORT_CONTRIBUTORS`, reading through `SupportContext.read`) carries the
  state with its code, the clock flags, the file's short id and sequence,
  its term and issue (UTC), its `kid`, the host's short id, the trial and the
  emergency; never the INN, the customer, the fingerprint or the file.
- The station reads its license with its record (`HostApi.getDevice`,
  `useStationLicense` in `App`): once the link is online and after every
  revision, kept in memory for the pairing (after a restart without the host
  it knows nothing, and opening needs the host anyway). The status bar is
  silent in the trial, while the license runs, in its last weeks and on
  another host; it says the grace with its date (this PC's zone), the
  emergency extension with its end (`emergencyUntil`: then shifts open), and
  that no new shift opens in `restricted`, `trial_expired` and `inn_mismatch`. Then a
  planned shift's card and «Новая смена» give their place to the reason, and
  the new shift's «Создать и открыть» too; the station's own open shift, the
  work, the boxes, the pallets and the close never change. The host's
  refusals `license_restricted` (by `details.state`) and `feature_disabled`
  (pallets by name) have words of their own.
- The shell keeps a pairing's `conflict` on `seat_limit` and
  `feature_disabled` (`license_refusal` in `device.rs`, the local pairing and
  the claim) as codes the pairing screens explain without figures (the
  station cannot read the license before it is paired) and do not remember
  (the code is not spent). An office write over the license says
  «Достигнут предел лицензии: N из M» or the feature it lacks
  (`alertFailure`, `failureValues`).
- Not proven by the tests: WebView2's picker and drag and drop of a `.mklic`,
  the documents folder redirected or on OneDrive, Explorer's «Показать
  папку», the clipboard in WebView2, a screen reader on the band and the
  focus, the floor on the touch panel, the real host's routes (only a fake
  `HostApi`), a real seat refusal of a pairing.

## Shifts
```

- [ ] **Step 2: §21 спецификации**

В конец `docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md` (после последнего раздела по номеру; если §18–§20 ещё не написаны — после §17, с номером 21) дописать:

<!-- prettier-ignore -->
```markdown
## 21. Уточнения плана ЛЦ-3

План: `docs/superpowers/plans/2026-10-13-standalone-lc3-license-office-station.md`.

- Ключи i18n страницы — `office.about.license.*` (префикс каркаса `claude/fb-about`), а не
  `office.info.license.*` раздела 9.7; полоса — `office.banner.license.*`, станция — `floor.license.*`.
- Точку Т3 (полоса над страницами) ввёл этот план: `LicenseBanner` в `OfficeShell`; Т4 — одна
  вежливая область «Обзора» на лицензию и копии. Т2 получила поле `SupportContext.read` (чтение
  хоста через сеанс), строка-заглушка лицензии ушла из базового текста.
- Станция читает поле `license` из `GET /v1/device` сама (`HostApi.getDevice`, нового в контракте
  брифа нет) при каждой ревизии и выходе на связь; последнее состояние живёт в памяти до
  перезапуска. Даты станции — в поясе её ПК, офиса — в поясе организации.
- Экраны сопряжения пишут отказ по местам без «N из M»: оболочка отдаёт вебвью только код, а до
  сопряжения станции лицензию не прочитать. Код подключения при таком отказе не запоминается.
- Кнопка аварийного продления — по `emergency.available` хоста; срок в вопросе — `effectiveAt`
  хоста + 72 часа. Станция при `emergencyUntil` открытие не закрывает и пишет срок продления.
- Отказ файла несёт от хоста только `fileHostId`: «№ N» у `license_older` — номер действующего
  файла из `GET`, `license_inn_mismatch` без ИНН файла — короткий текст (`license_inn_mismatch_short`).
- Часы: полоса пишет «отстают на N дн.» по `flags.clockBehindDays` (ЛЦ-2, Д4).
- Полоса для `inn_mismatch` (в таблице 9.5 её не было) — опасность, без закрытия, без чисел ИНН.
- Строка «Киоски» в «Рабочих местах» не показывается, пока квота не применяется.
- Отклонения при исполнении: <перенести сюда записи раздела «Отклонения при исполнении» плана>.
```

- [ ] **Step 3: Итоговые проверки (раздел «Итоговая проверка плана» ниже) и коммит**

<!-- prettier-ignore -->
```bash
node_modules/.bin/prettier --ignore-path .prettierignore --write apps/standalone/AGENTS.md docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md
node_modules/.bin/prettier --ignore-path .prettierignore --check apps/standalone/AGENTS.md docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md
git diff --check
```

Сообщение (`/tmp/claude/lc3-t11-msg.txt`):

<!-- prettier-ignore -->
```text
docs(standalone): the license in the office and on the floor (plan ЛЦ-3)

The scoped guide describes the license section, the band and «Обзор»,
the support block, the station's line and refusals and the pairing's
seat refusals; spec §21 records the plan's refinements.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

<!-- prettier-ignore -->
```bash
git add apps/standalone/AGENTS.md docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md
git commit -F /tmp/claude/lc3-t11-msg.txt
```

---

## Итоговая проверка плана

Из корня репозитория, после задачи 11:

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false exec turbo run build --filter='@markiro/standalone^...'
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run lint
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-proto
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host
node_modules/.bin/prettier --ignore-path .prettierignore --check $(git diff --name-only --diff-filter=ACMR "$(git merge-base HEAD origin/main)" -- 'apps/standalone/**/*.ts' 'apps/standalone/**/*.tsx' 'apps/standalone/**/*.json' 'apps/standalone/**/*.css' 'apps/standalone/**/*.md' 'docs/**/*.md')
git diff --check "$(git merge-base HEAD origin/main)"
rtk proxy grep -rn "notConnected\|office.about.report.license" apps/standalone/src apps/standalone/test
graphify update .
```

Ожидается: всё зелёное; поиск последней строки пуст. Тесты `markiro-host` с привязкой к loopback требуют песочницы без запрета привязки (бриф); этот план хоста не меняет — прогон подтверждает, что слияние с ЛЦ-2 ничего не сломало. `cargo test -p markiro-standalone` идёт после `pnpm … build` (оболочка встраивает `dist`). `cargo test --workspace` целиком — частями, как выше.

Отдельно (React-гейт): новые и изменённые тестовые файлы с React одним прогоном `--reporter=verbose` — в выводе нет `stderr |`:

<!-- prettier-ignore -->
```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/license-section.test.tsx test/license-banner.test.tsx test/station-license.test.tsx test/about-page.test.tsx test/floor-status-bar.test.tsx test/floor-shift-list.test.tsx test/floor-new-shift.test.tsx test/network-pairing.test.tsx test/app.test.tsx --reporter=verbose
```

## Перенесено

- **ТСД (Kotlin, `apps/handheld`)**: тексты отказов `seat_limit` и `feature_disabled` на экране сопряжения ТСД и строка лицензии на хабе ТСД — план ТСД (общие фикстуры, `apps/handheld/AGENTS.md`).
- **«N из M» на экранах сопряжения станции** (Д6): нужен структурированный отказ из оболочки (код плюс детали) — отдельная правка `DeviceError`, когда понадобится.
- **Лицензия станции после перезапуска без хоста** (Д4): хранение последнего состояния в локальной базе станции — новая миграция оболочки вне распределения этого направления.
- **Отказ по местам под полем формы** («Пользователи», «Линии»): сейчас — общий алерт над формой с числами; поле-специфичный текст — по желанию владельца.
- **Раздел «Обновление», таблица «Устройства и версии», полоса «Доступно обновление»** (Т5, Т6) — планы ОБН-2 и ОБН-3.
- **Киоски** — строка квоты и применение, когда в автономе появится киоск.

## Не проверено

Ничего из этого автоматические тесты (jsdom, поддельный `HostApi`, поддельные файлы офиса, unit-тесты оболочки) не доказывают:

- WebView2 на Windows 10 и 11: выбор `.mklic` в диалоге `FileDropZone` (у файла нет MIME, отбор — по расширению), перетаскивание из Проводника, файл на флешке; чтение файла 16 КиБ.
- Сохранение запроса в `Документы\Markiro\Лицензия` при перенаправленной папке «Документы», OneDrive, в киоск-сеансе; «Показать папку» в Проводнике; права на папку.
- Буфер обмена WebView2 для «Скопировать идентификатор хоста».
- Экранный диктор (NVDA, Экранный диктор Windows): объявление полосы и предупреждений «Обзора» один раз, скрытые слова тона, фокус на разделе «Лицензия» после ссылки, фокус на сообщении после отказа загрузки.
- Настоящий хост ЛЦ-2 против этого интерфейса: формы ответов (Д2), коды отказа файла и `details`, `emergency_used`, ревизия при смене фазы и перечитывание полосы и станции — проверены только против поддельного `HostApi`.
- Отказ сопряжения по местам против настоящего хоста: локальное сопряжение ПК хоста и `claim` по сети (`license_refusal` проверен unit-тестом на телах ответа); что код подключения действительно не тратится.
- Станция на сенсорной панели 1024 × 768 и 1280 × 800: объяснение вместо кнопок, длинные тексты на карточке смены, строка состояния с несколькими предупреждениями.
- Переход фазы в полночь (льготный срок → ограничение) с открытой сменой на станции: строка состояния меняется после ревизии, открытая смена продолжается — только на живом хосте.
- Часы Windows, переведённые назад и вперёд: флаги `clockBehind` / `clockAhead` в полосе.

## Отклонения при исполнении

(заполняет исполнитель)
