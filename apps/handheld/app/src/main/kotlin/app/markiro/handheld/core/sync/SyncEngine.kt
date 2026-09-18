package app.markiro.handheld.core.sync

import app.markiro.handheld.core.grants.GrantEvidenceTransport

import app.markiro.handheld.core.storage.applyValidationReceipt
import app.markiro.handheld.core.network.ValidationOccurrenceIdentity
import app.markiro.handheld.core.network.ValidationOccurrenceReceipt
import app.markiro.handheld.core.network.ValidationOccurrenceStatusRequest
import app.markiro.handheld.core.network.ValidationOccurrenceStatusResponse
import app.markiro.handheld.core.network.VALIDATION_REPROCESSING_PROTOCOL
import app.markiro.handheld.core.network.BatchConflictDto
import app.markiro.handheld.core.network.BoxClosureDto
import app.markiro.handheld.core.network.ConflictStatusRequest
import app.markiro.handheld.core.network.ConflictStatusResponse
import app.markiro.handheld.core.network.PalletClosureDto
import app.markiro.handheld.core.network.PalletMembershipDto
import app.markiro.handheld.core.network.PalletMembershipRemovalDto
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
import kotlinx.coroutines.Job
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
import kotlinx.serialization.builtins.ListSerializer
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
     * A box closure is queued work too, and so is a product-label event, a
     * pallet closure, and an operator correction against either a box or a
     * pallet. Counting only scans showed
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
        db.palletExceptionDao().observeUnackedCount(),
        db.validationDao().pendingCount(),
        // A box scanned onto a warehouse pallet is queued work in exactly the
        // same sense: until the server answers it, the pallet this device shows
        // as holding that box is a claim only this device knows about.
        db.palletMembershipDao().observePendingCount(),
        // And a box taken back off that pallet is owed in exactly the same
        // sense, for the mirror-image reason: until the server answers, the
        // pallet this device shows as no longer holding that box is a claim
        // only this device knows about.
        db.palletMembershipRemovalDao().observePendingCount(),
    ) { counts -> counts.sum() }

    val state: StateFlow<SyncState> =
        combine(pending, db.conflictDao().count(), lastSuccess, now) { owed, conflicts, last, at ->
            val since = last ?: startedAt
            SyncState(pending = owed, lastSuccessAt = last, stuck = owed > 0 && at - since > STUCK_AFTER_MS, conflicts = conflicts)
        }.stateIn(scope, SharingStarted.Eagerly, SyncState())

    /**
     * Materialisation of a pin written by a build that predates
     * `MetaStore.SYNC_PENDING_MEMBERSHIP_SNAPSHOT`, run once as soon as the
     * engine exists -- which on a device is app start, before an operator can
     * reach «Убрать с паллеты» and delete a `sent` row the pin names. Joinable
     * so a test can order itself against it; the drain does not wait on it,
     * because the retry path materialises the same pin itself if this has not
     * got there yet.
     */
    internal val legacyPinMaterialised: Job = scope.launch {
        try {
            materialiseLegacyPin()
        } catch (_: app.markiro.handheld.core.storage.RecoveryBlocked) {
            // Sealed or superseded device data: nothing is owed and nothing is sent.
        }
    }

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
        reconcileValidationOccurrences()
        reconcileConflicts()
        true
    }

    internal enum class Step { SENT, EMPTY, FAILED }

    internal suspend fun drainOnce(): Step = try { db.recovery.work { drainOnceOwned() } } catch (_: app.markiro.handheld.core.storage.RecoveryBlocked) { Step.FAILED }

    private suspend fun drainOnceOwned(): Step {
        val cfg = config.get() ?: return Step.EMPTY
        val pendingCeiling = meta.get(MetaStore.SYNC_PENDING_CEILING)?.toLongOrNull()
        var rows = if (pendingCeiling != null) db.outboxDao().headThrough(pendingCeiling, BATCH_SIZE) else db.outboxDao().head(BATCH_SIZE)
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
        var boxRows = if (boxLimit == 0) emptyList() else db.boxDao().unacked(boxLimit)
        // Product-label events follow the same pinning rule for the same reason:
        // a batch whose id is already fixed must carry the set it chose and no
        // more, or an event added since gets answered `alreadyApplied` and lost.
        val labelLimit = if (pendingCeiling != null) {
            meta.get(MetaStore.SYNC_PENDING_LABEL_COUNT)?.toIntOrNull() ?: 0
        } else {
            MAX_PRODUCT_LABEL_EVENTS
        }
        var labelRows = if (labelLimit == 0) emptyList() else db.productLabelEventDao().unacked(labelLimit)
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
        var palletRows = if (palletLimit == 0) emptyList() else db.palletDao().unacked(palletLimit)
        // Memberships (warehouse pallets, room 18) pin like every other channel,
        // for the identical reason: a batch whose id is already fixed carries the
        // set it chose and no more. The rows a batch already chose are the `sent`
        // ones -- marked under the very commit that writes the pin, so a crash
        // between the two cannot leave a pinned batch whose rows still read
        // `pending` and would be picked up twice. A missing count is zero, never
        // "everything pending".
        //
        // Deliberately NOT part of grant negotiation below: a membership is not
        // grant evidence, carries no link, and rides whichever batch is
        // assembled.
        val membershipLimit = if (pendingCeiling != null) {
            meta.get(MetaStore.SYNC_PENDING_MEMBERSHIP_COUNT)?.toIntOrNull() ?: 0
        } else {
            MAX_PALLET_MEMBERSHIPS
        }
        // A pin from a build that predates the snapshot gets its bytes now, if
        // the construction-time pass has not already done it. `false` means the
        // pin was damaged and has just been abandoned, so this drain restarts
        // against clean meta rather than continuing with a ceiling and a batch
        // id that no longer exist.
        if (pendingCeiling != null && membershipLimit > 0 &&
            meta.get(MetaStore.SYNC_PENDING_MEMBERSHIP_SNAPSHOT) == null &&
            !materialiseLegacyPin()
        ) {
            return Step.SENT
        }
        // The DTOs a batch in flight actually pinned, read back verbatim.
        //
        // Unlike every other channel, this one's rows can VANISH under a batch
        // in flight: `WarehousePallets.remove` deletes a membership row at any
        // status, `sent` included. A retry that rebuilt its body from a live
        // `sent()` read would then resend the identical `batchId` with fewer
        // memberships, the server would answer `station_batch_mismatch` (409),
        // and the drain would fail forever -- wedging every channel on this
        // terminal. The snapshot is written under the same commit as the pin,
        // so a local delete cannot change the bytes a pinned batch resends.
        //
        // Absent only for a batch pinned by a build that predates the snapshot;
        // that one falls back to the live `sent()` read below. A pin whose COUNT
        // is zero carries no memberships whatever the snapshot says: the two are
        // written under one commit, so they disagree only when the pin is
        // damaged, and the count is the key every channel here is judged by.
        val pinnedMemberships: List<PalletMembershipDto>? = if (pendingCeiling == null || membershipLimit == 0) {
            null
        } else {
            meta.get(MetaStore.SYNC_PENDING_MEMBERSHIP_SNAPSHOT)
                ?.let { json.decodeFromString(ListSerializer(PalletMembershipDto.serializer()), it) }
        }
        // This read is provisional for the fresh-batch case (`pendingCeiling
        // == null`): it only decides, below, whether this drain has any work
        // at all. The set that is actually signed into the batch id and
        // marked `sent` is re-read atomically with that mark, inside the pin
        // commit further down -- otherwise a `deletePending` racing this
        // drain between this read and that mark could leave the batch naming
        // a row that already vanished. For a retry (`pendingCeiling != null`)
        // this is only the fallback for a snapshot-less pin: the snapshot
        // above is authoritative when present.
        var membershipRows = when {
            membershipLimit == 0 -> emptyList()
            pendingCeiling != null -> db.palletMembershipDao().sent(membershipLimit)
            else -> db.palletMembershipDao().pending(membershipLimit)
        }
        // Removals (room 19) are the exact mirror of the memberships above and
        // follow every one of their rules: their own pinned count, `sent` rows
        // for a retry and `pending` for a fresh batch (re-read inside the pin
        // commit below for the same race), no part of grant negotiation.
        val removalLimit = if (pendingCeiling != null) {
            meta.get(MetaStore.SYNC_PENDING_MEMBERSHIP_REMOVAL_COUNT)?.toIntOrNull() ?: 0
        } else {
            MAX_PALLET_MEMBERSHIP_REMOVALS
        }
        var removalRows = when {
            removalLimit == 0 -> emptyList()
            pendingCeiling != null -> db.palletMembershipRemovalDao().sent(removalLimit)
            else -> db.palletMembershipRemovalDao().pending(removalLimit)
        }
        val evidence = GrantEvidenceTransport(db)
        // ACK retains the initial event for the live job. Recovery attempts inherit its
        // protocol, not current grant availability; retention removes the job and events together.
        val labelNegotiation = mutableMapOf<String, Boolean>()
        for (row in labelRows) {
            if (row.jobId !in labelNegotiation) {
                val initial = db.productLabelEventDao().bySequence(row.jobId).firstOrNull { it.sequence == 1 && isInitialLabelPreparation(it) }
                labelNegotiation[row.jobId] = initial?.let { evidence.negotiated(it.eventId) } ?: false
            }
        }
        val negotiatedBatch = if (pendingCeiling != null) meta.get(GrantEvidenceTransport.SYNC_PROTOCOL) == "true" else {
            // Split only new batches. A legacy durable pin is never retroactively regrouped.
            val first = rows.firstOrNull { it.verdict == "ok" }?.let { "shift.scan:${it.id}" }
                ?: boxRows.firstOrNull()?.let { "shift.box.close:${it.boxId}" }
                ?: palletRows.firstOrNull()?.let { "shift.pallet.close:${it.palletId}" }
            first?.let { evidence.negotiated(it) } ?: labelRows.firstOrNull()?.let { labelNegotiation[it.jobId] } ?: false
        }
        if (pendingCeiling == null) {
            rows = rows.takeWhile { it.verdict != "ok" || evidence.negotiated("shift.scan:${it.id}") == negotiatedBatch }
            boxRows = boxRows.takeWhile { evidence.negotiated("shift.box.close:${it.boxId}") == negotiatedBatch }
            palletRows = palletRows.takeWhile { evidence.negotiated("shift.pallet.close:${it.palletId}") == negotiatedBatch }
            labelRows = labelRows.takeWhile { labelNegotiation[it.jobId] == negotiatedBatch }
        }
        val palletIds = palletRows.map { it.palletId }
        // Pallet corrections pin like everything else...
        val palletExceptionLimit = if (pendingCeiling != null) {
            meta.get(MetaStore.SYNC_PENDING_PALLET_EXCEPTION_COUNT)?.toIntOrNull() ?: 0
        } else {
            MAX_PALLET_EXCEPTIONS
        }
        // ...but their ordering rule is against the PALLET CLOSURE channel, not
        // the outbox. `applyPalletExceptions` (`pallet-ingest.ts`) resolves a
        // fact through the pallets this batch carries plus the ones the server
        // already holds, and `continue`s past one it cannot resolve -- no
        // error, no receipt, nothing. So a fact sent before its pallet's
        // closure is not retried or quarantined: it is dropped in silence while
        // this device marks it acknowledged. `palletIds` is exactly the set
        // this batch carries, so a fact naming one of them, or a pallet already
        // acknowledged, is safe; anything else waits. This is not a corner
        // case -- the pallet channel is capped at MAX_PALLET_CLOSURES, so a
        // device holding more unacknowledged closures than that defers the ones
        // past the cap to a later batch while their reprints are already
        // queued.
        val palletExceptionRows = if (palletExceptionLimit == 0) {
            emptyList()
        } else {
            db.palletExceptionDao().sendable(palletIds, palletExceptionLimit)
        }
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
        // An empty outbox with unacknowledged boxes, pallets, events,
        // memberships or corrections of either kind is not empty.
        if (rows.isEmpty() && boxRows.isEmpty() && palletRows.isEmpty() && labelRows.isEmpty() &&
            exceptionRows.isEmpty() && palletExceptionRows.isEmpty() &&
            (pinnedMemberships?.isEmpty() ?: membershipRows.isEmpty()) &&
            removalRows.isEmpty()
        ) {
            if (pendingCeiling != null) clearPending()
            return Step.EMPTY
        }
        val maxId = rows.lastOrNull()?.id ?: pendingCeiling ?: 0L
        val boxIds = boxRows.map { it.boxId }
        val batchId = meta.get(MetaStore.SYNC_PENDING_BATCH_ID)?.takeIf { pendingCeiling != null } ?: run {
            // EVERY channel's set is folded in -- boxes, pallets, label events,
            // memberships, membership removals and both kinds of correction.
            // Without it, a record of
            // that channel closing while this batch awaits acknowledgement would
            // be resent under an id the server has already applied, and it would
            // vanish silently.
            //
            // Every id here is a short hashed signature (`idSignature`), not
            // the raw ids themselves, so this key's worst-case length does not
            // grow with a channel's own cap the way the station's concatenated
            // form does. It is no longer comfortably clear of the server's
            // shared `MAX_SYNC_BATCH_ID_CHARS` (200) though: two UUIDs, a
            // Long-valued ceiling and now SEVEN bounded signatures pass it
            // outright when fully loaded, so `boundedBatchId` folds the
            // over-long key the way the station's own does -- an over-long key
            // is a 400 on every retry forever, wedging every channel on the
            // device, because the drain never drops data.
            val installId = db.recovery.commit { meta.installId() }
            db.recovery.commit {
            // Re-read fresh, atomically with `markSent` below, for a truly
            // new batch. This is the set that is actually signed into the id
            // and marked `sent` -- the earlier read above was only a peek to
            // decide whether the drain was empty. Without this re-read, a
            // `deletePending` racing this drain between the peek and the mark
            // could leave the batch naming a row that already vanished: the
            // id would carry its signature, the mark would silently no-op
            // for it (its `WHERE status = 'pending'` no longer matches
            // anything), and a retry would resend an id whose membership set
            // was never actually pinned in full.
            if (pendingCeiling == null) {
                membershipRows = if (membershipLimit == 0) emptyList() else db.palletMembershipDao().pending(membershipLimit)
                removalRows = if (removalLimit == 0) emptyList() else db.palletMembershipRemovalDao().pending(removalLimit)
            }
            val id = boundedBatchId(
                "${cfg.deviceId}:$installId:$maxId:" +
                    "${idSignature(boxIds)}:${idSignature(palletIds)}:" +
                    "${idSignature(labelRows.map { it.eventId })}:" +
                    "${idSignature(exceptionRows.map { it.id.toString() })}:" +
                    "${idSignature(palletExceptionRows.map { it.id.toString() })}:" +
                    "${idSignature(membershipRows.map { "${it.palletId}|${it.sscc}" })}:" +
                    idSignature(removalRows.map { it.id.toString() }),
            )
            meta.put(MetaStore.SYNC_PENDING_CEILING, maxId.toString())
            meta.put(MetaStore.SYNC_PENDING_BOX_COUNT, boxIds.size.toString())
            meta.put(MetaStore.SYNC_PENDING_PALLET_COUNT, palletIds.size.toString())
            meta.put(MetaStore.SYNC_PENDING_LABEL_COUNT, labelRows.size.toString())
            meta.put(MetaStore.SYNC_PENDING_EXCEPTION_COUNT, exceptionRows.size.toString())
            meta.put(MetaStore.SYNC_PENDING_PALLET_EXCEPTION_COUNT, palletExceptionRows.size.toString())
            meta.put(MetaStore.SYNC_PENDING_MEMBERSHIP_COUNT, membershipRows.size.toString())
            meta.put(MetaStore.SYNC_PENDING_MEMBERSHIP_REMOVAL_COUNT, removalRows.size.toString())
            meta.put(MetaStore.SYNC_PENDING_BATCH_ID, id)
            meta.put(GrantEvidenceTransport.SYNC_PROTOCOL, negotiatedBatch.toString())
            // Under the SAME commit as the pin above: the pinned count and the
            // rows it names have to become true together, or a crash between
            // them leaves a batch in flight whose rows still read `pending` and
            // a later batch sends them a second time under a different id.
            for (m in membershipRows) db.palletMembershipDao().markSent(m.palletId, m.sscc)
            for (r in removalRows) db.palletMembershipRemovalDao().markSent(r.id)
            // ...and under that same commit, the exact DTO list this batch will
            // send. A membership row can be DELETED locally while its batch is
            // in flight (`WarehousePallets.remove` deletes at any status), so
            // the pinned count and the `sent` marks are not enough to rebuild
            // an identical body on a retry -- only these bytes are.
            meta.put(
                MetaStore.SYNC_PENDING_MEMBERSHIP_SNAPSHOT,
                json.encodeToString(
                    ListSerializer(PalletMembershipDto.serializer()),
                    membershipRows.map { PalletMembershipDto(it.palletId, it.sscc, it.addedAt, it.operatorId) },
                ),
            )
            id
            }
        }
        // What this batch sends and what its answer is matched against, in this
        // order: the snapshot of a batch in flight, or the rows just pinned.
        val membershipDtos = pinnedMemberships
            ?: membershipRows.map { PalletMembershipDto(it.palletId, it.sscc, it.addedAt, it.operatorId) }
        val body = json.encodeToString(
            SyncBatchRequest.serializer(),
            SyncBatchRequest(
                batchId,
                rows.map { it.toItem(cfg.deviceId) },
                boxRows.map { it.toClosure(cfg.deviceId) },
                palletRows.map { it.toClosure(cfg.deviceId) },
                labelRows.map { json.parseToJsonElement(it.payloadJson) },
                exceptionRows.map { json.parseToJsonElement(it.payloadJson) },
                palletExceptionRows.map { json.parseToJsonElement(it.payloadJson) },
                membershipDtos,
                removalRows.map { PalletMembershipRemovalDto(it.palletId, it.sscc, it.removedAt, it.operatorId) },
            ),
        )
        val links = buildMap {
            rows.forEachIndexed { i, row -> if (row.verdict == "ok") put("/items/$i#shift.scan.v1", "shift.scan:${row.id}") }
            boxRows.forEachIndexed { i, row -> put("/boxes/$i#shift.box.close.v1", "shift.box.close:${row.boxId}") }
            palletRows.forEachIndexed { i, row -> put("/pallets/$i#shift.pallet.close.v1", "shift.pallet.close:${row.palletId}") }
            labelRows.forEachIndexed { i, row -> if (isInitialLabelPreparation(row)) put("/productLabelEvents/$i#shift.label.prepare.v1", row.eventId) }
        }
        val request = evidence.prepare("scans", batchId, "/station/scans", body, links, negotiatedBatch)
        val result = transport.post(request.path, request.body) as? TransportResult.Ok ?: return Step.FAILED
        if (result.code !in 200..299) return Step.FAILED
        val native = evidence.nativeResult(request, result.body) ?: return Step.FAILED
        val parsed = parseBatchResponse(native) ?: return Step.FAILED
        // A fresh batch is applied whole (`applied == items.length`) or replayed (`alreadyApplied`); anything else is not this endpoint.
        if (!parsed.alreadyApplied && parsed.applied != rows.size) return Step.FAILED
        // The server answers exactly one outcome per submitted membership, in
        // submission order. Anything else -- no array, or a different length --
        // is not an acknowledgement of these rows, and guessing which record an
        // entry belongs to would silently drop a box off a pallet. Failing
        // leaves the pin standing and resends the identical batch; a server
        // that never answers memberships wedges this device loudly, which is
        // the intended outcome.
        if (membershipDtos.isNotEmpty() && parsed.memberships?.size != membershipDtos.size) return Step.FAILED
        // The removals' answer is held to the identical standard, for the
        // identical reason: guessing which record an entry belongs to would
        // silently leave a box on a pallet it was taken off, or take one off a
        // pallet it still sits on.
        if (removalRows.isNotEmpty() && parsed.membershipRemovals?.size != removalRows.size) return Step.FAILED
        val at = clock()
        db.recovery.commit {
            for (receipt in parsed.occurrences) {
                if (rows.any { it.shiftId == receipt.shiftId && it.codeHash == receipt.codeHash && it.scannedAt == receipt.scannedAt }) {
                    db.applyValidationReceipt(receipt)
                }
            }
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
            // Unconditional, for the same reason the box corrections above are:
            // this endpoint answers no per-pallet-exception receipt either, and
            // a fact only ever leaves once `PalletExceptionDao.sendable` says
            // the server can resolve its pallet -- which is precisely the one
            // case `applyPalletExceptions` would otherwise drop in silence. A
            // per-record ack, the way product-label events get one, is not
            // available here: there is nothing per-record to read.
            if (palletExceptionRows.isNotEmpty()) {
                db.palletExceptionDao().markAcked(palletExceptionRows.map { it.id }, Iso.format(at))
                db.palletExceptionDao().purgeAcked()
            }
            // Per record, positionally: the guard above established that the
            // answer has one entry per submitted row, in submission order. A
            // rejection also gives the box back to the registry -- the server
            // did not take it onto this pallet, so nothing here may keep
            // claiming it. `subscription_read_only` is a rejection like any
            // other: the record was quarantined server-side and the box stays
            // claimable once the subscription is back. An accepted record
            // leaves the claim alone; the registry refresh settles it.
            // A row this batch pinned may have been DELETED locally since
            // (`WarehousePallets.remove` deletes at any status): both
            // `markAccepted` and `markRejected` then match nothing, which is the
            // intended no-op -- the queued removal is what settles that box.
            if (membershipDtos.isNotEmpty()) {
                parsed.memberships?.forEachIndexed { i, outcome ->
                    val row = membershipDtos[i]
                    when (outcome.status) {
                        "accepted", "replayed" -> db.palletMembershipDao().markAccepted(row.palletId, row.boxSscc, Iso.format(at))
                        else -> {
                            db.palletMembershipDao()
                                .markRejected(row.palletId, row.boxSscc, outcome.status, outcome.winningPalletSscc, Iso.format(at))
                            db.boxRegistryDao().release(row.boxSscc)
                        }
                    }
                }
            }
            // Per record, positionally, like the memberships above.
            if (removalRows.isNotEmpty()) {
                parsed.membershipRemovals?.forEachIndexed { i, outcome ->
                    val row = removalRows[i]
                    // Terminal either way: the record is consumed. Only an answer
                    // that says the box is free updates the mirror; a closed
                    // pallet or a quarantined record leaves it to the next refresh.
                    // Nothing is logged here because this file logs nowhere.
                    if (outcome.status == "removed" || outcome.status == "replayed" || outcome.status == "not_found") {
                        db.boxRegistryDao().clearPallet(row.sscc)
                    }
                    db.palletMembershipRemovalDao().delete(row.id)
                }
            }
            db.metaDao().remove(GrantEvidenceTransport.SYNC_PROTOCOL)
            db.metaDao().remove(MetaStore.SYNC_PENDING_BATCH_ID)
            db.metaDao().remove(MetaStore.SYNC_PENDING_CEILING)
            db.metaDao().remove(MetaStore.SYNC_PENDING_BOX_COUNT)
            db.metaDao().remove(MetaStore.SYNC_PENDING_PALLET_COUNT)
            db.metaDao().remove(MetaStore.SYNC_PENDING_LABEL_COUNT)
            db.metaDao().remove(MetaStore.SYNC_PENDING_EXCEPTION_COUNT)
            db.metaDao().remove(MetaStore.SYNC_PENDING_PALLET_EXCEPTION_COUNT)
            db.metaDao().remove(MetaStore.SYNC_PENDING_MEMBERSHIP_COUNT)
            db.metaDao().remove(MetaStore.SYNC_PENDING_MEMBERSHIP_SNAPSHOT)
            db.metaDao().remove(MetaStore.SYNC_PENDING_MEMBERSHIP_REMOVAL_COUNT)
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

    /**
     * Gives a pin written before `MetaStore.SYNC_PENDING_MEMBERSHIP_SNAPSHOT`
     * existed the bytes it never stored, and answers whether that pin is still
     * usable.
     *
     * Such a pin survives the update that introduces the snapshot, and the very
     * next thing an operator can do offline is take one of its boxes off the
     * pallet -- `WarehousePallets.remove` deletes the `sent` row the pin names.
     * A retry would then fall back to the live `sent()` read, resend the
     * identical `batchId` one membership short, and the server would answer
     * `station_batch_mismatch` (409) on that batch forever, wedging every
     * channel on the terminal. So the snapshot is taken while the rows are
     * still all there: at engine construction, and again on the retry path for
     * a pin that reached it first.
     *
     * When the rows have ALREADY vanished there is nothing left to reconstruct
     * and no safe body to send, so the pin is abandoned instead: `sent` rows go
     * back to `pending` and ride a new batch id, which the server tolerates
     * because items and boxes are idempotent per record. A short body under the
     * old id would not be tolerated at all.
     */
    private suspend fun materialiseLegacyPin(): Boolean = db.recovery.commit {
        val count = meta.get(MetaStore.SYNC_PENDING_MEMBERSHIP_COUNT)?.toIntOrNull() ?: 0
        val pinned = meta.get(MetaStore.SYNC_PENDING_BATCH_ID) != null &&
            meta.get(MetaStore.SYNC_PENDING_CEILING)?.toLongOrNull() != null
        if (!pinned || count <= 0 || meta.get(MetaStore.SYNC_PENDING_MEMBERSHIP_SNAPSHOT) != null) {
            return@commit true
        }
        val rows = db.palletMembershipDao().sent(count)
        if (rows.size != count) {
            clearPendingOwned()
            return@commit false
        }
        meta.put(
            MetaStore.SYNC_PENDING_MEMBERSHIP_SNAPSHOT,
            json.encodeToString(
                ListSerializer(PalletMembershipDto.serializer()),
                rows.map { PalletMembershipDto(it.palletId, it.sscc, it.addedAt, it.operatorId) },
            ),
        )
        true
    }

    private suspend fun clearPending() = db.recovery.commit { clearPendingOwned() }

    private suspend fun clearPendingOwned() {
        meta.remove(GrantEvidenceTransport.SYNC_PROTOCOL)
        meta.remove(MetaStore.SYNC_PENDING_BATCH_ID)
        meta.remove(MetaStore.SYNC_PENDING_CEILING)
        meta.remove(MetaStore.SYNC_PENDING_BOX_COUNT)
        meta.remove(MetaStore.SYNC_PENDING_PALLET_COUNT)
        meta.remove(MetaStore.SYNC_PENDING_LABEL_COUNT)
        meta.remove(MetaStore.SYNC_PENDING_EXCEPTION_COUNT)
        meta.remove(MetaStore.SYNC_PENDING_PALLET_EXCEPTION_COUNT)
        meta.remove(MetaStore.SYNC_PENDING_MEMBERSHIP_COUNT)
        meta.remove(MetaStore.SYNC_PENDING_MEMBERSHIP_SNAPSHOT)
        meta.remove(MetaStore.SYNC_PENDING_MEMBERSHIP_REMOVAL_COUNT)
        // The abandoned batch never reached the server, so its rows are owed
        // again -- as `pending`, or the next batch would read none of them.
        db.palletMembershipDao().revertSent()
        db.palletMembershipRemovalDao().revertSent()
    }

    /**
     * The batch id actually posted: the assembled key, or a deterministic
     * digest of it once it would exceed what the server's
     * `syncBatchSchema.batchId` accepts.
     *
     * Ported from the station's `boundedBatchId` (`apps/station/src/lib/
     * sync.ts`), which solved exactly this: the assembled form folds one
     * signature per channel into the key so a retry changes exactly when the
     * SET being sent changes, which makes its length grow with how many
     * channels a batch carries. An over-long key is not cosmetic -- the server
     * rejects it with a 400 and the drain, which treats every error as
     * retryable and never drops data, resends the identical key forever,
     * wedging every channel on that device.
     *
     * Folding preserves both properties the key must have: the digest is a pure
     * function of the assembled key, so a retry of the same set produces the
     * same id, and two genuinely different sets keep different ids. The `sync:`
     * prefix keeps a folded key from colliding with a plain one. A key under
     * the bound is returned untouched, so nothing changes for an ordinary
     * batch -- and a batch already pinned in `meta` reads its stored id rather
     * than reassembling, so this cannot change the identity of anything in
     * flight across an upgrade.
     */
    internal fun boundedBatchId(batchId: String): String {
        if (batchId.length <= MAX_SYNC_BATCH_ID_CHARS) return batchId
        val digest = java.security.MessageDigest.getInstance("SHA-256")
            .digest(batchId.toByteArray(Charsets.UTF_8))
        return "sync:" + digest.joinToString("") { "%02x".format(it) }
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
        // Null for a warehouse pallet: that pallet belongs to no shift.
        shiftId = shiftId,
        terminalId = deviceId,
        sscc = checkNotNull(sscc) { "pallet $palletId is queued without an SSCC" },
        closedAt = checkNotNull(closedAt) { "pallet $palletId is queued while still open" },
        operatorId = operatorId,
        kind = kind,
        productId = productId,
    )

    private class BatchResponse(
        val applied: Int,
        val alreadyApplied: Boolean,
        val conflicts: List<BatchConflictDto>,
        val denied: String?,
        val receipt: ProductLabelReceipt?,
        val occurrences: List<ValidationOccurrenceReceipt>,
        /** One entry per submitted membership, in submission order. Null when the answer carried none. */
        val memberships: List<MembershipOutcome>?,
        /** One entry per submitted membership removal, in submission order. Null when the answer carried none. */
        val membershipRemovals: List<RemovalOutcome>?,
    )

    /** What the server did with one submitted membership. Any status but `accepted`/`replayed` is a rejection. */
    private class MembershipOutcome(val palletId: String, val boxSscc: String, val status: String, val winningPalletSscc: String?)

    /** What the server did with one submitted removal. Every status is terminal; see the design spec §2. */
    private class RemovalOutcome(val palletId: String, val boxSscc: String, val status: String)

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
        val occurrences = obj["validationOccurrences"]?.let { value ->
            val array = value as? kotlinx.serialization.json.JsonArray ?: return null
            array.map { entry ->
                val receipt = runCatching { json.decodeFromJsonElement(ValidationOccurrenceReceipt.serializer(), entry) }.getOrNull() ?: return null
                if (receipt.outcome !in setOf("first_accepted", "reprocessed", "conflict") || Iso.parse(receipt.scannedAt) == null) return null
                receipt
            }
        }.orEmpty()
        // Absent is null (an older server, or a batch that carried none); present
        // but not an array of `{palletId, boxSscc, status}` objects fails the
        // WHOLE answer, like every other shape guard here -- a body this device
        // cannot read is not an acknowledgement of anything in the batch.
        val memberships = obj["memberships"]?.takeIf { it !is JsonNull }?.let { value ->
            val array = value as? kotlinx.serialization.json.JsonArray ?: return null
            array.map { entry ->
                val o = entry as? kotlinx.serialization.json.JsonObject ?: return null
                val palletId = o.stringOrNull("palletId") ?: return null
                val boxSscc = o.stringOrNull("boxSscc") ?: return null
                val status = o.stringOrNull("status") ?: return null
                MembershipOutcome(palletId, boxSscc, status, rawSscc(o.stringOrNull("winningPalletSscc")))
            }
        }
        // Same rule as the memberships above: absent is null, present but not
        // an array of `{palletId, boxSscc, status}` objects fails the WHOLE
        // answer.
        val membershipRemovals = obj["membershipRemovals"]?.takeIf { it !is JsonNull }?.let { value ->
            val array = value as? kotlinx.serialization.json.JsonArray ?: return null
            array.map { entry ->
                val o = entry as? kotlinx.serialization.json.JsonObject ?: return null
                val palletId = o.stringOrNull("palletId") ?: return null
                val boxSscc = o.stringOrNull("boxSscc") ?: return null
                val status = o.stringOrNull("status") ?: return null
                RemovalOutcome(palletId, boxSscc, status)
            }
        }
        return BatchResponse(applied, alreadyApplied, conflicts, denied, parseReceipt(obj), occurrences, memberships, membershipRemovals)
    }

    /**
     * The winning pallet's SSCC as this device stores one: 18 raw digits.
     *
     * The server may answer with the AI-(00) element string, 20 digits with the
     * application identifier in front. Stored as-is, the screen's `takeLast(6)`
     * still reads right by luck while any comparison against a local `sscc`
     * silently never matches. Normalising here keeps one representation in the
     * database; anything else is passed through untouched.
     */
    private fun rawSscc(value: String?): String? =
        if (value != null && value.length == 20 && value.startsWith("00") && value.all { it.isDigit() }) value.substring(2) else value

    private fun kotlinx.serialization.json.JsonObject.stringOrNull(key: String): String? =
        (this[key] as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { it.isString }?.content

    /**
     * Every access is a safe cast.
     *
     * `jsonObject`, `jsonArray` and `jsonPrimitive` THROW on the wrong kind, and
     * nothing above this catches: the throw would leave `drainOnce` and unwind
     * the sync loop itself, which never restarts. A captive portal answering
     * 200 with a differently shaped body is exactly the case the rest of this
     * parser is already shaped against.
     */
    private fun isInitialLabelPreparation(row: app.markiro.handheld.core.storage.ProductLabelEventEntity): Boolean {
        if (row.kind != "prepared") return false
        val payload = runCatching { json.parseToJsonElement(row.payloadJson).jsonObject }.getOrNull() ?: return false
        val attempt = payload["attemptNo"] as? kotlinx.serialization.json.JsonPrimitive ?: return false
        return !attempt.isString && attempt.intOrNull == 1 &&
            (payload["reason"] == null || payload["reason"] == kotlinx.serialization.json.JsonNull)
    }

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
            val evidence = GrantEvidenceTransport(db)
            val request = evidence.prepare("shift-close", row.eventId, "/station/shift-closures", body, mapOf("/#shift.close.v1" to row.eventId), evidence.negotiated(row.eventId))
            val result = transport.post(request.path, request.body) as? TransportResult.Ok ?: return false
            if (result.code !in 200..299) return false
            val native = evidence.nativeResult(request, result.body) ?: return false
            val response = runCatching { json.decodeFromString(ShiftCloseResponse.serializer(), native) }.getOrNull() ?: return false
            when (response.outcome) {
                // The row stays as the idempotency marker: a second close of the same shift returns it instead of a new event.
                "accepted", "already_resolved" -> db.recovery.commit { db.shiftCloseDao().markAccepted(row.eventId, Iso.format(clock())) }
                "conflict" -> db.recovery.commit { db.shiftCloseDao().markConflict(row.eventId, response.conflictCode ?: "multiple_devices", Iso.format(clock())) }
                else -> return false
            }
        }
        return true
    }

    /** Includes acknowledged occurrences: an earlier competing scan may arrive in a later batch. */
    internal suspend fun reconcileValidationOccurrences() = db.recovery.work {
        var afterShift = ""
        var afterHash = ""
        while (true) {
            val page = db.validationDao().page(afterShift, afterHash, 500)
            if (page.isEmpty()) break
            val identities = page.map { ValidationOccurrenceIdentity(it.shiftId, it.codeHash, it.scannedAt) }
            val body = json.encodeToString(ValidationOccurrenceStatusRequest.serializer(), ValidationOccurrenceStatusRequest(identities))
            val result = transport.post("/station/validation-occurrences/status", body) as? TransportResult.Ok ?: break
            if (result.code !in 200..299) break
            val response = runCatching { json.decodeFromString(ValidationOccurrenceStatusResponse.serializer(), result.body) }.getOrNull() ?: break
            if (response.protocol != VALIDATION_REPROCESSING_PROTOCOL || response.occurrences.size > 500 ||
                response.occurrences.any { it.outcome !in setOf("first_accepted", "reprocessed", "pending", "conflict") }) break
            db.recovery.commit {
                for (receipt in response.occurrences) {
                    if (ValidationOccurrenceIdentity(receipt.shiftId, receipt.codeHash, receipt.scannedAt) in identities) db.applyValidationReceipt(receipt)
                }
            }
            afterShift = page.last().shiftId; afterHash = page.last().codeHash
            if (page.size < 500) break
        }
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

        /**
         * The server's own `MAX_PALLET_MEMBERSHIPS_PER_SYNC_BATCH`
         * (`packages/domain/src/sync/limits.ts`): one closed box scanned onto a
         * warehouse pallet per record. Hand-copied for the reason
         * `MAX_BOX_CLOSURES` above gives; pinned by `SyncLimitsFixturesTest`.
         */
        const val MAX_PALLET_MEMBERSHIPS = 100

        /**
         * Membership removals are bounded by the MEMBERSHIP cap above, not one
         * of their own: a removal is the undo of exactly one membership, so a
         * batch cannot owe more removals than it could owe memberships. The
         * server bounds `palletMembershipRemovals[]` by the same
         * `MAX_PALLET_MEMBERSHIPS_PER_SYNC_BATCH`, so no new fixture key is
         * needed -- `SyncLimitsFixturesTest` pins this literal to that number,
         * the way `MAX_PALLET_EXCEPTIONS` is pinned to the closure cap.
         */
        const val MAX_PALLET_MEMBERSHIP_REMOVALS = 100

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

        /**
         * The server's cap on `palletExceptions[]`.
         *
         * NOT a constant of its own on the server: `syncBatchSchema` bounds
         * that array with `MAX_PALLET_CLOSURES_PER_SYNC_BATCH` -- "a batch
         * cannot carry exceptions against more pallets than it could close" --
         * so this is the same number as [MAX_PALLET_CLOSURES] on purpose, not
         * by coincidence, and it must track that constant rather than acquire
         * a life of its own. `SyncLimitsFixturesTest` asserts it against the
         * committed `maxPalletClosuresPerSyncBatch`, so the generated fixture
         * needs no new key and the pair cannot drift apart silently.
         */
        const val MAX_PALLET_EXCEPTIONS = MAX_PALLET_CLOSURES

        const val RECONCILE_PAGE = 200
        const val HEARTBEAT_MS = 15_000L
        const val STUCK_AFTER_MS = 15 * 60 * 1000L
    }
}
