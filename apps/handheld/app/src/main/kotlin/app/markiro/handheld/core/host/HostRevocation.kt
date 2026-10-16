package app.markiro.handheld.core.host

import app.markiro.handheld.core.network.RevocationBus
import app.markiro.handheld.core.storage.DeviceRecovery
import app.markiro.handheld.core.storage.GenerationToken

/**
 * A key the host rejected ends this device's data in the same way a revoked cloud key does: the credential is sealed and the shell goes back to
 * pairing. The rejection belongs to the generation that sent the request (as the cloud transport tags it); one that answers after the device was
 * paired again names an old generation, and `DeviceRecovery.reject` refuses it.
 */
class HostRevocation(private val recovery: DeviceRecovery, private val bus: RevocationBus) {
    suspend fun reject(generation: GenerationToken?) {
        val token = generation ?: return
        if (recovery.reject(token)) bus.raise(token)
    }

    /** The generation a call starts under, or `null` while the device is sealed. */
    fun current(): GenerationToken? = runCatching { recovery.token() }.getOrNull()
}
