package app.markiro.handheld.core.grants

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.RecoveryPhase
import app.markiro.handheld.core.storage.RecoveryState
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.isActive
import javax.inject.Inject

enum class GrantEvidenceStatus { OBSERVED, REVIEW_REQUIRED }

enum class GrantStatus { OBSERVE, STRICT, REFRESH_REQUIRED, CLOCK_UNTRUSTED }

internal fun grantStatus(state: GrantStateEntity?, session: RecoveryState, sample: ClockSample): GrantStatus {
    if (state == null || state.mode == "observe") return GrantStatus.OBSERVE
    if (session.phase != RecoveryPhase.ACTIVE || state.generation != session.generation ||
        state.ownerKey != session.owner?.grantOwnerKey()) return GrantStatus.REFRESH_REQUIRED
    if (!state.clockValid || assessClock(TrustedClock(state.serverMs, state.monotonicMs, state.bootId,
            state.serverHighWater, state.wallHighWater), sample) !is ClockAssessment.Trusted) return GrantStatus.CLOCK_UNTRUSTED
    return GrantStatus.STRICT
}

/** Read-only settings diagnostic. It never substitutes for productive admission. */
@HiltViewModel
class GrantStatusViewModel @Inject constructor(
    private val db: HandheldDatabase,
    private val refresher: GrantRefresher,
) : ViewModel() {
    private val ticks = flow {
        while (currentCoroutineContext().isActive) {
            emit(Unit)
            delay(1000)
        }
    }
    val status = combine(db.grantDao().observeState(), db.recovery.state, ticks) { state, session, _ ->
        grantStatus(state, session, db.grants.sample())
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), null)

    val evidenceStatus = combine(db.recovery.state, ticks) { session, _ ->
        val value = session.owner?.let { db.metaDao().get(GrantEvidenceTransport.diagnosticKey(it.grantOwnerKey())) }
        when (value) {
            "observed" -> GrantEvidenceStatus.OBSERVED
            "review" -> GrantEvidenceStatus.REVIEW_REQUIRED
            else -> null
        }
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), null)

    fun refresh() = refresher.nudge()
}
