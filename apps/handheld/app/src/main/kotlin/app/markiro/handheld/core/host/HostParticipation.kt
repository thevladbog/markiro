package app.markiro.handheld.core.host

import app.markiro.handheld.core.network.host.HostApi
import app.markiro.handheld.core.network.host.HostApiError
import app.markiro.handheld.core.network.host.HostFailure
import app.markiro.handheld.core.storage.DeviceConfigDao
import app.markiro.handheld.core.storage.HandheldDatabase
import kotlinx.serialization.json.Json
import retrofit2.HttpException
import java.io.IOException

/**
 * What the heartbeat does for shifts several devices work (plan 2b): sends the leaves still owed to the host, and, while a shift is this device's
 * active one, reads the host's list again so the strip's shift-wide figures follow the others' scans (a scan takes no host revision, so there is nothing
 * to wait for: the beat is the poll, every 15 s). Nothing here runs for a cloud device.
 */
class HostParticipation(
    private val db: HandheldDatabase,
    private val api: () -> HostApi,
    private val calls: HostCalls,
    private val store: ShiftParticipationStore = ShiftParticipationStore(db),
    private val config: DeviceConfigDao = db.deviceConfigDao(),
) {
    private val json = Json { ignoreUnknownKeys = true }

    /** One beat that reached the host. A failure of either part is that part's: the next beat repeats it. */
    suspend fun beat() {
        val cfg = config.get() ?: return
        if (cfg.backend != "host") return
        flushLeaves()
        if (cfg.activeShiftId != null && refresh()) rejoinLeftPart(cfg.activeShiftId)
    }

    /** One beat that did not reach the host: the figures of the shift being worked are the last known ones. */
    suspend fun markStale() {
        val cfg = config.get() ?: return
        if (cfg.backend != "host") return
        cfg.activeShiftId?.let { store.markStale(it) }
    }

    /** Reads the host's shift list into the store. `true` when the host answered; `false` marks the worked shift's figures stale. */
    suspend fun refresh(): Boolean {
        val cfg = config.get() ?: return false
        if (cfg.backend != "host") return false
        return try {
            store.save(calls.run { api().shifts() }.shifts)
            true
        } catch (_: IOException) {
            cfg.activeShiftId?.let { store.markStale(it) }
            false
        } catch (_: HttpException) {
            // A refusal (409 STATION_UPDATE_REQUIRED and the like) gave no figures either: what is kept is the last known, not current.
            cfg.activeShiftId?.let { store.markStale(it) }
            false
        }
    }

    /**
     * Each owed leave is its own: one the host keeps failing never holds the others back. A leave is sent only while the local row still says the
     * device is out: an entry since (online or offline) writes `leftAt = null` and the owed leave is dropped, so a late leave never undoes a
     * re-entry. Only the host's definite refusals of THIS shift settle one ([settles]: it holds no slot of this device, or no such shift); every other
     * failure keeps it owed, because it may still succeed. A failure that says the host cannot be reached (no answer, another certificate, a rejected
     * key) ends the pass: the rest would fail the same way and each would cost a timeout; the next beat starts over.
     */
    private suspend fun flushLeaves() {
        for (owed in store.owedLeaves()) {
            val shiftId = owed.shiftId
            if (!owed.stillOut) {
                store.clearLeavePending(shiftId, owed.marker)
                continue
            }
            try {
                // With this device's token as read together with the marker: a leave of an earlier stay changes nothing on the host, which
                // answers the part still `active`. The row says the device is out, so `active` means the host still holds a slot this device
                // does not use (final review I2): the leave stays owed, and the answer kept here carries the current token, so the next beat
                // ends the stay the host actually has. Any other state settles it.
                val answered = calls.run { api().leave(shiftId, owed.joinedRev) }
                store.save(answered)
                if (answered.myState != "active") store.clearLeavePending(shiftId, owed.marker)
            } catch (e: HttpException) {
                if (OwedLeaveRefusals.settles(e)) store.clearLeavePending(shiftId, owed.marker)
            } catch (e: IOException) {
                if (OwedLeaveRefusals.settles(e)) store.clearLeavePending(shiftId, owed.marker) else if (hostNotReached(e)) return
            }
        }
    }

    private fun hostNotReached(e: IOException): Boolean = when ((e.cause as? HostApiError)?.failure) {
        null, HostFailure.Unreachable, HostFailure.Timeout, HostFailure.CertificateMismatch, HostFailure.KeyRejected -> true
        else -> false
    }

    /**
     * A part the host has as `left` while this device is working the shift (the pause was made with the link up and the work continued offline, or
     * the pause landed after the entry) holds no slot: the host would give it to another device. With the host's answer just read, the shift active
     * here, no leave owed and the device not out of it, the device enters again and keeps the answer. A full line (`shift_line_full`) or any failure
     * changes nothing kept: production goes on (the scans are facts the host takes from a left part) and the next beat asks again.
     */
    private suspend fun rejoinLeftPart(shiftId: String) {
        if (store.get(shiftId)?.myState != "left") return
        val row = db.shiftDao().get(shiftId) ?: return
        if (row.status != "active" || row.leftAt != null || shiftId in store.pendingLeaves()) return
        try {
            store.save(calls.run { api().enter(shiftId) })
        } catch (_: IOException) {
            // The host did not answer: nothing was changed and the next beat reads the list and asks again.
        } catch (_: HttpException) {
            // Refused (a full line, a closed shift): nothing was changed; production goes on and the next beat asks again.
        }
    }
}

/**
 * The host's definite refusals of ONE shift's leave: it holds no slot of this device (`shift_not_entered`), or no such shift (`not_found`), or the
 * request was invalid (`validation_failed`). Only these settle an owed leave; every other failure may still succeed, so the leave stays owed.
 */
internal object OwedLeaveRefusals {
    private val json = Json { ignoreUnknownKeys = true }

    fun settles(e: HttpException): Boolean {
        val code = runCatching {
            json.decodeFromString(app.markiro.handheld.core.network.ErrorBody.serializer(), e.response()?.errorBody()?.string().orEmpty()).code
        }.getOrNull()
        return e.code() == 409 && code == "shift_not_entered"
    }

    /** `not_found` (404) and `validation_failed` (400) of the host's own envelope (found anywhere in the cause chain: a wrapper may add a layer): a body that is not one (a proxy's page) settles nothing. */
    fun settles(e: IOException): Boolean {
        val cause = generateSequence<Throwable>(e) { it.cause }.filterIsInstance<HostApiError>().firstOrNull() ?: return false
        return (cause.status == 404 && cause.code == "not_found") || (cause.status == 400 && cause.code == "validation_failed")
    }
}
