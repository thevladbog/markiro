package app.markiro.handheld.core.box

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.storage.BoxEntity
import app.markiro.handheld.core.storage.CodeEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.ShiftEntity
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * `ClosePallet` is `CloseBox` one level up, and `CloseBox`'s own join/auto-close
 * of the pallet a box fills is exercised here too: the two features share one
 * invariant (a serial that leaves a pool without landing on its label is
 * gone), so they share one test file rather than splitting a single race into
 * two.
 */
@RunWith(AndroidJUnit4::class)
class ClosePalletTest {
    private lateinit var db: HandheldDatabase
    private lateinit var pool: SsccPool
    private lateinit var boxes: BoxRepository
    private lateinit var pallets: PalletRepository
    private lateinit var closePallet: ClosePallet
    private lateinit var closeBox: CloseBox
    private var now = 1_757_000_000_000L

    private companion object {
        const val PREFIX = "468008990"
    }

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        pool = SsccPool(db)
        boxes = BoxRepository(db) { now }
        pallets = PalletRepository(db) { now }
        closePallet = ClosePallet(db, pool) { now }
        closeBox = CloseBox(db, boxes, pool, pallets, closePallet) { now }
    }

    @After
    fun tearDown() = db.close()

    private suspend fun givenShift(boxCapacity: Int? = 100, palletBoxCapacity: Int? = null) {
        db.shiftDao().upsert(
            ShiftEntity(
                id = "s1", number = "SEP26-003", status = "open", mode = "aggregation", productId = "p1",
                productName = "Вода питьевая 0,5 л", productPrintName = null, productGtin14 = "04680089900000",
                lineId = null, lineName = null, counterpartyName = null, plannedQty = null, plannedDate = null,
                productionDate = "2026-09-11", boxCapacity = boxCapacity, palletsEnabled = palletBoxCapacity != null,
                validationPrintMode = "none", closePolicyKind = null, closeOwnerDeviceId = null, openedAt = null,
                listFetchedAt = 1L, shelfLifeDays = 365, ssccIssuerPrefix = PREFIX,
                palletBoxCapacity = palletBoxCapacity,
            ),
        )
    }

    private suspend fun seedBoxPool(from: Long = 1, to: Long = 200) =
        pool.addRange(ServerRange(PREFIX, SsccPool.BOX_EXTENSION_DIGIT, from, to, null))

    private suspend fun seedPalletPool(from: Long = 1, to: Long = 200) =
        pool.addRange(ServerRange(PREFIX, SsccPool.PALLET_EXTENSION_DIGIT, from, to, null))

    private suspend fun scanInto(boxId: String, hash: String) = db.codeDao().insert(
        CodeEntity(hash, "s1", "04680089900000", hash, "2026-09-11T08:00:00.000Z", boxId),
    )

    /** Opens a box, scans one item into it, and closes it -- the shift must already exist. */
    private suspend fun fillAndCloseBox(label: String): CloseResult.Closed {
        val box = boxes.currentBox("s1")
        scanInto(box.boxId, label)
        return closeBox.close("s1", PREFIX, "op1") as CloseResult.Closed
    }

    // -- ClosePallet's own behaviour, mirroring CloseBoxTest -----------------

    @Test
    fun anEmptyPalletCostsNoSerial() = runTest {
        seedPalletPool()
        pallets.currentPallet("s1")
        assertEquals(ClosePalletResult.Empty, closePallet.close("s1", PREFIX, "op1"))
        // Closing a pallet nothing has joined yet must not consume a number
        // that nothing will ever print.
        assertEquals(200L, pool.remaining(PREFIX, SsccPool.PALLET_EXTENSION_DIGIT))
    }

    @Test
    fun aShiftWithNoOpenPalletIsEmptyNotAnError() = runTest {
        seedPalletPool()
        assertEquals(ClosePalletResult.Empty, closePallet.close("s1", PREFIX, "op1"))
    }

    @Test
    fun aFilledPalletClosesWithAnSsccAndItsOwnTimestamp() = runTest {
        seedPalletPool()
        val pallet = pallets.currentPallet("s1")
        db.boxDao().insert(
            BoxEntity(
                boxId = "b1", shiftId = "s1", sscc = "046800899000000018",
                openedAt = "2026-09-11T07:00:00.000Z", closedAt = "2026-09-11T08:00:00.000Z",
                operatorId = "op1", printState = BoxPrint.PENDING, printReason = null, ackedAt = null,
                palletId = pallet.palletId,
            ),
        )
        val result = closePallet.close("s1", PREFIX, "op1") as ClosePalletResult.Closed
        assertEquals(1, result.boxCount)
        // Extension digit 1: the leading character of a pallet SSCC.
        assertEquals('1', result.sscc.first())
        assertEquals(Sscc.build(SsccPool.PALLET_EXTENSION_DIGIT, PREFIX, 1), result.sscc)
        val stored = db.palletDao().get(pallet.palletId)!!
        assertEquals(result.sscc, stored.sscc)
        assertEquals(result.closedAt, stored.closedAt)
        assertEquals("op1", stored.operatorId)
    }

    @Test
    fun aDryPoolLeavesThePalletOpen() = runTest {
        val pallet = pallets.currentPallet("s1")
        db.boxDao().insert(
            BoxEntity(
                boxId = "b1", shiftId = "s1", sscc = null, openedAt = "2026-09-11T07:00:00.000Z",
                closedAt = null, operatorId = null, printState = BoxPrint.PENDING, printReason = null,
                ackedAt = null, palletId = pallet.palletId,
            ),
        )
        assertEquals(ClosePalletResult.NoSerials, closePallet.close("s1", PREFIX, "op1"))
        assertNull(db.palletDao().get(pallet.palletId)!!.closedAt)
        // Still closable once the pool is topped up.
        seedPalletPool()
        val closed = closePallet.close("s1", PREFIX, "op1")
        assertTrue(closed is ClosePalletResult.Closed)
    }

    @Test
    fun aShiftWithNoIssuerCannotClosePalletAndBurnsNothing() = runTest {
        seedPalletPool()
        val pallet = pallets.currentPallet("s1")
        db.boxDao().insert(
            BoxEntity(
                boxId = "b1", shiftId = "s1", sscc = null, openedAt = "2026-09-11T07:00:00.000Z",
                closedAt = null, operatorId = null, printState = BoxPrint.PENDING, printReason = null,
                ackedAt = null, palletId = pallet.palletId,
            ),
        )
        assertEquals(ClosePalletResult.NoIssuer, closePallet.close("s1", null, "op1"))
        assertEquals(200L, pool.remaining(PREFIX, SsccPool.PALLET_EXTENSION_DIGIT))
    }

    @Test
    fun aSecondCloseOfAnAlreadyClosedPalletBurnsNothing() = runTest {
        // Same invariant CloseBox holds: a serial that leaves the pool without
        // landing on a label is gone, so a replayed close of the SAME shift
        // must not mint a second one for the pallet it already closed.
        seedPalletPool()
        val pallet = pallets.currentPallet("s1")
        db.boxDao().insert(
            BoxEntity(
                boxId = "b1", shiftId = "s1", sscc = null, openedAt = "2026-09-11T07:00:00.000Z",
                closedAt = null, operatorId = null, printState = BoxPrint.PENDING, printReason = null,
                ackedAt = null, palletId = pallet.palletId,
            ),
        )
        closePallet.close("s1", PREFIX, "op1")
        val before = pool.remaining(PREFIX, SsccPool.PALLET_EXTENSION_DIGIT)
        assertEquals(ClosePalletResult.Empty, closePallet.close("s1", PREFIX, "op1"))
        assertEquals(before, pool.remaining(PREFIX, SsccPool.PALLET_EXTENSION_DIGIT))
    }

    @Test
    fun twoScansArrivingTogetherStillOpenOnePallet() = runTest {
        // The gap this device carries that the station does not: `pallets`
        // has only a non-unique `(shiftId, closedAt)` index, so nothing at the
        // database stops two callers each finding no open pallet and
        // inserting one. `PalletRepository`'s own mutex is what closes it.
        val ids = List(8) { async { pallets.currentPallet("s1").palletId } }.awaitAll().toSet()
        assertEquals(1, ids.size)
    }

    @Test
    fun twoDirectClosesArrivingTogetherBurnExactlyOneSerial() = runTest {
        seedPalletPool()
        val pallet = pallets.currentPallet("s1")
        db.boxDao().insert(
            BoxEntity(
                boxId = "b1", shiftId = "s1", sscc = null, openedAt = "2026-09-11T07:00:00.000Z",
                closedAt = null, operatorId = null, printState = BoxPrint.PENDING, printReason = null,
                ackedAt = null, palletId = pallet.palletId,
            ),
        )
        val results = List(4) { async { closePallet.close("s1", PREFIX, "op1") } }.awaitAll()
        assertEquals(1, results.count { it is ClosePalletResult.Closed })
        assertEquals(199L, pool.remaining(PREFIX, SsccPool.PALLET_EXTENSION_DIGIT))
    }

    // -- CloseBox joining a box to the shift's open pallet, and auto-closing
    // -- it at capacity ------------------------------------------------------

    @Test
    fun aShiftWithNoPalletCapacityNeverJoinsAPallet() = runTest {
        givenShift(palletBoxCapacity = null)
        seedBoxPool()
        val result = fillAndCloseBox("b1")
        assertNull(result.pallet)
        assertNull(result.box.palletId)
    }

    @Test
    fun joiningABoxBelowCapacityLeavesThePalletOpen() = runTest {
        givenShift(boxCapacity = 2, palletBoxCapacity = 2)
        seedBoxPool()
        seedPalletPool()
        val result = fillAndCloseBox("b1")
        assertNull(result.pallet)
        assertEquals(1, db.palletDao().boxCount(result.box.palletId!!))
        assertNull(pallets.get(result.box.palletId!!)!!.closedAt)
    }

    @Test
    fun closesThePalletWhenTheLastBoxJoinsIt() = runTest {
        givenShift(boxCapacity = 2, palletBoxCapacity = 2)
        seedBoxPool()
        seedPalletPool()
        fillAndCloseBox("b1")
        val result = fillAndCloseBox("b2")
        assertTrue(result.pallet is ClosePalletResult.Closed)
        val closed = result.pallet as ClosePalletResult.Closed
        assertEquals(2, closed.boxCount)
        assertEquals('1', closed.sscc.first())
    }

    @Test
    fun keepsOneOverCapacityPalletWhenThePoolIsDry() = runTest {
        givenShift(boxCapacity = 2, palletBoxCapacity = 1)
        seedBoxPool()
        // No pallet-range seeded: the PALLET_EXTENSION_DIGIT pool is dry from
        // the start, even though the box pool has plenty.
        val first = fillAndCloseBox("b1")
        val second = fillAndCloseBox("b2")
        assertEquals(ClosePalletResult.NoSerials, first.pallet)
        assertEquals(ClosePalletResult.NoSerials, second.pallet)
        // One pallet, over capacity -- never a second one nobody can number.
        val palletId = first.box.palletId!!
        assertEquals(palletId, second.box.palletId)
        assertEquals(2, db.palletDao().boxCount(palletId))
        assertNull(db.palletDao().get(palletId)!!.closedAt)
        // Serials arrive: the SAME over-capacity pallet closes, not a second one.
        seedPalletPool()
        val closed = closePallet.close("s1", PREFIX, "op1") as ClosePalletResult.Closed
        assertEquals(2, closed.boxCount)
    }

    @Test
    fun theAutomaticCloseAtCapacityAndAnEarlyManualCloseNeverDoubleBurn() = runTest {
        // The automatic close CloseBox triggers at capacity and a directly
        // issued «Закрыть паллету досрочно» are separate coroutines; without
        // ClosePallet's own mutex both could pass the open-pallet read
        // together and each burn a serial for the same pallet.
        givenShift(boxCapacity = 1, palletBoxCapacity = 1)
        seedBoxPool()
        seedPalletPool()
        val box = boxes.currentBox("s1")
        scanInto(box.boxId, "h1")
        val boxClose = async { closeBox.close("s1", PREFIX, "op1") }
        val manualClose = async { closePallet.close("s1", PREFIX, "op1") }
        val boxResult = boxClose.await() as CloseResult.Closed
        val manualResult = manualClose.await()
        val closedCount = listOfNotNull(
            boxResult.pallet.takeIf { it is ClosePalletResult.Closed },
            manualResult.takeIf { it is ClosePalletResult.Closed },
        ).size
        assertEquals(1, closedCount)
        assertEquals(199L, pool.remaining(PREFIX, SsccPool.PALLET_EXTENSION_DIGIT))
    }
}
