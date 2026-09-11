package app.markiro.handheld.feature.exceptions

import androidx.lifecycle.SavedStateHandle
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.MainDispatcherRule
import app.markiro.handheld.core.auth.OperatorRecord
import app.markiro.handheld.core.box.BoxPrinter
import app.markiro.handheld.core.box.BoxRepository
import app.markiro.handheld.core.exceptions.ExceptionEngine
import app.markiro.handheld.core.exceptions.ReprintReason
import app.markiro.handheld.core.label.LabelRenderer
import app.markiro.handheld.core.label.RasterResult
import app.markiro.handheld.core.label.RasterizeText
import app.markiro.handheld.core.print.NotReadyReason
import app.markiro.handheld.core.print.PrinterEntity
import app.markiro.handheld.core.print.PrinterStatus
import app.markiro.handheld.core.print.PrinterTransport
import app.markiro.handheld.core.print.SendOutcome
import app.markiro.handheld.core.scan.ScanEvent
import app.markiro.handheld.core.scan.ScanRouterAdapter
import app.markiro.handheld.core.storage.BoxEntity
import app.markiro.handheld.core.storage.CodeEntity
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.ShiftEntity
import app.markiro.handheld.feature.signin.SessionHolder
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ReprintViewModelTest {
    @get:Rule
    val main = MainDispatcherRule()

    private lateinit var db: HandheldDatabase
    private val scans = MutableSharedFlow<ScanEvent>(extraBufferCapacity = 4)
    private val session = SessionHolder().apply {
        signIn(OperatorRecord("op-1", "Иванова Анна", "4127", "operator", "x", null, true))
    }
    private val sscc = "046800899000000018"
    private val older = "046800899000000025"

    private class RecordingTransport : PrinterTransport {
        val sent = mutableListOf<String>()
        var refuse = false
        override suspend fun status(printer: PrinterEntity) = PrinterStatus.Ready
        override suspend fun send(printer: PrinterEntity, document: ByteArray): SendOutcome {
            sent += document.toString(Charsets.ISO_8859_1)
            return if (refuse) SendOutcome.Refused(NotReadyReason.NO_PAPER) else SendOutcome.Delivered
        }
    }

    private val transport = RecordingTransport()

    @Before
    fun setUp() = runTest {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        db.deviceConfigDao().upsert(
            DeviceConfigEntity(
                deviceId = "dev-1", deviceName = "ТСД 1", tenantId = "t", organizationName = "ООО",
                lineId = "l1", lineName = "Линия 2", kind = "handheld", serverUrl = "http://x", pairedAt = 1L,
            ),
        )
        db.shiftDao().upsert(
            ShiftEntity(
                id = "s1", number = "SEP26-003", status = "open", mode = "aggregation", productId = "p1",
                productName = "Вода", productPrintName = null, productGtin14 = "04680089900000", lineId = null,
                lineName = null, counterpartyName = null, plannedQty = null, plannedDate = null,
                productionDate = "2026-09-10", boxCapacity = 20, palletCapacity = null, palletsEnabled = false,
                validationPrintMode = "none", closePolicyKind = null, closeOwnerDeviceId = null, openedAt = null,
                listFetchedAt = 1L, shelfLifeDays = 365, ssccIssuerPrefix = "468008990",
                boxLabelTemplate = """{"widthMm":58,"heightMm":40,"dpi":203,"language":"zpl","elements":[
                    {"kind":"field","id":"s","xMm":2,"yMm":2,"field":"sscc","fontSizePt":8}]}""",
            ),
        )
        db.printerDao().upsert(
            PrinterEntity(
                id = "p1", name = "Zebra", transport = "wifi", address = "127.0.0.1:9100",
                language = "zpl", dpi = 203, selected = true, lastStatus = null, lastSeenAt = null,
            ),
        )
    }

    @After
    fun tearDown() = db.close()

    private suspend fun closedBox(id: String, number: String, closedAt: String, units: Int = 0) {
        db.boxDao().insert(
            BoxEntity(
                boxId = id, shiftId = "s1", sscc = number, openedAt = "2026-09-11T07:00:00.000Z",
                closedAt = closedAt, operatorId = "op-1", printState = "printed", printReason = null,
                ackedAt = "2026-09-11T07:31:00.000Z",
            ),
        )
        repeat(units) { n ->
            db.codeDao().insert(
                CodeEntity("$id-$n".padEnd(64, 'f'), "s1", "04600000000015", "$n", "2026-09-11T07:0$n:00.000Z", id),
            )
        }
    }

    private fun vm() = main.track(
        ReprintViewModel(
            db, ExceptionEngine(db),
            BoxPrinter(db, BoxRepository(db), LabelRenderer(RasterizeText { _, _ -> RasterResult("AA", 1, 1, 8, 8) }), transport),
            session, ScanRouterAdapter(scans), SavedStateHandle(mapOf("shiftId" to "s1")),
        ),
    )

    private suspend fun scan(raw: String) {
        scans.subscriptionCount.first { it > 0 }
        scans.emit(ScanEvent(raw, null, "debug", 0))
    }

    @Test
    fun theLastClosedBoxIsOfferedFirst() = runTest {
        closedBox("box-1", sscc, "2026-09-11T07:30:00.000Z")
        closedBox("box-2", older, "2026-09-11T08:30:00.000Z")
        assertEquals("box-2", vm().state.first { it.last != null }.last!!.boxId)
    }

    @Test
    fun aRetiredBoxIsNotOffered() = runTest {
        closedBox("box-1", sscc, "2026-09-11T07:30:00.000Z")
        closedBox("box-2", older, "2026-09-11T08:30:00.000Z")
        db.boxDao().markDisassembled("box-2", "2026-09-11T09:00:00.000Z")
        assertEquals("box-1", vm().state.first { it.last != null }.last!!.boxId)
    }

    @Test
    fun choosingAReasonQueuesTheFactAndPrints() = runTest {
        closedBox("box-1", sscc, "2026-09-11T07:30:00.000Z")
        val vm = vm()
        vm.state.first { it.last != null }
        vm.chooseLast()
        vm.chooseReason(ReprintReason.DAMAGED_LABEL)
        vm.state.first { it.done }
        val queued = db.boxExceptionDao().sendable(Long.MAX_VALUE, 10).single()
        assertEquals("reprint", queued.kind)
        assertEquals("Этикетка повреждена", queued.reason)
        assertEquals("box-1", queued.boxId)
        assertEquals(1, transport.sent.size)
    }

    /** Reprint is an audit fact and a print job: no box or item state moves. */
    @Test
    fun reprintChangesNoBoxOrItemState() = runTest {
        closedBox("box-1", sscc, "2026-09-11T07:30:00.000Z", units = 3)
        val vm = vm()
        vm.state.first { it.last != null }
        vm.chooseLast()
        vm.chooseReason(ReprintReason.DAMAGED_LABEL)
        vm.state.first { it.done }
        assertNull(db.boxDao().get("box-1")?.disassembledAt)
        assertEquals(3, db.boxDao().itemCount("box-1"))
    }

    @Test
    fun scanningAnSsccSelectsThatBox() = runTest {
        closedBox("box-1", sscc, "2026-09-11T07:30:00.000Z")
        closedBox("box-2", older, "2026-09-11T08:30:00.000Z")
        val vm = vm()
        vm.state.first { it.last != null }
        scan("(00)$sscc")
        assertEquals("box-1", vm.state.first { it.selected != null }.selected!!.boxId)
    }

    /** The ledger records the request even when the printer then refuses. */
    @Test
    fun theFactIsQueuedEvenWhenPrintingFails() = runTest {
        closedBox("box-1", sscc, "2026-09-11T07:30:00.000Z")
        transport.refuse = true
        val vm = vm()
        vm.state.first { it.last != null }
        vm.chooseLast()
        vm.chooseReason(ReprintReason.PRINTER_JAM)
        vm.state.first { it.done }
        assertEquals(1, db.boxExceptionDao().unackedCount())
    }
}
