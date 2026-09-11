package app.markiro.handheld.feature.hub

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.MainDispatcherRule
import app.markiro.handheld.core.auth.OperatorRecord
import app.markiro.handheld.core.inventory.InventorySyncEngine
import app.markiro.handheld.core.network.IdentityResponse
import app.markiro.handheld.core.network.InventoryBundlePageDto
import app.markiro.handheld.core.network.InventoryManifestDto
import app.markiro.handheld.core.network.InventoryTaskDto
import app.markiro.handheld.core.network.InventoryTaskListResponse
import app.markiro.handheld.core.network.JoinInventoryRequest
import app.markiro.handheld.core.network.LeaveInventoryRequest
import app.markiro.handheld.core.network.LeaveInventoryResponse
import app.markiro.handheld.core.network.LineListResponse
import app.markiro.handheld.core.network.ResolveTaskRequest
import app.markiro.handheld.core.network.ResolveTaskResponse
import app.markiro.handheld.core.box.BoxRepository
import app.markiro.handheld.core.network.NetworkModule
import app.markiro.handheld.core.print.PrinterEntity
import app.markiro.handheld.core.network.ReachabilityTracker
import app.markiro.handheld.core.network.RosterResponse
import app.markiro.handheld.core.network.ShiftBundleDto
import app.markiro.handheld.core.network.ShiftDto
import app.markiro.handheld.core.network.ShiftListResponse
import app.markiro.handheld.core.network.ShiftSummaryDto
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.network.ValidationPrintDto
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.InventoryFixtures
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.sync.SyncEngine
import app.markiro.handheld.core.sync.SyncTransport
import app.markiro.handheld.feature.shift.ShiftEntityFixtures
import app.markiro.handheld.feature.signin.SessionHolder
import kotlinx.coroutines.cancel
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
        db.deviceConfigDao().upsert(paired)
    }

    @After
    fun tearDown() {
        try {
            main.cancelAndJoinModels()
        } finally {
            engineScope.cancel()
            db.close()
        }
    }

    private fun dto(id: String, number: String, status: String) =
        ShiftDto(id, number, status, mode = "validation", validationPrint = ValidationPrintDto("none"), productId = "p1", palletsEnabled = false)

    private fun api(fail: Boolean = false) = object : StationApi {
        override suspend fun identity(): IdentityResponse = throw UnsupportedOperationException()
        override suspend fun operators() = RosterResponse(emptyList())
        override suspend fun shifts(status: String?, lineId: String?): ShiftListResponse {
            if (fail) throw IOException("offline")
            return ShiftListResponse(
                listOf(dto("s1", "SEP26-001", "active"), dto("s2", "SEP26-002", "planned"), dto("s3", "SEP26-003", "closed")),
            )
        }
        override suspend fun inventoryTasks(scope: String?): InventoryTaskListResponse {
            if (fail) throw IOException("offline")
            return InventoryTaskListResponse(
                listOf(InventoryTaskDto("i1", "INV-0007", "Вода 0,5 л", null, "check", "line-2", "Линия 2", "2026-08-01", "2026-08-31")),
            )
        }
        override suspend fun enter(id: String): ShiftDto = throw UnsupportedOperationException()
        override suspend fun bundle(id: String): ShiftBundleDto = throw UnsupportedOperationException()
        override suspend fun summary(id: String): ShiftSummaryDto = throw UnsupportedOperationException()
        override suspend fun lines(): LineListResponse = throw UnsupportedOperationException()
        override suspend fun resolveInventoryBarcode(body: ResolveTaskRequest): ResolveTaskResponse = throw UnsupportedOperationException()
        override suspend fun joinInventory(id: String, body: JoinInventoryRequest): InventoryManifestDto = throw UnsupportedOperationException()
        override suspend fun inventoryManifest(id: String): InventoryManifestDto = throw UnsupportedOperationException()
        override suspend fun inventoryCodes(id: String, cursor: String?, limit: Int): InventoryBundlePageDto = throw UnsupportedOperationException()
        override suspend fun leaveInventory(id: String, body: LeaveInventoryRequest): LeaveInventoryResponse = throw UnsupportedOperationException()
    }

    private fun vm(api: StationApi): HubViewModel {
        val engine = SyncEngine(
            db, MetaStore(db.metaDao()), db.deviceConfigDao(), SyncTransport(OkHttpClient()) { "http://127.0.0.1:1/" },
            NetworkModule.strictJson(), engineScope,
        )
        val inventoryEngine = InventorySyncEngine(
            db, MetaStore(db.metaDao()), db.deviceConfigDao(), SyncTransport(OkHttpClient()) { "http://127.0.0.1:1/" },
            NetworkModule.strictJson(), engineScope,
        )
        return main.track(
            HubViewModel(
                api, db.deviceConfigDao(), session, reachability, engine, db.shiftDao(), inventoryEngine, db.inventoryTaskDao(), db.printerDao(),
                BoxRepository(db), scannerLabel = { "встроенный" }, now = { clock }, tick = flowOf(Unit),
            ),
        )
    }

    @Test
    fun anActiveInventoryIsPinnedForContinuing() = runTest {
        db.inventoryTaskDao().upsert(InventoryFixtures.task("i1"))
        db.deviceConfigDao().upsert(paired.copy(activeInventoryId = "i1"))
        val vm = vm(api())
        val ui = vm.state.first { it.activeInventoryId != null }
        assertEquals("INV-0007", ui.continueInventoryNumber)
        db.inventoryTaskDao().setState("i1", "closed")
        assertNull(vm.state.first { it.activeInventoryId == null }.continueInventoryNumber)
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

    @Test
    fun theHubKnowsWhetherAPrinterIsConfigured() = runTest {
        val model = vm(api())
        assertEquals(false, model.state.first { it.organization.isNotEmpty() }.printerConfigured)
        db.printerDao().upsert(
            PrinterEntity(
                id = "p1", name = "Zebra ZD421", transport = "wifi", address = "192.168.1.40:9100",
                language = "zpl", dpi = 203, selected = true, lastStatus = "ready", lastSeenAt = 1L,
            ),
        )
        assertEquals(true, model.state.first { it.printerConfigured }.printerConfigured)
    }
}
