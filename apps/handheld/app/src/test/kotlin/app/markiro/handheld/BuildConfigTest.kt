package app.markiro.handheld

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BuildConfigTest {
    @Test
    fun applicationIdIsFixed() {
        assertEquals("app.markiro.handheld", BuildConfig.APPLICATION_ID)
    }

    @Test
    fun debugBuildEnablesEmulatorAids() {
        assertTrue(BuildConfig.SERVER_URL_EDITABLE)
        assertTrue(BuildConfig.DEBUG_SCAN_SOURCE)
        assertEquals("https://admin.markiro.app", BuildConfig.SAAS_SERVER_URL)
    }
}
