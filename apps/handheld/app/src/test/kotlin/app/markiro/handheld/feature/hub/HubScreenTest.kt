package app.markiro.handheld.feature.hub

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class HubScreenTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun showsHeaderTilesAndCounts() {
        var opened: HubTile? = null
        compose.setContent {
            MarkiroTheme {
                HubScreen(
                    HubUi(
                        "ООО «Родник»", "Иванова Анна", "Линия 2", shifts = 3, inventories = 1, countsAt = null, reachable = true,
                        scannerLabel = "Datalogic", queue = 37,
                    ),
                    onTile = { opened = it },
                    onSignOut = {},
                )
            }
        }
        compose.onNodeWithText("Иванова Анна · Линия 2").assertIsDisplayed()
        compose.onNodeWithText("3 доступны").assertIsDisplayed()
        compose.onNodeWithText("1 задание").assertIsDisplayed()
        compose.onNodeWithText("Очередь 37").assertIsDisplayed()
        compose.onNodeWithText("Инвентаризация").performClick()
        assertEquals(HubTile.INVENTORY, opened)
    }

    @Test
    fun offlineShowsTheQueueBannerAndTheContinueTile() {
        compose.setContent {
            MarkiroTheme {
                HubScreen(
                    HubUi(
                        "ООО «Родник»", "Иванова Анна", "Линия 2", shifts = 2, inventories = 0, countsAt = 0L, reachable = false,
                        scannerLabel = "Datalogic", queue = 37, activeShiftId = "s1", continueShiftNumber = "SEP26-001",
                    ),
                    onTile = {},
                    onSignOut = {},
                )
            }
        }
        compose.onNodeWithText("Работаем офлайн · 37 сканов в очереди").assertIsDisplayed()
        compose.onNodeWithText("продолжить SEP26-001").assertIsDisplayed()
        compose.onNodeWithText("заданий нет").assertIsDisplayed()
    }
}
