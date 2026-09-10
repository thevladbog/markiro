package app.markiro.handheld.feature.printer

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.MainDispatcherRule
import app.markiro.handheld.core.label.LabelRenderer
import app.markiro.handheld.core.label.RasterResult
import app.markiro.handheld.core.label.RasterizeText
import app.markiro.handheld.core.print.DiscoveredPrinter
import app.markiro.handheld.core.print.NotReadyReason
import app.markiro.handheld.core.print.PrinterEntity
import app.markiro.handheld.core.print.PrinterStatus
import app.markiro.handheld.core.print.PrinterTransport
import app.markiro.handheld.core.print.SendOutcome
import app.markiro.handheld.core.storage.HandheldDatabase
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PrinterViewModelTest {
    @get:Rule
    val main = MainDispatcherRule()

    private lateinit var db: HandheldDatabase

    /** `nextStatus` rather than `status`, so the property never shadows the method it stands in for. */
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

    private val rasterize = RasterizeText { _, _ -> RasterResult("AA", 1, 1, 8, 8) }

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
    }

    @After
    fun tearDown() = db.close()

    private fun vm(
        transport: FakeTransport = FakeTransport(),
        paired: List<DiscoveredPrinter> = emptyList(),
    ) = PrinterViewModel(db.printerDao(), transport, LabelRenderer(rasterize), { paired }, { 1_757_000_000_000L })

    @Test
    fun aCheckedPrinterIsSavedAndSelected() = runTest {
        val model = vm()
        model.startAdd(TransportKind.WIFI)
        model.editHost("192.168.1.40")
        model.editPort("9100")
        model.setDpi(300)
        model.checkAndSave()
        advanceUntilIdle()
        val saved = model.state.first { it.printers.isNotEmpty() }
        assertEquals("192.168.1.40:9100", saved.selected?.address)
        assertEquals(300, saved.selected?.dpi)
        assertEquals("ready", saved.selected?.lastStatus)
    }

    @Test
    fun aPrinterThatIsNotReadySurfacesItsOwnReasonAndIsNotSaved() = runTest {
        val transport = FakeTransport(nextStatus = PrinterStatus.NotReady(NotReadyReason.NO_PAPER))
        val model = vm(transport)
        model.startAdd(TransportKind.WIFI)
        model.editHost("192.168.1.40")
        model.checkAndSave()
        advanceUntilIdle()
        assertEquals(NotReadyReason.NO_PAPER, model.addForm.first { it.error != null }.error)
        assertEquals(emptyList<PrinterEntity>(), db.printerDao().all())
    }

    @Test
    fun aDeliveredTestPrintAsksTheOperatorToConfirmIt() = runTest {
        val transport = FakeTransport()
        val model = vm(transport)
        saveSelected(model)
        model.printTest()
        advanceUntilIdle()
        assertTrue(model.testStep.first { it is TestPrintStep.Sent } is TestPrintStep.Sent)
        assertEquals(1, transport.sent)
    }

    @Test
    fun anUnknownResultNeverResendsOnItsOwn() = runTest {
        val transport = FakeTransport(outcome = SendOutcome.Unknown("link lost"))
        val model = vm(transport)
        saveSelected(model)
        model.printTest()
        advanceUntilIdle()
        assertTrue(model.testStep.first { it is TestPrintStep.Unknown } is TestPrintStep.Unknown)
        assertEquals(1, transport.sent)
        // Confirming resolves it without sending anything more.
        model.confirmTestPrinted()
        advanceUntilIdle()
        assertEquals(1, transport.sent)
        assertTrue(model.testStep.value is TestPrintStep.Idle)
    }

    @Test
    fun retryingAnUnknownResultIsAnExplicitSecondSend() = runTest {
        val transport = FakeTransport(outcome = SendOutcome.Unknown("link lost"))
        val model = vm(transport)
        saveSelected(model)
        model.printTest()
        advanceUntilIdle()
        model.retryTest()
        advanceUntilIdle()
        assertEquals(2, transport.sent)
    }

    @Test
    fun aRefusedPrintNamesTheReason() = runTest {
        val transport = FakeTransport(outcome = SendOutcome.Refused(NotReadyReason.NO_PAPER))
        val model = vm(transport)
        saveSelected(model)
        model.printTest()
        advanceUntilIdle()
        val step = model.testStep.first { it is TestPrintStep.Failed } as TestPrintStep.Failed
        assertEquals(NotReadyReason.NO_PAPER, step.reason)
    }

    @Test
    fun aPrinterOutOfPaperIsCaughtBeforeAnythingIsSent() = runTest {
        val transport = FakeTransport()
        val model = vm(transport)
        saveSelected(model)
        transport.nextStatus = PrinterStatus.NotReady(NotReadyReason.NO_PAPER)
        model.printTest()
        advanceUntilIdle()
        val step = model.testStep.first { it is TestPrintStep.Failed } as TestPrintStep.Failed
        assertEquals(NotReadyReason.NO_PAPER, step.reason)
        assertEquals(0, transport.sent)
    }

    @Test
    fun pairedBluetoothDevicesAreOffered() = runTest {
        val model = vm(paired = listOf(DiscoveredPrinter("AA:BB", "Zebra ZQ320", bonded = true)))
        model.loadPairedDevices()
        advanceUntilIdle()
        assertEquals(listOf("Zebra ZQ320"), model.state.first { it.paired.isNotEmpty() }.paired.map { it.name })
        model.pickPairedDevice(DiscoveredPrinter("AA:BB", "Zebra ZQ320", bonded = true))
        advanceUntilIdle()
        assertEquals("AA:BB", model.state.first { it.selected != null }.selected?.address)
    }

    private suspend fun saveSelected(model: PrinterViewModel) {
        model.startAdd(TransportKind.WIFI)
        model.editHost("192.168.1.40")
        model.checkAndSave()
        model.state.first { it.selected != null }
    }
}
