# План ТСД-А: Android-приложение работает с хостом «Markiro Автоном» — сеть с закреплённым сертификатом, сопряжение по IP и коду, смена и паллеты на хосте (потоки С и Д) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Приложение ТСД (`apps/handheld`, Kotlin, Compose, Room) получает второй бэкенд — хост автонома на площадке — и
остаётся тем же APK для облака. После плана оператор склада и цеха берёт ТСД, подключает его к хосту по IP и одноразовому
коду (или сканом DataMatrix с экрана офиса), входит по PIN или бейджу без интернета, берёт смену своей линии, сканирует КМ
в короба, закрывает короба с печатью, собирает производственные паллеты в смене и складские паллеты вне смены; факты
приходят на хост теми же квитанциями, что у станции. Облачное устройство не затронуто: его код выполняется как раньше, его
очереди целы, все облачные тесты остаются обязательным стражем.

**Architecture:**

- **Шов `StationBackend`.** Интерфейс из шести сетевых вызовов, на которых стоят загрузчики приложения (`RosterRefresher`,
  `ShiftRepository`, `PalletBootstrapMirror`, `BoxRegistryMirror`): список ролей, список смен, вход в смену (смена + её
  «пакет»), довыдача блока SSCC, начальные данные паллет, страница реестра коробов. `CloudBackend` — те же вызовы
  `StationApi`, дословно; `HostBackend` — переводит ответы хоста в те же DTO (`ShiftBundleDto`, `PalletBootstrapDto`,
  `BoxRegistryPageDto`), поэтому экраны, Room-слой и печать не знают, кто за ними. Выбор — по `device_config.backend`
  (`BackendSelector`); конструкторы загрузчиков получают второй вариант с `StationApi`, чтобы облачные тесты не менялись.
- **Сеть хоста.** `HostHttpClient`: OkHttp только по `https://`, без прокси и перенаправлений, `ConnectionSpec.MODERN_TLS`, свой
  `X509TrustManager`, который сверяет SHA-256 от DER листа с закреплённым отпечатком (`PinnedTrustManager`), и режим только
  наблюдения (`ObservingTrustManager`) для сопряжения вручную. Системное доверие не участвует. Ключ — `Authorization: Bearer`.
- **Идентичность.** Запечатанный владелец `DeviceRecovery` переиспользуется: `tenantId` := `hostId`, `serverOrigin` :=
  `https://<ip>:<port>`; к нему добавлен `pinSha256`. Облачная защита от смешения данных работает без второй реализации.
- **Очередь.** Таблица `host_outbox` хранит замороженный JSON каждой записи (идентификатор записи — UUID, порядок — `seq`);
  `HostRecordFreezer` строит записи из тех же исходных строк Room, что читает облачный `SyncEngine` (`outbox`, `boxes`,
  `pallets`, `pallet_memberships`, …), в причинном порядке по времени; `HostSyncEngine` отправляет их пачками
  (`POST /v1/device/facts`, `POST /v1/device/pallet-events`), по квитанциям снимает исходные строки и копит карантин. Повтор —
  теми же байтами.
- **Лицензия, гранты, обновления.** Облачные подсистемы (`core/grants`, `core/replacement`, инвентаризация, списание, проверка
  обновлений) в режиме `host` не запускаются и не показываются; гранты не денят (режим `observe` без состояния), явный
  короткий путь в `GrantRepository.admit` не пишет их свидетельства.

**Tech Stack:** Kotlin 2.2, Jetpack Compose, Room 2.7.2, Hilt, OkHttp 4.12, kotlinx.serialization, Retrofit (только облако),
Robolectric 4.15, MockWebServer; Gradle (`apps/handheld`, вне pnpm-workspace).

**Спецификация:** `docs/superpowers/specs/2026-10-15-standalone-handheld-on-host-design.md` (разделы 4, 5, 7.2, 8, 10, 11.2, 11.3, 15 потоки
С и Д, решения владельца в конце). Планы: хост `2026-10-15-standalone-tsd-host.md` (порядок трёх планов — в его начале),
протокол `2026-10-15-standalone-tsd-protocol.md`. Правила приложения: `apps/handheld/AGENTS.md`, `apps/handheld/README.md`,
`docs/standalone/ledger/agent-rules.md`.

## Что спецификация оставила непроверенным и что показало чтение кода

| Пункт спецификации (раздел 7.2, 8.2)                                     | Результат                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Шаблоны этикеток автонома и облака читаются одним кодом `core/label`** | Да. `LabelSpecCodec` — порт `packages/domain/src/labels/model.ts`; хост хранит ту же JSON-структуру (`widthMm`, `heightMm`, `dpi` 203/300, `language` zpl/tspl, `elements` шести видов `text`, `field`, `barcode`, `line`, `box`, `organization_logo`), поля `product.egais` и `qty.boxes` кодек знает. Расхождения нет; тест С1 разбирает все шаблоны фикстур `changes-catalog.json` и `bootstrap-request-templates.json` кодеком и ловит будущее расхождение.                                                       |
| **Формат метки времени устройства**                                      | Уже совпадает: `core/util/Iso.kt` пишет `yyyy-MM-dd'T'HH:mm:ss.SSS'Z'` в UTC, ровно 24 символа, как `rules::device_instant` хоста. Отдельного `DeviceInstant` не нужно; С1 добавляет в `Iso` проверку `isDeviceInstant` и тест по `device-instants.json`.                                                                                                                                                                                                                                                             |
| **TLS на Android 9**                                                     | По чтению: сертификат хоста — ECDSA P-256 с SHA-256 (`rcgen` 0.14: `KeyPair::generate()` = `PKCS_ECDSA_P256_SHA256`), хост на `rustls` 0.23 (`aws_lc_rs`, `tls12`, версии по умолчанию: TLS 1.3 и 1.2, наборы ECDHE-ECDSA-AES-GCM и ChaCha20). Android 9 (API 28, minSdk приложения) говорит по TLS 1.2 с этими наборами; `ConnectionSpec.MODERN_TLS` их включает. Совместимость по документации сходится, **на устройстве не проверена** — это пункт ручного чек-листа Д5 («TLS-рукопожатие с хостом на Android 9»). |

## Другие находки при чтении кода, которых нет в спецификации

- **Гранты** (`core/grants`) вызываются из `ScanRecorder`, `CloseBox`, `ClosePallet`, `ShiftCloser`, `DuplicateJobs`. Без состояния грантов режим
  — `observe`: никого не денят, но каждое событие пишет строки свидетельств. В режиме `host` `GrantRepository.admit` возвращается сразу (задача С3).
- **Скан-факт хоста** не несёт сырого текста: `ScanFact.code = { codeHash, gtin14, serial, canonical }`, `rawKind` (`km`/`gtin`/`sscc`/`unknown`),
  `rawLength`; сырой текст облачной очереди (`OutboxEntity.raw`) превращается в них при заморозке записи (С1: `ScanRawKind`, `KmCodec.canonicalize`).
- **Блоки SSCC**: `box_closed` и `pallet_closed` хоста требуют `blockId` и `serial`. Серийный номер выводится из SSCC (`Sscc.serialOf`), идентификатор
  блока хранится в строке пула (`SsccRangeEntity.blockId`, Room 21) — колонки в `BoxEntity`/`PalletEntity`, как в 8.4 спецификации, не нужны.
- **Реестр коробов хоста** отдаёт форму облачного `BoxRegistryItemDto` (план хоста, Х4), а не усечённую из 6.5; `contentKeys` нет: зеркало в режиме
  `host` читает их как пустой список.
- **Операторы хоста** — отдельные записи `operators` (PIN) и `operator_badges` (несколько бейджей); поля `active` нет (удалённые приходят надгробием).
- **Лента изменений** сверяет `hostId`: другой `hostId` — остановка синхронизации справочников.

## Global Constraints

- Рабочее дерево: `git -C /tmp/claude/wt/integ worktree add /tmp/claude/wt/tsd-android -b claude/tsd-android claude/integration`,
  затем клонирование зависимостей по `docs/standalone/ledger/agent-rules.md` (Gradle-кэш общий, `apps/handheld/local.properties` с
  `sdk.dir` не коммитится). Дальше `WT=/tmp/claude/wt/tsd-android`, `GR="$WT/apps/handheld/gradlew -p $WT/apps/handheld --no-daemon"`.
  Не `cd`, абсолютные пути; без `git stash` и push.
- Гейты каждой задачи называют свои Kotlin-команды; перед завершением плана — `$GR testDebugUnitTest lintDebug assembleDebug` целиком
  (`apps/handheld/AGENTS.md`). Эмулятор и Robolectric не доказывают вендорский сканер, реальный принтер, Wi-Fi, Doze и TLS на Android 9.
- Русские и английские строки добавляются в `res/values/strings.xml` и `res/values-en/strings.xml` одновременно (lint падает на пропуск).
- Фикстуры протокола читаются из `apps/standalone/proto/fixtures` без копирования; фикстуры КМ/инвентаризации/этикеток не трогаются.
  Не нормализуйте КМ, JSON и хэши самостоятельно (`apps/handheld/AGENTS.md`).
- Журналы: ключ устройства, код сопряжения, тело `claim` и отпечаток целиком не пишутся никуда.
- Debug-HTTP остаётся debug-only: режим `host` не зависит от открытого HTTP ни в одной сборке (тест на `http://` в release и debug).
- Облачные тесты (~27,5 тыс. строк) остаются зелёными; тест, чьё ожидание меняется, называется в отчёте.
- Коммит: явные пути, одна строка `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Task С1: общие фикстуры хоста в тестах приложения и классы паритета (отпечаток, код сопряжения, дайджест, коды квитанций, совместимость)

**Files:**

- Modify: `apps/handheld/app/build.gradle.kts` (`srcDir` фикстур хоста)
- Create: `app/src/main/kotlin/app/markiro/handheld/core/network/host/CertPin.kt`
- Create: `app/src/main/kotlin/app/markiro/handheld/core/network/host/HostReceiptCode.kt`
- Create: `app/src/main/kotlin/app/markiro/handheld/core/network/host/HostCompat.kt`
- Create: `app/src/main/kotlin/app/markiro/handheld/feature/pairing/HostPairingCode.kt`
- Create: `app/src/main/kotlin/app/markiro/handheld/core/box/BoxDigest.kt`
- Create: `app/src/main/kotlin/app/markiro/handheld/core/km/ScanRawKind.kt`
- Modify: `app/src/main/kotlin/app/markiro/handheld/core/util/Iso.kt` (`isDeviceInstant`), `core/box/Sscc.kt` (`serialOf`)
- Test: `app/src/test/kotlin/app/markiro/handheld/core/network/host/HostFixturesTest.kt`,
  `app/src/test/kotlin/app/markiro/handheld/core/label/HostLabelSpecParityTest.kt`

**Interfaces:**

- Consumes (план протокола П1/П3): `fingerprint.json`, `pairing-payloads.json`, `compatibility.json`, `pairing-codes.json`,
  `device-instants.json`, `box-digest.json`, `sscc-serials.json`, `shift-close-reasons.json`, `fact-receipt-codes.json`,
  `changes-catalog.json`, `bootstrap-request-templates.json` из `apps/standalone/proto/fixtures`.
- Produces: `CertPin.{isFingerprint, fingerprintOf, display, matches}`; `HostPairingCode.{normalize, parsePayload, Payload}`;
  `Iso.isDeviceInstant`; `BoxDigest.of`; `HostReceiptCode.{ALL, hintOf}`; `HostCompat.{PROTOCOL, decide}`; `ScanRawKind.classify`;
  `Sscc.serialOf`. Задачи С2–Д4 потребляют именно эти имена.

- [ ] **Step 1: написать падающие тесты.** `HostFixturesTest.kt` (все фикстуры читаются одним помощником):

```kotlin
package app.markiro.handheld.core.network.host

import app.markiro.handheld.core.box.BoxDigest
import app.markiro.handheld.core.box.Sscc
import app.markiro.handheld.core.km.ScanRawKind
import app.markiro.handheld.core.util.Iso
import app.markiro.handheld.feature.pairing.HostPairingCode
import app.markiro.handheld.feature.shift.ShiftCloser
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The wire rules the host, the webview and this app read alike (plan ТСД-А, task С1): one file each in
 * `apps/standalone/proto/fixtures`, added to the test resources by `build.gradle.kts`. A rule that
 * differs here fails with the fixture's own case.
 */
class HostFixturesTest {
    private fun fixture(name: String): JsonObject = Json.parseToJsonElement(
        checkNotNull(javaClass.classLoader?.getResource(name)) { "$name is not in the test resources: see build.gradle.kts" }
            .readText(),
    ).jsonObject

    private fun bytes(hex: String) = ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    private fun text(element: JsonElement?): String? = if (element == null || element is JsonNull) null else element.jsonPrimitive.content

    @Test
    fun theFingerprintIsTheSha256OfTheDerAndShowsAsEightGroups() {
        val cases = fixture("fingerprint.json").getValue("cases").jsonArray
        assertTrue(cases.size >= 4)
        for (case in cases) {
            val der = bytes(case.jsonObject.getValue("derHex").jsonPrimitive.content)
            val expected = case.jsonObject.getValue("fingerprint").jsonPrimitive.content
            assertEquals(expected, CertPin.fingerprintOf(der))
            assertEquals(case.jsonObject.getValue("display").jsonPrimitive.content, CertPin.display(expected))
            assertTrue(CertPin.matches(expected, der))
            assertTrue(CertPin.matches(expected.uppercase(), der).not())
            assertFalse(CertPin.matches(expected, der + 0))
        }
        assertFalse(CertPin.isFingerprint("ab".repeat(31)))
    }

    @Test
    fun theCodeIsNormalizedLikeTheHostDoes() {
        for (case in fixture("pairing-codes.json").getValue("cases").jsonArray) {
            val input = case.jsonObject.getValue("input").jsonPrimitive.content
            val expected = text(case.jsonObject["normalized"])
            assertEquals("input ${input.map { it.code.toString(16) }}", expected, HostPairingCode.normalize(input))
        }
    }

    @Test
    fun thePayloadOfTheOfficesDataMatrixIsReadLikeTheWebviewReadsIt() {
        val file = fixture("pairing-payloads.json")
        for (case in file.getValue("valid").jsonArray) {
            val textOf = case.jsonObject.getValue("text").jsonPrimitive.content
            val parsed = case.jsonObject.getValue("parsed").jsonObject
            val payload = checkNotNull(HostPairingCode.parsePayload(textOf)) { textOf }
            assertEquals(parsed.getValue("addresses").jsonArray.map { it.jsonPrimitive.content }, payload.addresses)
            assertEquals(parsed.getValue("port").jsonPrimitive.int, payload.port)
            assertEquals(parsed.getValue("fingerprint").jsonPrimitive.content, payload.fingerprint)
            assertEquals(parsed.getValue("code").jsonPrimitive.content, payload.code)
        }
        for (case in file.getValue("invalid").jsonArray) {
            assertNull(case.jsonPrimitive.content, HostPairingCode.parsePayload(case.jsonPrimitive.content))
        }
    }

    @Test
    fun aDeviceInstantIsExactlyTwentyFourCharactersOfAnUtcInstant() {
        val file = fixture("device-instants.json")
        for (valid in file.getValue("valid").jsonArray) {
            val value = valid.jsonPrimitive.content
            assertTrue(value, Iso.isDeviceInstant(value))
            assertEquals(value, Iso.format(checkNotNull(Iso.parse(value))))
        }
        for (invalid in file.getValue("invalid").jsonArray) {
            assertFalse(invalid.jsonPrimitive.content, Iso.isDeviceInstant(invalid.jsonPrimitive.content))
        }
    }

    @Test
    fun theBoxDigestIsTheHostsForAnyOrderOfTheHashes() {
        for (case in fixture("box-digest.json").getValue("cases").jsonArray) {
            val hashes = case.jsonObject.getValue("hashes").jsonArray.map { it.jsonPrimitive.content }
            assertEquals(case.jsonObject.getValue("digest").jsonPrimitive.content, BoxDigest.of(hashes))
        }
    }

    @Test
    fun anSsccIsBuiltFromItsSerialAndGivesItBack() {
        for (case in fixture("sscc-serials.json").getValue("cases").jsonArray) {
            val extension = case.jsonObject.getValue("extension").jsonPrimitive.int
            val prefix = case.jsonObject.getValue("issuerPrefix").jsonPrimitive.content
            val serial = case.jsonObject.getValue("serial").jsonPrimitive.long
            val sscc = case.jsonObject.getValue("sscc").jsonPrimitive.content
            assertEquals(sscc, Sscc.build(extension, prefix, serial))
            assertEquals(serial, Sscc.serialOf(sscc, prefix))
        }
        assertNull(Sscc.serialOf("046006820000015000", "4600682"))
        assertNull(Sscc.serialOf("04600682000001500", "460068200"))
    }

    @Test
    fun theShiftCloseRulesAndReasonsAreTheHostsAndTheDomains() {
        val file = fixture("shift-close-reasons.json")
        assertEquals(file.getValue("codes").jsonArray.map { it.jsonPrimitive.content }, ShiftCloser.REASONS)
        for (case in file.getValue("required").jsonArray) {
            val planned = case.jsonObject["plannedQty"]?.let { if (it is JsonNull) null else it.jsonPrimitive.int }
            val actual = case.jsonObject.getValue("actualQty").jsonPrimitive.int
            assertEquals(case.toString(), case.jsonObject.getValue("required").jsonPrimitive.content.toBoolean(), ShiftCloser.reasonRequired(planned, actual))
        }
    }

    @Test
    fun theReceiptCodesAreTheHostsInTheHostsOrder() {
        val listed = fixture("fact-receipt-codes.json").getValue("codes").jsonArray.map { it.jsonPrimitive.content }
        assertEquals(listed, HostReceiptCode.ALL)
        assertEquals(23, listed.size)
        assertEquals(RejectionHint.PALLET_CONFLICT, HostReceiptCode.hintOf("box_on_pallet"))
        assertEquals(RejectionHint.OTHER_DEVICE_OR_CLOSED, HostReceiptCode.hintOf("not_entered"))
        assertEquals(RejectionHint.OTHER_DEVICE_OR_CLOSED, HostReceiptCode.hintOf("unknown_shift"))
        assertEquals(RejectionHint.LICENSE, HostReceiptCode.hintOf("feature_disabled"))
        assertEquals(RejectionHint.BUG, HostReceiptCode.hintOf("payload_mismatch"))
        assertEquals(RejectionHint.DATA, HostReceiptCode.hintOf("sscc_taken"))
        // A code a newer host adds does not fail the batch.
        assertEquals(RejectionHint.DATA, HostReceiptCode.hintOf("a_code_of_protocol_9"))
    }

    @Test
    fun theHelloEnvelopeDecidesWhoMustUpdate() {
        val expected = mapOf(
            "compatible" to HostCompatibility.COMPATIBLE,
            "host_too_old" to HostCompatibility.HOST_TOO_OLD,
            "app_too_old" to HostCompatibility.APP_TOO_OLD,
        )
        for (case in fixture("compatibility.json").getValue("cases").jsonArray) {
            val host = case.jsonObject.getValue("host").jsonObject
            assertEquals(
                case.toString(),
                expected.getValue(case.jsonObject.getValue("expected").jsonPrimitive.content),
                HostCompat.decide(
                    case.jsonObject.getValue("client").jsonPrimitive.int,
                    host.getValue("protocol").jsonPrimitive.int,
                    host.getValue("minProtocol").jsonPrimitive.int,
                ),
            )
        }
        assertEquals(6, HostCompat.PROTOCOL)
        assertEquals(fixture("hello.json").getValue("minProtocol").jsonPrimitive.int, HostCompat.MIN_PROTOCOL)
    }

    @Test
    fun aScanIsClassifiedAsTheDomainClassifiesIt() {
        assertEquals("sscc", ScanRawKind.classify("(00)046006820000015000"))
        assertEquals("sscc", ScanRawKind.classify(" 146006820000000409 "))
        assertEquals("gtin", ScanRawKind.classify("04600682000013"))
        assertEquals("km", ScanRawKind.classify("0104600682000013" + "21A1\u001d93dGVz"))
        assertEquals("unknown", ScanRawKind.classify("не код"))
        assertEquals("unknown", ScanRawKind.classify(""))
    }
}
```

`HostLabelSpecParityTest.kt`:

```kotlin
package app.markiro.handheld.core.label

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The label layouts of the host are the domain's (`labelTemplateSpecSchema`), so the app's codec reads them
 * (plan ТСД-А, task С1; spec 7.2, risk Р-11): every template of the host's feed fixtures and of the wizard's
 * stock templates is read, and the layout survives with the geometry and the element kinds it had.
 */
class HostLabelSpecParityTest {
    private fun fixture(name: String): JsonObject = Json.parseToJsonElement(
        checkNotNull(javaClass.classLoader?.getResource(name)) { name }.readText(),
    ).jsonObject

    @Test
    fun everyTemplateOfTheHostsFeedIsReadByTheAppsCodec() {
        val specs = fixture("changes-catalog.json").getValue("items").jsonArray
            .map { it.jsonObject }
            .filter { it.getValue("entity").jsonPrimitive.content == "label_templates" && it["data"] != null }
            .map { it.getValue("data").jsonObject.getValue("spec").jsonObject }
        assertTrue(specs.size >= 2)
        for (spec in specs) {
            val read = LabelSpecCodec.spec(spec)
            assertEquals(spec.getValue("widthMm").jsonPrimitive.content.toDouble(), read.widthMm, 0.0)
            assertEquals(spec.getValue("dpi").jsonPrimitive.content.toInt(), read.dpi)
            assertEquals(spec.getValue("elements").jsonArray.size, read.elements.size)
        }
    }

    @Test
    fun theWizardsStockTemplatesAreReadToo() {
        val templates = fixture("bootstrap-request-templates.json").getValue("templates").jsonArray
        assertTrue(templates.isNotEmpty())
        for (template in templates) {
            val spec = template.jsonObject.getValue("spec").jsonObject
            val read = LabelSpecCodec.spec(spec)
            assertEquals(spec.getValue("elements").jsonArray.size, read.elements.size)
        }
    }
}
```

(`LabelSpec` в приложении: `widthMm: Double`, `dpi: Int`, `elements` — как в `LabelSpecCodec.spec`.)

Run: `$GR :app:testDebugUnitTest --tests 'app.markiro.handheld.core.network.host.HostFixturesTest' --tests 'app.markiro.handheld.core.label.HostLabelSpecParityTest'`
Expected: ошибка компиляции (`CertPin`, `HostPairingCode`, … не определены) — затем, после шага 3, `BUILD SUCCESSFUL`.

- [ ] **Step 2: ресурсы.** `app/build.gradle.kts`, рядом со строкой `sourceSets["test"].resources.srcDir("../../../packages/platform-contracts/fixtures")`:

```kotlin
    // The host's wire fixtures (apps/standalone/proto/fixtures): the same files the Rust crate and the webview read,
    // so a rule the host changes fails here too. `tools/ci/affected.mjs` runs this job when one of them changes.
    sourceSets["test"].resources.srcDir("../../standalone/proto/fixtures")
```

(путь от `apps/handheld/app`: `../../standalone/proto/fixtures` = `apps/standalone/proto/fixtures`; имена не пересекаются с
`src/test/resources` и `packages/platform-contracts/fixtures`: проверено `comm` по спискам файлов.)

- [ ] **Step 3: реализация.**

  `core/network/host/CertPin.kt`:

```kotlin
package app.markiro.handheld.core.network.host

import java.security.MessageDigest

/**
 * The pin of a host's certificate: the lower-case hex SHA-256 of its DER (`markiro_proto::certificate_fingerprint`). A
 * device trusts exactly this one certificate; the names inside it do not matter. Kept in one small file for review (risk Р-10).
 */
object CertPin {
    private val HEX64 = Regex("^[0-9a-f]{64}$")

    fun isFingerprint(text: String): Boolean = HEX64.matches(text)

    fun fingerprintOf(der: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(der).joinToString("") { "%02x".format(it.toInt() and 0xff) }

    /** What the person compares with the office's screen: the first 32 characters, upper case, in groups of four. */
    fun display(fingerprint: String): String = fingerprint.take(32).uppercase().chunked(4).joinToString(" ")

    /** Whether `der` is the certificate `expected` names. Constant time over the two digests; a malformed pin matches nothing. */
    fun matches(expected: String, der: ByteArray): Boolean {
        if (!isFingerprint(expected)) return false
        return MessageDigest.isEqual(
            fingerprintOf(der).toByteArray(Charsets.US_ASCII),
            expected.toByteArray(Charsets.US_ASCII),
        )
    }
}
```

`core/network/host/HostCompat.kt`:

```kotlin
package app.markiro.handheld.core.network.host

enum class HostCompatibility { COMPATIBLE, HOST_TOO_OLD, APP_TOO_OLD }

/** `markiro_proto::compatibility_for`: who must update, decided from the `hello` envelope before anything else is read. */
object HostCompat {
    /** The protocol this build speaks (`PROTOCOL_VERSION` of the host crate). */
    const val PROTOCOL = 6

    /** The oldest protocol this build still speaks to (`MIN_PROTOCOL_VERSION`). */
    const val MIN_PROTOCOL = 1

    fun decide(clientProtocol: Int, hostProtocol: Int, hostMinProtocol: Int): HostCompatibility = when {
        clientProtocol > hostProtocol -> HostCompatibility.HOST_TOO_OLD
        clientProtocol < hostMinProtocol -> HostCompatibility.APP_TOO_OLD
        else -> HostCompatibility.COMPATIBLE
    }
}
```

`core/network/host/HostReceiptCode.kt`:

```kotlin
package app.markiro.handheld.core.network.host

/** What a person should be told about a `rejected` receipt (spec 8.5, point 2). */
enum class RejectionHint {
    /** The shift is closed, unknown to the host, or another device works it. */
    OTHER_DEVICE_OR_CLOSED,

    /** The same id came with other content: a defect of this app, for support. */
    BUG,

    /** The license has no pallets feature. */
    LICENSE,

    /** A box stands on another pallet (`details.palletSscc`, `details.palletId`). */
    PALLET_CONFLICT,

    /** Any other refusal of the record's data. */
    DATA,
}

/** `markiro_proto::receipt_codes`, in the order of `fact-receipt-codes.json`. A code a newer host adds is `DATA`, never a failure of the batch. */
object HostReceiptCode {
    val ALL: List<String> = listOf(
        "invalid_record", "payload_mismatch", "unknown_shift", "not_entered", "gtin_mismatch", "box_unknown",
        "box_closed", "box_already_closed", "box_state", "sscc_not_issued", "sscc_taken", "no_pallets",
        "pallet_unknown", "pallet_already_closed", "pallet_state", "subject_unknown", "box_not_found",
        "box_not_closed", "box_on_pallet", "product_mismatch", "pallet_not_open", "pallet_count_mismatch",
        "feature_disabled",
    )

    fun hintOf(code: String?): RejectionHint = when (code) {
        "not_entered", "unknown_shift" -> RejectionHint.OTHER_DEVICE_OR_CLOSED
        "payload_mismatch" -> RejectionHint.BUG
        "feature_disabled" -> RejectionHint.LICENSE
        "box_on_pallet" -> RejectionHint.PALLET_CONFLICT
        else -> RejectionHint.DATA
    }
}
```

`feature/pairing/HostPairingCode.kt`:

```kotlin
package app.markiro.handheld.feature.pairing

import app.markiro.handheld.core.network.host.CertPin

/**
 * The host's one-time code (10 Crockford characters) and the payload of the office's DataMatrix
 * (`markiro-host:1?h=<a,b>&p=<port>&f=<fingerprint>&c=<code>`): `markiro_proto::pairing::normalize` and the webview's
 * `parsePairingPayload`, pinned by `pairing-codes.json` and `pairing-payloads.json`. The Russian-layout recovery of a keyboard
 * wedge stays in the webview.
 */
object HostPairingCode {
    const val LENGTH = 10
    private const val ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    private val IPV4 = Regex("^(0|[1-9]\\d{0,2})\\.(0|[1-9]\\d{0,2})\\.(0|[1-9]\\d{0,2})\\.(0|[1-9]\\d{0,2})$")
    private val PORT = Regex("^\\d{1,5}$")

