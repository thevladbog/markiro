package app.markiro.handheld.core.inventory

import app.markiro.handheld.core.km.KmCodec
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.InventoryEventEntity
import app.markiro.handheld.core.storage.InventoryOutboxEntity
import app.markiro.handheld.core.storage.InventoryResultEntity
import app.markiro.handheld.core.storage.InventorySnapshotCodeEntity
import app.markiro.handheld.core.storage.InventoryTaskEntity
import app.markiro.handheld.core.storage.InventoryTerminalStateEntity
import app.markiro.handheld.core.util.Iso
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.UUID

enum class InventoryVerdict(val wire: String) {
    EXPECTED("expected"),
    PROTECTED("protected"),
    KNOWN_INELIGIBLE("known-ineligible"),
    UNKNOWN("unknown"),
    DUPLICATE("duplicate"),
    INVALID("invalid"),
    ;

    companion object {
        fun fromWire(wire: String): InventoryVerdict = entries.first { it.wire == wire }
    }
}

sealed interface RecordOutcome {
    data class Recorded(
        val verdict: InventoryVerdict,
        /** `item`, `known_box`, `old_box` or `invalid`. */
        val scanKind: String,
        val tail: String?,
        val claimedCount: Int,
        val boxChildCount: Int,
        val winner: LocalClaim?,
        val sourceStatus: String?,
        val scannedAt: String,
        val eventId: String?,
        val invalidReason: String? = null,
    ) : RecordOutcome

    /** Nothing was written; the screen asks the operator and repeats the scan with `acceptMismatch` or a new date. */
    data class DateMismatch(val activeDate: String, val codeDate: String?, val mixed: Boolean, val raw: String) : RecordOutcome
}

/**
 * Port of the station's `recordInventoryScanInternal` for `check`: classify against the snapshot and
 * local claims, guard the production date, then in one transaction allocate the device sequence,
 * insert the event, claim result rows (`INSERT OR IGNORE` decides who counted first) and queue the
 * canonical event JSON. One scan at a time.
 */
class InventoryRecorder(private val db: HandheldDatabase, private val clock: () -> Long = System::currentTimeMillis) {
    private val mutex = Mutex()

    suspend fun activeDate(inventoryId: String): String? =
        db.inventoryTerminalStateDao().get(inventoryId)?.activeProductionDate ?: db.inventoryTaskDao().get(inventoryId)?.productionDateFrom

    suspend fun setActiveDate(inventoryId: String, date: String, operatorId: String) = db.recovery.commit { setActiveDateOwned(inventoryId, date, operatorId) }

    private suspend fun setActiveDateOwned(inventoryId: String, date: String, operatorId: String) = mutex.withLock {
        val task = checkNotNull(db.inventoryTaskDao().get(inventoryId)) { "inventory $inventoryId is not on this device" }
        require(date >= task.productionDateFrom && date <= task.productionDateTo) { "date outside the task range" }
        val at = Iso.format(clock())
        db.recovery.commit {
            val state = db.inventoryTerminalStateDao().get(inventoryId) ?: terminal(task, operatorId, at)
            db.inventoryTerminalStateDao().upsert(state.copy(activeProductionDate = date, operatorId = operatorId, updatedAt = at))
        }
    }

    suspend fun record(
        inventoryId: String,
        raw: String,
        operatorId: String,
        acceptMismatch: Boolean = false,
        eventId: String = UUID.randomUUID().toString(),
    ): RecordOutcome = db.recovery.commit { recordOwned(inventoryId, raw, operatorId, acceptMismatch, eventId) }

