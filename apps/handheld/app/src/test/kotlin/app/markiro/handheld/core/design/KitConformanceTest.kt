package app.markiro.handheld.core.design

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode

@GraphicsMode(GraphicsMode.Mode.NATIVE)
@RunWith(AndroidJUnit4::class)
class KitConformanceTest {
    @get:Rule val compose = createComposeRule()

    @Test fun nativeControlsUseTheKitInDarkTheme() = verifyTheme(true)
    @Test fun nativeControlsUseTheKitInLightTheme() = verifyTheme(false)

    private fun verifyTheme(dark: Boolean) {
        compose.setContent {
            MarkiroTheme(dark) {
                val palette = MarkiroTheme.colors
                assertEquals("Primary controls use monochrome, leaving green for status", palette.fg1, MaterialTheme.colorScheme.primary)
                assertEquals(palette.surfacePage, MaterialTheme.colorScheme.onPrimary)
                assertEquals("Native menus use Kit surfaces", palette.surfaceCard, MaterialTheme.colorScheme.surfaceContainer)
                assertEquals(palette.surfaceCard, MaterialTheme.colorScheme.surfaceContainerHigh)
                assertEquals(palette.lineControl, MaterialTheme.colorScheme.outline)
                val border = palette.lineControl.luminance()
                val surface = palette.surfaceCard.luminance()
                assertTrue("Field boundaries need 3:1 contrast", (maxOf(border, surface) + 0.05f) / (minOf(border, surface) + 0.05f) >= 3f)
                assertEquals("Native fields use the bundled typeface", PlexSans, MaterialTheme.typography.bodyLarge.fontFamily)
                assertEquals(PlexSans, MaterialTheme.typography.labelLarge.fontFamily)
            }
        }
    }

    @Test fun longPrimaryActionGrowsAtLargeFontInsteadOfClipping() {
        val label = "Подтвердить закрытие своей части смены"
        compose.setContent {
            MarkiroTheme {
                CompositionLocalProvider(LocalDensity provides Density(1f, fontScale = 2f)) {
                    Box(Modifier.width(280.dp)) { PrimaryButton(label, {}) }
                }
            }
        }
        val action = compose.onNodeWithText(label).assertIsDisplayed()
        val layouts = mutableListOf<TextLayoutResult>()
        action.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
        assertEquals(1, layouts.size)
        assertFalse("The whole action label must remain readable", layouts.single().hasVisualOverflow)
    }
}
