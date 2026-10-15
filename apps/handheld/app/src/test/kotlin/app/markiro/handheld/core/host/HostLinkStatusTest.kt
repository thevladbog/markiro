package app.markiro.handheld.core.host

import app.markiro.handheld.core.network.host.HostFailure
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HostLinkStatusTest {
    @Test
    fun theStateFollowsTheMonitorAndNeverStopsTheLine() {
        assertEquals(HostLinkStatus.Online, HostLinkStatus.of(reachable = true, restoring = false, skewSeconds = 3))
        assertEquals(HostLinkStatus.Offline, HostLinkStatus.of(reachable = false, restoring = false, skewSeconds = 0))
        assertEquals(HostLinkStatus.Restoring, HostLinkStatus.of(reachable = true, restoring = true, skewSeconds = 0))
        assertEquals(HostLinkStatus.ClockSkew, HostLinkStatus.of(reachable = true, restoring = false, skewSeconds = 121))
        assertEquals(HostLinkStatus.ClockSkew, HostLinkStatus.of(reachable = true, restoring = false, skewSeconds = -121))
        assertEquals("two minutes exactly is still fine", HostLinkStatus.Online, HostLinkStatus.of(true, false, 120))
        // Every state keeps scanning allowed.
        assertTrue(HostLinkStatus.entries.all { it.scanningAllowed })
    }

    @Test
    fun theMonitorsStateIsReadAsItIsAndUnknownBeforeTheFirstBeat() {
        assertNull(HostLinkStatus.of(HostLinkState()))
        assertEquals(HostLinkStatus.Online, HostLinkStatus.of(HostLinkState(reachable = true, clockSkewMs = 2_500)))
        assertEquals(HostLinkStatus.ClockSkew, HostLinkStatus.of(HostLinkState(reachable = true, clockSkewMs = 130_000)))
        assertEquals(HostLinkStatus.Restoring, HostLinkStatus.of(HostLinkState(reachable = true, restoreEpochChanged = true)))
        assertEquals(HostLinkStatus.Offline, HostLinkStatus.of(HostLinkState(reachable = false, failure = HostFailure.Unreachable)))
        // A host that answers "restoring" is being restored, not lost.
        assertEquals(HostLinkStatus.Restoring, HostLinkStatus.of(HostLinkState(reachable = false, failure = HostFailure.RestorePending(30))))
    }
}
