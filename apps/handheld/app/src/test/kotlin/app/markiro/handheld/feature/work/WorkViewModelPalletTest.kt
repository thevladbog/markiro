package app.markiro.handheld.feature.work

import app.markiro.handheld.core.storage.initializeRecoveryForTest
import androidx.lifecycle.SavedStateHandle
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.MainDispatcherRule
import app.markiro.handheld.core.auth.OperatorRecord
import app.markiro.handheld.core.box.BoxPrinter
import app.markiro.handheld.core.box.BoxRepository
import app.markiro.handheld.core.box.CloseBox
import app.markiro.handheld.core.box.ClosePallet
import app.markiro.handheld.core.box.ClosePalletResult
import app.markiro.handheld.core.box.PalletLock
import app.markiro.handheld.core.box.PalletPrinter
import app.markiro.handheld.core.box.PalletRepository
import app.markiro.handheld.core.box.PrintReason
import app.markiro.handheld.core.box.ServerRange
import app.markiro.handheld.core.box.SsccPool
import app.markiro.handheld.core.duplicate.DuplicateJobs
import app.markiro.handheld.core.exceptions.ExceptionEngine
import app.markiro.handheld.core.label.LabelRenderer
import app.markiro.handheld.core.label.RasterResult
import app.markiro.handheld.core.label.RasterizeText
import app.markiro.handheld.core.network.NetworkModule
import app.markiro.handheld.core.network.ReachabilityTracker
import app.markiro.handheld.core.print.PrinterEntity
import app.markiro.handheld.core.print.PrinterStatus
import app.markiro.handheld.core.print.PrinterTransport
import app.markiro.handheld.core.print.SendOutcome
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
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 06d's pallet strip, pallet-close screen and «Закрыть паллету досрочно» from
 * the `WorkViewModel` side. `ClosePalletTest` already covers the domain layer
 * (`CloseBox`/`ClosePallet`/`PalletRepository`) in isolation; this file checks
 * that the view model actually reads `CloseResult.Closed.pallet`, prints the
 * pallet's own label, and resets the strip -- none of which `ClosePalletTest`
 * can see, because it never touches `WorkViewModel`.
 */
@RunWith(AndroidJUnit4::class)
class WorkViewModelPalletTest {
    @get:Rule
    val main = MainDispatcherRule()

    private lateinit var db: HandheldDatabase
    private val scans = MutableSharedFlow<ScanEvent>(extraBufferCapacity = 8)
    private val played = mutableListOf<SignalKind>()
    private val session = SessionHolder().apply { signIn(OperatorRecord("op-1", "Иванова Анна", "4127", "operator", "x", null, true)) }
    private val rasterize = RasterizeText { _, _ -> RasterResult("AA", 1, 1, 8, 8) }

    private class FakeTransport(
        var nextStatus: PrinterStatus = PrinterStatus.Ready,
        var outcome: SendOutcome = SendOutcome.Delivered,
    ) : PrinterTransport {
        var sent = 0
        override suspend fun status(printer: PrinterEntity) = nextStatus
        override suspend fun send(printer: PrinterEntity, document: ByteArray): SendOutcome {
            sent++
            return outcome
        }
    }

    private val transport = FakeTransport()

