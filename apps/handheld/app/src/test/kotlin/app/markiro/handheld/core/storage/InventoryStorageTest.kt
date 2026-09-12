package app.markiro.handheld.core.storage

import app.markiro.handheld.core.storage.initializeRecoveryForTest
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class InventoryStorageTest {
    private lateinit var db: HandheldDatabase

    @Before
    fun open() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        db.initializeRecoveryForTest()
    }

    @After
    fun close() = db.close()

    @Test
    fun snapshotCodesAreLookedUpByHashAndByParentSscc() = runTest {
        db.inventorySnapshotCodeDao().insertAll(
            listOf(
                InventoryFixtures.code("snap", "h1", parentSscc = "346006820000000014"),
                InventoryFixtures.code("snap", "h2", parentSscc = "346006820000000014", expected = false, protected = true),
                InventoryFixtures.code("snap", "h3"),
            ),
        )
        assertEquals("h3", db.inventorySnapshotCodeDao().get("snap", "h3")?.codeHash)
        assertEquals(listOf("h1", "h2"), db.inventorySnapshotCodeDao().children("snap", "346006820000000014").map { it.codeHash })
        assertEquals(3, db.inventorySnapshotCodeDao().count("snap"))
        assertEquals(2, db.inventorySnapshotCodeDao().countExpected("snap"))
        assertEquals(listOf("h1", "h2"), db.inventorySnapshotCodeDao().pageAfter("snap", "", 2).map { it.codeHash })
        assertEquals(listOf("h3"), db.inventorySnapshotCodeDao().pageAfter("snap", "h2", 2).map { it.codeHash })
    }

    @Test
    fun resultsInsertIgnoreReturnsMinusOneForAnExistingClaim() = runTest {
        val first = InventoryFixtures.result("i1", "snap", "h1", eventId = "e1", deviceId = "dev-1")
        assertTrue(db.inventoryResultDao().insertIgnore(first) >= 0)
        assertEquals(-1L, db.inventoryResultDao().insertIgnore(first.copy(firstAcceptedEventId = "e2")))
        assertEquals("e1", db.inventoryResultDao().get("i1", "h1")?.firstAcceptedEventId)
        assertEquals(1, db.inventoryResultDao().observeCount("i1", "expected").first())
        assertEquals(1, db.inventoryResultDao().observeCountForDevice("i1", "dev-1").first())
    }

    @Test
    fun outboxHeadFollowsDeviceSequenceAndCountsTheTail() = runTest {
        for (n in 1L..3L) {
            db.inventoryOutboxDao().insert(
                InventoryOutboxEntity(inventoryId = "i1", snapshotId = "snap", eventId = "e$n", deviceSequence = n, payloadJson = "{}", createdAt = "t"),
            )
        }
        val head = db.inventoryOutboxDao().head("i1", 2)
        assertEquals(listOf(1L, 2L), head.map { it.deviceSequence })
        assertEquals(1, db.inventoryOutboxDao().countAfter("i1", head.last().id))
        db.inventoryOutboxDao().deleteIds(head.map { it.id })
        assertEquals(1, db.inventoryOutboxDao().observeCount("i1").first())
        assertEquals(1, db.inventoryOutboxDao().observeTotal().first())
    }

    @Test
    fun terminalStateAndTaskLifecycle() = runTest {
        db.inventoryTaskDao().upsert(InventoryFixtures.task("i1", state = "staging"))
        db.inventoryTaskDao().setStaging("i1", cursor = "h9", staged = 200)
        assertEquals("h9", db.inventoryTaskDao().get("i1")?.stagingCursor)
        db.inventoryTaskDao().activate("i1", expectedCount = 150, joinedAt = 5L)
        assertEquals("active", db.inventoryTaskDao().observe("i1").first()?.state)
        assertNull(db.inventoryTerminalStateDao().get("i1"))
        db.inventoryTerminalStateDao().upsert(InventoryTerminalStateEntity("i1", "snap", "op-1", "2026-08-20", 1, null, 0, "t"))
        db.inventoryTerminalStateDao().setProgress("i1", "3:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 3)
        assertEquals(3L, db.inventoryTerminalStateDao().get("i1")?.progressResultRevision)
    }
}
