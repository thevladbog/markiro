package app.markiro.handheld.feature.work

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.box.ClosePalletResult
import app.markiro.handheld.core.box.PrintReason
import app.markiro.handheld.core.design.MarkiroTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PalletCloseScreensTest {
    @get:Rule
    val compose = createComposeRule()

    private val pallet = ClosedPalletUi("p1", "103460068200000004", 12)

    @Test
    fun namesThePalletAndItsSsccOnClose() {
        compose.setContent { MarkiroTheme { PalletCloseScreen(PalletCloseStep.Printed(pallet), PalletCloseCallbacks()) } }
        compose.onNodeWithText("Паллета закрыта").assertIsDisplayed()
        compose.onNodeWithText("103460068200000004").assertIsDisplayed()
        compose.onNodeWithText("12 коробов").assertIsDisplayed()
        compose.onNodeWithText("Напечатано").assertIsDisplayed()
    }

    @Test
    fun aFailedPrintNamesThePrintersOwnReasonAndOffersThreeWaysOut() {
        var deferred = false
        compose.setContent {
            MarkiroTheme {
                PalletCloseScreen(
                    PalletCloseStep.Failed(pallet, PrintReason.NO_PAPER),
                    PalletCloseCallbacks(onDefer = { deferred = true }),
                )
            }
        }
        compose.onNodeWithText("Этикетка не напечатана").assertIsDisplayed()
        compose.onNodeWithText("Нет бумаги").assertIsDisplayed()
        compose.onNodeWithText("Повторить").assertIsDisplayed()
        compose.onNodeWithText("Другой принтер").assertIsDisplayed()
        compose.onNodeWithText("Отложить этикетку").performClick()
        assertTrue(deferred)
    }

    @Test
    fun anUnknownResultAsksAPersonAndNeverRetriesOnItsOwn() {
        var confirmed = false
        var retried = false
        compose.setContent {
            MarkiroTheme {
                PalletCloseScreen(
                    PalletCloseStep.Unknown(pallet, "link lost"),
                    PalletCloseCallbacks(onRetry = { retried = true }, onConfirmPrinted = { confirmed = true }),
                )
            }
        }
        compose.onNodeWithText("Результат печати неизвестен").assertIsDisplayed()
        compose.onNodeWithText("Напечатать ещё раз").assertIsDisplayed()
        assertEquals(false, retried)
        compose.onNodeWithText("Этикетка напечаталась").performClick()
        assertTrue(confirmed)
    }

    @Test
    fun aDryPoolSaysWhatToDoRatherThanThatPrintingFailed() {
        compose.setContent {
            MarkiroTheme { PalletCloseScreen(PalletCloseStep.Refused(ClosePalletResult.NoSerials), PalletCloseCallbacks()) }
        }
        compose.onNodeWithText("Закончились номера SSCC").assertIsDisplayed()
        compose.onNodeWithText("Паллета осталась открытой. Подключитесь к сети — устройство получит новый блок номеров.")
            .assertIsDisplayed()
    }

    @Test
    fun anEmptyPalletNamesTheProblemRatherThanARawCode() {
        compose.setContent {
            MarkiroTheme { PalletCloseScreen(PalletCloseStep.Refused(ClosePalletResult.Empty), PalletCloseCallbacks()) }
        }
        compose.onNodeWithText("В паллете нет коробов").assertIsDisplayed()
    }
}
