package app.markiro.handheld.core.scan

import android.content.Context
import app.markiro.handheld.BuildConfig
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow

/** What screens and view models depend on; `ScanRouter` is the production implementation. */
interface ScanEvents {
    val events: Flow<ScanEvent>
}

/** Test seam: a source of scans that is just a flow. */
class ScanRouterAdapter(override val events: Flow<ScanEvent>) : ScanEvents

/**
 * One trigger pull is one scan, however many sources saw it.
 *
 * Several profiles can be registered on one action, a terminal can be left in
 * both intent and wedge mode, and a service can send the same code under two
 * keys. None of that is a second unit, and a second unit is exactly what the
 * work screen would report it as. The window is anchored on the last ACCEPTED
 * scan, so a held trigger cannot be suppressed indefinitely.
 */
class ScanDedup(private val windowMs: Long = 200) {
    private var lastRaw: String? = null
    private var lastAt = Long.MIN_VALUE

    fun accept(event: ScanEvent): Boolean {
        if (event.raw == lastRaw && event.at - lastAt in 0 until windowMs) return false
        lastRaw = event.raw
        lastAt = event.at
        return true
    }
}

/** Single entry for every scan; screens collect `events` while they are resumed. */
class ScanRouter(private val context: Context, private val preferences: ScanPreferences) : ScanEvents {
    private val flow = MutableSharedFlow<ScanEvent>(extraBufferCapacity = 16)
    override val events: SharedFlow<ScanEvent> = flow
    private val reports = MutableStateFlow<IntentReport?>(null)

    /** The last broadcast a registered profile received, matched or not. Drives the settings screen. */
    val lastIntent: StateFlow<IntentReport?> = reports
    val wedge = KeyboardWedgeScanSource()
    private val dedup = ScanDedup()
    private var active: List<ScanSource> = emptyList()

    @Synchronized
    fun submit(event: ScanEvent) {
        if (!dedup.accept(event)) return
        flow.tryEmit(event)
    }

    /** Rebuilds the active sources from preferences; safe to call on every settings change. */
    fun configure() {
        active.forEach { it.stop() }
        val sources = mutableListOf<ScanSource>()
        // The wedge is always on, whatever the preference says. A terminal ships
        // in HID mode and the vendor intent action is a guess until somebody
        // opens Settings -- but Settings is behind pairing, and pairing is done
        // by scanning the code the cabinet prints. With the wedge off by
        // default, a brand-new device cannot be paired by scanning at all, and
        // has no screen on which to fix that. Both sources cost nothing
        // together: a scanner in intent mode types nothing, one in HID mode
        // broadcasts nothing.
        sources += wedge
        if (preferences.sourceKind == ScanSourceKind.BUILTIN_INTENT) {
            // Every known profile at once, for the same reason. A scanner in
            // intent mode broadcasts exactly one action, so the other filters
            // cost a registration and nothing else -- and «which vendor made the
            // terminal in your hand» is a question the app can answer itself
            // instead of asking an operator on a factory floor.
            for (profile in VendorProfiles.ALL + listOfNotNull(preferences.customProfile())) {
                sources += IntentScanSource(context, profile) { reports.value = it }
            }
        }
        if (BuildConfig.DEBUG_SCAN_SOURCE) sources += DebugScanSource(context)
        sources.forEach { it.start(::submit) }
        active = sources
    }
}
