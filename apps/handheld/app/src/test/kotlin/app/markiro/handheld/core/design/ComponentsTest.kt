package app.markiro.handheld.core.design

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Key
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ComponentsTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun keypadReportsDigitsBackspaceAndConfirm() {
        val typed = StringBuilder()
        var confirmed = 0
        compose.setContent {
            MarkiroTheme(dark = true) {
                Keypad(
                    onDigit = { typed.append(it) },
                    onBackspace = { typed.setLength(maxOf(0, typed.length - 1)) },
                    onConfirm = { confirmed++ },
                    confirmEnabled = true,
                )
            }
        }
        compose.onNodeWithText("4").performClick()
        compose.onNodeWithText("8").performClick()
        compose.onNodeWithText("1").performClick()
        compose.onNode(hasContentDescription("Стереть")).performClick()
        compose.onNodeWithText("OK").performClick()
        assertEquals("48", typed.toString())
        assertEquals(1, confirmed)
    }

    @Test
    fun fullScreenStateShowsTitleTextAndAction() {
        var pressed = false
        compose.setContent {
            MarkiroTheme(dark = true) {
                FullScreenState(
                    icon = Icons.Outlined.Key,
                    title = "Код не подошёл",
                    text = "Обновите код в кабинете.",
                    primary = StateAction("Ввести новый код") { pressed = true },
                    tone = Tone.Err,
                )
            }
        }
        compose.onNodeWithText("Код не подошёл").assertIsDisplayed()
        compose.onNodeWithText("Ввести новый код").performClick()
        assertEquals(true, pressed)
    }
}
