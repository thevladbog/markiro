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
    private val rasterizer = AndroidTextRasterizer(androidx.test.core.app.ApplicationProvider.getApplicationContext())

    @Test fun labelTextUsesBundledPlexMetricsInsteadOfTheSystemFont() = runTest {
        val context = androidx.test.core.app.ApplicationProvider.getApplicationContext<android.content.Context>()
        val text = "ДИКИЙ КРЕСТ 0123456789"
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            textSize = 32f
            typeface = context.resources.getFont(app.markiro.handheld.R.font.plex_sans_regular)
        }
        val raster = rasterizer.rasterize(text, RasterOptions("sans-serif", 32, false, null, 1))
        assertEquals(kotlin.math.ceil(paint.measureText(text).toDouble()).toInt(), raster.width)
    }

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
