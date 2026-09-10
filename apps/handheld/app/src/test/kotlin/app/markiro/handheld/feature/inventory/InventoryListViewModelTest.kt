package app.markiro.handheld.feature.inventory

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.cash.turbine.test
import app.markiro.handheld.MainDispatcherRule
import app.markiro.handheld.core.auth.OperatorRecord
import app.markiro.handheld.core.inventory.MirrorResult
import app.markiro.handheld.core.network.BundleLimitsDto
import app.markiro.handheld.core.network.InventoryManifestDto
import app.markiro.handheld.core.network.InventoryTaskDto
import app.markiro.handheld.core.network.ReachabilityTracker
import app.markiro.handheld.core.scan.ScanEvent
import app.markiro.handheld.core.scan.ScanRouterAdapter
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.InventoryFixtures
import app.markiro.handheld.feature.signin.SessionHolder
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.IOException
import kotlin.time.Duration.Companion.seconds

/**
 * The event probes below carry a generous budget on purpose. Turbine's wait is wall clock, not
 * virtual time, and joining a task does real work on Room's own threads, so a loaded machine can
 * outrun a short budget. The budget is a guard against a hang, not an assertion about latency.
 */
@RunWith(AndroidJUnit4::class)
class InventoryListViewModelTest {
    @get:Rule
    val main = MainDispatcherRule()

    private lateinit var db: HandheldDatabase
    private val scans = MutableSharedFlow<ScanEvent>(extraBufferCapacity = 4)
    private val session = SessionHolder().apply { signIn(OperatorRecord("op-1", "Иванова Анна", "4127", "operator", "x", null, true)) }
    private val reachability = ReachabilityTracker { 1_000_000L }
    private val own = InventoryTaskDto("i1", "INV-0007", "Вода 0,5 л", "Вода", "check", "l1", "Линия 2", "2026-08-01", "2026-08-31")
    private val other = InventoryTaskDto("i2", "INV-0008", "Сок", null, "check", "l3", "Линия 3", "2026-08-01", "2026-08-31")
    private val repack = InventoryTaskDto("i3", "INV-0009", "Сок", null, "repack", "l1", "Линия 2", "2026-08-01", "2026-08-31")

    /** Fake gateway: the view model only needs the repository's public surface. */
    private inner class FakeRepo(private val joinResult: JoinResult = JoinResult.Ok(manifestFor("i1")), var mirror: MirrorResult = MirrorResult.Active) : InventoryGateway {
        val joins = mutableListOf<Triple<String, Boolean, String?>>()
        override fun observeTasks() = db.inventoryTaskDao().observeAll()
        override suspend fun listTasks(scope: String?) = if (scope == "all") listOf(own, other, repack) else listOf(own, repack)
        override suspend fun resolveBarcode(barcode: String) = when {
            barcode.endsWith("i2") -> ResolvedTask(other, requiresConfirmation = true)
            barcode.endsWith("offline") -> throw IOException("no route")
            else -> null
        }
        override suspend fun join(task: InventoryTaskDto, operatorId: String, confirmDifferentLine: Boolean, barcode: String?): JoinResult {
            joins += Triple(task.inventoryId, confirmDifferentLine, barcode)
            return joinResult
        }
        override suspend fun manifest(inventoryId: String): InventoryManifestDto = manifestFor(inventoryId)
        override suspend fun download(manifest: InventoryManifestDto, onProgress: suspend (Int, Int) -> Unit): MirrorResult {
            onProgress(2, 4)
            return mirror
        }
        override suspend fun activate(inventoryId: String) {
            db.inventoryTaskDao().upsert(InventoryFixtures.task(inventoryId))
            db.deviceConfigDao().get()?.let { db.deviceConfigDao().upsert(it.copy(activeInventoryId = inventoryId)) }
        }
        override suspend fun leave(inventoryId: String): LeaveResult = LeaveResult.Left
        override suspend fun queued(inventoryId: String) = 0
    }

    private fun manifestFor(id: String) = InventoryManifestDto(
        inventoryId = id, inventoryNumber = "INV-0007", snapshotId = "snap", snapshotRevision = 1, snapshotFixedAt = "t", combinedDigest = "a".repeat(64),
        contentDigest = "b".repeat(64), codeCount = 4, productId = "p1", productName = "Вода 0,5 л", productPrintName = "Вода", gtin14 = "04600000000015",
        boxCapacity = 12, mode = "check", lineId = "l1", lineName = "Линия 2", productionDateFrom = "2026-08-01", productionDateTo = "2026-08-31",
        limits = BundleLimitsDto(200, 100, 200),
    )

