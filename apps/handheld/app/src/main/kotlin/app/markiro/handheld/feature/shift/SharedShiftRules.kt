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
)

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
     * What the others delivered (the host's total less this device's own delivered share) plus everything this device has counted, delivered or not,
     * less the [lost] codes (answered `conflict`, held in `conflicts_mirror`): the host gave those to another device, so they are inside the others'
     * part already and would count twice (the station's `sharedCount(lost)`, final review I2). Never below the device's own count.
     */
    fun shiftTotal(p: ShiftParticipation?, localAccepted: Int, lost: Int = 0): Int {
        val own = (localAccepted - lost).coerceAtLeast(0)
        val accepted = p?.accepted ?: return own
        val others = (accepted - (p.myAccepted ?: 0L)).coerceAtLeast(0L)
        return (others + own).coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
    }

    /**
     * Whether this close should ask for a reason now. One device ever in the shift (or no figures, or an older host): stage 2a's rule on its own
     * count. A shared shift: only the last closer, only with fresh figures, by the shift-wide total against the plan; every other case closes
     * without a reason and the host marks a shared shift's missing one for the office.
     */
    fun reasonRequired(plan: Int?, localAccepted: Int, p: ShiftParticipation?, now: Long, lost: Int = 0): Boolean {
        // A close that leaves the shift open never asks (the host's `closesShift = false` is `none`), whatever the device count says.
        if (p != null && p.othersOpen > 0) return false
        if (p == null || p.participantsEver <= 1) return ShiftCloser.reasonRequired(plan, localAccepted)
        if (!isFresh(p, now)) return false
        return plan != null && plan != shiftTotal(p, localAccepted, lost)
    }

    fun strip(p: ShiftParticipation?, localAccepted: Int, plan: Int?, lost: Int = 0): SharedStrip? {
        if (p == null || !isShared(p)) return null
        return SharedStrip(
            mine = (localAccepted - lost).coerceAtLeast(0),
            total = shiftTotal(p, localAccepted, lost),
            plan = plan,
            active = p.active,
            maxStations = p.maxStations ?: p.participantsEver.coerceAtLeast(1),
            staleAtMillis = if (p.stale) p.asOf?.let(Iso::parse) ?: p.fetchedAt else null,
        )
    }
}
