package app.markiro.handheld.feature.pallets

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.core.box.ClosePalletResult
import app.markiro.handheld.core.box.PrintOutcome
import app.markiro.handheld.core.exceptions.ReprintReason
import app.markiro.handheld.core.inventory.ScanClassifier
import app.markiro.handheld.core.inventory.ScanInput
import app.markiro.handheld.core.pallets.AttachResult
import app.markiro.handheld.core.print.PrinterEntity
import app.markiro.handheld.core.scan.ScanEvents
import app.markiro.handheld.core.signal.SignalKind
import app.markiro.handheld.core.signal.Signaller
import app.markiro.handheld.core.storage.DeviceRecovery
import app.markiro.handheld.core.storage.MembershipStatus
import app.markiro.handheld.core.storage.RecoveryBlocked
import app.markiro.handheld.core.storage.PalletEntity
import app.markiro.handheld.core.storage.PalletMembershipEntity
import app.markiro.handheld.feature.signin.SessionHolder
import app.markiro.handheld.feature.work.ClosedPalletUi
import app.markiro.handheld.feature.work.PalletCloseStep
import app.markiro.handheld.feature.work.SignalPort
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicBoolean
import javax.inject.Inject

/** Why the mode refuses to start. Neither is recoverable from inside it. */
enum class PalletsBlocked { NO_PERMISSION, NEVER_SYNCED }

/**
 * The verdict of the last scan, shown as a compact banner rather than a
 * full-screen overlay: in a warehouse the operator's hands are on the box and
 * their eyes are on the pallet, so the sound is the primary answer and this
 * line is what they read when the sound was not enough.
 */
sealed interface PalletVerdict {
    data class Attached(val tail: String) : PalletVerdict

    data class AlreadyHere(val tail: String) : PalletVerdict

    /** Null tail: the winning pallet is still open elsewhere and has no number yet. */
    data class OnPallet(val palletTail: String?) : PalletVerdict

    data object OnLocalPallet : PalletVerdict

    data class OtherProduct(val name: String) : PalletVerdict

    data object UnknownBox : PalletVerdict

    data object UnknownProduct : PalletVerdict

    data object IsPallet : PalletVerdict

    /** A unit's KM, not a box: a correct code for the wrong screen. */
    data object UnitCode : PalletVerdict

    data object NotACode : PalletVerdict
}

data class PalletsUi(
    val blocked: PalletsBlocked? = null,
    val stampAt: Long? = null,
    val operatorName: String = "",
    val pallet: PalletEntity? = null,
    val productName: String = "",
    val boxCount: Int = 0,
    val capacity: Int? = null,
    val members: List<PalletMembershipEntity> = emptyList(),
    val rejections: List<PalletMembershipEntity> = emptyList(),
    val lastVerdict: PalletVerdict? = null,
    val confirmEarlyClose: Boolean = false,
    val closeStep: PalletCloseStep = PalletCloseStep.Idle,
)

/**
 * The «Паллеты» mode: build one warehouse pallet from closed boxes, then close
 * and label it.
 *
 * Nothing scanned here reaches `scan_events` or the scan outbox. A box already
 * had its own scan history when it was built; putting it on a pallet is a
 * membership fact, and that is the only thing this mode records.
 *
 * Every database touch goes through `recovery.work`, so a device whose
 * credential was revoked mid-shift stops writing rather than stamping rows
 * against an owner it no longer is.
 */
