package app.markiro.handheld.feature.shift

import android.database.sqlite.SQLiteConstraintException
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
        /**
         * Boxes and pallets this device closed, which design brief 10 §9 names
         * as part of the close summary.
         *
         * Null means "this shift does not have them" rather than zero: a
         * validation shift aggregates nothing and a shift without pallets closes
         * none, and a permanent «Паллеты 0» on every such close is noise the
         * operator learns to read past. Zero is reserved for the case that
         * actually deserves attention -- an aggregation shift that closed no
         * box.
         */
        val closedBoxes: Int? = null,
        val closedPallets: Int? = null,
    )

    suspend fun preview(shiftId: String): Preview? {
        val shift = db.shiftDao().get(shiftId) ?: return null
        val accepted = db.codeDao().countForShift(shiftId)
        val errors = db.scanEventDao().count(shiftId, Verdict.INVALID.wire) + db.scanEventDao().count(shiftId, Verdict.WRONG_GTIN.wire)
        val duplicates = db.scanEventDao().count(shiftId, Verdict.DUPLICATE.wire)
        val aggregation = shift.mode == "aggregation"
        return Preview(
            accepted = accepted,
            errors = errors,
            duplicates = duplicates,
            plan = shift.plannedQty,
            reasonRequired = reasonRequired(shift.plannedQty, accepted),
            alreadyClosed = db.shiftCloseDao().forShift(shiftId) != null,
            outstandingDuplicates = db.productLabelJobDao().outstandingCount(shiftId),
            closedBoxes = if (aggregation) db.boxDao().closedCount(shiftId) else null,
            closedPallets = if (aggregation && shift.palletsEnabled) db.palletDao().closedCount(shiftId) else null,
        )
    }

    /** Idempotent per shift: a second call returns the stored row and re-applies the local close. */
    suspend fun close(shiftId: String, operatorId: String?, reasonCode: String?): ShiftCloseEntity = db.recovery.commit { closeOwned(shiftId, operatorId, reasonCode) }

    private suspend fun closeOwned(shiftId: String, operatorId: String?, reasonCode: String?): ShiftCloseEntity = db.recovery.commit {
        db.shiftCloseDao().forShift(shiftId)?.let { existing ->
            finishLocally(shiftId)
            return@commit existing
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
            // Counted, not zero. This rides `/station/shift-closures` into
            // `station_shift_close_events.closed_box_count`, so a hardcoded 0
            // did not leave a number unshown -- it recorded a FALSE one, for
            // every shift a handheld has ever closed. Nothing reads that column
            // today, which is why no test caught it; the first report that does
            // would have been wrong retroactively.
            //
            // `closedCount` is the query the station already uses for the same
            // field (`apps/station/src/lib/shift-close.ts`): closed boxes on
            // this device for this shift, with no disassembly filter, because a
            // box that was closed and later taken apart was still closed.
            closedBoxCount = db.boxDao().closedCount(shiftId),
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
            return@commit checkNotNull(db.shiftCloseDao().forShift(shiftId))
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
