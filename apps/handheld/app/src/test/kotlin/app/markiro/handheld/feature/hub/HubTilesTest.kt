package app.markiro.handheld.feature.hub

import org.junit.Assert.assertEquals
import org.junit.Test

class HubTilesTest {
    @Test
    fun theCloudsHubKeepsAllFiveTilesAndAHostsHubDropsInventoryAndWriteoff() {
        assertEquals(
            listOf(HubTile.SHIFT, HubTile.INVENTORY, HubTile.WRITEOFF, HubTile.PALLETS, HubTile.SETTINGS),
            visibleTiles(hostMode = false),
        )
        assertEquals(listOf(HubTile.SHIFT, HubTile.PALLETS, HubTile.SETTINGS), visibleTiles(hostMode = true))
    }
}
