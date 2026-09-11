package app.markiro.handheld.core.storage

import app.markiro.handheld.core.auth.OperatorRecord
import app.markiro.handheld.core.auth.OperatorRoster

class RosterStore(private val dao: OperatorDao, private val recovery: DeviceRecovery) : OperatorRoster {
    override suspend fun operators(): List<OperatorRecord> = dao.all().map {
        OperatorRecord(it.operatorId, it.name, it.login, it.role, it.pinHash, it.badgeHash, it.active)
    }

    suspend fun replace(records: List<OperatorRecord>) = recovery.commit { dao.replaceAll(
        records.map { OperatorEntity(it.operatorId, it.name, it.login, it.role, it.pinHash, it.badgeHash, it.active) },
    ) }
}
