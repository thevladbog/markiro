package app.markiro.handheld.feature.pallets

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The «Паллеты» app bar's disassemble action, gated on `closedPalletCount`
 * exactly like the exceptions hub row it shares its wording with: nothing
 * closed on this device yet means the action must not open onto an instant
 * refusal screen.
 */
@RunWith(AndroidJUnit4::class)
class PalletsScreenTest {
    @get:Rule
    val compose = createComposeRule()

    private fun render(closedPalletCount: Int, cb: PalletsCallbacks = PalletsCallbacks()) {
        compose.setContent { MarkiroTheme { PalletsRoute(PalletsUi(closedPalletCount = closedPalletCount), cb) } }
    }

    @Test
    fun noClosedPalletsDisablesTheDisassembleActionAndSaysWhy() {
        render(closedPalletCount = 0)
        compose.onNode(hasContentDescription("Расформировать паллету", substring = true)).assertIsNotEnabled()
        compose.onNode(hasContentDescription("Нет закрытых паллет", substring = true)).assertIsDisplayed()
    }

    @Test
    fun aClosedPalletEnablesTheDisassembleAction() {
        render(closedPalletCount = 1)
        compose.onNode(hasContentDescription("Расформировать паллету", substring = true)).assertIsEnabled()
    }
}
