package app.markiro.handheld.core.box

import app.markiro.handheld.core.storage.initializeRecoveryForTest
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.label.LabelRenderer
import app.markiro.handheld.core.label.RasterResult
import app.markiro.handheld.core.label.RasterizeText
import app.markiro.handheld.core.print.NotReadyReason
import app.markiro.handheld.core.print.PrinterEntity
import app.markiro.handheld.core.print.PrinterStatus
import app.markiro.handheld.core.print.PrinterTransport
import app.markiro.handheld.core.print.SendOutcome
import app.markiro.handheld.core.storage.BoxEntity
import app.markiro.handheld.core.storage.CodeEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.ShiftEntity
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class BoxPrinterTest {
    private lateinit var db: HandheldDatabase

    private class FakeTransport(
        var nextStatus: PrinterStatus = PrinterStatus.Ready,
        var outcome: SendOutcome = SendOutcome.Delivered,
    ) : PrinterTransport {
        var sent: ByteArray? = null
        override suspend fun status(printer: PrinterEntity) = nextStatus
        override suspend fun send(printer: PrinterEntity, document: ByteArray): SendOutcome {
            sent = document
            return outcome
        }
    }

    /** A 58×40 label carrying the SSCC as text, which is all these assertions need. */
    private val template = """
        {"widthMm":58,"heightMm":40,"dpi":203,"language":"zpl","elements":[
          {"kind":"field","id":"s","xMm":2,"yMm":2,"field":"sscc","fontSizePt":8},
          {"kind":"field","id":"e","xMm":2,"yMm":10,"field":"expiry","fontSizePt":8},
          {"kind":"field","id":"q","xMm":2,"yMm":18,"field":"qty","fontSizePt":8}
        ]}
    """.trimIndent()

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        db.initializeRecoveryForTest()
    }

    @After
    fun tearDown() = db.close()

    private fun printer(transport: FakeTransport) = BoxPrinter(
        db,
        BoxRepository(db),
        LabelRenderer(RasterizeText { _, _ -> RasterResult("AA", 1, 1, 8, 8) }),
        transport,
    )

    private suspend fun seedClosedBox(
        boxTemplate: String? = template,
        withPrinter: Boolean = true,
        units: Int = 20,
    ) {
        db.shiftDao().upsert(
            ShiftEntity(
                id = "s1", number = "SEP26-003", status = "open", mode = "aggregation", productId = "p1",
                productName = "Вода питьевая 0,5 л", productPrintName = null, productGtin14 = "04680089900000",
                lineId = null, lineName = null, counterpartyName = null, plannedQty = null, plannedDate = null,
                productionDate = "2026-09-10", boxCapacity = 20, palletBoxCapacity = null, palletsEnabled = false,
                validationPrintMode = "none", closePolicyKind = null, closeOwnerDeviceId = null, openedAt = null,
                listFetchedAt = 1L, boxLabelTemplate = boxTemplate, shelfLifeDays = 365,
                ssccIssuerPrefix = "468008990",
            ),
        )
        if (withPrinter) {
            db.printerDao().upsert(
                PrinterEntity(
                    id = "p1", name = "Zebra", transport = "wifi", address = "127.0.0.1:9100",
                    language = "zpl", dpi = 203, selected = true, lastStatus = null, lastSeenAt = null,
                ),
            )
        }
        db.boxDao().insert(
            BoxEntity(
                boxId = "box-1", shiftId = "s1", sscc = "046800899000000018",
                openedAt = "2026-09-10T07:00:00.000Z", closedAt = "2026-09-10T08:00:00.000Z",
                operatorId = "op1", printState = BoxPrint.PENDING, printReason = null, ackedAt = null,
            ),
        )
        repeat(units) { db.codeDao().insert(CodeEntity("h$it", "s1", "04680089900000", "$it", "t", "box-1")) }
    }

    @Test
    fun aClosedBoxPrintsItsOwnSsccDatesAndCount() = runTest {
        val transport = FakeTransport()
        seedClosedBox()
        assertEquals(PrintOutcome.Printed, printer(transport).print("box-1"))
        val document = transport.sent!!.toString(Charsets.ISO_8859_1)
        // The bare 18 digits reach the emitter; the (00) identifier is added there.
        assertTrue(document, document.contains("046800899000000018"))
        // Production day is day one: 2026-09-10 plus 365 days is usable through 2027-09-09.
        assertTrue(document, document.contains("09.09.2027"))
        // The quantity never reaches the document as text: its display value
        // carries «шт.», so the field is rasterized like any other Cyrillic run.
        // The old assertion looked for "20", which matched the SSCC and the font
        // size and would have passed with no quantity on the label at all.
        assertEquals(3, Regex("\\^FO").findAll(document).count())
        assertTrue(document, document.contains("^GFA"))
        assertEquals(BoxPrint.PRINTED, db.boxDao().get("box-1")!!.printState)
    }

    @Test
    fun theLabelIsStampedFromTheBoxsOwnClosureNotFromNow() = runTest {
        // A recovery print the next morning must carry the same two dates, or
        // one SSCC ends up on two labels that disagree about expiry.
        val transport = FakeTransport()
        seedClosedBox()
        printer(transport).print("box-1")
        val first = transport.sent!!.toString(Charsets.ISO_8859_1)
        printer(transport).print("box-1")
        assertEquals(first, transport.sent!!.toString(Charsets.ISO_8859_1))
    }

    @Test
    fun aShiftWithNoTemplateFailsByNameWithoutSending() = runTest {
        val transport = FakeTransport()
        seedClosedBox(boxTemplate = null)
        assertEquals(PrintOutcome.Failed(PrintReason.TEMPLATE_MISSING), printer(transport).print("box-1"))
        assertNull(transport.sent)
        assertEquals(PrintReason.TEMPLATE_MISSING, db.boxDao().get("box-1")!!.printReason)
    }

    @Test
    fun noPrinterConfiguredIsItsOwnReasonRatherThanSilence() = runTest {
        val transport = FakeTransport()
        seedClosedBox(withPrinter = false)
        assertEquals(PrintOutcome.Failed(PrintReason.PRINTER_UNCONFIGURED), printer(transport).print("box-1"))
        assertNull(transport.sent)
    }

    @Test
    fun aPrinterOutOfPaperRefusesBeforeAnythingIsSent() = runTest {
        val transport = FakeTransport(nextStatus = PrinterStatus.NotReady(NotReadyReason.NO_PAPER))
        seedClosedBox()
        assertEquals(PrintOutcome.Failed(PrintReason.NO_PAPER), printer(transport).print("box-1"))
        assertNull(transport.sent)
    }

    @Test
    fun aLinkThatBreaksPartwayLeavesTheBoxUnknown() = runTest {
        val transport = FakeTransport(outcome = SendOutcome.Unknown("link lost"))
        seedClosedBox()
        assertTrue(printer(transport).print("box-1") is PrintOutcome.Unknown)
        val stored = db.boxDao().get("box-1")!!
        assertEquals(BoxPrint.UNKNOWN, stored.printState)
        assertEquals("link lost", stored.printReason)
    }

    @Test
    fun aPrintInterruptedByTheAppDyingIsUnknownNotResumed() = runTest {
        seedClosedBox()
        db.boxDao().setPrintState("box-1", BoxPrint.PRINTING, null)
        assertEquals(1, BoxRepository(db).demoteInterruptedPrints())
        // Resuming would be an automatic resend, which is the one thing an
        // unknown outcome must never do.
        assertEquals(BoxPrint.UNKNOWN, db.boxDao().get("box-1")!!.printState)
    }

    @Test
    fun anOperatorCanResolveAnUnknownWithoutSendingAnything() = runTest {
        val transport = FakeTransport(outcome = SendOutcome.Unknown("link lost"))
        seedClosedBox()
        val boxPrinter = printer(transport)
        boxPrinter.print("box-1")
        transport.sent = null
        boxPrinter.resolveUnknownAsPrinted("box-1")
        assertEquals(BoxPrint.PRINTED, db.boxDao().get("box-1")!!.printState)
        assertNull(transport.sent)
    }

    @Test
    fun aStillOpenBoxIsRefusedRatherThanPrintedWithoutANumber() = runTest {
        seedClosedBox()
        db.boxDao().insert(
            BoxEntity(
                boxId = "box-2", shiftId = "s1", sscc = null, openedAt = "2026-09-10T09:00:00.000Z",
                closedAt = null, operatorId = null, printState = BoxPrint.PENDING, printReason = null, ackedAt = null,
            ),
        )
        val transport = FakeTransport()
        assertEquals(PrintOutcome.Failed(PrintReason.BOX_OPEN), printer(transport).print("box-2"))
        assertNull(transport.sent)
    }

    @Test
    fun deferringKeepsWhyTheLastAttemptFailed() = runTest {
        // Erasing it leaves the queue saying only that the label did not print,
        // which is both less useful and untrue: the operator set it aside, and
        // «Нет бумаги» is still the reason it is waiting.
        val transport = FakeTransport(nextStatus = PrinterStatus.NotReady(NotReadyReason.NO_PAPER))
        seedClosedBox()
        val boxPrinter = printer(transport)
        boxPrinter.print("box-1")
        boxPrinter.defer("box-1")
        val stored = db.boxDao().get("box-1")!!
        assertEquals(BoxPrint.DEFERRED, stored.printState)
        assertEquals(PrintReason.NO_PAPER, stored.printReason)
    }
}
