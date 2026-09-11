package app.markiro.handheld.core.box

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.storage.HandheldDatabase
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SsccPoolTest {
    private lateinit var db: HandheldDatabase
    private lateinit var pool: SsccPool

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        pool = SsccPool(db)
    }

    @After
    fun tearDown() = db.close()

    private fun range(from: Long, to: Long, consumed: Long? = null) =
        ServerRange("468008990", 0, from, to, consumed)

    @Test
    fun serialsComeOutLowestFirstAndTheCursorHolds() = runTest {
        pool.addRange(range(100, 102))
        assertEquals(100L, pool.burn("468008990", 0))
        assertEquals(101L, pool.burn("468008990", 0))
        assertEquals(1L, pool.remaining("468008990", 0))
    }

    @Test
    fun aDryPoolReturnsNullRatherThanReissuing() = runTest {
        pool.addRange(range(1, 1))
        assertEquals(1L, pool.burn("468008990", 0))
        assertNull(pool.burn("468008990", 0))
        assertEquals(0L, pool.remaining("468008990", 0))
    }

    @Test
    fun replayingABlockNeverRegressesTheCursor() = runTest {
        // The server always reports ORIGINAL bounds, so a repeat bundle fetch
        // re-applies them. Handing those serials back would print a second
        // label carrying a number already stuck to a box.
        pool.addRange(range(100, 200))
        pool.burn("468008990", 0)
        pool.burn("468008990", 0)
        pool.addRange(range(100, 200))
        assertEquals(102L, pool.burn("468008990", 0))
    }

    @Test
    fun aBlockIsAdvancedToWhatTheServerKnowsWasConsumed() = runTest {
        // A device restored from a stale copy holds a cursor behind the
        // server's; without this it would reissue everything in between.
        pool.addRange(range(100, 200))
        pool.addRange(range(100, 200, consumed = 150))
        assertEquals(151L, pool.burn("468008990", 0))
    }

    @Test
    fun revokedRangesAreDeletedSoTheReplacementWins() = runTest {
        // Burning picks the lowest fromSerial with room, so a revoked low range
        // left in place would keep winning over the reseeded one and the
        // admin's new number would never reach a label.
        pool.addRange(range(100, 200))
        pool.addRange(range(500, 600))
        pool.dropRanges("468008990", 0, listOf(100))
        assertEquals(500L, pool.burn("468008990", 0))
    }

    @Test
    fun droppingARangeThisDeviceDoesNotHoldIsHarmless() = runTest {
        pool.addRange(range(100, 200))
        pool.dropRanges("468008990", 0, listOf(999))
        pool.dropRanges("468008990", 0, emptyList())
        assertEquals(100L, pool.burn("468008990", 0))
    }

    @Test
    fun extensionDigitsNeverShareASerialSpace() = runTest {
        // Boxes are 0 and pallets are 1. One serial space for both would put
        // the same number on a box and a pallet.
        pool.addRange(range(10, 20))
        pool.addRange(ServerRange("468008990", 1, 10, 20, null))
        assertEquals(10L, pool.burn("468008990", 0))
        assertEquals(10L, pool.burn("468008990", 1))
        assertEquals(11L, pool.burn("468008990", 0))
    }

    @Test
    fun issuerPrefixesNeverShareASerialSpace() = runTest {
        pool.addRange(range(10, 20))
        pool.addRange(ServerRange("460000000", 0, 10, 20, null))
        assertEquals(10L, pool.burn("468008990", 0))
        assertEquals(10L, pool.burn("460000000", 0))
    }

    @Test
    fun concurrentBurnsNeverIssueOneSerialTwice() = runTest {
        // Two boxes sharing one SSCC is the single failure the server cannot
        // repair. This asserts the property of the whole path — 200 burns, 200
        // distinct serials, then a dry pool — not that any one guard produces
        // it: removing the mutex leaves this passing, because Room serialises
        // transactions over a single writable connection.
        pool.addRange(range(0, 199))
        val burned = List(200) { async { pool.burn("468008990", 0) } }.awaitAll()
        assertEquals(200, burned.filterNotNull().size)
        assertEquals(200, burned.filterNotNull().toSet().size)
        assertNull(pool.burn("468008990", 0))
    }
}
