package app.markiro.handheld.feature.hub

import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.storage.DeviceConfigDao
import app.markiro.handheld.core.storage.RosterStore
import app.markiro.handheld.feature.pairing.toRecord
import javax.inject.Inject

/** Refreshes the operator mirror when online; a failure keeps the previous roster. */
class RosterRefresher @Inject constructor(
    private val api: StationApi,
    private val roster: RosterStore,
    private val config: DeviceConfigDao,
) {
    suspend fun refresh(now: Long = System.currentTimeMillis()) {
        val items = runCatching { api.operators().items }.getOrNull() ?: return
        roster.replace(items.map { it.toRecord() })
        config.get()?.let { config.upsert(it.copy(rosterFetchedAt = now)) }
    }
}
