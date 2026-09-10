package app.markiro.handheld.core.scan

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class VendorProfilesTest {
    @Test
    fun picksAProfileByManufacturer() {
        assertEquals(VendorProfiles.DATALOGIC, VendorProfiles.defaultFor("Datalogic"))
        assertEquals(VendorProfiles.HONEYWELL, VendorProfiles.defaultFor("Honeywell"))
        assertEquals(VendorProfiles.ZEBRA, VendorProfiles.defaultFor("Zebra Technologies"))
        assertEquals(VendorProfiles.ZEBRA, VendorProfiles.defaultFor("Google"))
    }

    @Test
    fun extractsTheDataAndSymbologyExtrasOfAProfile() {
        val event = IntentExtractor(VendorProfiles.DATALOGIC).extract(
            mapOf(
                VendorProfiles.DATALOGIC.dataExtra to "]d2010468008990038391EE10",
                VendorProfiles.DATALOGIC.symbologyExtra to "DATAMATRIX",
            ),
            nowMs = 5,
        )
        assertEquals("010468008990038391EE10", event?.raw)
        assertEquals("DATAMATRIX", event?.symbology)
        assertEquals("intent:datalogic", event?.source)
        assertEquals(5L, event?.at)
        assertNull(IntentExtractor(VendorProfiles.DATALOGIC).extract(emptyMap(), 0))
    }
}
