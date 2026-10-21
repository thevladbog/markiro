package app.markiro.handheld.core.host

import app.markiro.handheld.core.network.host.DeviceShiftDto
import app.markiro.handheld.core.storage.HandheldDatabase
import androidx.room.withTransaction
import app.markiro.handheld.core.storage.MetaEntity
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * What the host last said of a shift that several devices may work, reduced to what this device needs (plan 2b): the strip's figures and the
 * close rule. Derived, never a source of truth: it is rewritten from every answer of the host and losing it costs a refresh.
 */
@Serializable
data class ShiftParticipation(
    val shiftId: String,
    /** The line's limit of devices in one shift; `null` from a host that does not say. */
    val maxStations: Int? = null,
    /** This device's state at the host (`active|left|closed`); `null` when it never entered. */
    val myState: String? = null,
    /** Every device the shift ever had, this one included: only ever grows, so a stale value can only be too small. */
    val participantsEver: Int = 0,
    val active: Int = 0,
    /** Other devices whose part is still open (`active` or `left`): they keep the shift open after this device closes its part. */
    val othersOpen: Int = 0,
    /** The shift-wide accepted units as the host counted them at [asOf]. */
    val accepted: Long? = null,
    val boxesClosed: Int? = null,
    val pallets: Int? = null,
    /** What this device had delivered to the host at [asOf] (its `byDevice` row): the part of [accepted] that is its own. */
    val myAccepted: Long? = null,
    /** The host's clock when it counted, as it wrote it. */
    val asOf: String? = null,
    /** This device's clock when the answer was read: the freshness test of the close rule. */
    val fetchedAt: Long,
    /** The host did not answer the last beat: the figures are the last known ones. */
    val stale: Boolean = false,
    /** This device's own leave token (`participants[me].joinedRev`), echoed by the leave; `null` while no answer named one (an older host). */
    val joinedRev: Long? = null,
)

/** One leave still owed to the host: [marker] is what the pause wrote, [joinedRev] this device's token at the same read, [stillOut] whether the row says it is out. */
data class OwedLeave(val shiftId: String, val marker: String, val stillOut: Boolean, val joinedRev: Long?)

/** `null` for a shift that carries none of the protocol-7 fields (a planned shift, or an older host): there is nothing to remember. */
fun DeviceShiftDto.toParticipation(myDeviceId: String?, now: Long): ShiftParticipation? {
    if (maxStations == null && participants == null && totals == null && myState == null) return null
    val all = participants.orEmpty()
    return ShiftParticipation(
        shiftId = id,
        maxStations = maxStations,
        myState = myState,
        participantsEver = all.size,
        active = all.count { it.state == "active" },
        othersOpen = all.count { it.deviceId != myDeviceId && (it.state == "active" || it.state == "left") },
        accepted = totals?.accepted,
        boxesClosed = totals?.boxesClosed,
        pallets = totals?.pallets,
        myAccepted = byDevice?.firstOrNull { it.deviceId == myDeviceId }?.accepted,
        asOf = totals?.asOf,
        fetchedAt = now,
        joinedRev = all.firstOrNull { it.deviceId == myDeviceId }?.joinedRev,
    )
}

/**
 * The participation of each shift, the leaves still owed to the host and the host's remark on this device's close, as rows of `meta`
 * (a business table: a dataset reset clears it; no Room migration). Reads are cheap and tolerate a damaged value.
 */
