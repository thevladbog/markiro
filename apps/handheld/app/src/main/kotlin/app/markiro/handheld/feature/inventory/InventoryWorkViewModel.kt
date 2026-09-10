package app.markiro.handheld.feature.inventory

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.core.inventory.InventoryRecorder
import app.markiro.handheld.core.inventory.InventorySyncEngine
import app.markiro.handheld.core.inventory.InventorySyncState
import app.markiro.handheld.core.inventory.InventoryVerdict
import app.markiro.handheld.core.inventory.LocalClaim
import app.markiro.handheld.core.inventory.RecordOutcome
import app.markiro.handheld.core.network.ReachabilityTracker
import app.markiro.handheld.core.scan.ScanEvents
import app.markiro.handheld.core.signal.SignalKind
import app.markiro.handheld.core.signal.Signaller
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.InventoryEventEntity
import app.markiro.handheld.core.storage.InventoryTaskEntity
import app.markiro.handheld.core.storage.InventoryTerminalStateEntity
import app.markiro.handheld.feature.signin.SessionHolder
import app.markiro.handheld.feature.work.SignalPort
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

data class InventoryLastScan(
    val verdict: InventoryVerdict,
    val tail: String?,
    val winner: LocalClaim?,
    val ownDevice: Boolean,
    val boxCounted: Int?,
    val boxTotal: Int?,
    val sourceStatus: String?,
    val invalidReason: String?,
)

data class InventoryProgress(
    val verified: Int = 0,
    val discrepancies: Int = 0,
    val protected: Int = 0,
    val thisTerminal: Int = 0,
    val rejected: Int = 0,
)

data class InventoryWorkUi(
    val task: InventoryTaskEntity?,
    val expectedCount: Int,
    val activeDate: String?,
    val last: InventoryLastScan?,
    val progress: InventoryProgress,
    val feed: List<InventoryEventEntity>,
    val sync: InventorySyncState,
    val reachable: Boolean,
    val held: RecordOutcome.DateMismatch?,
    val closed: Boolean,
)

private const val REACHABLE_WINDOW_MS = 2 * 60 * 1000L
private const val REACHABLE_TICK_MS = 30 * 1000L

