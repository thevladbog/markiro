package app.markiro.handheld

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.core.network.RevocationBus
import app.markiro.handheld.core.storage.DeviceConfigDao
import app.markiro.handheld.core.storage.DeviceWipe
import app.markiro.handheld.feature.signin.SessionHolder
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import javax.inject.Inject

enum class StartDestination { PAIRING, SIGN_IN, HUB }

sealed interface ShellEvent {
    data object Revoked : ShellEvent
    data object Locked : ShellEvent
}

@HiltViewModel
class AppShellViewModel(
    private val config: DeviceConfigDao,
    private val session: SessionHolder,
    revocation: RevocationBus,
    private val wipe: DeviceWipe,
    private val idleMs: Long,
) : ViewModel() {
    @Inject
    constructor(config: DeviceConfigDao, session: SessionHolder, revocation: RevocationBus, wipe: DeviceWipe) :
        this(config, session, revocation, wipe, idleMs = IDLE_LOCK_MS)

    private val _start = MutableStateFlow<StartDestination?>(null)
    val start: StateFlow<StartDestination?> = _start
    private val _events = MutableSharedFlow<ShellEvent>(extraBufferCapacity = 1)
    val events: SharedFlow<ShellEvent> = _events
    private var idleJob: Job? = null

    init {
        viewModelScope.launch {
            val paired = config.observe().first() != null
            _start.value = when {
                !paired -> StartDestination.PAIRING
                session.state.value.operator != null && !session.state.value.locked -> StartDestination.HUB
                else -> StartDestination.SIGN_IN
            }
        }
        viewModelScope.launch {
            revocation.events.collect {
                wipe.wipeAll()
                session.signOut()
                _events.emit(ShellEvent.Revoked)
            }
        }
    }

    /** Called by the activity on every touch or key; five idle minutes lock a signed-in session. */
    fun onUserInteraction() {
        idleJob?.cancel()
        if (session.state.value.operator == null || session.state.value.locked) return
        idleJob = viewModelScope.launch {
            delay(idleMs)
            session.lock()
            _events.emit(ShellEvent.Locked)
        }
    }

    companion object {
        const val IDLE_LOCK_MS = 5 * 60 * 1000L
    }
}