    private suspend fun recordOwned(
        inventoryId: String,
        raw: String,
        operatorId: String,
        acceptMismatch: Boolean = false,
        eventId: String = UUID.randomUUID().toString(),
    ): RecordOutcome = mutex.withLock {
        val task = checkNotNull(db.inventoryTaskDao().get(inventoryId)) { "inventory $inventoryId is not on this device" }
        check(task.state == "active") { "inventory $inventoryId is not active" }
        val scannedAt = Iso.format(clock())
        db.inventoryEventDao().get(eventId)?.let { return replay(it) }
        val ctx = context(task, raw)
        val classification = InventoryClassifier.classify(raw, ctx)
        if (classification is InventoryClassification.Invalid) {
            return RecordOutcome.Recorded(InventoryVerdict.INVALID, "invalid", null, 0, 0, null, null, scannedAt, null, classification.reason)
        }
        val deviceId = db.deviceConfigDao().get()?.deviceId ?: "dev-local"
        db.recovery.commit {
            val state = db.inventoryTerminalStateDao().get(inventoryId) ?: terminal(task, operatorId, scannedAt)
            val active = state.activeProductionDate ?: task.productionDateFrom
            var activeDate = active
            if (!acceptMismatch) {
                when (val source = InventoryClassifier.sourceDate(classification, ctx)) {
                    SourceDate.None -> Unit
                    SourceDate.Mixed -> return@commit RecordOutcome.DateMismatch(active, null, true, raw)
                    is SourceDate.Single -> if (source.productionDate != active) {
                        if (db.inventoryEventDao().hasAny(inventoryId)) {
                            return@commit RecordOutcome.DateMismatch(active, source.productionDate, false, raw)
                        }
                        // The first scan of this terminal silently adopts the code's date, as on the station.
                        activeDate = source.productionDate
                    }
                }
            }
            val sequence = state.nextDeviceSequence
            db.inventoryTerminalStateDao().upsert(
                state.copy(nextDeviceSequence = sequence + 1, operatorId = operatorId, activeProductionDate = activeDate, updatedAt = scannedAt),
            )
            val identity = classification.identity
            val claimedOrigins = claim(task, identity, classification, eventId, scannedAt, activeDate, deviceId)
            var verdict = when {
                Origin.EXPECTED in claimedOrigins -> InventoryVerdict.EXPECTED
                Origin.PROTECTED in claimedOrigins -> InventoryVerdict.PROTECTED
                Origin.KNOWN_INELIGIBLE in claimedOrigins -> InventoryVerdict.KNOWN_INELIGIBLE
                classification is InventoryClassification.Unknown -> InventoryVerdict.UNKNOWN
                else -> InventoryVerdict.DUPLICATE
            }
            var winner: LocalClaim? = null
            val normalized = normalizedIdentity(identity)
            if (verdict == InventoryVerdict.UNKNOWN) {
                db.inventoryEventDao().firstUnknown(inventoryId, normalized)?.let { first ->
                    verdict = InventoryVerdict.DUPLICATE
                    winner = LocalClaim(first.codeHash ?: first.normalizedIdentity, first.eventId, deviceId, first.scannedAt)
                }
            } else if (verdict == InventoryVerdict.DUPLICATE) {
                winner = (classification as? InventoryClassification.Duplicate)?.firstWinning ?: projectionWinner(task, identity)
            }
            val event = InventoryEventEntity(
                eventId = eventId, inventoryId = inventoryId, snapshotId = task.snapshotId, deviceSequence = sequence, operatorId = operatorId,
                scannedAt = scannedAt, kind = identity.scanKind, normalizedIdentity = normalized,
                codeHash = (identity as? Identity.Item)?.codeHash, canonicalRaw = canonicalRaw(identity), activeProductionDate = activeDate,
                localVerdict = verdict.wire, claimedCount = claimedOrigins.size, winnerEventId = winner?.eventId, winnerDeviceId = winner?.deviceId,
                winnerScannedAt = winner?.scannedAt, serverStatus = null,
            )
            db.inventoryEventDao().insert(event)
            db.inventoryOutboxDao().insert(
                InventoryOutboxEntity(
                    inventoryId = inventoryId, snapshotId = task.snapshotId, eventId = eventId, deviceSequence = sequence,
                    payloadJson = InventoryBatchCodec.eventJson(event), createdAt = scannedAt,
                ),
            )
            RecordOutcome.Recorded(
                verdict, identity.scanKind, tail(identity), claimedOrigins.size, (identity as? Identity.KnownBox)?.children?.size ?: 0,
                winner, classification.sourceStatus, scannedAt, eventId,
            )
        }
    }

    private fun replay(event: InventoryEventEntity): RecordOutcome.Recorded {
        val winner = event.winnerEventId?.let {
            LocalClaim(event.codeHash ?: event.normalizedIdentity, it, event.winnerDeviceId.orEmpty(), event.winnerScannedAt.orEmpty())
        }
        val tail = InventoryTail.ofEvent(event.kind, event.canonicalRaw)
        return RecordOutcome.Recorded(InventoryVerdict.fromWire(event.localVerdict), event.kind, tail, event.claimedCount, 0, winner, null, event.scannedAt, event.eventId)
    }

