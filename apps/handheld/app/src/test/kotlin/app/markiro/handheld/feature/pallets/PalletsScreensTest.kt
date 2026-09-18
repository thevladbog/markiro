package app.markiro.handheld.feature.pallets

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
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

    private fun member(sscc: String, status: String) =
        PalletMembershipEntity("w1", sscc, "t", null, status, null, null, null, null)

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

    /** «Убрать» belongs to a pending row only: a sent one may already be on the server. */
    @Test
    fun aPendingRowCanBeTakenOffAndASentOneCannot() {
        var removed: String? = null
        compose.setContent {
            MarkiroTheme {
                PalletsRoute(
                    PalletsUi(
                        pallet = pallet, productName = "Вода 0,5 л", boxCount = 2, capacity = 12,
                        members = listOf(member("034600682000000014", MembershipStatus.SENT), member("034600682000000021", MembershipStatus.PENDING)),
                    ),
                    PalletsCallbacks(onRemove = { removed = it }),
                )
            }
        }
        compose.onNodeWithText("2 / 12 коробов").assertIsDisplayed()
        compose.onNodeWithText("Вода 0,5 л").assertIsDisplayed()
        compose.onNodeWithText("в очереди").assertIsDisplayed()
        compose.onNodeWithText("отправляется").assertIsDisplayed()
        compose.onNodeWithContentDescription("Убрать с паллеты").performClick()
        assertEquals("034600682000000021", removed)
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
        var acknowledged = false
        compose.setContent {
            MarkiroTheme {
                PalletsRoute(
                    PalletsUi(
                        pallet = pallet, boxCount = 0,
                        rejections = listOf(
                            PalletMembershipEntity(
                                "w1", "034600682000000014", "t", null, MembershipStatus.REJECTED,
                                "already_on_pallet", "134600682000000011", "t", null,
                            ),
                        ),
                    ),
                    PalletsCallbacks(onAcknowledge = { acknowledged = true }),
                )
            }
        }
        compose.onNodeWithText("Снимите с паллеты 1 короб").assertIsDisplayed()
        compose.onNodeWithText("короб …000014 — На паллете …000011").assertIsDisplayed()
        compose.onNodeWithText("Принято").performClick()
        assertEquals(true, acknowledged)
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
                        rejections = listOf(
                            PalletMembershipEntity(
                                "w1", "034600682000000014", "t", null, MembershipStatus.REJECTED,
                                "already_on_pallet", null, "t", null,
                            ),
                        ),
                    ),
                    PalletsCallbacks(),
                )
            }
        }
        compose.onNodeWithText("короб …000014 — На открытой паллете другого устройства").assertIsDisplayed()
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
