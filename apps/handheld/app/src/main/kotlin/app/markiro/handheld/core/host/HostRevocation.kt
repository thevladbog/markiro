package app.markiro.handheld.core.host

import app.markiro.handheld.core.network.RevocationBus
import app.markiro.handheld.core.storage.DeviceRecovery

/** A key the host rejected ends this device's data in the same way a revoked cloud key does: the credential is sealed and the shell goes back to pairing. */
class HostRevocation(private val recovery: DeviceRecovery, private val bus: RevocationBus) {
    suspend fun reject() {
        val token = runCatching { recovery.token() }.getOrNull() ?: return
        if (recovery.reject(token)) bus.raise(token)
    }
}
