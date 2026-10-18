package app.markiro.handheld.core.host

import app.markiro.handheld.core.network.host.HelloDto
import app.markiro.handheld.core.network.host.HostApi
import app.markiro.handheld.core.network.host.HostApiError
import app.markiro.handheld.core.network.host.HostFailure
import app.markiro.handheld.core.storage.DeviceConfigDao
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.time.Instant
import kotlin.math.abs

data class HostObservation(val restored: Boolean, val clockSkew: Boolean, val skewMs: Long?)

/** What the screens read of the link: `reachable` is `null` before the first heartbeat. */
data class HostLinkState(
    val reachable: Boolean? = null,
    val restoreEpochChanged: Boolean = false,
    val clockSkewMs: Long? = null,
    val failure: HostFailure? = null,
)

/**
 * What a `hello` says about the link (spec 8.5, point 7, risk Р-6): a restore of the host (its `restoreEpoch` changed since the one this device
 * knew) and a gap of more than two minutes between the host's clock and the device's, which spoils the order in which codes are displaced.
 */
class HostLinkMonitor(private val now: () -> Long, private val onRestore: (String?) -> Unit) {
    private val mutable = MutableStateFlow(HostLinkState())
    val state: StateFlow<HostLinkState> = mutable

    fun observe(hello: HelloDto, knownEpoch: String?): HostObservation {
        val epoch = hello.restoreEpoch
        val restored = epoch != null && knownEpoch != null && epoch != knownEpoch
        if (restored) onRestore(epoch)
        val host = hello.time?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }
        val skew = host?.let { it - now() }
        val observation = HostObservation(restored, skew != null && abs(skew) > MAX_SKEW_MS, skew)
        mutable.value = HostLinkState(reachable = true, restoreEpochChanged = restored, clockSkewMs = skew, failure = null)
        return observation
    }

    /**
     * One beat: `GET /v1/hello` with the device's pin. The epoch the device knows moves only when it is safe: the first one is remembered
     * at once, a changed one only after [register] (telling the host the blocks the device holds) succeeded, so a failed registration is
     * repeated on the next beat.
     */
    suspend fun heartbeat(api: HostApi, config: DeviceConfigDao, beforeRestore: suspend (HelloDto) -> Unit = {}, register: suspend () -> Result<Unit>): Result<HostObservation> {
        val hello = api.hello().getOrElse { error ->
            mutable.value = mutable.value.copy(reachable = false, failure = (error as? HostApiError)?.failure)
            return Result.failure(error)
        }
        beforeRestore(hello)
        val known = config.get()?.hostRestoreEpoch
        val observation = observe(hello, known)
        val epoch = hello.restoreEpoch
        val remember = when {
            epoch == null || epoch == known -> false
            observation.restored -> register().isSuccess
            else -> true
        }
        if (remember) config.get()?.let { config.upsert(it.copy(hostRestoreEpoch = epoch)) }
        return Result.success(observation)
    }

    companion object {
        const val MAX_SKEW_MS = 2 * 60 * 1000L
    }
}
