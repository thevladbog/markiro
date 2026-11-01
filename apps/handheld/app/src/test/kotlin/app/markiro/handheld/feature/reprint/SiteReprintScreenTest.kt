package app.markiro.handheld.feature.reprint

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.ComponentActivity
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.unit.Density
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.text.TextLayoutResult
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.reprint.SiteReprintResult
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "ru-w360dp-h640dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SiteReprintScreenTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private fun show(state: SiteReprintUi, callbacks: SiteReprintCallbacks = SiteReprintCallbacks(), large: Boolean = false) {
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, if (large) 1.5f else 1f)) {
                MarkiroTheme(dark = true) { SiteReprintScreen(state, callbacks) }
            }
        }
    }
    private fun capture(name: String, width: Int = 360) {
        compose.waitForIdle()
        val bitmap = compose.runOnIdle { val view = compose.activity.window.decorView; Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888).also { view.draw(Canvas(it)) } }
        assertEquals(width, bitmap.width)
        val folder = File("build/site-reprint-visuals").also { it.mkdirs() }
        File(folder, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
    @Test fun reasonIsRequiredAndGearUsesTheSettingsCallback() {
        var settings = 0; var selected: String? = null
        show(SiteReprintUi(step = SiteReprintStep.REASON), SiteReprintCallbacks(onSettings = { settings++ }, onReason = { selected = it }))
        compose.onNodeWithText("Далее к сканированию").assertIsNotEnabled()
        compose.onNodeWithText("Повреждена").performClick(); assertEquals("damaged", selected)
        compose.onNodeWithContentDescription("Принтеры и шаблоны").performClick(); assertEquals(1, settings)
        capture("ru-reason")
    }
    @Test fun knownSuccessIsInlineAndAutomaticallyReadyWithoutAnotherAction() {
        show(SiteReprintUi(step = SiteReprintStep.SCAN, reason = "damaged", result = SiteReprintResult.Printed("job", "Вода питьевая")))
        compose.onNodeWithText("Сканируйте этикетку").assertIsDisplayed()
        compose.onNodeWithText("Напечатано").assertIsDisplayed()
        compose.onNodeWithText("Следующая этикетка").assertDoesNotExist()
        compose.onNodeWithText("Ввести код вручную", useUnmergedTree = true).assertIsDisplayed()
        capture("ru-success-ready")
    }
    @Test fun manualInputHasOneFindAndPrintAction() {
        var submitted = ""
        show(SiteReprintUi(step = SiteReprintStep.MANUAL, reason = "lost"), SiteReprintCallbacks(onSubmit = { submitted = it }))
        compose.onNodeWithText("Полный код маркировки или SSCC").performTextInput("046800899000000017")
        compose.onNodeWithText("Найти и напечатать", useUnmergedTree = true).performScrollTo().performClick()
        assertEquals("046800899000000017", submitted)
        capture("ru-manual")
    }
    @Test fun unknownRequiresExplicitRetryOrVerificationAndCannotBeCancelled() {
        show(SiteReprintUi(step = SiteReprintStep.SCAN, reason = "lost", result = SiteReprintResult.Unknown("job", "Вода"), pendingJobId = "job"))
        compose.onNodeWithText("Проверить этикетку", useUnmergedTree = true).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Напечатать ещё раз", useUnmergedTree = true).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Отменить задание").assertDoesNotExist()
        capture("ru-unknown")
    }
    @Test @Config(qualifiers = "ru-w320dp-h568dp-mdpi") fun largeTextReasonAndActionsRemainReachableAt320dp() {
        show(SiteReprintUi(step = SiteReprintStep.REASON, reason = "damaged"), large = true)
        val explanation = compose.onNodeWithText("Выберите один раз для всех следующих этикеток.").performScrollTo()
        val layouts = mutableListOf<TextLayoutResult>()
        explanation.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
        assertFalse(layouts.single().hasVisualOverflow)
        compose.onNodeWithText("Далее к сканированию", useUnmergedTree = true).performScrollTo().assertIsDisplayed()
        capture("ru-reason-320-large", 320)
    }
    @Test @Config(qualifiers = "en-w360dp-h640dp-mdpi") fun englishReadyStateKeepsManualActionReachable() {
        show(SiteReprintUi(step = SiteReprintStep.SCAN, reason = "damaged"))
        compose.onNodeWithText("Scan a label").assertIsDisplayed()
        compose.onNodeWithText("Enter code manually", useUnmergedTree = true).performScrollTo().assertIsDisplayed()
        capture("en-ready")
    }
}
