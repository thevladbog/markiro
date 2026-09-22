package app.markiro.handheld.core.exceptions

import app.markiro.handheld.core.storage.BoxExceptionEntity
import app.markiro.handheld.core.storage.CodeEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.PalletExceptionEntity
import app.markiro.handheld.core.storage.ScanEventEntity
import app.markiro.handheld.core.util.Iso

sealed interface UndoResult {
    data class Undone(val codeHash: String) : UndoResult

    /** A scan landed between the confirmation screen opening and the operator confirming. */
    data object Stale : UndoResult
    data object Empty : UndoResult
}

sealed interface DisassembleResult {
    data object Retired : DisassembleResult
    data object AlreadyRetired : DisassembleResult
    data object NotClosed : DisassembleResult
}

/**
 * The pallet twin of [DisassembleResult]. A separate type rather than a reused
 * one: a caller that can only handle a box outcome must not compile against a
 * pallet call by accident, and the two flows refuse for different reasons
 * ("this pallet is still open" is not "this box is still open").
 */
sealed interface DisassemblePalletResult {
    data object Retired : DisassemblePalletResult
    data object AlreadyRetired : DisassemblePalletResult
    data object NotClosed : DisassemblePalletResult
}

/**
 * The four operator corrections, applied on this device and queued for the
 * server.
 *
 * Every one is a single Room transaction: the local effect and the queued fact
 * land together or not at all. A correction the operator saw applied must never
 * be missing from the queue, and a fact must never describe a release that did
 * not happen.
 */
