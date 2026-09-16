package app.markiro.handheld.feature.shift

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.MainDispatcherRule
import app.markiro.handheld.core.box.SsccPool
import app.markiro.handheld.core.network.NetworkModule
import app.markiro.handheld.core.network.ReachabilityTracker
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import kotlinx.coroutines.flow.first
import app.cash.turbine.test
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory

@RunWith(AndroidJUnit4::class)
class ReplacementAdmissionReviewTest {
    @get:Rule
    val main = MainDispatcherRule()

    private lateinit var db: HandheldDatabase
    private lateinit var server: MockWebServer
    private lateinit var api: StationApi

    @Before
    fun setUp() = runTest {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        server = MockWebServer().also { it.start() }
        api = Retrofit.Builder().baseUrl(server.url("/")).client(OkHttpClient())
            .addConverterFactory(NetworkModule.json().asConverterFactory("application/json".toMediaType()))
            .build()
            .create(StationApi::class.java)
        db.deviceConfigDao().upsert(
            DeviceConfigEntity(
                deviceId = "dev-1", deviceName = "ТСД 1", tenantId = "t", organizationName = "ООО",
                lineId = "l1", lineName = "Линия 2", kind = "handheld", serverUrl = "http://x", pairedAt = 1L,
            ),
        )
        db.initializeRecoveryForTest()
    }

    @After
    fun tearDown() {
        try {
            main.cancelAndJoinModels()
        } finally {
            server.shutdown()
            db.close()
        }
    }

    private fun vm() = main.track(
        ShiftListViewModel(
            ShiftRepository(api, db, NetworkModule.json(), SsccPool(db)) { 1_757_500_000_000L },
            db.deviceConfigDao(),
            db.recovery,
            ReachabilityTracker { 1_757_500_000_000L },
            flowOf(Unit),
        ),
    )

    @Test
    fun drainArrivingOnOpenShiftListDoesNotEscapeAsUnhandledException() = runTest {
        server.enqueue(MockResponse().setBody("""{"items":[]}"""))
        val model=vm()
        model.state.first { !it.loading }
        val intent=kotlinx.serialization.json.Json.parseToJsonElement("""{"version":1,"state":"active","intent":{"intentId":"11111111-1111-4111-8111-111111111111","preparationId":"22222222-2222-4222-8222-222222222222","credentialEpoch":7,"preparationRevision":2,"requestedAt":"2026-09-16T00:00:00Z","expiresAt":"2026-09-17T00:00:00Z"}}""") as kotlinx.serialization.json.JsonObject
        app.markiro.handheld.core.replacement.ReplacementReadiness(db).apply(db.recovery.token(),intent)
        model.events.test(timeout = 10.seconds) {
            model.select(ShiftEntityFixtures.bundled("new-shift"))
            model.grantDenial.isVisible.first { it }
            model.state.first { it.dialog == null }
            expectNoEvents()
        }
        assertNull(db.deviceConfigDao().get()?.activeShiftId)
        assertEquals(1,server.requestCount)
    }
    @Test fun drainArrivingOnOpenInventoryListShowsDenialWithoutEntering() = runTest {
        val session=app.markiro.handheld.feature.signin.SessionHolder().apply { signIn(app.markiro.handheld.core.auth.OperatorRecord("op","Operator","login","operator","hash",null,true)) }
        val repo=app.markiro.handheld.feature.inventory.InventoryRepository(api,db,app.markiro.handheld.core.inventory.InventoryBundleMirror(db,api),NetworkModule.json())
        val scanEvents=kotlinx.coroutines.flow.MutableSharedFlow<app.markiro.handheld.core.scan.ScanEvent>()
        server.enqueue(MockResponse().setBody("""{"items":[]}"""))
        val model=main.track(app.markiro.handheld.feature.inventory.InventoryListViewModel(repo,db.deviceConfigDao(),db.recovery,session,ReachabilityTracker(),app.markiro.handheld.core.scan.ScanRouterAdapter(scanEvents)))
        model.state.first { !it.loading }
        val intent=kotlinx.serialization.json.Json.parseToJsonElement("""{"version":1,"state":"active","intent":{"intentId":"11111111-1111-4111-8111-111111111111","preparationId":"22222222-2222-4222-8222-222222222222","credentialEpoch":7,"preparationRevision":2,"requestedAt":"2026-09-16T00:00:00Z","expiresAt":"2026-09-17T00:00:00Z"}}""") as kotlinx.serialization.json.JsonObject
        app.markiro.handheld.core.replacement.ReplacementReadiness(db).apply(db.recovery.token(),intent)
        model.events.test(timeout = 10.seconds) {
            model.select(app.markiro.handheld.core.network.InventoryTaskDto("new","INV-1","Product",null,"check","l1","Line","2026-09-01","2026-09-30"))
            model.grantDenial.isVisible.first { it }
            model.state.first { it.dialog == null }
            expectNoEvents()
        }
        assertNull(db.deviceConfigDao().get()?.activeInventoryId)
        assertEquals(1,server.requestCount)
    }

    @Test
    fun drainBeforeDelayedShiftBundleReturnsShowsDenialWithoutEntering() = runTest {
        val token = db.recovery.token()
        val shift = """{"id":"s1","number":"SEP26-001","status":"active","mode":"validation","validationPrint":{"mode":"none"},"productId":"p1","productName":"Вода","lineId":"l1","lineName":"Линия 2","plannedQty":100,"plannedDate":"2026-09-10","palletsEnabled":false,"stationCloseAccess":{"kind":"admin_only"}}"""
        val bundle = """{"shift":$shift,"product":{"id":"p1","gtin14":"04600682000013","name":"Вода"},"labelTemplate":null,"boxLabelTemplate":null,"counterpartyGln":null,"sscc":null,"ssccRevokedFrom":[],"operators":[]}"""
        server.dispatcher = object : okhttp3.mockwebserver.Dispatcher() {
            override fun dispatch(request: okhttp3.mockwebserver.RecordedRequest): MockResponse = when {
                request.path?.endsWith("/enter") == true -> MockResponse().setBody(shift)
                request.path?.endsWith("/bundle") == true -> {
                    kotlinx.coroutines.runBlocking {
                        val intent = kotlinx.serialization.json.Json.parseToJsonElement("""{"version":1,"state":"active","intent":{"intentId":"11111111-1111-4111-8111-111111111111","preparationId":"22222222-2222-4222-8222-222222222222","credentialEpoch":7,"preparationRevision":2,"requestedAt":"2026-09-16T00:00:00Z","expiresAt":"2026-09-17T00:00:00Z"}}""") as kotlinx.serialization.json.JsonObject
                        app.markiro.handheld.core.replacement.ReplacementReadiness(db).apply(token, intent)
                    }
                    MockResponse().setBody(bundle)
                }
                else -> MockResponse().setBody("""{"items":[]}""")
            }
        }
        val model = vm()
        model.state.first { !it.loading }
        model.events.test(timeout = 10.seconds) {
            model.select(ShiftEntityFixtures.bundled("s1"))
            model.grantDenial.isVisible.first { it }
            model.state.first { it.dialog == null }
            expectNoEvents()
        }
        assertNull(db.deviceConfigDao().get()?.activeShiftId)
        assertNull(db.shiftDao().get("s1"))
        assertEquals(3, server.requestCount)
    }

}
