package app.markiro.handheld.core.box

import app.markiro.handheld.core.storage.BoxEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.util.Iso
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

sealed interface CloseResult {
    data class Closed(
        val box: BoxEntity,
        val sscc: String,
        val itemCount: Int,
        val closedAt: String,
        /**
         * What happened to the pallet this box joined (06d), or null when the
         * shift carries no pallet capacity at all (`palletBoxCapacity == null`)
         * or the joined pallet had not yet reached it. Reaching capacity closes
         * the pallet as part of THIS same close, so the operator gets one
         * outcome for one scan rather than a box confirmation followed by a
         * separate, easy-to-miss pallet event.
         */
        val pallet: ClosePalletResult? = null,
    ) : CloseResult

    /** No box is open, or the open one holds nothing. Nothing was burned. */
    data object Empty : CloseResult

    /** This issuer prefix's pool is dry. Nothing was burned and the box stays open. */
    data object NoSerials : CloseResult

    /**
     * The burned serial cannot become a valid SSCC.
     *
     * Only reachable when this device holds a range reaching past its issuer
     * prefix's own capacity — a corrupted local pool. The serial is already
     * burned and cannot be given back, exactly as an abandoned box costs one,
     * and the box is left OPEN so the operator can try again rather than being
     * stranded half-closed. Surfaced by name so it is not repeated silently
     * until the whole invalid block is spent.
     */
    data object InvalidSerial : CloseResult

    /** The shift carries no SSCC issuer, so no box of it can ever be numbered. */
    data object NoIssuer : CloseResult
}

/**
 * Closes the shift's open box.
 *
 * The order of the checks is the design, not an implementation detail.
 * Emptiness is tested BEFORE burning, so a box closed by mistake costs no
 * serial, and the serial is burned only once the pool actually yields one,
 * never pre-emptively. That is why a serial is burned here, at close, rather
 * than when the box was opened: a box abandoned at shift end then costs nothing
 * either.
 *
 * Pallets (06d): a closing box also joins the shift's open pallet and, at
 * capacity, closes it -- through `ClosePallet`, this class's own analogue one
 * level down.
 *
 * The box's closure and its pallet membership commit as ONE guarded UPDATE
 * (`BoxDao.close` carries `palletId`), because splitting them is what the
 * station's own task-14 review had to undo: two statements can be separated
 * by a drain or a power cut, and the membership is then lost with nothing left
 * to rebuild it from. Closing the PALLET, by contrast, is deliberately its own
 * transaction that runs after the box's has committed -- see [close] for why
 * nesting it was a deadlock waiting for the manual early-close button, and why
 * splitting it costs nothing: a pallet left open at capacity is the same
 * recoverable state a dry serial pool already produces.
 */
