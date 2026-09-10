package app.markiro.handheld.feature.work

import androidx.lifecycle.SavedStateHandle
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.MainDispatcherRule
import app.markiro.handheld.core.auth.OperatorRecord
import app.markiro.handheld.core.km.Verdict
import app.markiro.handheld.core.network.NetworkModule
import app.markiro.handheld.core.network.ReachabilityTracker
import app.markiro.handheld.core.scan.ScanEvent
import app.markiro.handheld.core.scan.ScanRecorder
import app.markiro.handheld.core.scan.ScanRouterAdapter
import app.markiro.handheld.core.signal.SignalKind
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.sync.SyncEngine
import app.markiro.handheld.core.sync.SyncTransport
import app.markiro.handheld.feature.shift.ShiftEntityFixtures
import app.markiro.handheld.feature.signin.SessionHolder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class WorkViewModelTest {
    @get:Rule
    val main = MainDispatcherRule()

    private lateinit var db: HandheldDatabase
    private val scans = MutableSharedFlow<ScanEvent>(extraBufferCapacity = 8)
    private val played = mutableListOf<SignalKind>()
    private val session = SessionHolder().apply { signIn(OperatorRecord("op-1", "Иванова Анна", "4127", "operator", "x", null, true)) }
    private val gs = "\u001d"

    @Before
    fun setUp() = runTest {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        db.deviceConfigDao().upsert(
            DeviceConfigEntity(
                deviceId = "dev-1", deviceName = "ТСД", tenantId = "t", organizationName = "ООО", lineId = "l1", lineName = "Линия 2",
                kind = "handheld", serverUrl = "http://x", pairedAt = 1L, activeShiftId = "s1",
            ),
        )
        db.shiftDao().upsert(ShiftEntityFixtures.bundled("s1"))
    }

    @After
    fun tearDown() = db.close()

    private fun vm(team: TeamRefresher = TeamRefresher { null }): WorkViewModel {
        val engine = SyncEngine(
            db, MetaStore(db.metaDao()), db.deviceConfigDao(), SyncTransport(OkHttpClient()) { "http://127.0.0.1:1/" },
            NetworkModule.strictJson(), CoroutineScope(SupervisorJob() + Dispatchers.Unconfined),
        )
        return WorkViewModel(
            SavedStateHandle(mapOf("shiftId" to "s1")), db, ScanRecorder(db), ScanRouterAdapter(scans),
            { kind -> played += kind }, engine, session, ReachabilityTracker(), team, null, flowOf(Unit),
        )
    }

    @Test
    fun scansUpdateTheLastZoneCountersAndFeed() = runTest {
        val vm = vm()
        advanceUntilIdle()
        scans.tryEmit(ScanEvent("010460068200001321abc${gs}93AAAA", null, "debug", 0))
        advanceUntilIdle()
        assertEquals(Verdict.OK, vm.state.first { it.last != null }.last?.verdict)
        assertEquals("abc", vm.state.value.last?.tail)
        assertEquals(1, vm.state.first { it.thisTerminal == 1 }.thisTerminal)
        scans.tryEmit(ScanEvent("010460068200001321abc${gs}93BBBB", null, "debug", 0))
        advanceUntilIdle()
        scans.tryEmit(ScanEvent("010460000000001521x", null, "debug", 0))
        advanceUntilIdle()
        scans.tryEmit(ScanEvent("garbage", null, "debug", 0))
        advanceUntilIdle()
        val s = vm.state.first { it.feed.size == 4 && it.errors == 2 }
        assertEquals(Verdict.INVALID, s.last?.verdict)
        assertEquals(1, s.thisTerminal)
        assertEquals(2, s.errors)
        assertEquals(1, s.duplicates)
        assertEquals(listOf(SignalKind.OK, SignalKind.DUPLICATE, SignalKind.ERROR, SignalKind.ERROR), played)
        assertNotNull(db.outboxDao().head(1).firstOrNull())
    }

    @Test
    fun totalNeverLagsBehindThisTerminal() = runTest {
        val vm = vm(team = TeamRefresher { TeamState(emptyList(), acceptedUnits = 0, at = 1L) })
        advanceUntilIdle()
        assertEquals(0, vm.state.first { it.team != null }.total)
        scans.tryEmit(ScanEvent("010460068200001321abc${gs}93AAAA", null, "debug", 0))
        advanceUntilIdle()
        assertEquals(1, vm.state.first { it.thisTerminal == 1 }.total)
    }

    @Test
    fun duplicateCarriesTheFirstSeenTime() = runTest {
        val vm = vm()
        advanceUntilIdle()
        scans.tryEmit(ScanEvent("010460068200001321dup", null, "debug", 0))
        advanceUntilIdle()
        scans.tryEmit(ScanEvent("010460068200001321dup", null, "debug", 0))
        advanceUntilIdle()
        val s = vm.state.first { it.last?.verdict == Verdict.DUPLICATE }
        assertNotNull(s.last?.firstSeenAt)
    }
}
