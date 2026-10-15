package app.markiro.handheld.core.backend

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.syntheticDeviceConfig
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.IOException

/** A cloud call that slips through in host mode must fail before it leaves the device (and take the cloud's key header with it). */
@RunWith(AndroidJUnit4::class)
class BackendGuardTest {
    @Test
    fun theCloudClientRefusesEveryCallOnceTheDeviceIsPairedWithAHost() = runTest {
        val db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        val server = MockWebServer().also { it.enqueue(MockResponse()); it.enqueue(MockResponse()); it.start() }
        try {
            val client = OkHttpClient.Builder().addInterceptor(BackendGuardInterceptor(db.deviceConfigDao())).build()
            val call = { client.newCall(Request.Builder().url(server.url("/shifts")).build()).execute().close() }
            db.deviceConfigDao().upsert(syntheticDeviceConfig())
            call()
            assertEquals(1, server.requestCount)
            db.deviceConfigDao().upsert(syntheticDeviceConfig().copy(backend = "host"))
            val failure = runCatching { call() }.exceptionOrNull()
            assertTrue("$failure", failure is IOException)
            assertEquals("the second call never left", 1, server.requestCount)
        } finally {
            server.shutdown()
            db.close()
        }
    }
}
