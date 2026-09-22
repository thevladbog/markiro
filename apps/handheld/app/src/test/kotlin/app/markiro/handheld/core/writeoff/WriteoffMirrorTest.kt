package app.markiro.handheld.core.writeoff

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.network.NetworkModule
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.pallets.BoxRegistryMirror
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaStore
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
        mirror = WriteoffMirror(api, db, meta, BoxRegistryMirror(api, db, meta)) { STAMP }
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
        assertNotNull(meta.get(MetaStore.WRITEOFF_BOOTSTRAP_AT))
        assertEquals(STAMP, mirror.stampAt.first())
        assertEquals("/station/writeoff-bootstrap", server.takeRequest().path)
        // The bootstrap ends in the shared registry walk, which stores its own revision.
        // No `since` on a first run and no `until` on a first page: both are what the server expects.
        assertEquals("/station/box-registry?limit=250", server.takeRequest().path)
        assertEquals("7", meta.get(MetaStore.BOX_REGISTRY_UNTIL))
    }

    /** A refused walk is the refresh's outcome: the mode's data is not complete without it. */
    @Test
    fun aRefusedRegistryWalkFailsTheRefresh() = runTest {
        server.enqueue(MockResponse().setBody(bootstrapJson))
        server.enqueue(MockResponse().setResponseCode(500))
        assertEquals(MirrorOutcome.Failed("http"), mirror.refresh())
        assertNull(meta.get(MetaStore.BOX_REGISTRY_UNTIL))
        // The caches that did land stay: the next refresh replaces them wholesale anyway.
        assertEquals(2, db.writeoffReasonDao().all().size)
    }

    @Test
    fun offlineLeavesCachesUntouched() = runTest {
        db.writeoffReasonDao().replaceAll(listOf(WriteoffReasonEntity("r1", "Старая", 0)))
        server.shutdown()
        assertEquals(MirrorOutcome.Offline, mirror.refresh())
        assertEquals("Старая", db.writeoffReasonDao().all().single().name)
        assertNull(meta.get(MetaStore.WRITEOFF_BOOTSTRAP_AT))
    }

    private companion object {
        const val STAMP = 1_757_845_320_000L
    }
}