@OptIn(ExperimentalCoroutinesApi::class)
@HiltViewModel
class InventoryWorkViewModel(
    handle: SavedStateHandle,
    private val db: HandheldDatabase,
    private val recorder: InventoryRecorder,
    scans: ScanEvents,
    private val signals: SignalPort,
    private val sync: InventorySyncEngine,
    private val session: SessionHolder,
    reachability: ReachabilityTracker,
) : ViewModel() {
    @Inject
    constructor(
        handle: SavedStateHandle,
        db: HandheldDatabase,
        recorder: InventoryRecorder,
        scans: ScanEvents,
        signaller: Signaller,
        sync: InventorySyncEngine,
        session: SessionHolder,
        reachability: ReachabilityTracker,
    ) : this(handle, db, recorder, scans, { signaller.play(it) }, sync, session, reachability)

    val inventoryId: String = checkNotNull(handle["inventoryId"])
    private val last = MutableStateFlow<InventoryLastScan?>(null)
    private val held = MutableStateFlow<RecordOutcome.DateMismatch?>(null)

    private val progress = db.deviceConfigDao().observe().flatMapLatest { cfg ->
        val deviceId = cfg?.deviceId ?: ""
        combine(
            db.inventoryResultDao().observeCount(inventoryId, "expected"),
            db.inventoryResultDao().observeCount(inventoryId, "known-ineligible"),
            db.inventoryResultDao().observeCount(inventoryId, "unknown"),
            db.inventoryEventDao().observeUnknownIdentities(inventoryId),
            db.inventoryResultDao().observeCount(inventoryId, "protected"),
            db.inventoryResultDao().observeCountForDevice(inventoryId, deviceId),
            db.inventoryEventDao().observeCountByServerStatus(inventoryId, "rejected"),
        ) { v -> InventoryProgress(verified = v[0], discrepancies = v[1] + v[2] + v[3], protected = v[4], thisTerminal = v[5], rejected = v[6]) }
    }

    /**
     * Re-evaluates the reachability window while nothing else emits (an idle handheld that just went offline).
     * Runs off the main dispatcher so test schedulers never see an endless timer.
     */
    private val ticker = flow {
        while (true) {
            emit(Unit)
            delay(REACHABLE_TICK_MS)
        }
    }.flowOn(Dispatchers.Default)

    val state: StateFlow<InventoryWorkUi> = combine(
        db.inventoryTaskDao().observe(inventoryId),
        db.inventoryTerminalStateDao().observe(inventoryId),
        last,
        progress,
        db.inventoryEventDao().observeRecent(inventoryId, 4),
        sync.state,
        reachability.lastSuccessAt,
        held,
        ticker,
    ) { v ->
        val task = v[0] as InventoryTaskEntity?
        val terminal = v[1] as InventoryTerminalStateEntity?
        val lastOk = v[6] as Long?
        @Suppress("UNCHECKED_CAST")
        InventoryWorkUi(
            task = task,
            expectedCount = task?.expectedCount ?: 0,
            activeDate = terminal?.activeProductionDate ?: task?.productionDateFrom,
            last = v[2] as InventoryLastScan?,
            progress = v[3] as InventoryProgress,
            feed = v[4] as List<InventoryEventEntity>,
            sync = v[5] as InventorySyncState,
            reachable = lastOk != null && System.currentTimeMillis() - lastOk <= REACHABLE_WINDOW_MS,
            held = v[7] as RecordOutcome.DateMismatch?,
            closed = task?.state == "closed",
        )
    }.stateIn(
        viewModelScope,
        SharingStarted.Eagerly,
        InventoryWorkUi(null, 0, null, null, InventoryProgress(), emptyList(), InventorySyncState(), false, null, false),
    )

    init {
        viewModelScope.launch { scans.events.collect { onScan(it.raw) } }
        sync.nudge()
    }

    private suspend fun onScan(raw: String, acceptMismatch: Boolean = false) {
        val task = db.inventoryTaskDao().get(inventoryId) ?: return
        if (task.state != "active") return
        if (held.value != null && !acceptMismatch) {
            // A held scan owns the screen: further scans are dropped loudly, as on the station.
            signals.play(SignalKind.ERROR)
            return
        }
        val operatorId = session.state.value.operator?.operatorId ?: return
        when (val outcome = recorder.record(inventoryId, raw, operatorId, acceptMismatch)) {
            is RecordOutcome.DateMismatch -> {
                held.value = outcome
                last.value = null
                signals.play(SignalKind.ERROR)
            }
            is RecordOutcome.Recorded -> {
                held.value = null
                signals.play(outcome.verdict.signal())
                val ownDevice = db.deviceConfigDao().get()?.deviceId
                last.value = InventoryLastScan(
                    verdict = outcome.verdict,
                    tail = outcome.tail,
                    winner = outcome.winner,
                    ownDevice = outcome.winner?.deviceId == ownDevice,
                    boxCounted = if (outcome.scanKind == "known_box") outcome.claimedCount else null,
                    boxTotal = if (outcome.scanKind == "known_box") outcome.boxChildCount else null,
                    sourceStatus = outcome.sourceStatus,
                    invalidReason = outcome.invalidReason,
                )
                if (outcome.eventId != null) sync.nudge()
            }
        }
    }

    /** «Установить дату и зачесть»: the code's date becomes active, then the held scan is recorded normally. */
    fun applyDateAndAccept() {
        val h = held.value ?: return
        val date = h.codeDate ?: return
        viewModelScope.launch {
            val operatorId = session.state.value.operator?.operatorId ?: return@launch
            recorder.setActiveDate(inventoryId, date, operatorId)
            onScan(h.raw, acceptMismatch = true)
        }
    }

    fun acceptAsIs() {
        val h = held.value ?: return
        viewModelScope.launch { onScan(h.raw, acceptMismatch = true) }
    }

    fun skipHeld() {
        held.value = null
    }

    fun setDate(date: String) {
        viewModelScope.launch {
            val operatorId = session.state.value.operator?.operatorId ?: return@launch
            runCatching { recorder.setActiveDate(inventoryId, date, operatorId) }
        }
    }
}
