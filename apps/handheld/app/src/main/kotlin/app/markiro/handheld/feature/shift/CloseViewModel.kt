package app.markiro.handheld.feature.shift

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.sync.SyncEngine
import app.markiro.handheld.feature.signin.SessionHolder
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import javax.inject.Inject

enum class CloseOutcome { ACCEPTED, CONFLICT, PENDING }

sealed interface CloseStep {
    data object Loading : CloseStep
    data class Confirm(val preview: ShiftCloser.Preview) : CloseStep
    data class Reason(val preview: ShiftCloser.Preview, val selected: String?) : CloseStep
    data class Draining(val pending: Int) : CloseStep
    data class Summary(val accepted: Int, val errors: Int, val duplicates: Int, val conflicts: Int, val outcome: CloseOutcome) : CloseStep
}

@HiltViewModel
class CloseViewModel @Inject constructor(
    handle: SavedStateHandle,
    private val closer: ShiftCloser,
    private val sync: SyncEngine,
    private val db: HandheldDatabase,
    private val session: SessionHolder,
) : ViewModel() {
    val shiftId: String = checkNotNull(handle["shiftId"])
    private val _step = MutableStateFlow<CloseStep>(CloseStep.Loading)
    val step: StateFlow<CloseStep> = _step

    init {
        viewModelScope.launch {
            val preview = closer.preview(shiftId)
            _step.value = if (preview == null) CloseStep.Summary(0, 0, 0, 0, CloseOutcome.PENDING) else CloseStep.Confirm(preview)
        }
    }

    fun confirm() {
        val preview = (_step.value as? CloseStep.Confirm)?.preview ?: return
        if (preview.reasonRequired) _step.value = CloseStep.Reason(preview, null) else finish(preview, null)
    }

    fun selectReason(code: String) {
        val current = _step.value as? CloseStep.Reason ?: return
        _step.value = current.copy(selected = code)
    }

    fun submitReason() {
        val current = _step.value as? CloseStep.Reason ?: return
        val reason = current.selected ?: return
        finish(current.preview, reason)
    }

    /** Close locally first, then drain scans and the close itself; the summary reflects what the server answered. */
    private fun finish(preview: ShiftCloser.Preview, reason: String?) {
        viewModelScope.launch {
            _step.value = CloseStep.Draining(sync.state.value.pending)
            closer.close(shiftId, session.state.value.operator?.operatorId, reason)
            val watcher = launch { sync.state.collect { if (_step.value is CloseStep.Draining) _step.value = CloseStep.Draining(it.pending) } }
            sync.drainAll()
            watcher.cancel()
            val row = db.shiftCloseDao().forShift(shiftId)
            val outcome = when (row?.state) {
                null -> CloseOutcome.ACCEPTED
                "conflict" -> CloseOutcome.CONFLICT
                else -> CloseOutcome.PENDING
            }
            val conflicts = db.conflictDao().count().first()
            _step.value = CloseStep.Summary(preview.accepted, preview.errors, preview.duplicates, conflicts, outcome)
        }
    }
}
