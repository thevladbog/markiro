package app.markiro.handheld.core.barcode

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ShiftTaskTokenTest {
    private val shiftId = "11111111-1111-4111-8111-111111111111"

    @Test
    fun `parses the frozen v1 namespace`() {
        assertEquals("markiro:shift:v1:", ShiftTaskToken.PREFIX)
        assertEquals(shiftId, ShiftTaskToken.parse("markiro:shift:v1:$shiftId"))
    }

    @Test
    fun `lowercases the id so one shift keeps one identity`() {
        assertEquals(shiftId, ShiftTaskToken.parse("markiro:shift:v1:${shiftId.uppercase()}"))
    }

    @Test
    fun `refuses the inventory namespace`() {
        assertNull(ShiftTaskToken.parse("markiro:inventory:v1:$shiftId"))
    }

    @Test
    fun `refuses a well-prefixed payload that is not a uuid`() {
        assertNull(ShiftTaskToken.parse("markiro:shift:v1:not-a-uuid"))
        assertNull(ShiftTaskToken.parse("markiro:shift:v1:"))
    }

    @Test
    fun `refuses a bare uuid and a production code`() {
        assertNull(ShiftTaskToken.parse(shiftId))
        assertNull(ShiftTaskToken.parse("010468008990038321ABC93XYZ"))
    }
}
