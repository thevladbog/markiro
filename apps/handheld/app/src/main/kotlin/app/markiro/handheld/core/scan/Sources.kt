package app.markiro.handheld.core.scan

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.view.KeyEvent
import androidx.core.content.ContextCompat

enum class ScanSourceKind { BUILTIN_INTENT, KEYBOARD_WEDGE, DEBUG }

interface ScanSource {
    val id: String
    fun start(onEvent: (ScanEvent) -> Unit)
    fun stop()
}

/** What a terminal actually sent, whether or not a profile understood it. */
data class IntentReport(val action: String, val extraKeys: List<String>, val profileId: String?, val at: Long)

/**
 * Receives one action's broadcast. Exported: the scanner service is another app.
 *
 * [profiles] are every profile registered on that action, tried in order until
 * one reads the extras. One receiver rather than one per profile, because
 * Honeywell and Zebra share the app's own action: as separate receivers they
 * raced to write the diagnostic report, and the one that could NOT read the
 * broadcast could land last -- telling an operator the key was unrecognised
 * about a scan that had just gone through.
 */
class IntentScanSource(
    private val context: Context,
    private val profiles: List<VendorProfile>,
    /** Every received broadcast, matched or not: the only way to name an unknown service without adb. */
    private val onReport: (IntentReport) -> Unit = {},
) : ScanSource {
    private val action = profiles.first().action
    private val category = profiles.first().category
    override val id = "intent:$action"
    private var receiver: BroadcastReceiver? = null

    override fun start(onEvent: (ScanEvent) -> Unit) {
        val extractors = profiles.map { it to IntentExtractor(it) }
        receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                val bundle = intent.extras ?: return
                val extras = bundle.keySet().associateWith { key -> @Suppress("DEPRECATION") bundle.get(key) }
                val now = System.currentTimeMillis()
                val match = extractors.firstNotNullOfOrNull { (profile, extractor) ->
                    extractor.extract(extras, now)?.let { profile to it }
                }
                onReport(IntentReport(action, extras.keys.sorted(), match?.first?.id, now))
                match?.second?.let(onEvent)
            }
        }.also {
            // A broadcast that carries a category matches only a filter declaring
            // it -- АТОЛ's ScanWedge sends DEFAULT, and without this the service
            // and the app never meet.
            val filter = IntentFilter(action)
            category?.let(filter::addCategory)
            ContextCompat.registerReceiver(context, it, filter, ContextCompat.RECEIVER_EXPORTED)
        }
    }

    override fun stop() {
        receiver?.let { runCatching { context.unregisterReceiver(it) } }
        receiver = null
    }
}

/** Fed by the activity's dispatchKeyEvent; consumes wedge keystrokes so text fields never see them. */
class KeyboardWedgeScanSource(private val buffer: WedgeBuffer = WedgeBuffer(timeoutMs = 150)) : ScanSource {
    override val id = "wedge"
    private var sink: ((ScanEvent) -> Unit)? = null

    override fun start(onEvent: (ScanEvent) -> Unit) {
        sink = onEvent
    }

    override fun stop() {
        sink = null
    }

    /** Returns true when the event was consumed as part of a scan. */
    fun onKeyEvent(event: KeyEvent): Boolean {
        val sink = sink ?: return false
        val isEnter = event.keyCode == KeyEvent.KEYCODE_ENTER || event.keyCode == KeyEvent.KEYCODE_NUMPAD_ENTER
        if (event.action != KeyEvent.ACTION_DOWN) return isEnter
        val now = System.currentTimeMillis()
        if (isEnter) {
            buffer.onEnter(now)?.let { sink(ScanEvent(ScanNormalizer.normalize(it), null, id, now)) }
            return true
        }
        val ch = event.unicodeChar
        if (ch == 0) return false
        buffer.onChar(ch.toChar(), now)
        return true
    }
}

/** Debug builds only: `adb shell am broadcast -a app.markiro.handheld.DEBUG_SCAN --es data "..."`. */
class DebugScanSource(private val context: Context) : ScanSource {
    override val id = "debug"
    private var receiver: BroadcastReceiver? = null

    override fun start(onEvent: (ScanEvent) -> Unit) {
        receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                val data = intent.getStringExtra("data") ?: return
                onEvent(ScanEvent(ScanNormalizer.normalize(data), intent.getStringExtra("symbology"), id, System.currentTimeMillis()))
            }
        }.also {
            ContextCompat.registerReceiver(context, it, IntentFilter(ACTION), ContextCompat.RECEIVER_EXPORTED)
        }
    }

    override fun stop() {
        receiver?.let { runCatching { context.unregisterReceiver(it) } }
        receiver = null
    }

    companion object {
        const val ACTION = "app.markiro.handheld.DEBUG_SCAN"
    }
}
