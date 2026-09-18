package app.markiro.handheld.feature.hub

import app.markiro.handheld.core.print.upsertAssigned
import app.markiro.handheld.core.storage.initializeRecoveryForTest
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
import app.markiro.handheld.core.storage.CodeEntity
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.InventoryFixtures
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.sync.SyncEngine
import app.markiro.handheld.core.sync.SyncTransport
import app.markiro.handheld.feature.shift.ShiftEntityFixtures
import app.markiro.handheld.feature.work.TeamRefresher
import app.markiro.handheld.feature.work.TeamState
import app.markiro.handheld.feature.signin.SessionHolder
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.cancel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.UnconfinedTestDispatcher
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

@OptIn(ExperimentalCoroutinesApi::class)
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
        db.initializeRecoveryForTest()
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

    private fun api(
        fail: Boolean = false,
        enter: suspend (String) -> ShiftDto = { throw UnsupportedOperationException() },
        bundle: suspend (String) -> ShiftBundleDto = { throw UnsupportedOperationException() },
    ) = object : StationApi {
        override suspend fun grantInventoryLeave(id: String, body: kotlinx.serialization.json.JsonObject): kotlinx.serialization.json.JsonObject = error("Unused")
        override suspend fun grantConfiguration(body: kotlinx.serialization.json.JsonObject): kotlinx.serialization.json.JsonObject = error("Unused")
        override suspend fun grantKeyset(): kotlinx.serialization.json.JsonObject = throw java.io.IOException("unconfigured")
        override suspend fun deviceGrant(body: kotlinx.serialization.json.JsonObject): kotlinx.serialization.json.JsonObject = throw java.io.IOException("unconfigured")
        override suspend fun taskGrant(body: kotlinx.serialization.json.JsonObject): kotlinx.serialization.json.JsonObject = throw java.io.IOException("unconfigured")
        override suspend fun grantReadiness(body: kotlinx.serialization.json.JsonObject): kotlinx.serialization.json.JsonObject = throw java.io.IOException("unconfigured")
        override suspend fun codeHistory(id: String, cursor: String?, snapshot: String?, limit: Int): app.markiro.handheld.core.network.ValidationHistoryPage = error("not used")
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
        override suspend fun enter(id: String): ShiftDto = enter(id)
        override suspend fun bundle(id: String): ShiftBundleDto = bundle(id)
        override suspend fun summary(id: String): ShiftSummaryDto = throw UnsupportedOperationException()
        override suspend fun lines(): LineListResponse = throw UnsupportedOperationException()
        override suspend fun resolveInventoryBarcode(body: ResolveTaskRequest): ResolveTaskResponse = throw UnsupportedOperationException()
        override suspend fun joinInventory(id: String, body: JoinInventoryRequest): InventoryManifestDto = throw UnsupportedOperationException()
        override suspend fun inventoryManifest(id: String): InventoryManifestDto = throw UnsupportedOperationException()
        override suspend fun inventoryCodes(id: String, cursor: String?, limit: Int): InventoryBundlePageDto = throw UnsupportedOperationException()
        override suspend fun leaveInventory(id: String, body: LeaveInventoryRequest): LeaveInventoryResponse = throw UnsupportedOperationException()
        override suspend fun writeoffBootstrap(): app.markiro.handheld.core.network.WriteoffBootstrapDto = error("Unused")
        override suspend fun boxRegistry(since: String?, until: String?, cursor: String?, limit: Int): app.markiro.handheld.core.network.BoxRegistryPageDto = error("Unused")
        override suspend fun palletBootstrap(): app.markiro.handheld.core.network.PalletBootstrapDto = error("Unused")
    }

    private fun vm(
        api: StationApi,
        team: TeamRefresher = TeamRefresher { null },
        tick: Flow<Unit> = flowOf(Unit),
        repository: app.markiro.handheld.feature.shift.ShiftRepository? = null,
    ): HubViewModel {
        val engine = SyncEngine(
            db, MetaStore(db), db.deviceConfigDao(), SyncTransport(OkHttpClient()) { "http://127.0.0.1:1/" },
            NetworkModule.strictJson(), engineScope,
        )
        val inventoryEngine = InventorySyncEngine(
            db, MetaStore(db), db.deviceConfigDao(), SyncTransport(OkHttpClient()) { "http://127.0.0.1:1/" },
            NetworkModule.strictJson(), engineScope,
        )
        val writeoffEngine = app.markiro.handheld.core.writeoff.WriteoffSyncEngine(
            db, MetaStore(db), SyncTransport(OkHttpClient()) { "http://127.0.0.1:1/" },
            NetworkModule.strictJson(), engineScope,
        )
        return main.track(
            HubViewModel(recovery = db.recovery,
                api, db.deviceConfigDao(), session, reachability, engine, db.shiftDao(), inventoryEngine, db.inventoryTaskDao(), db.printerDao(),
                BoxRepository(db), db.codeDao(), team, writeoffEngine, db.writeoffPermissionDao(),
                db.palletPermissionDao(), db.palletMembershipDao(),
                scannerLabel = { "встроенный" }, now = { clock }, tick = tick, shiftRepository = repository,
            ),
        )
    }

    private fun repository(api: StationApi) =
        app.markiro.handheld.feature.shift.ShiftRepository(api, db, NetworkModule.json(), app.markiro.handheld.core.box.SsccPool(db)) { clock }

    /**
     * Found on the emulator: the card led straight to the work screen without
     * `enter`, so a GLN, a serial block or a template changed in the cabinet
     * after entry never reached the device until the operator left the shift
     * and came back through the list. «Продолжить» is the list's own path now.
     */
    @Test
    fun continueReEntersTheShiftAndRefreshesItsBundle() = runTest {
        db.shiftDao().upsert(ShiftEntityFixtures.bundled("s1").copy(mode = "aggregation", boxCapacity = 20))
        db.deviceConfigDao().upsert(paired.copy(activeShiftId = "s1"))
        var entered = 0
        val api = api(
            enter = { entered++; dto("s1", "SEP26-001", "active").copy(mode = "aggregation", boxCapacity = 20) },
            bundle = {
                ShiftBundleDto(
                    shift = dto("s1", "SEP26-001", "active").copy(mode = "aggregation", boxCapacity = 20),
                    product = app.markiro.handheld.core.network.BundleProductDto("p1", "04600682000013", "Вода 0,5"),
                    sscc = app.markiro.handheld.core.network.BundleSsccDto("468008990", 0, 1, 100, null),
                )
            },
        )
        val model = vm(api, repository = repository(api))
        model.state.first { it.activeShiftId == "s1" }
        model.continueShift()
        assertEquals(HubEvent.Entered("s1"), model.events.first())
        assertEquals(1, entered)
        assertEquals("468008990", db.shiftDao().get("s1")?.ssccIssuerPrefix)
        assertNull(model.state.first { it.dialog == null }.dialog)
    }

    @Test
    fun aRefusedContinueShowsTheSameDialogAsTheList() = runTest {
        db.shiftDao().upsert(ShiftEntityFixtures.bundled("s1"))
        db.deviceConfigDao().upsert(paired.copy(activeShiftId = "s1"))
        val api = api(enter = {
            throw retrofit2.HttpException(
                retrofit2.Response.error<ShiftDto>(409, okhttp3.ResponseBody.create(null, """{"statusCode":409,"message":"Closed"}""")),
            )
        })
        val model = vm(api, repository = repository(api))
        model.state.first { it.activeShiftId == "s1" }
        model.continueShift()
        assertEquals(
            app.markiro.handheld.feature.shift.ShiftDialog.Closed,
            model.state.first { it.dialog != null && it.dialog != app.markiro.handheld.feature.shift.ShiftDialog.Entering }.dialog,
        )
        model.dismissDialog()
        assertNull(model.state.first { it.dialog == null }.dialog)
    }

    private fun pendingWriteoff(id: String, seq: Long) = app.markiro.handheld.core.storage.WriteoffOutboxEntity(
        documentId = id, deviceSeq = seq, operatorId = "op-1", reasonId = "r-1", reasonName = "Бой", unitCount = 1,
        boxCount = 0, requestJson = "{}", createdAt = "2026-09-14T10:00:00.000Z", state = "pending", orderNo = null,
        acceptedCount = null, conflictsJson = null, lastAttemptAt = null,
    )

    /** The hub is the one place an operator sees that a write-off is still owed. */
    @Test
    fun hubSumsWriteoffQueueAndReadsPermission() = runTest {
        db.writeoffPermissionDao().replaceAll(listOf(app.markiro.handheld.core.storage.WriteoffPermissionEntity("op-1", true)))
        db.writeoffOutboxDao().insert(pendingWriteoff("d-1", 1))
        val ui = vm(api()).state.first { it.writeoffPending == 1 }
        assertEquals(1, ui.queue)
        assertEquals(true, ui.canWriteoff)
    }

    /** An operator the mirror has never heard of is unknown, not refused. */
    @Test
    fun anUnmirroredOperatorLeavesThePermissionUnknown() = runTest {
        assertNull(vm(api()).state.first { it.operatorName.isNotEmpty() }.canWriteoff)
    }

    private fun membership(sscc: String) = app.markiro.handheld.core.storage.PalletMembershipEntity(
        palletId = "w1", sscc = sscc, addedAt = "2026-09-17T10:00:00.000Z", operatorId = "op-1",
        status = app.markiro.handheld.core.storage.MembershipStatus.PENDING, reason = null,
        winningPalletSscc = null, ackedAt = null, acknowledgedAt = null,
    )

    private suspend fun queueMemberships(count: Int) = repeat(count) { index ->
        db.palletMembershipDao().insert(membership("03460068200000001$index"))
    }

    /**
     * `pallet_memberships` is one of the sync engine's OWN channels, so its
     * rows are already in `SyncState.pending`. The hub added them a second time
     * and three queued boxes read as six owed rows -- an operator waiting for a
     * queue that never drains to what they can count on the pallet.
     */
    @Test
    fun queuedMembershipsAreCountedOnceInTheQueue() = runTest {
        queueMemberships(3)
        val engine = SyncEngine(
            db, MetaStore(db), db.deviceConfigDao(), SyncTransport(OkHttpClient()) { "http://127.0.0.1:1/" },
            NetworkModule.strictJson(), engineScope,
        )
        val owed = engine.state.first { it.pending == 3 }.pending
        val ui = vm(api()).state.first { it.palletsPending == 3 }
        assertEquals(owed, ui.queue)
        assertEquals(3, ui.palletsPending)
    }

    /** The tile's own count is unchanged by the queue fix: it still names the unsent boxes. */
    @Test
    fun theTileReadsThePermissionRowWhenItGrantsTheRight() = runTest {
        db.palletPermissionDao().replaceAll(
            listOf(app.markiro.handheld.core.storage.PalletPermissionEntity("op-1", true)),
        )
        queueMemberships(2)
        val ui = vm(api()).state.first { it.canBuildPallets == true }
        assertEquals(2, ui.palletsPending)
        assertEquals(2, ui.queue)
    }

    @Test
    fun aRefusedPermissionRowIsAHardNo() = runTest {
        db.palletPermissionDao().replaceAll(
            listOf(app.markiro.handheld.core.storage.PalletPermissionEntity("op-1", false)),
        )
        assertEquals(false, vm(api()).state.first { it.canBuildPallets != null }.canBuildPallets)
    }

    /** No row at all is «not mirrored yet», which is not the same answer as «нет прав». */
    @Test
    fun anOperatorWithoutAPalletPermissionRowStaysUnknown() = runTest {
        assertNull(vm(api()).state.first { it.operatorName.isNotEmpty() }.canBuildPallets)
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

    /**
     * «Выйти из смены» on the work screen only stamped `leftAt`, and the card
     * read `activeShiftId` alone -- so the operator came back to the hub and
     * found the shift still pinned with «Продолжить», contrary to the README
     * («Leaving or locally closing the shift removes the card»).
     */
    @Test
    fun leavingTheShiftRemovesTheCard() = runTest {
        db.shiftDao().upsert(ShiftEntityFixtures.bundled("s1"))
        db.deviceConfigDao().upsert(paired.copy(activeShiftId = "s1"))
        val repository = repository(api())
        val model = vm(api(), repository = repository)
        assertEquals("SEP26-001", model.state.first { it.activeShift != null }.continueShiftNumber)
        repository.leave("s1")
        val ui = model.state.first { it.activeShiftId == null }
        assertNull(ui.activeShift)
        assertNull(ui.continueShiftNumber)
    }

    @Test
    fun activeCardUsesTheJoinedShiftsMetadataAndObservesLocalAcceptedUnits() = runTest {
        val shift = ShiftEntityFixtures.bundled("s1").copy(productPrintName = "Вода 0,5 л", plannedQty = 3000, mode = "aggregation")
        db.shiftDao().upsert(shift)
        db.deviceConfigDao().upsert(paired.copy(activeShiftId = "s1"))
        val model = vm(api())
        val first = model.state.first { it.activeShift != null }.activeShift!!
        assertEquals(shift, first.shift)
        assertEquals(0, first.acceptedUnits)
        assertNull(first.summaryAt)
        db.codeDao().insert(CodeEntity("hash-1", "s1", "04600682000013", "one", "2026-09-12T10:00:00Z"))
        assertEquals(1, model.state.first { it.activeShift?.acceptedUnits == 1 }.activeShift?.acceptedUnits)
        db.deviceConfigDao().upsert(paired.copy(activeShiftId = null))
        assertNull(model.state.first { it.activeShiftId == null }.activeShift)
    }

    @Test
    fun aFailedRefreshKeepsTheLastSummaryButAnotherShiftNeverInheritsIt() = runTest {
        db.shiftDao().upsertAll(listOf(ShiftEntityFixtures.bundled("s1"), ShiftEntityFixtures.bundled("s2")))
        db.deviceConfigDao().upsert(paired.copy(activeShiftId = "s1"))
        val ticks = MutableSharedFlow<Unit>(replay = 1).apply { tryEmit(Unit) }
        var result: TeamState? = TeamState(emptyList(), 2, 123L)
        var calls = 0
        val model = vm(api(), TeamRefresher { calls++; result }, ticks)
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { model.state.collect() }
        assertEquals(2, model.state.first { it.activeShift?.summaryAt == 123L }.activeShift?.acceptedUnits)
        result = null
        ticks.emit(Unit)
        runCurrent()
        assertEquals(2, calls)
        assertEquals(123L, model.state.value.activeShift?.summaryAt)
        repeat(3) { index ->
            db.codeDao().insert(CodeEntity("hash-$index", "s1", "04600682000013", "$index", "2026-09-12T10:00:00Z"))
        }
        assertEquals(123L, model.state.first { it.activeShift?.acceptedUnits == 3 }.activeShift?.summaryAt)
        db.deviceConfigDao().upsert(paired.copy(activeShiftId = "s2"))
        val next = model.state.first { it.activeShiftId == "s2" }.activeShift!!
        assertEquals(0, next.acceptedUnits)
        assertNull(next.summaryAt)
        db.shiftDao().setStatus("s2", "closed")
        assertNull(model.state.first { it.activeShiftId == null }.activeShift)
    }

    @Test
    fun aSummaryWithoutAnAcceptedUnitTotalKeepsTheCountExplicitlyLocal() = runTest {
        db.shiftDao().upsert(ShiftEntityFixtures.bundled("s1").copy(mode = "aggregation"))
        db.deviceConfigDao().upsert(paired.copy(activeShiftId = "s1"))
        db.codeDao().insert(CodeEntity("hash-1", "s1", "04600682000013", "one", "2026-09-12T10:00:00Z"))
        var fetched = false
        val model = vm(api(), TeamRefresher { fetched = true; TeamState(emptyList(), null, 123L) })
        val active = model.state.first { it.activeShift != null }.activeShift!!
        runCurrent()
        assertEquals(true, fetched)
        assertEquals(1, active.acceptedUnits)
        assertNull(model.state.value.activeShift?.summaryAt)
    }

    @Test
    fun summaryPollingStopsWhenTheHubHasNoVisibleSubscriber() = runTest {
        db.shiftDao().upsert(ShiftEntityFixtures.bundled("s1"))
        db.deviceConfigDao().upsert(paired.copy(activeShiftId = "s1"))
        val ticks = MutableSharedFlow<Unit>(replay = 1).apply { tryEmit(Unit) }
        val model = vm(api(), TeamRefresher { TeamState(emptyList(), 1, 123L) }, ticks)
        model.state.first { it.activeShift?.summaryAt == 123L }
        advanceTimeBy(5_001)
        runCurrent()
        assertEquals(0, ticks.subscriptionCount.value)
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
        db.printerDao().upsertAssigned(
            PrinterEntity(
                id = "p1", name = "Zebra ZD421", transport = "wifi", address = "192.168.1.40:9100",
                language = "zpl", dpi = 203, selected = true, lastStatus = "ready", lastSeenAt = 1L,
            ),
        )
        assertEquals(true, model.state.first { it.printerConfigured }.printerConfigured)
    }
}