    /** Unicode White_Space, exactly what Rust's `char::is_whitespace` accepts (Java's own tests miss U+0085 and others). */
    private fun isWhiteSpace(c: Char): Boolean =
        c in '\u0009'..'\u000d' || c == ' ' || c == '\u0085' || c == '\u00a0' || c == '\u1680' ||
            c in '\u2000'..'\u200a' || c == '\u2028' || c == '\u2029' || c == '\u202f' ||
            c == '\u205f' || c == '\u3000'

    /** The ASCII hyphen, the dashes U+2010..U+2015 and the minus sign U+2212. */
    private fun isDash(c: Char): Boolean = c == '-' || c in '\u2010'..'\u2015' || c == '\u2212'

    /**
     * The canonical form of a typed or scanned code: separators skipped, ASCII letters upper-cased, O read as 0, I and L as 1.
     * `null` when the input cannot be a code.
     */
    fun normalize(input: String): String? {
        val code = StringBuilder()
        for (symbol in input) {
            if (isWhiteSpace(symbol) || isDash(symbol)) continue
            val upper = if (symbol in 'a'..'z') symbol.uppercaseChar() else symbol
            val canonical = when (upper) {
                'O' -> '0'
                'I', 'L' -> '1'
                else -> upper
            }
            if (ALPHABET.indexOf(canonical) < 0) return null
            code.append(canonical)
            if (code.length > LENGTH) return null
        }
        return code.toString().takeIf { it.length == LENGTH }
    }

    data class Payload(val addresses: List<String>, val port: Int, val fingerprint: String, val code: String)

    private fun trimmed(text: String): String {
        var start = 0
        var end = text.length
        while (start < end && isWhiteSpace(text[start])) start++
        while (end > start && isWhiteSpace(text[end - 1])) end--
        return text.substring(start, end)
    }

    private fun isIpv4(address: String): Boolean {
        val match = IPV4.matchEntire(address) ?: return false
        return match.groupValues.drop(1).all { it.toInt() <= 255 }
    }

    /** The payload of a scan: plain, behind the AIM identifier `]d1`, or typed with Caps Lock on. `null` when it is no payload of protocol 1. */
    fun parsePayload(text: String): Payload? {
        val body = trimmed(text).replace(Regex("^\\][dD]\\d"), "")
        val query = body.indexOf('?')
        if (query < 0 || !body.substring(0, query).equals("markiro-host:1", ignoreCase = true)) return null
        val fields = HashMap<String, String>()
        for (field in body.substring(query + 1).split("&")) {
            val equals = field.indexOf('=')
            if (equals < 0) return null
            val key = field.substring(0, equals).lowercase()
            if (key in fields) return null
            fields[key] = field.substring(equals + 1)
        }
        val hosts = fields["h"] ?: return null
        val port = fields["p"] ?: return null
        val fingerprint = fields["f"]?.lowercase() ?: return null
        val code = normalize(fields["c"] ?: "") ?: return null
        val addresses = if (hosts.isEmpty()) emptyList() else hosts.split(",")
        val portNumber = if (PORT.matches(port)) port.toInt() else 0
        if (!addresses.all(::isIpv4) || portNumber !in 1..65535) return null
        if (!CertPin.isFingerprint(fingerprint)) return null
        return Payload(addresses, portNumber, fingerprint, code)
    }
}
```

`core/box/BoxDigest.kt`:

```kotlin
package app.markiro.handheld.core.box

import java.security.MessageDigest

/** The domain's `boxMembershipDigestV1` (`box-digest.json`): SHA-256 of `markiro:box-members:v1\n` and the code hashes in byte order, joined by line feeds. */
object BoxDigest {
    fun of(codeHashes: List<String>): String {
        val text = "markiro:box-members:v1\n" + codeHashes.sorted().joinToString("\n")
        return MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it.toInt() and 0xff) }
    }
}
```

`core/km/ScanRawKind.kt`:

```kotlin
package app.markiro.handheld.core.km

import app.markiro.handheld.core.box.Sscc

/** What the domain's `classifyScan` read a scan as (`ScanFact.rawKind`): an SSCC, a GTIN, a code of marking, or nothing it knows. */
object ScanRawKind {
    fun classify(raw: String): String {
        val trimmed = raw.trim()
        if (Sscc.parse(trimmed) != null) return "sscc"
        if (runCatching { KmCodec.normalizeGtin14(trimmed) }.isSuccess) return "gtin"
        return if (runCatching { KmCodec.canonicalize(raw) }.isSuccess) "km" else "unknown"
    }
}
```

`core/util/Iso.kt`: добавьте

```kotlin
    /** Exactly what the host reads as a device's instant (`rules::device_instant`): 24 characters, an UTC instant with milliseconds, written back the same. */
    fun isDeviceInstant(text: String): Boolean {
        if (text.length != 24) return false
        val millis = parse(text) ?: return false
        return format(millis) == text
    }
```

`core/box/Sscc.kt`: добавьте

```kotlin
    /** The serial an SSCC of issuer prefix `gs1Prefix` carries, or null when the 18 digits are not of that prefix. */
    fun serialOf(sscc: String, gs1Prefix: String): Long? {
        if (sscc.length != 18 || !sscc.all(Char::isDigit) || !PREFIX.matches(gs1Prefix)) return null
        if (sscc.substring(1, 1 + gs1Prefix.length) != gs1Prefix) return null
        return sscc.substring(1 + gs1Prefix.length, 17).toLongOrNull()
    }
```

Теперь доработайте тест по замечанию шага 1 (одно честное утверждение о `MIN_PROTOCOL`, без заглушек).

- [ ] **Step 4: запустить, увидеть успех.**

  Run: `$GR :app:testDebugUnitTest --tests 'app.markiro.handheld.core.network.host.HostFixturesTest' --tests 'app.markiro.handheld.core.label.HostLabelSpecParityTest'`
  Expected: `BUILD SUCCESSFUL`, `HostFixturesTest` — 10 тестов, `HostLabelSpecParityTest` — 2.

  Run: `$GR :app:testDebugUnitTest --tests 'app.markiro.handheld.core.km.*' --tests 'app.markiro.handheld.core.box.*' --tests 'app.markiro.handheld.core.label.*'`
  Expected: `BUILD SUCCESSFUL` (облачные тесты КМ, коробов и этикеток не затронуты).

- [ ] **Step 5: Commit.**

```bash
git -C "$WT" add apps/handheld/app/build.gradle.kts apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/network/host apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/pairing/HostPairingCode.kt apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/box/BoxDigest.kt apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/box/Sscc.kt apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/km/ScanRawKind.kt apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/util/Iso.kt apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/network/host apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/label/HostLabelSpecParityTest.kt
git -C "$WT" commit -m "feat(handheld): host wire fixtures in the tests and the parity classes (pin, code, digest, receipts)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

## Task С2: сетевой слой хоста — закреплённый сертификат, режим наблюдения, только HTTPS, разбор ответов и ошибок

**Files:**

- Modify: `apps/handheld/gradle/libs.versions.toml` (`okhttp-tls`), `apps/handheld/app/build.gradle.kts` (`testImplementation(libs.okhttp.tls)`)
- Create: `core/network/host/PinnedTrust.kt`, `core/network/host/HostHttpClient.kt`, `core/network/host/HostTransport.kt`,
  `core/network/host/HostDtos.kt`, `core/network/host/HostApi.kt`, `core/network/host/HostFailure.kt`
- Test: `app/src/test/kotlin/app/markiro/handheld/core/network/host/PinnedTrustTest.kt`, `HostApiTest.kt`

**Interfaces:**

- Consumes: С1 (`CertPin`, `HostCompat`, `HostReceiptCode`), `ReachabilityTracker`.
- Produces: `PinnedTrustManager(expected)`, `ObservingTrustManager`, `FingerprintMismatch`; `HostHttpClient.pinned(pin, key)` и
  `HostHttpClient.observing(observer)` (оба — `OkHttpClient`); `HostTransport` (интерфейс: `get`, `post` → `HostResult`) и его реализация
  на OkHttp; `HostApi` с вызовами `hello`, `observe`, `claim`, `device`, `changes`, `shifts`, `enter`, `block`, `knownBlocks`, `postFacts`,
  `postPalletEvents`, `boxRegistry`, `orgPrint`; `HostFailure`/`HostApiError`. Их потребляют С4 (сопряжение), С5 (лента), Д1–Д3.

Решения, которых нет в спецификации:

- Слой — на «голом» OkHttp и kotlinx.serialization, без Retrofit: запись очереди уходит замороженными байтами (как `SyncTransport`
  облака), а остальным вызовам хоста Retrofit не даёт ничего, кроме второго клиента с чужим соглашением об ошибках.
- Сертификат закрепляется целиком по SHA-256 от DER листа (`CertificatePinner` OkHttp не годится: он требует доверенной цепочки).

- [ ] **Step 1: зависимость и падающие тесты.** В `gradle/libs.versions.toml`, рядом с `okhttp-mockwebserver`:
      `okhttp-tls = { module = "com.squareup.okhttp3:okhttp-tls", version.ref = "okhttp" }`; в `app/build.gradle.kts` к `testImplementation(libs.okhttp.mockwebserver)` добавьте
      `testImplementation(libs.okhttp.tls)`.

  `PinnedTrustTest.kt`:

```kotlin
package app.markiro.handheld.core.network.host

import kotlinx.coroutines.test.runTest
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

/**
 * Risk Р-10 of the spec: a pinned trust manager that accepts anything would lose the whole protection, so the negative
 * tests come first. Real TLS over MockWebServer with throw-away ECDSA certificates (the host's own is ECDSA P-256 too).
 */
class PinnedTrustTest {
    private val servers = mutableListOf<MockWebServer>()

    @After
    fun stop() = servers.forEach { it.shutdown() }

    /** A TLS server with `certificate` whose names are NOT 127.0.0.1: the pin, not the name, must decide. */
    private fun serverOf(certificate: HeldCertificate): MockWebServer {
        val handshake = HandshakeCertificates.Builder().heldCertificate(certificate).build()
        return MockWebServer().also {
            it.useHttps(handshake.sslSocketFactory(), false)
            it.start()
            servers += it
        }
    }

    private fun certificate(name: String) =
        HeldCertificate.Builder().commonName(name).addSubjectAlternativeName("host-$name.invalid").build()

    private fun pinOf(certificate: HeldCertificate) = CertPin.fingerprintOf(certificate.certificate.encoded)

    private fun get(client: okhttp3.OkHttpClient, server: MockWebServer, path: String = "/v1/hello") =
        client.newCall(Request.Builder().url(server.url(path)).build())

    @Test
    fun theCertificateOfThePinIsTrustedWhateverItsNamesAre() {
        val host = certificate("markiro-host")
        val server = serverOf(host).also { it.enqueue(MockResponse().setBody("""{"ok":true}""")) }
        val client = HostHttpClient.pinned(pinOf(host)) { "device-key" }
        get(client, server).execute().use { response -> assertEquals(200, response.code) }
        val request = server.takeRequest()
        assertEquals("Bearer device-key", request.getHeader("Authorization"))
        assertEquals(HostCompat.PROTOCOL.toString(), request.getHeader("x-markiro-protocol"))
        assertTrue(request.getHeader("x-markiro-app-version").orEmpty().isNotBlank())
    }

    @Test
    fun anotherCertificateIsRefusedAtTheHandshakeAndNoRequestReachesTheServer() {
        val paired = certificate("paired")
        val impostor = certificate("impostor")
        val server = serverOf(impostor).also { it.enqueue(MockResponse().setBody("secret")) }
        val client = HostHttpClient.pinned(pinOf(paired)) { "device-key" }
        val failure = runCatching { get(client, server).execute().close() }.exceptionOrNull()
        assertTrue("$failure", failure is IOException)
        assertTrue(generateSequence(failure) { it.cause }.any { it is FingerprintMismatch })
        assertEquals("not a byte of the request leaves the device", 0, server.requestCount)
    }

    @Test
    fun aMalformedPinTrustsNothing() {
        val host = certificate("markiro-host")
        val server = serverOf(host).also { it.enqueue(MockResponse()) }
        for (pin in listOf("", "AB".repeat(32), "ab".repeat(31), "zz".repeat(32))) {
            val client = HostHttpClient.pinned(pin) { "k" }
            assertTrue(pin, runCatching { get(client, server).execute().close() }.isFailure)
        }
        assertEquals(0, server.requestCount)
    }

    @Test
    fun theObservingClientReadsTheFingerprintAndSendsNothingButAHello() = runTest {
        val host = certificate("markiro-host")
        val server = serverOf(host).also {
            it.enqueue(
                MockResponse().setBody(
                    """{"product":"markiro-host","protocol":6,"minProtocol":1,"hostId":"3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f","version":"0.1.0","time":"2026-10-15T09:00:00Z","initialized":true}""",
                ),
            )
        }
        val observer = ObservingTrustManager()
        val hello = HostApi.observeHello(HostHttpClient.observing(observer), server.hostName, server.port)
        assertEquals(6, hello.protocol)
        assertEquals(pinOf(host), observer.observed)
        val request = server.takeRequest()
        assertEquals("GET", request.method)
        assertEquals("/v1/hello", request.path)
        assertNull("no key and no code go to a host that is not yet verified", request.getHeader("Authorization"))
        assertEquals(0L, request.bodySize)
    }

    @Test
    fun plainHttpIsRefusedBeforeAnyConnection() {
        val plain = MockWebServer().also { it.enqueue(MockResponse()); it.start(); servers += it }
        val client = HostHttpClient.pinned("ab".repeat(32)) { "k" }
        val failure = runCatching {
            client.newCall(Request.Builder().url(plain.url("/v1/hello")).build()).execute().close()
        }.exceptionOrNull()
        assertTrue("$failure", failure is IOException)
        assertEquals(0, plain.requestCount)
    }

    @Test
    fun aRedirectIsNotFollowed() {
        val host = certificate("markiro-host")
        val server = serverOf(host).also {
            it.enqueue(MockResponse().setResponseCode(302).addHeader("Location", "https://elsewhere.invalid/"))
        }
        val client = HostHttpClient.pinned(pinOf(host)) { "k" }
        get(client, server).execute().use { assertEquals(302, it.code) }
        assertEquals(1, server.requestCount)
    }
}
```

`HostApiTest.kt` (разбор ответов и ошибок на подставном транспорте):

```kotlin
package app.markiro.handheld.core.network.host

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class HostApiTest {
    private class FakeTransport(private val answers: ArrayDeque<HostResult>) : HostTransport {
        val sent = mutableListOf<Triple<String, String, String?>>()
        override suspend fun get(path: String): HostResult = answers.removeFirst().also { sent += Triple("GET", path, null) }
        override suspend fun post(path: String, body: String): HostResult = answers.removeFirst().also { sent += Triple("POST", path, body) }
    }

    private fun api(vararg answers: HostResult) = FakeTransport(ArrayDeque(answers.toList())).let { it to HostApi(it) }
    private fun ok(body: String, code: Int = 200) = HostResult.Ok(code, body, null)
    private fun error(code: Int, kind: String, details: String = "{}", retryAfter: Long? = null) =
        HostResult.Ok(code, """{"error":{"code":"$kind","message":"m","details":$details}}""", retryAfter)

    @Test
    fun aClaimSendsTheCapabilityAndReadsTheKey() = runTest {
        val (transport, host) = api(ok("""{"deviceId":"d1","deviceKey":"k1","hostId":"h1"}"""))
        val paired = host.claim(code = "7K3MQ9XV2D", name = "ТСД 1", appVersion = "1.3.0", recoverDeviceId = null).getOrThrow()
        assertEquals(Triple("d1", "k1", "h1"), Triple(paired.deviceId, paired.deviceKey, paired.hostId))
        val body = transport.sent.single().third.orEmpty()
        assertTrue(body.contains("\"kind\":\"handheld\"") && body.contains("\"capabilities\":[\"handheld-host-v1\"]"))
        assertTrue("no recoverDeviceId when none", !body.contains("recoverDeviceId"))
    }

    @Test
    fun everyRefusalOfTheHostHasItsOwnReason() = runTest {
        val cases = mapOf(
            error(400, "pairing_code_invalid") to HostFailure.PairingInvalid,
            error(400, "pairing_code_expired") to HostFailure.PairingExpired,
            error(429, "rate_limited") to HostFailure.RateLimited,
            error(409, "conflict", """{"constraint":"seat_limit"}""") to HostFailure.SeatLimit,
            error(409, "conflict", """{"constraint":"feature_disabled","feature":"handheld"}""") to HostFailure.FeatureDisabled,
            error(409, "conflict", """{"constraint":"license_restricted","state":"restricted"}""") to HostFailure.LicenseRestricted,
            error(409, "conflict", """{"constraint":"shift_busy"}""") to HostFailure.Constraint("shift_busy"),
            error(401, "unauthorized", """{"credential":"device"}""") to HostFailure.KeyRejected,
            error(403, "forbidden") to HostFailure.Forbidden,
            error(400, "protocol_unsupported") to HostFailure.ProtocolUnsupported,
            error(503, "restore_pending", """{"since":"2026-10-09T15:00:00Z"}""", retryAfter = 60) to HostFailure.RestorePending(60),
            HostResult.Ok(500, "boom", null) to HostFailure.ServerError(500),
        )
        for ((answer, expected) in cases) {
            val (_, host) = api(answer)
            assertEquals(expected, host.claim("7K3MQ9XV2D", "ТСД 1", "1.3.0", null).exceptionOrNull()?.let { (it as HostApiError).failure })
        }
    }

    @Test
    fun aTransportFailureIsUnreachableTimeoutOrACertificateMismatch() = runTest {
        for ((failure, expected) in listOf(
            HostResult.Failed(TransportFailure.UNREACHABLE) to HostFailure.Unreachable,
            HostResult.Failed(TransportFailure.TIMEOUT) to HostFailure.Timeout,
            HostResult.Failed(TransportFailure.CERT_MISMATCH) to HostFailure.CertificateMismatch,
        )) {
            val (_, host) = api(failure)
            assertEquals(expected, (host.device().exceptionOrNull() as HostApiError).failure)
        }
    }

    @Test
    fun anAnswerThatIsNoJsonOfTheShapeIsABadResponseNotACrash() = runTest {
        val (_, host) = api(ok("not json"))
        assertEquals(HostFailure.BadResponse, (host.device().exceptionOrNull() as HostApiError).failure)
    }

    @Test
    fun aBatchOfFactsGoesAsFrozenBytesAndItsReceiptsComeBackInOrder() = runTest {
        val (transport, host) = api(
            ok("""{"receipts":[{"id":"r1","outcome":"accepted"},{"id":"r2","outcome":"rejected","code":"box_on_pallet","details":{"palletSscc":null,"palletId":"p"}}]}"""),
        )
        val frozen = """{"records":[{"id":"r1"},{"id":"r2"}]}"""
        val receipts = host.postFacts(frozen).getOrThrow()
        assertEquals(frozen, transport.sent.single().third)
        assertEquals("/v1/device/facts", transport.sent.single().second)
        assertEquals(listOf("accepted", "rejected"), receipts.map { it.outcome })
        assertEquals("box_on_pallet", receipts[1].code)
    }
}
```

Run: `$GR :app:testDebugUnitTest --tests 'app.markiro.handheld.core.network.host.*'`
Expected: ошибка компиляции (`HostHttpClient`, `ObservingTrustManager`, `HostApi`, … не определены).

- [ ] **Step 2: реализация.**

  `PinnedTrust.kt`:

```kotlin
package app.markiro.handheld.core.network.host

import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.X509TrustManager

/** The certificate the host presents is not the one this device was paired with. Recognised by the cause chain of an `IOException`. */
class FingerprintMismatch(val seen: String) : CertificateException("the server's certificate is not the paired one")

/**
 * Trusts exactly one certificate: the SHA-256 of the leaf's DER equals the pin. Neither the chain, nor the dates, nor the names are
 * looked at — the certificate is self-signed and its names do not matter (the host's own `tls.rs` says so). The system's trust store
 * and user-installed certificates take no part. Risk Р-10: this file is small on purpose.
 */
class PinnedTrustManager(private val expected: String) : X509TrustManager {
    override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {
        throw CertificateException("this device does not authenticate clients")
    }

    override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
        val leaf = chain.firstOrNull() ?: throw CertificateException("the server sent no certificate")
        val der = leaf.encoded
        if (!CertPin.matches(expected, der)) throw FingerprintMismatch(CertPin.fingerprintOf(der))
    }

    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}

/**
 * For pairing by hand: accepts any certificate and remembers the leaf's fingerprint, so the person can compare it with the office's
 * screen. The client built with it only ever asks `GET /v1/hello` (`HostApi.observeHello`); a code or a key never goes through it.
 */
class ObservingTrustManager : X509TrustManager {
    @Volatile
    var observed: String? = null
        private set

    override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {
        throw CertificateException("this device does not authenticate clients")
    }

    override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
        val leaf = chain.firstOrNull() ?: throw CertificateException("the server sent no certificate")
        observed = CertPin.fingerprintOf(leaf.encoded)
    }

    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}
```

`HostHttpClient.kt`:

```kotlin
package app.markiro.handheld.core.network.host

import app.markiro.handheld.BuildConfig
import okhttp3.ConnectionSpec
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Response
import java.io.IOException
import java.net.Proxy
import java.security.SecureRandom
import java.util.concurrent.TimeUnit
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

/** Host mode speaks HTTPS only, in every build: the debug build's cleartext allowance is for the cloud's local API. */
private object HttpsOnly : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        if (!chain.request().url.isHttps) throw IOException("host mode speaks https only")
        return chain.proceed(chain.request())
    }
}

/** The headers the host asks of a device: its protocol and its app's version, and the key as a bearer token. */
private class DeviceHeaders(private val key: () -> String?) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val builder = chain.request().newBuilder()
            .header("x-markiro-protocol", HostCompat.PROTOCOL.toString())
            .header("x-markiro-app-version", BuildConfig.VERSION_NAME)
        key()?.let { builder.header("Authorization", "Bearer $it") }
        return chain.proceed(builder.build())
    }
}

object HostHttpClient {
    private fun base(): OkHttpClient.Builder = OkHttpClient.Builder()
        .proxy(Proxy.NO_PROXY)
        .followRedirects(false)
        .followSslRedirects(false)
        // MODERN_TLS: TLS 1.3 and 1.2 with the AEAD suites; no cleartext connection spec at all.
        .connectionSpecs(listOf(ConnectionSpec.MODERN_TLS))
        .connectTimeout(2, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .writeTimeout(10, TimeUnit.SECONDS)
        .callTimeout(30, TimeUnit.SECONDS)
        .addInterceptor(HttpsOnly)

    private fun OkHttpClient.Builder.trusting(trust: X509TrustManager, verifier: HostnameVerifier): OkHttpClient.Builder {
        val context = SSLContext.getInstance("TLS")
        context.init(null, arrayOf(trust), SecureRandom())
        return sslSocketFactory(context.socketFactory, trust).hostnameVerifier(verifier)
    }

    /**
     * The client of a paired device: it trusts the certificate whose fingerprint is `pin` and no other. The hostname check passes
     * only after the handshake went through [PinnedTrustManager]: it re-reads the peer's leaf and compares it with the pin, so the
     * single place that ignores the name is this one.
     */
    fun pinned(pin: String, key: () -> String?): OkHttpClient = base()
        .trusting(PinnedTrustManager(pin)) { _, session ->
            runCatching { CertPin.matches(pin, session.peerCertificates.first().encoded) }.getOrDefault(false)
        }
        .addInterceptor(DeviceHeaders(key))
        .build()

    /** The client for looking at a host that is not yet verified: no key, no code, certificate recorded in `observer`. */
    fun observing(observer: ObservingTrustManager): OkHttpClient = base()
        .trusting(observer) { _, _ -> true }
        .build()
}
```

`HostFailure.kt`:

```kotlin
package app.markiro.handheld.core.network.host

/** Why a call of the host did not give its answer (spec 8.1). */
sealed interface HostFailure {
    data object Unreachable : HostFailure
    data object Timeout : HostFailure

    /** The host presents another certificate than the paired one: never accepted silently (risk Р-2). */
    data object CertificateMismatch : HostFailure
    data object KeyRejected : HostFailure
    data object Forbidden : HostFailure
    data object PairingInvalid : HostFailure
    data object PairingExpired : HostFailure
    data object RateLimited : HostFailure
    data object SeatLimit : HostFailure
    data object FeatureDisabled : HostFailure
    data object LicenseRestricted : HostFailure
    data object ProtocolUnsupported : HostFailure
    data class RestorePending(val retryAfterSeconds: Long?) : HostFailure

    /** A `409 conflict` with a constraint of its own (`shift_busy`, `shift_line`, `station_update`, …). */
    data class Constraint(val name: String) : HostFailure
    data class ServerError(val status: Int) : HostFailure
    data object BadResponse : HostFailure
}

class HostApiError(val failure: HostFailure, val status: Int? = null) : Exception("host call failed: $failure")

enum class TransportFailure { UNREACHABLE, TIMEOUT, CERT_MISMATCH }
```

`HostTransport.kt`:

```kotlin
package app.markiro.handheld.core.network.host

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.net.SocketTimeoutException

sealed interface HostResult {
    data class Ok(val code: Int, val body: String, val retryAfterSeconds: Long?) : HostResult
    data class Failed(val failure: TransportFailure) : HostResult
}

interface HostTransport {
    suspend fun get(path: String): HostResult
    suspend fun post(path: String, body: String): HostResult
}

/** OkHttp over the pinned client: the body of a POST is the caller's bytes, never re-encoded (a retry is byte-identical). */
class OkHttpHostTransport(
    private val client: Call.Factory,
    private val origin: () -> String,
    private val onResponse: () -> Unit = {},
) : HostTransport {
    private val json = "application/json; charset=utf-8".toMediaType()

    override suspend fun get(path: String): HostResult = execute(Request.Builder().url(origin().trimEnd('/') + path).get().build())

    override suspend fun post(path: String, body: String): HostResult =
        execute(Request.Builder().url(origin().trimEnd('/') + path).post(body.toRequestBody(json)).build())

    private suspend fun execute(request: Request): HostResult = withContext(Dispatchers.IO) {
        try {
            client.newCall(request).execute().use { response ->
                onResponse()
                HostResult.Ok(response.code, response.body?.string().orEmpty(), response.header("Retry-After")?.toLongOrNull())
            }
        } catch (e: SocketTimeoutException) {
            HostResult.Failed(TransportFailure.TIMEOUT)
        } catch (e: IOException) {
            val mismatch = generateSequence<Throwable>(e) { it.cause }.any { it is FingerprintMismatch }
            HostResult.Failed(if (mismatch) TransportFailure.CERT_MISMATCH else TransportFailure.UNREACHABLE)
        }
    }
}
```

`HostDtos.kt` (ответы терпят неизвестные поля; запросы строятся явно):

```kotlin
package app.markiro.handheld.core.network.host

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

@Serializable
data class HelloDto(
    val product: String,
    val protocol: Int,
    val minProtocol: Int,
    val hostId: String,
    val version: String? = null,
    val time: String? = null,
    val initialized: Boolean = true,
    val restoreEpoch: String? = null,
)

@Serializable
data class PairedDto(val deviceId: String, val deviceKey: String, val hostId: String)

@Serializable
data class DeviceInfoDto(val id: String, val kind: String, val name: String, val lineId: String? = null, val pairedAt: String? = null)

@Serializable
data class ChangeItemDto(val entity: String, val id: String, val rev: Long, val deleted: Boolean, val data: JsonObject? = null)

@Serializable
data class ChangesDto(val hostId: String, val rev: Long, val hasMore: Boolean, val items: List<ChangeItemDto>)

@Serializable
data class SsccBlockDto(val id: String, val issuerPrefix: String, val extension: Int, val fromSerial: Long, val toSerial: Long)

@Serializable
data class ShiftSnapshotDto(
    val product: JsonObject,
    val boxTemplate: JsonObject,
    val issuerPrefix: String,
    val counterpartyName: String? = null,
    val palletTemplate: JsonObject? = null,
    val organization: JsonObject? = null,
)

@Serializable
data class DeviceShiftDto(
    val id: String,
    val number: String,
    val status: String,
    val mode: String,
    val palletsEnabled: Boolean = false,
    val lineId: String,
    val productId: String,
    val productName: String,
    val productGtin14: String,
    val counterpartyName: String? = null,
    val productionDate: String,
    val plannedDate: String? = null,
    val plannedQty: Int? = null,
    val boxCapacity: Int,
    val palletBoxCapacity: Int? = null,
    val ownerDeviceId: String? = null,
    val openedAt: String? = null,
    val closedAt: String? = null,
    val snapshot: ShiftSnapshotDto? = null,
)

@Serializable
data class DeviceShiftsDto(val shifts: List<DeviceShiftDto>)

@Serializable
data class FactReceiptDto(val id: String? = null, val outcome: String, val code: String? = null, val details: JsonObject? = null)

@Serializable
data class FactReceiptsDto(val receipts: List<FactReceiptDto>)

@Serializable
data class OrgPrintDto(val name: String, val inn: String? = null, val issuerPrefix: String, val logo: JsonElement? = null)

@Serializable
data class ErrorEnvelopeDto(val error: ErrorDto)

@Serializable
data class ErrorDto(val code: String, val message: String? = null, val details: JsonObject? = null)
```

