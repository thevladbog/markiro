package app.markiro.handheld.feature.work

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
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
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

/** Seam for the signaller so tests can record kinds. */
fun interface SignalPort {
    fun play(kind: SignalKind)
}

data class LastScan(val verdict: Verdict, val tail: String, val firstSeenAt: String?, val at: String)

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
    ) : this(handle, db, recorder, scans, { signaller.play(it) }, sync, session, reachability, team, repository)

    val shiftId: String = checkNotNull(handle["shiftId"])
    private val last = MutableStateFlow<LastScan?>(null)
    private val teamState = MutableStateFlow<TeamState?>(null)

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
    ) { values ->
        val shift = values[0] as ShiftEntity?
        val c = values[2] as Counters
        val teamNow = values[6] as TeamState?
        val lastOk = values[5] as Long?
        @Suppress("UNCHECKED_CAST")
        WorkUi(
            shift = shift,
            last = values[1] as LastScan?,
            total = teamNow?.acceptedUnits ?: c.mine,
            plan = shift?.plannedQty,
            thisTerminal = c.mine,
            errors = c.errors,
            duplicates = c.duplicates,
            feed = values[3] as List<ScanEventEntity>,
            sync = values[4] as SyncState,
            reachable = lastOk != null && System.currentTimeMillis() - lastOk <= REACHABLE_WINDOW_MS,
            team = teamNow,
        )
    }.stateIn(viewModelScope, SharingStarted.Eagerly, WorkUi(null, null, 0, null, 0, 0, 0, emptyList(), SyncState(), false, null))

    init {
        viewModelScope.launch { scans.events.collect { onScan(it.raw) } }
        viewModelScope.launch {
            teamTicks.collect { teamState.value = team.refresh(shiftId) ?: teamState.value }
        }
    }

    private suspend fun onScan(raw: String) {
        val shift = db.shiftDao().get(shiftId) ?: return
        if (shift.productGtin14 == null || shift.status == "closed") return
        val outcome = recorder.record(shift, raw, session.state.value.operator?.operatorId)
        signals.play(Signaller.forVerdict(outcome.verdict))
        last.value = outcome.toLastScan(raw)
        sync.nudge()
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
