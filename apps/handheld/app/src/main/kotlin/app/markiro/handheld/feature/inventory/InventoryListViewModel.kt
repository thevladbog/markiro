package app.markiro.handheld.feature.inventory

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.core.inventory.MirrorResult
import app.markiro.handheld.core.network.InventoryTaskDto
import app.markiro.handheld.core.network.ReachabilityTracker
import app.markiro.handheld.core.scan.ScanEvents
import app.markiro.handheld.core.storage.DeviceConfigDao
import app.markiro.handheld.core.storage.InventoryTaskEntity
import app.markiro.handheld.feature.signin.SessionHolder
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

enum class InventoryError { NOT_RUNNING, OPERATOR_UNAVAILABLE, LINE_REQUIRED, BARCODE_UNKNOWN, NEEDS_NETWORK, DOWNLOAD_FAILED, INVALID_SNAPSHOT, REPACK }

sealed interface InventoryDialog {
    data class ConfirmOther(val task: InventoryTaskDto, val barcode: String?) : InventoryDialog
    data object Joining : InventoryDialog
    data class Downloading(val number: String, val staged: Int, val total: Int) : InventoryDialog
    data class Error(val kind: InventoryError, val detail: String? = null, val retry: InventoryTaskDto? = null) : InventoryDialog
}

data class InventoryListUi(
    val loading: Boolean,
    val active: InventoryTaskEntity?,
    val mine: List<InventoryTaskDto>,
    /** Line name → tasks of other lines, filled by «Показать другие линии». */
    val others: Map<String, List<InventoryTaskDto>>,
    val othersExpanded: Boolean,
    val othersLoading: Boolean,
    val reachable: Boolean,
    val ownLineName: String?,
    val listFetchedAt: Long?,
    val dialog: InventoryDialog?,
)

sealed interface InventoryListEvent {
    data class Entered(val inventoryId: String) : InventoryListEvent
}

private const val REACHABLE_WINDOW_MS = 2 * 60 * 1000L