`HostApi.kt`:

```kotlin
package app.markiro.handheld.core.network.host

import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import java.io.IOException

/** The calls of the host's protocol (spec 5, 8.1). Every call answers a `Result`; a failure is a [HostApiError]. */
class HostApi(private val transport: HostTransport, private val json: Json = Json { ignoreUnknownKeys = true }) {
    private fun failureOf(result: HostResult.Ok): HostFailure {
        val error = runCatching { json.decodeFromString(ErrorEnvelopeDto.serializer(), result.body).error }.getOrNull()
            ?: return if (result.code >= 500) HostFailure.ServerError(result.code) else HostFailure.BadResponse
        val constraint = error.details?.get("constraint")?.jsonPrimitive?.contentOrNull
        return when {
            error.code == "restore_pending" -> HostFailure.RestorePending(result.retryAfterSeconds)
            error.code == "unauthorized" && error.details?.get("credential")?.jsonPrimitive?.contentOrNull == "device" -> HostFailure.KeyRejected
            error.code == "forbidden" -> HostFailure.Forbidden
            error.code == "pairing_code_invalid" -> HostFailure.PairingInvalid
            error.code == "pairing_code_expired" -> HostFailure.PairingExpired
            error.code == "rate_limited" -> HostFailure.RateLimited
            error.code == "protocol_unsupported" -> HostFailure.ProtocolUnsupported
            constraint == "seat_limit" -> HostFailure.SeatLimit
            constraint == "feature_disabled" -> HostFailure.FeatureDisabled
            constraint == "license_restricted" -> HostFailure.LicenseRestricted
            constraint != null -> HostFailure.Constraint(constraint)
            result.code >= 500 -> HostFailure.ServerError(result.code)
            else -> HostFailure.BadResponse
        }
    }

    private fun <T> parse(result: HostResult, serializer: KSerializer<T>): Result<T> = when (result) {
        is HostResult.Failed -> Result.failure(
            HostApiError(
                when (result.failure) {
                    TransportFailure.UNREACHABLE -> HostFailure.Unreachable
                    TransportFailure.TIMEOUT -> HostFailure.Timeout
                    TransportFailure.CERT_MISMATCH -> HostFailure.CertificateMismatch
                },
            ),
        )
        is HostResult.Ok ->
            if (result.code in 200..299) {
                runCatching { json.decodeFromString(serializer, result.body) }
                    .fold({ Result.success(it) }, { Result.failure(HostApiError(HostFailure.BadResponse, result.code)) })
            } else {
                Result.failure(HostApiError(failureOf(result), result.code))
            }
    }

    suspend fun hello(): Result<HelloDto> = parse(transport.get("/v1/hello"), HelloDto.serializer())

    suspend fun claim(code: String, name: String, appVersion: String, recoverDeviceId: String?): Result<PairedDto> {
        val body = buildJsonObject {
            put("code", code)
            put("kind", "handheld")
            put("name", name)
            put("appVersion", appVersion)
            put("capabilities", JsonArray(listOf(JsonPrimitive(CAPABILITY))))
            if (recoverDeviceId != null) put("recoverDeviceId", recoverDeviceId)
        }.toString()
        return parse(transport.post("/v1/pairing/claim", body), PairedDto.serializer())
    }

    suspend fun device(): Result<DeviceInfoDto> = parse(transport.get("/v1/device"), DeviceInfoDto.serializer())

    suspend fun changes(since: Long, limit: Int = 500): Result<ChangesDto> =
        parse(transport.get("/v1/changes?since=$since&limit=$limit"), ChangesDto.serializer())

    suspend fun shifts(): Result<DeviceShiftsDto> = parse(transport.get("/v1/device/shifts"), DeviceShiftsDto.serializer())

    suspend fun enter(shiftId: String): Result<DeviceShiftDto> {
        val body = buildJsonObject { put("supports", JsonArray(listOf(JsonPrimitive(CAPABILITY)))) }.toString()
        return parse(transport.post("/v1/device/shifts/$shiftId/enter", body), DeviceShiftDto.serializer())
    }

    suspend fun block(requestId: String, issuerPrefix: String, extension: Int): Result<SsccBlockDto> {
        val body = buildJsonObject {
            put("requestId", requestId)
            put("issuerPrefix", issuerPrefix)
            put("extension", extension)
        }.toString()
        return parse(transport.post("/v1/device/sscc/blocks", body), SsccBlockDto.serializer())
    }

    /** `body` is the batch as frozen by the caller (`{"records":[…]}`): sent as it is, so a retry is byte-identical. */
    suspend fun postFacts(body: String): Result<List<FactReceiptDto>> =
        parse(transport.post("/v1/device/facts", body), FactReceiptsDto.serializer()).map { it.receipts }

    suspend fun postPalletEvents(body: String): Result<List<FactReceiptDto>> =
        parse(transport.post("/v1/device/pallet-events", body), FactReceiptsDto.serializer()).map { it.receipts }

    suspend fun orgPrint(): Result<OrgPrintDto> = parse(transport.get("/v1/device/org/print"), OrgPrintDto.serializer())

    /** One page of the registry of closed boxes; `until` is null on the first page of a walk. */
    suspend fun boxRegistry(since: String?, until: String?, cursor: String?, limit: Int): Result<JsonObject> {
        val query = buildList {
            add("limit=$limit")
            since?.let { add("since=" + java.net.URLEncoder.encode(it, "UTF-8")) }
            until?.let { add("until=" + java.net.URLEncoder.encode(it, "UTF-8")) }
            cursor?.let { add("cursor=" + java.net.URLEncoder.encode(it, "UTF-8")) }
        }.joinToString("&")
        return parse(transport.get("/v1/device/box-registry?$query"), JsonObject.serializer())
    }

    companion object {
        const val CAPABILITY = "handheld-host-v1"

        /**
         * `GET /v1/hello` through the observing client, the certificate recorded by `client`'s trust manager. The only thing a host that
         * is not yet verified is asked. Throws [IOException] when the host does not answer.
         */
        suspend fun observeHello(client: OkHttpClient, host: String, port: Int): HelloDto {
            val transport = OkHttpHostTransport(client, { "https://$host:$port" })
            return HostApi(transport).hello().getOrElse { throw IOException("the host did not answer hello", it) }
        }
    }
}
```

- [ ] **Step 3: запустить, увидеть успех.**

  Run: `$GR :app:testDebugUnitTest --tests 'app.markiro.handheld.core.network.host.*'`
  Expected: `BUILD SUCCESSFUL` (`PinnedTrustTest` — 6, `HostApiTest` — 5, `HostFixturesTest` — 10).

  Run: `$GR :app:testDebugUnitTest --tests 'app.markiro.handheld.core.network.*'`
  Expected: `BUILD SUCCESSFUL` (облачные `InterceptorsTest`, `PairingClientTest` и др. не затронуты).

- [ ] **Step 4: Commit.**

```bash
git -C "$WT" add apps/handheld/gradle/libs.versions.toml apps/handheld/app/build.gradle.kts apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/network/host apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/network/host
git -C "$WT" commit -m "feat(handheld): host network layer — pinned certificate, observe-only pairing, https only

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

## Task С3: шов `StationBackend`, Room 21 и защита от облачных вызовов в режиме `host`

**Files:**

- Create: `core/backend/StationBackend.kt`, `core/backend/CloudBackend.kt`, `core/backend/BackendSelector.kt`, `core/backend/BackendModule.kt`,
  `core/backend/BackendGuardInterceptor.kt`
- Modify: `core/storage/Entities.kt` (`DeviceConfigEntity`), `core/storage/DeviceRecovery.kt` (`DeviceRecoveryEntity.pinSha256`),
  `core/storage/BoxEntities.kt` (`SsccRangeEntity.blockId`), `core/storage/Migrations.kt` (`MIGRATION_20_21`),
  `core/storage/HandheldDatabase.kt` (версия 21, сущности, DAO), `core/storage/StorageModule.kt` (миграция в список),
  `core/storage/OperatorBadgeEntities.kt` (новый), `core/storage/HostOutboxEntities.kt` (новый)
- Modify: `core/network/NetworkModule.kt` (защитный перехватчик), `feature/hub/RosterRefresher.kt`, `feature/shift/ShiftRepository.kt`,
  `feature/shift/ShiftModule.kt`, `feature/shift/BoxSerialTopUp.kt` (вызов), `core/pallets/PalletBootstrapMirror.kt`,
  `core/pallets/BoxRegistryMirror.kt`, `core/pallets/PalletsModule.kt`, `feature/hub/HubViewModel.kt`, `core/grants/GrantRepository.kt`
- Modify (тесты): `GrantMigrationTest.kt`, `MigrationTest.kt`, `PrinterRoutingMigrationTest.kt`, `DeviceRecoveryMigrationTest.kt`,
  `WarehousePalletMigrationTest.kt`, `ValidationMigrationTest.kt`, `ReplacementMigrationTest.kt` — в список `addMigrations(…)` добавляется `MIGRATION_20_21`
- Test: `core/backend/BackendSelectorTest.kt`, `core/storage/HostMigrationTest.kt`, `core/backend/BackendGuardTest.kt`, `core/grants/GrantHostModeTest.kt`

**Interfaces:**

- Consumes: С1, С2 (пока ничего не вызывают из хоста: `HostBackend` появляется в С4–Д1, здесь — заглушка `NotPairedHostBackend`).
- Produces: `BackendKind { CLOUD, HOST }`; `StationBackend` (методы `kindNow`, `cloudApi`, `operators`, `shifts`, `enter`, `bundle`,
  `topUpBoxSscc`, `palletBootstrap`, `boxRegistry`, `hubCounts`); `CloudBackend(api)`; `BackendSelector(config, cloud, host)`;
  таблицы `operator_badges`, `host_outbox`; колонки `device_config.{backend, pinSha256, hostId, hostAddresses, hostRestoreEpoch, hostRev}`,
  `device_recovery.pinSha256`, `sscc_pool.blockId`; `HANDHELD_DATABASE_VERSION = 21`.

Решения, которых нет в спецификации (8.4 даёт колонки в `BoxEntity`/`PalletEntity`):

- `blockId` хранится в строке пула SSCC, а не в коробе и паллете: серийный номер выводится из SSCC (`Sscc.serialOf`), блок находится по
  `(префикс, расширение, серийный номер)` в пуле. Облачные короба и паллеты не получают лишних колонок.
- Очередь хоста — одна таблица `host_outbox` рядом с облачными очередями (спецификация оставляла выбор плану): облачный `SyncEngine` она не касается.

- [ ] **Step 1: написать падающие тесты.**

  `core/backend/BackendSelectorTest.kt`:

```kotlin
package app.markiro.handheld.core.backend

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.network.RosterResponse
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.syntheticDeviceConfig
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class BackendSelectorTest {
    private lateinit var db: HandheldDatabase

    @Before
    fun open() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
    }

    @After
    fun close() = db.close()

    private class Marker(private val type: BackendKind, private val name: String) : StationBackend by NoBackend {
        val calls = mutableListOf<String>()
        override suspend fun kindNow() = type
        override suspend fun operators() = RosterResponse(emptyList()).also { calls += name }
    }

    @Test
    fun aDeviceWithoutConfigOrWithTheCloudBackendUsesTheCloud() = runTest {
        val cloud = Marker(BackendKind.CLOUD, "cloud")
        val host = Marker(BackendKind.HOST, "host")
        val selector = BackendSelector(db.deviceConfigDao(), cloud, host)
        assertEquals(BackendKind.CLOUD, selector.kindNow())
        db.deviceConfigDao().upsert(syntheticDeviceConfig())
        selector.operators()
        assertEquals(listOf("cloud"), cloud.calls)
        assertEquals(emptyList<String>(), host.calls)
    }

    @Test
    fun aDevicePairedWithAHostUsesTheHostAndNeverTheCloud() = runTest {
        val cloud = Marker(BackendKind.CLOUD, "cloud")
        val host = Marker(BackendKind.HOST, "host")
        db.deviceConfigDao().upsert(syntheticDeviceConfig().copy(backend = "host", pinSha256 = "ab".repeat(32), hostId = "h"))
        val selector = BackendSelector(db.deviceConfigDao(), cloud, host)
        assertEquals(BackendKind.HOST, selector.kindNow())
        selector.operators()
        assertEquals(listOf("host"), host.calls)
        assertEquals(emptyList<String>(), cloud.calls)
        assertSame(null, selector.cloudApi())
    }
}
```

(`NoBackend` — объект в `StationBackend.kt`, реализующий интерфейс исключениями `UnsupportedOperationException`: тестовые двойники и
`NotPairedHostBackend` делегируют ему.)

`core/storage/HostMigrationTest.kt` (приём `WarehousePalletMigrationTest`: построить текущую схему, отмотать новое, открыть с миграциями):

```kotlin
package app.markiro.handheld.core.storage

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith

/** A cloud terminal of version 20 with a live queue upgrades to 21 and loses nothing (spec 10: "облачный остаётся облачным"). */
@RunWith(AndroidJUnit4::class)
class HostMigrationTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()

    private fun database(name: String) = Room.databaseBuilder(context, HandheldDatabase::class.java, name)
        .allowMainThreadQueries()
        .addMigrations(
            MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4, MIGRATION_4_5, MIGRATION_5_6, MIGRATION_6_7, MIGRATION_7_8,
            MIGRATION_8_9, MIGRATION_9_10, MIGRATION_10_11, MIGRATION_11_12, MIGRATION_12_13, MIGRATION_13_14,
            MIGRATION_14_15, MIGRATION_15_16, MIGRATION_16_17, MIGRATION_17_18, MIGRATION_18_19, MIGRATION_19_20,
            MIGRATION_20_21,
        ).build()

    @Test
    fun aCloudTerminalWithAQueueKeepsItAndGetsTheHostColumnsEmpty() = runTest {
        val name = "host-migration.db"
        context.deleteDatabase(name)
        database(name).apply { openHelper.writableDatabase }.close()
        SQLiteDatabase.openOrCreateDatabase(context.getDatabasePath(name), null).use { raw ->
            // Rewind to version 20: the columns and tables 21 adds go away.
            for (column in listOf("backend", "pinSha256", "hostId", "hostAddresses", "hostRestoreEpoch", "hostRev")) {
                raw.execSQL("ALTER TABLE device_config DROP COLUMN $column")
            }
            raw.execSQL("ALTER TABLE device_recovery DROP COLUMN pinSha256")
            raw.execSQL("ALTER TABLE sscc_pool DROP COLUMN blockId")
            raw.execSQL("DROP TABLE operator_badges")
            raw.execSQL("DROP TABLE host_outbox")
            raw.execSQL(
                "INSERT INTO device_config (id, deviceId, deviceName, tenantId, organizationName, kind, serverUrl, pairedAt) " +
                    "VALUES (1, 'dev-1', 'ТСД 1', 't-1', 'ООО', 'handheld', 'https://admin.markiro.app', 1)",
            )
            raw.execSQL("INSERT INTO outbox (shiftId, raw, verdict, scannedAt, operatorId, codeHash, gtin14, serial, boxId) VALUES ('s1', 'raw', 'ok', '2026-10-08T06:00:00.000Z', 'op', 'h', 'g', 's', NULL)")
            raw.execSQL("INSERT INTO sscc_pool (issuerPrefix, extensionDigit, fromSerial, toSerial, nextSerial) VALUES ('460068200', 0, 1500, 3499, 1502)")
            raw.execSQL("PRAGMA user_version = 20")
        }
        val db = database(name)
        try {
            val config = db.deviceConfigDao().get()!!
            assertEquals("cloud", config.backend)
            assertNull(config.pinSha256)
            assertNull(config.hostId)
            assertEquals(1, db.outboxDao().countNow())
            val range = db.ssccPoolDao().lowestWithRoom("460068200", 0)!!
            assertEquals(1502L, range.nextSerial)
            assertNull(range.blockId)
            assertEquals(21, db.openHelper.readableDatabase.version)
            assertEquals(0, db.hostOutboxDao().queuedCount())
        } finally {
            db.close()
            context.deleteDatabase(name)
        }
    }
}
```

`core/backend/BackendGuardTest.kt`:

```kotlin
package app.markiro.handheld.core.backend

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.syntheticDeviceConfig
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.IOException

/** A cloud call that slips through in host mode must fail before it leaves the device (and take the cloud's key header with it). */
@RunWith(AndroidJUnit4::class)
class BackendGuardTest {
    @Test
    fun theCloudClientRefusesEveryCallOnceTheDeviceIsPairedWithAHost() = runTest {
        val db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        val server = MockWebServer().also { it.enqueue(MockResponse()); it.enqueue(MockResponse()); it.start() }
        try {
            val client = OkHttpClient.Builder().addInterceptor(BackendGuardInterceptor(db.deviceConfigDao())).build()
            val call = { client.newCall(Request.Builder().url(server.url("/shifts")).build()).execute().close() }
            db.deviceConfigDao().upsert(syntheticDeviceConfig())
            call()
            assertEquals(1, server.requestCount)
            db.deviceConfigDao().upsert(syntheticDeviceConfig().copy(backend = "host"))
            val failure = runCatching { call() }.exceptionOrNull()
            assertTrue("$failure", failure is IOException)
            assertEquals("the second call never left", 1, server.requestCount)
        } finally {
            server.shutdown()
            db.close()
        }
    }
}
```

`core/grants/GrantHostModeTest.kt` (образец — существующий `GrantRepository`-тест в этом пакете; фикстуры `initializeRecoveryForTest`):

```kotlin
package app.markiro.handheld.core.grants

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import app.markiro.handheld.core.storage.syntheticDeviceConfig
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class GrantHostModeTest {
    private fun count(db: HandheldDatabase, table: String): Long =
        db.openHelper.readableDatabase.query("SELECT COUNT(*) FROM `$table`").use { it.moveToFirst(); it.getLong(0) }

    @Test
    fun aHostDeviceWritesNoGrantEvidenceAndACloudOneStillDoes() = runTest {
        val db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        try {
            db.deviceConfigDao().upsert(syntheticDeviceConfig().copy(backend = "host"))
            db.initializeRecoveryForTest()
            db.grants.start(TaskKind.SHIFT, "s1", "shift.enter:s1")
            db.grants.complete(TaskKind.SHIFT, "s1", "shift.scan:1", GrantEventType.SHIFT_SCAN, units = 1)
            assertEquals(0L, count(db, "grant_evidence"))
            db.deviceConfigDao().upsert(syntheticDeviceConfig().copy(backend = "cloud"))
            db.grants.start(TaskKind.SHIFT, "s2", "shift.enter:s2")
            assertEquals(1L, count(db, "grant_evidence"))
        } finally {
            db.close()
        }
    }
}
```

Run: `$GR :app:testDebugUnitTest --tests 'app.markiro.handheld.core.backend.*' --tests 'app.markiro.handheld.core.storage.HostMigrationTest' --tests 'app.markiro.handheld.core.grants.GrantHostModeTest'`
Expected: ошибка компиляции (`BackendKind`, `MIGRATION_20_21`, `DeviceConfigEntity.backend`, … не определены).

- [ ] **Step 2: схема Room.** `core/storage/Entities.kt` — `DeviceConfigEntity` дополняется в конце:

```kotlin
    /** `cloud` (the default, every device paired before plan ТСД-А) or `host`: a device is one or the other for life (spec Д2). */
    @androidx.room.ColumnInfo(defaultValue = "'cloud'")
    val backend: String = "cloud",
    /** The lower-case hex SHA-256 of the host's certificate this device was paired with; only for `host`. */
    val pinSha256: String? = null,
    val hostId: String? = null,
    /** The addresses of the pairing payload, comma-separated, active one first. */
    val hostAddresses: String? = null,
    /** The host's `restoreEpoch` last seen: a change means a restore from a copy (spec 8.5). */
    val hostRestoreEpoch: String? = null,
    /** The last revision of `GET /v1/changes` applied. */
    val hostRev: Long? = null,
```

`DeviceRecoveryEntity` (в `DeviceRecovery.kt`): добавьте последним `val pinSha256: String? = null,` (запечатанный владелец хоста помнит отпечаток).
`SsccRangeEntity`: последним `val blockId: String? = null,` (комментарий: «The host's id of the block, for the `blockId` of a `box_closed`/`pallet_closed`; `null` for a cloud block»).

`core/storage/OperatorBadgeEntities.kt`:

```kotlin
package app.markiro.handheld.core.storage

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Transaction

/** One badge of an operator on the host (an operator may hold several; the cloud's `operators.badgeHash` is one). A PHC verifier, never the code. */
@Entity(tableName = "operator_badges", indices = [Index(value = ["operatorId"])])
data class OperatorBadgeEntity(
    @PrimaryKey val badgeId: String,
    val operatorId: String,
    val badgePhc: String,
    val label: String?,
)

@Dao
interface OperatorBadgeDao {
    @Query("SELECT * FROM operator_badges")
    suspend fun all(): List<OperatorBadgeEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(row: OperatorBadgeEntity)

    @Query("DELETE FROM operator_badges WHERE badgeId = :badgeId")
    suspend fun delete(badgeId: String)

    @Query("DELETE FROM operator_badges")
    suspend fun clear()
}
```

`core/storage/HostOutboxEntities.kt`:

```kotlin
package app.markiro.handheld.core.storage

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query

/**
 * A record for the host, frozen: `body` is the JSON of one record exactly as it will be sent (and sent again), `recordId` its UUID
 * (the host's idempotency key), `seq` its place in the queue. `sourceKind` + `sourceKey` name the Room row it was made of, so the
 * freezer never makes two records of one row. `state`: `queued`, or `quarantined` with the host's `reason` (a refused record stays
 * for support, it never blocks the others). An acknowledged record is deleted together with the acknowledgement of its source row.
 */
@Entity(
    tableName = "host_outbox",
    indices = [
        Index(value = ["recordId"], unique = true),
        Index(value = ["sourceKind", "sourceKey"], unique = true),
        Index(value = ["state", "seq"]),
    ],
)
data class HostOutboxEntity(
    @PrimaryKey(autoGenerate = true) val seq: Long = 0,
    val recordId: String,
    /** `facts` (`POST /v1/device/facts`) or `events` (`POST /v1/device/pallet-events`). */
    val target: String,
    val kind: String,
    val sourceKind: String,
    val sourceKey: String,
    val body: String,
    val state: String,
    val reason: String?,
    val createdAt: String,
)

@Dao
interface HostOutboxDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insert(row: HostOutboxEntity): Long

    @Query("SELECT * FROM host_outbox WHERE state = 'queued' ORDER BY seq LIMIT :limit")
    suspend fun queued(limit: Int): List<HostOutboxEntity>

    @Query("SELECT COUNT(*) FROM host_outbox WHERE state = 'queued'")
    suspend fun queuedCount(): Int

    @Query("SELECT COUNT(*) FROM host_outbox WHERE state = 'quarantined'")
    fun observeQuarantinedCount(): kotlinx.coroutines.flow.Flow<Int>

    @Query("SELECT * FROM host_outbox WHERE state = 'quarantined' ORDER BY seq")
    fun observeQuarantined(): kotlinx.coroutines.flow.Flow<List<HostOutboxEntity>>

    @Query("SELECT COUNT(*) FROM host_outbox WHERE sourceKind = :kind AND sourceKey = :key")
    suspend fun frozen(kind: String, key: String): Int

    @Query("SELECT sourceKey FROM host_outbox WHERE sourceKind = :kind")
    suspend fun frozenKeys(kind: String): List<String>

    @Query("UPDATE host_outbox SET state = 'quarantined', reason = :reason WHERE recordId = :recordId")
    suspend fun quarantine(recordId: String, reason: String)

    @Query("DELETE FROM host_outbox WHERE recordId = :recordId")
    suspend fun delete(recordId: String)

    @Query("DELETE FROM host_outbox WHERE state = 'quarantined' AND recordId = :recordId")
    suspend fun dismiss(recordId: String)

    @Query("DELETE FROM host_outbox")
    suspend fun clear()
}
```

`HandheldDatabase.kt`: добавьте `OperatorBadgeEntity::class, HostOutboxEntity::class` в `entities`, абстрактные `operatorBadgeDao()` и `hostOutboxDao()`;
`const val HANDHELD_DATABASE_VERSION = 21`. `StorageModule.kt`: `MIGRATION_20_21` в `addMigrations(…)` и провайдеры двух DAO по образцу соседних.
`Migrations.kt`:

```kotlin
/**
 * Room 20 → 21 (plan ТСД-А): the second backend. Additive: a cloud terminal keeps every queue and every row, gets `backend = 'cloud'`
 * and the host columns empty, two new tables and the block id of the SSCC pool.
 */
val MIGRATION_20_21 = object : Migration(20, 21) {
    override fun migrate(db: SupportSQLiteDatabase) {
        val config = db.columnsOf("device_config")
        for ((column, ddl) in listOf(
            "backend" to "TEXT NOT NULL DEFAULT 'cloud'",
            "pinSha256" to "TEXT",
            "hostId" to "TEXT",
            "hostAddresses" to "TEXT",
            "hostRestoreEpoch" to "TEXT",
            "hostRev" to "INTEGER",
        )) {
            if (column !in config) db.execSQL("ALTER TABLE `device_config` ADD COLUMN `$column` $ddl")
        }
        if ("pinSha256" !in db.columnsOf("device_recovery")) db.execSQL("ALTER TABLE `device_recovery` ADD COLUMN `pinSha256` TEXT")
        if ("blockId" !in db.columnsOf("sscc_pool")) db.execSQL("ALTER TABLE `sscc_pool` ADD COLUMN `blockId` TEXT")
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `operator_badges` (`badgeId` TEXT NOT NULL, `operatorId` TEXT NOT NULL, " +
                "`badgePhc` TEXT NOT NULL, `label` TEXT, PRIMARY KEY(`badgeId`))",
        )
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_operator_badges_operatorId` ON `operator_badges` (`operatorId`)")
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `host_outbox` (`seq` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, `recordId` TEXT NOT NULL, " +
                "`target` TEXT NOT NULL, `kind` TEXT NOT NULL, `sourceKind` TEXT NOT NULL, `sourceKey` TEXT NOT NULL, " +
                "`body` TEXT NOT NULL, `state` TEXT NOT NULL, `reason` TEXT, `createdAt` TEXT NOT NULL)",
        )
        db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS `index_host_outbox_recordId` ON `host_outbox` (`recordId`)")
        db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS `index_host_outbox_sourceKind_sourceKey` ON `host_outbox` (`sourceKind`, `sourceKey`)")
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_host_outbox_state_seq` ON `host_outbox` (`state`, `seq`)")
    }
}
```

В семь существующих тестов миграций (перечень в «Files») в `addMigrations(…)` после `MIGRATION_19_20` добавьте `MIGRATION_20_21`; это единственная их правка
(утверждения о `HANDHELD_DATABASE_VERSION` читают константу).

- [ ] **Step 3: шов.** `core/backend/StationBackend.kt`:

```kotlin
package app.markiro.handheld.core.backend

import app.markiro.handheld.core.network.BoxRegistryPageDto
import app.markiro.handheld.core.network.BoxSsccTopUpDto
import app.markiro.handheld.core.network.PalletBootstrapDto
import app.markiro.handheld.core.network.RosterResponse
import app.markiro.handheld.core.network.ShiftBundleDto
import app.markiro.handheld.core.network.ShiftDto
import app.markiro.handheld.core.network.ShiftEntryRequest
import app.markiro.handheld.core.network.ShiftListResponse
import app.markiro.handheld.core.network.StationApi

enum class BackendKind { CLOUD, HOST }

/** The open shifts and running inventories the hub's tiles count. */
data class HubCounts(val shifts: Int, val inventories: Int)

