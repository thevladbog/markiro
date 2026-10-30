# Handheld Pack Disassembly Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Расформирование любых локальных упаковок площадки по SSCC с ТСД Автонома.

**Architecture:** Новые device lookup/apply используют общие правила дезагрегации и
создают обычный проведённый документ с отдельной идентичностью оператора/устройства.
Android сохраняет подтверждённый запрос до отправки и повторяет его с тем же UUID.

**Tech Stack:** Rust/Axum/sqlx SQLite; Kotlin/Room/Hilt/Compose.

**Spec:** `docs/superpowers/specs/2026-10-30-handheld-pack-disassembly-design.md`

## Global Constraints

- Только Автоном; существующие облачные и офлайн-сценарии не меняются.
- Живой handheld и активный оператор проверяются под блокировкой записи.
- Тот же snapshot token, тот же requestId/body при повторах; успех после ответа хоста.
- Использовать обычный документ, общие правила, историю и code releases.
- Коммит, push, PR и проверка CI разрешены владельцем 30.10.2026; merge и релиз не запрошены.

## Review Focus

- Палет офиса/другого ТСД; исторические связи и действующие короба сохраняются.
- Одновременный офисный apply/изменение состава: старый token отказывается без записи.
- Отзыв устройства, оператора, dataset reset или restore между чтением и записью.
- Неопределённый результат переживает процесс и не становится новым запросом.
- Миграция сохраняет дочерние rowid и точные байты существующих документов.

### Task 1: Device authors on regular disaggregation documents

**Files:** `host/migrations/0057_device_disaggregation.sql`, `host/src/routes/disaggregation.rs`,
`host/src/routes/office_disaggregation_reports.rs`, читатели карточек/истории и их тесты.

- [x] Написать тест миграции существующего документа с дочерними строками и выгрузками.
- [x] Увидеть отказ нового device-автора на старой схеме.
- [x] Перестроить заголовки с отложенными FK и отдельными device/operator FK.
- [x] Обновить SQL читателей: офисный пользователь либо оператор + имя ТСД.
- [x] Проверить миграцию и существующие office/disaggregation suites.

### Task 2: Idempotent lookup/apply host boundary

**Files:** `proto/src/device_disaggregation.rs`, fixtures/tests;
`host/src/routes/device_disaggregation.rs`, `server.rs`, `routes/mod.rs`, host tests.

**Interfaces:** `POST /v1/device/disaggregation/lookup {sscc,operatorId}` →
`{sscc,kind,productName,boxes,units,status,token,reasons:[{id,name}]}`.
`POST /v1/device/disaggregation/apply {requestId,sscc,operatorId,reasonId,expectedToken}` →
`{documentId,docNo,sscc,kind,boxes,codes,appliedAt}`.

- [x] RED: чужие устройства/офисный палет, короб, production pallet, фактический аудит.
- [x] Общий resolve/snapshot; только local/native, без demo и cloud history.
- [x] Под write lock проверить credential, operator, restore/license, reason, snapshot.
- [x] Создать заголовок/строку, вызвать apply_targets, audit + revision одной транзакцией.
- [x] Повторы, конфликт UUID, изменённый token, inactive/revoked/restore отказы без записи.
- [x] GREEN: focused host, office cards/reports/feed, proto fixtures.

### Task 3: Android durable request and scanner flow

**Files:** `core/network/host/HostApi.kt`, DTO;
`core/host/HostPackDisassembly.kt`, `feature/disassembly/*`, `AppNavigation.kt`,
`feature/hub/*`, обе strings.xml; соответствующие network/storage/ViewModel/Compose tests.

- [x] RED: protocol fixture decoding and canonical request retries.
- [x] RED: lookup → reason → confirmation; no retarget on scan; double tap once.
- [x] Сохранить запрос с identity/generation до сети; загрузить на повторном входе;
      definite отказ удаляет только своё намерение, transport/unknown сохраняет его.
- [x] После успеха обновить складской реестр и локальные mirror упаковок; не менять
      непринятые локальные факты и не скрывать их конфликт при последующей синхронизации.
- [x] Пункт «Расформирование» только для host, поля/сообщения/кнопки RU/EN, 360 dp.
- [x] GREEN: focused Android tests, затем testDebugUnitTest lintDebug assembleDebug.

### Task 4: Integration, documentation and review

- [x] Проверить через emulator/debug harness при доступности; иначе записать границу.
- [x] Обновить scoped guides и README с маршрутом и ограничением связи.
- [x] Прогнать host workspace и affected standalone checks, формат и diff --check.
- [x] Свежий обзор ветки по acceptance и failure cases, исправить важные замечания.
- [x] Итог: поведение, проверки, APK/снимки и отдельная аппаратная приёмка.

## Execution ledger

- Task 1 RED: новый device-author INSERT отказан отсутствующим `device_id`.
  GREEN: actor/card/act и миграция с сохранением line/release rowids и bytes.
- Task 2 RED: device lookup отсутствовал (404). GREEN: 7 host tests, включая
  чужой короб, production/office палеты, повторы и отсутствие частичной записи.
