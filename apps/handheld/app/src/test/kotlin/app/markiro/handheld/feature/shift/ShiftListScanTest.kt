package app.markiro.handheld.feature.shift

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.MainDispatcherRule
import app.markiro.handheld.core.box.SsccPool
import app.markiro.handheld.core.network.BoxRegistryPageDto
import app.markiro.handheld.core.network.BundleProductDto
import app.markiro.handheld.core.network.IdentityResponse
import app.markiro.handheld.core.network.InventoryBundlePageDto
import app.markiro.handheld.core.network.InventoryManifestDto
import app.markiro.handheld.core.network.InventoryTaskListResponse
import app.markiro.handheld.core.network.JoinInventoryRequest
import app.markiro.handheld.core.network.LeaveInventoryRequest
import app.markiro.handheld.core.network.LeaveInventoryResponse
import app.markiro.handheld.core.network.LineDto
import app.markiro.handheld.core.network.LineListResponse
import app.markiro.handheld.core.network.NetworkModule
import app.markiro.handheld.core.network.PalletBootstrapDto
import app.markiro.handheld.core.network.ReachabilityTracker
import app.markiro.handheld.core.network.ResolveTaskRequest
import app.markiro.handheld.core.network.ResolveTaskResponse
import app.markiro.handheld.core.network.RosterResponse
import app.markiro.handheld.core.network.ShiftBundleDto
import app.markiro.handheld.core.network.ShiftDto
import app.markiro.handheld.core.network.ShiftEntryRequest
import app.markiro.handheld.core.network.ShiftListResponse
import app.markiro.handheld.core.network.ShiftSummaryDto
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.network.ValidationHistoryPage
import app.markiro.handheld.core.network.ValidationPrintDto
import app.markiro.handheld.core.network.WriteoffBootstrapDto
import app.markiro.handheld.core.scan.ScanEvent
import app.markiro.handheld.core.scan.ScanEvents
import app.markiro.handheld.core.scan.ScanRouterAdapter
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

private const val OWN_LINE = "l1"
private const val OTHER_LINE = "l2"

/**
 * A hand-written `StationApi` fake rather than `MockWebServer`: the shift list
 * and the entry it produces are the only calls this slice exercises, and the
 * point of these tests is the view model's local resolution, not HTTP framing.
 */
private class FakeStationApi(shifts: List<ShiftDto>) : StationApi {
    private val byId = shifts.associateBy { it.id }.toMutableMap()

    var enteredShiftId: String? = null
        private set
    var lastEnterBody: ShiftEntryRequest? = null
        private set

    /**
     * Mirrors the server's own scoping (`shifts.controller.ts`): a line-less
     * query returns only this device's own line plus unassigned shifts, and a
     * scoped query returns only that line. Until this honoured `lineId`, the
     * ordinary line-less refresh silently mirrored every other line's shifts
     * into Room too, which is not what the real backend does and hid the
     * exact defect these tests exist to catch.
     */
    override suspend fun shifts(status: String?, lineId: String?): ShiftListResponse {
        val items = byId.values.toList()
        val scoped = if (lineId != null) {
            items.filter { it.lineId == lineId }
        } else {
            items.filter { it.lineId == OWN_LINE || it.lineId == null }
        }
        return ShiftListResponse(scoped)
    }

    override suspend fun enter(id: String, body: ShiftEntryRequest): ShiftDto {
        enteredShiftId = id
        lastEnterBody = body
        val entered = byId.getValue(id).copy(status = "active")
        byId[id] = entered
        return entered
    }

    override suspend fun bundle(id: String): ShiftBundleDto {
        val shift = byId.getValue(id)
        return ShiftBundleDto(shift = shift, product = BundleProductDto(shift.productId, "04600682000013", "Вода 0,5"))
    }

    override suspend fun grantConfiguration(body: JsonObject): JsonObject = error("not used")
    override suspend fun grantKeyset(): JsonObject = error("not used")
    override suspend fun deviceGrant(body: JsonObject): JsonObject = error("not used")
    override suspend fun taskGrant(body: JsonObject): JsonObject = error("not used")
    override suspend fun grantReadiness(body: JsonObject): JsonObject = error("not used")
    override suspend fun identity(): IdentityResponse = error("not used")
    override suspend fun operators(): RosterResponse = error("not used")
    override suspend fun inventoryTasks(scope: String?): InventoryTaskListResponse = error("not used")
    override suspend fun resolveInventoryBarcode(body: ResolveTaskRequest): ResolveTaskResponse = error("not used")
    override suspend fun joinInventory(id: String, body: JoinInventoryRequest): InventoryManifestDto = error("not used")
    override suspend fun inventoryManifest(id: String): InventoryManifestDto = error("not used")
    override suspend fun inventoryCodes(id: String, cursor: String?, limit: Int): InventoryBundlePageDto = error("not used")
    override suspend fun leaveInventory(id: String, body: LeaveInventoryRequest): LeaveInventoryResponse = error("not used")
    override suspend fun grantInventoryLeave(id: String, body: JsonObject): JsonObject = error("not used")
    override suspend fun codeHistory(id: String, cursor: String?, snapshot: String?, limit: Int): ValidationHistoryPage = error("not used")
    override suspend fun summary(id: String): ShiftSummaryDto = error("not used")

