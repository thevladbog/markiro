package app.markiro.handheld.feature.shift

import app.markiro.handheld.core.host.ShiftParticipation
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SharedShiftRulesTest {
    private val now = 1_760_000_000_000L

    private fun fixture(name: String) = Json.parseToJsonElement(
        checkNotNull(javaClass.classLoader?.getResource(name)) { "$name is not in the test resources" }.readText(),
    ).jsonObject

    private fun shared(
        accepted: Long? = 547,
        mine: Long? = 427,
        ever: Int = 2,
        othersOpen: Int = 0,
        max: Int? = 2,
        fetchedAt: Long = now,
        stale: Boolean = false,
    ) = ShiftParticipation(
        shiftId = "s1", maxStations = max, myState = "active", participantsEver = ever, active = 1, othersOpen = othersOpen,
        accepted = accepted, myAccepted = mine, asOf = "2026-10-08T09:41:07Z", fetchedAt = fetchedAt, stale = stale,
    )

    /** The host's own cases (`shift_participants::reason_need`): this client says «ask for a reason» exactly where the host says `required` or `shared`. */
    @Test
    fun theReasonRuleIsTheHostsSharedFixture() {
        val cases = fixture("shift-close-reason-shared.json").getValue("cases").jsonArray
        assertEquals(12, cases.size)
        for (case in cases) {
            val o = case.jsonObject
            fun int(key: String): Int? = (o.getValue(key) as? JsonPrimitive)?.takeIf { it !is JsonNull }?.int
            val ever = int("participantsEver")!!
            val actual = int("actualQty")!!
            val closesShift = o.getValue("closesShift").jsonPrimitive.boolean
            // One device ever: the plan the device saw (the shift row it holds); a shared shift: the host's plan now (the same row, freshly listed).
            val plan = if (ever <= 1) int("factPlanned") else int("hostPlanned")
            val snapshot = shared(
                accepted = o.getValue("shiftAccepted").jsonPrimitive.long, mine = actual.toLong(), ever = ever, othersOpen = if (closesShift) 0 else 1,
            )
            val expected = o.getValue("need").jsonPrimitive.content != "none"
            assertEquals(case.toString(), expected, SharedShiftRules.reasonRequired(plan, actual, snapshot, now, lost = 0))
        }
    }

    @Test
    fun aDeviceAloneInItsShiftKeepsStageTwoAsRule() {
        // No snapshot, an older host (no figures) and a shift only this device ever had all judge by the device's own count.
        assertTrue(SharedShiftRules.reasonRequired(100, 99, null, now, lost = 0))
        assertFalse(SharedShiftRules.reasonRequired(100, 100, null, now, lost = 0))
        assertFalse(SharedShiftRules.reasonRequired(null, 5, null, now, lost = 0))
        assertTrue(SharedShiftRules.reasonRequired(100, 99, shared(ever = 1, accepted = 99, mine = 99), now, lost = 0))
        assertTrue(SharedShiftRules.reasonRequired(100, 99, shared(ever = 0, accepted = null, mine = null), now, lost = 0))
    }

    @Test
    fun aSharedShiftAsksOnlyTheLastCloserAndOnlyWithFreshFigures() {
        // Others still hold their parts: no reason from this one, whatever the plan says.
        assertFalse(SharedShiftRules.reasonRequired(1200, 427, shared(othersOpen = 1), now, lost = 0))
        // The last closer, fresh figures, the total (547) misses the plan (1200): a reason.
        assertTrue(SharedShiftRules.reasonRequired(1200, 427, shared(), now, lost = 0))
        // The total meets the plan: none.
        assertFalse(SharedShiftRules.reasonRequired(547, 427, shared(), now, lost = 0))
        // The host could not be reached (stale) or the answer is old: this device cannot know it is the last, it closes without a reason (spec 12.9).
        assertFalse(SharedShiftRules.reasonRequired(1200, 427, shared(stale = true), now, lost = 0))
        assertFalse(SharedShiftRules.reasonRequired(1200, 427, shared(fetchedAt = now - SharedShiftRules.FRESH_MS - 1), now, lost = 0))
        assertTrue(SharedShiftRules.reasonRequired(1200, 427, shared(fetchedAt = now - SharedShiftRules.FRESH_MS), now, lost = 0))
        // No plan: nothing to miss.
        assertFalse(SharedShiftRules.reasonRequired(null, 427, shared(), now, lost = 0))
    }

    @Test
    fun theShiftWideTotalIsTheOthersAsTheHostCountedThemPlusThisDevicesOwnCount() {
        // The host holds 547 of which 427 are this device's; the device has since scanned 30 more that it has not delivered.
        assertEquals(120 + 457, SharedShiftRules.shiftTotal(shared(), 457, lost = 0))
        // Never below the device's own count (a host answer older than the scans).
        assertEquals(500, SharedShiftRules.shiftTotal(shared(accepted = 10, mine = 400), 500, lost = 0))
        // No figures: the device's own count.
        assertEquals(42, SharedShiftRules.shiftTotal(null, 42, lost = 0))
        assertEquals(42, SharedShiftRules.shiftTotal(shared(accepted = null, mine = null), 42, lost = 0))
        // This device is not in the host's per-device list: the host's total is all someone else's.
        assertEquals(547 + 3, SharedShiftRules.shiftTotal(shared(mine = null), 3, lost = 0))
    }

    @Test
    fun theStripAppearsOnlyWhenTheLineAllowsSeveralDevicesOrSeveralWork() {
        assertNull(SharedShiftRules.strip(null, 10, 100, lost = 0))
        // maxStations 1 and only this device: today's screen, unchanged.
        assertNull(SharedShiftRules.strip(shared(max = 1, ever = 1, accepted = 10, mine = 10), 10, 100, lost = 0))
        // A host that says no limit but lists two participants.
        assertNotNull(SharedShiftRules.strip(shared(max = null, ever = 2), 10, 100, lost = 0))
        val strip = checkNotNull(SharedShiftRules.strip(shared(), 457, 1200, lost = 0))
        assertEquals(457, strip.mine)
        assertEquals(577, strip.total)
        assertEquals(1200, strip.plan)
        assertEquals(1, strip.active)
        assertEquals(2, strip.maxStations)
        assertNull("fresh figures carry no stale mark", strip.staleAtMillis)
        // Stale: the stamp is the host's own asOf.
        val stale = checkNotNull(SharedShiftRules.strip(shared(stale = true), 457, 1200, lost = 0))
        assertEquals(java.time.Instant.parse("2026-10-08T09:41:07Z").toEpochMilli(), stale.staleAtMillis)
    }

    @Test
    fun aCodeTheHostGaveToAnotherDeviceCountsOnceNotTwice() {
        // The host holds 547 (427 this device's). This device counts 457 and has heard that 5 of them went to another device (conflict): those 5 are
        // inside the others' 120 already, so the total is 120 + 452, as the station's sharedCount(lost) says.
        assertEquals(120 + 452, SharedShiftRules.shiftTotal(shared(), 457, lost = 5))
        assertEquals(120 + 457, SharedShiftRules.shiftTotal(shared(), 457, lost = 0))
        // More lost than counted never goes negative.
        assertEquals(120, SharedShiftRules.shiftTotal(shared(), 3, lost = 9))
        // The strip and the reason follow the corrected total.
        assertEquals(572, checkNotNull(SharedShiftRules.strip(shared(), 457, 1200, lost = 5)).total)
        assertEquals(452, checkNotNull(SharedShiftRules.strip(shared(), 457, 1200, lost = 5)).mine)
        // Total 572 would meet this plan, 577 would not: the lost code decides the reason.
        assertFalse(SharedShiftRules.reasonRequired(572, 457, shared(), now, lost = 5))
        assertTrue(SharedShiftRules.reasonRequired(572, 457, shared(), now, lost = 0))
    }
}
