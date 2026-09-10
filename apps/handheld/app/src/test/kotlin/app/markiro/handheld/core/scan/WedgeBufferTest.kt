package app.markiro.handheld.core.scan

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WedgeBufferTest {
    @Test
    fun completesOnEnter() {
        val buffer = WedgeBuffer(timeoutMs = 150)
        var t = 1000L
        "010491".forEach { assertNull(buffer.onChar(it, t++)) }
        assertEquals("010491", buffer.onEnter(t))
        assertNull(buffer.onEnter(t + 1))
    }

    @Test
    fun dropsAStaleFragmentWhenTheInterKeyGapIsTooLong() {
        val buffer = WedgeBuffer(timeoutMs = 150)
        buffer.onChar('1', 1000)
        buffer.onChar('2', 1050)
        assertNull(buffer.onChar('3', 1400))
        assertEquals("3", buffer.onEnter(1401))
    }

    @Test
    fun ignoresEnterOnAnEmptyBuffer() {
        assertNull(WedgeBuffer(150).onEnter(0))
    }
}
