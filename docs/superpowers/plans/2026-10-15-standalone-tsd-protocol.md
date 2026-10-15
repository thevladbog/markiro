# План ТСД-П: протокол хоста для ТСД — версия 6, типы, фикстуры и паритет TypeScript ↔ Rust ↔ Kotlin, постоянный адрес хоста в мастере — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Протокол хоста автонома (`apps/standalone/proto`) учится говорить с ТСД, и каждое правило, которое
приложение ТСД на Kotlin обязано читать так же, как хост и webview, получает общий файл-фикстуру. После плана:

- `PROTOCOL_VERSION` равна 6, `MIN_PROTOCOL_VERSION` остаётся 1, `hello-future.json` стоит на 7;
- возможность `handheld-host-v1` названа константой `shift_supports::HANDHELD_HOST` (ТСД объявляет её при
  сопряжении и на каждом входе в смену);
- в `proto` есть типы складских паллет (`PalletEventRecord` и данные пяти видов записей), реестра коробов
  (`BoxRegistryPage`), печати организации (`OrgPrint`), списка складских паллет офиса
  (`OfficeWarehousePallets`) и адреса хоста (`HostNetwork`); `ClaimRequest` получает `recoverDeviceId`,
  `BootstrapRequest` — `addressConfirmed`; к кодам квитанций добавлены семь новых;
- каждый новый тип пересекает границу через фикстуру в `proto/fixtures`, которую разбирают тесты Rust, а для
  типов офиса и мастера — Zod-зеркало и Vitest; фикстуры для Kotlin (`fingerprint.json`, `pairing-payloads.json`,
  `compatibility.json`) закреплены тестами Rust и Vitest, чтобы приложение читало их теми же ответами;
- `tools/ci/affected.mjs` запускает job `handheld_android` при правке `apps/standalone/proto/fixtures/**`;
- мастер установки получает шаг «Адрес хоста» (предупреждение и отметка «я зарезервировал адрес», установку не
  блокирует), хост — команду `markiro-host address-check`, маршруты `GET|PUT /v1/office/host-network` и плашку
  офиса «Адрес хоста может измениться».

**Architecture:**

- Новые типы живут в новом модуле `proto/src/handheld.rs` и реэкспортируются из корня крейта
  (`pub use handheld::*`), как остальные типы протокола; перечисления читаются `parse_variant` (набор имён живёт
  только в derive).
- Запросы хоста (`PalletEventBatch`, данные записей, `ClaimRequest`, `BootstrapRequest`) строгие
  (`deny_unknown_fields`), ответы (`BoxRegistryPage`, `OrgPrint`, `OfficeWarehousePallets`, `HostNetwork`)
  терпят неизвестные поля.
- Фикстуры — единственный источник ответов для Kotlin: в `apps/handheld/app/build.gradle.kts` к тестовым
  ресурсам добавляется `../../standalone/proto/fixtures` (план ТСД-А, С1); этот план только создаёт файлы и
  закрепляет их тестами Rust и Vitest.
- Постоянный адрес: миграция `0039_host_address.sql` (`site.address_confirmed_at`), модуль `address_check.rs` по
  образцу `network_profile.rs` (PowerShell через `Commands`, проверка на подставном шелле), команда
  `address-check` с кодом выхода 5 при адресе по DHCP, NSIS-подсказка, офисная плашка.

**Tech Stack:** Rust (serde, serde_json, sqlx на SQLite), `markiro-proto`, `markiro-host`; TypeScript 6 strict,
zod 4, Vitest 4, React 19, `@markiro/ui`; Node `node:test` для `tools/ci`.

**Спецификация:** `docs/superpowers/specs/2026-10-15-standalone-handheld-on-host-design.md` (разделы 6.4–6.6, 7, 9.1,
15 потоки П и Х7, решения владельца В-2, В-6). План хоста: `2026-10-15-standalone-tsd-host.md` (порядок трёх планов
— в его начале). План Android: `2026-10-15-standalone-tsd-android.md`.

## Global Constraints

- Рабочее дерево: `git -C /tmp/claude/wt/integ worktree add /tmp/claude/wt/tsd-proto -b claude/tsd-proto claude/integration`,
  зависимости по `docs/standalone/ledger/agent-rules.md`; дальше `WT=/tmp/claude/wt/tsd-proto`. Не `cd`, только
  абсолютные пути; без `git stash` и push.
- Cargo: `cargo --offline --locked --manifest-path "$WT/apps/standalone/Cargo.toml" ...`. Vitest:
  `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/<файл>`.
  Узловые тесты: `node --test "$WT/tools/ci/test/affected.test.mjs"`.
- Поле провода — в `proto`, Zod (если пересекает IPC) и фикстуре одновременно; фикстуру не правят руками, чтобы
  скрыть расхождение: исправляют сторону, которая отстала.
- Правило AGENTS.md о версии протокола: новый вид записи или новое поле `data` поднимает её. Здесь это ровно
  `PROTOCOL_VERSION` 5 → 6 (новый канал событий и новые маршруты); поле ответа без новой версии не поднимает.
- Тест, который утверждал «текущая версия 5» или «хост протокола 6 из будущего», меняется явно и называется в
  отчёте; ослаблять проверки ради зелёного запрещено.
