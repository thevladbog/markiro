package app.markiro.handheld.feature.inventory

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.network.InventoryTaskDto
import app.markiro.handheld.core.storage.InventoryFixtures
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.text.NumberFormat

@RunWith(AndroidJUnit4::class)
class InventoryListScreenTest {
    @get:Rule
    val compose = createComposeRule()

    private val check = InventoryTaskDto("i2", "INV-0008", "Сок", null, "check", "l1", "Линия 2", "2026-08-01", "2026-08-31")
    private val repack = InventoryTaskDto("i3", "INV-0009", "Сок", null, "repack", "l1", "Линия 2", "2026-08-01", "2026-08-31")

    @Test
    fun showsContinueMineAndDisabledRepack() {
        var selected: String? = null
        var continued = false
        compose.setContent {
            MarkiroTheme {
                InventoryListScreen(
                    InventoryListUi(
                        loading = false, active = InventoryFixtures.task("i1"), mine = listOf(check, repack), others = emptyMap(),
                        othersExpanded = false, othersLoading = false, reachable = true, ownLineName = "Линия 2", listFetchedAt = 0L, dialog = null,
                    ),
                    InventoryListCallbacks(onContinue = { continued = true }, onSelect = { selected = it.inventoryId }),
                )
            }
        }
        compose.onNodeWithText("INV-0007").assertIsDisplayed()
        compose.onNodeWithText("Продолжить").performClick()
        assertEquals(true, continued)
        compose.onNodeWithText("INV-0008").performClick()
        assertEquals("i2", selected)
        compose.onNodeWithText("с переупаковкой: в следующем срезе").assertIsDisplayed()
        compose.onNode(hasText("INV-0009")).assertIsNotEnabled()
    }

    /**
     * `onRefresh` was already wired, but the only way an operator could reach it
     * was to hit an error first -- the list itself offered nothing.
     */
    @Test
    fun theAppBarOffersRefresh() {
        var refreshed = false
        compose.setContent {
            MarkiroTheme {
                InventoryListScreen(
                    InventoryListUi(false, null, listOf(check), emptyMap(), false, false, true, "Линия 2", 0L, null),
                    InventoryListCallbacks(onRefresh = { refreshed = true }),
                )
            }
        }
        compose.onNodeWithContentDescription("Обновить").performClick()
        assertEquals(true, refreshed)
    }

    @Test
    fun aFailedRefreshSaysSoInsteadOfLookingLikeSuccess() {
        compose.setContent {
            MarkiroTheme {
                InventoryListScreen(
                    InventoryListUi(
                        false, null, listOf(check), emptyMap(), false, false, true, "Линия 2", 0L, null,
                        refreshFailed = true,
                    ),
                    InventoryListCallbacks(),
                )
            }
        }
        compose.onNodeWithText("Не удалось обновить список", substring = true).assertIsDisplayed()
    }

    @Test
    fun downloadDialogShowsProgress() {
        compose.setContent {
            MarkiroTheme {
                InventoryListScreen(
                    InventoryListUi(false, null, emptyList(), emptyMap(), false, false, true, "Линия 2", 0L, InventoryDialog.Downloading("INV-0008", 12400, 41160)),
                    InventoryListCallbacks(),
                )
            }
        }
        compose.onNodeWithText("Загружаем снимок INV-0008").assertIsDisplayed()
        val n = NumberFormat.getIntegerInstance()
        compose.onNodeWithText("${n.format(12400)} из ${n.format(41160)}").assertIsDisplayed()
    }
}
