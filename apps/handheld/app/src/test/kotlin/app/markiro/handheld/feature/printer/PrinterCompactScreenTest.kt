package app.markiro.handheld.feature.printer

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.print.PrintPurpose
import app.markiro.handheld.core.print.PrinterAssignmentEntity
import app.markiro.handheld.core.print.PrinterEntity
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "ru-w360dp-h640dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class PrinterCompactScreenTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val profiles = listOf(
        PrinterEntity("box", "Zebra ZD421 · Этикетки коробов линии розлива № 2", "wifi", "192.168.1.40:9100", "zpl", 203, false, null, null),
        PrinterEntity("duplicate", "TSC Alpha · Дубли кодов на упаковке", "bluetooth", "AA:BB:CC:DD:EE:FF", "tspl", 300, false, null, null),
        PrinterEntity("pallet", "Zebra ZT411 · Паллетизатор склада готовой продукции", "wifi", "192.168.1.42:9100", "zpl", 203, false, null, null),
    )
    private val state = PrinterUi(printers = profiles, assignments = PrintPurpose.entries.map { PrinterAssignmentEntity(it.wire, it.wire) })
    private fun capture(name: String) {
        compose.waitForIdle()
        // Robolectric does not drive PixelCopy's window-redraw callback. Drawing the actual
        // laid-out decor view onto a native Canvas captures the same Compose nodes directly.
        val bitmap = compose.runOnIdle {
            val view = compose.activity.window.decorView
            Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888).also { view.draw(Canvas(it)) }
        }
        assertEquals(360, bitmap.width)
        File("build/printer-visuals").mkdirs()
        File("build/printer-visuals/$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
    private fun list(dark: Boolean, name: String, purposes: String, add: String) {
        compose.setContent { MarkiroTheme(dark = dark) { PrinterListScreen(state, PrinterListCallbacks()) } }
        compose.onNodeWithText(purposes).assertIsDisplayed()
        compose.onNodeWithText(add).assertIsDisplayed()
        capture(name)
        compose.onNodeWithText(profiles.last().name).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(purposes).assertIsDisplayed()
        compose.onNodeWithText(add).assertIsDisplayed()
    }
    @Test fun russianDarkListKeepsActionsVisibleWithLongNames() = list(true, "ru-dark-list", "Назначения", "Добавить по адресу")
    @Test fun russianLightListKeepsActionsVisibleWithLongNames() = list(false, "ru-light-list", "Назначения", "Добавить по адресу")
    @Test @Config(qualifiers = "en-w360dp-h640dp-mdpi")
    fun englishDarkListKeepsActionsVisibleWithLongNames() = list(true, "en-dark-list", "Label purposes", "Add by address")
    @Test @Config(qualifiers = "en-w360dp-h640dp-mdpi")
    fun englishLightListKeepsActionsVisibleWithLongNames() = list(false, "en-light-list", "Label purposes", "Add by address")

    private fun assignments(dark: Boolean, name: String, pallet: String) {
        compose.setContent { MarkiroTheme(dark = dark) { PrinterAssignmentsScreen(state, {}, { _, _ -> }) } }
        compose.onNodeWithText(pallet).assertIsDisplayed()
        capture(name)
    }
    @Test fun russianDarkAssignments() = assignments(true, "ru-dark-assignments", "Паллета")
    @Test fun russianLightAssignments() = assignments(false, "ru-light-assignments", "Паллета")
    @Test @Config(qualifiers = "en-w360dp-h640dp-mdpi")
    fun englishDarkAssignments() = assignments(true, "en-dark-assignments", "Pallet")
    @Test @Config(qualifiers = "en-w360dp-h640dp-mdpi")
    fun englishLightAssignments() = assignments(false, "en-light-assignments", "Pallet")

    @Test fun duplicateVerificationNamesTheChosenReplacementBeforeTheReasonIsConfirmed() {
        compose.setContent {
            MarkiroTheme {
                app.markiro.handheld.feature.work.DuplicateScreen(
                    app.markiro.handheld.feature.work.DuplicateStep.Awaiting("job", "SERIAL-123"),
                    app.markiro.handheld.feature.work.DuplicateCallbacks(),
                    destinationLabel = "Original printer", replacementLabel = "Replacement printer",
                )
            }
        }
        compose.onNodeWithText("Повторная печать: Replacement printer. Выберите основание ниже.").assertIsDisplayed()
        capture("ru-dark-duplicate-replacement")
    }

    @Test fun aChosenReplacementRequiresAReasonInsteadOfRetryingThePreviousDestination() {
        compose.setContent {
            MarkiroTheme {
                app.markiro.handheld.feature.work.DuplicateScreen(
                    app.markiro.handheld.feature.work.DuplicateStep.Failed("job", "no_paper"),
                    app.markiro.handheld.feature.work.DuplicateCallbacks(),
                    destinationLabel = "Original printer", replacementLabel = "Replacement printer",
                )
            }
        }
        compose.onNodeWithText("Повторить печать").assertDoesNotExist()
        compose.onNodeWithText("Перепечатать: не напечаталась").assertIsDisplayed()
    }

    @Test fun sendingShowsTheBoundPrinterAndOffersNoRetryActions() {
        compose.setContent {
            MarkiroTheme {
                app.markiro.handheld.feature.work.DuplicateScreen(
                    app.markiro.handheld.feature.work.DuplicateStep.Sending("job"),
                    app.markiro.handheld.feature.work.DuplicateCallbacks(), destinationLabel = "Zebra line two",
                )
            }
        }
        compose.onNodeWithText("Дубль кода · Zebra line two").assertIsDisplayed()
        compose.onNodeWithText("Повторить печать").assertDoesNotExist()
        capture("ru-dark-duplicate-sending")
    }

    @Test fun assignmentPickerSupportsExplicitUnassignedAndOneSharedPrinter() {
        var assignment: Pair<PrintPurpose, String?>? = null
        compose.setContent { MarkiroTheme { PrinterAssignmentsScreen(state, {}, { purpose, id -> assignment = purpose to id }) } }
        compose.onNodeWithText("Паллета").performClick()
        compose.onNodeWithText("Не назначен").performClick()
        assertEquals(PrintPurpose.PALLET to null, assignment)
        compose.onNodeWithText("Паллета").performClick()
        compose.onNodeWithText(profiles.first().name).performClick()
        assertEquals(PrintPurpose.PALLET to "box", assignment)
    }
}
