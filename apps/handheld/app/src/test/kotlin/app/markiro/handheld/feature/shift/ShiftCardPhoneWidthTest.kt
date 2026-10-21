package app.markiro.handheld.feature.shift

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * A shift card with every chip, at the width of a typical phone, 411 dp.
 *
 * The number and four chips shared one row: «+ паллеты» broke in two, the
 * number dropped, and the status chip of the running shift was pushed past the
 * card's edge, so the one shift the operator was looking for read as idle.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ShiftCardPhoneWidthTest {
    @get:Rule
    val compose = createComposeRule()

    private val card = ShiftCard(
        id = "s14", number = "ОКТ26-014", product = "Сидр яблочный сухой 0,75", plan = 6000,
        aggregation = true, pallets = true, lineName = "Линия розлива 2", tolling = null,
        active = true, enabled = true, disabledReason = null,
    )

    private fun SemanticsNodeInteraction.layout(): TextLayoutResult {
        val layouts = mutableListOf<TextLayoutResult>()
        performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
        return layouts.single()
    }

    private fun everyChipFitsInsideTheCard(number: String, chips: List<String>) {
        compose.setContent { MarkiroTheme { ShiftCardView(card, onClick = {}) } }
        val right = compose.onRoot().fetchSemanticsNode().boundsInRoot.right
        (chips + number).forEach { text ->
            val node = compose.onNodeWithText(text, useUnmergedTree = true)
            val layout = node.layout()
            assertEquals(text, 1, layout.lineCount)
            val bounds = node.fetchSemanticsNode().boundsInRoot
            assertTrue("$text ends at ${bounds.right}, past the card at $right", bounds.right <= right)
            assertTrue("$text was squeezed to ${bounds.width}", bounds.width >= layout.size.width)
        }
    }

    @Test
    @Config(qualifiers = "ru-w411dp-h914dp-mdpi")
    fun russianChipsFitAtPhoneWidth() =
        everyChipFitsInsideTheCard("ОКТ26-014", listOf("валидация", "+ агрегация", "+ паллеты", "идёт"))

    @Test
    @Config(qualifiers = "en-w411dp-h914dp-mdpi")
    fun englishChipsFitAtPhoneWidth() =
        everyChipFitsInsideTheCard("ОКТ26-014", listOf("validation", "+ aggregation", "+ pallets", "active"))
}
