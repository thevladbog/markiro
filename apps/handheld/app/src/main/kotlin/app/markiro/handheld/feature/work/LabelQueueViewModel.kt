package app.markiro.handheld.feature.work

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.core.box.BoxPrint
import app.markiro.handheld.core.box.BoxPrinter
import app.markiro.handheld.core.box.BoxRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
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
) : ViewModel() {
    private val printing = MutableStateFlow(false)

    val state: StateFlow<LabelQueueUi> = combine(boxes.observeUnprinted(), printing) { rows, busy ->
        LabelQueueUi(
            items = rows.mapNotNull { row ->
                val sscc = row.sscc ?: return@mapNotNull null
                val closedAt = row.closedAt ?: return@mapNotNull null
                LabelQueueItem(row.boxId, sscc, closedAt, row.printState, row.printReason)
            },
            printing = busy,
        )
    }.stateIn(viewModelScope, SharingStarted.Eagerly, LabelQueueUi())

    fun printOne(boxId: String) {
        viewModelScope.launch {
            printing.value = true
            try {
                printer.print(boxId)
            } finally {
                printing.value = false
            }
        }
    }

    /**
     * Every queued label except those whose last attempt is `unknown`.
     *
     * Retrying an unknown could put a second label on a box the server has
     * already accepted, so only a person who has looked at the printer resolves
     * one — which is exactly why `failed` and `unknown` are different states.
     */
    fun printAll() {
        viewModelScope.launch {
            printing.value = true
            try {
                for (item in state.value.items) {
                    if (item.skippedByPrintAll) continue
                    printer.print(item.boxId)
                }
            } finally {
                printing.value = false
            }
        }
    }

    /** The operator looked at the printer and says the label is there. Nothing is sent. */
    fun resolveUnknown(boxId: String) {
        viewModelScope.launch { printer.resolveUnknownAsPrinted(boxId) }
    }
}
