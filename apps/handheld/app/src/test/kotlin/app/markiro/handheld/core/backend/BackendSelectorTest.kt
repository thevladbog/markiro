package app.markiro.handheld.core.backend

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.network.RosterResponse
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.syntheticDeviceConfig
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class BackendSelectorTest {
    private lateinit var db: HandheldDatabase

    @Before
    fun open() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
    }

    @After
    fun close() = db.close()

    private class Marker(private val type: BackendKind, private val name: String) : StationBackend by NoBackend {
        val calls = mutableListOf<String>()
        override suspend fun kindNow() = type
        override suspend fun operators() = RosterResponse(emptyList()).also { calls += name }
        override suspend fun leave(shiftId: String): String = "left".also { calls += "$name leave $shiftId" }
    }

    @Test
    fun aDeviceWithoutConfigOrWithTheCloudBackendUsesTheCloud() = runTest {
        val cloud = Marker(BackendKind.CLOUD, "cloud")
        val host = Marker(BackendKind.HOST, "host")
        val selector = BackendSelector(db.deviceConfigDao(), cloud, host)
        assertEquals(BackendKind.CLOUD, selector.kindNow())
        db.deviceConfigDao().upsert(syntheticDeviceConfig())
        selector.operators()
        assertEquals(listOf("cloud"), cloud.calls)
        assertEquals(emptyList<String>(), host.calls)
    }

    @Test
    fun aDevicePairedWithAHostUsesTheHostAndNeverTheCloud() = runTest {
        val cloud = Marker(BackendKind.CLOUD, "cloud")
        val host = Marker(BackendKind.HOST, "host")
        db.deviceConfigDao().upsert(syntheticDeviceConfig().copy(backend = "host", pinSha256 = "ab".repeat(32), hostId = "h"))
        val selector = BackendSelector(db.deviceConfigDao(), cloud, host)
        assertEquals(BackendKind.HOST, selector.kindNow())
        selector.operators()
        assertEquals(listOf("host"), host.calls)
        assertEquals(emptyList<String>(), cloud.calls)
        assertSame(null, selector.cloudApi())
    }

    @Test
    fun aLeaveOfADevicePairedWithAHostReachesTheHost() = runTest {
        val cloud = Marker(BackendKind.CLOUD, "cloud")
        val host = Marker(BackendKind.HOST, "host")
        db.deviceConfigDao().upsert(syntheticDeviceConfig().copy(backend = "host", pinSha256 = "ab".repeat(32), hostId = "h"))
        val selector = BackendSelector(db.deviceConfigDao(), cloud, host)
        // Final review C1: the selector used to inherit a default that answered `null` without asking anyone.
        assertEquals("left", selector.leave("s1"))
        assertEquals(listOf("host leave s1"), host.calls)
        assertEquals(emptyList<String>(), cloud.calls)
    }
}
