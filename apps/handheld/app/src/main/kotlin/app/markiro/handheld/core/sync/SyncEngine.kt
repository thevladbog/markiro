package app.markiro.handheld.core.sync

import androidx.room.withTransaction
import app.markiro.handheld.core.network.BatchConflictDto
import app.markiro.handheld.core.network.ConflictStatusRequest
import app.markiro.handheld.core.network.ConflictStatusResponse
import app.markiro.handheld.core.network.ScanCodeDto
import app.markiro.handheld.core.network.ScanItemDto
import app.markiro.handheld.core.network.ShiftCloseRequest
import app.markiro.handheld.core.network.ShiftCloseResponse
import app.markiro.handheld.core.network.SyncBatchRequest
import app.markiro.handheld.core.storage.ConflictEntity
import app.markiro.handheld.core.storage.DeviceConfigDao
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaEntity
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.storage.OutboxEntity
import app.markiro.handheld.core.storage.ShiftCloseEntity
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
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.util.concurrent.atomic.AtomicBoolean

data class SyncState(val pending: Int = 0, val lastSuccessAt: Long? = null, val stuck: Boolean = false, val conflicts: Int = 0)

/**
 * Port of the station's sync loop: one drain at a time, batches are a contiguous prefix of the
 * outbox pinned in `meta` before the request so a retry resends the same rows under the same
 * batch id, `alreadyApplied` is success, every other failure is retried with backoff.
 */
