package app.markiro.handheld.feature.signin

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.core.auth.BadgeCheck
import app.markiro.handheld.core.auth.LoginCheck
import app.markiro.handheld.core.auth.NotABadge
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
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import javax.inject.Inject

enum class SignInError {
    WRONG_PIN, NOT_FOUND, BADGE_UNKNOWN, ROSTER_EMPTY,

    /** The operator exists but is turned off (the cabinet or the host): said plainly, never «not found». */
    ACCESS_DENIED,

    /** A scan that was never tried as a badge: a product's DataMatrix, a code typed under another layout, or something that is not a badge. */
    BADGE_PRODUCT_CODE, BADGE_LAYOUT, BADGE_NOT_A_BADGE,
}

/** The roster the sign-in works from: how many operators the device holds, when they were read, and whether the last read failed. */
data class RosterInfo(
    /** `null` until the first count is taken. Zero means nobody can sign in yet. */
    val count: Int? = null,
    val fetchedAt: Long? = null,
    val refreshing: Boolean = false,
    val failed: Boolean = false,
)

sealed interface SignInUi {
    data class Login(val login: String = "", val error: SignInError? = null, val busy: Boolean = false) : SignInUi
    data class Pin(
        val login: String,
        val operatorName: String?,
        val pin: String = "",
        val error: SignInError? = null,
        val lockMode: Boolean = false,
        val busy: Boolean = false,
    ) : SignInUi
    data class Search(val query: String = "", val results: List<OperatorRecord> = emptyList(), val error: SignInError? = null) : SignInUi
}

