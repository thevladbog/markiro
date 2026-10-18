package app.markiro.handheld.feature.settings

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.network.host.RejectionHint
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.HostOutboxEntity
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import app.markiro.handheld.core.sync.SyncDriver
import app.markiro.handheld.core.sync.SyncState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
class HostQueueViewModelTest {
    private lateinit var db: HandheldDatabase

    private class Driver : SyncDriver {
        var nudges = 0
        override val state: StateFlow<SyncState> = MutableStateFlow(SyncState())
        override suspend fun drainAll() = true
        override fun nudge() { nudges++ }
        override fun start() = Unit
    }

    @Before
    fun open() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java).allowMainThreadQueries().build()
        db.initializeRecoveryForTest()
    }

    @After
    fun close() {
        db.close()
        Dispatchers.resetMain()
    }

    private fun row(id: String, kind: String, state: String, reason: String? = null, body: String = "{}") =
        HostOutboxEntity(recordId = id, target = "facts", kind = kind, sourceKind = "t", sourceKey = id, body = body, state = state, reason = reason, createdAt = "2026-10-15T08:00:00.000Z")

    @Test
    fun queuedAndQuarantinedRowsShowWithTheHostsReasonInTheOperatorsWords() = runBlocking {
        db.hostOutboxDao().insert(row("a", "scan", "queued"))
        db.hostOutboxDao().insert(row("b", "box_closed", "quarantined", "shift_closed", """{"data":{"sscc":"046006820000015000"}}"""))
        db.hostOutboxDao().insert(row("c", "pallet_box_added", "quarantined", "box_on_pallet", """{"data":{"palletId":"p","boxSscc":"046006820000015017"}}"""))
        val items = HostQueueSource(db).observe().first()
        assertEquals(listOf("a", "b", "c"), items.map { it.recordId })
        assertEquals(listOf(false, true, true), items.map { it.quarantined })
        assertEquals(listOf<RejectionHint?>(null, RejectionHint.OTHER_DEVICE_OR_CLOSED, RejectionHint.PALLET_CONFLICT), items.map { it.hint })
        assertEquals(listOf(null, "015000", "015017"), items.map { it.subject })
        assertEquals("shift_closed", items[1].code)
        val ui = HostQueueUi(items)
        assertEquals(listOf("a"), ui.waiting.map { it.recordId })
        assertEquals(listOf("b", "c"), ui.quarantined.map { it.recordId })
    }

    @Test
    fun sendNowWakesTheLoopAndSupportGetsTheRecordAsFrozenAndNothingElse() = runBlocking {
        val body = """{"id":"b","kind":"box_closed","data":{"sscc":"046006820000015000"}}"""
        db.hostOutboxDao().insert(row("b", "box_closed", "quarantined", "shift_closed", body))
        val driver = Driver()
        val vm = HostQueueViewModel(HostQueueSource(db), driver)
        vm.sendNow()
        assertEquals(1, driver.nudges)
        val seen = mutableListOf<SupportExport>()
        val job = launch(Dispatchers.Unconfined) { vm.exports.collect { seen += it } }
        vm.exportForSupport("missing")
        vm.exportForSupport("b")
        withTimeout(5_000) { while (seen.isEmpty()) delay(10) }
        job.cancel()
        assertEquals(listOf(body), seen.map { it.text })
        assertTrue(seen.single().fileName.startsWith("markiro-host-record-"))
        assertFalse("a key never rides in a record", seen.single().text.contains("deviceKey"))
    }
}
