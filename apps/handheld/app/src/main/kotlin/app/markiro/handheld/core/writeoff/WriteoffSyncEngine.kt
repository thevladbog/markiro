package app.markiro.handheld.core.writeoff

import app.markiro.handheld.core.network.WriteoffResultDto
import app.markiro.handheld.core.network.WriteoffSettlementDto
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaEntity
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.storage.RecoveryBlocked
import app.markiro.handheld.core.storage.WriteoffOutboxEntity
import app.markiro.handheld.core.sync.Backoff
import app.markiro.handheld.core.sync.SyncTransport
import app.markiro.handheld.core.sync.TransportResult
import app.markiro.handheld.core.util.Iso
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
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.util.concurrent.atomic.AtomicBoolean

data class WriteoffSyncState(
    val pending: Int = 0,
    val lastSuccessAt: Long? = null,
    val stuck: Boolean = false,
    /** The server refused the operator's right to write off. Only a human can clear this. */
    val denied: Boolean = false,
)

/**
 * Sends queued write-off documents, oldest first.
 *
 * Unlike the scan and inventory engines there is no batch and no payload digest:
 * a write-off is already one document with one `deviceSeq`, and its exact bytes
 * were frozen into `requestJson` when the operator confirmed it. A retry re-posts
 * those bytes unchanged, which is what lets the server answer a replay with the
 * original order number instead of filing a second act. The `writeoffPin` key is
 * therefore only a marker that a document is in flight.
 *
 * A refusal the server has already decided (an archived reason, an operator
 * without the right, a malformed body) settles the row as `rejected`. Retrying
 * would re-ask a question that has been answered, and because the queue is strict
 * FIFO by `deviceSeq`, one such row would otherwise block every later document
 * forever.
 *
 * A `401` is deliberately NOT such a refusal: it says the device is not
 * authenticated, which is about the device rather than this document, and
 * discarding queued production work over it would be data loss. It fails, backs
 * off and retries.
 */
