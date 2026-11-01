package app.markiro.handheld.feature.printer

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.print.CachedLabelTemplate
import app.markiro.handheld.core.print.PrintPurpose
import app.markiro.handheld.core.print.PrinterEntity
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "ru-w320dp-h568dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class PrinterTemplateScreenTest {
    @get:Rule val compose = createComposeRule()
    private val printer = PrinterEntity("p", "TSC TE200", "wifi", "printer:9100", "zpl", 203, false, null, null)
    private val template = CachedLabelTemplate("box", "box", "Коробка 100×100",
        """{"widthMm":100,"heightMm":100,"dpi":203,"language":"zpl","elements":[]}""")

    @Test fun cloudCatalogueCanRefreshThroughTheReprintCatalog() {
        var refreshes = 0
        compose.setContent { MarkiroTheme {
            PrinterTemplateChooserScreen(printer, PrintPurpose.BOX, PrinterTemplatesUi(loading = false),
                onBack = {}, onSave = { _, _ -> }, onRefresh = { refreshes++ })
        } }
        compose.onNodeWithText("Обновить шаблоны").performScrollTo().performClick()
        assertEquals(1, refreshes)
        compose.onNodeWithText("Каталог перепечати", substring = true).assertIsDisplayed()
    }

    @Test fun selectingRequiresPreviewAndAnExplicitSaveAndFiltersOtherPurposes() {
        val saved = mutableListOf<String?>()
        compose.setContent { MarkiroTheme {
            PrinterTemplateChooserScreen(printer, PrintPurpose.BOX,
                PrinterTemplatesUi(catalog = listOf(template, template.copy(id = "pallet", purpose = "pallet", name = "Палет")), loading = false),
                onBack = {}, onSave = { id, _ -> saved += id }, onRefresh = {})
        } }
        compose.onNodeWithText("Палет").assertDoesNotExist()
        compose.onNodeWithText("Коробка 100×100").performClick()
        assertEquals(emptyList<String?>(), saved)
        compose.onNodeWithText("Далее").performScrollTo().performClick()
        compose.onNodeWithText("Проверить шаблон").assertIsDisplayed()
        assertEquals(emptyList<String?>(), saved)
        compose.onNodeWithText("Назначить шаблон").performScrollTo().performClick()
        assertEquals(listOf("box"), saved)
    }

    @Test fun offlineEmptyCatalogKeepsTheSourceChoiceUsable() {
        var saved = false
        compose.setContent { MarkiroTheme {
            PrinterTemplateChooserScreen(printer, PrintPurpose.BOX, PrinterTemplatesUi(loading = false, refreshFailed = true),
                onBack = {}, onSave = { id, _ -> assertEquals(null, id); saved = true }, onRefresh = {})
        } }
        compose.onNodeWithText("Другие шаблоны не загружены").assertIsDisplayed()
        compose.onNodeWithText("Назначить шаблон").performScrollTo().performClick()
        assertEquals(true, saved)
    }
}
