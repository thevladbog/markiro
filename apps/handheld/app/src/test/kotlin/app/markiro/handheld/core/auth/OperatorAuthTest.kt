package app.markiro.handheld.core.auth

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class OperatorAuthTest {
    private val anna = OperatorRecord("op-1", "Иванова Анна", "4127", "operator", "PIN:1234", "BADGE:735519", true)
    private val petr = OperatorRecord("op-2", "Иванов Пётр", "3310", "operator", "PIN:9999", null, true)
    private val gone = OperatorRecord("op-3", "Ивлев Сергей", "2201", "operator", "PIN:1234", "BADGE:1", false)
    private val roster = object : OperatorRoster {
        override suspend fun operators() = listOf(anna, petr, gone)
    }
    private val verified = mutableListOf<String>()
    private val auth = OperatorAuth(roster) { secret, phc ->
        verified += phc
        phc == "PIN:$secret" || phc == "BADGE:$secret"
    }

    @Test fun padsShortLoginsOnly() {
        assertEquals("041", OperatorAuth.padLogin("41"))
        assertEquals("4127", OperatorAuth.padLogin("4127"))
        assertEquals("0012", OperatorAuth.padLogin("0012"))
        assertNull(OperatorAuth.padLogin("41a"))
        assertNull(OperatorAuth.padLogin("1234567890123"))
    }

    @Test fun signsInByLoginAndPin() = runTest {
        assertEquals(anna, auth.byLogin("4127", "1234"))
        assertNull(auth.byLogin("4127", "0000"))
        assertNull(auth.byLogin("2201", "1234"))
        assertNull(auth.byLogin("4127", "12"))
    }

    @Test fun unknownLoginStillRunsOneVerification() = runTest {
        verified.clear()
        assertNull(auth.byLogin("7777", "1234"))
        assertEquals(1, verified.size)
        assertEquals(OperatorAuth.DUMMY_PHC, verified.single())
    }

    @Test fun looksUpTheNameForThePinStepWithoutVerifying() = runTest {
        verified.clear()
        assertEquals(anna, auth.byLoginOnly("4127"))
        assertNull(auth.byLoginOnly("2201"))
        assertEquals(0, verified.size)
    }

    @Test fun signsInByBadgeAmongActiveOperatorsOnly() = runTest {
        assertEquals(anna, auth.byBadge("735519"))
        assertNull(auth.byBadge("1"))
        assertNull(auth.byBadge(""))
    }

    @Test fun searchesActiveOperatorsByWordPrefixLimitedToFive() = runTest {
        assertEquals(listOf(anna, petr), auth.search("ив"))
        assertEquals(listOf(anna), auth.search("Анна"))
        assertEquals(emptyList<OperatorRecord>(), auth.search(""))
    }
}
