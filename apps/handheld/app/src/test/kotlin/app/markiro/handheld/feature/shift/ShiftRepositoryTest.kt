package app.markiro.handheld.feature.shift

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.network.NetworkModule
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.HandheldDatabase
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
class ShiftRepositoryTest {
    private lateinit var db: HandheldDatabase
    private lateinit var server: MockWebServer
    private lateinit var api: StationApi
    private var clock = 1_757_500_000_000L

    private val shiftJson = """{"id":"s1","number":"SEP26-001","status":"planned","mode":"validation","validationPrint":{"mode":"none"},
        "productId":"p1","productName":"Вода","productPrintName":null,"lineId":"l1","lineName":"Линия 2","counterpartyName":null,
        "plannedQty":100,"plannedDate":"2026-09-10","productionDate":null,"boxCapacity":null,"palletCapacity":null,"palletsEnabled":false,
        "openedAt":null,"closedAt":null,"stationCloseAccess":{"kind":"admin_only"}}"""
    private val activeShiftJson = shiftJson.replace("\"status\":\"planned\"", "\"status\":\"active\"")
    private val bundleJson = """{"shift":$activeShiftJson,
        "product":{"id":"p1","gtin14":"04600682000013","name":"Вода 0,5","printName":"Вода"},
        "labelTemplate":null,"boxLabelTemplate":null,"counterpartyGln":null,"sscc":null,"ssccRevokedFrom":[],
        "operators":[{"operatorId":"op-1","name":"Иванова Анна","login":"4127","role":"operator","pinHash":"x","badgeHash":null,"active":true}]}"""

    @Before
    fun setUp() = runTest {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        server = MockWebServer().also { it.start() }
        api = Retrofit.Builder().baseUrl(server.url("/")).client(OkHttpClient())
            .addConverterFactory(NetworkModule.json().asConverterFactory("application/json".toMediaType()))
            .build()
            .create(StationApi::class.java)
        db.deviceConfigDao().upsert(
            DeviceConfigEntity(
                deviceId = "dev-1", deviceName = "ТСД 1", tenantId = "t", organizationName = "ООО", lineId = "l1", lineName = "Линия 2",
                kind = "handheld", serverUrl = "http://x", pairedAt = 1L,
            ),
        )
    }

    @After
    fun tearDown() {
        server.shutdown()
        db.close()
    }

    private fun repo() = ShiftRepository(api, db, NetworkModule.json()) { clock }

    @Test
    fun refreshStoresTheListAndDropsVanishedListOnlyRows() = runTest {
        server.enqueue(MockResponse().setBody("""{"items":[$shiftJson]}"""))
        assertTrue(repo().refreshList())
        assertEquals("/shifts", server.takeRequest().path)
        assertEquals(listOf("s1"), db.shiftDao().observeAll().first().map { it.id })
        server.enqueue(MockResponse().setBody("""{"items":[]}"""))
        assertTrue(repo().refreshList())
        assertTrue(db.shiftDao().observeAll().first().isEmpty())
    }

    @Test
    fun enterRecordsParticipationStoresTheBundleAndActiveShiftButLeavesTheRosterAlone() = runTest {
        server.enqueue(MockResponse().setBody(activeShiftJson))
        server.enqueue(MockResponse().setBody(bundleJson))
        assertEquals(EnterResult.Ok, repo().enter("s1", null))
        assertEquals("/shifts/s1/enter", server.takeRequest().path)
        assertEquals("/shifts/s1/bundle", server.takeRequest().path)
        val shift = db.shiftDao().get("s1")
        assertEquals("04600682000013", shift?.productGtin14)
        assertEquals("active", shift?.status)
        assertNotNull(shift?.bundleFetchedAt)
        assertEquals("s1", db.deviceConfigDao().get()?.activeShiftId)
        // Pairing and the roster refresh own the operators mirror; the bundle's copy is ignored as on the station.
        assertTrue(db.operatorDao().all().isEmpty())
    }

    @Test
    fun refreshKeepsAShiftClosedOnThisDeviceClosed() = runTest {
        db.shiftDao().upsert(ShiftEntityFixtures.bundled("s1").copy(status = "closed"))
        server.enqueue(MockResponse().setBody("""{"items":[$activeShiftJson]}"""))
        assertTrue(repo().refreshList())
        assertEquals("closed", db.shiftDao().get("s1")?.status)
    }

    @Test
    fun updateRequiredAndClosedAreDistinguished() = runTest {
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"code":"STATION_UPDATE_REQUIRED","message":"x"}"""))
        assertEquals(EnterResult.UpdateRequired, repo().enter("s1", null))
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"message":"Closed shifts cannot be entered"}"""))
        assertEquals(EnterResult.Closed, repo().enter("s1", null))
    }

    @Test
    fun offlineEntryWorksOnlyWithABundle() = runTest {
        server.shutdown()
        assertEquals(EnterResult.Unavailable, repo().enter("s1", null))
        db.shiftDao().upsert(ShiftEntityFixtures.bundled("s1").copy(leftAt = 5L))
        assertEquals(EnterResult.Ok, repo().enter("s1", null))
        assertNull(db.shiftDao().get("s1")?.leftAt)
        assertEquals("s1", db.deviceConfigDao().get()?.activeShiftId)
    }

    @Test
    fun aggregationShiftsAreRefused() = runTest {
        db.shiftDao().upsert(ShiftEntityFixtures.bundled("s2").copy(mode = "aggregation"))
        assertEquals(EnterResult.AggregationUnsupported, repo().enter("s2", null))
    }
}
