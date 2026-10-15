package app.markiro.handheld.feature.pairing

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.core.network.host.CertPin
import app.markiro.handheld.core.network.host.HostApiError
import app.markiro.handheld.core.network.host.HostCompat
import app.markiro.handheld.core.network.host.HostCompatibility
import app.markiro.handheld.core.network.host.HostFailure
import app.markiro.handheld.core.network.host.HostPairingGateway
import app.markiro.handheld.core.network.host.Observed
import app.markiro.handheld.core.network.host.PairedDto
import app.markiro.handheld.core.scan.ScanEvent
import app.markiro.handheld.core.scan.ScanEvents
import app.markiro.handheld.core.storage.DeviceOwner
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

enum class HostPairingError {
    ADDRESS_INVALID, CODE_INVALID, UNREACHABLE, TIMEOUT, NOT_A_HOST, HOST_TOO_OLD, APP_TOO_OLD, NO_ADDRESS_MATCHES,
    PAIRING_INVALID, PAIRING_EXPIRED, RATE_LIMITED, SEAT_LIMIT, FEATURE_DISABLED, CERTIFICATE_MISMATCH, OTHER, SYNC_FAILED,
}

sealed interface HostPairingUi {
    data class Enter(
        val address: String,
        val code: String,
        val error: HostPairingError? = null,
        /** The device was paired before: the address is its own and the form asks only for the new code. */
        val repairing: Boolean = false,
    ) : HostPairingUi

    /** The person compares `display` with the office's screen. `changed`: the host presents another certificate than the paired one. */
    data class Verify(val address: String, val display: String, val changed: Boolean) : HostPairingUi
    data object Binding : HostPairingUi
    data class Failed(val error: HostPairingError, val canRetrySync: Boolean = false) : HostPairingUi
    data object Success : HostPairingUi
}

