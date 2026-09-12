package app.markiro.handheld.feature.hub

import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.storage.DeviceConfigDao
import app.markiro.handheld.core.storage.RosterStore
import app.markiro.handheld.feature.pairing.toRecord
import javax.inject.Inject

/** Refreshes the operator mirror when online; a failure keeps the previous roster. */
class RosterRefresher @Inject constructor(
    private val recovery: app.markiro.handheld.core.storage.DeviceRecovery,
    private val api: StationApi,
    private val roster: RosterStore,
    private val config: DeviceConfigDao,
) {
    suspend fun refresh(now: Long = System.currentTimeMillis()) = recovery.work {
        val items = runCatching { api.operators().items }.getOrNull() ?: return@work
        roster.replace(items.map { it.toRecord() })
        recovery.commit { config.get()?.let { config.upsert(it.copy(rosterFetchedAt = now)) } }
    }
}
