package app.markiro.handheld.core.grants

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.replacement.ReplacementDenied
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
class GrantDenialUiTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun replacementDenialUsesRussianNoticeAndCanBeDismissed() {
        val denial = GrantDenialUi()
        runBlocking { denial.guard { throw ReplacementDenied() } }
        compose.setContent { MarkiroTheme { denial.Dialog() } }
        compose.onNodeWithText("Новая работа недоступна").assertIsDisplayed()
        compose.onNodeWithText("ТСД находится в режиме замены. Новые задания и списания недоступны. Завершите текущую работу или обратитесь к администратору.").assertIsDisplayed()
        compose.onNodeWithText("ОК", ignoreCase = true).performClick()
        compose.runOnIdle { assertFalse(denial.isVisible.value) }
    }

    @Test
    @Config(qualifiers = "en")
    fun replacementDenialUsesEnglishNotice() {
        val denial = GrantDenialUi()
        runBlocking { denial.guard { throw ReplacementDenied() } }
        compose.setContent { MarkiroTheme { denial.Dialog() } }
        compose.onNodeWithText("New work unavailable").assertIsDisplayed()
        compose.onNodeWithText("This device is being replaced. New tasks and write-offs are unavailable. Finish existing work or contact an administrator.").assertIsDisplayed()
    }

    @Test
    fun cancellationIsNeverConvertedIntoDenial() = runBlocking {
        val denial = GrantDenialUi()
        val cancellation = CancellationException("cancel")
        try {
            denial.guard { throw cancellation }
            fail("Cancellation must propagate")
        } catch (caught: CancellationException) {
            assertSame(cancellation, caught)
        }
        assertFalse(denial.isVisible.value)
    }
}
