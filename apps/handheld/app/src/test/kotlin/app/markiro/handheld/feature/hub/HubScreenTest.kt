package app.markiro.handheld.feature.hub

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.size
import androidx.compose.ui.test.onNodeWithContentDescription
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
    fun aMissingWorkPrinterRemainsActionableAfterMovingSettingsToTheHeader() {
        var selected: HubTile? = null
        compose.setContent { MarkiroTheme {
            HubScreen(HubUi(hostMode = true, missingPrinterPurposes = listOf(app.markiro.handheld.core.print.PrintPurpose.BOX)),
                onTile = { selected = it }, onSignOut = {})
        } }
        compose.onNodeWithText("Не назначено: Короб").assertIsDisplayed().performClick()
        assertEquals(HubTile.SETTINGS, selected)
    }

    @Test
    fun aMissingMarkingCodePrinterRemainsActionableInHostMode() {
        var selected: HubTile? = null
        compose.setContent { MarkiroTheme {
            HubScreen(HubUi(hostMode = true, missingPrinterPurposes = listOf(app.markiro.handheld.core.print.PrintPurpose.DUPLICATE)),
                onTile = { selected = it }, onSignOut = {})
        } }
        compose.onNodeWithText("Не назначено: Коды маркировки").assertIsDisplayed().performClick()
        assertEquals(HubTile.SETTINGS, selected)
    }

    @Test
    fun aMarkingCodePrinterProblemRemainsActionableInHostMode() {
        var selected: HubTile? = null
        compose.setContent { MarkiroTheme {
            HubScreen(HubUi(hostMode = true, printerAttentionPurposes = listOf(app.markiro.handheld.core.print.PrintPurpose.DUPLICATE)),
                onTile = { selected = it }, onSignOut = {})
        } }
        compose.onNodeWithText("Проверьте принтер: Коды маркировки").assertIsDisplayed().performClick()
        assertEquals(HubTile.SETTINGS, selected)
    }

    @Test
    fun hostMenuAndSettingsFitWithoutScrollingOn320dp() {
        var selected: HubTile? = null
        compose.setContent {
            MarkiroTheme {
                Box(Modifier.size(320.dp, 520.dp)) {
                    HubScreen(HubUi(hostMode = true, organization = "ООО", operatorName = "Богатырев Владислав Сергеевич"),
                        onTile = { selected = it }, onSignOut = {})
                }
            }
        }
        compose.onNodeWithText("Смена").assertIsDisplayed()
        compose.onNodeWithText("Палеты").assertIsDisplayed()
        compose.onNodeWithText("Расформирование").assertIsDisplayed()
        compose.onNodeWithContentDescription("Настройки").assertIsDisplayed().performClick()
        assertEquals(HubTile.SETTINGS, selected)
        compose.onNodeWithText("Принтер").assertDoesNotExist()
    }

    @Test
    fun replacementBlocksNewTilesButKeepsRecoveryAndSettings() {
        var selected: HubTile? = null
        var recoveryOpened = false
        compose.setContent {
            MarkiroTheme {
                HubScreen(HubUi(replacementBlocked = true, unprintedLabels = 1),
                    onTile = { selected = it }, onSignOut = {}, onLabelQueue = { recoveryOpened = true })
            }
        }
        compose.onNodeWithText("Смена").performScrollTo().performClick()
        assertNull(selected)
        compose.onNodeWithText("Инвентаризация").performScrollTo().performClick()
        assertNull(selected)
        compose.onNodeWithText("Списание").performScrollTo().performClick()
        assertNull(selected)
        compose.onNodeWithContentDescription("Настройки").performClick()
        assertEquals(HubTile.SETTINGS, selected)
        compose.onNodeWithText("1 этикетка не напечатана").performClick()
        assertTrue(recoveryOpened)
    }

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
        compose.onNodeWithText("Смена 14", substring = true).assertIsDisplayed()
        compose.onNodeWithText("Продолжить").assertIsDisplayed().performClick()
        assertEquals("s1", resumed)
        assertNull(selected)
        compose.onNodeWithText("3 доступны").performScrollTo().performClick()
        assertEquals(HubTile.SHIFT, selected)
    }

    /** «Продолжить» goes through the same entry as the list, so it can be refused the same way. */
    @Test
    fun anEntryRefusalOnTheHubIsShownInWords() {
        var dismissed = false
        compose.setContent {
            MarkiroTheme {
                HubScreen(
                    HubUi(activeShiftId = "s1", dialog = app.markiro.handheld.feature.shift.ShiftDialog.Closed),
                    onTile = {}, onSignOut = {}, onDismissDialog = { dismissed = true },
                )
            }
        }
        compose.onNodeWithText("Смена уже закрыта").assertIsDisplayed()
        compose.onNodeWithText("Понятно").performClick()
        assertEquals(true, dismissed)
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
        compose.onNodeWithText("Богатырев Владислав Сергеевич")
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
        compose.onNodeWithText("Иванова Анна").assertIsDisplayed()
        compose.onNodeWithText("3 доступны").assertIsDisplayed()
        compose.onNodeWithText("1 задание").assertIsDisplayed()
        compose.onNodeWithContentDescription("Связь и очередь").performClick()
        compose.onNodeWithText("Очередь 37").assertIsDisplayed()
        compose.onNodeWithText("Готово").performClick()
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
        // The pallet tile made the grid taller than the screen; the tile is still there.
        compose.onNodeWithContentDescription("Настройки").assertIsDisplayed()
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
        compose.onNodeWithContentDescription("Связь и очередь").performClick()
        compose.onNodeWithText("Работаем офлайн").assertIsDisplayed()
        compose.onNodeWithText("Очередь 37").assertIsDisplayed()
        compose.onNodeWithText("Готово").performClick()
        compose.onNodeWithText("Продолжить").assertIsDisplayed()
        compose.onNodeWithText("На этом ТСД").assertIsDisplayed()
        compose.onNodeWithText("заданий нет · данные на", substring = true).performScrollTo().assertIsDisplayed()
    }

    /**
     * The pallet tile carries the same two facts the write-off one does: a
     * missing right, and work this device still owes the server.
     */
    @Test
    fun thePalletTileShowsAMissingRightAndTheQueueItOwes() {
        var selected: HubTile? = null
        compose.setContent {
            MarkiroTheme { HubScreen(HubUi(canBuildPallets = false), onTile = { selected = it }, onSignOut = {}) }
        }
        compose.onNodeWithText("Палеты").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("нет прав").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Палеты").performScrollTo().performClick()
        assertEquals(HubTile.PALLETS, selected)
    }

    @Test
    fun thePalletTileCountsUnsentMembershipsInWords() {
        compose.setContent {
            MarkiroTheme { HubScreen(HubUi(canBuildPallets = true, palletsPending = 3), onTile = {}, onSignOut = {}) }
        }
        compose.onNodeWithText("3 короба не отправлены").performScrollTo().assertIsDisplayed()
    }
}
