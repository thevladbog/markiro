package app.markiro.handheld.feature.pairing

import app.markiro.handheld.core.network.CredentialDto
import app.markiro.handheld.core.network.DeviceDto
import app.markiro.handheld.core.network.PairResponse
import app.markiro.handheld.core.network.host.PairedDto
import app.markiro.handheld.core.storage.DeviceRecovery
import app.markiro.handheld.core.storage.HostPairing

fun interface HostProvisioningStore {
    /** Publishes the pairing: the key to the credential store, the owner (with the pin) and the config to Room, in one resumable intent (`DeviceRecovery`). */
    suspend fun persist(paired: PairedDto, origin: String, pin: String, addresses: List<String>, changedPin: Boolean)
}

class RoomHostProvisioningStore(private val recovery: DeviceRecovery) : HostProvisioningStore {
    override suspend fun persist(paired: PairedDto, origin: String, pin: String, addresses: List<String>, changedPin: Boolean) {
        recovery.initialize()
        val response = PairResponse(
            device = DeviceDto(id = paired.deviceId, name = "ТСД", kind = "handheld", tenantId = paired.hostId, organizationName = "", line = null),
            credential = CredentialDto(apiKey = paired.deviceKey, serverUrl = origin),
            operators = emptyList(),
        )
        recovery.restore(response, origin, HostPairing(pin, paired.hostId, addresses), allowPinChange = changedPin)
    }
}

/** The first read of the host's data after a claim (the feed, the blocks): pairing is not done before it lands (spec 8.3, point 4). */
fun interface HostBootstrap {
    suspend fun initialSync(): Result<Unit>
}
