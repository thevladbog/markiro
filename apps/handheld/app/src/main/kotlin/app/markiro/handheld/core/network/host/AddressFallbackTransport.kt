package app.markiro.handheld.core.network.host

import java.util.concurrent.atomic.AtomicReference

/**
 * One host behind several addresses (the payload of the pairing code lists them, a DHCP lease may move the host to another): a call goes to the
 * address that answered last, and when it does not answer, to the others in order. Every address is asked through a transport pinned to the same
 * certificate, so an address whose certificate is not the pinned one is a failure like any other and never a result: nothing it says is read.
 * The failure returned when no address answers is the one of the first address of the list (the paired one), the most informative.
 *
 * Only an address that did not answer (unreachable, timed out, or a refused certificate) hands the call on. A host that answered, with any
 * status, has answered. A request that is repeated on another address is idempotent by the ids it carries (facts, events, blocks).
 */
class AddressFallbackTransport(
    private val origins: List<String>,
    private val transportFor: (String) -> HostTransport,
    private val active: AtomicReference<String?>,
) : HostTransport {
    private fun order(): List<String> {
        val first = active.get()?.takeIf { it in origins }
        return if (first == null) origins else listOf(first) + origins.filter { it != first }
    }

    private suspend fun attempt(call: suspend (HostTransport) -> HostResult): HostResult {
        var primary: HostResult? = null
        for (origin in order()) {
            val result = call(transportFor(origin))
            if (result is HostResult.Ok) {
                active.set(origin)
                return result
            }
            if (primary == null || origin == origins.firstOrNull()) primary = result
        }
        return primary ?: HostResult.Failed(TransportFailure.UNREACHABLE)
    }

    override suspend fun get(path: String): HostResult = attempt { it.get(path) }

    override suspend fun post(path: String, body: String): HostResult = attempt { it.post(path, body) }
}
