package app.markiro.handheld.feature.writeoff

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.core.inventory.ScanClassifier
import app.markiro.handheld.core.inventory.ScanInput
import app.markiro.handheld.core.km.KmCodec
import app.markiro.handheld.core.scan.ScanEvents
import app.markiro.handheld.core.signal.SignalKind
import app.markiro.handheld.core.signal.Signaller
import app.markiro.handheld.core.storage.DeviceRecovery
import app.markiro.handheld.core.storage.WriteoffOutboxEntity
import app.markiro.handheld.core.storage.WriteoffReasonEntity
import app.markiro.handheld.feature.signin.SessionHolder
import app.markiro.handheld.feature.work.SignalPort
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/** The verdict of the last scan, shown compactly rather than as a full-screen overlay. */
sealed interface Verdict {
    data class Accepted(val tail: String) : Verdict
    data class Duplicate(val tail: String) : Verdict
    data object UnknownProduct : Verdict
    data object UnknownBox : Verdict
    data object NotACode : Verdict
}

/** Why the mode refuses to start. Each is recoverable only outside the mode. */
enum class Blocked { NO_PERMISSION, NO_REASONS, NEVER_SYNCED }

enum class WriteoffStep { LIST, REASON, CONFIRM, RESULT }

data class WriteoffUi(
    val step: WriteoffStep = WriteoffStep.LIST,
    val lines: List<WriteoffLine> = emptyList(),
    val unitCount: Int = 0,
    val boxCount: Int = 0,
    val lastVerdict: Verdict? = null,
    val reasons: List<WriteoffReasonEntity> = emptyList(),
    val selectedReason: WriteoffReasonEntity? = null,
    val operatorName: String = "",
    val blocked: Blocked? = null,
    val stampAt: Long? = null,
    val filedDocumentId: String? = null,
    /** The filed document as the engine settles it; drives «В очереди» → the act number. */
    val filed: WriteoffOutboxEntity? = null,
    /** Raised when Back would discard a list the operator has built. */
    val confirmDiscard: Boolean = false,
)

/**
 * The write-off mode.
 *
 * Duplicate checking is deliberately confined to the list being built: a box
 * contributes the unit keys the registry says it holds, so a loose unit already
 * inside a listed box is caught, but a code some other document filed is not the
 * device's call. Refusing those locally would invent offline refusals while
 * still missing everything another terminal filed. The server decides, and says
 * so through partial acceptance.
 */
