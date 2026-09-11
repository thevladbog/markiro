package app.markiro.handheld.feature.settings

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollTo
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.scan.ScanSourceKind
import app.markiro.handheld.core.storage.DeviceConfigEntity
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SettingsScreenTest {
    @get:Rule
    val compose = createComposeRule()

    private val config = DeviceConfigEntity(
        deviceId = "dev-1", deviceName = "ТСД 1", tenantId = "t", organizationName = "ООО",
        lineId = "l1", lineName = "Линия 2", kind = "handheld",
        serverUrl = "https://admin.markiro.app", pairedAt = 1L,
    )

    private val ui = SettingsUi(
        sourceKind = ScanSourceKind.KEYBOARD_WEDGE,
        profileId = "",
        theme = ThemeMode.DARK,
        language = "ru",
        version = "0.1.0",
        installId = "0123456789abcdef",
    )

    /**
     * The device block answers «чей это продукт и что за сборка» when a line
     * asks — the version alone does not, and the operator has no other place to
     * look on a handheld with no browser.
     */
    @Test
    fun theDeviceBlockNamesTheVendorBesideTheVersion() {
        compose.setContent {
            MarkiroTheme {
                SettingsScreen(ui, config, onBack = {}, onScanner = {}, onTheme = {}, onLanguage = {})
            }
        }
        // The block sits below the fold on a handheld screen; scrolling to it is
        // part of the claim that an operator can actually reach it.
        compose.onNodeWithText("Производитель").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("v-b.tech").assertIsDisplayed()
        compose.onNodeWithText("0.1.0").assertIsDisplayed()
    }
}
