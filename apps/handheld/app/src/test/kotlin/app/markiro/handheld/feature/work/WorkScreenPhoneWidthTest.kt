package app.markiro.handheld.feature.work

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.design.PlexMono
import app.markiro.handheld.core.km.feedTail
import app.markiro.handheld.core.storage.ScanEventEntity
import app.markiro.handheld.core.sync.SyncState
import app.markiro.handheld.feature.shift.ShiftEntityFixtures
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.text.NumberFormat

/**
 * The work screen at the width of a typical phone, 411 dp.
 *
 * Both defects were found on a phone, not on the ТСД: four counters shared the
 * row equally and broke «Всего» in two, and the feed spread its row with
 * SpaceBetween, so a shorter verdict word moved the code.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "ru-w411dp-h914dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class WorkScreenPhoneWidthTest {
    @get:Rule
    val compose = createComposeRule()

    private val accepted = "010460068200001321AAAA0000000001\u001d93XyZw"
    private val duplicate = "010460068200001321AAAA0000000002\u001d93XyZw"
    private val at = "2026-10-20T08:14:00.000Z"

    private val ui = WorkUi(
        shift = ShiftEntityFixtures.bundled("s1"),
        total = 1427, plan = 6000, thisTerminal = 1427, errors = 3, duplicates = 12,
        feed = listOf(
            ScanEventEntity(3, "s1", accepted, "ok", at, null, "a"),
            ScanEventEntity(2, "s1", duplicate, "duplicate", at, null, "b"),
            ScanEventEntity(1, "s1", accepted, "ok", at, null, "c"),
        ),
        sync = SyncState(pending = 0), reachable = true, last = null, team = null,
    )

    private fun SemanticsNodeInteraction.layout(): TextLayoutResult {
        val layouts = mutableListOf<TextLayoutResult>()
        performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
        return layouts.single()
    }

    private fun countersStayOnOneLine(labels: List<String>) {
        compose.setContent { MarkiroTheme { WorkScreen(ui, WorkCallbacks()) } }
        val numbers = NumberFormat.getIntegerInstance()
        val total = compose.onNodeWithText("${numbers.format(1427)} / ${numbers.format(6000)}", useUnmergedTree = true).layout()
        assertEquals(1, total.lineCount)
        assertEquals("Numeric counters use the Kit's mono face", PlexMono, total.layoutInput.style.fontFamily)
        // The other three still fit beside it rather than being squeezed out.
        labels.forEach { label ->
            assertEquals(label, 1, compose.onNodeWithText(label, useUnmergedTree = true).layout().lineCount)
        }
    }

    @Test
    fun theTotalAgainstThePlanStaysOnOneLine() = countersStayOnOneLine(listOf("Всего", "Этот ТСД", "Ошибки", "Дубли"))

    @Test
    @Config(qualifiers = "ru-w320dp-h520dp-mdpi")
    fun statusAndCounterLabelsStayReadableWithLargeText() {
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(1f, fontScale = 1.5f)) {
                MarkiroTheme { WorkScreen(ui, WorkCallbacks()) }
            }
        }
        compose.onNodeWithContentDescription("Связь и очередь").performClick()
        for (label in listOf("Принтер", "Сканер")) {
            val node = compose.onNodeWithText(label).assertIsDisplayed()
            assertEquals("$label must not be squeezed into narrow fragments", 1, node.layout().lineCount)
        }
        compose.onNodeWithText("Готово").performClick()
        for (label in listOf("Всего", "Этот ТСД", "Ошибки", "Дубли")) {
            val node = compose.onNodeWithText(label).performScrollTo().assertIsDisplayed()
            assertEquals("$label must not be squeezed into narrow fragments", 1, node.layout().lineCount)
        }
        val waiting = compose.onNodeWithText("Ожидание скана…").performScrollTo().assertIsDisplayed().layout()
        assertEquals("Scan result: size=${waiting.size}, widthOverflow=${waiting.didOverflowWidth}, heightOverflow=${waiting.didOverflowHeight}, lines=${waiting.lineCount}, bottom=${waiting.getLineBottom(waiting.lineCount - 1)}, constraints=${waiting.layoutInput.constraints}", false,
            waiting.hasVisualOverflow)
    }

    @Test
    @Config(qualifiers = "en-w411dp-h914dp-mdpi")
    fun englishCountersStayOnOneLine() = countersStayOnOneLine(listOf("Total", "This handheld", "Errors", "Duplicates"))

    @Test
    fun everyFeedRowStartsItsCodeAtTheSameColumn() {
        compose.setContent { MarkiroTheme { WorkScreen(ui, WorkCallbacks()) } }
        val acceptedLeft = compose.onAllNodesWithTextLeft(feedTail(accepted))
        val duplicateLeft = compose.onAllNodesWithTextLeft(feedTail(duplicate)).single()
        assertEquals(2, acceptedLeft.size)
        acceptedLeft.forEach { assertEquals(it, duplicateLeft, 0.5f) }
    }

    private fun androidx.compose.ui.test.junit4.ComposeContentTestRule.onAllNodesWithTextLeft(text: String): List<Float> =
        onAllNodes(androidx.compose.ui.test.hasText(text), useUnmergedTree = true)
            .fetchSemanticsNodes().map { it.boundsInRoot.left }
}
