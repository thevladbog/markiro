package app.markiro.handheld.core.grants

import org.junit.Assert.assertEquals
import org.junit.Test

class GrantClockTest {
    private val anchor = TrustedClock(1000, 100, "boot-1", 1000, 1000)

    @Test fun `uses independent monotonic server and local wall high water domains`() {
        assertEquals(ClockAssessment.Trusted(1050), assessClock(anchor, ClockSample(150, "boot-1", 1050)))
        assertEquals(ClockAssessment.Trusted(1050), assessClock(anchor.copy(wallHighWaterMs = 900), ClockSample(150, "boot-1", 950)))
        assertEquals(ClockAssessment.Trusted(1050), assessClock(anchor.copy(wallHighWaterMs = 1100), ClockSample(150, "boot-1", 1150)))
        assertEquals(ClockAssessment.Untrusted, assessClock(anchor, ClockSample(150, "boot-1", 999)))
        assertEquals(ClockAssessment.Untrusted, assessClock(anchor, ClockSample(99, "boot-1", 1050)))
        assertEquals(ClockAssessment.Untrusted, assessClock(anchor, ClockSample(150, "boot-2", 1050)))
        assertEquals(ClockAssessment.Untrusted, assessClock(anchor.copy(highWaterMs = 1051), ClockSample(150, "boot-1", 1050)))
    }

    @Test fun `rejects unsafe values and addition overflow`() {
        assertEquals(ClockAssessment.Untrusted, assessClock(anchor.copy(serverMs = -1), ClockSample(150, "boot-1", 1050)))
        assertEquals(ClockAssessment.Untrusted, assessClock(anchor.copy(serverMs = JS_MAX_SAFE_INTEGER, highWaterMs = JS_MAX_SAFE_INTEGER), ClockSample(101, "boot-1", 1001)))
    }

    @Test fun `persisted forward wall jump rejects later rollback`() {
        assertEquals(ClockAssessment.Trusted(1050), assessClock(anchor, ClockSample(150, "boot-1", 5000)))
        val persisted = anchor.copy(highWaterMs = 1050, wallHighWaterMs = 5000)
        assertEquals(ClockAssessment.Untrusted, assessClock(persisted, ClockSample(200, "boot-1", 4999)))
    }
}
