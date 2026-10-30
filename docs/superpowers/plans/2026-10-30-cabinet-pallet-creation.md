# Создание палета в офисе Автонома Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Создать складской палет из введённых или импортированных кодов коробов и дать ему карточку и документы.

**Architecture:** React office → HostApi/session.call → локальный Rust host → SQLite warehouse_pallets. Транзакция BEGIN IMMEDIATE объединяет проверку, выдачу одного номера из общего счётчика, связи и аудит. Три независимые области после фиксации контракта выполняются параллельно: создание host, чтение/документы host, офисный интерфейс.

**Tech Stack:** React, Zod, Rust, Axum, sqlx, SQLite, @markiro/ui, @markiro/domain.

**Spec:** docs/superpowers/specs/2026-10-30-cabinet-pallet-creation-design.md

## Global Constraints

- Файл до 1 МиБ, 1000 непустых кодов, SSCC строками с ведущими нулями.
- Создание только после исправления всех ошибок, один товар, разные смены допустимы.
- Офисные роли admin/technologist; действующая сессия проверяется в транзакции.
- Только новая миграция, настоящий device_id офиса, без фиктивной смены.
- После проверки боковых штор пользователь авторизовал коммит, push и PR;
  развёртывание остаётся вне задачи.

## Review Focus

- Ответ создания потерян: повтор UUID возвращает тот же палет без второго аудита.
- Одновременное создание и сборка ТСД: один короб никогда не в двух живых палетах.
- После проверки короб стал занят: создание откатывает весь список.
- Файл повреждён или старый асинхронный ответ пришёл после редактирования: список и состояние не теряются.
- Палет расформирован: новый XML не создаётся, прежние байты и журнал остаются.

### Task 1: Создание на хосте

**Files:** host/src/routes/office_pallet_create.rs, proto/src/office_pallet_create.rs, host/migrations/0055_office_pallets.sql, host/tests/office_pallet_create.rs; server.rs, audit.rs, license/gate.rs.

**Interfaces:** POST /v1/office/warehouse-pallets/validate {codes:string[]} → {valid,productId,productName,boxes,units,errors:[{line,code,sscc,palletId}]}; POST /v1/office/warehouse-pallets {requestId,codes} → {id,sscc}. Errors code: invalid_sscc,not_box,duplicate,not_found,not_closed,disassembled,already_on_pallet,product_mismatch. Optional values serialized null. Conflicting creation returns conflict constraint pallet_codes with details.validation equal validation response. Idempotency mismatch constraint request_id.

- [x] Write host integration tests for atomic success, errors, retry, auth, license, counter and registry; run and observe red.
- [x] Add provenance/request fields and immutable single-serial SSCC block with real office device; use existing begin_write, session checks, registry_touch, audit and commit_with_revision.
- [x] Run cargo test -p markiro-host --test office_pallet_create; expect all pass.

### Task 2: Складская карточка и документы хоста

**Files:** host/src/routes/office_warehouse_detail.rs, proto/src/office_warehouse_detail.rs, host/tests/office_warehouse_detail.rs, affected disaggregation/export readers.

**Interfaces:** GET /v1/office/warehouse-pallets/{id} returns identity, source/creator, product, org, dates/counts and members with origin shift/date, removedAt and units. Reuse existing domain document shapes on client; no synthetic shift. Existing GET warehouse-pallets list includes cabinet entries and links.

- [x] Add focused failing card/membership/document/disassembly tests.
- [x] Implement consistent reads and integration with existing disaggregation/storage; agree exact detail wire shape with UI before writing both.
- [x] Run focused host tests plus warehouse/disaggregation/storage regressions.

### Task 3: Интерфейс офиса и импорт

**Files:** standalone/src/office/codes/_, src/host/api.ts, src/host/requests.ts, new src/host/office-pallet-create.ts, src/office/routes.tsx, i18n/ru.json, test/_.

**Interfaces:** Task 1 exact validate/create contract; Task 2 exact detail contract. Host calls through session.call. New warehouse card route /codes/warehouse-pallet/:id.

- [x] Write failing parser/UI tests for CSV/TXT, leading zeros, duplicates, limit, editing, network retry and one mutation at a time.
- [x] Add plus action, edit/check/create form and new card, print/export/download actions using existing domain and office file/print facilities.
- [x] Correct Russian pallet spelling in runtime office sources and shared forms without modifying snapshots or applied migrations.
- [x] Run corepack pnpm --filter @markiro/standalone test/typecheck/lint/build.

### Task 4: Интеграция и проверка

- [x] Align proto, Zod, builders and JSON fixtures; run protocol parity and route/device/license inventories.
- [x] Run cargo test --manifest-path apps/standalone/Cargo.toml --workspace and affected domain checks; keep logs and report infrastructure limits.
- [x] Exercise browser scenario locally where supported; do not claim Windows/hardware printing from DOM or host tests.
- [x] Review complete changes with fresh reviewer, fix material findings with regression tests; run git diff --check and format check.
- [x] Keep plan ledger and list automated/manual/unrun checks in completion report.

## Completion record

Implemented in the managed worktree on `codex/office-pallet-creation`. The user
approved the side drawers and requested a PR after the local review. Deployment
is outside this task. Initial full verification: standalone 8701, domain 1508, Rust
workspace 2775 plus final focused host 47, release contracts 104; all passed.
Intentional skips: standalone 3 and Rust 12. Typecheck/lint/build, changed-file
formatting, Rust format and whitespace checks passed. Browser coverage used
real components with controlled API answers; Windows and physical printing
remain external. No local Graphify graph exists in this fresh worktree, so its
conditional incremental update does not apply.

The final interface uses `EntityDrawer` for creation and `SidePanel` for pallet
documents, with the shared `FileDropZone`. Focused drawer/import tests: 47 passed.
Browser checks at 1280×720 and 390×700 confirmed that the body scrolls while the
footer stays visible. Before publishing the PR, the complete rerun passed: standalone 8704 (3 skipped),
domain 1508, Rust workspace 2776 (12 ignored). The whole repository format check
passed. Focused API consumer tests passed 16 and skipped 24 PostgreSQL e2e cases
without the required test environment; only their corrected document-title and
filename expectations changed.