/**
 * What the loaders of this app need from "the server" (spec 4.1). The cloud answers them with [StationApi], the host with its own
 * protocol translated into the same DTOs, so the screens, the Room layer and printing do not know which one is behind them. Every call
 * throws what [StationApi] throws (`IOException`, `retrofit2.HttpException`): the loaders already read those.
 */
interface StationBackend {
    suspend fun kindNow(): BackendKind

    /** The cloud's API, for the subsystems that exist only there (grants, validation history, inventory); `null` on the host. */
    suspend fun cloudApi(): StationApi?

    suspend fun operators(): RosterResponse
    suspend fun shifts(): ShiftListResponse
    suspend fun enter(shiftId: String, body: ShiftEntryRequest): ShiftDto
    suspend fun bundle(shiftId: String): ShiftBundleDto
    suspend fun topUpBoxSscc(shiftId: String): BoxSsccTopUpDto
    suspend fun palletBootstrap(): PalletBootstrapDto
    suspend fun boxRegistry(since: String?, until: String?, cursor: String?, limit: Int): BoxRegistryPageDto
    suspend fun hubCounts(): HubCounts
}

/** A backend that answers nothing: the base of test doubles and of the host backend before it exists. */
object NoBackend : StationBackend {
    private fun unsupported(): Nothing = throw UnsupportedOperationException("this backend does not answer that call")
    override suspend fun kindNow(): BackendKind = unsupported()
    override suspend fun cloudApi(): StationApi? = unsupported()
    override suspend fun operators(): RosterResponse = unsupported()
    override suspend fun shifts(): ShiftListResponse = unsupported()
    override suspend fun enter(shiftId: String, body: ShiftEntryRequest): ShiftDto = unsupported()
    override suspend fun bundle(shiftId: String): ShiftBundleDto = unsupported()
    override suspend fun topUpBoxSscc(shiftId: String): BoxSsccTopUpDto = unsupported()
    override suspend fun palletBootstrap(): PalletBootstrapDto = unsupported()
    override suspend fun boxRegistry(since: String?, until: String?, cursor: String?, limit: Int): BoxRegistryPageDto = unsupported()
    override suspend fun hubCounts(): HubCounts = unsupported()
}
```

`CloudBackend.kt`:

```kotlin
package app.markiro.handheld.core.backend

import app.markiro.handheld.core.network.BoxRegistryPageDto
import app.markiro.handheld.core.network.BoxSsccTopUpDto
import app.markiro.handheld.core.network.PalletBootstrapDto
import app.markiro.handheld.core.network.RosterResponse
import app.markiro.handheld.core.network.ShiftBundleDto
import app.markiro.handheld.core.network.ShiftDto
import app.markiro.handheld.core.network.ShiftEntryRequest
import app.markiro.handheld.core.network.ShiftListResponse
import app.markiro.handheld.core.network.StationApi
import javax.inject.Inject
import javax.inject.Singleton

/** The cloud: [StationApi] word for word. Nothing here may change what the cloud device does. */
@Singleton
class CloudBackend @Inject constructor(private val api: StationApi) : StationBackend {
    override suspend fun kindNow() = BackendKind.CLOUD
    override suspend fun cloudApi(): StationApi = api
    override suspend fun operators(): RosterResponse = api.operators()
    override suspend fun shifts(): ShiftListResponse = api.shifts()
    override suspend fun enter(shiftId: String, body: ShiftEntryRequest): ShiftDto = api.enter(shiftId, body)
    override suspend fun bundle(shiftId: String): ShiftBundleDto = api.bundle(shiftId)
    override suspend fun topUpBoxSscc(shiftId: String): BoxSsccTopUpDto = api.topUpBoxSscc(shiftId)
    override suspend fun palletBootstrap(): PalletBootstrapDto = api.palletBootstrap()
    override suspend fun boxRegistry(since: String?, until: String?, cursor: String?, limit: Int): BoxRegistryPageDto =
        api.boxRegistry(since, until, cursor, limit)

    /** What `HubViewModel` counted from the API before the seam. */
    override suspend fun hubCounts(): HubCounts = HubCounts(
        shifts = api.shifts().items.count { it.status in OPEN_SHIFT_STATUSES },
        inventories = api.inventoryTasks().items.size,
    )

    private companion object {
        val OPEN_SHIFT_STATUSES = setOf("planned", "active")
    }
}
```

(`OPEN_SHIFT_STATUSES` в `HubViewModel.kt` — закрытая константа файла с тем же набором `planned`/`active`; здесь она повторена, логика счёта плиток не меняется.)

`BackendSelector.kt`:

```kotlin
package app.markiro.handheld.core.backend

import app.markiro.handheld.core.network.BoxRegistryPageDto
import app.markiro.handheld.core.network.BoxSsccTopUpDto
import app.markiro.handheld.core.network.PalletBootstrapDto
import app.markiro.handheld.core.network.RosterResponse
import app.markiro.handheld.core.network.ShiftBundleDto
import app.markiro.handheld.core.network.ShiftDto
import app.markiro.handheld.core.network.ShiftEntryRequest
import app.markiro.handheld.core.network.ShiftListResponse
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.storage.DeviceConfigDao

/**
 * The backend of this device: its `device_config.backend`, read at each call (a device that is not paired yet is the cloud's, as it
 * always was). The loaders hold this, not a backend, so pairing with a host changes what they talk to without being rebuilt.
 */
class BackendSelector(
    private val config: DeviceConfigDao,
    private val cloud: StationBackend,
    private val host: StationBackend,
) : StationBackend {
    private suspend fun current(): StationBackend = if (config.get()?.backend == "host") host else cloud

    override suspend fun kindNow(): BackendKind = current().kindNow()
    override suspend fun cloudApi(): StationApi? = current().cloudApi()
    override suspend fun operators(): RosterResponse = current().operators()
    override suspend fun shifts(): ShiftListResponse = current().shifts()
    override suspend fun enter(shiftId: String, body: ShiftEntryRequest): ShiftDto = current().enter(shiftId, body)
    override suspend fun bundle(shiftId: String): ShiftBundleDto = current().bundle(shiftId)
    override suspend fun topUpBoxSscc(shiftId: String): BoxSsccTopUpDto = current().topUpBoxSscc(shiftId)
    override suspend fun palletBootstrap(): PalletBootstrapDto = current().palletBootstrap()
    override suspend fun boxRegistry(since: String?, until: String?, cursor: String?, limit: Int): BoxRegistryPageDto =
        current().boxRegistry(since, until, cursor, limit)
    override suspend fun hubCounts(): HubCounts = current().hubCounts()
}
```

`BackendGuardInterceptor.kt`:

```kotlin
package app.markiro.handheld.core.backend

import app.markiro.handheld.core.storage.DeviceConfigDao
import kotlinx.coroutines.runBlocking
import okhttp3.Interceptor
import okhttp3.Response
import java.io.IOException

/**
 * The first interceptor of the cloud client: a device paired with a host never talks to the cloud, so a cloud call that is still wired
 * somewhere fails here, before the connection, instead of reaching a host with a cloud key header or the internet with a host's origin.
 */