- Коммит: явные пути, одна строка `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Гейты плана: `cargo test -p markiro-proto -p markiro-host`, `cargo fmt --check`,
  `cargo clippy -p markiro-proto -p markiro-host --all-targets -- -D warnings`, Vitest пакета
  `@markiro/standalone`, `typecheck`, `lint`, `prettier --check`, `git diff --check`, `node --test` для `tools/ci`.

## Что проверено по коду ветки `claude/integration` (`598627c66`, база спецификации)

- `PROTOCOL_VERSION` = 5 (`proto/src/lib.rs`), в TypeScript `PROTOCOL_VERSION = 5` (`src/host/protocol.ts`) и
  два теста `expect(PROTOCOL_VERSION).toBe(5)` (`test/protocol.test.ts`, строки ≈531 и ≈3423).
- `hello-future.json` сейчас на протоколе 6 с `minProtocol` 3; тест `envelope_decides_compatibility_before_the_rest`
  требует, чтобы он оставался впереди версии сборки, поэтому его поднимают на 7 одновременно с версией.
- `receipt_codes::ALL` и `fact-receipt-codes.json` связаны тестом (`fixtures.rs`, ≈1248), Zod-список
  `FACT_RECEIPT_CODES` — тестом Vitest (`protocol.test.ts`, ≈2787).
- `ClaimRequest` строится в `src-tauri/src/device.rs` (≈351) литералом; `BootstrapRequest` литералом нигде не
  строится (оболочка пересобирает его из JSON).
- В Rust нет разбора нагрузки DataMatrix (хост её только строит: `pairing_code::payload`); разбор есть в
  TypeScript (`src/host/pairing-code.ts`, `parsePairingPayload`). Общие случаи нагрузки поэтому читают TypeScript
  (`parsePairingPayload`), Kotlin и Rust-тест сборки нагрузки.
- `affected.mjs` отправляет `apps/standalone/proto/fixtures/**` в задачи `verify_static`, `standalone_*`, но не в
  `handheld_android`; `tools/ci/test/affected.test.mjs` закрепляет текущий список для `hello.json`.
- Мастер (`BootstrapWizard.tsx`) состоит из пяти шагов (`WIZARD_STEPS`); фразы «Шаг N из 5» стоят в
  `test/wizard.test.tsx`, `test/app.test.tsx`, `test/support/wizard.ts`.

## Task П1: версия 6, типы ТСД в `proto`, новые коды квитанций, фикстуры и тесты Rust

**Files:**

- Create: `apps/standalone/proto/src/handheld.rs`
- Modify: `apps/standalone/proto/src/lib.rs` (`PROTOCOL_VERSION`, документ над ней, `receipt_codes`, `shift_supports`, `ClaimRequest`, `pub mod handheld; pub use handheld::*;`)
- Modify: `apps/standalone/src-tauri/src/device.rs` (литерал `ClaimRequest`: `recover_device_id: None`)
- Create (фикстуры в `apps/standalone/proto/fixtures/`): `pallet-events-request.json`, `pallet-events-response.json`,
  `box-registry-page.json`, `box-registry-last-page.json`, `org-print.json`, `org-print-bundled.json`,
  `claim-request-handheld.json`, `claim-request-recover.json`, `pairing-code-device.json`,
  `office-warehouse-pallets.json`, `shift-enter-handheld.json`
- Modify (фикстуры): `fact-receipt-codes.json`, `hello.json` (протокол 6), `hello-restored.json` (протокол 6), `hello-future.json` (протокол 7)
- Test: `apps/standalone/proto/tests/fixtures.rs`

**Interfaces:**

- Consumes: существующие `FactReceipt`, `FactReceipts`, `LabelOutcome`, `ShiftSnapshotLogo`, `parse_variant`, `UnknownVariant`, `ShiftEnter`.
- Produces (корень крейта `markiro_proto`): `PalletEventKind` (+ `as_str`, `FromStr`), `PalletEventRecord`,
  `PalletEventBatch`, `WarehousePalletOpenedData`, `PalletBoxAddedData`, `PalletBoxRemovedData`,
  `WarehousePalletClosedData`, `WarehousePalletLabelData`, `BoxRegistryKind`, `BoxRegistryItem`
  (+ `BoxRegistryItem::remove`), `BoxRegistryPage`, `OrgPrint`, `OfficeWarehousePallet`, `OfficeWarehousePallets`;
  `shift_supports::HANDHELD_HOST`; `receipt_codes::{BOX_NOT_FOUND, BOX_NOT_CLOSED, BOX_ON_PALLET, PRODUCT_MISMATCH,
PALLET_NOT_OPEN, PALLET_COUNT_MISMATCH, FEATURE_DISABLED}`; `ClaimRequest.recover_device_id`. Задачи плана хоста
  Х2–Х6 потребляют именно эти имена.

Решения, которых нет в спецификации:

- Элемент реестра коробов несёт поля облачного `BoxRegistryItemDto` приложения (`kind` = `upsert`/`remove`,
  `boxId`, `productId`, `bottleCount`, `palletId`, `palletSscc`, `palletActive`, `closedAt`, `productionDate`), а не
  усечённую форму раздела 6.5 спецификации: зеркало приложения читает их и без них не работает (план хоста, Х4).
  Полных кодов (`contentKeys`) в ответе нет никогда.
- `OrgPrint` несёт `issuerPrefix` (план хоста, Х5).
- Новый код квитанции `feature_disabled` (возможность `pallets` не включена) добавлен к шести из спецификации:
  пачка с событиями не должна падать целиком из-за одной записи.
- Событие `box_on_pallet` — `rejected` с `details.palletSscc` (`null`, пока та паллета открыта) и `details.palletId`.

- [ ] **Step 1: написать падающие тесты Rust.** В начало `proto/tests/fixtures.rs` (вторым `use`, существующий список не
      трогайте) добавьте:

```rust
use markiro_proto::{
    receipt_codes, shift_supports, BoxRegistryItem, BoxRegistryKind, BoxRegistryPage,
    OfficeWarehousePallets, OrgPrint, PalletBoxAddedData, PalletBoxRemovedData, PalletEventBatch,
    PalletEventKind, WarehousePalletClosedData, WarehousePalletLabelData,
    WarehousePalletOpenedData, MIN_PROTOCOL_VERSION,
};
```

В существующем тесте `hello_ignores_fields_added_by_newer_hosts` замените `assert_eq!(hello.protocol, 6)` на
`assert_eq!(hello.protocol, 7)`; в `envelope_decides_compatibility_before_the_rest` перечень проверок заменяется на

```rust
    assert_eq!(compatibility_for(2, &future), Compatibility::AppTooOld);
    assert_eq!(compatibility_for(3, &future), Compatibility::Compatible);
    assert_eq!(compatibility_for(6, &future), Compatibility::Compatible);
    assert_eq!(compatibility_for(7, &future), Compatibility::Compatible);
    assert_eq!(compatibility_for(8, &future), Compatibility::HostTooOld);
```

(причина: `hello-future.json` обязан оставаться впереди версии сборки, а она теперь 6). Затем добавьте тесты в конец файла:

```rust
#[test]
fn this_build_speaks_protocol_six_and_the_current_hello_fixtures_say_so() {
    assert_eq!(PROTOCOL_VERSION, 6);
    assert_eq!(MIN_PROTOCOL_VERSION, 1);
    for name in ["hello.json", "hello-restored.json"] {
        let hello: Hello = serde_json::from_value(fixture(name)).unwrap();
        assert_eq!(hello.protocol, PROTOCOL_VERSION, "{name}");
        assert_eq!(hello.min_protocol, MIN_PROTOCOL_VERSION, "{name}");
    }
}

#[test]
fn a_handheld_names_the_capability_in_its_claim_and_its_entry() {
    assert_eq!(shift_supports::HANDHELD_HOST, "handheld-host-v1");
    let claim: ClaimRequest = round_trip("claim-request-handheld.json");
    assert_eq!(claim.kind, DeviceKind::Handheld);
    assert_eq!(claim.capabilities, vec![shift_supports::HANDHELD_HOST.to_owned()]);
    assert_eq!(claim.recover_device_id, None);
    let enter: markiro_proto::ShiftEnter = round_trip("shift-enter-handheld.json");
    assert_eq!(enter.supports, vec![shift_supports::HANDHELD_HOST.to_owned()]);
}

#[test]
fn a_re_pairing_claim_names_the_device_and_an_ordinary_one_names_none() {
    let recover: ClaimRequest = round_trip("claim-request-recover.json");
    assert_eq!(
        recover.recover_device_id.as_deref(),
        Some("2c1f0b7e-8a4d-4c3b-9e2f-1a0b9c8d7e6f")
    );
    let ordinary: ClaimRequest = round_trip("claim-request.json");
    assert_eq!(ordinary.recover_device_id, None);
    // The request is strict: a misspelt field is refused, not ignored.
    let mut value = fixture("claim-request-recover.json");
    value["recoverDevice"] = Value::String("x".into());
    assert!(serde_json::from_value::<ClaimRequest>(value).is_err());
}

#[test]
fn the_pallet_event_batch_holds_every_kind_with_the_data_its_kind_reads() {
    let batch: PalletEventBatch = round_trip("pallet-events-request.json");
    let kinds: Vec<_> = batch.records.iter().map(|record| record.kind).collect();
    assert_eq!(
        kinds,
        vec![
            PalletEventKind::WarehousePalletOpened,
            PalletEventKind::PalletBoxAdded,
            PalletEventKind::PalletBoxAdded,
            PalletEventKind::PalletBoxRemoved,
            PalletEventKind::WarehousePalletClosed,
            PalletEventKind::WarehousePalletLabel,
        ]
    );
    for record in &batch.records {
        let data = record.data.clone();
        match record.kind {
            PalletEventKind::WarehousePalletOpened => {
                serde_json::from_value::<WarehousePalletOpenedData>(data).unwrap();
            }
            PalletEventKind::PalletBoxAdded => {
                serde_json::from_value::<PalletBoxAddedData>(data).unwrap();
            }
            PalletEventKind::PalletBoxRemoved => {
                serde_json::from_value::<PalletBoxRemovedData>(data).unwrap();
            }
            PalletEventKind::WarehousePalletClosed => {
                let closed: WarehousePalletClosedData = serde_json::from_value(data).unwrap();
                assert_eq!((closed.serial, closed.box_count), (40, 1));
            }
            PalletEventKind::WarehousePalletLabel => {
                serde_json::from_value::<WarehousePalletLabelData>(data).unwrap();
            }
        }
    }
    // The last record carries no operator; the first carries one.
    assert!(batch.records[0].operator_id.is_some());
    assert!(batch.records[5].operator_id.is_none());
    for kind in kinds {
        assert_eq!(kind.as_str().parse::<PalletEventKind>().unwrap(), kind);
    }
    assert!("pallet_exploded".parse::<PalletEventKind>().is_err());
    // A data object with a field it does not know is refused.
    let mut data = batch.records[1].data.clone();
    data["extra"] = Value::Bool(true);
    assert!(serde_json::from_value::<PalletBoxAddedData>(data).is_err());
}

#[test]
fn the_pallet_event_receipts_are_fact_receipts_with_codes_of_the_shared_list() {
    let receipts: FactReceipts = round_trip("pallet-events-response.json");
    assert_eq!(receipts.receipts.len(), 6);
    let rejected: Vec<_> = receipts
        .receipts
        .iter()
        .filter_map(|receipt| receipt.code.as_deref())
        .collect();
    assert_eq!(
        rejected,
        vec!["box_on_pallet", "pallet_count_mismatch", "feature_disabled"]
    );
    for code in rejected {
        assert!(receipt_codes::ALL.contains(&code), "{code}");
    }
    assert_eq!(
        receipts.receipts[1].details.as_ref().map(|details| details.len()),
        None,
        "an accepted receipt has no details"
    );
}

#[test]
fn the_box_registry_page_is_a_delta_with_removals_and_the_restore_epoch() {
    let page: BoxRegistryPage = round_trip("box-registry-page.json");
    assert_eq!(page.items.len(), 3);
    assert_eq!(page.items[0].kind, BoxRegistryKind::Upsert);
    assert_eq!(page.items[0].pallet_active, Some(true));
    assert_eq!(page.items[1].pallet_id, None);
    assert_eq!(page.items[1].pallet_active, Some(false));
    // A removal carries only what names the box and when.
    assert_eq!(
        page.items[2],
        BoxRegistryItem::remove("046006820000015024".into(), "2026-10-08T07:10:00Z".into())
    );
    assert!(page.next_cursor.is_some() && page.restore_epoch.is_some());
    let last: BoxRegistryPage = round_trip("box-registry-last-page.json");
    assert!(last.next_cursor.is_none() && last.restore_epoch.is_none() && last.items.is_empty());
    // No code of a unit is in a registry item: the type has no field for one.
    let text = serde_json::to_string(&page).unwrap();
    assert!(!text.contains("contentKeys") && !text.contains("codeHash"));
}

#[test]
fn the_organization_to_print_has_a_logo_or_leaves_it_to_the_bundled_one() {
    let own: OrgPrint = round_trip("org-print.json");
    assert_eq!(own.issuer_prefix, "460068200");
    assert_eq!(own.logo.as_ref().map(|logo| (logo.width, logo.height)), Some((10, 2)));
    let bundled: OrgPrint = round_trip("org-print-bundled.json");
    assert!(bundled.logo.is_none() && bundled.inn.is_none());
}

#[test]
fn the_office_lists_warehouse_pallets_open_ones_first() {
    let list: OfficeWarehousePallets = round_trip("office-warehouse-pallets.json");
    assert_eq!(list.pallets.len(), 2);
    assert!(list.pallets[0].sscc.is_none() && list.pallets[0].closed_at.is_none());
    assert_eq!(list.pallets[1].box_count_reported, Some(40));
}

#[test]
fn a_pairing_code_made_for_a_device_has_the_shape_of_any_code() {
    let code: PairingCode = round_trip("pairing-code-device.json");
    assert_eq!(code.code.expose().len(), 10);
}

#[test]
fn the_receipt_codes_of_the_fixture_are_the_codes_of_the_crate() {
    let codes = fixture("fact-receipt-codes.json");
    let listed: Vec<&str> = codes["codes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|code| code.as_str().unwrap())
        .collect();
    assert_eq!(listed, receipt_codes::ALL);
    for new in [
        "box_not_found",
        "box_not_closed",
        "box_on_pallet",
        "product_mismatch",
        "pallet_not_open",
        "pallet_count_mismatch",
        "feature_disabled",
    ] {
        assert!(receipt_codes::ALL.contains(&new), "{new}");
    }
}
```

Второй `use` содержит только имена, которых нет в существующем списке (`ClaimRequest`, `DeviceKind`, `FactReceipts`, `Hello`,
`PairingCode`, `PROTOCOL_VERSION` и `Value` файл уже импортирует): повторный импорт того же имени — ошибка E0252.

- [ ] **Step 2: запустить, увидеть падение.**

  Run: `cargo --offline --locked --manifest-path "$WT/apps/standalone/Cargo.toml" test -p markiro-proto`
  Expected: ошибка компиляции `unresolved imports markiro_proto::PalletEventBatch, … shift_supports::HANDHELD_HOST`.

- [ ] **Step 3: типы.** `proto/src/handheld.rs`:

```rust
//! The handheld's side of the host protocol (plan ТСД-П, spec 6.4, 6.5, 7): the events of a
//! warehouse pallet outside a shift, the registry of closed boxes, the organization to print and
//! the office's list of warehouse pallets. Requests reject unknown fields and responses tolerate
//! them (`lib.rs`); each shape has a fixture in `fixtures/`.

use serde::{Deserialize, Serialize};

use crate::{parse_variant, LabelOutcome, ShiftSnapshotLogo, UnknownVariant};

/// What a record of `POST /v1/device/pallet-events` says (spec 6.4.1). The list is open: a kind
/// added later raises the protocol version, as a new fact kind does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PalletEventKind {
    /// A handheld began a pallet of one product.
    WarehousePalletOpened,
    /// A closed box went onto the open pallet.
    PalletBoxAdded,
    /// A box was taken back off the open pallet.
    PalletBoxRemoved,
    /// The pallet closed with an SSCC of the handheld's pallet block.
    WarehousePalletClosed,
    /// The check of a closed pallet's label.
    WarehousePalletLabel,
}

impl PalletEventKind {
    pub fn as_str(self) -> &'static str {
        match self {
            PalletEventKind::WarehousePalletOpened => "warehouse_pallet_opened",
            PalletEventKind::PalletBoxAdded => "pallet_box_added",
            PalletEventKind::PalletBoxRemoved => "pallet_box_removed",
            PalletEventKind::WarehousePalletClosed => "warehouse_pallet_closed",
            PalletEventKind::WarehousePalletLabel => "warehouse_pallet_label",
        }
    }
}

impl std::str::FromStr for PalletEventKind {
    type Err = UnknownVariant;

    /// The name [`PalletEventKind::as_str`] gives, as `device_event_receipts.kind` stores it.
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        parse_variant("pallet event kind", text)
    }
}

/// One record of a handheld's outbox for events outside a shift: `id` is a lower-case hyphenated
/// UUID the device made up, which keys the receipt; `data` is read by `kind`. `operatorId` is the
/// operator's UUID or `null` (evidence, no foreign key).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PalletEventRecord {
    pub id: String,
    pub kind: PalletEventKind,
    #[serde(default)]
    pub operator_id: Option<String>,
    pub data: serde_json::Value,
}

/// `POST /v1/device/pallet-events`: 1-100 records, applied in their order; the answer is
/// `FactReceipts`, one receipt per record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PalletEventBatch {
    pub records: Vec<PalletEventRecord>,
}

/// `data` of `warehouse_pallet_opened`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WarehousePalletOpenedData {
    pub pallet_id: String,
    pub product_id: String,
    pub opened_at: String,
}

/// `data` of `pallet_box_added`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PalletBoxAddedData {
    pub pallet_id: String,
    pub box_sscc: String,
    pub added_at: String,
}

/// `data` of `pallet_box_removed`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PalletBoxRemovedData {
    pub pallet_id: String,
    pub box_sscc: String,
    pub removed_at: String,
}

/// `data` of `warehouse_pallet_closed`: the SSCC of serial `serial` from the pallet block
/// (extension 1) `blockId` the host issued to this device, and how many boxes the device counted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WarehousePalletClosedData {
    pub pallet_id: String,
    pub sscc: String,
    pub block_id: String,
    pub serial: u64,
    pub opened_at: String,
    pub closed_at: String,
    pub box_count: u32,
}

/// `data` of `warehouse_pallet_label`: the check of a closed pallet's label, as a box's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WarehousePalletLabelData {
    pub pallet_id: String,
    pub outcome: LabelOutcome,
    pub at: String,
}

/// What a registry item says about its box.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BoxRegistryKind {
    /// The box is closed and stands as the other fields say.
    Upsert,
    /// The box was taken apart: a handheld forgets it.
    Remove,
}

/// One change of the registry of closed boxes (`GET /v1/device/box-registry`). The names are the
/// cloud's `BoxRegistryItemDto`, so a handheld reads both with one mirror. `updatedAt` is the
/// host's time of the change. `bottleCount` is the units the box held when it closed. A box on a
/// pallet names it: `palletSscc` is `null` while that pallet is open. A removal carries only
/// `kind`, `sscc` and `updatedAt`. No code of a unit is ever in an item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoxRegistryItem {
    pub kind: BoxRegistryKind,
    pub sscc: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub box_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub product_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bottle_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pallet_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pallet_sscc: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pallet_active: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub closed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub production_date: Option<String>,
}

impl BoxRegistryItem {
    /// The removal of the box `sscc`.
    pub fn remove(sscc: String, updated_at: String) -> Self {
        Self {
            kind: BoxRegistryKind::Remove,
            sscc,
            updated_at,
            box_id: None,
            product_id: None,
            bottle_count: None,
            pallet_id: None,
            pallet_sscc: None,
            pallet_active: None,
            closed_at: None,
            production_date: None,
        }
    }
}

/// A page of the registry. Every page of one walk repeats the `until` the first page named; the
/// next walk asks `since=<until>`. `restoreEpoch` is the host's, so a handheld that sees it
/// change drops the mirror and walks again.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoxRegistryPage {
    pub until: String,
    pub items: Vec<BoxRegistryItem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restore_epoch: Option<String>,
}

/// `GET /v1/device/org/print`: what a device prints about the organization when no shift is open.
/// `logo` is the print logo when the license has `customLogo`, else `null` (the bundled one
/// prints). `issuerPrefix` is the first nine digits of the organization's GLN.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgPrint {
    pub name: String,
    pub inn: Option<String>,
    pub issuer_prefix: String,
    pub logo: Option<ShiftSnapshotLogo>,
}

/// A warehouse pallet in the office's list (`GET /v1/office/warehouse-pallets`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeWarehousePallet {
    pub id: String,
    pub device_id: String,
    pub device_name: String,
    pub product_id: String,
    pub product_name: String,
    pub opened_at: String,
    pub closed_at: Option<String>,
    pub sscc: Option<String>,
    /// The boxes standing on it now.
    pub boxes: u32,
    /// The count the handheld reported at the close.
    pub box_count_reported: Option<u32>,
}

/// The answer of `GET /v1/office/warehouse-pallets`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeWarehousePallets {
    pub pallets: Vec<OfficeWarehousePallet>,
}
```

`proto/src/lib.rs`:

- в списке `pub mod …` (после `pub mod export_files;`) добавьте `pub mod handheld;`, и рядом (где реэкспорты;
  если их нет — сразу после списка модулей) строку `pub use handheld::*;`;
- `pub const PROTOCOL_VERSION: u32 = 6;` и в документе над константой добавьте первым абзацем: «6 since plan ТСД
  (handhelds on the host): the channel `POST /v1/device/pallet-events`, `GET /v1/device/box-registry`,
  `GET /v1/device/org/print`, `recoverDeviceId` of a claim and the capability `handheld-host-v1`; a handheld of
  protocol 6 against a host of 5 is `host_too_old`»;
- в `receipt_codes` добавьте (после `SUBJECT_UNKNOWN`) и включите в `ALL` (в том же порядке):

```rust
    /// No closed box has this SSCC (a pallet event names a box the host never closed).
    pub const BOX_NOT_FOUND: &str = "box_not_found";
    /// The box exists but is taken apart: it is no closed box any more.
    pub const BOX_NOT_CLOSED: &str = "box_not_closed";
    /// The box stands on another pallet; `details.palletSscc` (`null` while that pallet is open) and
    /// `details.palletId` name it.
    pub const BOX_ON_PALLET: &str = "box_on_pallet";
    /// The box is of another product than the pallet.
    pub const PRODUCT_MISMATCH: &str = "product_mismatch";
    /// The pallet is closed (or taken apart): a box neither joins nor leaves it.
    pub const PALLET_NOT_OPEN: &str = "pallet_not_open";
    /// A warehouse pallet closed with a box count the host does not hold; `details.counted` is its own.
    pub const PALLET_COUNT_MISMATCH: &str = "pallet_count_mismatch";
    /// The license has no `pallets` feature: a new warehouse pallet is refused (open ones go on).
    pub const FEATURE_DISABLED: &str = "feature_disabled";
```

    `ALL` теперь заканчивается `…, SUBJECT_UNKNOWN, BOX_NOT_FOUND, BOX_NOT_CLOSED, BOX_ON_PALLET, PRODUCT_MISMATCH,
    PALLET_NOT_OPEN, PALLET_COUNT_MISMATCH, FEATURE_DISABLED`;

- в `shift_supports` добавьте

```rust
    /// A handheld that speaks the host's protocol (plan ТСД, protocol 6): named in its claim's
    /// `capabilities` and on every entry into a shift, which the host always asks of a handheld.
    pub const HANDHELD_HOST: &str = "handheld-host-v1";
```

- в `ClaimRequest` после `capabilities`:

```rust
    /// The `deviceId` of the device this claim re-pairs (plan ТСД-Х, task Х6): the host gives that
    /// device a new key when the code was made for it. Left out, a claim pairs a new device.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recover_device_id: Option<String>,
```

`src-tauri/src/device.rs`, литерал `ClaimRequest { … }` (≈351): добавьте `recover_device_id: None,`.

- [ ] **Step 4: фикстуры.** Файлы в `apps/standalone/proto/fixtures/` (JSON, 2 пробела):

  `claim-request-handheld.json`:

```json
{
  "code": "7K3MQ9XV2D",
  "kind": "handheld",
  "name": "ТСД 1",
  "appVersion": "1.3.0",
  "capabilities": ["handheld-host-v1"]
}
```

`claim-request-recover.json`:

```json
{
  "code": "7K3MQ9XV2D",
  "kind": "handheld",
  "name": "ТСД 1",
  "appVersion": "1.3.0",
  "capabilities": ["handheld-host-v1"],
  "recoverDeviceId": "2c1f0b7e-8a4d-4c3b-9e2f-1a0b9c8d7e6f"
}
```

`shift-enter-handheld.json`: `{ "supports": ["handheld-host-v1"] }`.

`pairing-code-device.json` (форма кода; id другой):

```json
{
  "id": "5d3b8f1c-2e4a-4b6c-9d7e-8f0a1b2c3d4e",
  "code": "9QW2R5T8YB",
  "createdAt": "2026-10-15T09:15:00Z",
  "expiresAt": "2026-10-15T09:25:00Z",
  "payload": "markiro-host:1?h=10.0.0.5,192.168.1.10&p=45710&f=abababababababababababababababababababababababababababababababab&c=9QW2R5T8YB"
}
```

`pallet-events-request.json`:

```json
{
  "records": [
    {
      "id": "e1000000-0000-4000-8000-000000000001",
      "kind": "warehouse_pallet_opened",
      "operatorId": "c4a1e2b3-5d6f-4a7b-8c9d-0e1f2a3b4c5d",
      "data": {
        "palletId": "a1000000-0000-4000-8000-000000000001",
        "productId": "9f0e1d2c-3b4a-4958-8776-655443322110",
        "openedAt": "2026-10-08T07:00:00.000Z"
      }
    },
    {
      "id": "e1000000-0000-4000-8000-000000000002",
      "kind": "pallet_box_added",
      "operatorId": "c4a1e2b3-5d6f-4a7b-8c9d-0e1f2a3b4c5d",
      "data": {
        "palletId": "a1000000-0000-4000-8000-000000000001",
        "boxSscc": "046006820000015000",
        "addedAt": "2026-10-08T07:00:05.000Z"
      }
    },
    {
      "id": "e1000000-0000-4000-8000-000000000003",
      "kind": "pallet_box_added",
      "operatorId": "c4a1e2b3-5d6f-4a7b-8c9d-0e1f2a3b4c5d",
      "data": {
        "palletId": "a1000000-0000-4000-8000-000000000001",
        "boxSscc": "046006820000015017",
        "addedAt": "2026-10-08T07:00:09.000Z"
      }
    },
    {
      "id": "e1000000-0000-4000-8000-000000000004",
      "kind": "pallet_box_removed",
      "operatorId": "c4a1e2b3-5d6f-4a7b-8c9d-0e1f2a3b4c5d",
      "data": {
        "palletId": "a1000000-0000-4000-8000-000000000001",
        "boxSscc": "046006820000015017",
        "removedAt": "2026-10-08T07:00:14.000Z"
      }
    },
    {
      "id": "e1000000-0000-4000-8000-000000000005",
      "kind": "warehouse_pallet_closed",
      "operatorId": "c4a1e2b3-5d6f-4a7b-8c9d-0e1f2a3b4c5d",
      "data": {
        "palletId": "a1000000-0000-4000-8000-000000000001",
        "sscc": "146006820000000409",
        "blockId": "6e5d4c3b-2a1f-4e0d-9c8b-7a6f5e4d3c2b",
        "serial": 40,
        "openedAt": "2026-10-08T07:00:00.000Z",
        "closedAt": "2026-10-08T07:01:00.000Z",
        "boxCount": 1
      }
    },
    {
      "id": "e1000000-0000-4000-8000-000000000006",
      "kind": "warehouse_pallet_label",
      "operatorId": null,
      "data": {
        "palletId": "a1000000-0000-4000-8000-000000000001",
        "outcome": "verified",
        "at": "2026-10-08T07:01:20.000Z"
      }
    }
  ]
}
```

`pallet-events-response.json`:

```json
{
  "receipts": [
    { "id": "e1000000-0000-4000-8000-000000000001", "outcome": "accepted" },
    { "id": "e1000000-0000-4000-8000-000000000002", "outcome": "accepted" },
    {
      "id": "e1000000-0000-4000-8000-000000000003",
      "outcome": "rejected",
      "code": "box_on_pallet",
      "details": {
        "palletSscc": "146006820000000409",
        "palletId": "a1000000-0000-4000-8000-0000000000b2"
      }
    },
    { "id": "e1000000-0000-4000-8000-000000000004", "outcome": "accepted" },
    {
      "id": "e1000000-0000-4000-8000-000000000005",
      "outcome": "rejected",
      "code": "pallet_count_mismatch",
      "details": { "counted": 2 }
    },
    {
      "id": "e1000000-0000-4000-8000-000000000006",
      "outcome": "rejected",
      "code": "feature_disabled"
    }
  ]
}
```

`box-registry-page.json`:

```json
{
  "until": "2026-10-08T07:30:00Z",
  "items": [
    {
      "kind": "upsert",
      "sscc": "046006820000015000",
      "updatedAt": "2026-10-08T07:00:05Z",
      "boxId": "b0000000-0000-4000-8000-000000000001",
      "productId": "9f0e1d2c-3b4a-4958-8776-655443322110",
      "bottleCount": 12,
      "palletId": "a1000000-0000-4000-8000-000000000001",
      "palletSscc": "146006820000000409",
      "palletActive": true,
      "closedAt": "2026-10-08T06:15:06.000Z",
      "productionDate": "2026-10-08"
    },
    {
      "kind": "upsert",
      "sscc": "046006820000015017",
      "updatedAt": "2026-10-08T07:00:14Z",
      "boxId": "b0000000-0000-4000-8000-000000000002",
      "productId": "9f0e1d2c-3b4a-4958-8776-655443322110",
      "bottleCount": 12,
      "palletActive": false,
      "closedAt": "2026-10-08T06:15:20.000Z",
      "productionDate": "2026-10-08"
    },
    {
      "kind": "remove",
      "sscc": "046006820000015024",
      "updatedAt": "2026-10-08T07:10:00Z"
    }
  ],
  "nextCursor": "2026-10-08T07:10:00Z|046006820000015024",
  "restoreEpoch": "5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e"
}
```

`box-registry-last-page.json`: `{ "until": "2026-10-08T07:30:00Z", "items": [] }`.

`org-print.json`:

```json
{
  "name": "ООО «Атолл»",
  "inn": "7707083893",
  "issuerPrefix": "460068200",
  "logo": { "width": 10, "height": 2, "pixelsBase64": "8MAPQA==" }
}
```

`org-print-bundled.json`: `{ "name": "ООО «Атолл»", "inn": null, "issuerPrefix": "460068200", "logo": null }`.

`office-warehouse-pallets.json`:

```json
{
  "pallets": [
    {
      "id": "a1000000-0000-4000-8000-000000000002",
      "deviceId": "d1000000-0000-4000-8000-000000000001",
      "deviceName": "ТСД 1",
      "productId": "9f0e1d2c-3b4a-4958-8776-655443322110",
      "productName": "Молоко 3,2% 0,9 л",
      "openedAt": "2026-10-08T06:02:00.000Z",
      "closedAt": null,
      "sscc": null,
      "boxes": 3,
      "boxCountReported": null
    },
    {
      "id": "a1000000-0000-4000-8000-000000000001",
      "deviceId": "d1000000-0000-4000-8000-000000000001",
      "deviceName": "ТСД 1",
      "productId": "9f0e1d2c-3b4a-4958-8776-655443322110",
      "productName": "Молоко 3,2% 0,9 л",
      "openedAt": "2026-10-08T05:00:00.000Z",
      "closedAt": "2026-10-08T05:30:00.000Z",
      "sscc": "146006820000000409",
      "boxes": 40,
      "boxCountReported": 40
    }
  ]
}
```

Правки существующих: в `hello.json` и `hello-restored.json` `"protocol": 5` → `"protocol": 6`; в `hello-future.json`
`"protocol": 6` → `"protocol": 7`; в `fact-receipt-codes.json` к массиву `codes` после `"subject_unknown"` добавьте
`"box_not_found", "box_not_closed", "box_on_pallet", "product_mismatch", "pallet_not_open",
  "pallet_count_mismatch", "feature_disabled"` (по строке на код, тем же порядком, что в `ALL`).

- [ ] **Step 5: запустить, увидеть успех.**

  Run: `cargo --offline --locked --manifest-path "$WT/apps/standalone/Cargo.toml" test -p markiro-proto`
  Expected: `test result: ok.` (прежние тесты и десять новых).

  Run: `cargo --offline --locked --manifest-path "$WT/apps/standalone/Cargo.toml" test -p markiro-host --lib`
  Expected: `ok` (модули хоста читают протокол 6 без правок: `pairing_code` читает `pairing-code.json`).

- [ ] **Step 6: Commit.**

```bash
git -C "$WT" add apps/standalone/proto/src/handheld.rs apps/standalone/proto/src/lib.rs apps/standalone/src-tauri/src/device.rs apps/standalone/proto/tests/fixtures.rs apps/standalone/proto/fixtures/pallet-events-request.json apps/standalone/proto/fixtures/pallet-events-response.json apps/standalone/proto/fixtures/box-registry-page.json apps/standalone/proto/fixtures/box-registry-last-page.json apps/standalone/proto/fixtures/org-print.json apps/standalone/proto/fixtures/org-print-bundled.json apps/standalone/proto/fixtures/claim-request-handheld.json apps/standalone/proto/fixtures/claim-request-recover.json apps/standalone/proto/fixtures/pairing-code-device.json apps/standalone/proto/fixtures/office-warehouse-pallets.json apps/standalone/proto/fixtures/shift-enter-handheld.json apps/standalone/proto/fixtures/fact-receipt-codes.json apps/standalone/proto/fixtures/hello.json apps/standalone/proto/fixtures/hello-restored.json apps/standalone/proto/fixtures/hello-future.json
git -C "$WT" commit -m "feat(standalone): protocol 6 — the handheld's host types, receipt codes and fixtures

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

## Task П2: Zod-зеркало и Vitest — версия 6, коды квитанций, список складских паллет

**Files:**

- Modify: `apps/standalone/src/host/protocol.ts` (`PROTOCOL_VERSION`, `SHIFT_SUPPORTS`, `FACT_RECEIPT_CODES`, `officeWarehousePalletSchema`, `officeWarehousePalletsSchema`)
- Test: `apps/standalone/test/protocol.test.ts`

**Interfaces:**

- Consumes: фикстуры П1 (`office-warehouse-pallets.json`, `shift-enter-handheld.json`, `fact-receipt-codes.json`, `hello*.json`).
- Produces: `PROTOCOL_VERSION = 6`; `SHIFT_SUPPORTS.handheldHost = "handheld-host-v1"`; `FACT_RECEIPT_CODES` из 23 имён;
  `officeWarehousePalletsSchema` / `OfficeWarehousePallets` / `OfficeWarehousePallet` — их потребляют `HostApi.listWarehousePallets`
  (план хоста, Х5) и `WarehousePalletsSection`.

Зеркала запросов ТСД на стороне webview нет и не нужно: `pallet-events`, `box-registry` и `org/print` вызывает только
приложение Android; их формы закреплены Rust и Kotlin. Zod-зеркало — только то, что пересекает IPC офиса.

- [ ] **Step 1: написать падающие тесты.** В `test/protocol.test.ts`:

  1. в импорт из `../src/host/protocol.js` добавьте `officeWarehousePalletsSchema`, `officeWarehousePalletSchema`;
  2. в таблицу `RESPONSES` (рядом с `["office-line.json", officeLineSchema]`) добавьте
     `["office-warehouse-pallets.json", officeWarehousePalletsSchema],`;
  3. два теста `expect(PROTOCOL_VERSION).toBe(5)` (описания «speaks protocol 4 …» и «speaks protocol 5 …») меняются на
     `.toBe(6)`; в первом из них проверка набора возможностей становится

```ts
expect(SHIFT_SUPPORTS).toStrictEqual({
  validation: "validation-v1",
  validationDmDuplicate: "validation-dm-duplicate-v1",
  handheldHost: "handheld-host-v1",
});
```

     (комментарий над ней: «Protocol 4 brought the modes, 5 the duplicate print, 6 the handheld on the host»);

4. в конец файла добавьте:

```ts
describe("protocol 6: the handheld on the host (plan ТСД-П)", () => {
  type Row = Record<string, unknown>;

  it("is the version of the current hello fixtures, and the future one stays ahead", () => {
    expect(PROTOCOL_VERSION).toBe(6);
    for (const name of ["hello.json", "hello-restored.json"]) {
      expect((fixture(name) as Row).protocol, name).toBe(PROTOCOL_VERSION);
    }
    expect((fixture("hello-future.json") as Row).protocol as number).toBeGreaterThan(
      PROTOCOL_VERSION,
    );
  });

  it("names the capability a handheld enters a shift with, as the Rust fixture does", () => {
    const enter = fixture("shift-enter-handheld.json");
    expect(shiftEnterSchema.parse(enter)).toStrictEqual({
      supports: [SHIFT_SUPPORTS.handheldHost],
    });
  });

  it("knows the seven receipt codes the pallet events added", () => {
    for (const code of [
      "box_not_found",
      "box_not_closed",
      "box_on_pallet",
      "product_mismatch",
      "pallet_not_open",
      "pallet_count_mismatch",
      "feature_disabled",
    ]) {
      expect(FACT_RECEIPT_CODES as readonly string[]).toContain(code);
    }
    expect(FACT_RECEIPT_CODES).toHaveLength(23);
  });

  it("reads the office's list of warehouse pallets and refuses a row that lacks a count", () => {
    const list = officeWarehousePalletsSchema.parse(fixture("office-warehouse-pallets.json"));
    expect(list.pallets.map((pallet) => pallet.sscc)).toStrictEqual([null, "146006820000000409"]);
    const [open] = list.pallets;
    expect(officeWarehousePalletSchema.safeParse({ ...open, boxes: undefined }).success).toBe(
      false,
    );
    expect(officeWarehousePalletSchema.safeParse({ ...open, sscc: "12" }).success).toBe(false);
  });
});
```

     (`fixture`, `shiftEnterSchema`, `SHIFT_SUPPORTS`, `FACT_RECEIPT_CODES` в этом файле уже есть.)

Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts`
Expected: FAIL (`officeWarehousePalletsSchema` не экспортирован; `PROTOCOL_VERSION` равна 5; список кодов короче).

- [ ] **Step 2: реализовать.** `src/host/protocol.ts`:

  - `export const PROTOCOL_VERSION = 6;` и в документе над ней: «…, 5 since its part B (the duplicate print), 6 since plan ТСД
    (the handheld on the host: pallet events, the box registry, `handheld-host-v1`)»;
  - `SHIFT_SUPPORTS` получает `handheldHost: "handheld-host-v1",` (документ: «`handheldHost` is a handheld's; a station never names it»);
  - в `FACT_RECEIPT_CODES` после `"subject_unknown"` — семь новых имён в порядке `receipt_codes::ALL`;
  - рядом с `officeBoxSchema` (раздел офисных списков) добавьте:

```ts
/** `markiro_proto::OfficeWarehousePallet`: a pallet a handheld built outside a shift (plan ТСД-Х). */
export const officeWarehousePalletSchema = z.object({
  id: z.uuid(),
  deviceId: z.uuid(),
  deviceName: z.string(),
  productId: z.uuid(),
  productName: z.string(),
  openedAt: z.iso.datetime(),
  closedAt: z.iso.datetime().nullable(),
  /** `null` while the pallet is open. */
  sscc: z
    .string()
    .regex(/^\d{18}$/)
    .nullable(),
  /** The boxes standing on it now. */
  boxes: z.number().int().nonnegative(),
  /** The count the handheld reported when it closed the pallet. */
  boxCountReported: z.number().int().positive().nullable(),
});
export type OfficeWarehousePallet = z.infer<typeof officeWarehousePalletSchema>;

