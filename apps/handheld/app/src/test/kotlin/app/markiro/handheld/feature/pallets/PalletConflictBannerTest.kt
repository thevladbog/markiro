package app.markiro.handheld.feature.pallets

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.storage.MembershipStatus
import app.markiro.handheld.core.storage.PalletEntity
import app.markiro.handheld.core.storage.PalletKind
import app.markiro.handheld.core.storage.PalletMembershipEntity
import app.markiro.handheld.core.storage.PalletPrint
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** The host's own refusal codes (`box_on_pallet` and its siblings) read as the cloud's refusals do, and the next box can still be scanned. */
@RunWith(AndroidJUnit4::class)
class PalletConflictBannerTest {
    @get:Rule
    val compose = createComposeRule()

    private val pallet = PalletEntity(
        palletId = "w1", shiftId = null, terminalId = "dev-1", sscc = null, openedAt = "t", closedAt = null,
        operatorId = "op-1", printState = PalletPrint.PENDING, printReason = null, ackedAt = null,
        kind = PalletKind.WAREHOUSE, productId = "p1", deviceId = "dev-1",
    )

    private fun rejected(sscc: String, reason: String, winner: String?) =
        PalletMembershipEntity("w1", sscc, "t", null, MembershipStatus.REJECTED, reason, winner, "t", null)

    private fun show(vararg rows: PalletMembershipEntity) = compose.setContent {
        MarkiroTheme {
            PalletsRoute(PalletsUi(pallet = pallet, boxCount = 0, rejections = rows.toList(), rejectionPallets = mapOf("w1" to pallet)), PalletsCallbacks())
        }
    }

    @Test
    fun aBoxTheHostHoldsOnAnotherPalletNamesThatPallet() {
        show(rejected("034600682000000014", "box_on_pallet", "134600682000000011"))
        compose.onNodeWithText("короб …000014 — На паллете …000011").assertIsDisplayed()
    }

    @Test
    fun aBoxOnAnotherOpenPalletOfAnotherDeviceSaysSoWithoutANumber() {
        show(rejected("034600682000000014", "box_on_pallet", null))
        compose.onNodeWithText("короб …000014 — На открытой паллете другого устройства").assertIsDisplayed()
    }

    @Test
    fun theHostsUnknownAndNotClosedBoxAreSaidInTheCloudsWords() {
        show(rejected("034600682000000014", "box_not_found", null), rejected("034600682000000021", "box_not_closed", null))
        compose.onNodeWithText("короб …000014 — Сервер не знает этот короб").assertIsDisplayed()
        compose.onNodeWithText("короб …000021 — Короб не закрыт").assertIsDisplayed()
    }
}
