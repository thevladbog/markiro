package app.markiro.handheld.feature.work

import androidx.lifecycle.SavedStateHandle
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.MainDispatcherRule
import app.markiro.handheld.core.auth.OperatorRecord
import app.markiro.handheld.core.box.BoxPrinter
import app.markiro.handheld.core.box.PrintReason
import app.markiro.handheld.core.box.BoxRepository
import app.markiro.handheld.core.box.CloseBox
import app.markiro.handheld.core.box.ClosePallet
import app.markiro.handheld.core.box.PalletLock
import app.markiro.handheld.core.box.PalletRepository
import app.markiro.handheld.core.duplicate.DuplicateJobs
import app.markiro.handheld.core.duplicate.DuplicateReason
import app.markiro.handheld.core.box.CloseResult
import app.markiro.handheld.core.box.ServerRange
import app.markiro.handheld.core.box.SsccPool
import app.markiro.handheld.core.km.Verdict
import app.markiro.handheld.core.label.LabelRenderer
import app.markiro.handheld.core.label.RasterResult
import app.markiro.handheld.core.label.RasterizeText
import app.markiro.handheld.core.print.NotReadyReason
import app.markiro.handheld.core.print.PrinterEntity
import app.markiro.handheld.core.print.PrinterStatus
import app.markiro.handheld.core.print.PrinterTransport
import app.markiro.handheld.core.print.SendOutcome
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
import kotlinx.coroutines.cancel
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
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
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
        db.deviceConfigDao().upsert(
            DeviceConfigEntity(
                deviceId = "dev-1", deviceName = "ТСД", tenantId = "t", organizationName = "ООО", lineId = "l1", lineName = "Линия 2",
                kind = "handheld", serverUrl = "http://x", pairedAt = 1L, activeShiftId = "s1",
            ),
        )
        db.shiftDao().upsert(ShiftEntityFixtures.bundled("s1"))
    }

    @After
    fun tearDown() {
        engineScope.cancel()
        db.close()
    }

    private fun vm(team: TeamRefresher = TeamRefresher { null }): WorkViewModel {
        val engine = SyncEngine(
            db, MetaStore(db.metaDao()), db.deviceConfigDao(), SyncTransport(OkHttpClient()) { "http://127.0.0.1:1/" },
            NetworkModule.strictJson(), engineScope,
        )
        val boxes = BoxRepository(db)
        val pool = SsccPool(db)
        // The fixture shift carries no `palletBoxCapacity`, so these are wired
        // up only to satisfy `CloseBox`'s constructor -- nothing here joins a
        // pallet. That path has its own suite, `ClosePalletTest`.
        val palletLock = PalletLock(db)
        val pallets = PalletRepository(db, palletLock)
        val closePallet = ClosePallet(db, pool, palletLock)
        // `main.track` is #506's leak guard; the duplicate engine is this slice's
        // own argument. Both belong.
        return main.track(
            WorkViewModel(
                SavedStateHandle(mapOf("shiftId" to "s1")), db, ScanRecorder(db), ScanRouterAdapter(scans),
                { kind -> played += kind }, engine, session, ReachabilityTracker(), team, null,
                boxes, CloseBox(db, boxes, pool, pallets, closePallet, palletLock),
                BoxPrinter(db, boxes, LabelRenderer(rasterize), transport),
                DuplicateJobs(db, LabelRenderer(rasterize), transport), flowOf(Unit),
            ),
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

    /** An aggregation shift with a template, a printer and a serial block. */
    private suspend fun aggregating(capacity: Int = 20, withPrinter: Boolean = true) {
        db.shiftDao().upsert(
            ShiftEntityFixtures.bundled("s1").copy(
                mode = "aggregation",
                boxCapacity = capacity,
                productName = "Вода",
                shelfLifeDays = 365,
                ssccIssuerPrefix = "468008990",
                boxLabelTemplate = """{"widthMm":58,"heightMm":40,"dpi":203,"language":"zpl","elements":[]}""",
            ),
        )
        SsccPool(db).addRange(ServerRange("468008990", 0, 1, 100, null))
        if (withPrinter) {
            db.printerDao().upsert(
                PrinterEntity(
                    id = "p1", name = "Zebra", transport = "wifi", address = "127.0.0.1:9100",
                    language = "zpl", dpi = 203, selected = true, lastStatus = null, lastSeenAt = null,
                ),
            )
        }
    }

    private fun scan(serial: String) = scans.tryEmit(ScanEvent("010460068200001321$serial", null, "debug", 0))

    @Test
    fun aScanInAnAggregationShiftJoinsTheOpenBox() = runTest {
        aggregating()
        val vm = vm()
        advanceUntilIdle()
        scan("a")
        advanceUntilIdle()
        // The box is visible from entry, so this waits for the unit to land in it.
        val box = vm.state.first { it.box?.filled == 1 }.box!!
        assertEquals(1, box.ordinal)
        assertEquals(20, box.capacity)
    }

    @Test
    fun aValidationShiftHasNoBoxAndItsScansJoinNone() = runTest {
        val vm = vm()
        advanceUntilIdle()
        scan("a")
        advanceUntilIdle()
        vm.state.first { it.last != null }
        assertNull(vm.state.value.box)
        assertNull(db.outboxDao().head(1).single().boxId)
    }

    @Test
    fun theLastUnitClosesTheBoxWithItsOwnSignalAndPrints() = runTest {
        aggregating(capacity = 2)
        val vm = vm()
        advanceUntilIdle()
        scan("a")
        advanceUntilIdle()
        scan("b")
        advanceUntilIdle()
        val step = vm.closeStep.first { it is BoxCloseStep.Printed } as BoxCloseStep.Printed
        assertEquals(2, step.box.itemCount)
        assertEquals(1, step.box.ordinal)
        // The box's own signal, so a full box is never heard as one more unit.
        assertTrue(played.contains(SignalKind.BOX_DONE))
        assertEquals(1, transport.sent)
        assertEquals(step.box.sscc, db.boxDao().unacked(10).single().sscc)
    }

    @Test
    fun aScanArrivingUnderTheCloseScreenIsIgnored() = runTest {
        // The close is a full-screen state the operator is meant to read; a unit
        // scanned under it belongs to the next box, not the one just closed.
        aggregating(capacity = 1)
        val vm = vm()
        advanceUntilIdle()
        scan("a")
        advanceUntilIdle()
        vm.closeStep.first { it is BoxCloseStep.Printed }
        scan("b")
        advanceUntilIdle()
        assertEquals(1, db.codeDao().countForShift("s1"))
    }

    @Test
    fun withNoPrinterTheBoxStillClosesAndTheLabelIsOwed() = runTest {
        // A dead printer must not stop a line: the box is numbered and reported,
        // and the label becomes a visible debt instead.
        aggregating(capacity = 1, withPrinter = false)
        val vm = vm()
        advanceUntilIdle()
        scan("a")
        advanceUntilIdle()
        val step = vm.closeStep.first { it is BoxCloseStep.Failed } as BoxCloseStep.Failed
        assertEquals(PrintReason.PRINTER_UNCONFIGURED, step.reason)
        assertNotNull(db.boxDao().unacked(10).single().sscc)
        assertEquals(1, vm.state.first { it.unprintedLabels == 1 }.unprintedLabels)
    }

    @Test
    fun aDryPoolLeavesTheBoxOpenAndSaysSo() = runTest {
        db.shiftDao().upsert(
            ShiftEntityFixtures.bundled("s1").copy(mode = "aggregation", boxCapacity = 1, ssccIssuerPrefix = "468008990"),
        )
        val vm = vm()
        advanceUntilIdle()
        scan("a")
        advanceUntilIdle()
        val step = vm.closeStep.first { it is BoxCloseStep.Refused } as BoxCloseStep.Refused
        assertEquals(CloseResult.NoSerials, step.reason)
        assertEquals(0, db.boxDao().unacked(10).size)
    }

    @Test
    fun closingEarlyNumbersWhatIsActuallyInTheBox() = runTest {
        aggregating(capacity = 20)
        val vm = vm()
        advanceUntilIdle()
        scan("a")
        // Waited on the state rather than advanceUntilIdle: Room writes on its own
        // executor, so the scheduler goes idle before the row exists.
        vm.state.first { it.box?.filled == 1 }
        scan("b")
        vm.state.first { it.box?.filled == 2 }
        vm.closeEarly()
        val step = vm.closeStep.first { it is BoxCloseStep.Printed } as BoxCloseStep.Printed
        assertEquals(2, step.box.itemCount)
    }

    @Test
    fun anUnknownPrintNeverResendsOnItsOwn() = runTest {
        aggregating(capacity = 1)
        transport.outcome = SendOutcome.Unknown("link lost")
        val vm = vm()
        advanceUntilIdle()
        scan("a")
        advanceUntilIdle()
        vm.closeStep.first { it is BoxCloseStep.Unknown }
        assertEquals(1, transport.sent)
        // Confirming resolves it without sending anything more.
        vm.confirmPrinted()
        assertEquals(BoxCloseStep.Idle, vm.closeStep.value)
        assertEquals(1, transport.sent)
        assertEquals(0, vm.state.first { it.unprintedLabels == 0 }.unprintedLabels)
    }

    @Test
    fun deferringALabelKeepsTheBoxInTheQueue() = runTest {
        aggregating(capacity = 1, withPrinter = false)
        val vm = vm()
        advanceUntilIdle()
        scan("a")
        advanceUntilIdle()
        vm.closeStep.first { it is BoxCloseStep.Failed }
        vm.deferLabel()
        assertEquals(BoxCloseStep.Idle, vm.closeStep.value)
        assertEquals(1, vm.state.first { it.unprintedLabels == 1 }.unprintedLabels)
    }

    @Test
    fun anAggregationShiftShowsAnEmptyBoxBeforeTheFirstScan() = runTest {
        // Otherwise the operator meets the validation layout on entry and the grid
        // appears from nowhere on the first unit.
        aggregating()
        val vm = vm()
        val box = vm.state.first { it.box != null }.box!!
        assertEquals(1, box.ordinal)
        assertEquals(0, box.filled)
        assertEquals(20, box.capacity)
        // And no row was created just by opening the screen.
        assertEquals(0, db.boxDao().unacked(10).size)
    }

    @Test
    fun theBoxAfterACloseShowsAsEmptyRatherThanVanishing() = runTest {
        aggregating(capacity = 1)
        val vm = vm()
        advanceUntilIdle()
        scan("a")
        advanceUntilIdle()
        vm.closeStep.first { it is BoxCloseStep.Printed }
        val next = vm.state.first { it.box?.filled == 0 && it.box?.ordinal == 2 }.box!!
        assertEquals(2, next.ordinal)
        assertEquals(1, next.capacity)
    }

    /** A complete marking code: a duplicate needs the crypto tail to be reproducible. */
    private fun duplicateRaw(serial: String) = "010460068200001321$serial${gs}93Zf8K"

    private val duplicateTemplate = """
        {"widthMm":30,"heightMm":20,"dpi":203,"language":"zpl","elements":[
          {"kind":"barcode","id":"dm","xMm":2,"yMm":2,"format":"datamatrix","data":"km.code","sizeMm":16}
        ]}
    """.trimIndent()

    private suspend fun duplicateShift(verification: String = "none") {
        db.shiftDao().upsert(
            ShiftEntityFixtures.bundled("s1").copy(
                validationPrintMode = "duplicate_dm",
                duplicateVerification = verification,
                duplicateTemplate = duplicateTemplate,
                duplicateTemplateDigest = "a".repeat(64),
                duplicatePolicyRevision = "66666666-6666-4666-8666-666666666666",
                shelfLifeDays = 365,
                productionDate = "2026-09-11",
            ),
        )
        db.printerDao().upsert(
            PrinterEntity(
                id = "p1", name = "Zebra", transport = "wifi", address = "10.0.0.1:9100",
                language = "zpl", dpi = 203, selected = true, lastStatus = null, lastSeenAt = null,
            ),
        )
    }

    /** An accepted unit gets a label; the ordinary path takes over nothing. */
    @Test
    fun anAcceptedUnitInADuplicateShiftPrintsAndStaysQuiet() = runTest {
        duplicateShift()
        val vm = vm()
        advanceUntilIdle()
        scans.tryEmit(ScanEvent(duplicateRaw("AAA111"), null, "debug", 0))
        advanceUntilIdle()
        // Room answers on its own executor, so `advanceUntilIdle` returns while
        // the job is still being written. The UI state is set before the send
        // too, so the only honest signal is the event log: prepared, sending,
        // sent -- three, and only once the send is over.
        db.productLabelEventDao().observeUnackedCount().first { it == 3 }
        assertEquals(DuplicateStep.Idle, vm.duplicateStep.value)
        assertEquals(1, transport.sent)
        // Nothing took over the screen: the ordinary path stays quiet.
        assertEquals(false, vm.state.value.duplicate?.awaitingVerification)
    }

    /** The whole slice turns on this: the operator is holding a sticker. */
    @Test
    fun aSecondUnitIsRefusedWhileADuplicateAwaitsVerification() = runTest {
        duplicateShift(verification = "required")
        val vm = vm()
        advanceUntilIdle()
        scans.tryEmit(ScanEvent(duplicateRaw("AAA111"), null, "debug", 0))
        advanceUntilIdle()
        vm.state.first { it.duplicate?.awaitingVerification == true }

        // A different unit, scanned while the first is awaiting its verification.
        scans.tryEmit(ScanEvent(duplicateRaw("BBB222"), null, "debug", 0))
        advanceUntilIdle()
        // It is read as a verification of the OPEN job and rejected, never
        // accepted as a new unit.
        vm.duplicateStep.first { it is DuplicateStep.Rejected }
        assertEquals(1, db.codeDao().countForShift("s1"))
    }

    /** Scanning the printed sticker back completes the unit. */
    @Test
    fun scanningTheStickerBackCompletesTheUnit() = runTest {
        duplicateShift(verification = "required")
        val vm = vm()
        advanceUntilIdle()
        val raw = duplicateRaw("AAA111")
        scans.tryEmit(ScanEvent(raw, null, "debug", 0))
        advanceUntilIdle()
        vm.state.first { it.duplicate?.awaitingVerification == true }

        scans.tryEmit(ScanEvent(raw, null, "debug", 0))
        advanceUntilIdle()
        vm.state.first { it.duplicate?.awaitingVerification == false }
        assertEquals(DuplicateStep.Idle, vm.duplicateStep.value)
        // And it did not count as a second unit.
        assertEquals(1, db.codeDao().countForShift("s1"))
    }

    /**
     * Found on the emulator: `_duplicateStep` lives in memory, so a job whose
     * attempt failed was invisible after a restart -- and the next unit was then
     * refused with nothing on screen explaining why.
     */
    @Test
    fun anOutstandingJobsScreenComesBackAfterARestart() = runTest {
        duplicateShift()
        transport.nextStatus = PrinterStatus.NotReady(NotReadyReason.NO_PAPER)
        val first = vm()
        advanceUntilIdle()
        scans.tryEmit(ScanEvent(duplicateRaw("AAA111"), null, "debug", 0))
        advanceUntilIdle()
        first.duplicateStep.first { it is DuplicateStep.Failed }

        // A fresh view model over the same database is what a restart looks like.
        val restarted = vm()
        advanceUntilIdle()
        val step = restarted.duplicateStep.first { it is DuplicateStep.Failed } as DuplicateStep.Failed
        assertEquals(DuplicateReason.NO_PAPER, step.reason)
    }

    /**
     * Also found on the emulator: the refusal reused `Verdict.INVALID`, so a
     * perfectly good code read as «НЕВЕРНЫЙ КОД» when its only problem was that
     * another unit's label was unresolved.
     */
    @Test
    fun aRefusedScanIsNotReportedAsABadCode() = runTest {
        duplicateShift(verification = "required")
        val vm = vm()
        advanceUntilIdle()
        scans.tryEmit(ScanEvent(duplicateRaw("AAA111"), null, "debug", 0))
        advanceUntilIdle()
        db.productLabelEventDao().observeUnackedCount().first { it == 3 }

        // While the first awaits verification, freeze it mid-print so the next
        // scan is refused rather than read as a verification.
        val job = checkNotNull(db.productLabelJobDao().openJob("s1"))
        db.productLabelJobDao().update(job.copy(status = "sending", attemptState = "sending"))

        scans.tryEmit(ScanEvent(duplicateRaw("BBB222"), null, "debug", 0))
        advanceUntilIdle()
        val last = vm.state.first { it.last?.blocked == true }.last
        assertEquals(true, last?.blocked)
        // Never judged, so never a verdict about the code itself.
        assertEquals(1, db.codeDao().countForShift("s1"))
    }
}