/** `GET /v1/office/warehouse-pallets`: open pallets first, then closed ones, newest first. */
export const officeWarehousePalletsSchema = z.object({
  pallets: z.array(officeWarehousePalletSchema),
});
export type OfficeWarehousePallets = z.infer<typeof officeWarehousePalletsSchema>;
```

- [ ] **Step 3: запустить, увидеть успех.**

  Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts`
  Expected: файл `passed` (прежние тесты, включая `know every receipt code of the host`, и четыре новых).

  Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`
  Expected: без ошибок.

  Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
  Expected: весь пакет `passed` (другие тесты читают `PROTOCOL_VERSION` как константу, а не число 5; если какой-то
  утверждает `5` литералом — он называется в отчёте и исправляется на `PROTOCOL_VERSION`).

- [ ] **Step 4: Commit.**

```bash
git -C "$WT" add apps/standalone/src/host/protocol.ts apps/standalone/test/protocol.test.ts
git -C "$WT" commit -m "feat(standalone): protocol 6 in the webview — receipt codes, the capability, warehouse pallets list

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

## Task П3: фикстуры для Kotlin (отпечаток, нагрузка DataMatrix, совместимость) и запуск Android-job при правке фикстур

**Files:**

- Create (фикстуры): `apps/standalone/proto/fixtures/fingerprint.json`, `pairing-payloads.json`, `compatibility.json`
- Test: `apps/standalone/proto/tests/fixtures.rs` (отпечаток, совместимость), `apps/standalone/host/src/pairing_code.rs`
  (модульный тест: хост строит каноническую нагрузку так же, как в фикстуре),
  `apps/standalone/test/fingerprint.test.ts`, `apps/standalone/test/pairing-code.test.ts`
