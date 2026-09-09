package app.markiro.handheld.feature.pairing

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.BuildConfig
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
    data class Enter(val code: String, val serverUrl: String, val serverEditable: Boolean) : PairingUi
    data object Binding : PairingUi
    data class Failed(val error: PairingError) : PairingUi
    data class Success(val organizationName: String, val lineName: String?) : PairingUi
}

@HiltViewModel
class PairingViewModel(
    private val gateway: PairingGateway,
    private val store: ProvisioningStore,
    scans: Flow<ScanEvent>,
    initialServerUrl: String,
    private val serverEditable: Boolean,
    private val onServerUrlChanged: (String) -> Unit = {},
) : ViewModel() {
    @Inject
    constructor(
        gateway: PairingGateway,
        store: ProvisioningStore,
        scans: ScanEvents,
        serverUrl: ServerUrlProvider,
    ) : this(
        gateway,
        store,
        scans.events,
        serverUrl.current(),
        BuildConfig.SERVER_URL_EDITABLE,
        onServerUrlChanged = { serverUrl.debugOverride = it },
    )

    private val _state = MutableStateFlow<PairingUi>(PairingUi.Enter("", initialServerUrl, serverEditable))
    val state: StateFlow<PairingUi> = _state
    private var serverUrl = initialServerUrl

    init {
        viewModelScope.launch { scans.collect { onScan(it.raw) } }
    }

    fun onDigit(digit: Char) = _state.update { s ->
        if (s is PairingUi.Enter && s.code.length < 8 && digit.isDigit()) s.copy(code = s.code + digit) else s
    }

    fun onBackspace() = _state.update { s -> if (s is PairingUi.Enter) s.copy(code = s.code.dropLast(1)) else s }

    fun onServerUrl(url: String) {
        if (!serverEditable) return
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
        _state.value = PairingUi.Enter("", serverUrl, serverEditable)
    }

    private fun redeem(code: String) {
        _state.value = PairingUi.Binding
        viewModelScope.launch {
            when (val result = gateway.redeem(serverUrl, code)) {
                is PairingResult.Failure -> _state.value = PairingUi.Failed(result.error)
                is PairingResult.Success -> {
                    store.persist(result.response, serverUrl)
                    _state.value = PairingUi.Success(result.response.device.organizationName, result.response.device.line?.name)
                }
            }
        }
    }

    private companion object {
        val CODE = Regex("^\\d{8}$")
    }
}
