package app.markiro.handheld.feature.shift

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.box.ServerRange
import app.markiro.handheld.core.box.SsccPool
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

    private val aggregationShiftJson = activeShiftJson
        .replace("\"mode\":\"validation\"", "\"mode\":\"aggregation\"")
        .replace("\"boxCapacity\":null", "\"boxCapacity\":20")

    /** An aggregation shift as the server sends it: a box template and a serial block. */
    private val aggregationBundleJson = """{"shift":$aggregationShiftJson,
        "product":{"id":"p1","gtin14":"04600682000013","name":"Вода 0,5","printName":"Вода","shelfLifeDays":365,"egaisCode":null},
        "labelTemplate":null,
        "boxLabelTemplate":{"id":"t1","name":"Коробка 58×40","spec":{"widthMm":58,"heightMm":40,"dpi":203,"language":"zpl","elements":[]}},
        "counterpartyGln":null,
        "sscc":{"issuerPrefix":"468008990","extensionDigit":0,"fromSerial":1,"toSerial":1000,"consumedThroughSerial":100},
        "ssccRevokedFrom":[1],"operators":[]}"""

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

    private fun repo() = ShiftRepository(api, db, NetworkModule.json(), SsccPool(db)) { clock }

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
        assertEquals(EnterResult.Ok, repo().enter("s1"))
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
        assertEquals(EnterResult.UpdateRequired, repo().enter("s1"))
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"message":"Closed shifts cannot be entered"}"""))
        assertEquals(EnterResult.Closed, repo().enter("s1"))
    }

    @Test
    fun offlineEntryWorksOnlyWithABundle() = runTest {
        server.shutdown()
        assertEquals(EnterResult.Unavailable, repo().enter("s1"))
        db.shiftDao().upsert(ShiftEntityFixtures.bundled("s1").copy(leftAt = 5L))
        assertEquals(EnterResult.Ok, repo().enter("s1"))
        assertNull(db.shiftDao().get("s1")?.leftAt)
        assertEquals("s1", db.deviceConfigDao().get()?.activeShiftId)
    }

    @Test
    fun enteringAnAggregationShiftStoresItsBlockAndTemplate() = runTest {
        server.enqueue(MockResponse().setBody(aggregationShiftJson))
        server.enqueue(MockResponse().setBody(aggregationBundleJson))
        assertEquals(EnterResult.Ok, repo().enter("s1"))
        val shift = db.shiftDao().get("s1")!!
        assertEquals("468008990", shift.ssccIssuerPrefix)
        assertEquals(365, shift.shelfLifeDays)
        assertTrue(shift.boxLabelTemplate!!.contains("\"widthMm\""))
        // The block lands at its ORIGINAL bounds, advanced past what the server
        // already recorded as consumed.
        assertEquals(101L, SsccPool(db).burn("468008990", 0))
    }

    @Test
    fun aRevokedBlockIsDroppedBeforeTheReplacementIsApplied() = runTest {
        val pool = SsccPool(db)
        pool.addRange(ServerRange("468008990", 0, 1, 50, null))
        server.enqueue(MockResponse().setBody(aggregationShiftJson))
        server.enqueue(MockResponse().setBody(aggregationBundleJson))
        repo().enter("s1")
        // Burning picks the lowest fromSerial with room, so a revoked range left
        // in place would keep winning over the block the admin just cut.
        assertEquals(101L, pool.burn("468008990", 0))
    }

    @Test
    fun refreshingTheListKeepsWhatOnlyTheBundleCarries() = runTest {
        // The list has no SSCC issuer and no box template. Rebuilding the row from
        // it silently stripped both off a shift already entered, and boxes stopped
        // closing with nothing on screen connecting that to a list refresh.
        server.enqueue(MockResponse().setBody(aggregationShiftJson))
        server.enqueue(MockResponse().setBody(aggregationBundleJson))
        assertEquals(EnterResult.Ok, repo().enter("s1"))

        server.enqueue(MockResponse().setBody("""{"items":[$aggregationShiftJson]}"""))
        assertTrue(repo().refreshList())

        val shift = db.shiftDao().get("s1")!!
        assertEquals("468008990", shift.ssccIssuerPrefix)
        assertEquals(365, shift.shelfLifeDays)
        assertNotNull(shift.boxLabelTemplate)
        assertEquals("04600682000013", shift.productGtin14)
        // The bundle resolves these from the product and the list never carries a
        // print name, so a refresh must not replace what gets printed.
        assertEquals("Вода 0,5", shift.productName)
        assertEquals("Вода", shift.productPrintName)
    }
}