- Ruling: `createdBy`/`appliedBy` остаются только офисными FK; для документа ТСД
  `createdBy=null`, новые `createdByDeviceId`/`createdByOperatorId` передают автора.
  Имена выводит общий SQL view. Старые офисные документы сериализуются как раньше.
- Ruling: расформирование — исправление существующих фактов, как в офисе; новые
  маршруты относятся к license NEVER, не блокируются истечением лицензии.
- Ruling: неизвестное намерение при dataset reset сохраняется как opaque meta
  evidence вместе со старым owner/generation/epoch. Оно не перепривязывается.
  Экран требует проверки в офисе и явного архивирования; архивные записи остаются
  при последующих reset. Новые операции никогда не повторяют старое намерение.
- Android checks запускаются последовательно. Два ранних параллельных запуска
  столкнулись в Hilt outputs; выполнен штатный `gradlew clean` перед повтором.

- Task 3 RED/GREEN: exact-body retry after real Room reopen, dataset reset,
  stale inspection after rekey, late 401 from the old generation, unreadable
  intent, operator change and scanner/double-tap isolation. Compose checks cover
  RU/EN, light/dark and 360 dp; long reasons use the existing adaptive ActionRow.
- Fresh builder/spec review and branch review completed. Addressed both branch
  findings: inspection keeps its original binding; confirmed success updates
  local registry/box/pallet mirrors before best-effort refresh.
- Native manual check: fresh isolated Android 36 emulator, final debug APK and
  a real local host upgraded from schema 56 to 57 on synthetic instruction data.
  Paired normally, signed in with the synthetic operator badge, scanned the
  office-created pallet, selected a reason, confirmed, then disassembled its box.
  DSG-26-0004/0005 are applied and readable in the office. Pallet preserved one
  box and 12 codes; box released all 12. Exact device/operator audit and report
  data checked. Re-scan of the retired box refuses without another document.
  Native screenshots are under ignored `.playwright-mcp/handheld-disassembly/`.
- Office gates: 8705 tests pass, 3 existing tests skipped; typecheck, lint,
  production build and repository Prettier check pass. The full run exposed a
  delayed scheduler callback after teardown in the late-effects test fixture;
  the fixture now cancels both owned timer stages. Assertions and the deliberate
  25 ms test delay are unchanged. Focused late-effects tests and full rerun pass.
- Cargo full run exposed an indexed-card regression: LEFT JOIN of the author
  view materialized all documents. EXPLAIN reproduces the table scan. The view
  has exactly one row per header, so INNER JOIN preserves semantics and flattens
  the indexed lookup. All 36 device/card/report tests pass after correction,
  including the original strict no-SCAN assertion.
- Android full gate after the first spelling pass: 1609 tests, no failures or
  skips; lintDebug and assembleDebug pass. Final resource concordance is verified by a focused screen rerun. The first earlier green run logged a background SQLite open diagnostic
  from InventoryBundleMirrorTest; no such diagnostic in the next full run.
- Not performed: physical terminal/vendor scanner, printer, Windows host service,
  remote CI, release/deployment. Emulator/debug scans do not establish those.
  At that implementation checkpoint no commit, push or new PR had been performed;
  the owner subsequently authorized PR creation and CI verification.

- Final workspace accounting: 2783 Rust tests passed, 12 intentionally ignored;
  the sole failure was the indexed-card regression described above (now fixed,
  all 36 affected tests pass). The whole workspace was not rerun after that
  two-query correction. Ignored gates require a dedicated migrated PostgreSQL,
  live OAuth, a million-row benchmark or explicitly opted-in spawned/load tests.
- Office skips: two optional Chromium layout suites require PLAYWRIGHT_CORE;
  PostgreSQL-to-office acceptance requires STANDALONE_HISTORY_ACCEPTANCE_OUT.
  They were not enabled. Native Android was checked separately, as above.
- Full Android gate after resource gender/concordance cleanup also passed:
  1609 tests, zero failures/errors/skips, assembleDebug and lintDebug successful.
  Final singular/plural wording uses «палет/палетов»; old stored audit payloads
  are not rewritten. A final focused screen check covers the last copy edits.
- Temporary emulator and synthetic local host stopped. Test data and screenshots
  retained; original user emulators and production were not touched.

- Final copy-only rerun: 22 affected Compose screen tests pass, zero failures or
  skips; final assembleDebug and lintDebug pass. Repository format:check,
  Cargo fmt --check and git diff --check pass. Implementation remains local.

- PR preparation: owner explicitly authorized commit/push/PR and CI verification.
  Synced the task branch to origin/main (3732cb034, merged online updates #839)
  with all task changes preserved and no conflicts. Full Rust workspace and
  standalone app gates rerun on this combined tree. A draft PR starts remote CI
  alongside the remaining local Rust tests; mark ready after successful gates.

- Latest-main app gate: 8722 tests pass, 3 intentional environment-dependent skips;
  standalone typecheck, lint and production build pass. No implementation files
  changed during this verification. The task diff is 60 explicit files; the
  previously merged online-update work is excluded from the PR range.
