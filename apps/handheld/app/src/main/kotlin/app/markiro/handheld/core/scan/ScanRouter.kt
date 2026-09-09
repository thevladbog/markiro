package app.markiro.handheld.core.scan

import android.content.Context
import app.markiro.handheld.BuildConfig
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow

/** What screens and view models depend on; `ScanRouter` is the production implementation. */
interface ScanEvents {
    val events: Flow<ScanEvent>
}

/** Test seam: a source of scans that is just a flow. */
class ScanRouterAdapter(override val events: Flow<ScanEvent>) : ScanEvents

/** Single entry for every scan; screens collect `events` while they are resumed. */
class ScanRouter(private val context: Context, private val preferences: ScanPreferences) : ScanEvents {
    private val flow = MutableSharedFlow<ScanEvent>(extraBufferCapacity = 16)
    override val events: SharedFlow<ScanEvent> = flow
    val wedge = KeyboardWedgeScanSource()
    private var active: List<ScanSource> = emptyList()

    fun submit(event: ScanEvent) {
        flow.tryEmit(event)
    }

    /** Rebuilds the active sources from preferences; safe to call on every settings change. */
    fun configure() {
        active.forEach { it.stop() }
        val sources = mutableListOf<ScanSource>()
        when (preferences.sourceKind) {
            ScanSourceKind.BUILTIN_INTENT -> sources += IntentScanSource(context, VendorProfiles.byId(preferences.profileId))
            ScanSourceKind.KEYBOARD_WEDGE -> sources += wedge
            ScanSourceKind.DEBUG -> Unit
        }
        if (BuildConfig.DEBUG_SCAN_SOURCE) sources += DebugScanSource(context)
        sources.forEach { it.start(::submit) }
        active = sources
    }
}
