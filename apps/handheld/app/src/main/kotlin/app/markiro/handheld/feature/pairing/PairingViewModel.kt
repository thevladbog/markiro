package app.markiro.handheld.feature.pairing

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.BuildConfig
import app.markiro.handheld.core.storage.DeviceRecovery
import app.markiro.handheld.core.storage.RecoveryPhase
import app.markiro.handheld.core.storage.RecoveryMismatch
import app.markiro.handheld.core.network.RecoveryIdentity
import app.markiro.handheld.core.network.PairResponse
import app.markiro.handheld.core.network.PairingError
import app.markiro.handheld.core.network.PairingGateway
import app.markiro.handheld.core.network.PairingResult
import app.markiro.handheld.core.network.ServerUrlProvider
import app.markiro.handheld.core.scan.ScanEvent
import app.markiro.handheld.core.scan.ScanEvents
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

sealed interface PairingUi {
    data class Enter(val code: String, val serverUrl: String, val serverEditable: Boolean, val restoring: Boolean = false) : PairingUi
    data class Recovery(val deviceId: String?, val summary: Map<String, Long>?, val unresolved: Boolean) : PairingUi
    data object Binding : PairingUi
    data class Failed(val error: PairingError) : PairingUi
    data class Success(val organizationName: String, val lineName: String?, val restored: Boolean = false) : PairingUi
}

@HiltViewModel
class PairingViewModel(
    private val gateway: PairingGateway,
    private val store: ProvisioningStore,
    private val recovery: DeviceRecovery,
    scans: Flow<ScanEvent>,
    initialServerUrl: String,
    private val serverEditable: Boolean,
    private val onServerUrlChanged: (String) -> Unit = {},
) : ViewModel() {
    @Inject
    constructor(
        gateway: PairingGateway,
        store: ProvisioningStore,
        recovery: DeviceRecovery,
        scans: ScanEvents,
        serverUrl: ServerUrlProvider,
    ) : this(
        gateway,
        store,
        recovery,
        scans.events,
        serverUrl.current(),
        BuildConfig.SERVER_URL_EDITABLE,
        onServerUrlChanged = { serverUrl.debugOverride = it },
    )

    private val _state = MutableStateFlow<PairingUi>(PairingUi.Enter("", initialServerUrl, serverEditable))
    val state: StateFlow<PairingUi> = _state
    private var serverUrl = initialServerUrl
    private var candidate: PairResponse? = null
    private var restoring = false

    init {
        viewModelScope.launch {
            try {
                recovery.initialize()
                val current = recovery.current()
                restoring = current.owner != null
                current.owner?.let { serverUrl = it.serverOrigin }
                if (current.phase !in setOf(RecoveryPhase.ACTIVE, RecoveryPhase.UNPAIRED)) {
                    _state.value = PairingUi.Recovery(current.owner?.deviceId, runCatching { recovery.summary() }.getOrNull(), current.phase == RecoveryPhase.OWNER_UNRESOLVED)
                }
            } catch (_: Exception) { _state.value = PairingUi.Failed(PairingError.PUBLICATION_FAILED) }
        }
        viewModelScope.launch { scans.collect { onScan(it.raw) } }
    }

    fun onDigit(digit: Char) = _state.update { s ->
        if (s is PairingUi.Enter && s.code.length < 8 && digit.isDigit()) s.copy(code = s.code + digit) else s
    }

    fun onBackspace() = _state.update { s -> if (s is PairingUi.Enter) s.copy(code = s.code.dropLast(1)) else s }

    fun onServerUrl(url: String) {
        if (!serverEditable || recovery.current().owner != null) return
        serverUrl = url.trim()
        onServerUrlChanged(serverUrl)
        _state.update { s -> if (s is PairingUi.Enter) s.copy(serverUrl = serverUrl) else s }
    }

    fun onConfirm() {
        val s = _state.value as? PairingUi.Enter ?: return
        if (s.code.length != 8) return
        redeem(s.code)
    }

    fun onScan(raw: String) {
        if (_state.value !is PairingUi.Enter) return
        if (CODE.matches(raw)) redeem(raw)
    }

    fun retry() {
        if (candidate != null) {
            _state.value = PairingUi.Binding
            viewModelScope.launch { publish(checkNotNull(candidate)) }
        } else if (recovery.current().phase == RecoveryPhase.SEALING) {
            _state.value = PairingUi.Binding
            viewModelScope.launch {
                try {
                    recovery.initialize()
                    _state.value = PairingUi.Enter("", serverUrl, false, restoring = true)
                } catch (_: Exception) { _state.value = PairingUi.Failed(PairingError.PUBLICATION_FAILED) }
            }
        } else if (recovery.current().phase == RecoveryPhase.RESTORING) {
            _state.value = PairingUi.Binding
            viewModelScope.launch {
                try {
                    if (recovery.resumePublication()) {
                        _state.value = PairingUi.Success("", null, restored = true)
                    } else _state.value = PairingUi.Enter("", serverUrl, false, restoring = true)
                } catch (_: Exception) { _state.value = PairingUi.Failed(PairingError.PUBLICATION_FAILED) }
            }
        } else if (recovery.current().phase != RecoveryPhase.OWNER_UNRESOLVED) {
            _state.value = PairingUi.Enter("", serverUrl, serverEditable && !restoring, restoring)
        }
    }

    private suspend fun publish(response: PairResponse) {
        try {
            store.persist(response, serverUrl)
            candidate = null
            _state.value = PairingUi.Success(response.device.organizationName, response.device.line?.name, restoring)
        } catch (_: RecoveryMismatch) {
            candidate = null
            _state.value = PairingUi.Failed(PairingError.RECOVERY_MISMATCH)
        } catch (_: Exception) { _state.value = PairingUi.Failed(PairingError.PUBLICATION_FAILED) }
    }

    private fun redeem(code: String) {
        _state.value = PairingUi.Binding
        viewModelScope.launch {
            recovery.initialize()
            val current = recovery.current()
            if (current.phase == RecoveryPhase.OWNER_UNRESOLVED) {
                _state.value = PairingUi.Failed(PairingError.OWNER_UNRESOLVED)
                return@launch
            }
            val owner = current.owner
            restoring = owner != null
            val result = if (owner == null && current.phase == RecoveryPhase.UNPAIRED) gateway.redeem(serverUrl, code)
                else if (owner != null && current.phase == RecoveryPhase.SEALED) {
                    serverUrl = owner.serverOrigin
                    gateway.recover(serverUrl, code, RecoveryIdentity(owner.tenantId, owner.deviceId, owner.kind))
                } else PairingResult.Failure(PairingError.PUBLICATION_FAILED)
            when (result) {
                is PairingResult.Failure -> _state.value = PairingUi.Failed(result.error)
                is PairingResult.Success -> {
                    candidate = result.response
                    publish(result.response)
                }
            }
        }
    }

    private companion object {
        val CODE = Regex("^\\d{8}$")
    }
}