class BackendGuardInterceptor(private val config: DeviceConfigDao) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        if (runBlocking { config.get()?.backend } == "host") throw IOException("a device of a host does not call the cloud")
        return chain.proceed(chain.request())
    }
}
```

`NetworkModule.client(...)`: первой строкой цепочки `.addInterceptor(BackendGuardInterceptor(config))` (в провайдер добавьте параметр `config: DeviceConfigDao`).
`BackendModule.kt` (Hilt): `@Provides @Singleton fun backend(config: DeviceConfigDao, cloud: CloudBackend, host: HostBackendHolder): StationBackend = BackendSelector(config, cloud, host.backend)` и,
пока `HostBackend` не написан (С4–Д1), `object HostBackendHolder { val backend: StationBackend = NoBackend }` — заменяется на настоящий `HostBackend` в задаче Д1.

- [ ] **Step 4: загрузчики на шов.** Во всех четырёх загрузчиках первичный конструктор принимает `StationBackend`, а побочный — `StationApi` (облачные тесты не меняются):

  `feature/hub/RosterRefresher.kt`:

```kotlin
class RosterRefresher @Inject constructor(
    private val recovery: app.markiro.handheld.core.storage.DeviceRecovery,
    private val backend: StationBackend,
    private val roster: RosterStore,
    private val config: DeviceConfigDao,
    private val branding: app.markiro.handheld.core.label.OrganizationPrintBranding? = null,
) {
    constructor(
        recovery: app.markiro.handheld.core.storage.DeviceRecovery,
        api: StationApi,
        roster: RosterStore,
        config: DeviceConfigDao,
        branding: app.markiro.handheld.core.label.OrganizationPrintBranding? = null,
    ) : this(recovery, CloudBackend(api), roster, config, branding)

    suspend fun refresh(now: Long = System.currentTimeMillis()) = recovery.work {
        val items = runCatching { backend.operators().items }.getOrNull() ?: return@work
        roster.replace(items.map { it.toRecord() })
        recovery.commit { config.get()?.let { config.upsert(it.copy(rosterFetchedAt = now)) } }
        // The cloud's print logo; a host's comes with its shifts and `org/print` (task Д3).
        if (backend.kindNow() == BackendKind.CLOUD) {
            try { branding?.refresh() } catch (e: kotlinx.coroutines.CancellationException) { throw e } catch (_: Exception) { /* Retain the last complete logo offline. */ }
        }
    }
}
```

Для хоста `backend.operators()` в С5 отдаёт справочник из ленты (там же операторы пишутся в Room); `RosterRefresher.refresh` в режиме `host` вызывает его, и он возвращает уже записанных операторов.

`ShiftRepository` (`feature/shift/ShiftRepository.kt`): первый параметр конструктора `api: StationApi` → `backend: StationBackend`; побочный конструктор `(api: StationApi, db, json, pool, blocks = SsccBlockApplier(pool), clock = System::currentTimeMillis) : this(CloudBackend(api), …)`.
Правки тела:

- поле `private val history = ValidationHistoryMirror(db, api, json)` удаляется; вызов `history.refresh(shiftId, bundle.product.id)` (он стоит под условием `bundle.shift.validationPrint.mode == "duplicate_dm"`, которого на хосте нет) становится `ValidationHistoryMirror(db, checkNotNull(cloud), json).refresh(shiftId, bundle.product.id)`;
- `boxSerialTopUp(...)`: последний аргумент `api::topUpBoxSscc` → `backend::topUpBoxSscc`;
- `refreshListOwned`: `api.shifts().items` → `backend.shifts().items`;
- `otherLines(ownLineId)` и `shiftsOfLine(lineId)`: в начале `if (backend.kindNow() == BackendKind.HOST) return emptyList()` (смены чужих линий на хосте не показываются);
- `enterOwned`: `val cloud = backend.cloudApi()`; строки `GrantTransport(db,api).refreshConfiguredDevice()` и `GrantTransport(db,api).refreshConfiguredTask(...)` выполняются только `if (cloud != null)`; вызовы `db.grants.start(…)`/`saveProvenance(…)` остаются
  (на хосте `GrantRepository.admit` возвращается сразу; `saveProvenance` — запись исходного пакета, без неё на хосте можно: оберните `if (cloud != null)`);
  `api.enter(shiftId, ShiftEntryRequest(entryMethod))` → `backend.enter(…)`, `api.bundle(shiftId)` → `backend.bundle(shiftId)`.

`core/pallets/PalletBootstrapMirror.kt` и `BoxRegistryMirror.kt`: параметр `api: StationApi` → `backend: StationBackend`, побочные конструкторы с `StationApi`; `api.palletBootstrap()` → `backend.palletBootstrap()`; `api.boxRegistry(...)` → `backend.boxRegistry(...)`.
`PalletsModule.kt`, `ShiftModule.kt`: провайдеры берут `StationBackend` вместо `StationApi` для этих классов (`TeamRefresher`/`ApiTeamRefresher(api)` остаётся облачным; на хосте экран «команда» не вызывается — Д1).
`HubViewModel`: в самый конец конструктора (после `shiftRepository`) добавьте `private val backend: StationBackend? = null`, в `@Inject`-конструктор передайте `StationBackend`, а строки 285–286
(`api.shifts().items.count … ; api.inventoryTasks().items.size`) замените на `val counts = backend?.hubCounts() ?: HubCounts(api.shifts().items.count { … }, api.inventoryTasks().items.size)` с сохранением остальной логики счётчиков.

`core/grants/GrantRepository.kt`, начало `admit`:

```kotlin
    private suspend fun admit(kind: TaskKind, taskId: String, eventId: String, event: GrantEventType?, costs: Map<String, Long>, payload: String = eventId, executionFingerprint: String? = null) = db.recovery.commit {
        // A device of a host has no offline grants (spec 8.7): no state means `observe`, which denies nothing, and the evidence it would
        // write has no one to be sent to.
        if (db.deviceConfigDao().get()?.backend == "host") return@commit
        require(kind != TaskKind.PICKUP && …
```

(остальное тело без изменений).

- [ ] **Step 5: запустить, увидеть успех.**

  Run: `$GR :app:testDebugUnitTest --tests 'app.markiro.handheld.core.backend.*' --tests 'app.markiro.handheld.core.storage.*' --tests 'app.markiro.handheld.core.grants.*' --tests 'app.markiro.handheld.core.pallets.*' --tests 'app.markiro.handheld.feature.shift.*' --tests 'app.markiro.handheld.feature.hub.*'`
  Expected: `BUILD SUCCESSFUL` (новые: `BackendSelectorTest` — 2, `HostMigrationTest` — 1, `BackendGuardTest` — 1, `GrantHostModeTest` — 1; все облачные — без изменений).

  Run: `$GR testDebugUnitTest lintDebug`
  Expected: `BUILD SUCCESSFUL` — полный набор облачных тестов остаётся обязательным стражем шва; если какой-то из них красный, причина в шве, а не в тесте.

- [ ] **Step 6: Commit.**

```bash
git -C "$WT" add apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/backend apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/storage apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/network/NetworkModule.kt apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/hub apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/shift apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/pallets apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/grants/GrantRepository.kt apps/handheld/app/src/test/kotlin/app/markiro/handheld/core
git -C "$WT" commit -m "feat(handheld): StationBackend seam, Room 21 and the guard against cloud calls on a host device

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

## Task С4: сопряжение с хостом — источник, адрес и код, скан нагрузки, сверка отпечатка, `claim`, запечатанный владелец `host`, перепривязка

**Files:**

- Modify: `core/storage/DeviceRecovery.kt` (`DeviceOwner.pinSha256`, `HostPairing`, `restore(..., host)`, `completePublication`, `ownerOf`, `sameDevice`)
- Create: `core/network/host/HostPairingGateway.kt` (интерфейс и настоящая реализация), `feature/pairing/HostPairingViewModel.kt`,
  `feature/pairing/HostPairingScreen.kt`, `feature/pairing/HostProvisioningStore.kt`, `feature/pairing/HostBootstrap.kt` (интерфейс начальной выкачки)
- Modify: `AppNavigation.kt` (выбор источника на экране сопряжения), `feature/pairing/PairingModule.kt`, `res/values/strings.xml`, `res/values-en/strings.xml`
- Test: `app/src/test/kotlin/app/markiro/handheld/feature/pairing/HostPairingViewModelTest.kt`,
  `app/src/test/kotlin/app/markiro/handheld/core/storage/HostRecoveryTest.kt`

**Interfaces:**

- Consumes: С1 (`CertPin`, `HostPairingCode`, `HostCompat`), С2 (`HostApi`, `HostHttpClient`, `PairedDto`, `HostFailure`), С3 (колонки `device_config`, `device_recovery.pinSha256`).
- Produces: `DeviceOwner(serverOrigin, tenantId, deviceId, kind, pinSha256)`; `HostPairing(pinSha256, hostId, addresses)`;
  `DeviceRecovery.restore(response, serverUrl, host = null, allowPinChange = false)`; `HostPairingGateway { observe, claim }`;
  `HostPairingViewModel` с состояниями `Enter`, `Verify`, `Binding`, `Failed`, `Success`; `HostBootstrap.initialSync()` (реализация — С5).

Решения, которых нет в спецификации:

- Смена отпечатка при перепривязке не молчит и не отвергается: экран показывает новый отпечаток и просит подтвердить (`Verify(changed = true)`); подтверждённый пин
  попадает в запечатанного владельца только через `restore(…, allowPinChange = true)`, и только с кодом, который офис сделал для этого устройства (план хоста, Х6).
- Источник выбирается на первом экране сопряжения («Облако Markiro» / «Сервер на площадке»); устройство с запечатанным владельцем `host` сразу идёт в перепривязку.
- Перепривязка сбрасывает `hostRev`: операторов и бейджи запечатывание стёрло, и полная лента вернёт их.

- [ ] **Step 1: написать падающие тесты.**

  `HostPairingViewModelTest.kt`:

```kotlin
package app.markiro.handheld.feature.pairing

import app.markiro.handheld.MainDispatcherRule
import app.markiro.handheld.core.network.host.HostApiError
import app.markiro.handheld.core.network.host.HostFailure
import app.markiro.handheld.core.network.host.HelloDto
import app.markiro.handheld.core.network.host.HostPairingGateway
import app.markiro.handheld.core.network.host.Observed
import app.markiro.handheld.core.network.host.PairedDto
import app.markiro.handheld.core.storage.DeviceOwner
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class HostPairingViewModelTest {
    @get:Rule
    val dispatcher = MainDispatcherRule()

    private val pin = "ab".repeat(32)
    private val otherPin = "cd".repeat(32)

    private fun hello(protocol: Int = 6, min: Int = 1) =
        HelloDto("markiro-host", protocol, min, "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f", "0.1.0", "2026-10-15T09:00:00Z", true)

    private class FakeGateway(
        val seen: Map<String, Result<Observed>>,
        var claimResult: Result<PairedDto> = Result.success(PairedDto("d1", "k1", "h1")),
    ) : HostPairingGateway {
        val observed = mutableListOf<String>()
        val claims = mutableListOf<Triple<String, String, String?>>() // address, code, recoverDeviceId
        override suspend fun observe(address: String, port: Int): Result<Observed> {
            observed += address
            return seen[address] ?: Result.failure(HostApiError(HostFailure.Unreachable))
        }

        override suspend fun claim(address: String, port: Int, pin: String, code: String, recoverDeviceId: String?): Result<PairedDto> {
            claims += Triple(address, code, recoverDeviceId)
            return claimResult
        }
    }

    private class FakeStore : HostProvisioningStore {
        val saved = mutableListOf<List<Any?>>()
        override suspend fun persist(paired: PairedDto, origin: String, pin: String, addresses: List<String>, changedPin: Boolean) {
            saved += listOf(paired.deviceId, origin, pin, addresses, changedPin)
        }
    }

    private class FakeBootstrap(var result: Result<Unit> = Result.success(Unit)) : HostBootstrap {
        var runs = 0
        override suspend fun initialSync(): Result<Unit> = result.also { runs++ }
    }

    private fun viewModel(
        gateway: FakeGateway,
        store: FakeStore = FakeStore(),
        bootstrap: FakeBootstrap = FakeBootstrap(),
        owner: DeviceOwner? = null,
    ) = dispatcher.track(HostPairingViewModel(gateway, store, bootstrap, owner))

    @Test
    fun aTypedAddressIsObservedShownAsAFingerprintAndOnlyThenClaimed() = runTest {
        val gateway = FakeGateway(mapOf("192.168.1.10" to Result.success(Observed(pin, hello()))))
        val store = FakeStore()
        val vm = viewModel(gateway, store)
        vm.onAddress("192,168,1,10")
        vm.onCode("7k3mq-9xv2d")
        vm.onContinue()
        advanceUntilIdle()
        val verify = vm.state.value as HostPairingUi.Verify
        assertEquals("ABAB ABAB ABAB ABAB ABAB ABAB ABAB ABAB", verify.display)
        assertTrue("nothing is claimed before the person compares the fingerprint", gateway.claims.isEmpty())
        vm.onFingerprintConfirmed()
        advanceUntilIdle()
        assertEquals(listOf(Triple("192.168.1.10", "7K3MQ9XV2D", null)), gateway.claims)
        assertEquals(listOf(listOf("d1", "https://192.168.1.10:45710", pin, listOf("192.168.1.10"), false)), store.saved)
        assertTrue(vm.state.value is HostPairingUi.Success)
    }

    @Test
    fun aBadAddressOrCodeIsRefusedOnTheDeviceWithoutAnyNetwork() = runTest {
        val gateway = FakeGateway(emptyMap())
        val vm = viewModel(gateway)
        vm.onAddress("10.0.0.256")
        vm.onCode("7K3MQ9XV2D")
        vm.onContinue()
        advanceUntilIdle()
        assertEquals(HostPairingError.ADDRESS_INVALID, (vm.state.value as HostPairingUi.Enter).error)
        vm.onAddress("10.0.0.5")
        vm.onCode("7K3MQ9XV2U")
        vm.onContinue()
        advanceUntilIdle()
        assertEquals(HostPairingError.CODE_INVALID, (vm.state.value as HostPairingUi.Enter).error)
        assertEquals(emptyList<String>(), gateway.observed)
    }

    @Test
    fun aHostOfAnotherProtocolIsNamedBeforeAnythingElse() = runTest {
        for ((protocol, error) in listOf(5 to HostPairingError.HOST_TOO_OLD, 9 to HostPairingError.APP_TOO_OLD)) {
            val min = if (protocol == 9) 8 else 1
            val gateway = FakeGateway(mapOf("10.0.0.5" to Result.success(Observed(pin, hello(protocol, min)))))
            val vm = viewModel(gateway)
            vm.onAddress("10.0.0.5")
            vm.onCode("7K3MQ9XV2D")
            vm.onContinue()
            advanceUntilIdle()
            assertEquals(error, (vm.state.value as HostPairingUi.Failed).error)
            assertTrue(gateway.claims.isEmpty())
        }
    }

    @Test
    fun aScannedPayloadClaimsOnlyAtTheAddressWhoseCertificateIsTheOneItNames() = runTest {
        val gateway = FakeGateway(
            mapOf(
                "10.0.0.5" to Result.success(Observed(otherPin, hello())), // some other host on the first address
                "192.168.1.10" to Result.success(Observed(pin, hello())),
            ),
        )
        val store = FakeStore()
        val vm = viewModel(gateway, store)
        vm.onScan("markiro-host:1?h=10.0.0.5,192.168.1.10&p=45710&f=$pin&c=7K3MQ9XV2D")
        advanceUntilIdle()
        assertEquals(listOf(Triple("192.168.1.10", "7K3MQ9XV2D", null)), gateway.claims)
        assertEquals(listOf("10.0.0.5", "192.168.1.10").sorted(), gateway.observed.sorted())
        assertEquals(listOf("192.168.1.10"), (store.saved.single()[3] as List<*>).take(1))
        assertTrue(vm.state.value is HostPairingUi.Success)
    }

    @Test
    fun aScannedPayloadWhoseFingerprintMatchesNoAddressSendsNoCode() = runTest {
        val gateway = FakeGateway(mapOf("10.0.0.5" to Result.success(Observed(otherPin, hello()))))
        val vm = viewModel(gateway)
        vm.onScan("markiro-host:1?h=10.0.0.5&p=45710&f=$pin&c=7K3MQ9XV2D")
        advanceUntilIdle()
        assertEquals(HostPairingError.NO_ADDRESS_MATCHES, (vm.state.value as HostPairingUi.Failed).error)
        assertTrue(gateway.claims.isEmpty())
    }

    @Test
    fun theHostsRefusalsAreShownAndNotRepeatedByThemselves() = runTest {
        val cases = mapOf(
            HostFailure.PairingInvalid to HostPairingError.PAIRING_INVALID,
            HostFailure.PairingExpired to HostPairingError.PAIRING_EXPIRED,
            HostFailure.RateLimited to HostPairingError.RATE_LIMITED,
            HostFailure.SeatLimit to HostPairingError.SEAT_LIMIT,
            HostFailure.FeatureDisabled to HostPairingError.FEATURE_DISABLED,
        )
        for ((failure, error) in cases) {
            val gateway = FakeGateway(mapOf("10.0.0.5" to Result.success(Observed(pin, hello()))), Result.failure(HostApiError(failure)))
            val vm = viewModel(gateway)
            vm.onAddress("10.0.0.5")
            vm.onCode("7K3MQ9XV2D")
            vm.onContinue()
            advanceUntilIdle()
            vm.onFingerprintConfirmed()
            advanceUntilIdle()
            assertEquals(error, (vm.state.value as HostPairingUi.Failed).error)
            assertEquals(1, gateway.claims.size)
            vm.onRetry()
            assertTrue("retry goes back to the form, it does not claim again", vm.state.value is HostPairingUi.Enter)
            assertEquals(1, gateway.claims.size)
        }
    }

    @Test
    fun aDeviceThatWasPairedClaimsAgainWithItsOwnIdAndAChangedCertificateNeedsTheNewFingerprintConfirmed() = runTest {
        val owner = DeviceOwner("https://192.168.1.10:45710", "h1", "d1", "handheld", pin)
        val gateway = FakeGateway(mapOf("192.168.1.10" to Result.success(Observed(otherPin, hello()))))
        val store = FakeStore()
        val vm = viewModel(gateway, store, owner = owner)
        vm.onCode("7K3MQ9XV2D")
        vm.onContinue()
        advanceUntilIdle()
        val verify = vm.state.value as HostPairingUi.Verify
        assertTrue("the certificate is not the paired one", verify.changed)
        assertTrue(gateway.claims.isEmpty())
        vm.onFingerprintConfirmed()
        advanceUntilIdle()
        assertEquals(listOf(Triple("192.168.1.10", "7K3MQ9XV2D", "d1")), gateway.claims)
        assertEquals(true, store.saved.single()[4])
        assertEquals(otherPin, store.saved.single()[2])
    }

    @Test
    fun aDeviceThatWasPairedAndSeesTheSameCertificateClaimsAtOnce() = runTest {
        val owner = DeviceOwner("https://192.168.1.10:45710", "h1", "d1", "handheld", pin)
        val gateway = FakeGateway(mapOf("192.168.1.10" to Result.success(Observed(pin, hello()))))
        val vm = viewModel(gateway, owner = owner)
        vm.onCode("7K3MQ9XV2D")
        vm.onContinue()
        advanceUntilIdle()
        assertEquals(listOf(Triple("192.168.1.10", "7K3MQ9XV2D", "d1")), gateway.claims)
        assertTrue(vm.state.value is HostPairingUi.Success)
    }

    @Test
    fun theFirstSyncMustLandBeforeThePairingIsDoneAndItsFailureDoesNotClaimAgain() = runTest {
        val gateway = FakeGateway(mapOf("10.0.0.5" to Result.success(Observed(pin, hello()))))
        val bootstrap = FakeBootstrap(Result.failure(HostApiError(HostFailure.Unreachable)))
        val vm = viewModel(gateway, bootstrap = bootstrap)
        vm.onAddress("10.0.0.5")
        vm.onCode("7K3MQ9XV2D")
        vm.onContinue()
        advanceUntilIdle()
        vm.onFingerprintConfirmed()
        advanceUntilIdle()
        assertEquals(HostPairingError.SYNC_FAILED, (vm.state.value as HostPairingUi.Failed).error)
        bootstrap.result = Result.success(Unit)
        vm.onRetrySync()
        advanceUntilIdle()
        assertTrue(vm.state.value is HostPairingUi.Success)
        assertEquals(1, gateway.claims.size)
        assertEquals(2, bootstrap.runs)
    }
}
```

`HostRecoveryTest.kt`:

```kotlin
package app.markiro.handheld.core.storage

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.network.CredentialDto
import app.markiro.handheld.core.network.DeviceDto
import app.markiro.handheld.core.network.PairResponse
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class HostRecoveryTest {
    private lateinit var db: HandheldDatabase
    private val credential = InMemoryCredentialStore()
    private val pin = "ab".repeat(32)
    private val origin = "https://192.168.1.10:45710"

    @Before
    fun open() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
    }

    @After
    fun close() = db.close()

    private fun response(key: String = "k1") = PairResponse(
        device = DeviceDto("d1", "ТСД 1", "handheld", "h1", "", null),
        credential = CredentialDto(key, origin),
        operators = emptyList(),
    )

    @Test
    fun aHostPairingMakesAHostDeviceWithItsPinAndNoCloudOwnerNoise() = runTest {
        val recovery = DeviceRecovery(db, credential).also { it.initialize() }
        recovery.restore(response(), origin, HostPairing(pin, "h1", listOf("192.168.1.10")))
        val config = db.deviceConfigDao().get()!!
        assertEquals("host", config.backend)
        assertEquals(pin, config.pinSha256)
        assertEquals("h1", config.hostId)
        assertEquals("192.168.1.10", config.hostAddresses)
        assertNull(config.hostRev)
        assertEquals(DeviceOwner(origin, "h1", "d1", "handheld", pin), recovery.current().owner)
        assertEquals("k1", credential.read())
    }

    @Test
    fun aCloudPairingStaysTheCloudsAndAHostDeviceSurvivesARestartAsTheSameOwner() = runTest {
        DeviceRecovery(db, credential).also { it.initialize(); it.restore(response(), origin, HostPairing(pin, "h1", listOf("192.168.1.10"))) }
        val restarted = DeviceRecovery(db, credential).also { it.initialize() }
        assertEquals(RecoveryPhase.ACTIVE, restarted.current().phase)
        assertEquals(pin, restarted.current().owner?.pinSha256)
    }

    @Test
    fun aRePairingKeepsTheOwnerAndTakesAChangedPinOnlyWhenTheCallerSaysSo() = runTest {
        val recovery = DeviceRecovery(db, credential).also { it.initialize() }
        recovery.restore(response(), origin, HostPairing(pin, "h1", listOf("192.168.1.10")))
        val token = recovery.token()
        recovery.reject(token)
        assertEquals(RecoveryPhase.SEALED, recovery.current().phase)
        val changed = "cd".repeat(32)
        assertThrows(RecoveryMismatch::class.java) {
            kotlinx.coroutines.runBlocking { recovery.restore(response("k2"), origin, HostPairing(changed, "h1", listOf("192.168.1.10"))) }
        }
        recovery.restore(response("k2"), origin, HostPairing(changed, "h1", listOf("192.168.1.10")), allowPinChange = true)
        assertEquals(changed, recovery.current().owner?.pinSha256)
        assertEquals("k2", credential.read())
        assertNull("the full feed is read again after a re-pairing", db.deviceConfigDao().get()!!.hostRev)
    }
}
```

(в `rejectionPreserves…` существующего `StorageTest` и в других тестах `DeviceOwner(...)` строится четырьмя позиционными аргументами — пятый параметр с
значением по умолчанию их не ломает.)

Run: `$GR :app:testDebugUnitTest --tests 'app.markiro.handheld.feature.pairing.HostPairingViewModelTest' --tests 'app.markiro.handheld.core.storage.HostRecoveryTest'`
Expected: ошибка компиляции (`HostPairingViewModel`, `HostPairing`, … не определены).

- [ ] **Step 2: запечатанный владелец.** `core/storage/DeviceRecovery.kt`:

  - `data class DeviceOwner(val serverOrigin: String, val tenantId: String, val deviceId: String, val kind: String, val pinSha256: String? = null)` (остаётся `@Serializable`);
    `fun DeviceOwner.sameDevice(other: DeviceOwner) = copy(pinSha256 = null) == other.copy(pinSha256 = null)`;
  - `DeviceRecoveryEntity.owner()` строит `DeviceOwner(serverOrigin, tenantId, deviceId, kind, pinSha256)`; `ownerOf(server, tenant, device, kind, pin: String? = null)` кладёт пин в результат
    (проверка `kind == "handheld"` и разбор URL — прежние); все вызовы `ownerOf(config.serverUrl, config.tenantId, config.deviceId, config.kind)` получают пятым аргументом `config.pinSha256`
    (в `initialize`, `ownerConsistent`);
  - `@Serializable data class HostPairing(val pinSha256: String, val hostId: String, val addresses: List<String>)`; `Publication` получает `val host: HostPairing? = null`;
  - `suspend fun restore(response: PairResponse, serverUrl: String, host: HostPairing? = null, allowPinChange: Boolean = false)`: `owner = ownerOf(serverUrl, response.device.tenantId, response.device.id, response.device.kind, host?.pinSha256)`;
    проверка `row.owner()?.let { it != owner } == true` заменяется на
    `row.owner()?.let { existing -> if (allowPinChange && host != null) !existing.sameDevice(owner) else existing != owner } == true` → `RecoveryMismatch`; промежуточное `intent` пишется с `pinSha256 = owner.pinSha256`
    (`row.copy(…, pinSha256 = owner.pinSha256, phase = RESTORING, …)`); `Publication(id, owner, generation, response, host)`;
  - `completePublication`: после чтения `publication` —
    `val host = publication.host`; операторы заменяются только при `host == null` (`if (host == null) db.operatorDao().replaceAll(...)` — операторов хоста пишет лента, С5);
    конфиг: если `old != null` → `old.copy(…прежнее…, backend = if (host != null) "host" else old.backend, pinSha256 = host?.pinSha256 ?: old.pinSha256, hostId = host?.hostId ?: old.hostId,
hostAddresses = host?.addresses?.joinToString(",") ?: old.hostAddresses, hostRev = if (host != null) null else old.hostRev)`; иначе новый `DeviceConfigEntity(…, backend = if (host != null) "host" else "cloud",
pinSha256 = host?.pinSha256, hostId = host?.hostId, hostAddresses = host?.addresses?.joinToString(","))`;
    `rosterFetchedAt`, `organizationName` для хоста — как есть (название организации заполняет лента, С5).
    Остальная логика (замена ключа, `demoteInterruptedPrints`, чистка `staged`) не меняется.

- [ ] **Step 3: шлюз и хранилище.** `core/network/host/HostPairingGateway.kt`:

```kotlin
package app.markiro.handheld.core.network.host

import app.markiro.handheld.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import javax.inject.Inject

/** A host seen through the observing client: the certificate it presented and what it said in `hello`. Untrusted until the person confirms the fingerprint. */
data class Observed(val fingerprint: String, val hello: HelloDto)

interface HostPairingGateway {
    suspend fun observe(address: String, port: Int): Result<Observed>

    /** The `claim` through a client that trusts exactly `pin`: the code goes only to the host that presents it. */
    suspend fun claim(address: String, port: Int, pin: String, code: String, recoverDeviceId: String?): Result<PairedDto>
}

class RealHostPairingGateway @Inject constructor() : HostPairingGateway {
    override suspend fun observe(address: String, port: Int): Result<Observed> = withContext(Dispatchers.IO) {
        val observer = ObservingTrustManager()
        runCatching { HostApi.observeHello(HostHttpClient.observing(observer), address, port) }
            .mapCatching { hello -> Observed(checkNotNull(observer.observed) { "no certificate was presented" }, hello) }
            .recoverCatching { throw HostApiError(HostFailure.Unreachable) }
    }

    override suspend fun claim(address: String, port: Int, pin: String, code: String, recoverDeviceId: String?): Result<PairedDto> {
        val transport = OkHttpHostTransport(HostHttpClient.pinned(pin) { null }, { "https://$address:$port" })
        return HostApi(transport).claim(code, name = DEVICE_NAME, appVersion = BuildConfig.VERSION_NAME, recoverDeviceId = recoverDeviceId)
    }

    private companion object {
        const val DEVICE_NAME = "ТСД"
    }
}
```

`feature/pairing/HostProvisioningStore.kt`:

```kotlin
package app.markiro.handheld.feature.pairing

import app.markiro.handheld.core.network.CredentialDto
import app.markiro.handheld.core.network.DeviceDto
import app.markiro.handheld.core.network.PairResponse
import app.markiro.handheld.core.network.host.PairedDto
import app.markiro.handheld.core.storage.DeviceRecovery
import app.markiro.handheld.core.storage.HostPairing

fun interface HostProvisioningStore {
    /** Publishes the pairing: the key to the credential store, the owner (with the pin) and the config to Room, in one resumable intent (`DeviceRecovery`). */
    suspend fun persist(paired: PairedDto, origin: String, pin: String, addresses: List<String>, changedPin: Boolean)
}

class RoomHostProvisioningStore(private val recovery: DeviceRecovery) : HostProvisioningStore {
    override suspend fun persist(paired: PairedDto, origin: String, pin: String, addresses: List<String>, changedPin: Boolean) {
        recovery.initialize()
        val response = PairResponse(
            device = DeviceDto(id = paired.deviceId, name = "ТСД", kind = "handheld", tenantId = paired.hostId, organizationName = "", line = null),
            credential = CredentialDto(apiKey = paired.deviceKey, serverUrl = origin),
            operators = emptyList(),
        )
        recovery.restore(response, origin, HostPairing(pin, paired.hostId, addresses), allowPinChange = changedPin)
    }
}

/** The first read of the host's data after a claim (the feed, the blocks): pairing is not done before it lands (spec 8.3, point 4). */
fun interface HostBootstrap {
    suspend fun initialSync(): Result<Unit>
}
```

(интерфейс `HostBootstrap` объявлен в этом же файле; `PairingModule` добавляет `@Provides fun hostProvisioningStore(recovery) = RoomHostProvisioningStore(recovery)` и
`@Provides fun hostPairingGateway(): HostPairingGateway = RealHostPairingGateway()`; `HostBootstrap` пока даёт заглушка модуля, которую задача С5 заменяет настоящей.)

- [ ] **Step 4: модель экрана.** `feature/pairing/HostPairingViewModel.kt`:

```kotlin
package app.markiro.handheld.feature.pairing

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.core.network.host.CertPin
import app.markiro.handheld.core.network.host.HostApiError
import app.markiro.handheld.core.network.host.HostCompat
import app.markiro.handheld.core.network.host.HostCompatibility
import app.markiro.handheld.core.network.host.HostFailure
import app.markiro.handheld.core.network.host.HostPairingGateway
import app.markiro.handheld.core.network.host.Observed
import app.markiro.handheld.core.network.host.PairedDto
import app.markiro.handheld.core.storage.DeviceOwner
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

enum class HostPairingError {
    ADDRESS_INVALID, CODE_INVALID, UNREACHABLE, TIMEOUT, NOT_A_HOST, HOST_TOO_OLD, APP_TOO_OLD, NO_ADDRESS_MATCHES,
    PAIRING_INVALID, PAIRING_EXPIRED, RATE_LIMITED, SEAT_LIMIT, FEATURE_DISABLED, CERTIFICATE_MISMATCH, OTHER, SYNC_FAILED,
}

sealed interface HostPairingUi {
    data class Enter(
        val address: String,
        val code: String,
        val error: HostPairingError? = null,
        /** The device was paired before: the address is its own and the form asks only for the new code. */
        val repairing: Boolean = false,
    ) : HostPairingUi

    /** The person compares `display` with the office's screen. `changed`: the host presents another certificate than the paired one. */
    data class Verify(val address: String, val display: String, val changed: Boolean) : HostPairingUi
    data object Binding : HostPairingUi
    data class Failed(val error: HostPairingError, val canRetrySync: Boolean = false) : HostPairingUi
    data object Success : HostPairingUi
}

@HiltViewModel
class HostPairingViewModel(
    private val gateway: HostPairingGateway,
    private val store: HostProvisioningStore,
    private val bootstrap: HostBootstrap,
    /** The sealed owner of a device that was paired with a host, or `null` for a new device. */
    private val owner: DeviceOwner?,
) : ViewModel() {
    @javax.inject.Inject
    constructor(
        gateway: HostPairingGateway,
        store: HostProvisioningStore,
        bootstrap: HostBootstrap,
        recovery: app.markiro.handheld.core.storage.DeviceRecovery,
    ) : this(gateway, store, bootstrap, recovery.current().owner?.takeIf { it.pinSha256 != null })

    private val ownerAddress = owner?.let { it.serverOrigin.toHttpUrlOrNull()?.host }
    private val ownerPort = owner?.let { it.serverOrigin.toHttpUrlOrNull()?.port } ?: DEFAULT_PORT
    private val _state = MutableStateFlow<HostPairingUi>(HostPairingUi.Enter(ownerAddress.orEmpty(), "", repairing = owner != null))
    val state: StateFlow<HostPairingUi> = _state

    private class Pending(val address: String, val port: Int, val addresses: List<String>, val code: String, val observed: Observed, val changed: Boolean)

    private var pending: Pending? = null
    private var paired: Triple<PairedDto, Pending, Boolean>? = null

    fun onAddress(text: String) = _state.update { s -> if (s is HostPairingUi.Enter && !s.repairing) s.copy(address = text.trim().replace(',', '.'), error = null) else s }

    fun onCode(text: String) = _state.update { s -> if (s is HostPairingUi.Enter) s.copy(code = text, error = null) else s }

    fun onContinue() {
        val form = _state.value as? HostPairingUi.Enter ?: return
        val address = form.address.trim()
        if (!isIpv4(address)) return fail(form, HostPairingError.ADDRESS_INVALID)
        val code = HostPairingCode.normalize(form.code) ?: return fail(form, HostPairingError.CODE_INVALID)
        _state.value = HostPairingUi.Binding
        viewModelScope.launch {
            val port = if (owner != null) ownerPort else DEFAULT_PORT
            val observed = gateway.observe(address, port).getOrElse { return@launch failed(it) }
            compatibilityError(observed)?.let { return@launch _state.update { _ -> HostPairingUi.Failed(it) } }
            proceed(Pending(address, port, listOf(address), code, observed, changed = owner?.pinSha256 != null && owner.pinSha256 != observed.fingerprint))
        }
    }

    /** A scan of the office's DataMatrix: the code goes only to the address whose certificate is the payload's `f`. */
    fun onScan(raw: String) {
        if (_state.value !is HostPairingUi.Enter) return
        val payload = HostPairingCode.parsePayload(raw) ?: return
        _state.value = HostPairingUi.Binding
        viewModelScope.launch {
            val seen = coroutineScope {
                payload.addresses.map { address -> async { address to gateway.observe(address, payload.port) } }.awaitAll()
            }
            val match = seen.firstOrNull { (_, result) -> result.getOrNull()?.fingerprint == payload.fingerprint }
            if (match == null) return@launch _state.update { _ -> HostPairingUi.Failed(HostPairingError.NO_ADDRESS_MATCHES) }
            val observed = checkNotNull(match.second.getOrNull())
            compatibilityError(observed)?.let { return@launch _state.update { _ -> HostPairingUi.Failed(it) } }
            // The payload carries the fingerprint of the office's own screen: no second comparison by eye.
            val ordered = listOf(match.first) + payload.addresses.filter { it != match.first }
            claim(Pending(match.first, payload.port, ordered, payload.code, observed, changed = false))
        }
    }

    fun onFingerprintConfirmed() {
        val next = pending ?: return
        if (_state.value !is HostPairingUi.Verify) return
        _state.value = HostPairingUi.Binding
        viewModelScope.launch { claim(next) }
    }

    /** «Не совпадает»: nothing was sent, back to the form. */
    fun onFingerprintRejected() {
        pending = null
        _state.value = HostPairingUi.Enter(ownerAddress.orEmpty(), "", repairing = owner != null)
    }

    fun onRetry() {
        if (_state.value is HostPairingUi.Failed) _state.value = HostPairingUi.Enter(ownerAddress.orEmpty(), "", repairing = owner != null)
    }

    /** The claim succeeded and the first sync did not: only the sync is repeated (a code is one-time). */
    fun onRetrySync() {
        val done = paired ?: return
        _state.value = HostPairingUi.Binding
        viewModelScope.launch { finish(done.first, done.second, done.third) }
    }

    private suspend fun proceed(next: Pending) {
        // The person compares the fingerprint of a typed address; a re-pairing with the certificate it already trusts needs no comparison.
        if (owner != null && !next.changed) return claim(next)
        pending = next
        _state.value = HostPairingUi.Verify(next.address, CertPin.display(next.observed.fingerprint), next.changed)
    }

    private suspend fun claim(next: Pending) {
        val result = gateway.claim(next.address, next.port, next.observed.fingerprint, next.code, owner?.deviceId)
        val pairing = result.getOrElse { return failed(it) }
        paired = Triple(pairing, next, next.changed)
        finish(pairing, next, next.changed)
    }

    private suspend fun finish(pairing: PairedDto, next: Pending, changedPin: Boolean) {
        runCatching {
            store.persist(pairing, "https://${next.address}:${next.port}", next.observed.fingerprint, next.addresses, changedPin)
        }.onFailure { return _state.update { _ -> HostPairingUi.Failed(HostPairingError.OTHER) } }
        val synced = bootstrap.initialSync()
        _state.value = if (synced.isSuccess) HostPairingUi.Success else HostPairingUi.Failed(HostPairingError.SYNC_FAILED, canRetrySync = true)
    }

    private fun compatibilityError(observed: Observed): HostPairingError? = when (
        HostCompat.decide(HostCompat.PROTOCOL, observed.hello.protocol, observed.hello.minProtocol)
    ) {
        HostCompatibility.HOST_TOO_OLD -> HostPairingError.HOST_TOO_OLD
        HostCompatibility.APP_TOO_OLD -> HostPairingError.APP_TOO_OLD
        HostCompatibility.COMPATIBLE -> if (observed.hello.product == "markiro-host") null else HostPairingError.NOT_A_HOST
    }

    private fun failed(cause: Throwable) {
        val failure = (cause as? HostApiError)?.failure
        _state.value = HostPairingUi.Failed(
            when (failure) {
                HostFailure.PairingInvalid -> HostPairingError.PAIRING_INVALID
                HostFailure.PairingExpired -> HostPairingError.PAIRING_EXPIRED
                HostFailure.RateLimited -> HostPairingError.RATE_LIMITED
                HostFailure.SeatLimit -> HostPairingError.SEAT_LIMIT
                HostFailure.FeatureDisabled -> HostPairingError.FEATURE_DISABLED
                HostFailure.CertificateMismatch -> HostPairingError.CERTIFICATE_MISMATCH
                HostFailure.Timeout -> HostPairingError.TIMEOUT
                HostFailure.Unreachable -> HostPairingError.UNREACHABLE
                else -> HostPairingError.OTHER
            },
        )
    }

    private fun fail(form: HostPairingUi.Enter, error: HostPairingError) {
        _state.value = form.copy(error = error)
    }

    private fun isIpv4(text: String): Boolean {
        val parts = text.split('.')
        return parts.size == 4 && parts.all { it.length in 1..3 && it.all(Char::isDigit) && it.toInt() <= 255 && (it == "0" || !it.startsWith("0")) }
    }

    private companion object {
        const val DEFAULT_PORT = 45710
    }
}
```

(код проверяется на устройстве `HostPairingCode.normalize` до любого запроса; одинаковый отказ хоста не уходит заново сам: `onRetry` возвращает форму, а не шлёт `claim`.)

- [ ] **Step 5: экран и навигация.** `HostPairingScreen.kt` — Compose по образцу `PairingScreen` (`ScreenColumn`, `FullScreenState`, `MarkiroSizes`): состояния `Enter` (поле «Адрес хоста» с `KeyboardType.Uri`,
      поле «Код» с `KeyboardCapitalization.Characters`, кнопка «Продолжить»; в режиме `repairing` адрес показан и не правится, заголовок «Привязать заново»), `Verify` (крупный отпечаток моноширинным шрифтом по четыре
      знака, строка «Сверьте с экраном офиса», при `changed` — предупреждение «Сертификат сервера изменился», кнопки «Совпадает» и «Не совпадает»), `Binding` («Загружаем справочники…»), `Failed` (текст по `HostPairingError`, кнопки
      «Повторить», а при `canRetrySync` — «Повторить загрузку»), `Success` («ТСД привязан», «Перейти ко входу»). Тексты — в обоих `strings.xml` с префиксом `host_pairing_`:
      `host_pairing_title`, `host_pairing_address`, `host_pairing_code`, `host_pairing_continue`, `host_pairing_verify_title`, `host_pairing_verify_hint`, `host_pairing_verify_changed`, `host_pairing_match`,
      `host_pairing_no_match`, `host_pairing_binding`, `host_pairing_success`, `host_pairing_repair_title`, и по одной `host_pairing_error_*` на значение `HostPairingError` (ru и en одновременно).
      `AppNavigation.kt`: на маршруте `PAIRING` новое состояние выбора источника (`rememberSaveable`): две крупные кнопки «Облако Markiro» (прежний `PairingScreen`) и «Сервер на площадке (Автоном)» (`HostPairingScreen` с
      `hiltViewModel<HostPairingViewModel>()`); если у запечатанного владельца есть `pinSha256`, источник выбирается сразу в пользу хоста. Хардварный скан (`ScanEvents`) подаёт `onScan` модели хоста.

- [ ] **Step 6: запустить, увидеть успех.**

  Run: `$GR :app:testDebugUnitTest --tests 'app.markiro.handheld.feature.pairing.*' --tests 'app.markiro.handheld.core.storage.*'`
  Expected: `BUILD SUCCESSFUL` (`HostPairingViewModelTest` — 9, `HostRecoveryTest` — 3; облачные `PairingViewModelTest`, `DeviceRecoveryTest`, `DeviceRecoveryMigrationTest` — без правок).

  Run: `$GR lintDebug`
  Expected: `BUILD SUCCESSFUL`: ни одной `MissingTranslation`/`ExtraTranslation`.

- [ ] **Step 7: Commit.**

```bash
git -C "$WT" add apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/storage/DeviceRecovery.kt apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/network/host/HostPairingGateway.kt apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/pairing apps/handheld/app/src/main/kotlin/app/markiro/handheld/AppNavigation.kt apps/handheld/app/src/main/res/values/strings.xml apps/handheld/app/src/main/res/values-en/strings.xml apps/handheld/app/src/test/kotlin/app/markiro/handheld/feature/pairing/HostPairingViewModelTest.kt apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/storage/HostRecoveryTest.kt
git -C "$WT" commit -m "feat(handheld): pairing with a host — address and code, DataMatrix payload, pinned fingerprint, re-pairing

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

## Task С5: справочники из ленты изменений, операторы с несколькими бейджами, блоки SSCC хоста, пульс связи

**Files:**

- Create: `core/host/HostReferenceSync.kt`, `core/host/HostBlockSupplier.kt`, `core/host/HostLinkMonitor.kt`, `core/host/HostBootstrapImpl.kt`,
  `core/backend/HostBackend.kt` (первые методы), `core/host/HostModule.kt`
- Modify: `core/storage/Daos.kt` (`OperatorDao.upsert/delete`), `core/storage/PalletBootstrapEntities.kt` (`PalletProductDao.upsert/delete`,
  `PalletLabelTemplateDao.replaceAll` уже есть), `core/storage/ShiftDaos.kt` (`MetaDao.withPrefix`), `core/storage/RosterStore.kt`,
  `core/auth/OperatorRecord.kt`, `core/auth/OperatorAuth.kt`, `core/network/ShiftDtos.kt` (`BundleSsccDto.blockId`), `core/box/SsccPool.kt`
  (`ServerRange.blockId`), `core/storage/BoxDaos.kt` (`SsccRangeEntity` из `ServerRange`; запрос блока по серийному номеру),
  `core/pallets/SsccBlockApplier.kt`, `feature/hub/RosterRefresher.kt`, `core/backend/BackendModule.kt`, `feature/pairing/PairingModule.kt` (настоящий `HostBootstrap`)
- Test: `core/host/HostReferenceSyncTest.kt`, `core/host/HostBlockSupplierTest.kt`, `core/host/HostLinkMonitorTest.kt`, `core/auth/OperatorAuthHostTest.kt`

**Interfaces:**

- Consumes: С2 (`HostApi`, `ChangesDto`, `SsccBlockDto`), С3 (таблицы, колонки, `MetaStore`), С4 (`HostBootstrap`, `HostPairing`).
- Produces: `HostReferenceSync.sync(): Result<Unit>` (лента → Room, ревизия в `device_config.hostRev`); `HostBlockSupplier.ensure(extension)` и `registerKnown()`;
  `HostLinkMonitor.state: StateFlow<HostLinkState>` (`reachable`, `restoreEpochChanged`, `clockSkewMs`, `failure`); `SsccRangeDao.rangeOf(prefix, extension, serial): SsccRangeEntity?`;
  `OperatorRecord.badgeHashes`; `HostBackend.operators()`.

Решения, которых нет в спецификации:

- Шаблоны этикеток паллет из ленты и умолчания категорий лежат в `meta` под ключами `host_template:<id>`, `host_cat_default:<код>:<назначение>`, `host_org_pallet_template`
  (запросом по префиксу): отдельных таблиц ради двух десятков строк не заводим; `pallet_label_templates` пересобирается после каждой страницы ленты.
- Права «собирать паллеты» у оператора нет (решение В-5): после ленты `pallet_permissions` получает строку `canBuildPallets = true` для каждого оператора хоста.
- `RosterRefresher.refresh` в режиме `host` только запрашивает ленту через `HostBackend.operators()` и ставит метку времени; операторов пишет лента, а не замена списка.

- [ ] **Step 1: написать падающие тесты.**

  `HostReferenceSyncTest.kt` (Robolectric, подставной транспорт, ответы — файлы-фикстуры хоста):

```kotlin
package app.markiro.handheld.core.host

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.network.host.HostApi
import app.markiro.handheld.core.network.host.HostApiError
import app.markiro.handheld.core.network.host.HostFailure
import app.markiro.handheld.core.network.host.HostResult
import app.markiro.handheld.core.network.host.HostTransport
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import app.markiro.handheld.core.storage.syntheticDeviceConfig
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class HostReferenceSyncTest {
    private lateinit var db: HandheldDatabase
    private val hostId = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f"

    private class FeedTransport(val pages: ArrayDeque<String>) : HostTransport {
        val asked = mutableListOf<String>()
        override suspend fun get(path: String): HostResult = HostResult.Ok(200, pages.removeFirst(), null).also { asked += path }
        override suspend fun post(path: String, body: String): HostResult = error("the feed is read, not written")
    }

    @Before
    fun open() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        db.deviceConfigDao().let { dao ->
            kotlinx.coroutines.runBlocking { dao.upsert(syntheticDeviceConfig().copy(backend = "host", hostId = hostId, pinSha256 = "ab".repeat(32), lineId = "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61")) }
        }
        db.initializeRecoveryForTest()
    }

    @After
    fun close() = db.close()

    private fun fixture(name: String) =
        checkNotNull(javaClass.classLoader?.getResource(name)) { name }.readText()

    private fun sync(vararg pages: String): Pair<HostReferenceSync, FeedTransport> {
        val transport = FeedTransport(ArrayDeque(pages.toList()))
        return HostReferenceSync(db, db.deviceConfigDao(), MetaStore(db), HostApi(transport)) to transport
    }

    @Test
    fun theFeedGivesOperatorsTheirBadgesAndTheirPermissionToBuildPallets() = runTest {
        val (reference, transport) = sync(fixture("changes-people.json"))
        reference.sync().getOrThrow()
        val operator = db.operatorDao().all().single()
        assertEquals("0042", operator.login)
        assertEquals("Анна Кузнецова", operator.name)
        assertTrue(operator.pinHash.startsWith("pbkdf2$"))
        assertTrue(operator.active)
        assertEquals(listOf("c4e2a1b3-5d6f-4a8b-9c0d-1e2f3a4b5c6d"), db.operatorBadgeDao().all().map { it.badgeId })
        assertTrue(db.palletPermissionDao().get(operator.operatorId)!!.canBuildPallets)
        assertEquals(57L, db.deviceConfigDao().get()!!.hostRev)
        assertEquals(listOf("/v1/changes?since=0&limit=500"), transport.asked)
    }

    @Test
    fun aTombstoneRemovesTheOperatorAndItsBadgesAndASecondSyncAsksFromTheRevision() = runTest {
        val (reference, transport) = sync(
            fixture("changes-people.json"),
            """{"hostId":"$hostId","rev":60,"hasMore":false,"items":[{"entity":"operators","id":"8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b","rev":60,"deleted":true}]}""",
        )
        reference.sync().getOrThrow()
        reference.sync().getOrThrow()
        assertEquals(emptyList<Any>(), db.operatorDao().all())
        assertEquals(emptyList<Any>(), db.operatorBadgeDao().all())
        assertNull(db.palletPermissionDao().get("8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b"))
        assertEquals(listOf("/v1/changes?since=0&limit=500", "/v1/changes?since=57&limit=500"), transport.asked)
    }

    @Test
    fun aRecordOfAccessThatCannotBeReadRemovesTheLocalCopyInsteadOfKeepingIt() = runTest {
        val (reference, _) = sync(
            fixture("changes-people.json"),
            """{"hostId":"$hostId","rev":58,"hasMore":false,"items":[{"entity":"operators","id":"8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b","rev":58,"deleted":false,"data":{"login":"0042","name":"Анна","pinPhc":"not a verifier"}}]}""",
        )
        reference.sync().getOrThrow()
        assertEquals(1, db.operatorDao().all().size)
        reference.sync().getOrThrow()
        assertEquals("a verifier the app cannot read is no way in", emptyList<Any>(), db.operatorDao().all())
    }

    @Test
    fun aFeedOfAnotherHostStopsTheSyncAndWritesNothing() = runTest {
        val (reference, _) = sync(fixture("changes-people.json").replace(hostId, "00000000-0000-4000-8000-000000000000"))
        val failure = reference.sync().exceptionOrNull()
        assertTrue("$failure", failure is HostApiError && failure.failure == HostFailure.Constraint("host_mismatch"))
        assertEquals(emptyList<Any>(), db.operatorDao().all())
        assertNull(db.deviceConfigDao().get()!!.hostRev)
    }

    @Test
    fun pagesAreAppliedAsLongAsTheHostHasMore() = runTest {
        val first = """{"hostId":"$hostId","rev":10,"hasMore":true,"items":[{"entity":"operators","id":"8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b","rev":10,"deleted":false,"data":{"login":"0042","name":"Анна","pinPhc":"pbkdf2${'$'}sha256${'$'}100000${'$'}bWFya2lyby1waW4tc2FsdA==${'$'}3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU="}}]}"""
        val (reference, transport) = sync(first, fixture("changes-people.json"))
        reference.sync().getOrThrow()
        assertEquals(listOf("/v1/changes?since=0&limit=500", "/v1/changes?since=10&limit=500"), transport.asked)
        assertEquals(57L, db.deviceConfigDao().get()!!.hostRev)
    }

    @Test
    fun productsTemplatesAndTheDefaultsMakeTheLabelTemplatesOfPallets() = runTest {
        val catalog = fixture("changes-catalog.json")
        val (reference, _) = sync(catalog)
        reference.sync().getOrThrow()
        val products = db.palletProductDao().all()
        assertTrue("an archived product is not offered", products.none { it.gtin14 == "04600682000020" })
        val milk = products.single { it.gtin14 == "04600682000013" }
        assertEquals(40, milk.palletBoxCapacity)
        assertEquals("Молоко 3,2%", milk.printName)
        // Whatever the fixture's pallet defaults name, each resolves to a template the feed carried.
        for (row in db.palletLabelTemplateDao().all()) assertNotNull(row.specJson)
        assertEquals("ООО «Атолл»", db.deviceConfigDao().get()!!.organizationName)
    }

    @Test
    fun theNameOfTheDevicesOwnLineComesFromTheFeed() = runTest {
        val (reference, _) = sync(fixture("changes-response.json"))
        reference.sync().getOrThrow()
        assertEquals("Линия 2", db.deviceConfigDao().get()!!.lineName)
    }
}
```

`OperatorAuthHostTest.kt`:

```kotlin
package app.markiro.handheld.core.auth

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class OperatorAuthHostTest {
    private fun operator(vararg badges: String, legacy: String? = null) =
        OperatorRecord("op-1", "Анна", "0042", "Упаковщик", "pin-phc", legacy, true, badges.toList())

    private fun auth(record: OperatorRecord) = OperatorAuth(
        roster = object : OperatorRoster { override suspend fun operators() = listOf(record) },
        verifier = { secret, phc -> secret == phc.removePrefix("phc-") },
    )

    @Test
    fun anyOfSeveralBadgesOfAnOperatorSignsHimIn() = runTest {
        val auth = auth(operator("phc-first", "phc-second"))
        assertEquals("op-1", auth.byBadge("first")?.operatorId)
        assertEquals("op-1", auth.byBadge("second")?.operatorId)
        assertNull(auth.byBadge("third"))
    }

    @Test
    fun theCloudsSingleBadgeStillWorksAlone() = runTest {
        assertEquals("op-1", auth(operator(legacy = "phc-only")).byBadge("only")?.operatorId)
        assertNull(auth(operator()).byBadge("anything"))
    }
}
```

`HostBlockSupplierTest.kt`:

```kotlin
package app.markiro.handheld.core.host

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.box.SsccPool
import app.markiro.handheld.core.network.host.HostApi
import app.markiro.handheld.core.network.host.HostResult
import app.markiro.handheld.core.network.host.HostTransport
import app.markiro.handheld.core.network.host.TransportFailure
import app.markiro.handheld.core.pallets.SsccBlockApplier
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class HostBlockSupplierTest {
    private lateinit var db: HandheldDatabase

    @Before
    fun open() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        db.initializeRecoveryForTest()
    }

    @After
    fun close() = db.close()

    /** Answers each POST with the next scripted result and keeps what was sent as `"<path> <body>"`. */
    private class Script(val answers: ArrayDeque<HostResult>) : HostTransport {
        val bodies = mutableListOf<String>()
        override suspend fun get(path: String): HostResult = error("no GET")
        override suspend fun post(path: String, body: String): HostResult = answers.removeFirst().also { bodies += "$path $body" }
    }

    private fun block(id: String, from: Long, to: Long, extension: Int = 0) =
        HostResult.Ok(200, """{"id":"$id","issuerPrefix":"460068200","extension":$extension,"fromSerial":$from,"toSerial":$to}""", null)

    private fun supplier(script: Script): HostBlockSupplier {
        val pool = SsccPool(db)
        return HostBlockSupplier(db, MetaStore(db), HostApi(script), pool, SsccBlockApplier(pool), requestId = { "req-${script.bodies.size}" })
    }

    @Test
    fun aBlockIsRequestedWhenThePoolIsDryAndKeepsTheIdOfItsBlock() = runTest {
        val script = Script(ArrayDeque(listOf(block("b1000000-0000-4000-8000-000000000001", 1500, 3499))))
        supplier(script).ensure("460068200", 0).getOrThrow()
        assertEquals(1, script.bodies.size)
        val range = db.ssccPoolDao().lowestWithRoom("460068200", 0)!!
        assertEquals(Triple(1500L, 3499L, 1500L), Triple(range.fromSerial, range.toSerial, range.nextSerial))
        assertEquals("b1000000-0000-4000-8000-000000000001", range.blockId)
        assertNull("the request id is forgotten once the block is held", MetaStore(db).get("host_block_request:0"))
    }

    @Test
    fun aRequestThatGotNoAnswerIsRepeatedUnderTheSameIdAndANeededBlockIsNotAskedTwice() = runTest {
        val script = Script(
            ArrayDeque(
                listOf(HostResult.Failed(TransportFailure.TIMEOUT), block("b1000000-0000-4000-8000-000000000001", 1500, 3499)),
            ),
        )
        val supplier = supplier(script)
        assertEquals(true, supplier.ensure("460068200", 0).isFailure)
        supplier.ensure("460068200", 0).getOrThrow()
        val ids = script.bodies.map { Regex("\"requestId\":\"([^\"]+)\"").find(it)!!.groupValues[1] }
        assertEquals("a retry carries the same request id: the host answers the same block", ids[0], ids[1])
        supplier.ensure("460068200", 0).getOrThrow()
        assertEquals("the pool is full: no third request", 2, script.bodies.size)
    }

    @Test
    fun aPoolBelowHalfABlockAsksForTheNextOne() = runTest {
        val script = Script(ArrayDeque(listOf(block("b1000000-0000-4000-8000-000000000001", 1500, 3499), block("b1000000-0000-4000-8000-000000000002", 3500, 5499))))
        val supplier = supplier(script)
        supplier.ensure("460068200", 0).getOrThrow()
        val pool = SsccPool(db)
        repeat(1100) { pool.burn("460068200", 0) }
        supplier.ensure("460068200", 0).getOrThrow()
        assertEquals(2, script.bodies.size)
        assertEquals(true, db.ssccPoolDao().remaining("460068200", 0) > 900)
    }
}
```

`HostLinkMonitorTest.kt`:

```kotlin
package app.markiro.handheld.core.host

