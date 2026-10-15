package app.markiro.handheld.core.host

import app.markiro.handheld.core.network.host.FactReceiptDto
import app.markiro.handheld.core.network.host.HostApi
import app.markiro.handheld.core.storage.DeviceConfigDao
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.RecoveryBlocked
import app.markiro.handheld.core.sync.Backoff
import app.markiro.handheld.core.sync.SyncDriver
import app.markiro.handheld.core.sync.SyncEngine
import app.markiro.handheld.core.sync.SyncState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import retrofit2.HttpException
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The facts of a device paired with a host (`POST /v1/device/facts`): the other implementation of `SyncDriver`, which a cloud device
 * never runs (the pass is a no-op unless `device_config.backend` is `host`) and whose twin never runs on a host device.
 *
 * A pass freezes what is owed (`HostRecordFreezer`), then sends the queue in the order the records were frozen, at most 100 to a
 * request, each record's stored body as it is. The host answers a receipt per record and `HostAckMapper` settles each; a request that
 * got no answer (no network, a restore in progress, a 5xx, a rejected key) changes nothing, and the next pass sends the same bytes
 * under the same ids. A pass that settled nothing ends rather than ask again at once, so a host that answers but never names a record
 * cannot hold the loop.
 */
class HostSyncEngine(
    private val db: HandheldDatabase,
    private val api: () -> HostApi,
    private val mapper: HostAckMapper,
    private val calls: HostCalls,
    private val config: DeviceConfigDao = db.deviceConfigDao(),
    private val freezer: HostRecordFreezer = HostRecordFreezer(db),
    private val palletEvents: HostPalletEvents = HostPalletEvents(db),
    private val scope: CoroutineScope = CoroutineScope(kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.IO),
    private val clock: () -> Long = System::currentTimeMillis,
    private val heartbeatMs: Long = SyncEngine.HEARTBEAT_MS,
    private val backoff: Backoff = Backoff(),
    /** The beat of the link with the host (`HostHeartbeat.beat`), once per turn of the loop, before the queue is sent. */
    private val beat: suspend () -> Unit = {},
) : SyncDriver {
    private val nudges = Channel<Unit>(Channel.CONFLATED)
    private val drainMutex = Mutex()
    private val started = AtomicBoolean(false)
    private val startedAt = clock()
    private val lastSuccess = MutableStateFlow<Long?>(null)
    private val now = MutableStateFlow(clock())

    /** Everything the host is still owed: the queue and the sources not yet frozen. A quarantined record is not owed, it is for support. */
    override val state: StateFlow<SyncState> by lazy {
        combine(db.hostOutboxDao().observeOwed(), db.conflictDao().count(), lastSuccess, now) { owed, conflicts, last, at ->
            val since = last ?: startedAt
            SyncState(pending = owed, lastSuccessAt = last, stuck = owed > 0 && at - since > SyncEngine.STUCK_AFTER_MS, conflicts = conflicts)
        }.stateIn(scope, SharingStarted.Eagerly, SyncState())
    }

    override fun start() {
        if (!started.compareAndSet(false, true)) return
        scope.launch {
            var delayMs = heartbeatMs
            while (true) {
                withTimeoutOrNull(delayMs) { nudges.receive() }
                now.value = clock()
                try {
                    beat()
                } catch (e: kotlinx.coroutines.CancellationException) {
                    throw e
                } catch (_: Exception) {
                    // A beat that failed in some way of its own must not stop the queue from going out.
                }
                delayMs = if (drainAll()) {
                    backoff.reset()
                    heartbeatMs
                } else {
                    backoff.nextDelay()
                }
            }
        }
    }

    override fun nudge() {
        nudges.trySend(Unit)
    }

    override suspend fun drainAll(): Boolean = drainMutex.withLock {
        // A device of the cloud owes the host nothing, and never sends anything to it.
        if (config.get()?.backend != "host") return@withLock true
        try {
            db.recovery.work { drainOwned() }.also { if (it) lastSuccess.value = clock() }
        } catch (_: RecoveryBlocked) {
            false
        }
    }

    /**
     * Facts first, then the events of the warehouse pallets (they name boxes that the facts closed). What the events settle can free a record
     * that waited for them (the close of a pallet waits for its boxes), so the passes repeat while a pass froze something new.
     */
    private suspend fun drainOwned(): Boolean {
        repeat(MAX_ROUNDS) {
            val made = freezer.freezeAll() + palletEvents.freeze()
            if (!drainTarget(TARGET) { api().postFacts(it) }) return false
            if (!drainTarget(EVENTS) { api().postPalletEvents(it) }) return false
            if (made == 0) return true
        }
        return true
    }

    private suspend fun drainTarget(target: String, post: suspend (String) -> Result<List<FactReceiptDto>>): Boolean {
        val dao = db.hostOutboxDao()
        var previous: List<String>? = null
        while (true) {
            val batch = dao.queuedFor(target, MAX_BATCH)
            if (batch.isEmpty()) return true
            // The same head again means the answer settled nothing that left the queue: end the pass, never ask in a circle.
            val heads = batch.map { it.recordId }
            if (heads == previous) return false
            previous = heads
            // The stored bodies are joined, never parsed and written again: a record goes out in the bytes it was frozen in.
            val body = batch.joinToString(separator = ",", prefix = "{\"records\":[", postfix = "]}") { it.body }
            val receipts = try {
                calls.run { post(body) }
            } catch (_: IOException) {
                return false
            } catch (_: HttpException) {
                return false
            }
            if (mapper.apply(batch, receipts) == 0) return false
        }
    }

    companion object {
        const val TARGET = "facts"
        const val EVENTS = "events"
        private const val MAX_ROUNDS = 4

        /** The host's own limit of `POST /v1/device/facts` (1–100 records). */
        const val MAX_BATCH = 100
    }
}
