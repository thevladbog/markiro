package app.markiro.handheld.feature.pallets

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.storage.MembershipStatus
import app.markiro.handheld.core.storage.PalletEntity
import app.markiro.handheld.core.storage.PalletKind
import app.markiro.handheld.core.storage.PalletMembershipEntity
import app.markiro.handheld.core.storage.PalletPrint
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PalletsScreensTest {
    @get:Rule
    val compose = createComposeRule()

    private val pallet = PalletEntity(
        palletId = "w1", shiftId = null, terminalId = "dev-1", sscc = null, openedAt = "t", closedAt = null,
        operatorId = "op-1", printState = PalletPrint.PENDING, printReason = null, ackedAt = null,
        kind = PalletKind.WAREHOUSE, productId = "p1", deviceId = "dev-1",
    )

    private val closed = pallet.copy(palletId = "w0", sscc = "134600682000000011", closedAt = "t")

    private fun member(sscc: String, status: String) =
        PalletMembershipEntity("w1", sscc, "t", null, status, null, null, null, null)

    private fun rejected(sscc: String, reason: String, winner: String?, palletId: String = "w1") =
        PalletMembershipEntity(palletId, sscc, "t", null, MembershipStatus.REJECTED, reason, winner, "t", null)

    /** A refusal names the right the operator is missing and where it is granted. */
    @Test
    fun anOperatorWithoutTheRightIsToldWhereItComesFrom() {
        var back = false
        compose.setContent {
            MarkiroTheme { PalletsRoute(PalletsUi(blocked = PalletsBlocked.NO_PERMISSION), PalletsCallbacks(onBack = { back = true })) }
        }
        compose.onNodeWithText("Нет права собирать паллеты").assertIsDisplayed()
        compose.onNodeWithText("Попросите менеджера включить «Сборка паллет на ТСД» в карточке сотрудника.").assertIsDisplayed()
        compose.onNodeWithText("На главный экран").performClick()
        assertEquals(true, back)
    }

    @Test
    fun anEmptyModeAsksForTheFirstBox() {
        compose.setContent { MarkiroTheme { PalletsRoute(PalletsUi(), PalletsCallbacks()) } }
        compose.onNodeWithText("Отсканируйте короб").assertIsDisplayed()
        compose.onNodeWithText("Первый короб задаёт товар паллеты.").assertIsDisplayed()
    }

    /** Spec 2026-09-18: every non-rejected box can be taken off, whatever its sync status. */
    @Test
    fun anyNonRejectedRowCanBeTakenOff() {
        val removed = mutableListOf<String>()
        compose.setContent {
            MarkiroTheme {
                PalletsRoute(
                    PalletsUi(
                        pallet = pallet, productName = "Вода 0,5 л", boxCount = 3, capacity = 12,
                        members = listOf(
                            member("034600682000000014", MembershipStatus.SENT),
                            member("034600682000000021", MembershipStatus.PENDING),
                            member("034600682000000038", MembershipStatus.ACCEPTED),
                        ),
                    ),
                    PalletsCallbacks(onRemove = { removed += it }),
                )
            }
        }
        compose.onAllNodesWithContentDescription("Убрать с паллеты").assertCountEquals(3)
        compose.onAllNodesWithContentDescription("Убрать с паллеты")[0].performClick()
        // Rows are listed newest first.
        assertEquals(listOf("034600682000000038"), removed)
    }

    /** No capacity is not «0 из 0»: the count still has to be honest -- and declined. */
    @Test
    fun aProductWithoutACapacityStillCountsItsBoxes() {
        compose.setContent {
            MarkiroTheme {
                PalletsRoute(
                    PalletsUi(pallet = pallet, boxCount = 3, capacity = null, members = listOf(member("034600682000000014", MembershipStatus.PENDING))),
                    PalletsCallbacks(),
                )
            }
        }
        compose.onNodeWithText("3 короба · ёмкость не задана").assertIsDisplayed()
    }

    /** «1 коробов» is the kind of line an operator stops trusting the screen over. */
    @Test
    fun aSingleBoxWithoutACapacityIsDeclinedProperly() {
        compose.setContent {
            MarkiroTheme {
                PalletsRoute(
                    PalletsUi(pallet = pallet, boxCount = 1, capacity = null, members = listOf(member("034600682000000014", MembershipStatus.PENDING))),
                    PalletsCallbacks(),
                )
            }
        }
        compose.onNodeWithText("1 короб · ёмкость не задана").assertIsDisplayed()
    }

    @Test
    fun aRejectionNamesTheBoxTheReasonAndOffersToAcknowledge() {
        var acknowledged: String? = null
        compose.setContent {
            MarkiroTheme {
                PalletsRoute(
                    PalletsUi(
                        pallet = pallet, boxCount = 0,
                        rejections = listOf(rejected("034600682000000014", "already_on_pallet", "134600682000000011")),
                        rejectionPallets = mapOf("w1" to pallet),
                    ),
                    PalletsCallbacks(onAcknowledge = { acknowledged = it }),
                )
            }
        }
        compose.onNodeWithText("Снимите с паллеты 1 короб").assertIsDisplayed()
        compose.onNodeWithText("короб …000014 — На паллете …000011").assertIsDisplayed()
        compose.onNodeWithText("Принято").performClick()
        assertEquals("w1", acknowledged)
    }

    /**
     * The winning pallet is still open somewhere else, so it has no number yet.
     * «На паллете …» with an empty tail read like a bug rather than an answer.
     */
    @Test
    fun aRejectionByAnUnnumberedPalletSaysSoInWords() {
        compose.setContent {
            MarkiroTheme {
                PalletsRoute(
                    PalletsUi(
                        pallet = pallet, boxCount = 0,
                        rejections = listOf(rejected("034600682000000014", "already_on_pallet", null)),
                        rejectionPallets = mapOf("w1" to pallet),
                    ),
                    PalletsCallbacks(),
                )
            }
        }
        compose.onNodeWithText("короб …000014 — На открытой паллете другого устройства").assertIsDisplayed()
    }

    /**
     * Rejections are device-wide, so two pallets can be owed news at once — and
     * only the CLOSED one has a label in the warehouse that now overstates its
     * stack. The open one has printed nothing yet, so it is offered nothing to
     * reprint.
     */
    @Test
    fun eachPalletGetsItsOwnSectionAndOnlyTheClosedOneOffersANewLabel() {
        var reprinted: String? = null
        var acknowledged: String? = null
        compose.setContent {
            MarkiroTheme {
                PalletsRoute(
                    PalletsUi(
                        pallet = pallet, boxCount = 0,
                        rejections = listOf(
                            rejected("034600682000000014", "not_found", null, palletId = "w0"),
                            rejected("034600682000000021", "already_on_pallet", null),
                        ),
                        rejectionPallets = mapOf("w0" to closed, "w1" to pallet),
                    ),
                    PalletsCallbacks(onAcknowledge = { acknowledged = it }, onReprint = { reprinted = it }),
                )
            }
        }
        compose.onNodeWithText("Паллета …000011").assertIsDisplayed()
        compose.onNodeWithText("Открытая паллета").assertIsDisplayed()
        compose.onNodeWithText("короб …000014 — Сервер не знает этот короб").assertIsDisplayed()
        compose.onNodeWithText("короб …000021 — На открытой паллете другого устройства").assertIsDisplayed()
        // One button, and it belongs to the closed pallet's section.
        compose.onAllNodesWithText("Перепечатать этикетку").assertCountEquals(1)
        compose.onNodeWithText("Перепечатать этикетку").performClick()
        assertEquals("w0", reprinted)
        compose.onAllNodesWithText("Принято").assertCountEquals(2)
        compose.onAllNodesWithText("Принято").onFirst().performClick()
        assertEquals("w0", acknowledged)
    }

    @Test
    fun theEarlyCloseQuestionNamesTheCountBeforeItCloses() {
        var confirmed = false
        compose.setContent {
            MarkiroTheme {
                PalletsRoute(
                    PalletsUi(pallet = pallet, boxCount = 7, capacity = 12, confirmEarlyClose = true),
                    PalletsCallbacks(onConfirmEarlyClose = { confirmed = true }),
                )
            }
        }
        compose.onNodeWithText("В паллете 7 из 12 коробов.").assertIsDisplayed()
        compose.onNodeWithText("Закрыть паллету").performClick()
        assertEquals(true, confirmed)
    }

    @Test
    fun aScanVerdictIsShownAsALineNotAnOverlay() {
        compose.setContent {
            MarkiroTheme {
                PalletsRoute(
                    PalletsUi(pallet = pallet, boxCount = 1, capacity = 12, lastVerdict = PalletVerdict.UnitCode),
                    PalletsCallbacks(),
                )
            }
        }
        compose.onNodeWithText("Это код единицы, нужен SSCC короба").assertIsDisplayed()
    }
}
