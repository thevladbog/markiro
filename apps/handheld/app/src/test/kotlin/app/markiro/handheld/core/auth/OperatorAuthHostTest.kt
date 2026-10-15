package app.markiro.handheld.core.auth

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class OperatorAuthHostTest {
    private fun operator(vararg badges: String, legacy: String? = null) =
        OperatorRecord("op-1", "Анна", "0042", "Упаковщик", "pin-phc", legacy, true, badges.toList())

    private fun auth(record: OperatorRecord) = OperatorAuth(
        roster = object : OperatorRoster { override suspend fun operators() = listOf(record) },
        verifier = { secret, phc -> secret == phc.removePrefix("phc-") },
    )

    @Test
    fun anyOfSeveralBadgesOfAnOperatorSignsHimIn() = runTest {
        val auth = auth(operator("phc-first", "phc-second"))
        assertEquals("op-1", auth.byBadge("first")?.operatorId)
        assertEquals("op-1", auth.byBadge("second")?.operatorId)
        assertNull(auth.byBadge("third"))
    }

    @Test
    fun theCloudsSingleBadgeStillWorksAlone() = runTest {
        assertEquals("op-1", auth(operator(legacy = "phc-only")).byBadge("only")?.operatorId)
        assertNull(auth(operator()).byBadge("anything"))
    }
}
