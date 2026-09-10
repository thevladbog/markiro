package app.markiro.handheld.feature.settings

import androidx.appcompat.app.AppCompatDelegate
import androidx.core.os.LocaleListCompat
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.BuildConfig
import app.markiro.handheld.core.inventory.InventorySyncEngine
import app.markiro.handheld.core.scan.ScanEvent
import app.markiro.handheld.core.scan.ScanEvents
import app.markiro.handheld.core.scan.ScanPreferences
import app.markiro.handheld.core.scan.ScanRouter
import app.markiro.handheld.core.scan.ScanSourceKind
import app.markiro.handheld.core.scan.VendorProfiles
import app.markiro.handheld.core.signal.SignalKind
import app.markiro.handheld.core.signal.Signaller
import app.markiro.handheld.core.storage.DeviceConfigDao
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.sync.SyncEngine
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class SettingsUi(
    val sourceKind: ScanSourceKind,
    val profileId: String,
    val theme: ThemeMode,
    val language: String,
    val lastScan: ScanEvent? = null,
    val debugScanEnabled: Boolean = BuildConfig.DEBUG_SCAN_SOURCE,
    val version: String = BuildConfig.VERSION_NAME,
    val soundMuted: Boolean = false,
    val soundVolume: Float = 1f,
    val vibrationEnabled: Boolean = true,
    val queue: Int = 0,
    val lastSyncAt: Long? = null,
    val installId: String = "",
)

@HiltViewModel
class SettingsViewModel @Inject constructor(
    private val scan: ScanPreferences,
    private val router: ScanRouter,
    scans: ScanEvents,
    private val app: AppPreferences,
    config: DeviceConfigDao,
    private val signaller: Signaller,
    sync: SyncEngine,
    inventorySync: InventorySyncEngine,
    meta: MetaStore,
) : ViewModel() {
    private val _state = MutableStateFlow(
        SettingsUi(
            scan.sourceKind, scan.profileId, app.theme, app.language,
            soundMuted = app.soundMuted, soundVolume = app.soundVolume, vibrationEnabled = app.vibrationEnabled,
        ),
    )
    val state: StateFlow<SettingsUi> = _state
    val config: StateFlow<DeviceConfigEntity?> = config.observe().stateIn(viewModelScope, SharingStarted.Eagerly, null)

    init {
        viewModelScope.launch { scans.events.collect { event -> _state.update { it.copy(lastScan = event) } } }
        viewModelScope.launch {
            // Both queues count: shift scans and inventory events share the «Очередь синхронизации» row.
            combine(sync.state, inventorySync.state) { s, i -> s to i }.collect { (s, i) ->
                val last = maxOf(s.lastSuccessAt ?: 0L, i.lastSuccessAt ?: 0L).takeIf { it > 0L }
                _state.update { it.copy(queue = s.pending + i.pending, lastSyncAt = last) }
            }
        }
        viewModelScope.launch { val id = meta.installId(); _state.update { it.copy(installId = id) } }
    }

    fun setSource(kind: ScanSourceKind) {
        scan.sourceKind = kind
        router.configure()
        _state.update { it.copy(sourceKind = kind) }
    }

    fun setProfile(id: String) {
        scan.profileId = id
        router.configure()
        _state.update { it.copy(profileId = id) }
    }

    fun setTheme(mode: ThemeMode) {
        app.theme = mode
        _state.update { it.copy(theme = mode) }
    }

    fun setLanguage(tag: String) {
        app.language = tag
        AppCompatDelegate.setApplicationLocales(LocaleListCompat.forLanguageTags(tag))
        _state.update { it.copy(language = tag) }
    }

    fun toggleSound() {
        app.soundMuted = !app.soundMuted
        _state.update { it.copy(soundMuted = app.soundMuted) }
    }

    fun setVolume(volume: Float) {
        app.soundVolume = volume
        _state.update { it.copy(soundVolume = app.soundVolume) }
    }

    fun toggleVibration() {
        app.vibrationEnabled = !app.vibrationEnabled
        _state.update { it.copy(vibrationEnabled = app.vibrationEnabled) }
    }

    fun testSignal(kind: SignalKind) = signaller.play(kind)

    /** Hidden text field on the test-scan screen (debug builds): behaves like a scan. */
    fun submitDebugScan(text: String) {
        if (BuildConfig.DEBUG_SCAN_SOURCE) router.submit(ScanEvent(text, null, "debug-field", System.currentTimeMillis()))
    }

    fun profileLabel(id: String): String = VendorProfiles.byId(id).label
}
