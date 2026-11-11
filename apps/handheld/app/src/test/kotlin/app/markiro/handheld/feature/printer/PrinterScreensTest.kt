package app.markiro.handheld.feature.printer

import android.Manifest.permission.BLUETOOTH_CONNECT
import android.Manifest.permission.BLUETOOTH_SCAN
import android.app.Activity.RESULT_CANCELED
import android.content.Intent
import android.content.pm.PackageManager.PERMISSION_GRANTED
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.label.PrinterLanguage
import app.markiro.handheld.core.print.DiscoveredPrinter
import app.markiro.handheld.core.print.NotReadyReason
import app.markiro.handheld.core.print.PrinterEntity
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
class PrinterScreensTest {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    private val zebra = PrinterEntity(
        "p1", "Zebra ZD421", "wifi", "192.168.1.40:9100", "zpl", 203,
        selected = true, lastStatus = "ready", lastSeenAt = 1L,
    )
    private val belt = PrinterEntity(
        "p2", "Zebra ZQ320", "bluetooth", "AA:BB", "tspl", 203,
        selected = false, lastStatus = null, lastSeenAt = null,
    )

    @Test fun outputModeCanBeSelectedFromTheCompactForm() {
        var selected: String? = null
        compose.setContent { MarkiroTheme {
            AddPrinterScreen(AddPrinterForm(outputMode = null), AddPrinterCallbacks(onOutputMode = { selected = it }))
        } }
        compose.onNodeWithText("Как настроено в принтере").performScrollTo().performClick()
        compose.onNodeWithText("Обычная печать").assertIsDisplayed()
        compose.onNodeWithText("Обрезчик — каждая этикетка").assertIsDisplayed()
        compose.onNodeWithText("Отделитель с датчиком снятия").performClick()
        assertEquals("peel", selected)
    }

    @Test
    fun theListShowsProfilesAndPurposeSettingsWithoutAGlobalSelection() {
        var tested = false
        compose.setContent {
            MarkiroTheme {
                PrinterListScreen(
                    PrinterUi(printers = listOf(zebra, belt), selected = zebra),
                    PrinterListCallbacks(onTest = { tested = true }),
                )
            }
        }
        compose.onNodeWithText("Назначения").assertIsDisplayed()
        compose.onNodeWithText("Zebra ZD421").assertIsDisplayed()
        compose.onNodeWithText("Zebra ZQ320").assertIsDisplayed()
        compose.onNodeWithText("ZPL · 203 dpi").assertIsDisplayed()
        compose.onAllNodesWithText("Тест")[0].performClick()
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
    fun aPaperJamIsShownOnTheTestPrintScreen() {
        compose.setContent {
            MarkiroTheme {
                TestPrintScreen(
                    TestPrintStep.Failed(NotReadyReason.PAPER_JAM),
                    PrinterLanguage.TSPL,
                    203,
                    TestPrintCallbacks(),
                )
            }
        }
        compose.onNodeWithText("Замятие бумаги").assertIsDisplayed()
    }

    @Test
    fun anUnknownResultOffersConfirmationBeforeAnySecondSend() {
        var confirmed = false
        var retried = false
        compose.setContent {
            MarkiroTheme {
                TestPrintScreen(
                    TestPrintStep.Unknown("unreachable"),
                    PrinterLanguage.ZPL,
                    203,
                    TestPrintCallbacks(onConfirm = { confirmed = true }, onRetry = { retried = true }),
                )
            }
        }
        compose.onNodeWithText("Результат печати неизвестен").assertIsDisplayed()
        compose.onNodeWithText("Принтер не отвечает").assertIsDisplayed()
        compose.onNodeWithText("Этикетка напечаталась").performClick()
        assertEquals(true, confirmed)
        assertEquals(false, retried)
    }

    @Test
    @Config(sdk = [33])
    fun aPartialGrantHidesPairedDevicesUntilTheRemainingPermissionIsGranted() {
        val activity = compose.activity
        val app = shadowOf(activity.application)
        app.grantPermissions(BLUETOOTH_CONNECT)
        app.denyPermissions(BLUETOOTH_SCAN)
        var reads = 0
        compose.setContent {
            MarkiroTheme {
                BluetoothPairScreen(
                    PrinterUi(paired = listOf(DiscoveredPrinter("AA:BB", "Zebra ZQ320", bonded = true))),
                    BluetoothPairCallbacks(onSearchAgain = { reads++ }),
                )
            }
        }

        compose.onNodeWithText("Zebra ZQ320").assertDoesNotExist()
        compose.onNodeWithText("Разрешить").performClick()
        val request = checkNotNull(shadowOf(activity).lastRequestedPermission)
        assertArrayEquals(arrayOf(BLUETOOTH_SCAN), request.requestedPermissions)
        compose.runOnIdle {
            activity.activityResultRegistry.dispatchResult(request.requestCode, mapOf(BLUETOOTH_SCAN to false))
            assertEquals(0, reads)
        }

        compose.onNodeWithText("Открыть настройки приложения").performClick()
        val settings = checkNotNull(shadowOf(activity).nextStartedActivityForResult)
        assertEquals(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, settings.intent.action)
        assertEquals("package:${activity.packageName}", settings.intent.dataString)
        compose.runOnIdle {
            app.grantPermissions(BLUETOOTH_SCAN)
            activity.activityResultRegistry.dispatchResult(settings.requestCode, RESULT_CANCELED, Intent())
        }
        compose.onNodeWithText("Zebra ZQ320").assertIsDisplayed()
        compose.runOnIdle { assertEquals(1, reads) }
    }

    @Test
    @Config(sdk = [33])
    @Suppress("DEPRECATION") // Simulate Android delivering the permission result.
    fun tappingAllowRequestsAndroidPermissionsAndReloadsAfterGrant() {
        val activity = compose.activity
        val app = shadowOf(activity.application)
        val permissions = arrayOf(BLUETOOTH_SCAN, BLUETOOTH_CONNECT)
        app.denyPermissions(*permissions)
        val state = mutableStateOf(PrinterUi(permissionNeeded = true))
        var reads = 0
        compose.setContent {
            MarkiroTheme {
                BluetoothPairScreen(state.value, BluetoothPairCallbacks(onSearchAgain = {
                    reads++
                    state.value = PrinterUi(paired = listOf(DiscoveredPrinter("AA:BB", "Zebra ZQ320", bonded = true)))
                }))
            }
        }

        compose.onNodeWithText("Разрешить").performClick()
        val request = checkNotNull(shadowOf(activity).lastRequestedPermission) {
            "The Allow button did not ask Android for Bluetooth permissions"
        }
        assertArrayEquals(permissions, request.requestedPermissions)
        compose.runOnIdle {
            assertEquals(0, reads)
            app.grantPermissions(*permissions)
            activity.onRequestPermissionsResult(request.requestCode, permissions, intArrayOf(PERMISSION_GRANTED, PERMISSION_GRANTED))
        }
        compose.onNodeWithText("Zebra ZQ320").assertIsDisplayed()
        compose.runOnIdle { assertEquals(1, reads) }
    }

    @Test
    @Config(sdk = [28])
    fun theBluetoothScreenListsPairedDevicesWithoutRuntimePermissionOnOlderAndroid() {
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
