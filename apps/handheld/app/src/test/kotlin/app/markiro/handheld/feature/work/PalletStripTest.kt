package app.markiro.handheld.feature.work

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PalletStripTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun showsTheBoxCountAgainstThePalletsCapacity() {
        compose.setContent { MarkiroTheme { PalletStrip(boxCount = 3, capacity = 12) } }
        compose.onNodeWithText("3 / 12 коробов").assertIsDisplayed()
    }

    @Test
    fun anEmptyPalletStartsAtZero() {
        compose.setContent { MarkiroTheme { PalletStrip(boxCount = 0, capacity = 20) } }
        compose.onNodeWithText("0 / 20 коробов").assertIsDisplayed()
    }
}
