package app.markiro.handheld.feature.shift

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.core.barcode.ShiftTaskToken
import app.markiro.handheld.core.network.ReachabilityTracker
import app.markiro.handheld.core.network.ShiftDto
import app.markiro.handheld.core.scan.ScanEvents
import app.markiro.handheld.core.storage.DeviceConfigDao
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.DeviceRecovery
import app.markiro.handheld.core.storage.ShiftEntity
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

data class OtherLine(val id: String, val name: String, val shifts: List<ShiftDto>)

sealed interface ShiftDialog {
    /**
     * @param entryMethod What confirming should send: `"list"` when the operator tapped
     * the card, `"task_barcode"` when a form scan opened this same confirmation.
     */
    data class ConfirmOther(val shift: ShiftDto, val lineName: String, val entryMethod: String = "list") : ShiftDialog
    data object Entering : ShiftDialog
    data object UpdateRequired : ShiftDialog
    data object Closed : ShiftDialog
    data object Unavailable : ShiftDialog
    data class Refused(val step: EnterStep, val status: Int, val code: String?) : ShiftDialog
    /** The scanned form's barcode matched no shift already mirrored on this device. */
    data object BarcodeUnknown : ShiftDialog
}

data class ShiftListUi(
    val loading: Boolean,
    val continueShift: ShiftEntity?,
    val mine: List<ShiftEntity>,
    val others: List<OtherLine>,
    val othersExpanded: Boolean,
    val othersLoading: Boolean,
    val listFetchedAt: Long?,
    val reachable: Boolean,
    val ownLineName: String?,
    val dialog: ShiftDialog?,
    /**
     * The last refresh did not reach the server. Without this the screen is
     * identical either way, and pull-to-refresh is worse than nothing: the
     * spinner turns, the list does not change, and nothing says why.
     */
    val refreshFailed: Boolean = false,
    val othersFailed: Boolean = false,
)

sealed interface ShiftListEvent {
    data class Entered(val shiftId: String) : ShiftListEvent
}

private const val REACHABLE_WINDOW_MS = 2 * 60 * 1000L
private const val REACHABLE_TICK_MS = 30 * 1000L

private data class Lists(val current: ShiftEntity?, val mine: List<ShiftEntity>, val config: DeviceConfigEntity?, val reachable: Boolean)

