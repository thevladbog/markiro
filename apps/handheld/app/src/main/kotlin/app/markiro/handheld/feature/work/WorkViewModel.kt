package app.markiro.handheld.feature.work

import android.util.Log
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.core.box.BoxPrinter
import app.markiro.handheld.core.box.BoxPrint
import app.markiro.handheld.core.box.BoxRepository
import app.markiro.handheld.core.exceptions.ExceptionEngine
import app.markiro.handheld.core.exceptions.ReprintReason
import app.markiro.handheld.core.box.CloseBox
import app.markiro.handheld.core.box.CloseResult
import app.markiro.handheld.core.box.PrintOutcome
import app.markiro.handheld.core.duplicate.DuplicateJobs
import app.markiro.handheld.core.duplicate.DuplicateMatch
import app.markiro.handheld.core.duplicate.DuplicateOutcome
import app.markiro.handheld.core.duplicate.DuplicateReason
import app.markiro.handheld.core.duplicate.DuplicateSend
import app.markiro.handheld.core.duplicate.JobStatus
import app.markiro.handheld.core.duplicate.Verification
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
import app.markiro.handheld.core.util.Iso
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

data class LastScan(
    val verdict: Verdict,
    val tail: String,
    val firstSeenAt: String?,
    val at: String,
    /**
     * Set when the scan was REFUSED rather than judged.
     *
     * Reusing `Verdict.INVALID` told the operator «НЕВЕРНЫЙ КОД» for a perfectly
     * good code whose only problem was that another unit's label was still
     * unresolved -- a lie, and one that sends them looking at the wrong thing.
     */
    val blocked: Boolean = false,
)

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
    /** Present only in a shift whose validation policy prints a duplicate. */
    val duplicate: DuplicateUi? = null,
)

/**
 * The duplicate's progress, in the last-scan zone rather than over the screen: a
 * duplicate prints on EVERY unit, so a full-screen state per scan would be
 * unusable. `awaitingVerification` is the one an operator cannot guess -- without
 * it they scan the next product, are told it is the wrong code, and have no idea
 * why.
 */
data class DuplicateUi(val printing: Boolean, val awaitingVerification: Boolean)

