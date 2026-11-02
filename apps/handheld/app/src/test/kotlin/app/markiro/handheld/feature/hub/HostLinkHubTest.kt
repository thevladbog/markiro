package app.markiro.handheld.feature.hub

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.assertWidthIsAtLeast
import androidx.compose.ui.unit.dp
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.host.HostLinkStatus
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode

@GraphicsMode(GraphicsMode.Mode.NATIVE)
@RunWith(AndroidJUnit4::class)
class HostLinkHubTest {
    @get:Rule
    val compose = createComposeRule()

    private fun show(state: HubUi, onHostQueue: () -> Unit = {}) = compose.setContent {
        MarkiroTheme { HubScreen(state, onTile = {}, onSignOut = {}, onHostQueue = onHostQueue) }
    }

    @Test fun offlineDetailsDoNotTakeSpaceAboveOperations() {
        show(HubUi(hostMode = true, hostLink = HostLinkStatus.Offline, queue = 12))
        compose.onNodeWithText("Нет связи с хостом — работа продолжается").assertDoesNotExist()
        compose.onNodeWithText("Очередь хоста: ждут 12, отклонено 0").assertDoesNotExist()
        compose.onNodeWithContentDescription("Связь и очередь").performClick()
        compose.onNodeWithText("Нет связи с хостом — работа продолжается").assertIsDisplayed()
        compose.onNodeWithText("Очередь хоста: ждут 12, отклонено 0").assertIsDisplayed()
    }

    @Test fun healthyStatusIsAnAccessibleHeaderTarget() {
        show(HubUi(hostMode = true, hostLink = HostLinkStatus.Online, reachable = true))
        compose.onNodeWithContentDescription("Связь и очередь").assertIsDisplayed().assertWidthIsAtLeast(48.dp)
    }

    @Test fun hubCarriesTheMarkiroLogo() {
        show(HubUi())
        compose.onNodeWithContentDescription("Маркиро").assertIsDisplayed()
    }

    @Test
    fun theHubSaysInTextWhetherTheHostIsThere() {
        show(HubUi(hostMode = true, reachable = true, hostLink = HostLinkStatus.Online))
        compose.onNodeWithContentDescription("Связь и очередь").performClick()
        compose.onNodeWithText("Хост на связи").assertIsDisplayed()
    }

    @Test
    fun withoutALinkTheWorkGoesOnAndTheBannerSaysSo() {
        show(HubUi(hostMode = true, hostLink = HostLinkStatus.Offline))
        compose.onNodeWithContentDescription("Связь и очередь").performClick()
        compose.onNodeWithText("Нет связи с хостом — работа продолжается").assertIsDisplayed()
    }

    @Test
    fun aHostBeingRestoredAndAWrongClockEachHaveTheirOwnWords() {
        show(HubUi(hostMode = true, reachable = true, hostLink = HostLinkStatus.Restoring))
        compose.onNodeWithContentDescription("Связь и очередь").performClick()
        compose.onNodeWithText("Хост восстанавливается из копии — работа продолжается").assertIsDisplayed()
    }

    @Test
    fun aWrongClockIsNamed() {
        show(HubUi(hostMode = true, reachable = true, hostLink = HostLinkStatus.ClockSkew))
        compose.onNodeWithContentDescription("Связь и очередь").performClick()
        compose.onNodeWithText("Часы устройства расходятся с хостом — проверьте время на ТСД").assertIsDisplayed()
    }

    @Test
    fun theHostQueueIsOneTapAwayWhenSomethingWaitsOrWasRefused() {
        var opened = 0
        show(HubUi(hostMode = true, reachable = true, hostLink = HostLinkStatus.Online, queue = 3, hostQuarantined = 1), onHostQueue = { opened++ })
        compose.onNodeWithContentDescription("Связь и очередь").performClick()
        compose.onNodeWithText("Очередь хоста: ждут 3, отклонено 1").assertIsDisplayed()
        compose.onNodeWithText("Открыть очередь хоста").performClick()
        assertEquals(1, opened)
    }

    @Test
    fun aCloudDeviceShowsNothingOfTheHost() {
        show(HubUi(hostMode = false, reachable = true, queue = 3, hostLink = HostLinkStatus.Offline, hostQuarantined = 2))
        compose.onNodeWithContentDescription("Связь и очередь").performClick()
        compose.onNodeWithText("Сеть").assertIsDisplayed()
        compose.onNodeWithText("Нет связи с хостом — работа продолжается").assertDoesNotExist()
    }

    @Test
    fun aChangedCertificateOffersPairingAgainAndAsksBeforeSealing() {
        var repaired = 0
        compose.setContent {
            MarkiroTheme { HubScreen(HubUi(hostMode = true, hostLink = HostLinkStatus.CertificateChanged), onTile = {}, onSignOut = {}, onRepairHost = { repaired++ }) }
        }
        compose.onNodeWithContentDescription("Связь и очередь").performClick()
        compose.onNodeWithText("Сертификат хоста изменился").assertIsDisplayed()
        compose.onNodeWithText("Привязать заново").performClick()
        compose.onNodeWithText("Привязать заново?").assertIsDisplayed()
        assertEquals("nothing happens before the person confirms", 0, repaired)
        compose.onNodeWithText("Привязать заново").performClick()
        assertEquals(1, repaired)
    }
    @Test fun onlineQuarantineShowsRefusedCountBeforeOpeningDetails() {
        show(HubUi(hostMode = true, reachable = true, hostLink = HostLinkStatus.Online, queue = 0, hostQuarantined = 7))
        compose.onNodeWithText("7").assertIsDisplayed()
        compose.onNodeWithContentDescription("Связь и очередь").performClick()
        compose.onNodeWithText("Очередь хоста: ждут 0, отклонено 7").assertIsDisplayed()
    }

    @Test fun offlineWarningStillShowsPendingRatherThanRefusedCount() {
        show(HubUi(hostMode = true, hostLink = HostLinkStatus.Offline, queue = 3, hostQuarantined = 7))
        compose.onNodeWithText("3").assertIsDisplayed()
        compose.onNodeWithText("7").assertDoesNotExist()
    }

}
