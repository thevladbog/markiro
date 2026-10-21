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
    @Test fun oldAndReplacedHelloCarryIndependentOptionalDatasetEpochs() {
        val json = Json { ignoreUnknownKeys = true }
        val legacy = json.decodeFromJsonElement(HelloDto.serializer(), fixture("hello.json"))
        val replaced = json.decodeFromJsonElement(HelloDto.serializer(), fixture("hello-replaced.json"))
        assertNull(legacy.datasetEpoch)
        assertNull(replaced.restoreEpoch)
        assertEquals("8b134f46-5501-4ba2-931e-fde1e7251951", replaced.datasetEpoch)
    }

    @Test
    fun aSharedShiftsParticipantsTotalsAndEachDevicesPartAreReadAndAddUp() {
        val json = Json { ignoreUnknownKeys = true }
        val shifts = json.decodeFromJsonElement(DeviceShiftsDto.serializer(), fixture("device-shifts-participants.json")).shifts
        // An active shift with its figures and a closed one without them (the list carries totals for active shifts only).
        assertEquals(listOf("active", "closed"), shifts.map { it.status })
        val shift = shifts.first { it.status == "active" }
        assertEquals(2, shift.maxStations)
        assertEquals("active", shift.myState)
        val participants = checkNotNull(shift.participants)
        val byDevice = checkNotNull(shift.byDevice)
        val totals = checkNotNull(shift.totals)
        assertEquals(listOf("active", "closed"), participants.map { it.state })
        assertEquals(listOf("station", "handheld"), participants.map { it.deviceKind })
        assertEquals("device", participants[1].closedBy)
        assertEquals(120, participants[1].closedActualQty)
        assertEquals("2026-10-08T09:05:00Z", participants[1].lateDataAt)
        // byDevice lists every participant in participants order and adds up to the shift's total.
        assertEquals(participants.map { it.deviceId }, byDevice.map { it.deviceId })
        assertEquals(totals.accepted, byDevice.sumOf { it.accepted })
        assertEquals(45, totals.boxesClosed)
        assertEquals("2026-10-08T09:41:07Z", totals.asOf)
        // Each participant's leave token (`joinedRev`), the revision of the write that took its slot.
        assertEquals(listOf(12L, 15L), participants.map { it.joinedRev })
    }

    @Test
    fun aClosedShiftInTheListKeepsItsParticipantsAndStateButCarriesNoFigures() {
        val json = Json { ignoreUnknownKeys = true }
        val closed = json.decodeFromJsonElement(DeviceShiftsDto.serializer(), fixture("device-shifts-participants.json"))
            .shifts.first { it.status == "closed" }
        assertEquals(2, closed.maxStations)
        assertEquals("closed", closed.myState)
        assertEquals(listOf("closed"), checkNotNull(closed.participants).map { it.state })
        assertNull(closed.totals)
        assertNull(closed.byDevice)
        // A host row without the token (an older host) reads as `null`, never as 0.
        assertNull(closed.participants!!.single().joinedRev)
    }

    @Test
    fun aHostBeforeProtocolSevenNamesNoParticipantsAndItsListStillReads() {
        val json = Json { ignoreUnknownKeys = true }
        val shifts = json.decodeFromJsonElement(DeviceShiftsDto.serializer(), fixture("device-shifts.json")).shifts
        assertTrue(shifts.isNotEmpty())
        assertTrue(
            shifts.all { it.participants == null && it.totals == null && it.byDevice == null && it.myState == null && it.maxStations == null },
        )
    }

    @Test
    fun theReceiptOfAPartCloseCarriesItsFlagsAndTheOtherFlagIsAbsent() {
        val json = Json { ignoreUnknownKeys = true }
        val receipts = json.decodeFromJsonElement(FactReceiptsDto.serializer(), fixture("facts-response-part-close.json")).receipts
        assertEquals(listOf("accepted", "accepted"), receipts.map { it.outcome })
        assertTrue(receipts[0].details.flag("partClosed"))
        assertFalse(receipts[0].details.flag("reasonMissing"))
        assertTrue(receipts[1].details.flag("reasonMissing"))
        // A flag that is not a JSON boolean, or a missing detail object, is `false`, never a crash.
        assertFalse(null.flag("partClosed"))
        assertFalse(Json.parseToJsonElement("""{"partClosed":"true"}""").jsonObject.flag("partClosed"))
        assertEquals(2, Json.parseToJsonElement("""{"active":2}""").jsonObject.int("active"))
        assertNull(Json.parseToJsonElement("""{"active":"2"}""").jsonObject.int("active"))
    }

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
        assertNull(Sscc.serialOf("046006820000015000", "4600683"))
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

    @Test
    fun theEntryNamesWhatTheHostsHandheldFixtureAsksAndTheMultiStationCapability() {
        val named = fixture("shift-enter-handheld-multi.json").getValue("supports").jsonArray.map { it.jsonPrimitive.content }
        assertTrue(named.contains(HostApi.CAPABILITY_MULTI_STATION))
        // The host checks that what a shift needs is a subset of what the device names, so more names are harmless;
        // fewer are not: every name of the host's fixture must be one of this app's.
        assertTrue(HostApi.ENTER_SUPPORTS.toString(), HostApi.ENTER_SUPPORTS.containsAll(named))
        assertEquals("multi-station-v1", HostApi.CAPABILITY_MULTI_STATION)
    }
}