class ShiftParticipationStore(
    private val db: HandheldDatabase,
    private val myDeviceId: suspend () -> String? = { db.deviceConfigDao().get()?.deviceId },
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    private fun decode(value: String?): ShiftParticipation? =
        value?.let { runCatching { json.decodeFromString(ShiftParticipation.serializer(), it) }.getOrNull() }

    private fun encode(row: ShiftParticipation) = json.encodeToString(ShiftParticipation.serializer(), row)

    suspend fun get(shiftId: String): ShiftParticipation? = decode(db.metaDao().get(key(shiftId)))

    fun observe(shiftId: String): Flow<ShiftParticipation?> = db.metaDao().observe(key(shiftId)).map { decode(it) }.distinctUntilChanged()

    /**
     * What to store for [shift] read as [row], over [stored]: the station's `COALESCE` against the stored row, for any status. The token stays when
     * the answer does not name it; an answer without `totals` (the list carries them for active shifts only, host D14 as amended, and a closed one
     * never) takes its participants and state over the stored figures, which stay with their `fetchedAt` and `stale`; an answer with `totals` but
     * without `byDevice` keeps the stored share of this device. A closed shift with nothing stored gives nothing (no figures to show, never zeros).
     */
    private fun merged(shift: DeviceShiftDto, row: ShiftParticipation, stored: ShiftParticipation?): ShiftParticipation? {
        val kept = row.copy(joinedRev = row.joinedRev ?: stored?.joinedRev)
        if (stored == null) return if (shift.totals == null && shift.status == "closed") null else kept
        val share = if (shift.byDevice == null) stored.myAccepted else kept.myAccepted
        if (shift.totals != null) return kept.copy(myAccepted = share)
        return kept.copy(
            accepted = stored.accepted,
            boxesClosed = stored.boxesClosed,
            pallets = stored.pallets,
            myAccepted = share,
            asOf = stored.asOf,
            fetchedAt = stored.fetchedAt,
            stale = stored.stale,
        )
    }

    /**
     * The station's rule (`UPSERT_PARTICIPATION_SQL`): a read older than the stored one (`asOf`, whole-second host instants in one format, so
     * the strings compare) changes nothing, so two overlapping refreshes never take the figures back, unless this device read the stored one
     * more than a minute before (a host clock set back must not freeze the figures).
     */
    private fun supersedes(row: ShiftParticipation, stored: ShiftParticipation?, now: Long): Boolean {
        if (stored == null) return true
        val incoming = row.asOf
        val known = stored.asOf
        if (incoming != null && (known == null || incoming >= known)) return true
        return now >= stored.fetchedAt + OVERRIDE_AFTER_MS
    }

    /**
     * One answer of the list: every shift that carries figures is rewritten (a closed one keeps the stored figures, see [merged]), every stored
     * shift the host no longer lists is forgotten.
     */
    suspend fun save(shifts: List<DeviceShiftDto>) {
        val me = myDeviceId()
        val now = clock()
        db.recovery.commit {
            val keep = mutableSetOf<String>()
            for (shift in shifts) {
                val read = shift.toParticipation(me, now) ?: continue
                val stored = decode(db.metaDao().get(key(shift.id)))
                val row = merged(shift, read, stored) ?: continue
                if (supersedes(row, stored, now)) db.metaDao().put(MetaEntity(key(shift.id), encode(row)))
                keep += shift.id
            }
            for (stored in db.metaDao().withPrefix(PREFIX)) {
                if (stored.key.removePrefix(PREFIX) !in keep) db.metaDao().remove(stored.key)
            }
            // A close note is read right after the close, while the shift is still listed; one for a shift the host dropped is an orphan.
            // An owed leave is kept: it is delivered or answered `not_found` by the caller, which clears it.
            for (note in db.metaDao().withPrefix(NOTE_PREFIX)) {
                if (note.key.removePrefix(NOTE_PREFIX) !in keep) db.metaDao().remove(note.key)
            }
        }
    }

    /** The answer of one call (an entry or a leave; it carries the figures for any non-planned status). */
    suspend fun save(shift: DeviceShiftDto) {
        val now = clock()
        val read = shift.toParticipation(myDeviceId(), now) ?: return
        db.recovery.commit {
            val stored = decode(db.metaDao().get(key(shift.id)))
            val row = merged(shift, read, stored) ?: return@commit
            if (supersedes(row, stored, now)) db.metaDao().put(MetaEntity(key(shift.id), encode(row)))
        }
    }

    /** The host did not answer: the stored figures stay, marked as the last known ones. A shift with no figures stays without. */
    suspend fun markStale(shiftId: String) {
        db.recovery.commit {
            val current = decode(db.metaDao().get(key(shiftId))) ?: return@commit
            if (!current.stale) db.metaDao().put(MetaEntity(key(shiftId), encode(current.copy(stale = true))))
        }
    }

    /**
     * The marker is the time of the pause, and strictly later than the one it replaces: a leave in flight settles only the marker it was sent for
     * ([clearLeavePending]), so a pause asked again must never be mistaken for the one already answered, whatever the clock says.
     */
    suspend fun markLeavePending(shiftId: String) = db.recovery.commit {
        val previous = db.metaDao().get(leaveKey(shiftId))?.toLongOrNull()
        val marker = clock().let { if (previous != null && previous >= it) previous + 1 else it }
        db.metaDao().put(MetaEntity(leaveKey(shiftId), marker.toString()))
    }

    suspend fun pendingLeaves(): List<String> = db.metaDao().withPrefix(LEAVE_PREFIX).map { it.key.removePrefix(LEAVE_PREFIX) }

    /**
     * Every owed leave with what the send needs, read in one transaction so the marker, the leave token and the device's own state in the shift
     * belong together: an entry cannot slip between the question «is it still out?» and the token the leave carries (a late leave of the
     * earlier stay would end the new one; with the token read here the host ignores it).
     */
    suspend fun owedLeaves(): List<OwedLeave> = db.withTransaction {
        db.metaDao().withPrefix(LEAVE_PREFIX).map { row ->
            val shiftId = row.key.removePrefix(LEAVE_PREFIX)
            OwedLeave(
                shiftId = shiftId,
                marker = row.value,
                stillOut = db.shiftDao().get(shiftId)?.leftAt != null,
                joinedRev = get(shiftId)?.joinedRev,
            )
        }
    }

    /** The station's `AND leave_requested_at = ?`: settles the pause that was sent, and leaves one asked again meanwhile (another marker) owed. */
    suspend fun clearLeavePending(shiftId: String, marker: String) = db.recovery.commit {
        if (db.metaDao().get(leaveKey(shiftId)) == marker) db.metaDao().remove(leaveKey(shiftId))
    }

    /** What the host answered to this device's close beyond «accepted» (`NOTE_*`); read by the close summary. */
    suspend fun noteClose(shiftId: String, note: String) = db.recovery.commit { db.metaDao().put(MetaEntity(closeNoteKey(shiftId), note)) }

    suspend fun closeNote(shiftId: String): String? = db.metaDao().get(closeNoteKey(shiftId))

    companion object {
        const val PREFIX = "shift_participation:"
        const val LEAVE_PREFIX = "shift_leave_pending:"
        private const val NOTE_PREFIX = "shift_close_note:"
        private const val OVERRIDE_AFTER_MS = 60_000L

        /** The part closed and the shift stays open for the others (`accepted {partClosed:true}`). */
        const val NOTE_PART_CLOSED = "part_closed"

        /** The shift closed with this close but without the reason its plan needed (`accepted {reasonMissing:true}`): the office supplies it. */
        const val NOTE_REASON_MISSING = "reason_missing"

        fun key(shiftId: String) = PREFIX + shiftId
        fun leaveKey(shiftId: String) = LEAVE_PREFIX + shiftId
        fun closeNoteKey(shiftId: String) = NOTE_PREFIX + shiftId
    }
}
