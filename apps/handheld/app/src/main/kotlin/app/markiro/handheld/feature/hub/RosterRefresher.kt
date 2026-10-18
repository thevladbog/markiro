package app.markiro.handheld.feature.hub

import app.markiro.handheld.core.backend.BackendKind
import app.markiro.handheld.core.backend.CloudBackend
import app.markiro.handheld.core.backend.StationBackend
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.storage.DeviceConfigDao
import app.markiro.handheld.core.storage.RosterStore
import app.markiro.handheld.feature.pairing.toRecord
import javax.inject.Inject

/** Refreshes the operator mirror when online; a failure keeps the previous roster. */
class RosterRefresher @Inject constructor(
    private val recovery: app.markiro.handheld.core.storage.DeviceRecovery,
    private val backend: StationBackend,
    private val roster: RosterStore,
    private val config: DeviceConfigDao,
    private val branding: app.markiro.handheld.core.label.OrganizationPrintBranding? = null,
) {
    constructor(
        recovery: app.markiro.handheld.core.storage.DeviceRecovery,
        api: StationApi,
        roster: RosterStore,
        config: DeviceConfigDao,
        branding: app.markiro.handheld.core.label.OrganizationPrintBranding? = null,
    ) : this(recovery, CloudBackend(api), roster, config, branding)

    suspend fun refresh(now: Long = System.currentTimeMillis()) = recovery.work {
        if (backend.kindNow() == BackendKind.HOST) {
            // The feed writes the operators; the refresh only asks for it and stamps the time.
            runCatching { backend.operators() }.getOrNull() ?: return@work
            recovery.commit { config.get()?.let { config.upsert(it.copy(rosterFetchedAt = now)) } }
            return@work
        }
        val items = runCatching { backend.operators().items }.getOrNull() ?: return@work
        roster.replace(items.map { it.toRecord() })
        recovery.commit { config.get()?.let { config.upsert(it.copy(rosterFetchedAt = now)) } }
        // The cloud's print logo; a host's comes with its shifts and `org/print` (task Д3).
        if (backend.kindNow() == BackendKind.CLOUD) {
            try { branding?.refresh() } catch (e: kotlinx.coroutines.CancellationException) { throw e } catch (_: Exception) { /* Retain the last complete logo offline. */ }
        }
    }
}
