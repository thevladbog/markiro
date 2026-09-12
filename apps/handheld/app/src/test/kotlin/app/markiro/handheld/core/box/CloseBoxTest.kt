package app.markiro.handheld.core.box

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.storage.CodeEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class CloseBoxTest {
    private lateinit var db: HandheldDatabase
    private lateinit var pool: SsccPool
    private lateinit var boxes: BoxRepository
    private lateinit var closer: CloseBox
    private var now = 1_757_000_000_000L

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        pool = SsccPool(db)
        boxes = BoxRepository(db) { now }
        // No shift row is seeded in this file, so `palletBoxCapacity` reads as
        // null and every case here behaves exactly as it did before pallets
        // (06d) existed; that join/auto-close path has its own file,
        // `ClosePalletTest`.
        val pallets = PalletRepository(db) { now }
        val closePallet = ClosePallet(db, pool) { now }
        closer = CloseBox(db, boxes, pool, pallets, closePallet) { now }
    }

    @After
    fun tearDown() = db.close()

    private suspend fun scanInto(boxId: String, hash: String) = db.codeDao().insert(
        CodeEntity(hash, "s1", "04680089900000", hash, "2026-09-10T08:00:00.000Z", boxId),
    )

    private suspend fun seedPool(from: Long = 1, to: Long = 10) =
        pool.addRange(ServerRange("468008990", 0, from, to, null))

    @Test
    fun anEmptyBoxCostsNoSerial() = runTest {
        seedPool()
        boxes.currentBox("s1")
        assertEquals(CloseResult.Empty, closer.close("s1", "468008990", null))
        // Closing an empty box by mistake is routine on a floor; it must not
        // consume a number that nothing will ever print.
        assertEquals(10L, pool.remaining("468008990", 0))
    }

    @Test
    fun aShiftWithNoOpenBoxIsEmptyNotAnError() = runTest {
        seedPool()
        assertEquals(CloseResult.Empty, closer.close("s1", "468008990", null))
    }

    @Test
    fun aFilledBoxClosesWithAnSsccAndItsOwnTimestamp() = runTest {
        seedPool()
        val box = boxes.currentBox("s1")
        scanInto(box.boxId, "h1")
        scanInto(box.boxId, "h2")
        val result = closer.close("s1", "468008990", "op1") as CloseResult.Closed
        assertEquals(2, result.itemCount)
        assertEquals(Sscc.build(0, "468008990", 1), result.sscc)
        val stored = db.boxDao().get(box.boxId)!!
        assertEquals(result.sscc, stored.sscc)
        assertEquals(result.closedAt, stored.closedAt)
        assertEquals("op1", stored.operatorId)
        assertEquals(BoxPrint.PENDING, stored.printState)
        // The next scan opens a NEW box rather than joining the closed one.
        assertNotEquals(box.boxId, boxes.currentBox("s1").boxId)
    }

    @Test
    fun aCodeInAnotherBoxNeverInflatesThisOnesCount() = runTest {
        seedPool()
        val first = boxes.currentBox("s1")
        scanInto(first.boxId, "h1")
        closer.close("s1", "468008990", null)
        val second = boxes.currentBox("s1")
        scanInto(second.boxId, "h2")
        assertEquals(1, (closer.close("s1", "468008990", null) as CloseResult.Closed).itemCount)
    }

    @Test
    fun aDryPoolLeavesTheBoxOpen() = runTest {
        val box = boxes.currentBox("s1")
        scanInto(box.boxId, "h1")
        assertEquals(CloseResult.NoSerials, closer.close("s1", "468008990", null))
        assertNull(db.boxDao().get(box.boxId)!!.closedAt)
        // Still closable once the pool is topped up.
        seedPool()
        assertEquals(Sscc.build(0, "468008990", 1), (closer.close("s1", "468008990", null) as CloseResult.Closed).sscc)
    }

    @Test
    fun aSerialBeyondThePrefixLeavesTheBoxOpen() = runTest {
        // A local range reaching past the issuer prefix's capacity: a corrupted
        // pool. The serial is burned and cannot be given back, but the box must
        // stay closable rather than half-closed.
        pool.addRange(ServerRange("468008990", 0, 10_000_000, 10_000_001, null))
        val box = boxes.currentBox("s1")
        scanInto(box.boxId, "h1")
        assertEquals(CloseResult.InvalidSerial, closer.close("s1", "468008990", null))
        assertNull(db.boxDao().get(box.boxId)!!.closedAt)
    }

    @Test
    fun aShiftWithNoIssuerCannotCloseABoxAndBurnsNothing() = runTest {
        seedPool()
        val box = boxes.currentBox("s1")
        scanInto(box.boxId, "h1")
        assertEquals(CloseResult.NoIssuer, closer.close("s1", null, null))
        assertEquals(10L, pool.remaining("468008990", 0))
        assertNull(db.boxDao().get(box.boxId)!!.closedAt)
    }

    @Test
    fun boxNumbersAreStableAndDerivedFromRows() = runTest {
        seedPool()
        val first = boxes.currentBox("s1")
        scanInto(first.boxId, "h1")
        closer.close("s1", "468008990", null)
        now += 1_000
        val second = boxes.currentBox("s1")
        assertEquals(1, boxes.ordinal(first))
        assertEquals(2, boxes.ordinal(second))
        // A restart re-reads the same rows and reaches the same numbers.
        assertEquals(2, BoxRepository(db) { now }.ordinal(second))
    }

    @Test
    fun twoScansArrivingTogetherStillOpenOneBox() = runTest {
        val ids = List(8) { async { boxes.currentBox("s1").boxId } }.awaitAll().toSet()
        assertEquals(1, ids.size)
    }

    @Test
    fun twoClosesArrivingTogetherBurnExactlyOneSerial() = runTest {
        // The automatic close at capacity and «Закрыть короб досрочно» are separate
        // coroutines. Without serialisation both pass the open-box read and each
        // burn a serial; one lands on the box and the other is simply gone.
        seedPool()
        val box = boxes.currentBox("s1")
        scanInto(box.boxId, "h1")
        val results = List(4) { async { closer.close("s1", "468008990", null) } }.awaitAll()
        assertEquals(1, results.count { it is CloseResult.Closed })
        // One serial spent, not four.
        assertEquals(9L, pool.remaining("468008990", 0))
        assertEquals(Sscc.build(0, "468008990", 1), db.boxDao().get(box.boxId)!!.sscc)
    }
}
