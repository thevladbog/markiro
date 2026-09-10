package app.markiro.handheld.feature.settings

import androidx.appcompat.app.AppCompatDelegate
import androidx.core.os.LocaleListCompat
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.markiro.handheld.BuildConfig
import app.markiro.handheld.core.scan.ScanEvent
import app.markiro.handheld.core.scan.ScanEvents
import app.markiro.handheld.core.scan.ScanPreferences
import app.markiro.handheld.core.scan.ScanRouter
import app.markiro.handheld.core.scan.ScanSourceKind
import app.markiro.handheld.core.scan.VendorProfiles
import app.markiro.handheld.core.storage.DeviceConfigDao
import app.markiro.handheld.core.storage.DeviceConfigEntity
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
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
)

@HiltViewModel
class SettingsViewModel @Inject constructor(
    private val scan: ScanPreferences,
    private val router: ScanRouter,
    scans: ScanEvents,
    private val app: AppPreferences,
    config: DeviceConfigDao,
) : ViewModel() {
    private val _state = MutableStateFlow(SettingsUi(scan.sourceKind, scan.profileId, app.theme, app.language))
    val state: StateFlow<SettingsUi> = _state
    val config: StateFlow<DeviceConfigEntity?> = config.observe().stateIn(viewModelScope, SharingStarted.Eagerly, null)

    init {
        viewModelScope.launch { scans.events.collect { event -> _state.value = _state.value.copy(lastScan = event) } }
    }

    fun setSource(kind: ScanSourceKind) {
        scan.sourceKind = kind
        router.configure()
        _state.value = _state.value.copy(sourceKind = kind)
    }

    fun setProfile(id: String) {
        scan.profileId = id
        router.configure()
        _state.value = _state.value.copy(profileId = id)
    }

    fun setTheme(mode: ThemeMode) {
        app.theme = mode
        _state.value = _state.value.copy(theme = mode)
    }

    fun setLanguage(tag: String) {
        app.language = tag
        AppCompatDelegate.setApplicationLocales(LocaleListCompat.forLanguageTags(tag))
        _state.value = _state.value.copy(language = tag)
    }

    /** Hidden text field on the test-scan screen (debug builds): behaves like a scan. */
    fun submitDebugScan(text: String) {
        if (BuildConfig.DEBUG_SCAN_SOURCE) router.submit(ScanEvent(text, null, "debug-field", System.currentTimeMillis()))
    }

    fun profileLabel(id: String): String = VendorProfiles.byId(id).label
}