    /** Every line a configured shift sits on, other than the device's own -- enough for `expandOthers()`. */
    override suspend fun lines(): LineListResponse =
        LineListResponse(byId.values.mapNotNull { it.lineId }.distinct().filter { it != OWN_LINE }.map { LineDto(it, "Линия $it") })
    override suspend fun writeoffBootstrap(): WriteoffBootstrapDto = error("not used")
    override suspend fun palletBootstrap(): PalletBootstrapDto = error("not used")
    override suspend fun boxRegistry(since: String?, until: String?, cursor: String?, limit: Int): BoxRegistryPageDto = error("not used")
}

@RunWith(AndroidJUnit4::class)
class ShiftListScanTest {
    @get:Rule
    val main = MainDispatcherRule()

    private lateinit var db: HandheldDatabase
    private val shiftId = "11111111-1111-4111-8111-111111111111"
    private val scans = MutableSharedFlow<ScanEvent>(extraBufferCapacity = 8)

    private fun scan(raw: String) = scans.tryEmit(ScanEvent(raw = raw, symbology = null, source = "test", at = 0L))

    @Before
    fun setUp() = runTest {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        db.deviceConfigDao().upsert(
            DeviceConfigEntity(
                deviceId = "dev-1", deviceName = "ТСД 1", tenantId = "t", organizationName = "ООО",
                lineId = OWN_LINE, lineName = "Линия 1", kind = "handheld", serverUrl = "http://x", pairedAt = 1L,
            ),
        )
        db.initializeRecoveryForTest()
    }

    @After
    fun tearDown() {
        main.cancelAndJoinModels()
        db.close()
    }

    private fun plannedShift(id: String, lineId: String?) = ShiftDto(
        id = id, number = "SEP26-001", status = "planned", mode = "validation",
        validationPrint = ValidationPrintDto("none"), productId = "p1", palletsEnabled = false,
        lineId = lineId, lineName = lineId?.let { "Линия $it" },
    )

    private fun closedShift(id: String) = plannedShift(id, OWN_LINE).copy(status = "closed")

    private fun viewModel(api: StationApi, scans: ScanEvents) = main.track(
        ShiftListViewModel(
            ShiftRepository(api, db, NetworkModule.json(), SsccPool(db)) { 1_757_500_000_000L },
            db.deviceConfigDao(),
            db.recovery,
            ReachabilityTracker { 1_757_500_000_000L },
            scans,
            flowOf(Unit),
        ),
    )

    /**
     * Waits for the first real `state` emission.
     *
     * `observeShifts()` and the initial refresh land through Room's own
     * executor thread, not the test's virtual clock -- `advanceUntilIdle`
     * alone races that real completion, and reading `state.value` too early
     * returns the `stateIn` seed rather than a value reflecting what the
     * scan-collector subscription and the refresh actually did.
     */
    private suspend fun ShiftListViewModel.settled() = state.first { !it.loading }

    /**
     * Expands the other-line groups and waits until the target shift is
     * actually inside one of them -- `expandOthers()` populates `others`
     * asynchronously through the fake, so this is the same seed-vs-real-
     * emission trap `settled()` guards against, one field over.
     */
    private suspend fun ShiftListViewModel.othersExpandedWith(id: String) {
        expandOthers()
        state.first { ui -> ui.others.any { line -> line.shifts.any { it.id == id } } }
    }

    @Test
    fun `scanned shift of this line is entered with the barcode entry method`() = runTest {
        val api = FakeStationApi(shifts = listOf(plannedShift(shiftId, OWN_LINE)))
        val model = viewModel(api, ScanRouterAdapter(scans))
        model.settled()

        scan("markiro:shift:v1:$shiftId")
        // `enter` re-fetches through the fake and persists via Room the same way; see `settled`.
        model.state.first { it.continueShift?.id == shiftId }

        assertEquals(shiftId, api.enteredShiftId)
        assertEquals("task_barcode", api.lastEnterBody?.entryMethod)
    }

