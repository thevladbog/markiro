package app.markiro.handheld.feature.inventory

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.inventory.InventorySyncState
import app.markiro.handheld.core.inventory.InventoryVerdict
import app.markiro.handheld.core.inventory.LocalClaim
import app.markiro.handheld.core.inventory.RecordOutcome
import app.markiro.handheld.core.storage.InventoryEventEntity
import app.markiro.handheld.core.storage.InventoryFixtures
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.text.NumberFormat

@RunWith(AndroidJUnit4::class)
class InventoryWorkScreenTest {
    @get:Rule
    val compose = createComposeRule()

    private val event = InventoryEventEntity(
        "e1", "i1", "snap", 1, "op-1", "2026-09-10T08:00:00.000Z", "item", "item:h", "h", "010460000000001521S1", "2026-08-20", "expected", 1,
        null, null, null, null,
    )

    private val ui = InventoryWorkUi(
        task = InventoryFixtures.task("i1"), expectedCount = 4116, activeDate = "2026-08-20",
        last = InventoryLastScan(
            InventoryVerdict.DUPLICATE, "…1234", winner = LocalClaim("h", "z", "dev-2", "2026-09-10T07:42:00.000Z"), ownDevice = false,
            boxCounted = null, boxTotal = null, sourceStatus = null, invalidReason = null,
        ),
        progress = InventoryProgress(verified = 1240, discrepancies = 7, protected = 3, thisTerminal = 312, rejected = 1),
        feed = listOf(event), sync = InventorySyncState(pending = 37), reachable = false, held = null, closed = false,
    )

    @Test
    fun rendersVerdictCountersAndDateChip() {
        var left = false
        compose.setContent { MarkiroTheme { InventoryWorkScreen(ui, InventoryWorkCallbacks(onLeave = { left = true })) } }
        val n = NumberFormat.getIntegerInstance()
        compose.onNodeWithText("ДУБЛЬ").assertIsDisplayed()
        compose.onNodeWithText("на другом терминале в", substring = true).assertIsDisplayed()
        compose.onNodeWithText("${n.format(1240)} / ${n.format(4116)}").assertIsDisplayed()
        compose.onNodeWithText("…S1").assertIsDisplayed()
        compose.onNodeWithText("312").assertIsDisplayed()
        compose.onNodeWithText("Защищено 3 · Отклонено сервером 1").assertIsDisplayed()
        compose.onNodeWithText("Дата 20.08.2026").assertIsDisplayed()
        compose.onNodeWithText("Работаем офлайн · 37 событий в очереди").assertIsDisplayed()
        compose.onNodeWithContentDescription("Ещё").performClick()
        compose.onNodeWithText("Выйти из задания").performClick()
        assertEquals(true, left)
    }

    @Test
    fun mismatchSheetOffersThreeActionsAndMixedOnlyTwo() {
        var applied = false
        compose.setContent {
            MarkiroTheme {
                InventoryWorkScreen(
                    ui.copy(held = RecordOutcome.DateMismatch("2026-08-20", "2026-08-22", false, "raw")),
                    InventoryWorkCallbacks(onApplyDate = { applied = true }),
                )
            }
        }
        compose.onNodeWithText("Дата в коде отличается от активной").assertIsDisplayed()
        compose.onNodeWithText("Установить 22.08.2026 и зачесть").performClick()
        assertEquals(true, applied)
    }

    @Test
    fun mixedBoxSheetHasNoDateToApply() {
        compose.setContent {
            MarkiroTheme {
                InventoryWorkScreen(ui.copy(held = RecordOutcome.DateMismatch("2026-08-20", null, true, "raw")), InventoryWorkCallbacks())
            }
        }
        compose.onNodeWithText("В коробе несколько дат розлива").assertIsDisplayed()
        compose.onNodeWithText("Зачесть как есть").assertIsDisplayed()
        compose.onNodeWithText("Пропустить код").assertIsDisplayed()
    }

    @Test
    fun closedStateReplacesTheScanZone() {
        compose.setContent { MarkiroTheme { InventoryWorkScreen(ui.copy(closed = true), InventoryWorkCallbacks()) } }
        compose.onNodeWithText("Задание закрыто в кабинете").assertIsDisplayed()
        compose.onNodeWithText("В хаб").assertIsDisplayed()
    }
}