- Modify: `tools/ci/affected.mjs`; Test: `tools/ci/test/affected.test.mjs`

**Interfaces:**

- Consumes: `markiro_proto::{certificate_fingerprint, display_fingerprint, compatibility_for, HelloEnvelope}`;
  `parsePairingPayload`, `formatFingerprint` (webview); `pairing_code::payload` (хост).
- Produces: три общих файла, которые план Android (С1) читает без копирования: `CertPin` — по `fingerprint.json`,
  `HostPairingCode.parsePayload` — по `pairing-payloads.json`, `HostCompat` — по `compatibility.json`; правило CI,
  при котором правка `apps/standalone/proto/fixtures/**` запускает `handheld_android`.

Решение, которого нет в спецификации: Kotlin разбирает нагрузку DataMatrix в трёх обликах — обычном, с префиксом AIM
`]d1`/`]D1` и набранном при включённом Caps Lock в английской раскладке. Восстановление русской раскладки (клавиатурный клин с
включённой кириллицей, `parsePairingPayload` в webview) в приложении ТСД не реализуется: ТСД получает скан интентом
вендора или клином в раскладке приложения; такие случаи остаются в тестах webview и в фикстуру не входят.

- [ ] **Step 1: фикстуры.**

  `fingerprint.json` (SHA-256 посчитан для DER-байт по `derHex`; `display` — первые 32 символа, верхний регистр, по четыре):

```json
{
  "cases": [
    {
      "derHex": "",
      "fingerprint": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "display": "E3B0 C442 98FC 1C14 9AFB F4C8 996F B924"
    },
    {
      "derHex": "00",
      "fingerprint": "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
      "display": "6E34 0B9C FFB3 7A98 9CA5 44E6 BB78 0A2C"
    },
    {
      "derHex": "616263",
      "fingerprint": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      "display": "BA78 16BF 8F01 CFEA 4141 40DE 5DAE 2223"
    },
    {
      "derHex": "3082010a02820101",
      "fingerprint": "31a2314b018c0e23d8a5845d9fe8bc675e8358dbe7b76a9f3f387c3b658b573c",
      "display": "31A2 314B 018C 0E23 D8A5 845D 9FE8 BC67"
    }
  ]
}
```

`compatibility.json` (`client` — протокол приложения; `host` — конверт `hello`; ответ — кто должен обновиться):

```json
{
  "cases": [
    { "client": 6, "host": { "protocol": 6, "minProtocol": 1 }, "expected": "compatible" },
    { "client": 6, "host": { "protocol": 7, "minProtocol": 3 }, "expected": "compatible" },
    { "client": 6, "host": { "protocol": 6, "minProtocol": 6 }, "expected": "compatible" },
    { "client": 1, "host": { "protocol": 6, "minProtocol": 1 }, "expected": "compatible" },
    { "client": 6, "host": { "protocol": 5, "minProtocol": 1 }, "expected": "host_too_old" },
    { "client": 6, "host": { "protocol": 4, "minProtocol": 4 }, "expected": "host_too_old" },
    { "client": 2, "host": { "protocol": 7, "minProtocol": 3 }, "expected": "app_too_old" },
    { "client": 6, "host": { "protocol": 8, "minProtocol": 7 }, "expected": "app_too_old" }
  ]
}
```

`pairing-payloads.json` (`canonical` — нагрузка ровно в том виде, в каком её строит хост):

```json
{
  "valid": [
    {
      "text": "markiro-host:1?h=10.0.0.5,192.168.1.10&p=45710&f=abababababababababababababababababababababababababababababababab&c=7K3MQ9XV2D",
      "canonical": true,
      "parsed": {
        "addresses": ["10.0.0.5", "192.168.1.10"],
        "port": 45710,
        "fingerprint": "abababababababababababababababababababababababababababababababab",
        "code": "7K3MQ9XV2D"
      }
    },
    {
      "text": "markiro-host:1?h=&p=45710&f=abababababababababababababababababababababababababababababababab&c=7K3MQ9XV2D",
      "canonical": true,
      "parsed": {
        "addresses": [],
        "port": 45710,
        "fingerprint": "abababababababababababababababababababababababababababababababab",
        "code": "7K3MQ9XV2D"
      }
    },
    {
      "text": "]d1markiro-host:1?h=10.0.0.5&p=45710&f=abababababababababababababababababababababababababababababababab&c=7K3MQ9XV2D",
      "canonical": false,
      "parsed": {
        "addresses": ["10.0.0.5"],
        "port": 45710,
        "fingerprint": "abababababababababababababababababababababababababababababababab",
        "code": "7K3MQ9XV2D"
      }
    },
    {
      "text": "MARKIRO-HOST:1?H=10.0.0.5,192.168.1.10&P=45710&F=ABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABAB&C=7k3mq9xv2d",
      "canonical": false,
      "parsed": {
        "addresses": ["10.0.0.5", "192.168.1.10"],
        "port": 45710,
        "fingerprint": "abababababababababababababababababababababababababababababababab",
        "code": "7K3MQ9XV2D"
      }
    },
    {
      "text": "  markiro-host:1?h=10.0.0.5&p=45710&f=abababababababababababababababababababababababababababababababab&c=7k3mq-9xv2d \n",
      "canonical": false,
      "parsed": {
        "addresses": ["10.0.0.5"],
        "port": 45710,
        "fingerprint": "abababababababababababababababababababababababababababababababab",
        "code": "7K3MQ9XV2D"
      }
    }
  ],
  "invalid": [
    "",
    "7K3MQ9XV2D",
    "markiro-host:2?h=10.0.0.5&p=45710&f=abababababababababababababababababababababababababababababababab&c=7K3MQ9XV2D",
    "markiro-host:1?h=10.0.0.5&p=45710&c=7K3MQ9XV2D",
    "markiro-host:1?h=10.0.0.5&p=45710&f=abab&c=7K3MQ9XV2D",
    "markiro-host:1?h=10.0.0.5&p=0&f=abababababababababababababababababababababababababababababababab&c=7K3MQ9XV2D",
    "markiro-host:1?h=10.0.0.5&p=70000&f=abababababababababababababababababababababababababababababababab&c=7K3MQ9XV2D",
    "markiro-host:1?h=10.0.0.256&p=45710&f=abababababababababababababababababababababababababababababababab&c=7K3MQ9XV2D",
    "markiro-host:1?h=010.0.0.5&p=45710&f=abababababababababababababababababababababababababababababababab&c=7K3MQ9XV2D",
    "markiro-host:1?h=10.0.0.5&h=10.0.0.6&p=45710&f=abababababababababababababababababababababababababababababababab&c=7K3MQ9XV2D",
    "markiro-host:1?h=10.0.0.5&p=45710&f=abababababababababababababababababababababababababababababababab&c=7K3MQ9XV2",
    "markiro-host:1?h=10.0.0.5&p=45710&f=abababababababababababababababababababababababababababababababab&c=7K3MQ9XV2U"
  ]
}
```

- [ ] **Step 2: написать падающие тесты.**

  `proto/tests/fixtures.rs` — добавьте (имена `compatibility_for`, `HelloEnvelope`, `Compatibility`, `certificate_fingerprint`,
  `display_fingerprint` уже импортированы в файле):

