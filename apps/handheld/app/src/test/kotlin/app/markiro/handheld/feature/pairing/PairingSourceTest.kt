package app.markiro.handheld.feature.pairing

import app.markiro.handheld.core.storage.DeviceOwner
import app.markiro.handheld.core.storage.RecoveryPhase
import app.markiro.handheld.core.storage.RecoveryState
import org.junit.Assert.assertEquals
import org.junit.Test

class PairingSourceTest {
    private val cloud = DeviceOwner("https://api.markiro.app", "t1", "d1", "handheld")
    private val host = DeviceOwner("https://192.168.1.10:45710", "h1", "d1", "handheld", "ab".repeat(32))

    @Test
    fun onlyANewDeviceChoosesAndAPairedOneKeepsItsBackend() {
        assertEquals(PairingSource.LOADING, pairingSourceOf(RecoveryState()))
        assertEquals(PairingSource.CHOOSE, pairingSourceOf(RecoveryState(RecoveryPhase.UNPAIRED)))
        assertEquals(PairingSource.CLOUD, pairingSourceOf(RecoveryState(RecoveryPhase.SEALED, cloud, 2)))
        assertEquals(PairingSource.HOST, pairingSourceOf(RecoveryState(RecoveryPhase.SEALED, host, 2)))
        assertEquals(PairingSource.CLOUD, pairingSourceOf(RecoveryState(RecoveryPhase.OWNER_UNRESOLVED)))
    }
}
