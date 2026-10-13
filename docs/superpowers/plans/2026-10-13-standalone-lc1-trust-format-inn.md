# План ЛЦ-1: доверие — компактный JWS ES256, схемы лицензии, манифеста обновления и запроса активации, общие подписанные фикстуры, `markiro_proto::trust` с наборами ключей, `markiro-host trust-keys`, ИНН с контрольной суммой в домене и в хосте — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать обеим сторонам будущей лицензии автонома одну проверку подписанных документов. В `@markiro/domain` — обобщённый компактный JWS ES256 (`verifyCompactJws`, `signCompactJws`, вынесенный из офлайн-грантов канонический base64url), строгие Zod-схемы нагрузки лицензии (§4.2), запроса активации (§6.3) и манифеста обновления (§10.2), `verifyStandaloneLicense`, а также `isValidInn`/`normalizeInn`, перенесённые из закрытой функции клиента Национального каталога (API импортирует их из домена). В автономе — `markiro_proto::trust` на `aws-lc-rs` с теми же правилами, производственные наборы открытых ключей из `proto/fixtures/trust-keys.json` (пока пустые), тестовые ключи только под `cfg(test)`/фичей `test-keys`, команда `markiro-host trust-keys`, порт ИНН `host/src/inn.rs`. Общие фикстуры (`packages/domain/fixtures/…`: подписанные тестовым ключом файлы, ожидания, правила полей, случаи ИНН) держат TypeScript и Rust в одних ответах. Сторожа: ни один отслеживаемый файл не содержит закрытого ключа, кроме двух тестовых; хост сборки выпуска не доверяет тестовому ключу. Шаг владельца — создать ключ лицензий (будущий ключ окружения API плана ЛЦ-0) и ключ выпусков и закоммитить их открытые JWK.

**Architecture:**

- Задача 1 — `packages/domain/src/inn.ts` (`isValidInn` строгая, `normalizeInn` с обрезкой пробелов JavaScript) и общая фикстура `packages/domain/fixtures/inn-cases.json` (27 случаев, в том числе U+FEFF и U+0085, на которых `trim` JavaScript и Rust расходятся).
- Задача 2 — API: `national-catalog.client.ts` импортирует `isValidInn` из `@markiro/domain`, своя копия удалена; тест API идёт по той же фикстуре.
- Задача 3 — `packages/domain/src/signed-documents/compact-jws.ts`: `decodeBase64UrlCanonical` (вынесен из `offline-grants/jws.ts`, который теперь его импортирует), `encodeBase64Url`, `decodeUtf8Strict`, `verifyCompactJws` (форма → `kid` → подпись; полезная нагрузка — байтами), `signCompactJws`.
- Задача 4 — `packages/domain/src/standalone-license/`: константы `typ`, пределов размера, ключей квот и возможностей; строгие схемы; `verifyStandaloneLicense` и `verifyStandaloneUpdateManifest`; фикстура правил полей `schema-cases.json` (91 случай для трёх схем).
- Задача 5 — генератор `packages/domain/scripts/generate-standalone-fixtures.mjs` (node:crypto, вне CI), тестовые ключи и подписанные файлы в `packages/domain/fixtures/standalone-license/`, `expectations.json` (исход каждого файла), тест фикстур домена; переэкспорт в `@markiro/platform-contracts` и тест равенства ключей облачным `ENTITLEMENT_*_KEYS`.
- Задача 6 — `apps/standalone/proto`: зависимости `aws-lc-rs`/`base64` (пины хоста), фича `test-keys`, `src/trust.rs` (наборы ключей, `parse_keysets`, `verify_compact`, `license_keyset`/`update_keyset`), `fixtures/trust-keys.json` (пустые наборы), `tests/trust.rs`.
- Задача 7 — в `trust.rs`: `LicensePayloadV1`, `UpdateManifestV1`, `ActivationRequest` (serde через `Value`, строгие правила как у Zod), `verify_license`, `verify_update_manifest`; паритет по `expectations.json` и `schema-cases.json`.
- Задача 8 — хост: `src/inn.rs` + `tests/inn.rs` по общей фикстуре; команда `markiro-host trust-keys`; dev-зависимость хоста включает `test-keys`.
- Задача 9 — сторожа: `tools/standalone-release/test/no-private-keys.test.mjs`; шаг CI `standalone-windows-build` «The release host trusts no test key» и его контракт в `workflow.test.mjs`.
- Задача 10 — документы (`apps/standalone/AGENTS.md`, §18 спецификации) и шаг владельца: ключи лицензий и выпусков, открытые JWK в `trust-keys.json`.

**Tech Stack:** TypeScript 6 strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), zod 4.4.3, Vitest 4.1.11, WebCrypto (Node 24 и браузер; без Node-API в исходниках домена), node:crypto только в генераторе; Rust 2021 — `aws-lc-rs` 1.18.1 (`ECDSA_P256_SHA256_FIXED`, `ParsedPublicKey`), `base64` 0.22.1 (`URL_SAFE_NO_PAD`), serde/serde_json; `node:test` для контрактов выпуска; GitHub Actions (`windows-latest`, bash).

**Спецификации и источники:**

- `docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md` (редакция 3, принята владельцем): §2 (таблица «что есть»), §4.1–4.3 (формат, нагрузка, порядок проверки), §4.9 (ИНН), §5 (ключи, наборы в сборке, ротация), §6.3 (запрос активации), §10.1–10.2 (манифест), §12.1 (автоматические проверки), §13 строка 1 (объём ЛЦ-1), §16 (риск «тестовый ключ в сборке выпуска»). Этот план дописывает §18.
- `/tmp/claude/fb/license-plans-brief.md` — распределение, общий контракт имён «ЛЦ-1 produces» (TypeScript и Rust).
- Код: `packages/domain/src/offline-grants/jws.ts` (закрытый `decode` в строках 13–21, `verifyGrant` с 24), `packages/domain/src/offline-grants/contracts.ts` (`grantProtectedHeaderSchema`), `packages/domain/src/index.ts` (экспорты, строки 388–393 — гранты), `packages/platform-contracts/src/{entitlements.ts:10-16,offline-grants.ts,index.ts:743}`, `apps/api/src/modules/national-catalog/national-catalog.client.ts:310,523-536`, `apps/api/src/modules/device-grants/grant-keyset.ts` (формат окружения ключа грантов — образец для шага владельца), `apps/standalone/proto/{Cargo.toml,src/lib.rs:191-193,src/pairing.rs}`, `apps/standalone/host/{Cargo.toml,src/main.rs,src/lib.rs}`, `apps/standalone/Cargo.lock` (`aws-lc-rs` 1.18.1, `base64` 0.22.1 уже есть), `tools/standalone-release/test/workflow.test.mjs`, `.github/workflows/ci.yml` (задание `standalone-windows-build`), `tools/ci/affected.mjs` (изменения `packages/domain/**` уже включают задания автонома), `packages/platform-contracts/tools/offline-grants-test-only-key.json` (уже отслеживаемый тестовый закрытый JWK грантов).

## Допущения

- **Д1 — фикстуры лежат только в домене.** §12.1 называет `proto/fixtures/license-*.json` и `update-manifest-*.json`; по брифу подписанные файлы, ожидания и правила полей живут в `packages/domain/fixtures/standalone-license/`, а Rust читает их по относительному пути (так уже делают `src-tauri/src/office_files.rs` и `printer/driver.rs` с `packages/domain/test/fixtures/…`). `expectations.json` задаёт исход каждого подписанного файла, `schema-cases.json` — правила полей; обе стороны обходят одни и те же файлы. Подписанные файлы кончаются переводом строки — читатели обрезают текст (`.trim()`).
- **Д2 — `isValidInn` строгая, `normalizeInn` обрезает.** `isValidInn` — ровно прежняя функция API (10 или 12 цифр ASCII, контрольные суммы, без обрезки), поэтому поведение клиента НК не меняется: `" 7707083893"` он по-прежнему отвергает. `normalizeInn` убирает пробелы `String.prototype.trim` и проверяет остаток. Порт Rust повторяет набор JavaScript явно: `trim` Rust убирает U+0085 и не убирает U+FEFF — фикстура держит оба случая.
- **Д3 — порядок проверки как в §4.3, не как у `verifyGrant`.** `verifyCompactJws`: форма и заголовок → `kid` (в наборе ровно один раз и не в `retiredKids`) → длина и проверка подписи → вызывающий читает нагрузку. `verifyGrant` проверяет нагрузку и `issuer` до ключа; он не переписывается, меняется только источник декодера.
- **Д4 — строгие формы, одинаковые в Zod и Rust.** `tenantId` и `siteId` — непрозрачные строки 1–64 знака `A-Za-z0-9._:-` (решение владельца 2026-10-13, «Отклонения при исполнении», О1; фрагменты кода ниже с `tenantId: uuid` и `is_uuid(&self.tenant_id)` исполнены по О1). Остальные UUID — канонические в нижнем регистре, версии 1–8, вариант RFC (`z.uuid()` принял бы верхний регистр и nil — равенство с `host.json` и паритет с Rust важнее); целые ≤ `Number.MAX_SAFE_INTEGER`; время — `YYYY-MM-DDTHH:MM:SS[.дробь]Z`; версия — `X.Y.Z` без ведущих нулей, до 9 цифр в части (как `tools/standalone-release/prepare.mjs:24`); имя установщика — ровно `markiro-standalone-<version>-windows-x86_64-setup.exe` (`prepare.mjs:26-28`), так что путь в нём невозможен; `minUpgradeFrom ≤ version` по числам; заметки — до 30 строк по 200 единиц UTF-16 без управляющих символов; ИНН в нагрузке — только форма 10/12 цифр: контрольную сумму сверяет хост (ЛЦ-2), и неверная сумма в файле — `inn_mismatch`, а не испорченный файл; `customer.name` — 1–300 единиц UTF-16 без управляющих символов; `entitlementRevision` — десятичное без ведущего нуля, до 19 цифр; `validFrom < validUntil`.
- **Д5 — Rust читает объекты через `serde_json::Value`.** Прототип при написании плана показал: derive serde берёт структуру и из JSON-массива (поля по порядку), Zod — нет. `read_object` требует объект по каждому указателю (корень, `customer`, `quotas`, `features`, `installer`, `organization`, `usage`; `trial`, `currentLicense` — объект или `null`). Через `Value` повтор ключа даёт последнее значение, как `JSON.parse`. BOM в начале UTF-8 отвергают обе стороны (`ignoreBOM: true` в `decodeUtf8Strict`). Остаточные расхождения, которых подписанты (`JSON.stringify`, облако) не производят: `1.0` вместо `1` (Zod примет, serde нет), одиночный суррогат `\ud800` (JSON.parse примет).
- **Д6 — тестовые ключи и один `origin`.** Под `cfg(test)` или фичей `test-keys` набор = производственные ключи + тестовые (повтор `kid` — паника), `retiredKids` объединяются, а `origin` набора лицензий становится тестовым (`https://license.test.invalid`): у `Keyset` одно поле `origin` (контракт), и в тестовой сборке лицензии принимаются только от тестового издателя. Интеграционные тесты `proto` (`tests/trust.rs`) не видят `cfg(test)` крейта и фичу не включают: они строят тестовый набор через `parse_keysets`. Фичу включает только dev-зависимость хоста; `cargo build --release -p markiro-host` dev-зависимостей не берёт.
- **Д7 — форма `TrustError::code`.** Контракт: «`code()` → `license_malformed`/`license_unknown_key`/`license_signature` style codes chosen by the caller». Сделано `code(kind: DocumentKind)`: для `License` — ровно эти три кода §4.3, для `Update` — `update_malformed`, `update_unknown_key`, `update_signature` (ОБН-2 может взять их или назвать свои, сопоставив с `TrustError`). Плюс `reason()` — имя причины домена (`malformed`, `unknown_key`, `bad_signature`), которым пользуются тесты паритета.
- **Д8 — добавлено к контракту (имена контракта не меняются).** TypeScript: `encodeBase64Url`, `decodeUtf8Strict`, тип `CompactJwsVerification`, `STANDALONE_LICENSE_MAX_BYTES` (16 КиБ), `STANDALONE_UPDATE_MANIFEST_MAX_BYTES` (64 КиБ), `standaloneLicenseQuotasSchema`, `standaloneLicenseFeaturesSchema`, `verifyStandaloneUpdateManifest`, типы `StandaloneLicenseKeyset`, `StandaloneUpdateKeyset`, `StandaloneLicenseVerification`, `StandaloneUpdateVerification`, `StandaloneQuotaKey`, `StandaloneFeatureKey`, `StandaloneLicensePayloadV1`, `StandaloneActivationRequest`, `StandaloneUpdateManifestV1`. Успех `verifyStandaloneLicense` — `{ ok: true, kid, license }`. Rust: `LICENSE_TYP`, `UPDATE_TYP`, `MAX_LICENSE_BYTES`, `MAX_UPDATE_MANIFEST_BYTES`, `ACTIVATION_REQUEST_FORMAT`, `DocumentKind`, `Keysets`, `parse_keysets`, `from_json`/`is_valid` у трёх типов нагрузок, вложенные типы (`LicenseCustomer`, `LicensePlan`, `LicenseQuotas`, `LicenseFeatures`, `UpdateChannel`, `UpdateInstaller`, `ActivationOrganization`, `ActivationTrial`, `ActivationLicense`, `ActivationUsage`). Фикстуры сверх брифа: `expectations.json`, `schema-cases.json`.
- **Д9 — переэкспорт в контрактах без функций.** `@markiro/platform-contracts` переэкспортирует константы, схемы и типы — как `offline-grants.ts` переэкспортирует схемы грантов без `verifyGrant`. ЛЦ-0 берёт `verifyStandaloneLicense` и `verifyCompactJws` из `@markiro/domain`.
- **Д10 — что такое «закрытый ключ в репозитории».** Проверка ловит PEM (`-----BEGIN … PRIVATE KEY-----` с телом base64 от 64 знаков: PKCS#8, EC, RSA, зашифрованный, OpenSSH) и закрытый JWK (`"d": "<от 32 знаков base64url>"`). Разрешены ровно два файла: новый `packages/domain/fixtures/standalone-license/test-private-keys.json` и уже отслеживаемый `packages/platform-contracts/tools/offline-grants-test-only-key.json` (тестовый ключ грантов — JWK, не PEM; спецификация говорит только о `PRIVATE KEY`, без него проверка упала бы в первый день). Слова «PRIVATE KEY» и короткие подделки тестов `deploy/yandex/test` ключом не считаются (проверено прогоном по дереву при написании: только ключ грантов, 1,3 с). Тест лежит в контрактах выпуска автонома (§12.1) и идёт в задании `standalone-windows-build`.
- **Д11 — проверка сборки выпуска — шаг CI.** После `cargo build --release --locked … -p markiro-host` шаг печатает `markiro-host.exe trust-keys` и падает на строке `test-…`. Проверка в `smoke.ps1` по установленному хосту (§16) — план ОБН-2.
- **Д12 — до шага владельца производственные наборы пусты.** Сборка тогда не доверяет никакому файлу лицензии и манифесту; это безопасно, потому что принимать лицензию начнёт только ЛЦ-2, а манифест — ОБН-2. Шаг владельца (задача 10) — до первой сборки выпуска с ЛЦ-2.
- **Д13 — порт ИНН в хосте, не в `proto`.** Как в контракте: сверка ИНН — дело хоста; `proto` проверяет только форму ИНН в нагрузке и запросе активации.

## Global Constraints

**Распределение (бриф, BINDING):**

- Миграции хоста: `0030_license.sql` — ЛЦ-2, `0031_device_versions.sql` — ОБН-1, `0032`–`0033` — резерв этого направления; `0017`–`0018` заняты открытыми ветками (`fb-codesearch`, `fb-people`, `fb-templates`, `fb-mode`) — не трогать. Оболочка (`src-tauri/migrations`) — без новых миграций (`0030`–`0031` зарезервированы, не используются). Облако (`packages/db/migrations`, ЛЦ-0) — следующий свободный номер Drizzle при исполнении (`0186` при написании), через `pnpm --filter @markiro/db db:generate`, применённые не правятся. **ЛЦ-1 миграций не добавляет.**
- Разделы «Уточнения плана …» спецификации при исполнении: §18 ЛЦ-1 (этот план), §19 ЛЦ-2, §20 ОБН-1, §21 ЛЦ-3, §22 ОБН-2, §23 ОБН-3, §24 ЛЦ-0.
- Файлы планов: `2026-10-13-standalone-lc1-trust-format-inn.md` (этот), `…-lc0-saas-offline-license-export.md`, `…-lc2-host-license.md`, `…-obn1-safe-migration-versions.md`, `…-lc3-license-office-station.md`, `…-obn2-update-from-file.md`, `…-obn3-update-via-host.md`.
- Порядок: ЛЦ-1 → (ЛЦ-0 ∥ ЛЦ-2 ∥ ОБН-1) → (ЛЦ-3 ∥ ОБН-2) → ОБН-3. ЛЦ-1 ни от чего не зависит; ЛЦ-0 и ЛЦ-2 опираются на его имена (контракт брифа, «ЛЦ-1 produces») — менять их можно только с отметкой в «Отклонениях» и §18.

**Правила (общие для всех планов направления):**

- Никогда `git stash`; команды из корня репозитория с путями от корня, без `cd`; pnpm — как `pnpm --config.verifyDepsBeforeRun=false …`, без `pnpm install`/`add` (новая JS-зависимость — шаг владельца; ЛЦ-1 их не добавляет); cargo — `--offline --locked` (единственное исключение — задача 6, шаг обновления `Cargo.lock` офлайн без `--locked`); тесты хоста, открывающие сокет на loopback, — вне песочницы (в ЛЦ-1 таких нет, кроме гейта `--workspace`).
- TDD: сначала падающий тест, потом код. Существующие проверки не ослабляются. Аудита и UI в ЛЦ-1 нет; в лог ничего не пишется (ни текста файла, ни ИНН, ни ключей). Тексты интерфейса — не задача ЛЦ-1.
- Формы на проводе хоста ЛЦ-1 не меняет (маршрутов нет); формы документов — Zod и serde вместе, с общими фикстурами.
- Гейты перед каждым коммитом: `node_modules/.bin/prettier --ignore-path .prettierignore --check` на изменённых TS/MJS/JSON/MD (не на `.jws` — у prettier для них нет парсера), `typecheck` и `lint` затронутых пакетов, `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` при правке Rust, `git diff --check`.

**Код и процесс:**

- TypeScript strict: без `any`, приведений и `!` в исходниках; `import type` для типов; исходники домена — без Node-API (домен идёт и в webview автонома); `node:fs` — только в тестах и генераторе.
- Rust: `cargo fmt` чистый, сборка без предупреждений. `Cargo.toml` меняются только в задачах 6 (`proto`) и 8 (dev-зависимость хоста); `Cargo.lock` — только блок `markiro-proto` (задача 6). `package.json` и `pnpm-lock.yaml` не меняются.
- Закрытых ключей в репозитории нет, кроме двух тестовых (Д10); производственные закрытые ключи никогда не попадают ни в репозиторий, ни в чат, ни в аргументы командной строки.
- Коммиты — явные пути, сообщение из файла, ровно одна строка `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; push и PR — не задачи плана.

## Заметки для исполнения

**Основа плана.** Ветка от `claude/integration` (`a4eef5cd6` или новее). Перед задачей 1 убедиться: в `packages/domain/src/offline-grants/jws.ts` есть закрытая `function decode(segment: string)`; в `apps/api/src/modules/national-catalog/national-catalog.client.ts` есть `function isValidInn(value: string)`; нет каталога `packages/domain/fixtures/`, файла `apps/standalone/proto/src/trust.rs`, файла `apps/standalone/host/src/inn.rs`; в `apps/standalone/Cargo.lock` есть `name = "aws-lc-rs"` версии `1.18.1` и `name = "base64"` версии `0.22.1`. Иначе остановиться и назвать расхождение в отчёте.

**Что прогонялось при написании.** Код задач 1, 3–9 (исходники, тесты, генератор, Rust-модуль и тесты, проверка ключей, шаг CI и его контракт) прогнан в черновой копии вне репозитория: Node 24.18, zod 4.4.3, Vitest 4.1.11 (145 тестов), `tsc` 6.0.3 со строгими флагами репозитория (исходники и тесты), prettier 3.9.6 с `.prettierrc` репозитория; Rust 1.93 с `aws-lc-rs` 1.18.1 офлайн (17 тестов `proto`, порт ИНН по фикстуре), `rustfmt`; `node --test` контракта workflow на копии `ci.yml` (14 из 14; без шага — новый тест падает); проверка ключей — по дереву `fb-license` (находит только ключ грантов). **Не прогонялись:** eslint, тест API (задача 2), тест `@markiro/platform-contracts`, тесты хоста в настоящем крейте (задача 8), `Cargo.lock` настоящего workspace. Фрагменты «заменить на» взяты из дерева `/tmp/claude/wt/fb-license` (`f38f4a3e9` поверх `a4eef5cd6`). Не находится фрагмент — применить по смыслу и записать в «Отклонения при исполнении».

**Свежий worktree.** Если в рабочем дереве нет установленных зависимостей (`packages/domain/node_modules` отсутствует), установка — шаг контроллера или владельца (`pnpm install --frozen-lockfile` вне песочницы), не исполнителя. Перед тестами `@markiro/platform-contracts` и API собрать домен: `pnpm --config.verifyDepsBeforeRun=false exec turbo run build --filter=@markiro/domain`. Перед `cargo` в свежем worktree ничего собирать не нужно (`proto` и хост не встраивают `dist`); `-p markiro-standalone` в ЛЦ-1 не затрагивается.

**Мутации.** `cp <файл> /tmp/claude/before-lc1 && shasum -a 256 <файл>`; правка; команда — ожидаемый FAIL названного теста; `cp /tmp/claude/before-lc1 <файл>`, `cmp` молчит, `shasum` тот же. Мутацию не коммитить.

**Генератор фикстур.** `node packages/domain/scripts/generate-standalone-fixtures.mjs` запускается один раз в задаче 5 и потом только при смене ключей или нагрузок: подписи ECDSA случайны, каждый запуск переписывает все `.jws`, тесты их проверяют, а не сравнивают байты. Ключи создаются при первом запуске и сохраняются в `test-private-keys.json`; удалить файл — новые ключи. В CI генератор не запускается и проверкой `--check` не обладает (в отличие от грантов): закреплять нечего, кроме исходов в `expectations.json`.

**pnpm, git, cargo.** Без `git stash`; урезанный `rtk` вывод — `rtk proxy <команда>`; вывод тестов не передавать в `tail`/`grep`, когда нужен код возврата. `cargo test … -p markiro-proto` и `-p markiro-host --test inn`/`--bin markiro-host` сокета не открывают и идут в песочнице. Гейт `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml --workspace --no-fail-fast` — вне песочницы и частями, если весь не помещается.

**Для следующих планов (ЛЦ-0, ЛЦ-2, ОБН-2).** Хост получает текст файла лицензии и обрезает его (`trim`) до `verify_license`; размер 16 КиБ считается от необрезанного тела запроса или от обрезанного — решает ЛЦ-2 (здесь — от того, что передано). `license_keyset()`/`update_keyset()` возвращают клон набора на каждый вызов — дешёво (единицы ключей). Подписант грантов API пишет заголовок в порядке `{alg, typ, kid}` (`grant-keyset.ts:69`), `signCompactJws` домена — `{typ, alg, kid}`; проверка от порядка не зависит.

## Файлы

- Create (домен): `packages/domain/src/inn.ts`, `packages/domain/src/signed-documents/compact-jws.ts`, `packages/domain/src/standalone-license/{contracts.ts,verify.ts,index.ts}`, `packages/domain/scripts/generate-standalone-fixtures.mjs`, `packages/domain/fixtures/inn-cases.json`, `packages/domain/fixtures/standalone-license/{schema-cases.json,test-keyset.json,test-private-keys.json,expectations.json,activation-request.json,license-subscription.jws,license-demo.jws,license-upgrade.jws,license-older.jws,license-other-host.jws,license-other-inn.jws,license-tampered.jws,license-unknown-kid.jws,update-manifest.jws}`, `packages/domain/test/{inn.test.ts,compact-jws.test.ts,standalone-license.test.ts,standalone-license-fixtures.test.ts}`
- Modify (домен): `packages/domain/src/index.ts`, `packages/domain/src/offline-grants/jws.ts`
- Create/Modify (контракты): `packages/platform-contracts/src/standalone-license.ts`, `packages/platform-contracts/src/index.ts`, `packages/platform-contracts/test/standalone-license.test.ts`
- Modify (API): `apps/api/src/modules/national-catalog/national-catalog.client.ts`, `apps/api/test/national-catalog.client.test.ts`
- Create (автоном): `apps/standalone/proto/src/trust.rs`, `apps/standalone/proto/fixtures/trust-keys.json`, `apps/standalone/proto/tests/trust.rs`, `apps/standalone/host/src/inn.rs`, `apps/standalone/host/tests/inn.rs`
- Modify (автоном): `apps/standalone/proto/Cargo.toml`, `apps/standalone/proto/src/lib.rs`, `apps/standalone/Cargo.lock`, `apps/standalone/host/Cargo.toml`, `apps/standalone/host/src/lib.rs`, `apps/standalone/host/src/main.rs`
- Create/Modify (сторожа): `tools/standalone-release/test/no-private-keys.test.mjs`, `tools/standalone-release/test/workflow.test.mjs`, `.github/workflows/ci.yml`
- Modify (документы): `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md`
- Шаг владельца (задача 10): `apps/standalone/proto/fixtures/trust-keys.json` (открытые JWK)

---

### Task 1: ИНН в домене — `isValidInn`, `normalizeInn` и общая фикстура

**Files:**

- Create: `packages/domain/src/inn.ts`, `packages/domain/fixtures/inn-cases.json`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/test/inn.test.ts`

**Interfaces:**

- Consumes: правила контрольной суммы закрытой `isValidInn` (`apps/api/src/modules/national-catalog/national-catalog.client.ts:523-536`): веса 10 цифр `[2,4,10,3,5,9,4,6,8]`, 12 цифр `[7,2,4,10,3,5,9,4,6,8]` и `[3,7,2,4,10,3,5,9,4,6,8]`, `% 11 % 10`.
- Produces: `isValidInn(value: string): boolean` (строгая, Д2), `normalizeInn(value: string): string | null`; фикстура `packages/domain/fixtures/inn-cases.json` — `[{ "input", "normalized": string | null }]`, которую читают тест домена (здесь), тест API (задача 2) и тест хоста (задача 8).

- [ ] **Step 1: Написать фикстуру и падающий тест**

Создать `packages/domain/fixtures/inn-cases.json` (контрольные суммы посчитаны при написании; `0000000000` действительно проходит формулу — это свойство алгоритма ФНС, а не ошибка фикстуры):

```json
[
  {
    "input": "7707083893",
    "normalized": "7707083893"
  },
  {
    "input": "7707654321",
    "normalized": "7707654321"
  },
  {
    "input": "1234567894",
    "normalized": "1234567894"
  },
  {
    "input": "500100732259",
    "normalized": "500100732259"
  },
  {
    "input": "526317984689",
    "normalized": "526317984689"
  },
  {
    "input": "0000000000",
    "normalized": "0000000000"
  },
  {
    "input": " 7707083893 ",
    "normalized": "7707083893"
  },
  {
    "input": "\t7707083893\r\n",
    "normalized": "7707083893"
  },
  {
    "input": "\u000b7707083893\f",
    "normalized": "7707083893"
  },
  {
    "input": "\u00a07707083893\u00a0",
    "normalized": "7707083893"
  },
  {
    "input": "\ufeff7707083893",
    "normalized": "7707083893"
  },
  {
    "input": "\u20287707083893\u3000",
    "normalized": "7707083893"
  },
  {
    "input": "\u2009500100732259\u202f",
    "normalized": "500100732259"
  },
  {
    "input": "\u00857707083893",
    "normalized": null
  },
  {
    "input": "\u200b7707083893",
    "normalized": null
  },
  {
    "input": "7707083894",
    "normalized": null
  },
  {
    "input": "500100732250",
    "normalized": null
  },
  {
    "input": "500100732209",
    "normalized": null
  },
  {
    "input": "770708389",
    "normalized": null
  },
  {
    "input": "77070838931",
    "normalized": null
  },
  {
    "input": "7707 083893",
    "normalized": null
  },
  {
    "input": "77070838A3",
    "normalized": null
  },
  {
    "input": "\uff17\uff17\uff10\uff17\uff10\uff18\uff13\uff18\uff19\uff13",
    "normalized": null
  },
  {
    "input": "-707083893",
    "normalized": null
  },
  {
    "input": "+7707083893",
    "normalized": null
  },
  {
    "input": "",
    "normalized": null
  },
  {
    "input": "   ",
    "normalized": null
  }
]
```

Создать `packages/domain/test/inn.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import cases from "../fixtures/inn-cases.json" with { type: "json" };
import { isValidInn, normalizeInn } from "../src/inn.js";

describe("the INN (shared with the host's Rust port through inn-cases.json)", () => {
  it.each(cases)("answers $input", ({ input, normalized }) => {
    expect(normalizeInn(input)).toBe(normalized);
    // Strict: only a bare valid INN, nothing trimmed.
    expect(isValidInn(input)).toBe(normalized !== null && normalized === input);
  });

  it("checks both check digits of a 12-digit INN and the one of a 10-digit INN", () => {
    expect(isValidInn("7707083893")).toBe(true);
    expect(isValidInn("7707654321")).toBe(true);
    expect(isValidInn("500100732259")).toBe(true);
    // The first check digit (index 10) wrong, then the second (index 11).
    expect(isValidInn("500100732209")).toBe(false);
    expect(isValidInn("500100732250")).toBe(false);
    for (let digit = 0; digit <= 9; digit += 1) {
      expect(isValidInn(`770708389${digit}`)).toBe(digit === 3);
    }
  });

  it("covers what the Rust port must agree on", () => {
    const inputs = cases.map((entry) => entry.input);
    // JavaScript's trim removes U+FEFF and keeps U+0085, unlike Rust's own trim.
    expect(inputs).toContain("\ufeff7707083893");
    expect(inputs).toContain("\u00857707083893");
    expect(cases.some((entry) => entry.normalized?.length === 12)).toBe(true);
    expect(cases.filter((entry) => entry.normalized === null).length).toBeGreaterThan(10);
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain exec vitest run test/inn.test.ts
```

Ожидается: FAIL — `Failed to load url ../src/inn.js` (модуля нет).

- [ ] **Step 3: Реализация**

Создать `packages/domain/src/inn.ts`:

```ts
/**
 * The Russian taxpayer number (ИНН): 10 digits for an organization, 12 for an
 * individual entrepreneur, with the Federal Tax Service's check digits. One
 * implementation for the cloud (the National Catalog client) and the
 * standalone product's license (spec 2026-10-13 §4.9); the host's Rust port
 * (`apps/standalone/host/src/inn.rs`) answers `fixtures/inn-cases.json` alike.
 */
const TEN = [2, 4, 10, 3, 5, 9, 4, 6, 8] as const;
const TWELVE_FIRST = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8] as const;
const TWELVE_SECOND = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8] as const;

function checkDigit(digits: readonly number[], weights: readonly number[]): number {
  return (weights.reduce((sum, weight, index) => sum + weight * (digits[index] ?? 0), 0) % 11) % 10;
}

/** Exactly 10 or 12 ASCII digits whose check digits hold; nothing is trimmed. */
export function isValidInn(value: string): boolean {
  if (!/^\d{10}(?:\d{2})?$/.test(value)) return false;
  const digits = [...value].map(Number);
  if (digits.length === 10) return checkDigit(digits, TEN) === digits[9];
  return (
    checkDigit(digits, TWELVE_FIRST) === digits[10] &&
    checkDigit(digits, TWELVE_SECOND) === digits[11]
  );
}

/**
 * `value` without the whitespace `String.prototype.trim` removes, when that is
 * a valid INN; otherwise `null`. Inner spaces, letters and other digits than
 * ASCII are never removed: such a value is no INN.
 */
export function normalizeInn(value: string): string | null {
  const trimmed = value.trim();
  return isValidInn(trimmed) ? trimmed : null;
}
```

Правка `packages/domain/src/index.ts` — фрагмент (последние строки файла):

```ts
export {
  PALLET_SHEET_FOOTER_CAPABILITY,
  palletSheetRequiresFooterCapability,
} from "./labels/pallet-sheet-model.js";
```

заменить на:

```ts
export {
  PALLET_SHEET_FOOTER_CAPABILITY,
  palletSheetRequiresFooterCapability,
} from "./labels/pallet-sheet-model.js";

export { isValidInn, normalizeInn } from "./inn.js";
```

- [ ] **Step 4: Убедиться, что тест проходит**

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain exec vitest run test/inn.test.ts
```

Ожидается: PASS (27 случаев фикстуры и два теста правил).

- [ ] **Step 5: Мутации**

- M1: в `inn.ts` заменить `const trimmed = value.trim();` на `const trimmed = value;` → FAIL случаи с пробелами (`" 7707083893 "`, `" 7707083893 "`, …).
- M2: убрать `&& checkDigit(digits, TWELVE_SECOND) === digits[11]` → FAIL `500100732250` и «checks both check digits…».

- [ ] **Step 6: Гейты**

```bash
node_modules/.bin/prettier --ignore-path .prettierignore --check packages/domain/src/inn.ts packages/domain/src/index.ts packages/domain/test/inn.test.ts packages/domain/fixtures/inn-cases.json
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain run lint
git diff --check
```

- [ ] **Step 7: Коммит**

```bash
git add packages/domain/src/inn.ts packages/domain/src/index.ts packages/domain/test/inn.test.ts packages/domain/fixtures/inn-cases.json
git commit -F /tmp/claude/msg-lc1-1.txt
```

Сообщение (`/tmp/claude/msg-lc1-1.txt`): `feat(domain): the INN check digits move into the domain, with a fixture the host's port will answer too` + пустая строка + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 2: API берёт `isValidInn` из домена

**Files:**

- Modify: `apps/api/src/modules/national-catalog/national-catalog.client.ts`
- Test: `apps/api/test/national-catalog.client.test.ts`

**Interfaces:**

- Consumes: `isValidInn` из `@markiro/domain` (задача 1), `packages/domain/fixtures/inn-cases.json`.
- Produces: клиент НК без своей копии контрольной суммы; поведение `listEtags({ ownerInn })` прежнее (строгое, Д2).

- [ ] **Step 1: Написать тесты**

Правка `apps/api/test/national-catalog.client.test.ts`:

Фрагмент 1:

```ts
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
```

заменить на:

```ts
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";
```

Фрагмент 2:

```ts
describe("NationalCatalogClient", () => {
```

заменить на:

```ts
// The INN cases the domain, the API and the standalone host answer alike.
const innCases = z
  .array(z.object({ input: z.string(), normalized: z.string().nullable() }).strict())
  .parse(
    JSON.parse(
      readFileSync(join(__dirname, "../../../packages/domain/fixtures/inn-cases.json"), "utf8"),
    ),
  );

describe("NationalCatalogClient", () => {
```

Фрагмент 3 (перед тестом «rejects oversized, inconsistent, and malformed etagslist pages»):

```ts
  it("rejects oversized, inconsistent, and malformed etagslist pages", async () => {
```

заменить на:

```ts
  it("takes an owner INN exactly when the shared domain fixture calls it a bare valid INN", async () => {
    const calls: string[] = [];
    const client = new NationalCatalogClient(
      dependencies(async (url) => {
        calls.push(String(url));
        return new Response(JSON.stringify({ apiversion: 3, result: {} }), { status: 200 });
      }),
    );
    let accepted = 0;
    for (const { input, normalized } of innCases) {
      const request = client.listEtags(auth, { ownerInn: input });
      if (normalized === input) {
        accepted += 1;
        await expect(request).resolves.toBeDefined();
      } else {
        await expect(request).rejects.toThrow("National Catalog ownerInn must be a valid INN");
      }
    }
    expect(accepted).toBeGreaterThan(3);
    expect(calls).toHaveLength(accepted);
  });

  it("checks an owner INN with the domain's isValidInn, not a copy of its own", () => {
    const source = readFileSync(
      join(__dirname, "../src/modules/national-catalog/national-catalog.client.ts"),
      "utf8",
    );
    expect(source).toMatch(/import \{ isValidInn \} from "@markiro\/domain";/);
    expect(source).not.toMatch(/function isValidInn\(/);
  });

  it("rejects oversized, inconsistent, and malformed etagslist pages", async () => {
```

- [ ] **Step 2: Убедиться, что падает именно тест источника**

```bash
pnpm --config.verifyDepsBeforeRun=false exec turbo run build --filter=@markiro/domain
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/national-catalog.client.test.ts
```

Ожидается: FAIL «checks an owner INN with the domain's isValidInn…» (импорта нет, функция есть). Тест «takes an owner INN exactly…» уже PASS: правила совпадают — он закрепляет, что перенос их не меняет (ответ `invalid_response` на пустой `result` годится: тест ждёт только отсутствия отказа по ИНН).

- [ ] **Step 3: Реализация**

Правка `apps/api/src/modules/national-catalog/national-catalog.client.ts`:

Фрагмент 1:

```ts
import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
```

заменить на:

```ts
import { Injectable } from "@nestjs/common";
import { isValidInn } from "@markiro/domain";
import { createHash } from "node:crypto";
```

Фрагмент 2 — удалить целиком (вместе с пустой строкой после него):

```ts
function isValidInn(value: string): boolean {
  if (!/^\d{10}(?:\d{2})?$/.test(value)) return false;
  const digits = [...value].map(Number);
  const checksum = (weights: number[]): number =>
    (weights.reduce((sum, weight, index) => sum + weight * (digits[index] ?? 0), 0) % 11) % 10;
  if (digits.length === 10) {
    return checksum([2, 4, 10, 3, 5, 9, 4, 6, 8]) === digits[9];
  }
  return (
    checksum([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === digits[10] &&
    checksum([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === digits[11]
  );
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/national-catalog.client.test.ts
```

Ожидается: PASS весь файл, в том числе прежний «reads and strictly validates a documented etagslist page» (`7707083893` принят, `012345` отвергнут).

- [ ] **Step 5: Мутация**

- M1: в `packages/domain/src/inn.ts` заменить `=== digits[9]` на `!== digits[9]`, `pnpm --config.verifyDepsBeforeRun=false exec turbo run build --filter=@markiro/domain`, тест API → FAIL «takes an owner INN exactly…» и «reads and strictly validates…». Вернуть файл, собрать домен снова.

- [ ] **Step 6: Гейты**

```bash
node_modules/.bin/prettier --ignore-path .prettierignore --check apps/api/src/modules/national-catalog/national-catalog.client.ts apps/api/test/national-catalog.client.test.ts
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api run lint
git diff --check
```

- [ ] **Step 7: Коммит**

```bash
git add apps/api/src/modules/national-catalog/national-catalog.client.ts apps/api/test/national-catalog.client.test.ts
git commit -F /tmp/claude/msg-lc1-2.txt
```

Сообщение: `refactor(api): the National Catalog client checks an owner INN with the domain's isValidInn` + пустая строка + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 3: Обобщённый компактный JWS ES256 в домене

**Files:**

- Create: `packages/domain/src/signed-documents/compact-jws.ts`
- Modify: `packages/domain/src/offline-grants/jws.ts`, `packages/domain/src/index.ts`
- Test: `packages/domain/test/compact-jws.test.ts`; без изменений и зелёным остаётся `packages/domain/test/offline-grants-jws.test.ts`

**Interfaces:**

- Consumes: закрытый декодер `decode` из `offline-grants/jws.ts:13-21` (переносится дословно); фикстура грантов `packages/platform-contracts/fixtures/offline-grants-v1.json` (тест разделения `typ`).
- Produces: `decodeBase64UrlCanonical(segment): Uint8Array<ArrayBuffer>`, `encodeBase64Url(bytes): string`, `decodeUtf8Strict(bytes): string`, `interface TrustedKey { kid; jwk }`, `type CompactJwsFailure`, `type CompactJwsVerification`, `verifyCompactJws(compact, { typ, keys, retiredKids? })`, `signCompactJws(privateKey, { typ, kid }, payload)`.

- [ ] **Step 1: Написать падающий тест**

Создать `packages/domain/test/compact-jws.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import grants from "../../platform-contracts/fixtures/offline-grants-v1.json" with { type: "json" };
import {
  decodeBase64UrlCanonical,
  encodeBase64Url,
  signCompactJws,
  verifyCompactJws,
  type TrustedKey,
} from "../src/signed-documents/compact-jws.js";

const TYP = "markiro-test+jws";
const encoder = new TextEncoder();
const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
]);
const other = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
]);
const key: TrustedKey = { kid: "k1", jwk: await crypto.subtle.exportKey("jwk", pair.publicKey) };
const keys = [key];

/** Signs any header and payload bytes, to build what signCompactJws never would. */
async function signRaw(privateKey: CryptoKey, header: unknown, payload: Uint8Array) {
  const input = `${encodeBase64Url(encoder.encode(JSON.stringify(header)))}.${encodeBase64Url(payload)}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    encoder.encode(input),
  );
  return `${input}.${encodeBase64Url(new Uint8Array(signature))}`;
}

