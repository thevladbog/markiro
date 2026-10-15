# Исполнение плана ЛЦ-0 (облако: экспорт офлайн-лицензии автонома)

Ветка `claude/exec-lc0` (worktree `/tmp/claude/wt/exec-lc0`), основа `claude/integration`; влиты
`claude/exec-lc1` (до ревью-правок) и затем `claude/integration` с ЛЦ-1 (`34b30449b`). Не запушено,
в `claude/integration` не влито.

## Решения владельца, пришедшие во время исполнения (реализованы)

- **Р1 — офлайн-лицензия клиенту без кабинета.** Клиент с `cabinet_access = 'none'` получает файл по
  офлайн-условиям из раздела «Офлайн» диалога выпуска: опубликованная версия тарифа каталога (квоты и
  возможности тарифа; `null` — «выключено» с подсветкой) и срок 1–365 дней от выпуска, бессрочно
  нельзя. В файле `plan: subscription`, `entitlementRevision: "0"`, причина срока `offline_term`,
  льгота по умолчанию 14. Облако не трогается (e2e проверяет: подписки, дополнения, источники и ревизии
  прав, участники, приглашения, устройства, назначения — пусто, `cabinet_access` остаётся `none`).
  Аудит `standalone_license.issued` с `after.source = "offline"` и `after.offlineTerms` проверяется
  точно. Возможность та же: `standaloneLicenses.manage` (только `platform_admin`). Отказы:
  `409 standalone_license_offline_not_allowed` (у клиента есть кабинет),
  `409 standalone_license_offline_terms_required`, `409 standalone_license_offline_plan_unavailable`.
  Клиент с кабинетом — путь из подписки как в плане; без подписки — по-прежнему
  `standalone_license_subscription_required`. Путь решает `cabinet_access`, запись держит его
  `FOR SHARE`; выдача кабинета между предпросмотром и подтверждением — отказ (тест).
- **Р2 — `tenantId` не UUID.** С exec-lc1 согласовано: в файле `tenantId` и `siteId` —
  `^[A-Za-z0-9._:-]{1,64}$` (`STANDALONE_OPAQUE_ID_PATTERN`, `standaloneOpaqueIdSchema` из ЛЦ-1).
  Маршруты ЛЦ-0 проверяют `tenantId` этим правилом и отвечают `400` до базы; тесты на пустой, 65 знаков,
  пробел, NUL, перевод строки, `/`, кириллическую «е», полноширинную букву, U+202E. Отказ
  `standalone_license_tenant_id_unsupported` удалён; e2e выпускает файл клиенту `Zq4b…` и проверяет его
  доменной проверкой.
- **Р3 — подписка без даты окончания:** файл на год; фраза «клиент бесплатно запрашивает у нас новый
  файл» — в подсказке выпуска (`one_year_cap`), памятке, примечании §9.7 и строке ЛО8 спецификации.

## Что сделано по задачам

| Задача                | Коммит                          | Суть                                                                                                                                                                                                                                                        |
| --------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2 БД                  | `139e61ef0`, правка `f0cc82a5e` | `standalone_sites`, `standalone_license_issuances` (+ колонка `source`, проверки офлайн ⇔ `offline_term`, интервал ≤ 365 дней, `issued_at = valid_from`); миграция `0186_standalone_licenses` (drizzle-kit, просмотрена: только две таблицы, ключи, индекс) |
| 1 Контракты           | `bb04cf35e`                     | возможность, схемы; плюс `source`, `offline`, `issuanceSource`, `offline_term`; позже `termsDigest` в ожидании                                                                                                                                              |
| 3 Подписант           | `79a64c03c`                     | `signCompactJws` вынесен; гранты байт-в-байт (тест заголовка и `verifyGrant`)                                                                                                                                                                               |
| 4 Окружение           | `567fce136`                     | `STANDALONE_LICENSE_*`, проверка при старте, запрет ключа грантов, группа Lockbox                                                                                                                                                                           |
| 5 Права и срок        | `7b5f97e3d`                     | + `exportPlanRights`, `offlineValidity`                                                                                                                                                                                                                     |
| 6 ИНН                 | `c9b25cd44`                     | как в плане (позже две правки, см. отклонения)                                                                                                                                                                                                              |
| 7 Площадки            | `f5a3d7a3d`, `f0cc82a5e`        | сервис, аудит, изоляция; правки ревью                                                                                                                                                                                                                       |
| 8 Выпуск              | `0b700abd1`, `69384c78d`        | предпросмотр/подтверждение, оба пути, `termsDigest`                                                                                                                                                                                                         |
| 9 Маршруты            | `6aa63657f`                     | контроллер, модуль, реестр, OpenAPI, инвентарь; `tenantId` по правилу Р2                                                                                                                                                                                    |
| 10 Панель             | `dba4dffea`                     | список, фаза словом, напоминание, история, загрузка `.mklic`, отметка «клиент без кабинета»                                                                                                                                                                 |
| 11 Диалоги            | `b27ce42ed`                     | регистрация по запросу активации; выпуск с разделом «Офлайн» (тариф + срок)                                                                                                                                                                                 |
| 12 Браузер, документы | `8daad5928`                     | фикстура и сценарий `tenant-equipment`, памятка `docs/operations/standalone-licenses.md`, спецификация §6.2/§9.7/§14 ЛО8/§15/§24                                                                                                                            |
| Документы плана       | `ea5f4697c`                     | раздел «Решения владельца… Р1–Р3», «Отклонения при исполнении»                                                                                                                                                                                              |
| Итоговое ревью        | `6fab0963f`                     | правки итогового ревью                                                                                                                                                                                                                                      |