```rust
fn bytes_of(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&hex[at..at + 2], 16).unwrap())
        .collect()
}

#[test]
fn the_fingerprint_cases_are_the_sha256_of_the_der_and_their_display_form() {
    let cases = fixture("fingerprint.json");
    let cases = cases["cases"].as_array().unwrap();
    assert!(cases.len() >= 4);
    for case in cases {
        let fingerprint = certificate_fingerprint(&bytes_of(case["derHex"].as_str().unwrap()));
        assert_eq!(fingerprint, case["fingerprint"].as_str().unwrap());
        assert_eq!(display_fingerprint(&fingerprint), case["display"].as_str().unwrap());
    }
}

#[test]
fn the_compatibility_cases_say_who_must_update() {
    let cases = fixture("compatibility.json");
    for case in cases["cases"].as_array().unwrap() {
        let host = HelloEnvelope {
            product: "markiro-host".into(),
            protocol: case["host"]["protocol"].as_u64().unwrap() as u32,
            min_protocol: case["host"]["minProtocol"].as_u64().unwrap() as u32,
        };
        let client = case["client"].as_u64().unwrap() as u32;
        let expected = match case["expected"].as_str().unwrap() {
            "compatible" => Compatibility::Compatible,
            "host_too_old" => Compatibility::HostTooOld,
            "app_too_old" => Compatibility::AppTooOld,
            other => panic!("unknown expectation {other}"),
        };
        assert_eq!(compatibility_for(client, &host), expected, "{case}");
    }
}
```

`host/src/pairing_code.rs`, модуль `tests`, добавьте:

```rust
    /// The payloads of `pairing-payloads.json` that are the host's own spelling: what the host builds
    /// from the parsed parts is the text (the TypeScript and Kotlin readers parse the same texts).
    #[test]
    fn the_host_builds_the_canonical_payloads_of_the_shared_fixture() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../proto/fixtures/pairing-payloads.json")).unwrap();
        let mut canonical = 0;
        for case in fixture["valid"].as_array().unwrap() {
            if case["canonical"] != true {
                continue;
            }
            canonical += 1;
            let parsed = &case["parsed"];
            let addresses: Vec<Ipv4Addr> = parsed["addresses"]
                .as_array()
                .unwrap()
                .iter()
                .map(|address| address.as_str().unwrap().parse().unwrap())
                .collect();
            assert_eq!(
                payload(
                    &addresses,
                    parsed["port"].as_u64().unwrap() as u16,
                    parsed["fingerprint"].as_str().unwrap(),
                    parsed["code"].as_str().unwrap(),
                ),
                case["text"].as_str().unwrap()
            );
        }
        assert_eq!(canonical, 2);
    }
```

`test/fingerprint.test.ts` целиком:

```ts
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { formatFingerprint } from "../src/app/fingerprint.js";

// Bound before the URL is built (see test/protocol.test.ts).
const testModuleUrl = import.meta.url;

describe("formatFingerprint", () => {
  it("shows the first 32 hex characters in eight upper-case groups of four", () => {
    expect(formatFingerprint("0123456789abcdef".repeat(4))).toBe(
      "0123 4567 89AB CDEF 0123 4567 89AB CDEF",
    );
  });

  it("shows the cases of the shared fixture, whose fingerprints are the SHA-256 of their DER", () => {
    const { cases } = JSON.parse(
      readFileSync(new URL("../proto/fixtures/fingerprint.json", testModuleUrl), "utf8"),
    ) as { cases: { derHex: string; fingerprint: string; display: string }[] };
    expect(cases.length).toBeGreaterThanOrEqual(4);
    for (const { derHex, fingerprint, display } of cases) {
      expect(createHash("sha256").update(Buffer.from(derHex, "hex")).digest("hex")).toBe(
        fingerprint,
      );
      expect(formatFingerprint(fingerprint)).toBe(display);
    }
  });
});
```

`test/pairing-code.test.ts` — добавьте (в тот же `describe("pairing code", …)`; `fixture` и `z` в файле уже есть):

```ts
it("reads the payload cases of the shared fixture, which the Android app reads too", () => {
  const parsed = z
    .object({
      valid: z.array(
        z.object({
          text: z.string(),
          canonical: z.boolean(),
          parsed: z.object({
            addresses: z.array(z.string()),
            port: z.number(),
            fingerprint: z.string(),
            code: z.string(),
          }),
        }),
      ),
      invalid: z.array(z.string()),
    })
    .strict()
    .parse(fixture("pairing-payloads.json"));
  expect(parsed.valid.length).toBeGreaterThanOrEqual(5);
  for (const { text, parsed: expected } of parsed.valid) {
    expect(parsePairingPayload(text), text).toStrictEqual(expected);
  }
  for (const text of parsed.invalid) {
    expect(parsePairingPayload(text), text).toBeNull();
  }
});
```

`tools/ci/test/affected.test.mjs`: в тесте `"Standalone native and web changes select their jobs; …"` уберите
`"apps/standalone/proto/fixtures/hello.json"` из списка webview-файлов (его ожидание изменилось по решению: правка
фикстуры протокола теперь запускает ещё и Android) и допишите после теста новый:

```js
test("a changed wire fixture of the standalone protocol also runs the Android job that reads it", () => {
  for (const path of [
    "apps/standalone/proto/fixtures/hello.json",
    "apps/standalone/proto/fixtures/pallet-events-request.json",
  ]) {
    const result = classifyChangedFiles([path]);
    assert.equal(result.full, false, path);
    assert.deepEqual(
      enabledJobs(result),
      [
        "verify_static",
        "handheld_android",
        "standalone_rust",
        "standalone_windows_build",
        "standalone_app_tests",
      ],
      path,
    );
  }
  // The host's and the shell's own sources still do not run it.
  assert.deepEqual(enabledJobs(classifyChangedFiles(["apps/standalone/proto/src/lib.rs"])), [
    "verify_static",
    "standalone_rust",
    "standalone_windows_build",
    "standalone_app_tests",
  ]);
});
```

(`enabledJobs` отдаёт задачи в порядке `jobNames` файла, поэтому `handheld_android` стоит перед `standalone_*`. Последняя
проверка фиксирует, что правка типов `proto/src` без правки фикстуры Android не запускает.)

Run: `cargo --offline --locked --manifest-path "$WT/apps/standalone/Cargo.toml" test -p markiro-proto -p markiro-host --lib`
Expected: падают `the_fingerprint_cases_*`, `the_compatibility_cases_*` и `the_host_builds_the_canonical_payloads_*`
(файлов фикстур ещё нет, если вы начали с тестов).

Run: `node --test "$WT/tools/ci/test/affected.test.mjs"` — Expected: FAIL на новом тесте (`handheld_android` не выбран).

- [ ] **Step 3: правило CI.** В `tools/ci/affected.mjs` в блоке `if (path.startsWith("apps/standalone/")) { … }` ПЕРЕД проверкой
      `src-tauri/migrations/` добавьте:

```js
// The handheld's unit tests read these files (`apps/handheld/app/build.gradle.kts` adds the directory to the test
// resources): a changed wire fixture must run its Kotlin consumers, or a protocol change passes with Android untested.
if (path.startsWith("apps/standalone/proto/fixtures/")) {
  return ["verify_static", ...standaloneJobs, standaloneAppTests, "handheld_android"];
}
```

и поправьте комментарий над блоком: «…protocol fixtures read by the webview, the host, the shell and the Android app…».

- [ ] **Step 4: запустить, увидеть успех.**

  Run: `cargo --offline --locked --manifest-path "$WT/apps/standalone/Cargo.toml" test -p markiro-proto -p markiro-host --lib`
  Expected: `ok`.

  Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/fingerprint.test.ts test/pairing-code.test.ts`
  Expected: `passed`.

  Run: `node --test "$WT/tools/ci/test/affected.test.mjs" "$WT/tools/ci/test/workflow.test.mjs"`
  Expected: `# fail 0`.

- [ ] **Step 5: Commit.**

```bash
git -C "$WT" add apps/standalone/proto/fixtures/fingerprint.json apps/standalone/proto/fixtures/pairing-payloads.json apps/standalone/proto/fixtures/compatibility.json apps/standalone/proto/tests/fixtures.rs apps/standalone/host/src/pairing_code.rs apps/standalone/test/fingerprint.test.ts apps/standalone/test/pairing-code.test.ts tools/ci/affected.mjs tools/ci/test/affected.test.mjs
git -C "$WT" commit -m "feat(standalone): shared fixtures for the Android reader and the CI rule that runs it

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

## Task П4: постоянный адрес хоста — шаг мастера, `address-check`, плашка офиса (Х7 спецификации)

**Files:**

- Create: `apps/standalone/host/migrations/0039_host_address.sql`
- Create: `apps/standalone/host/src/address_check.rs`; Modify: `host/src/lib.rs` (`pub mod address_check;`)
- Modify: `apps/standalone/host/src/main.rs` (команда `address-check`, `USAGE`, код выхода)
- Modify: `apps/standalone/host/src/server.rs` (`Endpoint.details`, `AppState::with_address_details`, маршруты)
- Create: `apps/standalone/host/src/routes/host_network.rs`; Modify: `routes/mod.rs`, `routes/bootstrap.rs`, `audit.rs`, `license/gate.rs`
- Modify: `apps/standalone/proto/src/handheld.rs` (`AddressMode`, `HostAddress`, `HostNetwork`, `HostNetworkConfirm`),
  `apps/standalone/proto/src/lib.rs` (`BootstrapRequest.address_confirmed`)
- Create (фикстуры): `host-network.json`, `host-network-confirm.json`, `bootstrap-request-address.json`
- Modify: `apps/standalone/src-tauri/windows/installer-hooks.nsh`
- Create: `docs/runbooks/standalone-handheld-network.md`
- Test: `apps/standalone/host/tests/address_check.rs`, `apps/standalone/host/tests/host_network.rs`, модульные тесты `main.rs`,
  `apps/standalone/proto/tests/fixtures.rs`
- Webview: Modify `src/host/protocol.ts`, `src/host/api.ts`, `src/office/office-query.ts`, `src/wizard/wizard-form.ts`,
  `src/wizard/BootstrapWizard.tsx`, `src/office/OfficeOverview.tsx`, `src/i18n/ru.json`; Create
  `src/office/overview/HostAddressNotice.tsx`; Test: `test/wizard.test.tsx`, `test/app.test.tsx`, `test/support/wizard.ts`,
  `test/support/office.tsx`, `test/office-overview.test.tsx`, `test/protocol.test.ts`

**Interfaces:**

- Consumes: П1 (`handheld.rs`, `PROTOCOL_VERSION` 6), `network::lan_ipv4_addresses`, `install::{Commands, SystemCommands, powershell_args, run_checked}`.
- Produces: `markiro-host address-check` (код выхода 0 — все адреса статические, 5 — есть адрес по DHCP, 1 — не удалось определить);
  `GET /v1/office/host-network` (любая роль) и `PUT /v1/office/host-network` (администратор) —
  `HostNetwork { addresses: [{ address, mode: dhcp|static|unknown, mac, alias }], port, confirmedAt }`;
  `BootstrapRequest.addressConfirmed`; шаг мастера «Адрес хоста»; плашка «Адрес хоста может измениться» на обзоре офиса.

Решения, которых нет в спецификации (раздел 9.1 говорит «запоминается в `host.json`»):

- Отметка «я зарезервировал адрес» хранится в базе (`site.address_confirmed_at`), а не в `host.json`: `HostConfig` читается
  один раз при запуске службы и закрыт `deny_unknown_fields` (старая сборка не прочтёт новый файл после отката), а плашка в
  офисе должна гаснуть сразу после подтверждения без перезапуска хоста.
- Мастер установки — это первый запуск приложения (`BootstrapWizard`), а не NSIS; живой адрес мастеру до создания узла
  показать нечем (устройство ещё не сопряжено с хостом), поэтому шаг мастера даёт пояснение и флажок, а MAC и способ получения
  адреса показывает офис после установки (плашка) и NSIS при установке службы (`address-check`). Установку ничто не блокирует.
- Шаг мастера показывается всегда, не только в роли «Хост»: мастер выполняется на ПК узла, другой роли у него нет.

- [ ] **Step 1: фикстуры и падающие тесты Rust/Vitest — протокол.**

  `proto/fixtures/host-network.json`:

```json
{
  "addresses": [
    {
      "address": "192.168.1.10",
      "mode": "dhcp",
      "mac": "AA-BB-CC-DD-EE-FF",
      "alias": "Беспроводная сеть"
    },
    { "address": "10.0.0.5", "mode": "static", "mac": null, "alias": null }
  ],
  "port": 45710,
  "confirmedAt": null
}
```

`host-network-confirm.json`: `{ "confirmed": true }`.
`bootstrap-request-address.json`: содержимое `bootstrap-request.json` плюс поле `"addressConfirmed": true` последним ключом.

В `proto/tests/fixtures.rs` добавьте:

```rust
#[test]
fn the_host_network_lists_each_address_with_how_it_was_got() {
    let network: markiro_proto::HostNetwork = round_trip("host-network.json");
    assert_eq!(network.port, 45710);
    assert_eq!(network.addresses[0].mode, markiro_proto::AddressMode::Dhcp);
    assert_eq!(network.addresses[1].mode, markiro_proto::AddressMode::Static);
    assert!(network.confirmed_at.is_none());
    let confirm: markiro_proto::HostNetworkConfirm = round_trip("host-network-confirm.json");
    assert!(confirm.confirmed);
    let mut value = fixture("host-network-confirm.json");
    value["extra"] = Value::Bool(true);
    assert!(serde_json::from_value::<markiro_proto::HostNetworkConfirm>(value).is_err());
}

