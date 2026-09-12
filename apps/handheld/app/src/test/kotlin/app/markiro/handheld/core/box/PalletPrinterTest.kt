package app.markiro.handheld.core.box

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
import app.markiro.handheld.core.storage.PalletEntity
import app.markiro.handheld.core.storage.PalletPrint
import app.markiro.handheld.core.storage.ShiftEntity
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * `BoxPrinterTest` one level up. The cases that differ from a box are the ones
 * worth having twice: a pallet label carries BOTH counts (`qty` in units,
 * `qty.boxes` in boxes), and a pallet that is missing or still open fails with
 * its own reason rather than a box's -- `pallet_missing`/`pallet_open` exist so
 * the operator is not told a box is open when a pallet is.
 */
@RunWith(AndroidJUnit4::class)
class PalletPrinterTest {
    private lateinit var db: HandheldDatabase
    private lateinit var palletLock: PalletLock

    private companion object {
        const val PREFIX = "468008990"

        /** Built rather than spelled out, so the check digit is the real one. */
        val PALLET_SSCC: String = Sscc.build(SsccPool.PALLET_EXTENSION_DIGIT, PREFIX, 1)
    }

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

    /** A 100×100 pallet label carrying the SSCC, the expiry and BOTH quantity fields. */
    private val template = """
        {"widthMm":100,"heightMm":100,"dpi":203,"language":"zpl","elements":[
          {"kind":"field","id":"s","xMm":2,"yMm":2,"field":"sscc","fontSizePt":10},
          {"kind":"field","id":"e","xMm":2,"yMm":12,"field":"expiry","fontSizePt":10},
          {"kind":"field","id":"q","xMm":2,"yMm":22,"field":"qty","fontSizePt":10},
          {"kind":"field","id":"b","xMm":2,"yMm":32,"field":"qty.boxes","fontSizePt":10}
        ]}
    """.trimIndent()

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        palletLock = PalletLock(db)
    }

    @After
    fun tearDown() = db.close()

    private fun printer(transport: FakeTransport) = PalletPrinter(
        db,
        PalletRepository(db, palletLock),
        LabelRenderer(RasterizeText { _, _ -> RasterResult("AA", 1, 1, 8, 8) }),
        transport,
    )

    private suspend fun seedShift(palletTemplate: String? = template, withPrinter: Boolean = true) {
        db.shiftDao().upsert(
            ShiftEntity(
                id = "s1", number = "SEP26-003", status = "open", mode = "aggregation", productId = "p1",
                productName = "Вода питьевая 0,5 л", productPrintName = null, productGtin14 = "04680089900000",
                lineId = null, lineName = null, counterpartyName = null, plannedQty = null, plannedDate = null,
                productionDate = "2026-09-10", boxCapacity = 20, palletBoxCapacity = 2, palletsEnabled = true,
                validationPrintMode = "none", closePolicyKind = null, closeOwnerDeviceId = null, openedAt = null,
                listFetchedAt = 1L, shelfLifeDays = 365, ssccIssuerPrefix = PREFIX,
                palletLabelTemplateSpec = palletTemplate,
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
    }

    /** A closed pallet holding [boxes] boxes of [unitsPerBox] units each. */
    private suspend fun seedClosedPallet(boxes: Int = 2, unitsPerBox: Int = 20) {
        db.palletDao().insert(
            PalletEntity(
                palletId = "pal-1", shiftId = "s1", terminalId = null, sscc = PALLET_SSCC,
                openedAt = "2026-09-10T07:00:00.000Z", closedAt = "2026-09-10T08:00:00.000Z",
                operatorId = "op1", printState = PalletPrint.PENDING, printReason = null, ackedAt = null,
            ),
        )
        repeat(boxes) { box ->
            db.boxDao().insert(
                BoxEntity(
                    boxId = "box-$box", shiftId = "s1", sscc = "04680089900000001$box",
                    openedAt = "2026-09-10T07:00:00.000Z", closedAt = "2026-09-10T07:30:00.000Z",
                    operatorId = "op1", printState = BoxPrint.PRINTED, printReason = null, ackedAt = null,
                    palletId = "pal-1",
                ),
            )
            repeat(unitsPerBox) {
                db.codeDao().insert(CodeEntity("h-$box-$it", "s1", "04680089900000", "$box-$it", "t", "box-$box"))
            }
        }
    }

    @Test
    fun aClosedPalletPrintsItsOwnSsccDatesAndBothCounts() = runTest {
        val transport = FakeTransport()
        seedShift()
        seedClosedPallet()
        assertEquals(PrintOutcome.Printed, printer(transport).print("pal-1"))
        val document = transport.sent!!.toString(Charsets.ISO_8859_1)
        // The bare 18 digits reach the emitter; the (00) identifier is added there.
        // A pallet SSCC starts with the pallet extension digit, 1.
        assertEquals('1', PALLET_SSCC.first())
        assertTrue(document, document.contains(PALLET_SSCC))
        // Production day is day one: 2026-09-10 plus 365 days is usable through 2027-09-09.
        assertTrue(document, document.contains("09.09.2027"))
        // Both quantity fields render. Their display values carry «шт.»/«кор.»,
        // so they reach the document as raster rather than as digits -- four
        // placed elements is what proves neither was silently dropped.
        assertEquals(4, Regex("\\^FO").findAll(document).count())
        assertTrue(document, document.contains("^GFA"))
        assertEquals(PalletPrint.PRINTED, db.palletDao().get("pal-1")!!.printState)
    }

    @Test
    fun theTwoCountsAreUnitsAndBoxesNotTheSameNumberTwice() = runTest {
        // The one field a pallet does not share with a box. `qty` is product
        // units across the pallet; `qty.boxes` is the box count a clerk reads
        // at goods-in. Asserted on the field map rather than the raster, since
        // the rendered text is an image by the time it reaches the printer.
        seedShift()
        seedClosedPallet(boxes = 3, unitsPerBox = 20)
        val pallets = PalletRepository(db, palletLock)
        assertEquals(3, pallets.boxCount("pal-1"))
        assertEquals(60, pallets.itemCount("pal-1"))
    }

    @Test
    fun aPalletThatDoesNotExistFailsAsAPalletNotAsABox() = runTest {
        val transport = FakeTransport()
        seedShift()
        assertEquals(PrintOutcome.Failed(PrintReason.PALLET_MISSING), printer(transport).print("pal-nope"))
        assertNull(transport.sent)
    }

    @Test
    fun aStillOpenPalletIsRefusedRatherThanPrintedWithoutANumber() = runTest {
        val transport = FakeTransport()
        seedShift()
        db.palletDao().insert(
            PalletEntity(
                palletId = "pal-open", shiftId = "s1", terminalId = null, sscc = null,
                openedAt = "2026-09-10T09:00:00.000Z", closedAt = null, operatorId = null,
                printState = PalletPrint.PENDING, printReason = null, ackedAt = null,
            ),
        )
        assertEquals(PrintOutcome.Failed(PrintReason.PALLET_OPEN), printer(transport).print("pal-open"))
        assertNull(transport.sent)
        assertEquals(PrintReason.PALLET_OPEN, db.palletDao().get("pal-open")!!.printReason)
    }

    @Test
    fun aShiftWithNoPalletTemplateFailsByNameWithoutSending() = runTest {
        val transport = FakeTransport()
        seedShift(palletTemplate = null)
        seedClosedPallet()
        assertEquals(PrintOutcome.Failed(PrintReason.TEMPLATE_MISSING), printer(transport).print("pal-1"))
        assertNull(transport.sent)
        assertEquals(PrintReason.TEMPLATE_MISSING, db.palletDao().get("pal-1")!!.printReason)
    }

    @Test
    fun aPrinterOutOfPaperRefusesBeforeAnythingIsSent() = runTest {
        val transport = FakeTransport(nextStatus = PrinterStatus.NotReady(NotReadyReason.NO_PAPER))
        seedShift()
        seedClosedPallet()
        assertEquals(PrintOutcome.Failed(PrintReason.NO_PAPER), printer(transport).print("pal-1"))
        assertNull(transport.sent)
    }

    @Test
    fun theLabelIsStampedFromThePalletsOwnClosureNotFromNow() = runTest {
        // A recovery print the next morning must carry the same two dates, or
        // one SSCC ends up on two labels that disagree about expiry.
        val transport = FakeTransport()
        seedShift()
        seedClosedPallet()
        printer(transport).print("pal-1")
        val first = transport.sent!!.toString(Charsets.ISO_8859_1)
        printer(transport).print("pal-1")
        assertEquals(first, transport.sent!!.toString(Charsets.ISO_8859_1))
    }

    @Test
    fun aLinkThatBreaksPartwayLeavesThePalletUnknownAndDeferringKeepsWhy() = runTest {
        val transport = FakeTransport(outcome = SendOutcome.Unknown("link lost"))
        seedShift()
        seedClosedPallet()
        val palletPrinter = printer(transport)
        assertTrue(palletPrinter.print("pal-1") is PrintOutcome.Unknown)
        val afterSend = db.palletDao().get("pal-1")!!
        // Never resent on its own: a retry could put a second label on a pallet
        // the server has already accepted.
        assertEquals(PalletPrint.UNKNOWN, afterSend.printState)
        assertEquals("link lost", afterSend.printReason)
        palletPrinter.defer("pal-1")
        val afterDefer = db.palletDao().get("pal-1")!!
        assertEquals(PalletPrint.DEFERRED, afterDefer.printState)
        assertEquals("link lost", afterDefer.printReason)
    }
}
