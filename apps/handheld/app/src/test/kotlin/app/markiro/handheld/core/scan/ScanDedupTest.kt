package app.markiro.handheld.core.scan

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ScanDedupTest {
    private fun scan(raw: String, at: Long, source: String = "intent:urovo") = ScanEvent(raw, null, source, at)

    /**
     * The reason this class exists: every known profile is registered at once,
     * and a terminal left in both intent and wedge mode sends the same pull
     * twice. Reported as two scans it becomes a duplicate unit on the work
     * screen -- an error the operator has to resolve for something they did once.
     */
    @Test
    fun oneTriggerPullSeenByTwoSourcesIsOneScan() {
        val dedup = ScanDedup()
        assertTrue(dedup.accept(scan("0104680089900383215Qbc93Zjqw", 1_000)))
        assertFalse(dedup.accept(scan("0104680089900383215Qbc93Zjqw", 1_002, "wedge")))
    }

    @Test
    fun twoDifferentCodesBackToBackAreTwoScans() {
        val dedup = ScanDedup()
        assertTrue(dedup.accept(scan("40318827", 1_000)))
        assertTrue(dedup.accept(scan("40318828", 1_001)))
    }

    /** Scanning the same unit again is a duplicate the work screen must report, not swallow. */
    @Test
    fun theSameCodeScannedAgainLaterIsANewScan() {
        val dedup = ScanDedup()
        assertTrue(dedup.accept(scan("40318827", 1_000)))
        assertTrue(dedup.accept(scan("40318827", 1_400)))
    }

    /**
     * The window is anchored on the last accepted scan, not the last seen one:
     * anchored on every arrival, a stream of repeats inside the window would
     * push the anchor forward forever and the code would never be admitted.
     */
    @Test
    fun aRunOfRepeatsCannotSuppressTheCodeIndefinitely() {
        val dedup = ScanDedup()
        assertTrue(dedup.accept(scan("40318827", 0)))
        for (at in listOf(50L, 100L, 150L)) assertFalse(dedup.accept(scan("40318827", at)))
        assertTrue(dedup.accept(scan("40318827", 201)))
    }

    /** A clock that steps backwards (NTP, or a reboot) must not swallow real work. */
    @Test
    fun aBackwardsClockAdmitsTheScan() {
        val dedup = ScanDedup()
        assertTrue(dedup.accept(scan("40318827", 5_000)))
        assertTrue(dedup.accept(scan("40318827", 4_000)))
    }
}
