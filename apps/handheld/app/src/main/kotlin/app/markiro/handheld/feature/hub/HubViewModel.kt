package app.markiro.handheld.feature.hub

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.core.network.ReachabilityTracker
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.scan.ScanPreferences
import app.markiro.handheld.core.scan.ScanSourceKind
import app.markiro.handheld.core.scan.VendorProfiles
import app.markiro.handheld.core.storage.DeviceConfigDao
import app.markiro.handheld.feature.signin.SessionHolder
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
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
)

enum class HubTile { SHIFT, INVENTORY, CHECK, SETTINGS }

/** Reachable = an HTTP response within the last two minutes (the station's online threshold). */
private const val REACHABLE_WINDOW_MS = 2 * 60 * 1000L
private val OPEN_SHIFT_STATUSES = setOf("planned", "active")

@HiltViewModel
class HubViewModel(
    private val api: StationApi,
    private val config: DeviceConfigDao,
    private val session: SessionHolder,
    reachability: ReachabilityTracker,
    private val scannerLabel: () -> String,
    private val now: () -> Long = System::currentTimeMillis,
) : ViewModel() {
    @Inject
    constructor(
        api: StationApi,
        config: DeviceConfigDao,
        session: SessionHolder,
        reachability: ReachabilityTracker,
        scan: ScanPreferences,
    ) : this(
        api,
        config,
        session,
        reachability,
        scannerLabel = {
            when (scan.sourceKind) {
                ScanSourceKind.BUILTIN_INTENT -> VendorProfiles.byId(scan.profileId).label.substringBefore(" ·")
                ScanSourceKind.KEYBOARD_WEDGE -> "клавиатурный"
                ScanSourceKind.DEBUG -> "отладка"
            }
        },
    )

    val state: StateFlow<HubUi> = combine(config.observe(), session.state, reachability.lastSuccessAt) { cfg, ses, lastOk ->
        HubUi(
            organization = cfg?.organizationName.orEmpty(),
            operatorName = ses.operator?.name.orEmpty(),
            lineName = cfg?.lineName,
            shifts = cfg?.shiftsCount,
            inventories = cfg?.inventoryCount,
            countsAt = cfg?.countsAt,
            reachable = lastOk != null && now() - lastOk <= REACHABLE_WINDOW_MS,
            scannerLabel = scannerLabel(),
        )
    }.stateIn(viewModelScope, SharingStarted.Eagerly, HubUi())

    /** Fetches live counts; on any failure the cached counts and their timestamp stay untouched. */
    fun refresh() {
        viewModelScope.launch {
            val current = config.get() ?: return@launch
            val counts = runCatching {
                val shifts = api.shifts().items.count { it.status in OPEN_SHIFT_STATUSES }
                val tasks = api.inventoryTasks().items.size
                shifts to tasks
            }.getOrNull() ?: return@launch
            config.upsert(current.copy(shiftsCount = counts.first, inventoryCount = counts.second, countsAt = now()))
        }
    }

    fun signOut() = session.signOut()
}
