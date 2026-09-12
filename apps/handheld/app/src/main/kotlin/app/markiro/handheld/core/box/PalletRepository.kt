package app.markiro.handheld.core.box

import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.PalletEntity
import app.markiro.handheld.core.storage.PalletPrint
import app.markiro.handheld.core.util.Iso
import kotlinx.coroutines.flow.Flow
import java.util.UUID

/**
 * The device's pallets. One pallet is open per shift at a time.
 *
 * Unlike `boxes`, whose `(shiftId, closedAt)` index is also just non-unique,
 * the STATION guards its own pallet table with a partial unique index on
 * `(shiftId, terminalId)` where `closedAt IS NULL`. The handheld's `pallets`
 * table carries only the plain, non-unique `(shiftId, closedAt)` index (see
 * `MIGRATION_9_10`), so nothing at the database stops two scans arriving
 * together from each finding no open pallet and inserting one. The shared
 * [PalletLock] is what closes that gap here, the way `BoxRepository.currentBox`
 * closes the identical exposure for boxes -- shared rather than private so
 * opening, joining and closing a pallet have ONE order between them.
 */
class PalletRepository(
    private val db: HandheldDatabase,
    private val lock: PalletLock,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    /**
     * The shift's open pallet, opening one if none is.
     *
     * Serialised so two boxes closing together cannot each open a pallet and
     * leave the shift with two open ones, which no later query could tell apart.
     *
     * The recovery lease is taken BEFORE the lock, the same order `CloseBox`
     * and `ClosePallet` take them in; `exclusive` holds it without opening a
     * transaction, which is what [PalletLock] requires of its callers.
     */
    suspend fun currentPallet(shiftId: String, terminalId: String? = null): PalletEntity =
        db.recovery.exclusive { lock.withLock { held -> currentPallet(held, shiftId, terminalId) } }

    /**
     * [currentPallet] for a caller that already holds the lock.
     *
     * `CloseBox` takes the lock before opening its transaction and resolves the
     * pallet inside it, so the pallet lands in the same commit as the box that
     * joined it. Re-taking the lock down here would be exactly the inverted
     * order [PalletLock] exists to forbid, so the caller's proof is passed in.
     */
    suspend fun currentPallet(held: PalletLock.Held, shiftId: String, terminalId: String? = null): PalletEntity {
        lock.requireHeld(held)
        return db.palletDao().open(shiftId) ?: PalletEntity(
            palletId = UUID.randomUUID().toString(),
            shiftId = shiftId,
            terminalId = terminalId,
            sscc = null,
            openedAt = Iso.format(clock()),
            closedAt = null,
            operatorId = null,
            printState = PalletPrint.PENDING,
            printReason = null,
            ackedAt = null,
        ).also { db.palletDao().insert(it) }
    }

    fun observeOpen(shiftId: String): Flow<PalletEntity?> = db.palletDao().observeOpen(shiftId)

    suspend fun get(palletId: String): PalletEntity? = db.palletDao().get(palletId)

    suspend fun boxCount(palletId: String): Int = db.palletDao().boxCount(palletId)

    fun observeBoxCount(palletId: String): Flow<Int> = db.palletDao().observeBoxCount(palletId)

    suspend fun itemCount(palletId: String): Int = db.palletDao().itemCount(palletId)

    suspend fun setPrintState(palletId: String, state: String, reason: String?) =
        db.recovery.commit { db.palletDao().setPrintState(palletId, state, reason) }

    /** Closed pallets whose label is not resolved -- the label queue's pallet half. */
    fun observeUnprinted(): Flow<List<PalletEntity>> = db.palletDao().observeUnprinted()

    fun observeUnprintedCount(): Flow<Int> = db.palletDao().observeUnprintedCount()

    /**
     * Called once at startup. Anything left mid-print is unknown, never resumed:
     * the app died between handing bytes to the printer and hearing back, and
     * resuming would be an automatic resend of a label that may already be on
     * a pallet the server has accepted. Same reasoning as
     * `BoxRepository.demoteInterruptedPrints`.
     */
    suspend fun demoteInterruptedPrints(): Int = db.recovery.commit { db.palletDao().demoteInterruptedPrints() }
}
