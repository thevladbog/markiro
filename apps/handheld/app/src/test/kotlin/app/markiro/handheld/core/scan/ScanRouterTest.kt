package app.markiro.handheld.core.scan

import android.view.KeyEvent
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScanRouterTest {
    private val context = ApplicationProvider.getApplicationContext<android.content.Context>()

    private fun router(kind: ScanSourceKind): ScanRouter {
        val preferences = ScanPreferences(context).also { it.sourceKind = kind }
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
}