    @Before
    fun setUp() = runTest {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java).allowMainThreadQueries().build()
        db.deviceConfigDao().upsert(
            DeviceConfigEntity(
                deviceId = "dev-1", deviceName = "ТСД 1", tenantId = "t", organizationName = "ООО", lineId = "l1", lineName = "Линия 2",
                kind = "handheld", serverUrl = "http://x", pairedAt = 1L,
            ),
        )
        reachability.markSuccess()
    }

    @After
    fun tearDown() = db.close()

    private fun vm(repo: FakeRepo = FakeRepo()) = InventoryListViewModel(repo, db.deviceConfigDao(), session, reachability, ScanRouterAdapter(scans))

    @Test
    fun listsOwnLineThenOthersOnRequest() = runTest {
        val vm = vm()
        val ui = vm.state.first { !it.loading }
        assertEquals(listOf("i1", "i3"), ui.mine.map { it.inventoryId })
        vm.expandOthers()
        val expanded = vm.state.first { it.othersExpanded && !it.othersLoading }
        assertEquals(mapOf("Линия 3" to listOf("i2")), expanded.others.mapValues { e -> e.value.map { it.inventoryId } })
    }

    @Test
    fun joiningOwnTaskDownloadsActivatesAndEmitsEntered() = runTest {
        val repo = FakeRepo()
        val vm = vm(repo)
        vm.state.first { !it.loading }
        vm.events.test(timeout = 60.seconds) {
            vm.select(own)
            assertEquals(InventoryListEvent.Entered("i1"), awaitItem())
        }
        assertEquals(listOf(Triple("i1", false, null)), repo.joins)
        assertEquals("i1", db.deviceConfigDao().get()?.activeInventoryId)
    }

    @Test
    fun anotherLineAsksForConfirmationAndRepackIsIgnored() = runTest {
        val repo = FakeRepo()
        val vm = vm(repo)
        vm.state.first { !it.loading }
        vm.select(repack)
        advanceUntilIdle()
        assertTrue(repo.joins.isEmpty())
        vm.select(other)
        assertTrue(vm.state.first { it.dialog != null }.dialog is InventoryDialog.ConfirmOther)
        vm.events.test(timeout = 60.seconds) {
            vm.confirmOther()
            assertEquals(InventoryListEvent.Entered("i2"), awaitItem())
        }
        assertEquals(Triple("i2", true, null), repo.joins.single())
    }

    @Test
    fun aTaskBarcodeResolvesAndJoinsWithTheBarcode() = runTest {
        val repo = FakeRepo()
        val vm = vm(repo)
        vm.state.first { !it.loading }
        scans.tryEmit(ScanEvent("markiro:inventory:v1:i2", null, "debug", 0))
        advanceUntilIdle()
        assertTrue(vm.state.first { it.dialog != null }.dialog is InventoryDialog.ConfirmOther)
        vm.confirmOther()
        advanceUntilIdle()
        assertEquals(Triple("i2", true, "markiro:inventory:v1:i2"), repo.joins.single())
    }

    @Test
    fun aBarcodeLookupTellsAnUnknownLabelFromAMissingNetwork() = runTest {
        val vm = vm()
        vm.state.first { !it.loading }
        scans.tryEmit(ScanEvent("markiro:inventory:v1:zz", null, "debug", 0))
        assertEquals(InventoryError.BARCODE_UNKNOWN, (vm.state.first { it.dialog != null }.dialog as InventoryDialog.Error).kind)
        vm.dismissDialog()
        vm.state.first { it.dialog == null }
        scans.tryEmit(ScanEvent("markiro:inventory:v1:offline", null, "debug", 0))
        assertEquals(InventoryError.NEEDS_NETWORK, (vm.state.first { it.dialog != null }.dialog as InventoryDialog.Error).kind)
    }

    @Test
    fun anInvalidSnapshotShowsTheReasonAndDoesNotActivate() = runTest {
        val repo = FakeRepo(mirror = MirrorResult.Invalid("content digest"))
        val vm = vm(repo)
        vm.state.first { !it.loading }
        vm.select(own)
        val ui = vm.state.first { it.dialog is InventoryDialog.Error }
        assertEquals(InventoryError.INVALID_SNAPSHOT, (ui.dialog as InventoryDialog.Error).kind)
        assertNull(db.deviceConfigDao().get()?.activeInventoryId)
    }
}
