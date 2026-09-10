package app.markiro.handheld.feature.work

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.storage.ConflictEntity
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ConflictsScreenTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun listsConflictsWithTerminalTailAndTime() {
        compose.setContent {
            MarkiroTheme {
                ConflictsScreen(
                    listOf(ConflictEntity("abcdef0123456789", "8f3c2a1b-terminal-dev2", "2026-09-10T06:12:00.000Z", "2026-09-10T07:00:00.000Z")),
                    onBack = {},
                )
            }
        }
        compose.onNodeWithText("…23456789 · терминал …l-dev2", substring = true).assertIsDisplayed()
        compose.onNodeWithText("Разбор — в кабинете", substring = true).assertIsDisplayed()
    }

    @Test
    fun emptyState() {
        compose.setContent { MarkiroTheme { ConflictsScreen(emptyList(), onBack = {}) } }
        compose.onNodeWithText("Конфликтов нет").assertIsDisplayed()
    }
}
