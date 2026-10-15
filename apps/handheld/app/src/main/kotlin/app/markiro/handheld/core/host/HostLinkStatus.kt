package app.markiro.handheld.core.host

import app.markiro.handheld.core.network.host.HostFailure
import kotlin.math.abs

/**
 * What the screens say of the link with the host. The line never stops for any of them: [scanningAllowed] is `true` for every value, and a
 * test holds the enum to that (a state that blocked scanning would stop a factory line for a host that is restarting or a clock that is wrong).
 */
enum class HostLinkStatus(val scanningAllowed: Boolean = true) {
    /** The host answered its last heartbeat. */
    Online,

    /** No answer: the work goes on, the queue waits. */
    Offline,

    /** The host is being restored from a copy (it says so, or its epoch changed and this device has not yet told it its blocks). */
    Restoring,

    /** The host's clock and the device's differ by more than two minutes: the order in which codes are displaced would suffer. */
    ClockSkew,
    ;

    companion object {
        const val MAX_SKEW_SECONDS = 120L

        fun of(reachable: Boolean, restoring: Boolean, skewSeconds: Long): HostLinkStatus = when {
            !reachable -> Offline
            restoring -> Restoring
            abs(skewSeconds) > MAX_SKEW_SECONDS -> ClockSkew
            else -> Online
        }

        /** `null` before the first heartbeat: nothing is known, nothing is claimed. */
        fun of(state: HostLinkState): HostLinkStatus? {
            val reachable = state.reachable ?: return null
            // A host that answers "restoring" is not reachable for work, but it is not gone either.
            if (state.failure is HostFailure.RestorePending) return Restoring
            return of(reachable, state.restoreEpochChanged, (state.clockSkewMs ?: 0L) / 1000L)
        }
    }
}
