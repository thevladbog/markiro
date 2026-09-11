package app.markiro.handheld.feature.work

import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.duplicate.DuplicateReason
import app.markiro.handheld.core.duplicate.ReprintReason
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class DuplicateScreensTest {
    @get:Rule
    val compose = createComposeRule()

    private fun show(step: DuplicateStep, cb: DuplicateCallbacks = DuplicateCallbacks()) {
        compose.setContent { MarkiroTheme { DuplicateScreen(step, cb) } }
    }

    /** `setContent` may only be called once per test, so a driven state replaces a second call. */
    private fun driven(initial: DuplicateStep): MutableState<DuplicateStep> {
        val state = mutableStateOf(initial)
        compose.setContent { MarkiroTheme { DuplicateScreen(state.value, DuplicateCallbacks()) } }
        return state
    }

    @Test
    fun aFailureNamesThePrintersOwnReasonAndOffersAnotherTry() {
        show(DuplicateStep.Failed("j1", DuplicateReason.NO_PAPER))
        compose.onNodeWithText("Дубликат не напечатан").assertIsDisplayed()
        compose.onNodeWithText("Нет бумаги").assertIsDisplayed()
        compose.onNodeWithText("Повторить печать").assertIsDisplayed()
    }

    /**
     * The scan leads, not the reprint. Under a `none` policy this is the only
     * place a verification scan is ever offered, so the screen has to say what
     * the trigger pull will do.
     */
    @Test
    fun anUnknownDeliveryLeadsWithTheScan() {
        show(DuplicateStep.Unknown("j1", "transport_failed"))
        compose.onNodeWithText("Неизвестно, вышел ли дубликат").assertIsDisplayed()
        compose.onNodeWithText(
            "Посмотрите на принтер. Если этикетка вышла — отсканируйте её, и единица будет закрыта.",
        ).assertIsDisplayed()
    }

    /** An unknown delivery is not a failure: nothing offers to «повторить печать» blindly. */
    @Test
    fun anUnknownDeliveryDoesNotOfferABlindResend() {
        show(DuplicateStep.Unknown("j1", "transport_failed"))
        compose.onNodeWithText("Повторить печать").assertDoesNotExist()
    }

    @Test
    fun aMismatchAndAnUnreadableCodeReadDifferently() {
        val state = driven(DuplicateStep.Rejected("j1", mismatch = true))
        compose.onNodeWithText("Это код другой единицы. Отсканируйте наклейку, которая только что вышла.").assertIsDisplayed()

        state.value = DuplicateStep.Rejected("j1", mismatch = false)
        compose.onNodeWithText("Код не читается. Попробуйте ещё раз или перепечатайте.").assertIsDisplayed()
    }

    @Test
    fun everyStateOffersTheThreeReprintReasons() {
        val state = driven(DuplicateStep.Failed("j1", DuplicateReason.NO_PAPER))
        for (step in listOf(
            DuplicateStep.Failed("j1", DuplicateReason.NO_PAPER),
            DuplicateStep.Unknown("j1", "transport_failed"),
            DuplicateStep.Rejected("j1", mismatch = true),
        )) {
            state.value = step
            compose.onNodeWithText("Перепечатать: не напечаталась").assertIsDisplayed()
            compose.onNodeWithText("Перепечатать: испорчена").assertIsDisplayed()
            compose.onNodeWithText("Перепечатать: потеряна").assertIsDisplayed()
        }
    }

    @Test
    fun eachReprintReasonReportsItself() {
        val reasons = mutableListOf<String>()
        show(DuplicateStep.Failed("j1", DuplicateReason.NO_PAPER), DuplicateCallbacks(onReprint = { reasons += it }))
        compose.onNodeWithText("Перепечатать: не напечаталась").performClick()
        compose.onNodeWithText("Перепечатать: испорчена").performClick()
        compose.onNodeWithText("Перепечатать: потеряна").performClick()
        assertEquals(listOf(ReprintReason.NOT_PRINTED, ReprintReason.DAMAGED, ReprintReason.LOST), reasons)
    }

    /** Every refusal the engine can produce has a name; none reaches the screen as a code. */
    @Test
    fun everyRefusalHasItsOwnWords() {
        val named = listOf(
            DuplicateReason.PRINTER_UNCONFIGURED,
            DuplicateReason.PRINTER_CHANGED,
            DuplicateReason.TEMPLATE_MISSING,
            DuplicateReason.TEMPLATE_INVALID,
            DuplicateReason.RENDER_FAILED,
            DuplicateReason.CODE_INCOMPLETE,
            DuplicateReason.BYTES_GONE,
            DuplicateReason.ATTEMPT_IN_FLIGHT,
            DuplicateReason.NO_PAPER,
            DuplicateReason.HEAD_OPEN,
            DuplicateReason.UNREACHABLE,
            DuplicateReason.TRANSPORT_FAILED,
        )
        val generic = duplicateReasonLabel("something nobody wrote")
        for (reason in named) {
            assertEquals("$reason falls through to the generic label", false, duplicateReasonLabel(reason) == generic)
        }
    }
}
