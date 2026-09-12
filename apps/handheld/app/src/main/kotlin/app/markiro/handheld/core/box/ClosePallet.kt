package app.markiro.handheld.core.box

import androidx.room.withTransaction
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.PalletEntity
import app.markiro.handheld.core.storage.PalletPrint
import app.markiro.handheld.core.util.Iso

sealed interface ClosePalletResult {
    data class Closed(
        val pallet: PalletEntity,
        val sscc: String,
        val boxCount: Int,
        val closedAt: String,
    ) : ClosePalletResult

    /** No pallet is open, or the open one holds no boxes. Nothing was burned. */
    data object Empty : ClosePalletResult

    /** This issuer prefix's pool is dry. Nothing was burned and the pallet stays open. */
    data object NoSerials : ClosePalletResult

    /**
     * The burned serial cannot become a valid SSCC.
     *
     * Only reachable when this device holds a range reaching past its issuer
     * prefix's own capacity — a corrupted local pool. The serial is already
     * burned and cannot be given back, exactly as an abandoned pallet costs
     * one, and the pallet is left OPEN so the operator can try again rather
     * than being stranded half-closed. Surfaced by name so it is not repeated
     * silently until the whole invalid block is spent.
     */
    data object InvalidSerial : ClosePalletResult

    /** The shift carries no SSCC issuer, so no pallet of it can ever be numbered. */
    data object NoIssuer : ClosePalletResult
}

/**
 * Closes the shift's open pallet.
 *
 * `CloseBox` one level up, keeping every one of its invariants for the exact
 * same reasons: emptiness is checked BEFORE burning, so a pallet closed
 * before any box joined it (or closed by mistake) costs no serial; burning
 * and closing are ONE `db.withTransaction`, because a serial that leaves the
 * pool without landing on a pallet is gone and the pool has no way to give
 * one back; and the `AlreadyClosed` rollback takes the burn back with it if
 * the guarded close affects no row.
 *
 * `CloseBox` calls this automatically once a box closing brings the open
 * pallet to capacity, and the operator's own «Закрыть паллету досрочно» calls
 * it directly. Those are separate coroutines, so without the shared
 * [PalletLock] both could pass the open-pallet read together and each burn a
 * serial for the same pallet -- identical to why `CloseBox` guards itself
 * against its own automatic-close-at-capacity race.
 *
 * Both entry points take that lock BEFORE opening the transaction below, and
 * neither runs inside somebody else's: `CloseBox` commits its own box
 * transaction first and calls [close] with the lock still in hand. That single
 * order is what keeps the automatic and manual paths out of an ABBA deadlock,
 * and it also keeps the `AlreadyClosed` rollback local -- a nested
 * `withTransaction` that throws marks the OUTER transaction for rollback on
 * Android's SQLiteDatabase even when the exception is caught here.
 */
class ClosePallet(
    private val db: HandheldDatabase,
    private val pool: SsccPool,
    private val lock: PalletLock,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    /** Rolls the burn back when the guarded close turns out to affect no row. */
    private class AlreadyClosed : Exception()

    /** Closes the shift's open pallet, taking the pallet lock itself. */
    suspend fun close(shiftId: String, issuerPrefix: String?, operatorId: String?): ClosePalletResult =
        lock.withLock { held -> close(held, shiftId, issuerPrefix, operatorId) }

    /**
     * [close] for a caller that already holds the lock -- `CloseBox`, which
     * holds it across the box transaction it just committed so no other
     * coroutine can close this pallet, or open a different one, in between.
     */
    suspend fun close(
        held: PalletLock.Held,
        shiftId: String,
        issuerPrefix: String?,
        operatorId: String?,
    ): ClosePalletResult {
        lock.requireHeld(held)
        lock.requireNoTransaction("Closing a pallet")
        if (issuerPrefix == null) return ClosePalletResult.NoIssuer
        val pallet = db.palletDao().open(shiftId) ?: return ClosePalletResult.Empty
        val boxCount = db.palletDao().boxCount(pallet.palletId)
        if (boxCount == 0) return ClosePalletResult.Empty

        // Burning and closing are ONE transaction. A serial that leaves the
        // pool without landing on a pallet is gone -- the pool has no way to
        // give one back -- so the guarded update failing has to take the
        // burn with it.
        return try {
            db.withTransaction {
                val serial = pool.burn(issuerPrefix, SsccPool.PALLET_EXTENSION_DIGIT)
                    ?: return@withTransaction ClosePalletResult.NoSerials
                val sscc = try {
                    Sscc.build(SsccPool.PALLET_EXTENSION_DIGIT, issuerPrefix, serial)
                } catch (_: SsccException) {
                    // The serial IS spent here, deliberately: see CloseBox's
                    // identical InvalidSerial case for why rolling back
                    // would only hand the same impossible serial out again.
                    return@withTransaction ClosePalletResult.InvalidSerial
                }
                // The pallet's own moment, persisted: the label's «Дата
                // производства» and «Годен до» derive from it, and a
                // recovery print the next morning must stamp the same two
                // dates rather than that morning's.
                val closedAt = Iso.format(clock())
                if (db.palletDao().close(pallet.palletId, sscc, closedAt, operatorId) == 0) {
                    throw AlreadyClosed()
                }
                ClosePalletResult.Closed(
                    pallet = pallet.copy(
                        sscc = sscc,
                        closedAt = closedAt,
                        operatorId = operatorId,
                        printState = PalletPrint.PENDING,
                        printReason = null,
                    ),
                    sscc = sscc,
                    boxCount = boxCount,
                    closedAt = closedAt,
                )
            }
        } catch (_: AlreadyClosed) {
            ClosePalletResult.Empty
        }
    }
}
