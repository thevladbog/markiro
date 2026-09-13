package app.markiro.handheld.core.scan

import android.content.Intent
import android.os.Looper
import android.view.KeyEvent
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf

@RunWith(AndroidJUnit4::class)
class ScanRouterTest {
    private val context = ApplicationProvider.getApplicationContext<android.content.Context>()

    private fun router(kind: ScanSourceKind): ScanRouter {
        val preferences = ScanPreferences(context).also {
            it.sourceKind = kind
            it.customAction = ""
            it.customDataExtra = ""
        }
        return ScanRouter(context, preferences).also { it.configure() }
    }

    private fun ScanRouter.type(text: String) {
        text.forEach { ch ->
            // A wedge scanner types; `unicodeChar` is what the activity hands the
            // router, so the events carry one.
            wedge.onKeyEvent(KeyEvent(0L, 0L, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_0 + (ch - '0'), 0))
        }
        wedge.onKeyEvent(KeyEvent(0L, 0L, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER, 0))
    }

    /**
     * The default source is the vendor intent with a guessed action, and the
     * only screen that can correct it is behind pairing -- which is done by
     * scanning. With the wedge off until then, a terminal that ships in HID mode
     * could never be paired by scanning at all.
     */
    @Test
    fun theKeyboardWedgeStaysLiveWhileTheBuiltInScannerIsSelected() = runTest {
        val router = router(ScanSourceKind.BUILTIN_INTENT)
        val scanned = async { router.events.first() }
        yield()
        // Checked before the scan so an unattached wedge fails here rather than
        // by waiting out the test's timeout for an event that cannot arrive.
        assertTrue(
            "the keyboard wedge is not attached",
            router.wedge.onKeyEvent(KeyEvent(0L, 0L, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER, 0)),
        )
        router.type("40318827")
        assertEquals("40318827", scanned.await().raw)
    }

    @Test
    fun theKeyboardWedgeStillWorksWhenItIsTheSelectedSource() = runTest {
        val router = router(ScanSourceKind.KEYBOARD_WEDGE)
        val scanned = async { router.events.first() }
        yield()
        router.type("40318827")
        assertEquals("wedge", scanned.await().source)
    }

    private fun broadcast(action: String, fill: Intent.() -> Unit) {
        context.sendBroadcast(Intent(action).apply(fill))
        shadowOf(Looper.getMainLooper()).idle()
    }

    /**
     * Nobody names the vendor of the terminal in their hand. A scanner in intent
     * mode broadcasts exactly one action, so every profile is registered and the
     * one that understands the extras answers.
     */
    @Test
    fun aBroadcastFromAnyKnownVendorArrivesWithoutChoosingAProfile() = runTest {
        val router = router(ScanSourceKind.BUILTIN_INTENT)
        val scanned = async { router.events.first() }
        yield()
        broadcast(VendorProfiles.UROVO.action) { putExtra("barcode_string", "40318827") }
        assertEquals("intent:urovo", scanned.await().source)
    }

    /** The profile confirmed on hardware keeps working with every other one registered. */
    @Test
    fun honeywellStillArrives() = runTest {
        val router = router(ScanSourceKind.BUILTIN_INTENT)
        val scanned = async { router.events.first() }
        yield()
        broadcast(VendorProfiles.HONEYWELL.action) { putExtra("data", "40318827") }
        assertEquals("intent:honeywell", scanned.await().source)
    }

    /** Filled in by an operator from the diagnostics below, and live without a release. */
    @Test
    fun aCustomProfileIsRegisteredToo() = runTest {
        val preferences = ScanPreferences(context).also {
            it.sourceKind = ScanSourceKind.BUILTIN_INTENT
            it.customAction = "com.example.UNKNOWN_SCANNER"
            it.customDataExtra = "payload"
        }
        val router = ScanRouter(context, preferences).also { it.configure() }
        val scanned = async { router.events.first() }
        yield()
        broadcast("com.example.UNKNOWN_SCANNER") { putExtra("payload", "40318827") }
        assertEquals("intent:custom", scanned.await().source)
    }

    /**
     * An unknown service is diagnosed from the terminal, not from adb: the
     * screen reports the action and the keys that arrived even when no profile
     * could read them.
     */
    @Test
    fun anUnreadableBroadcastIsStillReported() = runTest {
        val router = router(ScanSourceKind.BUILTIN_INTENT)
        broadcast(VendorProfiles.UROVO.action) { putExtra("some_unknown_key", "40318827") }
        val report = router.lastIntent.value
        assertEquals(VendorProfiles.UROVO.action, report?.action)
        assertEquals(listOf("some_unknown_key"), report?.extraKeys)
        assertNull("no profile read it, so none may be named", report?.profileId)
    }

    @Test
    fun aReadableBroadcastNamesTheProfileThatReadIt() = runTest {
        val router = router(ScanSourceKind.BUILTIN_INTENT)
        broadcast(VendorProfiles.UROVO.action) { putExtra("barcode_string", "40318827") }
        assertEquals("urovo", router.lastIntent.value?.profileId)
    }

    /** A terminal left in both modes sends one pull twice; the work screen must see one unit. */
    @Test
    fun thePullThatArrivesTwiceIsEmittedOnce() = runTest {
        val router = router(ScanSourceKind.BUILTIN_INTENT)
        val seen = mutableListOf<ScanEvent>()
        val collecting = launch { router.events.collect { seen += it } }
        yield()
        broadcast(VendorProfiles.UROVO.action) { putExtra("barcode_string", "40318827") }
        router.type("40318827")
        yield()
        collecting.cancel()
        assertEquals(listOf("40318827"), seen.map { it.raw })
    }
}
