package app.markiro.handheld.feature.hub

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
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

    @Test
    fun theHubSaysInTextWhetherTheHostIsThere() {
        show(HubUi(hostMode = true, reachable = true, hostLink = HostLinkStatus.Online))
        compose.onNodeWithText("Хост на связи").assertIsDisplayed()
    }

    @Test
    fun withoutALinkTheWorkGoesOnAndTheBannerSaysSo() {
        show(HubUi(hostMode = true, hostLink = HostLinkStatus.Offline))
        compose.onNodeWithText("Нет связи").assertIsDisplayed()
        compose.onNodeWithText("Нет связи с хостом — работа продолжается").assertIsDisplayed()
    }

    @Test
    fun aHostBeingRestoredAndAWrongClockEachHaveTheirOwnWords() {
        show(HubUi(hostMode = true, reachable = true, hostLink = HostLinkStatus.Restoring))
        compose.onNodeWithText("Хост восстанавливается из копии — работа продолжается").assertIsDisplayed()
    }

    @Test
    fun aWrongClockIsNamed() {
        show(HubUi(hostMode = true, reachable = true, hostLink = HostLinkStatus.ClockSkew))
        compose.onNodeWithText("Часы устройства расходятся с хостом — проверьте время на ТСД").assertIsDisplayed()
    }

    @Test
    fun theHostQueueIsOneTapAwayWhenSomethingWaitsOrWasRefused() {
        var opened = 0
        show(HubUi(hostMode = true, reachable = true, hostLink = HostLinkStatus.Online, queue = 3, hostQuarantined = 1), onHostQueue = { opened++ })
        compose.onNodeWithText("Очередь хоста: ждут 3, отклонено 1").performClick()
        assertEquals(1, opened)
    }

    @Test
    fun aCloudDeviceShowsNothingOfTheHost() {
        show(HubUi(hostMode = false, reachable = true, queue = 3, hostLink = HostLinkStatus.Offline, hostQuarantined = 2))
        compose.onNodeWithText("Сеть").assertIsDisplayed()
        compose.onNodeWithText("Нет связи с хостом — работа продолжается").assertDoesNotExist()
    }

    @Test
    fun aChangedCertificateOffersPairingAgainAndAsksBeforeSealing() {
        var repaired = 0
        compose.setContent {
            MarkiroTheme { HubScreen(HubUi(hostMode = true, hostLink = HostLinkStatus.CertificateChanged), onTile = {}, onSignOut = {}, onRepairHost = { repaired++ }) }
        }
        compose.onNodeWithText("Сертификат хоста изменился").assertIsDisplayed()
        compose.onNodeWithText("Сертификат хоста изменился — нажмите, чтобы привязать ТСД заново").performClick()
        compose.onNodeWithText("Привязать заново?").assertIsDisplayed()
        assertEquals("nothing happens before the person confirms", 0, repaired)
        compose.onNodeWithText("Привязать заново").performClick()
        assertEquals(1, repaired)
    }
}
