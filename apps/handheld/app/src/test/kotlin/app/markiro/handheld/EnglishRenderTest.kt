package app.markiro.handheld

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.feature.hub.HubScreen
import app.markiro.handheld.feature.hub.HubUi
import app.markiro.handheld.feature.pairing.PairingCallbacks
import app.markiro.handheld.feature.pairing.PairingScreen
import app.markiro.handheld.feature.pairing.PairingUi
import app.markiro.handheld.feature.signin.SignInCallbacks
import app.markiro.handheld.feature.signin.SignInScreen
import app.markiro.handheld.feature.signin.SignInUi
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

private val cyrillic = Regex("[А-Яа-яЁё]")
private val hasCyrillic = SemanticsMatcher("has Cyrillic text") { node ->
    val texts = node.config.getOrNull(SemanticsProperties.Text).orEmpty().map { it.text } +
        listOfNotNull(node.config.getOrNull(SemanticsProperties.ContentDescription)?.joinToString())
    texts.any { cyrillic.containsMatchIn(it) }
}

/** Under an English locale no screen may leak a Russian literal. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "en-rUS-w360dp-h640dp")
class EnglishRenderTest {
    @get:Rule
    val compose = createComposeRule()

    private fun assertNoCyrillic() = assertEquals(0, compose.onAllNodes(hasCyrillic).fetchSemanticsNodes().size)

    @Test
    fun hubRendersInEnglish() {
        compose.setContent {
            MarkiroTheme {
                HubScreen(
                    HubUi("Test Plant", "Anna Ivanova", "Line 2", shifts = 2, inventories = 0, countsAt = 0L, reachable = false, scannerLabel = "Zebra"),
                    onTile = {},
                    onSignOut = {},
                )
            }
        }
        assertNoCyrillic()
    }

    @Test
    fun pairingRendersInEnglish() {
        compose.setContent { MarkiroTheme { PairingScreen(PairingUi.Enter("", "https://x", true), PairingCallbacks()) } }
        assertNoCyrillic()
    }

    @Test
    fun signInRendersInEnglish() {
        compose.setContent { MarkiroTheme { SignInScreen(SignInUi.Pin("4127", "Anna Ivanova", lockMode = true), SignInCallbacks()) } }
        assertNoCyrillic()
    }
}