import app.markiro.handheld.core.network.host.HelloDto
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HostLinkMonitorTest {
    private fun hello(epoch: String? = null, time: String = "2026-10-15T09:00:00Z", protocol: Int = 6) =
        HelloDto("markiro-host", protocol, 1, "h", "0.1.0", time, true, epoch)

    @Test
    fun aChangedRestoreEpochIsReportedOnceAndTheFirstOneIsJustRemembered() = runTest {
        val seen = mutableListOf<String?>()
        val monitor = HostLinkMonitor(now = { 1_790_000_000_000L }, onRestore = { seen += it })
        assertFalse(monitor.observe(hello(epoch = "e1"), knownEpoch = null).restored)
        assertTrue(monitor.observe(hello(epoch = "e2"), knownEpoch = "e1").restored)
        assertFalse(monitor.observe(hello(epoch = "e2"), knownEpoch = "e2").restored)
        assertEquals(listOf<String?>("e2"), seen)
    }

    @Test
    fun theHostsClockMoreThanTwoMinutesFromTheDevicesIsWarnedAbout() = runTest {
        val now = java.time.Instant.parse("2026-10-15T09:00:00Z").toEpochMilli()
        val monitor = HostLinkMonitor(now = { now }, onRestore = {})
        assertFalse(monitor.observe(hello(time = "2026-10-15T09:01:59Z"), null).clockSkew)
        assertTrue(monitor.observe(hello(time = "2026-10-15T09:02:01Z"), null).clockSkew)
        assertTrue(monitor.observe(hello(time = "2026-10-15T08:57:00Z"), null).clockSkew)
    }
}
```

Run: `$GR :app:testDebugUnitTest --tests 'app.markiro.handheld.core.host.*' --tests 'app.markiro.handheld.core.auth.OperatorAuthHostTest'`
Expected: ошибка компиляции (`HostReferenceSync`, `HostBlockSupplier`, `HostLinkMonitor`, `OperatorRecord.badgeHashes`, … не определены).

- [ ] **Step 2: операторы и бейджи.** `core/auth/OperatorRecord.kt`: `val badgeHashes: List<String> = emptyList()` последним полем (`data class OperatorRecord(…, val active: Boolean, val badgeHashes: List<String> = emptyList())`).
      `OperatorAuth.byBadge`:

```kotlin
    suspend fun byBadge(code: String): OperatorRecord? {
        if (code.isEmpty()) return null
        val candidates = roster.operators().filter { it.active && (it.badgeHash != null || it.badgeHashes.isNotEmpty()) }
        return withContext(hashDispatcher) {
            candidates.firstOrNull { operator -> (listOfNotNull(operator.badgeHash) + operator.badgeHashes).any { verifier(code, it) } }
        }
    }
```

`RosterStore(dao, recovery, badges: OperatorBadgeDao? = null)`: `operators()` присоединяет `badges?.all()?.groupBy { it.operatorId }` к `badgeHashes`; провайдер в `StorageModule`
передаёт `db.operatorBadgeDao()`. `OperatorDao`: `@Upsert suspend fun upsert(row: OperatorEntity)` и `@Query("DELETE FROM operators WHERE operatorId = :id") suspend fun delete(id: String)`.
`PalletProductDao`: `@Upsert suspend fun upsert(row: PalletProductEntity)`, `@Query("DELETE FROM pallet_products WHERE id = :id") suspend fun delete(id: String)`, `@Query("SELECT * FROM pallet_products") suspend fun all()` (если не хватает);
`PalletPermissionDao`: `@Upsert suspend fun upsert(row)`, `@Query("DELETE FROM pallet_permissions WHERE employeeId = :id") suspend fun delete(id: String)`;
`PalletLabelTemplateDao`: `@Query("SELECT * FROM pallet_label_templates") suspend fun all()`; `MetaDao`:
`@Query("SELECT * FROM meta WHERE `key` LIKE :prefix || '%'") suspend fun withPrefix(prefix: String): List<MetaEntity>`.

- [ ] **Step 3: лента.** `core/host/HostReferenceSync.kt`:

```kotlin
package app.markiro.handheld.core.host

import app.markiro.handheld.core.network.host.ChangeItemDto
import app.markiro.handheld.core.network.host.HostApi
import app.markiro.handheld.core.network.host.HostApiError
import app.markiro.handheld.core.network.host.HostFailure
import app.markiro.handheld.core.storage.DeviceConfigDao
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaEntity
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.storage.OperatorBadgeEntity
import app.markiro.handheld.core.storage.OperatorEntity
import app.markiro.handheld.core.storage.PalletLabelTemplateEntity
import app.markiro.handheld.core.storage.PalletPermissionEntity
import app.markiro.handheld.core.storage.PalletProductEntity
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull

/**
 * The host's reference data (`GET /v1/changes`) into Room (spec 8.5, point 1): operators, their badges, the products of the pallet mode, the
 * labels' templates and the names of the line and the organization. Every page is applied in one transaction and its revision is kept with
 * it, so a crash re-reads the page. A record of access (`operators`, `operator_badges`) that cannot be read removes the local copy: an
 * unreadable verifier is no way in (the station's rule). A feed of another host stops the sync and writes nothing.
 */
class HostReferenceSync(
    private val db: HandheldDatabase,
    private val config: DeviceConfigDao,
    private val meta: MetaStore,
    private val api: HostApi,
    private val pageSize: Int = 500,
) {
    suspend fun sync(): Result<Unit> = runCatching {
        while (true) {
            val current = config.get() ?: error("the device is not paired")
            val since = current.hostRev ?: 0L
            val page = api.changes(since, pageSize).getOrThrow()
            if (current.hostId != null && page.hostId != current.hostId) throw HostApiError(HostFailure.Constraint("host_mismatch"))
            db.recovery.commit { applyPage(page.items, page.rev) }
            if (!page.hasMore) break
        }
    }

    private suspend fun applyPage(items: List<ChangeItemDto>, rev: Long) {
        for (item in items) {
            when (item.entity) {
                "operators" -> operator(item)
                "operator_badges" -> badge(item)
                "products" -> product(item)
                "lines" -> line(item)
                "label_templates" -> template(item)
                "category_template_defaults" -> categoryDefault(item)
                "org_profile" -> organization(item)
                else -> Unit // `site`, `code_releases`: nothing a handheld keeps
            }
        }
        rebuildPalletTemplates()
        rebuildPalletPermissions()
        config.get()?.let { config.upsert(it.copy(hostRev = rev)) }
    }

    private fun JsonObject.text(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.contentOrNull

    private suspend fun operator(item: ChangeItemDto) {
        val data = item.data
        val login = data?.text("login")
        val name = data?.text("name")
        val phc = data?.text("pinPhc")
        if (item.deleted || data == null || login == null || name == null || phc == null || !isReadableVerifier(phc)) {
            db.operatorDao().delete(item.id)
            db.operatorBadgeDao().deleteOf(item.id)
            return
        }
        db.operatorDao().upsert(OperatorEntity(item.id, name, login, data.text("role").orEmpty(), phc, null, true))
    }

    private suspend fun badge(item: ChangeItemDto) {
        val data = item.data
        val operatorId = data?.text("operatorId")
        val phc = data?.text("badgePhc")
        if (item.deleted || operatorId == null || phc == null || !isReadableVerifier(phc)) {
            db.operatorBadgeDao().delete(item.id)
            return
        }
        db.operatorBadgeDao().upsert(OperatorBadgeEntity(item.id, operatorId, phc, data.text("label")))
    }

    /** `pbkdf2$sha256$<iterations>$<salt>$<digest>`, the shape [app.markiro.handheld.core.auth.PhcVerifier] verifies. */
    private fun isReadableVerifier(phc: String): Boolean {
        val parts = phc.split('$')
        return parts.size == 5 && parts[0] == "pbkdf2" && parts[1] == "sha256" && parts[2].toIntOrNull() != null && parts[3].isNotEmpty() && parts[4].isNotEmpty()
    }

    private suspend fun product(item: ChangeItemDto) {
        val data = item.data
        if (item.deleted || data == null || data["archived"]?.let { (it as? JsonPrimitive)?.booleanOrNull } == true) {
            db.palletProductDao().delete(item.id)
            return
        }
        val gtin = data.text("gtin14") ?: return db.palletProductDao().delete(item.id)
        val name = data.text("name") ?: return db.palletProductDao().delete(item.id)
        fun int(key: String) = (data[key] as? JsonPrimitive)?.intOrNull
        db.palletProductDao().upsert(
            PalletProductEntity(item.id, gtin, name, data.text("printName"), int("shelfLifeDays"), int("palletBoxCapacity"), int("chzProductGroupCode")),
        )
    }

    private suspend fun line(item: ChangeItemDto) {
        val own = config.get() ?: return
        if (item.id != own.lineId) return
        val name = if (item.deleted) null else item.data?.text("name")
        config.upsert(own.copy(lineName = name ?: own.lineName))
    }

    private suspend fun template(item: ChangeItemDto) {
        val key = "host_template:${item.id}"
        val data = item.data
        if (item.deleted || data == null || data.text("purpose") != "pallet" || data["enabled"]?.let { (it as? JsonPrimitive)?.booleanOrNull } == false) {
            meta.remove(key)
            return
        }
        val spec = data["spec"]?.toString() ?: return meta.remove(key)
        meta.put(key, spec)
    }

    private suspend fun categoryDefault(item: ChangeItemDto) {
        val data = item.data
        val code = data?.let { (it["chzProductGroupCode"] as? JsonPrimitive)?.intOrNull }
        val purpose = data?.text("purpose")
        // The feed id is `<code>:<purpose>`; a tombstone has no data, so the key is read from the id.
        val (idCode, idPurpose) = item.id.split(':', limit = 2).let { (it.getOrNull(0) ?: "") to (it.getOrNull(1) ?: "") }
        val key = "host_cat_default:${code?.toString() ?: idCode}:${purpose ?: idPurpose}"
        val template = data?.text("templateId")
        if (item.deleted || template == null) meta.remove(key) else meta.put(key, template)
    }

    private suspend fun organization(item: ChangeItemDto) {
        val data = item.data ?: return
        config.get()?.let { config.upsert(it.copy(organizationName = data.text("name") ?: it.organizationName)) }
        val pallet = data.text("defaultPalletTemplateId")
        if (pallet == null) meta.remove(ORG_PALLET_TEMPLATE) else meta.put(ORG_PALLET_TEMPLATE, pallet)
    }

    /** The organization's pallet template and each category's, as the cloud's bootstrap delivered them (`org` and `category:<code>`). */
    private suspend fun rebuildPalletTemplates() {
        val rows = mutableListOf<PalletLabelTemplateEntity>()
        meta.get(ORG_PALLET_TEMPLATE)?.let { id -> meta.get("host_template:$id")?.let { rows += PalletLabelTemplateEntity(PalletLabelTemplateEntity.ORG, it) } }
        for (entry in db.metaDao().withPrefix("host_cat_default:")) {
            val (code, purpose) = entry.key.removePrefix("host_cat_default:").split(':').let { it[0] to it.getOrElse(1) { "" } }
            if (purpose != "pallet") continue
            val spec = meta.get("host_template:${entry.value}") ?: continue
            code.toIntOrNull()?.let { rows += PalletLabelTemplateEntity(PalletLabelTemplateEntity.category(it), spec) }
        }
        db.palletLabelTemplateDao().replaceAll(rows)
    }

    /** No flag «может строить паллеты» on the host's operators (decision В-5): every operator may. */
    private suspend fun rebuildPalletPermissions() {
        val operators = db.operatorDao().all().map { it.operatorId }.toSet()
        for (id in operators) db.palletPermissionDao().upsert(PalletPermissionEntity(id, true))
        for (stale in db.palletPermissionDao().all().map { it.employeeId } - operators) db.palletPermissionDao().delete(stale)
    }

    private companion object {
        const val ORG_PALLET_TEMPLATE = "host_org_pallet_template"
    }
}
```

(`OperatorBadgeDao.deleteOf(operatorId)` — запрос `DELETE FROM operator_badges WHERE operatorId = :operatorId`, добавьте в DAO С3; `PalletPermissionDao.all()` — `SELECT * FROM pallet_permissions`; неиспользуемый импорт `MetaEntity` удалите.)

- [ ] **Step 4: блоки SSCC.** `core/network/ShiftDtos.kt`: `BundleSsccDto` получает последним полем `val blockId: String? = null` (облако его не шлёт и не читает). `ServerRange` — тоже `val blockId: String? = null`;
      `SsccPool.addRangeOwned` кладёт его в `SsccRangeEntity(…, blockId = range.blockId)`; `SsccBlockApplier.apply` передаёт `block.blockId`. `SsccPoolDao`: `@Query("SELECT * FROM sscc_pool WHERE issuerPrefix = :prefix AND extensionDigit = :extension AND fromSerial <= :serial AND toSerial >= :serial LIMIT 1") suspend fun rangeOf(prefix: String, extension: Int, serial: Long): SsccRangeEntity?`.
      `core/host/HostBlockSupplier.kt`:

```kotlin
package app.markiro.handheld.core.host

import app.markiro.handheld.core.box.SsccPool
import app.markiro.handheld.core.network.BundleSsccDto
import app.markiro.handheld.core.network.host.HostApi
import app.markiro.handheld.core.pallets.SsccBlockApplier
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaStore
import java.util.UUID

/**
 * The device's SSCC blocks from the host (spec 8.5, point 5): a block is requested when the pool is dry or below half a block; the request id is
 * kept until the block is held, so a lost answer is repeated under the same id and the host gives the same block. A block of the host carries its
 * id, which `box_closed` and `pallet_closed` name.
 */
class HostBlockSupplier(
    private val db: HandheldDatabase,
    private val meta: MetaStore,
    private val api: HostApi,
    private val pool: SsccPool,
    private val blocks: SsccBlockApplier,
    private val requestId: () -> String = { UUID.randomUUID().toString() },
) {
    suspend fun ensure(issuerPrefix: String, extension: Int): Result<Unit> = runCatching {
        val remaining = pool.remaining(issuerPrefix, extension)
        val pending = meta.get(requestKey(extension))
        if (pending == null && remaining >= size(extension) / 2) return@runCatching
        val id = pending ?: requestId().also { meta.put(requestKey(extension), it) }
        val block = api.block(id, issuerPrefix, extension).getOrThrow()
        blocks.apply(BundleSsccDto(block.issuerPrefix, block.extension, block.fromSerial, block.toSerial, null, block.id), emptyList())
        meta.remove(requestKey(extension))
    }

    /** After a restore of the host from a copy it knows no block of ours (`restoreEpoch` changed): tell it every one we hold (`POST /v1/device/sscc/blocks/known`). */
    suspend fun registerKnown(): Result<Unit> = runCatching {
        val held = db.ssccPoolDao().allWithBlockId()
        if (held.isEmpty()) return@runCatching
        api.knownBlocks(held.map { KnownBlock(checkNotNull(it.blockId), it.issuerPrefix, it.extensionDigit, it.fromSerial, it.toSerial) }).getOrThrow()
    }

    private fun requestKey(extension: Int) = "host_block_request:$extension"

    /** A block's size on the host (`site.boxBlockSize` 2000, `palletBlockSize` 200 by default). */
    private fun size(extension: Int): Long = if (extension == 0) 2000L else 200L
}

data class KnownBlock(val id: String, val issuerPrefix: String, val extension: Int, val fromSerial: Long, val toSerial: Long)
```

Добавьте в `HostApi` (С2) метод `knownBlocks(blocks: List<KnownBlock>)`: тело `{"blocks":[{id,issuerPrefix,extension,fromSerial,toSerial}…]}` (по 64 блока в пачке с `"more": true` во всех, кроме последней;
форма — `known-blocks-request.json`), результат — список `{id, outcome, code}`; в `SsccPoolDao` — `@Query("SELECT * FROM sscc_pool WHERE blockId IS NOT NULL") suspend fun allWithBlockId()`.

- [ ] **Step 5: связь.** `core/host/HostLinkMonitor.kt`:

```kotlin
package app.markiro.handheld.core.host

import app.markiro.handheld.core.network.host.HelloDto
import java.time.Instant
import kotlin.math.abs

data class HostObservation(val restored: Boolean, val clockSkew: Boolean, val skewMs: Long?)

/**
 * What a `hello` says about the link (spec 8.5, point 7, risk Р-6): a restore of the host (its `restoreEpoch` changed since the one this device
 * knew) and a gap of more than two minutes between the host's clock and the device's, which spoils the order in which codes are displaced.
 */
class HostLinkMonitor(private val now: () -> Long, private val onRestore: (String?) -> Unit) {
    fun observe(hello: HelloDto, knownEpoch: String?): HostObservation {
        val epoch = hello.restoreEpoch
        val restored = epoch != null && knownEpoch != null && epoch != knownEpoch
        if (restored) onRestore(epoch)
        val host = hello.time?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }
        val skew = host?.let { it - now() }
        return HostObservation(restored, skew != null && abs(skew) > MAX_SKEW_MS, skew)
    }

    companion object {
        const val MAX_SKEW_MS = 2 * 60 * 1000L
    }
}
```

- [ ] **Step 6: бэкенд хоста (первые методы) и начальная выкачка.** `core/backend/HostBackend.kt`:

```kotlin
package app.markiro.handheld.core.backend

import app.markiro.handheld.core.host.HostReferenceSync
import app.markiro.handheld.core.network.OperatorDto
import app.markiro.handheld.core.network.RosterResponse
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.storage.OperatorDao

/** The host behind the seam. Shifts, blocks and the pallet mode are added by tasks Д1 and Д3; what is not answered yet is `NoBackend`'s refusal. */
class HostBackend(
    private val reference: HostReferenceSync,
    private val operators: OperatorDao,
) : StationBackend by NoBackend {
    override suspend fun kindNow() = BackendKind.HOST
    override suspend fun cloudApi(): StationApi? = null

    /** The roster is what the feed wrote to Room: reading the feed is how it is refreshed. */
    override suspend fun operators(): RosterResponse {
        reference.sync().getOrThrow()
        return RosterResponse(operators.all().map { OperatorDto(it.operatorId, it.name, it.login, it.role, it.pinHash, it.badgeHash, it.active) })
    }
}
```

`feature/hub/RosterRefresher.refresh` (С3) в начале: `if (backend.kindNow() == BackendKind.HOST) { runCatching { backend.operators() }.getOrNull() ?: return@work; recovery.commit { config.get()?.let { config.upsert(it.copy(rosterFetchedAt = now)) } }; return@work }`.
`core/host/HostBootstrapImpl.kt`: `HostBootstrap` из С4 — `initialSync()` = `reference.sync()` затем `api.orgPrint()` (в `meta`: `PALLET_BOOTSTRAP_ISSUER_PREFIX` = `issuerPrefix`) затем `api.device()` (имя линии и `lineId` в `device_config`) затем `HostBlockSupplier.ensure(prefix, 0)`;
ошибка любого шага — `Result.failure`. `HostModule` (Hilt) строит `HostApi` над `OkHttpHostTransport(HostHttpClient.pinned(pin) { key }, origin)`, где `pin`, `origin` и `key` читаются из `DeviceRecovery`/`device_config`
при каждом обращении (устройство могло перепривязаться), и подставляет настоящие `HostBackend` (вместо `HostBackendHolder` из С3) и `HostBootstrap`.

- [ ] **Step 7: запустить, увидеть успех.**

  Run: `$GR :app:testDebugUnitTest --tests 'app.markiro.handheld.core.host.*' --tests 'app.markiro.handheld.core.auth.*' --tests 'app.markiro.handheld.core.storage.*' --tests 'app.markiro.handheld.core.pallets.*' --tests 'app.markiro.handheld.feature.hub.*'`
  Expected: `BUILD SUCCESSFUL` (`HostReferenceSyncTest` — 7, `OperatorAuthHostTest` — 2, `HostBlockSupplierTest` — 3, `HostLinkMonitorTest` — 2; облачные тесты без изменений).

- [ ] **Step 8: Commit.**

```bash
git -C "$WT" add apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/host apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/backend apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/auth apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/storage apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/box/SsccPool.kt apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/pallets/SsccBlockApplier.kt apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/network apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/hub/RosterRefresher.kt apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/pairing/PairingModule.kt apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/host apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/auth/OperatorAuthHostTest.kt
git -C "$WT" commit -m "feat(handheld): host reference data from the changes feed, several badges, SSCC blocks of the host

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

## Task Д1: смены на хосте — список, вход со снимком, блоки, хаб в режиме `host`

**Files:**

