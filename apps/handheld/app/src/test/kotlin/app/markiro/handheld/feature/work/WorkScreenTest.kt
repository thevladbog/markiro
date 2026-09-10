package app.markiro.handheld.feature.work

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.km.Verdict
import app.markiro.handheld.core.storage.ScanEventEntity
import app.markiro.handheld.core.sync.SyncState
import app.markiro.handheld.feature.shift.ShiftEntityFixtures
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.text.NumberFormat

@RunWith(AndroidJUnit4::class)
class WorkScreenTest {
    @get:Rule
    val compose = createComposeRule()

    private val ui = WorkUi(
        shift = ShiftEntityFixtures.bundled("s1"),
        last = LastScan(Verdict.DUPLICATE, "…1234567", firstSeenAt = "2026-09-10T07:42:00.000Z", at = "2026-09-10T08:00:00.000Z"),
        total = 1240, plan = 3000, thisTerminal = 312, errors = 4, duplicates = 2,
        feed = listOf(ScanEventEntity(1, "s1", "raw", "ok", "2026-09-10T08:00:00.000Z", null, "h")),
        sync = SyncState(pending = 37), reachable = false,
        team = TeamState(participants = emptyList(), acceptedUnits = 1240, at = 0L),
    )

    @Test
    fun rendersVerdictCountersBannerAndOverflowActions() {
        var closed = false
        compose.setContent { MarkiroTheme { WorkScreen(ui, WorkCallbacks(onClose = { closed = true })) } }
        val numbers = NumberFormat.getIntegerInstance()
        compose.onNodeWithText("ДУБЛЬ").assertIsDisplayed()
        compose.onNodeWithText("Первый скан в", substring = true).assertIsDisplayed()
        compose.onNodeWithText("${numbers.format(1240)} / ${numbers.format(3000)}").assertIsDisplayed()
        compose.onNodeWithText("312").assertIsDisplayed()
        compose.onNodeWithText("Ошибки 4 · Дубли 2").assertIsDisplayed()
        compose.onNodeWithText("Работаем офлайн · 37 сканов в очереди").assertIsDisplayed()
        compose.onNodeWithContentDescription("Ещё").performClick()
        compose.onNodeWithText("Закрыть смену").performClick()
        assertEquals(true, closed)
    }
}
