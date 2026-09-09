package app.markiro.handheld.feature.pairing

import app.markiro.handheld.core.auth.OperatorRecord
import app.markiro.handheld.core.network.OperatorDto
import app.markiro.handheld.core.network.PairResponse
import app.markiro.handheld.core.storage.CredentialStore
import app.markiro.handheld.core.storage.DeviceConfigDao
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.RosterStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

fun interface ProvisioningStore {
    suspend fun persist(response: PairResponse, enteredServerUrl: String)
}

fun OperatorDto.toRecord() = OperatorRecord(operatorId, name, login, role, pinHash, badgeHash, active)

/**
 * Same order as the station's persistStationProvisioning: roster, then credential, then the
 * config row whose presence means "paired". A failure before the config write leaves the
 * device unpaired with nothing to clean up but a roster that the next pairing replaces.
 */
class RoomProvisioningStore(
    private val roster: RosterStore,
    private val credential: CredentialStore,
    private val config: DeviceConfigDao,
    private val now: () -> Long = System::currentTimeMillis,
) : ProvisioningStore {
    override suspend fun persist(response: PairResponse, enteredServerUrl: String) = withContext(Dispatchers.IO) {
        roster.replace(response.operators.map { it.toRecord() })
        credential.write(response.credential.apiKey)
        val device = response.device
        config.upsert(
            DeviceConfigEntity(
                deviceId = device.id,
                deviceName = device.name,
                tenantId = device.tenantId,
                organizationName = device.organizationName,
                lineId = device.line?.id,
                lineName = device.line?.name,
                kind = device.kind,
                serverUrl = response.credential.serverUrl.ifBlank { enteredServerUrl },
                pairedAt = now(),
                rosterFetchedAt = now(),
            ),
        )
    }
}
