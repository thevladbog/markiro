package app.markiro.handheld.feature.shift

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
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

    /**
     * The list was fetched once on the way in and never again: a shift opened in
     * the cabinet a minute later could not be reached without leaving the screen
     * and coming back.
     */
    @Test
    fun theAppBarOffersRefresh() {
        var refreshed = false
        compose.setContent {
            MarkiroTheme {
                ShiftListScreen(
                    ShiftListUi(false, null, listOf(ShiftEntityFixtures.listed("s2")), emptyList(), false, false, 0L, true, "Линия 2", null),
                    ShiftListCallbacks(onRefresh = { refreshed = true }),
                )
            }
        }
        compose.onNodeWithContentDescription("Обновить").performClick()
        assertEquals(true, refreshed)
    }

    /**
     * Any refusal used to read «Смена уже закрыта», sending the line to look at a
     * shift the cabinet still lists as open. The server's own code is what makes
     * the call to the office useful.
     */
    @Test
    fun aRefusalNamesTheStepAndTheServersCode() {
        compose.setContent {
            MarkiroTheme {
                ShiftListScreen(
                    ShiftListUi(
                        false, null, emptyList(), emptyList(), false, false, 0L, true, "Линия 2",
                        ShiftDialog.Refused(EnterStep.ENTER, 409, "subscription_unmanaged"),
                    ),
                    ShiftListCallbacks(),
                )
            }
        }
        compose.onNodeWithText("Сервер отказал").assertIsDisplayed()
        compose.onNodeWithText("вход в смену · HTTP 409 · subscription_unmanaged", substring = true).assertIsDisplayed()
        compose.onNodeWithText("Смена уже закрыта").assertDoesNotExist()
    }

    /**
     * A refused refresh looked exactly like a successful one, and with the pull
     * gesture that is worse than before: the spinner turns, the list does not
     * move, and nothing says why.
     */
    @Test
    fun aFailedRefreshSaysSoInsteadOfLookingLikeSuccess() {
        compose.setContent {
            MarkiroTheme {
                ShiftListScreen(
                    ShiftListUi(
                        false, null, listOf(ShiftEntityFixtures.listed("s2")), emptyList(), false, false, 0L,
                        reachable = true, ownLineName = "Линия 2", dialog = null, refreshFailed = true,
                    ),
                    ShiftListCallbacks(),
                )
            }
        }
        compose.onNodeWithText("Не удалось обновить список", substring = true).assertIsDisplayed()
    }

    /** An unreachable line lookup used to be indistinguishable from «других смен нет». */
    @Test
    fun otherLinesThatCouldNotBeLoadedAreNotShownAsEmpty() {
        compose.setContent {
            MarkiroTheme {
                ShiftListScreen(
                    ShiftListUi(
                        false, null, listOf(ShiftEntityFixtures.listed("s2")), emptyList(), othersExpanded = true,
                        othersLoading = false, listFetchedAt = 0L, reachable = true, ownLineName = "Линия 2",
                        dialog = null, othersFailed = true,
                    ),
                    ShiftListCallbacks(),
                )
            }
        }
        compose.onNodeWithText("Не удалось загрузить другие линии.").assertIsDisplayed()
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
