package app.markiro.handheld

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "ru-w360dp-h640dp-mdpi")
class DatasetResetScreenTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun durableResetOffersActualProcessCloseOnAHandheldScreen() {
        compose.setContent { MarkiroTheme { DatasetResetScreen(ready = true, failed = false, retry = {}) } }
        compose.onNodeWithText("Данные хоста заменены").assertIsDisplayed()
        compose.onNodeWithText("Закрыть приложение").assertIsDisplayed()
        compose.onNodeWithText("Повторить").assertDoesNotExist()
    }

    @Test fun failedUndurableIntentOffersRetryAndCannotCloseTheProcess() {
        var attempts = 0
        compose.setContent { MarkiroTheme { DatasetResetScreen(ready = false, failed = true, retry = { attempts++ }) } }
        compose.onNodeWithText("Закрыть приложение").assertDoesNotExist()
        compose.onNodeWithText("Повторить").assertIsDisplayed().performClick()
        assertEquals(1, attempts)
    }

    @Test fun failedStartupPurgeShowsRetryAndTheDurableCloseOption() {
        compose.setContent { MarkiroTheme { DatasetResetScreen(ready = true, failed = true, retry = {}) } }
        compose.onNodeWithText("Повторить").assertIsDisplayed()
        compose.onNodeWithText("Закрыть приложение").assertIsDisplayed()
    }

    @Test @Config(qualifiers = "en-w360dp-h640dp-mdpi")
    fun englishResetHasTheSameCloseAction() {
        compose.setContent { MarkiroTheme { DatasetResetScreen(ready = true, failed = false, retry = {}) } }
        compose.onNodeWithText("Host data was replaced").assertIsDisplayed()
        compose.onNodeWithText("Close application").assertIsDisplayed()
    }
}
