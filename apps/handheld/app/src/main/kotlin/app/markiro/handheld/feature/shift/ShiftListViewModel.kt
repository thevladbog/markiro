package app.markiro.handheld.feature.shift

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.core.network.ReachabilityTracker
import app.markiro.handheld.core.network.ShiftDto
import app.markiro.handheld.core.storage.DeviceConfigDao
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.ShiftEntity
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

data class OtherLine(val id: String, val name: String, val shifts: List<ShiftDto>)

sealed interface ShiftDialog {
    data class ConfirmOther(val shift: ShiftDto, val lineName: String) : ShiftDialog
    data object Entering : ShiftDialog
    data object UpdateRequired : ShiftDialog
    data object Closed : ShiftDialog
    data object Unavailable : ShiftDialog
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
)

sealed interface ShiftListEvent {
    data class Entered(val shiftId: String) : ShiftListEvent
}

private const val REACHABLE_WINDOW_MS = 2 * 60 * 1000L

private data class Lists(val current: ShiftEntity?, val mine: List<ShiftEntity>, val config: DeviceConfigEntity?, val reachable: Boolean)

@HiltViewModel
class ShiftListViewModel @Inject constructor(
    private val repository: ShiftRepository,
    private val config: DeviceConfigDao,
    reachability: ReachabilityTracker,
) : ViewModel() {
    private val now: () -> Long = System::currentTimeMillis
    private val loading = MutableStateFlow(true)
    private val others = MutableStateFlow<List<OtherLine>>(emptyList())
    private val othersExpanded = MutableStateFlow(false)
    private val othersLoading = MutableStateFlow(false)
    private val dialog = MutableStateFlow<ShiftDialog?>(null)
    private val _events = MutableSharedFlow<ShiftListEvent>(extraBufferCapacity = 1)
    val events: SharedFlow<ShiftListEvent> = _events

    private val lists = combine(repository.observeShifts(), config.observe(), reachability.lastSuccessAt) { shifts, cfg, lastOk ->
        val open = shifts.filter { it.status != "closed" }
        val current = cfg?.activeShiftId?.let { id -> open.firstOrNull { it.id == id } }
        val mine = open.filter { it.id != current?.id && (it.lineId == cfg?.lineId || it.lineId == null) }
        Lists(current, mine, cfg, lastOk != null && now() - lastOk <= REACHABLE_WINDOW_MS)
    }

    val state: StateFlow<ShiftListUi> = combine(lists, loading, others, othersExpanded, othersLoading, dialog) { values ->
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
        )
    }.stateIn(viewModelScope, SharingStarted.Eagerly, ShiftListUi(true, null, emptyList(), emptyList(), false, false, null, false, null, null))

    init {
        refresh()
    }

    fun refresh() {
        viewModelScope.launch {
            loading.value = true
            repository.refreshList()
            loading.value = false
        }
    }

    fun expandOthers() {
        if (othersExpanded.value) return
        othersExpanded.value = true
        viewModelScope.launch {
            othersLoading.value = true
            val lines = runCatching { repository.otherLines(config.get()?.lineId) }.getOrDefault(emptyList())
            others.value = lines.map { line ->
                OtherLine(line.id, line.name, runCatching { repository.shiftsOfLine(line.id) }.getOrDefault(emptyList()))
            }
            othersLoading.value = false
        }
    }

    fun select(shift: ShiftEntity) {
        if (shift.mode == "aggregation") return
        if (shift.bundleFetchedAt == null && !state.value.reachable) {
            dialog.value = ShiftDialog.Unavailable
            return
        }
        enter(shift.id, null)
    }

    fun continueCurrent() {
        state.value.continueShift?.let { enter(it.id, null) }
    }

    fun selectOther(shift: ShiftDto, lineName: String) {
        dialog.value = ShiftDialog.ConfirmOther(shift, lineName)
    }

    fun confirmOther() {
        val d = dialog.value as? ShiftDialog.ConfirmOther ?: return
        enter(d.shift.id, d.shift)
    }

    fun dismissDialog() {
        dialog.value = null
    }

    private fun enter(shiftId: String, fallback: ShiftDto?) {
        viewModelScope.launch {
            dialog.value = ShiftDialog.Entering
            when (repository.enter(shiftId, fallback)) {
                EnterResult.Ok -> {
                    dialog.value = null
                    _events.emit(ShiftListEvent.Entered(shiftId))
                }
                EnterResult.UpdateRequired -> dialog.value = ShiftDialog.UpdateRequired
                EnterResult.Closed -> {
                    dialog.value = ShiftDialog.Closed
                    repository.refreshList()
                }
                EnterResult.AggregationUnsupported -> dialog.value = null
                EnterResult.Unavailable -> dialog.value = ShiftDialog.Unavailable
            }
        }
    }
}
