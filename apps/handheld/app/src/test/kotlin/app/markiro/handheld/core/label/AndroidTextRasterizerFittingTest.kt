package app.markiro.handheld.core.label

import android.graphics.Paint
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AndroidTextRasterizerFittingTest {
    private val rasterizer = AndroidTextRasterizer()

    @Test
    fun minimumFontDoesNotShrinkOrRejectMultilineWrapping() = runTest {
        val text = "Очень длинное наименование продукции"
        val options = RasterOptions("sans-serif", 20, false, 80, 4)
        assertTrue(Paint().apply { textSize = 18f }.measureText(text) > 80)
        val wrapped = rasterizer.rasterize(text, options)
        val fitted = rasterizer.rasterize(text, options.copy(minFontSizePx = 18))
        assertEquals(wrapped, fitted)
        assertTrue(fitted.height > 30)
        assertTrue(fitted.width <= 80)
    }

    @Test
    fun singleLineStillRejectsOverflowAtMinimumFont() = runTest {
        try {
            rasterizer.rasterize("999999", RasterOptions("sans-serif", 20, false, 1, 1, minFontSizePx = 18))
            fail("Expected minimum-font overflow")
        } catch (expected: LabelRenderException) {
            assertTrue(expected.message.orEmpty().contains("minimum font size"))
        }
    }
}
