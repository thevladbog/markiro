package app.markiro.handheld.feature.work

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.core.box.BoxPrint
import app.markiro.handheld.core.box.BoxPrinter
import app.markiro.handheld.core.box.BoxRepository
import app.markiro.handheld.core.exceptions.ExceptionEngine
import app.markiro.handheld.core.exceptions.ReprintReason
import app.markiro.handheld.core.storage.DeviceConfigDao
import app.markiro.handheld.feature.signin.SessionHolder
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicBoolean
import javax.inject.Inject

data class LabelQueueItem(
    val boxId: String,
    val sscc: String,
    val closedAt: String,
    val printState: String,
    val reason: String?,
) {
    /**
     * An unknown outcome is not retried in bulk: a second label on a box the
     * server has already accepted is worse than a label printed late.
     */
    val skippedByPrintAll: Boolean get() = printState == BoxPrint.UNKNOWN
}

data class LabelQueueUi(val items: List<LabelQueueItem> = emptyList(), val printing: Boolean = false)

@HiltViewModel
class LabelQueueViewModel @Inject constructor(
    private val boxes: BoxRepository,
    private val printer: BoxPrinter,
    private val exceptions: ExceptionEngine,
    private val session: SessionHolder,
    private val config: DeviceConfigDao,
) : ViewModel() {
    private val printing = MutableStateFlow(false)
    private val busy = AtomicBoolean(false)

    val state: StateFlow<LabelQueueUi> = combine(boxes.observeUnprinted(), printing) { rows, inFlight ->
        LabelQueueUi(
            items = rows.mapNotNull { row ->
                val sscc = row.sscc ?: return@mapNotNull null
                val closedAt = row.closedAt ?: return@mapNotNull null
                LabelQueueItem(row.boxId, sscc, closedAt, row.printState, row.printReason)
            },
            printing = inFlight,
        )
    }.stateIn(viewModelScope, SharingStarted.Eagerly, LabelQueueUi())

    fun printOne(boxId: String) = runPrint {
        auditIfOutcomeUnknown(boxId)
        printer.print(boxId)
    }

    /**
     * Printing again a box whose last attempt ended `unknown` is an explicit
     * same-SSCC reprint (design brief 10 §8) and is recorded as one -- with a
     * fixed reason rather than a prompt, because the operator is standing at
     * the printer deciding whether paper moved, not filling in a ledger.
     *
     * `failed` and `deferred` never put paper through, so they are ordinary
     * retries and write nothing.
     */
    private suspend fun auditIfOutcomeUnknown(boxId: String) {
        val box = boxes.get(boxId) ?: return
        if (box.printState != BoxPrint.UNKNOWN) return
        exceptions.reprint(
            shiftId = box.shiftId,
            boxId = boxId,
            reason = ReprintReason.PRINT_OUTCOME_UNKNOWN,
            operatorId = session.state.value.operator?.operatorId,
            terminalId = config.get()?.deviceId,
        )
    }

    /**
     * Every queued label except those whose last attempt is `unknown`.
     *
     * Retrying an unknown could put a second label on a box the server has
     * already accepted, so only a person who has looked at the printer resolves
     * one — which is exactly why `failed` and `unknown` are different states.
     */
    fun printAll() = runPrint {
        for (item in state.value.items) {
            if (item.skippedByPrintAll) continue
            printer.print(item.boxId)
        }
    }

    /**
     * Runs one print operation at a time and drops any request arriving while one
     * is in flight. Two overlapping runs would send the same label twice, which is
     * the single thing this queue exists to avoid.
     */
    private fun runPrint(work: suspend () -> Unit) {
        if (!busy.compareAndSet(false, true)) return
        viewModelScope.launch {
            printing.value = true
            try {
                work()
            } finally {
                printing.value = false
                busy.set(false)
            }
        }
    }

    /** The operator looked at the printer and says the label is there. Nothing is sent. */
    fun resolveUnknown(boxId: String) {
        viewModelScope.launch { printer.resolveUnknownAsPrinted(boxId) }
    }
}
