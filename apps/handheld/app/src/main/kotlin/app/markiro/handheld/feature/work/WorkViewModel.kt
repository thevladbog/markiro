package app.markiro.handheld.feature.work

import android.util.Log
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.core.box.BoxPrinter
import app.markiro.handheld.core.box.BoxRepository
import app.markiro.handheld.core.box.CloseBox
import app.markiro.handheld.core.box.CloseResult
import app.markiro.handheld.core.box.PrintOutcome
import app.markiro.handheld.core.km.Verdict
import app.markiro.handheld.core.network.ReachabilityTracker
import app.markiro.handheld.core.scan.ScanEvents
import app.markiro.handheld.core.scan.ScanOutcome
import app.markiro.handheld.core.scan.ScanRecorder
import app.markiro.handheld.core.signal.SignalKind
import app.markiro.handheld.core.signal.Signaller
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.ScanEventEntity
import app.markiro.handheld.core.storage.ShiftEntity
import app.markiro.handheld.core.sync.SyncEngine
import app.markiro.handheld.core.sync.SyncState
import app.markiro.handheld.feature.shift.ShiftRepository
import app.markiro.handheld.feature.signin.SessionHolder
import app.markiro.handheld.feature.signin.SessionState
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicBoolean
import javax.inject.Inject

/** Seam for the signaller so tests can record kinds. */
fun interface SignalPort {
    fun play(kind: SignalKind)
}

data class LastScan(val verdict: Verdict, val tail: String, val firstSeenAt: String?, val at: String)

/** The open box, as the fill grid needs it. Null outside an aggregation shift. */
data class BoxUi(val ordinal: Int, val filled: Int, val capacity: Int)

/** The closed box a print state is about, carried so no step has to look it up again. */
data class ClosedBoxUi(val boxId: String, val ordinal: Int, val sscc: String, val itemCount: Int)

/** What the full-screen close state is showing. */
sealed interface BoxCloseStep {
    data object Idle : BoxCloseStep
    data class Printing(val box: ClosedBoxUi) : BoxCloseStep
    data class Printed(val box: ClosedBoxUi) : BoxCloseStep
    data class Failed(val box: ClosedBoxUi, val reason: String) : BoxCloseStep

    /** The link broke partway. Nothing resends from here without a person. */
    data class Unknown(val box: ClosedBoxUi, val cause: String) : BoxCloseStep

    /** The box did not close at all, and the reason has nothing to do with printing. */
    data class Refused(val reason: CloseResult) : BoxCloseStep

    /** The box this step is about, or null when none closed. */
    fun closedBox(): ClosedBoxUi? = when (this) {
        is Printing -> box
        is Printed -> box
        is Failed -> box
        is Unknown -> box
        Idle, is Refused -> null
    }
}

data class WorkUi(
    val shift: ShiftEntity?,
    val last: LastScan?,
    val total: Int,
    val plan: Int?,
    val thisTerminal: Int,
    val errors: Int,
    val duplicates: Int,
    val feed: List<ScanEventEntity>,
    val sync: SyncState,
    val reachable: Boolean,
    val team: TeamState?,
    /** Signed-in operator; the team chip counts participants other than them. */
    val operatorId: String? = null,
    /** Present only in an aggregation shift. */
    val box: BoxUi? = null,
    /** Closed boxes on this device whose label is not resolved, across every shift. */
    val unprintedLabels: Int = 0,
)

private const val REACHABLE_WINDOW_MS = 2 * 60 * 1000L
private const val TEAM_REFRESH_MS = 60_000L

