package app.markiro.handheld.core.box

import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.PalletEntity
import app.markiro.handheld.core.storage.PalletPrint
import app.markiro.handheld.core.util.Iso
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.UUID

/**
 * The device's pallets. One pallet is open per shift at a time.
 *
 * Unlike `boxes`, whose `(shiftId, closedAt)` index is also just non-unique,
 * the STATION guards its own pallet table with a partial unique index on
 * `(shiftId, terminalId)` where `closedAt IS NULL`. The handheld's `pallets`
 * table carries only the plain, non-unique `(shiftId, closedAt)` index (see
 * `MIGRATION_7_8`), so nothing at the database stops two scans arriving
 * together from each finding no open pallet and inserting one. This mutex is
 * what closes that gap here, exactly the way `BoxRepository.currentBox`
 * closes the identical exposure for boxes.
 */
class PalletRepository(
    private val db: HandheldDatabase,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val mutex = Mutex()

    /**
     * The shift's open pallet, opening one if none is.
     *
     * Serialised so two boxes closing together cannot each open a pallet and
     * leave the shift with two open ones, which no later query could tell apart.
     */
    suspend fun currentPallet(shiftId: String, terminalId: String? = null): PalletEntity = mutex.withLock {
        db.palletDao().open(shiftId) ?: PalletEntity(
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
        db.palletDao().setPrintState(palletId, state, reason)

    /**
     * Called once at startup. Anything left mid-print is unknown, never resumed:
     * the app died between handing bytes to the printer and hearing back, and
     * resuming would be an automatic resend of a label that may already be on
     * a pallet the server has accepted. Same reasoning as
     * `BoxRepository.demoteInterruptedPrints`.
     */
    suspend fun demoteInterruptedPrints(): Int = db.palletDao().demoteInterruptedPrints()
}
