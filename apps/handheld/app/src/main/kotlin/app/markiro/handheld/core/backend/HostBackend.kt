package app.markiro.handheld.core.backend

import app.markiro.handheld.core.host.HostBlockSupplier
import app.markiro.handheld.core.host.HostCalls
import app.markiro.handheld.core.host.HostReferenceSync
import app.markiro.handheld.core.host.toBundle
import app.markiro.handheld.core.host.toBundleProduct
import app.markiro.handheld.core.host.toBundleTemplate
import app.markiro.handheld.core.host.toShiftDto
import app.markiro.handheld.core.network.BoxSsccTopUpDto
import app.markiro.handheld.core.network.BundleSsccDto
import app.markiro.handheld.core.network.OperatorDto
import app.markiro.handheld.core.network.RosterResponse
import app.markiro.handheld.core.network.ShiftBundleDto
import app.markiro.handheld.core.network.ShiftDto
import app.markiro.handheld.core.network.ShiftEntryRequest
import app.markiro.handheld.core.network.ShiftListResponse
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.network.host.DeviceShiftDto
import app.markiro.handheld.core.network.host.HostApi
import app.markiro.handheld.core.storage.DeviceConfigDao
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.OperatorDao
import java.util.concurrent.ConcurrentHashMap

/** The host behind the seam. Pallet mode is added by task Д3; what is not answered yet is `NoBackend`'s refusal. */
class HostBackend(
    private val api: () -> HostApi,
    private val config: DeviceConfigDao,
    private val db: HandheldDatabase,
    private val supplier: HostBlockSupplier,
    private val calls: HostCalls,
    private val reference: HostReferenceSync?,
    private val operators: OperatorDao,
) : StationBackend by NoBackend {
    private val entries = ConcurrentHashMap<String, DeviceShiftDto>()

    override suspend fun kindNow() = BackendKind.HOST
    override suspend fun cloudApi(): StationApi? = null

    /** The roster is what the feed wrote to Room: reading the feed is how it is refreshed. */
    override suspend fun operators(): RosterResponse {
        reference?.let { calls.run { it.sync() } }
        return RosterResponse(operators.all().map { OperatorDto(it.operatorId, it.name, it.login, it.role, it.pinHash, it.badgeHash, it.active) })
    }

    override suspend fun shifts(): ShiftListResponse {
        val line = config.get()?.lineName
        return ShiftListResponse(calls.run { api().shifts() }.shifts.map { it.toShiftDto(line) })
    }

    override suspend fun enter(shiftId: String, body: ShiftEntryRequest): ShiftDto {
        val entered = calls.run { api().enter(shiftId) }
        entries[shiftId] = entered
        return entered.toShiftDto(config.get()?.lineName)
    }

    /** The snapshot of the entry just made (or, for a bundle asked alone, the owner's re-entry, which gives the same snapshot) becomes the bundle the loaders read. */
    override suspend fun bundle(shiftId: String): ShiftBundleDto {
        val entered = entries.remove(shiftId) ?: calls.run { api().enter(shiftId) }
        val snapshot = checkNotNull(entered.snapshot) { "an entered shift carries its snapshot" }
        val prefix = snapshot.issuerPrefix
        calls.run { supplier.ensure(prefix, 0) }
        if (entered.palletsEnabled) calls.run { supplier.ensure(prefix, 1) }
        return ShiftBundleDto(
            shift = entered.toShiftDto(config.get()?.lineName),
            product = snapshot.product.toBundleProduct(),
            boxLabelTemplate = snapshot.boxTemplate.toBundleTemplate(),
            palletLabelTemplate = snapshot.palletTemplate?.toBundleTemplate(),
            sscc = heldBlock(prefix, 0),
            palletSscc = if (entered.palletsEnabled) heldBlock(prefix, 1) else null,
        )
    }

    override suspend fun topUpBoxSscc(shiftId: String): BoxSsccTopUpDto {
        val prefix = checkNotNull(db.shiftDao().get(shiftId)?.ssccIssuerPrefix) { "the shift has no issuer prefix" }
        calls.run { supplier.ensure(prefix, 0) }
        return BoxSsccTopUpDto(blocks = db.ssccPoolDao().ranges(prefix, 0).map { it.toBundle() }, revokedFrom = emptyList(), issuerProblem = null)
    }

    override suspend fun hubCounts(): HubCounts {
        val open = shifts().items.count { it.status in setOf("planned", "active") }
        return HubCounts(shifts = open, inventories = 0)
    }

    /** The earliest block of the pool with room, as the bundle carries it: the loader puts the same range into the pool again, which changes nothing. */
    private suspend fun heldBlock(prefix: String, extension: Int): BundleSsccDto? =
        db.ssccPoolDao().lowestWithRoom(prefix, extension)?.toBundle()
}