@HiltViewModel
class ShiftListViewModel(
    private val repository: ShiftRepository,
    private val config: DeviceConfigDao,
    private val recovery: DeviceRecovery,
    reachability: ReachabilityTracker,
    scans: ScanEvents,
    /** Re-evaluates the reachability window while nothing else changes; tests pass a single tick. */
    tick: Flow<Unit>,
) : ViewModel() {
    @Inject
    constructor(repository: ShiftRepository, config: DeviceConfigDao, recovery: DeviceRecovery, reachability: ReachabilityTracker, scans: ScanEvents) : this(
        repository,
        config,
        recovery,
        reachability,
        scans,
        flow {
            while (true) {
                emit(Unit)
                delay(REACHABLE_TICK_MS)
            }
        },
    )

    val grantDenial = app.markiro.handheld.core.grants.GrantDenialUi()

    private val generation = recovery.token()

    private fun launchOwned(block: suspend CoroutineScope.() -> Unit) = viewModelScope.launch {
        try { recovery.work(generation) { block() } }
        catch (_: app.markiro.handheld.core.grants.GrantDenied) { dialog.value=null; grantDenial.show() }
    }

    private val now: () -> Long = System::currentTimeMillis
    private val loading = MutableStateFlow(true)
    private val others = MutableStateFlow<List<OtherLine>>(emptyList())
    private val othersExpanded = MutableStateFlow(false)
    private val othersLoading = MutableStateFlow(false)
    private val refreshFailed = MutableStateFlow(false)
    private val othersFailed = MutableStateFlow(false)
    private val dialog = MutableStateFlow<ShiftDialog?>(null)
    private val _events = MutableSharedFlow<ShiftListEvent>(extraBufferCapacity = 1)
    val events: SharedFlow<ShiftListEvent> = _events

    private val lists = combine(repository.observeShifts(), config.observe(), reachability.lastSuccessAt, tick) { shifts, cfg, lastOk, _ ->
        val open = shifts.filter { it.status != "closed" }
        val current = cfg?.activeShiftId?.let { id -> open.firstOrNull { it.id == id } }
        val mine = open.filter { it.id != current?.id && (it.lineId == cfg?.lineId || it.lineId == null) }
        Lists(current, mine, cfg, lastOk != null && now() - lastOk <= REACHABLE_WINDOW_MS)
    }

    val state: StateFlow<ShiftListUi> =
        combine(lists, loading, others, othersExpanded, othersLoading, dialog, refreshFailed, othersFailed) { values ->
            val lists = values[0] as Lists
            @Suppress("UNCHECKED_CAST")
            ShiftListUi(
                loading = values[1] as Boolean,
                continueShift = lists.current,
                mine = lists.mine,
                others = values[2] as List<OtherLine>,
                othersExpanded = values[3] as Boolean,
                othersLoading = values[4] as Boolean,
                listFetchedAt = lists.mine.maxOfOrNull { it.listFetchedAt } ?: lists.current?.listFetchedAt,
                reachable = lists.reachable,
                ownLineName = lists.config?.lineName,
                dialog = values[5] as ShiftDialog?,
                refreshFailed = values[6] as Boolean,
                othersFailed = values[7] as Boolean,
            )
        }.stateIn(viewModelScope, SharingStarted.Eagerly, ShiftListUi(true, null, emptyList(), emptyList(), false, false, null, false, null, null))

    init {
        launchOwned { scans.events.collect { event ->
            try { onScan(event.raw) }
            catch (_: app.markiro.handheld.core.grants.GrantDenied) { dialog.value=null; grantDenial.show() }
        } }
        refresh()
    }

    fun refresh() {
        launchOwned {
            loading.value = true
            // `refreshList` has always returned whether it reached the server;
            // nobody read it, so a refused or unreachable refresh left the
            // operator looking at yesterday's list with no sign of it.
            refreshFailed.value = !repository.refreshList()
            loading.value = false
        }
    }

    fun expandOthers() {
        if (othersExpanded.value) return
        othersExpanded.value = true
        launchOwned {
            othersLoading.value = true
            val lines = runCatching { repository.otherLines(config.get()?.lineId) }
            othersFailed.value = lines.isFailure
            others.value = lines.getOrDefault(emptyList()).map { line ->
                OtherLine(line.id, line.name, runCatching { repository.shiftsOfLine(line.id) }.getOrDefault(emptyList()))
            }
            othersLoading.value = false
        }
    }

    fun select(shift: ShiftEntity) {
        if (shift.bundleFetchedAt == null && !state.value.reachable) {
            dialog.value = ShiftDialog.Unavailable
            return
        }
        enter(shift.id, "list")
    }

    fun continueCurrent() {
        state.value.continueShift?.let { enter(it.id, "list") }
    }

    fun selectOther(shift: ShiftDto, lineName: String) {
        dialog.value = ShiftDialog.ConfirmOther(shift, lineName)
    }

    fun confirmOther() {
        val d = dialog.value as? ShiftDialog.ConfirmOther ?: return
        enter(d.shift.id, d.entryMethod)
    }

    fun dismissDialog() {
        dialog.value = null
    }

    /**
     * The printed form's barcode is a shortcut to the card, not a key: a shift
     * of another line still goes through the same confirmation the list would
     * show. Resolution first checks everything already visible to the
     * operator on this screen -- this device's own list plus any other-line
     * groups already expanded via `expandOthers()`. An other-line shift lives
     * only in that in-memory `others` state until it is entered: the server
     * scopes a line-less refresh to this device's own line (plus unassigned
     * shifts), so `expandOthers()` never writes an other-line shift into Room.
     * `repository.listed(...)` is the fallback, covering a shift cached from a
     * previous entry but no longer in either visible list -- a closed shift,
     * for instance, which both lists above always exclude. No lookup endpoint
     * exists for a scan, and none is added here.
     */
    private suspend fun onScan(raw: String) {
        if (dialog.value != null) return
        val shiftId = ShiftTaskToken.parse(raw.trim()) ?: return
        val ui = state.value
        val visible = (listOfNotNull(ui.continueShift) + ui.mine).map { it.toDto() } + ui.others.flatMap { it.shifts }
        val match = visible.firstOrNull { it.id == shiftId } ?: repository.listed(shiftId)?.toDto()
        if (match == null) {
            dialog.value = ShiftDialog.BarcodeUnknown
            return
        }
        if (match.status == "closed") {
            dialog.value = ShiftDialog.Closed
            // Matches the `EnterResult.Closed` branch of `enter()`: the dialog's own
            // text claims the list was refreshed, so this scan path must actually do
            // it too, not just leave the stale row for the operator to dismiss into.
            repository.refreshList()
            return
        }
        val ownLine = config.get()?.lineId
        if (match.lineId != null && match.lineId != ownLine) {
            dialog.value = ShiftDialog.ConfirmOther(match, match.lineName.orEmpty(), entryMethod = "task_barcode")
            return
        }
        enter(match.id, "task_barcode")
    }

    private fun enter(shiftId: String, entryMethod: String) {
        launchOwned {
            dialog.value = ShiftDialog.Entering
            when (val result = repository.enter(shiftId, entryMethod)) {
                EnterResult.Ok -> {
                    dialog.value = null
                    _events.emit(ShiftListEvent.Entered(shiftId))
                }
                EnterResult.UpdateRequired -> dialog.value = ShiftDialog.UpdateRequired
                EnterResult.Closed -> {
                    dialog.value = ShiftDialog.Closed
                    repository.refreshList()
                }
                EnterResult.Unavailable -> dialog.value = ShiftDialog.Unavailable
                // Also refreshed: a 404 can simply mean the cached list is behind.
                is EnterResult.Refused -> {
                    dialog.value = ShiftDialog.Refused(result.step, result.status, result.code)
                    repository.refreshList()
                }
            }
        }
    }
}
