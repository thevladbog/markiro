package app.markiro.handheld.feature.printer

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.label.PrinterLanguage
import app.markiro.handheld.core.print.DiscoveredPrinter
import app.markiro.handheld.core.print.NotReadyReason
import app.markiro.handheld.core.print.PrinterEntity
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PrinterScreensTest {
    @get:Rule
    val compose = createComposeRule()

    private val zebra = PrinterEntity(
        "p1", "Zebra ZD421", "wifi", "192.168.1.40:9100", "zpl", 203,
        selected = true, lastStatus = "ready", lastSeenAt = 1L,
    )
    private val belt = PrinterEntity(
        "p2", "Zebra ZQ320", "bluetooth", "AA:BB", "tspl", 203,
        selected = false, lastStatus = null, lastSeenAt = null,
    )

    @Test
    fun theListShowsTheSelectedPrinterItsSettingsAndTheOthers() {
        var tested = false
        compose.setContent {
            MarkiroTheme {
                PrinterListScreen(
                    PrinterUi(printers = listOf(zebra, belt), selected = zebra),
                    PrinterListCallbacks(onTest = { tested = true }),
                )
            }
        }
        compose.onNodeWithText("ВЫБРАН").assertIsDisplayed()
        compose.onNodeWithText("Zebra ZD421").assertIsDisplayed()
        compose.onNodeWithText("ДОСТУПНЫЕ").assertIsDisplayed()
        compose.onNodeWithText("Zebra ZQ320").assertIsDisplayed()
        compose.onNodeWithText("ZPL · 203 dpi").assertIsDisplayed()
        compose.onNodeWithText("Тестовая печать").performClick()
        assertEquals(true, tested)
    }

    @Test
    fun theAddFormOffersBothTransportsAndTheTwoDensities() {
        var checked = false
        compose.setContent {
            MarkiroTheme {
                AddPrinterScreen(AddPrinterForm(host = "192.168.1.40"), AddPrinterCallbacks(onCheck = { checked = true }))
            }
        }
        compose.onNodeWithText("По сети (Wi-Fi)").assertIsDisplayed()
        compose.onNodeWithText("Bluetooth").assertIsDisplayed()
        compose.onNodeWithText("300 dpi").assertIsDisplayed()
        compose.onNodeWithText("Проверить связь").performClick()
        assertEquals(true, checked)
    }

    @Test
    fun aPrinterThatWillNotPrintNamesTheReason() {
        compose.setContent {
            MarkiroTheme {
                AddPrinterScreen(
                    AddPrinterForm(host = "192.168.1.40", error = NotReadyReason.NO_PAPER),
                    AddPrinterCallbacks(),
                )
            }
        }
        compose.onNodeWithText("Нет бумаги").assertIsDisplayed()
    }

    @Test
    fun anUnreachablePrinterNamesItsAddressAndTheTimeout() {
        compose.setContent {
            MarkiroTheme { PrinterErrorScreen("192.168.1.40:9100", PrinterErrorCallbacks()) }
        }
        compose.onNodeWithText("Принтер не отвечает").assertIsDisplayed()
        compose.onNodeWithText("192.168.1.40:9100", substring = true).assertIsDisplayed()
        compose.onNodeWithText("Проверить снова").assertIsDisplayed()
    }

    @Test
    fun aDeliveredTestPrintAsksWhetherTheLabelIsClean() {
        var confirmed = false
        compose.setContent {
            MarkiroTheme {
                TestPrintScreen(
                    TestPrintStep.Sent("Zebra ZD421 · 192.168.1.40:9100"),
                    PrinterLanguage.ZPL,
                    203,
                    TestPrintCallbacks(onConfirm = { confirmed = true }),
                )
            }
        }
        compose.onNodeWithText("Тестовая этикетка отправлена").assertIsDisplayed()
        compose.onNodeWithText("Этикетка напечаталась чётко, кириллица и штрих-код читаются?").assertIsDisplayed()
        compose.onNodeWithText("Да, всё чётко").performClick()
        assertEquals(true, confirmed)
    }

    @Test
    fun anUnknownResultOffersConfirmationBeforeAnySecondSend() {
        var confirmed = false
        var retried = false
        compose.setContent {
            MarkiroTheme {
                TestPrintScreen(
                    TestPrintStep.Unknown("link lost"),
                    PrinterLanguage.ZPL,
                    203,
                    TestPrintCallbacks(onConfirm = { confirmed = true }, onRetry = { retried = true }),
                )
            }
        }
        compose.onNodeWithText("Результат печати неизвестен").assertIsDisplayed()
        compose.onNodeWithText("Этикетка напечаталась").performClick()
        assertEquals(true, confirmed)
        assertEquals(false, retried)
    }

    @Test
    fun theBluetoothScreenAsksForPermissionBeforeListingAnything() {
        compose.setContent {
            MarkiroTheme { BluetoothPairScreen(PrinterUi(permissionNeeded = true), BluetoothPairCallbacks()) }
        }
        compose.onNodeWithText("Нужен доступ к Bluetooth, чтобы увидеть принтеры.").assertIsDisplayed()
        compose.onNodeWithText("Разрешить").assertIsDisplayed()
    }

    @Test
    fun theBluetoothScreenListsPairedDevices() {
        compose.setContent {
            MarkiroTheme {
                BluetoothPairScreen(
                    PrinterUi(paired = listOf(DiscoveredPrinter("AA:BB", "Zebra ZQ320", bonded = true))),
                    BluetoothPairCallbacks(),
                )
            }
        }
        compose.onNodeWithText("Zebra ZQ320").assertIsDisplayed()
        compose.onNodeWithText("Выбрать").assertIsDisplayed()
    }
}
