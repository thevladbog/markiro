package app.markiro.handheld.feature.hub

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.feature.shift.ShiftEntityFixtures
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.text.NumberFormat
import java.util.Locale

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "ru-w320dp-h640dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ActiveShiftCardTest {
    @get:Rule val compose = createComposeRule()
    private val progress = SemanticsMatcher.keyIsDefined(SemanticsProperties.ProgressBarRangeInfo)
    private val shift = ShiftEntityFixtures.bundled("s1").copy(number = "14", productPrintName = "Вода 0,5 л", plannedQty = 3000)

    private fun show(active: HubActiveShift, dark: Boolean = true) {
        compose.setContent {
            MarkiroTheme(dark = dark) {
                Box(Modifier.width(320.dp)) { ActiveShiftCard(active, onContinue = {}) }
            }
        }
    }

    @Test
    fun aKnownTotalShowsTheProductPlanAndPercentage() {
        show(HubActiveShift(shift, 1240, 0L))
        val format = NumberFormat.getIntegerInstance(Locale.forLanguageTag("ru"))
        compose.onNodeWithText("Смена 14 · Вода 0,5 л").assertIsDisplayed()
        compose.onNodeWithText("Линия 2 · валидация").assertIsDisplayed()
        compose.onNodeWithText("${format.format(1240)} / ${format.format(3000)}").assertIsDisplayed()
        compose.onNodeWithText("41 %").assertIsDisplayed()
        compose.onNodeWithText("данные на", substring = true).assertIsDisplayed()
        compose.onNodeWithText("На этом ТСД").assertDoesNotExist()
        compose.onNode(progress, useUnmergedTree = true).assert(SemanticsMatcher.expectValue(
            SemanticsProperties.ProgressBarRangeInfo, ProgressBarRangeInfo(1240f / 3000, 0f..1f),
        ))
    }

    @Test
    fun withoutAPlanItShowsTheLocalCountWithoutInventingAPercentage() {
        show(HubActiveShift(shift.copy(plannedQty = null, mode = "aggregation"), 12))
        compose.onNodeWithText("12").assertIsDisplayed()
        compose.onNodeWithText("Линия 2 · агрегация").assertIsDisplayed()
        compose.onNodeWithText("На этом ТСД").assertIsDisplayed()
        compose.onNode(progress, useUnmergedTree = true).assertDoesNotExist()
    }

    @Test
    fun aZeroPlanHasNoProgressBar() {
        show(HubActiveShift(shift.copy(plannedQty = 0), 0))
        compose.onNodeWithText("0").assertIsDisplayed()
        compose.onNode(progress, useUnmergedTree = true).assertDoesNotExist()
    }

    @Test
    fun exceedingThePlanKeepsTheRealCountAndClampsOnlyTheBar() {
        show(HubActiveShift(shift.copy(plannedQty = 100), 125))
        compose.onNodeWithText("125 / 100").assertIsDisplayed()
        compose.onNodeWithText("125 %").assertIsDisplayed()
        compose.onNode(progress, useUnmergedTree = true).assert(SemanticsMatcher.expectValue(
            SemanticsProperties.ProgressBarRangeInfo, ProgressBarRangeInfo(1f, 0f..1f),
        ))
    }

    @Test
    @Config(qualifiers = "en-w320dp-h640dp-mdpi")
    fun theLightEnglishCardUsesEnglishLabelsAndNumberGrouping() {
        show(HubActiveShift(shift.copy(productPrintName = "Water 0.5 L", lineName = "Line 2"), 1240), dark = false)
        compose.onNodeWithText("ACTIVE SHIFT").assertIsDisplayed()
        compose.onNodeWithText("Shift 14 · Water 0.5 L").assertIsDisplayed()
        compose.onNodeWithText("1,240 / 3,000").assertIsDisplayed()
        compose.onNodeWithText("On this handheld").assertIsDisplayed()
        compose.onNodeWithText("Continue").assertIsDisplayed()
    }

    @Test
    fun aLongProductNameWrapsWithoutClippingOnANarrowHandheld() {
        val name = "Вода питьевая негазированная в стеклянной бутылке 0,5 л"
        show(HubActiveShift(shift.copy(productPrintName = name), 0))
        val layouts = mutableListOf<TextLayoutResult>()
        compose.onNodeWithText("Смена 14 · $name", useUnmergedTree = true)
            .performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
        val result = layouts.single()
        assertTrue(result.lineCount > 1)
        assertEquals(result.layoutInput.text.length, result.getLineEnd(result.lineCount - 1, visibleEnd = true))
        assertTrue(result.getLineBottom(result.lineCount - 1) <= result.size.height)
        compose.onNodeWithText("Продолжить").assertIsDisplayed()
    }
}
