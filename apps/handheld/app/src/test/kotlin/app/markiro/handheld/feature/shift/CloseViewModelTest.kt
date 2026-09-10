package app.markiro.handheld.feature.shift

import androidx.lifecycle.SavedStateHandle
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.MainDispatcherRule
import app.markiro.handheld.core.network.NetworkModule
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.sync.SyncEngine
import app.markiro.handheld.core.sync.SyncTransport
import app.markiro.handheld.feature.signin.SessionHolder
import kotlinx.coroutines.cancel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class CloseViewModelTest {
    @get:Rule
    val main = MainDispatcherRule()

    private lateinit var db: HandheldDatabase
    private lateinit var server: MockWebServer

    /**
     * The engines below publish their state with an eagerly started flow, which keeps reading Room
     * for as long as its scope lives. Left running past the database it reads, it throws into
     * whichever test happens to run next, so the scope is owned here and cancelled before the close.
     */
    private val engineScope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)

    @Before
    fun setUp() = runTest {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        server = MockWebServer().also { it.start() }
        db.deviceConfigDao().upsert(
            DeviceConfigEntity(
                deviceId = "dev-1", deviceName = "ТСД", tenantId = "t", organizationName = "ООО", lineId = "l1", lineName = "Линия 2",
                kind = "handheld", serverUrl = "http://x", pairedAt = 1L, activeShiftId = "s1",
            ),
        )
        db.shiftDao().upsert(ShiftEntityFixtures.bundled("s1").copy(plannedQty = 5))
    }

    @After
    fun tearDown() {
        engineScope.cancel()
        server.shutdown()
        db.close()
    }

    private fun vm(): CloseViewModel {
        val engine = SyncEngine(
            db, MetaStore(db.metaDao()), db.deviceConfigDao(), SyncTransport(OkHttpClient()) { server.url("/").toString() },
            NetworkModule.strictJson(), engineScope,
        )
        return CloseViewModel(SavedStateHandle(mapOf("shiftId" to "s1")), ShiftCloser(db), engine, db, SessionHolder())
    }

    @Test
    fun planMissRequiresAReasonThenDrainsAndReportsAccepted() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"outcome":"accepted"}"""))
        val vm = vm()
        assertTrue(vm.step.first { it !is CloseStep.Loading } is CloseStep.Confirm)
        vm.confirm()
        assertTrue(vm.step.first { it !is CloseStep.Confirm } is CloseStep.Reason)
        vm.selectReason("equipment_stop")
        vm.submitReason()
        val summary = vm.step.first { it is CloseStep.Summary } as CloseStep.Summary
        assertEquals(CloseOutcome.ACCEPTED, summary.outcome)
        assertEquals("/station/shift-closures", server.takeRequest().path)
    }

    @Test
    fun offlineCloseEndsInPending() = runTest {
        server.shutdown()
        db.shiftDao().upsert(ShiftEntityFixtures.bundled("s1").copy(plannedQty = null))
        val vm = vm()
        vm.step.first { it is CloseStep.Confirm }
        vm.confirm()
        assertEquals(CloseOutcome.PENDING, (vm.step.first { it is CloseStep.Summary } as CloseStep.Summary).outcome)
        assertEquals("pending", db.shiftCloseDao().forShift("s1")?.state)
    }

    @Test
    fun conflictIsReported() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"outcome":"conflict","conflictCode":"multiple_devices"}"""))
        db.shiftDao().upsert(ShiftEntityFixtures.bundled("s1").copy(plannedQty = null))
        val vm = vm()
        vm.step.first { it is CloseStep.Confirm }
        vm.confirm()
        assertEquals(CloseOutcome.CONFLICT, (vm.step.first { it is CloseStep.Summary } as CloseStep.Summary).outcome)
    }
}
