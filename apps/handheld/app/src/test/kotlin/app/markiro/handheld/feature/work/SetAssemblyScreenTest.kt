package app.markiro.handheld.feature.work

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertWidthIsEqualTo
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.host.HostFactsFixtures
import app.markiro.handheld.core.network.SetItemDto
import app.markiro.handheld.core.sync.SyncState
import kotlinx.serialization.json.Json
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "ru-w360dp-h640dp-mdpi")
class SetAssemblyScreenTest {
    @get:Rule val compose = createComposeRule()

    private val cream = "04607123456804"
    private val balm = "04607123456811"
    private val scanned = listOf("01${balm}21balm", "01${cream}21cream1", "01${cream}21cream2")
    private val recipe = listOf(SetItemDto(cream, "Крем для рук", 2), SetItemDto(balm, "Бальзам для губ", 1))
    private val state = WorkUi(
        shift = HostFactsFixtures.shift().copy(
            mode = "validation",
            productName = "Зимний набор",
            setItemsJson = Json.encodeToString(recipe),
        ),
        last = null,
        total = 1,
        plan = null,
        thisTerminal = 1,
        errors = 0,
        duplicates = 0,
        feed = emptyList(),
        sync = SyncState(),
        reachable = true,
        team = null,
    )

    @Test
    @Config(qualifiers = "ru-w411dp-h914dp-mdpi")
    fun completionMakesThePackageScanTheFirstActionAboveTheRecipe() {
        val assembly = mutableStateOf(SetAssemblyUi(draft = scanned.take(1)))
        compose.setContent { MarkiroTheme { SetAssemblyScreen(state, assembly.value, {}, {}, { _, _ -> }) } }

        compose.onNodeWithText("1 / 3").assertIsDisplayed()
        compose.onNodeWithText("Отсканируйте код набора").assertDoesNotExist()
        compose.runOnIdle { assembly.value = SetAssemblyUi(draft = scanned) }

        val action = compose.onNodeWithText("Отсканируйте код набора").assertIsDisplayed().fetchSemanticsNode()
        val recipeHeading = compose.onNodeWithText("Состав набора").assertIsDisplayed().fetchSemanticsNode()
        assertTrue("Package scan panel was ${action.boundsInRoot.height} px high", action.boundsInRoot.height >= 100f)
        compose.onNodeWithTag("set-package-scan-icon", useUnmergedTree = true).assertWidthIsEqualTo(36.dp)
        assertTrue(action.boundsInRoot.bottom < recipeHeading.boundsInRoot.top)
        compose.onNodeWithText("Data Matrix на упаковке").assertIsDisplayed()
        compose.onNodeWithText("3 / 3").assertIsDisplayed()
        compose.onNodeWithText("Сканируйте вложения").assertDoesNotExist()
    }

    @Test
    @Config(qualifiers = "ru-w320dp-h568dp-mdpi")
    fun fullSetKeepsThePackageInstructionAndCompositionVisibleOnASmallTerminal() {
        compose.setContent { MarkiroTheme { SetAssemblyScreen(state, SetAssemblyUi(draft = scanned), {}, {}, { _, _ -> }) } }

        compose.onNodeWithText("Отсканируйте код набора").assertIsDisplayed()
        compose.onNodeWithText("Data Matrix на упаковке").assertIsDisplayed()
        compose.onNodeWithText("3 / 3").assertIsDisplayed()
        compose.onNodeWithText("Бальзам для губ").assertIsDisplayed()
        compose.onNodeWithText("Собрано за смену").assertIsDisplayed()
    }

    @Test
    fun shiftTotalFollowsTheCompositionWithoutAViewportSizedGap() {
        compose.setContent { MarkiroTheme { SetAssemblyScreen(state, SetAssemblyUi(draft = scanned.take(1)), {}, {}, { _, _ -> }) } }

        val lastItem = compose.onNodeWithText("Бальзам для губ").assertIsDisplayed().fetchSemanticsNode()
        val total = compose.onNodeWithText("Собрано за смену").assertIsDisplayed().fetchSemanticsNode()
        val gap = total.boundsInRoot.top - lastItem.boundsInRoot.bottom
        assertTrue("Gap between the recipe and shift total was $gap px", gap in 0f..72f)
    }
}
