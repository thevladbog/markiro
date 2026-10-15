package app.markiro.handheld.core.storage

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.network.CredentialDto
import app.markiro.handheld.core.network.DeviceDto
import app.markiro.handheld.core.network.PairResponse
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class HostRecoveryTest {
    private lateinit var db: HandheldDatabase
    private val credential = InMemoryCredentialStore()
    private val pin = "ab".repeat(32)
    private val origin = "https://192.168.1.10:45710"

    @Before
    fun open() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
    }

    @After
    fun close() = db.close()

    private fun response(key: String = "k1") = PairResponse(
        device = DeviceDto("d1", "ТСД 1", "handheld", "h1", "", null),
        credential = CredentialDto(key, origin),
        operators = emptyList(),
    )

    @Test
    fun aHostPairingMakesAHostDeviceWithItsPinAndNoCloudOwnerNoise() = runTest {
        val recovery = DeviceRecovery(db, credential).also { it.initialize() }
        recovery.restore(response(), origin, HostPairing(pin, "h1", listOf("192.168.1.10")))
        val config = db.deviceConfigDao().get()!!
        assertEquals("host", config.backend)
        assertEquals(pin, config.pinSha256)
        assertEquals("h1", config.hostId)
        assertEquals("192.168.1.10", config.hostAddresses)
        assertNull(config.hostRev)
        assertEquals(DeviceOwner(origin, "h1", "d1", "handheld", pin), recovery.current().owner)
        assertEquals("k1", credential.read())
    }

    @Test
    fun aCloudPairingStaysTheCloudsAndAHostDeviceSurvivesARestartAsTheSameOwner() = runTest {
        // A restart is a second coordinator over the same file; one database object admits one coordinator.
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        fun open() = Room.databaseBuilder(context, HandheldDatabase::class.java, "host-restart.db").allowMainThreadQueries().build()
        val first = open()
        DeviceRecovery(first, credential).also { it.initialize(); it.restore(response(), origin, HostPairing(pin, "h1", listOf("192.168.1.10"))) }
        first.close()
        val second = open()
        try {
            val restarted = DeviceRecovery(second, credential).also { it.initialize() }
            assertEquals(RecoveryPhase.ACTIVE, restarted.current().phase)
            assertEquals(pin, restarted.current().owner?.pinSha256)
            assertEquals("host", second.deviceConfigDao().get()!!.backend)
        } finally {
            second.close()
            context.deleteDatabase("host-restart.db")
        }
    }

    @Test
    fun aRePairingKeepsTheOwnerAndTakesAChangedPinOnlyWhenTheCallerSaysSo() = runTest {
        val recovery = DeviceRecovery(db, credential).also { it.initialize() }
        recovery.restore(response(), origin, HostPairing(pin, "h1", listOf("192.168.1.10")))
        val token = recovery.token()
        recovery.reject(token)
        assertEquals(RecoveryPhase.SEALED, recovery.current().phase)
        val changed = "cd".repeat(32)
        assertThrows(RecoveryMismatch::class.java) {
            kotlinx.coroutines.runBlocking { recovery.restore(response("k2"), origin, HostPairing(changed, "h1", listOf("192.168.1.10"))) }
        }
        recovery.restore(response("k2"), origin, HostPairing(changed, "h1", listOf("192.168.1.10")), allowPinChange = true)
        assertEquals(changed, recovery.current().owner?.pinSha256)
        assertEquals("k2", credential.read())
        assertNull("the full feed is read again after a re-pairing", db.deviceConfigDao().get()!!.hostRev)
    }
}
