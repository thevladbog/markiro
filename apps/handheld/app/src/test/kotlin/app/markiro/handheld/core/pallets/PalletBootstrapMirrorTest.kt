package app.markiro.handheld.core.pallets

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.box.SsccPool
import app.markiro.handheld.core.network.BundleSsccDto
import app.markiro.handheld.core.network.NetworkModule
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.storage.PalletLabelTemplateEntity
import app.markiro.handheld.core.storage.PalletPermissionEntity
import app.markiro.handheld.core.storage.PalletProductEntity
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import app.markiro.handheld.core.writeoff.MirrorOutcome
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory

@RunWith(AndroidJUnit4::class)
class PalletBootstrapMirrorTest {
    private lateinit var db: HandheldDatabase
    private lateinit var server: MockWebServer
    private lateinit var meta: MetaStore
    private lateinit var mirror: PalletBootstrapMirror

    private val bootstrapJson = """{"generatedAt":"2026-09-18T08:00:00.000Z",
        "products":[{"id":"p-1","gtin14":"04600682000013","name":"Cola","printName":"Cola 0.5","shelfLifeDays":180,"palletBoxCapacity":12,"chzProductGroupCode":8}],
        "operators":[{"employeeId":"op-1","canBuildPallets":true},{"employeeId":"op-2","canBuildPallets":false}],
        "palletSscc":{"issuerPrefix":"046006820","extensionDigit":1,"fromSerial":0,"toSerial":199,"consumedThroughSerial":null},
        "palletSsccRevokedFrom":[],
        "palletLabelTemplates":{"organisation":{"widthMm":100,"heightMm":150},"byCategory":[{"chzProductGroupCode":8,"template":{"widthMm":100,"heightMm":100}}]}}"""

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
        mirror = PalletBootstrapMirror(api, db, meta, SsccBlockApplier(SsccPool(db)), BoxRegistryMirror(api, db, meta)) { STAMP }
    }

    @After
    fun tearDown() {
        runCatching { server.shutdown() }
        db.close()
    }

    @Test
    fun aRefreshFillsCachesSeedsTheExtensionOnePoolAndWalksTheRegistry() = runTest {
        // Stale rows from a previous bootstrap must not survive: the caches are
        // replaced wholesale, not merged.
        db.palletProductDao().insertAll(listOf(PalletProductEntity("p-stale", "00000000000000", "Stale", null, null, null, null)))
        db.palletPermissionDao().insertAll(listOf(PalletPermissionEntity("op-stale", true)))
        db.palletLabelTemplateDao().insertAll(listOf(PalletLabelTemplateEntity("category:99", "{}")))
        server.enqueue(MockResponse().setBody(bootstrapJson))
        server.enqueue(
            MockResponse().setBody(
                """{"until":"9","items":[
            {"kind":"upsert","boxId":"b1","sscc":"034600682000000018","productId":"p-1","bottleCount":6,"contentKeys":[],"updatedAt":"t",
             "palletId":null,"palletSscc":null,"palletActive":false,"closedAt":"c","productionDate":"2026-09-10"}]}""",
            ),
        )
        assertEquals(MirrorOutcome.Ok, mirror.refresh())
        assertEquals(12, db.palletProductDao().byId("p-1")?.palletBoxCapacity)
        assertTrue(db.palletPermissionDao().get("op-1")!!.canBuildPallets)
        assertNotNull(db.palletLabelTemplateDao().get(PalletLabelTemplateEntity.ORG))
        assertNotNull(db.palletLabelTemplateDao().get(PalletLabelTemplateEntity.category(8)))
        assertNull(db.palletProductDao().byId("p-stale"))
        assertNull(db.palletPermissionDao().get("op-stale"))
        assertNull(db.palletLabelTemplateDao().get("category:99"))
        assertEquals("046006820", mirror.issuerPrefix())
        assertEquals(200L, SsccPool(db).remaining("046006820", SsccPool.PALLET_EXTENSION_DIGIT))
        assertEquals("2026-09-10", db.boxRegistryDao().bySscc("034600682000000018")?.productionDate)
        assertEquals("9", meta.get(MetaStore.BOX_REGISTRY_UNTIL))
        assertEquals(STAMP, meta.get(MetaStore.PALLET_BOOTSTRAP_AT)?.toLong())
        assertEquals(STAMP, mirror.stampAt.first())
        assertEquals("/station/pallet-bootstrap", server.takeRequest().path)
        assertEquals("/station/box-registry?limit=250", server.takeRequest().path)
    }

    @Test
    fun aNullBlockLeavesThePoolAloneAndStillFillsTheCaches() = runTest {
        // A pool already holding this device's extension-1 block: a null block on
        // refresh must leave it exactly as it was, not zero it out.
        SsccBlockApplier(SsccPool(db)).apply(BundleSsccDto("046006820", 1, 0, 199, null), emptyList())
        meta.put(MetaStore.PALLET_BOOTSTRAP_ISSUER_PREFIX, "046006820")
        server.enqueue(
            MockResponse().setBody(
                bootstrapJson.replace(
                    """"palletSscc":{"issuerPrefix":"046006820","extensionDigit":1,"fromSerial":0,"toSerial":199,"consumedThroughSerial":null}""",
                    """"palletSscc":null""",
                ),
            ),
        )
        server.enqueue(MockResponse().setBody("""{"until":"1","items":[]}"""))
        assertEquals(MirrorOutcome.Ok, mirror.refresh())
        assertEquals(200L, SsccPool(db).remaining("046006820", SsccPool.PALLET_EXTENSION_DIGIT))
        assertNull(mirror.issuerPrefix())
        assertEquals(1, db.palletProductDao().count())
    }

    @Test
    fun offlineKeepsEverything() = runTest {
        server.shutdown()
        assertEquals(MirrorOutcome.Offline, mirror.refresh())
        assertEquals(0, db.palletProductDao().count())
        assertNull(meta.get(MetaStore.PALLET_BOOTSTRAP_AT))
    }

    @Test
    fun aFailedRegistryWalkFailsTheRefreshButLeavesTheCachesFilled() = runTest {
        server.enqueue(MockResponse().setBody(bootstrapJson))
        server.enqueue(MockResponse().setResponseCode(500))
        assertEquals(MirrorOutcome.Failed("http"), mirror.refresh())
        assertEquals(12, db.palletProductDao().byId("p-1")?.palletBoxCapacity)
        assertTrue(db.palletPermissionDao().get("op-1")!!.canBuildPallets)
        assertNotNull(db.palletLabelTemplateDao().get(PalletLabelTemplateEntity.ORG))
        assertEquals("046006820", mirror.issuerPrefix())
        assertEquals(200L, SsccPool(db).remaining("046006820", SsccPool.PALLET_EXTENSION_DIGIT))
        assertEquals(STAMP, meta.get(MetaStore.PALLET_BOOTSTRAP_AT)?.toLong())
    }

    private companion object {
        const val STAMP = 1_757_845_320_000L
    }
}
