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

/** Receives the vendor service's broadcast. Exported: the scanner service is another app. */
class IntentScanSource(
    private val context: Context,
    private val profile: VendorProfile,
    /** Every received broadcast, matched or not: the only way to name an unknown service without adb. */
    private val onReport: (IntentReport) -> Unit = {},
) : ScanSource {
    override val id = "intent:${profile.id}"
    private var receiver: BroadcastReceiver? = null

    override fun start(onEvent: (ScanEvent) -> Unit) {
        val extractor = IntentExtractor(profile)
        receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                val bundle = intent.extras ?: return
                val extras = bundle.keySet().associateWith { key -> @Suppress("DEPRECATION") bundle.get(key) }
                val now = System.currentTimeMillis()
                val event = extractor.extract(extras, now)
                onReport(IntentReport(profile.action, extras.keys.sorted(), event?.let { profile.id }, now))
                event?.let(onEvent)
            }
        }.also {
            // A broadcast that carries a category matches only a filter declaring
            // it -- АТОЛ's ScanWedge sends DEFAULT, and without this the service
            // and the app never meet.
            val filter = IntentFilter(profile.action)
            profile.category?.let(filter::addCategory)
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
