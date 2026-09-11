package app.markiro.handheld.feature.exceptions

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.R
import app.markiro.handheld.core.design.MarkiroTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ExceptionsScreenTest {
    @get:Rule
    val compose = createComposeRule()

    private val target = UndoTarget(codeTail = "7XQ4K2", scannedAt = "10:42:17", codeHash = "a".repeat(64))

    private fun ui(
        canUndo: Boolean = false,
        undoTarget: UndoTarget? = null,
        openBoxId: String? = null,
        openBoxOrdinal: Int = 27,
        openBoxCount: Int = 0,
        reprintableCount: Int = 0,
        step: ExceptionsStep = ExceptionsStep.List,
    ) = ExceptionsUi(canUndo, undoTarget, openBoxId, openBoxOrdinal, openBoxCount, reprintableCount, step)

    private fun render(state: ExceptionsUi, cb: ExceptionsCallbacks = ExceptionsCallbacks()) {
        compose.setContent { MarkiroTheme { ExceptionsScreen(state, cb) } }
    }

    /** A greyed-out row with no explanation is the failure mode this pins. */
    @Test
    fun anUnavailableActionSaysWhyInsteadOfGoingQuiet() {
        render(ui())
        // Clear and undo both need the open box, and each row states its own
        // reason: a row that explains itself does not depend on reading another.
        compose.onAllNodesWithText("Короб не открыт").assertCountEquals(2)
        compose.onAllNodesWithText("В этой смене нет закрытых коробов").assertCountEquals(2)
        compose.onNode(hasText("Очистить короб")).assertIsNotEnabled()
        compose.onNode(hasText("Расформировать короб")).assertIsNotEnabled()
    }

    @Test
    fun anOpenBoxWithoutScansExplainsWhyUndoIsOff() {
        render(ui(openBoxId = "box-1", openBoxCount = 0))
        compose.onNodeWithText("Отменять нечего: в коробе нет сканов").assertIsDisplayed()
        compose.onNode(hasText("Отменить последний скан")).assertIsNotEnabled()
    }

    @Test
    fun theListNamesTheUndoTargetAndOffersTheFourActions() {
        var undo = false
        render(
            ui(canUndo = true, undoTarget = target, openBoxId = "box-1", openBoxCount = 12, reprintableCount = 3),
            ExceptionsCallbacks(onUndo = { undo = true }),
        )
        compose.onNodeWithText("Последний скан: 7XQ4K2 в 10:42:17").assertIsDisplayed()
        compose.onNodeWithText("Расформировать короб").assertIsDisplayed()
        compose.onNodeWithText("Очистить короб").assertIsDisplayed()
        compose.onNodeWithText("Перепечатать этикетку").assertIsDisplayed()
        compose.onNodeWithText("Отменить последний скан").performClick()
        assertEquals(true, undo)
    }

    @Test
    fun theUndoConfirmationNamesTheUnitAndItsTime() {
        render(ui(canUndo = true, undoTarget = target, openBoxId = "box-1", openBoxCount = 12, step = ExceptionsStep.ConfirmUndo))
        compose.onNodeWithText("Отменить последний скан?").assertIsDisplayed()
        compose.onNode(hasText("7XQ4K2", substring = true)).assertIsDisplayed()
        compose.onNode(hasText("10:42:17", substring = true)).assertIsDisplayed()
    }

    @Test
    fun theClearConfirmationNamesTheBoxAndItsCount() {
        render(ui(openBoxId = "box-1", openBoxCount = 12, step = ExceptionsStep.ConfirmClear))
        compose.onNodeWithText("Очистить короб?").assertIsDisplayed()
        compose.onNode(hasText("12", substring = true)).assertIsDisplayed()
    }

    @Test
    fun aRefusalIsShownInWords() {
        render(ui(step = ExceptionsStep.Refused(R.string.exceptions_undo_stale)))
        compose.onNode(hasText("Появился новый скан", substring = true)).assertIsDisplayed()
    }
}
