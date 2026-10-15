package app.markiro.handheld.core.backend

import app.markiro.handheld.core.network.BoxRegistryPageDto
import app.markiro.handheld.core.network.BoxSsccTopUpDto
import app.markiro.handheld.core.network.PalletBootstrapDto
import app.markiro.handheld.core.network.RosterResponse
import app.markiro.handheld.core.network.ShiftBundleDto
import app.markiro.handheld.core.network.ShiftDto
import app.markiro.handheld.core.network.ShiftEntryRequest
import app.markiro.handheld.core.network.ShiftListResponse
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.storage.DeviceConfigDao

/**
 * The backend of this device: its `device_config.backend`, read at each call (a device that is not paired yet is the cloud's, as it
 * always was). The loaders hold this, not a backend, so pairing with a host changes what they talk to without being rebuilt.
 */
class BackendSelector(
    private val config: DeviceConfigDao,
    private val cloud: StationBackend,
    private val host: StationBackend,
) : StationBackend {
    private suspend fun current(): StationBackend = if (config.get()?.backend == "host") host else cloud

    override suspend fun kindNow(): BackendKind = current().kindNow()
    override suspend fun cloudApi(): StationApi? = current().cloudApi()
    override suspend fun operators(): RosterResponse = current().operators()
    override suspend fun shifts(): ShiftListResponse = current().shifts()
    override suspend fun enter(shiftId: String, body: ShiftEntryRequest): ShiftDto = current().enter(shiftId, body)
    override suspend fun bundle(shiftId: String): ShiftBundleDto = current().bundle(shiftId)
    override suspend fun topUpBoxSscc(shiftId: String): BoxSsccTopUpDto = current().topUpBoxSscc(shiftId)
    override suspend fun palletBootstrap(): PalletBootstrapDto = current().palletBootstrap()
    override suspend fun boxRegistry(since: String?, until: String?, cursor: String?, limit: Int): BoxRegistryPageDto =
        current().boxRegistry(since, until, cursor, limit)
    override suspend fun hubCounts(): HubCounts = current().hubCounts()
}
