package app.markiro.handheld.feature.settings

import androidx.appcompat.app.AppCompatDelegate
import androidx.core.os.LocaleListCompat
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.BuildConfig
import app.markiro.handheld.core.inventory.InventorySyncEngine
import app.markiro.handheld.core.print.PrinterDao
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
import android.content.Intent
import app.markiro.handheld.core.update.DownloadResult
import app.markiro.handheld.core.update.UpdateCheck
import app.markiro.handheld.core.update.UpdateInstaller
import app.markiro.handheld.core.update.UpdateState
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.sync.SyncEngine
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
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
    /** `null` until a printer is configured; the settings row falls back to a hint. */
    val printerLabel: String? = null,
    /** `null` until the check has answered; it is read-only and never blocks a screen. */
    val update: UpdateState? = null,
    val install: InstallStep? = null,
)

sealed interface InstallStep {
    data object Downloading : InstallStep

    /**
     * Refused because this device still owes the server work. An install
     * restarts the app and can end in a downgrade prompt or a wipe; losing
     * queued scans to it is worse than running an old build for another hour.
     */
    data object QueueNotEmpty : InstallStep

    data class Failed(val failure: DownloadResult.Failure) : InstallStep
}

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
    printers: PrinterDao,
    private val updates: UpdateCheck,
    private val installer: UpdateInstaller,
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
        viewModelScope.launch {
            printers.observeSelected().collect { printer ->
                val label = printer?.let { "${it.name} · ${it.language.uppercase()} ${it.dpi} dpi" }
                _state.update { it.copy(printerLabel = label) }
            }
        }
    }

    /**
     * Asked for, not polled. The terminal is offline most of a shift, and a
     * background poll would spend its battery to learn «не знаю» over and over.
     */
    fun checkForUpdate() {
        _state.update { it.copy(update = null) }
        viewModelScope.launch { val state = updates.check(); _state.update { it.copy(update = state) } }
    }

    /** One-shot: the system installer is an activity, and the operator confirms it. */
    private val _launchInstall = MutableSharedFlow<Intent>(extraBufferCapacity = 1)
    val launchInstall: SharedFlow<Intent> = _launchInstall

    fun installUpdate() {
        val available = (_state.value.update as? UpdateState.Available)?.manifest ?: return
        if (_state.value.install == InstallStep.Downloading) return
        if (_state.value.queue > 0) {
            _state.update { it.copy(install = InstallStep.QueueNotEmpty) }
            return
        }
        _state.update { it.copy(install = InstallStep.Downloading) }
        viewModelScope.launch {
            when (val result = installer.download(available)) {
                is DownloadResult.Ready -> {
                    _state.update { it.copy(install = null) }
                    _launchInstall.emit(installer.installIntent(result.file))
                }
                is DownloadResult.Failed -> _state.update { it.copy(install = InstallStep.Failed(result.failure)) }
            }
        }
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
