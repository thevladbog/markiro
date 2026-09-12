package app.markiro.handheld.feature.pairing

import androidx.compose.foundation.layout.requiredSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
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
    @Test fun recoveryShowsSavedChannelsAndOffersOnlySameDeviceConnection() {
        var reconnect = false
        compose.setContent {
            MarkiroTheme { PairingScreen(PairingUi.Recovery("saved-device", mapOf("scans" to 12L, "inventory" to 4L,
                "labels" to 3L, "boxes" to 2L, "pallets" to 5L, "exceptions" to 1L, "closes" to 1L,
                "conflicts" to 2L, "unknownPrints" to 1L), false),
                PairingCallbacks(onRetry = { reconnect = true })) }
        }
        compose.onNodeWithText("Доступ к устройству приостановлен").assertIsDisplayed()
        compose.onNodeWithText("Ожидают отправки: сканы 12", substring = true).assertExists()
        // Pallets are named, not folded into the box count: a closed pallet the
        // server has not acknowledged is its own physically labelled fact, and
        // the operator deciding whether to reconnect is owed it.
        compose.onNodeWithText("паллеты 5", substring = true).assertExists()
        compose.onNodeWithText("Подключить прежнее устройство").performScrollTo().performClick()
        assertEquals(true, reconnect)
    }

    @Test fun unresolvedOwnerExplainsUnknownCountsWithoutOfferingReassignment() {
        compose.setContent { MarkiroTheme { PairingScreen(PairingUi.Recovery(null, null, true), PairingCallbacks()) } }
        compose.onNodeWithText("Не удалось определить владельца данных").assertIsDisplayed()
        compose.onNodeWithText("Количество сохранённых записей пока недоступно.", substring = true).assertExists()
        compose.onNodeWithText("Подключить прежнее устройство").assertDoesNotExist()
    }

    @Test fun recoveryActionRemainsReachableOnAShortViewportWithLargeText() {
        var reconnect = false
        compose.setContent {
            androidx.compose.runtime.CompositionLocalProvider(androidx.compose.ui.platform.LocalDensity provides androidx.compose.ui.unit.Density(1f, 1.5f)) {
                MarkiroTheme {
                    androidx.compose.foundation.layout.Box(androidx.compose.ui.Modifier.requiredSize(320.dp, 300.dp)) {
                        PairingScreen(PairingUi.Recovery("saved-device", mapOf("scans" to 12L), false), PairingCallbacks(onRetry = { reconnect = true }))
                    }
                }
            }
        }
        compose.onNodeWithText("Ожидают отправки: сканы 12", substring = true).assertExists()
        compose.onNodeWithText("Подключить прежнее устройство").performScrollTo().performClick()
        assertEquals(true, reconnect)
    }

}