- Modify: `core/backend/HostBackend.kt` (`shifts`, `enter`, `bundle`, `topUpBoxSscc`, `hubCounts`), `core/backend/BackendModule.kt` / `core/host/HostModule.kt` (зависимости)
- Create: `core/host/HostCalls.kt` (перевод отказов хоста в то, что читают загрузчики), `core/host/HostRevocation.kt`, `core/host/HostShiftMapping.kt`
- Modify: `feature/hub/HubViewModel.kt` (`HubUi.hostMode`), `feature/hub/HubScreen.kt` (`visibleTiles`), `res/values/strings.xml`, `res/values-en/strings.xml`
- Test: `core/backend/HostBackendShiftsTest.kt`, `feature/shift/ShiftRepositoryHostTest.kt`, `feature/hub/HubTilesTest.kt`

**Interfaces:**

- Consumes: С2 (`HostApi.shifts/enter/block`, `HostFailure`), С5 (`HostBlockSupplier.ensure`, пул с `blockId`), С3 (`StationBackend`, `ShiftRepository` на шве), фикстуры `device-shifts.json`, `device-shift-entered-pallets.json`, `sscc-block.json`.
- Produces: `HostBackend` отвечает на вызовы загрузчиков смен: `ShiftListResponse` из `GET /v1/device/shifts`, `ShiftDto` и `ShiftBundleDto` из `POST …/enter` (снимок смены → пакет: товар, шаблоны коробки и паллеты, блоки SSCC обоих расширений из пула);
  `HostCalls.run` — единственное место, где отказ хоста превращается в `IOException` или `retrofit2.HttpException` с кодом, который уже читает `ShiftRepository.refusal`; `visibleTiles(hostMode)`.

Решения, которых нет в спецификации:

- Отказ хоста превращается в `HttpException` с облачным кодом, чтобы `ShiftRepository` и экраны смен не менялись: `station_update` → `409 STATION_UPDATE_REQUIRED` («Обновите приложение»), закрытая смена (`shift_status`) → `409` без кода («смена закрыта»),
  остальные ограничения (`shift_busy`, `shift_line`, `license_restricted`, …) → `409` с кодом самого ограничения, и экран показывает его, как показывает облачные коды.
- Блоки SSCC выдаются при входе в смену (хост выдаёт блок по запросу устройства, а не вместе со сменой): пакет несёт блок из пула — самый ранний с остатком, — а `ShiftRepository.applySsccBlock` повторно кладёт тот же диапазон и ничего не портит (`addRange` идемпотентен и не откатывает курсор).
- Команда смены («кто ещё работает») на хосте не показывается: `GET …/summary` отложен (спецификация, п. 10 таблицы маршрутов).

- [ ] **Step 1: написать падающие тесты.**

  `core/backend/HostBackendShiftsTest.kt`:

```kotlin
package app.markiro.handheld.core.backend

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.box.SsccPool
import app.markiro.handheld.core.host.HostBlockSupplier
import app.markiro.handheld.core.host.HostCalls
import app.markiro.handheld.core.network.ShiftEntryRequest
import app.markiro.handheld.core.network.host.HostApi
import app.markiro.handheld.core.network.host.HostResult
import app.markiro.handheld.core.network.host.HostTransport
import app.markiro.handheld.core.network.host.TransportFailure
import app.markiro.handheld.core.pallets.SsccBlockApplier
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import app.markiro.handheld.core.storage.syntheticDeviceConfig
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import retrofit2.HttpException
import java.io.IOException

@RunWith(AndroidJUnit4::class)
class HostBackendShiftsTest {
    private lateinit var db: HandheldDatabase

    @Before
    fun open() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        kotlinx.coroutines.runBlocking {
            db.deviceConfigDao().upsert(syntheticDeviceConfig().copy(backend = "host", hostId = "h1", pinSha256 = "ab".repeat(32), lineName = "Линия 2"))
        }
        db.initializeRecoveryForTest()
    }

    @After
    fun close() = db.close()

    private fun fixture(name: String) = checkNotNull(javaClass.classLoader?.getResource(name)) { name }.readText()

    /** Answers by path; keeps what was posted. */
    private class Routes(val answers: MutableMap<String, ArrayDeque<HostResult>>) : HostTransport {
        val posts = mutableListOf<Pair<String, String>>()
        override suspend fun get(path: String) = answers.getValue(path).removeFirst()
        override suspend fun post(path: String, body: String): HostResult {
            posts += path to body
            val queue = answers[path]?.takeIf { it.isNotEmpty() } ?: error("nothing scripted for POST $path")
            return queue.removeFirst()
        }
    }

    private fun ok(body: String, code: Int = 200) = HostResult.Ok(code, body, null)
    private fun refusal(code: Int, kind: String, details: String) =
        HostResult.Ok(code, """{"error":{"code":"$kind","message":"m","details":$details}}""", null)

    private val shiftPath = "/v1/device/shifts/0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b/enter"
    private val block0 = """{"id":"b1000000-0000-4000-8000-000000000001","issuerPrefix":"460068200","extension":0,"fromSerial":1500,"toSerial":3499}"""
    private val block1 = """{"id":"b1000000-0000-4000-8000-000000000002","issuerPrefix":"460068200","extension":1,"fromSerial":40,"toSerial":239}"""

    private fun backend(routes: Routes, revoked: () -> Unit = {}): HostBackend {
        val api = HostApi(routes)
        val pool = SsccPool(db)
        val supplier = HostBlockSupplier(db, MetaStore(db), api, pool, SsccBlockApplier(pool), requestId = { "req-${routes.posts.size}" })
        return HostBackend(
            api = { api }, config = db.deviceConfigDao(), db = db, supplier = supplier,
            calls = HostCalls(revocation = { revoked() }), reference = null, operators = db.operatorDao(),
        )
    }

    @Test
    fun theListIsTheHostsShiftsInTheShapeTheLoadersRead() = runTest {
        val routes = Routes(mutableMapOf("/v1/device/shifts" to ArrayDeque(listOf(ok(fixture("device-shifts.json"))))))
        val items = backend(routes).shifts().items
        assertEquals(listOf("active", "planned"), items.map { it.status }.take(2))
        val first = items.first()
        assertEquals("OCT26-004", first.number)
        assertEquals("Молоко 3,2% 0,9 л", first.productName)
        assertEquals("Линия 2", first.lineName)
        assertEquals(false, first.palletsEnabled)
        assertEquals("none", first.validationPrint.mode)
        assertNull(first.palletBoxCapacity)
    }

    @Test
    fun anEntryGivesTheBundleWithTheSnapshotsTemplatesAndBlocksOfBothExtensions() = runTest {
        val routes = Routes(
            mutableMapOf(
                shiftPath to ArrayDeque(listOf(ok(fixture("device-shift-entered-pallets.json")))),
                "/v1/device/sscc/blocks" to ArrayDeque(listOf(ok(block0), ok(block1))),
            ),
        )
        val backend = backend(routes)
        val shift = backend.enter("0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b", ShiftEntryRequest("list"))
        assertEquals("active", shift.status)
        assertEquals(40, shift.palletBoxCapacity)
        val bundle = backend.bundle("0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b")
        assertEquals("04600682000013", bundle.product.gtin14)
        assertEquals("Молоко 3,2%", bundle.product.printName)
        assertEquals(10, bundle.product.shelfLifeDays)
        assertEquals(58.0, bundle.boxLabelTemplate!!.spec.jsonObject.getValue("widthMm").jsonPrimitive.content.toDouble(), 0.0)
        assertNotNull(bundle.palletLabelTemplate)
        assertEquals(Triple("460068200", 0, 1500L), bundle.sscc!!.let { Triple(it.issuerPrefix, it.extensionDigit, it.fromSerial) })
        assertEquals("b1000000-0000-4000-8000-000000000001", bundle.sscc!!.blockId)
        assertEquals(Triple("460068200", 1, 40L), bundle.palletSscc!!.let { Triple(it.issuerPrefix, it.extensionDigit, it.fromSerial) })
        assertNull(bundle.ssccIssuerProblem)
        // One entry and two block requests, and the entry names the capability.
        assertEquals(1, routes.posts.count { it.first == shiftPath })
        assertTrue(routes.posts.first { it.first == shiftPath }.second.contains("handheld-host-v1"))
        assertEquals(2, routes.posts.count { it.first == "/v1/device/sscc/blocks" })
    }

    @Test
    fun theHostsRefusalsReachTheLoadersAsTheCodesTheyAlreadyRead() = runTest {
        fun entering(answer: HostResult) = backend(Routes(mutableMapOf(shiftPath to ArrayDeque(listOf(answer)))))
        suspend fun refused(answer: HostResult): Pair<Int, String> {
            val error = runCatching { entering(answer).enter("0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b", ShiftEntryRequest("list")) }.exceptionOrNull()
            val http = error as HttpException
            return http.code() to http.response()?.errorBody()?.string().orEmpty()
        }
        assertEquals(409 to """{"code":"STATION_UPDATE_REQUIRED"}""", refused(refusal(409, "conflict", """{"constraint":"station_update"}""")))
        assertEquals(409 to "{}", refused(refusal(409, "conflict", """{"constraint":"shift_status","status":"closed"}""")))
        assertEquals(409 to """{"code":"shift_busy"}""", refused(refusal(409, "conflict", """{"constraint":"shift_busy"}""")))
        assertEquals(409 to """{"code":"shift_line"}""", refused(refusal(409, "conflict", """{"constraint":"shift_line"}""")))
        assertEquals(409 to """{"code":"license_restricted"}""", refused(refusal(409, "conflict", """{"constraint":"license_restricted"}""")))
    }

    @Test
    fun aHostThatDoesNotAnswerIsAnIoErrorWhichTheLoadersTreatAsOffline() = runTest {
        for (failure in TransportFailure.entries) {
            val backend = backend(Routes(mutableMapOf(shiftPath to ArrayDeque(listOf(HostResult.Failed(failure))))))
            assertThrows(IOException::class.java) { kotlinx.coroutines.runBlocking { backend.enter("0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b", ShiftEntryRequest("list")) } }
        }
    }

    @Test
    fun aRejectedKeyRevokesTheDeviceOnceAndIsAnIoError() = runTest {
        var revoked = 0
        val backend = backend(
            Routes(mutableMapOf("/v1/device/shifts" to ArrayDeque(listOf(refusal(401, "unauthorized", """{"credential":"device"}""")))))) ,
            revoked = { revoked++ },
        )
        assertThrows(IOException::class.java) { kotlinx.coroutines.runBlocking { backend.shifts() } }
        assertEquals(1, revoked)
    }

    @Test
    fun theTopUpAsksForABlockOfTheShiftsPrefixAndReturnsWhatThePoolHolds() = runTest {
        val routes = Routes(mutableMapOf("/v1/device/sscc/blocks" to ArrayDeque(listOf(ok(block0)))))
        db.shiftDao().upsert(app.markiro.handheld.core.storage.ShiftEntityFixtures.bundled("s1").copy(ssccIssuerPrefix = "460068200"))
        val top = backend(routes).topUpBoxSscc("s1")
        assertEquals(listOf(1500L), top.blocks.map { it.fromSerial })
        assertEquals(emptyList<Long>(), top.revokedFrom)
        assertNull(top.issuerProblem)
    }
}
```

`feature/shift/ShiftRepositoryHostTest.kt` (интеграция шва: тот же `ShiftRepository`, что у облака, но с `HostBackend`):

```kotlin
package app.markiro.handheld.feature.shift

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.backend.HostBackend
import app.markiro.handheld.core.box.SsccPool
import app.markiro.handheld.core.host.HostBlockSupplier
import app.markiro.handheld.core.host.HostCalls
import app.markiro.handheld.core.network.host.HostApi
import app.markiro.handheld.core.network.host.HostResult
import app.markiro.handheld.core.network.host.HostTransport
import app.markiro.handheld.core.pallets.SsccBlockApplier
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import app.markiro.handheld.core.storage.syntheticDeviceConfig
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ShiftRepositoryHostTest {
    private lateinit var db: HandheldDatabase
    private val id = "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b"

    @Before
    fun open() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        kotlinx.coroutines.runBlocking {
            db.deviceConfigDao().upsert(syntheticDeviceConfig().copy(backend = "host", hostId = "h1", pinSha256 = "ab".repeat(32), lineName = "Линия 2"))
        }
        db.initializeRecoveryForTest()
    }

    @After
    fun close() = db.close()

    private fun fixture(name: String) = checkNotNull(javaClass.classLoader?.getResource(name)) { name }.readText()

    private class Script(val gets: Map<String, String>, val posts: MutableMap<String, ArrayDeque<HostResult>>) : HostTransport {
        override suspend fun get(path: String) = HostResult.Ok(200, gets.getValue(path), null)
        override suspend fun post(path: String, body: String) = posts.getValue(path).removeFirst()
    }

    private fun repository(script: Script): ShiftRepository {
        val api = HostApi(script)
        val pool = SsccPool(db)
        val supplier = HostBlockSupplier(db, MetaStore(db), api, pool, SsccBlockApplier(pool))
        val backend = HostBackend({ api }, db.deviceConfigDao(), db, supplier, HostCalls { }, null, db.operatorDao())
        return ShiftRepository(backend, db, Json { ignoreUnknownKeys = true }, pool)
    }

    private fun ok(body: String) = HostResult.Ok(200, body, null)
    private val block0 = """{"id":"b1000000-0000-4000-8000-000000000001","issuerPrefix":"460068200","extension":0,"fromSerial":1500,"toSerial":3499}"""
    private val block1 = """{"id":"b1000000-0000-4000-8000-000000000002","issuerPrefix":"460068200","extension":1,"fromSerial":40,"toSerial":239}"""

    @Test
    fun theListLandsInTheMirrorAndAnEntryGivesTheShiftItsTemplatesPrefixAndBlocks() = runTest {
        val script = Script(
            gets = mapOf("/v1/device/shifts" to fixture("device-shifts.json")),
            posts = mutableMapOf(
                "/v1/device/shifts/$id/enter" to ArrayDeque(listOf(ok(fixture("device-shift-entered-pallets.json")))),
                "/v1/device/sscc/blocks" to ArrayDeque(listOf(ok(block0), ok(block1))),
            ),
        )
        val repository = repository(script)
        assertTrue(repository.refreshList())
        assertEquals(setOf("OCT26-004", "OCT26-005/S"), db.shiftDao().all().map { it.number }.toSet())

        assertEquals(EnterResult.Ok, repository.enter(id))
        val shift = db.shiftDao().get(id)!!
        assertNotNull(shift.enteredAt)
        assertEquals("460068200", shift.ssccIssuerPrefix)
        assertEquals("04600682000013", shift.productGtin14)
        assertTrue(shift.boxLabelTemplate!!.contains("\"widthMm\":58"))
        assertTrue(shift.palletLabelTemplateSpec!!.contains("qty.boxes"))
        assertEquals(40, shift.palletBoxCapacity)
        assertEquals(id, db.deviceConfigDao().get()!!.activeShiftId)
        // Both serial streams are in the pool, with the host's block ids.
        assertEquals(1500L, db.ssccPoolDao().lowestWithRoom("460068200", 0)!!.nextSerial)
        assertEquals("b1000000-0000-4000-8000-000000000002", db.ssccPoolDao().lowestWithRoom("460068200", 1)!!.blockId)
    }

    @Test
    fun aShiftTheHostCallsClosedOrForOtherVersionsIsReportedAsThePeopleAlreadyRead() = runTest {
        val closed = HostResult.Ok(409, """{"error":{"code":"conflict","message":"m","details":{"constraint":"shift_status","status":"closed"}}}""", null)
        val update = HostResult.Ok(409, """{"error":{"code":"conflict","message":"m","details":{"constraint":"station_update"}}}""", null)
        assertEquals(EnterResult.Closed, repository(Script(emptyMap(), mutableMapOf("/v1/device/shifts/$id/enter" to ArrayDeque(listOf(closed))))).enter(id))
        assertEquals(EnterResult.UpdateRequired, repository(Script(emptyMap(), mutableMapOf("/v1/device/shifts/$id/enter" to ArrayDeque(listOf(update))))).enter(id))
    }
}
```

`feature/hub/HubTilesTest.kt`:

```kotlin
package app.markiro.handheld.feature.hub

import org.junit.Assert.assertEquals
import org.junit.Test

class HubTilesTest {
    @Test
    fun theCloudsHubKeepsAllFiveTilesAndAHostsHubDropsInventoryAndWriteoff() {
        assertEquals(
            listOf(HubTile.SHIFT, HubTile.INVENTORY, HubTile.WRITEOFF, HubTile.PALLETS, HubTile.SETTINGS),
            visibleTiles(hostMode = false),
        )
        assertEquals(listOf(HubTile.SHIFT, HubTile.PALLETS, HubTile.SETTINGS), visibleTiles(hostMode = true))
    }
}
```

Run: `$GR :app:testDebugUnitTest --tests 'app.markiro.handheld.core.backend.HostBackendShiftsTest' --tests 'app.markiro.handheld.feature.shift.ShiftRepositoryHostTest' --tests 'app.markiro.handheld.feature.hub.HubTilesTest'`
Expected: ошибка компиляции (`HostCalls`, `visibleTiles`, расширенный `HostBackend` не определены).

- [ ] **Step 2: перевод отказов.** `core/host/HostCalls.kt` и `HostRevocation.kt`:

```kotlin
package app.markiro.handheld.core.host

import app.markiro.handheld.core.network.host.HostApiError
import app.markiro.handheld.core.network.host.HostFailure
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import retrofit2.HttpException
import retrofit2.Response
import java.io.IOException

/**
 * Where a refusal of the host becomes what the app's loaders already read from the cloud: `IOException` for «нет связи» (a shift whose bundle is
 * on the device is then entered offline), `HttpException` with the cloud's own code for a refusal they show. A rejected key revokes this device
 * once (`revocation`), as the cloud's `RevocationInterceptor` does.
 */
class HostCalls(private val revocation: suspend () -> Unit) {
    suspend fun <T> run(block: suspend () -> Result<T>): T = block().getOrElse { throw translate(it) }

    private suspend fun translate(error: Throwable): Throwable {
        val failure = (error as? HostApiError)?.failure ?: return IOException("host call failed", error)
        return when (failure) {
            HostFailure.KeyRejected -> {
                revocation()
                IOException("the host rejected this device's key")
            }
            is HostFailure.Constraint -> http(
                409,
                when (failure.name) {
                    "station_update" -> "STATION_UPDATE_REQUIRED"
                    "shift_status" -> null // the cloud's closed shift is a `409` with no code
                    else -> failure.name
                },
            )
            HostFailure.LicenseRestricted -> http(409, "license_restricted")
            HostFailure.FeatureDisabled -> http(409, "feature_disabled")
            HostFailure.SeatLimit -> http(409, "seat_limit")
            HostFailure.Forbidden -> http(403, "forbidden")
            HostFailure.ProtocolUnsupported -> http(409, "STATION_UPDATE_REQUIRED")
            HostFailure.Unreachable, HostFailure.Timeout, HostFailure.CertificateMismatch, HostFailure.BadResponse,
            is HostFailure.RestorePending, is HostFailure.ServerError,
            -> IOException("the host did not give its answer: $failure", error)
            HostFailure.PairingInvalid, HostFailure.PairingExpired, HostFailure.RateLimited -> IOException("unexpected on this call: $failure", error)
        }
    }

    private fun http(status: Int, code: String?): HttpException {
        val body = (if (code == null) "{}" else """{"code":"$code"}""").toResponseBody("application/json".toMediaType())
        return HttpException(Response.error<Any>(status, body))
    }
}
```

```kotlin
package app.markiro.handheld.core.host

import app.markiro.handheld.core.network.RevocationBus
import app.markiro.handheld.core.storage.DeviceRecovery

/** A key the host rejected ends this device's data in the same way a revoked cloud key does: the credential is sealed and the shell goes back to pairing. */
class HostRevocation(private val recovery: DeviceRecovery, private val bus: RevocationBus) {
    suspend fun reject() {
        val token = runCatching { recovery.token() }.getOrNull() ?: return
        if (recovery.reject(token)) bus.raise(token)
    }
}
```

- [ ] **Step 3: бэкенд.** `core/backend/HostBackend.kt` (поверх С5; конструктор `HostBackend(api: () -> HostApi, config: DeviceConfigDao, db: HandheldDatabase, supplier: HostBlockSupplier, calls: HostCalls, reference: HostReferenceSync?, operators: OperatorDao)`;
      в С5 первые два метода уже есть — `operators()` теперь зовёт `reference?.sync()`):

```kotlin
    private val entries = mutableMapOf<String, DeviceShiftDto>()

    override suspend fun shifts(): ShiftListResponse {
        val line = config.get()?.lineName
        return ShiftListResponse(calls.run { api().shifts() }.shifts.map { it.toShiftDto(line) })
    }

    override suspend fun enter(shiftId: String, body: ShiftEntryRequest): ShiftDto {
        val entered = calls.run { api().enter(shiftId) }
        entries[shiftId] = entered
        return entered.toShiftDto(config.get()?.lineName)
    }

    /** The snapshot of the entry just made (or, for a bundle asked alone, the owner's re-entry, which gives the same snapshot) becomes the bundle the loaders read. */
    override suspend fun bundle(shiftId: String): ShiftBundleDto {
        val entered = entries.remove(shiftId) ?: calls.run { api().enter(shiftId) }
        val snapshot = checkNotNull(entered.snapshot) { "an entered shift carries its snapshot" }
        val prefix = snapshot.issuerPrefix
        calls.run { supplier.ensure(prefix, 0) }
        if (entered.palletsEnabled) calls.run { supplier.ensure(prefix, 1) }
        return ShiftBundleDto(
            shift = entered.toShiftDto(config.get()?.lineName),
            product = snapshot.product.toBundleProduct(),
            boxLabelTemplate = snapshot.boxTemplate.toBundleTemplate(),
            palletLabelTemplate = snapshot.palletTemplate?.toBundleTemplate(),
            sscc = heldBlock(prefix, 0),
            palletSscc = if (entered.palletsEnabled) heldBlock(prefix, 1) else null,
        )
    }

    override suspend fun topUpBoxSscc(shiftId: String): BoxSsccTopUpDto {
        val prefix = checkNotNull(db.shiftDao().get(shiftId)?.ssccIssuerPrefix) { "the shift has no issuer prefix" }
        calls.run { supplier.ensure(prefix, 0) }
        return BoxSsccTopUpDto(blocks = db.ssccPoolDao().ranges(prefix, 0).map { it.toBundle() }, revokedFrom = emptyList(), issuerProblem = null)
    }

    override suspend fun hubCounts(): HubCounts {
        val open = shifts().items.count { it.status in setOf("planned", "active") }
        return HubCounts(shifts = open, inventories = 0)
    }

    /** The earliest block of the pool with room, as the bundle carries it: the loader puts the same range into the pool again, which changes nothing. */
    private suspend fun heldBlock(prefix: String, extension: Int): BundleSsccDto? =
        db.ssccPoolDao().lowestWithRoom(prefix, extension)?.toBundle()
```

`core/host/HostShiftMapping.kt`:

```kotlin
package app.markiro.handheld.core.host

import app.markiro.handheld.core.network.BundleLabelTemplateDto
import app.markiro.handheld.core.network.BundleProductDto
import app.markiro.handheld.core.network.BundleSsccDto
import app.markiro.handheld.core.network.ShiftDto
import app.markiro.handheld.core.network.ValidationPrintDto
import app.markiro.handheld.core.network.host.DeviceShiftDto
import app.markiro.handheld.core.storage.SsccRangeEntity
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject

private fun JsonObject.text(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.contentOrNull
private fun JsonObject.number(key: String): Int? = (this[key] as? JsonPrimitive)?.intOrNull

/** A shift of the host as `GET /shifts` of the cloud delivered it. The host never prints a duplicate for a handheld (`station_update` otherwise), so the print policy is `none`. */
fun DeviceShiftDto.toShiftDto(lineName: String?) = ShiftDto(
    id = id,
    number = number,
    status = status,
    mode = mode,
    validationPrint = ValidationPrintDto("none"),
    productId = productId,
    productName = productName,
    productPrintName = snapshot?.product?.text("printName"),
    lineId = lineId,
    lineName = lineName,
    counterpartyName = counterpartyName,
    plannedQty = plannedQty,
    plannedDate = plannedDate ?: productionDate,
    productionDate = productionDate,
    boxCapacity = boxCapacity,
    palletBoxCapacity = if (palletsEnabled) palletBoxCapacity else null,
    palletsEnabled = palletsEnabled,
    openedAt = openedAt,
    closedAt = closedAt,
)

fun JsonObject.toBundleProduct() = BundleProductDto(
    id = checkNotNull(text("id")),
    gtin14 = checkNotNull(text("gtin14")),
    name = checkNotNull(text("name")),
    printName = text("printName"),
    shelfLifeDays = number("shelfLifeDays"),
    egaisCode = text("egaisCode"),
)

fun JsonObject.toBundleTemplate() = BundleLabelTemplateDto(
    id = checkNotNull(text("id")),
    name = checkNotNull(text("name")),
    spec = getValue("spec").jsonObject,
)

fun SsccRangeEntity.toBundle() = BundleSsccDto(
    issuerPrefix = issuerPrefix,
    extensionDigit = extensionDigit,
    fromSerial = fromSerial,
    toSerial = toSerial,
    consumedThroughSerial = (nextSerial - 1).takeIf { it >= fromSerial },
    blockId = blockId,
)
```

`SsccPoolDao`: `@Query("SELECT * FROM sscc_pool WHERE issuerPrefix = :prefix AND extensionDigit = :extension ORDER BY fromSerial") suspend fun ranges(prefix: String, extension: Int): List<SsccRangeEntity>`.
В `HostModule` (Hilt) `HostBackend` собирается с `{ hostApi() }`, `HostCalls { HostRevocation(recovery, bus).reject() }` и общим `HostReferenceSync`.

- [ ] **Step 4: хаб.** `HubScreen.kt`: вынесите перечень видимых плиток —

```kotlin
/** The tiles of the hub: a host has no inventory and no write-off (spec 8.7: hidden by `backend`, not deleted). */
internal fun visibleTiles(hostMode: Boolean): List<HubTile> =
    if (hostMode) listOf(HubTile.SHIFT, HubTile.PALLETS, HubTile.SETTINGS)
    else listOf(HubTile.SHIFT, HubTile.INVENTORY, HubTile.WRITEOFF, HubTile.PALLETS, HubTile.SETTINGS)
```

и в экране перестройте `val tiles = listOf({…}, {…}, …)` в `val byTile: Map<HubTile, @Composable (Modifier) -> Unit> = mapOf(HubTile.SHIFT to { … }, HubTile.INVENTORY to { … }, …)` с теми же телами, затем
`val tiles = visibleTiles(state.hostMode).map { byTile.getValue(it) }`. `HubUi` получает `val hostMode: Boolean = false`; `HubViewModel` выставляет его из `config.backend == "host"` там, где собирает `organization`/`lineName`.
Баннер замены устройства (`state.replacementBlocked`) на хосте не появляется: интент замены приходит только из облака.

- [ ] **Step 5: запустить, увидеть успех.**

  Run: `$GR :app:testDebugUnitTest --tests 'app.markiro.handheld.core.backend.*' --tests 'app.markiro.handheld.feature.shift.*' --tests 'app.markiro.handheld.feature.hub.*' --tests 'app.markiro.handheld.core.host.*'`
  Expected: `BUILD SUCCESSFUL` (`HostBackendShiftsTest` — 6, `ShiftRepositoryHostTest` — 2, `HubTilesTest` — 1; облачные тесты смен и хаба — без правок, кроме разбора `tiles` — их ожидания прежние).

- [ ] **Step 6: Commit.**

