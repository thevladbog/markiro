package app.markiro.handheld.feature.settings

import android.content.Context
import androidx.compose.material3.Text
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroColors
import app.markiro.handheld.core.design.MarkiroTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AppPreferencesTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun changingSavedThemeRecolorsTheExistingCompositionImmediately() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        context.getSharedPreferences("app", Context.MODE_PRIVATE).edit().clear().commit()
        val preferences = AppPreferences(context)
        compose.setContent {
            MarkiroTheme(dark = preferences.theme == ThemeMode.DARK) {
                Text(if (MarkiroTheme.colors.surfacePage == MarkiroColors.Light.surfacePage) "light" else "dark")
            }
        }
        compose.onNodeWithText("dark").assertIsDisplayed()
        compose.runOnIdle { preferences.theme = ThemeMode.LIGHT }
        compose.onNodeWithText("light").assertIsDisplayed()
        assertEquals(ThemeMode.LIGHT, AppPreferences(context).theme)
        compose.runOnIdle { preferences.theme = ThemeMode.DARK }
        compose.onNodeWithText("dark").assertIsDisplayed()
    }
}
