package app.markiro.handheld.core.sets

import app.markiro.handheld.core.host.HostSyncEngine
import app.markiro.handheld.core.km.KmCodec
import app.markiro.handheld.core.network.SetItemDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SetAssemblyTest {
    private val kit = "04607123456781"
    private val cream = "04607123456804"
    private val balm = "04607123456811"
    private val gel = "04607123456828"
    private val items = listOf(SetItemDto(cream, "Cream", 2), SetItemDto(balm, "Balm", 1), SetItemDto(gel, "Gel", 1))

    @Test
    fun `incomplete kit does not reserve its mark and preserves pending items`() {
        val draft = listOf(code(balm, "balm1"))
        val result = judgeSetScan(kit, items, draft, code(kit, "set1"), emptySet())
        assertEquals(SetScanStatus.INCOMPLETE, result.status)
        assertEquals(draft, result.items)
        assertEquals(3, result.remaining)
    }

    @Test
    fun `items can arrive in any order and final scan alone closes the set`() {
        val scanned = listOf(code(gel, "gel1"), code(cream, "cream1"), code(balm, "balm1"), code(cream, "cream2"))
        var draft = emptyList<String>()
        for (raw in scanned) {
            val result = judgeSetScan(kit, items, draft, raw, emptySet())
            assertEquals(SetScanStatus.ITEM_ADDED, result.status)
            draft = result.items
        }
        val result = judgeSetScan(kit, items, draft, code(kit, "set1"), emptySet())
        assertEquals(SetScanStatus.CLOSED, result.status)
        assertEquals(scanned, result.items)
        assertTrue(result.setCode!!.canonicalRaw.endsWith("${KmCodec.GS}93check"))
    }

    @Test
    fun `wrong gtin extra or duplicate units do not mutate the draft`() {
        val first = code(cream, "cream1")
        val draft = listOf(first, code(cream, "cream2"))
        for ((raw, expected) in listOf(
            code(cream, "cream3") to SetScanStatus.EXTRA,
            first.replace("93check", "93another") to SetScanStatus.DUPLICATE,
            code("04601234000017", "outside") to SetScanStatus.WRONG_PRODUCT,
            "4607123456781" to SetScanStatus.INVALID,
        )) {
            val result = judgeSetScan(kit, items, draft, raw, emptySet())
            assertEquals(expected, result.status)
            assertEquals(draft, result.items)
        }
    }

    @Test
    fun `existing claims block both item and kit code reuse`() {
        val used = code(gel, "gel1")
        val claim = KmCodec.hash(KmCodec.canonicalize(used))
        assertEquals(SetScanStatus.DUPLICATE, judgeSetScan(kit, items, emptyList(), used, setOf(claim)).status)
        val draft = listOf(used, code(cream, "cream1"), code(cream, "cream2"), code(balm, "balm1"))
        assertEquals(SetScanStatus.DUPLICATE, judgeSetScan(kit, items, draft, code(kit, "set1"), setOf(claim)).status)
    }

    @Test
    fun `fact batching keeps queue order within the host request size`() {
        val overhead = """{"records":[]}""".length
        val max = HostSyncEngine.MAX_BODY_BYTES
        assertEquals(2, HostSyncEngine.batchCount(listOf(max - overhead - 200, 199, 1)))
        assertEquals(1, HostSyncEngine.batchCount(listOf(max - overhead, 1)))
        assertEquals(0, HostSyncEngine.batchCount(emptyList()))
    }

    private fun code(gtin: String, serial: String) = "01${gtin}21${serial}${KmCodec.GS}93check"
}
