package app.markiro.handheld.feature.shift

import app.markiro.handheld.core.host.ShiftParticipation
import app.markiro.handheld.core.util.Iso

/** What the work screen's strip shows of a shared shift (plan 2b). `staleAtMillis` is non-null while the figures are the last known ones. */
data class SharedStrip(
    val mine: Int,
    val total: Int,
    val plan: Int?,
    val active: Int,
    val maxStations: Int,
    val staleAtMillis: Long?,
    /** The host has this device's part as `left` and every slot of the line taken: work goes on, the slot comes back when one frees up. */
    val lineFull: LineFullNotice? = null,
)

/** «Линия занята: N из M» while this device works a shift whose host part is left (final review I4); the numbers are the host's. */
data class LineFullNotice(val active: Int, val maxStations: Int)

/**
 * The rules of a shift several devices work, as a handheld can apply them from the host's last answer. Pure and deterministic: the clock is an
 * argument. The reason rule mirrors `shift_participants::reason_need` of the host and is pinned by `shift-close-reason-shared.json`.
 */
object SharedShiftRules {
    /** How old the host's answer may be for this device to still believe it knows who else keeps the shift open (the beat is 15 s). */
    const val FRESH_MS = 90_000L

    /** The line allows several devices, or several have worked this shift. With one device and a limit of one nothing is shown or changed. */
    fun isShared(p: ShiftParticipation?): Boolean = p != null && ((p.maxStations ?: 1) >= 2 || p.participantsEver >= 2)

    fun isFresh(p: ShiftParticipation?, now: Long): Boolean = p != null && !p.stale && now - p.fetchedAt <= FRESH_MS

    /**
     * This device's own part: everything it has counted, delivered or not, less the [lost] codes (`CodeDao.lostForShift`: answered `conflict` or
     * `rejected`) and less the acknowledged codes the host's last snapshot no longer credits to it ([ShiftParticipation.displaced], PR #775): the
     * host gave those to another device. Never negative; without a snapshot, the count less the lost ones.
     */
    fun own(p: ShiftParticipation?, localAccepted: Int, lost: Int): Int = (localAccepted - lost - (p?.displaced ?: 0)).coerceAtLeast(0)

    /**
     * What the others delivered (the host's total less this device's own delivered share) plus this device's [own] part: the lost and displaced codes
     * are inside the others' part already and would count twice (the station's `sharedCount(lost)` with its displaced kind, final review I2, PR #775);
     * [lost] is required, never defaulted, so a caller cannot forget it.
     */
    fun shiftTotal(p: ShiftParticipation?, localAccepted: Int, lost: Int): Int {
        val own = own(p, localAccepted, lost)
        val accepted = p?.accepted ?: return own
        val others = (accepted - (p.myAccepted ?: 0L)).coerceAtLeast(0L)
        return (others + own).coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
    }

    /**
     * Whether this close should ask for a reason now. One device ever in the shift (or no figures, or an older host): stage 2a's rule on its own
     * count. A shared shift: only the last closer, only with fresh figures, by the shift-wide total against the plan; every other case closes
     * without a reason and the host marks a shared shift's missing one for the office.
     */
    fun reasonRequired(plan: Int?, localAccepted: Int, p: ShiftParticipation?, now: Long, lost: Int): Boolean {
        // A close that leaves the shift open never asks (the host's `closesShift = false` is `none`), whatever the device count says.
        if (p != null && p.othersOpen > 0) return false
        if (p == null || p.participantsEver <= 1) return ShiftCloser.reasonRequired(plan, localAccepted)
        if (!isFresh(p, now)) return false
        return plan != null && plan != shiftTotal(p, localAccepted, lost)
    }

    fun strip(p: ShiftParticipation?, localAccepted: Int, plan: Int?, lost: Int): SharedStrip? {
        if (p == null || !isShared(p)) return null
        return SharedStrip(
            mine = own(p, localAccepted, lost),
            total = shiftTotal(p, localAccepted, lost),
            plan = plan,
            active = p.active,
            maxStations = p.maxStations ?: p.participantsEver.coerceAtLeast(1),
            staleAtMillis = if (p.stale) p.asOf?.let(Iso::parse) ?: p.fetchedAt else null,
            lineFull = lineFull(p),
        )
    }

    /** The part is `left` at the host and every slot is taken: the rejoin of each beat is refused until one frees up. Only with the host's own limit. */
    fun lineFull(p: ShiftParticipation): LineFullNotice? {
        val max = p.maxStations ?: return null
        return if (p.myState == "left" && p.active >= max) LineFullNotice(p.active, max) else null
    }
}
