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
import javax.inject.Inject
import javax.inject.Singleton

/** The cloud: [StationApi] word for word. Nothing here may change what the cloud device does. */
@Singleton
class CloudBackend @Inject constructor(private val api: StationApi) : StationBackend {
    override suspend fun kindNow() = BackendKind.CLOUD
    override suspend fun cloudApi(): StationApi = api
    override suspend fun operators(): RosterResponse = api.operators()
    override suspend fun shifts(): ShiftListResponse = api.shifts()
    override suspend fun enter(shiftId: String, body: ShiftEntryRequest): ShiftDto = api.enter(shiftId, body)
    override suspend fun bundle(shiftId: String): ShiftBundleDto = api.bundle(shiftId)
    override suspend fun topUpBoxSscc(shiftId: String): BoxSsccTopUpDto = api.topUpBoxSscc(shiftId)
    override suspend fun palletBootstrap(): PalletBootstrapDto = api.palletBootstrap()
    override suspend fun boxRegistry(since: String?, until: String?, cursor: String?, limit: Int): BoxRegistryPageDto =
        api.boxRegistry(since, until, cursor, limit)

    /** What `HubViewModel` counted from the API before the seam. */
    override suspend fun hubCounts(): HubCounts = HubCounts(
        shifts = api.shifts().items.count { it.status in OPEN_SHIFT_STATUSES },
        inventories = api.inventoryTasks().items.size,
    )

    private companion object {
        val OPEN_SHIFT_STATUSES = setOf("planned", "active")
    }
}
