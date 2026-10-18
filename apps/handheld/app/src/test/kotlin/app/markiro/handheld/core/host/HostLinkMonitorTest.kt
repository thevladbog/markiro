package app.markiro.handheld.core.host

import app.markiro.handheld.core.network.host.HelloDto
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(androidx.test.ext.junit.runners.AndroidJUnit4::class)
class HostLinkMonitorTest {
    private fun hello(epoch: String? = null, time: String = "2026-10-15T09:00:00Z", protocol: Int = 6) =
        HelloDto("markiro-host", protocol, 1, "h", "0.1.0", time, true, epoch)

    @Test
    fun aChangedRestoreEpochIsReportedOnceAndTheFirstOneIsJustRemembered() = runTest {
        val seen = mutableListOf<String?>()
        val monitor = HostLinkMonitor(now = { 1_790_000_000_000L }, onRestore = { seen += it })
        assertFalse(monitor.observe(hello(epoch = "e1"), knownEpoch = null).restored)
        assertTrue(monitor.observe(hello(epoch = "e2"), knownEpoch = "e1").restored)
        assertFalse(monitor.observe(hello(epoch = "e2"), knownEpoch = "e2").restored)
        assertEquals(listOf<String?>("e2"), seen)
    }

    @Test
    fun theHostsClockMoreThanTwoMinutesFromTheDevicesIsWarnedAbout() = runTest {
        val now = java.time.Instant.parse("2026-10-15T09:00:00Z").toEpochMilli()
        val monitor = HostLinkMonitor(now = { now }, onRestore = {})
        assertFalse(monitor.observe(hello(time = "2026-10-15T09:01:59Z"), null).clockSkew)
        assertTrue(monitor.observe(hello(time = "2026-10-15T09:02:01Z"), null).clockSkew)
        assertTrue(monitor.observe(hello(time = "2026-10-15T08:57:00Z"), null).clockSkew)
    }

    private class Hello(val body: String) : app.markiro.handheld.core.network.host.HostTransport {
        override suspend fun get(path: String) = app.markiro.handheld.core.network.host.HostResult.Ok(200, body, null)
        override suspend fun post(path: String, body: String) = error("no POST")
    }

    private fun helloJson(epoch: String) =
        """{"product":"markiro-host","protocol":6,"minProtocol":1,"hostId":"h","time":"2026-10-15T09:00:00Z","initialized":true,"restoreEpoch":"$epoch"}"""

    @Test
    fun aHeartbeatRemembersTheFirstEpochAndAChangedOneOnlyAfterTheBlocksWereRegistered() = runTest {
        val db = androidx.room.Room.inMemoryDatabaseBuilder(
            androidx.test.core.app.ApplicationProvider.getApplicationContext(),
            app.markiro.handheld.core.storage.HandheldDatabase::class.java,
        ).allowMainThreadQueries().build()
        try {
            val config = db.deviceConfigDao()
            config.upsert(app.markiro.handheld.core.storage.syntheticDeviceConfig())
            val monitor = HostLinkMonitor(now = { java.time.Instant.parse("2026-10-15T09:00:00Z").toEpochMilli() }, onRestore = {})
            fun api(epoch: String) = app.markiro.handheld.core.network.host.HostApi(Hello(helloJson(epoch)))
            monitor.heartbeat(api("e1"), config) { error("nothing to register at the first sight") }.getOrThrow()
            assertEquals("e1", config.get()!!.hostRestoreEpoch)
            val failed = monitor.heartbeat(api("e2"), config) { Result.failure(java.io.IOException("down")) }.getOrThrow()
            assertTrue(failed.restored)
            assertEquals("a failed registration is repeated on the next beat", "e1", config.get()!!.hostRestoreEpoch)
            assertTrue(monitor.state.value.restoreEpochChanged)
            monitor.heartbeat(api("e2"), config) { Result.success(Unit) }.getOrThrow()
            assertEquals("e2", config.get()!!.hostRestoreEpoch)
        } finally {
            db.close()
        }
    }
}
