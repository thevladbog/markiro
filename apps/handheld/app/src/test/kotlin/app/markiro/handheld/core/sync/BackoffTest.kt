package app.markiro.handheld.core.sync

import org.junit.Assert.assertEquals
import org.junit.Test

class BackoffTest {
    @Test
    fun doublesFromTwoSecondsToSixtyAndResets() {
        val b = Backoff(startMs = 2_000, capMs = 60_000)
        assertEquals(listOf(2_000L, 4_000L, 8_000L, 16_000L, 32_000L, 60_000L, 60_000L), (1..7).map { b.nextDelay() })
        b.reset()
        assertEquals(2_000L, b.nextDelay())
    }
}
