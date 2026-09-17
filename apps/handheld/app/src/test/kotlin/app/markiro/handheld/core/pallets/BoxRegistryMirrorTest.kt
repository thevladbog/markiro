package app.markiro.handheld.core.pallets

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.network.NetworkModule
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.storage.BoxRegistryEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import app.markiro.handheld.core.writeoff.MirrorOutcome
import app.markiro.handheld.core.writeoff.contentKeys
import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory

@RunWith(AndroidJUnit4::class)
class BoxRegistryMirrorTest {
    private lateinit var db: HandheldDatabase
    private lateinit var server: MockWebServer
    private lateinit var meta: MetaStore
    private lateinit var mirror: BoxRegistryMirror

    private fun upsert(sscc: String, bottles: Int) =
        """{"kind":"upsert","boxId":"b-1","sscc":"$sscc","productId":"p-1","bottleCount":$bottles,"contentKeys":["0104600682000013215S"],"updatedAt":"t"}"""

    private fun box(sscc: String, bottles: Int, localPalletId: String? = null) =
        BoxRegistryEntity(sscc, "b-0", "p-1", bottles, "[]", "2026-09-01T00:00:00.000Z", localPalletId = localPalletId)

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        db.initializeRecoveryForTest()
        server = MockWebServer().also { it.start() }
        val api = Retrofit.Builder().baseUrl(server.url("/")).client(OkHttpClient())
            .addConverterFactory(NetworkModule.json().asConverterFactory("application/json".toMediaType()))
            .build().create(StationApi::class.java)
        meta = MetaStore(db)
        mirror = BoxRegistryMirror(api, db, meta)
    }

    @After
    fun tearDown() {
        runCatching { server.shutdown() }
        db.close()
    }

    @Test
    fun registryDeltaAppliesUpsertAndRemove() = runTest {
        db.boxRegistryDao().upsert(box("046000000000000018", bottles = 20))
        meta.put(MetaStore.BOX_REGISTRY_UNTIL, "7")
        server.enqueue(
            MockResponse().setBody(
                """{"until":"9","items":[{"kind":"remove","sscc":"046000000000000018","updatedAt":"t"},""" +
                    """${upsert("046000000000000025", 12)}]}""",
            ),
        )
        assertEquals(MirrorOutcome.Ok, mirror.walk())
        assertNull(db.boxRegistryDao().bySscc("046000000000000018"))
        assertEquals(12, db.boxRegistryDao().bySscc("046000000000000025")?.bottleCount)
        assertEquals(listOf("0104600682000013215S"), db.boxRegistryDao().bySscc("046000000000000025")?.contentKeys())
        assertEquals("9", meta.get(MetaStore.BOX_REGISTRY_UNTIL))
        assertEquals("/station/box-registry?since=7&limit=250", server.takeRequest().path)
    }

    /**
     * A delta walk must not drop what it already holds, and a cursor page must
     * echo the window the first page assigned: the server rejects a changed one.
     */
    @Test
    fun aCursorWalkEchoesTheWindowAndStoresUntilOnlyAtTheEnd() = runTest {
        meta.put(MetaStore.BOX_REGISTRY_UNTIL, "7")
        server.enqueue(MockResponse().setBody("""{"until":"9","items":[${upsert("046000000000000025", 12)}],"nextCursor":"c1"}"""))
        server.enqueue(MockResponse().setBody("""{"until":"9","items":[${upsert("046000000000000032", 6)}]}"""))
        assertEquals(MirrorOutcome.Ok, mirror.walk())
        assertEquals(2, db.boxRegistryDao().count())
        assertEquals("9", meta.get(MetaStore.BOX_REGISTRY_UNTIL))
        assertEquals("/station/box-registry?since=7&limit=250", server.takeRequest().path)
        assertEquals("/station/box-registry?since=7&until=9&cursor=c1&limit=250", server.takeRequest().path)
    }

    /** The server moved the window under the walk: the pages no longer describe one revision. */
    @Test
    fun aMidWalkWindowChangeIsRefused() = runTest {
        meta.put(MetaStore.BOX_REGISTRY_UNTIL, "7")
        server.enqueue(MockResponse().setBody("""{"until":"9","items":[${upsert("046000000000000025", 12)}],"nextCursor":"c1"}"""))
        server.enqueue(MockResponse().setBody("""{"until":"11","items":[${upsert("046000000000000032", 6)}]}"""))
        assertEquals(MirrorOutcome.Failed("registry window"), mirror.walk())
        assertEquals("7", meta.get(MetaStore.BOX_REGISTRY_UNTIL))
    }

    /**
     * Storing the window before the walk finishes would skip the tail forever on
     * the next run, so a failed page must leave the old revision in place.
     */
    @Test
    fun aFailedTailLeavesTheOldRevision() = runTest {
        meta.put(MetaStore.BOX_REGISTRY_UNTIL, "7")
        server.enqueue(MockResponse().setBody("""{"until":"9","items":[${upsert("046000000000000025", 12)}],"nextCursor":"c1"}"""))
        server.enqueue(MockResponse().setResponseCode(500))
        assertEquals(MirrorOutcome.Failed("http"), mirror.walk())
        assertEquals("7", meta.get(MetaStore.BOX_REGISTRY_UNTIL))
        // The page that did land stays: re-applying an upsert is idempotent.
        assertEquals(12, db.boxRegistryDao().bySscc("046000000000000025")?.bottleCount)
    }

    @Test
    fun aFullSnapshotDropsBoxesTheServerNoLongerLists() = runTest {
        db.boxRegistryDao().upsert(box("046000000000000018", bottles = 20))
        server.enqueue(MockResponse().setBody("""{"until":"9","items":[${upsert("046000000000000025", 12)}]}"""))
        assertEquals(MirrorOutcome.Ok, mirror.walk())
        assertNull(db.boxRegistryDao().bySscc("046000000000000018"))
        assertEquals(1, db.boxRegistryDao().count())
    }

    @Test
    fun offlineLeavesTheRevisionAlone() = runTest {
        meta.put(MetaStore.BOX_REGISTRY_UNTIL, "7")
        server.shutdown()
        assertEquals(MirrorOutcome.Offline, mirror.walk())
        assertEquals("7", meta.get(MetaStore.BOX_REGISTRY_UNTIL))
    }

    @Test
    fun anUpsertMissingItsBoxFieldsIsRefusedWithoutStoringTheRevision() = runTest {
        server.enqueue(MockResponse().setBody("""{"until":"9","items":[{"kind":"upsert","sscc":"046000000000000025","updatedAt":"t"}]}"""))
        assertEquals(MirrorOutcome.Failed("registry shape"), mirror.walk())
        assertEquals(0, db.boxRegistryDao().count())
        assertNull(meta.get(MetaStore.BOX_REGISTRY_UNTIL))
    }

    @Test
    fun anUpsertKeepsTheDeviceClaimUntilTheServerSettlesIt() = runTest {
        meta.put(MetaStore.BOX_REGISTRY_UNTIL, "2")
        db.boxRegistryDao().upsert(BoxRegistryEntity("034600682000000018", "b1", "p-1", 6, "[]", "t", localPalletId = "w-local"))
        server.enqueue(
            MockResponse().setBody(
                """{"until":"3","items":[
            {"kind":"upsert","boxId":"b1","sscc":"034600682000000018","productId":"p-1","bottleCount":6,"contentKeys":[],"updatedAt":"t2","palletId":null,"palletSscc":null,"palletActive":false,"closedAt":"c","productionDate":null}]}""",
            ),
        )
        assertEquals(MirrorOutcome.Ok, mirror.walk())
        assertEquals("w-local", db.boxRegistryDao().bySscc("034600682000000018")?.localPalletId)
        server.enqueue(
            MockResponse().setBody(
                """{"until":"4","items":[
            {"kind":"upsert","boxId":"b1","sscc":"034600682000000018","productId":"p-1","bottleCount":6,"contentKeys":[],"updatedAt":"t3","palletId":"srv","palletSscc":"134600682000000017","palletActive":true,"closedAt":"c","productionDate":null}]}""",
            ),
        )
        assertEquals(MirrorOutcome.Ok, mirror.walk())
        val row = db.boxRegistryDao().bySscc("034600682000000018")!!
        assertNull(row.localPalletId)
        assertEquals(true, row.palletActive)
    }

    /**
     * A full re-walk clears the table first, so an open pallet built on this
     * device would silently lose its boxes. The claims are re-applied to every
     * SSCC the snapshot still reports as unassigned.
     */
    @Test
    fun aFullReWalkKeepsClaimsTheServerHasNoAnswerFor() = runTest {
        db.boxRegistryDao().upsert(box("046000000000000018", bottles = 6, localPalletId = "w-local"))
        db.boxRegistryDao().upsert(box("046000000000000025", bottles = 6, localPalletId = "w-local"))
        db.boxRegistryDao().upsert(box("046000000000000032", bottles = 6, localPalletId = "w-local"))
        server.enqueue(
            MockResponse().setBody(
                """{"until":"9","items":[${upsert("046000000000000018", 6)},""" +
                    """{"kind":"upsert","boxId":"b1","sscc":"046000000000000025","productId":"p-1","bottleCount":6,"contentKeys":[],"updatedAt":"t","palletId":"srv","palletSscc":null,"palletActive":true,"closedAt":"c","productionDate":null}]}""",
            ),
        )
        assertEquals(MirrorOutcome.Ok, mirror.walk())
        // Still unassigned on the server: the device's claim is the only answer there is.
        assertEquals("w-local", db.boxRegistryDao().bySscc("046000000000000018")?.localPalletId)
        // The server settled it: the claim goes.
        assertNull(db.boxRegistryDao().bySscc("046000000000000025")?.localPalletId)
        // Gone from the registry entirely; nothing to re-claim.
        assertNull(db.boxRegistryDao().bySscc("046000000000000032"))
    }
}
