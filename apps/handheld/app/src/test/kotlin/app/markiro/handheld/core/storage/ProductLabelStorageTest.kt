package app.markiro.handheld.core.storage

import app.markiro.handheld.core.storage.initializeRecoveryForTest
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ProductLabelStorageTest {
    private lateinit var db: HandheldDatabase

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        db.initializeRecoveryForTest()
    }

    @After
    fun tearDown() = db.close()

    private fun job(id: String, status: String = "prepared", acceptedAt: String = "2026-09-11T08:00:00.000Z") =
        ProductLabelJobEntity(
            jobId = id,
            shiftId = "s1",
            codeHash = "c".repeat(64),
            canonicalRaw = "0104600682000013215Y7HG9",
            acceptedAt = acceptedAt,
            operatorId = "op-1",
            policyRevision = "rev-1",
            templateDigest = "a".repeat(64),
            payloadDigest = "p".repeat(64),
            bytesBase64 = "AAEC",
            bytesDigest = "b".repeat(64),
            language = "zpl",
            dpi = 203,
            latestSequence = 1,
            attemptId = "att-1",
            attemptNo = 1,
            attemptState = "prepared",
            verification = "none",
            verificationOutcome = "not_required",
            status = status,
            lastFailure = null,
        )

    private fun event(id: String, jobId: String, sequence: Int, occurredAt: String = "2026-09-11T08:00:00.000Z") =
        ProductLabelEventEntity(
            eventId = id,
            jobId = jobId,
            sequence = sequence,
            kind = "prepared",
            payloadJson = """{"eventId":"$id"}""",
            occurredAt = occurredAt,
            ackedAt = null,
            quarantineCode = null,
        )

    @Test
    fun anOpenJobIsTheOneThatIsNotSettled() = runTest {
        db.productLabelJobDao().insert(job("j1", status = "completed"))
        assertNull(db.productLabelJobDao().openJob("s1"))
        db.productLabelJobDao().insert(job("j2", status = "sending"))
        assertEquals("j2", db.productLabelJobDao().openJob("s1")?.jobId)
    }

    /** A job in another shift is another shift's business. */
    @Test
    fun anOpenJobIsScopedToItsShift() = runTest {
        db.productLabelJobDao().insert(job("j1", status = "sending").copy(shiftId = "s2"))
        assertNull(db.productLabelJobDao().openJob("s1"))
    }

    @Test
    fun eventsDrainOldestFirstAndAcknowledgeById() = runTest {
        db.productLabelJobDao().insert(job("j1"))
        db.productLabelEventDao().insert(event("e2", "j1", 2, occurredAt = "2026-09-11T08:00:02.000Z"))
        db.productLabelEventDao().insert(event("e1", "j1", 1, occurredAt = "2026-09-11T08:00:01.000Z"))
        assertEquals(listOf("e1", "e2"), db.productLabelEventDao().unacked(10).map { it.eventId })
        db.productLabelEventDao().markAcked(listOf("e1"), "2026-09-11T09:00:00.000Z")
        assertEquals(listOf("e2"), db.productLabelEventDao().unacked(10).map { it.eventId })
    }

    /**
     * The server refuses a gap in a job's sequence, so two events recorded in the
     * same instant must still leave in the order they happened.
     */
    @Test
    fun eventsOfOneJobDrainInSequenceOrderEvenAtTheSameInstant() = runTest {
        db.productLabelJobDao().insert(job("j1"))
        db.productLabelEventDao().insert(event("e3", "j1", 3))
        db.productLabelEventDao().insert(event("e1", "j1", 1))
        db.productLabelEventDao().insert(event("e2", "j1", 2))
        assertEquals(listOf("e1", "e2", "e3"), db.productLabelEventDao().unacked(10).map { it.eventId })
    }

    @Test
    fun aQuarantinedEventLeavesTheQueueButKeepsItsCode() = runTest {
        db.productLabelJobDao().insert(job("j1"))
        db.productLabelEventDao().insert(event("e1", "j1", 1))
        db.productLabelEventDao().markQuarantined("e1", "policy_mismatch", "2026-09-11T09:00:00.000Z")
        assertEquals(emptyList<String>(), db.productLabelEventDao().unacked(10).map { it.eventId })
        assertEquals("policy_mismatch", db.productLabelEventDao().bySequence("j1").single().quarantineCode)
    }

    /** Retention step one: the bytes go at shift close whatever the status. */
    @Test
    fun closingAShiftDropsTheBytesAndKeepsTheRow() = runTest {
        db.productLabelJobDao().insert(job("j1", status = "attention"))
        db.productLabelJobDao().dropBytesForShift("s1")
        assertNotNull(db.productLabelJobDao().get("j1"))
        assertNull(db.productLabelJobDao().get("j1")?.bytesBase64)
        // The digest survives: an event already queued still describes what printed.
        assertEquals("b".repeat(64), db.productLabelJobDao().get("j1")?.bytesDigest)
    }

    /** Retention step two: the row goes once the server holds every one of its events. */
    @Test
    fun purgingKeepsAJobWhoseEventsAreStillOwed() = runTest {
        db.productLabelJobDao().insert(job("j1", status = "completed"))
        db.productLabelJobDao().insert(job("j2", status = "completed"))
        db.productLabelEventDao().insert(event("e1", "j1", 1))
        db.productLabelEventDao().insert(event("e2", "j2", 1).copy(ackedAt = "2026-09-11T09:00:00.000Z"))
        db.productLabelJobDao().purgeSettled("s1")
        assertNotNull(db.productLabelJobDao().get("j1"))
        assertNull(db.productLabelJobDao().get("j2"))
    }

    /** An unresolved job survives shift close as a record; only its bytes go. */
    @Test
    fun purgingKeepsAnUnresolvedJob() = runTest {
        db.productLabelJobDao().insert(job("j1", status = "attention"))
        db.productLabelEventDao().insert(event("e1", "j1", 1).copy(ackedAt = "2026-09-11T09:00:00.000Z"))
        db.productLabelJobDao().purgeSettled("s1")
        assertNotNull(db.productLabelJobDao().get("j1"))
    }

    /** A quarantined event is settled too: the server will never take it. */
    @Test
    fun purgingTreatsAQuarantinedEventAsSettled() = runTest {
        db.productLabelJobDao().insert(job("j1", status = "completed"))
        db.productLabelEventDao().insert(event("e1", "j1", 1).copy(quarantineCode = "policy_mismatch"))
        db.productLabelJobDao().purgeSettled("s1")
        assertNull(db.productLabelJobDao().get("j1"))
    }

    /** Anything left mid-send is unknown, never resumable. */
    @Test
    fun anInterruptedSendIsFoundByItsAttemptState() = runTest {
        db.productLabelJobDao().insert(job("j1", status = "sending").copy(attemptState = "sending"))
        db.productLabelJobDao().insert(job("j2", status = "completed").copy(attemptState = "sent"))
        assertEquals(listOf("j1"), db.productLabelJobDao().interrupted().map { it.jobId })
    }

    /** The whole "no credential scoping" decision rests on this. */
    @Test
    fun aWipeLeavesNoJobAndNoEvent() = runTest {
        db.productLabelJobDao().insert(job("j1", status = "attention"))
        db.productLabelEventDao().insert(event("e1", "j1", 1))
        db.productLabelJobDao().clear()
        db.productLabelEventDao().clear()
        assertNull(db.productLabelJobDao().get("j1"))
        assertEquals(emptyList<String>(), db.productLabelEventDao().bySequence("j1").map { it.eventId })
    }

    /**
     * A device clock that steps backwards would otherwise put event 2 ahead of
     * event 1, and a batch cut by the limit would carry the second without the
     * first -- which the server refuses as a sequence gap.
     */
    @Test
    fun aLimitedBatchIsAPrefixEvenWhenTheClockWentBackwards() = runTest {
        db.productLabelJobDao().insert(job("j1"))
        db.productLabelEventDao().insert(event("e1", "j1", 1, occurredAt = "2026-09-11T08:00:09.000Z"))
        db.productLabelEventDao().insert(event("e2", "j1", 2, occurredAt = "2026-09-11T08:00:05.000Z"))
        db.productLabelEventDao().insert(event("e3", "j1", 3, occurredAt = "2026-09-11T08:00:01.000Z"))
        assertEquals(listOf("e1", "e2"), db.productLabelEventDao().unacked(2).map { it.eventId })
    }

    /** A purged job must not leave its events behind: that is the table retention exists to bound. */
    @Test
    fun purgingTakesAJobsEventsWithIt() = runTest {
        db.productLabelJobDao().insert(job("j1", status = "completed"))
        db.productLabelEventDao().insert(event("e1", "j1", 1).copy(ackedAt = "2026-09-11T09:00:00.000Z"))
        db.productLabelEventDao().insert(event("e2", "j1", 2).copy(quarantineCode = "policy_mismatch"))
        db.productLabelJobDao().purgeSettled("s1")
        assertNull(db.productLabelJobDao().get("j1"))
        assertEquals(emptyList<String>(), db.productLabelEventDao().bySequence("j1").map { it.eventId })
    }

    /** The sync path purges across shifts, so a long shift does not carry every label it printed. */
    @Test
    fun purgingEverywhereIgnoresTheShiftButKeepsWhatIsOwed() = runTest {
        db.productLabelJobDao().insert(job("j1", status = "completed").copy(shiftId = "s2"))
        db.productLabelJobDao().insert(job("j2", status = "completed"))
        db.productLabelEventDao().insert(event("e1", "j1", 1).copy(ackedAt = "2026-09-11T09:00:00.000Z"))
        db.productLabelEventDao().insert(event("e2", "j2", 1))
        db.productLabelJobDao().purgeSettledEverywhere()
        assertNull(db.productLabelJobDao().get("j1"))
        assertNotNull(db.productLabelJobDao().get("j2"))
    }
}