@HiltViewModel
class WorkViewModel(
    handle: SavedStateHandle,
    private val db: HandheldDatabase,
    private val recorder: ScanRecorder,
    scans: ScanEvents,
    private val signals: SignalPort,
    private val sync: SyncEngine,
    private val session: SessionHolder,
    reachability: ReachabilityTracker,
    private val team: TeamRefresher,
    private val repository: ShiftRepository?,
    private val boxes: BoxRepository,
    private val closer: CloseBox,
    private val boxPrinter: BoxPrinter,
    /** One tick per team refresh; tests pass a single tick so virtual time never loops. */
    private val teamTicks: Flow<Unit> = flow {
        while (true) {
            emit(Unit)
            delay(TEAM_REFRESH_MS)
        }
    },
) : ViewModel() {
    @Inject
    constructor(
        handle: SavedStateHandle,
        db: HandheldDatabase,
        recorder: ScanRecorder,
        scans: ScanEvents,
        signaller: Signaller,
        sync: SyncEngine,
        session: SessionHolder,
        reachability: ReachabilityTracker,
        team: TeamRefresher,
        repository: ShiftRepository,
        boxes: BoxRepository,
        closer: CloseBox,
        boxPrinter: BoxPrinter,
    ) : this(
        handle, db, recorder, scans, { signaller.play(it) }, sync, session, reachability, team, repository,
        boxes, closer, boxPrinter,
    )

    val shiftId: String = checkNotNull(handle["shiftId"])
    private val last = MutableStateFlow<LastScan?>(null)
    private val teamState = MutableStateFlow<TeamState?>(null)
    private val boxUi = MutableStateFlow<BoxUi?>(null)

    private val closing = AtomicBoolean(false)

    private val _closeStep = MutableStateFlow<BoxCloseStep>(BoxCloseStep.Idle)
    val closeStep: StateFlow<BoxCloseStep> = _closeStep

    private data class Counters(val mine: Int, val errors: Int, val duplicates: Int)

    private val counters = combine(
        db.codeDao().observeCountForShift(shiftId),
        db.scanEventDao().observeCount(shiftId, Verdict.INVALID.wire),
        db.scanEventDao().observeCount(shiftId, Verdict.WRONG_GTIN.wire),
        db.scanEventDao().observeCount(shiftId, Verdict.DUPLICATE.wire),
    ) { mine, invalid, wrong, dup -> Counters(mine, invalid + wrong, dup) }

    val state: StateFlow<WorkUi> = combine(
        db.shiftDao().observe(shiftId),
        last,
        counters,
        db.scanEventDao().observeRecent(shiftId, 4),
        sync.state,
        reachability.lastSuccessAt,
        teamState,
        session.state,
        boxUi,
        boxes.observeUnprintedCount(),
    ) { values ->
        val shift = values[0] as ShiftEntity?
        val c = values[2] as Counters
        val teamNow = values[6] as TeamState?
        val lastOk = values[5] as Long?
        val operator = (values[7] as SessionState).operator
        @Suppress("UNCHECKED_CAST")
        WorkUi(
            shift = shift,
            last = values[1] as LastScan?,
            total = maxOf(teamNow?.acceptedUnits ?: 0, c.mine),
            plan = shift?.plannedQty,
            thisTerminal = c.mine,
            errors = c.errors,
            duplicates = c.duplicates,
            feed = values[3] as List<ScanEventEntity>,
            sync = values[4] as SyncState,
            reachable = lastOk != null && System.currentTimeMillis() - lastOk <= REACHABLE_WINDOW_MS,
            team = teamNow,
            operatorId = operator?.operatorId,
            box = values[8] as BoxUi?,
            unprintedLabels = values[9] as Int,
        )
    }.stateIn(viewModelScope, SharingStarted.Eagerly, WorkUi(null, null, 0, null, 0, 0, 0, emptyList(), SyncState(), false, null))

    init {
        // An aggregation shift shows its box from the moment it opens. Waiting for
        // the first scan means the operator meets the validation layout and the
        // grid appears from nowhere.
        viewModelScope.launch { showCurrentBox() }
        // Each scan is handled inside its own guard. A failure on one -- a print
        // that throws, a template that will not render -- must not take the
        // collector down with it: the app would keep looking alive while silently
        // recording nothing, which is the worst thing a scanner can do.
        viewModelScope.launch {
            scans.events.collect { event ->
                try {
                    onScan(event.raw)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    Log.e("markiro.work", "scan handling failed", e)
                }
            }
        }
        viewModelScope.launch {
            teamTicks.collect { teamState.value = team.refresh(shiftId) ?: teamState.value }
        }
    }

    private suspend fun onScan(raw: String) {
        val shift = db.shiftDao().get(shiftId) ?: return
        if (shift.productGtin14 == null || shift.status == "closed") return
        // A scan arriving while the close screen is up belongs to the NEXT box, and
        // `currentBox` gives it exactly that: the closed row is no longer open. It
        // is deliberately not dropped -- an operator whose unit vanished with no
        // sound and no count has no way to know it needs scanning again.
        val aggregating = shift.mode == "aggregation"
        val box = if (aggregating) boxes.currentBox(shiftId) else null
        val outcome = recorder.record(shift, raw, session.state.value.operator?.operatorId, box?.boxId)
        last.value = outcome.toLastScan(raw)
        sync.nudge()

        val capacity = shift.boxCapacity ?: 0
        if (box != null) refreshBox(box.boxId, capacity)
        if (box != null && outcome.verdict == Verdict.OK && capacity > 0 && boxes.itemCount(box.boxId) >= capacity) {
            // The box's own signal, not one more accepted unit.
            signals.play(SignalKind.BOX_DONE)
            closeAndPrint(shift)
            return
        }
        signals.play(Signaller.forVerdict(outcome.verdict))
    }

    private suspend fun refreshBox(boxId: String, capacity: Int) {
        val row = boxes.get(boxId) ?: return
        boxUi.value = BoxUi(boxes.ordinal(row), boxes.itemCount(boxId), capacity)
    }

    /**
     * The open box, or the one the next scan will open.
     *
     * Deliberately does not CREATE a row: opening the screen is not packing, and a
     * box row created per visit would give the shift a trail of empty boxes and
     * make the drawn number jump.
     */
    private suspend fun showCurrentBox() {
        val shift = db.shiftDao().get(shiftId) ?: return
        if (shift.mode != "aggregation") return
        val capacity = shift.boxCapacity ?: 0
        val open = db.boxDao().open(shiftId)
        boxUi.value = if (open != null) {
            BoxUi(boxes.ordinal(open), boxes.itemCount(open.boxId), capacity)
        } else {
            BoxUi(boxes.closedCount(shiftId) + 1, 0, capacity)
        }
    }

    /** «Закрыть короб досрочно», with the operator having seen the count inside. */
    fun closeEarly() {
        // A second tap while the first close is still running would queue a close
        // of the box that first one just opened. `CloseBox` serialises them
        // anyway; this stops the pointless second attempt from being started.
        if (!closing.compareAndSet(false, true)) return
        viewModelScope.launch {
            try {
                val shift = db.shiftDao().get(shiftId) ?: return@launch
                closeAndPrint(shift)
            } finally {
                closing.set(false)
            }
        }
    }

    private suspend fun closeAndPrint(shift: ShiftEntity) {
        when (val result = closer.close(shiftId, shift.ssccIssuerPrefix, session.state.value.operator?.operatorId)) {
            is CloseResult.Closed -> {
                val closed = ClosedBoxUi(
                    boxId = result.box.boxId,
                    ordinal = boxes.ordinal(result.box),
                    sscc = result.sscc,
                    itemCount = result.itemCount,
                )
                _closeStep.value = BoxCloseStep.Printing(closed)
                showCurrentBox()
                _closeStep.value = attempt(closed)
                // The closure is queued the moment the box closes, whatever the
                // printer did: the label is a separate debt.
                sync.nudge()
            }
            else -> _closeStep.value = BoxCloseStep.Refused(result)
        }
    }

    private suspend fun attempt(closed: ClosedBoxUi): BoxCloseStep = when (val printed = boxPrinter.print(closed.boxId)) {
        PrintOutcome.Printed -> BoxCloseStep.Printed(closed)
        is PrintOutcome.Failed -> BoxCloseStep.Failed(closed, printed.reason)
        is PrintOutcome.Unknown -> BoxCloseStep.Unknown(closed, printed.cause)
    }

    /** An explicit second send, chosen by a person who has looked at the printer. */
    fun retryPrint() {
        val closed = _closeStep.value.closedBox() ?: return
        viewModelScope.launch {
            _closeStep.value = BoxCloseStep.Printing(closed)
            _closeStep.value = attempt(closed)
        }
    }

    /**
     * The operator looked at the printer and says the label is there. Nothing is
     * sent.
     *
     * The screen goes first and the row is updated behind it: a person who has
     * just answered a question should not wait on a database write, and the write
     * is idempotent either way.
     */
    fun confirmPrinted() {
        val closed = _closeStep.value.closedBox()
        _closeStep.value = BoxCloseStep.Idle
        if (closed != null) viewModelScope.launch { boxPrinter.resolveUnknownAsPrinted(closed.boxId) }
    }

    /** Set aside for later, so a dead printer does not stop the line. */
    fun deferLabel() {
        val closed = _closeStep.value.closedBox()
        _closeStep.value = BoxCloseStep.Idle
        if (closed != null) viewModelScope.launch { boxPrinter.defer(closed.boxId) }
    }

    fun dismissClose() {
        _closeStep.value = BoxCloseStep.Idle
    }

    private fun ScanOutcome.toLastScan(raw: String) = LastScan(
        verdict = verdict,
        tail = (km?.serial ?: raw).let { if (it.length > 8) "…" + it.takeLast(8) else it },
        firstSeenAt = firstSeenAt,
        at = scannedAt,
    )

    fun leave() {
        viewModelScope.launch { repository?.leave(shiftId) }
    }
}