@HiltViewModel
class SignInViewModel private constructor(
    private val recovery: app.markiro.handheld.core.storage.DeviceRecovery,
    private val auth: OperatorAuth,
    private val session: SessionHolder,
    scans: ScanEvents,
    private val source: RosterSource?,
    private val clock: () -> Long,
) : ViewModel() {
    @Inject constructor(
        recovery: app.markiro.handheld.core.storage.DeviceRecovery,
        auth: OperatorAuth,
        session: SessionHolder,
        scans: ScanEvents,
        source: RosterSource,
    ) : this(recovery, auth, session, scans, source, System::currentTimeMillis)

    /** Test seam: scans as a bare flow. */
    constructor(
        recovery: app.markiro.handheld.core.storage.DeviceRecovery,
        auth: OperatorAuth,
        session: SessionHolder,
        scans: Flow<ScanEvent>,
        source: RosterSource? = null,
        clock: () -> Long = System::currentTimeMillis,
    ) : this(recovery, auth, session, ScanRouterAdapter(scans), source, clock)

    private val _state = MutableStateFlow<SignInUi>(initial())
    val state: StateFlow<SignInUi> = _state

    private val _roster = MutableStateFlow(RosterInfo())
    val roster: StateFlow<RosterInfo> = _roster

    private val refreshLock = Mutex()
    private var lastRefreshAt: Long? = null

    private enum class Refresh { SKIPPED, OK, FAILED }

    init {
        viewModelScope.launch { scans.events.collect { onScan(it.raw) } }
        // A host roster is written by the feed, and nothing else reads the feed before a first sign-in: ask now, and show what is held meanwhile.
        viewModelScope.launch {
            publishRoster(failed = false)
            refreshRoster(force = true)
        }
    }

    private fun initial(): SignInUi {
        val current = session.state.value
        return if (current.locked && current.operator != null) {
            SignInUi.Pin(current.operator.login, current.operator.name, lockMode = true)
        } else {
            SignInUi.Login()
        }
    }

    private suspend fun publishRoster(failed: Boolean) {
        _roster.value = RosterInfo(auth.rosterSize(), source?.rosterFetchedAt(), refreshing = false, failed = failed)
    }

    /**
     * Reads the roster again unless it was read a moment ago (a scanner held on a wrong badge must not flood the host). Serialized: a scan that
     * meets a read in flight waits for it and uses its result.
     */
    private suspend fun refreshRoster(force: Boolean): Refresh {
        val src = source ?: return Refresh.SKIPPED
        return refreshLock.withLock {
            val last = lastRefreshAt
            if (!force && last != null && clock() - last in 0 until MIN_REFRESH_GAP_MS) return@withLock Refresh.SKIPPED
            _roster.update { it.copy(refreshing = true) }
            val ok = try {
                src.refreshRoster()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                false
            }
            lastRefreshAt = clock()
            publishRoster(failed = !ok)
            if (ok) Refresh.OK else Refresh.FAILED
        }
    }

    /** The «Обновить список» action: always asks the host. */
    fun refreshRosterNow() {
        viewModelScope.launch { refreshRoster(force = true) }
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
            is SignInUi.Login -> s.copy(login = s.login.dropLast(1), error = null)
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
                    var check = auth.checkLogin(login)
                    // A number the mirror does not know may be an operator the office added after this device last read the host.
                    if ((check is LoginCheck.Unknown || check is LoginCheck.EmptyRoster) && refreshRoster(force = false) == Refresh.OK) {
                        check = auth.checkLogin(login)
                    }
                    _state.update { p ->
                        if (p !is SignInUi.Pin || p.login != login) return@update p
                        when (check) {
                            is LoginCheck.Found -> p.copy(operatorName = check.operator.name)
                            LoginCheck.Unknown -> SignInUi.Login(s.login, SignInError.NOT_FOUND)
                            LoginCheck.Blocked -> SignInUi.Login(s.login, SignInError.ACCESS_DENIED)
                            LoginCheck.EmptyRoster -> SignInUi.Login(s.login, SignInError.ROSTER_EMPTY)
                        }
                    }
                }
            }
            is SignInUi.Pin -> {
                if (s.pin.length < 4 || s.busy) return
                viewModelScope.launch {
                    val token = tokenOrNull() ?: return@launch
                    _state.update { p -> if (p is SignInUi.Pin) p.copy(busy = true) else p }
                    val operator = auth.byLogin(s.login, s.pin)
                    if (!recovery.valid(token)) return@launch
                    if (operator == null) {
                        _state.update { p -> if (p is SignInUi.Pin) p.copy(pin = "", error = SignInError.WRONG_PIN, busy = false) else p }
                    } else {
                        _state.update { p -> if (p is SignInUi.Pin) p.copy(busy = false) else p }
                        recovery.guard(token) { session.signIn(operator) }
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

    /** A device being paired again has no active owner: a scan then has nobody to sign in to, and must not crash the screen. */
    private fun tokenOrNull() = try {
        recovery.token()
    } catch (_: app.markiro.handheld.core.storage.RecoveryBlocked) {
        null
    }

    private fun showError(error: SignInError) = _state.update { s ->
        when (s) {
            is SignInUi.Login -> s.copy(error = error, busy = false)
            is SignInUi.Pin -> s.copy(error = error, busy = false)
            is SignInUi.Search -> s.copy(error = error)
        }
    }

    private fun setBusy(busy: Boolean) = _state.update { s ->
        when (s) {
            is SignInUi.Login -> s.copy(busy = busy, error = if (busy) null else s.error)
            is SignInUi.Pin -> s.copy(busy = busy, error = if (busy) null else s.error)
            is SignInUi.Search -> if (busy) s.copy(error = null) else s
        }
    }

    /**
     * Every scan ends in one visible outcome: signed in, or the reason it was not (an empty roster, an unknown badge, a blocked operator, a
     * code that is no badge). A roster that is empty or may be stale is read from the host first, once per gap, and the badge checked again.
     */
    fun onScan(raw: String) {
        viewModelScope.launch {
            val token = tokenOrNull() ?: return@launch
            setBusy(true)
            var check = auth.checkBadge(raw)
            if ((check is BadgeCheck.Unknown || check is BadgeCheck.EmptyRoster) && refreshRoster(force = false) == Refresh.OK) {
                check = auth.checkBadge(raw)
            }
            if (!recovery.valid(token)) return@launch
            setBusy(false)
            when (check) {
                is BadgeCheck.Match -> recovery.guard(token) { session.signIn(check.operator) }
                BadgeCheck.Unknown -> showError(SignInError.BADGE_UNKNOWN)
                BadgeCheck.Blocked -> showError(SignInError.ACCESS_DENIED)
                BadgeCheck.EmptyRoster -> showError(SignInError.ROSTER_EMPTY)
                is BadgeCheck.Refused -> showError(
                    when (check.reason) {
                        NotABadge.PRODUCT_CODE -> SignInError.BADGE_PRODUCT_CODE
                        NotABadge.LAYOUT -> SignInError.BADGE_LAYOUT
                        NotABadge.NOT_BADGE -> SignInError.BADGE_NOT_A_BADGE
                    },
                )
            }
        }
    }

    private companion object {
        /** A miss reads the host again at most this often. */
        const val MIN_REFRESH_GAP_MS = 3_000L
    }
}
