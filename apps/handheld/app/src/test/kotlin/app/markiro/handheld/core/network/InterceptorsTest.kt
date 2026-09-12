package app.markiro.handheld.core.network

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.DeviceRecovery
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import app.markiro.handheld.core.storage.syntheticDeviceConfig
import app.markiro.handheld.core.storage.reconnectSameDeviceForTest
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.async
import org.junit.Assert.assertTrue
import org.junit.runner.RunWith
import app.cash.turbine.test
import app.markiro.handheld.core.storage.InMemoryCredentialStore
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

@RunWith(AndroidJUnit4::class)
class InterceptorsTest {
    private lateinit var db: HandheldDatabase
    private lateinit var recovery: DeviceRecovery
    private val server = MockWebServer()
    private val credential = InMemoryCredentialStore()
    private val reachability = ReachabilityTracker()
    private val revocation = RevocationBus()
    private val client by lazy { GenerationCallFactory(OkHttpClient.Builder()
        .addInterceptor(ApiKeyInterceptor(recovery))
        .addInterceptor(CapabilitiesInterceptor())
        .addInterceptor(RevocationInterceptor(revocation, recovery))
        .addInterceptor(ReachabilityInterceptor(reachability))
        .build(), recovery) }

    @Before
    fun start() = runBlocking {
        server.start()
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java).allowMainThreadQueries().build()
        db.deviceConfigDao().upsert(syntheticDeviceConfig(server.url("/").toString()))
        credential.write("mk_live_abc")
        recovery = db.initializeRecoveryForTest(credential)
    }

    @After
    fun stop() { server.shutdown(); db.close() }

    @Test
    fun sendsTheKeyAndCapabilitiesAndRecordsSuccess() {
        credential.write("mk_live_abc")
        server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
        client.newCall(Request.Builder().url(server.url("/station/identity")).build()).execute().close()
        val request = server.takeRequest()
        assertEquals("mk_live_abc", request.getHeader("x-api-key"))
        assertEquals(HANDHELD_CAPABILITIES, request.getHeader("x-station-capabilities"))
        assertNotNull(reachability.lastSuccessAt.value)
    }

    @Test
    fun omitsTheKeyHeaderWhenUnpaired() {
        server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
        OkHttpClient().newCall(Request.Builder().url(server.url("/station/pair")).build()).execute().close()
        assertNull(server.takeRequest().getHeader("x-api-key"))
    }

    @Test
    fun raisesRevocationOnTheDocumentedRejectionOnly() = runTest {
        credential.write("mk_live_abc")
        revocation.events.test {
            server.enqueue(MockResponse().setResponseCode(401).setBody("""{"code":"STATION_CREDENTIAL_REVOKED"}"""))
            client.newCall(Request.Builder().url(server.url("/shifts")).build()).execute().close()
            awaitItem()
            assertNull(credential.read())
            expectNoEvents()
        }
    }
    @Test
    fun lateOld401CannotRevokeTheNewlyPublishedKey() = runTest {
        val entered = kotlinx.coroutines.CompletableDeferred<Unit>()
        val finish = kotlinx.coroutines.CompletableDeferred<Unit>()
        server.dispatcher = object : okhttp3.mockwebserver.Dispatcher() {
            override fun dispatch(request: okhttp3.mockwebserver.RecordedRequest): MockResponse {
                entered.complete(Unit)
                runBlocking { finish.await() }
                return MockResponse().setResponseCode(401).setBody("""{"code":"STATION_CREDENTIAL_REVOKED"}""")
            }
        }
        val call = client.newCall(Request.Builder().url(server.url("/shifts")).build())
        val inflight = async(kotlinx.coroutines.Dispatchers.IO) { call.execute().use { it.code } }
        entered.await()
        recovery.reject(recovery.token())
        val owner = checkNotNull(recovery.current().owner)
        recovery.restore(PairResponse(DeviceDto(owner.deviceId, "Restored", owner.kind, owner.tenantId, "Synthetic"),
            CredentialDto("new-key", owner.serverOrigin), emptyList()), owner.serverOrigin)
        finish.complete(Unit)
        assertEquals(401, inflight.await())
        assertEquals("new-key", credential.read())
        assertEquals(app.markiro.handheld.core.storage.RecoveryPhase.ACTIVE, recovery.current().phase)
        assertEquals("mk_live_abc", server.takeRequest().getHeader("x-api-key"))
    }

    @Test
    fun aQueuedOldCallCannotAttachTheNewCredentialWhenItStarts() = runTest {
        val queued = client.newCall(Request.Builder().url(server.url("/shifts")).build())
        recovery.reject(recovery.token())
        val owner = checkNotNull(recovery.current().owner)
        recovery.restore(PairResponse(DeviceDto(owner.deviceId, "Restored", owner.kind, owner.tenantId, "Synthetic"),
            CredentialDto("new-key", owner.serverOrigin), emptyList()), owner.serverOrigin)
        assertTrue(runCatching { queued.execute().close() }.isFailure)
        assertEquals(0, server.requestCount)
        assertEquals("new-key", credential.read())
    }

    @Test fun lateRosterResponseCannotRestorePurgedOperatorAuthentication() = runTest {
        val arrived = kotlinx.coroutines.CompletableDeferred<Unit>()
        val release = kotlinx.coroutines.CompletableDeferred<Unit>()
        server.dispatcher = object : okhttp3.mockwebserver.Dispatcher() {
            override fun dispatch(request: okhttp3.mockwebserver.RecordedRequest): MockResponse {
                arrived.complete(Unit)
                runBlocking { release.await() }
                return MockResponse().setBody("""{"items":[{"operatorId":"old-op","name":"Old","login":"123","role":"operator","pinHash":"synthetic-old-verifier","badgeHash":null,"active":true}]}""")
            }
        }
        val api = NetworkModule.stationApi(GenerationCallFactory(OkHttpClient.Builder().addInterceptor(BaseUrlInterceptor(ServerUrlProvider(db.deviceConfigDao(), server.url("/").toString()))).build(), recovery), NetworkModule.json())
        val refresher = app.markiro.handheld.feature.hub.RosterRefresher(recovery, api, app.markiro.handheld.core.storage.RosterStore(db.operatorDao(), recovery), db.deviceConfigDao())
        val oldRequest = async { runCatching { refresher.refresh() } }
        arrived.await()
        recovery.reject(recovery.token())
        db.reconnectSameDeviceForTest()
        release.complete(Unit)
        assertTrue(oldRequest.await().exceptionOrNull() is app.markiro.handheld.core.storage.RecoveryBlocked)
        assertTrue(db.operatorDao().all().isEmpty())
        assertEquals("restored-synthetic-key", credential.read())
    }

}