@HiltViewModel
class HostPairingViewModel(
    private val gateway: HostPairingGateway,
    private val store: HostProvisioningStore,
    private val bootstrap: HostBootstrap,
    /** The sealed owner of a device that was paired with a host, or `null` for a new device. */
    private val owner: DeviceOwner?,
    /** The scanner: a scan of the office's DataMatrix pairs without typing. */
    scans: Flow<ScanEvent> = emptyFlow(),
) : ViewModel() {
    @javax.inject.Inject
    constructor(
        gateway: HostPairingGateway,
        store: HostProvisioningStore,
        bootstrap: HostBootstrap,
        recovery: app.markiro.handheld.core.storage.DeviceRecovery,
        scans: ScanEvents,
    ) : this(gateway, store, bootstrap, recovery.current().owner?.takeIf { it.pinSha256 != null }, scans.events)

    private val ownerAddress = owner?.let { it.serverOrigin.toHttpUrlOrNull()?.host }
    private val ownerPort = owner?.let { it.serverOrigin.toHttpUrlOrNull()?.port } ?: DEFAULT_PORT
    private val _state = MutableStateFlow<HostPairingUi>(HostPairingUi.Enter(ownerAddress.orEmpty(), "", repairing = owner != null))
    val state: StateFlow<HostPairingUi> = _state

    private class Pending(val address: String, val port: Int, val addresses: List<String>, val code: String, val observed: Observed, val changed: Boolean)

    private var pending: Pending? = null
    private var paired: Triple<PairedDto, Pending, Boolean>? = null

    init {
        viewModelScope.launch { scans.collect { onScan(it.raw) } }
    }

    fun onAddress(text: String) = _state.update { s -> if (s is HostPairingUi.Enter && !s.repairing) s.copy(address = text.trim().replace(',', '.'), error = null) else s }

    fun onCode(text: String) = _state.update { s -> if (s is HostPairingUi.Enter) s.copy(code = text, error = null) else s }

    fun onContinue() {
        val form = _state.value as? HostPairingUi.Enter ?: return
        val address = form.address.trim()
        if (!isIpv4(address)) return fail(form, HostPairingError.ADDRESS_INVALID)
        val code = HostPairingCode.normalize(form.code) ?: return fail(form, HostPairingError.CODE_INVALID)
        _state.value = HostPairingUi.Binding
        viewModelScope.launch {
            val port = if (owner != null) ownerPort else DEFAULT_PORT
            val observed = gateway.observe(address, port).getOrElse { return@launch failed(it) }
            compatibilityError(observed)?.let { return@launch _state.update { _ -> HostPairingUi.Failed(it) } }
            proceed(Pending(address, port, listOf(address), code, observed, changed = owner?.pinSha256 != null && owner.pinSha256 != observed.fingerprint))
        }
    }

    /** A scan of the office's DataMatrix: the code goes only to the address whose certificate is the payload's `f`. */
    fun onScan(raw: String) {
        if (_state.value !is HostPairingUi.Enter) return
        val payload = HostPairingCode.parsePayload(raw) ?: return
        _state.value = HostPairingUi.Binding
        viewModelScope.launch {
            val seen = coroutineScope {
                payload.addresses.map { address -> async { address to gateway.observe(address, payload.port) } }.awaitAll()
            }
            val match = seen.firstOrNull { (_, result) -> result.getOrNull()?.fingerprint == payload.fingerprint }
            if (match == null) return@launch _state.update { _ -> HostPairingUi.Failed(HostPairingError.NO_ADDRESS_MATCHES) }
            val observed = checkNotNull(match.second.getOrNull())
            compatibilityError(observed)?.let { return@launch _state.update { _ -> HostPairingUi.Failed(it) } }
            // The payload carries the fingerprint of the office's own screen: no second comparison by eye.
            val ordered = listOf(match.first) + payload.addresses.filter { it != match.first }
            // A device that has an owner and meets another certificate than its pin: the person confirms before the one-time code is spent.
            val changed = owner?.pinSha256 != null && owner.pinSha256 != observed.fingerprint
            val next = Pending(match.first, payload.port, ordered, payload.code, observed, changed)
            if (!changed) return@launch claim(next)
            pending = next
            _state.value = HostPairingUi.Verify(next.address, CertPin.display(next.observed.fingerprint), changed = true)
        }
    }

    fun onFingerprintConfirmed() {
        val next = pending ?: return
        if (_state.value !is HostPairingUi.Verify) return
        _state.value = HostPairingUi.Binding
        viewModelScope.launch { claim(next) }
    }

    /** «Не совпадает»: nothing was sent, back to the form. */
    fun onFingerprintRejected() {
        pending = null
        _state.value = HostPairingUi.Enter(ownerAddress.orEmpty(), "", repairing = owner != null)
    }

    fun onRetry() {
        if (_state.value is HostPairingUi.Failed) _state.value = HostPairingUi.Enter(ownerAddress.orEmpty(), "", repairing = owner != null)
    }

    /** The claim succeeded and the first sync did not: only the sync is repeated (a code is one-time). */
    fun onRetrySync() {
        val done = paired ?: return
        _state.value = HostPairingUi.Binding
        viewModelScope.launch { finish(done.first, done.second, done.third) }
    }

    private suspend fun proceed(next: Pending) {
        // The person compares the fingerprint of a typed address; a re-pairing with the certificate it already trusts needs no comparison.
        if (owner != null && !next.changed) return claim(next)
        pending = next
        _state.value = HostPairingUi.Verify(next.address, CertPin.display(next.observed.fingerprint), next.changed)
    }

    private suspend fun claim(next: Pending) {
        val result = gateway.claim(next.address, next.port, next.observed.fingerprint, next.code, owner?.deviceId)
        val pairing = result.getOrElse { return failed(it) }
        paired = Triple(pairing, next, next.changed)
        finish(pairing, next, next.changed)
    }

    private suspend fun finish(pairing: PairedDto, next: Pending, changedPin: Boolean) {
        runCatching {
            store.persist(pairing, "https://${next.address}:${next.port}", next.observed.fingerprint, next.addresses, changedPin)
        }.onFailure { return _state.update { _ -> HostPairingUi.Failed(HostPairingError.OTHER) } }
        val synced = bootstrap.initialSync()
        _state.value = if (synced.isSuccess) HostPairingUi.Success else HostPairingUi.Failed(HostPairingError.SYNC_FAILED, canRetrySync = true)
    }

    private fun compatibilityError(observed: Observed): HostPairingError? = when (
        HostCompat.decide(HostCompat.PROTOCOL, observed.hello.protocol, observed.hello.minProtocol)
    ) {
        HostCompatibility.HOST_TOO_OLD -> HostPairingError.HOST_TOO_OLD
        HostCompatibility.APP_TOO_OLD -> HostPairingError.APP_TOO_OLD
        HostCompatibility.COMPATIBLE -> if (observed.hello.product == "markiro-host") null else HostPairingError.NOT_A_HOST
    }

    private fun failed(cause: Throwable) {
        val failure = (cause as? HostApiError)?.failure
        _state.value = HostPairingUi.Failed(
            when (failure) {
                HostFailure.PairingInvalid -> HostPairingError.PAIRING_INVALID
                HostFailure.PairingExpired -> HostPairingError.PAIRING_EXPIRED
                HostFailure.RateLimited -> HostPairingError.RATE_LIMITED
                HostFailure.SeatLimit -> HostPairingError.SEAT_LIMIT
                HostFailure.FeatureDisabled -> HostPairingError.FEATURE_DISABLED
                HostFailure.CertificateMismatch -> HostPairingError.CERTIFICATE_MISMATCH
                HostFailure.Timeout -> HostPairingError.TIMEOUT
                HostFailure.Unreachable -> HostPairingError.UNREACHABLE
                else -> HostPairingError.OTHER
            },
        )
    }

    private fun fail(form: HostPairingUi.Enter, error: HostPairingError) {
        _state.value = form.copy(error = error)
    }

    private fun isIpv4(text: String): Boolean {
        val parts = text.split('.')
        return parts.size == 4 && parts.all { it.length in 1..3 && it.all(Char::isDigit) && it.toInt() <= 255 && (it == "0" || !it.startsWith("0")) }
    }

    private companion object {
        const val DEFAULT_PORT = 45710
    }
}
