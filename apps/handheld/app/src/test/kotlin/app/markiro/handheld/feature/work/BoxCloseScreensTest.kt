package app.markiro.handheld.feature.work

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.box.CloseResult
import app.markiro.handheld.core.box.PrintReason
import app.markiro.handheld.core.design.MarkiroTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class BoxCloseScreensTest {
    @get:Rule
    val compose = createComposeRule()

    private val box = ClosedBoxUi("b1", 27, "046800899000000018", 20)

    @Test
    fun aPrintedBoxNamesItsNumberSsccAndCount() {
        compose.setContent { MarkiroTheme { BoxCloseScreen(BoxCloseStep.Printed(box), BoxCloseCallbacks()) } }
        compose.onNodeWithText("Короб 27 закрыт").assertIsDisplayed()
        compose.onNodeWithText("046800899000000018").assertIsDisplayed()
        compose.onNodeWithText("20 шт.").assertIsDisplayed()
        compose.onNodeWithText("Напечатано").assertIsDisplayed()
    }

    @Test
    fun aFailedPrintNamesThePrintersOwnReasonAndOffersThreeWaysOut() {
        var deferred = false
        compose.setContent {
            MarkiroTheme {
                BoxCloseScreen(
                    BoxCloseStep.Failed(box, PrintReason.NO_PAPER),
                    BoxCloseCallbacks(onDefer = { deferred = true }),
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
                BoxCloseScreen(
                    BoxCloseStep.Unknown(box, "link lost"),
                    BoxCloseCallbacks(onRetry = { retried = true }, onConfirmPrinted = { confirmed = true }),
                )
            }
        }
        compose.onNodeWithText("Результат печати неизвестен").assertIsDisplayed()
        // Both ways out are explicit choices; neither happens by itself.
        compose.onNodeWithText("Напечатать ещё раз").assertIsDisplayed()
        assertEquals(false, retried)
        compose.onNodeWithText("Этикетка напечаталась").performClick()
        assertTrue(confirmed)
    }

    @Test
    fun aDryPoolSaysWhatToDoRatherThanThatPrintingFailed() {
        compose.setContent {
            MarkiroTheme { BoxCloseScreen(BoxCloseStep.Refused(CloseResult.NoSerials), BoxCloseCallbacks()) }
        }
        compose.onNodeWithText("Закончились номера SSCC").assertIsDisplayed()
        compose.onNodeWithText("Короб остался открытым. Подключитесь к сети — устройство получит новый блок номеров.")
            .assertIsDisplayed()
    }

    @Test
    fun anUnprintableSerialLeavesTheBoxOpenAndSaysSo() {
        compose.setContent {
            MarkiroTheme { BoxCloseScreen(BoxCloseStep.Refused(CloseResult.InvalidSerial), BoxCloseCallbacks()) }
        }
        compose.onNodeWithText("Номер не подошёл под префикс").assertIsDisplayed()
        compose.onNodeWithText("Короб остался открытым. Попробуйте закрыть ещё раз.").assertIsDisplayed()
    }

    @Test
    fun everyPrintReasonHasWordsRatherThanACode() {
        val reasons = listOf(
            PrintReason.NO_PAPER, PrintReason.HEAD_OPEN, PrintReason.UNREACHABLE,
            PrintReason.PRINTER_UNCONFIGURED, PrintReason.TEMPLATE_MISSING, PrintReason.TEMPLATE_INVALID,
            PrintReason.RENDER_FAILED, PrintReason.TRANSPORT_FAILED, PrintReason.BOX_MISSING,
        )
        // Nothing falls through to a raw wire string on a screen an operator reads.
        for (reason in reasons) assertTrue(reason, printReasonLabel(reason) != 0)
    }
}
