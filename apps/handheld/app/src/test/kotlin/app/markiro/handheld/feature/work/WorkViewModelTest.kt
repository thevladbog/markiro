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
import app.markiro.handheld.core.box.CloseResult
import app.markiro.handheld.core.box.ServerRange
import app.markiro.handheld.core.box.SsccPool
import app.markiro.handheld.core.km.Verdict
import app.markiro.handheld.core.label.LabelRenderer
import app.markiro.handheld.core.label.RasterResult
import app.markiro.handheld.core.label.RasterizeText
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
        return WorkViewModel(
            SavedStateHandle(mapOf("shiftId" to "s1")), db, ScanRecorder(db), ScanRouterAdapter(scans),
            { kind -> played += kind }, engine, session, ReachabilityTracker(), team, null,
            boxes, CloseBox(db, boxes, pool), BoxPrinter(db, boxes, LabelRenderer(rasterize), transport), flowOf(Unit),
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
        val box = vm.state.first { it.box != null }.box!!
        assertEquals(1, box.ordinal)
        assertEquals(1, box.filled)
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
}