    /** See `WorkViewModelTest` for why this scope is owned and cancelled here rather than left implicit. */
    private val engineScope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)

    private companion object {
        const val PREFIX = "468008990"
    }

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
        db.initializeRecoveryForTest()
    }

    @After
    fun tearDown() {
        // #506's guard: `finished()` runs after `@After`, so a tracked model
        // left collecting would meet a closed Room pool and fail whichever test
        // ran next. Cancel first, close second.
        try {
            main.cancelAndJoinModels()
        } finally {
            engineScope.cancel()
            db.close()
        }
    }

    /** An aggregation shift with pallets enabled (06d): every scan closes a box unless `boxCapacity` says otherwise. */
    private suspend fun aggregatingWithPallets(boxCapacity: Int = 1, palletBoxCapacity: Int = 12, withPrinter: Boolean = true) {
        db.shiftDao().upsert(
            ShiftEntityFixtures.bundled("s1").copy(
                mode = "aggregation",
                boxCapacity = boxCapacity,
                palletsEnabled = true,
                palletBoxCapacity = palletBoxCapacity,
                productName = "Вода",
                shelfLifeDays = 365,
                ssccIssuerPrefix = PREFIX,
                boxLabelTemplate = """{"widthMm":58,"heightMm":40,"dpi":203,"language":"zpl","elements":[]}""",
                palletLabelTemplateSpec = """{"widthMm":100,"heightMm":150,"dpi":203,"language":"zpl","elements":[]}""",
            ),
        )
        SsccPool(db).addRange(ServerRange(PREFIX, SsccPool.BOX_EXTENSION_DIGIT, 1, 200, null))
        SsccPool(db).addRange(ServerRange(PREFIX, SsccPool.PALLET_EXTENSION_DIGIT, 1, 200, null))
        if (withPrinter) {
            db.printerDao().upsert(
                PrinterEntity(
                    id = "p1", name = "Zebra", transport = "wifi", address = "127.0.0.1:9100",
                    language = "zpl", dpi = 203, selected = true, lastStatus = null, lastSeenAt = null,
                ),
            )
        }
    }

    private fun vm(): WorkViewModel {
        val engine = SyncEngine(
            db, MetaStore(db), db.deviceConfigDao(), SyncTransport(OkHttpClient()) { "http://127.0.0.1:1/" },
            NetworkModule.strictJson(), engineScope,
        )
        val boxes = BoxRepository(db)
        val pool = SsccPool(db)
        val palletLock = PalletLock(db)
        val pallets = PalletRepository(db, palletLock)
        val closePallet = ClosePallet(db, pool, palletLock)
        val palletPrinter = PalletPrinter(db, pallets, LabelRenderer(rasterize), transport)
        return main.track(
            WorkViewModel(
                SavedStateHandle(mapOf("shiftId" to "s1")), db, ScanRecorder(db), ScanRouterAdapter(scans),
                { kind -> played += kind }, engine, session, ReachabilityTracker(), TeamRefresher { null }, null,
                boxes, CloseBox(db, boxes, pool, pallets, closePallet, palletLock),
                BoxPrinter(db, boxes, LabelRenderer(rasterize), transport),
                DuplicateJobs(db, LabelRenderer(rasterize), transport),
                pallets, closePallet, palletPrinter, ExceptionEngine(db), flowOf(Unit),
            ),
        )
    }

    private fun scan(serial: String) = scans.tryEmit(ScanEvent("010460068200001321$serial", null, "debug", 0))

    @Test
    fun aShiftWithPalletsShowsAnEmptyStripBeforeTheFirstBox() = runTest {
        aggregatingWithPallets(palletBoxCapacity = 12)
        val vm = vm()
        val pallet = vm.state.first { it.pallet != null }.pallet!!
        assertEquals(0, pallet.boxCount)
        assertEquals(12, pallet.capacity)
    }

    @Test
    fun aShiftWithNoPalletCapacityShowsNoStrip() = runTest {
        // The fixture shift carries no `palletBoxCapacity` at all.
        db.shiftDao().upsert(ShiftEntityFixtures.bundled("s1").copy(mode = "aggregation", boxCapacity = 5))
        val vm = vm()
        advanceUntilIdle()
        assertNull(vm.state.value.pallet)
    }

    @Test
    fun aClosedBoxJoinsThePalletAndTheStripCounts() = runTest {
        aggregatingWithPallets(palletBoxCapacity = 12)
        val vm = vm()
        advanceUntilIdle()
        scan("a")
        advanceUntilIdle()
        val pallet = vm.state.first { it.pallet?.boxCount == 1 }.pallet!!
        assertEquals(1, pallet.boxCount)
        assertEquals(12, pallet.capacity)
    }

    @Test
    fun theLastBoxClosesThePalletTooWithItsOwnSignalAndPrint() = runTest {
        aggregatingWithPallets(palletBoxCapacity = 2)
        val vm = vm()
        advanceUntilIdle()
        scan("a")
        advanceUntilIdle()
        scan("b")
        advanceUntilIdle()
        val step = vm.palletCloseStep.first { it is PalletCloseStep.Printed } as PalletCloseStep.Printed
        assertEquals(2, step.pallet.boxCount)
        // Pallet completion mirrors box completion (brief 10 §6): the SAME
        // signal, never a new one. Two scans closed two boxes here, and only the
        // SECOND one also closed the pallet -- so the count must be exactly 2
        // (one per completion), not 3, which is what a stray extra play on the
        // pallet-closing scan would produce.
        assertEquals(2, played.count { it == SignalKind.BOX_DONE })
        assertEquals(1, db.palletDao().unacked(10).size)
        // The strip resets against the shift's own capacity rather than vanishing.
        val pallet = vm.state.first { it.pallet?.boxCount == 0 }.pallet!!
        assertEquals(2, pallet.capacity)
    }

    @Test
    fun oneScanClosingBothTheBoxAndItsPalletPlaysTheCompletionSignalOnlyOnce() = runTest {
        // A shift where a box IS a pallet (both capacities are 1): the single scan
        // that fills the box also brings the pallet to capacity, so `closeAndPrint`
        // sees both outcomes at once. Before the fix, `onScan` played `BOX_DONE` for
        // the box and `handleClosedPallet` played it again for the pallet -- two
        // plays inside one scan, which is not a signal an operator watching the
        // stack (not the screen) can read as "done". This asserts the play COUNT,
        // not mere presence: a `.contains(...)` check cannot tell one play from two.
        aggregatingWithPallets(boxCapacity = 1, palletBoxCapacity = 1)
        val vm = vm()
        advanceUntilIdle()
        scan("a")
        advanceUntilIdle()
        vm.palletCloseStep.first { it is PalletCloseStep.Printed }
        assertEquals(1, played.count { it == SignalKind.BOX_DONE })
    }

    @Test
    fun statesTheBoxCountBeforeAnEarlyClose() = runTest {
        aggregatingWithPallets(palletBoxCapacity = 12)
        val vm = vm()
        advanceUntilIdle()
        scan("a")
        vm.state.first { it.pallet?.boxCount == 1 }
        scan("b")
        vm.state.first { it.pallet?.boxCount == 2 }
        scan("c")
        vm.state.first { it.pallet?.boxCount == 3 }
        vm.requestEarlyPalletClose()
        // `state` is a combined flow; a plain mutation needs a fresh emission
        // awaited, the same way every other combined field in this suite is
        // read, rather than trusting a `.value` snapshot taken with no
        // intervening suspension.
        val confirm = vm.state.first { it.palletConfirm != null }.palletConfirm
        assertEquals(3, confirm?.boxCount)
        assertEquals(12, confirm?.capacity)
        // Nothing closes just by asking.
        assertEquals(PalletCloseStep.Idle, vm.palletCloseStep.value)
    }

    @Test
    fun cancellingTheEarlyCloseLeavesThePalletOpen() = runTest {
        aggregatingWithPallets(palletBoxCapacity = 12)
        val vm = vm()
        advanceUntilIdle()
        scan("a")
        vm.state.first { it.pallet?.boxCount == 1 }
        vm.requestEarlyPalletClose()
        vm.state.first { it.palletConfirm != null }
        vm.cancelEarlyPalletClose()
        assertNull(vm.state.first { it.palletConfirm == null }.palletConfirm)
        assertEquals(PalletCloseStep.Idle, vm.palletCloseStep.value)
        assertEquals(1, vm.state.value.pallet?.boxCount)
    }

    @Test
    fun confirmingTheEarlyCloseNumbersWhatIsActuallyOnThePallet() = runTest {
        aggregatingWithPallets(palletBoxCapacity = 12)
        val vm = vm()
        advanceUntilIdle()
        scan("a")
        vm.state.first { it.pallet?.boxCount == 1 }
        scan("b")
        vm.state.first { it.pallet?.boxCount == 2 }
        vm.requestEarlyPalletClose()
        vm.confirmEarlyPalletClose()
        val step = vm.palletCloseStep.first { it is PalletCloseStep.Printed } as PalletCloseStep.Printed
        assertEquals(2, step.pallet.boxCount)
        assertTrue(played.contains(SignalKind.BOX_DONE))
    }

    @Test
    fun withNoPrinterBothTheBoxAndItsPalletAreOwed() = runTest {
        aggregatingWithPallets(boxCapacity = 1, palletBoxCapacity = 1, withPrinter = false)
        val vm = vm()
        advanceUntilIdle()
        scan("a")
        advanceUntilIdle()
        val step = vm.palletCloseStep.first { it is PalletCloseStep.Failed } as PalletCloseStep.Failed
        assertEquals(PrintReason.PRINTER_UNCONFIGURED, step.reason)
        // Both the box that closed and the pallet it just filled are owed a label.
        assertEquals(2, vm.state.first { it.unprintedLabels == 2 }.unprintedLabels)
    }

    @Test
    fun anUnknownPalletPrintNeverResendsOnItsOwn() = runTest {
        aggregatingWithPallets(boxCapacity = 1, palletBoxCapacity = 1)
        transport.outcome = SendOutcome.Unknown("link lost")
        val vm = vm()
        advanceUntilIdle()
        scan("a")
        advanceUntilIdle()
        vm.palletCloseStep.first { it is PalletCloseStep.Unknown }
        val sentSoFar = transport.sent
        vm.confirmPalletPrinted()
        assertEquals(PalletCloseStep.Idle, vm.palletCloseStep.value)
        // Confirming resolves it without sending anything more.
        assertEquals(sentSoFar, transport.sent)
    }

    @Test
    fun deferringAPalletLabelKeepsItInTheQueue() = runTest {
        aggregatingWithPallets(boxCapacity = 1, palletBoxCapacity = 1, withPrinter = false)
        val vm = vm()
        advanceUntilIdle()
        scan("a")
        advanceUntilIdle()
        vm.palletCloseStep.first { it is PalletCloseStep.Failed }
        vm.deferPalletLabel()
        assertEquals(PalletCloseStep.Idle, vm.palletCloseStep.value)
        // The box is also owed (no printer at all), so 2 rather than 1.
        assertEquals(2, vm.state.first { it.unprintedLabels == 2 }.unprintedLabels)
    }

    @Test
    fun aDryPalletPoolLeavesThePalletOpenAndSaysSo() = runTest {
        db.shiftDao().upsert(
            ShiftEntityFixtures.bundled("s1").copy(
                mode = "aggregation", boxCapacity = 1, palletsEnabled = true, palletBoxCapacity = 1,
                ssccIssuerPrefix = PREFIX,
            ),
        )
        SsccPool(db).addRange(ServerRange(PREFIX, SsccPool.BOX_EXTENSION_DIGIT, 1, 200, null))
        // No pallet range seeded: the PALLET_EXTENSION_DIGIT pool is dry from the start.
        val vm = vm()
        advanceUntilIdle()
        scan("a")
        advanceUntilIdle()
        val step = vm.palletCloseStep.first { it is PalletCloseStep.Refused } as PalletCloseStep.Refused
        assertEquals(ClosePalletResult.NoSerials, step.reason)
    }

    @Test
    fun everyModelBuiltHereIsTrackedSoALeakedCollectorCannotFailTheNextTest() = runTest {
        // Mirrors the guard added in #506: `vm()` always runs through `main.track`,
        // so this suite cannot leave a collector running on `Dispatchers.Main` for
        // whatever test happens to run after it.
        aggregatingWithPallets()
        vm()
        advanceUntilIdle()
    }
}