    @Test
    fun `scanned shift of another line asks for confirmation instead of entering`() = runTest {
        val api = FakeStationApi(shifts = listOf(plannedShift(shiftId, OTHER_LINE)))
        val model = viewModel(api, ScanRouterAdapter(scans))
        model.settled()
        // Own-line shifts only, exactly as the server's line-less list scopes it --
        // this shift is visible to the operator only after expanding other lines.
        model.othersExpandedWith(shiftId)

        scan("markiro:shift:v1:$shiftId")
        val dialog = model.state.first { it.dialog != null }.dialog

        assertTrue(dialog is ShiftDialog.ConfirmOther)
        assertNull(api.enteredShiftId)
    }

    @Test
    fun `confirming a scan-opened other-line dialog still sends the barcode entry method`() = runTest {
        val api = FakeStationApi(shifts = listOf(plannedShift(shiftId, OTHER_LINE)))
        val model = viewModel(api, ScanRouterAdapter(scans))
        model.settled()
        model.othersExpandedWith(shiftId)

        scan("markiro:shift:v1:$shiftId")
        model.state.first { it.dialog is ShiftDialog.ConfirmOther }
        model.confirmOther()
        model.state.first { it.continueShift?.id == shiftId }

        assertEquals(shiftId, api.enteredShiftId)
        assertEquals("task_barcode", api.lastEnterBody?.entryMethod)
    }

    /**
     * The exact regression this defect needs: a shift the ordinary line-less
     * refresh never mirrors into Room, made visible only by expanding other
     * lines. Before `onScan` also searched `others`, this scan reported
     * `BarcodeUnknown` even though the shift was sitting right there on
     * screen -- `repository.listed(...)` was the only place it looked, and an
     * other-line shift is never in that table.
     */
    @Test
    fun `scan of a shift visible only after expanding other lines opens confirmation, not unknown`() = runTest {
        val api = FakeStationApi(shifts = listOf(plannedShift(shiftId, OTHER_LINE)))
        val model = viewModel(api, ScanRouterAdapter(scans))
        model.settled()

        // The ordinary line-less refresh must not have mirrored the other
        // line's shift -- reintroducing that gap is exactly what let the old,
        // `lineId`-blind fake hide this defect: every test scan resolved
        // through Room regardless of which line actually owned the shift.
        assertNull(db.shiftDao().get(shiftId))
        assertTrue(model.state.value.mine.none { it.id == shiftId })

        model.othersExpandedWith(shiftId)

        scan("markiro:shift:v1:$shiftId")
        val dialog = model.state.first { it.dialog != null }.dialog

        assertTrue(dialog is ShiftDialog.ConfirmOther)
        assertNull(api.enteredShiftId)
    }

    @Test
    fun `scanned closed shift shows the closed dialog`() = runTest {
        val api = FakeStationApi(shifts = listOf(closedShift(shiftId)))
        val model = viewModel(api, ScanRouterAdapter(scans))
        model.settled()

        scan("markiro:shift:v1:$shiftId")
        val dialog = model.state.first { it.dialog != null }.dialog

        assertEquals(ShiftDialog.Closed, dialog)
    }

    @Test
    fun `scan of a shift missing from the list shows the unknown-barcode dialog`() = runTest {
        val api = FakeStationApi(shifts = emptyList())
        val model = viewModel(api, ScanRouterAdapter(scans))
        model.settled()

        scan("markiro:shift:v1:$shiftId")
        val dialog = model.state.first { it.dialog != null }.dialog

        assertEquals(ShiftDialog.BarcodeUnknown, dialog)
    }

    @Test
    fun `scan is ignored while a dialog is open`() = runTest {
        val api = FakeStationApi(shifts = listOf(plannedShift(shiftId, OWN_LINE)))
        val model = viewModel(api, ScanRouterAdapter(scans))
        model.settled()
        model.selectOther(plannedShift("other-shift", OTHER_LINE), "Линия 2")
        // `selectOther` mutates the raw dialog flow directly; wait for `state`'s
        // `combine` to actually pick it up before treating it as the baseline
        // the scan must leave alone (same seed-vs-real-emission trap as `settled`).
        model.state.first { it.dialog is ShiftDialog.ConfirmOther }

        scan("markiro:shift:v1:$shiftId")
        advanceUntilIdle()

        assertNull(api.enteredShiftId)
        // Untouched, not merely absent of entry -- the open dialog is exactly
        // what the scan was supposed to leave alone.
        assertTrue(model.state.value.dialog is ShiftDialog.ConfirmOther)
    }

    @Test
    fun `production code scan is ignored and opens no dialog`() = runTest {
        val api = FakeStationApi(shifts = listOf(plannedShift(shiftId, OWN_LINE)))
        val model = viewModel(api, ScanRouterAdapter(scans))
        model.settled()

        scan("010468008990038321ABC93XYZ")
        advanceUntilIdle()

        assertNull(api.enteredShiftId)
        assertNull(model.state.value.dialog)
    }
}