class CloseBox(
    private val db: HandheldDatabase,
    private val boxes: BoxRepository,
    private val pool: SsccPool,
    private val pallets: PalletRepository,
    private val closePallet: ClosePallet,
    private val palletLock: PalletLock,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    /**
     * One close at a time. The automatic close at capacity and «Закрыть короб
     * досрочно» are separate coroutines, so without this both can pass the
     * open-box read and each burn a serial for the same box.
     */
    private val mutex = Mutex()

    /** Rolls the burn back when the guarded close turns out to affect no row. */
    private class AlreadyClosed : Exception()

    /** What the box's own transaction settled, before the pallet it filled is closed. */
    private data class BoxOutcome(val result: CloseResult, val palletAtCapacity: Boolean)

    /**
     * Closes the shift's open box and, at capacity, the pallet it just filled.
     *
     * The outer lease is `recovery.exclusive`, not `recovery.commit`: the whole
     * close runs under ONE device generation, so a credential rejected halfway
     * through cannot leave a box closed against an owner the device no longer
     * is -- but `exclusive` holds that lease WITHOUT opening a Room transaction,
     * which is what lets `palletLock` still be taken outside one. The
     * transaction itself is opened by the `recovery.commit` below, exactly as
     * wide as the burn-and-close it has to be atomic over.
     *
     * The lock order is the design, and it is the SAME order on every path:
     * **recovery lease, then `palletLock`, then the transaction.** `palletLock`
     * is taken BEFORE the box transaction opens and held across both it and the
     * pallet close that may follow, so every path through pallets -- this one,
     * a standalone «Закрыть паллету досрочно», `PalletRepository.currentPallet`
     * -- runs lease-then-lock-then-transaction. Taking any two of the three the
     * other way round on one path, as calling `closePallet.close` from inside
     * this transaction did, is the ABBA shape: the automatic close holds the
     * write transaction waiting for the lock while the manual close holds the
     * lock waiting for the transaction.
     */
    suspend fun close(shiftId: String, issuerPrefix: String?, operatorId: String?): CloseResult =
        db.recovery.exclusive { closeOwned(shiftId, issuerPrefix, operatorId) }

    private suspend fun closeOwned(shiftId: String, issuerPrefix: String?, operatorId: String?): CloseResult = mutex.withLock {
        if (issuerPrefix == null) return CloseResult.NoIssuer
        val box = db.boxDao().open(shiftId) ?: return CloseResult.Empty
        val itemCount = boxes.itemCount(box.boxId)
        if (itemCount == 0) return CloseResult.Empty

        // Taken unconditionally, even for a shift with no pallets at all: a
        // lock acquired only on some paths is how an ordering rule rots.
        return palletLock.withLock { held ->
            // Burning and closing are ONE transaction. A serial that leaves the
            // pool without landing on a box is gone -- the pool has no way to give
            // one back -- so the guarded update failing has to take the burn with it.
            val outcome = try {
                db.recovery.commit {
                    val serial = pool.burn(issuerPrefix, SsccPool.BOX_EXTENSION_DIGIT)
                        ?: return@commit BoxOutcome(CloseResult.NoSerials, false)
                    val sscc = try {
                        Sscc.build(SsccPool.BOX_EXTENSION_DIGIT, issuerPrefix, serial)
                    } catch (_: SsccException) {
                        // The serial IS spent here, deliberately: the pool row is
                        // beyond its prefix's capacity and rolling back would hand the
                        // same impossible serial out again on the next attempt.
                        return@commit BoxOutcome(CloseResult.InvalidSerial, false)
                    }
                    // The box's own moment, persisted: the label's «Дата производства»
                    // and «Годен до» derive from it, and a recovery print the next
                    // morning must stamp the same two dates rather than that morning's.
                    val closedAt = Iso.format(clock())

                    // Pallets (06d): a box joins the shift's open pallet at CLOSE
                    // time, never at open -- same as the station. `palletBoxCapacity
                    // == null` means the shift carries no pallets at all, so nothing
                    // joins. Resolved inside this transaction, holding the lock
                    // already, so a pallet opened here is rolled back with the box
                    // whose close failed rather than left behind empty. The count is
                    // read BEFORE this box's own row lands, so the `+ 1` below counts
                    // this box exactly once, matching the station's
                    // `boxCount + 1 >= palletBoxCapacity`.
                    val capacity = db.shiftDao().get(shiftId)?.palletBoxCapacity
                    // The paired device's own id, threaded through rather than left
                    // null: the station's equivalent guard is keyed on
                    // `(shiftId, terminalId)`, and a pallet row that never carries
                    // which terminal opened it cannot answer that question later.
                    val terminalId = db.deviceConfigDao().get()?.deviceId
                    val pallet = if (capacity != null) pallets.currentPallet(held, shiftId, terminalId) else null
                    val boxCountBeforeJoin = pallet?.let { db.palletDao().boxCount(it.palletId) } ?: 0

                    // Closure and membership in ONE guarded statement: see the class
                    // comment, and the station's `close-box.ts`, for why they must not
                    // be two.
                    if (db.boxDao().close(box.boxId, sscc, closedAt, operatorId, pallet?.palletId) == 0) {
                        throw AlreadyClosed()
                    }

                    BoxOutcome(
                        CloseResult.Closed(
                            box = box.copy(
                                sscc = sscc,
                                closedAt = closedAt,
                                operatorId = operatorId,
                                printState = BoxPrint.PENDING,
                                printReason = null,
                                palletId = pallet?.palletId,
                            ),
                            sscc = sscc,
                            itemCount = itemCount,
                            closedAt = closedAt,
                        ),
                        palletAtCapacity = pallet != null && capacity != null &&
                            boxCountBeforeJoin + 1 >= capacity,
                    )
                }
            } catch (_: AlreadyClosed) {
                BoxOutcome(CloseResult.Empty, false)
            }

            val closed = outcome.result
            if (!outcome.palletAtCapacity || closed !is CloseResult.Closed) return@withLock closed

            // The box is committed; the pallet closes in its OWN transaction,
            // with the lock still held so nothing can close this pallet or open
            // another one in between.
            //
            // One over-capacity pallet, never a second: if the pallet pool is dry
            // this returns NoSerials and the SAME pallet stays open, over capacity,
            // for the next box to retry -- exhaustion blocks closing a pallet, never
            // scanning or closing a box.
            closed.copy(pallet = closePallet.close(held, shiftId, issuerPrefix, operatorId))
        }
    }
}
