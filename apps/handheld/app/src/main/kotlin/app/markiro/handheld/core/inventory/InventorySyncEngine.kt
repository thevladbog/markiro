package app.markiro.handheld.core.inventory

import androidx.room.withTransaction
import app.markiro.handheld.core.network.EventBatchResponseDto
import app.markiro.handheld.core.network.ProgressPageDto
import app.markiro.handheld.core.storage.DeviceConfigDao
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.InventoryResultEntity
import app.markiro.handheld.core.storage.InventoryTaskEntity
import app.markiro.handheld.core.storage.InventoryTerminalStateEntity
import app.markiro.handheld.core.storage.MetaEntity
import app.markiro.handheld.core.storage.MetaStore
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
import java.net.URLEncoder
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

data class InventorySyncState(
    val pending: Int = 0,
    val lastSuccessAt: Long? = null,
    val stuck: Boolean = false,
    /** Set when the server quarantined events because the cabinet closed the task. */
    val closedInventoryId: String? = null,
)

/**
 * Port of the station's inventory sync engine without its credential leases and receipts: one
 * drain at a time for the active task, a batch pinned in `meta` before the request and re-sent
 * byte for byte, the response guarded like `parseInventoryEventBatchResponse`, then the progress
 * feed of other terminals applied by cursor.
 */
