package app.markiro.handheld.feature.hub

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.R
import app.markiro.handheld.core.inventory.InventorySyncEngine
import app.markiro.handheld.core.print.PrinterDao
import app.markiro.handheld.core.print.PrinterEntity
import app.markiro.handheld.core.inventory.InventorySyncState
import app.markiro.handheld.core.box.BoxRepository
import app.markiro.handheld.core.network.ReachabilityTracker
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.scan.ScanPreferences
import app.markiro.handheld.core.scan.ScanSourceKind
import app.markiro.handheld.core.scan.VendorProfiles
import app.markiro.handheld.core.storage.CodeDao
import app.markiro.handheld.core.storage.DeviceConfigDao
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.InventoryTaskDao
import app.markiro.handheld.core.storage.InventoryTaskEntity
import app.markiro.handheld.core.storage.ShiftDao
import app.markiro.handheld.core.storage.ShiftEntity
import app.markiro.handheld.core.sync.SyncEngine
import app.markiro.handheld.core.sync.SyncState
import app.markiro.handheld.feature.work.TeamRefresher
import app.markiro.handheld.feature.work.TeamState
import app.markiro.handheld.feature.signin.SessionHolder
import app.markiro.handheld.feature.signin.SessionState
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

data class HubUi(
    val organization: String = "",
    val operatorName: String = "",
    val lineName: String? = null,
    val shifts: Int? = null,
    val inventories: Int? = null,
    val countsAt: Long? = null,
    val reachable: Boolean = false,
    val scannerLabel: String = "",
    val queue: Int = 0,
    val stuck: Boolean = false,
    val activeShiftId: String? = null,
    val continueShiftNumber: String? = null,
    val activeInventoryId: String? = null,
    val continueInventoryNumber: String? = null,
    /** Drives both the settings tile's hint and the printer indicator's tone. */
    val printerConfigured: Boolean = false,
    /** Closed boxes on this device whose label is still owed, across every shift. */
    val unprintedLabels: Int = 0,
    val activeShift: HubActiveShift? = null,
)

/** Same accepted-unit total as the work screen; a missing summary is explicitly local. */
data class HubActiveShift(val shift: ShiftEntity, val acceptedUnits: Int, val summaryAt: Long? = null)

enum class HubTile { SHIFT, INVENTORY, SETTINGS }

/** Reachable = an HTTP response within the last two minutes (the station's online threshold). */
private const val REACHABLE_WINDOW_MS = 2 * 60 * 1000L
private const val REACHABLE_TICK_MS = 30 * 1000L
private val OPEN_SHIFT_STATUSES = setOf("planned", "active")

