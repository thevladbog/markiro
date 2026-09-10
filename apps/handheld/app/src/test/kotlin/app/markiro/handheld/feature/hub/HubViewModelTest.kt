package app.markiro.handheld.feature.hub

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.MainDispatcherRule
import app.markiro.handheld.core.auth.OperatorRecord
import app.markiro.handheld.core.network.IdentityResponse
import app.markiro.handheld.core.network.InventoryTaskDto
import app.markiro.handheld.core.network.InventoryTaskListResponse
import app.markiro.handheld.core.network.LineListResponse
import app.markiro.handheld.core.network.NetworkModule
import app.markiro.handheld.core.network.ReachabilityTracker
import app.markiro.handheld.core.network.RosterResponse
import app.markiro.handheld.core.network.ShiftBundleDto
import app.markiro.handheld.core.network.ShiftDto
import app.markiro.handheld.core.network.ShiftListResponse
import app.markiro.handheld.core.network.ShiftSummaryDto
import app.markiro.handheld.core.network.StationApi
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
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.IOException

@RunWith(AndroidJUnit4::class)
class HubViewModelTest {
    @get:Rule
    val main = MainDispatcherRule()

    private lateinit var db: HandheldDatabase
    private val session = SessionHolder().apply { signIn(OperatorRecord("op-1", "Иванова Анна", "4127", "operator", "x", null, true)) }
    private var clock = 1_000_000L
    private val reachability = ReachabilityTracker { clock }
    private val paired = DeviceConfigEntity(
        deviceId = "dev-1", deviceName = "ТСД 1", tenantId = "t-1", organizationName = "ООО «Родник»", lineId = "line-2",
        lineName = "Линия 2", kind = "handheld", serverUrl = "https://x", pairedAt = 1L,
    )

    @Before
    fun setUp() = runTest {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        db.deviceConfigDao().upsert(paired)
    }

    @After
    fun tearDown() = db.close()

    private fun api(fail: Boolean = false) = object : StationApi {
        override suspend fun identity(): IdentityResponse = throw UnsupportedOperationException()
        override suspend fun operators() = RosterResponse(emptyList())
        override suspend fun shifts(status: String?, lineId: String?): ShiftListResponse {
            if (fail) throw IOException("offline")
            return ShiftListResponse(
                listOf(ShiftDto("s1", "SEP26-001", "active"), ShiftDto("s2", "SEP26-002", "planned"), ShiftDto("s3", "SEP26-003", "closed")),
            )
        }
        override suspend fun inventoryTasks(): InventoryTaskListResponse {
            if (fail) throw IOException("offline")
            return InventoryTaskListResponse(listOf(InventoryTaskDto("i1", "7", "Вода 0,5 л")))
        }
        override suspend fun enter(id: String): ShiftDto = throw UnsupportedOperationException()
        override suspend fun bundle(id: String): ShiftBundleDto = throw UnsupportedOperationException()
        override suspend fun summary(id: String): ShiftSummaryDto = throw UnsupportedOperationException()
        override suspend fun lines(): LineListResponse = throw UnsupportedOperationException()
    }

    private fun vm(api: StationApi): HubViewModel {
        val engine = SyncEngine(
            db, MetaStore(db.metaDao()), db.deviceConfigDao(), SyncTransport(OkHttpClient()) { "http://127.0.0.1:1/" },
            NetworkModule.strictJson(), CoroutineScope(SupervisorJob() + Dispatchers.Unconfined),
        )
        return HubViewModel(
            api, db.deviceConfigDao(), session, reachability, engine, db.shiftDao(),
            scannerLabel = { "встроенный" }, now = { clock }, tick = flowOf(Unit),
        )
    }

    @Test
    fun refreshCountsOpenShiftsAndTasksAndStoresThem() = runTest {
        val vm = vm(api())
        vm.refresh()
        val ui = vm.state.first { it.shifts == 2 }
        assertEquals(1, ui.inventories)
        assertEquals("Иванова Анна", ui.operatorName)
        assertEquals("Линия 2", ui.lineName)
        assertEquals(2, db.deviceConfigDao().get()?.shiftsCount)
    }

    @Test
    fun offlineKeepsCachedCountsAndReportsUnreachable() = runTest {
        db.deviceConfigDao().upsert(paired.copy(shiftsCount = 3, inventoryCount = 0, countsAt = 900_000L))
        val vm = vm(api(fail = true))
        vm.refresh()
        val ui = vm.state.first { it.shifts == 3 }
        assertEquals(900_000L, ui.countsAt)
        assertEquals(false, ui.reachable)
    }

    @Test
    fun anActiveShiftIsPinnedForContinuing() = runTest {
        db.shiftDao().upsert(ShiftEntityFixtures.bundled("s1"))
        db.deviceConfigDao().upsert(paired.copy(activeShiftId = "s1"))
        val vm = vm(api())
        val ui = vm.state.first { it.activeShiftId != null }
        assertEquals("SEP26-001", ui.continueShiftNumber)
        db.shiftDao().setStatus("s1", "closed")
        assertNull(vm.state.first { it.activeShiftId == null }.continueShiftNumber)
    }

    @Test
    fun signOutClearsTheSession() = runTest {
        val vm = vm(api())
        vm.signOut()
        assertNull(session.state.value.operator)
    }
}
