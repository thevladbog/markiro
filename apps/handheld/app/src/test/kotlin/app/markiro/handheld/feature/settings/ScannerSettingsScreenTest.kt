package app.markiro.handheld.feature.settings

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.scan.IntentReport
import app.markiro.handheld.core.scan.ScanSourceKind
import app.markiro.handheld.core.scan.VendorProfiles
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode

@GraphicsMode(GraphicsMode.Mode.NATIVE)
@RunWith(AndroidJUnit4::class)
class ScannerSettingsScreenTest {
    @get:Rule
    val compose = createComposeRule()

    private val ui = SettingsUi(
        sourceKind = ScanSourceKind.BUILTIN_INTENT,
        profileId = VendorProfiles.UROVO.id,
        theme = ThemeMode.DARK,
        language = "ru",
    )

    private fun show(state: SettingsUi = ui, onCustom: (String, String, String) -> Unit = { _, _, _ -> }) {
        compose.setContent {
            MarkiroTheme {
                ScannerSettingsScreen(state, onBack = {}, onSource = {}, onProfile = {}, onDebugScan = {}, onCustomProfile = onCustom)
            }
        }
    }

    /** The list is instructions to follow, not a service to choose; say so where it is read. */
    @Test
    fun theProfileListDoesNotAskTheOperatorToPickAVendor() {
        show()
        compose.onNodeWithText("Приложение слушает все профили сразу", substring = true).performScrollTo().assertIsDisplayed()
    }

    @Test
    fun everyKnownVendorIsOffered() {
        show()
        for (profile in VendorProfiles.ALL) {
            compose.onNodeWithText(profile.label).performScrollTo().assertIsDisplayed()
        }
    }

    /**
     * The whole point of the diagnostics block: a terminal whose service nobody
     * recognised can be identified where it stands, without adb and without
     * leaving the floor.
     */
    @Test
    fun anUnrecognisedBroadcastNamesItsActionAndKeys() {
        show(ui.copy(lastIntent = IntentReport("com.example.SCAN", listOf("payload", "symbol"), null, 0)))
        compose.onNodeWithText("com.example.SCAN").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("payload · symbol").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Ключ данных не опознан", substring = true).performScrollTo().assertIsDisplayed()
    }

    @Test
    fun aRecognisedBroadcastNamesTheProfileThatReadIt() {
        show(ui.copy(lastIntent = IntentReport(VendorProfiles.UROVO.action, listOf("barcode_string"), VendorProfiles.UROVO.id, 0)))
        compose.onNodeWithText("Опознан профилем «Urovo · ScanManager».").performScrollTo().assertIsDisplayed()
    }

    @Test
    fun aCustomProfileCannotBeSavedWithoutBothRequiredFields() {
        show()
        compose.onNodeWithText("Сохранить профиль").performScrollTo().assertIsNotEnabled()
    }

    @Test
    fun typingACustomProfileReportsAllThreeFields() {
        var saved: Triple<String, String, String>? = null
        show(onCustom = { a, d, s -> saved = Triple(a, d, s) })
        compose.onNodeWithText("Действие (intent action)").performScrollTo().performTextInput("com.example.SCAN")
        compose.onNodeWithText("Ключ данных (extra)").performTextInput("payload")
        compose.onNodeWithText("Ключ символики (необязательно)").performTextInput("symbol")
        compose.onNodeWithText("Сохранить профиль").performScrollTo().performClick()
        assertEquals(Triple("com.example.SCAN", "payload", "symbol"), saved)
    }

    /** Clearing has to reach the router too, or the stale action stays registered until a restart. */
    @Test
    fun clearingACustomProfileReportsEmptyFields() {
        var saved: Triple<String, String, String>? = null
        show(ui.copy(customAction = "com.example.SCAN", customDataExtra = "payload"), onCustom = { a, d, s -> saved = Triple(a, d, s) })
        compose.onNodeWithText("Очистить").performScrollTo().performClick()
        assertEquals(Triple("", "", ""), saved)
    }
}
