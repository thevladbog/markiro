package app.markiro.handheld.feature.settings

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.scan.ScanSourceKind
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.update.UpdateManifest
import app.markiro.handheld.core.update.UpdateState
import app.markiro.handheld.core.update.expectedArtifactUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode

@GraphicsMode(GraphicsMode.Mode.NATIVE)
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

    @Test
    fun longSyncValueKeepsAGapAndAlignsEveryLineToTheTrailingEdge() {
        compose.setContent {
            MarkiroTheme {
                Box(Modifier.width(320.dp)) {
                    SettingsScreen(ui.copy(queue = 12, lastSyncAt = 0L), config,
                        onBack = {}, onScanner = {}, onTheme = {}, onLanguage = {})
                }
            }
        }
        val valueNode = compose.onNodeWithText("12 · последняя отправка", substring = true, useUnmergedTree = true)
        valueNode.performScrollTo()
        val label = compose.onNodeWithText("Очередь синхронизации", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        val value = valueNode.fetchSemanticsNode().boundsInRoot
        assertTrue("label and value must have a gap", value.left - label.right >= 8f)
        val layouts = mutableListOf<TextLayoutResult>()
        valueNode.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
        assertEquals(TextAlign.End, layouts.single().layoutInput.style.textAlign)
        assertEquals(false, layouts.single().hasVisualOverflow)
    }

    /**
     * «Не знаю» is an answer an operator has to be able to read: a terminal is
     * offline most of a shift, and «нет сети» must not look like «обновлений нет».
     */
    @Test
    fun theUpdateRowSaysWhichKindOfNoAnswerItGot() {
        var asked = false
        compose.setContent {
            MarkiroTheme {
                SettingsScreen(
                    ui.copy(update = UpdateState.Unknown(UpdateState.Reason.UNREACHABLE)),
                    config, onBack = {}, onScanner = {}, onTheme = {}, onLanguage = {},
                    onCheckUpdate = { asked = true },
                )
            }
        }
        compose.onNodeWithText("сервер обновлений недоступен").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Обновление").performScrollTo().performClick()
        assertEquals(true, asked)
    }

    @Test
    fun anAvailableUpdateNamesItsVersion() {
        compose.setContent {
            MarkiroTheme {
                SettingsScreen(
                    ui.copy(
                        update = UpdateState.Available(
                            UpdateManifest(
                                versionName = "0.5.0", versionCode = 5, sha256 = "a".repeat(64), bytes = 1,
                                url = expectedArtifactUrl("0.5.0"), notes = "Исправлена лента",
                                releasedAt = "2026-09-12T10:00:00.000Z", sourceSha = "b".repeat(40),
                            ),
                        ),
                    ),
                    config, onBack = {}, onScanner = {}, onTheme = {}, onLanguage = {},
                )
            }
        }
        compose.onNodeWithText("есть 0.5.0 — нажмите").performScrollTo().assertIsDisplayed()
    }

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