#[test]
fn a_wizard_may_say_the_address_is_reserved_and_an_older_one_says_nothing() {
    let sent: BootstrapRequest = round_trip("bootstrap-request-address.json");
    assert_eq!(sent.address_confirmed, Some(true));
    let plain: BootstrapRequest = round_trip("bootstrap-request.json");
    assert_eq!(plain.address_confirmed, None);
}
```

В `test/protocol.test.ts` добавьте в `RESPONSES` `["host-network.json", hostNetworkSchema]`, в `REQUESTS`
`["host-network-confirm.json", hostNetworkConfirmSchema]` и `["bootstrap-request-address.json", bootstrapRequestSchema]`
(с импортом `hostNetworkSchema`, `hostNetworkConfirmSchema`) и тест в конец блока «protocol 6»:

```ts
it("reads the host's addresses with how each was got and the wizard's mark", () => {
  const network = hostNetworkSchema.parse(fixture("host-network.json"));
  expect(network.addresses.map((address) => address.mode)).toStrictEqual(["dhcp", "static"]);
  expect(hostNetworkConfirmSchema.safeParse({ confirmed: true, extra: 1 }).success).toBe(false);
  expect(
    bootstrapRequestSchema.parse(fixture("bootstrap-request-address.json")).addressConfirmed,
  ).toBe(true);
});
```

Run: `cargo --offline --locked --manifest-path "$WT/apps/standalone/Cargo.toml" test -p markiro-proto` и
`pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts`
Expected: FAIL (типов и схем ещё нет).

- [ ] **Step 2: типы и схемы.** В `proto/src/handheld.rs` добавьте:

```rust
/// How this host's IPv4 address was got (`markiro-host address-check`, spec 9.1): by DHCP it can
/// change with a lease, and every device that paired by it loses the host.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AddressMode {
    Dhcp,
    Static,
    /// The system would not say (not Windows, or the query failed).
    Unknown,
}

/// One address devices can reach the host by.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostAddress {
    pub address: String,
    pub mode: AddressMode,
    /// The adapter's MAC (`AA-BB-CC-DD-EE-FF`), for the reservation in the router.
    pub mac: Option<String>,
    /// The adapter's name in Windows.
    pub alias: Option<String>,
}

/// `GET` and `PUT /v1/office/host-network`: the host's addresses and whether an administrator
/// confirmed that they stay (`confirmedAt`, the host's time, or `null`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostNetwork {
    pub addresses: Vec<HostAddress>,
    pub port: u16,
    pub confirmed_at: Option<String>,
}

/// `PUT /v1/office/host-network`: the administrator's mark «адрес зарезервирован».
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostNetworkConfirm {
    pub confirmed: bool,
}
```

В `proto/src/lib.rs`, `BootstrapRequest`, после `templates`:

```rust
    /// The wizard's mark «I reserved the host's address» (plan ТСД-П, task П4); left out, nothing
    /// was confirmed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address_confirmed: Option<bool>,
```

`src/host/protocol.ts`:

```ts
/** `markiro_proto::AddressMode`: how the host's address was got. */
export const ADDRESS_MODES = ["dhcp", "static", "unknown"] as const;

/** `GET` and `PUT /v1/office/host-network` (`markiro_proto::HostNetwork`). */
export const hostNetworkSchema = z.object({
  addresses: z.array(
    z.object({
      address: z.string(),
      mode: z.enum(ADDRESS_MODES),
      mac: z.string().nullable(),
      alias: z.string().nullable(),
    }),
  ),
  port: z.number().int().positive(),
  confirmedAt: z.iso.datetime().nullable(),
});
export type HostNetwork = z.infer<typeof hostNetworkSchema>;

/** The body of `PUT /v1/office/host-network`. */
export const hostNetworkConfirmSchema = z.strictObject({ confirmed: z.boolean() });
export type HostNetworkConfirm = z.infer<typeof hostNetworkConfirmSchema>;
```

и в `bootstrapRequestSchema` после `templates`: `addressConfirmed: z.boolean().optional(),` (документ: «`addressConfirmed` is left out when
the box was not ticked»).

Run: оба набора из шага 1 — Expected: `ok` / `passed`.

- [ ] **Step 3: падающие тесты хоста.**

  `tests/address_check.rs` (образец — `network_profile.rs`; подставной шелл):

```rust
//! `markiro-host address-check` against a fake PowerShell (plan ТСД-П, task П4, spec 9.1): reading how
//! `Get-NetIPAddress` says each address was got, and what the host tells devices about it.

use std::collections::VecDeque;
use std::net::Ipv4Addr;

use markiro_host::address_check::{addresses_of, check, parse, reservation_needed, AdapterAddress, LIST_SCRIPT};
use markiro_host::install::{CommandOutput, Commands, InstallError};
use markiro_proto::{AddressMode, HostAddress};

fn adapter(address: &str, origin: &str) -> AdapterAddress {
    AdapterAddress {
        index: 12,
        alias: "Беспроводная сеть".into(),
        address: address.into(),
        origin: origin.into(),
        mac: "AA-BB-CC-DD-EE-FF".into(),
    }
}

#[test]
fn reads_an_array_one_row_or_nothing() {
    let wifi = adapter("192.168.1.10", "Dhcp");
    assert_eq!(
        parse(
            r#"[{"index":12,"alias":"Беспроводная сеть","address":"192.168.1.10","origin":"Dhcp","mac":"AA-BB-CC-DD-EE-FF"}]"#
                .as_bytes()
        ),
        Ok(vec![wifi.clone()])
    );
    assert_eq!(
        parse(
            "\u{feff}{\"index\":12,\"alias\":\"Беспроводная сеть\",\"address\":\"192.168.1.10\",\"origin\":\"Dhcp\",\"mac\":\"AA-BB-CC-DD-EE-FF\"}\r\n"
                .as_bytes()
        ),
        Ok(vec![wifi])
    );
    assert_eq!(parse(b""), Ok(vec![]));
    assert_eq!(parse(b"[]"), Ok(vec![]));
    assert_eq!(
        parse(b"Get-NetIPAddress : access denied"),
        Err(InstallError::Output { program: "Get-NetIPAddress".into() })
    );
}

#[test]
fn an_address_is_by_dhcp_static_or_unknown_as_its_prefix_origin_says() {
    let lan = [Ipv4Addr::new(10, 0, 0, 5), Ipv4Addr::new(192, 168, 1, 10), Ipv4Addr::new(172, 16, 0, 9)];
    let adapters = [
        adapter("10.0.0.5", "Manual"),
        adapter("192.168.1.10", "Dhcp"),
        // 172.16.0.9 is not among the shell's rows: nothing is known of it.
    ];
    let listed = addresses_of(&lan, &adapters);
    assert_eq!(
        listed,
        vec![
            HostAddress { address: "10.0.0.5".into(), mode: AddressMode::Static, mac: Some("AA-BB-CC-DD-EE-FF".into()), alias: Some("Беспроводная сеть".into()) },
            HostAddress { address: "172.16.0.9".into(), mode: AddressMode::Unknown, mac: None, alias: None },
            HostAddress { address: "192.168.1.10".into(), mode: AddressMode::Dhcp, mac: Some("AA-BB-CC-DD-EE-FF".into()), alias: Some("Беспроводная сеть".into()) },
        ]
    );
    assert!(reservation_needed(&listed));
    assert!(!reservation_needed(&listed[..1]));
    assert!(!reservation_needed(&[]));
}

/// PowerShell: answers each run with the next output, and keeps the scripts.
struct FakeShell {
    outputs: VecDeque<&'static str>,
    scripts: Vec<String>,
}

impl Commands for FakeShell {
    fn run(&mut self, program: &str, args: &[String]) -> Result<CommandOutput, InstallError> {
        assert_eq!(program, "powershell.exe");
        let encoded = args.last().expect("-EncodedCommand carries the script");
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).unwrap();
        let units: Vec<u16> = bytes.chunks(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect();
        self.scripts.push(String::from_utf16(&units).unwrap());
        Ok(CommandOutput { code: Some(0), stdout: self.outputs.pop_front().unwrap().as_bytes().to_vec() })
    }
}

