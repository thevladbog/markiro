package app.markiro.handheld.feature.pairing

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.core.storage.DeviceRecovery
import app.markiro.handheld.core.storage.RecoveryPhase
import app.markiro.handheld.core.storage.RecoveryState
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/** Which pairing screen the device is owed. A device is the cloud's or a host's for life, so only a new device chooses. */
enum class PairingSource { LOADING, CHOOSE, CLOUD, HOST }

fun pairingSourceOf(state: RecoveryState): PairingSource = when {
    state.phase == RecoveryPhase.UNINITIALIZED -> PairingSource.LOADING
    state.owner?.pinSha256 != null -> PairingSource.HOST
    state.owner != null || state.phase == RecoveryPhase.OWNER_UNRESOLVED -> PairingSource.CLOUD
    else -> PairingSource.CHOOSE
}

@HiltViewModel
class PairingSourceViewModel @Inject constructor(private val recovery: DeviceRecovery) : ViewModel() {
    private val _source = MutableStateFlow(PairingSource.LOADING)
    val source: StateFlow<PairingSource> = _source

    init {
        viewModelScope.launch {
            // A failure to read the owner leaves the cloud screen, which shows its own recovery failure.
            _source.value = runCatching { recovery.initialize(); pairingSourceOf(recovery.current()) }.getOrDefault(PairingSource.CLOUD)
        }
    }
}