class WriteoffSyncEngine(
    private val db: HandheldDatabase,
    private val meta: MetaStore,
    private val transport: SyncTransport,
    private val json: Json,
    private val scope: CoroutineScope,
    private val clock: () -> Long = System::currentTimeMillis,
    private val heartbeatMs: Long = HEARTBEAT_MS,
    private val backoff: Backoff = Backoff(),
) {
    private val nudges = Channel<Unit>(Channel.CONFLATED)
    private val drainMutex = Mutex()
    private val started = AtomicBoolean(false)
    private val startedAt = clock()
    private val lastSuccess = MutableStateFlow<Long?>(null)
    private val denied = MutableStateFlow(false)
    private val now = MutableStateFlow(clock())

    val state: StateFlow<WriteoffSyncState> =
        combine(db.writeoffOutboxDao().observePendingCount(), lastSuccess, denied, now) { pending, last, refused, at ->
            val since = last ?: startedAt
            WriteoffSyncState(pending, last, stuck = pending > 0 && at - since > STUCK_AFTER_MS, denied = refused)
        }.stateIn(scope, SharingStarted.Eagerly, WriteoffSyncState())

    fun start() {
        if (!started.compareAndSet(false, true)) return
        scope.launch {
            lastSuccess.value = meta.get(MetaStore.WRITEOFF_LAST_SUCCESS_AT)?.toLongOrNull()
            var delayMs = heartbeatMs
            while (true) {
                withTimeoutOrNull(delayMs) { nudges.receive() }
                now.value = clock()
                delayMs = if (try { drainAll() } catch (_: RecoveryBlocked) { false }) {
                    backoff.reset()
                    heartbeatMs
                } else {
                    backoff.nextDelay()
                }
            }
        }
    }

    /** A confirmed document, a regained network or the heartbeat; cheap and safe from any thread. */
    fun nudge() {
        nudges.trySend(Unit)
    }

    /** Every pending document in `deviceSeq` order. False on the first failure. */
    suspend fun drainAll(): Boolean = drainMutex.withLock {
        while (true) {
            when (drainOnce()) {
                Step.SETTLED -> continue
                Step.EMPTY -> break
                Step.FAILED -> return@withLock false
            }
        }
        true
    }

    internal enum class Step { SETTLED, EMPTY, FAILED }

    internal suspend fun drainOnce(): Step = try {
        db.recovery.work { drainOnceOwned() }
    } catch (_: RecoveryBlocked) {
        Step.FAILED
    }

    private suspend fun drainOnceOwned(): Step {
        val row = db.writeoffOutboxDao().oldestPending() ?: return Step.EMPTY
        val pin = MetaStore.writeoffPin(row.documentId)
        if (meta.get(pin) == null) db.recovery.commit { meta.put(pin, row.createdAt) }
        val sentAt = clock()
        val result = transport.post(PATH, row.requestJson)
        if (result !is TransportResult.Ok) return retryLater(row, sentAt)
        return when {
            result.code in 200..299 -> accept(row, result.body, sentAt)
            result.code in TERMINAL -> reject(row, result.code, result.body, sentAt)
            else -> retryLater(row, sentAt)
        }
    }

    private suspend fun retryLater(row: WriteoffOutboxEntity, at: Long): Step {
        db.recovery.commit { db.writeoffOutboxDao().touch(row.documentId, Iso.format(at)) }
        return Step.FAILED
    }

    private suspend fun accept(row: WriteoffOutboxEntity, body: String, at: Long): Step {
        val result = runCatching { json.decodeFromString(WriteoffResultDto.serializer(), body) }.getOrNull()
            ?: return retryLater(row, at)
        val settlement = json.encodeToString(
            WriteoffSettlementDto.serializer(),
            WriteoffSettlementDto(conflicts = result.conflicts, boxConflicts = result.boxConflicts),
        )
        db.recovery.commit {
            db.writeoffOutboxDao().markSent(row.documentId, result.orderNo, result.itemCount, settlement, Iso.format(at))
            db.writeoffOutboxDao().pruneSettledBeyond(KEEP_SETTLED)
            db.metaDao().remove(MetaStore.writeoffPin(row.documentId))
            db.metaDao().put(MetaEntity(MetaStore.WRITEOFF_LAST_SUCCESS_AT, at.toString()))
        }
        lastSuccess.value = at
        denied.value = false
        return Step.SETTLED
    }

    private suspend fun reject(row: WriteoffOutboxEntity, code: Int, body: String, at: Long): Step {
        val settlement = json.encodeToString(
            WriteoffSettlementDto.serializer(),
            WriteoffSettlementDto(error = message(body)),
        )
        db.recovery.commit {
            db.writeoffOutboxDao().markRejected(row.documentId, settlement, Iso.format(at))
            db.writeoffOutboxDao().pruneSettledBeyond(KEEP_SETTLED)
            db.metaDao().remove(MetaStore.writeoffPin(row.documentId))
        }
        if (code == 403) denied.value = true
        return Step.SETTLED
    }

    /** Nest's error body is `{"message": …}`; anything else is kept verbatim but bounded. */
    private fun message(body: String): String? {
        val parsed = runCatching { json.parseToJsonElement(body).jsonObject["message"]?.jsonPrimitive?.content }.getOrNull()
        return parsed ?: body.take(MESSAGE_MAX).ifEmpty { null }
    }

    private companion object {
        const val PATH = "/station/writeoffs"
        const val HEARTBEAT_MS = 15_000L
        const val STUCK_AFTER_MS = 5 * 60 * 1000L
        const val KEEP_SETTLED = 20
        const val MESSAGE_MAX = 200

        /**
         * Answers the server will repeat for these exact bytes. `401` is absent on
         * purpose: it is about the device's credential, not this document.
         */
        val TERMINAL = setOf(400, 403, 404, 409, 413, 422)
    }
}
