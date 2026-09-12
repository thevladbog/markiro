package app.markiro.handheld.feature.pairing

import app.markiro.handheld.core.auth.OperatorRecord
import app.markiro.handheld.core.network.OperatorDto
import app.markiro.handheld.core.network.PairResponse
import app.markiro.handheld.core.storage.DeviceRecovery

fun interface ProvisioningStore {
    suspend fun persist(response: PairResponse, enteredServerUrl: String)
}
fun OperatorDto.toRecord() = OperatorRecord(operatorId, name, login, role, pinHash, badgeHash, active)

/** Credential/config publication resumes a durable intent; retained tasks keep their owner. */
class RoomProvisioningStore(private val recovery: DeviceRecovery) : ProvisioningStore {
    override suspend fun persist(response: PairResponse, enteredServerUrl: String) {
        recovery.initialize()
        recovery.restore(response, enteredServerUrl)
    }
}