#[test]
fn the_check_asks_powershell_once_and_returns_its_rows() {
    let mut shell = FakeShell {
        outputs: VecDeque::from([r#"[{"index":7,"alias":"Ethernet","address":"10.0.0.5","origin":"Manual","mac":"11-22-33-44-55-66"}]"#]),
        scripts: Vec::new(),
    };
    let rows = check(&mut shell).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(shell.scripts, vec![LIST_SCRIPT.to_owned()]);
}
```

`tests/host_network.rs`:

```rust
//! The host's address as the office sees it, and the mark that it stays (plan ТСД-П, task П4): the
//! addresses come from the system, the mark is the administrator's and is also taken from the wizard.

mod support;

use axum::http::StatusCode;
use markiro_proto::{AddressMode, HostAddress};
use serde_json::json;
use support::app::{
    admin, audit_trail, bootstrap_body, json as json_request, pair_device, request, with_device,
    TestApp,
};

fn dhcp() -> Vec<HostAddress> {
    vec![HostAddress {
        address: "192.168.1.10".into(),
        mode: AddressMode::Dhcp,
        mac: Some("AA-BB-CC-DD-EE-FF".into()),
        alias: Some("Беспроводная сеть".into()),
    }]
}

#[tokio::test]
async fn the_office_reads_the_addresses_and_an_administrator_confirms_them() {
    let mut admin = admin().await;
    admin.app.state = admin.app.state.clone().with_address_details(dhcp);
    let (status, network) = admin.call("GET", "/v1/office/host-network", None).await;
    assert_eq!(status, StatusCode::OK, "{network}");
    assert_eq!(
        network,
        json!({
            "addresses": [{ "address": "192.168.1.10", "mode": "dhcp", "mac": "AA-BB-CC-DD-EE-FF", "alias": "Беспроводная сеть" }],
            "port": 45710,
            "confirmedAt": null
        })
    );
    let (status, confirmed) = admin.call("PUT", "/v1/office/host-network", Some(json!({ "confirmed": true }))).await;
    assert_eq!(status, StatusCode::OK, "{confirmed}");
    assert_eq!(confirmed["confirmedAt"], json!(admin.app.state.timestamp()));
    assert_eq!(
        audit_trail(&admin.app, "host_network.confirm").await,
        vec![admin.row("host_network.confirm", "site", "1", json!({ "confirmed": true }))]
    );
    // Taken back, it is `null` again.
    let (_, cleared) = admin.call("PUT", "/v1/office/host-network", Some(json!({ "confirmed": false }))).await;
    assert_eq!(cleared["confirmedAt"], json!(null));
}

#[tokio::test]
async fn a_technologist_reads_but_does_not_confirm() {
    let admin = admin().await;
    let token = admin.technologist().await;
    let (status, _) = admin.call_as(&token, "GET", "/v1/office/host-network", None).await;
    assert_eq!(status, StatusCode::OK);
    let (status, refused) = admin
        .call_as(&token, "PUT", "/v1/office/host-network", Some(json!({ "confirmed": true })))
        .await;
    assert_eq!((status, refused["error"]["code"].clone()), (StatusCode::FORBIDDEN, json!("forbidden")));
}

async fn wizard(app: &TestApp, body: serde_json::Value) -> serde_json::Value {
    let (_, key) = pair_device(app, "station").await;
    let (status, answer) = app
        .send(json_request(with_device(request("POST", "/v1/bootstrap"), &key), body))
        .await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    answer
}

#[tokio::test]
async fn the_wizard_may_confirm_the_address_and_says_so_in_its_audit_row_only_then() {
    let app = TestApp::new().await;
    let mut body = bootstrap_body();
    body["addressConfirmed"] = json!(true);
    wizard(&app, body).await;
    let confirmed: Option<String> = sqlx::query_scalar("SELECT address_confirmed_at FROM site WHERE id = 1")
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(confirmed, Some(app.state.timestamp()));
    let trail = audit_trail(&app, "host.bootstrap").await;
    assert_eq!(trail[0].6["addressConfirmed"], json!(true));

    let plain = TestApp::new().await;
    wizard(&plain, bootstrap_body()).await;
    let none: Option<String> = sqlx::query_scalar("SELECT address_confirmed_at FROM site WHERE id = 1")
        .fetch_one(&plain.state.pool)
        .await
        .unwrap();
    assert_eq!(none, None);
    assert!(audit_trail(&plain, "host.bootstrap").await[0].6.get("addressConfirmed").is_none());
}
```

В модульные тесты `main.rs` (рядом с `the_installer_commands_take_no_arguments_but_the_network_flag`) добавьте:

```rust
    #[test]
    fn address_check_takes_no_arguments_and_its_codes_are_the_documented_ones() {
        assert_eq!(parse(&args(&["address-check"])), Ok(Command::AddressCheck));
        assert!(parse(&args(&["address-check", "--now"])).is_err());
        assert_eq!(address_check_code(&Ok(false)), 0);
        assert_eq!(address_check_code(&Ok(true)), markiro_host::address_check::FROM_DHCP);
        assert_eq!(markiro_host::address_check::FROM_DHCP, 5);
        let failed: BoxError = "no".into();
        assert_eq!(address_check_code(&Err(failed)), 1);
    }
```

Run: `cargo --offline --locked --manifest-path "$WT/apps/standalone/Cargo.toml" test -p markiro-host --test address_check --test host_network --bin markiro-host`
Expected: ошибки компиляции (`address_check`, `with_address_details`, `Command::AddressCheck` нет).

- [ ] **Step 4: хост.**

  `migrations/0039_host_address.sql`:

```sql
-- The administrator's mark that the host's address stays (plan ТСД-П, task П4, spec 9.1): set by the
-- wizard's step or by the office, cleared by the office. NULL: not confirmed, and the office shows
-- its notice while an address is not static. In the database, not in `host.json`: the office reads
-- it live and an older build reads a database it has no column for.
ALTER TABLE site ADD COLUMN address_confirmed_at TEXT;
```

`src/address_check.rs`:

```rust
//! `markiro-host address-check`: how this PC got the IPv4 addresses devices reach it by (plan ТСД-П,
//! task П4, spec 9.1). A device pins the host's certificate and remembers its address; an address by
//! DHCP changes with a lease, and the factory's handhelds then "lose the server". The installer
//! warns when one is by DHCP; the office shows the addresses with their MAC for the router's
//! reservation. Windows only: `Get-NetIPAddress`'s `PrefixOrigin` says `Dhcp` or `Manual`.

use std::net::Ipv4Addr;

use markiro_proto::{AddressMode, HostAddress};
use serde::Deserialize;

use crate::install::{powershell_args, run_checked, Commands, InstallError};

/// The exit code of `address-check` while an address is by DHCP.
pub const FROM_DHCP: u8 = 5;

/// One address as `Get-NetIPAddress` reports it, with its adapter's MAC.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AdapterAddress {
    pub index: u32,
    pub alias: String,
    pub address: String,
    /// `PrefixOrigin` as text: `Dhcp`, `Manual`, `WellKnown`, `RouterAdvertisement`, `Other`.
    pub origin: String,
    pub mac: String,
}

impl AdapterAddress {
    pub fn mode(&self) -> AddressMode {
        match self.origin.as_str() {
            "Dhcp" => AddressMode::Dhcp,
            "Manual" => AddressMode::Static,
            _ => AddressMode::Unknown,
        }
    }
}

/// Lists the IPv4 addresses as JSON in UTF-8, with the MAC of each one's adapter (the origin goes out
/// as text, not as Windows PowerShell's number for the enum; `-InputObject` keeps one row an array).
pub const LIST_SCRIPT: &str = "$ErrorActionPreference = 'Stop'; \
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; \
$rows = @(Get-NetIPAddress -AddressFamily IPv4 | ForEach-Object { \
$adapter = Get-NetAdapter -InterfaceIndex $_.InterfaceIndex -ErrorAction SilentlyContinue; \
[pscustomobject]@{ index = [int]$_.InterfaceIndex; alias = [string]$_.InterfaceAlias; \
address = [string]$_.IPAddress; origin = [string]$_.PrefixOrigin; \
mac = [string]$adapter.MacAddress } }); \
ConvertTo-Json -Compress -InputObject $rows";

/// Reads `LIST_SCRIPT`'s output: an array, one object, or nothing at all.
pub fn parse(stdout: &[u8]) -> Result<Vec<AdapterAddress>, InstallError> {
    let text = String::from_utf8_lossy(stdout);
    let text = text.trim().trim_start_matches('\u{feff}');
    if text.is_empty() {
        return Ok(Vec::new());
    }
    let unexpected = |_| InstallError::Output {
        program: "Get-NetIPAddress".to_owned(),
    };
    if text.starts_with('[') {
        serde_json::from_str(text).map_err(unexpected)
    } else {
        serde_json::from_str::<AdapterAddress>(text)
            .map(|row| vec![row])
            .map_err(unexpected)
    }
}

/// The addresses of this PC, from the system.
pub fn check(commands: &mut dyn Commands) -> Result<Vec<AdapterAddress>, InstallError> {
    let output = run_checked(commands, "powershell.exe", &powershell_args(LIST_SCRIPT))?;
    parse(&output.stdout)
}

/// The addresses devices can try (`lan`, sorted) with what the shell said of each; an address the
/// shell did not list is `unknown`.
pub fn addresses_of(lan: &[Ipv4Addr], adapters: &[AdapterAddress]) -> Vec<HostAddress> {
    lan.iter()
        .map(|ip| {
            let text = ip.to_string();
            match adapters.iter().find(|row| row.address == text) {
                Some(row) => HostAddress {
                    address: text,
                    mode: row.mode(),
                    mac: Some(row.mac.clone()).filter(|mac| !mac.is_empty()),
                    alias: Some(row.alias.clone()).filter(|alias| !alias.is_empty()),
                },
                None => HostAddress {
                    address: text,
                    mode: AddressMode::Unknown,
                    mac: None,
                    alias: None,
                },
            }
        })
        .collect()
}

/// Whether the office should ask for a reservation: some address is by DHCP.
pub fn reservation_needed(addresses: &[HostAddress]) -> bool {
    addresses
        .iter()
        .any(|address| address.mode == AddressMode::Dhcp)
}

/// This PC's addresses with how each was got (the office reads them live).
pub fn detect() -> Vec<HostAddress> {
    let lan = crate::network::lan_ipv4_addresses();
    #[cfg(windows)]
    let adapters = check(&mut crate::install::SystemCommands).unwrap_or_default();
    #[cfg(not(windows))]
    let adapters: Vec<AdapterAddress> = Vec::new();
    addresses_of(&lan, &adapters)
}
```

`lib.rs`: `pub mod address_check;`. `audit.rs` `actions`: `pub const HOST_NETWORK_CONFIRM: &str = "host_network.confirm";`.

`server.rs`: в `Endpoint` добавьте поле `pub details: Arc<dyn Fn() -> Vec<markiro_proto::HostAddress> + Send + Sync>`, в инициализации
(≈строка 93, рядом с `addresses`) — `details: Arc::new(crate::address_check::detect)`, рядом с `with_addresses`:

```rust
    /// Replace the lookup of how the addresses were got; tests name them.
    pub fn with_address_details(
        mut self,
        details: impl Fn() -> Vec<markiro_proto::HostAddress> + Send + Sync + 'static,
    ) -> Self {
        self.endpoint.details = Arc::new(details);
        self
    }
```

`routes/host_network.rs`:

```rust
//! `GET` and `PUT /v1/office/host-network`: the host's addresses with how each was got, and the
//! administrator's mark that they stay (plan ТСД-П, task П4). The system is asked for every read
//! (a lease can change); on a PC that is not Windows every mode is `unknown`.

use axum::extract::State;
use axum::Json;
use markiro_proto::{HostNetwork, HostNetworkConfirm};
use serde_json::json;

use crate::audit::{self, actions, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::db::begin_write;
use crate::error::{ApiError, ApiJson};
use crate::server::AppState;

async fn read(state: &AppState) -> Result<HostNetwork, ApiError> {
    let details = state.endpoint.details.clone();
    let addresses = tokio::task::spawn_blocking(move || details())
        .await
        .map_err(ApiError::internal)?;
    let confirmed_at: Option<String> =
        sqlx::query_scalar("SELECT address_confirmed_at FROM site WHERE id = 1")
            .fetch_one(&state.pool)
            .await
            .map_err(ApiError::internal)?;
    Ok(HostNetwork {
        addresses,
        port: state.endpoint.port,
        confirmed_at,
    })
}

pub async fn get_network(
    State(state): State<AppState>,
    _context: OfficeContext,
) -> Result<Json<HostNetwork>, ApiError> {
    Ok(Json(read(&state).await?))
}

pub async fn put_network(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiJson(request): ApiJson<HostNetworkConfirm>,
) -> Result<Json<HostNetwork>, ApiError> {
    context.require_admin()?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    sqlx::query("UPDATE site SET address_confirmed_at = ? WHERE id = 1")
        .bind(request.confirmed.then_some(&at))
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::HOST_NETWORK_CONFIRM,
            target_type: Some("site"),
            target_id: Some("1"),
            outcome: Outcome::Ok,
            details: json!({ "confirmed": request.confirmed }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(read(&state).await?))
}
```

`server.rs` рядом с `/v1/office/org`:
`.route("/v1/office/host-network", get(crate::routes::host_network::get_network).put(crate::routes::host_network::put_network))`;
`routes/mod.rs`: `pub mod host_network;`; `license/gate.rs` `NEVER`: `("GET", "/v1/office/host-network"), ("PUT", "/v1/office/host-network"),`.

`routes/bootstrap.rs`: после `UPDATE site SET badge_salt = ?, initialized_at = ?, rev = ?` добавьте

```rust
    if request.address_confirmed == Some(true) {
        sqlx::query("UPDATE site SET address_confirmed_at = ? WHERE id = 1")
            .bind(&at)
            .execute(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
    }
```

а в детали аудита `HOST_BOOTSTRAP` — ключ только при подтверждении: переменную `details` соберите как `let mut details = json!({ …прежние поля… });
  if request.address_confirmed == Some(true) { details["addressConfirmed"] = json!(true); }` и передайте её в `Entry`.

`main.rs`: `Command::AddressCheck`; в `parse` — `("address-check", []) => return Ok(Command::AddressCheck),` и `"address-check"` в списке команд без
аргументов (рядом с `"network-check"`); в `USAGE` строка `markiro-host address-check`; диспетчер:

```rust
        Command::AddressCheck => {
            let result = address_check();
            match &result {
                Ok(true) => eprintln!(
                    "markiro-host: an address is got by DHCP; reserve it in the router by the MAC above"
                ),
                Err(error) => eprintln!("markiro-host: {error}"),
                Ok(false) => {}
            }
            return ExitCode::from(address_check_code(&result));
        }
```

```rust
/// `address-check`: 0 when every address is static, [`FROM_DHCP`] while one is by DHCP, 1 when the
/// check failed.
fn address_check_code(result: &Result<bool, BoxError>) -> u8 {
    match result {
        Ok(false) => 0,
        Ok(true) => markiro_host::address_check::FROM_DHCP,
        Err(_) => 1,
    }
}

/// Prints every address with how it was got and its MAC; whether one is by DHCP.
fn address_check() -> Result<bool, BoxError> {
    let lan = markiro_host::network::lan_ipv4_addresses();
    let adapters = markiro_host::address_check::check(&mut SystemCommands)?;
    let addresses = markiro_host::address_check::addresses_of(&lan, &adapters);
    for address in &addresses {
        println!(
            "{}\t{:?}\t{}\t{}",
            address.address,
            address.mode,
            address.mac.as_deref().unwrap_or("-"),
            address.alias.as_deref().unwrap_or("-")
        );
    }
    Ok(markiro_host::address_check::reservation_needed(&addresses))
}
```

Комментарий в шапке `main.rs` (список кодов выхода): «`address-check` 0 = every address static, 5 = one by DHCP, 1 = failed».

`installer-hooks.nsh`: после блока `network-check` (до `${Else}`/`${EndIf}` ветки роли хоста, строка ≈146) добавьте

```nsis
    nsExec::ExecToLog '"$INSTDIR\markiro-host.exe" address-check'
    Pop $0
    ${If} $0 == "5"
      DetailPrint "Адрес этого ПК получен по DHCP и может измениться."
      ; Like the network profile: the question belongs to the first installation, an update the app
      ; started asks nothing, and the office shows the notice until an administrator confirms.
      ${IfNot} ${Silent}
      ${AndIf} $UpdateMode <> 1
        MessageBox MB_OK|MB_ICONINFORMATION "Адрес этого компьютера в сети получен автоматически (DHCP) и может измениться после перезагрузки: ТСД и станции потеряют связь с хостом.$\n$\nЗарезервируйте адрес этого ПК в роутере по MAC-адресу (лучше всего) или задайте статический адрес вне пула DHCP. MAC и текущий адрес покажет офис после установки.$\n$\nУстановка продолжается."
      ${EndIf}
    ${EndIf}
```

и в комментарий шапки файла (строка с кодами) допишите «address-check 5 = an address by DHCP (a warning only)».

`docs/runbooks/standalone-handheld-network.md` (памятка, создаётся целиком):

```markdown
# Сеть для ТСД и станций: памятка администратору

Хост «Markiro Автоном» — ПК площадки. ТСД и станции находят его по IP-адресу и закрепляют отпечаток его сертификата.

1. **Постоянный адрес.** Адрес ПК хоста не должен меняться. Зарезервируйте его в роутере по MAC-адресу ПК (лучше всего) или
   задайте статический адрес вне пула DHCP. MAC и способ получения адреса показывает офис («Обзор», плашка «Адрес хоста может
   измениться») и команда `markiro-host address-check`. После резерва нажмите в офисе «Я зарезервировал адрес».
2. **Профиль сети.** Wi-Fi, к которому подключены ТСД, на ПК хоста должен быть «Частной» сетью: в «Общедоступной» порт 45710
   закрыт. Установщик предлагает исправить это (`markiro-host network-check --make-private`).
3. **Изоляция клиентов точки доступа (AP isolation).** При включённой изоляции ТСД и ПК не видят друг друга, хотя оба в сети.
   Программно это не проверить. Если ТСД не находит хост по правильному адресу и коду, выключите изоляцию клиентов на точке
   доступа.
4. **Несколько адаптеров.** Код подключения несёт все адреса ПК; ТСД выберет тот, чей сертификат совпал с отпечатком.
5. **Замена ПК.** Сертификат хоста входит в резервную копию: после восстановления на новом ПК отпечаток не меняется, и ТСД
   остаются подключёнными. Если отпечаток всё же изменился, ТСД покажет «Сертификат сервера изменился»; тогда в офисе
   («Устройства» → «Привязать заново») создайте код для этого ТСД.
6. **Время.** Часы ТСД и ПК хоста должны совпадать с точностью до двух минут; иначе приложение предупредит.
```

- [ ] **Step 5: запустить, увидеть успех.**

  Run: `cargo --offline --locked --manifest-path "$WT/apps/standalone/Cargo.toml" test -p markiro-host --test address_check --test host_network --test license_routes --test bootstrap --bin markiro-host`
  Expected: все `ok` (`address_check`: `3 passed`, `host_network`: `3 passed`, `bootstrap` — прежние тесты мастера без изменений).

- [ ] **Step 6: webview — падающие тесты.**

  `test/support/wizard.ts`: все «из 5» → «из 6»; после шага «Линии» и до «Проверка»:

```ts
await screen.findByText("Шаг 4 из 6 · Линии");
fireEvent.click(screen.getByRole("button", { name: "Добавить линию" }));
type("Линия 2", "Линия 2");
next();

await screen.findByText("Шаг 5 из 6 · Адрес хоста");
next();

await screen.findByText("Шаг 6 из 6 · Проверка");
```

В `test/wizard.test.tsx` — «Шаг 1 из 5 · Администратор» → «Шаг 1 из 6 · …», «Шаг 2 из 5» → «из 6», «Шаг 5 из 5 · Проверка» → «Шаг 6 из 6 · Проверка»,
«Шаг 4 из 5 · Линии» (после «Назад» с проверки) → «Шаг 5 из 6 · Адрес хоста»; добавьте тесты:

```tsx
it("lets the address step pass unticked, and sends the mark only when it is ticked", async () => {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(<BootstrapWizard onSubmit={onSubmit} />);
  await reachReview();
  fireEvent.click(screen.getByRole("button", { name: "Создать" }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty("addressConfirmed");
});

it("sends addressConfirmed when the box «Я зарезервировал адрес» is ticked", async () => {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(<BootstrapWizard onSubmit={onSubmit} />);
  await reachAddress();
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Я зарезервировал адрес (или задал статический)" }),
  );
  next();
  await screen.findByText("Шаг 6 из 6 · Проверка");
  fireEvent.click(screen.getByRole("button", { name: "Создать" }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ addressConfirmed: true });
});
```

где `reachAddress()` — экспорт `test/support/wizard.ts`: вынесите из `reachReview()` его часть до шага «Адрес хоста» включительно
(`reachReview` вызывает `reachAddress()`, затем `next()` и ждёт «Шаг 6 из 6 · Проверка»); `next` экспортируйте из того же файла.
В `test/app.test.tsx` (строки ≈607–613) цепочка `findByText` получает шаги: «Шаг 2 из 6 · Организация», «Шаг 3 из 6 · Номера SSCC»,
«Шаг 4 из 6 · Линии», «Шаг 5 из 6 · Адрес хоста», «Шаг 6 из 6 · Проверка», между последними двумя — ещё один «Далее».
Эти правки — следствие решения владельца В-2 (новый шаг), не ослабление проверок: каждый шаг по-прежнему проверен.

`test/support/office.tsx`: рядом с `getOrg` добавьте
`getHostNetwork: vi.fn<HostApi["getHostNetwork"]>(() => unexpected("getHostNetwork")),` и
`confirmHostNetwork: vi.fn<HostApi["confirmHostNetwork"]>(() => unexpected("confirmHostNetwork")),`.
В `test/office-overview.test.tsx` в `overviewSession` после `getBackups` добавьте
`session.api.getHostNetwork.mockResolvedValue(STATIC_NETWORK);` с константой

```ts
const STATIC_NETWORK = {
  addresses: [{ address: "10.0.0.5", mode: "static", mac: "AA-BB-CC-DD-EE-FF", alias: "Ethernet" }],
  port: 45710,
  confirmedAt: null,
} as const;
```

и тесты в конец `describe("«Обзор» of the office (beta 3.2)")`:

```tsx
it("warns that the host's address may change while one is by DHCP, and confirms the reservation", async () => {
  const session = overviewSession();
  session.api.getHostNetwork.mockResolvedValue({
    addresses: [
      {
        address: "192.168.1.10",
        mode: "dhcp",
        mac: "AA-BB-CC-DD-EE-FF",
        alias: "Беспроводная сеть",
      },
    ],
    port: 45710,
    confirmedAt: null,
  });
  session.api.confirmHostNetwork.mockResolvedValue({
    addresses: [
      {
        address: "192.168.1.10",
        mode: "dhcp",
        mac: "AA-BB-CC-DD-EE-FF",
        alias: "Беспроводная сеть",
      },
    ],
    port: 45710,
    confirmedAt: "2026-10-10T09:00:00Z",
  });
  renderOffice(session);
  const notice = await screen.findByRole("alert", { name: /Адрес хоста может измениться/ });
  expect(within(notice).getByText(/192\.168\.1\.10/)).toBeTruthy();
  expect(within(notice).getByText(/AA-BB-CC-DD-EE-FF/)).toBeTruthy();
  fireEvent.click(within(notice).getByRole("button", { name: "Я зарезервировал адрес" }));
  await waitFor(() =>
    expect(session.api.confirmHostNetwork).toHaveBeenCalledWith("office-session-token", {
      confirmed: true,
    }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("alert", { name: /Адрес хоста может измениться/ })).toBeNull(),
  );
});

it("says nothing about the address when it is static, or confirmed, or the reader is no administrator", async () => {
  const confirmed = overviewSession();
  confirmed.api.getHostNetwork.mockResolvedValue({
    addresses: [{ address: "192.168.1.10", mode: "dhcp", mac: null, alias: null }],
    port: 45710,
    confirmedAt: "2026-10-10T08:00:00Z",
  });
  renderOffice(confirmed);
  await screen.findByRole("heading", { name: "Смены в работе" });
  expect(screen.queryByRole("alert", { name: /Адрес хоста может измениться/ })).toBeNull();
  cleanup();
  const technologist = overviewSession(TECHNOLOGIST);
  renderOffice(technologist);
  await screen.findByRole("heading", { name: "Смены в работе" });
  expect(technologist.api.getHostNetwork).not.toHaveBeenCalled();
});
```

(импорты файла дополните `cleanup`, `fireEvent`, `waitFor` из `@testing-library/react`.)

Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/wizard.test.tsx test/app.test.tsx test/office-overview.test.tsx`
Expected: FAIL (нет шага «Адрес хоста», нет `getHostNetwork`).

- [ ] **Step 7: webview — реализация.**

  `src/host/api.ts`: в `HostApi` — `getHostNetwork: (token: string) => Promise<HostNetwork>;`,
  `confirmHostNetwork: (token: string, request: HostNetworkConfirm) => Promise<HostNetwork>;`; в фабрике:

```ts
    getHostNetwork: (token) =>
      client.request("GET", "/v1/office/host-network", { officeToken: token, schema: hostNetworkSchema }),
    confirmHostNetwork: (token, request) =>
      client.request("PUT", "/v1/office/host-network", {
        body: request,
        officeToken: token,
        schema: hostNetworkSchema,
      }),
```

`src/office/office-query.ts`: `officeKeys.hostNetwork: ["office", "host-network"],`.

`src/wizard/wizard-form.ts`: `WIZARD_STEPS = ["admin", "org", "sscc", "lines", "address", "review"] as const`;
`WizardValues.addressConfirmed: boolean`; `defaultWizardValues` → `addressConfirmed: false`;
в `validateStep`: `case "address": return [];` и в `review` перечень `["admin", "org", "sscc", "lines", "address"]`;
`toBootstrapRequest` в конце объекта: `...(values.addressConfirmed ? { addressConfirmed: true } : {}),` (при `exactOptionalPropertyTypes`
поле не пишется вовсе, пока флажок снят).

`src/wizard/BootstrapWizard.tsx`: после блока `{step === "lines" && …}`:

```tsx
{
  step === "address" && (
    <>
      <p>{t("wizard.address.intro")}</p>
      <p>{t("wizard.address.how")}</p>
      <Controller
        control={control}
        name="addressConfirmed"
        render={({ field }) => (
          <Checkbox
            label={t("wizard.address.confirm")}
            checked={field.value}
            onCheckedChange={field.onChange}
          />
        )}
      />
      <p className="standalone-wizard__note">{t("wizard.address.note")}</p>
    </>
  );
}
```

(импорт `Checkbox` из `@markiro/ui`.) `src/i18n/ru.json`, `wizard.steps.address` и блок `wizard.address`:

```json
"address": "Адрес хоста"
```

```json
"address": {
  "intro": "ТСД, станции и ПК офиса находят этот компьютер по IP-адресу. Если адрес изменится, они потеряют связь с хостом.",
  "how": "Зарезервируйте адрес этого компьютера в роутере по его MAC-адресу (лучше всего) или задайте статический адрес вне пула DHCP. MAC и способ получения адреса покажет офис после установки.",
  "confirm": "Я зарезервировал адрес (или задал статический)",
  "note": "Установку это не блокирует: пока пункт не закрыт, офис напоминает о нём плашкой."
}
```

`src/office/overview/HostAddressNotice.tsx`:

```tsx
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button } from "@markiro/ui";

import type { HostNetwork } from "../../host/protocol.js";
import { alertFailure, type AlertFailure } from "../form-errors.js";
import { officeKeys, useOfficeMutation, useOfficeQuery } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";

/**
 * «Адрес хоста может измениться» (plan ТСД-П, spec 9.1): shown to an administrator while some address of the
 * host is not static and nobody confirmed that it stays. The addresses and the MAC are what the router's
 * reservation needs. Nothing blocks: the notice stays until «Я зарезервировал адрес».
 */
export function HostAddressNotice() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const network = useOfficeQuery(
    officeKeys.hostNetwork,
    (api, token) => api.getHostNetwork(token),
    {
      staleTime: 60_000,
    },
  );
  const confirm = useOfficeMutation((api, token, confirmed: boolean) =>
    api.confirmHostNetwork(token, { confirmed }),
  );
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  if (!network.isSuccess) return null;
  const { addresses, confirmedAt } = network.data;
  const floating = addresses.filter((address) => address.mode !== "static");
  if (confirmedAt !== null || floating.length === 0) return null;
  const submit = async () => {
    setFailure(null);
    try {
      const saved = await confirm.mutateAsync(true);
      client.setQueryData<HostNetwork>(officeKeys.hostNetwork, saved);
    } catch (error) {
      setFailure(alertFailure(error));
    }
  };
  return (
    <Alert
      tone="warn"
      aria-label={t("office.hostAddress.title")}
      title={t("office.hostAddress.title")}
      action={
        <Button variant="secondary" loading={confirm.isPending} onClick={() => void submit()}>
          {t("office.hostAddress.confirm")}
        </Button>
      }
    >
      <p>
        {t("office.hostAddress.body", {
          addresses: floating
            .map((address) =>
              address.mac === null ? address.address : `${address.address} (MAC ${address.mac})`,
            )
            .join(", "),
        })}
      </p>
      <WriteFailureAlert failure={failure} />
    </Alert>
  );
}
```

`OfficeOverview.tsx`: после `<OverviewBackups />` — `{admin && <HostAddressNotice />}` и импорт. `ru.json`, внутри `office`:

```json
"hostAddress": {
  "title": "Адрес хоста может измениться",
  "body": "Адрес получен автоматически или не определён: {{addresses}}. ТСД и станции найдут хост только по нему. Зарезервируйте адрес в роутере по MAC или задайте статический, затем подтвердите.",
  "confirm": "Я зарезервировал адрес"
}
```

- [ ] **Step 8: запустить, увидеть успех.**

  Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/wizard.test.tsx test/app.test.tsx test/office-overview.test.tsx test/protocol.test.ts`
  Expected: четыре файла `passed`.

  Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone test` и `... typecheck` и `... lint`
  Expected: пакет `passed`, без ошибок типов и lint.

  Не проверено этим планом: окно NSIS (диалог `MessageBox`) на Windows, `Get-NetIPAddress` на реальном ПК, плашка и шаг мастера в браузере/Tauri
  (Vitest доказывает только DOM) — в отчёт отдельной строкой.

- [ ] **Step 9: Commit.**

```bash
git -C "$WT" add apps/standalone/host/migrations/0039_host_address.sql apps/standalone/host/src/address_check.rs apps/standalone/host/src/lib.rs apps/standalone/host/src/main.rs apps/standalone/host/src/server.rs apps/standalone/host/src/routes/host_network.rs apps/standalone/host/src/routes/mod.rs apps/standalone/host/src/routes/bootstrap.rs apps/standalone/host/src/audit.rs apps/standalone/host/src/license/gate.rs apps/standalone/proto/src/handheld.rs apps/standalone/proto/src/lib.rs apps/standalone/proto/fixtures/host-network.json apps/standalone/proto/fixtures/host-network-confirm.json apps/standalone/proto/fixtures/bootstrap-request-address.json apps/standalone/proto/tests/fixtures.rs apps/standalone/src-tauri/windows/installer-hooks.nsh docs/runbooks/standalone-handheld-network.md apps/standalone/host/tests/address_check.rs apps/standalone/host/tests/host_network.rs apps/standalone/src/host/protocol.ts apps/standalone/src/host/api.ts apps/standalone/src/office/office-query.ts apps/standalone/src/wizard/wizard-form.ts apps/standalone/src/wizard/BootstrapWizard.tsx apps/standalone/src/office/OfficeOverview.tsx apps/standalone/src/office/overview/HostAddressNotice.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/wizard.test.tsx apps/standalone/test/app.test.tsx apps/standalone/test/support/wizard.ts apps/standalone/test/support/office.tsx apps/standalone/test/office-overview.test.tsx apps/standalone/test/protocol.test.ts
git -C "$WT" commit -m "feat(standalone): the host's permanent address — wizard step, address-check, office notice

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

## Отклонения при исполнении

Раздел заполняет исполнитель: для каждой задачи — что пришлось сделать иначе и почему (образец —
«Отклонения при исполнении» в `2026-10-13-standalone-shift-modes.md`). Обязательно назвать: тесты, чьё ожидание
изменилось решением владельца (число шагов мастера, список задач CI для `hello.json`, `PROTOCOL_VERSION`), и любое поле
фикстур, которое пришлось изменить после первого запуска, с причиной.

### Задача П1

- Закреплённые версией ожидания, которых не было в плане, подняты с 5 до 6 (число протокола, не ослабление проверок):
  `proto/tests/shifts.rs` и `proto/tests/validation_print.rs` (`PROTOCOL_VERSION`), `host/tests/hello.rs`,
  `host/tests/platform.rs` (`protocol` в `/v1/hello`), `host/tests/claim.rs` (`devices.protocol` после claim = 6),
  юнит-тесты `host/src/server.rs` (`a_supported_version_passes` принимает 6; верхняя граница 6, отказ — 7 и 8 вместо 6 и 7).
- Zod/Vitest (`PROTOCOL_VERSION`, `FACT_RECEIPT_CODES`, фикстуры `hello*.json`) задача П1 не трогает: они
  краснеют до П2.
- Фикстуры из плана в этих блоках не потребовали правок после первого запуска.
