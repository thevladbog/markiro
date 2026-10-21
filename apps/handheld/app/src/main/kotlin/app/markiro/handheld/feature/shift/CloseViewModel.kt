package app.markiro.handheld.feature.shift

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.core.host.ShiftParticipationStore
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.sync.SyncDriver
import app.markiro.handheld.feature.signin.SessionHolder
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import javax.inject.Inject

enum class CloseOutcome { ACCEPTED, CONFLICT, PENDING, PART_CLOSED, REASON_MISSING }

sealed interface CloseStep {
    data object Loading : CloseStep
    data class Confirm(val preview: ShiftCloser.Preview) : CloseStep
    data class Reason(val preview: ShiftCloser.Preview, val selected: String?) : CloseStep
    data class Draining(val pending: Int) : CloseStep
    /** `boxes`/`pallets` are null when the shift has none; see [ShiftCloser.Preview]. */
    data class Summary(
        val accepted: Int,
        val errors: Int,
        val duplicates: Int,
        val conflicts: Int,
        val outcome: CloseOutcome,
        val boxes: Int? = null,
        val pallets: Int? = null,
        /** The close was of this device's part of a shared shift. */
        val part: Boolean = false,
    ) : CloseStep
}

@HiltViewModel
class CloseViewModel @Inject constructor(
    handle: SavedStateHandle,
    private val closer: ShiftCloser,
    private val sync: SyncDriver,
    private val db: HandheldDatabase,
    private val session: SessionHolder,
) : ViewModel() {
    companion object {
        /**
         * The outcome the summary reports from the close row's state and the host's note on it (plan 2b): a close the host accepted with
         * `partClosed` or `reasonMissing` says so; a conflict or a close still queued stays what it was, whatever an older note says.
         */
        fun outcomeOf(rowState: String?, note: String?): CloseOutcome = when (rowState) {
            null, "accepted" -> when (note) {
                ShiftParticipationStore.NOTE_PART_CLOSED -> CloseOutcome.PART_CLOSED
                ShiftParticipationStore.NOTE_REASON_MISSING -> CloseOutcome.REASON_MISSING
                else -> CloseOutcome.ACCEPTED
            }
            "conflict" -> CloseOutcome.CONFLICT
            else -> CloseOutcome.PENDING
        }
    }

    val grantDenial = app.markiro.handheld.core.grants.GrantDenialUi()

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
            try { closer.close(shiftId, session.state.value.operator?.operatorId, reason) }
            catch (_: app.markiro.handheld.core.grants.GrantDenied) {
                _step.value=CloseStep.Confirm(preview)
                grantDenial.show()
                return@launch
            }
            val watcher = launch { sync.state.collect { if (_step.value is CloseStep.Draining) _step.value = CloseStep.Draining(it.pending) } }
            sync.drainAll()
            watcher.cancel()
            val row = db.shiftCloseDao().forShift(shiftId)
            val outcome = outcomeOf(row?.state, ShiftParticipationStore(db).closeNote(shiftId))
            val conflicts = db.conflictDao().count().first()
            _step.value = CloseStep.Summary(
                preview.accepted, preview.errors, preview.duplicates, conflicts, outcome,
                boxes = preview.closedBoxes, pallets = preview.closedPallets, part = preview.shared,
            )
        }
    }
}
