package app.markiro.handheld.feature.settings

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.scan.ScanSourceKind
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.update.UpdateManifest
import app.markiro.handheld.core.update.UpdateState
import app.markiro.handheld.core.update.expectedArtifactUrl
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SettingsUpdateTest {
    @get:Rule
    val compose = createComposeRule()

    private val config = DeviceConfigEntity(
        deviceId = "dev-1", deviceName = "ТСД 1", tenantId = "t", organizationName = "ООО",
        lineId = "l1", lineName = "Линия 2", kind = "handheld",
        serverUrl = "https://admin.markiro.app", pairedAt = 1L,
    )

    private val available = UpdateState.Available(
        UpdateManifest(
            versionName = "0.5.0", versionCode = 5, sha256 = "a".repeat(64), bytes = 1,
            url = expectedArtifactUrl("0.5.0"), notes = "Исправлена лента",
            releasedAt = "2026-09-12T10:00:00.000Z", sourceSha = "b".repeat(40),
        ),
    )

    private val ui = SettingsUi(
        sourceKind = ScanSourceKind.KEYBOARD_WEDGE, profileId = "", theme = ThemeMode.DARK,
        language = "ru", version = "0.1.0", installId = "0123456789abcdef",
    )

    private fun screen(state: SettingsUi, onInstall: () -> Unit = {}) {
        compose.setContent {
            MarkiroTheme {
                SettingsScreen(
                    state, config, onBack = {}, onScanner = {}, onTheme = {}, onLanguage = {},
                    onInstallUpdate = onInstall,
                )
            }
        }
    }

    /** Nothing to install, nothing offered: the row would be a dead control. */
    @Test
    fun theInstallRowAppearsOnlyWhenSomethingIsAvailable() {
        screen(ui.copy(update = UpdateState.UpToDate))
        compose.onNodeWithText("скачать и установить").assertDoesNotExist()
    }

    @Test
    fun anAvailableUpdateCanBeInstalled() {
        var asked = false
        screen(ui.copy(update = available)) { asked = true }
        compose.onNodeWithText("скачать и установить").performScrollTo().performClick()
        assertEquals(true, asked)
    }

    /**
     * The queue is the reason this is offered from Settings and nowhere else.
     * An install restarts the app; losing queued scans to it is worse than
     * running an old build for another hour.
     */
    @Test
    fun aDeviceThatStillOwesTheServerWorkIsToldWhyItCannotInstall() {
        screen(ui.copy(update = available, install = InstallStep.QueueNotEmpty))
        compose.onNodeWithText("сначала дождитесь отправки очереди").performScrollTo().assertIsDisplayed()
    }

    @Test
    fun aCorruptDownloadSaysSoRatherThanFailingSilently() {
        screen(
            ui.copy(
                update = available,
                install = InstallStep.Failed(app.markiro.handheld.core.update.DownloadResult.Failure.CORRUPT),
            ),
        )
        compose.onNodeWithText("файл скачался повреждённым").performScrollTo().assertIsDisplayed()
    }
}
