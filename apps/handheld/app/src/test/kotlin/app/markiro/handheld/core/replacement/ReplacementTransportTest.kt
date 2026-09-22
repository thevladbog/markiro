package app.markiro.handheld.core.replacement

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.storage.*
import kotlinx.coroutines.*
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class ReplacementTransportTest {
    private val intent=Json.parseToJsonElement("""{"version":1,"state":"active","intent":{"intentId":"11111111-1111-4111-8111-111111111111","preparationId":"22222222-2222-4222-8222-222222222222","credentialEpoch":7,"preparationRevision":2,"requestedAt":"2026-09-16T00:00:00Z","expiresAt":"2026-09-17T00:00:00Z"}}""").jsonObject
    private val closure=Json.parseToJsonElement("""{"version":1,"state":"cancelled","intentId":"11111111-1111-4111-8111-111111111111","preparationId":"22222222-2222-4222-8222-222222222222","credentialEpoch":7,"preparationRevision":3,"closedAt":"2026-09-16T01:00:00Z"}""").jsonObject
    private fun api(server: MockWebServer)=Retrofit.Builder().baseUrl(server.url("/"))
        .client(OkHttpClient.Builder().retryOnConnectionFailure(false).build()).addConverterFactory(Json.asConverterFactory("application/json".toMediaType())).build().create(StationApi::class.java)
    private fun response(body: JsonObject)=MockResponse().setHeader("Content-Type","application/json").setBody(body.toString())
    @Test fun lostClosureResponseRetriesExactBodyAndFailedReportDoesNotBlockCancellation() = runTest {
        val server=MockWebServer(); server.start()
        val db=Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(),HandheldDatabase::class.java).allowMainThreadQueries().build()
        db.deviceConfigDao().upsert(syntheticDeviceConfig(server.url("/").toString())); db.initializeRecoveryForTest()
        try {
            val local=ReplacementReadiness(db); val token=db.recovery.token()
            local.apply(token,intent); local.prepareReport(token)
            server.enqueue(MockResponse().setResponseCode(409)); server.enqueue(response(closure)); server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
            assertFalse(replacementIfAvailable { ReplacementTransport(db,api(server)).refresh() })
            assertTrue(local.blocked())
            assertEquals("/station/device-replacement-readiness",server.takeRequest().path)
            assertTrue(server.takeRequest().path!!.contains("knownIntentId=11111111"))
            val first=server.takeRequest().body.readUtf8()
            val body=Json.parseToJsonElement(first).jsonObject
            server.enqueue(response(closure)); server.enqueue(response(JsonObject(body+("acknowledgedAt" to JsonPrimitive("2026-09-16T01:00:01Z")))))
            ReplacementTransport(db,api(server)).refresh()
            server.takeRequest()
            assertEquals(first,server.takeRequest().body.readUtf8())
            assertFalse(local.blocked())
        } finally { db.close(); server.shutdown() }
    }
    @Test fun lateAuthenticatedIntentCannotWriteAfterCredentialRotation() = runTest {
        val server=MockWebServer(); server.start()
        val db=Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(),HandheldDatabase::class.java).allowMainThreadQueries().build()
        db.deviceConfigDao().upsert(syntheticDeviceConfig(server.url("/").toString())); db.initializeRecoveryForTest()
        val arrived=CountDownLatch(1); val release=CountDownLatch(1)
        try {
            server.dispatcher=object: okhttp3.mockwebserver.Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse { arrived.countDown(); check(release.await(15,TimeUnit.SECONDS)); return response(intent) }
            }
            val pending=async(Dispatchers.IO) { runCatching { ReplacementTransport(db,api(server)).refresh() } }
            withContext(Dispatchers.IO) { check(arrived.await(15,TimeUnit.SECONDS)) }
            db.recovery.reject(db.recovery.token()); db.reconnectSameDeviceForTest(); release.countDown()
            assertTrue(pending.await().exceptionOrNull() is CancellationException)
            assertNull(db.replacementDao().get())
        } finally { release.countDown(); db.close(); server.shutdown() }
    }
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test fun coordinatorPollsOnlyAuthenticatedAndSealingCancelsItsChildRequest() = runTest {
        val server=MockWebServer(); server.start()
        val db=Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(),HandheldDatabase::class.java).allowMainThreadQueries().build()
        db.deviceConfigDao().upsert(syntheticDeviceConfig())
        val recovery=DeviceRecovery(db,InMemoryCredentialStore().apply { write("synthetic-key") })
        val began=CompletableDeferred<Unit>(); val cancelled=CompletableDeferred<Unit>()
        var requests=0
        val transport=object: StationApi by api(server) {
            override suspend fun replacementIntent(knownIntentId: String?): JsonObject? {
                requests++; began.complete(Unit)
                try { awaitCancellation() } finally { cancelled.complete(Unit) }
            }
        }
        val job=backgroundScope.launch(kotlinx.coroutines.test.UnconfinedTestDispatcher(testScheduler)) { ReplacementCoordinator(db,transport,recovery).run() }
        try {
            runCurrent()
            assertEquals(0,requests)
            recovery.initialize(); began.await(); assertEquals(1,requests)
            recovery.reject(recovery.token()); cancelled.await()
            advanceTimeBy(90_000)
            assertEquals(1,requests)
            assertTrue(job.isActive)
        } finally { job.cancelAndJoin(); db.close(); server.shutdown() }
    }

    @Test fun credentialRotationDoesNotSendOldGenerationReportOrKnownIntent() = runTest {
        val server=MockWebServer(); server.start()
        val db=Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(),HandheldDatabase::class.java).allowMainThreadQueries().build()
        db.deviceConfigDao().upsert(syntheticDeviceConfig(server.url("/").toString())); db.initializeRecoveryForTest()
        try {
            val local=ReplacementReadiness(db); val token=db.recovery.token()
            local.apply(token,intent); local.prepareReport(token)
            db.recovery.reject(token); db.reconnectSameDeviceForTest()
            server.enqueue(MockResponse().setResponseCode(409)); server.enqueue(response(buildJsonObject { put("version",1); put("state","none") }))
            assertFalse(replacementIfAvailable { ReplacementTransport(db,api(server)).refresh() })
            assertEquals(0,server.requestCount)
            assertTrue(local.blocked())
        } finally { db.close(); server.shutdown() }
    }

}