class SyncEngine(
    private val db: HandheldDatabase,
    private val meta: MetaStore,
    private val config: DeviceConfigDao,
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
    private val now = MutableStateFlow(clock())

    val state: StateFlow<SyncState> =
        combine(db.outboxDao().count(), db.conflictDao().count(), lastSuccess, now) { pending, conflicts, last, at ->
            val since = last ?: startedAt
            SyncState(pending = pending, lastSuccessAt = last, stuck = pending > 0 && at - since > STUCK_AFTER_MS, conflicts = conflicts)
        }.stateIn(scope, SharingStarted.Eagerly, SyncState())

    fun start() {
        if (!started.compareAndSet(false, true)) return
        scope.launch {
            lastSuccess.value = meta.get(MetaStore.SYNC_LAST_SUCCESS_AT)?.toLongOrNull()
            var delayMs = heartbeatMs
            while (true) {
                withTimeoutOrNull(delayMs) { nudges.receive() }
                tick()
                delayMs = if (drainAll()) {
                    backoff.reset()
                    heartbeatMs
                } else {
                    backoff.nextDelay()
                }
            }
        }
    }

    /** A recorded scan, a regained network or the heartbeat; cheap and safe from any thread. */
    fun nudge() {
        nudges.trySend(Unit)
    }

    /** Re-evaluates the stuck flag against the clock. */
    fun tick() {
        now.value = clock()
    }

    /** Sends every pending batch, then closes, then reconciles conflicts. False on the first failure. */
    suspend fun drainAll(): Boolean = drainMutex.withLock {
        while (true) {
            when (drainOnce()) {
                Step.SENT -> continue
                Step.EMPTY -> break
                Step.FAILED -> return false
            }
        }
        if (!drainCloses()) return false
        reconcileConflicts()
        true
    }

    internal enum class Step { SENT, EMPTY, FAILED }

    internal suspend fun drainOnce(): Step {
        val cfg = config.get() ?: return Step.EMPTY
        val pendingCeiling = meta.get(MetaStore.SYNC_PENDING_CEILING)?.toLongOrNull()
        val rows = if (pendingCeiling != null) db.outboxDao().headThrough(pendingCeiling, BATCH_SIZE) else db.outboxDao().head(BATCH_SIZE)
        if (rows.isEmpty()) {
            if (pendingCeiling != null) clearPending()
            return Step.EMPTY
        }
        val maxId = rows.last().id
        val batchId = meta.get(MetaStore.SYNC_PENDING_BATCH_ID)?.takeIf { pendingCeiling != null } ?: run {
            val id = "${cfg.deviceId}:${meta.installId()}:$maxId"
            meta.put(MetaStore.SYNC_PENDING_CEILING, maxId.toString())
            meta.put(MetaStore.SYNC_PENDING_BATCH_ID, id)
            id
        }
        val body = json.encodeToString(SyncBatchRequest.serializer(), SyncBatchRequest(batchId, rows.map { it.toItem(cfg.deviceId) }))
        val result = transport.post("/station/scans", body) as? TransportResult.Ok ?: return Step.FAILED
        if (result.code !in 200..299) return Step.FAILED
        val parsed = parseBatchResponse(result.body) ?: return Step.FAILED
        val at = clock()
        db.withTransaction {
            db.conflictDao().insertIgnore(
                parsed.conflicts.map { ConflictEntity(it.codeHash, it.winningTerminalId, it.winningScannedAt!!, Iso.format(at)) },
            )
            db.outboxDao().deleteThrough(maxId)
            db.metaDao().remove(MetaStore.SYNC_PENDING_BATCH_ID)
            db.metaDao().remove(MetaStore.SYNC_PENDING_CEILING)
            parsed.denied?.let { db.metaDao().put(MetaEntity(MetaStore.SYNC_LAST_DENIED, it)) }
            db.metaDao().put(MetaEntity(MetaStore.SYNC_LAST_SUCCESS_AT, at.toString()))
        }
        lastSuccess.value = at
        return Step.SENT
    }

    private suspend fun clearPending() {
        meta.remove(MetaStore.SYNC_PENDING_BATCH_ID)
        meta.remove(MetaStore.SYNC_PENDING_CEILING)
    }

    private class BatchResponse(val applied: Int, val alreadyApplied: Boolean, val conflicts: List<BatchConflictDto>, val denied: String?)

    /** The station's shape guard: a captive portal answering 200 must never ack a batch. */
    private fun parseBatchResponse(body: String): BatchResponse? {
        val obj = runCatching { json.parseToJsonElement(body).jsonObject }.getOrNull() ?: return null
        val applied = obj["applied"]?.jsonPrimitive?.takeIf { !it.isString }?.intOrNull ?: return null
        val alreadyApplied = obj["alreadyApplied"]?.jsonPrimitive?.takeIf { !it.isString }?.booleanOrNull ?: return null
        val conflicts = obj["conflicts"]?.takeIf { it !is JsonNull }?.jsonArray.orEmpty()
            .mapNotNull { runCatching { json.decodeFromJsonElement(BatchConflictDto.serializer(), it) }.getOrNull() }
            .filter { it.winningScannedAt != null && Iso.parse(it.winningScannedAt) != null }
        val denied = obj["denied"]?.takeIf { it !is JsonNull }?.toString()
        return BatchResponse(applied, alreadyApplied, conflicts, denied)
    }

    private suspend fun drainCloses(): Boolean {
        for (row in db.shiftCloseDao().pending()) {
            val body = json.encodeToString(ShiftCloseRequest.serializer(), row.toRequest())
            val result = transport.post("/station/shift-closures", body) as? TransportResult.Ok ?: return false
            if (result.code !in 200..299) return false
            val response = runCatching { json.decodeFromString(ShiftCloseResponse.serializer(), result.body) }.getOrNull() ?: return false
            when (response.outcome) {
                "accepted", "already_resolved" -> db.shiftCloseDao().delete(row.eventId)
                "conflict" -> db.shiftCloseDao().markConflict(row.eventId, response.conflictCode ?: "multiple_devices", Iso.format(clock()))
                else -> return false
            }
        }
        return true
    }

    private suspend fun reconcileConflicts() {
        var after = ""
        while (true) {
            val page = db.conflictDao().pageHashes(after, RECONCILE_PAGE)
            if (page.isEmpty()) return
            val body = json.encodeToString(ConflictStatusRequest.serializer(), ConflictStatusRequest(page))
            val result = transport.post("/station/conflicts/status", body) as? TransportResult.Ok ?: return
            if (result.code !in 200..299) return
            val reviewed = runCatching { json.decodeFromString(ConflictStatusResponse.serializer(), result.body) }
                .getOrNull()?.reviewedCodeHashes ?: return
            val gone = reviewed.filter { it in page }
            if (gone.isNotEmpty()) db.conflictDao().delete(gone)
            if (page.size < RECONCILE_PAGE) return
            after = page.last()
        }
    }

    private fun OutboxEntity.toItem(deviceId: String) = ScanItemDto(
        shiftId = shiftId,
        terminalId = deviceId,
        raw = raw,
        verdict = verdict,
        scannedAt = scannedAt,
        code = if (verdict == "ok" && codeHash != null && gtin14 != null && serial != null) ScanCodeDto(codeHash, gtin14, serial) else null,
        operatorId = operatorId,
    )

    private fun ShiftCloseEntity.toRequest() = ShiftCloseRequest(
        eventId = eventId,
        shiftId = shiftId,
        operatorId = operatorId,
        plannedQtySnapshot = plannedQtySnapshot,
        actualQty = actualQty,
        closedBoxCount = closedBoxCount,
        reasonCode = reasonCode,
        closedAt = closedAt,
    )

    companion object {
        const val BATCH_SIZE = 100
        const val RECONCILE_PAGE = 200
        const val HEARTBEAT_MS = 15_000L
        const val STUCK_AFTER_MS = 15 * 60 * 1000L
    }
}
