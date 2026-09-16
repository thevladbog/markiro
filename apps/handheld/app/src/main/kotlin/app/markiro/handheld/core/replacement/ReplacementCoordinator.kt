package app.markiro.handheld.core.replacement

import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.storage.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import javax.inject.Inject
import javax.inject.Singleton

/** Poll only in the active owner scope; sealing cancels the in-flight request and its children. */
@Singleton
class ReplacementCoordinator @Inject constructor(private val db: HandheldDatabase, private val api: StationApi, private val recovery: DeviceRecovery) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var observing: Job? = null
    val state: Flow<ReplacementDrainEntity?> = db.replacementDao().observe()
    val counters: Flow<JsonSnapshot> = flow {
        while (currentCoroutineContext().isActive) {
            emit(JsonSnapshot(ReplacementReadiness(db).snapshot()))
            delay(2_000)
        }
    }
    @Synchronized fun start() {
        if (observing != null) return
        observing = scope.launch { run() }
    }
    internal suspend fun run() {
            recovery.state.collectLatest { state ->
                if (state.phase == RecoveryPhase.ACTIVE) {
                    while (currentCoroutineContext().isActive) {
                        try { replacementIfAvailable { ReplacementTransport(db,api).refresh() } }
                        catch (cancelled: CancellationException) { throw cancelled }
                        catch (failure: Exception) { android.util.Log.w("ReplacementCoordinator", "Replacement retry pending (${failure.javaClass.simpleName})") }
                        delay(30_000)
                    }
                }
            }
    }
}
data class JsonSnapshot(val value: kotlinx.serialization.json.JsonObject)
