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

enum class BackendKind { CLOUD, HOST }

/** The open shifts and running inventories the hub's tiles count. */
data class HubCounts(val shifts: Int, val inventories: Int)

/**
 * What the loaders of this app need from "the server" (spec 4.1). The cloud answers them with [StationApi], the host with its own
 * protocol translated into the same DTOs, so the screens, the Room layer and printing do not know which one is behind them. Every call
 * throws what [StationApi] throws (`IOException`, `retrofit2.HttpException`): the loaders already read those.
 */
interface StationBackend {
    suspend fun kindNow(): BackendKind

    /** The cloud's API, for the subsystems that exist only there (grants, validation history, inventory); `null` on the host. */
    suspend fun cloudApi(): StationApi?

    suspend fun operators(): RosterResponse
    suspend fun shifts(): ShiftListResponse
    suspend fun enter(shiftId: String, body: ShiftEntryRequest): ShiftDto
    suspend fun bundle(shiftId: String): ShiftBundleDto
    suspend fun topUpBoxSscc(shiftId: String): BoxSsccTopUpDto
    suspend fun palletBootstrap(): PalletBootstrapDto
    suspend fun boxRegistry(since: String?, until: String?, cursor: String?, limit: Int): BoxRegistryPageDto
    suspend fun hubCounts(): HubCounts

    /**
     * Frees this device's slot of a shift several devices may work (plan 2b). The cloud has no slots and answers `null` without a call; the
     * host answers `POST /v1/device/shifts/{id}/leave`. Throws what the other calls throw (`IOException`, `HttpException`).
     * Returns this device's state in the shift as the host answered it (`active|left|closed`), `null` when none was said: `active` means the
     * host ignored the leave (a stale token) and the part still holds its slot. No default on purpose (final review C1): a delegating
     * backend that forgot it answered `null` for the host and the leave never left the device.
     */
    suspend fun leave(shiftId: String): String?
}

/** A backend that answers nothing: the base of test doubles and of the host backend before it exists. */
object NoBackend : StationBackend {
    private fun unsupported(): Nothing = throw UnsupportedOperationException("this backend does not answer that call")
    override suspend fun kindNow(): BackendKind = unsupported()
    override suspend fun cloudApi(): StationApi? = null
    override suspend fun operators(): RosterResponse = unsupported()
    override suspend fun shifts(): ShiftListResponse = unsupported()
    override suspend fun enter(shiftId: String, body: ShiftEntryRequest): ShiftDto = unsupported()
    override suspend fun bundle(shiftId: String): ShiftBundleDto = unsupported()
    override suspend fun topUpBoxSscc(shiftId: String): BoxSsccTopUpDto = unsupported()
    override suspend fun palletBootstrap(): PalletBootstrapDto = unsupported()
    override suspend fun boxRegistry(since: String?, until: String?, cursor: String?, limit: Int): BoxRegistryPageDto = unsupported()
    override suspend fun hubCounts(): HubCounts = unsupported()
    override suspend fun leave(shiftId: String): String? = unsupported()
}
