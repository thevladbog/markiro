package app.markiro.handheld.feature.work

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.core.box.BoxPrint
import app.markiro.handheld.core.box.BoxPrinter
import app.markiro.handheld.core.box.BoxRepository
import app.markiro.handheld.core.box.PalletPrinter
import app.markiro.handheld.core.box.PalletRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicBoolean
import javax.inject.Inject

/** Which repository/printer a queue row belongs to (06d added the pallet half). */
enum class LabelKind { BOX, PALLET }

data class LabelQueueItem(
    val boxId: String,
    val sscc: String,
    val closedAt: String,
    val printState: String,
    val reason: String?,
    val kind: LabelKind = LabelKind.BOX,
) {
    /**
     * An unknown outcome is not retried in bulk: a second label on a box the
     * server has already accepted is worse than a label printed late.
     */
    val skippedByPrintAll: Boolean get() = printState == BoxPrint.UNKNOWN
}

data class LabelQueueUi(val items: List<LabelQueueItem> = emptyList(), val printing: Boolean = false)

/**
 * Labels owed on this device, across both closed boxes and closed pallets.
 *
 * `PalletPrinter` mirrors `BoxPrinter` field for field -- same `printState`
 * vocabulary, same `unknown`-is-never-auto-retried rule -- so a pallet whose
 * label was deferred or failed rides this exact queue rather than getting a
 * screen of its own; only which repository/printer a row's `id` resolves
 * through differs.
 */
@HiltViewModel
class LabelQueueViewModel @Inject constructor(
    private val boxes: BoxRepository,
    private val printer: BoxPrinter,
    private val pallets: PalletRepository,
    private val palletPrinter: PalletPrinter,
) : ViewModel() {
    private val printing = MutableStateFlow(false)
    private val busy = AtomicBoolean(false)

    val state: StateFlow<LabelQueueUi> = combine(
        boxes.observeUnprinted(),
        pallets.observeUnprinted(),
        printing,
    ) { boxRows, palletRows, inFlight ->
        val boxItems = boxRows.mapNotNull { row ->
            val sscc = row.sscc ?: return@mapNotNull null
            val closedAt = row.closedAt ?: return@mapNotNull null
            LabelQueueItem(row.boxId, sscc, closedAt, row.printState, row.printReason, LabelKind.BOX)
        }
        val palletItems = palletRows.mapNotNull { row ->
            val sscc = row.sscc ?: return@mapNotNull null
            val closedAt = row.closedAt ?: return@mapNotNull null
            LabelQueueItem(row.palletId, sscc, closedAt, row.printState, row.printReason, LabelKind.PALLET)
        }
        LabelQueueUi(items = (boxItems + palletItems).sortedBy { it.closedAt }, printing = inFlight)
    }.stateIn(viewModelScope, SharingStarted.Eagerly, LabelQueueUi())

    fun printOne(id: String) = runPrint { print(id) }

    /**
     * Every queued label except those whose last attempt is `unknown`.
     *
     * Retrying an unknown could put a second label on a box or pallet the
     * server has already accepted, so only a person who has looked at the
     * printer resolves one — which is exactly why `failed` and `unknown` are
     * different states.
     */
    fun printAll() = runPrint {
        for (item in state.value.items) {
            if (item.skippedByPrintAll) continue
            print(item.boxId)
        }
    }

    private suspend fun print(id: String) {
        when (state.value.items.firstOrNull { it.boxId == id }?.kind ?: LabelKind.BOX) {
            LabelKind.BOX -> printer.print(id)
            LabelKind.PALLET -> palletPrinter.print(id)
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
    fun resolveUnknown(id: String) {
        val kind = state.value.items.firstOrNull { it.boxId == id }?.kind ?: LabelKind.BOX
        viewModelScope.launch {
            when (kind) {
                LabelKind.BOX -> printer.resolveUnknownAsPrinted(id)
                LabelKind.PALLET -> palletPrinter.resolveUnknownAsPrinted(id)
            }
        }
    }
}
