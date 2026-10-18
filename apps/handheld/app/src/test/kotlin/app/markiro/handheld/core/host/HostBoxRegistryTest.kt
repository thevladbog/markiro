package app.markiro.handheld.core.host

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.host.HostPalletFixtures.ok
import app.markiro.handheld.core.host.HostPalletFixtures.routes
import app.markiro.handheld.core.network.host.HostApi
import app.markiro.handheld.core.network.host.HostResult
import app.markiro.handheld.core.network.host.TransportFailure
import app.markiro.handheld.core.storage.BoxRegistryEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import app.markiro.handheld.core.writeoff.MirrorOutcome
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class HostBoxRegistryTest {
    private lateinit var db: HandheldDatabase
    private lateinit var meta: MetaStore

    @Before
    fun open() = runBlocking {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        db.deviceConfigDao().upsert(HostFactsFixtures.config(db))
        db.initializeRecoveryForTest()
        meta = MetaStore(db)
    }

    @After
    fun close() = db.close()

    private fun fixtureBody(name: String) = HostFactsFixtures.fixture(name).toString()

    private val lastPage = """{"until":"2026-10-08T07:30:00Z","items":[]}"""

    @Test
    fun aRegistryDeltaPagedByCursorFillsTheLocalRegistryAndMovesTheMarkOnlyAfterTheLastPage() = runTest {
        // the first answer is the guard's question about the host's epoch, then the walk: a page with a cursor, the last page
        val transport = routes("/v1/device/box-registry" to listOf(ok(fixtureBody("box-registry-page.json")), ok(fixtureBody("box-registry-page.json")), ok(lastPage)))
        assertEquals(MirrorOutcome.Ok, HostBoxRegistry(db, meta, HostApi(transport)).catchUp())
        assertEquals(2, db.boxRegistryDao().count())
        val onPallet = db.boxRegistryDao().bySscc("046006820000015000")!!
        assertEquals("146006820000000409", onPallet.palletSscc)
        assertEquals(true, onPallet.palletActive)
        assertEquals("[]", onPallet.contentKeysJson)
        assertEquals("2026-10-08T07:30:00Z", meta.get(MetaStore.BOX_REGISTRY_UNTIL))
        // the second page was asked by the cursor the first one gave, inside the window the first one fixed
        val second = transport.requests.last()
        assertTrue(second, second.contains("cursor=2026-10-08T07%3A10%3A00Z%7C046006820000015024"))
        assertTrue(second, second.contains("until=2026-10-08T07%3A30%3A00Z"))
    }

    @Test
    fun aPageThatFailsKeepsTheOldMarkAndTheNextWalkStartsOneSecondBeforeIt() = runTest {
        meta.put(MetaStore.BOX_REGISTRY_UNTIL, "2026-10-08T07:30:00Z")
        meta.put(HostBoxRegistry.EPOCH_KEY, "5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e")
        val transport = routes("/v1/device/box-registry" to listOf(ok(fixtureBody("box-registry-page.json")), HostResult.Failed(TransportFailure.UNREACHABLE)))
        val outcome = HostBoxRegistry(db, meta, HostApi(transport)).catchUp()
        assertEquals(MirrorOutcome.Offline, outcome)
        assertEquals("2026-10-08T07:30:00Z", meta.get(MetaStore.BOX_REGISTRY_UNTIL))
        assertTrue(transport.requests.first(), transport.requests.first().contains("since=2026-10-08T07%3A29%3A59Z"))
    }

    @Test
    fun aChangedRestoreEpochMakesTheNextWalkAFullOneThatForgetsWhatTheRestoredHostLacksButKeepsTheDevicesClaims() = runTest {
        meta.put(MetaStore.BOX_REGISTRY_UNTIL, "2026-10-08T07:30:00Z")
        meta.put(HostBoxRegistry.EPOCH_KEY, "old-epoch")
        db.boxRegistryDao().upsert(BoxRegistryEntity("046006820000099999", "gone", "p", 12, "[]", "2026-10-01T00:00:00Z"))
        db.boxRegistryDao().upsert(BoxRegistryEntity("046006820000015017", "b2", "p", 12, "[]", "2026-10-01T00:00:00Z", localPalletId = "local-pallet"))
        val transport = routes("/v1/device/box-registry" to listOf(ok(fixtureBody("box-registry-page.json")), ok(fixtureBody("box-registry-page.json")), ok(lastPage)))
        assertEquals(MirrorOutcome.Ok, HostBoxRegistry(db, meta, HostApi(transport)).catchUp())
        assertNull("a row the restored host does not hold", db.boxRegistryDao().bySscc("046006820000099999"))
        assertEquals("the device's claim survives the full walk", "local-pallet", db.boxRegistryDao().bySscc("046006820000015017")!!.localPalletId)
        assertEquals("5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e", meta.get(HostBoxRegistry.EPOCH_KEY))
        assertTrue("the full walk asks without a window", transport.requests.drop(1).first().let { !it.contains("since=") })
    }
}
