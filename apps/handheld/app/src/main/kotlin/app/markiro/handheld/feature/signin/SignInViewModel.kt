package app.markiro.handheld.feature.signin

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.core.auth.OperatorAuth
import app.markiro.handheld.core.auth.OperatorRecord
import app.markiro.handheld.core.scan.ScanEvent
import app.markiro.handheld.core.scan.ScanEvents
import app.markiro.handheld.core.scan.ScanRouterAdapter
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

enum class SignInError { WRONG_PIN, NOT_FOUND, BADGE_UNKNOWN, ROSTER_EMPTY }

sealed interface SignInUi {
    data class Login(val login: String = "", val error: SignInError? = null) : SignInUi
    data class Pin(
        val login: String,
        val operatorName: String?,
        val pin: String = "",
        val error: SignInError? = null,
        val lockMode: Boolean = false,
    ) : SignInUi
    data class Search(val query: String = "", val results: List<OperatorRecord> = emptyList()) : SignInUi
}

@HiltViewModel
class SignInViewModel @Inject constructor(
    private val auth: OperatorAuth,
    private val session: SessionHolder,
    scans: ScanEvents,
) : ViewModel() {
    /** Test seam: scans as a bare flow. */
    constructor(auth: OperatorAuth, session: SessionHolder, scans: Flow<ScanEvent>) : this(auth, session, ScanRouterAdapter(scans))

    private val _state = MutableStateFlow<SignInUi>(initial())
    val state: StateFlow<SignInUi> = _state

    init {
        viewModelScope.launch { scans.events.collect { onScan(it.raw) } }
    }

    private fun initial(): SignInUi {
        val current = session.state.value
        return if (current.locked && current.operator != null) {
            SignInUi.Pin(current.operator.login, current.operator.name, lockMode = true)
        } else {
            SignInUi.Login()
        }
    }

    fun onDigit(digit: Char) = _state.update { s ->
        when (s) {
            is SignInUi.Login -> if (s.login.length < 12) s.copy(login = s.login + digit, error = null) else s
            is SignInUi.Pin -> if (s.pin.length < 6) s.copy(pin = s.pin + digit, error = null) else s
            is SignInUi.Search -> s
        }
    }

    fun onBackspace() = _state.update { s ->
        when (s) {
            is SignInUi.Login -> s.copy(login = s.login.dropLast(1))
            is SignInUi.Pin -> s.copy(pin = s.pin.dropLast(1))
            is SignInUi.Search -> s
        }
    }

    fun onConfirm() {
        when (val s = _state.value) {
            is SignInUi.Login -> {
                val login = OperatorAuth.padLogin(s.login) ?: return
                _state.value = SignInUi.Pin(login, operatorName = null)
                viewModelScope.launch {
                    val name = auth.byLoginOnly(login)?.name
                    _state.update { p -> if (p is SignInUi.Pin && p.login == login) p.copy(operatorName = name) else p }
                }
            }
            is SignInUi.Pin -> {
                if (s.pin.length < 4) return
                viewModelScope.launch {
                    val operator = auth.byLogin(s.login, s.pin)
                    if (operator == null) {
                        _state.update { p -> if (p is SignInUi.Pin) p.copy(pin = "", error = SignInError.WRONG_PIN) else p }
                    } else {
                        session.signIn(operator)
                    }
                }
            }
            is SignInUi.Search -> Unit
        }
    }

    fun openSearch() {
        _state.value = SignInUi.Search()
    }

    fun onSearchQuery(query: String) {
        _state.value = SignInUi.Search(query)
        viewModelScope.launch {
            val results = auth.search(query)
            _state.update { s -> if (s is SignInUi.Search && s.query == query) s.copy(results = results) else s }
        }
    }

    fun onPickOperator(operator: OperatorRecord) {
        _state.value = SignInUi.Pin(operator.login, operator.name)
    }

    fun back() {
        _state.value = SignInUi.Login()
    }

    fun switchOperator() {
        session.signOut()
        _state.value = SignInUi.Login()
    }

    fun onScan(raw: String) {
        viewModelScope.launch {
            val operator = auth.byBadge(raw)
            if (operator != null) {
                session.signIn(operator)
            } else {
                _state.update { s ->
                    when (s) {
                        is SignInUi.Login -> s.copy(error = SignInError.BADGE_UNKNOWN)
                        is SignInUi.Pin -> s.copy(error = SignInError.BADGE_UNKNOWN)
                        is SignInUi.Search -> s
                    }
                }
            }
        }
    }
}
