package app.markiro.handheld.core.backend

import app.markiro.handheld.core.host.HostReferenceSync
import app.markiro.handheld.core.network.OperatorDto
import app.markiro.handheld.core.network.RosterResponse
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.storage.OperatorDao

/** The host behind the seam. Shifts, blocks and the pallet mode are added by tasks Д1 and Д3; what is not answered yet is `NoBackend`'s refusal. */
class HostBackend(
    private val reference: HostReferenceSync,
    private val operators: OperatorDao,
) : StationBackend by NoBackend {
    override suspend fun kindNow() = BackendKind.HOST
    override suspend fun cloudApi(): StationApi? = null

    /** The roster is what the feed wrote to Room: reading the feed is how it is refreshed. */
    override suspend fun operators(): RosterResponse {
        reference.sync().getOrThrow()
        return RosterResponse(operators.all().map { OperatorDto(it.operatorId, it.name, it.login, it.role, it.pinHash, it.badgeHash, it.active) })
    }
}
