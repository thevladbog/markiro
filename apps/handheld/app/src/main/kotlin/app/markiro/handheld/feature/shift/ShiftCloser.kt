package app.markiro.handheld.feature.shift

import android.database.sqlite.SQLiteConstraintException
import androidx.room.withTransaction
import app.markiro.handheld.core.km.Verdict
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.ShiftCloseEntity
import app.markiro.handheld.core.util.Iso
import java.util.UUID

/** Port of the station's closeShiftOffline: the close is a durable local fact before any network. */
class ShiftCloser(private val db: HandheldDatabase, private val clock: () -> Long = System::currentTimeMillis) {
    data class Preview(
        val accepted: Int,
        val errors: Int,
        val duplicates: Int,
        val plan: Int?,
        val reasonRequired: Boolean,
        val alreadyClosed: Boolean,
        /** Duplicate labels still unresolved. Closing warns about them; it never waits. */
        val outstandingDuplicates: Int = 0,
    )

    suspend fun preview(shiftId: String): Preview? {
        val shift = db.shiftDao().get(shiftId) ?: return null
        val accepted = db.codeDao().countForShift(shiftId)
        val errors = db.scanEventDao().count(shiftId, Verdict.INVALID.wire) + db.scanEventDao().count(shiftId, Verdict.WRONG_GTIN.wire)
        val duplicates = db.scanEventDao().count(shiftId, Verdict.DUPLICATE.wire)
        return Preview(
            accepted = accepted,
            errors = errors,
            duplicates = duplicates,
            plan = shift.plannedQty,
            reasonRequired = reasonRequired(shift.plannedQty, accepted),
            alreadyClosed = db.shiftCloseDao().forShift(shiftId) != null,
            outstandingDuplicates = db.productLabelJobDao().outstandingCount(shiftId),
        )
    }

    /** Idempotent per shift: a second call returns the stored row and re-applies the local close. */
    suspend fun close(shiftId: String, operatorId: String?, reasonCode: String?): ShiftCloseEntity = db.withTransaction {
        db.shiftCloseDao().forShift(shiftId)?.let { existing ->
            finishLocally(shiftId)
            return@withTransaction existing
        }
        val shift = db.shiftDao().get(shiftId) ?: error("shift $shiftId is not on this device")
        val accepted = db.codeDao().countForShift(shiftId)
        val reason = reasonCode?.takeIf { it in REASONS }
        require(!reasonRequired(shift.plannedQty, accepted) || reason != null) { "A valid close reason is required" }
        val row = ShiftCloseEntity(
            eventId = UUID.randomUUID().toString(),
            shiftId = shiftId,
            operatorId = operatorId,
            plannedQtySnapshot = shift.plannedQty,
            actualQty = accepted,
            closedBoxCount = 0,
            reasonCode = reason,
            closedAt = Iso.format(clock()),
            state = "pending",
            conflictCode = null,
            lastCheckedAt = null,
        )
        try {
            db.shiftCloseDao().insert(row)
        } catch (_: SQLiteConstraintException) {
            finishLocally(shiftId)
            return@withTransaction checkNotNull(db.shiftCloseDao().forShift(shiftId))
        }
        finishLocally(shiftId)
        row
    }

    private suspend fun finishLocally(shiftId: String) {
        db.shiftDao().setStatus(shiftId, "closed")
        db.deviceConfigDao().get()?.let { if (it.activeShiftId == shiftId) db.deviceConfigDao().upsert(it.copy(activeShiftId = null)) }
        // Duplicate-label retention, in two steps and in this order.
        //
        // The prepared bytes exist only so a reprint can replay them, and a
        // reprint into a closed shift is not a thing -- a shift's worth of
        // labels would otherwise grow without bound on a fixed disk. They go for
        // every job here, settled or not, so an unresolved one survives as a
        // record without costing anything.
        //
        // The rows themselves go only once the server holds every one of their
        // events, which is why this runs after the close rather than instead of
        // it: closing never waits on the queue.
        db.productLabelJobDao().dropBytesForShift(shiftId)
        db.productLabelJobDao().purgeSettled(shiftId)
    }

    companion object {
        val REASONS = listOf(
            "production_defect",
            "material_shortage",
            "equipment_stop",
            "production_order_changed",
            "planned_quantity_error",
            "other_production_deviation",
        )

        fun reasonRequired(plannedQty: Int?, actualQty: Int): Boolean = plannedQty != null && plannedQty != actualQty
    }
}
