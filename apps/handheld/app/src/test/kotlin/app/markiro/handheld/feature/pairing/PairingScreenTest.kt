package app.markiro.handheld.feature.pairing

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.network.PairingError
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PairingScreenTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun entryShowsTypedDigitsGroupedAndKeypad() {
        val digits = mutableListOf<Char>()
        compose.setContent {
            MarkiroTheme {
                PairingScreen(PairingUi.Enter("4812", "https://admin.markiro.app", false), PairingCallbacks(onDigit = { digits += it }))
            }
        }
        compose.onNodeWithText("Привязать устройство").assertIsDisplayed()
        compose.onNodeWithText("4 8 1 2").assertIsDisplayed()
        compose.onNodeWithText("7").performClick()
        assertEquals(listOf('7'), digits)
    }

    @Test
    fun kindMismatchExplainsTheCabinetFix() {
        var retried = false
        compose.setContent {
            MarkiroTheme { PairingScreen(PairingUi.Failed(PairingError.KIND_MISMATCH), PairingCallbacks(onRetry = { retried = true })) }
        }
        compose.onNodeWithText("Этот код выпущен для станции").assertIsDisplayed()
        compose.onNodeWithText("Ввести другой код").performClick()
        assertEquals(true, retried)
    }

    @Test
    fun successNamesTheLine() {
        compose.setContent {
            MarkiroTheme { PairingScreen(PairingUi.Success("ООО «Родник»", "Линия 2"), PairingCallbacks()) }
        }
        compose.onNodeWithText("ТСД привязан").assertIsDisplayed()
        compose.onNodeWithText("ООО «Родник» · Линия 2").assertIsDisplayed()
    }
}
