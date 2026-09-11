package app.markiro.handheld.feature.exceptions

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.R
import app.markiro.handheld.core.box.Sscc
import app.markiro.handheld.core.exceptions.DisassembleReason
import app.markiro.handheld.core.exceptions.DisassembleResult
import app.markiro.handheld.core.exceptions.ExceptionEngine
import app.markiro.handheld.core.scan.ScanEvents
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.feature.signin.SessionHolder
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicBoolean
import javax.inject.Inject

sealed interface DisassembleStep {
    data object ScanBox : DisassembleStep
    data class Reason(val boxId: String, val ordinal: Int, val units: Int, val sscc: String) : DisassembleStep
    data class Confirm(val boxId: String, val ordinal: Int, val units: Int, val sscc: String) : DisassembleStep
    data object Retired : DisassembleStep
    data class Refused(val message: Int) : DisassembleStep
}

/**
 * Scan the box label, choose a reason, confirm.
 *
 * The target is identified by scanning because a closed box has a printed SSCC
 * label in the operator's hand -- the one thing here that can be confirmed
 * without reading a screen. Nothing is applied before the third step: this is
 * the only irreversible action on the device.
 */
@HiltViewModel
class DisassembleViewModel @Inject constructor(
    private val db: HandheldDatabase,
    private val engine: ExceptionEngine,
    private val session: SessionHolder,
    scans: ScanEvents,
    handle: SavedStateHandle,
) : ViewModel() {
    private val shiftId: String = handle.get<String>("shiftId").orEmpty()
    private val _step = MutableStateFlow<DisassembleStep>(DisassembleStep.ScanBox)
    val step: StateFlow<DisassembleStep> = _step
    private var chosen: DisassembleReason? = null

    /**
     * One confirmation at a time.
     *
     * The engine refuses a second retirement, so a double tap cannot retire
     * twice -- but the second call answered `AlreadyRetired` and overwrote the
     * success the operator had just been shown with «Короб уже расформирован».
     */
    private val confirming = AtomicBoolean(false)

    init {
        viewModelScope.launch {
            scans.events.collect { event ->
                // Only the first step listens. A scan arriving later belongs to
                // whatever the operator does next, not to this flow's target.
                if (_step.value is DisassembleStep.ScanBox) resolve(event.raw)
            }
        }
    }

    private suspend fun resolve(raw: String) {
        val sscc = Sscc.parse(raw) ?: return refuse(R.string.disassemble_unknown_sscc)
        // `boxIdBySscc` already excludes a retired box, so a second pass over the
        // same label reports an unknown number rather than offering it again.
        val boxId = db.boxDao().boxIdBySscc(sscc) ?: return refuse(R.string.disassemble_unknown_sscc)
        val box = db.boxDao().get(boxId) ?: return refuse(R.string.disassemble_unknown_sscc)
        if (box.shiftId != shiftId) return refuse(R.string.disassemble_unknown_sscc)
        if (box.closedAt == null) return refuse(R.string.disassemble_not_closed)
        _step.value = DisassembleStep.Reason(
            boxId = boxId,
            ordinal = db.boxDao().ordinal(shiftId, box.openedAt, boxId),
            units = db.boxDao().itemCount(boxId),
            sscc = sscc,
        )
    }

    private fun refuse(message: Int) {
        _step.value = DisassembleStep.Refused(message)
    }

    fun chooseReason(reason: DisassembleReason) {
        val at = _step.value as? DisassembleStep.Reason ?: return
        chosen = reason
        _step.value = DisassembleStep.Confirm(at.boxId, at.ordinal, at.units, at.sscc)
    }

    fun confirm() {
        val at = _step.value as? DisassembleStep.Confirm ?: return
        val reason = chosen ?: return
        if (!confirming.compareAndSet(false, true)) return
        viewModelScope.launch {
            try {
                val deviceId = db.deviceConfigDao().get()?.deviceId
                val operatorId = session.state.value.operator?.operatorId
                _step.value = when (engine.disassemble(shiftId, at.boxId, reason, operatorId, deviceId)) {
                    DisassembleResult.Retired -> DisassembleStep.Retired
                    DisassembleResult.AlreadyRetired -> DisassembleStep.Refused(R.string.disassemble_already)
                    DisassembleResult.NotClosed -> DisassembleStep.Refused(R.string.disassemble_not_closed)
                }
            } finally {
                confirming.set(false)
            }
        }
    }

    /** Backing out before the third step applies nothing. */
    fun cancel() {
        chosen = null
        _step.value = DisassembleStep.ScanBox
    }
}
