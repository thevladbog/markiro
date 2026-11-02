package app.markiro.handheld.core.design

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertWidthIsAtLeast
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.sync.SyncState
import app.markiro.handheld.core.inventory.InventorySyncState
import app.markiro.handheld.feature.inventory.InventoryProgress
import app.markiro.handheld.core.storage.InventoryFixtures
import app.markiro.handheld.feature.inventory.InventoryWorkCallbacks
import app.markiro.handheld.feature.inventory.InventoryWorkScreen
import app.markiro.handheld.feature.inventory.InventoryWorkUi
import app.markiro.handheld.feature.shift.ShiftEntityFixtures
import app.markiro.handheld.feature.work.BoxUi
import app.markiro.handheld.feature.work.WorkCallbacks
import app.markiro.handheld.feature.work.WorkScreen
import app.markiro.handheld.feature.work.WorkUi
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "ru-w320dp-h520dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ProductHeaderTest {
    @get:Rule val compose = createComposeRule()
    private val product = "Сидр полусухой газированный «ДИКИЙ КРЕСТ» яблочный, пастеризованный, 0,45 л"

    private fun showWork(aggregation: Boolean, scale: Float = 1f) {
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(1f, scale)) {
                MarkiroTheme {
                    WorkScreen(WorkUi(shift = ShiftEntityFixtures.bundled("long-name").copy(productName = product, productPrintName = product,
                        mode = if (aggregation) "aggregation" else "validation", ssccIssuerPrefix = "046006820"),
                        last = null, total = 128, plan = 1200, thisTerminal = 128, errors = 0, duplicates = 0,
                        feed = emptyList(), sync = SyncState(pending = 0), reachable = true, team = null,
                        box = if (aggregation) BoxUi(1, 7, 12) else null), WorkCallbacks())
                }
            }
        }
        verifyHeader(scale)
        compose.onNodeWithText(if (aggregation) "Короб 1 · 7 / 12" else "Ожидание скана…").assertIsDisplayed()
        if (aggregation) compose.onNodeWithText("Всего").performScrollTo().assertIsDisplayed()
    }

    private fun verifyHeader(scale: Float) {
        val title = compose.onNodeWithText(product).assertIsDisplayed()
        val layouts = mutableListOf<TextLayoutResult>()
        title.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
        val layout = layouts.single()
        if (scale == 1f) assertEquals("Product wraps into three full-width lines", 3, layout.lineCount)
        else assertTrue("System font size is respected", layout.lineCount > 3)
        assertFalse("No clipping or ellipsis in product identity", layout.hasVisualOverflow)
        assertEquals("Actions must not narrow the product name", 288f, title.fetchSemanticsNode().boundsInRoot.width, 1f)
        for (label in listOf("Связь и очередь", "Ещё")) {
            val action = compose.onNodeWithContentDescription(label).assertIsDisplayed()
                .assertWidthIsAtLeast(48.dp).assertHeightIsAtLeast(48.dp)
            assertTrue("Actions have their own row", action.fetchSemanticsNode().boundsInRoot.bottom <= title.fetchSemanticsNode().boundsInRoot.top)
        }
        compose.onNodeWithContentDescription("Маркиро").assertDoesNotExist()
    }

    @Test fun threeLineProductOnWorkScreen() = showWork(false)
    @Test fun enlargedProductOnWorkScreen() = showWork(false, 1.5f)
    @Test fun threeLineProductAboveAggregation() = showWork(true)
    @Test fun enlargedProductAboveAggregation() = showWork(true, 1.5f)

    private fun showInventory(scale: Float) {
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(1f, scale)) {
                MarkiroTheme {
                    InventoryWorkScreen(InventoryWorkUi(task = InventoryFixtures.task("long-inventory").copy(productName = product, productPrintName = product),
                        expectedCount = 1200, activeDate = null, last = null, progress = InventoryProgress(verified = 128, discrepancies = 0, protected = 0, thisTerminal = 128, rejected = 0),
                        feed = emptyList(), sync = InventorySyncState(pending = 0), reachable = true, held = null, closed = false), InventoryWorkCallbacks())
                }
            }
        }
        verifyHeader(scale)
        compose.onNodeWithText("Ожидание скана…").assertIsDisplayed()
        for (label in listOf("Проверено", "Этот ТСД", "Расхождения")) {
            val layouts = mutableListOf<TextLayoutResult>()
            val node = compose.onNodeWithText(label)
            if (scale > 1f) node.performScrollTo()
            node.assertIsDisplayed().performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
            assertEquals("Inventory counters move as whole groups", 1, layouts.single().lineCount)
        }
    }
    @Test fun threeLineProductOnInventory() = showInventory(1f)
    @Test fun enlargedProductOnInventory() = showInventory(1.5f)
    @Test fun nestedAppBarsDoNotRepeatTheLogo() {
        compose.setContent { MarkiroTheme { AppBar("Добавить принтер", onBack = {}) } }
        compose.onNodeWithContentDescription("Маркиро").assertDoesNotExist()
        compose.onNodeWithText("Добавить принтер").assertIsDisplayed()
    }
    @Test @Config(qualifiers = "ru-w320dp-h320dp-mdpi")
    fun longWorkIdentityAndWarningsScrollWhileActionsStayAvailable() {
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(1f, 2f)) {
                MarkiroTheme {
                    WorkScreen(WorkUi(shift = ShiftEntityFixtures.bundled("scroll").copy(productPrintName = product.repeat(3), mode = "aggregation", ssccIssuerPrefix = null, ssccIssuerProblem = "org_gln_missing"),
                        last = null, total = 128, plan = 1200, thisTerminal = 128, errors = 0, duplicates = 0,
                        feed = emptyList(), sync = SyncState(pending = 0), reachable = true, team = null), WorkCallbacks())
                }
            }
        }
        compose.onNodeWithText("Всего").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("В организации не задан GLN", substring = true).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(product.repeat(3)).performScrollTo().assertIsDisplayed()
        compose.onNodeWithContentDescription("Связь и очередь").assertIsDisplayed().assertHeightIsAtLeast(48.dp)
        compose.onNodeWithContentDescription("Ещё").assertIsDisplayed().assertHeightIsAtLeast(48.dp)
    }

    @Test @Config(qualifiers = "ru-w320dp-h320dp-mdpi")
    fun longInventoryIdentityAndDateScrollWhileActionsStayAvailable() {
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(1f, 2f)) {
                MarkiroTheme {
                    InventoryWorkScreen(InventoryWorkUi(task = InventoryFixtures.task("scroll").copy(productPrintName = product.repeat(3)),
                        expectedCount = 1200, activeDate = "2026-08-20", last = null,
                        progress = InventoryProgress(128, 0, 0, 128, 0), feed = emptyList(), sync = InventorySyncState(pending = 0), reachable = true, held = null, closed = false), InventoryWorkCallbacks())
                }
            }
        }
        compose.onNodeWithText("Проверено").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Дата 20.08.2026").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(product.repeat(3)).performScrollTo().assertIsDisplayed()
        compose.onNodeWithContentDescription("Связь и очередь").assertIsDisplayed().assertHeightIsAtLeast(48.dp)
        compose.onNodeWithContentDescription("Ещё").assertIsDisplayed().assertHeightIsAtLeast(48.dp)
    }

}
