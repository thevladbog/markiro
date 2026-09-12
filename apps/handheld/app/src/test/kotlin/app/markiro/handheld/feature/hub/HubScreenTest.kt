package app.markiro.handheld.feature.hub

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.feature.shift.ShiftEntityFixtures
import org.junit.Assert.assertNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode

@GraphicsMode(GraphicsMode.Mode.NATIVE)
@RunWith(AndroidJUnit4::class)
class HubScreenTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun joinedShiftHasADedicatedContinueCard() {
        var resumed: String? = null
        var selected: HubTile? = null
        compose.setContent {
            MarkiroTheme {
                HubScreen(
                    HubUi(activeShiftId = "s1", continueShiftNumber = "14", shifts = 3,
                        activeShift = HubActiveShift(ShiftEntityFixtures.bundled("s1").copy(number = "14"), 0)),
                    onTile = { selected = it }, onSignOut = {}, onContinueShift = { resumed = it },
                )
            }
        }
        compose.onNodeWithText("АКТИВНАЯ СМЕНА").assertIsDisplayed()
        compose.onNodeWithText("Продолжить").assertIsDisplayed().performClick()
        assertEquals("s1", resumed)
        assertNull(selected)
        compose.onNodeWithText("3 доступны").performScrollTo().performClick()
        assertEquals(HubTile.SHIFT, selected)
    }

    @Test
    fun narrowHandheldShowsTheFullInventoryTitleOnOneLine() {
        compose.setContent {
            MarkiroTheme {
                Box(Modifier.width(320.dp)) {
                    HubScreen(HubUi("ООО", "Богатырев Владислав Сергеевич", "Линия 1", shifts = 0, inventories = 0), onTile = {}, onSignOut = {})
                }
            }
        }
        val layouts = mutableListOf<TextLayoutResult>()
        compose.onNodeWithText("Инвентаризация", useUnmergedTree = true)
            .performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
        assertEquals(1, layouts.single().lineCount)
        val layout = layouts.single()
        assertEquals("Инвентаризация".length, layout.getLineEnd(0, visibleEnd = true))
        assertTrue("the whole title must fit horizontally", layout.getLineRight(0) <= layout.size.width)
        assertTrue("the whole title must fit vertically", layout.getLineBottom(0) <= layout.size.height)
        val operatorLayouts = mutableListOf<TextLayoutResult>()
        compose.onNodeWithText("Богатырев Владислав Сергеевич · Линия 1")
            .performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(operatorLayouts) }
        val operator = operatorLayouts.single()
        assertTrue("the operator name must not be clipped", operator.getLineBottom(operator.lineCount - 1) <= operator.size.height)
    }

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

    /**
     * «Проверка кода» offered «нажмите триггер» and answered «в следующем срезе»
     * on every tap. A tile is a promise; this one had nothing behind it.
     */
    @Test
    fun thereIsNoTileForTheUnbuiltCodeCheck() {
        compose.setContent {
            MarkiroTheme {
                HubScreen(HubUi("ООО «Родник»", "Иванова Анна", "Линия 2", shifts = 3, inventories = 1), onTile = {}, onSignOut = {})
            }
        }
        compose.onNodeWithText("Проверка кода").assertDoesNotExist()
        compose.onNodeWithText("АКТИВНАЯ СМЕНА").assertDoesNotExist()
        compose.onNodeWithText("Настройки").assertIsDisplayed()
    }

    @Test
    fun offlineShowsTheQueueBannerAndTheContinueTile() {
        compose.setContent {
            MarkiroTheme {
                HubScreen(
                    HubUi(
                        "ООО «Родник»", "Иванова Анна", "Линия 2", shifts = 2, inventories = 0, countsAt = 0L, reachable = false,
                        scannerLabel = "Datalogic", queue = 37, activeShiftId = "s1", continueShiftNumber = "SEP26-001",
                        activeShift = HubActiveShift(ShiftEntityFixtures.bundled("s1"), 37),
                    ),
                    onTile = {},
                    onSignOut = {},
                )
            }
        }
        compose.onNodeWithText("Работаем офлайн · 37 сканов в очереди").assertIsDisplayed()
        compose.onNodeWithText("Продолжить").assertIsDisplayed()
        compose.onNodeWithText("На этом ТСД").assertIsDisplayed()
        compose.onNodeWithText("заданий нет · данные на", substring = true).performScrollTo().assertIsDisplayed()
    }
}
