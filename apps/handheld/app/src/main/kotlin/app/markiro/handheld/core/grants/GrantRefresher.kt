package app.markiro.handheld.core.grants

import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.DeviceRecovery
import app.markiro.handheld.core.storage.RecoveryPhase
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collectLatest
import javax.inject.Inject
import javax.inject.Singleton

/** Refresh on active credentials/reconnect and retry each minute. This cadence grants no offline lifetime. */
@Singleton
class GrantRefresher @Inject constructor(private val db: HandheldDatabase, private val api: StationApi, private val recovery: DeviceRecovery) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var observing: Job? = null
    @Synchronized fun start() {
        if(observing != null) return
        observing = scope.launch { recovery.state.collectLatest { if(it.phase == RecoveryPhase.ACTIVE) {
            while(isActive) { refresh(); delay(60_000) }
        } } }
    }
    fun nudge() { scope.launch { if(recovery.current().phase == RecoveryPhase.ACTIVE) refresh() } }
    private suspend fun refresh() {
        try {
            recovery.work {
                val transport = GrantTransport(db,api)
                if(!transport.refreshIfAvailable()) return@work
                db.shiftDao().all().filter { it.enteredAt != null && it.status != "closed" }.forEach { transport.refreshIfAvailable(TaskKind.SHIFT,it.id) }
                db.grantDao().provenances().filter { it.taskKind == "inventory" }.forEach {
                    if(db.inventoryTaskDao().get(it.taskId)?.state == "active") transport.refreshIfAvailable(TaskKind.INVENTORY,it.taskId)
                }
            }
        } catch (cancelled: CancellationException) { throw cancelled }
          catch (failure: Exception) { android.util.Log.w("GrantRefresher","Grant refresh failed (${failure.javaClass.simpleName})") }
    }
}
