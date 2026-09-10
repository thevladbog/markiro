package app.markiro.handheld.feature.inventory

import androidx.lifecycle.SavedStateHandle
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.MainDispatcherRule
import app.markiro.handheld.core.auth.OperatorRecord
import app.markiro.handheld.core.inventory.InventoryRecorder
import app.markiro.handheld.core.inventory.InventorySyncEngine
import app.markiro.handheld.core.inventory.InventoryVerdict
import app.markiro.handheld.core.km.KmCodec
import app.markiro.handheld.core.network.NetworkModule
import app.markiro.handheld.core.network.ReachabilityTracker
import app.markiro.handheld.core.scan.ScanEvent
import app.markiro.handheld.core.scan.ScanRouterAdapter
import app.markiro.handheld.core.signal.SignalKind
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.InventoryFixtures
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.sync.SyncTransport
import app.markiro.handheld.feature.signin.SessionHolder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class InventoryWorkViewModelTest {
    @get:Rule
    val main = MainDispatcherRule()

    private lateinit var db: HandheldDatabase
    private val scans = MutableSharedFlow<ScanEvent>(extraBufferCapacity = 8)
    private val played = mutableListOf<SignalKind>()
    private val session = SessionHolder().apply { signIn(OperatorRecord("op-1", "Иванова Анна", "4127", "operator", "x", null, true)) }
    private val gs = "\u001d"
    private fun raw(serial: String) = "010460000000001521$serial${gs}93AbCd"
    private fun hash(serial: String) = KmCodec.hash(KmCodec.canonicalize(raw(serial)))

    @Before
    fun setUp() = runTest {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java).allowMainThreadQueries().build()
        db.deviceConfigDao().upsert(
            DeviceConfigEntity(
                deviceId = "dev-1", deviceName = "ТСД", tenantId = "t", organizationName = "ООО", lineId = "l1", lineName = "Линия 2",
                kind = "handheld", serverUrl = "http://x", pairedAt = 1L, activeInventoryId = "i1",
            ),
        )
        db.inventoryTaskDao().upsert(InventoryFixtures.task("i1").copy(expectedCount = 3))
        db.inventorySnapshotCodeDao().insertAll(
            listOf(
                InventoryFixtures.code("snap", hash("A1"), serial = "A1", date = "2026-08-20"),
                InventoryFixtures.code("snap", hash("A2"), serial = "A2", date = "2026-08-22"),
                InventoryFixtures.code("snap", hash("A3"), serial = "A3", date = "2026-08-20"),
            ),
        )
    }

    @After
    fun tearDown() = db.close()

    /** Room answers on its own threads; keep draining the test dispatcher until the signals arrive. */
    private fun kotlinx.coroutines.test.TestScope.awaitSignals(count: Int) {
        repeat(400) {
            if (played.size >= count) return
            advanceUntilIdle()
            Thread.sleep(5)
        }
        assertEquals(count, played.size)
    }

    private fun vm(): InventoryWorkViewModel {
        val engine = InventorySyncEngine(
            db, MetaStore(db.metaDao()), db.deviceConfigDao(), SyncTransport(OkHttpClient()) { "http://127.0.0.1:1/" }, NetworkModule.strictJson(),
            CoroutineScope(SupervisorJob() + Dispatchers.Unconfined),
        )
        return InventoryWorkViewModel(
            SavedStateHandle(mapOf("inventoryId" to "i1")), db, InventoryRecorder(db), ScanRouterAdapter(scans), { played += it }, engine, session,
            ReachabilityTracker(),
        )
    }

    @Test
    fun scansUpdateTheVerdictCountersAndFeed() = runTest {
        val vm = vm()
        advanceUntilIdle()
        scans.tryEmit(ScanEvent(raw("A1"), null, "debug", 0))
        advanceUntilIdle()
        // The counters come from separate Room queries and land one at a time; wait for the whole picture.
        val ui = vm.state.first { it.progress.verified == 1 && it.progress.thisTerminal == 1 && it.last != null }
        assertEquals(InventoryVerdict.EXPECTED, ui.last?.verdict)
        assertEquals(1, ui.progress.thisTerminal)
        assertEquals(3, ui.expectedCount)
        assertEquals("2026-08-20", vm.state.first { it.activeDate == "2026-08-20" }.activeDate)
        scans.tryEmit(ScanEvent(raw("A1"), null, "debug", 0))
        assertEquals(InventoryVerdict.DUPLICATE, vm.state.first { it.last?.verdict == InventoryVerdict.DUPLICATE }.last?.verdict)
        scans.tryEmit(ScanEvent("garbage", null, "debug", 0))
        assertEquals(InventoryVerdict.INVALID, vm.state.first { it.last?.verdict == InventoryVerdict.INVALID }.last?.verdict)
        awaitSignals(3)
        assertEquals(listOf(SignalKind.OK, SignalKind.DUPLICATE, SignalKind.ERROR), played)
        // An invalid scan is not an event, so the feed holds the two recorded ones.
        assertEquals(2, vm.state.first { it.feed.size == 2 }.feed.size)
    }

    @Test
    fun aMismatchHoldsScansUntilResolved() = runTest {
        val vm = vm()
        advanceUntilIdle()
        scans.tryEmit(ScanEvent(raw("A1"), null, "debug", 0))
        advanceUntilIdle()
        scans.tryEmit(ScanEvent(raw("A2"), null, "debug", 0))
        val held = vm.state.first { it.held != null }.held
        assertEquals("2026-08-22", held?.codeDate)
        scans.tryEmit(ScanEvent(raw("A3"), null, "debug", 0))
        awaitSignals(3)
        assertEquals(1, vm.state.value.progress.verified)
        assertEquals(listOf(SignalKind.OK, SignalKind.ERROR, SignalKind.ERROR), played)
        vm.applyDateAndAccept()
        val after = vm.state.first { it.progress.verified == 2 }
        assertNull(after.held)
        assertEquals("2026-08-22", vm.state.first { it.activeDate == "2026-08-22" }.activeDate)
        vm.setDate("2026-08-20")
        assertEquals("2026-08-20", vm.state.first { it.activeDate == "2026-08-20" }.activeDate)
    }

    @Test
    fun acceptAsIsKeepsTheActiveDateAndSkipDropsTheScan() = runTest {
        val vm = vm()
        advanceUntilIdle()
        scans.tryEmit(ScanEvent(raw("A1"), null, "debug", 0))
        advanceUntilIdle()
        scans.tryEmit(ScanEvent(raw("A2"), null, "debug", 0))
        vm.state.first { it.held != null }
        vm.skipHeld()
        assertNull(vm.state.first { it.held == null }.held)
        assertEquals(1, vm.state.value.progress.verified)
        scans.tryEmit(ScanEvent(raw("A2"), null, "debug", 0))
        vm.state.first { it.held != null }
        vm.acceptAsIs()
        val after = vm.state.first { it.progress.verified == 2 }
        assertEquals("2026-08-20", after.activeDate)
        assertNull(after.held)
    }
}
