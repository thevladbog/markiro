package app.markiro.handheld.core.writeoff

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.network.NetworkModule
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.storage.BoxRegistryEntity
import app.markiro.handheld.core.storage.WriteoffReasonEntity
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory

@RunWith(AndroidJUnit4::class)
class WriteoffMirrorTest {
    private lateinit var db: HandheldDatabase
    private lateinit var server: MockWebServer
    private lateinit var meta: MetaStore
    private lateinit var mirror: WriteoffMirror

    private val bootstrapJson =
        """{"generatedAt":"2026-09-14T10:42:00.000Z",
        "reasons":[{"id":"r-1","name":"Бой","sortOrder":0},{"id":"r-2","name":"Просрочка","sortOrder":1}],
        "products":[{"id":"p-1","gtin14":"04600682000013","name":"Вода 0,5 л"}],
        "operators":[{"employeeId":"op-1","canWriteoff":true},{"employeeId":"op-2","canWriteoff":false}]}"""

    private fun upsert(sscc: String, bottles: Int) =
        """{"kind":"upsert","boxId":"b-1","sscc":"$sscc","productId":"p-1","bottleCount":$bottles,"contentKeys":["0104600682000013215S"],"updatedAt":"t"}"""

    private fun box(sscc: String, bottles: Int) =
        BoxRegistryEntity(sscc, "b-0", "p-1", bottles, "[]", "2026-09-01T00:00:00.000Z")

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
        mirror = WriteoffMirror(api, db, meta) { STAMP }
    }

    @After
    fun tearDown() {
        runCatching { server.shutdown() }
        db.close()
    }

    @Test
    fun bootstrapReplacesCachesAndStamps() = runTest {
        db.writeoffReasonDao().replaceAll(listOf(WriteoffReasonEntity("gone", "Снятая", 0)))
        server.enqueue(MockResponse().setBody(bootstrapJson))
        server.enqueue(MockResponse().setBody("""{"until":"7","items":[]}"""))
        assertEquals(MirrorOutcome.Ok, mirror.refresh())
        assertEquals(listOf("Бой", "Просрочка"), db.writeoffReasonDao().all().map { it.name })
        assertEquals("Вода 0,5 л", db.writeoffProductDao().byGtin("04600682000013")?.name)
        assertEquals("p-1", db.writeoffProductDao().byGtin("04600682000013")?.id)
        assertTrue(db.writeoffPermissionDao().get("op-1")!!.canWriteoff)
        assertFalse(db.writeoffPermissionDao().get("op-2")!!.canWriteoff)
        assertEquals("7", meta.get(MetaStore.BOX_REGISTRY_UNTIL))
        assertNotNull(meta.get(MetaStore.WRITEOFF_BOOTSTRAP_AT))
        assertEquals(STAMP, mirror.stampAt.first())
        assertEquals("/station/writeoff-bootstrap", server.takeRequest().path)
        // No `since` on a first run and no `until` on a first page: both are what the server expects.
        assertEquals("/station/box-registry?limit=250", server.takeRequest().path)
    }

    @Test
    fun registryDeltaAppliesUpsertAndRemove() = runTest {
        db.boxRegistryDao().upsert(box("046000000000000018", bottles = 20))
        meta.put(MetaStore.BOX_REGISTRY_UNTIL, "7")
        server.enqueue(MockResponse().setBody(bootstrapJson))
        server.enqueue(
            MockResponse().setBody(
                """{"until":"9","items":[{"kind":"remove","sscc":"046000000000000018","updatedAt":"t"},""" +
                    """${upsert("046000000000000025", 12)}]}""",
            ),
        )
        assertEquals(MirrorOutcome.Ok, mirror.refresh())
        assertNull(db.boxRegistryDao().bySscc("046000000000000018"))
        assertEquals(12, db.boxRegistryDao().bySscc("046000000000000025")?.bottleCount)
        assertEquals(listOf("0104600682000013215S"), db.boxRegistryDao().bySscc("046000000000000025")?.contentKeys())
        assertEquals("9", meta.get(MetaStore.BOX_REGISTRY_UNTIL))
        server.takeRequest()
        assertEquals("/station/box-registry?since=7&limit=250", server.takeRequest().path)
    }

    /**
     * A delta walk must not drop what it already holds, and a cursor page must
     * echo the window the first page assigned: the server rejects a changed one.
     */
    @Test
    fun aCursorWalkEchoesTheWindowAndStoresUntilOnlyAtTheEnd() = runTest {
        meta.put(MetaStore.BOX_REGISTRY_UNTIL, "7")
        server.enqueue(MockResponse().setBody(bootstrapJson))
        server.enqueue(MockResponse().setBody("""{"until":"9","items":[${upsert("046000000000000025", 12)}],"nextCursor":"c1"}"""))
        server.enqueue(MockResponse().setBody("""{"until":"9","items":[${upsert("046000000000000032", 6)}]}"""))
        assertEquals(MirrorOutcome.Ok, mirror.refresh())
        assertEquals(2, db.boxRegistryDao().count())
        assertEquals("9", meta.get(MetaStore.BOX_REGISTRY_UNTIL))
        server.takeRequest()
        assertEquals("/station/box-registry?since=7&limit=250", server.takeRequest().path)
        assertEquals("/station/box-registry?since=7&until=9&cursor=c1&limit=250", server.takeRequest().path)
    }

    /**
     * Storing the window before the walk finishes would skip the tail forever on
     * the next run, so a failed page must leave the old revision in place.
     */
    @Test
    fun aFailedTailLeavesTheOldRevision() = runTest {
        meta.put(MetaStore.BOX_REGISTRY_UNTIL, "7")
        server.enqueue(MockResponse().setBody(bootstrapJson))
        server.enqueue(MockResponse().setBody("""{"until":"9","items":[${upsert("046000000000000025", 12)}],"nextCursor":"c1"}"""))
        server.enqueue(MockResponse().setResponseCode(500))
        assertEquals(MirrorOutcome.Failed("http"), mirror.refresh())
        assertEquals("7", meta.get(MetaStore.BOX_REGISTRY_UNTIL))
        // The page that did land stays: re-applying an upsert is idempotent.
        assertEquals(12, db.boxRegistryDao().bySscc("046000000000000025")?.bottleCount)
    }

    @Test
    fun aFullSnapshotDropsBoxesTheServerNoLongerLists() = runTest {
        db.boxRegistryDao().upsert(box("046000000000000018", bottles = 20))
        server.enqueue(MockResponse().setBody(bootstrapJson))
        server.enqueue(MockResponse().setBody("""{"until":"9","items":[${upsert("046000000000000025", 12)}]}"""))
        assertEquals(MirrorOutcome.Ok, mirror.refresh())
        assertNull(db.boxRegistryDao().bySscc("046000000000000018"))
        assertEquals(1, db.boxRegistryDao().count())
    }

    @Test
    fun offlineLeavesCachesUntouched() = runTest {
        db.writeoffReasonDao().replaceAll(listOf(WriteoffReasonEntity("r1", "Старая", 0)))
        server.shutdown()
        assertEquals(MirrorOutcome.Offline, mirror.refresh())
        assertEquals("Старая", db.writeoffReasonDao().all().single().name)
        assertNull(meta.get(MetaStore.WRITEOFF_BOOTSTRAP_AT))
    }

    @Test
    fun anUpsertMissingItsBoxFieldsIsRefusedWithoutStoringTheRevision() = runTest {
        server.enqueue(MockResponse().setBody(bootstrapJson))
        server.enqueue(MockResponse().setBody("""{"until":"9","items":[{"kind":"upsert","sscc":"046000000000000025","updatedAt":"t"}]}"""))
        assertEquals(MirrorOutcome.Failed("registry shape"), mirror.refresh())
        assertEquals(0, db.boxRegistryDao().count())
        assertNull(meta.get(MetaStore.BOX_REGISTRY_UNTIL))
    }

    private companion object {
        const val STAMP = 1_757_845_320_000L
    }
}
