package app.markiro.handheld.feature.hub

import org.junit.Assert.assertEquals
import org.junit.Test

class HubTilesTest {
    @Test
    fun theCloudsHubKeepsAllFiveTilesAndAHostsHubOffersSiteDisassembly() {
        assertEquals(
            listOf(HubTile.SHIFT, HubTile.INVENTORY, HubTile.WRITEOFF, HubTile.PALLETS, HubTile.SETTINGS),
            visibleTiles(hostMode = false),
        )
        assertEquals(listOf(HubTile.SHIFT, HubTile.PALLETS, HubTile.DISASSEMBLY, HubTile.SETTINGS), visibleTiles(hostMode = true))
    }
}
