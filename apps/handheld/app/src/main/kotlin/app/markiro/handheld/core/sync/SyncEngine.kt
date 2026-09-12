package app.markiro.handheld.core.sync

import app.markiro.handheld.core.network.BatchConflictDto
import app.markiro.handheld.core.network.BoxClosureDto
import app.markiro.handheld.core.network.ConflictStatusRequest
import app.markiro.handheld.core.network.ConflictStatusResponse
import app.markiro.handheld.core.network.PalletClosureDto
import app.markiro.handheld.core.network.ScanCodeDto
import app.markiro.handheld.core.network.ScanItemDto
import app.markiro.handheld.core.network.ShiftCloseRequest
import app.markiro.handheld.core.network.ShiftCloseResponse
import app.markiro.handheld.core.network.SyncBatchRequest
import app.markiro.handheld.core.storage.BoxEntity
import app.markiro.handheld.core.storage.ConflictEntity
import app.markiro.handheld.core.storage.DeviceConfigDao
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaEntity
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.storage.OutboxEntity
import app.markiro.handheld.core.storage.PalletEntity
import app.markiro.handheld.core.storage.ShiftCloseEntity
import app.markiro.handheld.core.util.Iso
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
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

    /**
     * Everything this device still owes the server.
     *
     * A box closure is queued work too, and so is a product-label event, an
     * operator correction and a pallet closure. Counting only scans showed
     * «Очередь 0» while a closure sat unsent, and a queue that had stopped
     * moving would never read as stuck; every channel added since reintroduces
     * the identical gap if left out, and unlike a box, a pallet the operator
     * forgets about while this reads clear is a physically labelled unit the
     * server never learns about.
     *
     * Summed in its own flow so the state below stays a FOUR-argument combine:
     * the vararg overload infers one element type across every flow, which for
     * a mix of `Int`, `Long?` and `Long` collapses to an intersection and costs
     * an unchecked cast per value. Here every flow is `Flow<Int>`, so the
     * vararg overload is safe.
     */
    private val pending: Flow<Int> = combine(
        db.outboxDao().count(),
        db.boxDao().observeUnackedCount(),
        db.palletDao().observeUnackedCount(),
        db.productLabelEventDao().observeUnackedCount(),
        db.boxExceptionDao().observeUnackedCount(),
    ) { counts -> counts.sum() }

    val state: StateFlow<SyncState> =
        combine(pending, db.conflictDao().count(), lastSuccess, now) { owed, conflicts, last, at ->
            val since = last ?: startedAt
            SyncState(pending = owed, lastSuccessAt = last, stuck = owed > 0 && at - since > STUCK_AFTER_MS, conflicts = conflicts)
        }.stateIn(scope, SharingStarted.Eagerly, SyncState())

    fun start() {
        if (!started.compareAndSet(false, true)) return
        scope.launch {
            lastSuccess.value = meta.get(MetaStore.SYNC_LAST_SUCCESS_AT)?.toLongOrNull()
            var delayMs = heartbeatMs
            while (true) {
                withTimeoutOrNull(delayMs) { nudges.receive() }
                tick()
                delayMs = if (try { drainAll() } catch (_: app.markiro.handheld.core.storage.RecoveryBlocked) { false }) {
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

    internal suspend fun drainOnce(): Step = try { db.recovery.work { drainOnceOwned() } } catch (_: app.markiro.handheld.core.storage.RecoveryBlocked) { Step.FAILED }

    private suspend fun drainOnceOwned(): Step {
        val cfg = config.get() ?: return Step.EMPTY
        val pendingCeiling = meta.get(MetaStore.SYNC_PENDING_CEILING)?.toLongOrNull()
        val rows = if (pendingCeiling != null) db.outboxDao().headThrough(pendingCeiling, BATCH_SIZE) else db.outboxDao().head(BATCH_SIZE)
        // A batch in flight re-reads the EXACT box set it already chose. `unacked`
        // orders by (closedAt, boxId) and nothing can close earlier than a box that
        // already closed, so the first N rows are stable and a retry stays
        // byte-identical. Boxes closed since simply wait for the next batch.
        // A pinned batch carries the box set it already chose and no more. When the
        // count is missing -- a batch pinned by a build that predates it -- that set
        // is empty, NOT everything unacknowledged: growing a batch whose id is
        // already fixed is the exact way a closure gets answered `alreadyApplied`
        // and lost. Those boxes ride the next batch.
        val boxLimit = if (pendingCeiling != null) meta.get(MetaStore.SYNC_PENDING_BOX_COUNT)?.toIntOrNull() ?: 0 else MAX_BOX_CLOSURES
        val boxRows = if (boxLimit == 0) emptyList() else db.boxDao().unacked(boxLimit)
        // Product-label events follow the same pinning rule for the same reason:
        // a batch whose id is already fixed must carry the set it chose and no
        // more, or an event added since gets answered `alreadyApplied` and lost.
        val labelLimit = if (pendingCeiling != null) {
            meta.get(MetaStore.SYNC_PENDING_LABEL_COUNT)?.toIntOrNull() ?: 0
        } else {
            MAX_PRODUCT_LABEL_EVENTS
        }
        val labelRows = if (labelLimit == 0) emptyList() else db.productLabelEventDao().unacked(labelLimit)
        // Pallets (06d) follow the identical pinning rule, for the identical
        // reason: a batch whose id is already fixed must carry the pallet set
        // it chose and no more, or a pallet closing since gets answered
        // `alreadyApplied` and lost -- and unlike a scan or a box, a lost
        // pallet closure means a physically labelled pallet the server never
        // learns about.
        val palletLimit = if (pendingCeiling != null) {
            meta.get(MetaStore.SYNC_PENDING_PALLET_COUNT)?.toIntOrNull() ?: 0
        } else {
            MAX_PALLET_CLOSURES
        }
        val palletRows = if (palletLimit == 0) emptyList() else db.palletDao().unacked(palletLimit)
        // Corrections follow the same pinning rule as boxes and label events.
        val exceptionLimit = if (pendingCeiling != null) {
            meta.get(MetaStore.SYNC_PENDING_EXCEPTION_COUNT)?.toIntOrNull() ?: 0
        } else {
            MAX_EXCEPTIONS
        }
        // A correction may only ride a batch that also carries -- or has already
        // delivered -- the scans it corrects. `exceptionThrough` is this batch's
        // outbox ceiling; an empty outbox means everything before it is
        // acknowledged, so every watermark is satisfied. Without this, a device
        // that packed offline sends an undo in the first batch while the scan it
        // undoes waits for the third, and the server applies it against a row
        // that does not exist yet and drops it with no error anywhere.
        val exceptionThrough = if (rows.isEmpty()) Long.MAX_VALUE else rows.last().id
        val exceptionRows = if (exceptionLimit == 0) {
            emptyList()
        } else {
            db.boxExceptionDao().sendable(exceptionThrough, exceptionLimit)
        }
        // An empty outbox with unacknowledged boxes, pallets, events or
        // corrections is not empty.
        if (rows.isEmpty() && boxRows.isEmpty() && palletRows.isEmpty() && labelRows.isEmpty() &&
            exceptionRows.isEmpty()
        ) {
            if (pendingCeiling != null) clearPending()
            return Step.EMPTY
        }
        val maxId = rows.lastOrNull()?.id ?: pendingCeiling ?: 0L
        val boxIds = boxRows.map { it.boxId }
        val palletIds = palletRows.map { it.palletId }
        val batchId = meta.get(MetaStore.SYNC_PENDING_BATCH_ID)?.takeIf { pendingCeiling != null } ?: run {
            // EVERY channel's set is folded in -- boxes, pallets, label events
            // and corrections. Without it, a record of that channel closing
            // while this batch awaits acknowledgement would be resent under an
            // id the server has already applied, and it would vanish silently.
            //
            // Every id here is a short hashed signature (`idSignature`), not
            // the raw ids themselves, so this key's worst-case length does not
            // grow with a channel's own cap the way the station's
            // concatenated form does: two UUIDs, one bounded integer and four
            // bounded signatures stay well under the server's shared
            // `MAX_SYNC_BATCH_ID_CHARS` (200) even fully loaded, so no folding
            // digest is needed here the way the station needs one.
            val id = "${cfg.deviceId}:${db.recovery.commit { meta.installId() }}:$maxId:" +
                "${idSignature(boxIds)}:${idSignature(palletIds)}:" +
                "${idSignature(labelRows.map { it.eventId })}:" +
                idSignature(exceptionRows.map { it.id.toString() })
            db.recovery.commit {
            meta.put(MetaStore.SYNC_PENDING_CEILING, maxId.toString())
            meta.put(MetaStore.SYNC_PENDING_BOX_COUNT, boxIds.size.toString())
            meta.put(MetaStore.SYNC_PENDING_PALLET_COUNT, palletIds.size.toString())
            meta.put(MetaStore.SYNC_PENDING_LABEL_COUNT, labelRows.size.toString())
            meta.put(MetaStore.SYNC_PENDING_EXCEPTION_COUNT, exceptionRows.size.toString())
            meta.put(MetaStore.SYNC_PENDING_BATCH_ID, id)
            }
            id
        }
        val body = json.encodeToString(
            SyncBatchRequest.serializer(),
            SyncBatchRequest(
                batchId,
                rows.map { it.toItem(cfg.deviceId) },
                boxRows.map { it.toClosure(cfg.deviceId) },
                palletRows.map { it.toClosure(cfg.deviceId) },
                labelRows.map { json.parseToJsonElement(it.payloadJson) },
                exceptionRows.map { json.parseToJsonElement(it.payloadJson) },
            ),
        )
        val result = transport.post("/station/scans", body) as? TransportResult.Ok ?: return Step.FAILED
        if (result.code !in 200..299) return Step.FAILED
        val parsed = parseBatchResponse(result.body) ?: return Step.FAILED
        // A fresh batch is applied whole (`applied == items.length`) or replayed (`alreadyApplied`); anything else is not this endpoint.
        if (!parsed.alreadyApplied && parsed.applied != rows.size) return Step.FAILED
        val at = clock()
        db.recovery.commit {
            db.conflictDao().insertIgnore(
                parsed.conflicts.map { ConflictEntity(it.codeHash, it.winningTerminalId, it.winningScannedAt!!, Iso.format(at)) },
            )
            db.outboxDao().deleteThrough(maxId)
            // Unconditional, unlike the station's. Nothing in a handheld box payload
            // can change after close, because print state never leaves this device.
            // When print verification is added, the station's conditional ack has to
            // come back with it.
            if (boxIds.isNotEmpty()) db.boxDao().markAcked(boxIds, Iso.format(at))
            // Unconditional, for the identical reason the boxes above are: a
            // pallet closure's payload cannot change after this device sends
            // it, because print verification never leaves this device either.
            if (palletIds.isNotEmpty()) db.palletDao().markAcked(palletIds, Iso.format(at))
            // NOT unconditional, unlike the boxes and pallets above: the server
            // answers per event and may quarantine one. Acknowledging
            // everything sent would drop an event it never took.
            parsed.receipt?.let { receipt ->
                if (receipt.accepted.isNotEmpty()) db.productLabelEventDao().markAcked(receipt.accepted, Iso.format(at))
                for ((eventId, code) in receipt.quarantined) {
                    db.productLabelEventDao().markQuarantined(eventId, code, Iso.format(at))
                }
            }
            // Unconditional, like the boxes above: this endpoint answers no
            // per-exception receipt, and the server records every fact it
            // accepts -- including one that matched nothing.
            if (exceptionRows.isNotEmpty()) {
                db.boxExceptionDao().markAcked(exceptionRows.map { it.id }, Iso.format(at))
                db.boxExceptionDao().purgeAcked()
            }
            db.metaDao().remove(MetaStore.SYNC_PENDING_BATCH_ID)
            db.metaDao().remove(MetaStore.SYNC_PENDING_CEILING)
            db.metaDao().remove(MetaStore.SYNC_PENDING_BOX_COUNT)
            db.metaDao().remove(MetaStore.SYNC_PENDING_PALLET_COUNT)
            db.metaDao().remove(MetaStore.SYNC_PENDING_LABEL_COUNT)
            db.metaDao().remove(MetaStore.SYNC_PENDING_EXCEPTION_COUNT)
            parsed.denied?.let { db.metaDao().put(MetaEntity(MetaStore.SYNC_LAST_DENIED, it)) }
            db.metaDao().put(MetaEntity(MetaStore.SYNC_LAST_SUCCESS_AT, at.toString()))
            // A completed job the server has fully answered is dead weight, and
            // its bytes are the bulk of it. Waiting for shift close means a long
            // shift carries every label it ever printed.
            db.productLabelJobDao().purgeSettledEverywhere()
        }
        lastSuccess.value = at
        return Step.SENT
    }

    private suspend fun clearPending() = db.recovery.commit { clearPendingOwned() }

    private suspend fun clearPendingOwned() {
        meta.remove(MetaStore.SYNC_PENDING_BATCH_ID)
        meta.remove(MetaStore.SYNC_PENDING_CEILING)
        meta.remove(MetaStore.SYNC_PENDING_BOX_COUNT)
        meta.remove(MetaStore.SYNC_PENDING_PALLET_COUNT)
        meta.remove(MetaStore.SYNC_PENDING_LABEL_COUNT)
        meta.remove(MetaStore.SYNC_PENDING_EXCEPTION_COUNT)
    }

    /**
     * Short and stable: one set always signs the same, a different set never
     * does.
     *
     * SHA-256 rather than `String.hashCode`, which is 32 bits: a collision there
     * means two different sets share a batch id, the server answers
     * `alreadyApplied` to the second, and those records are lost without a trace.
     * Each id is length-delimited so no two lists can concatenate alike.
     */
    private fun idSignature(ids: List<String>): String {
        if (ids.isEmpty()) return "0"
        val joined = ids.joinToString("") { "${it.length}:$it" }
        val digest = java.security.MessageDigest.getInstance("SHA-256")
            .digest(joined.toByteArray(Charsets.UTF_8))
        return "${ids.size}-" + digest.take(8).joinToString("") { "%02x".format(it) }
    }

    private fun BoxEntity.toClosure(deviceId: String) = BoxClosureDto(
        boxId = boxId,
        shiftId = shiftId,
        terminalId = deviceId,
        sscc = checkNotNull(sscc) { "box $boxId is queued without an SSCC" },
        closedAt = checkNotNull(closedAt) { "box $boxId is queued while still open" },
        operatorId = operatorId,
        devicePalletId = palletId,
    )

    private fun PalletEntity.toClosure(deviceId: String) = PalletClosureDto(
        palletId = palletId,
        shiftId = shiftId,
        terminalId = deviceId,
        sscc = checkNotNull(sscc) { "pallet $palletId is queued without an SSCC" },
        closedAt = checkNotNull(closedAt) { "pallet $palletId is queued while still open" },
        operatorId = operatorId,
    )

    private class BatchResponse(
        val applied: Int,
        val alreadyApplied: Boolean,
        val conflicts: List<BatchConflictDto>,
        val denied: String?,
        val receipt: ProductLabelReceipt?,
    )

    /** Per-event outcomes. Absent when the batch carried no events, or on an older server. */
    private class ProductLabelReceipt(val accepted: List<String>, val quarantined: List<Pair<String, String>>)

    /** The station's shape guard: a captive portal answering 200 must never ack a batch. */
    private fun parseBatchResponse(body: String): BatchResponse? {
        val obj = runCatching { json.parseToJsonElement(body).jsonObject }.getOrNull() ?: return null
        val applied = obj["applied"]?.jsonPrimitive?.takeIf { !it.isString }?.intOrNull ?: return null
        val alreadyApplied = obj["alreadyApplied"]?.jsonPrimitive?.takeIf { !it.isString }?.booleanOrNull ?: return null
        val conflicts = obj["conflicts"]?.takeIf { it !is JsonNull }?.jsonArray.orEmpty()
            .mapNotNull { runCatching { json.decodeFromJsonElement(BatchConflictDto.serializer(), it) }.getOrNull() }
            .filter { it.winningScannedAt != null && Iso.parse(it.winningScannedAt) != null }
        val denied = obj["denied"]?.takeIf { it !is JsonNull }?.toString()
        return BatchResponse(applied, alreadyApplied, conflicts, denied, parseReceipt(obj))
    }

    /**
     * Every access is a safe cast.
     *
     * `jsonObject`, `jsonArray` and `jsonPrimitive` THROW on the wrong kind, and
     * nothing above this catches: the throw would leave `drainOnce` and unwind
     * the sync loop itself, which never restarts. A captive portal answering
     * 200 with a differently shaped body is exactly the case the rest of this
     * parser is already shaped against.
     */
    private fun parseReceipt(obj: kotlinx.serialization.json.JsonObject): ProductLabelReceipt? {
        val receipt = obj["productLabelReceipt"] as? kotlinx.serialization.json.JsonObject ?: return null
        val accepted = (receipt["acceptedEventIds"] as? kotlinx.serialization.json.JsonArray).orEmpty()
            .mapNotNull { (it as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { p -> p.isString }?.content }
        val quarantined = (receipt["quarantined"] as? kotlinx.serialization.json.JsonArray).orEmpty()
            .mapNotNull { record ->
                val o = record as? kotlinx.serialization.json.JsonObject ?: return@mapNotNull null
                val id = (o["eventId"] as? kotlinx.serialization.json.JsonPrimitive)
                    ?.takeIf { it.isString }?.content ?: return@mapNotNull null
                val code = (o["code"] as? kotlinx.serialization.json.JsonPrimitive)
                    ?.takeIf { it.isString }?.content ?: return@mapNotNull null
                id to code
            }
        return ProductLabelReceipt(accepted, quarantined)
    }

    private suspend fun drainCloses(): Boolean = try { db.recovery.work { drainClosesOwned() } } catch (_: app.markiro.handheld.core.storage.RecoveryBlocked) { false }

    private suspend fun drainClosesOwned(): Boolean {
        for (row in db.shiftCloseDao().pending()) {
            val body = json.encodeToString(ShiftCloseRequest.serializer(), row.toRequest())
            val result = transport.post("/station/shift-closures", body) as? TransportResult.Ok ?: return false
            if (result.code !in 200..299) return false
            val response = runCatching { json.decodeFromString(ShiftCloseResponse.serializer(), result.body) }.getOrNull() ?: return false
            when (response.outcome) {
                // The row stays as the idempotency marker: a second close of the same shift returns it instead of a new event.
                "accepted", "already_resolved" -> db.recovery.commit { db.shiftCloseDao().markAccepted(row.eventId, Iso.format(clock())) }
                "conflict" -> db.recovery.commit { db.shiftCloseDao().markConflict(row.eventId, response.conflictCode ?: "multiple_devices", Iso.format(clock())) }
                else -> return false
            }
        }
        return true
    }

    private suspend fun reconcileConflicts() = try { db.recovery.work { reconcileConflictsOwned() } } catch (_: app.markiro.handheld.core.storage.RecoveryBlocked) { Unit }

    private suspend fun reconcileConflictsOwned() {
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
            if (gone.isNotEmpty()) db.recovery.commit { db.conflictDao().delete(gone) }
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
        boxId = boxId,
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

        /**
         * The server's own `MAX_BOX_CLOSURES_PER_SYNC_BATCH` (`@markiro/domain`,
         * `packages/domain/src/sync/limits.ts`). See `MAX_PALLET_CLOSURES` below
         * for why this is a hand-copied literal and how it is kept from
         * drifting: `SyncLimitsFixturesTest` asserts this value against
         * `sync-limits-fixtures.json`, generated from the shared constant by
         * `pnpm --filter @markiro/domain fixtures:sync-limits`.
         */
        const val MAX_BOX_CLOSURES = 50

        /**
         * The server's own `MAX_PALLET_CLOSURES_PER_SYNC_BATCH` (`@markiro/domain`,
         * `packages/domain/src/sync/limits.ts`).
         *
         * Hand-copied for the exact reason `MAX_BOX_CLOSURES` above already is,
         * and it carries the identical risk: if this number and the shared
         * constant ever disagree, a device that reads more closed-unacked
         * pallets than the API accepts has its whole batch rejected every
         * retry, wedging pallets, boxes AND item delivery on that device
         * forever (the drain never drops data). Kotlin cannot import a
         * TypeScript constant, so this is a second literal, not a shared one --
         * flagged rather than silently added a second time. Kept from drifting
         * by `SyncLimitsFixturesTest`, which asserts this value (and
         * `MAX_BOX_CLOSURES`, `MAX_SYNC_BATCH_ID_CHARS`) against
         * `sync-limits-fixtures.json` -- generated from `limits.ts` by
         * `pnpm --filter @markiro/domain fixtures:sync-limits`, the same way
         * `fixtures:km`/`fixtures:inventory` already generate checked Android
         * test resources from TypeScript. `test/sync-limits-fixtures.test.ts`
         * fails if that JSON is regenerated but not committed.
         */
        const val MAX_PALLET_CLOSURES = 20

        /** The server's own `MAX_PRODUCT_LABEL_EVENTS`. */
        const val MAX_PRODUCT_LABEL_EVENTS = 100

        /**
         * The server's own `MAX_SYNC_BATCH_ID_CHARS` (`@markiro/domain`,
         * `packages/domain/src/sync/limits.ts`) -- the bound the batch-id
         * construction comment in `drainOnce` argues this device's id stays
         * under, fully loaded, by folding each channel into a short signature
         * rather than concatenating raw ids. Hand-copied for the same reason
         * and kept from drifting the same way `MAX_BOX_CLOSURES` and
         * `MAX_PALLET_CLOSURES` are: see `SyncLimitsFixturesTest`.
         */
        const val MAX_SYNC_BATCH_ID_CHARS = 200

        /** The server's own cap on `exceptions[]`. */
        const val MAX_EXCEPTIONS = 200

        const val RECONCILE_PAGE = 200
        const val HEARTBEAT_MS = 15_000L
        const val STUCK_AFTER_MS = 15 * 60 * 1000L
    }
}
