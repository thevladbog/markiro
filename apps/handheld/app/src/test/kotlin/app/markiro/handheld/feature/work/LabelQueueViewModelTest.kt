package app.markiro.handheld.feature.work

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.MainDispatcherRule
import app.markiro.handheld.core.box.BoxPrint
import app.markiro.handheld.core.box.BoxPrinter
import app.markiro.handheld.core.box.BoxRepository
import app.markiro.handheld.core.box.PalletLock
import app.markiro.handheld.core.box.PalletPrinter
import app.markiro.handheld.core.box.PalletRepository
import app.markiro.handheld.core.label.LabelRenderer
import app.markiro.handheld.core.label.RasterResult
import app.markiro.handheld.core.label.RasterizeText
import app.markiro.handheld.core.print.PrinterEntity
import app.markiro.handheld.core.print.PrinterStatus
import app.markiro.handheld.core.print.PrinterTransport
import app.markiro.handheld.core.print.SendOutcome
import app.markiro.handheld.core.storage.BoxEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.PalletEntity
import app.markiro.handheld.core.storage.PalletPrint
import app.markiro.handheld.core.storage.ShiftEntity
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class LabelQueueViewModelTest {
    @get:Rule
    val main = MainDispatcherRule()

    private lateinit var db: HandheldDatabase

    private class RecordingTransport : PrinterTransport {
        val printed = mutableListOf<String>()
        override suspend fun status(printer: PrinterEntity) = PrinterStatus.Ready
        override suspend fun send(printer: PrinterEntity, document: ByteArray): SendOutcome {
            printed += document.toString(Charsets.ISO_8859_1)
            return SendOutcome.Delivered
        }
    }

    private val transport = RecordingTransport()

    @Before
    fun setUp() = runTest {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        db.shiftDao().upsert(
            ShiftEntity(
                id = "s1", number = "SEP26-003", status = "open", mode = "aggregation", productId = "p1",
                productName = "Вода", productPrintName = null, productGtin14 = "04680089900000", lineId = null,
                lineName = null, counterpartyName = null, plannedQty = null, plannedDate = null,
                productionDate = "2026-09-10", boxCapacity = 20, palletBoxCapacity = null, palletsEnabled = false,
                validationPrintMode = "none", closePolicyKind = null, closeOwnerDeviceId = null, openedAt = null,
                listFetchedAt = 1L, shelfLifeDays = 365, ssccIssuerPrefix = "468008990",
                boxLabelTemplate = """{"widthMm":58,"heightMm":40,"dpi":203,"language":"zpl","elements":[
                    {"kind":"field","id":"s","xMm":2,"yMm":2,"field":"sscc","fontSizePt":8}]}""",
                palletLabelTemplateSpec = """{"widthMm":100,"heightMm":150,"dpi":203,"language":"zpl","elements":[
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

    private suspend fun box(id: String, sscc: String, state: String, shiftId: String = "s1") = db.boxDao().insert(
        BoxEntity(
            boxId = id, shiftId = shiftId, sscc = sscc, openedAt = "2026-09-10T07:00:00.000Z",
            closedAt = "2026-09-10T08:00:00.000Z", operatorId = null, printState = state,
            printReason = if (state == BoxPrint.FAILED) "no_paper" else null, ackedAt = null,
        ),
    )

    private suspend fun pallet(id: String, sscc: String, state: String, shiftId: String = "s1") = db.palletDao().insert(
        PalletEntity(
            palletId = id, shiftId = shiftId, terminalId = null, sscc = sscc, openedAt = "2026-09-10T07:00:00.000Z",
            closedAt = "2026-09-10T08:00:00.000Z", operatorId = null, printState = state,
            printReason = if (state == PalletPrint.FAILED) "no_paper" else null, ackedAt = null,
        ),
    )

    private fun model(): LabelQueueViewModel {
        val palletLock = PalletLock(db)
        val pallets = PalletRepository(db, palletLock)
        return main.track(
            LabelQueueViewModel(
                BoxRepository(db),
                BoxPrinter(db, BoxRepository(db), LabelRenderer(RasterizeText { _, _ -> RasterResult("AA", 1, 1, 8, 8) }), transport),
                pallets,
                PalletPrinter(db, pallets, LabelRenderer(RasterizeText { _, _ -> RasterResult("AA", 1, 1, 8, 8) }), transport),
            ),
        )
    }

    @Test
    fun theQueueListsOnlyClosedBoxesWhoseLabelIsNotResolved() = runTest {
        box("b1", "046800899000000018", BoxPrint.FAILED)
        box("b2", "046800899000000025", BoxPrint.PRINTED)
        box("b3", "046800899000000032", BoxPrint.DEFERRED)
        val items = model().state.first { it.items.size == 2 }.items
        assertEquals(listOf("b1", "b3"), items.map { it.boxId })
    }

    @Test
    fun printAllSkipsABoxWhoseLastAttemptIsUnknown() = runTest {
        // Retrying an unknown could put a second label on a box the server has
        // already accepted, which is the whole reason it is its own state.
        box("b1", "046800899000000018", BoxPrint.FAILED)
        box("b2", "046800899000000025", BoxPrint.UNKNOWN)
        val vm = model()
        vm.state.first { it.items.size == 2 }
        vm.printAll()
        vm.state.first { it.items.size == 1 }
        assertEquals(1, transport.printed.size)
        assertTrue(transport.printed.single().contains("046800899000000018"))
        assertEquals(BoxPrint.UNKNOWN, db.boxDao().get("b2")?.printState)
    }

    @Test
    fun anUnknownCanStillBePrintedOneAtATimeByAPerson() = runTest {
        box("b1", "046800899000000018", BoxPrint.UNKNOWN)
        val vm = model()
        vm.state.first { it.items.size == 1 }
        vm.printOne("b1")
        vm.state.first { it.items.isEmpty() }
        assertEquals(1, transport.printed.size)
    }

    @Test
    fun resolvingAnUnknownSendsNothing() = runTest {
        box("b1", "046800899000000018", BoxPrint.UNKNOWN)
        val vm = model()
        vm.state.first { it.items.size == 1 }
        vm.resolveUnknown("b1")
        vm.state.first { it.items.isEmpty() }
        // The operator looked at the printer and said so; nothing left the device.
        assertEquals(0, transport.printed.size)
        assertEquals(BoxPrint.PRINTED, db.boxDao().get("b1")?.printState)
    }

    @Test
    fun theQueueOutlivesTheShiftThatFilledIt() = runTest {
        // The boxes are already on the server; the label is a debt of the device.
        box("b1", "046800899000000018", BoxPrint.FAILED)
        db.shiftDao().get("s1")!!.let { db.shiftDao().upsert(it.copy(status = "closed")) }
        assertEquals(1, model().state.first { it.items.isNotEmpty() }.items.size)
    }

    // -- The pallet half of the queue (06d): `PalletPrinter` mirrors
    // `BoxPrinter`, so its deferred and failed labels ride this same queue. --

    @Test
    fun theQueueAlsoListsClosedPalletsWhoseLabelIsNotResolved() = runTest {
        box("b1", "046800899000000018", BoxPrint.PRINTED)
        pallet("p1", "146800899000000012", PalletPrint.FAILED)
        pallet("p2", "146800899000000029", PalletPrint.PRINTED)
        val items = model().state.first { it.items.size == 1 }.items
        assertEquals(listOf("p1"), items.map { it.boxId })
        assertEquals(LabelKind.PALLET, items.single().kind)
    }

    @Test
    fun aQueuedPalletCanBePrintedOneAtATimeByAPerson() = runTest {
        pallet("p1", "146800899000000012", PalletPrint.FAILED)
        val vm = model()
        vm.state.first { it.items.size == 1 }
        vm.printOne("p1")
        vm.state.first { it.items.isEmpty() }
        assertEquals(1, transport.printed.size)
        assertEquals(PalletPrint.PRINTED, db.palletDao().get("p1")?.printState)
    }

    @Test
    fun printAllReachesBothBoxesAndPalletsButSkipsWhicheverIsUnknown() = runTest {
        box("b1", "046800899000000018", BoxPrint.FAILED)
        pallet("p1", "146800899000000012", PalletPrint.UNKNOWN)
        val vm = model()
        vm.state.first { it.items.size == 2 }
        vm.printAll()
        vm.state.first { it.items.size == 1 }
        assertEquals(1, transport.printed.size)
        assertTrue(transport.printed.single().contains("046800899000000018"))
        assertEquals(PalletPrint.UNKNOWN, db.palletDao().get("p1")?.printState)
    }

    @Test
    fun resolvingAnUnknownPalletSendsNothing() = runTest {
        pallet("p1", "146800899000000012", PalletPrint.UNKNOWN)
        val vm = model()
        vm.state.first { it.items.size == 1 }
        vm.resolveUnknown("p1")
        vm.state.first { it.items.isEmpty() }
        assertEquals(0, transport.printed.size)
        assertEquals(PalletPrint.PRINTED, db.palletDao().get("p1")?.printState)
    }
}