Ревью: три независимых (opus) — задачи 1–7, задача 8, весь план. Критичных замечаний нет; все важные
исправлены, кроме номера миграции (см. открытые вопросы).

## Тесты и результаты

- `@markiro/platform-contracts`: 399 passed; typecheck, lint, build — зелёные.
- `@markiro/db` (одноразовый Postgres 17 в Docker на 127.0.0.1:55471, не общая база): 686 passed,
  миграция применена `db:migrate`; typecheck, lint, build — зелёные.
- `@markiro/domain`: 1417 passed.
- API, фокусные: `standalone-sites.e2e` + `standalone-license-issuance.e2e` +
  `standalone-license-rights` — 40 passed на базе; `standalone-inn-check`, `standalone-license-keyset`,
  `compact-jws-signing`, `platform-standalone-licenses.routes`, `platform-contract-openapi`,
  `subscription-route-inventory`, `openapi-coverage`, `env`, `env-example`, гранты
  (`device-grants-keyset`, `-issuer`, `device-grant-client-readiness`) — зелёные. typecheck, lint, build
  API — зелёные.
- API, весь пакет (последний прогон после всех правок): 4907 passed, 115 skipped (DB есть; пропуски —
  тесты, требующие SMTP/объектного хранилища/внешних сервисов), 5 failed: 2 в `signer-agents.e2e`
  (нет `CHZ_TOKEN_ENCRYPTION_KEY`; так же падает на `claude/integration`) и 3 тайм-аута 5 с под
  нагрузкой (`billing-acts.service`, `exchange-entitlement-admission`,
  `national-catalog-import-http.e2e`) — отдельно все 39 зелёные. Необработанных ошибок нет. В первом
  полном прогоне так же по тайм-ауту падали `platform-contract-openapi` (отдельно 1,1 с и на ветке, и на
  основе) и `inventories.e2e` (отдельно зелёный).
- SaaS-админка, фокусные (`standalone-api`, `standalone-sites-panel`, `standalone-license-flows`,
  `tenant-detail`, `device-licensing`): зелёные, без `stderr`; typecheck, lint, build — зелёные. Весь
  пакет под нагрузкой машины (load average 25–40 от других агентов) даёт тайм-ауты 5 с в
  `catalog`, `entitlements-navigation`, `document-composer`, `recurring-service-catalog`,
  `reports-page`; те же файлы падают так же на `claude/integration` — к изменениям не относится.
- `tools/production-browser` `tenant-equipment` (Chromium, `vite preview`): 29 passed — панель в двух
  языках на 1440 и 390 px, без переполнения страницы; скриншоты просмотрены глазами (1440 ru, 390 ru).
- `pnpm test:production-bundle:contract`: 580 passed после задачи 4; последний прогон — 579 passed,
  1 cancelled по времени (`smoke-route-table`, `deploy/production` не менялся; отдельно 94/94). `deploy/yandex` runtime-env: 23 passed.
  `no-private-keys` (ЛЦ-1): 2 passed — ключей в ветке нет, тесты генерируют пары на лету.
- prettier --check затронутых файлов, `git diff --check claude/integration...HEAD` — чисто.
- Мутации — в «Отклонениях при исполнении» плана (все значимые убиты; эквивалентные названы).

## Отклонения (подробно — в плане, раздел «Отклонения при исполнении»)

- Основа без ЛЦ-1 на старте; ЛЦ-1 влит из `claude/exec-lc1`, затем из `claude/integration`.
- Ожидание предпросмотра дополнено `termsDigest` (иначе подтверждение подписывало другой льготный
  срок, хост после перепривязки, имя клиента и офлайн-условия).
- Имя клиента — очистка по `isPlainText` ЛЦ-1 и обрезка до 300 единиц UTF-16.
- `org_inn_missing` не выдаётся при верном ИНН платёжного профиля; неверный ИНН пробного периода
  предупреждает всегда (тесты задачи 6 изменены соответственно).
- Тесты плана с ошибками исправлены (гонка загрузки в тесте панели; путь фикстуры в jsdom).
- `.standalone-sites-panel { min-width: 0 }` — без него вкладка «Оборудование» переполнялась на 390 px.
- Строка соавторства — `Claude Opus 5.5` (исполнитель — Opus; бриф называл Sonnet).
- `graphify update .` не запускался: в worktree нет `graphify-out`.

## Не проверено

- Что файл API принимает Rust-проверка хоста (`markiro_proto::trust`) — проверено только доменной
  `verifyStandaloneLicense` (TS); доказывает ЛЦ-2.
- Настоящий ключ в Yandex Lockbox, деплой, миграция на продовой базе.
- Загрузка `.mklic` в настоящем браузере (`<a download>`) — только jsdom; Playwright не скачивает.
- Гонка выдачи кабинета с подтверждением под `FOR SHARE` — проверен только последовательный случай.
- Windows/железо — не относится (облачная часть).

## Открытые вопросы владельцу и контроллеру

1. **Номер миграции:** `0186` — следующий в `claude/integration`, но в `origin/main` уже `0186`–`0191`.
   При переносе на `main` миграцию надо перенумеровать (drizzle-kit) и пересоздать снимок.
2. Квоты офлайн-лицензии берутся ровно из тарифа каталога; ручной поправки квот (например, «3 станции
   вместо 2») нет — если нужна, это отдельное решение (дополнения или поле в офлайн-условиях).
3. Офлайн-файл со сроком ≤ 30 дней сразу помечается «Пора продлить» (общее правило напоминания).
4. `signer-agents.e2e` падает в этом окружении (нет `CHZ_TOKEN_ENCRYPTION_KEY` в `.env.example`) — так
   же на `claude/integration`; к ЛЦ-0 не относится.