@HiltViewModel
class InventoryListViewModel @Inject constructor(
    private val repository: InventoryGateway,
    private val config: DeviceConfigDao,
    private val session: SessionHolder,
    reachability: ReachabilityTracker,
    scans: ScanEvents,
) : ViewModel() {
    private val now: () -> Long = System::currentTimeMillis
    private val loading = MutableStateFlow(true)
    private val mine = MutableStateFlow<List<InventoryTaskDto>>(emptyList())
    private val others = MutableStateFlow<Map<String, List<InventoryTaskDto>>>(emptyMap())
    private val othersExpanded = MutableStateFlow(false)
    private val othersLoading = MutableStateFlow(false)
    private val fetchedAt = MutableStateFlow<Long?>(null)
    private val dialog = MutableStateFlow<InventoryDialog?>(null)
    private val _events = MutableSharedFlow<InventoryListEvent>(extraBufferCapacity = 1)
    val events: SharedFlow<InventoryListEvent> = _events

    private data class Base(val active: InventoryTaskEntity?, val ownLineName: String?, val ownLineId: String?, val reachable: Boolean)

    private val base = combine(repository.observeTasks(), config.observe(), reachability.lastSuccessAt) { tasks, cfg, lastOk ->
        val active = cfg?.activeInventoryId?.let { id -> tasks.firstOrNull { it.inventoryId == id && it.state == "active" } }
        Base(active, cfg?.lineName, cfg?.lineId, lastOk != null && now() - lastOk <= REACHABLE_WINDOW_MS)
    }

    val state: StateFlow<InventoryListUi> = combine(base, loading, mine, others, othersExpanded, othersLoading, fetchedAt, dialog) { v ->
        val b = v[0] as Base
        @Suppress("UNCHECKED_CAST")
        InventoryListUi(
            loading = v[1] as Boolean,
            active = b.active,
            mine = (v[2] as List<InventoryTaskDto>).filter { it.inventoryId != b.active?.inventoryId },
            others = v[3] as Map<String, List<InventoryTaskDto>>,
            othersExpanded = v[4] as Boolean,
            othersLoading = v[5] as Boolean,
            reachable = b.reachable,
            ownLineName = b.ownLineName,
            listFetchedAt = v[6] as Long?,
            dialog = v[7] as InventoryDialog?,
        )
    }.stateIn(viewModelScope, SharingStarted.Eagerly, InventoryListUi(true, null, emptyList(), emptyMap(), false, false, false, null, null, null))

    private var ownLineId: String? = null

    init {
        viewModelScope.launch { config.observe().collect { ownLineId = it?.lineId } }
        viewModelScope.launch { scans.events.collect { onScan(it.raw) } }
        refresh()
    }

    fun refresh() {
        viewModelScope.launch {
            loading.value = true
            runCatching { repository.listTasks(null) }.onSuccess {
                mine.value = it
                fetchedAt.value = now()
            }
            loading.value = false
        }
    }

    fun expandOthers() {
        if (othersExpanded.value) return
        othersExpanded.value = true
        othersLoading.value = true
        viewModelScope.launch {
            val all = runCatching { repository.listTasks("all") }.getOrDefault(emptyList())
            val own = ownLineId
            others.value = all.filter { it.lineId != own }.groupBy { it.lineName }
            othersLoading.value = false
        }
    }

    fun continueActive() {
        val active = state.value.active ?: return
        viewModelScope.launch {
            repository.activate(active.inventoryId)
            _events.emit(InventoryListEvent.Entered(active.inventoryId))
        }
    }

    fun select(task: InventoryTaskDto) {
        if (task.mode != "check") return
        if (task.lineId != ownLineId) {
            dialog.value = InventoryDialog.ConfirmOther(task, null)
            return
        }
        join(task, confirm = false, barcode = null)
    }

    fun confirmOther() {
        val d = dialog.value as? InventoryDialog.ConfirmOther ?: return
        join(d.task, confirm = true, barcode = d.barcode)
    }

    fun dismissDialog() {
        dialog.value = null
    }

    fun retry() {
        val d = dialog.value as? InventoryDialog.Error ?: return
        val task = d.retry ?: return dismissDialog()
        join(task, confirm = task.lineId != ownLineId, barcode = null)
    }

    private suspend fun onScan(raw: String) {
        if (dialog.value != null) return
        val resolved = runCatching { repository.resolveBarcode(raw.trim()) }.getOrNull()
        if (resolved == null) {
            dialog.value = InventoryDialog.Error(InventoryError.BARCODE_UNKNOWN)
            return
        }
        if (resolved.task.mode != "check") {
            dialog.value = InventoryDialog.Error(InventoryError.REPACK)
            return
        }
        if (resolved.requiresConfirmation) {
            dialog.value = InventoryDialog.ConfirmOther(resolved.task, raw.trim())
        } else {
            join(resolved.task, confirm = false, barcode = raw.trim())
        }
    }

    private fun join(task: InventoryTaskDto, confirm: Boolean, barcode: String?) {
        viewModelScope.launch {
            val operatorId = session.state.value.operator?.operatorId ?: return@launch
            val cached = state.value.active?.takeIf { it.inventoryId == task.inventoryId }
            if (!state.value.reachable && cached != null) {
                repository.activate(task.inventoryId)
                _events.emit(InventoryListEvent.Entered(task.inventoryId))
                return@launch
            }
            dialog.value = InventoryDialog.Joining
            val manifest = when (val joined = repository.join(task, operatorId, confirm, barcode)) {
                is JoinResult.Ok -> joined.manifest
                JoinResult.NotRunning -> return@launch fail(InventoryError.NOT_RUNNING)
                JoinResult.OperatorUnavailable -> return@launch fail(InventoryError.OPERATOR_UNAVAILABLE)
                JoinResult.LineRequired -> return@launch fail(InventoryError.LINE_REQUIRED)
                JoinResult.ConfirmationRequired -> {
                    dialog.value = InventoryDialog.ConfirmOther(task, barcode)
                    return@launch
                }
                JoinResult.Unavailable -> return@launch fail(if (cached == null) InventoryError.NEEDS_NETWORK else InventoryError.DOWNLOAD_FAILED, retry = task)
            }
            dialog.value = InventoryDialog.Downloading(task.inventoryNumber, 0, manifest.codeCount)
            val result = runCatching {
                repository.download(manifest) { staged, total -> dialog.value = InventoryDialog.Downloading(task.inventoryNumber, staged, total) }
            }.getOrElse { return@launch fail(InventoryError.DOWNLOAD_FAILED, retry = task) }
            when (result) {
                MirrorResult.Active -> {
                    repository.activate(task.inventoryId)
                    dialog.value = null
                    _events.emit(InventoryListEvent.Entered(task.inventoryId))
                }
                MirrorResult.Repack -> fail(InventoryError.REPACK)
                is MirrorResult.Invalid -> fail(InventoryError.INVALID_SNAPSHOT, detail = result.reason, retry = task)
            }
        }
    }

    private fun fail(kind: InventoryError, detail: String? = null, retry: InventoryTaskDto? = null) {
        dialog.value = InventoryDialog.Error(kind, detail, retry)
    }
}
