package app.markiro.handheld.core.backend

import app.markiro.handheld.core.host.HostBlockSupplier
import app.markiro.handheld.core.host.HostBoxRegistry
import app.markiro.handheld.core.host.HostCalls
import app.markiro.handheld.core.host.HostOrgPrint
import app.markiro.handheld.core.host.HostReferenceSync
import app.markiro.handheld.core.host.toBundle
import app.markiro.handheld.core.host.toBundleProduct
import app.markiro.handheld.core.host.toBundleTemplate
import app.markiro.handheld.core.host.toShiftDto
import app.markiro.handheld.core.network.BoxRegistryPageDto
import app.markiro.handheld.core.network.BoxSsccTopUpDto
import app.markiro.handheld.core.network.PalletBootstrapDto
import app.markiro.handheld.core.network.PalletBootstrapOperatorDto
import app.markiro.handheld.core.network.PalletBootstrapProductDto
import app.markiro.handheld.core.network.PalletCategoryTemplateDto
import app.markiro.handheld.core.network.PalletLabelTemplatesDto
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
import app.markiro.handheld.core.storage.PalletLabelTemplateEntity
import app.markiro.handheld.core.util.Iso
import kotlinx.serialization.json.Json
import java.util.concurrent.ConcurrentHashMap

/** The host behind the seam. What is not answered (inventory, write-offs, replacement) is `NoBackend`'s refusal. */
class HostBackend(
    private val api: () -> HostApi,
    private val config: DeviceConfigDao,
    private val db: HandheldDatabase,
    private val supplier: HostBlockSupplier,
    private val calls: HostCalls,
    private val reference: HostReferenceSync?,
    private val operators: OperatorDao,
    private val orgPrint: HostOrgPrint? = null,
    private val registry: HostBoxRegistry? = null,
    private val clock: () -> Long = System::currentTimeMillis,
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
        // The office may have assigned (or changed) this device's line since it was paired: the list is of the line the host knows now.
        reference?.refreshDevice()
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

    /**
     * The pallet mode's dictionaries are what the changes feed already wrote to Room (products with their pallet capacity, the pallet label
     * templates, the right to build pallets), read back in the cloud's shape; the host's own part is the organization's print identity
     * (read here, kept for the labels), the extension-1 SSCC block, and the registry's epoch (a restored host makes the next walk a full one).
     */
    override suspend fun palletBootstrap(): PalletBootstrapDto {
        reference?.let { calls.run { it.sync() } }
        val org = orgPrint?.let { calls.run { it.fetch() } }
        val prefix = org?.issuerPrefix
        if (prefix != null) calls.run { supplier.ensure(prefix, 1) }
        registry?.let { calls.run { runCatching { it.guardEpoch() } } }
        val templates = db.palletLabelTemplateDao().all()
        return PalletBootstrapDto(
            generatedAt = Iso.format(clock()),
            products = db.palletProductDao().all().map {
                PalletBootstrapProductDto(it.id, it.gtin14, it.name, it.printName, it.shelfLifeDays, it.palletBoxCapacity, it.chzProductGroupCode)
            },
            operators = db.palletPermissionDao().all().map { PalletBootstrapOperatorDto(it.employeeId, it.canBuildPallets) },
            palletSscc = prefix?.let { heldBlock(it, 1) },
            palletSsccRevokedFrom = emptyList(),
            palletLabelTemplates = PalletLabelTemplatesDto(
                organisation = templates.firstOrNull { it.key == PalletLabelTemplateEntity.ORG }?.let { Json.parseToJsonElement(it.specJson) },
                byCategory = templates.filter { it.key.startsWith("category:") }.mapNotNull { row ->
                    row.key.removePrefix("category:").toIntOrNull()?.let { PalletCategoryTemplateDto(it, Json.parseToJsonElement(row.specJson)) }
                },
            ),
        )
    }

    override suspend fun boxRegistry(since: String?, until: String?, cursor: String?, limit: Int): BoxRegistryPageDto =
        calls.run { runCatching { checkNotNull(registry) { "the box registry is not wired" }.page(since, until, cursor, limit) } }

    override suspend fun hubCounts(): HubCounts {
        val open = shifts().items.count { it.status in setOf("planned", "active") }
        return HubCounts(shifts = open, inventories = 0)
    }

    /** The earliest block of the pool with room, as the bundle carries it: the loader puts the same range into the pool again, which changes nothing. */
    private suspend fun heldBlock(prefix: String, extension: Int): BundleSsccDto? =
        db.ssccPoolDao().lowestWithRoom(prefix, extension)?.toBundle()
}
