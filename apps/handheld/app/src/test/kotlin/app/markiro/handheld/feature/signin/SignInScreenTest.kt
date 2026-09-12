package app.markiro.handheld.feature.signin

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SignInScreenTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun loginStepShowsBadgeBlockLoginFieldAndSearchLink() {
        var searched = false
        compose.setContent { MarkiroTheme { SignInScreen(SignInUi.Login("41"), SignInCallbacks(onOpenSearch = { searched = true })) } }
        compose.onNodeWithText("Сканируйте бейдж").assertIsDisplayed()
        compose.onNodeWithText("41").assertIsDisplayed()
        compose.onNodeWithText("Найти по имени").performClick()
        assertEquals(true, searched)
    }

    /**
     * The badge block, the field, the keypad and the search link do not fit a
     * short handheld display, and there was nothing to scroll: the OK key and
     * «Найти по имени» were simply below the edge with no way to reach them.
     * The height here is deliberately smaller than the layout needs.
     */
    @Test
    fun aShortScreenCanBeScrolledToTheConfirmKey() {
        compose.setContent {
            MarkiroTheme {
                Box(Modifier.size(320.dp, 300.dp)) { SignInScreen(SignInUi.Login("41"), SignInCallbacks()) }
            }
        }
        compose.onNodeWithText("OK").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Найти по имени").performScrollTo().assertIsDisplayed()
    }

    @Test
    fun pinStepShowsTheOperatorAndAWrongPinError() {
        compose.setContent {
            MarkiroTheme { SignInScreen(SignInUi.Pin("4127", "Иванова Анна", "12", SignInError.WRONG_PIN), SignInCallbacks()) }
        }
        compose.onNodeWithText("Иванова Анна").assertIsDisplayed()
        compose.onNodeWithText("Неверный PIN").assertIsDisplayed()
    }

    @Test
    fun lockModeOffersSwitchingTheOperator() {
        var switched = false
        compose.setContent {
            MarkiroTheme {
                SignInScreen(SignInUi.Pin("4127", "Иванова Анна", lockMode = true), SignInCallbacks(onSwitchOperator = { switched = true }))
            }
        }
        compose.onNodeWithText("Сменить оператора").performClick()
        assertEquals(true, switched)
    }
}
