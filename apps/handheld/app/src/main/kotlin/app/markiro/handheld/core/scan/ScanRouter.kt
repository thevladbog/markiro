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
 * A terminal can be left in both intent and wedge mode, and a custom profile can
 * name an action a built-in one already covers. Neither is a second unit, and a
 * second unit is exactly what the work screen would report it as. Each code's
 * window is anchored on the last time that code was ACCEPTED, so a held trigger
 * cannot be suppressed indefinitely.
 */
class ScanDedup(private val windowMs: Long = 200, private val capacity: Int = 32) {
    /** Its own window per code: a single «last code» let A, B, A admit the repeat of A. */
    private val acceptedAt = LinkedHashMap<String, Long>()

    fun accept(event: ScanEvent): Boolean {
        val accepted = acceptedAt[event.raw]
        if (accepted != null && event.at - accepted in 0 until windowMs) return false
        // Anything outside the window can never suppress again, and a shift is
        // thousands of scans: prune before inserting rather than grow with it.
        // A clock that steps backwards leaves a negative age, which is outside
        // the window too -- it drops the entry instead of swallowing real work.
        acceptedAt.entries.removeAll { event.at - it.value !in 0 until windowMs }
        acceptedAt.remove(event.raw)
        acceptedAt[event.raw] = event.at
        while (acceptedAt.size > capacity) acceptedAt.remove(acceptedAt.keys.first())
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
            //
            // Grouped by the action they listen on, and by the category that
            // action is filtered with: two receivers on one action would race to
            // write the diagnostic report, and the profile that could not read
            // the broadcast could win. A profile an operator typed goes first,
            // because a value entered at the terminal beats one guessed from a
            // table.
            val profiles = listOfNotNull(preferences.customProfile()) + VendorProfiles.ALL
            for ((_, group) in profiles.groupBy { it.action to it.category }) {
                sources += IntentScanSource(context, group) { reports.value = it }
            }
        }
        if (BuildConfig.DEBUG_SCAN_SOURCE) sources += DebugScanSource(context)
        sources.forEach { it.start(::submit) }
        active = sources
    }
}