@HiltViewModel
class WriteoffViewModel(
    private val gateway: WriteoffGateway,
    private val session: SessionHolder,
    scans: ScanEvents,
    private val recovery: DeviceRecovery,
    private val signals: SignalPort,
) : ViewModel() {
    @Inject
    constructor(
        gateway: WriteoffGateway,
        session: SessionHolder,
        scans: ScanEvents,
        recovery: DeviceRecovery,
        signaller: Signaller,
    ) : this(gateway, session, scans, recovery, { signaller.play(it) })

    private val _state = MutableStateFlow(WriteoffUi())
    val state: StateFlow<WriteoffUi> = _state.asStateFlow()

    private val operatorId: String? get() = session.state.value.operator?.operatorId

    init {
        _state.update { it.copy(operatorName = session.state.value.operator?.name.orEmpty()) }
        // The gate is decided before the first scan is read, not beside it: a mode
        // that refuses an operator must refuse them before they scan, not after.
        viewModelScope.launch {
            val id = operatorId
            val permitted = if (id == null) null else runCatching { recovery.work { gateway.canWriteoff(id) } }.getOrNull()
            val ready = runCatching { recovery.work { gateway.catalogueReady() } }.getOrDefault(false)
            _state.update {
                it.copy(
                    blocked = when {
                        permitted == false -> Blocked.NO_PERMISSION
                        !ready -> Blocked.NEVER_SYNCED
                        else -> it.blocked
                    },
                )
            }
            scans.events.collect { event -> if (_state.value.blocked == null) onScan(event.raw) }
        }
        viewModelScope.launch {
            gateway.observeReasons().collectLatest { reasons ->
                _state.update { ui ->
                    ui.copy(
                        reasons = reasons,
                        // An empty dictionary blocks; a filled one clears only that block.
                        blocked = when {
                            ui.blocked == Blocked.NO_PERMISSION || ui.blocked == Blocked.NEVER_SYNCED -> ui.blocked
                            reasons.isEmpty() -> Blocked.NO_REASONS
                            else -> null
                        },
                    )
                }
            }
        }
        viewModelScope.launch { gateway.stampAt.collectLatest { at -> _state.update { it.copy(stampAt = at) } } }
        viewModelScope.launch { runCatching { gateway.refreshMirror() } }
    }

    private suspend fun onScan(raw: String) {
        if (_state.value.step != WriteoffStep.LIST) return
        when (val input = ScanClassifier.classify(raw)) {
            is ScanInput.Km -> addUnit(input)
            is ScanInput.Sscc -> addBox(input.sscc)
            is ScanInput.Gtin, is ScanInput.Unknown -> verdict(Verdict.NotACode, SignalKind.ERROR)
        }
    }

    private suspend fun addUnit(input: ScanInput.Km) {
        val key = KmCodec.key(input.km)
        val tail = input.km.serial.takeLast(TAIL)
        if (_state.value.lines.any { it.holds(key) }) return verdict(Verdict.Duplicate(tail), SignalKind.DUPLICATE)
        val name = runCatching { recovery.work { gateway.productName(input.km.gtin14) } }.getOrNull()
            ?: return verdict(Verdict.UnknownProduct, SignalKind.ERROR)
        _state.update { it.withLine(WriteoffLine.Unit(input.km, name)) }
        verdict(Verdict.Accepted(tail), SignalKind.OK)
    }

    private suspend fun addBox(sscc: String) {
        val tail = sscc.takeLast(TAIL)
        if (_state.value.lines.any { it.holds(sscc) }) return verdict(Verdict.Duplicate(tail), SignalKind.DUPLICATE)
        val box = runCatching { recovery.work { gateway.box(sscc) } }.getOrNull()
            ?: return verdict(Verdict.UnknownBox, SignalKind.ERROR)
        val keys = box.keys()
        // A box whose units are already loose in the list would double-count them.
        if (keys.any { key -> _state.value.lines.any { it.holds(key) } }) {
            return verdict(Verdict.Duplicate(tail), SignalKind.DUPLICATE)
        }
        val name = runCatching { recovery.work { gateway.productNameById(box.productId) } }.getOrNull().orEmpty()
        _state.update { it.withLine(WriteoffLine.Box(sscc, name, box.bottleCount, keys)) }
        verdict(Verdict.Accepted(tail), SignalKind.OK)
    }

    private fun WriteoffLine.holds(key: String): Boolean = when (this) {
        is WriteoffLine.Unit -> this.key == key
        is WriteoffLine.Box -> this.key == key || key in contentKeys
    }

    private fun WriteoffUi.withLine(line: WriteoffLine): WriteoffUi {
        val next = lines + line
        return copy(
            lines = next,
            unitCount = next.sumOf { if (it is WriteoffLine.Unit) 1 else (it as WriteoffLine.Box).count },
            boxCount = next.count { it is WriteoffLine.Box },
        )
    }

    private fun verdict(verdict: Verdict, signal: SignalKind) {
        signals.play(signal)
        _state.update { it.copy(lastVerdict = verdict) }
    }

    fun remove(line: WriteoffLine) = _state.update { ui ->
        val next = ui.lines.filterNot { it.key == line.key }
        ui.copy(
            lines = next,
            unitCount = next.sumOf { if (it is WriteoffLine.Unit) 1 else (it as WriteoffLine.Box).count },
            boxCount = next.count { it is WriteoffLine.Box },
        )
    }

    fun next() = _state.update { if (it.lines.isEmpty()) it else it.copy(step = WriteoffStep.REASON) }

    fun selectReason(reason: WriteoffReasonEntity) = _state.update { it.copy(selectedReason = reason) }

    fun toConfirm() = _state.update { if (it.selectedReason == null) it else it.copy(step = WriteoffStep.CONFIRM) }

    fun confirm() {
        val ui = _state.value
        val reason = ui.selectedReason ?: return
        val id = operatorId ?: return
        if (ui.lines.isEmpty() || ui.step == WriteoffStep.RESULT) return
        viewModelScope.launch {
            val documentId = runCatching { gateway.file(id, reason, ui.lines) }.getOrNull() ?: return@launch
            _state.update { it.copy(step = WriteoffStep.RESULT, filedDocumentId = documentId) }
            gateway.observeDocument(documentId).collectLatest { row -> _state.update { it.copy(filed = row) } }
        }
    }

    /** Back: a step inside the mode, or a question before discarding a built list. */
    fun back(): Boolean = when (_state.value.step) {
        WriteoffStep.CONFIRM -> {
            _state.update { it.copy(step = WriteoffStep.REASON) }
            true
        }
        WriteoffStep.REASON -> {
            _state.update { it.copy(step = WriteoffStep.LIST) }
            true
        }
        WriteoffStep.LIST -> if (_state.value.lines.isEmpty()) {
            false
        } else {
            _state.update { it.copy(confirmDiscard = true) }
            true
        }
        WriteoffStep.RESULT -> false
    }

    fun dismissDiscard() = _state.update { it.copy(confirmDiscard = false) }

    /** After a filed document, the mode starts clean rather than reopening from the hub. */
    fun startAnother() = _state.update {
        WriteoffUi(reasons = it.reasons, operatorName = it.operatorName, stampAt = it.stampAt, blocked = it.blocked)
    }

    private companion object {
        const val TAIL = 6
    }
}