describe("compact JWS ES256", () => {
  it("verifies what it signs and hands back the exact payload bytes", async () => {
    const compact = await signCompactJws(pair.privateKey, { typ: TYP, kid: "k1" }, { a: 1 });
    const result = await verifyCompactJws(compact, { typ: TYP, keys });
    expect(result).toEqual({ ok: true, kid: "k1", payload: encoder.encode('{"a":1}') });
    const [header] = compact.split(".");
    expect(JSON.parse(new TextDecoder().decode(decodeBase64UrlCanonical(header ?? "")))).toEqual({
      typ: TYP,
      alg: "ES256",
      kid: "k1",
    });
  });

  it("verifies the cloud's offline grant bytes under their own typ only", async () => {
    const device = grants.producers.find((producer) => producer.id === "device");
    if (!device) throw new Error("Missing device fixture");
    const grantKeys = [{ kid: grants.publicKey.kid, jwk: grants.publicKey.jwk }];
    const own = await verifyCompactJws(device.compact, {
      typ: "markiro-offline-grant+jws",
      keys: grantKeys,
    });
    expect(own).toMatchObject({ ok: true, kid: grants.publicKey.kid });
    expect(
      await verifyCompactJws(device.compact, {
        typ: "markiro-standalone-license+jws",
        keys: grantKeys,
      }),
    ).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses a header other than typ, alg ES256 and kid, even when signed", async () => {
    const payload = encoder.encode("{}");
    for (const header of [
      { typ: TYP, alg: "ES256", kid: "k1", cty: "json" },
      { typ: TYP, alg: "ES384", kid: "k1" },
      { typ: TYP, alg: "ES256" },
      { typ: TYP, alg: "ES256", kid: "" },
      { typ: TYP, alg: "ES256", kid: "k".repeat(129) },
      [TYP, "ES256", "k1"],
    ]) {
      expect(
        await verifyCompactJws(await signRaw(pair.privateKey, header, payload), { typ: TYP, keys }),
      ).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
    const plain = await signRaw(pair.privateKey, { typ: TYP, alg: "ES256", kid: "k1" }, payload);
    expect((await verifyCompactJws(plain, { typ: TYP, keys })).ok).toBe(true);
  });

  it("refuses non-canonical base64url and other segment counts", async () => {
    const compact = await signCompactJws(pair.privateKey, { typ: TYP, kid: "k1" }, { a: 1 });
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const bumped = alphabet[alphabet.indexOf(compact.slice(-1)) + 1] ?? "";
    const [header, payload, signature] = compact.split(".");
    for (const broken of [
      compact.slice(0, -1) + bumped,
      `${compact}=`,
      `${header}.${payload}`,
      `${compact}.${signature}`,
      `${header}..${signature}`,
      `${header}.${payload}.${(signature ?? "").replace(/-/g, "+").replace(/_/g, "/")}`,
      ` ${compact}`,
      "",
    ]) {
      expect(await verifyCompactJws(broken, { typ: TYP, keys })).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
  });

  it("refuses an unknown, retired, repeated or unsuitable key", async () => {
    const compact = await signCompactJws(pair.privateKey, { typ: TYP, kid: "k1" }, { a: 1 });
    const refuse = { ok: false, reason: "unknown_key" };
    expect(await verifyCompactJws(compact, { typ: TYP, keys: [{ ...key, kid: "k2" }] })).toEqual(
      refuse,
    );
    expect(await verifyCompactJws(compact, { typ: TYP, keys, retiredKids: ["k1"] })).toEqual(
      refuse,
    );
    expect(await verifyCompactJws(compact, { typ: TYP, keys: [key, key] })).toEqual(refuse);
    for (const override of [{ crv: "P-384" }, { kty: "RSA" }, { d: "never" }, { use: "enc" }]) {
      expect(
        await verifyCompactJws(compact, {
          typ: TYP,
          keys: [{ kid: "k1", jwk: { ...key.jwk, ...override } }],
        }),
      ).toEqual(refuse);
    }
  });

  it("refuses a changed payload, a foreign signature and a short one", async () => {
    const compact = await signCompactJws(pair.privateKey, { typ: TYP, kid: "k1" }, { stations: 5 });
    const [header, , signature] = compact.split(".");
    const raised = `${header}.${encodeBase64Url(encoder.encode('{"stations":50}'))}.${signature}`;
    const foreign = await signCompactJws(
      other.privateKey,
      { typ: TYP, kid: "k1" },
      { stations: 5 },
    );
    const bytes = decodeBase64UrlCanonical(signature ?? "");
    const [h, p] = compact.split(".");
    const short = `${h}.${p}.${encodeBase64Url(bytes.subarray(0, 63))}`;
    for (const broken of [raised, foreign, short]) {
      expect(await verifyCompactJws(broken, { typ: TYP, keys })).toEqual({
        ok: false,
        reason: "bad_signature",
      });
    }
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain exec vitest run test/compact-jws.test.ts
```

Ожидается: FAIL — модуля `../src/signed-documents/compact-jws.js` нет.

- [ ] **Step 3: Реализация**

Создать `packages/domain/src/signed-documents/compact-jws.ts`:

```ts
import { z } from "zod";

/**
 * A compact JWS with ES256 (ECDSA P-256 SHA-256, the 64-byte IEEE P1363
 * signature): the format of the cloud's offline grants and of the standalone
 * product's license and update manifest (spec 2026-10-13 §4.1). The exact
 * bytes `header.payload` are signed, so nothing is re-serialized before
 * verification, and every segment must be canonical unpadded base64url.
 * `markiro_proto::trust` (Rust) is the twin; the fixtures of
 * `fixtures/standalone-license/` hold both to the same answers.
 */
export interface TrustedKey {
  kid: string;
  jwk: JsonWebKey;
}
export type CompactJwsFailure = "malformed" | "unknown_key" | "bad_signature";
export type CompactJwsVerification =
  { ok: true; kid: string; payload: Uint8Array } | { ok: false; reason: CompactJwsFailure };

const protectedHeaderSchema = z
  .object({ typ: z.string(), alg: z.literal("ES256"), kid: z.string().min(1).max(128) })
  .strict();

/** Unpadded base64url of `bytes`. */
export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/** The bytes of a canonical unpadded base64url segment; throws on anything else. */
export function decodeBase64UrlCanonical(segment: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(segment) || segment.length % 4 === 1) {
    throw new Error("Invalid base64url");
  }
  const binary = atob(segment.replace(/-/g, "+").replace(/_/g, "/"));
  const canonical = btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  if (canonical !== segment) throw new Error("Noncanonical base64url");
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** UTF-8 that keeps a byte order mark, so JSON.parse refuses it as serde_json does. */
export function decodeUtf8Strict(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

interface Segments {
  kid: string;
  payload: Uint8Array<ArrayBuffer>;
  signature: Uint8Array<ArrayBuffer>;
  signingInput: Uint8Array<ArrayBuffer>;
}

function segments(compact: string, typ: string): Segments | null {
  try {
    const parts = compact.split(".");
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    if (parts.length !== 3 || !encodedHeader || !encodedPayload || !encodedSignature) return null;
    const header = protectedHeaderSchema.parse(
      JSON.parse(decodeUtf8Strict(decodeBase64UrlCanonical(encodedHeader))),
    );
    if (header.typ !== typ) return null;
    return {
      kid: header.kid,
      payload: decodeBase64UrlCanonical(encodedPayload),
      signature: decodeBase64UrlCanonical(encodedSignature),
      signingInput: new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
    };
  } catch {
    return null;
  }
}

function usable(jwk: JsonWebKey): boolean {
  return (
    jwk.kty === "EC" &&
    jwk.crv === "P-256" &&
    !("d" in jwk) &&
    (jwk.alg === undefined || jwk.alg === "ES256") &&
    (jwk.use === undefined || jwk.use === "sig")
  );
}

/**
 * Checks a compact JWS of type `typ` against `keys`: the header exactly
 * `{typ, alg: "ES256", kid}`, the `kid` named once in `keys` and not retired,
 * the signature over the exact bytes. The payload comes back as bytes: its
 * reading belongs to the caller (`verifyStandaloneLicense`).
 */
export async function verifyCompactJws(
  compact: string,
  options: { typ: string; keys: readonly TrustedKey[]; retiredKids?: readonly string[] },
): Promise<CompactJwsVerification> {
  const parts = segments(compact, options.typ);
  if (!parts) return { ok: false, reason: "malformed" };
  if (options.retiredKids?.includes(parts.kid)) return { ok: false, reason: "unknown_key" };
  const named = options.keys.filter((key) => key.kid === parts.kid);
  // An ambiguous keyset fails closed rather than trusting array order.
  const key = named.length === 1 ? named[0] : undefined;
  if (!key || !usable(key.jwk)) return { ok: false, reason: "unknown_key" };
  if (parts.signature.length !== 64) return { ok: false, reason: "bad_signature" };
  let publicKey: CryptoKey;
  try {
    publicKey = await crypto.subtle.importKey(
      "jwk",
      key.jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
  } catch {
    return { ok: false, reason: "unknown_key" };
  }
  try {
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      parts.signature,
      parts.signingInput,
    );
    return valid
      ? { ok: true, kid: parts.kid, payload: parts.payload }
      : { ok: false, reason: "bad_signature" };
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
}

/** Signs `payload` (its JSON.stringify text) as a compact JWS `{typ, alg: "ES256", kid}`. */
export async function signCompactJws(
  privateKey: CryptoKey,
  header: { typ: string; kid: string },
  payload: unknown,
): Promise<string> {
  const encoder = new TextEncoder();
  const encodedHeader = encodeBase64Url(
    encoder.encode(JSON.stringify({ typ: header.typ, alg: "ES256", kid: header.kid })),
  );
  const encodedPayload = encodeBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      encoder.encode(`${encodedHeader}.${encodedPayload}`),
    ),
  );
  if (signature.length !== 64) throw new Error("An ES256 signature is 64 bytes");
  return `${encodedHeader}.${encodedPayload}.${encodeBase64Url(signature)}`;
}
```

Правка `packages/domain/src/offline-grants/jws.ts`:

Фрагмент 1:

```ts
import { grantProtectedHeaderSchema, offlineGrantSchema } from "./contracts.js";
import type { OfflineGrant } from "./types.js";
```

заменить на:

```ts
import { decodeBase64UrlCanonical as decode } from "../signed-documents/compact-jws.js";
import { grantProtectedHeaderSchema, offlineGrantSchema } from "./contracts.js";
import type { OfflineGrant } from "./types.js";
```

Фрагмент 2 — удалить (вместе с пустой строкой после него):

```ts
function decode(segment: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(segment) || segment.length % 4 === 1) {
    throw new Error("Invalid base64url");
  }
  const binary = atob(segment.replace(/-/g, "+").replace(/_/g, "/"));
  const canonical = btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  if (canonical !== segment) throw new Error("Noncanonical base64url");
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
```

Правка `packages/domain/src/index.ts` — фрагмент:

```ts
export { isValidInn, normalizeInn } from "./inn.js";
```

заменить на:

```ts
export { isValidInn, normalizeInn } from "./inn.js";
export * from "./signed-documents/compact-jws.js";
```

- [ ] **Step 4: Убедиться, что тесты проходят**

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain exec vitest run test/compact-jws.test.ts test/offline-grants-jws.test.ts
```

Ожидается: PASS оба файла (гранты не изменили поведения: тот же декодер).

- [ ] **Step 5: Мутации**

- M1: в `compact-jws.ts` убрать строку `if (canonical !== segment) throw new Error("Noncanonical base64url");` → FAIL «refuses non-canonical base64url…» и `offline-grants-jws.test.ts` «rejects noncanonical trailing base64 bits».
- M2: `const key = named.length === 1 ? named[0] : undefined;` → `const key = named[0];` → FAIL «refuses an unknown, retired, repeated or unsuitable key».
- M3: убрать `if (header.typ !== typ) return null;` → FAIL «verifies the cloud's offline grant bytes under their own typ only».

- [ ] **Step 6: Гейты**

```bash
node_modules/.bin/prettier --ignore-path .prettierignore --check packages/domain/src/signed-documents/compact-jws.ts packages/domain/src/offline-grants/jws.ts packages/domain/src/index.ts packages/domain/test/compact-jws.test.ts
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain run lint
git diff --check
```

- [ ] **Step 7: Коммит**

```bash
git add packages/domain/src/signed-documents/compact-jws.ts packages/domain/src/offline-grants/jws.ts packages/domain/src/index.ts packages/domain/test/compact-jws.test.ts
git commit -F /tmp/claude/msg-lc1-3.txt
```

Сообщение: `feat(domain): a general compact JWS ES256 check and signer, its canonical base64url shared with the offline grants` + пустая строка + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 4: Схемы и проверка лицензии, манифеста обновления и запроса активации

**Files:**

- Create: `packages/domain/src/standalone-license/contracts.ts`, `packages/domain/src/standalone-license/verify.ts`, `packages/domain/src/standalone-license/index.ts`, `packages/domain/fixtures/standalone-license/schema-cases.json`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/test/standalone-license.test.ts`

**Interfaces:**

- Consumes: `verifyCompactJws`, `decodeUtf8Strict`, `encodeBase64Url`, `signCompactJws`, `TrustedKey`, `CompactJwsFailure` (задача 3).
- Produces: `STANDALONE_LICENSE_TYP`, `STANDALONE_UPDATE_TYP`, `STANDALONE_LICENSE_MAX_BYTES`, `STANDALONE_UPDATE_MANIFEST_MAX_BYTES`, `STANDALONE_QUOTA_KEYS`, `STANDALONE_FEATURE_KEYS`, `standaloneLicenseQuotasSchema`, `standaloneLicenseFeaturesSchema`, `standaloneLicensePayloadV1Schema`, `standaloneActivationRequestSchema`, `standaloneUpdateManifestV1Schema`, типы (Д8), `verifyStandaloneLicense(compact, { origin, keys, retiredKids })`, `verifyStandaloneUpdateManifest(compact, { keys, retiredKids })`; фикстура `schema-cases.json` — `{ license|manifest|activation: { base, cases: [{ name, valid, set?, remove? }] } }` (пути через точку, один уровень вложения), которую обходит и Rust (задача 7).

- [ ] **Step 1: Написать фикстуру правил и падающий тест**

Создать `packages/domain/fixtures/standalone-license/schema-cases.json` (база лицензии — нагрузка `license-subscription.jws` задачи 5, база запроса — `activation-request.json`; ожидания сверены с готовыми схемами в черновой копии, 91 из 91):

```json
{
  "license": {
    "base": {
      "version": 1,
      "licenseId": "7a1e5c2b-3d4f-4a6b-8c9d-0e1f2a3b4c5d",
      "sequence": 1,
      "issuer": "https://license.test.invalid",
      "tenantId": "1b2c3d4e-5f60-4718-9a2b-3c4d5e6f7a8b",
      "siteId": "2c3d4e5f-6071-4829-8b3c-4d5e6f7a8b9c",
      "hostId": "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
      "customer": {
        "name": "ООО «Тестовая площадка»",
        "inn": "7707083893"
      },
      "plan": "subscription",
      "planVersionId": "4e5f6071-8293-4a4b-9c5d-6e7f8091a2b3",
      "entitlementRevision": "12",
      "issuedAt": 1792454400000,
      "validFrom": 1792454400000,
      "validUntil": 1823990400000,
      "graceDays": 14,
      "quotas": {
        "lines": 2,
        "stations": 5,
        "kiosks": 0,
        "cabinetUsers": 3
      },
      "features": {
        "labelEditor": true,
        "publicApi": false,
        "pallets": true,
        "chzIntegration": true,
        "inventory": false,
        "commerceMl": false,
        "handheld": true
      },
      "replaces": null
    },
    "cases": [
      {
        "name": "the base",
        "valid": true
      },
      {
        "name": "a demo without grace",
        "valid": true,
        "set": {
          "plan": "demo",
          "graceDays": 0
        }
      },
      {
        "name": "no limit on lines",
        "valid": true,
        "set": {
          "quotas.lines": null
        }
      },
      {
        "name": "a 12-digit INN",
        "valid": true,
        "set": {
          "customer.inn": "500100732259"
        }
      },
      {
        "name": "an INN with a wrong check digit keeps its shape: the host compares it",
        "valid": true,
        "set": {
          "customer.inn": "7707083894"
        }
      },
      {
        "name": "sixty days of grace",
        "valid": true,
        "set": {
          "graceDays": 60
        }
      },
      {
        "name": "the first revision",
        "valid": true,
        "set": {
          "entitlementRevision": "0"
        }
      },
      {
        "name": "replaces an earlier file",
        "valid": true,
        "set": {
          "replaces": "6c7d8e9f-0a1b-4c2d-9e3f-5061728394a5"
        }
      },
      {
        "name": "an unknown field",
        "valid": false,
        "set": {
          "note": "x"
        }
      },
      {
        "name": "an unknown customer field",
        "valid": false,
        "set": {
          "customer.kpp": "770701001"
        }
      },
      {
        "name": "an unknown feature",
        "valid": false,
        "set": {
          "features.kiosk": true
        }
      },
      {
        "name": "an unknown quota",
        "valid": false,
        "set": {
          "quotas.handhelds": 1
        }
      },
      {
        "name": "no replaces",
        "valid": false,
        "remove": ["replaces"]
      },
      {
        "name": "no kiosks quota",
        "valid": false,
        "remove": ["quotas.kiosks"]
      },
      {
        "name": "no handheld feature",
        "valid": false,
        "remove": ["features.handheld"]
      },
      {
        "name": "version 2",
        "valid": false,
        "set": {
          "version": 2
        }
      },
      {
        "name": "sequence 0",
        "valid": false,
        "set": {
          "sequence": 0
        }
      },
      {
        "name": "a sequence above 2^53 - 1",
        "valid": false,
        "set": {
          "sequence": 9007199254740992
        }
      },
      {
        "name": "a negative quota",
        "valid": false,
        "set": {
          "quotas.stations": -1
        }
      },
      {
        "name": "a fractional quota",
        "valid": false,
        "set": {
          "quotas.stations": 1.5
        }
      },
      {
        "name": "a quota as text",
        "valid": false,
        "set": {
          "quotas.stations": "5"
        }
      },
      {
        "name": "61 days of grace",
        "valid": false,
        "set": {
          "graceDays": 61
        }
      },
      {
        "name": "the plan trial",
        "valid": false,
        "set": {
          "plan": "trial"
        }
      },
      {
        "name": "an upper-case host id",
        "valid": false,
        "set": {
          "hostId": "3F1C2D4E-5A6B-4C7D-8E9F-0A1B2C3D4E5F"
        }
      },
      {
        "name": "a license id that is no UUID",
        "valid": false,
        "set": {
          "licenseId": "license-1"
        }
      },
      {
        "name": "a nil tenant id",
        "valid": false,
        "set": {
          "tenantId": "00000000-0000-0000-0000-000000000000"
        }
      },
      {
        "name": "validUntil equal to validFrom",
        "valid": false,
        "set": {
          "validUntil": 1792454400000
        }
      },
      {
        "name": "a revision with a leading zero",
        "valid": false,
        "set": {
          "entitlementRevision": "012"
        }
      },
      {
        "name": "a revision that is no number",
        "valid": false,
        "set": {
          "entitlementRevision": "r12"
        }
      },
      {
        "name": "a nine-digit INN",
        "valid": false,
        "set": {
          "customer.inn": "770708389"
        }
      },
      {
        "name": "an INN with a space",
        "valid": false,
        "set": {
          "customer.inn": "7707 083893"
        }
      },
      {
        "name": "an empty customer name",
        "valid": false,
        "set": {
          "customer.name": ""
        }
      },
      {
        "name": "a customer name with a line break",
        "valid": false,
        "set": {
          "customer.name": "ООО\nТест"
        }
      },
      {
        "name": "a negative issuedAt",
        "valid": false,
        "set": {
          "issuedAt": -1
        }
      },
      {
        "name": "a fractional issuedAt",
        "valid": false,
        "set": {
          "issuedAt": 1792454400000.5
        }
      },
      {
        "name": "an empty issuer",
        "valid": false,
        "set": {
          "issuer": ""
        }
      },
      {
        "name": "a feature as text",
        "valid": false,
        "set": {
          "features.pallets": "true"
        }
      },
      {
        "name": "the customer as an array",
        "valid": false,
        "set": {
          "customer": ["ООО «Тестовая площадка»", "7707083893"]
        }
      },
      {
        "name": "the quotas as an array",
        "valid": false,
        "set": {
          "quotas": [2, 5, 0, 3]
        }
      },
      {
        "name": "the features as an array",
        "valid": false,
        "set": {
          "features": [true, false, true, true, false, false, true]
        }
      }
    ]
  },
  "manifest": {
    "base": {
      "v": 1,
      "product": "markiro-standalone",
      "version": "0.3.0",
      "channel": "stable",
      "releasedAt": "2026-11-02T10:00:00Z",
      "sourceSha": "0123456789abcdef0123456789abcdef01234567",
      "installer": {
        "name": "markiro-standalone-0.3.0-windows-x86_64-setup.exe",
        "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "sizeBytes": 61234567
      },
      "protocol": 4,
      "minProtocol": 2,
      "minUpgradeFrom": "0.2.0",
      "notes": ["Лицензия площадки и страница «Информация»", "Обновление из файла"]
    },
    "cases": [
      {
        "name": "the base",
        "valid": true
      },
      {
        "name": "a beta",
        "valid": true,
        "set": {
          "channel": "beta"
        }
      },
      {
        "name": "no notes",
        "valid": true,
        "set": {
          "notes": []
        }
      },
      {
        "name": "thirty notes",
        "valid": true,
        "set": {
          "notes": [
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n"
          ]
        }
      },
      {
        "name": "fractional seconds",
        "valid": true,
        "set": {
          "releasedAt": "2026-11-02T10:00:00.123Z"
        }
      },
      {
        "name": "an upgrade from the same version",
        "valid": true,
        "set": {
          "minUpgradeFrom": "0.3.0"
        }
      },
      {
        "name": "minProtocol equal to protocol",
        "valid": true,
        "set": {
          "minProtocol": 4
        }
      },
      {
        "name": "a note of 200 characters",
        "valid": true,
        "set": {
          "notes": [
            "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
          ]
        }
      },
      {
        "name": "an unknown field",
        "valid": false,
        "set": {
          "signature": "x"
        }
      },
      {
        "name": "an unknown installer field",
        "valid": false,
        "set": {
          "installer.url": "https://example.invalid/setup.exe"
        }
      },
      {
        "name": "v 2",
        "valid": false,
        "set": {
          "v": 2
        }
      },
      {
        "name": "another product",
        "valid": false,
        "set": {
          "product": "markiro-station"
        }
      },
      {
        "name": "a version of two parts",
        "valid": false,
        "set": {
          "version": "0.3"
        }
      },
      {
        "name": "a version with a leading zero",
        "valid": false,
        "set": {
          "version": "01.3.0"
        }
      },
      {
        "name": "a pre-release version",
        "valid": false,
        "set": {
          "version": "0.3.0-beta.1"
        }
      },
      {
        "name": "the installer of another version",
        "valid": false,
        "set": {
          "installer.name": "markiro-standalone-0.2.9-windows-x86_64-setup.exe"
        }
      },
      {
        "name": "an installer name with a path",
        "valid": false,
        "set": {
          "installer.name": "..\\markiro-standalone-0.3.0-windows-x86_64-setup.exe"
        }
      },
      {
        "name": "an upper-case installer hash",
        "valid": false,
        "set": {
          "installer.sha256": "E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855"
        }
      },
      {
        "name": "a short source commit",
        "valid": false,
        "set": {
          "sourceSha": "0123456"
        }
      },
      {
        "name": "an empty installer",
        "valid": false,
        "set": {
          "installer.sizeBytes": 0
        }
      },
      {
        "name": "minProtocol above protocol",
        "valid": false,
        "set": {
          "minProtocol": 5
        }
      },
      {
        "name": "minProtocol 0",
        "valid": false,
        "set": {
          "minProtocol": 0
        }
      },
      {
        "name": "an upgrade only from a newer version",
        "valid": false,
        "set": {
          "minUpgradeFrom": "0.4.0"
        }
      },
      {
        "name": "an upgrade only from 0.10.0, newer by number though not by text",
        "valid": false,
        "set": {
          "minUpgradeFrom": "0.10.0"
        }
      },
      {
        "name": "thirty-one notes",
        "valid": false,
        "set": {
          "notes": [
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n",
            "n"
          ]
        }
      },
      {
        "name": "a note of 201 characters",
        "valid": false,
        "set": {
          "notes": [
            "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
          ]
        }
      },
      {
        "name": "a note with a line break",
        "valid": false,
        "set": {
          "notes": ["Первая\nвторая"]
        }
      },
      {
        "name": "an empty note",
        "valid": false,
        "set": {
          "notes": [""]
        }
      },
      {
        "name": "the channel nightly",
        "valid": false,
        "set": {
          "channel": "nightly"
        }
      },
      {
        "name": "a date without a time",
        "valid": false,
        "set": {
          "releasedAt": "2026-11-02"
        }
      },
      {
        "name": "a time with an offset",
        "valid": false,
        "set": {
          "releasedAt": "2026-11-02T13:00:00+03:00"
        }
      },
      {
        "name": "no notes field",
        "valid": false,
        "remove": ["notes"]
      },
      {
        "name": "the installer as an array",
        "valid": false,
        "set": {
          "installer": [
            "markiro-standalone-0.3.0-windows-x86_64-setup.exe",
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            61234567
          ]
        }
      }
    ]
  },
  "activation": {
    "base": {
      "format": "markiro-activation-request-v1",
      "hostId": "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
      "hostFingerprint": "9b2c4d6e8f0a1b3c5d7e9f1a2b4c6d8e0f1a3b5c7d9e1f2a4b6c8d0e2f4a6b8c",
      "hostVersion": "0.3.0",
      "organization": {
        "name": "ООО «Тестовая площадка»",
        "inn": "7707083893"
      },
      "trial": {
        "startedAt": "2026-10-20T09:00:00Z",
        "inn": "7707083893"
      },
      "currentLicense": {
        "licenseId": "7a1e5c2b-3d4f-4a6b-8c9d-0e1f2a3b4c5d",
        "sequence": 1
      },
      "usage": {
        "stations": 4,
        "cabinetUsers": 2,
        "lines": 2
      },
      "createdAt": "2026-10-21T09:00:00Z"
    },
    "cases": [
      {
        "name": "the base",
        "valid": true
      },
      {
        "name": "no trial",
        "valid": true,
        "set": {
          "trial": null
        }
      },
      {
        "name": "no license yet",
        "valid": true,
        "set": {
          "currentLicense": null
        }
      },
      {
        "name": "no INN in the organization yet",
        "valid": true,
        "set": {
          "organization.inn": ""
        }
      },
      {
        "name": "an unknown field",
        "valid": false,
        "set": {
          "note": "x"
        }
      },
      {
        "name": "another format",
        "valid": false,
        "set": {
          "format": "markiro-activation-request-v2"
        }
      },
      {
        "name": "a three-digit INN",
        "valid": false,
        "set": {
          "organization.inn": "123"
        }
      },
      {
        "name": "no lines in the usage",
        "valid": false,
        "remove": ["usage.lines"]
      },
      {
        "name": "a negative usage",
        "valid": false,
        "set": {
          "usage.stations": -1
        }
      },
      {
        "name": "an upper-case fingerprint",
        "valid": false,
        "set": {
          "hostFingerprint": "9B2C4D6E8F0A1B3C5D7E9F1A2B4C6D8E0F1A3B5C7D9E1F2A4B6C8D0E2F4A6B8C"
        }
      },
      {
        "name": "a host version of two parts",
        "valid": false,
        "set": {
          "hostVersion": "0.3"
        }
      },
      {
        "name": "a license of sequence 0",
        "valid": false,
        "set": {
          "currentLicense.sequence": 0
        }
      },
      {
        "name": "no trial field",
        "valid": false,
        "remove": ["trial"]
      },
      {
        "name": "a creation time without a zone",
        "valid": false,
        "set": {
          "createdAt": "2026-10-21T09:00:00"
        }
      },
      {
        "name": "an unknown usage key",
        "valid": false,
        "set": {
          "usage.kiosks": 0
        }
      },
      {
        "name": "the organization as an array",
        "valid": false,
        "set": {
          "organization": ["ООО «Тестовая площадка»", "7707083893"]
        }
      },
      {
        "name": "the trial as an array",
        "valid": false,
        "set": {
          "trial": ["2026-10-20T09:00:00Z", "7707083893"]
        }
      },
      {
        "name": "the usage as an array",
        "valid": false,
        "set": {
          "usage": [4, 2, 2]
        }
      }
    ]
  }
}
```

Создать `packages/domain/test/standalone-license.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { z } from "zod";

import schemaCases from "../fixtures/standalone-license/schema-cases.json" with { type: "json" };
import { encodeBase64Url, signCompactJws } from "../src/signed-documents/compact-jws.js";
import {
  STANDALONE_FEATURE_KEYS,
  STANDALONE_LICENSE_MAX_BYTES,
  STANDALONE_LICENSE_TYP,
  STANDALONE_QUOTA_KEYS,
  STANDALONE_UPDATE_TYP,
  standaloneActivationRequestSchema,
  standaloneLicenseFeaturesSchema,
  standaloneLicensePayloadV1Schema,
  standaloneLicenseQuotasSchema,
  standaloneUpdateManifestV1Schema,
  verifyStandaloneLicense,
  verifyStandaloneUpdateManifest,
} from "../src/standalone-license/index.js";

const caseSchema = z
  .object({
    name: z.string(),
    valid: z.boolean(),
    set: z.record(z.string(), z.unknown()).optional(),
    remove: z.array(z.string()).optional(),
  })
  .strict();
const groupSchema = z
  .object({ base: z.record(z.string(), z.unknown()), cases: z.array(caseSchema).min(1) })
  .strict();
const cases = z
  .object({ license: groupSchema, manifest: groupSchema, activation: groupSchema })
  .strict()
  .parse(schemaCases);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The object holding a dotted path's last key (as `apply` in proto/tests/trust.rs). */
function parent(root: Record<string, unknown>, path: string): [Record<string, unknown>, string] {
  const parts = path.split(".");
  const key = parts.pop();
  let target: unknown = root;
  for (const part of parts) target = isRecord(target) ? target[part] : undefined;
  if (!isRecord(target) || key === undefined) throw new Error(`No object for ${path}`);
  return [target, key];
}

function applyCase(base: Record<string, unknown>, item: z.infer<typeof caseSchema>) {
  const value = structuredClone(base);
  for (const [path, next] of Object.entries(item.set ?? {})) {
    const [target, key] = parent(value, path);
    target[key] = next;
  }
  for (const path of item.remove ?? []) {
    const [target, key] = parent(value, path);
    if (!(key in target)) throw new Error(`Nothing at ${path}`);
    delete target[key];
  }
  return value;
}

const groups = [
  ["license", standaloneLicensePayloadV1Schema],
  ["manifest", standaloneUpdateManifestV1Schema],
  ["activation", standaloneActivationRequestSchema],
] as const;

describe.each(groups)("the %s schema cases (shared with markiro_proto::trust)", (name, schema) => {
  it.each(cases[name].cases)("$name", (item) => {
    expect(schema.safeParse(applyCase(cases[name].base, item)).success).toBe(item.valid);
  });
});

describe("standalone license contracts", () => {
  it("name the cloud's quota and feature keys, and only those", () => {
    expect(Object.keys(standaloneLicenseQuotasSchema.shape)).toEqual([...STANDALONE_QUOTA_KEYS]);
    expect(Object.keys(standaloneLicenseFeaturesSchema.shape)).toEqual([
      ...STANDALONE_FEATURE_KEYS,
    ]);
    expect(STANDALONE_LICENSE_TYP).toBe("markiro-standalone-license+jws");
    expect(STANDALONE_UPDATE_TYP).toBe("markiro-standalone-update+jws");
    expect(STANDALONE_LICENSE_MAX_BYTES).toBe(16 * 1024);
  });
});

describe("verifyStandaloneLicense", () => {
  const ORIGIN = "https://license.test.invalid";
  const encoder = new TextEncoder();
  const license = cases.license.base;
  const manifest = cases.manifest.base;

  async function setUp() {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const keys = [{ kid: "k1", jwk: await crypto.subtle.exportKey("jwk", pair.publicKey) }];
    return { privateKey: pair.privateKey, keyset: { origin: ORIGIN, keys, retiredKids: [] } };
  }

  async function signRaw(privateKey: CryptoKey, payload: Uint8Array) {
    const header = encoder.encode(
      JSON.stringify({ typ: STANDALONE_LICENSE_TYP, alg: "ES256", kid: "k1" }),
    );
    const input = `${encodeBase64Url(header)}.${encodeBase64Url(payload)}`;
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      encoder.encode(input),
    );
    return `${input}.${encodeBase64Url(new Uint8Array(signature))}`;
  }

  it("returns the license of the keyset's issuer with its kid", async () => {
    const { privateKey, keyset } = await setUp();
    const compact = await signCompactJws(
      privateKey,
      { typ: STANDALONE_LICENSE_TYP, kid: "k1" },
      license,
    );
    expect(await verifyStandaloneLicense(compact, keyset)).toEqual({
      ok: true,
      kid: "k1",
      license,
    });
  });

  it("calls malformed, after the signature, another issuer, an unknown field and a payload that is no UTF-8 JSON object", async () => {
    const { privateKey, keyset } = await setUp();
    const malformed = { ok: false, reason: "malformed" };
    const signed = (payload: unknown) =>
      signCompactJws(privateKey, { typ: STANDALONE_LICENSE_TYP, kid: "k1" }, payload);
    expect(
      await verifyStandaloneLicense(await signed(license), {
        ...keyset,
        origin: "https://other.invalid",
      }),
    ).toEqual(malformed);
    expect(await verifyStandaloneLicense(await signed({ ...license, limits: {} }), keyset)).toEqual(
      malformed,
    );
    expect(await verifyStandaloneLicense(await signed(Object.values(license)), keyset)).toEqual(
      malformed,
    );
    const json = encoder.encode(JSON.stringify(license));
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...json]);
    expect(await verifyStandaloneLicense(await signRaw(privateKey, withBom), keyset)).toEqual(
      malformed,
    );
    expect(
      await verifyStandaloneLicense(
        await signRaw(privateKey, new Uint8Array([0xff, 0xfe])),
        keyset,
      ),
    ).toEqual(malformed);
    // A repeated key keeps its last value, as serde_json read through a Value does.
    const repeated = encoder.encode(`{"graceDays":99,${JSON.stringify(license).slice(1)}`);
    expect((await verifyStandaloneLicense(await signRaw(privateKey, repeated), keyset)).ok).toBe(
      true,
    );
  });

  it("refuses a file above 16 KiB before reading it", async () => {
    const { privateKey, keyset } = await setUp();
    const compact = await signCompactJws(
      privateKey,
      { typ: STANDALONE_LICENSE_TYP, kid: "k1" },
      license,
    );
    const oversized = compact + " ".repeat(STANDALONE_LICENSE_MAX_BYTES + 1 - compact.length);
    expect(await verifyStandaloneLicense(oversized, keyset)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("keeps a license and an update manifest apart by their typ", async () => {
    const { privateKey, keyset } = await setUp();
    const asLicense = await signCompactJws(
      privateKey,
      { typ: STANDALONE_LICENSE_TYP, kid: "k1" },
      manifest,
    );
    const asUpdate = await signCompactJws(
      privateKey,
      { typ: STANDALONE_UPDATE_TYP, kid: "k1" },
      manifest,
    );
    const updateKeyset = { keys: keyset.keys, retiredKids: [] };
    expect(await verifyStandaloneUpdateManifest(asUpdate, updateKeyset)).toEqual({
      ok: true,
      kid: "k1",
      manifest,
    });
    expect(await verifyStandaloneUpdateManifest(asLicense, updateKeyset)).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(await verifyStandaloneLicense(asUpdate, keyset)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain exec vitest run test/standalone-license.test.ts
```

Ожидается: FAIL — модуля `../src/standalone-license/index.js` нет.

- [ ] **Step 3: Реализация**

Создать `packages/domain/src/standalone-license/contracts.ts`:

```ts
import { z } from "zod";

/** `typ` of a license file's JWS header (spec 2026-10-13 §4.1). */
export const STANDALONE_LICENSE_TYP = "markiro-standalone-license+jws";
/** `typ` of an update manifest's JWS header (spec §10.1). */
export const STANDALONE_UPDATE_TYP = "markiro-standalone-update+jws";
/** A license file above this many UTF-8 bytes is refused unread (spec §4.3). */
export const STANDALONE_LICENSE_MAX_BYTES = 16 * 1024;
/** An update manifest above this many UTF-8 bytes is refused unread (spec §10.11.2). */
export const STANDALONE_UPDATE_MANIFEST_MAX_BYTES = 64 * 1024;
/**
 * The cloud's `ENTITLEMENT_QUOTA_KEYS` and `ENTITLEMENT_FEATURE_KEYS`, in their
 * order: the license is a signed export of the SaaS entitlements (spec §4), and
 * `@markiro/platform-contracts` asserts the lists stay equal.
 */
export const STANDALONE_QUOTA_KEYS = ["lines", "stations", "kiosks", "cabinetUsers"] as const;
export const STANDALONE_FEATURE_KEYS = [
  "labelEditor",
  "publicApi",
  "pallets",
  "chzIntegration",
  "inventory",
  "commerceMl",
  "handheld",
] as const;
export type StandaloneQuotaKey = (typeof STANDALONE_QUOTA_KEYS)[number];
export type StandaloneFeatureKey = (typeof STANDALONE_FEATURE_KEYS)[number];

// Lower-case canonical UUIDs (versions 1-8, the RFC variant): what the cloud
// and the host write, and what `markiro_proto::trust` accepts byte for byte.
const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const safeCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const instant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/);
const VERSION = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;
const version = z.string().regex(VERSION);
const lowerHex = (length: number) => z.string().regex(new RegExp(`^[0-9a-f]{${length}}$`));

/** No control character (U+0000-U+001F, U+007F): the text is shown as text. */
function isPlainText(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}
const plainText = (max: number) =>
  z.string().min(1).max(max).refine(isPlainText, "Control characters are not allowed");

function versionParts(value: string): readonly [number, number, number] {
  const match = VERSION.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0];
}
function compareVersions(left: string, right: string): number {
  const [a, b] = [versionParts(left), versionParts(right)];
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

const quota = safeCount.nullable();
export const standaloneLicenseQuotasSchema = z
  .object({ lines: quota, stations: quota, kiosks: quota, cabinetUsers: quota })
  .strict();
export const standaloneLicenseFeaturesSchema = z
  .object({
    labelEditor: z.boolean(),
    publicApi: z.boolean(),
    pallets: z.boolean(),
    chzIntegration: z.boolean(),
    inventory: z.boolean(),
    commerceMl: z.boolean(),
    handheld: z.boolean(),
  })
  .strict();

/** The license file's payload (spec §4.2); read strictly, an unknown field is malformed. */
export const standaloneLicensePayloadV1Schema = z
  .object({
    version: z.literal(1),
    licenseId: uuid,
    sequence: positive,
    issuer: z.string().min(1).max(256),
    tenantId: uuid,
    siteId: uuid,
    hostId: uuid,
    customer: z
      .object({ name: plainText(300), inn: z.string().regex(/^(?:\d{10}|\d{12})$/) })
      .strict(),
    plan: z.enum(["demo", "subscription"]),
    planVersionId: uuid,
    entitlementRevision: z.string().regex(/^(?:0|[1-9][0-9]{0,18})$/),
    issuedAt: safeCount,
    validFrom: safeCount,
    validUntil: safeCount,
    graceDays: z.number().int().min(0).max(60),
    quotas: standaloneLicenseQuotasSchema,
    features: standaloneLicenseFeaturesSchema,
    replaces: uuid.nullable(),
  })
  .strict()
  .refine((license) => license.validFrom < license.validUntil, "validFrom must precede validUntil");

const innOrNone = z.string().regex(/^(?:\d{10}|\d{12})?$/);
/** The host's activation request (spec §6.3): unsigned, no secret in it. */
export const standaloneActivationRequestSchema = z
  .object({
    format: z.literal("markiro-activation-request-v1"),
    hostId: uuid,
    hostFingerprint: lowerHex(64),
    hostVersion: version,
    organization: z.object({ name: plainText(300), inn: innOrNone }).strict(),
    trial: z.object({ startedAt: instant, inn: innOrNone }).strict().nullable(),
    currentLicense: z.object({ licenseId: uuid, sequence: positive }).strict().nullable(),
    usage: z.object({ stations: safeCount, cabinetUsers: safeCount, lines: safeCount }).strict(),
    createdAt: instant,
  })
  .strict();

/** The signed update manifest (spec §10.2): the exact key set of a release. */
export const standaloneUpdateManifestV1Schema = z
  .object({
    v: z.literal(1),
    product: z.literal("markiro-standalone"),
    version,
    channel: z.enum(["beta", "stable"]),
    releasedAt: instant,
    sourceSha: lowerHex(40),
    installer: z
      .object({ name: z.string().min(1).max(128), sha256: lowerHex(64), sizeBytes: positive })
      .strict(),
    protocol: z.number().int().positive().max(4_294_967_295),
    minProtocol: z.number().int().positive().max(4_294_967_295),
    minUpgradeFrom: version,
    notes: z.array(plainText(200)).max(30),
  })
  .strict()
  .refine(
    (manifest) =>
      manifest.installer.name === `markiro-standalone-${manifest.version}-windows-x86_64-setup.exe`,
    "The installer is the release's own",
  )
  .refine((manifest) => manifest.minProtocol <= manifest.protocol, "minProtocol above protocol")
  .refine(
    (manifest) => compareVersions(manifest.minUpgradeFrom, manifest.version) <= 0,
    "minUpgradeFrom above version",
  );

export type StandaloneLicensePayloadV1 = z.infer<typeof standaloneLicensePayloadV1Schema>;
export type StandaloneActivationRequest = z.infer<typeof standaloneActivationRequestSchema>;
export type StandaloneUpdateManifestV1 = z.infer<typeof standaloneUpdateManifestV1Schema>;
```

Создать `packages/domain/src/standalone-license/verify.ts`:

```ts
import type { z } from "zod";

import {
  decodeUtf8Strict,
  verifyCompactJws,
  type CompactJwsFailure,
  type TrustedKey,
} from "../signed-documents/compact-jws.js";
import {
  STANDALONE_LICENSE_MAX_BYTES,
  STANDALONE_LICENSE_TYP,
  STANDALONE_UPDATE_MANIFEST_MAX_BYTES,
  STANDALONE_UPDATE_TYP,
  standaloneLicensePayloadV1Schema,
  standaloneUpdateManifestV1Schema,
  type StandaloneLicensePayloadV1,
  type StandaloneUpdateManifestV1,
} from "./contracts.js";

/** The license keyset a build trusts: the issuer's origin and its keys by `kid`. */
export interface StandaloneLicenseKeyset {
  origin: string;
  keys: readonly TrustedKey[];
  retiredKids: readonly string[];
}
/** The release keyset: update manifests carry no issuer. */
export interface StandaloneUpdateKeyset {
  keys: readonly TrustedKey[];
  retiredKids: readonly string[];
}
export type StandaloneLicenseVerification =
  | { ok: true; kid: string; license: StandaloneLicensePayloadV1 }
  | { ok: false; reason: CompactJwsFailure };
export type StandaloneUpdateVerification =
  | { ok: true; kid: string; manifest: StandaloneUpdateManifestV1 }
  | { ok: false; reason: CompactJwsFailure };

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

function readPayload<T>(bytes: Uint8Array, schema: z.ZodType<T>): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(decodeUtf8Strict(bytes)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Steps 1-4 of the host's check (spec §4.3): size, form, `kid`, signature,
 * then the payload strictly and its issuer against the keyset's origin. A
 * payload or issuer that does not fit is `malformed`. The binding (`hostId`,
 * INN, sequence) is the host's.
 */
export async function verifyStandaloneLicense(
  compact: string,
  keyset: StandaloneLicenseKeyset,
): Promise<StandaloneLicenseVerification> {
  if (utf8Length(compact) > STANDALONE_LICENSE_MAX_BYTES) return { ok: false, reason: "malformed" };
  const verified = await verifyCompactJws(compact, {
    typ: STANDALONE_LICENSE_TYP,
    keys: keyset.keys,
    retiredKids: keyset.retiredKids,
  });
  if (!verified.ok) return verified;
  const license = readPayload(verified.payload, standaloneLicensePayloadV1Schema);
  if (!license || license.issuer !== keyset.origin) return { ok: false, reason: "malformed" };
  return { ok: true, kid: verified.kid, license };
}

/** The same for an update manifest, signed by the release key. */
export async function verifyStandaloneUpdateManifest(
  compact: string,
  keyset: StandaloneUpdateKeyset,
): Promise<StandaloneUpdateVerification> {
  if (utf8Length(compact) > STANDALONE_UPDATE_MANIFEST_MAX_BYTES) {
    return { ok: false, reason: "malformed" };
  }
  const verified = await verifyCompactJws(compact, {
    typ: STANDALONE_UPDATE_TYP,
    keys: keyset.keys,
    retiredKids: keyset.retiredKids,
  });
  if (!verified.ok) return verified;
  const manifest = readPayload(verified.payload, standaloneUpdateManifestV1Schema);
  return manifest ? { ok: true, kid: verified.kid, manifest } : { ok: false, reason: "malformed" };
}
```

Создать `packages/domain/src/standalone-license/index.ts`:

```ts
export * from "./contracts.js";
export * from "./verify.js";
```

Правка `packages/domain/src/index.ts` — фрагмент:

```ts
export * from "./signed-documents/compact-jws.js";
```

заменить на:

```ts
export * from "./signed-documents/compact-jws.js";
export * from "./standalone-license/index.js";
```

- [ ] **Step 4: Убедиться, что тест проходит**

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain exec vitest run test/standalone-license.test.ts
```

Ожидается: PASS — 91 случай правил и 5 тестов проверки.

- [ ] **Step 5: Мутации**

- M1: убрать `.strict()` у объекта `standaloneLicensePayloadV1Schema` → FAIL «an unknown field» (license) и «calls malformed, after the signature, …».
- M2: убрать первую `.refine` манифеста (имя установщика) → FAIL «the installer of another version», «an installer name with a path».
- M3: в `compareVersions` заменить тело на `return left.localeCompare(right);` → FAIL «an upgrade only from 0.10.0, newer by number though not by text».
- M4: в `decodeUtf8Strict` (`compact-jws.ts`) убрать `ignoreBOM: true` → FAIL «calls malformed, after the signature, …» (BOM).

- [ ] **Step 6: Гейты**

```bash
node_modules/.bin/prettier --ignore-path .prettierignore --check packages/domain/src/standalone-license/contracts.ts packages/domain/src/standalone-license/verify.ts packages/domain/src/standalone-license/index.ts packages/domain/src/index.ts packages/domain/test/standalone-license.test.ts packages/domain/fixtures/standalone-license/schema-cases.json
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain run lint
git diff --check
```

- [ ] **Step 7: Коммит**

```bash
git add packages/domain/src/standalone-license/contracts.ts packages/domain/src/standalone-license/verify.ts packages/domain/src/standalone-license/index.ts packages/domain/src/index.ts packages/domain/test/standalone-license.test.ts packages/domain/fixtures/standalone-license/schema-cases.json
git commit -F /tmp/claude/msg-lc1-4.txt
```

Сообщение: `feat(domain): strict schemas and checks of the standalone license, update manifest and activation request` + пустая строка + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 5: Генератор, подписанные тестовые фикстуры, переэкспорт в контрактах платформы

**Files:**

- Create: `packages/domain/scripts/generate-standalone-fixtures.mjs`; результат генератора — `packages/domain/fixtures/standalone-license/{test-private-keys.json,test-keyset.json,activation-request.json,expectations.json,license-subscription.jws,license-demo.jws,license-upgrade.jws,license-older.jws,license-other-host.jws,license-other-inn.jws,license-tampered.jws,license-unknown-kid.jws,update-manifest.jws}`; `packages/platform-contracts/src/standalone-license.ts`
- Modify: `packages/platform-contracts/src/index.ts`
- Test: `packages/domain/test/standalone-license-fixtures.test.ts`, `packages/platform-contracts/test/standalone-license.test.ts`

**Interfaces:**

- Consumes: `verifyStandaloneLicense`, `verifyStandaloneUpdateManifest`, `standaloneActivationRequestSchema`, константы (задача 4), `isValidInn` (задача 1); `ENTITLEMENT_QUOTA_KEYS`, `ENTITLEMENT_FEATURE_KEYS`, `EntitlementQuotaKey`, `EntitlementFeatureKey` (`packages/platform-contracts/src/entitlements.ts:10-18`).
- Produces: тестовый набор `{ license: { origin: "https://license.test.invalid", keys: [{ kid: "test-lic-1", jwk }], retiredKids: [] }, update: { keys: [{ kid: "test-upd-1", jwk }], retiredKids: [] } }`; подписанные файлы и `expectations.json` (`[{ file, as: "license"|"update", result: "ok"|"malformed"|"unknown_key"|"bad_signature" }]`) для задач 6–7, ЛЦ-0 и ЛЦ-2; хост фикстур `3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f` (как `proto/fixtures/hello.json`), ИНН `7707083893`, другой ИНН `7707654321`; переэкспорт констант, схем и типов из `@markiro/platform-contracts` (Д9).

Содержимое файлов (все подписаны `test-lic-1`, кроме оговорённых): `license-subscription.jws` — подписка, `sequence` 1, с 2026-10-20 по 2027-10-20, 14 льготных дней, квоты `lines 2, stations 5, kiosks 0, cabinetUsers 3`; `license-demo.jws` — `plan: "demo"`, 14 дней, `graceDays: 0`; `license-upgrade.jws` — `sequence` 2 с 2026-11-19, `stations: 8`, `replaces` = номер подписки; `license-older.jws` — `sequence` 1 с другим `licenseId`; `license-other-host.jws` — `hostId` `9e8d7c6b-5a49-4382-9716-05f4e3d2c1b0`; `license-other-inn.jws` — ИНН `7707654321`; `license-tampered.jws` — заголовок и подпись подписки над нагрузкой со `stations: 50`; `license-unknown-kid.jws` — подписан ключом лицензий под `kid` `test-lic-unknown`; `update-manifest.jws` — манифест 0.3.0, подписан `test-upd-1`.

- [ ] **Step 1: Написать падающие тесты**

Создать `packages/domain/test/standalone-license-fixtures.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import activation from "../fixtures/standalone-license/activation-request.json" with { type: "json" };
import expectations from "../fixtures/standalone-license/expectations.json" with { type: "json" };
import keyset from "../fixtures/standalone-license/test-keyset.json" with { type: "json" };
import { isValidInn } from "../src/inn.js";
import {
  standaloneActivationRequestSchema,
  verifyStandaloneLicense,
  verifyStandaloneUpdateManifest,
} from "../src/standalone-license/index.js";

const HOST_ID = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const DAY = 86_400_000;

/** A signed fixture without the line end the generator writes. */
function signed(name: string): string {
  return readFileSync(
    new URL(`../fixtures/standalone-license/${name}`, import.meta.url),
    "utf8",
  ).trim();
}

async function outcome(file: string, as: string): Promise<string> {
  const result =
    as === "license"
      ? await verifyStandaloneLicense(signed(file), keyset.license)
      : await verifyStandaloneUpdateManifest(signed(file), keyset.update);
  return result.ok ? "ok" : result.reason;
}

async function license(file: string) {
  const result = await verifyStandaloneLicense(signed(file), keyset.license);
  if (!result.ok) throw new Error(`${file}: ${result.reason}`);
  return result.license;
}

describe("the signed standalone fixtures (shared with markiro_proto::trust)", () => {
  it.each(expectations)("$file as $as: $result", async ({ file, as, result }) => {
    expect(await outcome(file, as)).toBe(result);
  });

  it("hold a subscription, a demo, its upgrade and the files the host must refuse", async () => {
    const subscription = await license("license-subscription.jws");
    expect(subscription).toMatchObject({
      hostId: HOST_ID,
      sequence: 1,
      plan: "subscription",
      graceDays: 14,
      replaces: null,
      customer: { inn: "7707083893" },
    });
    expect(isValidInn(subscription.customer.inn)).toBe(true);
    const demo = await license("license-demo.jws");
    expect(demo).toMatchObject({
      plan: "demo",
      graceDays: 0,
      validUntil: demo.validFrom + 14 * DAY,
    });
    const upgrade = await license("license-upgrade.jws");
    expect(upgrade).toMatchObject({
      sequence: 2,
      replaces: subscription.licenseId,
      quotas: { ...subscription.quotas, stations: 8 },
    });
    const older = await license("license-older.jws");
    expect(older.sequence).toBe(1);
    expect(older.licenseId).not.toBe(subscription.licenseId);
    expect((await license("license-other-host.jws")).hostId).not.toBe(HOST_ID);
    const otherInn = (await license("license-other-inn.jws")).customer.inn;
    expect(otherInn).not.toBe(subscription.customer.inn);
    expect(isValidInn(otherInn)).toBe(true);
  });

  it("name their keys test-… and publish no private part", () => {
    for (const key of [...keyset.license.keys, ...keyset.update.keys]) {
      expect(key.kid.startsWith("test-")).toBe(true);
      expect(Object.keys(key.jwk).sort()).toEqual(["crv", "kty", "x", "y"]);
    }
    expect(keyset.license.origin).toBe("https://license.test.invalid");
  });

  it("hold an activation request the schema reads as it is", () => {
    expect(standaloneActivationRequestSchema.parse(activation)).toEqual(activation);
    expect(activation.hostId).toBe(HOST_ID);
  });
});
```

Создать `packages/platform-contracts/test/standalone-license.test.ts`:

```ts
import { describe, expect, expectTypeOf, it } from "vitest";

import activation from "../../domain/fixtures/standalone-license/activation-request.json" with { type: "json" };
import * as c from "../src/index.js";

describe("standalone license contracts", () => {
  it("name exactly the cloud's quota and feature keys, in their order", () => {
    expect(c.STANDALONE_QUOTA_KEYS).toEqual(c.ENTITLEMENT_QUOTA_KEYS);
    expect(c.STANDALONE_FEATURE_KEYS).toEqual(c.ENTITLEMENT_FEATURE_KEYS);
    expectTypeOf<c.StandaloneQuotaKey>().toEqualTypeOf<c.EntitlementQuotaKey>();
    expectTypeOf<c.StandaloneFeatureKey>().toEqualTypeOf<c.EntitlementFeatureKey>();
  });

  it("read the host's activation request and keep the documents' typ apart", () => {
    expect(c.standaloneActivationRequestSchema.parse(activation)).toEqual(activation);
    expect(c.STANDALONE_LICENSE_TYP).not.toBe(c.STANDALONE_UPDATE_TYP);
    expect(c.standaloneLicensePayloadV1Schema.safeParse({}).success).toBe(false);
    expect(c.standaloneUpdateManifestV1Schema.safeParse({}).success).toBe(false);
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain exec vitest run test/standalone-license-fixtures.test.ts
pnpm --config.verifyDepsBeforeRun=false exec turbo run build --filter=@markiro/domain
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/platform-contracts exec vitest run test/standalone-license.test.ts
```

Ожидается: оба FAIL — нет файлов фикстур (`activation-request.json`, `expectations.json`, `test-keyset.json`), в контрактах нет `STANDALONE_*`.

- [ ] **Step 3: Генератор и фикстуры**

Создать `packages/domain/scripts/generate-standalone-fixtures.mjs`:

```js
// Writes the TEST-ONLY fixtures of the standalone license and update manifest
// (spec 2026-10-13 §12.1, plan ЛЦ-1): the keys on the first run, then every
// signed file, the activation request and the expected outcomes that
// `test/standalone-license-fixtures.test.ts` and the Rust
// `apps/standalone/proto/tests/trust.rs` both check.
//
// Never run in CI: ECDSA signatures are randomized, so every run rewrites the
// .jws files; the suites verify them and never compare their bytes. The keys
// are kept once made (delete test-private-keys.json to make new ones, then
// rerun). Run from the repository root:
//   node packages/domain/scripts/generate-standalone-fixtures.mjs
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("../fixtures/standalone-license/", import.meta.url));
const keysFile = `${directory}test-private-keys.json`;
const ORIGIN = "https://license.test.invalid";
const HOST_ID = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const LICENSE_TYP = "markiro-standalone-license+jws";
const UPDATE_TYP = "markiro-standalone-update+jws";
const DAY = 86_400_000;

mkdirSync(directory, { recursive: true });
const newPrivateJwk = () =>
  generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" });
const keys = existsSync(keysFile)
  ? JSON.parse(readFileSync(keysFile, "utf8"))
  : {
      warning:
        "TEST ONLY. Public test keys of the standalone license and update fixtures. Never trust them in a release or sign anything real with them.",
      license: { kid: "test-lic-1", privateJwk: newPrivateJwk() },
      update: { kid: "test-upd-1", privateJwk: newPrivateJwk() },
    };
const privateKey = (role) => createPrivateKey({ key: keys[role].privateJwk, format: "jwk" });
const publicJwk = (role) => {
  const { kty, crv, x, y } = createPublicKey(privateKey(role)).export({ format: "jwk" });
  return { kty, crv, x, y };
};
const keyset = {
  license: {
    origin: ORIGIN,
    keys: [{ kid: keys.license.kid, jwk: publicJwk("license") }],
    retiredKids: [],
  },
  update: { keys: [{ kid: keys.update.kid, jwk: publicJwk("update") }], retiredKids: [] },
};

const b64 = (text) => Buffer.from(text).toString("base64url");
function jws(typ, role, payload, kid = keys[role].kid) {
  const input = `${b64(JSON.stringify({ typ, alg: "ES256", kid }))}.${b64(JSON.stringify(payload))}`;
  const signature = sign("sha256", Buffer.from(input), {
    key: privateKey(role),
    dsaEncoding: "ieee-p1363",
  });
  return `${input}.${signature.toString("base64url")}`;
}

const ISSUED = Date.UTC(2026, 9, 20); // 2026-10-20
const subscription = {
  version: 1,
  licenseId: "7a1e5c2b-3d4f-4a6b-8c9d-0e1f2a3b4c5d",
  sequence: 1,
  issuer: ORIGIN,
  tenantId: "1b2c3d4e-5f60-4718-9a2b-3c4d5e6f7a8b",
  siteId: "2c3d4e5f-6071-4829-8b3c-4d5e6f7a8b9c",
  hostId: HOST_ID,
  customer: { name: "ООО «Тестовая площадка»", inn: "7707083893" },
  plan: "subscription",
  planVersionId: "4e5f6071-8293-4a4b-9c5d-6e7f8091a2b3",
  entitlementRevision: "12",
  issuedAt: ISSUED,
  validFrom: ISSUED,
  validUntil: Date.UTC(2027, 9, 20),
  graceDays: 14,
  quotas: { lines: 2, stations: 5, kiosks: 0, cabinetUsers: 3 },
  features: {
    labelEditor: true,
    publicApi: false,
    pallets: true,
    chzIntegration: true,
    inventory: false,
    commerceMl: false,
    handheld: true,
  },
  replaces: null,
};
const UPGRADED = Date.UTC(2026, 10, 19); // 2026-11-19
const licenses = {
  "license-subscription.jws": subscription,
  "license-demo.jws": {
    ...subscription,
    licenseId: "5b6c7d8e-9f01-4a2b-8c3d-4e5f60718293",
    plan: "demo",
    validUntil: ISSUED + 14 * DAY,
    graceDays: 0,
  },
  "license-upgrade.jws": {
    ...subscription,
    licenseId: "6c7d8e9f-0a1b-4c2d-9e3f-5061728394a5",
    sequence: 2,
    entitlementRevision: "13",
    issuedAt: UPGRADED,
    validFrom: UPGRADED,
    quotas: { ...subscription.quotas, stations: 8 },
    replaces: subscription.licenseId,
  },
  "license-older.jws": { ...subscription, licenseId: "8d9eaf01-2b3c-4d4e-a5f6-0718293a4b5c" },
  "license-other-host.jws": {
    ...subscription,
    licenseId: "9eaf0112-3c4d-4e5f-b607-18293a4b5c6d",
    hostId: "9e8d7c6b-5a49-4382-9716-05f4e3d2c1b0",
  },
  "license-other-inn.jws": {
    ...subscription,
    licenseId: "af011223-4d5e-4f60-8718-293a4b5c6d7e",
    customer: { ...subscription.customer, inn: "7707654321" },
  },
};
const files = Object.fromEntries(
  Object.entries(licenses).map(([name, payload]) => [name, jws(LICENSE_TYP, "license", payload)]),
);
// The subscription's header and signature over a payload with more stations.
const [header, , signature] = files["license-subscription.jws"].split(".");
const raised = { ...subscription, quotas: { ...subscription.quotas, stations: 50 } };
files["license-tampered.jws"] = `${header}.${b64(JSON.stringify(raised))}.${signature}`;
files["license-unknown-kid.jws"] = jws(LICENSE_TYP, "license", subscription, "test-lic-unknown");
files["update-manifest.jws"] = jws(UPDATE_TYP, "update", {
  v: 1,
  product: "markiro-standalone",
  version: "0.3.0",
  channel: "stable",
  releasedAt: "2026-11-02T10:00:00Z",
  sourceSha: "0123456789abcdef0123456789abcdef01234567",
  installer: {
    name: "markiro-standalone-0.3.0-windows-x86_64-setup.exe",
    sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    sizeBytes: 61234567,
  },
  protocol: 4,
  minProtocol: 2,
  minUpgradeFrom: "0.2.0",
  notes: ["Лицензия площадки и страница «Информация»", "Обновление из файла"],
});
const activation = {
  format: "markiro-activation-request-v1",
  hostId: HOST_ID,
  hostFingerprint: "9b2c4d6e8f0a1b3c5d7e9f1a2b4c6d8e0f1a3b5c7d9e1f2a4b6c8d0e2f4a6b8c",
  hostVersion: "0.3.0",
  organization: { name: "ООО «Тестовая площадка»", inn: "7707083893" },
  trial: { startedAt: "2026-10-20T09:00:00Z", inn: "7707083893" },
  currentLicense: { licenseId: subscription.licenseId, sequence: 1 },
  usage: { stations: 4, cabinetUsers: 2, lines: 2 },
  createdAt: "2026-10-21T09:00:00Z",
};
const expectations = [
  ...Object.keys(licenses).map((file) => ({ file, as: "license", result: "ok" })),
  { file: "license-tampered.jws", as: "license", result: "bad_signature" },
  { file: "license-unknown-kid.jws", as: "license", result: "unknown_key" },
  { file: "update-manifest.jws", as: "update", result: "ok" },
  { file: "update-manifest.jws", as: "license", result: "malformed" },
  { file: "license-subscription.jws", as: "update", result: "malformed" },
];

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
writeFileSync(keysFile, json(keys));
writeFileSync(`${directory}test-keyset.json`, json(keyset));
writeFileSync(`${directory}activation-request.json`, json(activation));
writeFileSync(`${directory}expectations.json`, json(expectations));
for (const [name, compact] of Object.entries(files))
  writeFileSync(`${directory}${name}`, `${compact}\n`);
console.log(`wrote ${Object.keys(files).length} signed files and 4 JSON files to ${directory}`);
```

Запустить один раз и отформатировать его JSON:

```bash
node packages/domain/scripts/generate-standalone-fixtures.mjs
node_modules/.bin/prettier --ignore-path .prettierignore --write packages/domain/fixtures/standalone-license/test-private-keys.json packages/domain/fixtures/standalone-license/test-keyset.json packages/domain/fixtures/standalone-license/activation-request.json packages/domain/fixtures/standalone-license/expectations.json
```

Ожидается: `wrote 9 signed files and 4 JSON files to …/packages/domain/fixtures/standalone-license/`. `activation-request.json` должен совпасть с базой `activation` в `schema-cases.json` (проверка: `node -e 'const a=require("./packages/domain/fixtures/standalone-license/activation-request.json");const b=require("./packages/domain/fixtures/standalone-license/schema-cases.json").activation.base;process.exit(JSON.stringify(a)===JSON.stringify(b)?0:1)'` — код 0). Текст `test-private-keys.json` в чат и в отчёт не выводить: это тестовый ключ, но привычка — та же, что с настоящими.

Создать `packages/platform-contracts/src/standalone-license.ts`:

```ts
/** The standalone license contracts live in `@markiro/domain`, as the offline grants' (plan ЛЦ-1). */
export {
  STANDALONE_FEATURE_KEYS,
  STANDALONE_LICENSE_MAX_BYTES,
  STANDALONE_LICENSE_TYP,
  STANDALONE_QUOTA_KEYS,
  STANDALONE_UPDATE_MANIFEST_MAX_BYTES,
  STANDALONE_UPDATE_TYP,
  standaloneActivationRequestSchema,
  standaloneLicenseFeaturesSchema,
  standaloneLicensePayloadV1Schema,
  standaloneLicenseQuotasSchema,
  standaloneUpdateManifestV1Schema,
} from "@markiro/domain";
export type {
  StandaloneActivationRequest,
  StandaloneFeatureKey,
  StandaloneLicensePayloadV1,
  StandaloneQuotaKey,
  StandaloneUpdateManifestV1,
} from "@markiro/domain";
```

Правка `packages/platform-contracts/src/index.ts` — фрагмент:

```ts
export * from "./offline-grants.js";
```

заменить на:

```ts
export * from "./offline-grants.js";
export * from "./standalone-license.js";
```

- [ ] **Step 4: Убедиться, что тесты проходят**

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain exec vitest run test/standalone-license-fixtures.test.ts test/standalone-license.test.ts
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/platform-contracts exec vitest run test/standalone-license.test.ts test/entitlements.test.ts
```

Ожидается: PASS — 11 исходов `expectations.json` и три теста фикстур; контракты — оба файла.

- [ ] **Step 5: Мутации**

- M1: в `contracts.ts` домена поменять местами `"inventory"` и `"commerceMl"` в `STANDALONE_FEATURE_KEYS`, собрать домен → FAIL контракты «name exactly the cloud's quota and feature keys…» и домен «name the cloud's quota and feature keys, and only those».
- M2: в `packages/domain/fixtures/standalone-license/expectations.json` заменить исход `license-tampered.jws` на `"ok"` → FAIL «license-tampered.jws as license: ok» (вернуть из копии).

- [ ] **Step 6: Гейты**

```bash
node_modules/.bin/prettier --ignore-path .prettierignore --check packages/domain/scripts/generate-standalone-fixtures.mjs packages/domain/test/standalone-license-fixtures.test.ts packages/domain/fixtures/standalone-license/*.json packages/platform-contracts/src/standalone-license.ts packages/platform-contracts/src/index.ts packages/platform-contracts/test/standalone-license.test.ts
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain run lint
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/platform-contracts run typecheck
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/platform-contracts run lint
git diff --check
```

- [ ] **Step 7: Коммит**

```bash
git add packages/domain/scripts/generate-standalone-fixtures.mjs packages/domain/test/standalone-license-fixtures.test.ts packages/domain/fixtures/standalone-license/test-private-keys.json packages/domain/fixtures/standalone-license/test-keyset.json packages/domain/fixtures/standalone-license/activation-request.json packages/domain/fixtures/standalone-license/expectations.json packages/domain/fixtures/standalone-license/license-subscription.jws packages/domain/fixtures/standalone-license/license-demo.jws packages/domain/fixtures/standalone-license/license-upgrade.jws packages/domain/fixtures/standalone-license/license-older.jws packages/domain/fixtures/standalone-license/license-other-host.jws packages/domain/fixtures/standalone-license/license-other-inn.jws packages/domain/fixtures/standalone-license/license-tampered.jws packages/domain/fixtures/standalone-license/license-unknown-kid.jws packages/domain/fixtures/standalone-license/update-manifest.jws packages/platform-contracts/src/standalone-license.ts packages/platform-contracts/src/index.ts packages/platform-contracts/test/standalone-license.test.ts
git commit -F /tmp/claude/msg-lc1-5.txt
```

Сообщение: `test(domain): signed standalone license fixtures made with a test key, their expected outcomes, and the contracts' re-export` + пустая строка + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 6: `markiro_proto::trust` — наборы ключей и проверка компактного JWS на Rust

**Files:**

- Create: `apps/standalone/proto/src/trust.rs`, `apps/standalone/proto/fixtures/trust-keys.json`, `apps/standalone/proto/tests/trust.rs`
- Modify: `apps/standalone/proto/Cargo.toml`, `apps/standalone/proto/src/lib.rs`, `apps/standalone/Cargo.lock`

**Interfaces:**

- Consumes: `packages/domain/fixtures/standalone-license/{test-keyset.json,test-private-keys.json,*.jws}` (задача 5); `aws-lc-rs` 1.18.1 и `base64` 0.22.1 (пины хоста, уже в `Cargo.lock`).
- Produces: `markiro_proto::trust::{LICENSE_TYP, UPDATE_TYP, TrustError, DocumentKind, TrustedKey, Keyset, Keysets, Verified, parse_keysets, verify_compact, license_keyset, update_keyset}`; фича `test-keys`; `fixtures/trust-keys.json` (производственные наборы, пока пустые).

- [ ] **Step 1: Зависимости, пустые наборы и падающий тест**

Заменить `apps/standalone/proto/Cargo.toml` целиком:

```toml
[package]
name = "markiro-proto"
version = "0.1.0"
description = "Wire contract between the Markiro standalone host and its devices"
edition = "2021"
license-file = "../../../LICENSE"
publish = false

[dependencies]
aws-lc-rs = "=1.18.1"
base64 = "=0.22.1"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sha2 = "0.10"

[features]
# The test keys of packages/domain/fixtures/standalone-license join the
# built-in keysets (`trust::license_keyset`, `trust::update_keyset`). Only the
# host's dev-dependency enables it: a release build never trusts them.
test-keys = []
```

Создать `apps/standalone/proto/fixtures/trust-keys.json` (открытые ключи производства добавляет шаг владельца, задача 10):

<!-- prettier-ignore -->
```json
{
  "license": { "origin": null, "keys": [], "retiredKids": [] },
  "update": { "keys": [], "retiredKids": [] }
}
```

Правка `apps/standalone/proto/src/lib.rs` — фрагмент:

```rust
pub mod backup;
pub mod cloud_import;
pub mod pairing;
```

заменить на:

```rust
pub mod backup;
pub mod cloud_import;
pub mod pairing;
pub mod trust;
```

Создать `apps/standalone/proto/tests/trust.rs`:

```rust
//! `markiro_proto::trust` against the signed fixtures it shares with
//! `@markiro/domain` (`packages/domain/fixtures/standalone-license/`, made by
//! `packages/domain/scripts/generate-standalone-fixtures.mjs` with the test
//! keys): both sides must give every file and every payload case the same
//! answer.

use aws_lc_rs::rand::SystemRandom;
use aws_lc_rs::signature::{EcdsaKeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use markiro_proto::trust::{
    parse_keysets, verify_compact, DocumentKind, Keyset, Keysets, TrustError, LICENSE_TYP,
    UPDATE_TYP,
};
use serde_json::{json, Value};

const HOST_ID: &str = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

fn domain_fixture(name: &str) -> String {
    let path = format!(
        "{}/../../../packages/domain/fixtures/standalone-license/{name}",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("read {path}: {error}"))
}

/// A signed fixture without the line end the generator writes.
fn signed(name: &str) -> String {
    domain_fixture(name).trim().to_owned()
}

fn test_keysets() -> Keysets {
    parse_keysets(&domain_fixture("test-keyset.json")).unwrap()
}

/// The `role` ("license" or "update") test key, to sign what no fixture holds.
fn signer(role: &str) -> (String, EcdsaKeyPair) {
    let keys: Value = serde_json::from_str(&domain_fixture("test-private-keys.json")).unwrap();
    let jwk = &keys[role]["privateJwk"];
    let part = |name: &str| URL_SAFE_NO_PAD.decode(jwk[name].as_str().unwrap()).unwrap();
    let mut point = vec![0x04];
    point.extend(part("x"));
    point.extend(part("y"));
    let pair = EcdsaKeyPair::from_private_key_and_public_key(
        &ECDSA_P256_SHA256_FIXED_SIGNING,
        &part("d"),
        &point,
    )
    .unwrap();
    (keys[role]["kid"].as_str().unwrap().to_owned(), pair)
}

fn sign_raw(pair: &EcdsaKeyPair, header: &[u8], payload: &[u8]) -> String {
    let input = format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(header),
        URL_SAFE_NO_PAD.encode(payload)
    );
    let signature = pair.sign(&SystemRandom::new(), input.as_bytes()).unwrap();
    format!("{input}.{}", URL_SAFE_NO_PAD.encode(signature.as_ref()))
}

fn header(typ: &str, kid: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({ "typ": typ, "alg": "ES256", "kid": kid })).unwrap()
}

/// The segments of a fixture, the signature decoded.
fn split(compact: &str) -> (String, String, Vec<u8>) {
    let parts: Vec<&str> = compact.split('.').collect();
    (
        parts[0].to_owned(),
        parts[1].to_owned(),
        URL_SAFE_NO_PAD.decode(parts[2]).unwrap(),
    )
}

#[test]
fn a_fixture_license_verifies_under_its_typ_and_kid() {
    let keysets = test_keysets();
    let verified = verify_compact(
        &signed("license-subscription.jws"),
        LICENSE_TYP,
        &keysets.license,
    )
    .unwrap();
    assert_eq!(verified.kid, "test-lic-1");
    let payload: Value = serde_json::from_slice(&verified.payload).unwrap();
    assert_eq!(payload["hostId"], HOST_ID);
    let manifest =
        verify_compact(&signed("update-manifest.jws"), UPDATE_TYP, &keysets.update).unwrap();
    assert_eq!(manifest.kid, "test-upd-1");
}

#[test]
fn a_changed_payload_a_foreign_signature_or_a_short_one_is_a_bad_signature() {
    let keysets = test_keysets();
    let check = |compact: &str| verify_compact(compact, LICENSE_TYP, &keysets.license);
    assert_eq!(
        check(&signed("license-tampered.jws")),
        Err(TrustError::BadSignature)
    );
    // The release key's signature under the license kid.
    let (_, update_key) = signer("update");
    let (_, payload, _) = split(&signed("license-subscription.jws"));
    let foreign = sign_raw(
        &update_key,
        &header(LICENSE_TYP, "test-lic-1"),
        &URL_SAFE_NO_PAD.decode(payload).unwrap(),
    );
    assert_eq!(check(&foreign), Err(TrustError::BadSignature));
    let (head, body, signature) = split(&signed("license-subscription.jws"));
    let short = format!("{head}.{body}.{}", URL_SAFE_NO_PAD.encode(&signature[..63]));
    assert_eq!(check(&short), Err(TrustError::BadSignature));
}

#[test]
fn an_unknown_retired_or_ambiguous_kid_is_an_unknown_key() {
    let keysets = test_keysets();
    let compact = signed("license-subscription.jws");
    assert_eq!(
        verify_compact(
            &signed("license-unknown-kid.jws"),
            LICENSE_TYP,
            &keysets.license
        ),
        Err(TrustError::UnknownKey)
    );
    let retired = Keyset {
        retired_kids: vec!["test-lic-1".to_owned()],
        ..keysets.license.clone()
    };
    assert_eq!(
        verify_compact(&compact, LICENSE_TYP, &retired),
        Err(TrustError::UnknownKey)
    );
    let key = keysets.license.keys[0].clone();
    let twice = Keyset {
        keys: vec![key.clone(), key],
        ..keysets.license.clone()
    };
    assert_eq!(
        verify_compact(&compact, LICENSE_TYP, &twice),
        Err(TrustError::UnknownKey)
    );
    // The right signature under the other keyset's keys.
    assert_eq!(
        verify_compact(&compact, LICENSE_TYP, &keysets.update),
        Err(TrustError::UnknownKey)
    );
}

#[test]
fn the_typ_keeps_a_license_and_an_update_manifest_apart() {
    let keysets = test_keysets();
    assert_eq!(
        verify_compact(&signed("update-manifest.jws"), LICENSE_TYP, &keysets.update),
        Err(TrustError::Malformed)
    );
    assert_eq!(
        verify_compact(
            &signed("license-subscription.jws"),
            UPDATE_TYP,
            &keysets.license
        ),
        Err(TrustError::Malformed)
    );
}

#[test]
fn a_header_other_than_typ_alg_kid_is_malformed_even_when_signed() {
    let keysets = test_keysets();
    let (kid, key) = signer("license");
    let payload = br#"{"any":"payload"}"#;
    for header in [
        json!({ "typ": LICENSE_TYP, "alg": "ES256", "kid": kid, "cty": "json" }),
        json!({ "typ": LICENSE_TYP, "alg": "ES384", "kid": kid }),
        json!({ "typ": LICENSE_TYP, "alg": "ES256" }),
        json!({ "typ": LICENSE_TYP, "alg": "ES256", "kid": "" }),
        json!({ "typ": LICENSE_TYP, "alg": "ES256", "kid": "k".repeat(129) }),
        json!([LICENSE_TYP, "ES256", kid]),
    ] {
        let compact = sign_raw(&key, &serde_json::to_vec(&header).unwrap(), payload);
        assert_eq!(
            verify_compact(&compact, LICENSE_TYP, &keysets.license),
            Err(TrustError::Malformed),
            "{header}"
        );
    }
    let bom = sign_raw(
        &key,
        &[b"\xEF\xBB\xBF".as_slice(), &header(LICENSE_TYP, &kid)].concat(),
        payload,
    );
    assert_eq!(
        verify_compact(&bom, LICENSE_TYP, &keysets.license),
        Err(TrustError::Malformed)
    );
    // The same payload under the plain header verifies: the header alone failed.
    let plain = sign_raw(&key, &header(LICENSE_TYP, &kid), payload);
    assert!(verify_compact(&plain, LICENSE_TYP, &keysets.license).is_ok());
}

#[test]
fn non_canonical_base64url_and_wrong_segment_counts_are_malformed() {
    let keysets = test_keysets();
    let compact = signed("license-subscription.jws");
    let alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let last = compact.chars().last().unwrap();
    let bumped = alphabet
        .chars()
        .nth(alphabet.find(last).unwrap() + 1)
        .unwrap();
    let (head, body, _) = split(&compact);
    let signature = compact.rsplit('.').next().unwrap();
    for broken in [
        format!("{}{bumped}", &compact[..compact.len() - 1]),
        format!("{compact}="),
        format!("{head}.{body}"),
        format!("{compact}.{signature}"),
        format!("{head}..{signature}"),
        format!(
            "{head}.{body}.{}",
            signature.replace('-', "+").replace('_', "/")
        ),
        format!(" {compact}"),
        String::new(),
    ] {
        assert_eq!(
            verify_compact(&broken, LICENSE_TYP, &keysets.license),
            Err(TrustError::Malformed),
            "{broken}"
        );
    }
}

#[test]
fn the_refusal_codes_name_the_document() {
    let codes: Vec<&str> = [
        TrustError::Malformed,
        TrustError::UnknownKey,
        TrustError::BadSignature,
    ]
    .iter()
    .flat_map(|error| {
        [
            error.code(DocumentKind::License),
            error.code(DocumentKind::Update),
        ]
    })
    .collect();
    assert_eq!(
        codes,
        [
            "license_malformed",
            "update_malformed",
            "license_unknown_key",
            "update_unknown_key",
            "license_signature",
            "update_signature"
        ]
    );
    assert_eq!(TrustError::BadSignature.reason(), "bad_signature");
}

#[test]
fn a_keyset_document_takes_public_p256_keys_alone() {
    let real: Value = serde_json::from_str(&domain_fixture("test-keyset.json")).unwrap();
    let jwk = real["license"]["keys"][0]["jwk"].clone();
    let zero = URL_SAFE_NO_PAD.encode([0u8; 32]);
    let document = |license: Value, update: Value| json!({ "license": license, "update": update });
    let license = |keys: Value| json!({ "origin": "https://license.test.invalid", "keys": keys, "retiredKids": [] });
    let empty_update = json!({ "keys": [], "retiredKids": [] });
    let mut private = jwk.clone();
    private["d"] = json!(URL_SAFE_NO_PAD.encode([7u8; 32]));
    let mut p384 = jwk.clone();
    p384["crv"] = json!("P-384");
    let mut encrypting = jwk.clone();
    encrypting["use"] = json!("enc");
    let mut short = jwk.clone();
    short["x"] = json!(URL_SAFE_NO_PAD.encode([1u8; 31]));
    let off_curve = json!({ "kty": "EC", "crv": "P-256", "x": zero, "y": zero });
    for (name, text) in [
        (
            "private key",
            document(
                license(json!([{ "kid": "a", "jwk": private }])),
                empty_update.clone(),
            ),
        ),
        (
            "P-384",
            document(
                license(json!([{ "kid": "a", "jwk": p384 }])),
                empty_update.clone(),
            ),
        ),
        (
            "encryption key",
            document(
                license(json!([{ "kid": "a", "jwk": encrypting }])),
                empty_update.clone(),
            ),
        ),
        (
            "31-byte x",
            document(
                license(json!([{ "kid": "a", "jwk": short }])),
                empty_update.clone(),
            ),
        ),
        (
            "off the curve",
            document(
                license(json!([{ "kid": "a", "jwk": off_curve }])),
                empty_update.clone(),
            ),
        ),
        (
            "kid twice",
            document(
                license(json!([{ "kid": "a", "jwk": jwk }, { "kid": "a", "jwk": jwk }])),
                empty_update.clone(),
            ),
        ),
        (
            "empty kid",
            document(
                license(json!([{ "kid": "", "jwk": jwk }])),
                empty_update.clone(),
            ),
        ),
        (
            "keys without origin",
            document(
                json!({ "origin": null, "keys": [{ "kid": "a", "jwk": jwk }], "retiredKids": [] }),
                empty_update.clone(),
            ),
        ),
        (
            "release origin",
            document(
                license(json!([])),
                json!({ "origin": "https://x.invalid", "keys": [], "retiredKids": [] }),
            ),
        ),
        (
            "unknown field",
            json!({ "license": license(json!([])), "update": empty_update, "comment": "x" }),
        ),
    ] {
        assert!(parse_keysets(&text.to_string()).is_err(), "{name}");
    }
    let fine = document(license(json!([{ "kid": "a", "jwk": jwk }])), empty_update);
    let keysets = parse_keysets(&fine.to_string()).unwrap();
    assert_eq!(keysets.license.keys[0].public_key.len(), 65);
    assert_eq!(keysets.license.keys[0].public_key[0], 0x04);
}
```

- [ ] **Step 2: Обновить `Cargo.lock` офлайн и убедиться, что тест падает**

```bash
cargo metadata --offline --format-version 1 --manifest-path apps/standalone/Cargo.toml > /dev/null
git diff apps/standalone/Cargo.lock
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test trust
```

`cargo metadata` без `--locked` дописывает в блок `markiro-proto` две строки — `"aws-lc-rs",` и `"base64 0.22.1",`; иначе `git diff` пуст по остальным пакетам. Если офлайн разрешить нельзя (кэш реестра без этих версий) — остановиться: обновление `Cargo.lock` вне песочницы — шаг владельца (`cargo metadata --manifest-path apps/standalone/Cargo.toml` с сетью), затем продолжить. Ожидается от теста: FAIL компиляции — `unresolved import markiro_proto::trust` (файла `src/trust.rs` нет).

- [ ] **Step 3: Реализация**

Создать `apps/standalone/proto/src/trust.rs`:

```rust
//! Trust in signed documents (spec 2026-10-13 §4-5, plan ЛЦ-1): a compact
//! JWS with ES256 — `header.payload.signature`, the header exactly
//! `{"typ", "alg": "ES256", "kid"}`, the 64-byte IEEE P1363 signature over
//! the exact bytes `header.payload`, every segment canonical unpadded
//! base64url — checked against a keyset of public P-256 keys by `kid`.
//! `@markiro/domain` (`verifyCompactJws`, `verifyStandaloneLicense`) is the
//! TypeScript twin; the fixtures of `packages/domain/fixtures/standalone-license/`
//! hold both to the same answers (`tests/trust.rs`).
//!
//! The keysets a build trusts come from `fixtures/trust-keys.json` (public
//! keys only). The domain's test keys join them only under `cfg(test)` or the
//! `test-keys` feature, which only the host's dev-dependency enables: a
//! release build never trusts them (`markiro-host trust-keys`, checked in CI).

use std::sync::OnceLock;

use aws_lc_rs::signature::{ParsedPublicKey, UnparsedPublicKey, ECDSA_P256_SHA256_FIXED};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::Value;

/// `typ` of a license file's header.
pub const LICENSE_TYP: &str = "markiro-standalone-license+jws";
/// `typ` of an update manifest's header.
pub const UPDATE_TYP: &str = "markiro-standalone-update+jws";
/// The longest `kid`, in UTF-16 code units as the domain's Zod counts.
const MAX_KID_UNITS: usize = 128;

const PRODUCTION_KEYS: &str = include_str!("../fixtures/trust-keys.json");
#[cfg(any(test, feature = "test-keys"))]
const TEST_KEYS: &str =
    include_str!("../../../../packages/domain/fixtures/standalone-license/test-keyset.json");

/// Why a signed document is refused. The order of the checks is the
/// domain's: form, then `kid`, then signature, then the payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrustError {
    /// Size, segments, base64url, header, `typ`, payload or issuer.
    Malformed,
    /// The `kid` is not in the keyset once, or is retired.
    UnknownKey,
    /// The signature is not 64 bytes or does not verify.
    BadSignature,
}

/// What a refused document is, for its refusal code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocumentKind {
    License,
    Update,
}

impl TrustError {
    /// The reason the domain gives (`CompactJwsFailure`).
    pub const fn reason(self) -> &'static str {
        match self {
            Self::Malformed => "malformed",
            Self::UnknownKey => "unknown_key",
            Self::BadSignature => "bad_signature",
        }
    }

    /// The refusal code a caller reports for a document of `kind`: the
    /// license's are the host's validation reasons of spec §4.3.
    pub const fn code(self, kind: DocumentKind) -> &'static str {
        match (kind, self) {
            (DocumentKind::License, Self::Malformed) => "license_malformed",
            (DocumentKind::License, Self::UnknownKey) => "license_unknown_key",
            (DocumentKind::License, Self::BadSignature) => "license_signature",
            (DocumentKind::Update, Self::Malformed) => "update_malformed",
            (DocumentKind::Update, Self::UnknownKey) => "update_unknown_key",
            (DocumentKind::Update, Self::BadSignature) => "update_signature",
        }
    }
}

impl std::fmt::Display for TrustError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.reason())
    }
}

impl std::error::Error for TrustError {}

/// A public P-256 key: `public_key` is the SEC1 uncompressed point
/// (`04 || x || y`) of its JWK.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustedKey {
    pub kid: String,
    pub public_key: Vec<u8>,
}

/// Keys by `kid`; `origin` is the license issuer (`None` for the release
/// keyset, and for a license keyset without keys).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Keyset {
    pub origin: Option<String>,
    pub keys: Vec<TrustedKey>,
    pub retired_kids: Vec<String>,
}

/// A keyset document: the license keyset and the release keyset.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Keysets {
    pub license: Keyset,
    pub update: Keyset,
}

/// A verified document: its `kid` and the payload's bytes, unread.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verified {
    pub kid: String,
    pub payload: Vec<u8>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct KeysetsFile {
    license: KeysetFile,
    update: KeysetFile,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct KeysetFile {
    origin: Option<String>,
    keys: Vec<KeyFile>,
    retired_kids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct KeyFile {
    kid: String,
    jwk: PublicJwk,
}

/// A public JWK: a private one carries `d`, an unknown field here.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PublicJwk {
    kty: String,
    crv: String,
    x: String,
    y: String,
    alg: Option<String>,
    #[serde(rename = "use")]
    usage: Option<String>,
}

/// Reads a keyset document (`fixtures/trust-keys.json`, the domain's
/// `test-keyset.json`). Refused, with the reason: a private key (`d`), a key
/// that is not a P-256 signing key or not a point of the curve, an empty or
/// repeated `kid`, a license keyset with keys but no origin, a release
/// keyset with an origin.
pub fn parse_keysets(text: &str) -> Result<Keysets, String> {
    let file: KeysetsFile =
        serde_json::from_str(text).map_err(|error| format!("keyset document: {error}"))?;
    let license = keyset(file.license, "license")?;
    let update = keyset(file.update, "update")?;
    if !license.keys.is_empty() && license.origin.is_none() {
        return Err("license: keys need an origin".to_owned());
    }
    if update.origin.is_some() {
        return Err("update: a release keyset has no origin".to_owned());
    }
    Ok(Keysets { license, update })
}

fn keyset(file: KeysetFile, name: &str) -> Result<Keyset, String> {
    if file.origin.as_deref() == Some("") {
        return Err(format!("{name}: an empty origin"));
    }
    let mut keys: Vec<TrustedKey> = Vec::with_capacity(file.keys.len());
    for entry in file.keys {
        if entry.kid.is_empty() || entry.kid.encode_utf16().count() > MAX_KID_UNITS {
            return Err(format!("{name}: a kid is empty or too long"));
        }
        if keys.iter().any(|key| key.kid == entry.kid) {
            return Err(format!("{name}: kid {} twice", entry.kid));
        }
        let public_key = public_point(&entry.jwk)
            .map_err(|reason| format!("{name}: kid {}: {reason}", entry.kid))?;
        keys.push(TrustedKey {
            kid: entry.kid,
            public_key,
        });
    }
    Ok(Keyset {
        origin: file.origin,
        keys,
        retired_kids: file.retired_kids,
    })
}

fn public_point(jwk: &PublicJwk) -> Result<Vec<u8>, &'static str> {
    if jwk.kty != "EC" || jwk.crv != "P-256" {
        return Err("not a P-256 key");
    }
    if jwk.alg.as_deref().is_some_and(|alg| alg != "ES256")
        || jwk.usage.as_deref().is_some_and(|usage| usage != "sig")
    {
        return Err("not a signing key");
    }
    let x = decode_segment(&jwk.x).ok_or("x is not canonical base64url")?;
    let y = decode_segment(&jwk.y).ok_or("y is not canonical base64url")?;
    if x.len() != 32 || y.len() != 32 {
        return Err("a coordinate is not 32 bytes");
    }
    let mut point = Vec::with_capacity(65);
    point.push(0x04);
    point.extend_from_slice(&x);
    point.extend_from_slice(&y);
    ParsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, &point).map_err(|_| "not a point of P-256")?;
    Ok(point)
}

/// The bytes of a canonical unpadded base64url segment (the domain's
/// `decodeBase64UrlCanonical`): re-encoding them gives the same text.
fn decode_segment(segment: &str) -> Option<Vec<u8>> {
    if segment.is_empty()
        || !segment
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return None;
    }
    let bytes = URL_SAFE_NO_PAD.decode(segment).ok()?;
    (URL_SAFE_NO_PAD.encode(&bytes) == segment).then_some(bytes)
}

/// A JSON object of `bytes` as `T`, the way the domain's `JSON.parse` and
/// Zod read it. serde alone would also take a struct from a JSON array (its
/// fields in order), which Zod refuses: every pointer of `objects` must hold
/// an object, every pointer of `nullable` an object or `null`. Parsed
/// through a `Value`, a repeated key keeps its last value, as in JavaScript.
fn read_object<T: DeserializeOwned>(
    bytes: &[u8],
    objects: &[&str],
    nullable: &[&str],
) -> Result<T, TrustError> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| TrustError::Malformed)?;
    let shaped = objects
        .iter()
        .all(|pointer| value.pointer(pointer).is_some_and(Value::is_object))
        && nullable.iter().all(|pointer| {
            value
                .pointer(pointer)
                .map_or(true, |field| field.is_object() || field.is_null())
        });
    if !shaped {
        return Err(TrustError::Malformed);
    }
    serde_json::from_value(value).map_err(|_| TrustError::Malformed)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProtectedHeader {
    typ: String,
    alg: String,
    kid: String,
}

/// Checks a compact JWS of type `typ` against `keyset` (the domain's
/// `verifyCompactJws`): the payload comes back unread.
pub fn verify_compact(compact: &str, typ: &str, keyset: &Keyset) -> Result<Verified, TrustError> {
    let mut parts = compact.split('.');
    let (Some(encoded_header), Some(encoded_payload), Some(encoded_signature), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(TrustError::Malformed);
    };
    let header_bytes = decode_segment(encoded_header).ok_or(TrustError::Malformed)?;
    let header: ProtectedHeader = read_object(&header_bytes, &[""], &[])?;
    if header.typ != typ
        || header.alg != "ES256"
        || header.kid.is_empty()
        || header.kid.encode_utf16().count() > MAX_KID_UNITS
    {
        return Err(TrustError::Malformed);
    }
    let payload = decode_segment(encoded_payload).ok_or(TrustError::Malformed)?;
    let signature = decode_segment(encoded_signature).ok_or(TrustError::Malformed)?;
    if keyset.retired_kids.contains(&header.kid) {
        return Err(TrustError::UnknownKey);
    }
    // An ambiguous keyset fails closed rather than trusting the order.
    let mut named = keyset.keys.iter().filter(|key| key.kid == header.kid);
    let (Some(key), None) = (named.next(), named.next()) else {
        return Err(TrustError::UnknownKey);
    };
    if signature.len() != 64 {
        return Err(TrustError::BadSignature);
    }
    let signed = &compact.as_bytes()[..encoded_header.len() + 1 + encoded_payload.len()];
    UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, &key.public_key)
        .verify(signed, &signature)
        .map_err(|_| TrustError::BadSignature)?;
    Ok(Verified {
        kid: header.kid,
        payload,
    })
}

fn production_keysets() -> Keysets {
    parse_keysets(PRODUCTION_KEYS).expect("fixtures/trust-keys.json is a valid keyset document")
}

fn built_in() -> &'static Keysets {
    static KEYSETS: OnceLock<Keysets> = OnceLock::new();
    KEYSETS.get_or_init(|| {
        #[allow(unused_mut)]
        let mut keysets = production_keysets();
        #[cfg(any(test, feature = "test-keys"))]
        {
            let test = parse_keysets(TEST_KEYS).expect("the domain's test keyset is valid");
            keysets.license = with_test_keys(keysets.license, test.license);
            keysets.update = with_test_keys(keysets.update, test.update);
        }
        keysets
    })
}

/// The production keys and the test keys together. A keyset has one origin,
/// so a test build takes licenses of the test issuer alone.
#[cfg(any(test, feature = "test-keys"))]
fn with_test_keys(mut production: Keyset, test: Keyset) -> Keyset {
    for key in test.keys {
        assert!(
            !production.keys.iter().any(|known| known.kid == key.kid),
            "the test kid {} is a production kid",
            key.kid
        );
        production.keys.push(key);
    }
    production.retired_kids.extend(test.retired_kids);
    if test.origin.is_some() {
        production.origin = test.origin;
    }
    production
}

/// The license keyset this build trusts.
pub fn license_keyset() -> Keyset {
    built_in().license.clone()
}

/// The release keyset this build trusts.
pub fn update_keyset() -> Keyset {
    built_in().update.clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_production_keysets_are_public_keys_without_a_test_kid() {
        let production = production_keysets();
        for key in production
            .license
            .keys
            .iter()
            .chain(&production.update.keys)
        {
            assert!(!key.kid.starts_with("test-"), "{}", key.kid);
        }
        assert!(production.license.keys.is_empty() || production.license.origin.is_some());
        assert_eq!(production.update.origin, None);
    }

    #[test]
    fn a_test_build_trusts_the_test_keys_beside_the_production_ones() {
        let production = production_keysets();
        let license = license_keyset();
        let update = update_keyset();
        assert!(license.keys.iter().any(|key| key.kid == "test-lic-1"));
        assert!(update.keys.iter().any(|key| key.kid == "test-upd-1"));
        assert_eq!(
            license.origin.as_deref(),
            Some("https://license.test.invalid")
        );
        for key in &production.license.keys {
            assert!(license.keys.contains(key), "{}", key.kid);
        }
        for key in &production.update.keys {
            assert!(update.keys.contains(key), "{}", key.kid);
        }
    }
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test trust
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-proto --lib trust
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-proto
```

Ожидается: PASS — 8 тестов `tests/trust.rs`, 2 модульных (`the_production_keysets_are_public_keys_without_a_test_kid`, `a_test_build_trusts_the_test_keys_beside_the_production_ones`), прежние тесты `proto` без изменений. Сборка без предупреждений.

- [ ] **Step 5: Мутации**

- M1: убрать `if keyset.retired_kids.contains(&header.kid) { … }` → FAIL `an_unknown_retired_or_ambiguous_kid_is_an_unknown_key`.
- M2: `let (Some(key), None) = (named.next(), named.next())` → `let (Some(key), _) = …` → FAIL тот же тест (повтор `kid`).
- M3: убрать строку `ParsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, &point).map_err(|_| "not a point of P-256")?;` → FAIL `a_keyset_document_takes_public_p256_keys_alone` («off the curve»).
- M4: заменить `read_object(&header_bytes, &[""], &[])?` на `serde_json::from_slice(&header_bytes).map_err(|_| TrustError::Malformed)?` → FAIL `a_header_other_than_typ_alg_kid_is_malformed_even_when_signed` (заголовок-массив принят).
- Выживает по замыслу: снятие проверки `URL_SAFE_NO_PAD.encode(&bytes) == segment` — `base64` 0.22 сам отвергает ненулевые хвостовые биты и `=`; проверка оставлена как зеркало домена. Записать в «Отклонения», если поведение иное.

- [ ] **Step 6: Гейты**

```bash
node_modules/.bin/prettier --ignore-path .prettierignore --check apps/standalone/proto/fixtures/trust-keys.json
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
git diff --check
git diff --stat apps/standalone/Cargo.lock
```

`git diff apps/standalone/Cargo.lock` — только две строки в блоке `markiro-proto`.

- [ ] **Step 7: Коммит**

```bash
git add apps/standalone/proto/Cargo.toml apps/standalone/Cargo.lock apps/standalone/proto/src/lib.rs apps/standalone/proto/src/trust.rs apps/standalone/proto/fixtures/trust-keys.json apps/standalone/proto/tests/trust.rs
git commit -F /tmp/claude/msg-lc1-6.txt
```

Сообщение: `feat(standalone): markiro_proto::trust checks a compact JWS ES256 against built-in keysets, the test keys behind a feature` + пустая строка + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 7: Нагрузки на Rust — лицензия, манифест, запрос активации — и паритет с доменом

**Files:**

- Modify: `apps/standalone/proto/src/trust.rs`
- Test: `apps/standalone/proto/tests/trust.rs`

**Interfaces:**

- Consumes: `verify_compact`, `read_object`, `Keyset` (задача 6); `packages/domain/fixtures/standalone-license/{expectations.json,schema-cases.json,activation-request.json}`.
- Produces: `MAX_LICENSE_BYTES`, `MAX_UPDATE_MANIFEST_BYTES`, `ACTIVATION_REQUEST_FORMAT`, `LicensePayloadV1` (+ `LicenseCustomer`, `LicensePlan`, `LicenseQuotas`, `LicenseFeatures`), `UpdateManifestV1` (+ `UpdateChannel`, `UpdateInstaller`), `ActivationRequest` (+ `ActivationOrganization`, `ActivationTrial`, `ActivationLicense`, `ActivationUsage`), у каждого `from_json(&[u8]) -> Result<Self, TrustError>` и `is_valid(&self) -> bool`; `verify_license(compact, &Keyset) -> Result<(LicensePayloadV1, String), TrustError>`, `verify_update_manifest(compact, &Keyset) -> Result<(UpdateManifestV1, String), TrustError>`.

- [ ] **Step 1: Написать падающие тесты**

Правка `apps/standalone/proto/tests/trust.rs` — фрагмент:

```rust
use markiro_proto::trust::{
    parse_keysets, verify_compact, DocumentKind, Keyset, Keysets, TrustError, LICENSE_TYP,
    UPDATE_TYP,
};
```

заменить на:

```rust
use markiro_proto::trust::{
    parse_keysets, verify_compact, verify_license, verify_update_manifest, ActivationRequest,
    DocumentKind, Keyset, Keysets, LicensePayloadV1, LicensePlan, TrustError, UpdateChannel,
    UpdateManifestV1, LICENSE_TYP, MAX_LICENSE_BYTES, MAX_UPDATE_MANIFEST_BYTES, UPDATE_TYP,
};
```

В конец файла добавить:

```rust
/// The base of a schema case with its `set` and `remove` applied (dotted
/// paths, as `test/standalone-license.test.ts` applies them).
fn apply(base: &Value, case: &Value) -> Value {
    let mut value = base.clone();
    if let Some(set) = case.get("set").and_then(Value::as_object) {
        for (path, next) in set {
            let (target, key) = parent(&mut value, path);
            target.insert(key, next.clone());
        }
    }
    if let Some(remove) = case.get("remove").and_then(Value::as_array) {
        for path in remove {
            let path = path.as_str().unwrap();
            let (target, key) = parent(&mut value, path);
            assert!(target.remove(&key).is_some(), "nothing at {path}");
        }
    }
    value
}

fn parent<'a>(root: &'a mut Value, path: &str) -> (&'a mut serde_json::Map<String, Value>, String) {
    let mut parts: Vec<&str> = path.split('.').collect();
    let key = parts.pop().unwrap().to_owned();
    let mut target = root;
    for part in parts {
        target = target
            .get_mut(part)
            .unwrap_or_else(|| panic!("no object for {path}"));
    }
    (
        target
            .as_object_mut()
            .unwrap_or_else(|| panic!("no object for {path}")),
        key,
    )
}

fn license_fits(bytes: &[u8]) -> bool {
    LicensePayloadV1::from_json(bytes).is_ok()
}
fn manifest_fits(bytes: &[u8]) -> bool {
    UpdateManifestV1::from_json(bytes).is_ok()
}
fn activation_fits(bytes: &[u8]) -> bool {
    ActivationRequest::from_json(bytes).is_ok()
}

#[test]
fn the_payload_rules_answer_the_shared_cases_as_the_zod_schemas_do() {
    let cases: Value = serde_json::from_str(&domain_fixture("schema-cases.json")).unwrap();
    let mut checked = 0;
    for (group, fits) in [
        ("license", license_fits as fn(&[u8]) -> bool),
        ("manifest", manifest_fits),
        ("activation", activation_fits),
    ] {
        let base = &cases[group]["base"];
        for case in cases[group]["cases"].as_array().unwrap() {
            let bytes = serde_json::to_vec(&apply(base, case)).unwrap();
            assert_eq!(
                fits(&bytes),
                case["valid"].as_bool().unwrap(),
                "{group}: {}",
                case["name"]
            );
            checked += 1;
        }
    }
    assert!(checked >= 90, "{checked}");
}

#[test]
fn a_payload_that_is_an_array_or_no_utf8_json_is_refused() {
    let base: Value = serde_json::from_str(&domain_fixture("schema-cases.json")).unwrap();
    let license = &base["license"]["base"];
    let as_array = Value::Array(license.as_object().unwrap().values().cloned().collect());
    assert!(!license_fits(&serde_json::to_vec(&as_array).unwrap()));
    assert!(!license_fits(b"\xEF\xBB\xBF{}"));
    assert!(!license_fits(b"{\"version\":1,"));
    assert!(!license_fits(&[0xff, 0xfe]));
    // A repeated key keeps its last value, as JSON.parse does.
    let mut text = serde_json::to_string(license).unwrap();
    text.insert_str(1, "\"graceDays\":99,");
    assert!(license_fits(text.as_bytes()));
}

#[test]
fn the_signed_fixtures_verify_as_the_domain_says() {
    let keysets = test_keysets();
    let expectations: Vec<Value> =
        serde_json::from_str(&domain_fixture("expectations.json")).unwrap();
    assert!(expectations.len() >= 11);
    for expectation in &expectations {
        let file = expectation["file"].as_str().unwrap();
        let compact = signed(file);
        let outcome = match expectation["as"].as_str().unwrap() {
            "license" => verify_license(&compact, &keysets.license).map(|_| ()),
            "update" => verify_update_manifest(&compact, &keysets.update).map(|_| ()),
            other => panic!("{other}"),
        };
        assert_eq!(
            outcome.map_or_else(TrustError::reason, |()| "ok"),
            expectation["result"].as_str().unwrap(),
            "{file} as {}",
            expectation["as"]
        );
    }
}

#[test]
fn a_verified_license_carries_its_fields_and_kid() {
    let keysets = test_keysets();
    let (subscription, kid) =
        verify_license(&signed("license-subscription.jws"), &keysets.license).unwrap();
    assert_eq!(kid, "test-lic-1");
    assert_eq!(subscription.host_id, HOST_ID);
    assert_eq!(subscription.plan, LicensePlan::Subscription);
    assert_eq!(subscription.customer.inn, "7707083893");
    assert_eq!(subscription.quotas.stations, Some(5));
    assert!(subscription.features.handheld);
    assert_eq!(subscription.replaces, None);
    let (upgrade, _) = verify_license(&signed("license-upgrade.jws"), &keysets.license).unwrap();
    assert_eq!(upgrade.sequence, 2);
    assert_eq!(upgrade.quotas.stations, Some(8));
    assert_eq!(
        upgrade.replaces.as_deref(),
        Some(subscription.license_id.as_str())
    );
    let (demo, _) = verify_license(&signed("license-demo.jws"), &keysets.license).unwrap();
    assert_eq!((demo.plan, demo.grace_days), (LicensePlan::Demo, 0));
    let (manifest, kid) =
        verify_update_manifest(&signed("update-manifest.jws"), &keysets.update).unwrap();
    assert_eq!(kid, "test-upd-1");
    assert_eq!(manifest.version, "0.3.0");
    assert_eq!(manifest.channel, UpdateChannel::Stable);
    assert_eq!(
        manifest.installer.name,
        "markiro-standalone-0.3.0-windows-x86_64-setup.exe"
    );
}

#[test]
fn a_license_of_another_issuer_or_with_an_unknown_field_is_malformed_after_its_signature() {
    let keysets = test_keysets();
    let compact = signed("license-subscription.jws");
    let other = Keyset {
        origin: Some("https://other.invalid".to_owned()),
        ..keysets.license.clone()
    };
    assert_eq!(verify_license(&compact, &other), Err(TrustError::Malformed));
    let none = Keyset {
        origin: None,
        ..keysets.license.clone()
    };
    assert_eq!(verify_license(&compact, &none), Err(TrustError::Malformed));
    let (kid, key) = signer("license");
    let (_, body, _) = split(&compact);
    let mut payload: Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(body).unwrap()).unwrap();
    payload["limits"] = json!({});
    let extra = sign_raw(
        &key,
        &header(LICENSE_TYP, &kid),
        &serde_json::to_vec(&payload).unwrap(),
    );
    assert_eq!(
        verify_license(&extra, &keysets.license),
        Err(TrustError::Malformed)
    );
}

#[test]
fn an_oversized_file_is_refused_unread() {
    let keysets = test_keysets();
    assert_eq!(MAX_LICENSE_BYTES, 16 * 1024);
    assert_eq!(MAX_UPDATE_MANIFEST_BYTES, 64 * 1024);
    let compact = signed("license-subscription.jws");
    assert!(compact.len() < MAX_LICENSE_BYTES);
    // A valid license followed by padding up to one byte over the limit: the
    // size alone refuses it, before any segment is read.
    let oversized = format!(
        "{compact}{}",
        " ".repeat(MAX_LICENSE_BYTES + 1 - compact.len())
    );
    assert_eq!(
        verify_license(&oversized, &keysets.license),
        Err(TrustError::Malformed)
    );
    let manifest = signed("update-manifest.jws");
    let oversized = format!(
        "{manifest}{}",
        " ".repeat(MAX_UPDATE_MANIFEST_BYTES + 1 - manifest.len())
    );
    assert_eq!(
        verify_update_manifest(&oversized, &keysets.update),
        Err(TrustError::Malformed)
    );
}

#[test]
fn the_activation_request_round_trips_as_the_host_will_write_it() {
    let original: Value = serde_json::from_str(&domain_fixture("activation-request.json")).unwrap();
    let request = ActivationRequest::from_json(&serde_json::to_vec(&original).unwrap()).unwrap();
    assert_eq!(request.host_id, HOST_ID);
    assert!(request.is_valid());
    assert_eq!(serde_json::to_value(&request).unwrap(), original);
}
```

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test trust
```

Ожидается: FAIL компиляции — нет `verify_license`, `LicensePayloadV1`, `MAX_LICENSE_BYTES` и других.

- [ ] **Step 3: Реализация**

Правка `apps/standalone/proto/src/trust.rs`:

Фрагмент 1:

```rust
use serde::Deserialize;
```

заменить на:

```rust
use serde::{Deserialize, Deserializer, Serialize};
```

Фрагмент 2:

```rust
/// `typ` of an update manifest's header.
pub const UPDATE_TYP: &str = "markiro-standalone-update+jws";
/// The longest `kid`, in UTF-16 code units as the domain's Zod counts.
const MAX_KID_UNITS: usize = 128;
```

заменить на:

```rust
/// `typ` of an update manifest's header.
pub const UPDATE_TYP: &str = "markiro-standalone-update+jws";
/// A license file above this many bytes is refused unread (spec §4.3).
pub const MAX_LICENSE_BYTES: usize = 16 * 1024;
/// An update manifest above this many bytes is refused unread (spec §10.11.2).
pub const MAX_UPDATE_MANIFEST_BYTES: usize = 64 * 1024;
/// `format` of the host's activation request (spec §6.3).
pub const ACTIVATION_REQUEST_FORMAT: &str = "markiro-activation-request-v1";
/// The longest `kid`, in UTF-16 code units as the domain's Zod counts.
const MAX_KID_UNITS: usize = 128;
/// `Number.MAX_SAFE_INTEGER`: the domain reads every count and instant as a
/// JavaScript number, so a larger one is malformed on both sides.
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
```

Фрагмент 3 (перед модулем тестов):

```rust
#[cfg(test)]
mod tests {
```

заменить на:

```rust
/// Reads an `Option` field that must be present, `null` or a value: serde
/// alone would read a missing `Option` as `None`, where the domain's Zod
/// refuses it.
fn required<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(deserializer)
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// A lower-case canonical UUID of versions 1-8 and the RFC variant.
fn is_uuid(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(byte),
        })
        && (b'1'..=b'8').contains(&bytes[14])
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
}

fn is_lower_hex(text: &str, length: usize) -> bool {
    text.len() == length
        && text
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Ten or twelve ASCII digits: the shape; the check digits are the host's
/// (`markiro_host::inn`), since a wrong one is a mismatch, not a bad file.
fn is_inn_shape(text: &str) -> bool {
    (text.len() == 10 || text.len() == 12) && text.bytes().all(|byte| byte.is_ascii_digit())
}

/// Non-empty, at most `max` UTF-16 units, no control character.
fn is_plain_text(text: &str, max: usize) -> bool {
    !text.is_empty()
        && utf16_len(text) <= max
        && !text
            .chars()
            .any(|character| character <= '\u{1f}' || character == '\u{7f}')
}

/// `0` or a decimal without a leading zero, at most 19 digits.
fn is_decimal_revision(text: &str) -> bool {
    let bytes = text.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 19
        && bytes.iter().all(u8::is_ascii_digit)
        && (bytes.len() == 1 || bytes[0] != b'0')
}

/// `YYYY-MM-DDTHH:MM:SS[.fraction]Z`, the shape the domain's Zod checks.
fn is_utc_instant(text: &str) -> bool {
    let bytes = text.as_bytes();
    let shape = b"dddd-dd-ddTdd:dd:dd";
    if bytes.len() < shape.len() + 1 || bytes.last() != Some(&b'Z') {
        return false;
    }
    let fixed = shape.iter().zip(bytes).all(|(expected, byte)| {
        if *expected == b'd' {
            byte.is_ascii_digit()
        } else {
            expected == byte
        }
    });
    let fraction = &bytes[shape.len()..bytes.len() - 1];
    fixed
        && (fraction.is_empty()
            || (fraction[0] == b'.'
                && (2..=10).contains(&fraction.len())
                && fraction[1..].iter().all(u8::is_ascii_digit)))
}

/// `X.Y.Z`, each part `0` or up to nine digits without a leading zero.
fn version_parts(text: &str) -> Option<[u32; 3]> {
    let mut parts = text.split('.');
    let mut out = [0u32; 3];
    for slot in &mut out {
        let part = parts.next()?;
        if part.is_empty()
            || part.len() > 9
            || !part.bytes().all(|byte| byte.is_ascii_digit())
            || (part.len() > 1 && part.starts_with('0'))
        {
            return None;
        }
        *slot = part.parse().ok()?;
    }
    parts.next().is_none().then_some(out)
}

/// A license file's payload (spec §4.2), the domain's
/// `standaloneLicensePayloadV1Schema`: read strictly, an unknown field is
/// malformed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LicensePayloadV1 {
    pub version: u8,
    pub license_id: String,
    pub sequence: u64,
    pub issuer: String,
    pub tenant_id: String,
    pub site_id: String,
    pub host_id: String,
    pub customer: LicenseCustomer,
    pub plan: LicensePlan,
    pub plan_version_id: String,
    pub entitlement_revision: String,
    pub issued_at: u64,
    pub valid_from: u64,
    pub valid_until: u64,
    pub grace_days: u8,
    pub quotas: LicenseQuotas,
    pub features: LicenseFeatures,
    #[serde(deserialize_with = "required")]
    pub replaces: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LicenseCustomer {
    pub name: String,
    pub inn: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LicensePlan {
    Demo,
    Subscription,
}

/// The cloud's quotas; `None` is no limit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LicenseQuotas {
    #[serde(deserialize_with = "required")]
    pub lines: Option<u64>,
    #[serde(deserialize_with = "required")]
    pub stations: Option<u64>,
    #[serde(deserialize_with = "required")]
    pub kiosks: Option<u64>,
    #[serde(deserialize_with = "required")]
    pub cabinet_users: Option<u64>,
}

/// The cloud's features.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LicenseFeatures {
    pub label_editor: bool,
    pub public_api: bool,
    pub pallets: bool,
    pub chz_integration: bool,
    pub inventory: bool,
    pub commerce_ml: bool,
    pub handheld: bool,
}

impl LicensePayloadV1 {
    /// The payload of `bytes`, if it is one (shape and rules).
    pub fn from_json(bytes: &[u8]) -> Result<Self, TrustError> {
        let payload: Self = read_object(bytes, &["", "/customer", "/quotas", "/features"], &[])?;
        if payload.is_valid() {
            Ok(payload)
        } else {
            Err(TrustError::Malformed)
        }
    }

    /// The rules serde does not check (the domain's refinements).
    pub fn is_valid(&self) -> bool {
        let quotas = [
            self.quotas.lines,
            self.quotas.stations,
            self.quotas.kiosks,
            self.quotas.cabinet_users,
        ];
        self.version == 1
            && is_uuid(&self.license_id)
            && (1..=MAX_SAFE_INTEGER).contains(&self.sequence)
            && !self.issuer.is_empty()
            && utf16_len(&self.issuer) <= 256
            && is_uuid(&self.tenant_id)
            && is_uuid(&self.site_id)
            && is_uuid(&self.host_id)
            && is_plain_text(&self.customer.name, 300)
            && is_inn_shape(&self.customer.inn)
            && is_uuid(&self.plan_version_id)
            && is_decimal_revision(&self.entitlement_revision)
            && [self.issued_at, self.valid_from, self.valid_until]
                .iter()
                .all(|instant| *instant <= MAX_SAFE_INTEGER)
            && self.valid_from < self.valid_until
            && self.grace_days <= 60
            && quotas
                .iter()
                .flatten()
                .all(|limit| *limit <= MAX_SAFE_INTEGER)
            && self.replaces.as_deref().map_or(true, is_uuid)
    }
}

/// The signed update manifest (spec §10.2), the domain's
/// `standaloneUpdateManifestV1Schema`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct UpdateManifestV1 {
    pub v: u8,
    pub product: String,
    pub version: String,
    pub channel: UpdateChannel,
    pub released_at: String,
    pub source_sha: String,
    pub installer: UpdateInstaller,
    pub protocol: u32,
    pub min_protocol: u32,
    pub min_upgrade_from: String,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdateChannel {
    Beta,
    Stable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct UpdateInstaller {
    pub name: String,
    pub sha256: String,
    pub size_bytes: u64,
}

impl UpdateManifestV1 {
    /// The manifest of `bytes`, if it is one (shape and rules).
    pub fn from_json(bytes: &[u8]) -> Result<Self, TrustError> {
        let manifest: Self = read_object(bytes, &["", "/installer"], &[])?;
        if manifest.is_valid() {
            Ok(manifest)
        } else {
            Err(TrustError::Malformed)
        }
    }

    /// The rules serde does not check (the domain's refinements).
    pub fn is_valid(&self) -> bool {
        let (Some(version), Some(oldest)) = (
            version_parts(&self.version),
            version_parts(&self.min_upgrade_from),
        ) else {
            return false;
        };
        self.v == 1
            && self.product == "markiro-standalone"
            && oldest <= version
            && is_utc_instant(&self.released_at)
            && is_lower_hex(&self.source_sha, 40)
            && self.installer.name
                == format!(
                    "markiro-standalone-{}-windows-x86_64-setup.exe",
                    self.version
                )
            && is_lower_hex(&self.installer.sha256, 64)
            && (1..=MAX_SAFE_INTEGER).contains(&self.installer.size_bytes)
            && self.min_protocol >= 1
            && self.min_protocol <= self.protocol
            && self.notes.len() <= 30
            && self.notes.iter().all(|note| is_plain_text(note, 200))
    }
}

/// The host's activation request (spec §6.3), the domain's
/// `standaloneActivationRequestSchema`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ActivationRequest {
    pub format: String,
    pub host_id: String,
    pub host_fingerprint: String,
    pub host_version: String,
    pub organization: ActivationOrganization,
    #[serde(deserialize_with = "required")]
    pub trial: Option<ActivationTrial>,
    #[serde(deserialize_with = "required")]
    pub current_license: Option<ActivationLicense>,
    pub usage: ActivationUsage,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActivationOrganization {
    pub name: String,
    /// Empty while the organization has none.
    pub inn: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ActivationTrial {
    pub started_at: String,
    pub inn: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ActivationLicense {
    pub license_id: String,
    pub sequence: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ActivationUsage {
    pub stations: u64,
    pub cabinet_users: u64,
    pub lines: u64,
}

impl ActivationRequest {
    /// The request of `bytes`, if it is one (shape and rules).
    pub fn from_json(bytes: &[u8]) -> Result<Self, TrustError> {
        let request: Self = read_object(
            bytes,
            &["", "/organization", "/usage"],
            &["/trial", "/currentLicense"],
        )?;
        if request.is_valid() {
            Ok(request)
        } else {
            Err(TrustError::Malformed)
        }
    }

    /// The rules serde does not check; the host checks what it builds.
    pub fn is_valid(&self) -> bool {
        let inn_or_none = |inn: &str| inn.is_empty() || is_inn_shape(inn);
        self.format == ACTIVATION_REQUEST_FORMAT
            && is_uuid(&self.host_id)
            && is_lower_hex(&self.host_fingerprint, 64)
            && version_parts(&self.host_version).is_some()
            && is_plain_text(&self.organization.name, 300)
            && inn_or_none(&self.organization.inn)
            && self.trial.as_ref().map_or(true, |trial| {
                is_utc_instant(&trial.started_at) && inn_or_none(&trial.inn)
            })
            && self.current_license.as_ref().map_or(true, |license| {
                is_uuid(&license.license_id) && (1..=MAX_SAFE_INTEGER).contains(&license.sequence)
            })
            && [
                self.usage.stations,
                self.usage.cabinet_users,
                self.usage.lines,
            ]
            .iter()
            .all(|count| *count <= MAX_SAFE_INTEGER)
            && is_utc_instant(&self.created_at)
    }
}

/// Steps 1-4 of the host's check (spec §4.3): size, form, `kid`, signature,
/// the payload strictly and its issuer against the keyset's origin. The
/// binding (`hostId`, INN, `sequence`) is the host's.
pub fn verify_license(
    compact: &str,
    keyset: &Keyset,
) -> Result<(LicensePayloadV1, String), TrustError> {
    if compact.len() > MAX_LICENSE_BYTES {
        return Err(TrustError::Malformed);
    }
    let verified = verify_compact(compact, LICENSE_TYP, keyset)?;
    let license = LicensePayloadV1::from_json(&verified.payload)?;
    if keyset.origin.as_deref() != Some(license.issuer.as_str()) {
        return Err(TrustError::Malformed);
    }
    Ok((license, verified.kid))
}

/// The same for an update manifest, against the release keyset.
pub fn verify_update_manifest(
    compact: &str,
    keyset: &Keyset,
) -> Result<(UpdateManifestV1, String), TrustError> {
    if compact.len() > MAX_UPDATE_MANIFEST_BYTES {
        return Err(TrustError::Malformed);
    }
    let verified = verify_compact(compact, UPDATE_TYP, keyset)?;
    Ok((
        UpdateManifestV1::from_json(&verified.payload)?,
        verified.kid,
    ))
}

#[cfg(test)]
mod tests {
```

- [ ] **Step 4: Убедиться, что тесты проходят**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-proto
```

Ожидается: PASS — 15 тестов `tests/trust.rs` (в том числе 91 случай `schema-cases.json` и 11 исходов `expectations.json` — те же ответы, что у Vitest задач 4–5), модульные и прежние тесты `proto`. Сборка без предупреждений.

- [ ] **Step 5: Мутации**

- M1: убрать `#[serde(deserialize_with = "required")]` у `replaces` → FAIL `the_payload_rules_answer_the_shared_cases_as_the_zod_schemas_do` («no replaces»).
- M2: в `LicensePayloadV1::from_json` убрать `"/customer"` из списка объектов → FAIL тот же тест («the customer as an array»).
- M3: убрать `&& oldest <= version` → FAIL тот же тест («an upgrade only from a newer version», «… 0.10.0 …»).
- M4: в `verify_license` убрать проверку `keyset.origin` → FAIL `a_license_of_another_issuer_or_with_an_unknown_field_is_malformed_after_its_signature`.
- Выживает по замыслу: снятие проверки `compact.len() > MAX_LICENSE_BYTES` в `verify_license` — дополненный пробелами файл портит сегмент подписи и всё равно `Malformed`; предел — защита от разбора больших тел, а не другой исход. Тест закрепляет значение пределов и сам отказ.

- [ ] **Step 6: Гейты**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
git diff --check
```

- [ ] **Step 7: Коммит**

```bash
git add apps/standalone/proto/src/trust.rs apps/standalone/proto/tests/trust.rs
git commit -F /tmp/claude/msg-lc1-7.txt
```

Сообщение: `feat(standalone): the license, update manifest and activation request read as strictly in Rust as in the domain` + пустая строка + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 8: Хост — порт ИНН и команда `markiro-host trust-keys`

**Files:**

- Create: `apps/standalone/host/src/inn.rs`, `apps/standalone/host/tests/inn.rs`
- Modify: `apps/standalone/host/src/lib.rs`, `apps/standalone/host/src/main.rs`, `apps/standalone/host/Cargo.toml`

**Interfaces:**

- Consumes: `packages/domain/fixtures/inn-cases.json` (задача 1); `markiro_proto::trust::{license_keyset, update_keyset}` (задача 6).
- Produces: `markiro_host::inn::{normalize, is_valid}` для ЛЦ-2; команда `markiro-host trust-keys` — `kid` набора лицензий, затем набора выпусков, по одному в строке; dev-зависимость хоста с фичей `test-keys` (тесты хоста ЛЦ-2 видят тестовые ключи).

- [ ] **Step 1: Написать падающие тесты**

Создать `apps/standalone/host/tests/inn.rs`:

```rust
//! The host's INN port against the domain's shared cases
//! (`packages/domain/fixtures/inn-cases.json`, read by `test/inn.test.ts`
//! too): the same input gives the same answer on both sides.

use markiro_host::inn;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
    input: String,
    normalized: Option<String>,
}

fn cases() -> Vec<Case> {
    let path = format!(
        "{}/../../../packages/domain/fixtures/inn-cases.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("read {path}: {error}"));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("parse {path}: {error}"))
}

#[test]
fn the_host_answers_the_shared_inn_cases_as_the_domain_does() {
    let cases = cases();
    assert!(cases.len() >= 25, "{}", cases.len());
    for case in &cases {
        assert_eq!(
            inn::normalize(&case.input),
            case.normalized,
            "{:?}",
            case.input
        );
        assert_eq!(
            inn::is_valid(&case.input),
            case.normalized.as_deref() == Some(case.input.as_str()),
            "{:?}",
            case.input
        );
    }
}

#[test]
fn the_cases_hold_what_rust_and_javascript_trim_differently() {
    let inputs: Vec<String> = cases().into_iter().map(|case| case.input).collect();
    assert!(inputs.iter().any(|input| input.starts_with('\u{feff}')));
    assert!(inputs.iter().any(|input| input.starts_with('\u{85}')));
}
```

Правка `apps/standalone/host/src/main.rs` (модуль `tests`) — фрагмент:

```rust
    #[test]
    fn restore_of_a_missing_copy_is_an_error_and_writes_nothing() {
```

заменить на:

```rust
    #[test]
    fn trust_keys_takes_no_argument() {
        assert_eq!(parse(&args(&["trust-keys"])), Ok(Command::TrustKeys));
        assert!(parse(&args(&["trust-keys", "--data-dir", "/tmp/h"])).is_err());
        assert!(parse(&args(&["trust-keys", "license"])).is_err());
    }

    /// A test build trusts the domain's test keys (the `test-keys` feature of
    /// the host's dev-dependency): the license kids first, then the release's.
    #[test]
    fn trust_keys_lists_the_license_kids_then_the_release_kids() {
        let kids = trust_keys();
        let license: Vec<String> = markiro_proto::trust::license_keyset()
            .keys
            .into_iter()
            .map(|key| key.kid)
            .collect();
        assert!(license.contains(&"test-lic-1".to_owned()), "{license:?}");
        assert_eq!(kids[..license.len()], license[..]);
        assert!(kids[license.len()..].contains(&"test-upd-1".to_owned()), "{kids:?}");
    }

    #[test]
    fn restore_of_a_missing_copy_is_an_error_and_writes_nothing() {
```

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test inn
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --bin markiro-host trust_keys
```

Ожидается: FAIL компиляции — нет `markiro_host::inn`, `Command::TrustKeys`, `trust_keys`.

- [ ] **Step 3: Реализация**

Создать `apps/standalone/host/src/inn.rs`:

```rust
//! The Russian taxpayer number (ИНН) of the license check (spec 2026-10-13
//! §4.9, plan ЛЦ-1): a port of `@markiro/domain`'s `isValidInn` and
//! `normalizeInn`, held to the same answers by
//! `packages/domain/fixtures/inn-cases.json` (`tests/inn.rs`). Both values of
//! a comparison are normalized; one whose check digits fail equals nothing.

const TEN: [u32; 9] = [2, 4, 10, 3, 5, 9, 4, 6, 8];
const TWELVE_FIRST: [u32; 10] = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
const TWELVE_SECOND: [u32; 11] = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8];

fn check_digit(digits: &[u32], weights: &[u32]) -> u32 {
    weights
        .iter()
        .zip(digits)
        .map(|(weight, digit)| weight * digit)
        .sum::<u32>()
        % 11
        % 10
}

/// Exactly 10 or 12 ASCII digits whose check digits hold; nothing trimmed.
pub fn is_valid(value: &str) -> bool {
    if !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    let digits: Vec<u32> = value.bytes().map(|byte| u32::from(byte - b'0')).collect();
    match digits.len() {
        10 => check_digit(&digits, &TEN) == digits[9],
        12 => {
            check_digit(&digits, &TWELVE_FIRST) == digits[10]
                && check_digit(&digits, &TWELVE_SECOND) == digits[11]
        }
        _ => false,
    }
}

/// `value` without the whitespace JavaScript's `String.prototype.trim`
/// removes, if that is a valid INN.
pub fn normalize(value: &str) -> Option<String> {
    let trimmed = value.trim_matches(is_js_whitespace);
    is_valid(trimmed).then(|| trimmed.to_owned())
}

/// JavaScript's whitespace (WhiteSpace and LineTerminator): Unicode
/// `White_Space` without U+0085, plus U+FEFF. Rust's own `trim` differs in
/// exactly these two, and the shared fixture holds both.
fn is_js_whitespace(character: char) -> bool {
    (character.is_whitespace() && character != '\u{85}') || character == '\u{feff}'
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_or_short_value_is_no_inn() {
        assert!(!is_valid(""));
        assert_eq!(normalize("   "), None);
        assert!(!is_valid("123456789"));
    }
}
```

Правка `apps/standalone/host/src/lib.rs` — фрагмент:

```rust
pub mod feed;
pub mod install;
```

заменить на:

```rust
pub mod feed;
pub mod inn;
pub mod install;
```

Правка `apps/standalone/host/Cargo.toml` — фрагмент:

```toml
[dev-dependencies]
http-body-util = "0.1"
```

заменить на:

```toml
[dev-dependencies]
http-body-util = "0.1"
# The domain's test keys join the built-in keysets in the host's tests (plan
# ЛЦ-1); a release build, which has no dev-dependency, never trusts them.
markiro-proto = { path = "../proto", features = ["test-keys"] }
```

Правка `apps/standalone/host/src/main.rs`:

Фрагмент 1:

```rust
//!   network-check [--make-private]            list networks; exit 3 while one is public
```

заменить на:

```rust
//!   network-check [--make-private]            list networks; exit 3 while one is public
//!   trust-keys                                print the kids of the keys this build trusts
```

Фрагмент 2:

```rust
    NetworkCheck {
        make_private: bool,
    },
}
```

заменить на:

```rust
    NetworkCheck {
        make_private: bool,
    },
    TrustKeys,
}
```

Фрагмент 3:

```rust
       markiro-host network-check [--make-private]";
```

заменить на:

```rust
       markiro-host network-check [--make-private]
       markiro-host trust-keys";
```

Фрагмент 4:

```rust
        ("install" | "uninstall" | "stop-service" | "network-check", _) => {
            return Err(USAGE.to_owned())
        }
```

заменить на:

```rust
        ("trust-keys", []) => return Ok(Command::TrustKeys),
        ("install" | "uninstall" | "stop-service" | "network-check" | "trust-keys", _) => {
            return Err(USAGE.to_owned())
        }
```

Фрагмент 5:

```rust
        Command::StopService => stop_service(),
```

заменить на:

```rust
        Command::StopService => stop_service(),
        Command::TrustKeys => {
            for kid in trust_keys() {
                println!("{kid}");
            }
            Ok(())
        }
```

Фрагмент 6 (после функции `network_check_code`):

```rust
fn run_foreground(data_dir: PathBuf, port: Option<u16>) -> Result<(), BoxError> {
```

заменить на:

```rust
/// `trust-keys`: the kids of the license keyset, then of the release keyset,
/// one per line (spec 2026-10-13 §5.2). A release build lists no `test-` kid;
/// the Windows CI job checks the installer's host.
fn trust_keys() -> Vec<String> {
    let license = markiro_proto::trust::license_keyset();
    let update = markiro_proto::trust::update_keyset();
    license
        .keys
        .into_iter()
        .chain(update.keys)
        .map(|key| key.kid)
        .collect()
}

fn run_foreground(data_dir: PathBuf, port: Option<u16>) -> Result<(), BoxError> {
```

- [ ] **Step 4: Убедиться, что тесты проходят и сборка без тестов не знает тестовых ключей**

```bash
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test inn
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --bin markiro-host
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --lib inn
cargo run --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host -- trust-keys
```

Ожидается: PASS; `cargo run` (без dev-зависимостей, а значит без `test-keys`) печатает пустой вывод с кодом 0 — до шага владельца производственных ключей нет. Строка `test-lic-1` в этом выводе — дефект (фича протекла в обычную сборку): остановиться.

- [ ] **Step 5: Мутации**

- M1: в `inn.rs` заменить `value.trim_matches(is_js_whitespace)` на `value.trim()` → FAIL `the_host_answers_the_shared_inn_cases_as_the_domain_does` (U+FEFF, U+0085).
- M2: убрать строку `markiro-proto = { path = "../proto", features = ["test-keys"] }` → FAIL `trust_keys_lists_the_license_kids_then_the_release_kids`.

- [ ] **Step 6: Гейты**

```bash
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
git diff --check
git diff --stat apps/standalone/Cargo.lock
```

`Cargo.lock` в этой задаче не меняется (dev-зависимость на тот же путь).

- [ ] **Step 7: Коммит**

```bash
git add apps/standalone/host/src/inn.rs apps/standalone/host/tests/inn.rs apps/standalone/host/src/lib.rs apps/standalone/host/src/main.rs apps/standalone/host/Cargo.toml
git commit -F /tmp/claude/msg-lc1-8.txt
```

Сообщение: `feat(standalone): the host checks an INN as the domain does and lists the keys it trusts (markiro-host trust-keys)` + пустая строка + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 9: Сторожа — ни одного закрытого ключа в репозитории, ни одного тестового ключа в сборке выпуска

**Files:**

- Create: `tools/standalone-release/test/no-private-keys.test.mjs`
- Modify: `.github/workflows/ci.yml`, `tools/standalone-release/test/workflow.test.mjs`

**Interfaces:**

- Consumes: `git ls-files`; `markiro-host trust-keys` (задача 8); тестовые ключи задачи 5 и `packages/platform-contracts/tools/offline-grants-test-only-key.json`.
- Produces: контракт `pnpm test:standalone-release:contract` падает на закрытом ключе в отслеживаемом файле вне списка (Д10); шаг CI `The release host trusts no test key` в `standalone-windows-build` (Д11).

- [ ] **Step 1: Написать тесты**

Создать `tools/standalone-release/test/no-private-keys.test.mjs`:

```js
// Spec 2026-10-13 §12.1 (plan ЛЦ-1): no tracked file holds a private key but
// the public TEST keys named here. The production license key lives in the
// API's environment (plan ЛЦ-0) and the release key on the owner's machine
// (spec §5.1); `apps/standalone/proto/fixtures/trust-keys.json` holds their
// public halves only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const TEST_KEY_FILES = [
  "packages/domain/fixtures/standalone-license/test-private-keys.json",
  "packages/platform-contracts/tools/offline-grants-test-only-key.json",
];

// A PEM private key with a body (any kind: PKCS#8, EC, RSA, encrypted) or a
// private JWK (its `d`). The words alone and a test's short fake are no key.
const PEM_PRIVATE_KEY =
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]{64,}-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/u;
const JWK_PRIVATE_KEY = /"d"\s*:\s*"[A-Za-z0-9_-]{32,}"/u;

function holdsPrivateKey(text) {
  return PEM_PRIVATE_KEY.test(text) || JWK_PRIVATE_KEY.test(text);
}

test("a PEM or JWK private key is recognized, the words and a short fake are not", () => {
  const body = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg".repeat(2);
  for (const kind of ["", "EC ", "RSA ", "ENCRYPTED ", "OPENSSH "]) {
    assert.ok(
      holdsPrivateKey(
        `-----BEGIN ${kind}PRIVATE KEY-----\n${body}\n-----END ${kind}PRIVATE KEY-----\n`,
      ),
      kind,
    );
  }
  assert.ok(holdsPrivateKey(`-----BEGIN PRIVATE KEY-----\r\n${body}\r\n-----END PRIVATE KEY-----`));
  assert.ok(holdsPrivateKey(JSON.stringify({ kty: "EC", crv: "P-256", d: "A".repeat(43) })));
  assert.ok(holdsPrivateKey(`{\n  "d": "${"B".repeat(43)}"\n}`));
  assert.equal(holdsPrivateKey("The file holds the host's PRIVATE KEY"), false);
  assert.equal(
    holdsPrivateKey('"-----BEGIN OPENSSH PRIVATE KEY-----",\n  "b3BlbnNzaC1rZXktdjEAAAAA",'),
    false,
  );
  assert.equal(
    holdsPrivateKey(
      JSON.stringify({ kty: "EC", crv: "P-256", x: "A".repeat(43), y: "B".repeat(43) }),
    ),
    false,
  );
});

test("no tracked file holds a private key but the listed test keys", () => {
  const files = execFileSync("git", ["ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
  const holders = [];
  for (const path of files) {
    let bytes;
    try {
      bytes = readFileSync(path);
    } catch {
      continue; // deleted in the working tree
    }
    if (bytes.subarray(0, 8000).includes(0)) continue; // binary
    if (holdsPrivateKey(bytes.toString("utf8"))) holders.push(path);
  }
  assert.deepEqual(holders.sort(), [...TEST_KEY_FILES].sort());
});
```

В конец `tools/standalone-release/test/workflow.test.mjs` добавить:

```js
test("the release host is checked to trust no test key before it is bundled", () => {
  const compile = runs.findIndex((run) => run.startsWith("cargo build --release"));
  const check = runs.findIndex((run) => run.includes("markiro-host.exe trust-keys"));
  const sidecar = runs.findIndex((run) =>
    run.includes("mkdir -p apps/standalone/src-tauri/binaries"),
  );
  assert.ok(
    compile >= 0 && compile < check && check < sidecar,
    `${compile} < ${check} < ${sidecar}`,
  );
  const step = stepRunning("markiro-host.exe trust-keys");
  assert.equal(step.shell, "bash");
  assert.match(
    step.run,
    /"\$\(apps\/standalone\/target\/release\/markiro-host\.exe trust-keys\)"/u,
  );
  assert.match(step.run, /grep -q '\^test-'/u);
  assert.match(step.run, /exit 1/u);
});
```

- [ ] **Step 2: Убедиться, что падает контракт шага CI**

```bash
node --test tools/standalone-release/test/no-private-keys.test.mjs tools/standalone-release/test/workflow.test.mjs
```

Ожидается: FAIL «the release host is checked to trust no test key before it is bundled» (шага нет). `no-private-keys.test.mjs` — уже PASS: после задачи 5 в дереве ровно два тестовых ключа из списка (красное доказательство — мутации шага 5).

- [ ] **Step 3: Реализация**

Правка `.github/workflows/ci.yml` — фрагмент (задание `standalone-windows-build`):

<!-- prettier-ignore -->
```yaml
      - name: Build the host for the installer
        run: cargo build --release --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host
```

заменить на:

<!-- prettier-ignore -->
```yaml
      - name: Build the host for the installer
        run: cargo build --release --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host
      # The release host trusts the production keys alone (spec 2026-10-13
      # §5.2, plan ЛЦ-1): a test key (`test-…`) never reaches an installer.
      - name: The release host trusts no test key
        shell: bash
        run: |
          kids="$(apps/standalone/target/release/markiro-host.exe trust-keys)"
          printf '%s\n' "$kids"
          if printf '%s\n' "$kids" | grep -q '^test-'; then
            echo "the release host trusts a test key" >&2
            exit 1
          fi
```

- [ ] **Step 4: Убедиться, что контракты проходят**

```bash
pnpm test:standalone-release:contract
pnpm test:ci-policy
```

Ожидается: PASS (прежние контракты workflow — в том числе порядок шагов и «нет секретов» — не задеты: шаг без `${{ }}`, без `secrets.` и сетевых команд).

- [ ] **Step 5: Мутации**

- M1: создать `printf '%s\n' '-----BEGIN PRIVATE KEY-----' "$(head -c 96 /dev/zero | base64)" '-----END PRIVATE KEY-----' > /tmp/claude/lc1-key.pem`, скопировать его в `apps/standalone/proto/fixtures/leak.pem`, `git add -N apps/standalone/proto/fixtures/leak.pem` (файл становится отслеживаемым без содержимого в индексе) → FAIL «no tracked file holds a private key but the listed test keys». Затем `git rm --cached apps/standalone/proto/fixtures/leak.pem` и удалить файл; `git status --short` — чисто.
- M2: убрать из `TEST_KEY_FILES` строку `packages/platform-contracts/tools/offline-grants-test-only-key.json` → FAIL тот же тест.
- M3: в шаге CI заменить `grep -q '^test-'` на `grep -q '^prod-'` → FAIL «the release host is checked to trust no test key…».

- [ ] **Step 6: Гейты**

```bash
node_modules/.bin/prettier --ignore-path .prettierignore --check tools/standalone-release/test/no-private-keys.test.mjs tools/standalone-release/test/workflow.test.mjs .github/workflows/ci.yml
git diff --check
```

- [ ] **Step 7: Коммит**

```bash
git add tools/standalone-release/test/no-private-keys.test.mjs tools/standalone-release/test/workflow.test.mjs .github/workflows/ci.yml
git commit -F /tmp/claude/msg-lc1-9.txt
```

Сообщение: `ci(standalone): no tracked file holds a private key but the test keys, and the release host trusts no test key` + пустая строка + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 10: Документы и шаг владельца — ключ лицензий, ключ выпусков, открытые JWK в сборке

**Files:**

- Modify: `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md`
- Шаг владельца: `apps/standalone/proto/fixtures/trust-keys.json`

**Interfaces:**

- Consumes: всё задач 1–9.
- Produces: раздел `AGENTS.md` «Signed documents and trust keys»; §18 спецификации; после шага владельца — производственные `kid` в `markiro-host trust-keys` сборки выпуска и тот же открытый ключ лицензий для `STANDALONE_LICENSE_KEYSET_JSON` плана ЛЦ-0.

- [ ] **Step 1: `apps/standalone/AGENTS.md`**

Фрагмент:

```md
## Network and TLS
```

заменить на:

```md
## Signed documents and trust keys

The license file and the update manifest (spec 2026-10-13, plan ЛЦ-1) are
compact JWS with ES256, checked by `markiro_proto::trust` here and by
`@markiro/domain` (`verifyCompactJws`, `verifyStandaloneLicense`,
`verifyStandaloneUpdateManifest`) in TypeScript. The order is form, `kid`,
signature, then the payload, read strictly; both sides refuse a struct given
as a JSON array (serde alone would take one, so Rust reads through a `Value`)
and a byte order mark, and keep a repeated key's last value.
`packages/domain/fixtures/standalone-license/` holds the shared fixtures: the
signed files with `expectations.json` (the outcome of each) and
`schema-cases.json` (the field rules), which `proto/tests/trust.rs` and the
domain's Vitest both walk. `packages/domain/scripts/generate-standalone-fixtures.mjs`
makes them with the TEST keys and never runs in CI: its signatures are random,
so a rerun rewrites every `.jws`. `packages/domain/fixtures/inn-cases.json`
holds `normalizeInn` and the host's `inn::normalize` to the same answers (the
JavaScript whitespace set, not Rust's `trim`).

The keysets a build trusts are `proto/fixtures/trust-keys.json`: public JWKs
only, the license keyset with its issuer's origin. The test keys join them
only under `cfg(test)` or the `test-keys` feature of `markiro-proto`, which
only the host's dev-dependency enables; in a test build the license issuer is
the test one. `markiro-host trust-keys` prints the kids of both keysets, and
the Windows CI job fails when the release host prints a `test-…` kid. No
tracked file holds a private key but the two test keys
`tools/standalone-release/test/no-private-keys.test.mjs` names; the
production license key lives in the API's environment (plan ЛЦ-0) and the
release key on the owner's machine.

## Network and TLS
```

- [ ] **Step 2: §18 спецификации**

В конец `docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md` (после последнего пункта §17, через пустую строку) добавить:

```md
## 18. Уточнения плана ЛЦ-1

План `docs/superpowers/plans/2026-10-13-standalone-lc1-trust-format-inn.md`.

- **Фикстуры — в домене.** Подписанные тестовым ключом файлы, их исходы (`expectations.json`) и
  правила полей (`schema-cases.json`) лежат в `packages/domain/fixtures/standalone-license/`, а не в
  `proto/fixtures/license-*.json` (раздел 12.1); Rust читает их по относительному пути. Обе стороны
  обходят одни и те же файлы.
- **Строгие формы одинаковы в Zod и Rust:** UUID — в нижнем регистре; целые — не больше
  `Number.MAX_SAFE_INTEGER`; время — `…Z`; версия — `X.Y.Z`; имя установщика — ровно
  `markiro-standalone-<версия>-windows-x86_64-setup.exe`; ИНН в файле — только форма (контрольную
  сумму сверяет хост, неверная — `inn_mismatch`). Rust читает объекты через `Value`: serde брал
  структуру и из массива.
- **`TrustError::code(kind)`**: лицензия — `license_malformed`, `license_unknown_key`,
  `license_signature`; манифест — `update_malformed`, `update_unknown_key`, `update_signature`.
- **Тестовые ключи** — под `cfg(test)` или фичей `test-keys` (включает только dev-зависимость хоста);
  в тестовой сборке издатель лицензий — тестовый. Сборка выпуска проверяется шагом CI по
  `markiro-host trust-keys`; проверка в `smoke.ps1` — план ОБН-2.
- **Закрытых ключей в репозитории нет**, кроме двух тестовых: ключа фикстур автонома и уже
  лежавшего тестового ключа офлайн-грантов (JWK). Проверка ловит и PEM, и закрытый JWK.
- **Производственные наборы пусты до шага владельца**; ключ лицензий одновременно ключ окружения API
  плана ЛЦ-0.
- Примеры ИНН разделов 4.9 и 6.3 (`7701234567`) не проходят контрольную сумму; фикстуры берут
  `7707083893` и `7707654321`.
- Отклонения при исполнении — в разделе плана «Отклонения при исполнении».
```

- [ ] **Step 3: Гейты и коммит документов**

```bash
node_modules/.bin/prettier --ignore-path .prettierignore --check apps/standalone/AGENTS.md docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md
git diff --check
git add apps/standalone/AGENTS.md docs/superpowers/specs/2026-10-13-standalone-license-and-updates-design.md
git commit -F /tmp/claude/msg-lc1-10.txt
```

Если prettier переформатирует абзацы — `--write` и снова `--check`. Сообщение: `docs(standalone): the trust keys and the signed documents' check, and spec §18 for plan ЛЦ-1` + пустая строка + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

- [ ] **Step 4: ШАГ ВЛАДЕЛЬЦА — ключи (вне песочницы, на машине владельца, вне репозитория)**

Исполнитель этот шаг не делает: закрытые ключи никогда не создаются агентом и не проходят через чат. Владелец выполняет в своём терминале (OpenSSL 3 или LibreSSL; `prime256v1` = P-256):

```bash
umask 077
mkdir -p ~/markiro-keys
# 1. Ключ лицензий (kid lic-2026-10): закрытый PEM PKCS#8 — в окружение API плана ЛЦ-0
#    (STANDALONE_LICENSE_PRIVATE_KEY_PEM), как OFFLINE_GRANT_PRIVATE_KEY_PEM у грантов.
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:prime256v1 -out ~/markiro-keys/standalone-license-lic-2026-10.pem
# 2. Ключ выпусков (kid upd-2026-10): только эта машина, под парольной фразой (спросит дважды).
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:prime256v1 -aes-256-cbc -out ~/markiro-keys/standalone-release-upd-2026-10.pem
# 3. Открытые половины.
openssl pkey -in ~/markiro-keys/standalone-license-lic-2026-10.pem -pubout -out ~/markiro-keys/standalone-license-lic-2026-10.pub.pem
openssl pkey -in ~/markiro-keys/standalone-release-upd-2026-10.pem -pubout -out ~/markiro-keys/standalone-release-upd-2026-10.pub.pem
# 4. Открытые JWK (печатаются только x и y — открытые координаты).
node -e 'const { createPublicKey } = require("node:crypto"); const { readFileSync } = require("node:fs"); for (const file of process.argv.slice(1)) { const { kty, crv, x, y } = createPublicKey(readFileSync(file)).export({ format: "jwk" }); console.log(file, JSON.stringify({ kty, crv, x, y })); }' ~/markiro-keys/standalone-license-lic-2026-10.pub.pem ~/markiro-keys/standalone-release-upd-2026-10.pub.pem
```

Две офлайн-копии обоих закрытых файлов — по §16 («Потеря закрытого ключа владельца»). Затем владелец (или исполнитель по присланным **открытым** JWK) заменяет `apps/standalone/proto/fixtures/trust-keys.json`, где `origin` — точное значение `SAAS_ADMIN_ORIGIN` продакшна (то же значение ЛЦ-0 кладёт в `STANDALONE_LICENSE_ISSUER`, без завершающего `/`):

<!-- prettier-ignore -->
```json
{
  "license": {
    "origin": "<SAAS_ADMIN_ORIGIN продакшна>",
    "keys": [{ "kid": "lic-2026-10", "jwk": { "kty": "EC", "crv": "P-256", "x": "<x>", "y": "<y>" } }],
    "retiredKids": []
  },
  "update": {
    "keys": [{ "kid": "upd-2026-10", "jwk": { "kty": "EC", "crv": "P-256", "x": "<x>", "y": "<y>" } }],
    "retiredKids": []
  }
}
```

Проверка и коммит:

```bash
node_modules/.bin/prettier --ignore-path .prettierignore --write apps/standalone/proto/fixtures/trust-keys.json
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-proto
cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --bin markiro-host
cargo run --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host -- trust-keys
node --test tools/standalone-release/test/no-private-keys.test.mjs
git add apps/standalone/proto/fixtures/trust-keys.json
git commit -F /tmp/claude/msg-lc1-keys.txt
```

Ожидается: тесты PASS (модульный тест требует `origin` при ключах и ни одного `test-…`; разбор отвергнет закрытый JWK, точку вне кривой и повтор `kid`); `cargo run` печатает ровно `lic-2026-10` и `upd-2026-10`; проверка ключей — PASS (в коммит попали только открытые координаты). Сообщение: `feat(standalone): the production license and release public keys the standalone trusts` + пустая строка + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Ротация и компрометация — по §5.3: новый `kid` сначала в сборку, старый — в `retiredKids` только после перевыпуска действующих файлов.

---

## Итоговая проверка плана

1. Домен: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain test`, `typecheck`, `lint`, `build` — PASS (прежние тесты, в том числе `offline-grants-jws.test.ts`, не изменены).
2. Контракты платформы: `pnpm --config.verifyDepsBeforeRun=false exec turbo run build --filter=@markiro/domain`, затем `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/platform-contracts test`, `typecheck`, `lint`, `build` — PASS.
3. API: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/national-catalog.client.test.ts`, `typecheck`, `lint`, `build` — PASS. Полный `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api test` требует `DATABASE_URL` и переменных окружения из `.env.example`; без них часть тестов пропускается — пропуски перечислить в отчёте.
4. Потребители домена, которые импортируют корень `@markiro/domain` (новые `export *` не должны столкнуться с их именами): `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone run typecheck`, `--filter @markiro/station run typecheck`, `--filter @markiro/kiosk run typecheck`, `--filter @markiro/admin run typecheck`, `--filter @markiro/saas-admin run typecheck` — PASS (после `turbo run build --filter=@markiro/domain --filter=@markiro/platform-contracts`).
5. Rust: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-proto`; `-p markiro-host --test inn`; `-p markiro-host --bin markiro-host`; `cargo run --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host -- trust-keys` — пусто до шага владельца. Гейт `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml --workspace --no-fail-fast` — вне песочницы (тесты хоста и оболочки открывают сокеты), частями, если весь не помещается; перед `-p markiro-standalone` — `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build`.
6. Контракты: `pnpm test:standalone-release:contract`, `pnpm test:ci-policy` — PASS.
7. `git diff <основа> -- apps/standalone/Cargo.lock` — только две строки в блоке `markiro-proto`; `git diff --stat <основа> -- apps/standalone/host/migrations apps/standalone/src-tauri/migrations packages/db/migrations` — пусто; `package.json` и `pnpm-lock.yaml` не изменены.
8. `pnpm format:check` (изменение затрагивает несколько пакетов) и `git diff --check` — чисто.
9. Каждая мутация задач 1–9 — FAIL названного теста (кроме оговорённых выживших); файлы восстановлены (`cmp`, тот же `shasum`); `git status --short` — пусто.
10. `git log --format=%B <основа>..HEAD` — в каждом коммите ровно одна строка `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; изменены только пути раздела «Файлы».
11. Если в рабочем дереве есть `graphify-out/graph.json` — `graphify update .`.

## Перенесено

- **Проверка `trust-keys` установленного хоста в `smoke.ps1`** (§16) и контракт выпуска про сетевые крейты `Cargo.lock` (§10.10) — план ОБН-2.
- **Применение `verify_license` хостом** (обрезка текста файла, предел тела запроса, привязка `hostId`, ИНН, `sequence`, маршруты, аудит) — план ЛЦ-2; Zod и фикстуры проводных форм лицензии (`office-license.json` и др.) — там же.
- **Обобщённый подписант API** (`signCompactJws(config, typ, payload)` из `grant-keyset.ts`) и переменные `STANDALONE_LICENSE_*` — план ЛЦ-0; он может проверять свой результат `verifyStandaloneLicense` домена по `test-keyset.json` и `test-private-keys.json`.
- **`verifyGrant` поверх `verifyCompactJws`** — не делается: у грантов другой порядок проверок и своя причина `wrong_origin`; общий здесь только декодер.
- **Проверка ключей при изменениях вне автонома.** Тест закрытых ключей идёт в задании `standalone-windows-build`, которое запускается на изменениях автонома, домена и `tools/standalone-release/`. Ключ, добавленный в репозиторий изменением только `apps/api` или `deploy/`, этот тест сам не поймает, пока задание не сработает на другом изменении; перенос теста в `verify_static` — отдельное решение (`tools/ci/affected.mjs`).
- **Расхождение спецификации:** §3.4 упоминает «лимиты (`limits`, пока пустые)», а §4.2 — квоты `quotas` и поля `limits` не имеет; план следует §4.2 (`limits` в нагрузке — неизвестное поле, `malformed`).

## Не проверено

- Windows: `cargo test` `proto` на MSVC (ECDSA `aws-lc-rs`) идёт только в задании `standalone-windows-build`; шаг bash на `windows-latest` с путём `apps/standalone/target/release/markiro-host.exe` не запускался (контракт проверяет текст шага, не его работу).
- Шаг владельца: команды `openssl genpkey … -pkeyopt ec_paramgen_curve:prime256v1` на машине владельца (LibreSSL macOS или OpenSSL 3) и перевод PEM в JWK не запускались; открытые JWK производства в сборке ещё не проверялись ни одной лицензией (её выпустит ЛЦ-0).
- WebCrypto в WebView2: проверка домена в webview автонома в ЛЦ-1 не вызывается (появится в ЛЦ-3/ОБН-2, если понадобится).
- eslint на новых файлах, тест API, тест контрактов платформы и тесты хоста в настоящем крейте при написании не запускались (только в черновой копии без eslint).
- Совместимость с будущими данными облака: что `org_profiles.inn` и `planVersionId` облака проходят строгие формы (UUID в нижнем регистре, ИНН 10/12 цифр) — проверит ЛЦ-0 на настоящих данных.

## Отклонения при исполнении

Исполнено 2026-10-13 в ветке `claude/exec-lc1` (от `claude/integration` `39599103f`).

- **О1 — `tenantId` и `siteId` не UUID (решение владельца 2026-10-13, пришло во время исполнения).**
  Контрагент выбирает идентификатор сам: строка 1–64 знака `[A-Za-z0-9._:-]`, регистр значим, без
  обрезки и приведения регистра. Домен: `STANDALONE_OPAQUE_ID_PATTERN` и `standaloneOpaqueIdSchema`
  (переэкспорт в `@markiro/platform-contracts`, имена согласованы с исполнителем ЛЦ-0); Rust:
  `trust::is_opaque_id`. `licenseId`, `planVersionId`, `replaces`, `hostId` остаются UUID (привязка к
  хосту не ослаблена). Фикстуры: `tenantId` подписанных файлов — `Zq4bL0x9cabinetTenant01` (не UUID), в
  `schema-cases.json` вместо «a nil tenant id» — 27 случаев (пустой, 65 знаков, пробелы, NUL, табуляция,
  перевод строки, `/`, `\`, кириллический двойник, полноширинная буква, ZWSP, NBSP, число, `null`,
  отсутствие; UUID, nil-UUID, 64 знака, верхний регистр — допустимы) и «a nil host id» (nil остаётся
  отказом для UUID-полей). §4.2 спецификации исправлен.
- **О2 — ревью задач 1–6 (свежий рецензент opus), исправлено одним коммитом `24c06186c`:**
  домен принимал `__proto__` в заголовке и нагрузке и одиночный суррогат (Rust — нет): добавлен
  `parseJsonStrict` (и `isWellFormedText`), им читаются заголовок и нагрузка; `signCompactJws`
  подписывает только то, что прочтут проверки (неверный `kid`, `undefined`, суррогат, `__proto__` —
  исключение). Общие подписанные враждебные фикстуры (12 новых `.jws`, `expectations.json` с
  необязательным `retiredKids`); подпись с высоким S принимают обе стороны — закреплено. Пределы
  16/64 КиБ теперь убивает фикстура (корректный файл больше предела с неизвестным `kid`): «выживший по
  замыслу» мутант задачи 7 больше не выживает. «Простой текст» отвергает ещё C1, U+2028/2029 и
  двунаправленные управляющие знаки (обе стороны, новые случаи `schema-cases.json`, в том числе
  150/151 астральных знаков). Origin набора ключей — ровно `https://хост[:порт]`. Модульный тест
  `trust` ловит тестовый ключ под любым `kid` и тестовый origin в производственных наборах (не только
  префикс `test-`). Тест источника API принимает и другие имена в импорте домена.
  Не исправлено (Minor, записано): время — только форма, без календаря (обе стороны одинаково);
  `usable()` в `verifyCompactJws` отдельным тестом не закреплён — подменные JWK всё равно отвергает
  `importKey`, исход тот же (`unknown_key`); отсутствующий ключ `origin` у набора читается как `null`.
- **О3 — сообщение о предупреждении в `test-private-keys.json`:** «Private test keys … published on
  purpose» вместо «Public test keys» (файл держит закрытые тестовые ключи).
- **О4 — `apps/standalone/proto/src/lib.rs`:** между `cloud_import` и `pairing` теперь `code_search`;
  `pub mod trust;` добавлен после `pairing`.
- **О5 — мутанты, выживающие по замыслу:** снятие сверки `URL_SAFE_NO_PAD.encode(&bytes) == segment` в
  Rust (крейт `base64` 0.22 сам отвергает ненулевые хвостовые биты и `=`) — подтверждено прогоном.
- **О6 — подпись коммитов:** `Co-Authored-By: Claude Opus 5.5` (как требует план); правило
  исполнителя называло Sonnet 5.5, а работу выполнял Opus 5.5.
- **Шаг владельца не выполнен (и не выполняется агентом):** ключ лицензий и ключ выпусков, открытые
  JWK в `apps/standalone/proto/fixtures/trust-keys.json` — задача 10, шаг 4. До него производственные
  наборы пусты: сборка выпуска не доверяет ни одной лицензии и ни одному манифесту.