```bash
git -C "$WT" add apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/backend apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/host apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/storage apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/hub apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/backend apps/handheld/app/src/test/kotlin/app/markiro/handheld/feature
git -C "$WT" commit -m "feat(handheld): shifts on the host — list, entry with the snapshot, blocks, hub without cloud tiles

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

## Task Д2: факты на хост — заморозка записей и `HostSyncEngine`

**Files:**

- Create: `core/host/HostRecordFreezer.kt`, `core/host/HostSyncEngine.kt`, `core/host/HostAckMapper.kt`, `core/sync/SyncDriver.kt`
- Modify: `core/sync/SyncEngine.kt` (реализует `SyncDriver`), шесть потребителей `SyncEngine` (`ShiftCloser`, `ScanRepository`, `BoxRepository`, `PalletRepository`, `SyncWorker`, `HubViewModel`) — зависят от `SyncDriver`; `core/host/HostModule.kt` (выбор по `BackendSelector`)
- Test: `core/host/HostRecordFreezerTest.kt`, `core/host/HostSyncEngineTest.kt`

**Interfaces:**

- Consumes: С2 (`HostApi.postFacts`, `FactReceiptDto`), С3 (`HostOutboxDao`, `HostOutboxEntity`), С1 (`HostReceiptCode.hintOf`, `BoxDigest`, `Iso.isDeviceInstant`), фикстуры `facts-batch.json`, `fact-receipts.json`.
- Produces: `interface SyncDriver { suspend fun drain(): DrainResult; fun kick() }` — то, что шесть потребителей уже звали у `SyncEngine`; `HostRecordFreezer.freezeAll()` (запись → строка `host_outbox`, одна запись одной строки); `HostSyncEngine.drain()`.

Решения:

- Заморозка, а не пересчёт: тело записи собирается один раз, в момент заморозки, и дальше уходит байт в байт (повтор после обрыва — тот же `id` и тот же дайджест, иначе хост ответил бы `payload_mismatch`).
- Порядок: записи одной смены уходят в порядке `seq`; записи, замороженные одним проходом, сливаются по времени устройства (скан раньше короба, который он закрывает).
- Ответ хоста: `accepted`/`conflict` — строка `host_outbox` и источник подтверждены; `rejected` с `box_on_pallet` — источник отклонён и запись реестра коробов снята (Д3); любой другой отказ — карантин с причиной (не блокирует остальные); 5xx, `IOException`, `503 restore_pending` — повтор с отступом, очередь не теряется; `401` — отзыв устройства.

- [ ] **Step 1: падающие тесты.**

`HostRecordFreezerTest.kt`:

```kotlin
package app.markiro.handheld.core.host

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.ScanEntityFixtures
import app.markiro.handheld.core.box.Iso
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class HostRecordFreezerTest {
    private lateinit var db: HandheldDatabase

    @Before
    fun open() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
    }

    @After
    fun close() = db.close()

    @Test
    fun aScanBecomesOneFactWithItsOwnIdAndTheDeviceInstantTheHostAccepts() = runTest {
        db.scanDao().insert(ScanEntityFixtures.accepted(id = "11111111-1111-4111-8111-111111111111", shiftId = "s1", scannedAt = "2026-10-15T08:00:01.250Z"))
        val freezer = HostRecordFreezer(db, clock = { "2026-10-15T08:00:05.000Z" })
        assertEquals(1, freezer.freezeAll())
        assertEquals(0, freezer.freezeAll()) // the second pass makes nothing again
        val row = db.hostOutboxDao().queued(10).single()
        assertEquals("facts", row.target)
        assertEquals("11111111-1111-4111-8111-111111111111", row.recordId)
        val fact = Json.parseToJsonElement(row.body).jsonObject
        assertEquals("scan", fact.getValue("kind").jsonPrimitive.content)
        assertTrue(Iso.isDeviceInstant(fact.getValue("deviceAt").jsonPrimitive.content))
    }

    @Test
    fun aClosedBoxCarriesTheDigestOfItsCodesAndTheBlockSerialItWasMintedFrom() = runTest {
        ScanEntityFixtures.boxWithScans(db, boxId = "22222222-2222-4222-8222-222222222222", shiftId = "s1", sscc = "046006820000015003", hashes = listOf("b", "a", "c"))
        HostRecordFreezer(db, clock = { "2026-10-15T08:10:00.000Z" }).freezeAll()
        val box = db.hostOutboxDao().queued(10).first { it.kind == "box_closed" }
        val fact = Json.parseToJsonElement(box.body).jsonObject
        assertEquals(app.markiro.handheld.core.box.BoxDigest.of(listOf("b", "a", "c")), fact.getValue("digest").jsonPrimitive.content)
        assertEquals(1500L, fact.getValue("serial").jsonPrimitive.content.toLong())
        assertEquals(3, fact.getValue("scanIds").jsonArray.size)
    }

    @Test
    fun theTimeOfTheDeviceOrdersTheRecordsOfOnePass() = runTest {
        ScanEntityFixtures.boxWithScans(db, boxId = "33333333-3333-4333-8333-333333333333", shiftId = "s1", sscc = "046006820000015010", hashes = listOf("x"))
        HostRecordFreezer(db, clock = { "2026-10-15T09:00:00.000Z" }).freezeAll()
        assertEquals(listOf("scan", "box_closed"), db.hostOutboxDao().queued(10).map { it.kind })
    }
}
```

`HostSyncEngineTest.kt`:

```kotlin
package app.markiro.handheld.core.host

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.network.host.HostApi
import app.markiro.handheld.core.network.host.HostResult
import app.markiro.handheld.core.network.host.HostTransport
import app.markiro.handheld.core.network.host.TransportFailure
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.HostOutboxEntity
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class HostSyncEngineTest {
    private lateinit var db: HandheldDatabase

    @Before
    fun open() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
    }

    @After
    fun close() = db.close()

    private class Post(var answer: HostResult) : HostTransport {
        var bodies = mutableListOf<String>()
        override suspend fun get(path: String) = error("no GET")
        override suspend fun post(path: String, body: String): HostResult {
            bodies += body
            return answer
        }
    }

    private suspend fun queue(vararg ids: String) = ids.forEachIndexed { i, id ->
        db.hostOutboxDao().insert(HostOutboxEntity(recordId = id, target = "facts", kind = "scan", sourceKind = "scan", sourceKey = id, body = """{"id":"$id","kind":"scan"}""", state = "queued", reason = null, createdAt = "2026-10-15T08:00:0${i}Z"))
    }

    private fun receipts(vararg r: String) = HostResult.Ok(200, """{"receipts":[${r.joinToString(",")}]}""", null)

    private fun engine(post: Post, revoked: () -> Unit = {}) =
        HostSyncEngine(db, { HostApi(post) }, HostAckMapper(db), HostCalls { revoked() })

    @Test
    fun acceptedAndConflictLeaveTheQueueOthersRejectedGoToQuarantineWithTheHostsReason() = runTest {
        queue("a", "b", "c")
        val post = Post(
            receipts(
                """{"id":"a","outcome":"accepted"}""",
                """{"id":"b","outcome":"conflict","code":"device_duplicate"}""",
                """{"id":"c","outcome":"rejected","code":"shift_closed"}""",
            ),
        )
        engine(post).drain()
        assertEquals(0, db.hostOutboxDao().queuedCount())
        assertEquals(listOf("c"), db.hostOutboxDao().quarantined().map { it.recordId })
        assertEquals("shift_closed", db.hostOutboxDao().quarantined().single().reason)
    }

    @Test
    fun anUnreachableHostKeepsEveryRecordAndTheSameBodiesGoAgain() = runTest {
        queue("a", "b")
        val post = Post(HostResult.Failed(TransportFailure.UNREACHABLE))
        engine(post).drain()
        assertEquals(2, db.hostOutboxDao().queuedCount())
        post.answer = receipts("""{"id":"a","outcome":"accepted"}""", """{"id":"b","outcome":"accepted"}""")
        engine(post).drain()
        assertEquals(0, db.hostOutboxDao().queuedCount())
        assertEquals(post.bodies[0], post.bodies[1]) // byte for byte
    }

    @Test
    fun aRestoreInProgressIsARetryNotAQuarantine() = runTest {
        queue("a")
        engine(Post(HostResult.Ok(503, """{"error":{"code":"restore_pending","message":"m","details":{}}}""", "30"))).drain()
        assertEquals(1, db.hostOutboxDao().queuedCount())
        assertEquals(0, db.hostOutboxDao().quarantinedCount())
    }

    @Test
    fun aRejectedKeyRevokesAndKeepsTheQueueForSupport() = runTest {
        queue("a")
        var revoked = 0
        engine(Post(HostResult.Ok(401, """{"error":{"code":"unauthorized","message":"m","details":{"credential":"device"}}}""", null)), { revoked++ }).drain()
        assertEquals(1, revoked)
        assertEquals(1, db.hostOutboxDao().queuedCount())
    }

    @Test
    fun aBatchIsAtMostTheHostsLimitAndTheRestGoesInTheNextPass() = runTest {
        queue(*(1..150).map { "r$it" }.toTypedArray())
        val post = Post(receipts())
        engine(post).drain()
        assertEquals(true, post.bodies.size >= 2)
    }
}
```

Run: `$GR :app:testDebugUnitTest --tests 'app.markiro.handheld.core.host.HostRecordFreezerTest' --tests 'app.markiro.handheld.core.host.HostSyncEngineTest'`
Expected: ошибка компиляции (`HostRecordFreezer`, `HostSyncEngine`, `HostAckMapper` не определены).

- [ ] **Step 2: шов `SyncDriver`.** `core/sync/SyncDriver.kt`:

```kotlin
package app.markiro.handheld.core.sync

/** What the six consumers of the cloud `SyncEngine` need from it; `HostSyncEngine` is the other implementation, picked by `BackendSelector`. */
interface SyncDriver {
    suspend fun drain(): DrainResult
    fun kick()
}
```

`SyncEngine : SyncDriver` (`override` на существующих `drain`/`kick`, поведение не меняется); шесть потребителей принимают `SyncDriver`, Hilt отдаёт `BackendSelector`-зависимую реализацию:

```kotlin
@Provides @Singleton fun syncDriver(selector: BackendSelector, cloud: SyncEngine, host: HostSyncEngine): SyncDriver =
    object : SyncDriver {
        override suspend fun drain() = if (selector.kindNow() == BackendKind.HOST) host.drain() else cloud.drain()
        override fun kick() = if (selector.kindNow() == BackendKind.HOST) host.kick() else cloud.kick()
    }
```

- [ ] **Step 3: заморозка.** `HostRecordFreezer.freezeAll()` обходит источники в одной транзакции Room и для каждой не замороженной строки (`host_outbox.sourceKind/sourceKey` ещё нет) вставляет `HostOutboxEntity`:
      скан → `{id, kind:"scan", shiftId, deviceAt, raw, rawKind (ScanRawKind.classify), verdict…}`; закрытый короб → `{id, kind:"box_closed", shiftId, sscc, blockId, serial (Sscc.serialOf), digest (BoxDigest.of(hashes)), scanIds, deviceAt}`;
      закрытая паллета смены → `kind:"pallet_closed"`; закрытие смены из `ShiftCloseEntity` → `kind:"shift_closed"`. `deviceAt` — время устройства (`Iso.isDeviceInstant` проверяется перед вставкой; нечитаемое время даёт карантин с причиной `bad_device_time`, а не молчаливую подмену).
      Записи одного прохода сортируются по `deviceAt`, затем по виду (`scan` < `box_closed` < `pallet_closed` < `shift_closed`); вставка с `OnConflictStrategy.IGNORE` и уникальным индексом делает проход идемпотентным.

- [ ] **Step 4: движок.** `HostSyncEngine.drain()`: `freezer.freezeAll()`; пока есть строки `target = "facts"` — берёт до 100 (`queued(100)`), шлёт `api.postFacts("""{"facts":[…bodies…]}""")` (тела собираются конкатенацией сохранённых строк, не пересериализацией), разбирает `FactReceiptDto` через `HostAckMapper`:

```kotlin
class HostAckMapper(private val db: HandheldDatabase) {
    suspend fun apply(sent: List<HostOutboxEntity>, receipts: List<FactReceiptDto>) {
        val byId = receipts.associateBy { it.id }
        for (row in sent) {
            val receipt = byId[row.recordId] ?: continue // no receipt: stays queued, the next pass repeats it
            when (receipt.outcome) {
                "accepted", "conflict" -> {
                    db.hostOutboxDao().delete(row.recordId)
                    acknowledgeSource(row)
                }
                "rejected" -> when (HostReceiptCode.hintOf(receipt.code)) {
                    RejectionHint.RELEASE -> { // box_on_pallet: the box is already on another pallet (Д3)
                        db.hostOutboxDao().delete(row.recordId)
                        rejectSource(row, receipt.code)
                    }
                    else -> db.hostOutboxDao().quarantine(row.recordId, receipt.code ?: "rejected")
                }
            }
        }
    }
}
```

Ошибки: `HostCalls.run` бросает `IOException` (повтор — `drain()` возвращает `DrainResult.Retry(backoff)`, как у облачного движка) либо `HttpException` (карантин всей пачки не делается: `409` по смене разбирает отдельная ветка, `payload_mismatch` — карантин записи).

- [ ] **Step 5: запустить, увидеть успех.**

  Run: `$GR :app:testDebugUnitTest --tests 'app.markiro.handheld.core.host.*' --tests 'app.markiro.handheld.core.sync.*' --tests 'app.markiro.handheld.feature.shift.*'`
  Expected: `BUILD SUCCESSFUL` (новых 8; облачные тесты синхронизации не менялись).

- [ ] **Step 6: Commit.**

```bash
git -C "$WT" add apps/handheld/app/src/main/kotlin/app/markiro/handheld/core apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature apps/handheld/app/src/test/kotlin/app/markiro/handheld/core
git -C "$WT" commit -m "feat(handheld): facts to the host — frozen records and HostSyncEngine behind the SyncDriver seam

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

## Task Д3: складские паллеты на хосте — события паллет, реестр коробов, бренд печати

**Files:**

- Create: `core/host/HostPalletEvents.kt` (заморозка `pallet_open`/`box_added`/`box_removed`/`pallet_closed` из `PalletEntity(kind=warehouse)` и членств), `core/host/HostBoxRegistry.kt` (дельта реестра в `box_registry` Room), `core/host/HostOrgPrint.kt`
- Modify: `core/backend/HostBackend.kt` (`palletBootstrap`, `boxRegistry`), `core/host/HostAckMapper.kt` (цель `events`), `core/host/HostSyncEngine.kt` (вторая очередь `events`), `core/storage/BoxRegistryDao.kt` (`release`)
- Test: `core/host/HostPalletEventsTest.kt`, `core/host/HostBoxRegistryTest.kt`, `core/host/HostPalletConflictTest.kt`

**Interfaces:**

- Consumes: Х3/Х4/Х5 (`POST /v1/device/pallet-events`, `GET /v1/device/box-registry`, `GET /v1/device/org/print`), С2 (`HostApi.postPalletEvents/boxRegistry/orgPrint`), С3 (`StationBackend.palletBootstrap/boxRegistry`), фикстуры `pallet-events-batch.json`, `box-registry-page.json`, `org-print.json`.
- Produces: события склада уходят отдельным каналом; `box_on_pallet` снимает коробку с локальной паллеты и показывает конфликт; реестр коробов догоняет хост курсором `changed_at|sscc` (окно перекрытия 1 с); бренд печати (логотип, полное название) приходит в `palletBootstrap`.

Решения:

- События паллеты — не факты смены: свой `device_event_receipts`, своя очередь `target = "events"`; идемпотентность по `(устройство, id)` и SHA-256 дайджесту уже на хосте.
- Дельта реестра: сначала запрос без `cursor` с `since` = последняя отметка, затем страницы по `cursor`, пока `nextCursor` не `null`; отметка двигается только после последней страницы (прерванная догрузка повторяется без потерь, строки `INSERT OR REPLACE`).
- `box_on_pallet` в квитанции события: членство помечается отклонённым, запись реестра для этой коробки снимается (`release`), экран паллеты показывает «Короб уже на паллете …» (Д4) — работа смены не блокируется.

- [ ] **Step 1: падающие тесты** (структура как в Д2; ключевые проверки):

```kotlin
@Test
fun aWarehousePalletsFirstBoxMakesOpenAndAddEventsInOrderWithStableIds() = runTest {
    PalletFixtures.warehousePalletWithBoxes(db, palletId = "p1", sscc = "046006820100000041", boxes = listOf("b1", "b2"))
    HostPalletEvents(db, clock = { "2026-10-15T10:00:00.000Z" }).freeze()
    val kinds = db.hostOutboxDao().queued(10).filter { it.target == "events" }.map { it.kind }
    assertEquals(listOf("pallet_open", "box_added", "box_added"), kinds)
    // Freezing again changes nothing: ids are derived from the pallet and the box, not generated anew.
    HostPalletEvents(db, clock = { "2026-10-15T10:05:00.000Z" }).freeze()
    assertEquals(3, db.hostOutboxDao().queued(10).count { it.target == "events" })
}

@Test
fun aRegistryDeltaPagedByCursorFillsTheLocalRegistryAndMovesTheMarkOnlyAfterTheLastPage() = runTest {
    val page1 = fixture("box-registry-page.json")
    val transport = Pages(page1, last = """{"boxes":[],"nextCursor":null,"until":"2026-10-15T11:00:00.000Z"}""")
    val registry = HostBoxRegistry(db, MetaStore(db), HostApi(transport))
    registry.catchUp()
    assertTrue(db.boxRegistryDao().count() > 0)
    assertEquals("2026-10-15T11:00:00.000Z", MetaStore(db).get("host.registry.since"))
    // A page that fails keeps the old mark.
    val failing = HostBoxRegistry(db, MetaStore(db), HostApi(Pages(page1, last = null)))
    runCatching { failing.catchUp() }
    assertEquals("2026-10-15T11:00:00.000Z", MetaStore(db).get("host.registry.since"))
}

@Test
fun boxOnPalletReleasesTheBoxLocallyAndRejectsTheMembershipWithoutStoppingTheQueue() = runTest {
    PalletFixtures.warehousePalletWithBoxes(db, palletId = "p1", sscc = "046006820100000041", boxes = listOf("b1", "b2"))
    HostPalletEvents(db, clock = { "2026-10-15T10:00:00.000Z" }).freeze()
    val events = db.hostOutboxDao().queued(10).filter { it.target == "events" }
    val ids = events.map { it.recordId }
    val receipts = """{"receipts":[{"id":"${ids[0]}","outcome":"accepted"},{"id":"${ids[1]}","outcome":"rejected","code":"box_on_pallet"},{"id":"${ids[2]}","outcome":"accepted"}]}"""
    HostAckMapper(db).apply(events, Json.decodeFromString<FactReceiptsDto>(receipts).receipts)
    assertEquals(PalletMembershipState.REJECTED, db.palletMembershipDao().state("p1", "b1"))
    assertEquals(PalletMembershipState.ACCEPTED, db.palletMembershipDao().state("p1", "b2"))
    assertNull(db.boxRegistryDao().get("b1"))
    assertEquals(0, db.hostOutboxDao().quarantinedCount())
}
```

Run: `$GR :app:testDebugUnitTest --tests 'app.markiro.handheld.core.host.HostPalletEventsTest' --tests 'app.markiro.handheld.core.host.HostBoxRegistryTest' --tests 'app.markiro.handheld.core.host.HostPalletConflictTest'`
Expected: ошибка компиляции (`HostPalletEvents`, `HostBoxRegistry` не определены).

- [ ] **Step 2: реализация.** `HostPalletEvents.freeze()` строит записи из `PalletEntity(kind = "warehouse")` и таблицы членств (`PalletMembershipEntity`): `pallet_open` — по первой коробке паллеты; `box_added` / `box_removed` — по членству и снятию (id события = `UUIDv5(palletId + ":" + boxId + ":" + kind + ":" + n)`, где `n` — номер появления пары, чтобы «снять, поставить снова» давало разные события);
      `pallet_closed` — по закрытию. Общий порядок — по времени устройства. Если устройство открывает новую паллету, а прежняя открыта и пуста — `pallet_deleted` не шлётся, хост сам удаляет пустой черновик (Х3); непустая открытая паллета при открытии новой даёт `pallet_state`-отказ хоста, который экран паллеты показывает как «Закройте открытую паллету».
      `HostBoxRegistry.catchUp()` — как описано в решениях, окно перекрытия 1 с вычитается из `since` при следующем запросе. `HostBackend.palletBootstrap()` возвращает шаблоны паллеты и бренд из `HostOrgPrint.fetch()` (кэш в `MetaStore`, обновление при каждом входе в смену); `HostBackend.boxRegistry(...)` прокидывает `HostApi.boxRegistry` в `BoxRegistryPageDto`.
      `HostSyncEngine.drain()` обходит обе цели: сначала `facts`, затем `events` (события паллеты ссылаются на короба, закрытые фактами).

- [ ] **Step 3: запустить, увидеть успех.**

  Run: `$GR :app:testDebugUnitTest --tests 'app.markiro.handheld.core.host.*' --tests 'app.markiro.handheld.feature.pallets.*' --tests 'app.markiro.handheld.core.pallets.*'`
  Expected: `BUILD SUCCESSFUL` (новых 6+, облачные паллетные тесты без правок).

- [ ] **Step 4: Commit.**

```bash
git -C "$WT" add apps/handheld/app/src/main/kotlin/app/markiro/handheld/core apps/handheld/app/src/test/kotlin/app/markiro/handheld/core
git -C "$WT" commit -m "feat(handheld): warehouse pallets on the host — pallet events, box registry delta, print branding, box_on_pallet

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

## Task Д4: очередь, конфликты и состояние связи с хостом на экранах

**Files:**

- Modify: `feature/settings/QueueScreen.kt`, `feature/settings/QueueViewModel.kt`, `feature/hub/HubScreen.kt` (строка связи), `feature/pallets/PalletScreen.kt` (баннер конфликта), `res/values/strings.xml`, `res/values-en/strings.xml`
- Create: `feature/settings/HostQueueSource.kt` (строки очереди из `host_outbox`), `core/host/HostLinkState.kt` (состояния для UI)
- Test: `feature/settings/HostQueueViewModelTest.kt`, `feature/hub/HostLinkStateTest.kt`, `feature/pallets/PalletConflictBannerTest.kt`

**Interfaces:**

- Consumes: Д2 (`host_outbox`, карантин с причиной), Д3 (членство `REJECTED`), С5 (`HostLinkMonitor` с эпохой восстановления и перекосом часов).
- Produces: экран «Очередь» в режиме `host` показывает ожидающие и карантинные записи хоста с причиной на языке оператора (`HostReceiptCode.hintOf`), кнопки «Отправить сейчас» и «Передать в поддержку» (экспорт тела записи в файл); строка связи хаба: «Хост на связи», «Нет связи — работа продолжается», «Хост восстанавливается из копии», «Часы устройства расходятся с хостом»; баннер конфликта паллеты.

- [ ] **Step 1: падающие тесты.**

```kotlin
class HostLinkStateTest {
    @Test
    fun theStateFollowsTheMonitorAndNeverStopsTheLine() {
        assertEquals(HostLinkState.Online, HostLinkState.of(reachable = true, restoring = false, skewSeconds = 3))
        assertEquals(HostLinkState.Offline, HostLinkState.of(reachable = false, restoring = false, skewSeconds = 0))
        assertEquals(HostLinkState.Restoring, HostLinkState.of(reachable = true, restoring = true, skewSeconds = 0))
        assertEquals(HostLinkState.ClockSkew, HostLinkState.of(reachable = true, restoring = false, skewSeconds = 121))
        // Every state keeps scanning allowed.
        assertTrue(HostLinkState.entries.all { it.scanningAllowed })
    }
}
```

`HostQueueViewModelTest`: строки `queued` и `quarantined` из `host_outbox` попадают в `QueueUi.items` с локализованной причиной (`shift_closed` → «Смена закрыта на хосте»), «Отправить сейчас» вызывает `SyncDriver.kick()`, «Передать в поддержку» выдаёт тело записи для экспорта без секретов (ключ устройства в тело записи не попадает).
`PalletConflictBannerTest`: паллета с отклонённым членством показывает «Короб … уже на паллете …» и не блокирует добавление следующего короба.

Run: `$GR :app:testDebugUnitTest --tests 'app.markiro.handheld.feature.settings.HostQueueViewModelTest' --tests 'app.markiro.handheld.feature.hub.HostLinkStateTest' --tests 'app.markiro.handheld.feature.pallets.PalletConflictBannerTest'`
Expected: ошибка компиляции (`HostLinkState`, `HostQueueSource` не определены).

- [ ] **Step 2: реализация.** `HostLinkState` — enum с `scanningAllowed = true` для всех значений и `of(...)`; строки ресурсов добавляются парой (RU в `values/`, EN в `values-en/`) для каждого состояния и каждой подсказки отказа из `HostReceiptCode.ALL`; тест `StringsParityTest` (уже в репозитории) ловит пропуск перевода. Хаб показывает состояние текстом и значком (не только цветом).

- [ ] **Step 3: запустить, увидеть успех.**

  Run: `$GR :app:testDebugUnitTest --tests 'app.markiro.handheld.feature.*'`
  Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 4: Commit.**

```bash
git -C "$WT" add apps/handheld/app/src
git -C "$WT" commit -m "feat(handheld): host queue, conflict and link-state screens

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

## Task Д5: ручная проверка на железе, README, CHANGELOG, итоговые ворота

**Files:**

- Create: `docs/runbooks/standalone-handheld-checklist.md`
- Modify: `apps/handheld/README.md`, `apps/handheld/CHANGELOG.md`, `apps/handheld/AGENTS.md` (раздел «Режим host»), `docs/standalone/ROADMAP.md`

- [ ] **Step 1: чек-лист** `docs/runbooks/standalone-handheld-checklist.md` — таблица «шаг / ожидание / результат (заполняется на устройстве)»; результаты в ней остаются пустыми, пока шаг не выполнен на железе:
  1. Android 9 (API 28): сопряжение по IP и коду; подтверждение отпечатка; работа TLS 1.2 с ECDSA P-256 (`MODERN_TLS`), нет ли отказа рукопожатия — **единственный способ закрыть непроверенный пункт спецификации о TLS на Android 9**; повторить на Android 11+.
  2. Сопряжение DataMatrix с экрана офиса, ввод кода руками, истёкший и повторно использованный код.
  3. Смена: список, вход, печать коробов на сетевой принтер, закрытие; обрыв сети на середине смены и догрузка очереди.
  4. Складская паллета: добавление коробов, `box_on_pallet` со второго ТСД, закрытие, печать этикетки паллеты с брендом.
  5. Замена адреса хоста (DHCP) — устройство находит хост по сохранённым адресам; смена сертификата хоста — отказ с понятным сообщением и повторное сопряжение (`recoverDeviceId`).
  6. Восстановление хоста из копии: устройство видит «Хост восстанавливается», работа продолжается, очередь уходит после.
  7. Облачный режим на том же APK не затронут (сопряжение с облаком, смена, инвентаризация).

- [ ] **Step 2: документы.** `CHANGELOG.md` — запись «Режим host (Автоном)» в разделе «Не выпущено»; `README.md` — абзац о двух режимах и ссылка на чек-лист; `AGENTS.md` — раздел «Режим host» (шов `StationBackend`, закреплённый сертификат, запрет HTTP, `host_outbox`, что выключено); `ROADMAP.md` — отметка потока С+Д как исполненного кодом, но не проверенного на железе.

- [ ] **Step 3: итоговые ворота.**

  Run: `$GR testDebugUnitTest lintDebug assembleDebug` и затем `pnpm --filter @markiro/standalone exec vitest run test/handheld` и `pnpm test:production-bundle:contract` (трогаются только документы и фикстуры Kotlin; если CI-правило `handheld_android` в `tools/ci/affected.mjs` уже добавлено потоком П, контракт его проверяет).
  Expected: `BUILD SUCCESSFUL`; `Tests ... passed`. Эмулятор и реальные ТСД не запускались: пункты чек-листа без отметок не считаются проверенными, и итоговый отчёт исполнителя обязан перечислить их.

- [ ] **Step 4: Commit.**

```bash
git -C "$WT" add docs/runbooks/standalone-handheld-checklist.md apps/handheld/README.md apps/handheld/CHANGELOG.md apps/handheld/AGENTS.md docs/standalone/ROADMAP.md
git -C "$WT" commit -m "docs(handheld): host-mode hardware checklist, README, CHANGELOG, scoped guide

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

## Task Д6 (набросок, отдельный план): шаг 1б — дубликат DataMatrix и исключения коробов/паллет

Не входит в этот план. Состав: печать дубликата DataMatrix с ТСД через хост (`validation-dm-duplicate-v1`), исключения по коробам и паллетам (снятие, замена), «Проверка кода». Предпосылки: Д1–Д3 в main и пройденный чек-лист Д5. До этого плана `validationPrint.mode` в режиме host всегда `none`, а смена, которой нужен дубликат, отвечает `STATION_UPDATE_REQUIRED` (Д1).

## Отклонения при исполнении

Пусто до начала исполнения. Исполнитель записывает сюда каждое расхождение плана с кодом (имя, сигнатуру, поведение), которое он обнаружил, с коммитом, в котором оно исправлено, — как в планах `2026-10-13-standalone-*`.
