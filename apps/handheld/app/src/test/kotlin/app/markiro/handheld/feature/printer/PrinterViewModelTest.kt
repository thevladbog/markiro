package app.markiro.handheld.feature.printer

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.MainDispatcherRule
import app.markiro.handheld.core.label.LabelRenderer
import app.markiro.handheld.core.label.PrinterLanguage
import app.markiro.handheld.core.label.RasterResult
import app.markiro.handheld.core.label.RasterizeText
import app.markiro.handheld.core.print.DiscoveredPrinter
import app.markiro.handheld.core.print.NotReadyReason
import app.markiro.handheld.core.print.PrinterEntity
import app.markiro.handheld.core.print.PrinterStatus
import app.markiro.handheld.core.print.PrinterTransport
import app.markiro.handheld.core.print.SendOutcome
import app.markiro.handheld.core.storage.HandheldDatabase
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
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
    fun tearDown() {
        try {
            main.cancelAndJoinModels()
        } finally {
            db.close()
        }
    }

    private fun vm(
        transport: FakeTransport = FakeTransport(),
        paired: List<DiscoveredPrinter> = emptyList(),
    ) = main.track(PrinterViewModel(db.printerDao(), transport, LabelRenderer(rasterize), { paired }, { 1_757_000_000_000L }))

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
    fun addingTheSameAddressTwiceUpdatesTheSameRow() = runTest {
        val model = vm()
        saveSelected(model)
        saveSelected(model)
        assertEquals(1, db.printerDao().all().size)
        assertEquals("192.168.1.40:9100", db.printerDao().selected()?.address)
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
    fun aPortOutsideTheRangeIsStoredAsThePortThatWillActuallyBeUsed() = runTest {
        // The connector falls back for an unusable port. Storing the typed one anyway would show the
        // operator an address the socket never dials.
        val model = vm()
        model.startAdd(TransportKind.WIFI)
        model.editHost("192.168.1.40")
        model.editPort("99999")
        model.checkAndSave()
        advanceUntilIdle()
        assertEquals("192.168.1.40:9100", model.state.first { it.selected != null }.selected?.address)
    }

    @Test
    fun aSavedPrinterTellsTheFormItHasNothingLeftToShow() = runTest {
        val model = vm()
        model.startAdd(TransportKind.WIFI)
        model.editHost("192.168.1.40")
        // Subscribed before the check, because the signal is a one-shot with nothing replayed.
        val signalled = async { model.saved.first() }
        runCurrent()
        model.checkAndSave()
        signalled.await()
        // Arriving here is the point: without the signal the form simply blanks and says nothing.
        assertEquals(AddPrinterForm(), model.addForm.value)
    }

    @Test
    fun aPrinterThatRefusesNeverSignalsASave() = runTest {
        val model = vm(FakeTransport(nextStatus = PrinterStatus.NotReady(NotReadyReason.NO_PAPER)))
        val saved = mutableListOf<Unit>()
        backgroundScope.launch { model.saved.toList(saved) }
        runCurrent()
        model.startAdd(TransportKind.WIFI)
        model.editHost("192.168.1.40")
        model.checkAndSave()
        model.addForm.first { it.error != null }
        assertEquals(0, saved.size)
    }

    @Test
    fun switchingTransportKeepsTheLanguageAndResolutionAlreadyPicked() = runTest {
        // The Bluetooth path carries both over to the paired device, so resetting them here would
        // silently print the belt printer's label in the wrong language.
        val model = vm()
        model.startAdd(TransportKind.WIFI)
        model.setLanguage(PrinterLanguage.TSPL)
        model.setDpi(300)
        model.setTransport(TransportKind.BLUETOOTH)
        val form = model.addForm.value
        assertEquals(TransportKind.BLUETOOTH, form.transport)
        assertEquals(PrinterLanguage.TSPL, form.language)
        assertEquals(300, form.dpi)
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

    @Test
    fun pickingTheSamePairedDeviceTwiceUpdatesTheSameRow() = runTest {
        // The same rule the network path already follows: one address is one printer, or the list
        // fills with rows the operator cannot tell apart or remove the right one of.
        val device = DiscoveredPrinter("AA:BB", "Zebra ZQ320", bonded = true)
        val model = vm(paired = listOf(device))
        model.setTransport(TransportKind.BLUETOOTH)
        model.pickPairedDevice(device)
        model.state.first { it.selected?.language == "zpl" }
        // The second pick changes the language, so the row it lands on is observable.
        model.setLanguage(PrinterLanguage.TSPL)
        model.pickPairedDevice(device)
        model.state.first { it.selected?.language == "tspl" }
        assertEquals(1, db.printerDao().all().size)
    }

    private suspend fun saveSelected(model: PrinterViewModel) {
        model.startAdd(TransportKind.WIFI)
        model.editHost("192.168.1.40")
        model.checkAndSave()
        model.state.first { it.selected != null }
    }
}