@OptIn(ExperimentalCoroutinesApi::class)
@HiltViewModel
class HubViewModel(
    private val recovery: app.markiro.handheld.core.storage.DeviceRecovery,
    private val api: StationApi,
    private val config: DeviceConfigDao,
    private val session: SessionHolder,
    reachability: ReachabilityTracker,
    sync: SyncEngine,
    shifts: ShiftDao,
    inventorySync: InventorySyncEngine,
    inventories: InventoryTaskDao,
    printers: PrinterDao,
    boxes: BoxRepository,
    codes: CodeDao,
    team: TeamRefresher,
    private val scannerLabel: () -> String,
    private val now: () -> Long = System::currentTimeMillis,
    /** Refreshes the online indicator and the joined shift summary; tests pass controlled ticks. */
    tick: Flow<Unit> = flow {
        while (true) {
            emit(Unit)
            delay(REACHABLE_TICK_MS)
        }
    },
) : ViewModel() {
    @Inject
    constructor(
        @ApplicationContext context: Context,
        recovery: app.markiro.handheld.core.storage.DeviceRecovery,
        api: StationApi,
        config: DeviceConfigDao,
        session: SessionHolder,
        reachability: ReachabilityTracker,
        sync: SyncEngine,
        shifts: ShiftDao,
        inventorySync: InventorySyncEngine,
        inventories: InventoryTaskDao,
        printers: PrinterDao,
        boxes: BoxRepository,
        codes: CodeDao,
        team: TeamRefresher,
        scan: ScanPreferences,
    ) : this(
        recovery,
        api,
        config,
        session,
        reachability,
        sync,
        shifts,
        inventorySync,
        inventories,
        printers,
        boxes,
        codes,
        team,
        scannerLabel = {
            when (scan.sourceKind) {
                ScanSourceKind.BUILTIN_INTENT -> VendorProfiles.byId(scan.profileId).label.substringBefore(" ·")
                ScanSourceKind.KEYBOARD_WEDGE -> context.getString(R.string.scanner_source_wedge)
                ScanSourceKind.DEBUG -> context.getString(R.string.scanner_source_debug)
            }
        },
    )

    private val activeShift: Flow<HubActiveShift?> = config.observe()
        .map { it?.activeShiftId }
        .distinctUntilChanged()
        .flatMapLatest { id ->
            if (id == null) return@flatMapLatest flowOf(null)
            shifts.observe(id).flatMapLatest shiftFlow@ { shift ->
                if (shift == null || shift.status == "closed") return@shiftFlow flowOf(null)
                val summary: Flow<TeamState?> = flow {
                    var last: TeamState? = null
                    emit(null)
                    tick.collect {
                        last = recovery.work { team.refresh(id) } ?: last
                        emit(last)
                    }
                }
                combine(codes.observeCountForShift(id), summary) { local, shared ->
                    HubActiveShift(
                        shift = shift,
                        acceptedUnits = maxOf(shared?.acceptedUnits ?: 0, local),
                        summaryAt = shared?.takeIf { it.acceptedUnits != null }?.at,
                    )
                }
            }
        }

    private val activeInventory: Flow<InventoryTaskEntity?> =
        config.observe().flatMapLatest { cfg -> cfg?.activeInventoryId?.let { inventories.observe(it) } ?: flowOf(null) }

    val state: StateFlow<HubUi> = combine(
        config.observe(), session.state, reachability.lastSuccessAt, tick, sync.state, activeShift, inventorySync.state, activeInventory,
        printers.observeSelected(), boxes.observeUnprintedCount(),
    ) { values ->
        val cfg = values[0] as DeviceConfigEntity?
        val ses = values[1] as SessionState
        val lastOk = values[2] as Long?
        val syncState = values[4] as SyncState
        val current = (values[5] as HubActiveShift?)?.takeIf { it.shift.id == cfg?.activeShiftId }
        val inventoryState = values[6] as InventorySyncState
        val inventory = (values[7] as InventoryTaskEntity?)?.takeIf { it.state == "active" }
        val printer = values[8] as PrinterEntity?
        HubUi(
            printerConfigured = printer != null,
            unprintedLabels = values[9] as Int,
            organization = cfg?.organizationName.orEmpty(),
            operatorName = ses.operator?.name.orEmpty(),
            lineName = cfg?.lineName,
            shifts = cfg?.shiftsCount,
            inventories = cfg?.inventoryCount,
            countsAt = cfg?.countsAt,
            reachable = lastOk != null && now() - lastOk <= REACHABLE_WINDOW_MS,
            scannerLabel = scannerLabel(),
            queue = syncState.pending + inventoryState.pending,
            stuck = syncState.stuck || inventoryState.stuck,
            activeShiftId = current?.shift?.id,
            continueShiftNumber = current?.shift?.number,
            activeShift = current,
            activeInventoryId = inventory?.inventoryId,
            continueInventoryNumber = inventory?.inventoryNumber,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), HubUi())

    /** Fetches live counts; on any failure the cached counts and their timestamp stay untouched. */
    fun refresh() {
        viewModelScope.launch { recovery.work {
            val current = config.get() ?: return@work
            val counts = runCatching {
                val shifts = api.shifts().items.count { it.status in OPEN_SHIFT_STATUSES }
                val tasks = api.inventoryTasks().items.size
                shifts to tasks
            }.getOrNull() ?: return@work
            recovery.commit { config.upsert(current.copy(shiftsCount = counts.first, inventoryCount = counts.second, countsAt = now())) }
        }
        }
    }

    fun signOut() = session.signOut()
}
