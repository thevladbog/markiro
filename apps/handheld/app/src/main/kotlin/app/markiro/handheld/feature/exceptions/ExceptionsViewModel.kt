package app.markiro.handheld.feature.exceptions

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.R
import app.markiro.handheld.core.exceptions.ExceptionEngine
import app.markiro.handheld.core.exceptions.UndoResult
import app.markiro.handheld.core.storage.CodeEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.util.Iso
import app.markiro.handheld.core.util.TimeText
import app.markiro.handheld.feature.signin.SessionHolder
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicBoolean
import javax.inject.Inject

/** The unit an undo would take back, named so the operator confirms against it. */
data class UndoTarget(val codeTail: String, val scannedAt: String, val codeHash: String)

data class ExceptionsUi(
    val canUndo: Boolean = false,
    val undoTarget: UndoTarget? = null,
    val openBoxId: String? = null,
    val openBoxOrdinal: Int = 0,
    val openBoxCount: Int = 0,
    val reprintableCount: Int = 0,
    val step: ExceptionsStep = ExceptionsStep.List,
)

sealed interface ExceptionsStep {
    data object List : ExceptionsStep
    data object ConfirmUndo : ExceptionsStep
    data object ConfirmClear : ExceptionsStep
    data class Done(val message: Int) : ExceptionsStep
    data class Refused(val message: Int) : ExceptionsStep
}

/**
 * The four corrections, and what is available right now.
 *
 * An unavailable action is never a silently greyed row: the state carries
 * enough for the screen to say why, because an operator who cannot tell a
 * disabled button from a broken one stops trusting the screen.
 */
@HiltViewModel
class ExceptionsViewModel @Inject constructor(
    private val db: HandheldDatabase,
    private val engine: ExceptionEngine,
    private val session: SessionHolder,
    handle: SavedStateHandle,
) : ViewModel() {
    private val shiftId: String = handle.get<String>("shiftId").orEmpty()
    private val step = MutableStateFlow<ExceptionsStep>(ExceptionsStep.List)
    private val target = MutableStateFlow<UndoTarget?>(null)
    /**
     * One confirmation at a time: a second tap would answer against state the
     * first has already changed and overwrite what the operator was just shown.
     */
    private val confirming = AtomicBoolean(false)

    private val openBox = db.boxDao().observeOpen(shiftId)

    @Suppress("OPT_IN_USAGE")
    private val filled = openBox.flatMapLatest { box ->
        if (box == null) flowOf(0) else db.boxDao().observeItemCount(box.boxId)
    }

    /**
     * Observed, not read once: a box retired on the disassemble route leaves
     * this list while this screen is still on the back stack, and a one-shot
     * count would keep offering an action with nothing behind it.
     */
    private val reprintable = db.boxDao().observeReprintable(shiftId)

    val state: StateFlow<ExceptionsUi> = combine(openBox, filled, target, reprintable, step) { box, count, undo, closed, current ->
        ExceptionsUi(
            canUndo = box != null && undo != null,
            undoTarget = undo,
            openBoxId = box?.boxId,
            openBoxOrdinal = box?.let { ordinals[it.boxId] ?: 0 } ?: 0,
            openBoxCount = count,
            reprintableCount = closed.size,
            step = current,
        )
    }.stateIn(viewModelScope, SharingStarted.Eagerly, ExceptionsUi())

    /** Display numbers are derived from persisted rows, so one read per box is enough. */
    private val ordinals = mutableMapOf<String, Int>()

    init {
        // Driven by the item count as well as the box: a scan arriving while
        // this screen is open changes what "the last scan" means, and a target
        // refreshed only when the box row changes would name the wrong unit.
        viewModelScope.launch {
            combine(openBox, filled) { box, _ -> box }.collect { box ->
                if (box != null && box.boxId !in ordinals) {
                    ordinals[box.boxId] = db.boxDao().ordinal(shiftId, box.openedAt, box.boxId)
                }
                target.value = box?.let { open -> engine.lastScanIn(open.boxId)?.let(::targetOf) }
            }
        }
    }

    private fun targetOf(last: CodeEntity) = UndoTarget(
        codeTail = last.codeHash.takeLast(6).uppercase(),
        scannedAt = Iso.parse(last.scannedAt)?.let { TimeText.hhmmss(it) } ?: last.scannedAt,
        codeHash = last.codeHash,
    )

    fun startUndo() {
        if (state.value.canUndo) step.value = ExceptionsStep.ConfirmUndo
    }

    fun startClear() {
        if (state.value.openBoxId != null) step.value = ExceptionsStep.ConfirmClear
    }

    fun dismiss() {
        step.value = ExceptionsStep.List
    }

    fun confirm() {
        val current = step.value
        val boxId = state.value.openBoxId ?: return
        val operatorId = session.state.value.operator?.operatorId
        if (!confirming.compareAndSet(false, true)) return
        viewModelScope.launch {
            try {
                // Read at the moment it is needed rather than cached from an
                // observer: the config arrives on Room's own threads.
                val deviceId = db.deviceConfigDao().get()?.deviceId
                val expected = state.value.undoTarget?.codeHash
                step.value = when (current) {
                    ExceptionsStep.ConfirmUndo -> when {
                        expected == null -> ExceptionsStep.Refused(R.string.exceptions_no_last_scan)
                        else -> when (engine.undoLastScan(shiftId, boxId, expected, operatorId, deviceId)) {
                            is UndoResult.Undone -> ExceptionsStep.Done(R.string.exceptions_undone)
                            UndoResult.Stale -> ExceptionsStep.Refused(R.string.exceptions_undo_stale)
                            UndoResult.Empty -> ExceptionsStep.Refused(R.string.exceptions_no_last_scan)
                        }
                    }
                    ExceptionsStep.ConfirmClear -> {
                        val released = engine.clearBox(shiftId, boxId, operatorId, deviceId)
                        if (released > 0) {
                            ExceptionsStep.Done(R.string.exceptions_cleared)
                        } else {
                            ExceptionsStep.Refused(R.string.exceptions_no_last_scan)
                        }
                    }
                    else -> return@launch
                }
                target.value = engine.lastScanIn(boxId)?.let(::targetOf)
            } finally {
                confirming.set(false)
            }
        }
    }
}