class InventorySyncEngine(
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
    private val closed = MutableStateFlow<String?>(null)
    private val now = MutableStateFlow(clock())

    val state: StateFlow<InventorySyncState> =
        combine(db.inventoryOutboxDao().observeTotal(), lastSuccess, closed, now) { pending, last, closedId, at ->
            val since = last ?: startedAt
            InventorySyncState(pending, last, stuck = pending > 0 && at - since > STUCK_AFTER_MS, closedInventoryId = closedId)
        }.stateIn(scope, SharingStarted.Eagerly, InventorySyncState())

    fun start() {
        if (!started.compareAndSet(false, true)) return
        scope.launch {
            lastSuccess.value = meta.get(MetaStore.INVENTORY_LAST_SUCCESS_AT)?.toLongOrNull()
            var delayMs = heartbeatMs
            while (true) {
                withTimeoutOrNull(delayMs) { nudges.receive() }
                now.value = clock()
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

    /** Batches for the active task, then its progress feed. False on the first failure. */
    suspend fun drainAll(): Boolean = drainMutex.withLock {
        val task = activeTask() ?: return true
        while (true) {
            when (drainOnce(task)) {
                Step.SENT -> continue
                Step.EMPTY -> break
                Step.FAILED -> return false
            }
        }
        pollProgress(task)
    }

    private suspend fun activeTask(): InventoryTaskEntity? =
        config.get()?.activeInventoryId?.let { db.inventoryTaskDao().get(it) }?.takeIf { it.state == "active" }

    internal enum class Step { SENT, EMPTY, FAILED }

    private class Pin(val batchId: String, val payloadDigest: String, val ceilingId: Long, val request: String)

    private fun pinJson(pin: Pin) = CanonicalJson.obj(
        "batchId" to CanonicalJson.str(pin.batchId),
        "payloadDigest" to CanonicalJson.str(pin.payloadDigest),
        "ceilingId" to CanonicalJson.num(pin.ceilingId),
        "request" to CanonicalJson.str(pin.request),
    )

    private fun parsePin(text: String): Pin? = runCatching {
        val o = json.parseToJsonElement(text).jsonObject
        Pin(
            o.getValue("batchId").jsonPrimitive.content,
            o.getValue("payloadDigest").jsonPrimitive.content,
            o.getValue("ceilingId").jsonPrimitive.content.toLong(),
            o.getValue("request").jsonPrimitive.content,
        )
    }.getOrNull()

    internal suspend fun drainOnce(task: InventoryTaskEntity): Step {
        val id = task.inventoryId
        val pinned = meta.get(MetaStore.inventoryPin(id))?.let(::parsePin)
        val rows = if (pinned != null) db.inventoryOutboxDao().headThrough(id, pinned.ceilingId, BATCH_SIZE) else db.inventoryOutboxDao().head(id, BATCH_SIZE)
        if (rows.isEmpty()) {
            if (pinned != null) meta.remove(MetaStore.inventoryPin(id))
            return Step.EMPTY
        }
        val pin = pinned ?: run {
            val payload = InventoryBatchCodec.payloadJson(
                task.snapshotId, rows.last().deviceSequence, db.inventoryOutboxDao().countAfter(id, rows.last().id), rows.map { it.payloadJson },
            )
            val digest = InventoryBatchCodec.digest(payload)
            val batchId = UUID.randomUUID().toString()
            Pin(batchId, digest, rows.last().id, InventoryBatchCodec.requestJson(batchId, digest, payload)).also {
                meta.put(MetaStore.inventoryPin(id), pinJson(it))
            }
        }
        val result = transport.post("/station/inventories/$id/event-batches", pin.request) as? TransportResult.Ok ?: return Step.FAILED
        if (result.code !in 200..299) return Step.FAILED
        val response = runCatching { json.decodeFromString(EventBatchResponseDto.serializer(), result.body) }.getOrNull() ?: return Step.FAILED
        if (!acknowledges(response, task, pin, rows.map { it.eventId })) return Step.FAILED
        val at = clock()
        var quarantined = false
        db.withTransaction {
            for (outcome in response.outcomes) {
                db.inventoryEventDao().setServerStatus(outcome.eventId, outcome.status)
                when (outcome.status) {
                    "duplicate" -> outcome.claims.filter { it.status == "duplicate" }.forEach { claim ->
                        val existing = db.inventoryResultDao().get(id, claim.codeHash)
                        db.inventoryResultDao().upsert(
                            InventoryResultEntity(
                                inventoryId = id, snapshotId = task.snapshotId, codeHash = claim.codeHash, firstAcceptedEventId = claim.winner.eventId,
                                winningDeviceId = claim.winner.deviceId, winningScannedAt = claim.winner.scannedAt,
                                observedProductionDate = existing?.observedProductionDate, classification = existing?.classification ?: "expected",
                                source = "server", updatedAt = Iso.format(at),
                            ),
                        )
                    }
                    "quarantined" -> quarantined = true
                }
            }
            db.inventoryOutboxDao().deleteIds(rows.map { it.id })
            db.metaDao().remove(MetaStore.inventoryPin(id))
            db.metaDao().put(MetaEntity(MetaStore.INVENTORY_LAST_SUCCESS_AT, at.toString()))
            if (quarantined) db.inventoryTaskDao().setState(id, "closed")
        }
        lastSuccess.value = at
        if (quarantined) closed.value = id
        return Step.SENT
    }

    /** Shape guard: the answer must be for this batch, one outcome per event, counts consistent. */
    private fun acknowledges(r: EventBatchResponseDto, task: InventoryTaskEntity, pin: Pin, eventIds: List<String>): Boolean {
        if (r.inventoryId != task.inventoryId || r.snapshotId != task.snapshotId || r.snapshotRevision != 1 ||
            r.batchId != pin.batchId || r.payloadDigest != pin.payloadDigest
        ) {
            return false
        }
        if (r.outcomes.size != eventIds.size || r.outcomes.map { it.eventId }.toSet() != eventIds.toSet()) return false
        return r.outcomes.all { o ->
            o.status in OUTCOMES && o.claimedCount == o.claims.count { it.status == "claimed" } && o.conflictCount == o.claims.count { it.status == "duplicate" }
        }
    }

    internal suspend fun pollProgress(task: InventoryTaskEntity): Boolean {
        val id = task.inventoryId
        var terminal = db.inventoryTerminalStateDao().get(id)
        if (terminal == null) {
            terminal = InventoryTerminalStateEntity(id, task.snapshotId, null, task.productionDateFrom, 1, null, 0, Iso.format(clock()))
            db.inventoryTerminalStateDao().upsert(terminal)
        }
        var cursor = terminal.progressCursor
        var revision = terminal.progressResultRevision
        while (true) {
            val path = if (cursor == null) {
                "/station/inventories/$id/progress?limit=$PROGRESS_PAGE"
            } else {
                "/station/inventories/$id/progress?cursor=${URLEncoder.encode(cursor, "UTF-8")}&limit=$PROGRESS_PAGE"
            }
            val result = transport.get(path) as? TransportResult.Ok ?: return false
            if (result.code !in 200..299) return false
            val page = runCatching { json.decodeFromString(ProgressPageDto.serializer(), result.body) }.getOrNull() ?: return false
            if (page.inventoryId != id || page.snapshotId != task.snapshotId || page.cursor != cursor || page.resultRevision < revision ||
                !ordered(page, cursor)
            ) {
                return false
            }
            val next = page.nextCursor ?: cursor
            db.withTransaction {
                for (item in page.items) {
                    if (item.kind != "claim" && item.kind != "correction") continue
                    val hash = item.codeHash ?: continue
                    val winner = item.winner
                    if (winner == null || item.classification == "voided") {
                        db.inventoryResultDao().delete(id, hash)
                    } else {
                        db.inventoryResultDao().upsert(
                            InventoryResultEntity(
                                inventoryId = id, snapshotId = task.snapshotId, codeHash = hash, firstAcceptedEventId = winner.eventId,
                                winningDeviceId = winner.deviceId, winningScannedAt = winner.scannedAt, observedProductionDate = item.observedProductionDate,
                                classification = item.classification ?: "expected", source = "server", updatedAt = item.correctedAt,
                            ),
                        )
                    }
                }
                db.inventoryTerminalStateDao().setProgress(id, next, page.resultRevision)
            }
            revision = page.resultRevision
            if (page.nextCursor == null) return true
            cursor = page.nextCursor
        }
    }

    private fun ordered(page: ProgressPageDto, cursor: String?): Boolean {
        var prevRevision = cursor?.substringBefore(':')?.toLongOrNull() ?: -1L
        var prevId = cursor?.substringAfter(':') ?: ""
        for (item in page.items) {
            if (item.revision > page.resultRevision) return false
            if (item.revision < prevRevision || (item.revision == prevRevision && item.id <= prevId)) return false
            prevRevision = item.revision
            prevId = item.id
        }
        return true
    }

    companion object {
        const val BATCH_SIZE = 100
        const val PROGRESS_PAGE = 200
        const val HEARTBEAT_MS = 15_000L
        const val STUCK_AFTER_MS = 5 * 60 * 1000L
        private val OUTCOMES = setOf("applied", "replay", "duplicate", "rejected", "quarantined")
    }
}
