package app.markiro.handheld.core.reprint

import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.RecoveryPhase
import app.markiro.handheld.core.storage.RecoveryBlocked
import app.markiro.handheld.core.sync.SyncDriver
import app.markiro.handheld.core.sync.SyncState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.util.concurrent.atomic.AtomicBoolean

/** Adds audit delivery to existing queue visibility; audit delivery never prints bytes. */
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class ReprintSyncDriver(private val upstream: SyncDriver, private val db: HandheldDatabase,
    private val reprints: SiteReprintOperations, private val scope: CoroutineScope,
    private val recovery: app.markiro.handheld.core.storage.DeviceRecovery) : SyncDriver {
    private val started = AtomicBoolean(false)
    private val nudges = Channel<Unit>(Channel.CONFLATED)
    private val counts = recovery.state.flatMapLatest { state ->
        if (state.phase == RecoveryPhase.ACTIVE) db.siteReprintDao().observeCounts(Json.encodeToString(state.owner), state.generation)
        else flowOf(ReprintAuditCounts(0, 0))
    }
    override val state = combine(upstream.state, counts) { original, counts ->
        original.copy(pending = original.pending + counts.pending, conflicts = original.conflicts + counts.rejected,
            stuck = original.stuck || counts.rejected > 0)
    }.stateIn(scope, SharingStarted.WhileSubscribed(5_000), SyncState())
    override fun start() {
        upstream.start()
        if (started.compareAndSet(false, true)) scope.launch {
            while (true) {
                withTimeoutOrNull(15_000) { nudges.receive() }
                if (recovery.current().phase == RecoveryPhase.ACTIVE) {
                    try { reprints.flushAudit() }
                    catch (_: RecoveryBlocked) { }
                    catch (cancelled: CancellationException) { throw cancelled }
                    catch (_: Exception) { /* Exact envelopes remain in Room for the next beat. */ }
                }
            }
        }
    }
    override fun nudge() { upstream.nudge(); nudges.trySend(Unit) }
    override suspend fun drainAll(): Boolean {
        val settled = upstream.drainAll()
        reprints.flushAudit()
        val token = try { recovery.token() } catch (_: RecoveryBlocked) { return false }
        val remaining = db.siteReprintDao().counts(Json.encodeToString(token.owner), token.generation)
        return settled && remaining.pending == 0 && remaining.rejected == 0
    }
}
