package app.markiro.handheld.feature.shift

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class CloseScreensTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun reasonStepListsTheSixReasonsAndSubmits() {
        var picked: String? = null
        var submitted = false
        compose.setContent {
            MarkiroTheme {
                CloseScreen(
                    CloseStep.Reason(ShiftCloser.Preview(8, 1, 0, 10, reasonRequired = true, alreadyClosed = false), selected = "equipment_stop"),
                    CloseCallbacks(onSelectReason = { picked = it }, onSubmitReason = { submitted = true }),
                )
            }
        }
        compose.onNodeWithText("Почему план не выполнен?").assertIsDisplayed()
        compose.onNodeWithText("Нехватка сырья или материалов").performClick()
        assertEquals("material_shortage", picked)
        compose.onNodeWithText("Закрыть").performClick()
        assertEquals(true, submitted)
    }

    @Test
    fun summaryShowsTheConflictNote() {
        compose.setContent {
            MarkiroTheme { CloseScreen(CloseStep.Summary(8, 1, 0, 2, CloseOutcome.CONFLICT), CloseCallbacks()) }
        }
        compose.onNodeWithText("Смену закроет кабинет: работало несколько устройств").assertIsDisplayed()
        compose.onNodeWithText("В хаб").assertIsDisplayed()
    }
}
