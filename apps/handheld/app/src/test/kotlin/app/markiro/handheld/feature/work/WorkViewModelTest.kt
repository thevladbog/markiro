package app.markiro.handheld.feature.work

import app.markiro.handheld.core.print.upsertAssigned
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import androidx.lifecycle.SavedStateHandle
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.MainDispatcherRule
import app.markiro.handheld.core.auth.OperatorRecord
import app.markiro.handheld.core.box.BoxPrinter
import app.markiro.handheld.core.box.PrintReason
import app.markiro.handheld.core.box.BoxRepository
import app.markiro.handheld.core.exceptions.ExceptionEngine
import app.markiro.handheld.core.box.CloseBox
import app.markiro.handheld.core.box.ClosePallet
import app.markiro.handheld.core.box.PalletLock
import app.markiro.handheld.core.box.PalletPrinter
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
import app.markiro.handheld.feature.shift.ShiftRepository
import app.markiro.handheld.feature.signin.SessionHolder
import kotlinx.coroutines.cancel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import okhttp3.OkHttpClient
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import app.markiro.handheld.core.network.StationApi
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
        var release: kotlinx.coroutines.CompletableDeferred<Unit>? = null
        override suspend fun status(printer: PrinterEntity) = nextStatus
        override suspend fun send(printer: PrinterEntity, document: ByteArray): SendOutcome {
            sent++
            release?.await()
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

    private fun vm(team: TeamRefresher = TeamRefresher { null }, repository: ShiftRepository? = null): WorkViewModel {
        val engine = SyncEngine(
            db, MetaStore(db), db.deviceConfigDao(), SyncTransport(OkHttpClient()) { "http://127.0.0.1:1/" },
            NetworkModule.strictJson(), engineScope,
        )
        val boxes = BoxRepository(db)
        val pool = SsccPool(db)
        // The fixture shift carries no `palletBoxCapacity`, so these are wired
        // up only to satisfy `CloseBox`'s constructor -- nothing here joins a
        // pallet unless a test opts in with `aggregatingWithPallets`. That path
        // also has its own dedicated suite, `ClosePalletTest`.
        val palletLock = PalletLock(db)
        val pallets = PalletRepository(db, palletLock)
        val closePallet = ClosePallet(db, pool, palletLock)
        val palletPrinter = PalletPrinter(db, pallets, LabelRenderer(rasterize), transport)
        // `main.track` is #506's leak guard; the duplicate engine is this slice's
        // own argument. Both belong.
        return main.track(
            WorkViewModel(
                SavedStateHandle(mapOf("shiftId" to "s1")), db, ScanRecorder(db), ScanRouterAdapter(scans),
                { kind -> played += kind }, engine, session, ReachabilityTracker(), team, repository,
                boxes, CloseBox(db, boxes, pool, pallets, closePallet, palletLock),
                BoxPrinter(db, boxes, LabelRenderer(rasterize), transport),
                DuplicateJobs(db, LabelRenderer(rasterize), transport),
                pallets, closePallet, palletPrinter, ExceptionEngine(db), flowOf(Unit),
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
        // Waits for WHICH scan is last, then asserts what it was judged to be.
        // `feed` and `errors` come from Room's flows and `last` from this view
        // model, so a predicate on counters alone is satisfied by a state whose
        // `last` is still the previous scan -- which is how this read
        // «expected:<INVALID> but was:<WRONG_GTIN>» on a loaded CI runner and
        // never once on a developer machine.
        val s = vm.state.first { it.feed.size == 4 && it.errors == 2 && it.last?.tail == "garbage" }
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

    /**
     * Offered on the crossing, and only once. A plain `total >= plan` would raise
     * this again on every scan past the plan, and would greet an operator who
     * merely re-entered a shift that was already finished.
     */
    @Test
    fun theCloseOfferComesOnceWhenTheShiftCrossesItsPlan() = runTest {
        db.shiftDao().upsert(ShiftEntityFixtures.bundled("s1").copy(plannedQty = 2))
        val vm = vm()
        advanceUntilIdle()
        assertFalse(vm.planPrompt.value)

        scans.tryEmit(ScanEvent("010460068200001321one${gs}93AAAA", null, "debug", 0))
        advanceUntilIdle()
        assertFalse("below the plan, nothing is offered", vm.planPrompt.value)

        scans.tryEmit(ScanEvent("010460068200001321two${gs}93BBBB", null, "debug", 0))
        assertTrue(vm.planPrompt.first { it })

        vm.dismissPlanPrompt()
        scans.tryEmit(ScanEvent("010460068200001321three${gs}93CCCC", null, "debug", 0))
        advanceUntilIdle()
        assertFalse("past the plan it must not ask again", vm.planPrompt.value)
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
            db.printerDao().upsertAssigned(
                PrinterEntity(
                    id = "p1", name = "Zebra", transport = "wifi", address = "127.0.0.1:9100",
                    language = "zpl", dpi = 203, selected = true, lastStatus = null, lastSeenAt = null,
                ),
            )
        }
    }

    private fun scan(serial: String) = scans.tryEmit(ScanEvent("010460068200001321$serial", null, "debug", 0))

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test
    fun topUpCanStartWhenMainDispatcherRunsImmediatelyDuringConstruction() = runTest {
        aggregating()
        val server = MockWebServer()
        server.start()
        try {
            server.enqueue(MockResponse().setResponseCode(200)
                .setBody("""{"blocks":[],"revokedFrom":[],"issuerProblem":null}"""))
            val json = NetworkModule.json()
            val api = Retrofit.Builder().baseUrl(server.url("/"))
                .client(OkHttpClient())
                .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
                .build().create(StationApi::class.java)
            Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
            try {
                vm(repository = ShiftRepository(api, db, json, SsccPool(db)))
                val request = server.takeRequest(5, TimeUnit.SECONDS)
                assertEquals("POST", request?.method)
                assertEquals("/shifts/s1/sscc/top-up", request?.path)
            } finally {
                Dispatchers.setMain(main.dispatcher)
            }
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun pausingTheWorkScreenInvalidatesAQueuedTopUpStart() = runTest {
        aggregating()
        val server = MockWebServer()
        server.start()
        try {
            server.enqueue(MockResponse().setResponseCode(200)
                .setBody("""{"blocks":[],"revokedFrom":[],"issuerProblem":null}"""))
            val json = NetworkModule.json()
            val api = Retrofit.Builder().baseUrl(server.url("/"))
                .client(OkHttpClient())
                .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
                .build().create(StationApi::class.java)
            val vm = vm(repository = ShiftRepository(api, db, json, SsccPool(db)))
            vm.setScanning(false)
            runCurrent()
            kotlinx.coroutines.withContext(Dispatchers.IO) { kotlinx.coroutines.delay(100) }
            runCurrent()
            assertEquals(0, server.requestCount)
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun topUpChecksOnEntryAndAfterABoxCloses() = runTest {
        aggregating(capacity = 1)
        // 100 + 301 = 401 locally: entry must not call the server. The first
        // closed box burns one serial, crossing the low-water boundary.
        SsccPool(db).addRange(ServerRange("468008990", 0, 101, 401, null))
        val server = MockWebServer()
        server.start()
        try {
            server.enqueue(MockResponse().setResponseCode(200).setBody(
                """{"blocks":[{"issuerPrefix":"468008990","extensionDigit":0,"fromSerial":1,"toSerial":100,"consumedThroughSerial":null},{"issuerPrefix":"468008990","extensionDigit":0,"fromSerial":101,"toSerial":401,"consumedThroughSerial":null},{"issuerPrefix":"468008990","extensionDigit":0,"fromSerial":402,"toSerial":2401,"consumedThroughSerial":null}],"revokedFrom":[],"issuerProblem":null}""",
            ))
            val json = NetworkModule.json()
            val api = Retrofit.Builder().baseUrl(server.url("/"))
                .client(OkHttpClient())
                .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
                .build().create(StationApi::class.java)
            val vm = vm(repository = ShiftRepository(api, db, json, SsccPool(db)))
            runCurrent()
            assertEquals(0, server.requestCount)
            scan("topup")
            vm.closeStep.first { it is BoxCloseStep.Printed }
            val request = server.takeRequest(5, TimeUnit.SECONDS)
            assertEquals("POST", request?.method)
            assertEquals("/shifts/s1/sscc/top-up", request?.path)
            assertEquals(1, server.requestCount)
        } finally {
            server.shutdown()
        }
    }

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

    /**
     * Found on the emulator: the twentieth unit was written into the box
     * BEFORE the close was attempted, and a refused close rolled nothing back
     * and blocked nothing -- the box went to 21 / 20, 22 / 20, without limit.
     */
    @Test
    fun aFullBoxWhoseCloseWasRefusedAcceptsNoMoreUnits() = runTest {
        aggregating(capacity = 2)
        db.shiftDao().upsert(checkNotNull(db.shiftDao().get("s1")).copy(ssccIssuerPrefix = null))
        val vm = vm()
        advanceUntilIdle()
        scan("a")
        vm.state.first { it.box?.filled == 1 }
        scan("b")
        val refused = vm.closeStep.first { it is BoxCloseStep.Refused } as BoxCloseStep.Refused
        assertEquals(CloseResult.NoIssuer, refused.reason)
        vm.dismissClose()
        played.clear()

        scan("c")
        val s = vm.state.first { it.last?.blockedBy == ScanBlock.BOX_FULL }
        // The unit was refused, not recorded: the box stays at capacity.
        assertEquals(2, db.codeDao().countForShift("s1"))
        assertEquals(2, s.box?.filled)
        // And the reason stays on the work screen, not only in the dismissed state.
        assertEquals(CloseResult.NoIssuer, s.boxRefusal)
        assertEquals(listOf(SignalKind.ERROR), played)
        // No second full-screen refusal for a scan the operator already knows will not fit.
        assertEquals(BoxCloseStep.Idle, vm.closeStep.value)
    }

    /** Once the reason is gone, the next unit closes the full box and starts the next one. */
    @Test
    fun aRefusedCloseIsRetriedByTheNextScanWhichThenJoinsTheNewBox() = runTest {
        db.shiftDao().upsert(
            ShiftEntityFixtures.bundled("s1").copy(mode = "aggregation", boxCapacity = 2, ssccIssuerPrefix = "468008990"),
        )
        val vm = vm()
        advanceUntilIdle()
        scan("a")
        vm.state.first { it.box?.filled == 1 }
        scan("b")
        vm.closeStep.first { it is BoxCloseStep.Refused }
        vm.dismissClose()
        assertEquals(CloseResult.NoSerials, vm.state.first { it.boxRefusal != null }.boxRefusal)

        SsccPool(db).addRange(ServerRange("468008990", 0, 1, 100, null))
        scan("c")
        vm.closeStep.first { it is BoxCloseStep.Failed || it is BoxCloseStep.Printed }
        val next = vm.state.first { it.box?.ordinal == 2 && it.box?.filled == 1 }
        assertNull(next.boxRefusal)
        assertEquals(3, db.codeDao().countForShift("s1"))
        assertEquals(1, db.boxDao().unacked(10).size)
    }

    /**
     * The header read «Короб 1 · 21 / 20» after an undo on the exceptions
     * screen until the next scan: the box was recomputed only on scan and on
     * entry. It follows the rows now, whatever screen changed them.
     */
    @Test
    fun theBoxHeaderFollowsAnUndoMadeOnAnotherScreen() = runTest {
        aggregating(capacity = 20)
        val vm = vm()
        advanceUntilIdle()
        scan("a")
        vm.state.first { it.box?.filled == 1 }
        scan("b")
        vm.state.first { it.box?.filled == 2 }
        val box = checkNotNull(db.boxDao().open("s1"))
        val last = checkNotNull(db.codeDao().lastIn(box.boxId))
        ExceptionEngine(db).undoLastScan("s1", box.boxId, last.codeHash, "op-1", "dev-1")
        // Awaited, not advanced: Room emits on its own executor, and the flow
        // is what carries the undo here -- no scan, no re-entry.
        assertEquals(1, vm.state.first { it.box?.filled == 1 }.box?.filled)
        assertEquals(1, db.boxDao().itemCount(box.boxId))
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

    /**
     * Brief §8: «Напечатать ещё раз» out of an unknown outcome is an explicit
     * same-SSCC reprint and is recorded as one, with a fixed reason.
     */
    @Test
    fun printingAgainFromAnUnknownOutcomeWritesAReprint() = runTest {
        aggregating(capacity = 1)
        transport.outcome = SendOutcome.Unknown("link lost")
        val vm = vm()
        advanceUntilIdle()
        scan("a")
        advanceUntilIdle()
        val closed = vm.closeStep.first { it is BoxCloseStep.Unknown } as BoxCloseStep.Unknown
        vm.retryPrint()
        // The queue depth is the observable outcome; `advanceUntilIdle` would
        // return while Room is still writing it.
        db.boxExceptionDao().observeUnackedCount().first { it == 1 }
        // `queued`, not `sendable`: the closure of a box shut seconds ago is
        // very likely still unacknowledged, and the drain rightly withholds the
        // fact until the server has seen the box.
        val queued = db.boxExceptionDao().queued().single()
        assertEquals("reprint", queued.kind)
        assertEquals(closed.box.boxId, queued.boxId)
        assertEquals("Результат печати неизвестен", queued.reason)
    }

    /** Confirming the label is there sends nothing and records nothing. */
    @Test
    fun confirmingAnUnknownPrintWritesNoReprint() = runTest {
        aggregating(capacity = 1)
        transport.outcome = SendOutcome.Unknown("link lost")
        val vm = vm()
        advanceUntilIdle()
        scan("a")
        advanceUntilIdle()
        vm.closeStep.first { it is BoxCloseStep.Unknown }
        vm.confirmPrinted()
        vm.state.first { it.unprintedLabels == 0 }
        assertEquals(0, db.boxExceptionDao().unackedCount())
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

    private suspend fun duplicateShift(verification: String = "none", allowPreviouslyAcceptedCodes: Boolean = false) {
        db.shiftDao().upsert(
            ShiftEntityFixtures.bundled("s1").copy(
                validationPrintMode = "duplicate_dm",
                allowPreviouslyAcceptedCodes = allowPreviouslyAcceptedCodes,
                duplicateVerification = verification,
                duplicateTemplate = duplicateTemplate,
                duplicateTemplateDigest = "a".repeat(64),
                duplicatePolicyRevision = "66666666-6666-4666-8666-666666666666",
                shelfLifeDays = 365,
                productionDate = "2026-09-11",
            ),
        )
        db.printerDao().upsertAssigned(
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
        // too. Wait for both the committed events and the UI continuation.
        db.productLabelEventDao().observeUnackedCount().first { it == 3 }
        vm.duplicateStep.first { it == DuplicateStep.Idle }
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

    @Test
    fun skipClosesOnlyTheDisplayedJobAndAllowsTheNextUnit() = runTest {
        duplicateShift(verification = "required")
        val vm = vm()
        advanceUntilIdle()
        scans.tryEmit(ScanEvent(duplicateRaw("AAA111"), null, "debug", 0))
        advanceUntilIdle()
        val pending = vm.duplicateStep.first { it is DuplicateStep.Awaiting } as DuplicateStep.Awaiting
        assertEquals("AAA111", pending.tail)
        vm.skipDuplicateVerification()
        vm.skipDuplicateVerification()
        advanceUntilIdle()
        vm.state.first { it.duplicate?.awaitingVerification == false }
        assertEquals(DuplicateStep.Idle, vm.duplicateStep.value)
        assertEquals("skipped", db.productLabelJobDao().get(pending.jobId)?.verificationOutcome)
        assertEquals(1, db.productLabelEventDao().bySequence(pending.jobId).count { it.kind == "verification_skipped" })
        scans.tryEmit(ScanEvent(duplicateRaw("BBB222"), null, "debug", 0))
        advanceUntilIdle()
        val next = vm.duplicateStep.first { it is DuplicateStep.Awaiting } as DuplicateStep.Awaiting
        assertEquals(2, db.codeDao().countForShift("s1"))
        assertEquals("BBB222", next.tail)
    }

    @Test
    fun pendingVerificationRestoresItsFullScreenAfterViewModelRecreation() = runTest {
        duplicateShift(verification = "required")
        val first = vm()
        advanceUntilIdle()
        scans.tryEmit(ScanEvent(duplicateRaw("AAA111"), null, "debug", 0))
        advanceUntilIdle()
        val expected = first.duplicateStep.first { it is DuplicateStep.Awaiting }
        first.setScanning(false)
        val restored = vm()
        advanceUntilIdle()
        assertEquals(expected, restored.duplicateStep.first { it is DuplicateStep.Awaiting })
        assertTrue(restored.duplicateStep.value is DuplicateStep.Awaiting)
    }

    @Test fun previousCodeRefusalCreatesNeitherNewUnitNorNewPrintJob() = runTest {
        duplicateShift()
        val raw=duplicateRaw("PREVIOUS")
        val km=app.markiro.handheld.core.km.KmCodec.canonicalize(raw)
        val hash=app.markiro.handheld.core.km.KmCodec.hash(km)
        db.codeDao().insert(app.markiro.handheld.core.storage.CodeEntity(hash,"old",km.gtin14,km.serial,"2026-09-01T00:00:00Z"))
        db.shiftDao().upsert(ShiftEntityFixtures.bundled("old").copy(status="closed"))
        val vm=vm(); advanceUntilIdle()
        scans.tryEmit(ScanEvent(raw,null,"debug",0)); advanceUntilIdle()
        vm.state.first { it.last?.refusal==app.markiro.handheld.core.scan.ValidationRefusal.PREVIOUS_DISALLOWED }
        assertEquals(0,transport.sent)
        assertEquals(0,db.codeDao().countForShift("s1"))
        assertEquals(0,db.productLabelEventDao().observeUnackedCount().first())
        assertNull(db.validationDao().get("s1",hash))
    }

    @Test fun enabledRepeatPrintsOnceAndRestoresPendingCounterOnViewModelRecreation() = runTest {
        duplicateShift(allowPreviouslyAcceptedCodes=true)
        val raw=duplicateRaw("REPEAT1")
        val km=app.markiro.handheld.core.km.KmCodec.canonicalize(raw); val hash=app.markiro.handheld.core.km.KmCodec.hash(km)
        val old=app.markiro.handheld.core.storage.CodeEntity(hash,"old",km.gtin14,km.serial,"2026-09-01T00:00:00Z")
        db.codeDao().insert(old)
        db.shiftDao().upsert(ShiftEntityFixtures.bundled("old").copy(status="closed"))
        db.validationDao().stage(listOf(app.markiro.handheld.core.storage.ValidationHistoryEntity("pub",hash,"original","old","OLD-001","closed",old.scannedAt)))
        db.validationDao().publish(app.markiro.handheld.core.storage.ValidationHistoryPublication("s1","p1","pub","a".repeat(64),"2026-09-12T00:00:00Z","2026-09-12T01:00:00Z"))
        val first=vm(); advanceUntilIdle()
        scans.tryEmit(ScanEvent(raw,null,"debug",0)); advanceUntilIdle()
        first.state.first { it.thisTerminal==1 }
        db.productLabelEventDao().observeUnackedCount().first { it == 3 }
        val sent=transport.sent
        scans.tryEmit(ScanEvent(raw,null,"debug",0)); advanceUntilIdle()
        first.state.first { it.last?.refusal == app.markiro.handheld.core.scan.ValidationRefusal.SAME_SHIFT }
        assertEquals(sent,transport.sent)
        assertEquals(old,db.codeDao().get(hash))
        assertEquals(app.markiro.handheld.core.scan.ValidationRefusal.SAME_SHIFT,first.state.value.last?.refusal)
        val restarted=vm(); advanceUntilIdle()
        val state=restarted.state.first { it.thisTerminal==1 }
        assertEquals(1,state.validation?.pending)
        assertTrue(state.sync.pending>0)
    }

    /** Scanning the printed sticker back completes the unit. */
    @Test
    fun scanningTheStickerBackCompletesTheUnit() = runTest {
        duplicateShift(verification = "required", allowPreviouslyAcceptedCodes = true)
        val vm = vm()
        advanceUntilIdle()
        val raw = duplicateRaw("AAA111")
        scans.tryEmit(ScanEvent(raw, null, "debug", 0))
        advanceUntilIdle()
        vm.state.first { it.duplicate?.awaitingVerification == true }

        scans.tryEmit(ScanEvent(raw, null, "debug", 0))
        advanceUntilIdle()
        vm.state.first { it.duplicate?.awaitingVerification == false }
        assertEquals(DuplicateStep.Idle, vm.duplicateStep.first { it == DuplicateStep.Idle })
        // And it did not count as a second unit.
        assertEquals(1, db.codeDao().countForShift("s1"))
    }

    /**
     * Found on the emulator: `_duplicateStep` lives in memory, so a job whose
     * attempt failed was invisible after a restart -- and the next unit was then
     * refused with nothing on screen explaining why.
     */
    @Test
    fun aSlowDuplicateSendExposesItsSavedDestinationUntilOutputCompletes() = runTest {
        duplicateShift()
        val release = kotlinx.coroutines.CompletableDeferred<Unit>()
        transport.release = release
        val model = vm()
        advanceUntilIdle()
        scans.tryEmit(ScanEvent(duplicateRaw("AAA111"), null, "debug", 0))
        val sending = model.duplicateStep.first { it is DuplicateStep.Sending } as DuplicateStep.Sending
        val bound = model.printDestinations.first { rows -> rows.any { it.jobId == sending.jobId } }.single()
        assertEquals("duplicate", bound.purpose)
        assertEquals("Zebra", bound.printer.name)
        release.complete(Unit)
        model.duplicateStep.first { it == DuplicateStep.Idle }
        assertEquals(1, transport.sent)
    }

    @Test
    fun aLegacyPreparedJobRestoresAnExplicitContinueActionWithoutSending() = runTest {
        duplicateShift()
        val jobs = app.markiro.handheld.core.duplicate.DuplicateJobs(db, LabelRenderer(rasterize), transport)
        val shift = checkNotNull(db.shiftDao().get("s1"))
        val prepared = jobs.accept(shift, duplicateRaw("AAA111"), "c".repeat(64), "op-1", null, "2026-09-11T08:00:00.000Z")
            as app.markiro.handheld.core.duplicate.DuplicateOutcome.Prepared
        val before = checkNotNull(db.productLabelJobDao().get(prepared.jobId))
        db.openHelper.writableDatabase.execSQL("DELETE FROM print_destinations WHERE purpose = 'duplicate' AND jobId = ?", arrayOf(prepared.jobId))
        val restored = vm()
        val step = restored.duplicateStep.first { it is DuplicateStep.ReadyToResume } as DuplicateStep.ReadyToResume
        assertEquals(prepared.jobId, step.jobId)
        assertEquals(0, transport.sent)
        assertEquals(null, db.printerDao().destination("duplicate", prepared.jobId, before.attemptId))
        restored.retryDuplicate()
        restored.duplicateJob.first { it?.status == "completed" || (it == null && transport.sent == 1) }
        val after = checkNotNull(db.productLabelJobDao().get(prepared.jobId))
        assertEquals(before.bytesDigest, after.bytesDigest)
        assertEquals(before.bytesBase64, after.bytesBase64)
        assertEquals(1, transport.sent)
        assertTrue(db.printerDao().destination("duplicate", prepared.jobId, before.attemptId) != null)
    }

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

    /**
     * The view model outlives its screen: the back-stack entry keeps it alive
     * while the exception routes are on top, and the scanner is one app-wide
     * flow. Without the gate the SSCC scanned to disassemble a box was recorded
     * here as «НЕВЕРНЫЙ КОД», with an error beep and a bumped counter.
     */
    @Test
    fun aScanIsIgnoredWhileAnotherRouteOwnsTheScanner() = runTest {
        aggregating(capacity = 3)
        val vm = vm()
        advanceUntilIdle()
        vm.setScanning(false)
        scan("GATED1")
        advanceUntilIdle()
        vm.setScanning(true)
        scan("GATED2")
        // Awaited, not advanced: `advanceUntilIdle` returns while Room is still
        // writing. Exactly one row proves the gated scan was dropped -- a leak
        // would make it two.
        db.outboxDao().count().first { it == 1 }
        advanceUntilIdle()
        assertEquals(1, db.outboxDao().countNow())
    }

    /** Two taps must not put two identical reprints in the manager's ledger. */
    @Test
    fun aDoubleRetryFromAnUnknownOutcomeWritesOneReprint() = runTest {
        aggregating(capacity = 1)
        transport.outcome = SendOutcome.Unknown("link lost")
        val vm = vm()
        advanceUntilIdle()
        scan("a")
        advanceUntilIdle()
        vm.closeStep.first { it is BoxCloseStep.Unknown }
        vm.retryPrint()
        vm.retryPrint()
        db.boxExceptionDao().observeUnackedCount().first { it == 1 }
        advanceUntilIdle()
        assertEquals(1, db.boxExceptionDao().queued().size)
    }
}
