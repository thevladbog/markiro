package app.markiro.handheld.core.host

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.network.host.FactReceiptDto
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.HostOutboxEntity
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** The host's remarks on a close (`partClosed`, `reasonMissing`) reach the close summary through a note; a plain receipt leaves none. */
@RunWith(AndroidJUnit4::class)
class HostAckMapperCloseNoteTest {
    private lateinit var db: HandheldDatabase
    private val shift = HostFactsFixtures.SHIFT
    private val event = "00000000-0000-4000-8000-000000000002"

    @Before
    fun open() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java).allowMainThreadQueries().build()
        runBlocking {
            db.deviceConfigDao().upsert(HostFactsFixtures.config(db))
            db.shiftDao().upsert(HostFactsFixtures.shift())
        }
        db.initializeRecoveryForTest()
    }

    @After
    fun close() = db.close()

    private suspend fun queuedClose(): HostOutboxEntity {
        db.shiftCloseDao().insert(HostFactsFixtures.shiftClose(event))
        val row = HostOutboxEntity(recordId = event, target = "facts", kind = "shift_closed", sourceKind = "shift_close", sourceKey = event, body = "{}", state = "queued", reason = null, createdAt = "2026-10-08T14:10:00.000Z")
        db.hostOutboxDao().insert(row)
        return row
    }

    private fun receipt(details: String?, outcome: String = "accepted") = FactReceiptDto(
        id = event, outcome = outcome, details = details?.let { Json.parseToJsonElement(it).jsonObject },
    )

    @Test
    fun aPartCloseReceiptIsAcceptedAndNotedForTheSummary() = runTest {
        val row = queuedClose()
        HostAckMapper(db).apply(listOf(row), listOf(receipt("""{"partClosed":true}""")))
        assertEquals("accepted", db.shiftCloseDao().forShift(shift)!!.state)
        assertEquals("part_closed", ShiftParticipationStore(db).closeNote(shift))
    }

    @Test
    fun aMissingReasonReceiptIsAcceptedAndNotedForTheSummary() = runTest {
        val row = queuedClose()
        HostAckMapper(db).apply(listOf(row), listOf(receipt("""{"reasonMissing":true}""")))
        assertEquals("reason_missing", ShiftParticipationStore(db).closeNote(shift))
    }

    @Test
    fun aPlainAcceptedCloseLeavesNoNote() = runTest {
        val row = queuedClose()
        HostAckMapper(db).apply(listOf(row), listOf(receipt(null)))
        assertEquals("accepted", db.shiftCloseDao().forShift(shift)!!.state)
        assertNull(ShiftParticipationStore(db).closeNote(shift))
    }

    @Test
    fun aRefusedCloseIsAConflictAndLeavesNoNote() = runTest {
        val row = queuedClose()
        HostAckMapper(db).apply(listOf(row), listOf(receipt("""{"partClosed":true}""", outcome = "rejected")))
        assertEquals("conflict", db.shiftCloseDao().forShift(shift)!!.state)
        assertNull(ShiftParticipationStore(db).closeNote(shift))
    }

    @Test
    fun theReceiptOfAnythingButAClosePutsNoNote() = runTest {
        db.hostOutboxDao().insert(HostOutboxEntity(recordId = "r1", target = "facts", kind = "scan", sourceKind = "scan", sourceKey = "999", body = "{}", state = "queued", reason = null, createdAt = "2026-10-08T14:10:00.000Z"))
        val row = db.hostOutboxDao().queued(10).single()
        HostAckMapper(db).apply(listOf(row), listOf(FactReceiptDto(id = "r1", outcome = "accepted", details = Json.parseToJsonElement("""{"partClosed":true}""").jsonObject)))
        assertEquals(emptyList<String>(), db.metaDao().withPrefix("shift_close_note:").map { it.key })
    }
}
