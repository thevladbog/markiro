package app.markiro.handheld.feature.exceptions

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.R
import app.markiro.handheld.core.exceptions.DisassemblePalletResult
import app.markiro.handheld.core.exceptions.DisassembleReason
import app.markiro.handheld.core.exceptions.ExceptionEngine
import app.markiro.handheld.core.inventory.ScanClassifier
import app.markiro.handheld.core.inventory.ScanInput
import app.markiro.handheld.core.scan.ScanEvents
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.PalletKind
import app.markiro.handheld.core.storage.RecoveryBlocked
import app.markiro.handheld.feature.signin.SessionHolder
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicBoolean
import javax.inject.Inject

sealed interface PalletDisassembleStep {
    data object ScanPallet : PalletDisassembleStep
    data class Reason(val palletId: String, val sscc: String, val boxCount: Int) : PalletDisassembleStep
    data class Confirm(val palletId: String, val sscc: String, val boxCount: Int) : PalletDisassembleStep
    data object Retired : PalletDisassembleStep
    data class Refused(val message: Int) : PalletDisassembleStep
}

/**
 * Scan the pallet label, choose a reason, confirm — the pallet twin of
 * [DisassembleViewModel], and identified by scanning for the same reason: a
 * closed pallet has a printed SSCC label on it, which is the one thing here
 * that can be confirmed without reading a screen.
 *
 * Reached from two routes. The exceptions hub passes a `shiftId` and only that
 * shift's pallets are accepted, because the hub is a shift's own correction
 * screen. The «Паллеты» mode passes none and any closed pallet of this device
 * is accepted, because a warehouse pallet belongs to no shift at all and its
 * operator is standing in front of the stack, not inside a shift.
 */
@HiltViewModel
class PalletDisassembleViewModel @Inject constructor(
    private val db: HandheldDatabase,
    private val engine: ExceptionEngine,
    private val session: SessionHolder,
    scans: ScanEvents,
    handle: SavedStateHandle,
) : ViewModel() {
    /** Null on the shift-less route: then every closed pallet of this device is in scope. */
    private val shiftId: String? = handle.get<String>("shiftId")
    private val _step = MutableStateFlow<PalletDisassembleStep>(PalletDisassembleStep.ScanPallet)
    val step: StateFlow<PalletDisassembleStep> = _step
    private var chosen: DisassembleReason? = null

    /**
     * One confirmation at a time, exactly as [DisassembleViewModel] holds it:
     * the engine refuses the second retirement, but its `AlreadyRetired` would
     * overwrite the success the operator had just been shown.
     */
    private val confirming = AtomicBoolean(false)

    init {
        viewModelScope.launch {
            scans.events.collect { event ->
                // Only the first step listens: a scan arriving later belongs to
                // whatever the operator does next, not to this flow's target.
                if (_step.value is PalletDisassembleStep.ScanPallet) resolve(event.raw)
            }
        }
    }

    private suspend fun resolve(raw: String) {
        val sscc = (ScanClassifier.classify(raw) as? ScanInput.Sscc)?.sscc
            ?: return refuse(R.string.pallet_disassemble_unknown)
        // A box label is a perfectly valid SSCC and the likeliest wrong scan
        // here; it simply names no pallet, so it lands on the same refusal.
        val pallet = db.palletDao().bySscc(sscc) ?: return refuse(R.string.pallet_disassemble_unknown)
        if (shiftId != null && pallet.shiftId != shiftId) return refuse(R.string.pallet_disassemble_unknown)
        if (pallet.disassembledAt != null) return refuse(R.string.pallet_disassemble_already)
        if (pallet.closedAt == null) return refuse(R.string.pallet_disassemble_not_closed)
        _step.value = PalletDisassembleStep.Reason(
            palletId = pallet.palletId,
            sscc = sscc,
            boxCount = boxCountOf(pallet.palletId, pallet.kind),
        )
    }

    /**
     * The two kinds count their boxes in different tables: a production pallet
     * owns `boxes.palletId`, a warehouse pallet owns membership rows.
     */
    private suspend fun boxCountOf(palletId: String, kind: String): Int =
        if (kind == PalletKind.WAREHOUSE) {
            db.palletMembershipDao().countOnPallet(palletId)
        } else {
            db.palletDao().boxCount(palletId)
        }

    private fun refuse(message: Int) {
        _step.value = PalletDisassembleStep.Refused(message)
    }

    fun chooseReason(reason: DisassembleReason) {
        val at = _step.value as? PalletDisassembleStep.Reason ?: return
        chosen = reason
        _step.value = PalletDisassembleStep.Confirm(at.palletId, at.sscc, at.boxCount)
    }

    fun confirm() {
        val at = _step.value as? PalletDisassembleStep.Confirm ?: return
        val reason = chosen ?: return
        if (!confirming.compareAndSet(false, true)) return
        viewModelScope.launch {
            try {
                val deviceId = db.deviceConfigDao().get()?.deviceId
                val operatorId = session.state.value.operator?.operatorId
                // A THROWN retirement is not «уже расформирована». A revoked
                // lease (`RecoveryBlocked`) or a database error would otherwise
                // either be reported as a refusal that already happened or kill
                // this coroutine in silence, leaving the confirm screen frozen
                // with the operator pressing a button that does nothing.
                // `RecoveryBlocked` IS a `CancellationException` by type, so it
                // is named before the real cancellation is rethrown.
                _step.value = try {
                    when (engine.disassemblePallet(at.palletId, reason, operatorId, deviceId)) {
                        DisassemblePalletResult.Retired -> PalletDisassembleStep.Retired
                        DisassemblePalletResult.AlreadyRetired ->
                            PalletDisassembleStep.Refused(R.string.pallet_disassemble_already)
                        DisassemblePalletResult.NotClosed ->
                            PalletDisassembleStep.Refused(R.string.pallet_disassemble_not_closed)
                    }
                } catch (_: RecoveryBlocked) {
                    PalletDisassembleStep.Refused(R.string.pallet_disassemble_unavailable)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Throwable) {
                    PalletDisassembleStep.Refused(R.string.pallet_disassemble_unavailable)
                }
            } finally {
                confirming.set(false)
            }
        }
    }

    /** Backing out before the third step applies nothing. */
    fun cancel() {
        chosen = null
        _step.value = PalletDisassembleStep.ScanPallet
    }
}
