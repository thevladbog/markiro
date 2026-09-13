package app.markiro.handheld.core.scan

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class VendorProfilesTest {
    @Test
    fun picksAProfileByManufacturer() {
        assertEquals(VendorProfiles.DATALOGIC, VendorProfiles.defaultFor("Datalogic"))
        assertEquals(VendorProfiles.HONEYWELL, VendorProfiles.defaultFor("Honeywell"))
        assertEquals(VendorProfiles.ZEBRA, VendorProfiles.defaultFor("Zebra Technologies"))
        assertEquals(VendorProfiles.UROVO, VendorProfiles.defaultFor("UROVO"))
        assertEquals(VendorProfiles.NEWLAND, VendorProfiles.defaultFor("Newland"))
        assertEquals(VendorProfiles.XCHENG, VendorProfiles.defaultFor("ATOL"))
        assertEquals(VendorProfiles.CHAINWAY, VendorProfiles.defaultFor("Chainway"))
    }

    @Test
    fun extractsTheDataAndSymbologyExtrasOfAProfile() {
        val event = IntentExtractor(VendorProfiles.DATALOGIC).extract(
            mapOf(
                "com.datalogic.decode.intentwedge.barcode_string" to "]d2010468008990038391EE10",
                "com.datalogic.decode.intentwedge.barcode_type" to "DATAMATRIX",
            ),
            nowMs = 5,
        )
        assertEquals("010468008990038391EE10", event?.raw)
        assertEquals("DATAMATRIX", event?.symbology)
        assertEquals("intent:datalogic", event?.source)
        assertEquals(5L, event?.at)
        assertNull(IntentExtractor(VendorProfiles.DATALOGIC).extract(emptyMap(), 0))
    }

    /** The profile confirmed on a terminal. Nothing below may change what it reads. */
    @Test
    fun honeywellStillReadsItsOwnExtras() {
        val event = IntentExtractor(VendorProfiles.HONEYWELL).extract(
            mapOf("data" to "0104680089900383215Qbc93Zjqw", "codeId" to "j"),
            nowMs = 1,
        )
        assertEquals("0104680089900383215Qbc93Zjqw", event?.raw)
        assertEquals("j", event?.symbology)
    }

    /**
     * Urovo's own documented shape: the code as a byte array padded to the
     * decoder's buffer, its real length in a separate extra, and the symbology
     * as a single byte. Read as a String this produced nothing at all.
     */
    @Test
    fun urovoSendsBytesAPaddedBufferAndAByteSymbology() {
        val code = "0104680089900383215Qbc93Zjqw"
        val buffer = code.toByteArray().copyOf(64)
        val event = IntentExtractor(VendorProfiles.UROVO).extract(
            mapOf("barcode" to buffer, "length" to code.toByteArray().size, "barcodeType" to 13.toByte()),
            nowMs = 7,
        )
        assertEquals(code, event?.raw)
        assertEquals("13", event?.symbology)
        assertEquals("intent:urovo", event?.source)
    }

    /** The same service also offers a String; it is preferred, so no length is needed. */
    @Test
    fun urovoPrefersTheStringExtraWhenBothArePresent() {
        val event = IntentExtractor(VendorProfiles.UROVO).extract(
            mapOf("barcode_string" to "40318827", "barcode" to "nonsense".toByteArray()),
            nowMs = 0,
        )
        assertEquals("40318827", event?.raw)
    }

    /** A buffer with no length at all still has to yield the code, not the padding after it. */
    @Test
    fun aPaddedBufferWithoutALengthStopsAtTheFirstNul() {
        val event = IntentExtractor(VendorProfiles.UROVO).extract(
            mapOf("barcode" to "40318827".toByteArray().copyOf(32)),
            nowMs = 0,
        )
        assertEquals("40318827", event?.raw)
    }

    /** A length longer than the buffer is the vendor's bug, not a reason to crash a shift. */
    @Test
    fun animpossibleLengthFallsBackToTheBuffer() {
        val event = IntentExtractor(VendorProfiles.UROVO).extract(
            mapOf("barcode" to "40318827".toByteArray(), "length" to 9000),
            nowMs = 0,
        )
        assertEquals("40318827", event?.raw)
    }

    @Test
    fun theRebrandedChineseServicesReadTheirOwnKeys() {
        assertEquals(
            "40318827",
            IntentExtractor(VendorProfiles.XCHENG)
                .extract(mapOf("EXTRA_BARCODE_DECODING_DATA" to "40318827"), 0)?.raw,
        )
        assertEquals(
            "40318827",
            IntentExtractor(VendorProfiles.HHT)
                .extract(mapOf("com.hht.datawedge.data_string" to "40318827"), 0)?.raw,
        )
        assertEquals(
            "40318827",
            IntentExtractor(VendorProfiles.NEWLAND)
                .extract(mapOf("SCAN_BARCODE1" to "40318827", "SCAN_STATE" to "ok"), 0)?.raw,
        )
        assertEquals(
            "40318827",
            IntentExtractor(VendorProfiles.CHAINWAY)
                .extract(mapOf("dataBytes" to "40318827".toByteArray()), 0)?.raw,
        )
    }

    /** Newland numbers its symbologies; a number is still worth showing on the test-scan card. */
    @Test
    fun aNumericSymbologyIsReported() {
        val event = IntentExtractor(VendorProfiles.NEWLAND)
            .extract(mapOf("SCAN_BARCODE1" to "40318827", "SCAN_BARCODE_TYPE" to 7), 0)
        assertEquals("7", event?.symbology)
    }

    /**
     * АТОЛ's ScanWedge broadcasts with a category, and a filter that does not
     * declare one never matches it. The profile carries it so the source can.
     */
    @Test
    fun theScanWedgeProfileCarriesItsCategory() {
        assertEquals("android.intent.category.DEFAULT", VendorProfiles.HHT.category)
        assertTrue(VendorProfiles.ALL.filter { it.category != null } == listOf(VendorProfiles.HHT))
    }

    @Test
    fun aCustomProfileNeedsAnActionAndADataKey() {
        assertNull(VendorProfiles.custom("", "data", ""))
        assertNull(VendorProfiles.custom("some.action", "  ", ""))
        // Typed on a terminal keyboard, so the stray spaces are expected.
        val profile = VendorProfiles.custom(" some.action ", " payload ", " kind ")
        assertNotNull(profile)
        assertEquals("some.action", profile?.action)
        assertEquals(listOf("payload"), profile?.dataExtras)
        assertEquals(listOf("kind"), profile?.symbologyExtras)
        assertEquals(emptyList<String>(), VendorProfiles.custom("some.action", "payload", "")?.symbologyExtras)
        assertEquals(
            "40318827",
            IntentExtractor(VendorProfiles.custom("some.action", "payload", "")!!)
                .extract(mapOf("payload" to "40318827"), 0)?.raw,
        )
    }

    /** Two profiles that share an action are fine; two that share an id are not. */
    @Test
    fun everyProfileHasItsOwnId() {
        assertEquals(VendorProfiles.ALL.size, VendorProfiles.ALL.map { it.id }.toSet().size)
        assertTrue(VendorProfiles.ALL.none { it.id == VendorProfiles.CUSTOM_ID })
        assertTrue(VendorProfiles.ALL.all { it.dataExtras.isNotEmpty() })
    }
}
