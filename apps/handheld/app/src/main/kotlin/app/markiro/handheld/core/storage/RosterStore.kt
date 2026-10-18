package app.markiro.handheld.core.storage

import app.markiro.handheld.core.auth.OperatorRecord
import app.markiro.handheld.core.auth.OperatorRoster

class RosterStore(
    private val dao: OperatorDao,
    private val recovery: DeviceRecovery,
    /** The host's badges; `null` for the cloud's single-badge roster. */
    private val badges: OperatorBadgeDao? = null,
) : OperatorRoster {
    override suspend fun operators(): List<OperatorRecord> {
        val byOperator = badges?.all()?.groupBy { it.operatorId }.orEmpty()
        return dao.all().map {
            OperatorRecord(
                it.operatorId, it.name, it.login, it.role, it.pinHash, it.badgeHash, it.active,
                byOperator[it.operatorId].orEmpty().map { badge -> badge.badgePhc },
            )
        }
    }

    suspend fun replace(records: List<OperatorRecord>) = recovery.commit { dao.replaceAll(
        records.map { OperatorEntity(it.operatorId, it.name, it.login, it.role, it.pinHash, it.badgeHash, it.active) },
    ) }
}