    /** Preloads what the classifier will ask for: the code row or the box children, plus their claims. */
    private suspend fun context(task: InventoryTaskEntity, raw: String): ClassifierContext {
        val rows = HashMap<String, SnapshotRow>()
        val claims = HashMap<String, LocalClaim>()
        var boxChildren: Pair<String, List<SnapshotRow>>? = null
        when (val input = ScanClassifier.classify(raw)) {
            is ScanInput.Km -> {
                val hash = KmCodec.hash(input.km)
                db.inventorySnapshotCodeDao().get(task.snapshotId, hash)?.let { rows[hash] = it.toRow() }
                db.inventoryResultDao().get(task.inventoryId, hash)?.let { claims[hash] = it.toClaim() }
            }
            is ScanInput.Sscc -> {
                val list = db.inventorySnapshotCodeDao().children(task.snapshotId, input.sscc).map { it.toRow() }
                list.forEach { rows[it.codeHash] = it }
                db.inventoryResultDao().forHashes(task.inventoryId, list.map { it.codeHash }).forEach { claims[it.codeHash] = it.toClaim() }
                boxChildren = input.sscc to list
            }
            else -> Unit
        }
        return object : ClassifierContext {
            override val taskGtin14 = task.gtin14
            override fun snapshotCode(codeHash: String) = rows[codeHash]
            override fun snapshotChildren(sscc: String) = boxChildren?.takeIf { it.first == sscc }?.second.orEmpty()
            override fun localClaim(codeHash: String) = claims[codeHash]
        }
    }

    /** Result rows for what this event counted; returns the origins of the rows actually inserted. */
    private suspend fun claim(
        task: InventoryTaskEntity,
        identity: Identity,
        classification: InventoryClassification,
        eventId: String,
        scannedAt: String,
        activeDate: String,
        deviceId: String,
    ): List<Origin> {
        fun row(codeHash: String, origin: Origin) = InventoryResultEntity(
            inventoryId = task.inventoryId, snapshotId = task.snapshotId, codeHash = codeHash, firstAcceptedEventId = eventId,
            winningDeviceId = deviceId, winningScannedAt = scannedAt, observedProductionDate = activeDate, classification = origin.wire,
            source = "local", updatedAt = scannedAt,
        )
        val inserted = ArrayList<Origin>()
        when (identity) {
            is Identity.Item -> {
                val origin = when (classification) {
                    is InventoryClassification.Expected -> Origin.EXPECTED
                    is InventoryClassification.Protected -> Origin.PROTECTED
                    is InventoryClassification.KnownIneligible -> Origin.KNOWN_INELIGIBLE
                    else -> null
                }
                if (origin != null && db.inventoryResultDao().insertIgnore(row(identity.codeHash, origin)) >= 0) inserted += origin
            }
            is Identity.KnownBox -> identity.children.forEach { child ->
                if (child.firstWinning == null && db.inventoryResultDao().insertIgnore(row(child.codeHash, child.origin)) >= 0) inserted += child.origin
            }
            is Identity.OldBox -> Unit
        }
        return inserted
    }

    private suspend fun projectionWinner(task: InventoryTaskEntity, identity: Identity): LocalClaim? = when (identity) {
        is Identity.Item -> db.inventoryResultDao().get(task.inventoryId, identity.codeHash)?.toClaim()
        is Identity.KnownBox -> db.inventoryResultDao().forHashes(task.inventoryId, identity.children.map { it.codeHash })
            .map { it.toClaim() }.sortedWith(compareBy({ it.scannedAt }, { it.deviceId }, { it.eventId })).firstOrNull()
        is Identity.OldBox -> null
    }

    private fun terminal(task: InventoryTaskEntity, operatorId: String, at: String) = InventoryTerminalStateEntity(
        inventoryId = task.inventoryId, snapshotId = task.snapshotId, operatorId = operatorId, activeProductionDate = task.productionDateFrom,
        nextDeviceSequence = 1, progressCursor = null, progressResultRevision = 0, updatedAt = at,
    )

    private fun normalizedIdentity(identity: Identity) = when (identity) {
        is Identity.Item -> "item:${identity.codeHash}"
        is Identity.KnownBox -> "known_box:${identity.sscc}"
        is Identity.OldBox -> "old_box:${identity.sscc}"
    }

    private fun canonicalRaw(identity: Identity) = when (identity) {
        is Identity.Item -> identity.canonicalRaw
        is Identity.KnownBox -> identity.sscc
        is Identity.OldBox -> identity.sscc
    }

    private fun tail(identity: Identity) = when (identity) {
        is Identity.Item -> InventoryTail.ofSerial(identity.serial)
        is Identity.KnownBox -> InventoryTail.ofSscc(identity.sscc)
        is Identity.OldBox -> InventoryTail.ofSscc(identity.sscc)
    }

    private fun InventorySnapshotCodeEntity.toRow() =
        SnapshotRow(codeHash, canonicalRaw, gtin14, serial, sourceStatus, sourceState, sourceProductionDate, expected, protected, parentSscc)

    private fun InventoryResultEntity.toClaim() = LocalClaim(codeHash, firstAcceptedEventId, winningDeviceId, winningScannedAt)
}