@HiltViewModel
class PalletsViewModel(
    private val gateway: PalletsGateway,
    private val session: SessionHolder,
    scans: ScanEvents,
    private val recovery: DeviceRecovery,
    private val signals: SignalPort,
) : ViewModel() {
    @Inject
    constructor(
        gateway: PalletsGateway,
        session: SessionHolder,
        scans: ScanEvents,
        recovery: DeviceRecovery,
        signaller: Signaller,
    ) : this(gateway, session, scans, recovery, { signaller.play(it) })

    private val _state = MutableStateFlow(PalletsUi())
    val state: StateFlow<PalletsUi> = _state.asStateFlow()

    /** Offered when a pallet label fails: the operator picks another printer rather than stopping. */
    val printerProfiles: StateFlow<List<PrinterEntity>> =
        gateway.observePrinters().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    private val operatorId: String? get() = session.state.value.operator?.operatorId

    /** One close at a time: the automatic close at capacity and «Закрыть» can arrive together. */
    private val closing = AtomicBoolean(false)
    private val retrying = AtomicBoolean(false)

    init {
        _state.update { it.copy(operatorName = session.state.value.operator?.name.orEmpty()) }
        // The gate is decided before the first scan is read: a mode that refuses
        // an operator must refuse them before they scan, not after.
        viewModelScope.launch {
            val id = operatorId
            val permitted = if (id == null) null else runCatching { recovery.work { gateway.canBuildPallets(id) } }.getOrNull()
            val ready = runCatching { recovery.work { gateway.bootstrapReady() } }.getOrDefault(false)
            _state.update {
                it.copy(
                    blocked = when {
                        permitted == false -> PalletsBlocked.NO_PERMISSION
                        !ready -> PalletsBlocked.NEVER_SYNCED
                        else -> null
                    },
                )
            }
            // A closed pallet's label owns the screen; a scan landing behind it
            // would attach a box to a pallet the operator has already finished.
            scans.events.collect { event ->
                if (_state.value.blocked == null && _state.value.closeStep is PalletCloseStep.Idle) onScan(event.raw)
            }
        }
        viewModelScope.launch { gateway.stampAt.collectLatest { at -> _state.update { it.copy(stampAt = at) } } }
        viewModelScope.launch {
            gateway.observeOpen().collectLatest { pallet ->
                if (pallet == null) {
                    // The verdict belonged to the pallet that just went away;
                    // «Принят …000014» over an empty screen names a box that is
                    // no longer anywhere the operator can see.
                    _state.update {
                        it.copy(
                            pallet = null, productName = "", boxCount = 0, capacity = null,
                            members = emptyList(), rejections = emptyList(), lastVerdict = null,
                        )
                    }
                    return@collectLatest
                }
                val name = runCatching { recovery.work { pallet.productId?.let { id -> gateway.productName(id) } } }.getOrNull().orEmpty()
                val capacity = runCatching { recovery.work { gateway.capacity(pallet) } }.getOrNull()
                _state.update { it.copy(pallet = pallet, productName = name, capacity = capacity) }
                combine(gateway.observeMembers(pallet.palletId), gateway.observeRejections(pallet.palletId)) { m, r -> m to r }
                    .collect { (members, rejections) ->
                        // A rejected row is not on the pallet: the server refused it,
                        // and counting it would print a label claiming a box that is
                        // recorded somewhere else.
                        val onPallet = members.filter { m -> m.status != MembershipStatus.REJECTED }
                        _state.update { it.copy(members = onPallet, boxCount = onPallet.size, rejections = rejections) }
                    }
            }
        }
        viewModelScope.launch { runCatching { gateway.refresh() } }
    }

    private suspend fun onScan(raw: String) {
        when (val input = ScanClassifier.classify(raw)) {
            is ScanInput.Sscc -> attach(input.sscc)
            is ScanInput.Km -> verdict(PalletVerdict.UnitCode, SignalKind.ERROR)
            is ScanInput.Gtin, is ScanInput.Unknown -> verdict(PalletVerdict.NotACode, SignalKind.ERROR)
        }
    }

    private suspend fun attach(sscc: String) {
        val tail = sscc.takeLast(TAIL)
        val result = runCatching { recovery.work { gateway.attach(sscc, operatorId) } }
            .getOrElse { return verdict(PalletVerdict.UnknownBox, SignalKind.ERROR) }
        when (result) {
            is AttachResult.Attached -> {
                verdict(PalletVerdict.Attached(tail), SignalKind.OK)
                if (result.atCapacity) closeNow()
            }
            AttachResult.AlreadyOnThisPallet -> verdict(PalletVerdict.AlreadyHere(tail), SignalKind.DUPLICATE)
            is AttachResult.OnAnotherPallet -> verdict(PalletVerdict.OnPallet(result.palletSscc?.takeLast(TAIL)), SignalKind.ERROR)
            AttachResult.OnAnotherLocalPallet -> verdict(PalletVerdict.OnLocalPallet, SignalKind.ERROR)
            is AttachResult.OtherProduct -> verdict(PalletVerdict.OtherProduct(result.productName), SignalKind.ERROR)
            AttachResult.UnknownBox -> verdict(PalletVerdict.UnknownBox, SignalKind.ERROR)
            AttachResult.UnknownProduct -> verdict(PalletVerdict.UnknownProduct, SignalKind.ERROR)
            AttachResult.ThatIsAPallet -> verdict(PalletVerdict.IsPallet, SignalKind.ERROR)
        }
    }

    private fun verdict(v: PalletVerdict, signal: SignalKind) {
        _state.update { it.copy(lastVerdict = v) }
        signals.play(signal)
    }

    fun remove(sscc: String) {
        val pallet = _state.value.pallet ?: return
        viewModelScope.launch { runCatching { recovery.work { gateway.remove(pallet.palletId, sscc) } } }
    }

    fun requestEarlyClose() {
        if (_state.value.pallet != null) _state.update { it.copy(confirmEarlyClose = true) }
    }

    fun cancelEarlyClose() = _state.update { it.copy(confirmEarlyClose = false) }

    fun confirmEarlyClose() {
        _state.update { it.copy(confirmEarlyClose = false) }
        viewModelScope.launch { closeNow() }
    }

    /**
     * The one closure, whether capacity or the operator asked for it.
     *
     * A refusal is shown by name and leaves the pallet open: `ClosePallet`
     * burns nothing on `Empty`/`NoSerials`/`NoIssuer`, so the operator can fix
     * the cause and close again.
     *
     * A THROWN failure -- a revoked lease (`RecoveryBlocked`), a database error
     * -- is `Unavailable`, not `Empty`. Reporting it as «в паллете нет коробов»
     * would send the operator looking for boxes that are already on the pallet.
     * Cancellation is not a failure and is rethrown so the scope still dies.
     */
    private suspend fun closeNow() {
        if (!closing.compareAndSet(false, true)) return
        try {
            val outcome = try {
                recovery.work { gateway.close(operatorId) }
            } catch (_: RecoveryBlocked) {
                // A revoked or sealed credential IS a CancellationException by
                // type, so it has to be named before the real cancellation below
                // or the operator would be left staring at an unchanged screen.
                ClosePalletResult.Unavailable
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                ClosePalletResult.Unavailable
            }
            when (val result = outcome) {
                is ClosePalletResult.Closed -> {
                    signals.play(SignalKind.BOX_DONE)
                    val closed = ClosedPalletUi(result.pallet.palletId, result.sscc, result.boxCount)
                    // The pallet this verdict spoke about is closed; its banner
                    // must not survive onto the next one.
                    _state.update { it.copy(lastVerdict = null, closeStep = PalletCloseStep.Printing(closed)) }
                    val step = attemptPrint(closed)
                    _state.update { it.copy(closeStep = step) }
                    gateway.nudgeSync()
                }
                else -> _state.update { it.copy(closeStep = PalletCloseStep.Refused(result)) }
            }
        } finally {
            closing.set(false)
        }
    }

    private suspend fun attemptPrint(
        closed: ClosedPalletUi,
        replacementPrinterId: String? = null,
        explicitRetry: Boolean = false,
    ): PalletCloseStep =
        when (val printed = runCatching {
            recovery.work { gateway.print(closed.palletId, replacementPrinterId, allowUnknown = explicitRetry) }
        }.getOrElse { PrintOutcome.Unknown("interrupted") }) {
            PrintOutcome.Printed -> PalletCloseStep.Printed(closed)
            is PrintOutcome.Failed -> PalletCloseStep.Failed(closed, printed.reason)
            is PrintOutcome.Unknown -> PalletCloseStep.Unknown(closed, printed.cause)
        }

    /**
     * Nothing retries on its own. A second label on a pallet the server already
     * accepted is a real duplicate in the warehouse, so an unknown outcome is
     * recorded as a reprint exception BEFORE the second attempt is made.
     */
    fun retryPrint(replacementPrinterId: String? = null) {
        val closed = _state.value.closeStep.closedPallet() ?: return
        if (!retrying.compareAndSet(false, true)) return
        viewModelScope.launch {
            try {
                if (_state.value.closeStep is PalletCloseStep.Unknown) {
                    runCatching {
                        recovery.work {
                            gateway.reprintPallet(closed.palletId, ReprintReason.PRINT_OUTCOME_UNKNOWN, operatorId, gateway.deviceId())
                        }
                    }
                }
                _state.update { it.copy(closeStep = PalletCloseStep.Printing(closed)) }
                val step = attemptPrint(closed, replacementPrinterId, explicitRetry = true)
                _state.update { it.copy(closeStep = step) }
            } finally {
                retrying.set(false)
            }
        }
    }

    /** The operator looked at the printer and says the label is there. Nothing is sent. */
    fun confirmPrinted() {
        val closed = _state.value.closeStep.closedPallet()
        _state.update { it.copy(closeStep = PalletCloseStep.Idle) }
        if (closed != null) viewModelScope.launch { runCatching { recovery.work { gateway.resolveUnknownAsPrinted(closed.palletId) } } }
    }

    fun deferLabel() {
        val closed = _state.value.closeStep.closedPallet()
        _state.update { it.copy(closeStep = PalletCloseStep.Idle) }
        if (closed != null) viewModelScope.launch { runCatching { recovery.work { gateway.defer(closed.palletId) } } }
    }

    /**
     * A print in flight is not dismissable. The close coroutine is still
     * running and writes its own outcome back into `closeStep`, so clearing it
     * here only makes the label screen reappear a moment later -- and in the
     * gap a scan would attach a box to a pallet that is already closed.
     */
    fun dismissClose() = _state.update {
        if (it.closeStep is PalletCloseStep.Printing) it else it.copy(closeStep = PalletCloseStep.Idle)
    }

    fun acknowledge() {
        val pallet = _state.value.pallet ?: return
        viewModelScope.launch { runCatching { recovery.work { gateway.acknowledge(pallet.palletId) } } }
    }

    fun refresh() {
        viewModelScope.launch { runCatching { gateway.refresh() } }
    }

    private companion object {
        const val TAIL = 6
    }
}