class ExceptionEngine(
    private val db: HandheldDatabase,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    /** The undo target: what the confirmation screen names. */
    suspend fun lastScanIn(boxId: String): CodeEntity? = db.codeDao().lastIn(boxId)

    suspend fun undoLastScan(
        shiftId: String,
        boxId: String,
        expectedCodeHash: String,
        operatorId: String?,
        terminalId: String?,
    ): UndoResult = db.recovery.commit { undoLastScanOwned(shiftId, boxId, expectedCodeHash, operatorId, terminalId) }

    private suspend fun undoLastScanOwned(
        shiftId: String,
        boxId: String,
        expectedCodeHash: String,
        operatorId: String?,
        terminalId: String?,
    ): UndoResult = db.recovery.commit {
        val last = db.codeDao().lastIn(boxId) ?: return@commit UndoResult.Empty
        if (last.codeHash != expectedCodeHash) return@commit UndoResult.Stale
        val at = Iso.format(clock())
        // Released locally first: the row leaving `codes_mirror` is what makes the
        // code scannable again on this device without waiting for a round trip.
        db.codeDao().delete(last.codeHash)
        db.scanEventDao().insert(
            ScanEventEntity(
                shiftId = shiftId, raw = "", verdict = "undone", scannedAt = at,
                operatorId = operatorId, codeHash = last.codeHash,
            ),
        )
        queue(
            ExceptionFact.Undo(
                boxId = boxId, shiftId = shiftId, terminalId = terminalId, operatorId = operatorId,
                occurredAt = at,
                codeHash = last.codeHash,
                // The ORIGINAL scan's own time. The server joins the claim by it.
                targetScannedAt = last.scannedAt,
            ),
        )
        UndoResult.Undone(last.codeHash)
    }

    /** Returns how many units were released; zero queues nothing. */
    suspend fun clearBox(
        shiftId: String,
        boxId: String,
        operatorId: String?,
        terminalId: String?,
    ): Int = db.recovery.commit { clearBoxOwned(shiftId, boxId, operatorId, terminalId) }

    private suspend fun clearBoxOwned(
        shiftId: String,
        boxId: String,
        operatorId: String?,
        terminalId: String?,
    ): Int = db.recovery.commit {
        val released = db.codeDao().deleteInBox(boxId)
        if (released == 0) return@commit 0
        queue(
            ExceptionFact.Clear(
                boxId = boxId, shiftId = shiftId, terminalId = terminalId,
                operatorId = operatorId, occurredAt = Iso.format(clock()),
            ),
        )
        released
    }

    suspend fun disassemble(
        shiftId: String,
        boxId: String,
        reason: DisassembleReason,
        operatorId: String?,
        terminalId: String?,
    ): DisassembleResult = db.recovery.commit { disassembleOwned(shiftId, boxId, reason, operatorId, terminalId) }

    private suspend fun disassembleOwned(
        shiftId: String,
        boxId: String,
        reason: DisassembleReason,
        operatorId: String?,
        terminalId: String?,
    ): DisassembleResult = db.recovery.commit {
        val box = db.boxDao().get(boxId) ?: return@commit DisassembleResult.NotClosed
        if (box.closedAt == null) return@commit DisassembleResult.NotClosed
        val at = Iso.format(clock())
        if (db.boxDao().markDisassembled(boxId, at) == 0) return@commit DisassembleResult.AlreadyRetired
        db.codeDao().deleteInBox(boxId)
        queue(
            ExceptionFact.Disassemble(
                boxId = boxId, shiftId = shiftId, terminalId = terminalId,
                operatorId = operatorId, occurredAt = at, reason = reason.audit,
            ),
        )
        DisassembleResult.Retired
    }

    /**
     * Takes a CLOSED pallet apart, whichever kind it is (spec §3.2).
     *
     * Both effects and the queued fact land in one transaction, for the same
     * reason [disassemble] does: a stack the operator saw taken apart must not
     * be missing from the queue, and a fact must never describe a release that
     * did not happen.
     *
     * Two things deliberately do NOT happen here.
     *
     * The member boxes are not retired. A pallet is a way of stacking boxes;
     * taking the stack apart says nothing about the boxes on it, and each one
     * keeps its own SSCC, its own codes and its own life.
     *
     * The membership rows stay. They are the historical fact that these boxes
     * stood on this pallet -- the same rule `PalletDao.boxCount` documents for
     * a production pallet's `boxes.palletId`. What DOES go is the device's own
     * claim in `box_registry.localPalletId`: that claim exists only to stop a
     * box being scanned onto a second pallet, and a pallet that no longer
     * exists must not keep its boxes hostage.
     */
    suspend fun disassemblePallet(
        palletId: String,
        reason: DisassembleReason,
        operatorId: String?,
        terminalId: String?,
    ): DisassemblePalletResult = db.recovery.commit { disassemblePalletOwned(palletId, reason, operatorId, terminalId) }

    private suspend fun disassemblePalletOwned(
        palletId: String,
        reason: DisassembleReason,
        operatorId: String?,
        terminalId: String?,
    ): DisassemblePalletResult = db.recovery.commit {
        val pallet = db.palletDao().get(palletId) ?: return@commit DisassemblePalletResult.NotClosed
        if (pallet.closedAt == null) return@commit DisassemblePalletResult.NotClosed
        val at = Iso.format(clock())
        // The guarded UPDATE is the decision, not the row read above it: two
        // confirmations racing here both saw a retirable pallet, and only the
        // one that actually moved the row may queue a fact.
        if (db.palletDao().markDisassembled(palletId, at) == 0) return@commit DisassemblePalletResult.AlreadyRetired
        // A no-op for a production pallet: its boxes were never claimed here.
        db.boxRegistryDao().releaseAll(palletId)
        queuePallet(
            PalletExceptionFact(
                kind = PalletExceptionKind.DISASSEMBLE,
                palletId = palletId,
                // Null for a warehouse pallet, which belongs to no shift.
                shiftId = pallet.shiftId,
                terminalId = terminalId, operatorId = operatorId,
                reason = reason.audit, occurredAt = at,
            ),
        )
        DisassemblePalletResult.Retired
    }

    /** Records the request. The printing itself is the caller's business. */
    suspend fun reprint(
        shiftId: String,
        boxId: String,
        reason: ReprintReason,
        operatorId: String?,
        terminalId: String?,
    ) = db.recovery.work { reprintOwned(shiftId, boxId, reason, operatorId, terminalId) }

    private suspend fun reprintOwned(
        shiftId: String,
        boxId: String,
        reason: ReprintReason,
        operatorId: String?,
        terminalId: String?,
    ) {
        queue(
            ExceptionFact.Reprint(
                boxId = boxId, shiftId = shiftId, terminalId = terminalId,
                operatorId = operatorId, occurredAt = Iso.format(clock()), reason = reason.audit,
            ),
        )
    }

    /**
     * Records a pallet label reprint. The printing itself is the caller's
     * business, exactly as it is for [reprint].
     *
     * The station records the same fact through `reprintPallet`
     * (`apps/station/src/lib/pallets.ts`); without this the two surfaces close
     * pallets off the same physical event and keep different ledgers.
     */
    suspend fun reprintPallet(
        shiftId: String?,
        palletId: String,
        reason: ReprintReason,
        operatorId: String?,
        terminalId: String?,
    ) = db.recovery.work { reprintPalletOwned(shiftId, palletId, reason, operatorId, terminalId) }

    private suspend fun reprintPalletOwned(
        shiftId: String?,
        palletId: String,
        reason: ReprintReason,
        operatorId: String?,
        terminalId: String?,
    ) {
        queuePallet(
            PalletExceptionFact(
                kind = PalletExceptionKind.REPRINT,
                palletId = palletId, shiftId = shiftId, terminalId = terminalId,
                operatorId = operatorId, occurredAt = Iso.format(clock()), reason = reason.audit,
            ),
        )
    }

    /**
     * The watermark is read here, inside the same transaction as the local
     * effect, so it names exactly the scans that preceded this correction.
     */
    private suspend fun queue(fact: ExceptionFact) = db.recovery.commit { queueOwned(fact) }

    private suspend fun queuePallet(fact: PalletExceptionFact) = db.recovery.commit { queuePalletOwned(fact) }

    /**
     * No outbox watermark, unlike [queueOwned]: a pallet exception depends on
     * the pallet CLOSURE channel, not on the scans. `PalletExceptionDao.
     * sendable` is where that dependency is enforced.
     */
    private suspend fun queuePalletOwned(fact: PalletExceptionFact) {
        db.palletExceptionDao().insert(
            PalletExceptionEntity(
                kind = fact.kind.wire,
                palletId = fact.palletId,
                shiftId = fact.shiftId,
                terminalId = fact.terminalId,
                operatorId = fact.operatorId,
                reason = fact.reason,
                occurredAt = fact.occurredAt,
                payloadJson = fact.toWireJson().toString(),
                ackedAt = null,
            ),
        )
    }

    private suspend fun queueOwned(fact: ExceptionFact) {
        val undo = fact as? ExceptionFact.Undo
        db.boxExceptionDao().insert(
            BoxExceptionEntity(
                kind = fact.kind,
                boxId = fact.boxId,
                codeHash = undo?.codeHash,
                targetScannedAt = undo?.targetScannedAt,
                shiftId = fact.shiftId,
                operatorId = fact.operatorId,
                reason = when (fact) {
                    is ExceptionFact.Disassemble -> fact.reason
                    is ExceptionFact.Reprint -> fact.reason
                    is ExceptionFact.Undo, is ExceptionFact.Clear -> null
                },
                occurredAt = fact.occurredAt,
                payloadJson = fact.toWireJson().toString(),
                afterOutboxId = db.outboxDao().maxId(),
                ackedAt = null,
            ),
        )
    }
}
