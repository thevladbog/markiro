package app.markiro.handheld.feature.shift

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ShiftListScreenTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun showsContinueMineAndOffersAggregationShifts() {
        var selected: String? = null
        var continued = false
        compose.setContent {
            MarkiroTheme {
                ShiftListScreen(
                    ShiftListUi(
                        loading = false,
                        continueShift = ShiftEntityFixtures.bundled("s1"),
                        mine = listOf(ShiftEntityFixtures.listed("s2"), ShiftEntityFixtures.listed("s3", mode = "aggregation")),
                        others = emptyList(), othersExpanded = false, othersLoading = false, listFetchedAt = 0L, reachable = true,
                        ownLineName = "Линия 2", dialog = null,
                    ),
                    ShiftListCallbacks(onContinue = { continued = true }, onSelect = { selected = it.id }),
                )
            }
        }
        compose.onNodeWithText("SEP26-001").assertIsDisplayed()
        compose.onNodeWithText("Продолжить").performClick()
        assertEquals(true, continued)
        compose.onNodeWithText("SEP26-002").performClick()
        assertEquals("s2", selected)
        // An aggregation shift is enterable like any other. This assertion used to
        // say the opposite, and pinned the slice shut: the list, the view model and
        // the repository each gated aggregation separately, and a walk-through was
        // what found the one with no distinctive name to grep for.
        compose.onNodeWithText("SEP26-003").performClick()
        assertEquals("s3", selected)
    }

    @Test
    fun offlineShowsTheCacheTimeAndTheEmptyState() {
        compose.setContent {
            MarkiroTheme {
                ShiftListScreen(
                    ShiftListUi(false, null, emptyList(), emptyList(), false, false, listFetchedAt = 0L, reachable = false, ownLineName = null, dialog = null),
                    ShiftListCallbacks(),
                )
            }
        }
        compose.onNodeWithText("Смен нет").assertIsDisplayed()
        compose.onNodeWithText("данные на", substring = true).assertIsDisplayed()
    }
}
