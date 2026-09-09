package app.markiro.handheld.feature.signin

import app.markiro.handheld.core.auth.OperatorRecord
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update

data class SessionState(val operator: OperatorRecord? = null, val locked: Boolean = false)

/** In-memory operator session; the app shell locks it after idle time. */
class SessionHolder {
    private val _state = MutableStateFlow(SessionState())
    val state: StateFlow<SessionState> = _state

    fun signIn(operator: OperatorRecord) {
        _state.value = SessionState(operator, locked = false)
    }

    fun lock() = _state.update { if (it.operator != null) it.copy(locked = true) else it }

    fun unlock() = _state.update { it.copy(locked = false) }

    fun signOut() {
        _state.value = SessionState()
    }
}
