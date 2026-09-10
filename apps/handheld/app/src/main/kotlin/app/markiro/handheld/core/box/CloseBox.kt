package app.markiro.handheld.core.box

import app.markiro.handheld.core.storage.BoxEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.util.Iso

sealed interface CloseResult {
    data class Closed(
        val box: BoxEntity,
        val sscc: String,
        val itemCount: Int,
        val closedAt: String,
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
 */
class CloseBox(
    private val db: HandheldDatabase,
    private val boxes: BoxRepository,
    private val pool: SsccPool,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    suspend fun close(shiftId: String, issuerPrefix: String?, operatorId: String?): CloseResult {
        if (issuerPrefix == null) return CloseResult.NoIssuer
        val box = db.boxDao().open(shiftId) ?: return CloseResult.Empty
        val itemCount = boxes.itemCount(box.boxId)
        if (itemCount == 0) return CloseResult.Empty

        val serial = pool.burn(issuerPrefix, SsccPool.BOX_EXTENSION_DIGIT) ?: return CloseResult.NoSerials
        val sscc = try {
            Sscc.build(SsccPool.BOX_EXTENSION_DIGIT, issuerPrefix, serial)
        } catch (_: SsccException) {
            return CloseResult.InvalidSerial
        }

        // The box's own moment, persisted: the label's «Дата производства» and
        // «Годен до» derive from it, and a recovery print the next morning must
        // stamp the same two dates rather than that morning's.
        val closedAt = Iso.format(clock())
        if (db.boxDao().close(box.boxId, sscc, closedAt, operatorId) == 0) return CloseResult.Empty
        return CloseResult.Closed(
            box = box.copy(
                sscc = sscc,
                closedAt = closedAt,
                operatorId = operatorId,
                printState = BoxPrint.PENDING,
                printReason = null,
            ),
            sscc = sscc,
            itemCount = itemCount,
            closedAt = closedAt,
        )
    }
}
