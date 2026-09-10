package app.markiro.handheld.core.inventory

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class InventoryTailTest {
    @Test
    fun serialTailKeepsFourAlphanumerics() {
        assertEquals("…B1", InventoryTail.ofSerial("B1"))
        assertEquals("…DEFG", InventoryTail.ofSerial("ABCDEFG"))
        assertEquals("…AFGH", InventoryTail.ofSerial("A-F(G!H"))
        assertNull(InventoryTail.ofSerial("-_-"))
    }

    @Test
    fun eventTailIgnoresTheCryptoTail() {
        assertEquals("…B1", InventoryTail.ofEvent("item", "010460000000001521B193ZZ"))
        assertEquals("…S1", InventoryTail.ofEvent("item", "010460000000001521S1"))
        assertEquals("…0014", InventoryTail.ofEvent("known_box", "346006820000000014"))
        assertEquals("…0021", InventoryTail.ofEvent("old_box", "346006820000000021"))
        assertNull(InventoryTail.ofEvent("item", "garbage"))
        assertNull(InventoryTail.ofEvent("item", null))
    }
}
