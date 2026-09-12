package app.markiro.handheld.feature.work

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.core.box.BoxPrint
import app.markiro.handheld.core.box.BoxPrinter
import app.markiro.handheld.core.box.BoxRepository
import app.markiro.handheld.core.box.PalletPrinter
import app.markiro.handheld.core.box.PalletRepository
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
import kotlinx.coroutines.CoroutineScope
import app.markiro.handheld.core.storage.DeviceRecovery
import java.util.concurrent.atomic.AtomicBoolean
import javax.inject.Inject

/** Which repository/printer a queue row belongs to (06d added the pallet half). */
enum class LabelKind { BOX, PALLET }

data class LabelQueueItem(
    /** The box's or pallet's own id, whichever `kind` says this row is. */
    val id: String,
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
    private val exceptions: ExceptionEngine,
    private val session: SessionHolder,
    private val config: DeviceConfigDao,
    private val recovery: DeviceRecovery,
) : ViewModel() {
    private val generation = recovery.token()

    private fun launchOwned(block: suspend CoroutineScope.() -> Unit) = viewModelScope.launch {
        recovery.work(generation) { block() }
    }

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
     * Retrying an unknown could put a second label on a box or pallet the
     * server has already accepted, so only a person who has looked at the
     * printer resolves one — which is exactly why `failed` and `unknown` are
     * different states.
     */
    fun printAll() = runPrint {
        for (item in state.value.items) {
            if (item.skippedByPrintAll) continue
            print(item.id)
        }
    }

    private suspend fun print(id: String) {
        when (state.value.items.firstOrNull { it.id == id }?.kind ?: LabelKind.BOX) {
            LabelKind.BOX -> {
                auditIfOutcomeUnknown(id)
                printer.print(id)
            }
            // KNOWN GAP, not an oversight: a pallet reprint after an unknown
            // outcome writes no audit fact, so this device's trail is
            // asymmetric with the station's, which does record one
            // (`reprintPallet` in `apps/station/src/lib/pallets.ts`). Two
            // blockers, both bigger than this call site:
            //
            //  1. `pallet_exceptions` has no Room entity. It is created only by
            //     `MIGRATION_9_10`'s raw `execSQL`, and Room builds a fresh
            //     database from its entity list -- so on a CLEAN INSTALL the
            //     table does not exist at all, and writing here would crash a
            //     reprint on a new terminal. Giving it an entity means a schema
            //     version bump plus a migration reconciling the already-shipped
            //     raw table with what Room then expects.
            //  2. Nothing would drain it. The server accepts the channel
            //     (`palletExceptions` in `apps/api/src/modules/station-scans/
            //     dto.ts`), but `SyncEngine` has no reader for it, and its
            //     retry identity folds EVERY channel into one batch id
            //     signature with its own pinned counter -- so a fifth channel
            //     is a change to batch identity, not an added query. A row
            //     written today would sit on the device forever.
            //
            // Audited wrongly is worse than audited late: until the handheld's
            // pallet-exceptions screen lands with both halves, this path prints
            // and records nothing.
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
        launchOwned {
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
        val kind = state.value.items.firstOrNull { it.id == id }?.kind ?: LabelKind.BOX
        launchOwned {
            when (kind) {
                LabelKind.BOX -> printer.resolveUnknownAsPrinted(id)
                LabelKind.PALLET -> palletPrinter.resolveUnknownAsPrinted(id)
            }
        }
    }
}
