package app.markiro.handheld.feature.writeoff

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.storage.WriteoffReasonEntity
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The confirmation is the last thing an operator reads before an act that cannot
 * be undone from the terminal, so its summary has to be legible on the narrow
 * screen of a real handheld rather than on a desktop preview.
 */
@RunWith(AndroidJUnit4::class)
class WriteoffConfirmScreenTest {
    @get:Rule
    val compose = createComposeRule()

    private fun confirm(state: WriteoffUi) {
        compose.setContent {
            MarkiroTheme {
                // A Honeywell handheld is about this wide; the defects this test
                // guards are invisible at desktop width.
                Box(Modifier.requiredSize(320.dp, 640.dp)) {
                    WriteoffRoute(
                        state,
                        onBack = {}, onHistory = {}, onRemove = {}, onNext = {}, onSelectReason = {},
                        onToConfirm = {}, onConfirm = {}, onStepBack = {}, onAnother = {}, onDismissDiscard = {},
                    )
                }
            }
        }
    }

    private fun state(operator: String) = WriteoffUi(
        step = WriteoffStep.CONFIRM,
        unitCount = 3,
        boxCount = 0,
        selectedReason = WriteoffReasonEntity("r-1", "Маркетинг", 0),
        operatorName = operator,
    )

    /**
     * The label already names the noun. Taking the value from the plural made the
     * row read «Коробов — коробов 0» on a real terminal.
     */
    @Test
    fun theBoxCountDoesNotRepeatTheNounItsLabelAlreadyCarries() {
        confirm(state("Иванова Анна"))
        compose.onNodeWithText("Коробов").assertIsDisplayed()
        compose.onNodeWithText("0").assertIsDisplayed()
        compose.onNodeWithText("коробов 0").assertDoesNotExist()
        compose.onNodeWithText("3").assertIsDisplayed()
        compose.onNodeWithText("3 шт", substring = false).assertDoesNotExist()
    }

    /**
     * A full Russian name is longer than the row can spare. Laid out flush against
     * its label, with its wrapped lines ragged on the right, it read on a real
     * terminal as the name sitting on top of «Оператор».
     */
    @Test
    fun aLongOperatorNameKeepsAGapFromItsLabelAndStaysInTheValueColumn() {
        confirm(state("Богатырев Владислав Сергеевич"))
        val label = compose.onNodeWithText("Оператор").getUnclippedBoundsInRoot()
        val value = compose.onNodeWithText("Богатырев Владислав Сергеевич").getUnclippedBoundsInRoot()
        assertTrue(
            "the value must keep a gap from its label: label ends at ${label.right}, value starts at ${value.left}",
            value.left - label.right >= 8.dp,
        )
        // Anchored to the same right edge as every other value, which is what the
        // eye reads as a column. `ScreenColumn` insets the content by sp4 (16 dp).
        assertTrue("the value must end at the content's right edge, not before: ${value.right}", value.right >= 300.dp)
        assertTrue("the value must not run off screen: ${value.right}", value.right <= 320.dp)
    }
}
