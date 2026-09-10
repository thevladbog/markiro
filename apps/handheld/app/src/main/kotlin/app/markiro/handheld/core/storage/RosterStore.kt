package app.markiro.handheld.core.storage

import app.markiro.handheld.core.auth.OperatorRecord
import app.markiro.handheld.core.auth.OperatorRoster

class RosterStore(private val dao: OperatorDao) : OperatorRoster {
    override suspend fun operators(): List<OperatorRecord> = dao.all().map {
        OperatorRecord(it.operatorId, it.name, it.login, it.role, it.pinHash, it.badgeHash, it.active)
    }

    suspend fun replace(records: List<OperatorRecord>) = dao.replaceAll(
        records.map { OperatorEntity(it.operatorId, it.name, it.login, it.role, it.pinHash, it.badgeHash, it.active) },
    )
}