/** Shown instead of a code tail when a scan was refused rather than read. */
private const val BLOCKED_TAIL = "—"

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
    private val duplicates: DuplicateJobs,
    private val exceptions: ExceptionEngine,
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
        duplicates: DuplicateJobs,
        exceptions: ExceptionEngine,
    ) : this(
        handle, db, recorder, scans, { signaller.play(it) }, sync, session, reachability, team, repository,
        boxes, closer, boxPrinter, duplicates, exceptions,
    )

    val shiftId: String = checkNotNull(handle["shiftId"])
    private val last = MutableStateFlow<LastScan?>(null)
    private val teamState = MutableStateFlow<TeamState?>(null)
    private val boxUi = MutableStateFlow<BoxUi?>(null)

    private val closing = AtomicBoolean(false)

    private val _closeStep = MutableStateFlow<BoxCloseStep>(BoxCloseStep.Idle)
    val closeStep: StateFlow<BoxCloseStep> = _closeStep

    private val _duplicateStep = MutableStateFlow<DuplicateStep>(DuplicateStep.Idle)
    val duplicateStep: StateFlow<DuplicateStep> = _duplicateStep
    private val duplicateUi = MutableStateFlow<DuplicateUi?>(null)

    /**
     * Offered once, when the shift's accepted count crosses its plan.
     *
     * Deliberately a crossing and not «total >= plan»: entering a shift that is
     * already over plan is not the moment anyone wants to be asked, and a plain
     * comparison would raise this again on every scan after the first. Scanning
     * is never blocked -- the prompt sits over the screen while the router keeps
     * recording, because a line does not stop for a dialogue.
     */
    private val _planPrompt = MutableStateFlow(false)
    val planPrompt: StateFlow<Boolean> = _planPrompt
    private var belowPlanSeen = false

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
        duplicateUi,
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
            duplicate = values[10] as DuplicateUi?,
        )
    }.stateIn(viewModelScope, SharingStarted.Eagerly, WorkUi(null, null, 0, null, 0, 0, 0, emptyList(), SyncState(), false, null))

    init {
        // An aggregation shift shows its box from the moment it opens. Waiting for
        // the first scan means the operator meets the validation layout and the
        // grid appears from nowhere.
        viewModelScope.launch { showCurrentBox() }
        // A send the app died inside is unknown, never resumed. Emitting the
        // event is an obligation: the domain accepts only `sent` or
        // `delivery_unknown` out of `sending`, so a job left there across a
        // restart would be frozen -- no reprint, no verification, nothing.
        viewModelScope.launch {
            duplicates.demoteInterrupted()
            refreshDuplicate()
            restoreDuplicateStep()
        }
        // Each scan is handled inside its own guard. A failure on one -- a print
        // that throws, a template that will not render -- must not take the
        // collector down with it: the app would keep looking alive while silently
        // recording nothing, which is the worst thing a scanner can do.
        viewModelScope.launch {
            scans.events.collect { event ->
                // The scanner is one app-wide flow and this view model outlives
                // its screen: a back-stack entry keeps it alive while another
                // route is on top. Without this gate the SSCC scanned to
                // disassemble a box was ALSO recorded here as «НЕВЕРНЫЙ КОД»,
                // with an error beep and a bumped error counter.
                if (!scanning.value) return@collect
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
        viewModelScope.launch {
            state.collect { ui ->
                val plan = ui.plan ?: return@collect
                if (plan <= 0) return@collect
                if (ui.total < plan) {
                    belowPlanSeen = true
                } else if (belowPlanSeen) {
                    belowPlanSeen = false
                    _planPrompt.value = true
                }
            }
        }
    }

    fun dismissPlanPrompt() {
        _planPrompt.value = false
    }

    private suspend fun onScan(raw: String) {
        val shift = db.shiftDao().get(shiftId) ?: return
        if (shift.productGtin14 == null || shift.status == "closed") return
        // In a duplicate shift the open job decides what this scan IS, before
        // anything else looks at it. Getting this wrong means an operator scans
        // a sticker and the app counts it as a new unit.
        if (shift.validationPrintMode == "duplicate_dm" && routeDuplicateScan(raw)) return
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
        // Only an ACCEPTED unit gets a label. A duplicate of a code this device
        // already holds would put a second sticker on one physical item.
        if (shift.validationPrintMode == "duplicate_dm" && outcome.verdict == Verdict.OK) {
            printDuplicate(shift, raw, outcome.scannedAt)
        }
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

    /**
     * Whether the work screen currently owns scans.
     *
     * Defaults to true so a view model built outside navigation -- every test --
     * behaves as it always did; `AppNavigation` clears it while another route
     * is on top.
     */
    private val scanning = MutableStateFlow(true)

    fun setScanning(active: Boolean) {
        scanning.value = active
    }

    /** An explicit second send, chosen by a person who has looked at the printer. */
    fun retryPrint() {
        val closed = _closeStep.value.closedBox() ?: return
        // Two taps would both read the same `unknown` state before the first
        // print updated it, and each would write its own reprint fact.
        if (!retrying.compareAndSet(false, true)) return
        viewModelScope.launch {
            try {
                auditIfOutcomeUnknown(closed.boxId)
                _closeStep.value = BoxCloseStep.Printing(closed)
                _closeStep.value = attempt(closed)
            } finally {
                retrying.set(false)
            }
        }
    }

    private val retrying = AtomicBoolean(false)

    /**
     * Printing again a box whose last attempt ended `unknown` is an explicit
     * same-SSCC reprint (design brief 10 §8) and is recorded as one, with a
     * fixed reason rather than a prompt: the operator is at the printer working
     * out whether paper moved, not filling in a ledger.
     *
     * A `failed` attempt never put paper through, so retrying it is an ordinary
     * retry and writes nothing.
     */
    private suspend fun auditIfOutcomeUnknown(boxId: String) {
        val box = boxes.get(boxId) ?: return
        if (box.printState != BoxPrint.UNKNOWN) return
        exceptions.reprint(
            shiftId = box.shiftId,
            boxId = boxId,
            reason = ReprintReason.PRINT_OUTCOME_UNKNOWN,
            operatorId = session.state.value.operator?.operatorId,
            terminalId = db.deviceConfigDao().get()?.deviceId,
        )
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

    /**
     * Reads a scan against the open job, and reports whether it was consumed.
     *
     * | Open job                        | The scan is             |
     * | ------------------------------- | ----------------------- |
     * | none, or the last one completed | a new unit (false)      |
     * | prepared or sending             | refused -- «идёт печать» |
     * | awaiting_verification           | the verification        |
     * | delivery_unknown                | the verification        |
     * | failed_before_send              | refused -- reprint or fix |
     *
     * A refusal is a verdict with its own words and the error signal, never a
     * silently dropped scan: an operator whose unit vanished with no sound and
     * no count has no way to know it needs scanning again.
     */
    private suspend fun routeDuplicateScan(raw: String): Boolean {
        val job = duplicates.openJob(shiftId) ?: return false
        return when (job.status) {
            JobStatus.PREPARED, JobStatus.SENDING -> {
                refuse()
                true
            }
            JobStatus.AWAITING_VERIFICATION -> {
                verifyScan(job.jobId, raw)
                true
            }
            JobStatus.ATTENTION -> {
                // Only an unknown delivery is answerable by looking at the
                // printer. Nothing was printed in the other case, so there is
                // nothing to scan.
                if (job.attemptState == app.markiro.handheld.core.duplicate.AttemptState.DELIVERY_UNKNOWN) {
                    verifyScan(job.jobId, raw)
                } else {
                    // Nothing was printed, so there is nothing to scan. Put the
                    // job's own screen back rather than refusing into a void.
                    refuse()
                    restoreDuplicateStep()
                }
                true
            }
            else -> false
        }
    }

    /** A scan that was not judged at all: its own words, and the error signal. */
    private fun refuse() {
        last.value = LastScan(Verdict.OK, BLOCKED_TAIL, null, Iso.format(System.currentTimeMillis()), blocked = true)
        signals.play(SignalKind.ERROR)
    }

    /**
     * Puts an outstanding job's screen back after a restart.
     *
     * `_duplicateStep` lives in memory, so a job whose attempt failed or went
     * unknown is invisible once the process dies -- and the next unit is then
     * refused with nothing on screen explaining why. The row survives; the
     * screen has to be rebuilt from it.
     */
    private suspend fun restoreDuplicateStep() {
        val job = duplicates.openJob(shiftId) ?: return
        val reason = duplicates.attentionReason(job.jobId) ?: DuplicateReason.TRANSPORT_FAILED
        _duplicateStep.value = when {
            job.attemptState == app.markiro.handheld.core.duplicate.AttemptState.DELIVERY_UNKNOWN ->
                DuplicateStep.Unknown(job.jobId, reason)
            job.attemptState == app.markiro.handheld.core.duplicate.AttemptState.FAILED_BEFORE_SEND ->
                DuplicateStep.Failed(job.jobId, reason)
            // A printer that refused BEFORE the send leaves the attempt
            // `prepared` -- «нет бумаги» is no event at all. The job row is the
            // only record that it needs a person.
            job.lastFailure != null -> DuplicateStep.Failed(job.jobId, job.lastFailure)
            else -> _duplicateStep.value
        }
    }

    private suspend fun verifyScan(jobId: String, raw: String) {
        when (duplicates.verify(jobId, raw)) {
            DuplicateMatch.MATCH -> {
                _duplicateStep.value = DuplicateStep.Idle
                signals.play(SignalKind.OK)
            }
            // A rejected verification means to the operator what an error means:
            // that scan did not count, do it again. No new signal for it.
            DuplicateMatch.MISMATCH -> {
                _duplicateStep.value = DuplicateStep.Rejected(jobId, mismatch = true)
                signals.play(SignalKind.ERROR)
            }
            DuplicateMatch.INVALID -> {
                _duplicateStep.value = DuplicateStep.Rejected(jobId, mismatch = false)
                signals.play(SignalKind.ERROR)
            }
        }
        refreshDuplicate()
        sync.nudge()
    }

    /** Prepares and sends this unit's duplicate; the screen only opens if it goes wrong. */
    private suspend fun printDuplicate(shift: ShiftEntity, raw: String, scannedAt: String) {
        duplicateUi.value = DuplicateUi(printing = true, awaitingVerification = false)
        val operator = session.state.value.operator
        val hash = app.markiro.handheld.core.km.KmCodec.hash(app.markiro.handheld.core.km.KmCodec.canonicalize(raw))
        when (val prepared = duplicates.accept(shift, raw, hash, operator?.operatorId.orEmpty(), operator?.name, scannedAt)) {
            is DuplicateOutcome.Refused -> {
                // No job exists, so there is nothing to retry or reprint. The
                // unit itself is already accepted and queued -- only its label
                // is missing.
                _duplicateStep.value = DuplicateStep.Failed(null, prepared.reason)
                refreshDuplicate()
                return
            }
            is DuplicateOutcome.Prepared -> when (val sent = duplicates.send(prepared.jobId)) {
                DuplicateSend.Sent -> _duplicateStep.value = DuplicateStep.Idle
                is DuplicateSend.Failed -> _duplicateStep.value = DuplicateStep.Failed(prepared.jobId, sent.reason)
                is DuplicateSend.Unknown -> _duplicateStep.value = DuplicateStep.Unknown(prepared.jobId, sent.cause)
            }
        }
        refreshDuplicate()
        sync.nudge()
    }

    private suspend fun refreshDuplicate() {
        val job = duplicates.openJob(shiftId)
        duplicateUi.value = DuplicateUi(
            printing = job?.status == JobStatus.PREPARED || job?.status == JobStatus.SENDING,
            awaitingVerification = job?.status == JobStatus.AWAITING_VERIFICATION ||
                job?.attemptState == app.markiro.handheld.core.duplicate.AttemptState.DELIVERY_UNKNOWN,
        )
    }

    /** An explicit second send, chosen by a person who has looked at the printer. */
    fun retryDuplicate() {
        val jobId = _duplicateStep.value.jobId() ?: return
        viewModelScope.launch {
            _duplicateStep.value = DuplicateStep.Idle
            when (val sent = duplicates.send(jobId)) {
                DuplicateSend.Sent -> Unit
                is DuplicateSend.Failed -> _duplicateStep.value = DuplicateStep.Failed(jobId, sent.reason)
                is DuplicateSend.Unknown -> _duplicateStep.value = DuplicateStep.Unknown(jobId, sent.cause)
            }
            refreshDuplicate()
            sync.nudge()
        }
    }

    fun reprintDuplicate(reason: String) {
        val jobId = _duplicateStep.value.jobId() ?: return
        viewModelScope.launch {
            when (val outcome = duplicates.reprint(jobId, reason)) {
                is DuplicateOutcome.Refused -> _duplicateStep.value = DuplicateStep.Failed(jobId, outcome.reason)
                is DuplicateOutcome.Prepared -> {
                    _duplicateStep.value = DuplicateStep.Idle
                    when (val sent = duplicates.send(jobId)) {
                        DuplicateSend.Sent -> Unit
                        is DuplicateSend.Failed -> _duplicateStep.value = DuplicateStep.Failed(jobId, sent.reason)
                        is DuplicateSend.Unknown -> _duplicateStep.value = DuplicateStep.Unknown(jobId, sent.cause)
                    }
                }
            }
            refreshDuplicate()
            sync.nudge()
        }
    }

    /** Closes the screen without settling anything; the job stays outstanding. */
    fun dismissDuplicate() {
        _duplicateStep.value = DuplicateStep.Idle
    }

    fun leave() {
        viewModelScope.launch { repository?.leave(shiftId) }
    }
}
