package app.markiro.handheld.feature.exceptions

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.R
import app.markiro.handheld.core.box.BoxPrinter
import app.markiro.handheld.core.box.Sscc
import app.markiro.handheld.core.exceptions.ExceptionEngine
import app.markiro.handheld.core.exceptions.ReprintReason
import app.markiro.handheld.core.scan.ScanEvents
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.feature.signin.SessionHolder
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/** A closed box offered for reprint, named the way the operator reads it. */
data class ReprintTarget(val boxId: String, val ordinal: Int, val sscc: String)

data class ReprintUi(
    val last: ReprintTarget? = null,
    val selected: ReprintTarget? = null,
    val done: Boolean = false,
    val error: Int? = null,
)

/**
 * Reprint a closed box's label, unchanged, at the same SSCC.
 *
 * The audit fact is queued BEFORE the print job goes out: it records the
 * operator's request, not the printer's outcome. Those are separate facts, and
 * a label that jams after the request was made is still a request that was made.
 */
@HiltViewModel
class ReprintViewModel @Inject constructor(
    private val db: HandheldDatabase,
    private val engine: ExceptionEngine,
    private val printer: BoxPrinter,
    private val session: SessionHolder,
    scans: ScanEvents,
    handle: SavedStateHandle,
) : ViewModel() {
    private val shiftId: String = handle.get<String>("shiftId").orEmpty()
    private val _state = MutableStateFlow(ReprintUi())
    val state: StateFlow<ReprintUi> = _state

    init {
        viewModelScope.launch {
            _state.value = _state.value.copy(last = firstReprintable())
        }
        viewModelScope.launch {
            scans.events.collect { event ->
                if (_state.value.selected != null || _state.value.done) return@collect
                val sscc = Sscc.parse(event.raw) ?: return@collect fail(R.string.reprint_unknown_sscc)
                val boxId = db.boxDao().boxIdBySscc(sscc) ?: return@collect fail(R.string.reprint_unknown_sscc)
                val box = db.boxDao().get(boxId) ?: return@collect fail(R.string.reprint_unknown_sscc)
                if (box.shiftId != shiftId || box.closedAt == null) return@collect fail(R.string.reprint_unknown_sscc)
                _state.value = _state.value.copy(
                    selected = ReprintTarget(boxId, db.boxDao().ordinal(shiftId, box.openedAt, boxId), sscc),
                    error = null,
                )
            }
        }
    }

    private suspend fun firstReprintable(): ReprintTarget? {
        val box = db.boxDao().reprintable(shiftId).firstOrNull() ?: return null
        val sscc = box.sscc ?: return null
        return ReprintTarget(box.boxId, db.boxDao().ordinal(shiftId, box.openedAt, box.boxId), sscc)
    }

    private fun fail(message: Int) {
        _state.value = _state.value.copy(error = message)
    }

    fun chooseLast() {
        _state.value = _state.value.copy(selected = _state.value.last, error = null)
    }

    fun chooseReason(reason: ReprintReason) {
        val target = _state.value.selected ?: return
        viewModelScope.launch {
            val deviceId = db.deviceConfigDao().get()?.deviceId
            engine.reprint(shiftId, target.boxId, reason, session.state.value.operator?.operatorId, deviceId)
            printer.print(target.boxId)
            _state.value = _state.value.copy(done = true)
        }
    }

    fun cancel() {
        _state.value = _state.value.copy(selected = null, error = null)
    }
}
