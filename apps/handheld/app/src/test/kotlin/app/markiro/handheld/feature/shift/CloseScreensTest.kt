package app.markiro.handheld.feature.shift

import androidx.compose.ui.test.assertIsDisplayed
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
class CloseScreensTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun reasonStepListsTheSixReasonsAndSubmits() {
        var picked: String? = null
        var submitted = false
        compose.setContent {
            MarkiroTheme {
                CloseScreen(
                    CloseStep.Reason(ShiftCloser.Preview(8, 1, 0, 10, reasonRequired = true, alreadyClosed = false), selected = "equipment_stop"),
                    CloseCallbacks(onSelectReason = { picked = it }, onSubmitReason = { submitted = true }),
                )
            }
        }
        compose.onNodeWithText("Почему план не выполнен?").assertIsDisplayed()
        compose.onNodeWithText("Нехватка сырья или материалов").performClick()
        assertEquals("material_shortage", picked)
        compose.onNodeWithText("Закрыть").performClick()
        assertEquals(true, submitted)
    }

    @Test
    fun summaryShowsTheConflictNote() {
        compose.setContent {
            MarkiroTheme { CloseScreen(CloseStep.Summary(8, 1, 0, 2, CloseOutcome.CONFLICT), CloseCallbacks()) }
        }
        compose.onNodeWithText("Смену закроет кабинет: работало несколько устройств").assertIsDisplayed()
        compose.onNodeWithText("В хаб").assertIsDisplayed()
    }

    /** Design brief 10 §9: the summary reports boxes and pallets, not only units. */
    @Test
    fun summaryReportsBoxesAndPallets() {
        compose.setContent {
            MarkiroTheme {
                CloseScreen(CloseStep.Summary(240, 1, 0, 0, CloseOutcome.ACCEPTED, boxes = 12, pallets = 3), CloseCallbacks())
            }
        }
        compose.onNodeWithText("Короба").assertIsDisplayed()
        compose.onNodeWithText("12").assertIsDisplayed()
        compose.onNodeWithText("Паллеты").assertIsDisplayed()
        compose.onNodeWithText("3").assertIsDisplayed()
    }

    /**
     * A validation shift aggregates nothing, so the rows are absent rather than
     * a pair of permanent zeroes the operator learns to read past. Zero stays
     * reserved for the aggregation shift that really closed no box.
     */
    @Test
    fun summaryOmitsBoxesAndPalletsForAShiftThatHasNeither() {
        compose.setContent {
            MarkiroTheme { CloseScreen(CloseStep.Summary(8, 1, 0, 0, CloseOutcome.ACCEPTED), CloseCallbacks()) }
        }
        compose.onNodeWithText("Короба").assertDoesNotExist()
        compose.onNodeWithText("Паллеты").assertDoesNotExist()
        // The rest of the summary is unaffected.
        compose.onNodeWithText("Принято").assertIsDisplayed()
    }

    /**
     * An unresolved duplicate is said out loud and the shift closes anyway.
     * Blocking a close on a printer would stop a line over a sticker.
     */
    @Test
    fun anOutstandingDuplicateWarnsWithoutBlockingTheClose() {
        compose.setContent {
            MarkiroTheme {
                CloseScreen(
                    CloseStep.Confirm(
                        ShiftCloser.Preview(
                            accepted = 20, errors = 0, duplicates = 0, plan = 20,
                            reasonRequired = false, alreadyClosed = false, outstandingDuplicates = 2,
                        ),
                    ),
                    CloseCallbacks(),
                )
            }
        }
        compose.onNodeWithText(
            "Нерешённых дубликатов: 2. Смена закроется, события уйдут на сервер.",
            substring = true,
        ).assertIsDisplayed()
        // The close is offered, not withheld.
        compose.onNodeWithText("Закрыть").assertIsDisplayed()
    }

    private val sharedPreview = { others: Int? ->
        ShiftCloser.Preview(120, 1, 0, 1200, reasonRequired = false, alreadyClosed = false, shared = true, othersOpen = others)
    }

    @Test
    fun aSharedCloseNamesThePartAndHowManyOthersAreStillOpen() {
        compose.setContent { MarkiroTheme { CloseScreen(CloseStep.Confirm(sharedPreview(2)), CloseCallbacks()) } }
        compose.onNodeWithText("Закрыть свою часть?").assertIsDisplayed()
        compose.onNodeWithText("Смена закроется, когда закроют остальные: 2", substring = true).assertIsDisplayed()
    }

    @Test
    fun theLastCloserIsToldTheShiftClosesWithIt() {
        compose.setContent { MarkiroTheme { CloseScreen(CloseStep.Confirm(sharedPreview(0)), CloseCallbacks()) } }
        compose.onNodeWithText("Вы закрываете последним: смена закроется", substring = true).assertIsDisplayed()
    }

    @Test
    fun aDeviceThatCannotKnowSaysItClosesItsPartAndTheShiftClosesWhenTheOthersClose() {
        compose.setContent { MarkiroTheme { CloseScreen(CloseStep.Confirm(sharedPreview(null)), CloseCallbacks()) } }
        compose.onNodeWithText("Смена закроется, когда закроют остальные участники", substring = true).assertIsDisplayed()
    }

    @Test
    fun theReasonScreenComparesThePlanWithTheShiftWideTotal() {
        compose.setContent {
            MarkiroTheme {
                CloseScreen(
                    CloseStep.Reason(ShiftCloser.Preview(120, 1, 0, 1200, reasonRequired = true, alreadyClosed = false, shared = true, othersOpen = 0, reasonBasis = 547), null),
                    CloseCallbacks(),
                )
            }
        }
        compose.onNodeWithText("План 1200, принято 547.").assertIsDisplayed()
    }

    @Test
    fun theSummaryOfAPartCloseAndOfAMissingReasonSaySoInsteadOfShiftClosed() {
        compose.setContent { MarkiroTheme { CloseScreen(CloseStep.Summary(120, 1, 0, 0, CloseOutcome.PART_CLOSED, part = true), CloseCallbacks()) } }
        compose.onNodeWithText("Ваша часть закрыта").assertIsDisplayed()
        compose.onNodeWithText("Смена закроется, когда закроют остальные", substring = true).assertIsDisplayed()
    }

    @Test
    fun aShiftClosedWithoutItsReasonSaysTheOfficeEntersIt() {
        compose.setContent { MarkiroTheme { CloseScreen(CloseStep.Summary(120, 1, 0, 0, CloseOutcome.REASON_MISSING, part = true), CloseCallbacks()) } }
        compose.onNodeWithText("Причину недовыполнения плана внесёт офис", substring = true).assertIsDisplayed()
    }

    @Test
    fun aPartCloseStillQueuedDoesNotClaimTheShiftIsClosed() {
        compose.setContent { MarkiroTheme { CloseScreen(CloseStep.Summary(120, 1, 0, 0, CloseOutcome.PENDING, part = true), CloseCallbacks()) } }
        compose.onNodeWithText("Смена закрыта").assertDoesNotExist()
        compose.onNodeWithText("Ваша часть закрыта").assertIsDisplayed()
        compose.onNodeWithText("Закрытие отправится, когда появится сеть").assertIsDisplayed()
    }
}
