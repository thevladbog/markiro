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

    @Test
    fun `accepts every version nibble from 1 through 8`() {
        val v6 = "11111111-1111-6111-8111-111111111111"
        val v8 = "11111111-1111-8111-8111-111111111111"
        assertEquals(v6, ShiftTaskToken.parse("markiro:shift:v1:$v6"))
        assertEquals(v8, ShiftTaskToken.parse("markiro:shift:v1:$v8"))
    }

    @Test
    fun `still refuses an out-of-range version and variant`() {
        assertNull(ShiftTaskToken.parse("markiro:shift:v1:11111111-1111-9111-8111-111111111111"))
        assertNull(ShiftTaskToken.parse("markiro:shift:v1:11111111-1111-4111-c111-111111111111"))
    }

    @Test
    fun `mirrors the TypeScript task-tokens rule, accepting the nil and max uuid sentinels in either case`() {
        val nil = "00000000-0000-0000-0000-000000000000"
        val max = "ffffffff-ffff-ffff-ffff-ffffffffffff"
        assertEquals(nil, ShiftTaskToken.parse("markiro:shift:v1:$nil"))
        assertEquals(nil, ShiftTaskToken.parse("markiro:shift:v1:${nil.uppercase()}"))
        assertEquals(max, ShiftTaskToken.parse("markiro:shift:v1:$max"))
        assertEquals(max, ShiftTaskToken.parse("markiro:shift:v1:${max.uppercase()}"))
    }
}
